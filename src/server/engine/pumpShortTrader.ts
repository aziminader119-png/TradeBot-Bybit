import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { BotDatabase } from '../db/database.ts';
import type { TradingEngine } from './tradingEngine.ts';
import type { PumpShortScanner, PumpCandidate } from './pumpShortScanner.ts';
import { pumpShortEntryTarget } from './pumpShort.ts';

export type PumpTradeStatus = 'ENTRY_PENDING' | 'OPEN' | 'EXIT_PENDING' | 'CLOSED' | 'REVIEW';
export type PumpTrade = {
  id: string; symbol: string; status: PumpTradeStatus; entryPrice: number; exitPrice: number | null;
  target: number; waveLow: number; waveHigh: number; qty: number; entryAt: number; exitAt: number | null;
  entryLinkId: string; exitLinkId: string | null; note: string | null;
};

/** Independent ledger: uncertain Bybit results stay REVIEW and can never trigger duplicate orders. */
export class PumpShortTrader {
  private file = path.resolve(process.cwd(), 'data', 'pump_short_trades.json');
  private trades: PumpTrade[] = [];
  private armed = false; // Never persists across process restarts.
  private busy = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastError: string | null = null;
  private marks: Record<string, number> = {};
  private lastReasonLog = new Map<string, number>();

  private explain(reason: string, details: string, symbol?: string, intervalMs = 300_000) {
    const key = `${reason}:${symbol || ''}`;
    const now = Date.now();
    if (now - (this.lastReasonLog.get(key) || 0) < intervalMs) return;
    this.lastReasonLog.set(key, now);
    this.db.addLog('CYCLE', `Pump Short: ${reason}`, details.slice(0, 350), symbol);
  }

  constructor(private engine: TradingEngine, private db: BotDatabase, private scanner: PumpShortScanner) {
    if (fs.existsSync(this.file)) {
      try {
        const saved: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (!Array.isArray(saved)) throw Error('Invalid Pump Short ledger');
        this.trades = saved as PumpTrade[];
      } catch (e: any) { this.lastError = `Cannot read Pump Short ledger: ${e.message}`; }
    }
  }

  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.trades, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  public snapshot() {
    return { armed: this.armed, mode: this.engine.getTradingMode(), busy: this.busy,
      error: this.lastError, trades: this.trades.slice().reverse().map(t => ({ ...t,
        markPrice: this.marks[t.symbol] || null,
        unrealizedPnl: t.status === 'OPEN' && this.marks[t.symbol] ? (t.entryPrice - this.marks[t.symbol]) * t.qty : null,
      })) };
  }

  public arm(confirmed: boolean) {
    if (!confirmed) throw Error('Explicit confirmation is required');
    if (this.engine.getTradingMode() !== 'REAL') throw Error('Set the main trading mode to REAL first');
    if (this.db.getSettings().emergencyStop) throw Error('Emergency stop is active');
    if (this.lastError?.startsWith('Cannot read Pump Short ledger')) throw Error(this.lastError);
    this.armed = true;
    this.db.addLog('SECURITY', 'Pump Short ARMED', 'Explicitly armed REAL Pump Short trading; max 10 active/pending positions');
  }
  public disarm() { this.armed = false; this.db.addLog('SECURITY', 'Pump Short DISARMED', 'Pump Short execution stopped'); }

