// Phase 3 hedge strategy engine.
//
// Rules implemented (owner's spec):
//  1. Buy and Sell each have their own MARGIN (USDT). qty = floor(margin × leverage / price, step).
//     Below Bybit minimums the start is refused with the smallest valid margin; never rounded up.
//  2. TP per side on underlying price movement from the side's average entry. After TP that side is
//     closed and waits for its own configured same-side trigger; the other side is untouched.
//  3. One MART per side per cycle (configurable). After MART, that side's normal TP is off until the
//     basket closes.
//  4. Basket recovery (armed by any MART): both sides' P&L, fees and slippage; close the basket at the
//     target, then STOP or START_NEW_CYCLE as configured.
//  5. Independent freeze per side; a frozen side gets no automated action and stays available for
//     manual close / unfreeze.
//  6. TP and triggers are internal. This module never calls Bybit trading-stop; transfers never touch
//     Bybit at all.
//  7. Settings and cycle state are persisted on every change. Every order is an intent recorded
//     before sending, with a unique orderLinkId; a side cannot have two orders in flight; partial,
//     rejected or unknown outcomes stop automation for that cycle (INCOMPLETE / NEEDS_REVIEW) instead
//     of pretending the step succeeded.

import crypto from 'crypto';
import type { BotDatabase } from '../db/database.ts';
import type { BybitClient } from '../bybit/bybitClient.ts';
import type { BotPosition, TradeLog } from '../../types/trading.ts';
import type {
  IntentAction, OrderIntent, Side, SideState, SizingQuote, StrategyConfig, StrategyCycle,
} from '../../types/strategy.ts';
import {
  InstrumentRules, quoteMinimum, quoteNotional, adversePrice, basketNet, reached, favourableMovePct, quoteSide, tpPrice, triggerHit, triggerPrice, validateStrategy,
} from './strategyMath.ts';

export type Origin = 'automated' | 'user';

export interface StrategyDeps {
  db: BotDatabase;
  client: BybitClient;
  getPrice: (symbol: string) => number | undefined;
  getRules: (symbol: string) => InstrumentRules | undefined;
  // Minimum-size cycles: re-read this symbol's order rules and price from Bybit right before an open (throws if not verifiable)
  refreshRules?: (symbol: string) => Promise<void>;
  // scope: which cycle (or which symbol's start) the order belongs to — lets the engine allow ONLY that cycle
  assertOrderAllowed: (reduceOnly: boolean, origin: Origin, what: string, scope?: { cycleId?: string; symbol?: string }) => void;
  isLive: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  defaultTakerFeePct?: number; // used only to ESTIMATE paper fees when no fee is configured
}

const SIDES: Side[] = ['Buy', 'Sell'];
const opposite = (s: Side): Side => (s === 'Buy' ? 'Sell' : 'Buy');
const posIdx = (s: Side): 1 | 2 => (s === 'Buy' ? 1 : 2);
const posId = (symbol: string, s: Side) => `${symbol}-${s}`;
const ACTIVE: StrategyCycle['status'][] = ['ACTIVE', 'BASKET'];
const FILL_GRACE_MS = 20000; // Bybit position list may lag a fresh fill
const skipLeverage = new Set<string>(); // cycleId+side opened right after the cycle start already set leverage

const emptySide = (): SideState => ({
  phase: 'CLOSED', legNo: 0, legEntryPrice: null, avgEntryPrice: null, size: 0, legFees: 0,
  martUsed: false, tpEnabled: true, trigger: null, frozenAt: null, lastTpPrice: null,
});

export class StrategyEngine {
  private locks = new Map<string, Promise<void>>();
  private lastFillAt = new Map<string, number>();
  constructor(private d: StrategyDeps) {}

