// Shared indicator math: the ONE definition used by the chart (src/components/futures/sharedIndicators.ts) and by the
// server-side alert evaluator (src/server/alerts). Pure functions over closed OHLCV bars, oldest first; no I/O.
// Every output array has the same length as the input; values before the warm-up period are `undefined`.
//
// Definitions (standard, as published by their authors; reference-tested in tests/indicators.test.mts):
//   SMA(n)            arithmetic mean of the last n values.
//   EMA(n)            alpha = 2/(n+1), seeded with the SMA of the first n values.
//   RSI(n)            Wilder: average gain/loss seeded with the simple mean of the first n changes, then
//                     avg = (prev*(n-1) + x)/n. RSI = 100 - 100/(1+avgGain/avgLoss); 100 when avgLoss = 0 (50 if flat).
//   MACD(f,s,sig)     EMA(f) - EMA(s) of the source; signal = EMA(sig) of MACD; histogram = MACD - signal.
//   Bollinger(n,k)    middle = SMA(n); upper/lower = middle ± k × population standard deviation of the last n values.
//   ATR(n)            Wilder average of the true range, seeded with the mean of the first n true ranges.
//   ADX(di, adx)      Wilder +DM/-DM/TR smoothing over `di` bars -> +DI, -DI; DX = 100|+DI - -DI|/(+DI + -DI);
//                     ADX = Wilder average of DX over `adx` bars, seeded with the mean of the first `adx` DX values.
//   Parabolic SAR     Wilder (start, increment, maximum); SAR never inside the prior two bars' range.
//   VWAP              session VWAP, reset at 00:00 UTC, typical price (H+L+C)/3 weighted by volume.
export type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type Series = (number | undefined)[];
export type PriceSource = 'close' | 'open' | 'high' | 'low' | 'hl2' | 'hlc3' | 'ohlc4';
export const PRICE_SOURCES: PriceSource[] = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'];

export function source(bars: Bar[], src: PriceSource = 'close'): number[] {
  switch (src) {
    case 'open': return bars.map((b) => b.open);
    case 'high': return bars.map((b) => b.high);
    case 'low': return bars.map((b) => b.low);
    case 'hl2': return bars.map((b) => (b.high + b.low) / 2);
    case 'hlc3': return bars.map((b) => (b.high + b.low + b.close) / 3);
    case 'ohlc4': return bars.map((b) => (b.open + b.high + b.low + b.close) / 4);
    default: return bars.map((b) => b.close);
  }
}
const int = (n: number, name: string) => { if (!Number.isInteger(n) || n < 1 || n > 1000) throw Error(`${name} must be an integer 1..1000`); return n; };

export function sma(values: number[], n: number): Series {
  int(n, 'period');
  const out: Series = new Array(values.length).fill(undefined);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** EMA over a series that may start with undefined values (warm-up of an upstream series). */
export function ema(values: Series, n: number): Series {
  int(n, 'period');
  const out: Series = new Array(values.length).fill(undefined);
  const a = 2 / (n + 1);
  let start = values.findIndex((v) => v !== undefined), prev: number | undefined, sum = 0, count = 0;
  if (start < 0) return out;
  for (let i = start; i < values.length; i++) {
    const v = values[i];
    if (v === undefined) return out; // gaps are not expected inside a series
    if (prev === undefined) { sum += v; count++; if (count === n) { prev = sum / n; out[i] = prev; } continue; }
    prev = v * a + prev * (1 - a); out[i] = prev;
  }
  return out;
}

/** Wilder smoothing (RMA) seeded with the simple mean of the first n defined values. */
export function wilder(values: Series, n: number): Series {
  int(n, 'period');
  const out: Series = new Array(values.length).fill(undefined);
  let prev: number | undefined, sum = 0, count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === undefined) continue;
    if (prev === undefined) { sum += v; count++; if (count === n) { prev = sum / n; out[i] = prev; } continue; }
    prev = (prev * (n - 1) + v) / n; out[i] = prev;
  }
  return out;
}