  public start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 15_000);
    this.timer.unref?.();
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.lastError?.startsWith('Cannot read Pump Short ledger')) return;
      if (this.engine.getTradingMode() !== 'REAL') this.armed = false;
      const client = this.engine.getClient();
      const positions = await client.getPositions();
      try {
        const tickers = await client.getTickers();
        for (const trade of this.trades) {
          const p = tickers[trade.symbol]?.lastPrice;
          if (p && p > 0) this.marks[trade.symbol] = p;
        }
      } catch { /* Missing marks must not block reconciliations. */ }
      // Reconcile tracked positions even while entry is disarmed. Exit orders require REAL.
      for (const trade of this.trades) {
        if (trade.status === 'CLOSED' || trade.status === 'REVIEW') continue;
        const live = positions.find(p => p.symbol === trade.symbol && p.side === 'Sell' && Number(p.size) > 0);
        if (trade.status === 'ENTRY_PENDING') {
          if (live) {
            trade.status = 'OPEN'; trade.qty = Number(live.size); trade.entryPrice = Number(live.avgPrice) || trade.entryPrice;
            if (trade.entryPrice > trade.waveLow)
              trade.target = pumpShortEntryTarget(trade.entryPrice, trade.waveLow, this.db.getSettings().pumpShort!.retracementPct);
            this.save();
          }
          continue;
        }
        if (trade.status === 'EXIT_PENDING') {
          if (!live && trade.exitLinkId) {
            try {
              const order = await client.getOrderByLinkId(trade.symbol, trade.exitLinkId);
              if (order?.orderStatus === 'Filled') {
                trade.status = 'CLOSED'; trade.exitAt = Date.now();
                trade.exitPrice = order.avgPrice || trade.exitPrice; trade.note = null; this.save();
              } else if (order?.orderStatus === 'Rejected' || order?.orderStatus === 'Cancelled') {
                trade.status = 'REVIEW'; trade.note = `Exit order ${order.orderStatus}`; this.save();
              }
            } catch (e: any) { trade.note = `Exit verification pending: ${e.message}`; this.save(); }
          }
          continue;
        }
        if (!live) { trade.status = 'REVIEW'; trade.note = 'SHORT missing on exchange; inspect before declaring closed'; this.save(); this.explain('Manual review', trade.note, trade.symbol); continue; }
        // Recalculate existing live targets when deploying this formula or changing dashboard %.
        if (!(trade.entryPrice > trade.waveLow)) { trade.status = 'REVIEW'; trade.note = 'Entry is not above wave low; exit target requires review'; this.save(); this.explain('Manual review', trade.note, trade.symbol); continue; }
        const desiredTarget = pumpShortEntryTarget(trade.entryPrice, trade.waveLow, this.db.getSettings().pumpShort!.retracementPct);
        if (trade.target !== desiredTarget) { trade.target = desiredTarget; this.save(); }
        if (!this.armed || this.engine.getTradingMode() !== 'REAL') continue;
        const price = this.marks[trade.symbol] || 0;
        if (price <= 0 || price > trade.target) continue;
        this.engine.assertOrderAllowed(true, 'automated', `Pump Short exit ${trade.symbol}`);
        trade.status = 'EXIT_PENDING';
        trade.exitLinkId = `ps-x-${crypto.randomUUID().replace(/-/g, '').slice(0, 27)}`;
        trade.exitPrice = price; this.save();
        this.explain('Exit submitted', `Market close requested at ${price}, target ${trade.target}`, trade.symbol, 0);
        try {
          await client.createOrder({ category: 'linear', symbol: trade.symbol, side: 'Buy', orderType: 'Market',
            qty: String(Number(live.size)), positionIdx: 2, reduceOnly: true, orderLinkId: trade.exitLinkId });
        } catch (e: any) {
          if (e.rejected === true) { trade.status = 'OPEN'; trade.exitLinkId = null; trade.exitPrice = null; }
          trade.note = `${e.rejected === true ? 'EXIT rejected' : 'EXIT status uncertain'}: ${e.message}`;
          this.save(); this.explain('Exit order issue', trade.note, trade.symbol, 0);
        }
      }
      if (!this.armed || this.engine.getTradingMode() !== 'REAL' || this.db.getSettings().emergencyStop) {
        this.explain('Entries paused', `Armed=${this.armed}; mode=${this.engine.getTradingMode()}; emergencyStop=${Boolean(this.db.getSettings().emergencyStop)}`);
        return;
      }
      const scan = this.scanner.snapshot();
      if (scan.running || !scan.lastCompletedAt || Date.now() - scan.lastCompletedAt > 10 * 60_000) {
        this.explain('Scanner not ready', `Running=${scan.running}; last completed=${scan.lastCompletedAt || 'never'}`);
        return;
      }
      // One new order per pass, and no more than ten owned open/pending shorts overall.
      const occupied = this.trades.filter(t => t.status !== 'CLOSED').length;
      if (occupied >= 10) { this.explain('Position limit', `${occupied}/10 Pump Short positions or unresolved records; no new orders until slots are available.`); return; }
      const existing = new Set(positions.filter(p => p.side === 'Sell' && Number(p.size) > 0).map(p => String(p.symbol)));
      const candidate = scan.candidates.find(c => !c.excludedShort && !existing.has(c.symbol) &&
        !this.trades.some(t => t.symbol === c.symbol && t.status !== 'CLOSED'));
      if (!candidate) { this.explain('No available candidate', `${scan.candidates.length} pump candidates; all excluded due to existing SHORT or Pump Short records.`); return; }
      await this.open(candidate);
    } catch (e: any) { this.lastError = e.message || String(e); this.explain('Trading error', this.lastError || 'Unknown error'); }
    finally { this.busy = false; }
  }

  private async open(candidate: PumpCandidate) {
    const client = this.engine.getClient();
    // Fresh exchange checks immediately before sending an order.
    const fresh = await client.getPositions(candidate.symbol);
    if (fresh.some(p => p.side === 'Sell' && Number(p.size) > 0)) { this.explain('Existing SHORT', 'Exchange reports an open SHORT; duplicate entry skipped.', candidate.symbol); return; }
    const instrument = (await client.getInstrumentsInfo(candidate.symbol))[candidate.symbol];
    const price = (await client.getTickers(candidate.symbol))[candidate.symbol]?.lastPrice || 0;
    if (!instrument || instrument.missingRules?.length) { this.explain('Instrument rules', `Missing instrument or rules: ${instrument?.missingRules?.join(', ') || 'instrument unavailable'}`, candidate.symbol); return; }
    if (!(price > candidate.low)) { this.explain('Price filter', `Current price ${price} must exceed pump wave low ${candidate.low}`, candidate.symbol); return; }
    const settings = this.db.getSettings().pumpShort;
    if (!settings) { this.explain('Settings unavailable', 'Pump Short settings could not be loaded.', candidate.symbol); return; }
    const step = instrument.qtyStep;
    const decimals = String(step).split('.')[1]?.length || 0;
    const qty = Number((Math.floor((settings.positionNotionalUsdt / price) / step + 1e-9) * step).toFixed(decimals));
    if (!(qty >= instrument.minQty) || qty > instrument.maxQty || qty * price < instrument.minNotional) {
      this.explain('Order size rejected', `Notional=${settings.positionNotionalUsdt} USDT; qty=${qty}; minQty=${instrument.minQty}; maxQty=${instrument.maxQty}; minNotional=${instrument.minNotional}; price=${price}`, candidate.symbol);
      return;
    }
    this.engine.assertOrderAllowed(false, 'automated', `Pump Short open ${candidate.symbol}`);
    const trade: PumpTrade = { id: crypto.randomUUID(), symbol: candidate.symbol, status: 'ENTRY_PENDING',
      entryPrice: price, exitPrice: null, target: pumpShortEntryTarget(price, candidate.low, settings.retracementPct), waveLow: candidate.low,
      waveHigh: candidate.high, qty, entryAt: Date.now(), exitAt: null,
      entryLinkId: `ps-e-${crypto.randomUUID().replace(/-/g, '').slice(0, 27)}`, exitLinkId: null, note: null };
    this.trades.push(trade); this.save(); // Must persist before network call.
    this.explain('Entry submitted', `SHORT qty=${qty}; estimated value=${(qty * price).toFixed(4)} USDT; target=${trade.target}`, candidate.symbol, 0);
    try {
      await client.createOrder({ category: 'linear', symbol: candidate.symbol, side: 'Sell', orderType: 'Market',
        qty: String(qty), positionIdx: 2, reduceOnly: false, orderLinkId: trade.entryLinkId });
    } catch (e: any) {
      if (e.rejected === true) trade.status = 'REVIEW';
      trade.note = `${e.rejected === true ? 'ENTRY rejected' : 'ENTRY status uncertain'}: ${e.message}`;
      this.save(); this.explain('Entry order issue', trade.note, candidate.symbol, 0);
    }
  }
}
