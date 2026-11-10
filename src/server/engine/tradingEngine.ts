import { exchangeMarginOf } from '../../shared/positionMargin.ts';
import { BotDatabase } from '../db/database.ts';
import { BybitClient, BybitOrderParams, BybitWalletResult } from '../bybit/bybitClient.ts';
import { BybitWsClient } from '../bybit/bybitWs.ts';
import { StrategyEngine } from './strategyEngine.ts';
import { favourableMovePct, reached, tpPrice } from './strategyMath.ts';
import {
  BotPosition,
  CycleState,
  ClosedCycle,
  TradeLog,
  SymbolMarketInfo,
  SymbolTradingConfig,
  PositionSide,
  PositionOwner,
  ManagementIntent,
} from '../../types/trading.ts';

import type { SizingQuote, StrategyConfig, StrategyCycle } from '../../types/strategy.ts';
export type OrderOrigin = 'automated' | 'user';

const TAKER_FEE_RATE = 0.00055; // Bybit standard taker fee 0.055%
const SLIPPAGE_ESTIMATE_RATE = 0.0002; // 0.02% estimated slippage

export interface HedgeSettings {
  // Phase 6.1: no leverage here — each new cycle uses the symbol's maximum leverage read from Bybit at start
  buyNotionalUsdt: number; buyTpPct: number;
  sellNotionalUsdt: number; sellTpPct: number;
  takerFeePct: number;
  /** default size option offered for NEW hedge starts (each start still sends its own explicit choice) */
  sizingMode: 'CUSTOM' | 'MINIMUM';
}
/** a running side whose current move already meets a new TP % (it may close at the next price tick once applied) */
export interface TpAffectedSide { symbol: string; cycleId: string; side: 'Buy' | 'Sell'; entry: number; price: number | null; movePct: number | null; newTpPct: number; tpPrice: number; managed: boolean }
export interface HedgePreview {
  symbol: string; price: number; settings: HedgeSettings;
  buy: SizingQuote | null; sell: SizingQuote | null;
  onBybit: { side: string; size: number; entryPrice: number; takeProfit: number | null; positionIdx: number }[];
  positionCheck: 'OK' | 'FOUND' | 'ONE_WAY' | 'ERROR' | 'SKIPPED';
  marginMode: string | null; blockers: string[]; ok: boolean;
  /** Phase 6.1: the symbol's maximum leverage, read from Bybit for this check; used for BOTH sides */
  leverage: { max: number | null; source: string; fetchedAt: number | null; error?: string };
  /** CUSTOM = the dashboard Buy/Sell values; MINIMUM = the smallest valid Bybit order for each side */
  sizing: HedgeSizing;
  /** order rules used for this check (MINIMUM: read fresh from Bybit, all fields verified) */
  rules: { qtyStep: number; minQty: number; minNotional: number; maxLeverage: number; missing: string[] } | null;
  priceSource: string;
}
export type HedgeSizing = 'CUSTOM' | 'MINIMUM';
// Unset values stay NaN: nothing is assumed; the dashboard asks for them.
const DEFAULT_HEDGE: HedgeSettings = { buyNotionalUsdt: NaN, buyTpPct: NaN, sellNotionalUsdt: NaN, sellTpPct: NaN, takerFeePct: 0.055, sizingMode: 'CUSTOM' };

export class TradingEngine {
  private static instance: TradingEngine;
  private db: BotDatabase;
  private client: BybitClient;
  private wsClient: BybitWsClient;
  private isRunning: boolean = false;
  public readonly strategy: StrategyEngine;
  private marketInfoCache: Record<string, SymbolMarketInfo> = {};
  private reconcileTimer: NodeJS.Timeout | null = null;
  private scheduledReconcileRunning = false;
  private reconcileCount = 0;
  private fundingRetryAfter = new Map<string, number>();
  private fundingCursor = 0;
  private startTime: number = Date.now();
  private lastTickTime: number = Date.now();
  private liveWallet: (BybitWalletResult & { lastUpdated: number; connected: boolean; errorMessage?: string }) | null = null;
  private lastLatencyMs: number = 35;
  // Phase 1: automated trading state. Always PAUSED at boot and never persisted, so a
  // restart can never resume automated orders on its own. Only an explicit resume() changes it.
  private tradingState: 'PAUSED' | 'RUNNING' = 'PAUSED';
  // Phase 4: Bybit connection status shown to the owner (read-only information)
  private connection: {
    state: 'NO_CREDENTIALS' | 'CONNECTING' | 'CONNECTED' | 'ERROR';
    environment: 'mainnet' | 'testnet';
    lastCheckAt: number | null;
    lastOkAt: number | null;
    latencyMs: number | null;
    timeOffsetMs: number | null;
    keyInfo: any;
    marginMode: string | null;
    error: any;
    positionsSyncedAt: number | null;
    positionsCount: number | null;
  } = { state: 'NO_CREDENTIALS', environment: 'mainnet', lastCheckAt: null, lastOkAt: null, latencyMs: null, timeOffsetMs: null, keyInfo: null, marginMode: null, error: null, positionsSyncedAt: null, positionsCount: null };

  private constructor() {
    this.db = BotDatabase.getInstance();
    const settings = this.db.getSettings();
    this.client = new BybitClient(settings.apiKey, settings.apiSecret, settings.environment === 'testnet', settings.apiHost);
    this.wsClient = new BybitWsClient(settings.environment === 'testnet');
    this.strategy = new StrategyEngine({
      db: this.db,
      client: this.client,
      getPrice: (symbol) => {
        const p = this.marketInfoCache[symbol]?.lastPrice;
        return p && p > 0 ? p : undefined;
      },
      getRules: (symbol) => {
        const i = this.marketInfoCache[symbol];
        // only rules loaded from Bybit's instrument list are used for sizing (never fallbacks)
        if (!i || !i.fromExchange) return undefined;
        return { qtyStep: i.qtyStep, minQty: i.minQty, minNotional: i.minNotional, maxLeverage: i.maxLeverage, missing: i.missingRules };
      },
      refreshRules: async (symbol) => {
        // Minimum-size opens only: fresh lot-size rules + current price from Bybit for this one symbol
        const fresh = (await this.client.getInstrumentsInfo(symbol))[symbol];
        if (!fresh) throw new Error(`${symbol} was not returned by Bybit as a trading USDT perpetual`);
        const t = (await this.client.getTickers(symbol))[symbol];
        if (!(t?.lastPrice && t.lastPrice > 0)) throw new Error(`Bybit returned no current price for ${symbol}`);
        const cached = this.marketInfoCache[symbol];
        if (!cached) throw new Error(`${symbol} is not in the instrument list`);
        Object.assign(cached, { qtyStep: fresh.qtyStep, minQty: fresh.minQty, minNotional: fresh.minNotional, maxLeverage: fresh.maxLeverage, missingRules: fresh.missingRules, lastPrice: t.lastPrice });
      },
      assertOrderAllowed: (reduceOnly, origin, what, scope) => this.assertOrderAllowed(reduceOnly, origin, what, scope),
      isLive: () => {
        const s = this.db.getSettings();
        return Boolean(s.liveTrading && s.isApiKeyConfigured);
      },
    });
  }