  private now() { return this.d.now ? this.d.now() : Date.now(); }
  private sleep(ms: number) { return this.d.sleep ? this.d.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms)); }
  private get db() { return this.d.db; }

  // ---------- per-symbol mutex: ticks, manual actions and reconcile never interleave ----------
  private async withLock<T>(symbol: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(symbol) || Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chained = prev.then(() => mine);
    this.locks.set(symbol, chained);
    await prev;
    try { return await fn(); } finally {
      release();
      if (this.locks.get(symbol) === chained) this.locks.delete(symbol);
    }
  }
  private holdLogged = new Map<string, string>(); // cycleId -> funding status already logged as a hold
  private isBusy(symbol: string) { return this.locks.has(symbol); }

  /**
   * LIVE funding since the cycle started (Bybit sign kept: negative = paid). A failed retrieval sets
   * funding to unknown (never 0); the basket is then held until a retrieval succeeds.
   */
  public setFunding(symbol: string, funding: number | null, error?: string): void {
    const c = this.db.getStrategyCycle(symbol);
    if (!c) return;
    const now = this.now();
    const wasError = c.fundingError;
    c.fundingCheckedAt = now;
    if (error || funding === null || !Number.isFinite(funding)) {
      c.funding = null;
      c.fundingError = error || 'Bybit returned no usable funding value';
      if (!wasError) this.db.addAlert('warning', `Funding data unavailable [${symbol}]`, `${c.fundingError}. Basket recovery is on hold until funding is retrieved.`, symbol);
    } else {
      c.funding = funding;
      c.fundingError = undefined;
      c.fundingAt = now;
      if (wasError) this.db.addLog('CYCLE', `Funding data restored: ${symbol}`, `funding since start ${funding.toFixed(6)} USDT`, symbol);
    }
    this.db.saveStrategyCycle(c);
  }

  /** True while a fresh fill on this position id may not yet be visible on Bybit. */
  public recentlyFilled(positionId: string): boolean {
    return this.now() - (this.lastFillAt.get(positionId) || 0) < FILL_GRACE_MS;
  }

  // ---------- settings ----------
  public saveStrategy(input: any): { config: StrategyConfig; problems: string[] } {
    const symbol = String(input.symbol || '').toUpperCase();
    if (!/^[A-Z0-9]{2,30}USDT$/.test(symbol)) throw new Error('Invalid symbol');
    const num = (v: any) => (v === null || v === undefined || v === '' ? null : Number(v));
    const side = (s: any = {}): StrategyConfig['buy'] => ({
      marginUsdt: Number(s.marginUsdt ?? 0),
      notionalUsdt: num(s.notionalUsdt),
      leverage: num(s.leverage),
      tpPct: Number(s.tpPct),
      // Phase 5 workflow (owner-specified): after TP the same side reopens immediately unless another
      // re-entry rule is sent explicitly.
      trigger: (() => {
        const direction = s.trigger?.direction ?? 'IMMEDIATE';
        const noRef = direction === 'DISABLED' || direction === 'IMMEDIATE';
        return { direction, reference: noRef ? null : s.trigger?.reference ?? null, distancePct: noRef ? null : num(s.trigger?.distancePct) };
      })(),
      mart: { enabled: Boolean(s.mart?.enabled), triggerPct: num(s.mart?.triggerPct), marginUsdt: num(s.mart?.marginUsdt) },
      freezePct: num(s.freezePct),
    });
    const b = input.basket || {};
    const config: StrategyConfig = {
      version: 2, symbol, sizing: input.sizing === 'NOTIONAL' ? 'NOTIONAL' : 'MARGIN',
      ...(input.sizing === 'NOTIONAL' && input.minSize === true ? { minSize: true } : {}),
      leverage: input.sizing === 'NOTIONAL' ? Number(input.buy?.leverage) : Number(input.leverage), buy: side(input.buy), sell: side(input.sell),
      basket: {
        // Phase 4.2: whole cycle is the only enabled accounting mode (default when not given)
        // Phase 5 workflow defaults (owner-specified): frozen legs are manual (not part of the basket) and a
        // recovered basket closes both managed sides and starts a new cycle.
        targetUsdt: num(b.targetUsdt), pnlScope: b.pnlScope ?? 'CYCLE_TOTAL', frozenLegs: b.frozenLegs ?? 'EXCLUDE',
        takerFeePct: num(b.takerFeePct), slippagePct: num(b.slippagePct), afterClose: b.afterClose ?? 'START_NEW_CYCLE',
      },
      updatedAt: this.now(),
    };
    const enums: [any, any[]][] = [
      [config.buy.trigger.direction, [null, 'PULLBACK', 'CONTINUATION', 'DISABLED', 'IMMEDIATE']], [config.sell.trigger.direction, [null, 'PULLBACK', 'CONTINUATION', 'DISABLED', 'IMMEDIATE']],
      [config.buy.trigger.reference, [null, 'TP_FILL_PRICE', 'TP_TARGET_PRICE']], [config.sell.trigger.reference, [null, 'TP_FILL_PRICE', 'TP_TARGET_PRICE']],
      [config.basket.pnlScope, ['CYCLE_TOTAL']], [config.basket.frozenLegs, [null, 'INCLUDE', 'EXCLUDE']],
      [config.basket.afterClose, [null, 'STOP', 'START_NEW_CYCLE']],
    ];
    for (const [v, allowed] of enums) {
      if (!allowed.includes(v)) {
        if (v === 'OPEN_LEGS_ONLY') throw new Error('Basket mode OPEN_LEGS_ONLY is disabled until its funding attribution can be calculated correctly; use CYCLE_TOTAL (whole cycle)');
        throw new Error(`Invalid option: ${v}`);
      }
    }
    this.db.setStrategy(config);
    return { config, problems: this.problems(config) };
  }

  /** Phase 6: leverage of one side of a cycle (per-side for NOTIONAL cycles). */
  private levOf(c: StrategyCycle, side: Side): number {
    return (side === 'Buy' ? c.leverageBuy : c.leverageSell) ?? c.leverage;
  }

  /** Quote the configured opening size of one side (NOTIONAL value or MARGIN, depending on the strategy). */
  public quoteOpen(cfg: StrategyConfig, side: Side, price: number, rules: InstrumentRules, leverage?: number): SizingQuote {
    const sc = side === 'Buy' ? cfg.buy : cfg.sell;
    if (cfg.sizing === 'NOTIONAL' && cfg.minSize) return quoteMinimum(cfg.symbol, side, leverage ?? Number(sc.leverage), price, rules, cfg.basket.takerFeePct);
    if (cfg.sizing === 'NOTIONAL') return quoteNotional(cfg.symbol, side, Number(sc.notionalUsdt), leverage ?? Number(sc.leverage), price, rules, cfg.basket.takerFeePct);
    return quoteSide(cfg.symbol, side, sc.marginUsdt, leverage ?? cfg.leverage, price, rules, cfg.basket.takerFeePct);
  }

  public problems(cfg: StrategyConfig | undefined): string[] {
    const rules = cfg ? this.d.getRules(cfg.symbol) : undefined;
    return validateStrategy(cfg, rules?.maxLeverage ?? 0);
  }

  public quote(symbol: string, leverage: number, buyMargin: number, sellMargin: number, takerFeePct: number | null) {
    const rules = this.d.getRules(symbol);
    const price = this.d.getPrice(symbol) || 0;
    if (!rules) return { ok: false, error: 'Instrument rules not loaded for this symbol', buy: null, sell: null };
    const buy = quoteSide(symbol, 'Buy', buyMargin, leverage, price, rules, takerFeePct);
    const sell = quoteSide(symbol, 'Sell', sellMargin, leverage, price, rules, takerFeePct);
    return {
      ok: buy.ok && sell.ok, buy, sell,
      total: { margin: buy.estMargin + sell.estMargin, notional: buy.actualNotional + sell.actualNotional, requestedMargin: buyMargin + sellMargin },
    };
  }

  // ---------- order execution: intent → send → confirm ----------
  private inFlight(symbol: string, side: Side): OrderIntent | undefined {
    return this.db.getIntents().find((i) => i.symbol === symbol && i.side === side && (i.status === 'PENDING' || i.status === 'UNKNOWN'));
  }

  private newLinkId(action: IntentAction): string {
    const code = { OPEN: 'op', MART_ADD: 'ma', TP_CLOSE: 'tp', BASKET_CLOSE: 'bk', MANUAL_CLOSE: 'mc', TRIGGER_OPEN: 'tr' }[action];
    return `tb-${code}-${this.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`; // <= 36 chars
  }

  private async execute(p: { cycle: StrategyCycle | null; symbol: string; side: Side; action: IntentAction; reduceOnly: boolean; qty: number; origin: Origin; manualRequest?: {id:string;value:number}; leverage?: number | { buy: number; sell: number } }): Promise<OrderIntent> {
    this.d.assertOrderAllowed(p.reduceOnly, p.origin, `${p.action} ${p.symbol} ${p.side}`, { cycleId: p.cycle?.cycleId });
    const busy = this.inFlight(p.symbol, p.side);
    if (busy) throw new Error(`An order for ${p.symbol} ${p.side} is still ${busy.status} (${busy.orderLinkId}); refusing a second one`);
    if (!(p.qty > 0)) throw new Error('Order quantity must be > 0');
    const mode: 'LIVE' | 'PAPER' = p.cycle ? p.cycle.mode : this.d.isLive() ? 'LIVE' : 'PAPER';
    if (mode === 'LIVE' && !this.d.client.isTradingEnabled()) {
      throw new Error('READ-ONLY: live trading is not armed; no order was sent');
    }
    const orderSide = p.reduceOnly ? opposite(p.side) : p.side;
    const intent: OrderIntent = {
      id: crypto.randomUUID(), orderLinkId: this.newLinkId(p.action), cycleId: p.cycle?.cycleId ?? null, symbol: p.symbol,
      side: p.side, orderSide, action: p.action, reduceOnly: p.reduceOnly, qty: p.qty, mode, status: 'PENDING',
      createdAt: this.now(), updatedAt: this.now(),
      ...(p.manualRequest ? { manualRequestId:p.manualRequest.id, manualNotionalUsdt:p.manualRequest.value } : {}),
    };
    this.db.saveIntent(intent); // recorded BEFORE anything is sent

    if (mode === 'PAPER') {
      const price = this.d.getPrice(p.symbol);
      if (!price) return this.finish(intent, { status: 'REJECTED', error: 'No price for paper fill' });
      const feePct = this.db.getStrategy(p.symbol)?.basket.takerFeePct ?? this.d.defaultTakerFeePct ?? 0.055;
      return this.finish(intent, { status: 'FILLED', orderId: `paper-${intent.orderLinkId}`, filledQty: p.qty, avgPrice: price, fee: (p.qty * price * feePct) / 100 });
    }

    // LIVE
    if (!p.reduceOnly && p.leverage) {
      const lev = typeof p.leverage === 'number' ? { buy: p.leverage, sell: p.leverage } : p.leverage;
      const r: any = await (this.d.client as any).setLeverage(p.symbol, lev.buy, lev.sell);
      const ok = typeof r === 'object' && r !== null ? r.ok : Boolean(r);
      if (!ok) return this.finish(intent, { status: 'REJECTED', error: `Could not set leverage Buy ${lev.buy}x / Sell ${lev.sell}x on Bybit${r?.error ? `: ${r.error}` : ''}; order not sent` });
    }
    if(p.manualRequest){try{this.d.assertOrderAllowed(false,p.origin,'Manual Futures submit');}catch(e:any){return this.finish(intent,{status:'REJECTED',error:e.message});}}
    try {
      const r = await this.d.client.createOrder({
        category: 'linear', symbol: p.symbol, side: orderSide, orderType: 'Market', qty: String(p.qty),
        positionIdx: posIdx(p.side), reduceOnly: p.reduceOnly, orderLinkId: intent.orderLinkId,
      });
      intent.orderId = r.orderId;
    } catch (err: any) {
      if (err.rejected) return this.finish(intent, { status: 'REJECTED', error: err.message });
      // Network/timeout: the order may or may not exist. Look it up; never re-send.
    }
    return this.confirm(intent);
  }

  private async confirm(intent: OrderIntent): Promise<OrderIntent> {
    for (let attempt = 0; attempt < 6; attempt++) {
      let o: Awaited<ReturnType<BybitClient['getOrderByLinkId']>> = null;
      try { o = await this.d.client.getOrderByLinkId(intent.symbol, intent.orderLinkId); } catch { o = null; }
      if (o) {
        const base = { orderId: o.orderId, filledQty: o.cumExecQty, avgPrice: o.avgPrice || undefined, fee: o.cumExecFee };
        if (o.orderStatus === 'Filled' && o.cumExecQty >= intent.qty - 1e-12) return this.finish(intent, { ...base, status: 'FILLED' });
        const final = ['Cancelled', 'Rejected', 'Deactivated', 'PartiallyFilledCanceled'].includes(o.orderStatus);
        if (final) return this.finish(intent, { ...base, status: o.cumExecQty > 0 ? 'PARTIAL' : 'REJECTED', error: `${o.orderStatus}${o.rejectReason ? ` (${o.rejectReason})` : ''}` });
      }
      await this.sleep(300);
    }
    return this.finish(intent, { status: 'UNKNOWN', error: 'Order outcome could not be confirmed; not re-sent' });
  }

  private finish(intent: OrderIntent, upd: Partial<OrderIntent>): OrderIntent {
    Object.assign(intent, upd, { updatedAt: this.now() });
    this.db.saveIntent(intent);
    if (intent.status === 'FILLED' || intent.status === 'PARTIAL') this.lastFillAt.set(posId(intent.symbol, intent.side), this.now());
    this.db.addLog(intent.status === 'FILLED' ? 'ORDER' : 'ERROR', `${intent.action} ${intent.symbol} ${intent.side}: ${intent.status}`,
      `${intent.mode} ${intent.orderSide} qty ${intent.qty}${intent.filledQty != null ? ` filled ${intent.filledQty}` : ''}${intent.avgPrice ? ` @ ${intent.avgPrice}` : ''} | linkId ${intent.orderLinkId}${intent.error ? ` | ${intent.error}` : ''}`,
      intent.symbol);
    return intent;
  }

  // ---------- bookkeeping ----------
  private recordTrade(c: StrategyCycle | null, i: OrderIntent, pnl: number) {
    const map: Record<IntentAction, TradeLog['action']> = { OPEN: 'OPEN_INITIAL', TRIGGER_OPEN: 'TP_REOPEN', MART_ADD: 'MART_ADD', TP_CLOSE: 'TP_CLOSE', BASKET_CLOSE: 'CYCLE_CLOSE', MANUAL_CLOSE: 'MANUAL_CLOSE' };
    const qty = i.filledQty || 0, price = i.avgPrice || 0;
    this.db.addTrade({
      id: `trade-${i.orderLinkId}`, cycleId: c?.cycleId || 'manual', symbol: i.symbol, side: i.side, action: map[i.action],
      price, qty, notional: qty * price, fee: i.fee || 0, pnl, timestamp: i.updatedAt, orderId: i.orderId || '',
      notes: `${i.mode}${i.mode === 'PAPER' ? ' (simulated fill, estimated fee)' : ''} | orderLinkId ${i.orderLinkId}`,
    });
  }

  private writePosition(c: StrategyCycle, side: Side) {
    const s = c.sides[side];
    const id = posId(c.symbol, side);
    if (!s.size || s.phase === 'CLOSED' || s.phase === 'WAIT_TRIGGER') {
      const existing = this.db.getPosition(id);
      if (existing && existing.owner === 'bot' && existing.cycleId === c.cycleId) this.db.removePosition(id);
      return;
    }
    const cfg = this.db.getStrategy(c.symbol);
    const sc = side === 'Buy' ? cfg?.buy : cfg?.sell;
    const price = this.d.getPrice(c.symbol) || s.avgEntryPrice || 0;
    const entry = s.avgEntryPrice || 0;
    const prev = this.db.getPosition(id);
    const notional = s.size * price;
    const upnl = (side === 'Buy' ? price - entry : entry - price) * s.size;
    const pos: BotPosition = {
      ...(prev || ({} as BotPosition)),
      id, symbol: c.symbol, side, positionIdx: posIdx(side), owner: 'bot', size: s.size, entryPrice: entry, markPrice: price,
      notional, margin: notional / this.levOf(c, side), leverage: this.levOf(c, side), unrealizedPnl: upnl,
      unrealizedPnlPct: notional ? (upnl / (notional / this.levOf(c, side))) * 100 : 0,
      priceChangePct: entry ? favourableMovePct(side, entry, price) : 0,
      tpPrice: s.tpEnabled && sc ? tpPrice(side, entry, sc.tpPct) : 0, tpPct: sc?.tpPct || 0,
      martPrice: sc?.mart.enabled && !s.martUsed && sc.mart.triggerPct && s.legEntryPrice ? adversePrice(side, s.legEntryPrice, sc.mart.triggerPct) : 0,
      martPct: sc?.mart.triggerPct || 0, martTriggered: s.martUsed,
      freezePrice: sc?.freezePct ? adversePrice(side, entry, sc.freezePct) : 0, freezePct: sc?.freezePct || 0,
      isFrozen: s.phase === 'FROZEN', cycleId: c.cycleId, cycleStartTime: prev?.cycleStartTime || this.now(), updatedAt: this.now(),
      paper: c.mode === 'PAPER' ? true : undefined, missingOnExchangeSince: undefined,
    };
    this.db.savePosition(pos);
  }

  /** After a TP % change: recompute the stored TP target of this cycle's bot positions from each side's own average
   *  entry. Only tpPct / tpPrice change — no order, no phase change, missing-on-exchange flags kept. */
  public refreshTpTargets(symbol: string) {
    const c = this.db.getStrategyCycle(symbol);
    const cfg = this.db.getStrategy(symbol);
    if (!c || !cfg) return;
    for (const side of SIDES) {
      const p = this.db.getPosition(posId(symbol, side));
      if (!p || p.owner !== 'bot' || p.cycleId !== c.cycleId) continue;
      const s = c.sides[side];
      const sc = side === 'Buy' ? cfg.buy : cfg.sell;
      const entry = s.avgEntryPrice || 0;
      this.db.savePosition({ ...p, tpPct: sc.tpPct, tpPrice: s.tpEnabled && entry > 0 ? tpPrice(side, entry, sc.tpPct) : 0, updatedAt: this.now() });
    }
  }

  private save(c: StrategyCycle) {
    this.db.saveStrategyCycle(c);
    for (const s of SIDES) this.writePosition(c, s);
  }

  private stopCycle(c: StrategyCycle, status: 'INCOMPLETE' | 'NEEDS_REVIEW', reason: string) {
    c.status = status;
    c.statusReason = reason;
    this.save(c);
    this.db.addAlert('error', `${status === 'INCOMPLETE' ? 'Cycle incomplete' : 'Cycle needs review'} [${c.symbol}]`, `${reason}. Automation for this symbol is stopped until you resolve it.`, c.symbol);
  }

  /** Apply an order outcome; returns true only for a complete fill. */
  private accept(c: StrategyCycle, side: Side, i: OrderIntent, what: string): boolean {
    if (i.status === 'FILLED') return true;
    const s = c.sides[side];
    if (i.status === 'PARTIAL' && i.filledQty && i.avgPrice) {
      // keep the real partial exposure on the books
      if (i.reduceOnly) s.size = Math.max(0, s.size - i.filledQty);
      else {
        const total = s.size + i.filledQty;
        s.avgEntryPrice = s.size && s.avgEntryPrice ? (s.size * s.avgEntryPrice + i.filledQty * i.avgPrice) / total : i.avgPrice;
        s.legEntryPrice = s.legEntryPrice ?? i.avgPrice;
        s.size = total;
        s.legFees += i.fee || 0;
        if (what === 'MART_ADD') { s.martUsed = true; s.tpEnabled = false; }
      }
      c.feesPaid += i.fee || 0;
      this.recordTrade(c, i, 0);
    }
    s.phase = s.size > 0 ? (s.phase === 'OPENING' ? 'OPEN' : s.phase) : 'FAILED';
    s.note = `${what}: ${i.status}${i.error ? ` — ${i.error}` : ''}`;
    if (i.status === 'UNKNOWN') this.stopCycle(c, 'NEEDS_REVIEW', `${what} for ${side}: order outcome unknown (${i.orderLinkId})`);
    else this.stopCycle(c, 'INCOMPLETE', `${what} for ${side}: ${i.status}${i.error ? ` (${i.error})` : ''}`);
    return false;
  }

  private async openLeg(c: StrategyCycle, side: Side, marginUsdt: number, action: 'OPEN' | 'TRIGGER_OPEN' | 'MART_ADD', origin: Origin): Promise<boolean> {
    const cfg = this.db.getStrategy(c.symbol)!;
    if (cfg.minSize && action !== 'MART_ADD' && this.d.refreshRules) {
      // Minimum size: size every open (start and TP reopen) from rules and price verified on Bybit just now
      try { await this.d.refreshRules(c.symbol); } catch (err: any) {
        this.stopCycle(c, 'INCOMPLETE', `${action} ${side}: Bybit rules/price could not be verified now (${err.message || err}); nothing was sent`);
        return false;
      }
    }
    const rules = this.d.getRules(c.symbol);
    const price = this.d.getPrice(c.symbol) || 0;
    if (!rules) { this.stopCycle(c, 'INCOMPLETE', `${action} ${side}: instrument rules not loaded`); return false; }
    const lev = this.levOf(c, side);
    const q = action !== 'MART_ADD' && cfg.sizing === 'NOTIONAL'
      ? this.quoteOpen(cfg, side, price, rules, lev)
      : quoteSide(c.symbol, side, marginUsdt, lev, price, rules, cfg.basket.takerFeePct);
    if (!q.ok) { this.stopCycle(c, 'INCOMPLETE', `${action} ${side}: ${q.error}`); return false; }
    const s = c.sides[side];
    const prevPhase = s.phase;
    if (action !== 'MART_ADD') s.phase = 'OPENING';
    this.db.saveStrategyCycle(c);
    let i: OrderIntent;
    try {
      // the cycle start sets leverage once for both sides; later opens re-assert it
      const leverage = skipLeverage.has(c.cycleId + side) ? undefined : { buy: this.levOf(c, 'Buy'), sell: this.levOf(c, 'Sell') };
      i = await this.execute({ cycle: c, symbol: c.symbol, side, action, reduceOnly: false, qty: q.qty, origin, leverage });
    } catch (err: any) {
      s.phase = prevPhase === 'OPENING' ? 'FAILED' : prevPhase;
      s.note = `${action}: not sent — ${err.message}`;
      this.stopCycle(c, 'INCOMPLETE', `${action} ${side} not sent: ${err.message}`);
      return false;
    }
    if (!this.accept(c, side, i, action)) return false;
    const fillQty = i.filledQty!, fillPx = i.avgPrice!;
    if (action === 'MART_ADD') {
      const total = s.size + fillQty;
      s.avgEntryPrice = ((s.avgEntryPrice || fillPx) * s.size + fillPx * fillQty) / total;
      s.size = total;
      s.martUsed = true;
      s.tpEnabled = false;
      c.status = 'BASKET';
    } else {
      s.phase = 'OPEN';
      s.legNo += 1;
      s.size = fillQty;
      s.legEntryPrice = fillPx;
      s.avgEntryPrice = fillPx;
      s.legFees = 0;
      s.trigger = null;
      s.tpEnabled = !s.martUsed;
    }
    s.legFees += i.fee || 0;
    c.feesPaid += i.fee || 0;
    s.note = undefined;
    this.recordTrade(c, i, 0);
    this.save(c);
    return true;
  }

  private async closeLeg(c: StrategyCycle, side: Side, action: 'TP_CLOSE' | 'BASKET_CLOSE' | 'MANUAL_CLOSE', origin: Origin): Promise<OrderIntent | null> {
    const s = c.sides[side];
    if (!s.size) return null;
    const prevPhase = s.phase;
    s.phase = 'CLOSING';
    this.db.saveStrategyCycle(c);
    let i: OrderIntent;
    try {
      i = await this.execute({ cycle: c, symbol: c.symbol, side, action, reduceOnly: true, qty: s.size, origin });
    } catch (err: any) {
      s.phase = prevPhase;
      this.save(c);
      throw err;
    }
    if (i.status !== 'FILLED') {
      s.phase = prevPhase;
      this.accept(c, side, i, action);
      return null;
    }
    const entry = s.avgEntryPrice || i.avgPrice!;
    const gross = (side === 'Buy' ? i.avgPrice! - entry : entry - i.avgPrice!) * i.filledQty!;
    c.realizedPnl += gross;
    c.feesPaid += i.fee || 0;
    s.size = 0;
    s.legFees = 0;
    this.recordTrade(c, i, gross);
    return i;
  }

  // ---------- cycle lifecycle ----------
  /**
   * Start a cycle from the saved strategy. `adopt` lets the owner explicitly take an EXISTING position
   * on a side into the cycle instead of opening a new one (no exchange call for that side).
   */
  public startCycle(symbol: string, origin: Origin, adopt: Partial<Record<Side, boolean>> = {}, opts: { onCreated?: (c: StrategyCycle) => void } = {}): Promise<StrategyCycle> {
    return this.withLock(symbol, () => this.startCycleLocked(symbol, origin, adopt, opts));
  }

  private async startCycleLocked(symbol: string, origin: Origin, adopt: Partial<Record<Side, boolean>> = {}, opts: { onCreated?: (c: StrategyCycle) => void } = {}): Promise<StrategyCycle> {
    this.d.assertOrderAllowed(false, origin, `start cycle ${symbol}`, { symbol });
    const cfg = this.db.getStrategy(symbol);
    const problems = this.problems(cfg);
    if (problems.length) throw new Error(`Strategy not ready: ${problems.join('; ')}`);
    const existing = this.db.getStrategyCycle(symbol);
    if (existing && existing.status !== 'CLOSED') throw new Error(`A cycle is already ${existing.status} on ${symbol}`);
    const mode: 'LIVE' | 'PAPER' = this.d.isLive() ? 'LIVE' : 'PAPER';
    const adopted: Partial<Record<Side, BotPosition>> = {};
    for (const side of SIDES) {
      const p = this.db.getPosition(posId(symbol, side));
      const present = p && !p.missingOnExchangeSince && p.size > 0;
      if (adopt[side]) {
        if (!present) throw new Error(`Nothing to adopt: no ${side} position on ${symbol}`);
        if (mode === 'PAPER' && !p!.paper) throw new Error(`A real ${side} position can only be adopted by a LIVE cycle (live trading armed)`);
        if (mode === 'LIVE' && p!.paper) throw new Error(`A paper ${side} position cannot be adopted by a LIVE cycle`);
        adopted[side] = p!;
      } else if (present) {
        throw new Error(`${symbol} ${side} already has a ${p!.owner} position on the exchange. In hedge mode bot and manual size cannot be separated; adopt it into the cycle, close it, or keep it outside the bot.`);
      }
      const busy = this.inFlight(symbol, side);
      if (busy) throw new Error(`${symbol} ${side} has an unresolved order (${busy.orderLinkId})`);
    }
    const toOpen = SIDES.filter((sd) => !adopted[sd]);
    const rules = this.d.getRules(symbol);
    const price = this.d.getPrice(symbol) || 0;
    if (toOpen.length) {
      if (!rules) throw new Error('Instrument rules not loaded for this symbol');
      const errs = toOpen.map((sd) => this.quoteOpen(cfg!, sd, price, rules)).filter((q) => !q.ok).map((q) => q.error);
      if (errs.length) throw new Error(`Sizing refused: ${errs.join('; ')}`);
    }
    const notional = cfg!.sizing === 'NOTIONAL';
    const levBuy = notional ? Number(cfg!.buy.leverage) : cfg!.leverage;
    const levSell = notional ? Number(cfg!.sell.leverage) : cfg!.leverage;

    const c: StrategyCycle = {
      cycleId: `cy-${symbol}-${this.now().toString(36)}`, symbol, mode, status: 'OPENING',
      startedAt: this.now(), leverage: levBuy, leverageBuy: levBuy, leverageSell: levSell,
      sides: { Buy: emptySide(), Sell: emptySide() }, realizedPnl: 0, feesPaid: 0,
    };
    for (const side of SIDES) {
      const p = adopted[side];
      if (!p) continue;
      c.sides[side] = { ...emptySide(), phase: 'OPEN', legNo: 1, size: p.size, legEntryPrice: p.entryPrice, avgEntryPrice: p.entryPrice, note: `Adopted existing ${p.owner} position` };
      if (p.leverage && p.leverage !== this.levOf(c, side)) c.sides[side].note += ` (its leverage is ${p.leverage}x)`;
      // Phase 4: an external position's tpPrice is the TP read from Bybit; it is never changed, so say so.
      if (p.owner === 'external' && p.tpPrice > 0) c.sides[side].note += `; its Bybit TP at ${p.tpPrice} remains on the exchange and can still close this side`;
    }
    this.db.saveStrategyCycle(c);
    opts.onCreated?.(c); // Phase 6.2: lets the engine manage exactly this new cycle (and nothing else)
    const sizeText = (sd: Side) => {
      const sc = sd === 'Buy' ? cfg!.buy : cfg!.sell;
      return notional ? `${sc.notionalUsdt} USDT value at ${this.levOf(c, sd)}x` : `${sc.marginUsdt} USDT margin at ${c.leverage}x`;
    };
    this.db.addLog('CYCLE', `Cycle starting: ${symbol} (${c.mode})`, SIDES.map((sd) => (adopted[sd] ? `${sd}: adopt ${adopted[sd]!.size} @ ${adopted[sd]!.entryPrice}` : `${sd}: open ${sizeText(sd)}`)).join(' | '), symbol);
    for (const side of SIDES) if (adopted[side]) this.writePosition(c, side);

    if (toOpen.length) {
      // Leverage is set ONCE for both sides before any order; if Bybit refuses it, nothing is sent.
      if (mode === 'LIVE') {
        const r: any = await (this.d.client as any).setLeverage(symbol, levBuy, levSell);
        const ok = typeof r === 'object' && r !== null ? r.ok : Boolean(r);
        if (!ok) {
          c.status = 'INCOMPLETE';
          c.statusReason = `Leverage Buy ${levBuy}x / Sell ${levSell}x not accepted by Bybit${r?.error ? `: ${r.error}` : ''}. No order was sent.`;
          this.save(c);
          this.db.addAlert('error', `Cycle start failed [${symbol}]`, c.statusReason, symbol);
          this.finishCycle(c, 'START_FAILED');
          return c;
        }
      }
      // Phase 6: both sides are sent at (about) the same time; each is confirmed independently by its
      // orderLinkId. Fill prices may differ. A failed side is reported, never retried automatically.
      for (const sd of toOpen) skipLeverage.add(c.cycleId + sd);
      const results = await Promise.all(toOpen.map((sd) => this.openLeg(c, sd, sd === 'Buy' ? cfg!.buy.marginUsdt : cfg!.sell.marginUsdt, 'OPEN', origin)));
      for (const sd of toOpen) skipLeverage.delete(c.cycleId + sd);
      const failed = toOpen.filter((_, k) => !results[k]);
      if (failed.length) {
        const reasons = failed.map((sd) => `${sd}: ${c.sides[sd].note || 'not filled'}`).join(' | ');
        const nothingOpen = SIDES.every((sd) => c.sides[sd].size === 0);
        if (nothingOpen && c.status === 'INCOMPLETE') {
          c.statusReason = `Start failed — ${reasons}`;
          this.save(c);
          this.finishCycle(c, 'START_FAILED');
          return c;
        }
        if (c.status !== 'NEEDS_REVIEW') c.status = 'INCOMPLETE';
        const opened = SIDES.filter((sd) => c.sides[sd].size > 0).map((sd) => `${sd} ${c.sides[sd].size}${results[toOpen.indexOf(sd)] ? '' : ' (partial)'}`).join(' + ');
        c.statusReason = `Only partly opened (${opened} on Bybit) — ${reasons}. What is open is NOT managed until you choose Continue or Stop managing.`;
        this.save(c);
        this.db.addAlert('error', `Cycle incomplete [${symbol}]`, c.statusReason, symbol);
        return c;
      }
    }
    c.status = 'ACTIVE';
    this.save(c);
    this.db.addAlert('info', `Cycle started [${symbol}]`, `${c.mode}: ${SIDES.map((sd) => `${sd} ${adopted[sd] ? 'adopted' : `filled ${c.sides[sd].size} @ ${c.sides[sd].avgEntryPrice}`}`).join(', ')}`, symbol);
    return c;
  }

  /** Strategy evaluation on a price tick (only called while RUNNING). */
  public async evaluate(symbol: string): Promise<void> {
    const c0 = this.db.getStrategyCycle(symbol);
    if (!c0 || !ACTIVE.includes(c0.status)) return;
    if (this.isBusy(symbol)) return; // never queue ticks behind an order
    await this.withLock(symbol, () => this.evaluateLocked(symbol));
  }

  private async evaluateLocked(symbol: string): Promise<void> {
    const c = this.db.getStrategyCycle(symbol);
    const cfg = this.db.getStrategy(symbol);
    const price = this.d.getPrice(symbol);
    if (!c || !cfg || !price || !ACTIVE.includes(c.status)) return;

    for (const side of SIDES) {
      if (!ACTIVE.includes(c.status)) return;
      const s = c.sides[side];
      const sc = side === 'Buy' ? cfg.buy : cfg.sell;
      if (s.phase === 'OPEN' && s.avgEntryPrice && s.legEntryPrice) {
        // freeze (no order)
        if (sc.freezePct != null && reached(-favourableMovePct(side, s.avgEntryPrice, price), sc.freezePct)) {
          s.phase = 'FROZEN';
          s.frozenAt = this.now();
          this.save(c);
          this.db.addAlert('error', `Frozen [${symbol} ${side}]`, `Adverse move ≥ ${sc.freezePct}% from average entry. No automated action until you close or unfreeze it.`, symbol);
          continue;
        }
        // MART (once per side per cycle, measured from the leg's first entry)
        if (sc.mart.enabled && !s.martUsed && sc.mart.triggerPct && reached(-favourableMovePct(side, s.legEntryPrice, price), sc.mart.triggerPct)) {
          await this.openLeg(c, side, sc.mart.marginUsdt!, 'MART_ADD', 'automated');
          continue;
        }
        // normal TP (disabled after MART)
        if (s.tpEnabled && !s.martUsed && reached(favourableMovePct(side, s.avgEntryPrice, price), sc.tpPct)) {
          const target = tpPrice(side, s.avgEntryPrice, sc.tpPct);
          const fill = await this.closeLeg(c, side, 'TP_CLOSE', 'automated');
          if (!fill) continue;
          s.lastTpPrice = fill.avgPrice!;
          if (sc.trigger.direction === 'IMMEDIATE') {
            // Phase 5: TP closes the side and reopens the same side right away with its own margin.
            s.phase = 'WAIT_TRIGGER';
            s.trigger = null;
            this.save(c);
            this.db.addLog('CYCLE', `TP ${symbol} ${side}: reopening`, `closed at ${fill.avgPrice}; reopening ${side} with ${cfg.minSize ? 'minimum size (Bybit minimum order value + 1 USDT) at the current price' : cfg.sizing === 'NOTIONAL' ? `${sc.notionalUsdt} USDT value` : `${sc.marginUsdt} USDT margin`}`, symbol);
            await this.openLeg(c, side, sc.marginUsdt, 'TRIGGER_OPEN', 'automated');
            continue;
          }
          if (sc.trigger.direction === 'DISABLED') {
            s.phase = 'CLOSED';
          } else {
            const ref = sc.trigger.reference === 'TP_TARGET_PRICE' ? target : fill.avgPrice!;
            s.phase = 'WAIT_TRIGGER';
            s.trigger = { referencePrice: ref, triggerPrice: triggerPrice(side, sc.trigger.direction!, ref, sc.trigger.distancePct!), armedAt: this.now() };
          }
          this.save(c);
          continue;
        }
      } else if (s.phase === 'WAIT_TRIGGER' && sc.trigger.direction === 'IMMEDIATE') {
        // e.g. after a restart between the TP close and the reopen: reopen now
        await this.openLeg(c, side, sc.marginUsdt, 'TRIGGER_OPEN', 'automated');
      } else if (s.phase === 'WAIT_TRIGGER' && s.trigger && (sc.trigger.direction === 'PULLBACK' || sc.trigger.direction === 'CONTINUATION')) {
        if (triggerHit(side, sc.trigger.direction, s.trigger.triggerPrice, price)) {
          await this.openLeg(c, side, sc.marginUsdt, 'TRIGGER_OPEN', 'automated');
        }
      }
    }

    if (c.status === 'BASKET' && cfg.basket.targetUsdt != null) {
      const b = basketNet(c, cfg.basket, price, this.now());
      if (b.net === null) {
        // Unknown funding: no basket close and therefore no restart. Shown until funding is retrieved.
        c.basketNet = undefined;
        const hold = `Basket on hold: ${b.fundingMessage}. Net excluding funding ${b.netExFunding.toFixed(4)} USDT; no close or restart until funding is known.`;
        if (this.holdLogged.get(c.cycleId) !== b.fundingStatus) {
          this.holdLogged.set(c.cycleId, b.fundingStatus);
          this.db.addLog('CYCLE', `Basket on hold: ${c.symbol}`, hold, c.symbol);
        }
        c.basketHold = hold;
        this.db.saveStrategyCycle(c);
      } else {
        c.basketNet = b.net;
        c.basketHold = undefined;
        this.holdLogged.delete(c.cycleId);
        this.db.saveStrategyCycle(c);
        if (b.legs.length && b.net >= cfg.basket.targetUsdt) await this.closeBasket(c, cfg, b.legs);
      }
    }

    if (ACTIVE.includes(c.status) && SIDES.every((sd) => c.sides[sd].phase === 'CLOSED')) {
      this.finishCycle(c, 'ALL_SIDES_CLOSED');
    }
  }

  private async closeBasket(c: StrategyCycle, cfg: StrategyConfig, legs: Side[]) {
    c.status = 'CLOSING';
    this.db.saveStrategyCycle(c);
    this.db.addLog('CYCLE', `Basket target reached: ${c.symbol}`, `net ${c.basketNet?.toFixed(4)} ≥ ${cfg.basket.targetUsdt} USDT; closing ${legs.join(' + ')}`, c.symbol);
    for (const side of legs) {
      const fill = await this.closeLeg(c, side, 'BASKET_CLOSE', 'automated').catch((err) => {
        this.stopCycle(c, 'INCOMPLETE', `Basket close ${side} not sent: ${err.message}`);
        return null;
      });
      if (!fill) return; // accept()/stopCycle already set INCOMPLETE / NEEDS_REVIEW
      c.sides[side].phase = 'CLOSED';
      this.save(c);
    }
    // sides waiting for a trigger are cancelled by the basket close
    for (const side of SIDES) if (c.sides[side].phase === 'WAIT_TRIGGER') { c.sides[side].phase = 'CLOSED'; c.sides[side].trigger = null; }
    const frozenLeft = SIDES.some((sd) => c.sides[sd].phase === 'FROZEN');
    if (frozenLeft) {
      c.status = 'ACTIVE';
      c.statusReason = 'Basket closed; a frozen leg (excluded from the basket) remains for manual management';
      this.save(c);
      this.db.addAlert('warning', `Basket closed [${c.symbol}]`, c.statusReason, c.symbol);
      return;
    }
    this.finishCycle(c, 'BASKET_TARGET');
    if (cfg.basket.afterClose === 'START_NEW_CYCLE') {
      try {
        await this.startCycleLocked(c.symbol, 'automated');
      } catch (err: any) {
        this.db.addAlert('error', `New cycle not started [${c.symbol}]`, err.message, c.symbol);
      }
    }
  }

  private finishCycle(c: StrategyCycle, reason: StrategyCycle['closeReason']) {
    c.status = 'CLOSED';
    c.closeReason = reason;
    c.endedAt = this.now();
    this.save(c);
    this.db.archiveStrategyCycle(c.symbol);
    this.db.addLog('CYCLE', `Cycle closed: ${c.symbol} (${reason})`, `realised ${c.realizedPnl.toFixed(4)} USDT, fees ${c.feesPaid.toFixed(4)} USDT`, c.symbol);
  }

  // ---------- manual management ----------
  public manualCloseSide(symbol: string, side: Side): Promise<{ ok: boolean; message: string }> {
    return this.withLock(symbol, async () => {
      const c = this.db.getStrategyCycle(symbol);
      if (!c) throw new Error('No bot cycle on this symbol');
      const s = c.sides[side];
      if (!s.size) throw new Error(`${side} has no open bot position`);
      const fill = await this.closeLeg(c, side, 'MANUAL_CLOSE', 'user');
      if (!fill) return { ok: false, message: c.statusReason || 'Close not confirmed' };
      s.phase = 'CLOSED';
      s.trigger = null;
      s.note = 'Closed manually';
      this.save(c);
      if (SIDES.every((sd) => c.sides[sd].phase === 'CLOSED')) this.finishCycle(c, 'MANUAL');
      return { ok: true, message: `${symbol} ${side} closed` };
    });
  }

  public unfreeze(symbol: string, side: Side): Promise<{ ok: boolean; message: string }> {
    return this.withLock(symbol, async () => {
      const c = this.db.getStrategyCycle(symbol);
      const cfg = this.db.getStrategy(symbol);
      const price = this.d.getPrice(symbol);
      if (!c || !cfg || !price) throw new Error('No cycle, settings or price for this symbol');
      const s = c.sides[side];
      if (s.phase !== 'FROZEN') throw new Error(`${side} is not frozen`);
      const sc = side === 'Buy' ? cfg.buy : cfg.sell;
      if (sc.freezePct != null && s.avgEntryPrice && reached(-favourableMovePct(side, s.avgEntryPrice, price), sc.freezePct)) {
        throw new Error(`Price is still beyond the ${sc.freezePct}% freeze threshold. Close the position manually, or raise the freeze % first.`);
      }
      s.phase = 'OPEN';
      s.frozenAt = null;
      this.save(c);
      this.db.addLog('FREEZE', `Unfrozen by user: ${symbol} ${side}`, 'Targets keep the original entry prices', symbol);
      return { ok: true, message: `${symbol} ${side} is managed again` };
    });
  }

  /** Owner decision after INCOMPLETE / NEEDS_REVIEW. */
  public resolve(symbol: string, action: 'MANAGE_AS_IS' | 'RELEASE_TO_EXTERNAL'): Promise<StrategyCycle | null> {
    return this.withLock(symbol, async () => {
      const c = this.db.getStrategyCycle(symbol);
      if (!c) throw new Error('No cycle on this symbol');
      if (c.status !== 'INCOMPLETE' && c.status !== 'NEEDS_REVIEW') throw new Error(`Cycle is ${c.status}; nothing to resolve`);
      for (const side of SIDES) {
        const busy = this.inFlight(symbol, side);
        if (busy) throw new Error(`Order ${busy.orderLinkId} for ${side} is still ${busy.status}. Resolve it first (reconcile looks it up on Bybit).`);
      }
      if (action === 'RELEASE_TO_EXTERNAL') {
        for (const side of SIDES) {
          const p = this.db.getPosition(posId(symbol, side));
          if (p && p.owner === 'bot') { p.owner = 'external'; p.updatedAt = this.now(); this.db.savePosition(p); }
        }
        c.statusReason = 'Released to External by owner';
        c.status = 'CLOSED';
        c.closeReason = 'MANUAL';
        c.endedAt = this.now();
        this.db.saveStrategyCycle(c);
        this.db.archiveStrategyCycle(symbol);
        return null;
      }
      // MANAGE_AS_IS: rebuild each side from the exchange-synced position (LIVE) or local record (PAPER)
      for (const side of SIDES) {
        const s = c.sides[side];
        const p = this.db.getPosition(posId(symbol, side));
        if (p && p.owner === 'bot' && !p.missingOnExchangeSince && p.size > 0) {
          s.size = p.size;
          s.avgEntryPrice = p.entryPrice;
          s.legEntryPrice = s.legEntryPrice ?? p.entryPrice;
          if (s.phase !== 'FROZEN') s.phase = 'OPEN';
        } else if (s.phase !== 'WAIT_TRIGGER') {
          s.size = 0;
          s.phase = 'CLOSED';
        }
        s.note = undefined;
      }
      c.status = SIDES.some((sd) => c.sides[sd].martUsed) ? 'BASKET' : 'ACTIVE';
      c.statusReason = 'Resumed as-is by owner';
      this.save(c);
      return c;
    });
  }

  // ---------- transfers: never touch Bybit (existing Bybit TP orders stay as they are) ----------
  public transfer(positionId: string, target: 'bot' | 'external'): Promise<{ ok: boolean; message: string }> {
    const p0 = this.db.getPosition(positionId);
    if (!p0) return Promise.resolve({ ok: false, message: 'Position not found' });
    return this.withLock(p0.symbol, async () => {
      const p = this.db.getPosition(positionId)!;
      const side = p.side as Side;
      const c = this.db.getStrategyCycle(p.symbol);
      if (target === 'external') {
        if (p.owner === 'external') return { ok: true, message: 'Already external' };
        if (this.inFlight(p.symbol, side)) return { ok: false, message: 'An order for this side is in flight' };
        p.owner = 'external';
        p.updatedAt = this.now();
        this.db.savePosition(p);
        if (c && c.sides[side].size) {
          c.sides[side] = { ...c.sides[side], phase: 'CLOSED', size: 0, trigger: null, note: 'Released to External' };
          this.db.saveStrategyCycle(c);
          if (SIDES.every((sd) => c.sides[sd].phase === 'CLOSED')) this.finishCycle(c, 'MANUAL');
        }
        this.db.addLog('CYCLE', `Released to External: ${positionId}`, 'Bybit was not contacted; any Bybit TP on the position is unchanged', p.symbol);
        return { ok: true, message: 'Released to External. Bybit TP orders unchanged.' };
      }
      // to bot: only into an empty side of an active cycle
      if (p.owner === 'bot') return { ok: true, message: 'Already bot' };
      if (p.missingOnExchangeSince) return { ok: false, message: 'Position is not on the exchange' };
      if (!c || !ACTIVE.includes(c.status)) return { ok: false, message: 'Adopting needs an active bot cycle on this symbol. Start one first, or keep the position External.' };
      const s = c.sides[side];
      if (s.size || !['CLOSED', 'WAIT_TRIGGER'].includes(s.phase)) return { ok: false, message: `The bot already manages ${side} on ${p.symbol}` };
      p.owner = 'bot';
      p.cycleId = c.cycleId;
      p.updatedAt = this.now();
      this.db.savePosition(p);
      c.sides[side] = { ...emptySide(), phase: 'OPEN', legNo: s.legNo + 1, size: p.size, legEntryPrice: p.entryPrice, avgEntryPrice: p.entryPrice, martUsed: s.martUsed, tpEnabled: !s.martUsed, note: 'Adopted from External' };
      this.save(c);
      this.db.addLog('CYCLE', `Adopted to bot: ${positionId}`, 'Bybit was not contacted; any Bybit TP on the position is unchanged and may still close it', p.symbol);
      return { ok: true, message: 'Adopted. Bybit TP orders unchanged; note an existing Bybit TP can still close this position.' };
    });
  }

  // ---------- manual external orders (terminal) ----------
  public async manualExternalOpen(symbol: string, side: Side, marginUsdt: number, leverage: number, manual?: {notionalUsdt:number;requestId:string;prepare:()=>Promise<{price:number;rules:InstrumentRules;leverage:number}>}): Promise<OrderIntent> {
    return this.withLock(symbol, async () => {
      if(manual){
        const previous=this.db.getIntents().find(i=>i.manualRequestId===manual.requestId);
        if(previous){if(previous.symbol!==symbol||previous.side!==side||previous.manualNotionalUsdt!==manual.notionalUsdt)throw Error('Request ID already used with different order parameters');return previous;}
      }
      const c = this.db.getStrategyCycle(symbol);
      if (c && c.status !== 'CLOSED' && c.sides[side].phase !== 'CLOSED') throw new Error(`The bot manages ${symbol} ${side}; a manual order would merge into the bot position`);
      const fresh=manual?await manual.prepare():null;
      if(fresh)leverage=fresh.leverage;
      const rules = fresh?.rules || this.d.getRules(symbol);
      if (!rules) throw new Error('Instrument rules not loaded');
      const q = manual ? quoteNotional(symbol,side,manual.notionalUsdt,leverage,fresh!.price,rules,null) : quoteSide(symbol, side, marginUsdt, leverage, this.d.getPrice(symbol) || 0, rules, null);
      if (!q.ok) throw new Error(q.error);
      const i = await this.execute({ cycle: null, symbol, side, action: 'OPEN', reduceOnly: false, qty: q.qty, origin: 'user', leverage, ...(manual?{manualRequest:{id:manual.requestId,value:manual.notionalUsdt}}:{}) });
      if (i.status === 'FILLED' || i.status === 'PARTIAL') {
        this.recordTrade(null, i, 0);
        if (i.mode === 'PAPER') {
          const id = posId(symbol, side);
          const prev = this.db.getPosition(id);
          const size = (prev?.size || 0) + (i.filledQty || 0);
          this.db.savePosition({
            ...(prev || ({} as BotPosition)), id, symbol, side, positionIdx: posIdx(side), owner: 'external', size,
            entryPrice: prev ? (prev.size * prev.entryPrice + i.filledQty! * i.avgPrice!) / size : i.avgPrice!, markPrice: i.avgPrice!,
            notional: size * i.avgPrice!, margin: (size * i.avgPrice!) / leverage, leverage, unrealizedPnl: 0, unrealizedPnlPct: 0, priceChangePct: 0,
            tpPrice: 0, tpPct: 0, martPrice: 0, martPct: 0, martTriggered: false, freezePrice: 0, freezePct: 0, isFrozen: false,
            cycleId: 'manual', cycleStartTime: prev?.cycleStartTime || this.now(), updatedAt: this.now(), paper: true,
          });
        }
      }
      return i;
    });
  }

  public async manualCloseExternal(positionId: string): Promise<OrderIntent> {
    const p = this.db.getPosition(positionId);
    if (!p) throw new Error('Position not found');
    return this.withLock(p.symbol, async () => {
      const i = await this.execute({ cycle: null, symbol: p.symbol, side: p.side as Side, action: 'MANUAL_CLOSE', reduceOnly: true, qty: p.size, origin: 'user' });
      if (i.status === 'FILLED') {
        this.recordTrade(null, i, (p.side === 'Buy' ? i.avgPrice! - p.entryPrice : p.entryPrice - i.avgPrice!) * i.filledQty!);
        if (p.paper) this.db.removePosition(p.id);
      }
      return i;
    });
  }

  // ---------- restart / reconcile ----------
  /** Called once at boot: anything that was in flight is unknown until looked up. */
  public onBoot(): void {
    for (const i of this.db.getIntents()) {
      if (i.status === 'PENDING') this.finish(i, { status: 'UNKNOWN', error: 'Process restarted while the order was in flight' });
    }
    for (const c of Object.values(this.db.getStrategyCycles())) {
      if (c.status === 'OPENING' || c.status === 'CLOSING') {
        const was = c.status;
        c.status = 'NEEDS_REVIEW';
        c.statusReason = `Restarted during ${was === 'OPENING' ? 'opening' : 'closing'}; check positions and resolve`;
        this.db.saveStrategyCycle(c);
      }
      for (const sd of SIDES) if (c.sides[sd].phase === 'OPENING' || c.sides[sd].phase === 'CLOSING') {
        c.sides[sd].note = `Restarted while ${c.sides[sd].phase.toLowerCase()}`;
        this.db.saveStrategyCycle(c);
      }
    }
  }

  /**
   * Restart recovery (read-only, before any cycle is managed again). Call right after a successful Bybit position
   * sync. Sides interrupted by the restart (OPENING / CLOSING) are resolved from their recorded order by orderLinkId:
   * a TP close or a (re)open that Bybit reports fully filled AND that matches the synced position is applied exactly
   * as if the process had not stopped; anything else (partial, rejected, not found, other actions, mismatch) puts the
   * cycle in NEEDS_REVIEW with the reason. A side waiting to reopen while Bybit already shows a position on it is also
   * NEEDS_REVIEW (never a second open). Nothing is ever sent. Throws if Bybit cannot be read, so the caller retries.
   */
  public async recoverAfterRestart(): Promise<string[]> {
    const notes: string[] = [];
    for (const c of Object.values(this.db.getStrategyCycles())) {
      if (c.mode !== 'LIVE' || !ACTIVE.includes(c.status)) continue;
      const cfg = this.db.getStrategy(c.symbol);
      for (const side of SIDES) {
        if (!ACTIVE.includes(c.status)) break;
        const s = c.sides[side];
        const onBybit = this.db.getPosition(posId(c.symbol, side));
        const liveSize = onBybit && !onBybit.missingOnExchangeSince && !onBybit.paper ? onBybit.size : 0;
        if (s.phase === 'WAIT_TRIGGER') {
          if (liveSize > 0) this.stopCycle(c, 'NEEDS_REVIEW', `After restart: ${side} was waiting to reopen, but Bybit shows a ${side} position of ${liveSize}; not reopened`);
          continue;
        }
        if (s.phase !== 'OPENING' && s.phase !== 'CLOSING') continue;
        const i = this.db.getIntents().filter((x) => x.cycleId === c.cycleId && x.side === side && x.mode === 'LIVE' && (x.status === 'UNKNOWN' || x.status === 'PENDING')).sort((a, b) => b.createdAt - a.createdAt)[0];
        if (!i) {
          this.stopCycle(c, 'NEEDS_REVIEW', `After restart: ${side} was ${s.phase.toLowerCase()} with no order awaiting confirmation; check Bybit and resolve`);
          continue;
        }
        const o = await this.d.client.getOrderByLinkId(i.symbol, i.orderLinkId); // throws → caller retries later
        if (!o) { this.stopCycle(c, 'NEEDS_REVIEW', `After restart: ${i.action} ${side} order ${i.orderLinkId} not found on Bybit; not re-sent`); continue; }
        const final = ['Filled', 'Cancelled', 'Rejected', 'Deactivated', 'PartiallyFilledCanceled'].includes(o.orderStatus);
        if (!final) { this.stopCycle(c, 'NEEDS_REVIEW', `After restart: ${i.action} ${side} order ${i.orderLinkId} is still ${o.orderStatus} on Bybit`); continue; }
        const filled = o.orderStatus === 'Filled' && o.cumExecQty >= i.qty - 1e-12;
        const st: OrderIntent['status'] = filled ? 'FILLED' : o.cumExecQty > 0 ? 'PARTIAL' : 'REJECTED';
        this.finish(i, { status: st, orderId: o.orderId, filledQty: o.cumExecQty, avgPrice: o.avgPrice, fee: o.cumExecFee, error: filled ? undefined : `Resolved after restart: ${o.orderStatus}` });
        if (!filled) { this.stopCycle(c, 'NEEDS_REVIEW', `After restart: ${i.action} ${side} order ${i.orderLinkId} ended ${o.orderStatus} (filled ${o.cumExecQty} of ${i.qty})`); continue; }
        if (i.action === 'TP_CLOSE' && s.phase === 'CLOSING') {
          if (liveSize > 0) { this.stopCycle(c, 'NEEDS_REVIEW', `After restart: TP close ${side} filled on Bybit, but Bybit still shows ${liveSize}`); continue; }
          const sc = side === 'Buy' ? cfg?.buy : cfg?.sell;
          const dir = sc?.trigger.direction;
          if (dir !== 'IMMEDIATE' && dir !== 'DISABLED') { this.stopCycle(c, 'NEEDS_REVIEW', `After restart: TP close ${side} filled; reopen rule ${dir} must be checked manually`); continue; }
          const entry = s.avgEntryPrice || i.avgPrice!;
          const gross = (side === 'Buy' ? i.avgPrice! - entry : entry - i.avgPrice!) * i.filledQty!;
          c.realizedPnl += gross;
          c.feesPaid += i.fee || 0;
          s.size = 0;
          s.legFees = 0;
          s.lastTpPrice = i.avgPrice!;
          s.trigger = null;
          s.phase = dir === 'IMMEDIATE' ? 'WAIT_TRIGGER' : 'CLOSED';
          s.note = undefined;
          this.recordTrade(c, i, gross);
          this.save(c);
          notes.push(`${c.symbol} ${side}: TP close confirmed on Bybit (${i.orderLinkId})${dir === 'IMMEDIATE' ? '; reopen follows once managed' : ''}`);
        } else if ((i.action === 'OPEN' || i.action === 'TRIGGER_OPEN') && s.phase === 'OPENING') {
          if (Math.abs(liveSize - i.filledQty!) > 1e-9) { this.stopCycle(c, 'NEEDS_REVIEW', `After restart: ${i.action} ${side} filled ${i.filledQty} on Bybit, but the position there is ${liveSize}`); continue; }
          s.phase = 'OPEN';
          s.legNo += 1;
          s.size = i.filledQty!;
          s.legEntryPrice = i.avgPrice!;
          s.avgEntryPrice = i.avgPrice!;
          s.legFees = i.fee || 0;
          s.trigger = null;
          s.tpEnabled = !s.martUsed;
          s.note = undefined;
          c.feesPaid += i.fee || 0;
          this.recordTrade(c, i, 0);
          this.save(c);
          notes.push(`${c.symbol} ${side}: ${i.action} confirmed on Bybit (${i.orderLinkId})`);
        } else {
          this.stopCycle(c, 'NEEDS_REVIEW', `After restart: ${i.action} ${side} (${i.orderLinkId}) filled while ${s.phase.toLowerCase()}; resolve manually`);
        }
      }
    }
    return notes;
  }

  /** Look up UNKNOWN live intents on Bybit by orderLinkId; never re-sends. */
  public async resolveUnknownIntents(): Promise<void> {
    for (const i of this.db.getIntents().filter((x) => x.status === 'UNKNOWN' && x.mode === 'LIVE')) {
      let o = null;
      try { o = await this.d.client.getOrderByLinkId(i.symbol, i.orderLinkId); } catch { continue; }
      if (!o) {
        if (this.now() - i.createdAt > 10 * 60 * 1000) this.finish(i, { status: 'REJECTED', error: 'Not found on Bybit 10 minutes after sending' });
        continue;
      }
      const final = ['Filled', 'Cancelled', 'Rejected', 'Deactivated', 'PartiallyFilledCanceled'].includes(o.orderStatus);
      if (!final) continue;
      const st = o.orderStatus === 'Filled' && o.cumExecQty >= i.qty - 1e-12 ? 'FILLED' : o.cumExecQty > 0 ? 'PARTIAL' : 'REJECTED';
      this.finish(i, { status: st, orderId: o.orderId, filledQty: o.cumExecQty, avgPrice: o.avgPrice, fee: o.cumExecFee, error: `Resolved after restart/timeout: ${o.orderStatus}` });
      const c = i.cycleId ? Object.values(this.db.getStrategyCycles()).find((x) => x.cycleId === i.cycleId) : undefined;
      if (c && c.status !== 'NEEDS_REVIEW') this.stopCycle(c, 'NEEDS_REVIEW', `Order ${i.orderLinkId} resolved late as ${st}`);
    }
  }

  /** Compare LIVE cycle sides with the positions just synced from Bybit. */
  public checkAgainstExchange(): void {
    for (const c of Object.values(this.db.getStrategyCycles())) {
      if (c.mode !== 'LIVE' || !ACTIVE.includes(c.status)) continue;
      for (const side of SIDES) {
        const s = c.sides[side];
        if (!['OPEN', 'FROZEN'].includes(s.phase)) continue;
        if (this.now() - (this.lastFillAt.get(posId(c.symbol, side)) || 0) < FILL_GRACE_MS) continue;
        const p = this.db.getPosition(posId(c.symbol, side));
        if (!p || p.missingOnExchangeSince) { this.stopCycle(c, 'NEEDS_REVIEW', `${side} position is no longer on Bybit (closed outside the bot?)`); break; }
        if (Math.abs(p.size - s.size) > 1e-9) { this.stopCycle(c, 'NEEDS_REVIEW', `${side} size on Bybit is ${p.size}, bot expected ${s.size}`); break; }
        // keep owner = bot for adopted / bot legs
        if (p.owner !== 'bot') { p.owner = 'bot'; this.db.savePosition(p); }
      }
    }
  }

  public emergencyCloseAll(): Promise<string[]> {
    const out: string[] = [];
    const run = async () => {
      for (const c of Object.values(this.db.getStrategyCycles())) {
        await this.withLock(c.symbol, async () => {
          for (const side of SIDES) {
            if (!c.sides[side].size) continue;
            try {
              const fill = await this.closeLeg(c, side, 'MANUAL_CLOSE', 'user');
              if (fill) { c.sides[side].phase = 'CLOSED'; c.sides[side].trigger = null; out.push(`${c.symbol} ${side} closed`); }
              else out.push(`${c.symbol} ${side}: close not confirmed`);
            } catch (err: any) { out.push(`${c.symbol} ${side}: ${err.message}`); }
          }
          for (const side of SIDES) if (c.sides[side].phase === 'WAIT_TRIGGER') { c.sides[side].phase = 'CLOSED'; c.sides[side].trigger = null; }
          if (SIDES.every((sd) => c.sides[sd].phase === 'CLOSED')) this.finishCycle(c, 'MANUAL');
          else this.stopCycle(c, 'NEEDS_REVIEW', 'Emergency stop: not every side could be closed');
        });
      }
      return out;
    };
    return run();
  }
}

