/**
 * Independent, read-only Pump Short signal math.
 * This module deliberately does not place orders or touch existing hedge cycles.
 */
export interface PumpCandle {
  t: number; // Bybit candle open timestamp in milliseconds
  h: number;
  l: number;
}

export interface PumpShortSettings {
  lookbackDays: number;
  minGrowthPct: number;
  retracementPct: number;
}

export interface PumpWave {
  low: number;
  lowAt: number;
  high: number;
  highAt: number;
  growthPct: number;
  exitPrice: number;
}

export const DEFAULT_PUMP_SHORT: Readonly<PumpShortSettings> = Object.freeze({
  lookbackDays: 10,
  minGrowthPct: 20,
  retracementPct: 50,
});

export function validatePumpShortSettings(settings: PumpShortSettings): void {
  if (!Number.isInteger(settings.lookbackDays) || settings.lookbackDays < 1 || settings.lookbackDays > 365)
    throw new Error('lookbackDays must be an integer between 1 and 365');
  if (!Number.isFinite(settings.minGrowthPct) || settings.minGrowthPct <= 0)
    throw new Error('minGrowthPct must be positive');
  if (!Number.isFinite(settings.retracementPct) || settings.retracementPct <= 0 || settings.retracementPct > 100)
    throw new Error('retracementPct must be greater than 0 and at most 100');
}

/** The largest chronological low-to-LATER-high rise within the lookback window. */
export function findPumpWave(candles: readonly PumpCandle[], nowMs: number, settings: PumpShortSettings): PumpWave | null {
  validatePumpShortSettings(settings);
  const cutoff = nowMs - settings.lookbackDays * 86_400_000;
  const sorted = candles.filter(c => Number.isFinite(c.t) && c.t >= cutoff && c.t <= nowMs &&
    Number.isFinite(c.l) && Number.isFinite(c.h) && c.l > 0 && c.h >= c.l).sort((a, b) => a.t - b.t);
  if (sorted.length < 2) return null;

  let minLow = sorted[0].l;
  let minAt = sorted[0].t;
  let best: PumpWave | null = null;
  for (let i = 1; i < sorted.length; i++) {
    const c = sorted[i];
    // The preceding low must be on an earlier candle: within-bar order is unknowable.
    const growthPct = ((c.h - minLow) / minLow) * 100;
    if (growthPct >= settings.minGrowthPct && (!best || growthPct > best.growthPct)) {
      best = {
        low: minLow, lowAt: minAt, high: c.h, highAt: c.t, growthPct,
        exitPrice: c.h - (c.h - minLow) * settings.retracementPct / 100,
      };
    }
    if (c.l < minLow) { minLow = c.l; minAt = c.t; }
  }
  return best;
}

/** Do not open a short if the 50% retracement target is already behind the price. */
export function isPumpShortEntryEligible(wave: PumpWave | null, marketPrice: number): boolean {
  return wave !== null && Number.isFinite(marketPrice) && marketPrice > wave.low;
}

/** Percentage of the distance between the actual SHORT entry and the wave's starting low. */
export function pumpShortEntryTarget(entryPrice: number, waveLow: number, retracementPct: number): number {
  if (![entryPrice, waveLow, retracementPct].every(Number.isFinite) || waveLow <= 0 || entryPrice <= waveLow || retracementPct <= 0 || retracementPct > 100)
    throw new Error('Invalid entry / wave low / retracement percentage');
  return entryPrice - (entryPrice - waveLow) * retracementPct / 100;
}

/** Exit only at/under the recorded retracement target; never interpret this as fixed entry-price TP. */
export function pumpShortTargetHit(wave: PumpWave, marketPrice: number): boolean {
  return Number.isFinite(marketPrice) && marketPrice <= wave.exitPrice;
}