  public static getInstance(): TradingEngine {
    if (!TradingEngine.instance) {
      TradingEngine.instance = new TradingEngine();
    }
    return TradingEngine.instance;
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.startTime = Date.now();

    this.tradingState = 'PAUSED';
    // Phase 3: anything that was in flight when the process stopped is marked UNKNOWN for lookup.
    this.strategy.onBoot();
    this.db.addLog('CYCLE', 'Engine Start', 'Engine booted in PAUSED mode: prices and positions are synced read-only; no automated orders until an explicit resume');
    // Restart recovery: the saved management intent is only READ here (boot never overwrites it). Cycles that were
    // managed are resumed later by tryRestore(), and only after authentication + a full read-only reconciliation.
    const intent = this.db.getSettings().managementIntent;
    this.restorePending = Boolean(intent && intent.mode !== 'OFF' && (intent.state === 'RUNNING' || Object.values(intent.cycles || {}).includes('MANAGED')));
    this.restoreNote = null;
    if (this.restorePending) this.db.addLog('SECURITY', 'Restart recovery pending', `Saved state: ${intent!.state === 'RUNNING' ? 'bot running' : 'individually managed cycles'} (${intent!.mode}). Management resumes only after Bybit authentication and reconciliation succeed.`);
    else if (!intent) this.db.addLog('SECURITY', 'No saved management state', 'Legacy or first start: every cycle stays paused until you resume once.');

    // Phase 4: every boot starts READ-ONLY. Live trading must be re-armed (PIN + confirmation).
    if (this.db.getSettings().liveTrading) {
      this.db.updateSettings({ liveTrading: false });
      this.db.addLog('SECURITY', 'Live trading disarmed at boot', 'Every restart starts read-only; re-arm explicitly to trade.');
    }
    this.client.setTradingEnabled(false);
    const settings = this.db.getSettings();
    this.connection.environment = settings.environment;
    if (settings.apiKey && settings.apiSecret) {
      try {
        await this.refreshConnection();
        await this.syncBybitPositions();
      } catch (e: any) {
        console.warn('[Engine] Initial Bybit sync:', e.message);
      }
    }

    // 1. Initial market data & instruments load
    await this.refreshInstruments();

    // 2. Setup WebSocket price feed listener
    this.wsClient.onTicker((symbol, partialTicker) => {
      this.handlePriceTick(symbol, partialTicker);
    });
    this.wsClient.connect();

    // 3. Subscribe to all configured symbols
    const configs = this.db.getSymbolsConfig();
    const symbolsToSub = [...new Set([...Object.keys(configs), ...Object.keys(this.db.getStrategies()), ...Object.keys(this.db.getStrategyCycles())])];
    this.wsClient.subscribeMultiple(symbolsToSub);

    // 4. Start periodic background reconciliation
    this.startReconcileLoop();

    // 5. Ensure initial positions exist for active symbols
    await this.bootstrapActiveSymbols();

    // 6. Restart recovery: first attempt now; on failure the reconcile loop retries the read-only checks.
    if (this.restorePending) await this.tryRestore();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.wsClient.destroy();
    this.db.addLog('CYCLE', 'Engine Stopped', 'Trading engine stopped safely');
  }

  public isEngineRunning(): boolean {
    return this.isRunning;
  }

  public getTradingState(): 'PAUSED' | 'RUNNING' {
    return this.tradingState;
  }

  public pause(reason: string = 'User pause'): void {
    this.tradingState = 'PAUSED';
    this.managedCycles.clear(); // Phase 6.2: pausing stops management of every cycle, including single-started ones
    this.restorePending = false;
    this.saveIntent({ state: 'PAUSED', mode: 'OFF', all: 'PAUSED', reason });
    this.db.addLog('SECURITY', 'Automated trading PAUSED', reason);
  }

  // ---------------- restart recovery ----------------
  private restorePending = false;
  private restoreNote: string | null = null;

  /** Persist the owner's intended management state (only explicit pause / resume / start / arming call this). */
  private saveIntent(p: { state?: ManagementIntent['state']; mode?: ManagementIntent['mode']; all?: 'MANAGED' | 'PAUSED'; cycle?: [string, 'MANAGED' | 'PAUSED' | null]; reason?: string }): void {
    const prev = this.db.getSettings().managementIntent;
    const open = Object.values(this.db.getStrategyCycles()).filter((c) => c.status !== 'CLOSED').map((c) => c.cycleId);
    const cycles: ManagementIntent['cycles'] = {};
    for (const id of open) cycles[id] = p.all || prev?.cycles?.[id] || 'PAUSED';
    if (p.cycle) { if (p.cycle[1]) cycles[p.cycle[0]] = p.cycle[1]; else delete cycles[p.cycle[0]]; }
    this.db.setManagementIntent({ state: p.state || prev?.state || 'PAUSED', mode: p.mode || prev?.mode || 'OFF', cycles, updatedAt: Date.now(), reason: p.reason || prev?.reason });
  }

  public getRestoreStatus(): { pending: boolean; note: string | null } {
    return { pending: this.restorePending, note: this.restoreNote };
  }

  /**
   * Resume the cycles that were managed before a restart. Read-only until the very end: Bybit authentication,
   * a complete position sync (all pages), resolution of orders interrupted by the restart, and the comparison of
   * every cycle with Bybit must all succeed first; otherwise nothing is managed and the next reconcile retries.
   * Only cycles saved as MANAGED that are ACTIVE / BASKET afterwards resume; paused, legacy, NEEDS_REVIEW and
   * emergency-stopped states stay inactive; REAL is restored only if it was REAL (never from Simulation).
   */
  private async tryRestore(): Promise<boolean> {
    const intent = this.db.getSettings().managementIntent;
    const fail = (why: string) => {
      if (this.restoreNote !== why) this.db.addLog('SECURITY', 'Restart recovery waiting', `${why}. Management stays inactive; the read-only checks are retried.`);
      this.restoreNote = why;
      return false;
    };
    if (!this.restorePending || !intent || this.restoreRunning) return false;
    this.restoreRunning = true;
    try { return await this.tryRestoreOnce(intent, fail); } finally { this.restoreRunning = false; }
  }

  private restoreRunning = false;
  private async tryRestoreOnce(intent: ManagementIntent, fail: (why: string) => boolean): Promise<boolean> {
    if (this.db.getSettings().emergencyStop) {
      this.restorePending = false;
      this.restoreNote = 'Emergency stop is active: nothing was resumed';
      this.db.addLog('SECURITY', 'Restart recovery cancelled', this.restoreNote);
      return false;
    }
    const real = intent.mode === 'REAL';
    try {
      const conn = await this.refreshConnection();
      if (conn.state !== 'CONNECTED' || !conn.keyInfo) return fail(`Bybit authentication failed (${conn.error?.message || conn.state})`);
      if (real && conn.keyInfo.readOnly) return fail('The API key is read-only on Bybit');
      const sync = await this.syncBybitPositions();
      if (!sync.success) return fail(`Bybit position sync failed (${sync.error})`);
      let notes: string[];
      try { notes = await this.strategy.recoverAfterRestart(); } catch (err: any) { return fail(`Order lookup on Bybit failed (${err.message || err})`); }
      this.strategy.checkAgainstExchange(); // missing / mismatched sides → NEEDS_REVIEW (never reopened)
      if (!this.restorePending || this.db.getSettings().emergencyStop) return false; // the owner acted meanwhile
      const cycles = Object.values(this.db.getStrategyCycles()).filter((c) => c.status !== 'CLOSED');
      const runnable = cycles.filter((c) => c.status === 'ACTIVE' || c.status === 'BASKET');
      const eligible = runnable.filter((c) => intent.cycles?.[c.cycleId] === 'MANAGED' && (c.mode !== 'LIVE' || real));
      const held = cycles.filter((c) => !eligible.includes(c)).map((c) => `${c.symbol} (${c.status !== 'ACTIVE' && c.status !== 'BASKET' ? c.status : intent.cycles?.[c.cycleId] === 'MANAGED' ? 'needs REAL mode' : 'paused'})`);
      this.restorePending = false;
      this.restoreNote = null;
      if (intent.state === 'RUNNING' && runnable.every((c) => eligible.includes(c))) {
        this.setLiveArmed(real);
        this.resume(`Restored after restart (${intent.mode})`);
      } else if (eligible.length) {
        if (real) this.setLiveArmed(true);
        for (const c of eligible) this.managedCycles.add(c.cycleId);
      }
      this.db.addLog('SECURITY', 'Restart recovery complete', `Reconciled with Bybit. Resumed: ${eligible.map((c) => c.symbol).join(', ') || 'none'}${this.tradingState === 'RUNNING' ? ' (bot running)' : ''}. Kept inactive: ${held.join(', ') || 'none'}.${notes.length ? ' ' + notes.join('; ') + '.' : ''}`);
      return true;
    } catch (err: any) {
      return fail(err.message || String(err));
    }
  }

