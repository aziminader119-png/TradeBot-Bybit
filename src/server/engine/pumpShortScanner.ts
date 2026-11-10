import type { BybitClient } from '../bybit/bybitClient.ts';
import type { BotDatabase } from '../db/database.ts';
import { DEFAULT_PUMP_SHORT, findPumpWave, isPumpShortEntryEligible, pumpShortEntryTarget } from './pumpShort.ts';

export interface PumpCandidate {
  symbol: string;
  low: number;
  high: number;
  growthPct: number;
  retracementTarget: number;
  lastPrice: number;
  excludedShort: boolean;
}

/** Explicit, read-only scan. No orders and no changes to existing cycles. */
export class PumpShortScanner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private checked = 0;
  private total = 0;
  private error: string | null = null;
  private lastCompletedAt: number | null = null;
  private candidates: PumpCandidate[] = [];

  constructor(private client: BybitClient, private db: BotDatabase) {}

  /** Scan continuously, independently of the legacy hedge strategy. */
  public start(): void {
    if (this.timer) return;
    void this.scan();
    this.timer = setInterval(() => void this.scan(), 5 * 60_000);
    this.timer.unref?.();
  }

  public snapshot() {
    return { running: this.running, checked: this.checked, total: this.total,
      error: this.error, lastCompletedAt: this.lastCompletedAt, candidates: this.candidates };
  }

  public async scan(): Promise<void> {
    if (this.running) return;
    this.running = true; this.error = null; this.checked = 0; this.total = 0; this.candidates = [];
    try {
      const settings = this.db.getSettings().pumpShort || { ...DEFAULT_PUMP_SHORT, positionNotionalUsdt: 30 };
      const instruments = await this.client.getInstrumentsInfo();
      const tickers = await this.client.getTickers();
      // If exchange position sync fails, do not present symbols as eligible.
      const exchangePositions = await this.client.getPositions();
      const shorts = new Set(exchangePositions.filter(p => p.side === 'Sell' && Number(p.size) > 0).map(p => p.symbol));
      for (const p of this.db.getPositions()) {
        if (p.side === 'Sell' && p.size > 0 && !p.missingOnExchangeSince) shorts.add(p.symbol);
      }
      const symbols = Object.keys(instruments).filter(s => s.endsWith('USDT')).sort();
      this.total = symbols.length;
      let next = 0;
      const worker = async () => {
        while (next < symbols.length) {
          const symbol = symbols[next++];
          try {
            // Hourly candles cover every duration from one hour up to the configured days.
            // Bybit limits kline requests to 1000 rows: use daily candles only for longer windows.
            const hourly = settings.lookbackDays <= 40;
            const candles = await this.client.getKlines(symbol, hourly ? '60' : 'D', hourly ? settings.lookbackDays * 24 + 2 : settings.lookbackDays + 2);
            const wave = findPumpWave(candles, Date.now(), settings);
            const lastPrice = tickers[symbol]?.lastPrice || 0;
            if (wave && isPumpShortEntryEligible(wave, lastPrice)) {
              this.candidates.push({ symbol, low: wave.low, high: wave.high,
                growthPct: wave.growthPct, retracementTarget: pumpShortEntryTarget(lastPrice, wave.low, settings.retracementPct),
                lastPrice, excludedShort: shorts.has(symbol) });
            }
          } catch { /* One unavailable market must not abort the other scans. */ }
          this.checked++;
        }
      };
      await Promise.all(Array.from({ length: 4 }, () => worker()));
      this.candidates.sort((a, b) => b.growthPct - a.growthPct);
      this.lastCompletedAt = Date.now();
    } catch (e: any) { this.error = e.message || 'Scan failed'; }
    finally { this.running = false; }
  }
}
