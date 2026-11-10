// Server-side indicator / Smart MART alert evaluator. MONITORING ONLY: it reads candles (the shared chart candle cache)
// and the synced position snapshot, and raises notifications. It never imports the strategy or order code and has no
// way to open, close, MART, change TP, leverage, margin mode, freeze or ownership.
//
//  - One evaluator for the whole app; one loop (no per-alert timers or sockets), never two runs at once.
//  - Rules are grouped by symbol + timeframe: one history read per group per closed candle (cached tail joins).
//  - Confirmed-close signals by default; intrabar rules are evaluated on the forming candle and labelled so.
//  - Duplicate prevention: one event per rule + candle + position; cooldown per rule (and position).
//  - Restart recovery: each rule stores the last candle it evaluated; after a restart only the latest closed candle is
//    evaluated (old candles are not replayed into a burst of alerts).
//  - Definitions and history live in data/indicator_alerts.json (atomic writes), separate from trading records:
//    deleting an alert never touches trades, positions or cycles. History is capped (HISTORY_LIMIT).
import fs from 'node:fs';
import path from 'node:path';
import type { Bar } from '../../shared/indicators.ts';
import { INDICATORS } from '../../shared/indicators.ts';
import { ALERT_TIMEFRAMES, HISTORY_LIMIT, RULE_LIMIT, barsNeeded, conditionSpec, describeRule, evaluateCondition, lossPct, normalizeRule, timeframeLabel, timeframeSeconds, type AlertEvent, type AlertRule } from '../../shared/alertRules.ts';
import { positionMargin, syncAge } from '../../shared/positionMargin.ts';

export type AlertPosition = { id: string; symbol: string; side: 'Buy' | 'Sell'; owner: 'bot' | 'external'; size: number; entryPrice: number; markPrice: number; unrealizedPnl: number; notional: number; leverage: number; exchangeMargin?: number | null; paper?: boolean; missingOnExchangeSince?: number };
export interface AlertDeps {
  file: string;
  history: (symbol: string, interval: string, limit: number) => Promise<Bar[]>;
  positions: () => { list: AlertPosition[]; syncedAt: number | null };
  notify: (title: string, message: string, symbol: string) => void;
  now?: () => number;
  log?: (msg: string) => void;
}
type Store = { version: 1; rules: AlertRule[]; history: AlertEvent[] };

export class AlertService {
  private store: Store;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private lastIntrabar = new Map<string, number>(); // group -> last intrabar evaluation (ms)
  private wildcardSymbols: string[] = [];
  private wildcardLoadedAt = 0;
  private wildcardCursor = 0;
  private wildcardLastClosed = new Map<string, number>();
  private readonly wildcardBatch = 24; // bounded scan work on each 15-second tick
  readonly stats = { runs: 0, skippedOverlap: 0, historyReads: 0, events: 0, errors: 0, lastRunMs: 0 };
  constructor(private d: AlertDeps) { this.store = this.load(); }