  // ---------------- Phase 6: hedge workflow ----------------
  public getHedgeSettings(): HedgeSettings {
    const stored = (this.db.getSettings() as any).hedge || {};
    const { buyLeverage: _bl, sellLeverage: _sl, ...rest } = stored; // leverage from older settings is no longer used
    return { ...DEFAULT_HEDGE, ...rest };
  }

  /** Validate + merge a (partial) settings update with the stored settings; nothing is saved. Fields not sent keep
   *  their stored value (each dashboard box saves only its own fields). */
  private buildHedgeSettings(input: any): HedgeSettings {
    const cur = this.getHedgeSettings();
    const has = (k: string) => Object.prototype.hasOwnProperty.call(input || {}, k);
    const n = (v: any) => (v === '' || v === null || v === undefined ? NaN : Number(v));
    const h: HedgeSettings = {
      buyNotionalUsdt: has('buyNotionalUsdt') ? n(input.buyNotionalUsdt) : cur.buyNotionalUsdt,
      buyTpPct: has('buyTpPct') ? n(input.buyTpPct) : cur.buyTpPct,
      sellNotionalUsdt: has('sellNotionalUsdt') ? n(input.sellNotionalUsdt) : cur.sellNotionalUsdt,
      sellTpPct: has('sellTpPct') ? n(input.sellTpPct) : cur.sellTpPct,
      takerFeePct: has('takerFeePct') && Number.isFinite(n(input.takerFeePct)) ? n(input.takerFeePct) : Number.isFinite(cur.takerFeePct) ? cur.takerFeePct : DEFAULT_HEDGE.takerFeePct,
      sizingMode: has('sizingMode') ? String(input.sizingMode).toUpperCase() as any : cur.sizingMode === 'MINIMUM' ? 'MINIMUM' : 'CUSTOM',
    };
    const errs: string[] = [];
    for (const [k, label] of [['buyNotionalUsdt', 'Buy value'], ['sellNotionalUsdt', 'Sell value'], ['buyTpPct', 'Buy TP %'], ['sellTpPct', 'Sell TP %']] as const) {
      if (has(k) && !(Number.isFinite(h[k]) && h[k] > 0)) errs.push(`${label} must be a number > 0`);
    }
    if (!(h.takerFeePct >= 0)) errs.push('Taker fee % must be ≥ 0');
    if (h.sizingMode !== 'CUSTOM' && h.sizingMode !== 'MINIMUM') errs.push('Position sizing must be CUSTOM or MINIMUM');
    if (errs.length) throw new Error(errs.join('; '));
    return h;
  }

  public saveHedgeSettings(input: any): HedgeSettings {
    const h = this.buildHedgeSettings(input);
    this.db.updateSettings({ hedge: h } as any);
    return h;
  }

  /** Running sides whose current move already meets the new TP % (would close at the next tick once applied). */
  private tpAffectedSides(tp: { buy?: number; sell?: number }): { cycles: StrategyCycle[]; affected: TpAffectedSide[] } {
    const cycles = Object.values(this.db.getStrategyCycles()).filter((c) => c.status !== 'CLOSED');
    const affected: TpAffectedSide[] = [];
    for (const c of cycles) {
      for (const side of ['Buy', 'Sell'] as const) {
        const pct = side === 'Buy' ? tp.buy : tp.sell;
        const s = c.sides[side];
        const entry = s.avgEntryPrice ?? 0;
        if (pct === undefined || s.phase !== 'OPEN' || !s.tpEnabled || !(entry > 0)) continue;
        const price = this.marketInfoCache[c.symbol]?.lastPrice || 0;
        const move = price > 0 ? favourableMovePct(side, entry, price) : null;
        // no live price: the side cannot be checked, so it is listed for confirmation too
        if (move === null || reached(move, pct)) {
          affected.push({ symbol: c.symbol, cycleId: c.cycleId, side, entry, price: price > 0 ? price : null, movePct: move, newTpPct: pct, tpPrice: tpPrice(side, entry, pct), managed: this.isCycleManaged(c.cycleId) });
        }
      }
    }
    return { cycles, affected };
  }

  /**
   * Dashboard Save: store the settings and, when a Buy and/or Sell TP % is sent, apply it to every existing bot
   * cycle that is not closed (paused ones included) — only the TP % in each cycle's strategy changes; the stored TP
   * targets are recomputed from each side's own average entry (underlying price move, not ROI). Nothing is closed,
   * opened, resumed or armed here. If a running side already meets the new TP, nothing is saved unless confirmed.
   */
  public saveHedgeSettingsAndApplyTp(input: any, confirmTp: boolean): { needsConfirmation: true; affected: TpAffectedSide[]; cycles: number } | { needsConfirmation: false; settings: HedgeSettings; tpApplied: { cycles: number; buy: number | null; sell: number | null } | null } {
    const has = (k: string) => Object.prototype.hasOwnProperty.call(input || {}, k);
    const h = this.buildHedgeSettings(input);
    const tp = { buy: has('buyTpPct') ? h.buyTpPct : undefined, sell: has('sellTpPct') ? h.sellTpPct : undefined };
    if (tp.buy === undefined && tp.sell === undefined) {
      this.db.updateSettings({ hedge: h } as any);
      return { needsConfirmation: false, settings: h, tpApplied: null };
    }
    const { cycles, affected } = this.tpAffectedSides(tp);
    if (affected.length && confirmTp !== true) return { needsConfirmation: true, affected, cycles: cycles.length };
    this.db.updateSettings({ hedge: h } as any);
    let n = 0;
    for (const c of cycles) {
      const cfg = this.db.getStrategy(c.symbol);
      if (!cfg) continue;
      this.db.setStrategy({
        ...cfg,
        buy: tp.buy !== undefined ? { ...cfg.buy, tpPct: tp.buy } : cfg.buy,
        sell: tp.sell !== undefined ? { ...cfg.sell, tpPct: tp.sell } : cfg.sell,
        updatedAt: Date.now(),
      });
      this.strategy.refreshTpTargets(c.symbol);
      n++;
    }
    this.db.addLog('CONFIG', 'TP % applied to existing bot cycles', `${tp.buy !== undefined ? `Buy ${tp.buy}%` : ''}${tp.buy !== undefined && tp.sell !== undefined ? ' / ' : ''}${tp.sell !== undefined ? `Sell ${tp.sell}%` : ''} → ${n} cycle(s) (paused cycles stay paused; nothing was closed or opened)${affected.length ? `; confirmed for ${affected.map((a) => `${a.symbol} ${a.side}`).join(', ')}` : ''}`);
    return { needsConfirmation: false, settings: h, tpApplied: { cycles: n, buy: tp.buy ?? null, sell: tp.sell ?? null } };
  }

  /** The per-symbol strategy a hedge cycle runs with (built from the dashboard settings; no MART, no freeze). */
  private hedgeStrategy(symbol: string, h: HedgeSettings, leverage: number, minimum?: { buy: number; sell: number }): any {
    const side = (notional: number, lev: number, tp: number) => ({
      marginUsdt: 0, notionalUsdt: notional, leverage: lev, tpPct: tp,
      trigger: { direction: 'IMMEDIATE', reference: null, distancePct: null },
      mart: { enabled: false, triggerPct: null, marginUsdt: null }, freezePct: null,
    });
    // Minimum size: notionalUsdt only records the estimate shown at the start; every open (start and TP reopen)
    // recomputes the smallest valid order from Bybit's rules and the price at that moment (strategyMath.quoteMinimum).
    return {
      symbol, sizing: 'NOTIONAL', ...(minimum ? { minSize: true } : {}),
      buy: side(minimum ? minimum.buy : h.buyNotionalUsdt, leverage, h.buyTpPct), sell: side(minimum ? minimum.sell : h.sellNotionalUsdt, leverage, h.sellTpPct),
      basket: { targetUsdt: null, pnlScope: 'CYCLE_TOTAL', frozenLegs: 'EXCLUDE', takerFeePct: h.takerFeePct, slippagePct: 0, afterClose: 'STOP' },
    };
  }