export function rsi(values: number[], n: number): Series {
  const gains: Series = [undefined], losses: Series = [undefined];
  for (let i = 1; i < values.length; i++) { const d = values[i] - values[i - 1]; gains.push(Math.max(d, 0)); losses.push(Math.max(-d, 0)); }
  const g = wilder(gains.slice(0, values.length), n), l = wilder(losses.slice(0, values.length), n);
  return values.map((_, i) => {
    const ag = g[i], al = l[i];
    if (ag === undefined || al === undefined) return undefined;
    if (al === 0) return ag === 0 ? 50 : 100;
    return 100 - 100 / (1 + ag / al);
  });
}

export function macd(values: number[], fast: number, slow: number, signal: number): { macd: Series; signal: Series; hist: Series } {
  if (fast >= slow) throw Error('MACD fast period must be shorter than the slow period');
  const f = ema(values, fast), s = ema(values, slow);
  const m: Series = values.map((_, i) => (f[i] !== undefined && s[i] !== undefined ? f[i]! - s[i]! : undefined));
  const sig = ema(m, signal);
  return { macd: m, signal: sig, hist: m.map((v, i) => (v !== undefined && sig[i] !== undefined ? v - sig[i]! : undefined)) };
}

export function bollinger(values: number[], n: number, k: number): { upper: Series; middle: Series; lower: Series } {
  if (!(k > 0)) throw Error('standard deviation multiplier must be positive');
  const mid = sma(values, n), upper: Series = [], lower: Series = [];
  for (let i = 0; i < values.length; i++) {
    const m = mid[i];
    if (m === undefined) { upper.push(undefined); lower.push(undefined); continue; }
    let v = 0; for (let j = i - n + 1; j <= i; j++) v += (values[j] - m) ** 2;
    const sd = Math.sqrt(v / n);
    upper.push(m + k * sd); lower.push(m - k * sd);
  }
  return { upper, middle: mid, lower };
}

export function trueRange(bars: Bar[]): number[] {
  return bars.map((b, i) => (i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))));
}
export function atr(bars: Bar[], n: number): Series { return wilder(trueRange(bars), n); }

export function adx(bars: Bar[], diPeriod: number, adxPeriod: number): { adx: Series; plusDI: Series; minusDI: Series } {
  int(diPeriod, 'DI period'); int(adxPeriod, 'ADX smoothing');
  const len = bars.length, plusDI: Series = new Array(len).fill(undefined), minusDI: Series = new Array(len).fill(undefined), dx: Series = new Array(len).fill(undefined);
  // Wilder's smoothed SUMS (not averages): first = sum of the first n values from bar 1, then S - S/n + x
  let sTR = 0, sP = 0, sM = 0;
  for (let i = 1; i < len; i++) {
    const b = bars[i], p = bars[i - 1];
    const up = b.high - p.high, down = p.low - b.low;
    const pdm = up > down && up > 0 ? up : 0, mdm = down > up && down > 0 ? down : 0;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
    if (i <= diPeriod) { sTR += tr; sP += pdm; sM += mdm; if (i < diPeriod) continue; }
    else { sTR = sTR - sTR / diPeriod + tr; sP = sP - sP / diPeriod + pdm; sM = sM - sM / diPeriod + mdm; }
    const pdi = sTR > 0 ? (100 * sP) / sTR : 0, mdi = sTR > 0 ? (100 * sM) / sTR : 0;
    plusDI[i] = pdi; minusDI[i] = mdi;
    dx[i] = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
  }
  return { adx: wilder(dx, adxPeriod), plusDI, minusDI };
}