  private now() { return this.d.now ? this.d.now() : Date.now(); }
  private load(): Store {
    try {
      const raw = JSON.parse(fs.readFileSync(this.d.file, 'utf8'));
      return { version: 1, rules: Array.isArray(raw.rules) ? raw.rules.slice(0, RULE_LIMIT) : [], history: Array.isArray(raw.history) ? raw.history.slice(0, HISTORY_LIMIT) : [] };
    } catch { return { version: 1, rules: [], history: [] }; }
  }
  private persistNow() {
    const tmp = this.d.file + '.tmp';
    fs.mkdirSync(path.dirname(this.d.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.store), { mode: 0o600 });
    fs.renameSync(tmp, this.d.file);
  }
  private persist() { if (this.saveTimer) return; this.saveTimer = setTimeout(() => { this.saveTimer = null; try { this.persistNow(); } catch (e: any) { this.d.log?.('[Alerts] save failed: ' + e.message); } }, 500); this.saveTimer.unref?.(); }
  flush() { if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; } this.persistNow(); }

  // ---------- management ----------
  rules() { return this.store.rules.map((r) => ({ ...r, description: describeRule(r) })); }
  history(filter: { symbol?: string; ruleId?: string; limit?: number } = {}) {
    const lim = Math.min(Math.max(1, filter.limit || 200), HISTORY_LIMIT);
    return this.store.history.filter((e) => (!filter.symbol || e.symbol === filter.symbol) && (!filter.ruleId || e.ruleId === filter.ruleId)).slice(0, lim);
  }
  create(input: any): AlertRule {
    if (this.store.rules.length >= RULE_LIMIT) throw Error(`At most ${RULE_LIMIT} alerts`);
    const r = normalizeRule(input, this.now());
    r.lastCandle = this.lastClosedStart(r.timeframe); // a new alert watches candles that close AFTER it was created
    this.store.rules.unshift(r); this.persist(); return r;
  }
  update(id: string, input: any): AlertRule {
    const i = this.store.rules.findIndex((r) => r.id === id);
    if (i < 0) throw Error('Alert not found');
    const r = normalizeRule({ ...this.store.rules[i], ...input }, this.now(), this.store.rules[i]);
    if (r.lastCandle === undefined) r.lastCandle = this.lastClosedStart(r.timeframe); // changed definition: from now on
    this.store.rules[i] = r; this.persist(); return r;
  }
  private lastClosedStart(tf: string) { const step = timeframeSeconds(tf), nowS = Math.floor(this.now() / 1000); return Math.floor(nowS / step) * step - step; }

  /** Public instrument metadata only. Never touches authenticated Bybit clients or the trade engine. */
  private async refreshWildcardSymbols(): Promise<void> {
    if (this.wildcardSymbols.length && this.now() - this.wildcardLoadedAt < 6 * 3600_000) return;
    const found = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor = '';
    do {
      const args = new URLSearchParams({ category: 'linear', limit: '500' });
      if (cursor) args.set('cursor', cursor);
      const response = await fetch('https://api.bybit.com/v5/market/instruments-info?' + args, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw Error('Instrument list HTTP ' + response.status);
      const body: any = await response.json();
      if (body.retCode !== 0 || !Array.isArray(body.result?.list)) throw Error('Invalid Bybit instrument response');
      for (const item of body.result.list) if (item.status === 'Trading' && item.contractType === 'LinearPerpetual' && item.quoteCoin === 'USDT' && /^[A-Z0-9]{2,30}USDT$/.test(item.symbol)) found.add(item.symbol);
      const next = String(body.result.nextPageCursor || '');
      if (next && seenCursors.has(next)) throw Error('Repeated instrument cursor');
      if (next) seenCursors.add(next);
      cursor = next;
    } while (cursor && seenCursors.size < 20);
    if (!found.size || cursor) throw Error('Incomplete Bybit instrument list');
    this.wildcardSymbols = [...found].sort();
    this.wildcardLoadedAt = this.now();
    this.wildcardCursor %= this.wildcardSymbols.length;
  }
  setEnabled(id: string, enabled: boolean) { return this.update(id, { enabled }); }
  remove(id: string): boolean {
    const n = this.store.rules.length;
    this.store.rules = this.store.rules.filter((r) => r.id !== id); // history records are kept (they are a log)
    if (this.store.rules.length !== n) this.persist();
    return this.store.rules.length !== n;
  }
  markSeen(ids: string[] | 'all') { let n = 0; for (const e of this.store.history) if (e.status === 'new' && (ids === 'all' || ids.includes(e.id))) { e.status = 'seen'; n++; } if (n) this.persist(); return n; }
  unseen() { return this.store.history.filter((e) => e.status === 'new').length; }
  /** compact summary for the live snapshot (notification bell, sidebar counts) */
  summary() { return { unseen: this.unseen(), rules: this.store.rules.length, smartRules: this.store.rules.filter((r) => r.requirePosition).length, events: this.store.history.length, latest: this.store.history.slice(0, 20) }; }

  // ---------- evaluation loop ----------
  start(intervalMs = 15000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    void this.tick();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; try { this.flush(); } catch { /* best effort */ } }

  /** One evaluation pass. Concurrent calls are skipped (no overlapping runs). */
  async tick(): Promise<number> {
    if (this.running) { this.stats.skippedOverlap++; return 0; }
    this.running = true;
    const t0 = Date.now();
    let raised = 0;
    try {
      const nowS = Math.floor(this.now() / 1000);
      const groups = new Map<string, AlertRule[]>();
      for (const r of this.store.rules) if (r.enabled && r.symbol !== '*') { const k = r.symbol + '|' + r.timeframe; (groups.get(k) || groups.set(k, []).get(k)!).push(r); }
      const wildcardRules = this.store.rules.filter((r) => r.enabled && r.symbol === '*' && !r.requirePosition);
      if (wildcardRules.length) {
        try {
          await this.refreshWildcardSymbols();
          for (let j = 0; j < Math.min(this.wildcardBatch, this.wildcardSymbols.length); j++) {
            const symbol = this.wildcardSymbols[this.wildcardCursor++ % this.wildcardSymbols.length];
            for (const r of wildcardRules) {
              const k = symbol + '|' + r.timeframe;
              (groups.get(k) || groups.set(k, []).get(k)!).push(r);
            }
          }
        } catch (e: any) { this.stats.errors++; this.d.log?.('[Alerts] all-market universe unavailable: ' + e.message); }
      }
      for (const [key, rules] of groups) {
        const [symbol, tf] = key.split('|');
        const step = timeframeSeconds(tf);
        if (!Number.isFinite(step)) continue;
        // start of the last CLOSED candle: daily/intraday candles are UTC aligned on Bybit
        const lastClosed = Math.floor(nowS / step) * step - step;
        const closeRules = rules.filter((r) => r.mode === 'close' && (r.symbol === '*' ? (this.wildcardLastClosed.get(r.id + '|' + symbol) ?? r.lastCandle ?? lastClosed) < lastClosed : (r.lastCandle === undefined || r.lastCandle < lastClosed)));
        const intraRules = rules.filter((r) => r.mode === 'intrabar');
        const intraDue = intraRules.length > 0 && this.now() - (this.lastIntrabar.get(key) || 0) >= 30000;
        if (!closeRules.length && !intraDue) continue;
        const limit = Math.max(...[...closeRules, ...(intraDue ? intraRules : [])].map(barsNeeded));
        let bars: Bar[];
        try { this.stats.historyReads++; bars = await this.d.history(symbol, tf, limit + 1); }
        catch (e: any) { this.stats.errors++; this.d.log?.(`[Alerts] ${symbol} ${timeframeLabel(tf)} history unavailable: ${e.message}`); continue; }
        bars = [...bars].sort((a, b) => a.time - b.time).filter((b, i, a) => i === 0 || b.time !== a[i - 1].time);
        const closed = bars.filter((b) => b.time + step <= nowS);
        const li = closed.length - 1;
        if (li >= 1 && closed[li].time === lastClosed) {
          for (const r of closeRules) { raised += this.fire(r, closed, li, 'close', symbol); if (r.symbol === '*') this.wildcardLastClosed.set(r.id + '|' + symbol, lastClosed); else r.lastCandle = lastClosed; }
          this.persist();
        } else if (nowS >= lastClosed + step + 120) {
          // no candle for that period 2 minutes after the next one started: a trading halt. Nothing is fabricated;
          // the period is marked as evaluated without a signal. Before that, the next pass simply retries.
          for (const r of closeRules) { if (r.symbol === '*') this.wildcardLastClosed.set(r.id + '|' + symbol, lastClosed); else r.lastCandle = lastClosed; }
          this.persist();
        }
        if (intraDue) {
          this.lastIntrabar.set(key, this.now());
          const last = bars.length - 1;
          if (last >= 1 && bars[last].time > lastClosed) for (const r of intraRules) raised += this.fire(r, bars, last, 'intrabar', symbol);
        }
      }
    } catch (e: any) { this.stats.errors++; this.d.log?.('[Alerts] evaluation error: ' + e.message); }
    finally { this.running = false; this.stats.runs++; this.stats.lastRunMs = Date.now() - t0; }
    return raised;
  }

  private fire(r: AlertRule, bars: Bar[], i: number, mode: 'close' | 'intrabar', symbol = r.symbol): number {
    let ev: ReturnType<typeof evaluateCondition>;
    try { ev = evaluateCondition(r, bars, i); } catch (e: any) { this.stats.errors++; this.d.log?.(`[Alerts] ${r.name}: ${e.message}`); return 0; }
    if (!ev.hit) return 0;
    const now = this.now(), bar = bars[i], spec = conditionSpec(r.indicator, r.condition)!;
    const targets: (AlertPosition | null)[] = [];
    if (r.requirePosition) {
      const snap = this.d.positions();
      if (syncAge(snap.syncedAt, now).stale) return 0; // never alert on an unconfirmed (stale) position snapshot
      for (const p of snap.list) {
        if (p.symbol !== symbol || p.paper || p.missingOnExchangeSince || !(p.size > 0)) continue;
        if (r.side !== 'Both' && p.side !== r.side) continue;
        if (r.owner !== 'all' && p.owner !== r.owner) continue;
        if (r.minLossPct !== undefined && r.minLossPct > 0) {
          const loss = lossPct(p, r.lossBasis, positionMargin(p).value);
          if (loss === null || loss < r.minLossPct) continue;
        }
        targets.push(p);
      }
      if (!targets.length) return 0;
    } else targets.push(null);
    let n = 0;
    for (const p of targets) {
      const id = `${r.id}|${symbol}|${bar.time}|${mode}|${p?.id || '-'}`;
      if (this.store.history.some((e) => e.id === id)) continue; // duplicate
      const last = this.store.history.find((e) => e.ruleId === r.id && e.symbol === symbol && (e.positionId || '-') === (p?.id || '-'));
      if (r.cooldownMin > 0 && last && now - last.at < r.cooldownMin * 60000) continue;
      const loss = p ? lossPct(p, r.lossBasis, positionMargin(p).value) : null;
      const e: AlertEvent = {
        id, ruleId: r.id, ruleName: r.name, symbol, marketWide: r.symbol === '*', indicator: r.indicator, params: r.params, period2: r.period2,
        timeframe: r.timeframe, condition: r.condition, conditionLabel: spec.label, mode, candleTime: bar.time, price: bar.close,
        indicatorValues: ev.values, positionId: p?.id, positionSide: p?.side, positionOwner: p?.owner,
        positionPnl: p ? p.unrealizedPnl : undefined, positionLossPct: loss ?? undefined, lossBasis: p ? r.lossBasis : undefined,
        at: now, status: 'new',
      };
      this.store.history.unshift(e);
      if (this.store.history.length > HISTORY_LIMIT) this.store.history.length = HISTORY_LIMIT;
      r.lastTriggeredAt = now; n++; this.stats.events++;
      const who = p ? ` · ${p.owner === 'bot' ? 'BOT' : 'External'} ${p.side === 'Buy' ? 'BUY' : 'SELL'} ${loss !== null ? (loss >= 0 ? 'loss ' : 'profit ') + Math.abs(loss).toFixed(2) + '% (' + (r.lossBasis === 'roi' ? 'ROI' : 'price') + ')' : ''}` : '';
      this.d.notify(`${r.requirePosition ? 'Smart MART alert' : 'Indicator alert'}: ${symbol} ${INDICATORS[r.indicator].key}`,
        `${spec.label} on ${timeframeLabel(r.timeframe)}${mode === 'intrabar' ? ' (intrabar, candle not closed)' : ''} at ${bar.close}${who}. Notification only — no order was placed.`, symbol);
    }
    if (n && r.frequency === 'once') r.enabled = false;
    if (n) this.persist();
    return n;
  }
}

export const ALERT_INTERVALS = ALERT_TIMEFRAMES.map((t) => t.value);