  /**
   * Read-only pre-check for a hedge start: sizing for both sides at the current price, plus a FRESH
   * position check on Bybit for this symbol. Nothing is written and nothing is sent.
   */
  public async previewHedge(symbol: string, sizing: HedgeSizing = 'CUSTOM'): Promise<HedgePreview> {
    symbol = String(symbol || '').toUpperCase();
    const minimum = sizing === 'MINIMUM';
    const h = this.getHedgeSettings();
    const info = this.marketInfoCache[symbol];
    const blockers: string[] = [];
    const conn = this.getConnection();
    if (conn.state !== 'CONNECTED') blockers.push('Bybit API is not connected (Dashboard → Bybit account).');
    if (conn.keyInfo?.readOnly) blockers.push('This API key is read-only on Bybit; opening positions needs Contract trading permission.');
    if (this.db.getSettings().emergencyStop) blockers.push('Emergency stop is active.');
    if (!info?.fromExchange) blockers.push(`${symbol} is not in Bybit's USDT perpetual list.`);
    let price = info?.lastPrice || 0;
    let priceSource = 'live price feed';
    if (minimum) {
      // Minimum size: the price is read fresh from Bybit for this check (no cached value)
      price = 0;
      priceSource = 'Bybit /v5/market/tickers (read now)';
      try {
        const t = (await this.client.getTickers(symbol))[symbol];
        if (t?.lastPrice && t.lastPrice > 0) price = t.lastPrice;
        else blockers.push(`Bybit returned no current price for ${symbol}: minimum size cannot be verified. No order will be sent.`);
      } catch (err: any) {
        blockers.push(`Could not read the current ${symbol} price from Bybit: ${err.message || err}. No order will be sent.`);
      }
    } else if (!(price > 0)) blockers.push(`No live price for ${symbol} yet.`);
    // Phase 6.1: read the symbol's CURRENT maximum leverage (and order rules) from Bybit for this check.
    // If it cannot be retrieved, nothing can be started.
    const leverage: HedgePreview['leverage'] = { max: null, source: 'Bybit /v5/market/instruments-info (leverageFilter.maxLeverage)', fetchedAt: null };
    let fresh: SymbolMarketInfo | undefined;
    try {
      fresh = (await this.client.getInstrumentsInfo(symbol))[symbol];
      if (!fresh) throw new Error(`${symbol} was not returned by Bybit as a trading USDT perpetual`);
      if (!(fresh.maxLeverage >= 1)) throw new Error(`Bybit returned no valid maximum leverage for ${symbol}`);
      if (minimum && fresh.missingRules?.includes('maxLeverage')) throw new Error(`Bybit did not return the maximum leverage for ${symbol}`);
      leverage.max = fresh.maxLeverage;
      leverage.fetchedAt = Date.now();
    } catch (err: any) {
      leverage.error = err.message || String(err);
      blockers.push(`Could not retrieve the maximum leverage for ${symbol} from Bybit: ${leverage.error}. No order will be sent.`);
    }
    // Minimum size uses ONLY the rules just read from Bybit, and only if Bybit returned every one of them
    const src = minimum ? fresh : fresh || (info?.fromExchange ? info : undefined);
    const missing = src?.missingRules || [];
    if (minimum && fresh && missing.length) blockers.push(`Bybit did not return ${missing.join(', ')} for ${symbol}: minimum size cannot be verified. No order will be sent.`);
    if (minimum && !(h.buyTpPct > 0 && h.sellTpPct > 0)) blockers.push('Buy TP % and Sell TP % must be saved on the dashboard first.');
    const rules = src && leverage.max ? { qtyStep: src.qtyStep, minQty: src.minQty, minNotional: src.minNotional, maxLeverage: leverage.max, missing } : null;
    const cfg = this.hedgeStrategy(symbol, h, leverage.max ?? NaN, minimum ? { buy: 0, sell: 0 } : undefined) as StrategyConfig;
    const buy = rules && price > 0 ? this.strategy.quoteOpen(cfg, 'Buy', price, rules) : null;
    const sell = rules && price > 0 ? this.strategy.quoteOpen(cfg, 'Sell', price, rules) : null;
    if (buy && !buy.ok) blockers.push(buy.error!);
    if (sell && !sell.ok) blockers.push(sell.error!);
    const mm = conn.marginMode;
    const existing = this.db.getStrategyCycle(symbol);
    if (existing && existing.status !== 'CLOSED') blockers.push(`A bot cycle is already ${existing.status} on ${symbol}.`);
    if (this.hedgeStarting.has(symbol)) blockers.push(`A start for ${symbol} is already in progress.`);
    // fresh check on Bybit: any position on either side blocks the start (it is never opened over or changed)
    const onBybit: HedgePreview['onBybit'] = [];
    let positionCheck: 'OK' | 'FOUND' | 'ONE_WAY' | 'ERROR' | 'SKIPPED' = 'SKIPPED';
    if (conn.state === 'CONNECTED') {
      try {
        const list = await this.client.getPositions(symbol);
        const open = list.filter((p: any) => parseFloat(p.size || '0') > 0);
        for (const p of open) onBybit.push({ side: p.side, size: parseFloat(p.size), entryPrice: parseFloat(p.avgPrice || '0'), takeProfit: parseFloat(p.takeProfit || '0') || null, positionIdx: Number(p.positionIdx) });
        if (list.some((p: any) => Number(p.positionIdx) === 0)) {
          positionCheck = 'ONE_WAY';
          blockers.push(`${symbol} is in one-way position mode on Bybit. Switch it to Hedge mode in Bybit first (the bot does not change account settings).`);
        } else positionCheck = open.length ? 'FOUND' : 'OK';
        if (open.length) {
          blockers.push(`${symbol} already has ${open.map((p: any) => `a ${p.side === 'Buy' ? 'Long' : 'Short'} position (${p.size}${parseFloat(p.takeProfit || '0') ? `, Bybit TP ${p.takeProfit}` : ''})`).join(' and ')} on Bybit. The bot will not open or change anything on this symbol while it exists.`);
        }
      } catch (err: any) {
        positionCheck = 'ERROR';
        blockers.push(`Could not check ${symbol} positions on Bybit: ${err.message}`);
      }
    }
    return { symbol, price, settings: h, buy, sell, onBybit, positionCheck, marginMode: mm ?? null, blockers: [...new Set(blockers)], ok: blockers.length === 0, leverage, sizing, rules, priceSource };
  }

