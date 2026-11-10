// Read-only, bounded cache of Bybit linear candles for the chart (display only: never used for orders, sizing,
// TP or any trading decision; the strategy has its own price feed).
//
// Only CLOSED candles are stored; the still-forming candle is always read fresh. Each series (Bybit host +
// symbol + interval) keeps one contiguous run of closed candles.
//   - Latest view: when a contiguous run exists, only the tail from the last stored candle is read from Bybit and
//     joined to it (normally one small request instead of a full page).
//   - Older pages (scroll-back): served from the run when it fully covers the request; otherwise read from Bybit
//     and prepended when the pages are adjacent.
//   - Requests with an explicit start (gap recovery) always go to Bybit.
// Identical concurrent reads share one Bybit request. A stored candle that differs from a fresh copy invalidates
// the run. Limits: maxSeries runs (least recently used evicted), maxBarsPerSeries candles per run (oldest
// dropped), idle runs expire, and every run is rebuilt after revalidateMs. Errors are never cached.
export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Series = { bars: Candle[]; headComplete: boolean; lastUse: number; validatedAt: number };
// `scope` (the Bybit host) is passed so the reader can refuse a read when the active host changed meanwhile.
type Fetch = (symbol: string, interval: string, limit: number, start?: number, end?: number, scope?: string) => Promise<Candle[]>;
export type CandleCacheOptions = { fetch: Fetch; now?: () => number; maxSeries?: number; maxBarsPerSeries?: number; idleTtlMs?: number; revalidateMs?: number };

