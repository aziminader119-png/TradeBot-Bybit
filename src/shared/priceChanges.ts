// Multi-timeframe price change for the Symbols table, from correctly timestamped Bybit candles (shared candle cache).
// change(N) = (current price − reference) / reference × 100, reference = CLOSE of the last candle that closed at or
// before now − N. Resolution: 15-minute candles for 2H/4H/12H, 1-hour for 48H/72H, daily for 1W/1M. A symbol listed
// more recently than N (no such candle) gets null — nothing is extrapolated or fabricated.
export type Bar = { time: number; close: number };
export const CHANGE_WINDOWS: { key: string; hours: number; interval: string; stepS: number }[] = [
  { key: '2H', hours: 2, interval: '15', stepS: 900 }, { key: '4H', hours: 4, interval: '15', stepS: 900 }, { key: '12H', hours: 12, interval: '15', stepS: 900 },
  { key: '48H', hours: 48, interval: '60', stepS: 3600 }, { key: '72H', hours: 72, interval: '60', stepS: 3600 },
  { key: '1W', hours: 168, interval: 'D', stepS: 86400 }, { key: '1M', hours: 720, interval: 'D', stepS: 86400 },
];
/** Bars needed per interval (covers the longest window of that resolution plus the forming candle). */
export const CHANGE_LIMITS: Record<string, number> = { '15': 52, '60': 76, 'D': 33 };
export function changeFromBars(bars: Bar[], hours: number, stepS: number, nowS: number, current: number | null): number | null {
  if (!(current !== null && current > 0)) return null;
  const target = nowS - hours * 3600;
  let ref: Bar | undefined;
  for (const b of bars) if (b.time + stepS <= target && (!ref || b.time > ref.time)) ref = b;
  if (!ref || !(ref.close > 0)) return null;
  // the reference candle must be the one right before the target (a gap = halt/missing data -> no value)
  if (target - (ref.time + stepS) >= stepS) return null;
  return ((current - ref.close) / ref.close) * 100;
}