  /** Start a REAL Buy + Sell hedge cycle after the owner's explicit confirmation. */
  public async startHedge(symbol: string, confirm: boolean, sizing: HedgeSizing = 'CUSTOM'): Promise<{ ok: boolean; message: string; preview: HedgePreview; cycle?: StrategyCycle }> {
    symbol = String(symbol || '').toUpperCase();
    const preview = await this.previewHedge(symbol, sizing);
    if (!preview.ok) return { ok: false, message: preview.blockers.join(' '), preview };
    if (confirm !== true) return { ok: false, message: 'Confirmation required: nothing was sent.', preview };
    if (this.hedgeStarting.has(symbol)) return { ok: false, message: `A start for ${symbol} is already in progress.`, preview };
    this.hedgeStarting.add(symbol);
    const wasArmed = this.client.isTradingEnabled();
    try {
      // the maximum leverage read in this check is applied once for both sides when the cycle starts;
      // if Bybit refuses it, the start fails and no order is sent
      if (sizing === 'MINIMUM') {
        // use exactly the rules and price verified in this check for the opening orders (and later TP reopens)
        const r = preview.rules!;
        const cached = this.marketInfoCache[symbol];
        if (cached) Object.assign(cached, { qtyStep: r.qtyStep, minQty: r.minQty, minNotional: r.minNotional, maxLeverage: r.maxLeverage, missingRules: r.missing, lastPrice: preview.price });
      }
      this.strategy.saveStrategy(this.hedgeStrategy(symbol, preview.settings, preview.leverage.max!, sizing === 'MINIMUM' ? { buy: preview.buy!.actualNotional, sell: preview.sell!.actualNotional } : undefined));
      this.setLiveArmed(true);
      // Phase 6.2: NO global resume. Only this symbol's start and the cycle it creates are allowed to act;
      // previously saved cycles stay paused until "Resume managing".
      this.startPermits.add(symbol);
      const cycle = await this.strategy.startCycle(symbol, 'user', {}, { onCreated: (c) => { this.managedCycles.add(c.cycleId); this.saveIntent({ mode: 'REAL', cycle: [c.cycleId, 'MANAGED'] }); } });
      const ok = cycle.status === 'ACTIVE';
      if (!ok && cycle.status === 'CLOSED') { this.managedCycles.delete(cycle.cycleId); this.saveIntent({ cycle: [cycle.cycleId, null] }); this.revertIfNothingManaged(wasArmed); }
      if (ok) this.db.addLog('SECURITY', `Managing ${symbol} only`, `New hedge cycle ${cycle.cycleId} is managed; other saved cycles keep their state (${this.tradingState === 'RUNNING' ? 'bot already managing all' : 'paused'})`, symbol);
      return { ok, message: ok ? `${symbol}: Buy and Sell opened${sizing === 'MINIMUM' ? ' at minimum size' : ''} and confirmed by Bybit.` : cycle.statusReason || `Cycle ${cycle.status}`, preview, cycle };
    } catch (err: any) {
      this.revertIfNothingManaged(wasArmed);
      return { ok: false, message: err.message || String(err), preview };
    } finally {
      this.startPermits.delete(symbol);
      this.hedgeStarting.delete(symbol);
    }
  }

  private hedgeStarting = new Set<string>();
  /** Phase 6.2: cycles managed individually (started by "Start hedge") while the bot is otherwise paused. In memory:
   *  after a restart nothing is managed until an explicit resume. */
  private managedCycles = new Set<string>();
  private startPermits = new Set<string>();

  public isCycleManaged(cycleId: string): boolean {
    return this.tradingState === 'RUNNING' || this.managedCycles.has(cycleId);
  }
  public getManagedCycleIds(): string[] {
    const all = Object.values(this.db.getStrategyCycles());
    return all.filter((c) => this.isCycleManaged(c.cycleId)).map((c) => c.cycleId);
  }

  /** A failed start that opened nothing returns real-order arming to its previous state if nothing is managed. */
  private revertIfNothingManaged(wasArmed: boolean): void {
    if (this.tradingState === 'RUNNING' || this.managedCycles.size > 0) return;
    if (!wasArmed) this.setLiveArmed(false);
  }

  /** Phase 5: real-order arming in one place (settings flag + client-level lock). */
  public setLiveArmed(on: boolean): void {
    const s = this.db.getSettings();
    if (Boolean(s.liveTrading) !== on) this.db.updateSettings({ liveTrading: on });
    this.client.setTradingEnabled(on && this.client.isConfigured());
    const intent = this.db.getSettings().managementIntent;
    if (intent) this.saveIntent({ mode: on ? 'REAL' : intent.state === 'RUNNING' ? 'SIMULATION' : 'OFF' });
    this.db.addLog('SECURITY', on ? 'Real trading ARMED (confirmed)' : 'Real trading disarmed', on ? 'Bybit orders allowed for bot cycles' : 'Bybit order requests locked');
  }

  /** OFF = paused; SIMULATION = running without real orders; REAL = running with real orders. */
  public getTradingMode(): 'OFF' | 'SIMULATION' | 'REAL' {
    if (this.tradingState !== 'RUNNING' && this.managedCycles.size === 0) return 'OFF';
    return this.client.isTradingEnabled() ? 'REAL' : 'SIMULATION';
  }

  public resume(reason: string = 'User resume'): void {
    this.tradingState = 'RUNNING';
    this.restorePending = false;
    this.saveIntent({ state: 'RUNNING', mode: this.client.isTradingEnabled() ? 'REAL' : 'SIMULATION', all: 'MANAGED', reason });
    this.db.addLog('SECURITY', 'Automated trading RESUMED', reason);
  }

  // Phase 2: single order gateway. Every Bybit order and every local (simulated) trade action passes
  // through this check, so no code path can open exposure or act automatically while PAUSED/HALTED.
  //  - automated actions (TP, MART, basket, reopen) need RUNNING and no emergency stop;
  //  - any order that OPENS or ADDS exposure needs RUNNING and no emergency stop;
  //  - user-initiated reduce-only closes (manual close, emergency close) are always allowed.
  public assertOrderAllowed(reduceOnly: boolean, origin: OrderOrigin, what: string, scope: { cycleId?: string; symbol?: string } = {}): void {
    const halted = this.db.getSettings().emergencyStop;
    // Phase 6.2: RUNNING allows every cycle; otherwise only an individually managed cycle (or the start of one symbol)
    const allowed = this.tradingState === 'RUNNING' || (scope.cycleId ? this.managedCycles.has(scope.cycleId) : false) || (scope.symbol ? this.startPermits.has(scope.symbol) : false);
    const blocked = (origin === 'automated' || !reduceOnly) && (!allowed || halted || !this.isRunning);
    if (blocked) {
      const why = halted ? 'emergency stop is active' : !allowed ? 'engine is PAUSED' : 'engine is stopped';
      this.db.addLog('SECURITY', 'Order blocked', `${what} (${origin}, ${reduceOnly ? 'reduce-only' : 'opening'}) refused: ${why}`);
      throw new Error(`Order blocked: ${why}`);
    }
  }