const MINUTES: Record<string, number> = { 1: 1, 3: 3, 5: 5, 15: 15, 30: 30, 60: 60, 120: 120, 240: 240, 360: 360, 720: 720, D: 1440, W: 10080 };
/** Start (seconds) of the candle after the one starting at `time`. */
export function nextCandleStart(time: number, interval: string): number {
  if (interval === 'M') { const d = new Date(time * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000; }
  const m = MINUTES[interval];
  if (!m) throw Error('Unsupported candle interval');
  return time + m * 60;
}
/** Shortest possible distance between two candle starts, in milliseconds (a month is at least 28 days). */
const minGapMs = (interval: string) => (interval === 'M' ? 28 * 86400000 : MINUTES[interval] * 60000);
const same = (a: Candle, b: Candle) => a.time === b.time && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume;

export class CandleCache {
  private series = new Map<string, Series>();
  private inflight = new Map<string, Promise<Candle[]>>();
  private o: Required<Omit<CandleCacheOptions, 'now'>> & { now: () => number };
  readonly stats = { hits: 0, tailJoins: 0, misses: 0, bybitReads: 0, invalidations: 0, evictions: 0 };
  constructor(options: CandleCacheOptions) {
    this.o = { maxSeries: 32, maxBarsPerSeries: 5000, idleTtlMs: 30 * 60000, revalidateMs: 6 * 3600000, now: () => Date.now(), ...options };
  }
  size() { let bars = 0; for (const s of this.series.values()) bars += s.bars.length; return { series: this.series.size, bars }; }
  clear() { this.series.clear(); }

  private read(scope: string, symbol: string, interval: string, limit: number, start?: number, end?: number): Promise<Candle[]> {
    // the scope (Bybit host) is part of the key: concurrent reads for another host never share a response
    const key = [scope, symbol, interval, limit, start ?? '', end ?? ''].join('|');
    const shared = this.inflight.get(key);
    if (shared) return shared;
    this.stats.bybitReads++;
    const p = this.o.fetch(symbol, interval, limit, start, end, scope).finally(() => { if (this.inflight.get(key) === p) this.inflight.delete(key); });
    this.inflight.set(key, p);
    return p;
  }
  private closed(bars: Candle[], interval: string) { const now = this.o.now() / 1000; return bars.filter((b) => nextCandleStart(b.time, interval) <= now); }
  private touch(key: string): Series | undefined {
    const now = this.o.now();
    for (const [k, s] of this.series) if (now - s.lastUse > this.o.idleTtlMs || now - s.validatedAt > this.o.revalidateMs) { this.series.delete(k); this.stats.evictions++; }
    const s = this.series.get(key);
    if (s) { this.series.delete(key); s.lastUse = now; this.series.set(key, s); }
    return s;
  }
  private store(key: string, s: Series) {
    if (s.bars.length > this.o.maxBarsPerSeries) { s.bars = s.bars.slice(s.bars.length - this.o.maxBarsPerSeries); s.headComplete = false; }
    if (!s.bars.length) { this.series.delete(key); return; }
    this.series.delete(key); this.series.set(key, s);
    while (this.series.size > this.o.maxSeries) { this.series.delete(this.series.keys().next().value!); this.stats.evictions++; }
  }
  /** Replace the run with fresh closed candles (first sighting, or after a mismatch / gap). */
  private seed(key: string, bars: Candle[], interval: string, headComplete: boolean) {
    const now = this.o.now();
    this.store(key, { bars: this.closed(bars, interval), headComplete, lastUse: now, validatedAt: now });
  }
  /** Append fresh candles that start at or before the run's last candle; false if they do not connect or disagree. */
  private append(s: Series, fresh: Candle[], interval: string): boolean {
    const last = s.bars[s.bars.length - 1];
    if (!fresh.length || fresh[0].time > last.time) return false;
    const byTime = new Map(s.bars.slice(-fresh.length - 1).map((b) => [b.time, b]));
    for (const b of fresh) { const old = byTime.get(b.time); if (old && !same(old, b)) return false; }
    const add = this.closed(fresh.filter((b) => b.time > last.time), interval);
    if (add.length) s.bars = s.bars.concat(add);
    return true;
  }

  async history(scope: string, symbol: string, interval: string, limit: number, start?: number, end?: number): Promise<Candle[]> {
    nextCandleStart(0, interval); // validates the interval
    const key = scope + '|' + symbol + '|' + interval;
    const now = this.o.now();
    // 1. explicit start (gap recovery after a reconnect): always fresh; extend the run when it connects
    if (start !== undefined) {
      const fresh = await this.read(scope, symbol, interval, limit, start, end);
      const s = this.touch(key);
      if (s && fresh.length && !this.append(s, fresh, interval) && fresh[0].time <= s.bars[s.bars.length - 1].time) { this.series.delete(key); this.stats.invalidations++; }
      else if (s) this.store(key, s);
      return fresh;
    }
    // 2. latest candles (no end, or an end inside the current candle)
    if (end === undefined || end >= now - minGapMs(interval)) {
      const s = this.touch(key);
      if (s && s.bars.length) {
        const last = s.bars[s.bars.length - 1];
        const tail = await this.read(scope, symbol, interval, 1000, last.time * 1000);
        const live = this.series.get(key) === s;
        if (live && tail.length && tail[0].time <= last.time) {
          if (this.append(s, tail, interval)) {
            const merged = s.bars.filter((b) => b.time < tail[0].time).concat(tail);
            this.store(key, s);
            if (merged.length >= limit || s.headComplete) { this.stats.tailJoins++; return merged.slice(-limit); }
          } else { this.series.delete(key); this.stats.invalidations++; }
        }
      }
      this.stats.misses++;
      const bars = await this.read(scope, symbol, interval, limit, undefined, end);
      this.seed(key, bars, interval, bars.length < limit);
      return bars;
    }
    // 3. older candles (scroll-back)
    const endSec = end / 1000;
    const s = this.touch(key);
    if (s && s.bars.length && s.bars[0].time <= endSec && endSec <= s.bars[s.bars.length - 1].time) {
      let i = s.bars.length - 1;
      while (i >= 0 && s.bars[i].time > endSec) i--;
      const upTo = s.bars.slice(0, i + 1);
      if (upTo.length >= limit || s.headComplete) { this.stats.hits++; return upTo.slice(-limit); }
    }
    if (s && s.bars.length && endSec < s.bars[0].time) {
      // whole request before the run: answer from Bybit, then prepend if the pages are adjacent
      if (s.headComplete && s.bars[0].time * 1000 - end < minGapMs(interval)) { this.stats.hits++; return []; }
    }
    this.stats.misses++;
    const bars = await this.read(scope, symbol, interval, limit, undefined, end);
    const cur = this.series.get(key);
    if (!cur || !cur.bars.length) { if (bars.length) this.seed(key, bars, interval, bars.length < limit); return bars; }
    const first = cur.bars[0];
    const adjacent = first.time * 1000 - end < minGapMs(interval) && end < first.time * 1000;
    const overlapping = bars.length > 0 && bars[bars.length - 1].time >= first.time;
    if (adjacent || overlapping) {
      const byTime = new Map(cur.bars.slice(0, bars.length + 1).map((b) => [b.time, b]));
      if (bars.some((b) => byTime.has(b.time) && !same(byTime.get(b.time)!, b))) { this.series.delete(key); this.stats.invalidations++; return bars; }
      const older = bars.filter((b) => b.time < first.time);
      cur.bars = older.concat(cur.bars);
      if (bars.length < limit) cur.headComplete = true;
      this.store(key, cur);
    }
    return bars;
  }
}