/** Parabolic SAR. `trend` is +1 (SAR below price, bullish) or -1. The first bar has no value. */
export function parabolicSar(bars: Bar[], start: number, increment: number, maximum: number): { sar: Series; trend: (1 | -1 | undefined)[] } {
  if (!(start > 0 && increment > 0 && maximum >= start)) throw Error('SAR needs start > 0, increment > 0, maximum >= start');
  const len = bars.length, sar: Series = new Array(len).fill(undefined), trend: (1 | -1 | undefined)[] = new Array(len).fill(undefined);
  if (len < 2) return { sar, trend };
  let up = bars[1].close >= bars[0].close, af = start;
  let ep = up ? Math.max(bars[0].high, bars[1].high) : Math.min(bars[0].low, bars[1].low);
  let s = up ? Math.min(bars[0].low, bars[1].low) : Math.max(bars[0].high, bars[1].high);
  sar[1] = s; trend[1] = up ? 1 : -1;
  for (let i = 2; i < len; i++) {
    const b = bars[i];
    let next = s + af * (ep - s);
    if (up) {
      next = Math.min(next, bars[i - 1].low, bars[i - 2].low);
      if (b.low < next) { up = false; next = ep; ep = b.low; af = start; }
      else if (b.high > ep) { ep = b.high; af = Math.min(af + increment, maximum); }
    } else {
      next = Math.max(next, bars[i - 1].high, bars[i - 2].high);
      if (b.high > next) { up = true; next = ep; ep = b.high; af = start; }
      else if (b.low < ep) { ep = b.low; af = Math.min(af + increment, maximum); }
    }
    s = next; sar[i] = s; trend[i] = up ? 1 : -1;
  }
  return { sar, trend };
}