  public getUptimeSeconds(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  public getLastTickTime(): number {
    return this.lastTickTime;
  }

  public getMaxLeverage(symbol: string): number {
    return this.marketInfoCache[symbol]?.maxLeverage || (symbol.includes('BTC') || symbol.includes('ETH') ? 100 : 50);
  }

  public getMarketInfo(symbol: string): SymbolMarketInfo | undefined {
    return this.marketInfoCache[symbol];
  }

  public getAllMarketInfo(): Record<string, SymbolMarketInfo> {
    return { ...this.marketInfoCache };
  }

  public getBybitClient(): BybitClient {
    return this.client;
  }

  public getWsClient(): BybitWsClient {
    return this.wsClient;
  }

  public getLiveWallet() {
    return this.liveWallet;
  }

  public getLatency(): number {
    return this.lastLatencyMs;
  }

  public setLatency(ms: number): void {
    this.lastLatencyMs = ms;
  }

  // Sync Bybit live wallet balance
  public async syncBybitWallet(customClient?: BybitClient): Promise<{ success: boolean; wallet?: any; error?: string }> {
    const activeClient = customClient || this.client;
    if (!activeClient.isConfigured()) {
      this.liveWallet = null;
      return { success: false, error: 'Bybit API credentials are not configured' };
    }
    try {
      const start = Date.now();
      const res = await activeClient.getWalletBalance();
      this.lastLatencyMs = Date.now() - start;
      const wasConnected = this.liveWallet?.connected;
      this.liveWallet = { ...res, lastUpdated: Date.now(), connected: true };
      this.connection.lastOkAt = Date.now();
      this.connection.state = 'CONNECTED';
      this.connection.error = null;
      if (!wasConnected) this.db.addLog('RECONCILE', 'Bybit wallet connected', `Account ${res.accountType} | equity ${res.totalEquity.toFixed(2)} USDT | available ${res.availableBalance.toFixed(2)} USDT`);
      return { success: true, wallet: this.liveWallet };
    } catch (err: any) {
      const errMsg = err.message || 'Failed to fetch Bybit wallet';
      // Phase 4: keep the last real values, marked stale — never replace them with zeros or samples.
      this.liveWallet = this.liveWallet
        ? { ...this.liveWallet, connected: false, errorMessage: errMsg }
        : null;
      if (this.connection.state !== 'ERROR') this.db.addLog('ERROR', 'Bybit wallet sync failed', errMsg);
      this.connection.state = 'ERROR';
      this.connection.error = err.bybit || { kind: 'RET_CODE', endpoint: 'wallet', message: errMsg };
      return { success: false, error: errMsg };
    }
  }

  // Phase 4: read-only connection check (time sync, key info, wallet, margin mode). No account changes.
  public async refreshConnection(): Promise<typeof this.connection> {
    const settings = this.db.getSettings();
    this.connection.environment = settings.environment;
    this.connection.lastCheckAt = Date.now();
    if (!this.client.isConfigured()) {
      this.connection.state = 'NO_CREDENTIALS';
      this.connection.keyInfo = null;
      return this.connection;
    }
    this.connection.state = 'CONNECTING';
    const r = await this.client.testConnection();
    this.connection.latencyMs = r.latencyMs;
    this.connection.timeOffsetMs = this.client.getTimeOffsetMs();
    if (r.success) {
      this.connection.state = 'CONNECTED';
      this.connection.lastOkAt = Date.now();
      this.connection.error = null;
      this.connection.keyInfo = r.keyInfo || null;
      this.connection.marginMode = r.marginMode ?? null;
      if (r.wallet) this.liveWallet = { ...r.wallet, lastUpdated: Date.now(), connected: true };
      this.db.addLog('RECONCILE', 'Bybit connection check: OK', r.message);
    } else {
      this.connection.state = 'ERROR';
      this.connection.error = r.error || { kind: 'RET_CODE', endpoint: 'test', message: r.message };
      // keep the last real wallet values but mark them stale (never zeroed or invented)
      if (this.liveWallet) this.liveWallet = { ...this.liveWallet, connected: false, errorMessage: r.message };
      this.db.addLog('ERROR', 'Bybit connection check failed', r.message);
    }
    return this.connection;
  }

  public getConnection() {
    return {
      ...this.connection,
      mode: this.client.isTradingEnabled() ? 'LIVE_ARMED' : 'READ_ONLY',
      host: this.client.getHost(),
      signMethod: this.client.isConfigured() ? this.client.getSignMethod() : null,
      credentialNotes: this.client.credentialNotes,
      // last requests to Bybit, newest first: host, path, HTTP status, retCode, retMsg (never the key/secret/signature)
      trace: this.client.getTrace().slice(0, 12),
    };
  }

  // Update Bybit API credentials
  public async updateApiCredentials(): Promise<void> {
    const settings = this.db.getSettings();
    this.client.updateCredentials(settings.apiKey, settings.apiSecret, settings.environment === 'testnet', settings.apiHost);
    this.wsClient.setTestnet(settings.environment === 'testnet');
    // Phase 4: the client can only send orders while live trading is armed in this process.
    this.client.setTradingEnabled(Boolean(settings.liveTrading && settings.apiKey && settings.apiSecret));
    if (settings.apiKey && settings.apiSecret) {
      await this.refreshConnection();
      await this.syncBybitPositions();
    } else {
      this.liveWallet = null;
      this.connection.state = 'NO_CREDENTIALS';
    }
  }

  public getClient(): BybitClient {
    return this.client;
  }

  // Fetch instruments & initial tickers
  public async refreshInstruments(): Promise<void> {
    try {
      const instruments = await this.client.getInstrumentsInfo();
      const tickers = await this.client.getTickers();

      for (const [sym, info] of Object.entries(instruments)) {
        const tick = tickers[sym];
        this.marketInfoCache[sym] = {
          ...info,
          lastPrice: tick?.lastPrice || 0, // Phase 3: no invented prices
          fromExchange: true,
          price24hPcnt: tick?.price24hPcnt || 0,
          price1hPcnt: tick?.price1hPcnt || 0,
          highPrice24h: tick?.highPrice24h || 0,
          lowPrice24h: tick?.lowPrice24h || 0,
          volume24h: tick?.volume24h || 0,
          turnover24h: tick?.turnover24h || 0,
          fundingRate: tick?.fundingRate || 0,
        };
      }
      this.instrumentsError = null;
      this.instrumentsAt = Date.now();
    } catch (err: any) {
      // Phase 6: no guessed instruments or prices; the symbol list shows this error instead.
      this.instrumentsError = err.message || String(err);
      console.warn('[Engine] Could not load the Bybit symbol list:', this.instrumentsError);
    }
  }

  public instrumentsError: string | null = null;
  public instrumentsAt: number | null = null;

  // Real-time Tick Handler
  private async handlePriceTick(symbol: string, partial: Partial<SymbolMarketInfo>): Promise<void> {
    this.lastTickTime = Date.now();
    let info = this.marketInfoCache[symbol];
    if (!info) {
      this.marketInfoCache[symbol] = {
        symbol,
        lastPrice: partial.lastPrice || 0,
        price24hPcnt: partial.price24hPcnt || 0,
        highPrice24h: partial.highPrice24h || 0,
        lowPrice24h: partial.lowPrice24h || 0,
        volume24h: partial.volume24h || 0,
        tickSize: 0.01,
        qtyStep: 0.001,
        minQty: 0.001,
        maxQty: 100000,
        minNotional: 5,
        maxLeverage: symbol.includes('BTC') || symbol.includes('ETH') ? 100 : symbol.includes('SOL') ? 50 : 25,
      };
      info = this.marketInfoCache[symbol];
    } else {
      if (partial.lastPrice) info.lastPrice = partial.lastPrice;
      if (partial.price24hPcnt !== undefined) info.price24hPcnt = partial.price24hPcnt;
      if (partial.price1hPcnt !== undefined) info.price1hPcnt = partial.price1hPcnt;
      if (partial.highPrice24h) info.highPrice24h = partial.highPrice24h;
      if (partial.lowPrice24h) info.lowPrice24h = partial.lowPrice24h;
      if (partial.volume24h) info.volume24h = partial.volume24h;
      if (partial.turnover24h) info.turnover24h = partial.turnover24h;
      if (partial.fundingRate !== undefined) info.fundingRate = partial.fundingRate;
    }

    if (!info.lastPrice || info.lastPrice <= 0) return;

    // Check emergency stop
    const settings = this.db.getSettings();
    if (!this.isRunning) return;
    // Phase 1: while PAUSED or halted, ticks only refresh marks/PnL; no strategy evaluation, no orders.
    this.updatePositionMarkPrices(symbol, info.lastPrice);
    if (settings.emergencyStop) return;
    // Phase 6.2: evaluate only when the whole bot runs, or when THIS symbol's cycle is individually managed
    const cyc = this.db.getStrategyCycle(symbol);
    if (this.tradingState !== 'RUNNING' && !(cyc && this.managedCycles.has(cyc.cycleId))) return;

    // Phase 3: the strategy engine owns all automated decisions (per-symbol lock, intents, state).
    try {
      await this.strategy.evaluate(symbol);
    } catch (err: any) {
      this.db.addLog('ERROR', `Strategy evaluation error: ${symbol}`, err.message, symbol);
    }
  }

  // Update mark prices and unrealized PnL on positions
  private updatePositionMarkPrices(symbol: string, currentPrice: number): void {
    const positions = this.db.getPositionsBySymbol(symbol);
    let changed = false;

    for (const pos of positions) {
      if (pos.missingOnExchangeSince) continue;
      pos.markPrice = currentPrice;
      pos.notional = pos.size * currentPrice;
      pos.margin = pos.notional / pos.leverage;

      // Pure price change % from entry
      if (pos.side === 'Buy') {
        pos.priceChangePct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        pos.unrealizedPnl = (currentPrice - pos.entryPrice) * pos.size;
        // Real liquidation prices are exchange/account values; ticks must never overwrite them.
        if (pos.paper) pos.liqPrice = Math.max(0, pos.entryPrice * (1 - (1 / pos.leverage) + 0.005));
        if (pos.tpPrice > 0) pos.distanceToTpPct = Math.max(0, ((pos.tpPrice - currentPrice) / currentPrice) * 100);
        if (pos.martPrice > 0) pos.distanceToMartPct = Math.max(0, ((currentPrice - pos.martPrice) / currentPrice) * 100);
        if (pos.freezePrice > 0) pos.distanceToFreezePct = Math.max(0, ((currentPrice - pos.freezePrice) / currentPrice) * 100);
      } else {
        pos.priceChangePct = ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
        pos.unrealizedPnl = (pos.entryPrice - currentPrice) * pos.size;
        if (pos.paper) pos.liqPrice = pos.entryPrice * (1 + (1 / pos.leverage) - 0.005);
        if (pos.tpPrice > 0) pos.distanceToTpPct = Math.max(0, ((currentPrice - pos.tpPrice) / currentPrice) * 100);
        if (pos.martPrice > 0) pos.distanceToMartPct = Math.max(0, ((pos.martPrice - currentPrice) / currentPrice) * 100);
        if (pos.freezePrice > 0) pos.distanceToFreezePct = Math.max(0, ((pos.freezePrice - currentPrice) / currentPrice) * 100);
      }
      pos.unrealizedPnlPct = pos.margin > 0 ? (pos.unrealizedPnl / pos.margin) * 100 : 0;
      pos.updatedAt = Date.now();
      this.db.savePosition(pos);
      changed = true;
    }
  }

  // Bootstrap active symbols upon startup (subscribe to market feed only)
  private async bootstrapActiveSymbols(): Promise<void> {
    const configs = this.db.getSymbolsConfig();
    const symbolsToSub: string[] = [];
    for (const [symbol, config] of Object.entries(configs)) {
      if (config.enabled) {
        symbolsToSub.push(symbol);
      }
    }
    if (symbolsToSub.length > 0) {
      this.wsClient.subscribeMultiple(symbolsToSub);
    }
  }

  // Periodic Reconciliation Loop (sync with Bybit live state & prices)
  private startReconcileLoop(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);

    this.reconcileTimer = setInterval(async () => {
      // A slow Bybit request may exceed the 10-second cadence. Never start a
      // second scheduled reconciliation on top of one still waiting on Bybit.
      if (this.scheduledReconcileRunning) return;
      this.scheduledReconcileRunning = true;
      try {
        await this.reconcile();
      } catch (err: any) {
        console.warn('[Engine] Reconcile error:', err.message);
      } finally {
        this.scheduledReconcileRunning = false;
      }
    }, 10000);
  }

  public async reconcile(): Promise<void> {
    const settings = this.db.getSettings();
    if (!Object.values(this.marketInfoCache).some((m) => m.fromExchange)) await this.refreshInstruments();
    if (this.restorePending) await this.tryRestore();

    // 1. Re-fetch current tickers for all known symbols
    try {
      const tickers = await this.client.getTickers();
      for (const [sym, tick] of Object.entries(tickers)) {
        if (tick.lastPrice && this.marketInfoCache[sym]) {
          this.handlePriceTick(sym, tick);
        }
      }
    } catch {
      // ignore transient network hiccups
    }

    // 2. Prioritize open positions. Wallet/funding must not delay position freshness.
    if (this.client.isConfigured()) {
      try {
        if (++this.reconcileCount % 30 === 0) await this.client.syncTime().catch(() => undefined);
        const r = await this.syncBybitPositions();
        if (r.success) {
          if (!this.restorePending) await this.strategy.resolveUnknownIntents(); // while pending, tryRestore resolves them
          this.strategy.checkAgainstExchange();
          // Funding is secondary. A serial read for every managed cycle (often
          // 80+) can hold the 10-second reconciliation lock for minutes.
          // Bound the per-pass budget; remaining cycles rotate on later passes.
          let fundingBudget = 4;
          const fundingCycles = Object.values(this.db.getStrategyCycles());
          const fundingStart = this.fundingCursor % Math.max(1, fundingCycles.length);
          this.fundingCursor = fundingStart + 4;
          for (const c of [...fundingCycles.slice(fundingStart), ...fundingCycles.slice(0, fundingStart)]) {
            if (c.mode !== 'LIVE' || c.status === 'CLOSED') continue;
            // read at most once a minute (well inside the 5-minute freshness limit used for basket decisions)
            if (c.fundingCheckedAt && Date.now() - c.fundingCheckedAt < 60_000 && !c.fundingError) continue;
            if ((this.fundingRetryAfter.get(c.symbol) || 0) > Date.now()) continue;
            if (fundingBudget-- <= 0) break;
            try {
              this.strategy.setFunding(c.symbol, await this.client.getFundingSince(c.symbol, c.startedAt));
              this.fundingRetryAfter.delete(c.symbol);
            } catch (err: any) {
              this.strategy.setFunding(c.symbol, null, err.message || String(err));
              this.fundingRetryAfter.set(c.symbol, Date.now() + 60_000);
            }
          }
          // Closed LIVE cycles: re-read funding for the exact cycle window once, so the record is final.
          let closedFundingBudget = 2;
          for (const h of this.db.getCycleHistory().slice(0, 20)) {
            if (h.mode !== 'LIVE' || h.fundingFinal || !h.endedAt) continue;
            if ((this.fundingRetryAfter.get(h.cycleId) || 0) > Date.now()) continue;
            if (closedFundingBudget-- <= 0) break;
            try {
              const f = await this.client.getFundingSince(h.symbol, h.startedAt, h.endedAt);
              this.db.updateCycleHistory(h.cycleId, { funding: f, fundingError: undefined, fundingAt: Date.now(), fundingFinal: true });
              this.fundingRetryAfter.delete(h.cycleId);
            } catch (err: any) {
              this.db.updateCycleHistory(h.cycleId, { fundingError: err.message || String(err), fundingCheckedAt: Date.now() });
              this.fundingRetryAfter.set(h.cycleId, Date.now() + 60_000);
            }
          }
        }
      } catch (err: any) {
        console.warn('[Engine] Bybit position reconciliation error:', err.message);
      }
    }
    // 3. Wallet is read after positions so a slow balance endpoint cannot
    // make the open-position table appear stale.
    if (settings.isApiKeyConfigured && settings.apiKey && settings.apiSecret) {
      try { await this.syncBybitWallet(); }
      catch { /* Transient wallet failure must not stop position sync. */ }
    }
  }