export function vwap(bars: Bar[]): Series {
  let day = NaN, pv = 0, v = 0;
  return bars.map((b) => {
    const d = Math.floor(b.time / 86400);
    if (d !== day) { day = d; pv = 0; v = 0; }
    pv += ((b.high + b.low + b.close) / 3) * b.volume; v += b.volume;
    return v > 0 ? pv / v : undefined;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Indicator catalogue: parameters, outputs and pane, shared by the chart UI, the alert builder and the evaluator.
export type IndicatorKey = 'EMA' | 'SMA' | 'RSI' | 'MACD' | 'BB' | 'ADX' | 'ATR' | 'SAR' | 'VOL' | 'VWAP' | 'PRICE';
export type ParamSpec = { name: string; label: string; kind: 'int' | 'number' | 'source' | 'color'; default: number | string; min?: number; max?: number; step?: number };
export type IndicatorSpec = { key: IndicatorKey; label: string; overlay: boolean; params: ParamSpec[]; outputs: string[] };
const P = (name: string, label: string, def: number, min = 1, max = 500, kind: 'int' | 'number' = 'int', step = 1): ParamSpec => ({ name, label, kind, default: def, min, max, step });
const COLOR = (def: string): ParamSpec => ({ name: 'color', label: 'Color', kind: 'color', default: def });
const WIDTH: ParamSpec = { name: 'width', label: 'Thickness', kind: 'number', default: 1.5, min: 0.5, max: 5, step: 0.5 };
export const INDICATORS: Record<IndicatorKey, IndicatorSpec> = {
  EMA: { key: 'EMA', label: 'Exponential Moving Average', overlay: true, params: [P('period', 'Period', 50), { name: 'source', label: 'Source', kind: 'source', default: 'close' }, COLOR('#FF9800'), WIDTH], outputs: ['value'] },
  SMA: { key: 'SMA', label: 'Simple Moving Average', overlay: true, params: [P('period', 'Period', 20), { name: 'source', label: 'Source', kind: 'source', default: 'close' }, COLOR('#2196F3'), WIDTH], outputs: ['value'] },
  RSI: { key: 'RSI', label: 'RSI', overlay: false, params: [P('period', 'Period', 14), P('overbought', 'Overbought', 70, 50, 100, 'number'), P('oversold', 'Oversold', 30, 0, 50, 'number')], outputs: ['value'] },
  MACD: { key: 'MACD', label: 'MACD', overlay: false, params: [P('fast', 'Fast period', 12), P('slow', 'Slow period', 26), P('signal', 'Signal period', 9)], outputs: ['macd', 'signal', 'hist'] },
  BB: { key: 'BB', label: 'Bollinger Bands', overlay: true, params: [P('period', 'Period', 20, 2), P('mult', 'Std. deviation multiplier', 2, 0.1, 10, 'number', 0.1)], outputs: ['upper', 'middle', 'lower'] },
  ADX: { key: 'ADX', label: 'ADX / DMI', overlay: false, params: [P('di', 'DI period', 14), P('smooth', 'ADX smoothing', 14), P('threshold', 'Threshold', 25, 1, 100, 'number')], outputs: ['adx', 'plusDI', 'minusDI'] },
  ATR: { key: 'ATR', label: 'ATR', overlay: false, params: [P('period', 'Period', 14)], outputs: ['value'] },
  SAR: { key: 'SAR', label: 'Parabolic SAR', overlay: true, params: [P('start', 'Start', 0.02, 0.001, 1, 'number', 0.001), P('increment', 'Increment', 0.02, 0.001, 1, 'number', 0.001), P('maximum', 'Maximum', 0.2, 0.01, 1, 'number', 0.01)], outputs: ['value', 'trend'] },
  VOL: { key: 'VOL', label: 'Volume', overlay: false, params: [P('period', 'Average period', 20)], outputs: ['value', 'average'] },
  VWAP: { key: 'VWAP', label: 'VWAP (daily, UTC)', overlay: true, params: [], outputs: ['value'] },
  PRICE: { key: 'PRICE', label: 'Price level', overlay: true, params: [], outputs: ['value'] }, // alerts only (candle close vs a level)
};
export type Params = Record<string, number | string>;

/** Validated parameters: defaults filled in, numbers range-checked. Throws a readable error for invalid input. */
export function normalizeParams(key: IndicatorKey, raw: Params = {}): Params {
  const spec = INDICATORS[key];
  if (!spec) throw Error('Unknown indicator');
  const out: Params = {};
  for (const p of spec.params) {
    const v = raw[p.name] ?? p.default;
    if (p.kind === 'source') { if (!PRICE_SOURCES.includes(v as PriceSource)) throw Error(`${p.label}: unknown price source`); out[p.name] = v; continue; }
    if (p.kind === 'color') { out[p.name] = typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : p.default; continue; }
    const n = Number(v);
    if (!Number.isFinite(n) || (p.min !== undefined && n < p.min) || (p.max !== undefined && n > p.max) || (p.kind === 'int' && !Number.isInteger(n))) throw Error(`${spec.label} ${p.label} must be ${p.kind === 'int' ? 'a whole number' : 'a number'} between ${p.min} and ${p.max}`);
    out[p.name] = n;
  }
  if (key === 'MACD' && Number(out.fast) >= Number(out.slow)) throw Error('MACD fast period must be shorter than the slow period');
  return out;
}

/** Bars needed before the indicator's values are reliable (used to size history reads for alerts). */
export function warmupBars(key: IndicatorKey, p: Params): number {
  const n = (k: string) => Number(p[k]) || 0;
  switch (key) {
    case 'EMA': return n('period') * 4 + 10; // EMA seed influence < 0.1 % after ~4 periods
    case 'SMA': case 'VOL': return n('period') + 2;
    case 'RSI': case 'ATR': return n('period') * 4 + 10;
    case 'MACD': return (n('slow') + n('signal')) * 4 + 10;
    case 'BB': return n('period') + 2;
    case 'ADX': return (n('di') + n('smooth')) * 4 + 10;
    case 'SAR': return 200;
    case 'VWAP': return 1440;
    case 'PRICE': return 3;
  }
}

/** Compute every output of an indicator. */
export function compute(key: IndicatorKey, bars: Bar[], raw: Params = {}): Record<string, Series> {
  const p = normalizeParams(key, raw);
  switch (key) {
    case 'EMA': return { value: ema(source(bars, p.source as PriceSource), Number(p.period)) };
    case 'SMA': return { value: sma(source(bars, p.source as PriceSource), Number(p.period)) };
    case 'RSI': return { value: rsi(source(bars), Number(p.period)) };
    case 'MACD': return macd(source(bars), Number(p.fast), Number(p.slow), Number(p.signal));
    case 'BB': return bollinger(source(bars), Number(p.period), Number(p.mult));
    case 'ADX': return adx(bars, Number(p.di), Number(p.smooth));
    case 'ATR': return { value: atr(bars, Number(p.period)) };
    case 'SAR': { const r = parabolicSar(bars, Number(p.start), Number(p.increment), Number(p.maximum)); return { value: r.sar, trend: r.trend }; }
    case 'VOL': { const v = bars.map((b) => b.volume); return { value: v, average: sma(v, Number(p.period)) }; }
    case 'VWAP': return { value: vwap(bars) };
    case 'PRICE': return { value: bars.map((b) => b.close) };
  }
}