  // 3b. Sync and Reconcile Positions directly from Bybit
  public async syncBybitPositions(): Promise<{
    success: boolean;
    count: number;
    positions: BotPosition[];
    error?: string;
  }> {
    if (!this.client.isConfigured()) {
      return { success: false, count: 0, positions: [], error: 'Bybit API credentials are not configured' };
    }

    try {
      const liveList = await this.client.getPositions();
      const currentDbPositions = this.db.getPositions();
      const activeLiveList = (liveList || []).filter((p: any) => parseFloat(p.size || '0') > 0);

      const reconciledPositions: BotPosition[] = [];

      for (const live of activeLiveList) {
        const size = parseFloat(live.size || '0');
        const symbol = live.symbol;
        const side: PositionSide = live.side === 'Buy' || live.side === 'Sell' ? live.side : (live.positionIdx === 1 ? 'Buy' : 'Sell');
        const posIdx: 1 | 2 = live.positionIdx === 2 || side === 'Sell' ? 2 : 1;
        const posId = `${symbol}-${side}`;

        const entryPrice = parseFloat(live.avgPrice || live.entryPrice || '0');
        const markPrice = parseFloat(live.markPrice || (entryPrice > 0 ? entryPrice.toString() : '0'));
        const leverage = parseFloat(live.leverage || '50');
        const notional = parseFloat(live.positionValue || (size * markPrice).toString());
        const margin = parseFloat(live.positionIM || (leverage > 0 ? (notional / leverage).toString() : notional.toString()));
        const unrealizedPnl = parseFloat(live.unrealisedPnl || '0');
        const exchangeLiq = parseFloat(live.liqPrice || '');
        const liqPrice = Number.isFinite(exchangeLiq) && exchangeLiq > 0 ? exchangeLiq : undefined;
        const priceChangePct = entryPrice > 0 ? ((markPrice - entryPrice) / entryPrice) * (side === 'Buy' ? 100 : -100) : 0;
        const unrealizedPnlPct = margin > 0 ? (unrealizedPnl / margin) * 100 : 0;

        const existing = currentDbPositions.find((p) => p.id === posId);

        const config = this.db.getSymbolConfig(symbol);
        const tpPct = existing?.tpPct || (side === 'Buy' ? config?.buyTpPct || 2.5 : config?.sellTpPct || 2.5);
        const defaultTpPrice = side === 'Buy' ? entryPrice * (1 + tpPct / 100) : entryPrice * (1 - tpPct / 100);
        const tpPrice = live.takeProfit && parseFloat(live.takeProfit) > 0 ? parseFloat(live.takeProfit) : (existing?.tpPrice && existing.tpPrice > 0 ? existing.tpPrice : defaultTpPrice);

        // Phase 1: read-only. Existing Bybit TP values are read (above) and never created or changed.

        const pos: BotPosition = {
          id: posId,
          symbol,
          side,
          positionIdx: posIdx,
          // Phase 1: a position the bot has no record of is never assumed to be the bot's.
          owner: existing?.owner || 'external',
          size,
          entryPrice,
          markPrice,
          notional: Math.round(notional * 1000) / 1000,
          margin: Math.round(margin * 1000) / 1000,
          leverage,
          liqPrice,
          unrealizedPnl: Math.round(unrealizedPnl * 1000) / 1000,
          unrealizedPnlPct: Math.round(unrealizedPnlPct * 100) / 100,
          priceChangePct: Math.round(priceChangePct * 100) / 100,
          tpPrice,
          tpPct,
          martPrice: existing?.martPrice || 0,
          martPct: existing?.martPct || 75,
          martTriggered: existing?.martTriggered || false,
          freezePrice: existing?.freezePrice || 0,
          freezePct: existing?.freezePct || 1000,
          isFrozen: existing?.isFrozen || false,
          cycleId: existing?.cycleId || `bybit-${symbol}`,
          // Bybit createdTime is the FIRST EVER position created for the symbol,
          // not when the currently open trade began. Bybit V5 exposes openTime
          // specifically for the current position. Never inherit historical
          // local cycleStartTime or createdTime for exchange position age.
          // If Bybit reports openTime=0/unavailable, show unknown rather than
          // falsely claiming the current trade has been open for hundreds of days.
          cycleStartTime: Number(live.openTime) > 0 && Number(live.openTime) <= Date.now()
            ? Number(live.openTime) : 0,
          updatedAt: Date.now(),
          // display only (High Margin and position pages); the trading fields above are unchanged
          exchangeMargin: exchangeMarginOf(live.positionIM, this.connection.marginMode),
          exchangeMarginAt: Date.now(),
          tradeMode: Number(live.tradeMode) === 1 ? 'isolated' : Number(live.tradeMode) === 0 ? 'cross' : null,
        };

        reconciledPositions.push(pos);

        // Ensure symbol is configured in DB & subscribed in wsClient
        if (!this.db.getSymbolConfig(symbol)) {
          this.db.setSymbolConfig(symbol, {
            symbol,
            enabled: false,
            leverage,
            buyNotional: Math.max(10, Math.round(notional)),
            sellNotional: Math.max(10, Math.round(notional)),
            buyTpPct: 2.5,
            sellTpPct: 2.5,
            buyMartPct: 75,
            sellMartPct: 95,
            buyMartMultiplier: 1.5,
            sellMartMultiplier: 1.5,
            buyFreezePct: 1000,
            sellFreezePct: 1000,
            breakEvenTargetUSDT: 0.5,
            autoReopenOnTp: true,
            notes: 'Auto-detected from active Bybit positions',
          });
        }
        this.wsClient.subscribe(symbol);
      }

      // Phase 1: NEVER open or reopen anything during sync. A local position that Bybit no longer
      // reports is kept as a record, flagged MISSING ON EXCHANGE, excluded from strategy evaluation,
      // and surfaced for manual review.
      const now = Date.now();
      // Phase 3: the strategy is the authority for a position that was just filled (Bybit's list can
      // lag a fill), and PAPER positions exist only locally. Re-read the DB now (no await since) so
      // nothing the strategy wrote during the Bybit request is overwritten.
      const latestDb = this.db.getPositions();
      for (let k = reconciledPositions.length - 1; k >= 0; k--) {
        const rp = reconciledPositions[k];
        if (this.strategy.recentlyFilled(rp.id)) {
          const cur = latestDb.find((p) => p.id === rp.id);
          if (cur) reconciledPositions[k] = cur;
          else reconciledPositions.splice(k, 1);
        }
      }
      for (const dbPos of latestDb) {
        if (reconciledPositions.some((rp) => rp.id === dbPos.id)) continue;
        if (dbPos.paper || this.strategy.recentlyFilled(dbPos.id)) {
          reconciledPositions.push(dbPos);
          continue;
        }
        if (!dbPos.missingOnExchangeSince) {
          this.db.addLog(
            'RECONCILE',
            `Position not found on Bybit: ${dbPos.id}`,
            `Kept as a record and flagged for review. Not reopened. Last local state: ${JSON.stringify({ owner: dbPos.owner, size: dbPos.size, entryPrice: dbPos.entryPrice, cycleId: dbPos.cycleId })}`,
            dbPos.symbol
          );
          this.db.addAlert('warning', `Not on Bybit: ${dbPos.symbol} ${dbPos.side}`, 'Position is missing on the exchange. It was NOT reopened; review it manually.', dbPos.symbol);
        }
        reconciledPositions.push({ ...dbPos, missingOnExchangeSince: dbPos.missingOnExchangeSince || now, updatedAt: now });
      }

      this.db.updatePositions(reconciledPositions);

      // Sync real Bybit closed PnL history into database trades
      try {
        const closedPnlList = await this.client.getClosedPnl();
        if (closedPnlList && closedPnlList.length > 0) {
          // Phase 4: skip rows for orders the bot already recorded itself (no double counting).
          const knownOrderIds = new Set(this.db.getTrades().map((t) => t.orderId).filter(Boolean));
          const mappedTrades: TradeLog[] = closedPnlList.filter((c: any) => !knownOrderIds.has(c.orderId)).map((c: any) => ({
            id: `bybit-pnl-${c.orderId || c.createdTime}`,
            orderId: c.orderId || '',
            timestamp: parseInt(c.createdTime) || Date.now(),
            cycleId: `cycle-${c.symbol}`,
            symbol: c.symbol,
            side: c.side === 'Buy' ? 'Buy' : 'Sell',
            action: 'TP_CLOSE',
            price: parseFloat(c.avgExitPrice || '0'),
            qty: parseFloat(c.qty || '0'),
            notional: parseFloat(c.qty || '0') * parseFloat(c.avgExitPrice || '0'),
            fee: parseFloat(c.execFee || '0'),
            pnl: parseFloat(c.closedPnl || '0'),
            notes: `Bybit closed P&L (net of fees, side = closing order side): ${parseFloat(c.closedPnl || '0') >= 0 ? '+' : ''}${parseFloat(c.closedPnl || '0').toFixed(4)} USDT, exit ${c.avgExitPrice}`,
          }));
          this.db.syncBybitTrades(mappedTrades);
        }
      } catch (err: any) {
        console.warn('[Engine] Failed to sync closed PnL:', err.message);
      }

      // Phase 1: pruneStaleData() is no longer called here; it deleted cycles and symbol settings
      // without archiving them. Records are preserved.

      this.connection.positionsSyncedAt = Date.now();
      this.connection.positionsCount = activeLiveList.length;
      return { success: true, count: reconciledPositions.length, positions: reconciledPositions };
    } catch (err: any) {
      console.warn('[Engine] syncBybitPositions error:', err.message);
      this.connection.error = err.bybit || { kind: 'RET_CODE', endpoint: '/v5/position/list', message: err.message };
      this.connection.state = 'ERROR';
      return { success: false, count: 0, positions: [], error: err.message };
    }
  }
}

