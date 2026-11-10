// Alert rule model and condition evaluation, shared by the server evaluator (src/server/alerts/alertService.ts) and the
// alert builder UI. Monitoring only: nothing here can place, change or close an order.
//
// A signal is decided on CLOSED candles by default ("close" mode): bar i is the last closed candle and the condition
// compares bar i-1 with bar i (e.g. "crosses above" = at or below on i-1, strictly above on i). No later bar is read,
// so there is no lookahead. "intrabar" mode evaluates the still-forming candle and is always labelled as such.
import { compute, INDICATORS, normalizeParams, warmupBars, type Bar, type IndicatorKey, type Params, type Series } from './indicators.ts';

export type AlertTimeframe = '1' | '3' | '5' | '15' | '30' | '60' | '120' | '240' | '360' | '720' | 'D';
export const ALERT_TIMEFRAMES: { value: AlertTimeframe; label: string; seconds: number }[] = [
  { value: '1', label: '1m', seconds: 60 }, { value: '3', label: '3m', seconds: 180 }, { value: '5', label: '5m', seconds: 300 },
  { value: '15', label: '15m', seconds: 900 }, { value: '30', label: '30m', seconds: 1800 }, { value: '60', label: '1H', seconds: 3600 },
  { value: '120', label: '2H', seconds: 7200 }, { value: '240', label: '4H', seconds: 14400 }, { value: '360', label: '6H', seconds: 21600 },
  { value: '720', label: '12H', seconds: 43200 }, { value: 'D', label: '1D', seconds: 86400 },
];
export const timeframeSeconds = (tf: string) => ALERT_TIMEFRAMES.find((t) => t.value === tf)?.seconds ?? NaN;
export const timeframeLabel = (tf: string) => ALERT_TIMEFRAMES.find((t) => t.value === tf)?.label ?? tf;

export type ConditionSpec = { key: string; label: string; level?: 'level' | 'mult'; needsPeriod2?: boolean; direction: 'bullish' | 'bearish' | 'neutral' };
type Ctx = { bars: Bar[]; out: Record<string, Series>; out2?: Record<string, Series>; i: number; params: Params; level?: number };
type Check = (c: Ctx) => boolean;
const v = (s: Series | undefined, i: number) => (s ? s[i] : undefined);
const defined = (...xs: (number | undefined)[]) => xs.every((x) => x !== undefined && Number.isFinite(x));
const crossAbove = (a0: number | undefined, a1: number | undefined, b0: number | undefined, b1: number | undefined) => defined(a0, a1, b0, b1) && a0! <= b0! && a1! > b1!;
const crossBelow = (a0: number | undefined, a1: number | undefined, b0: number | undefined, b1: number | undefined) => defined(a0, a1, b0, b1) && a0! >= b0! && a1! < b1!;
const close = (c: Ctx, i: number) => c.bars[i]?.close;
const priceVs = (key: string, dir: 'above' | 'below'): Check => (c) => (dir === 'above' ? crossAbove : crossBelow)(close(c, c.i - 1), close(c, c.i), v(c.out[key], c.i - 1), v(c.out[key], c.i));
const lineVsLevel = (key: string, dir: 'above' | 'below', levelOf: (c: Ctx) => number | undefined): Check => (c) => { const L = levelOf(c); return (dir === 'above' ? crossAbove : crossBelow)(v(c.out[key], c.i - 1), v(c.out[key], c.i), L, L); };
const lineVsLine = (a: string, b: string, dir: 'above' | 'below'): Check => (c) => (dir === 'above' ? crossAbove : crossBelow)(v(c.out[a], c.i - 1), v(c.out[a], c.i), v(c.out[b], c.i - 1), v(c.out[b], c.i));
const maVsMa = (dir: 'above' | 'below'): Check => (c) => (dir === 'above' ? crossAbove : crossBelow)(v(c.out.value, c.i - 1), v(c.out.value, c.i), v(c.out2?.value, c.i - 1), v(c.out2?.value, c.i));
const touch: Check = (c) => { const m = v(c.out.value, c.i), b = c.bars[c.i]; return defined(m) && !!b && b.low <= m! && b.high >= m!; };

const MA_CONDITIONS: [ConditionSpec, Check][] = [
  [{ key: 'price_cross_above', label: 'Price crosses above', direction: 'bullish' }, priceVs('value', 'above')],
  [{ key: 'price_cross_below', label: 'Price crosses below', direction: 'bearish' }, priceVs('value', 'below')],
  [{ key: 'ma_cross_above', label: 'Crosses above a second average (period 2)', needsPeriod2: true, direction: 'bullish' }, maVsMa('above')],
  [{ key: 'ma_cross_below', label: 'Crosses below a second average (period 2)', needsPeriod2: true, direction: 'bearish' }, maVsMa('below')],
  [{ key: 'price_touch', label: 'Price touches the average (candle range)', direction: 'neutral' }, touch],
];
export const CONDITIONS: Record<IndicatorKey, [ConditionSpec, Check][]> = {
  EMA: MA_CONDITIONS,
  SMA: MA_CONDITIONS,
  RSI: [
    [{ key: 'cross_above_level', label: 'Crosses above level', level: 'level', direction: 'bullish' }, lineVsLevel('value', 'above', (c) => c.level)],
    [{ key: 'cross_below_level', label: 'Crosses below level', level: 'level', direction: 'bearish' }, lineVsLevel('value', 'below', (c) => c.level)],
    [{ key: 'overbought', label: 'Enters overbought (above the overbought threshold)', direction: 'bearish' }, lineVsLevel('value', 'above', (c) => Number(c.params.overbought))],
    [{ key: 'oversold', label: 'Enters oversold (below the oversold threshold)', direction: 'bullish' }, lineVsLevel('value', 'below', (c) => Number(c.params.oversold))],
  ],
  MACD: [
    [{ key: 'bullish_cross', label: 'Bullish crossover (MACD above signal)', direction: 'bullish' }, lineVsLine('macd', 'signal', 'above')],
    [{ key: 'bearish_cross', label: 'Bearish crossover (MACD below signal)', direction: 'bearish' }, lineVsLine('macd', 'signal', 'below')],
    [{ key: 'hist_cross_up', label: 'Histogram crosses above zero', direction: 'bullish' }, lineVsLevel('hist', 'above', () => 0)],
    [{ key: 'hist_cross_down', label: 'Histogram crosses below zero', direction: 'bearish' }, lineVsLevel('hist', 'below', () => 0)],
  ],
  BB: [
    [{ key: 'cross_above_upper', label: 'Price crosses above the upper band', direction: 'bullish' }, priceVs('upper', 'above')],
    [{ key: 'cross_below_lower', label: 'Price crosses below the lower band', direction: 'bearish' }, priceVs('lower', 'below')],
    [{ key: 'return_inside', label: 'Price returns inside the bands', direction: 'neutral' }, (c) => { const p0 = close(c, c.i - 1), p1 = close(c, c.i), u0 = v(c.out.upper, c.i - 1), l0 = v(c.out.lower, c.i - 1), u1 = v(c.out.upper, c.i), l1 = v(c.out.lower, c.i); return defined(p0, p1, u0, l0, u1, l1) && (p0! > u0! || p0! < l0!) && p1! <= u1! && p1! >= l1!; }],
  ],
  ADX: [
    [{ key: 'adx_cross_above', label: 'ADX crosses above the threshold', direction: 'neutral' }, lineVsLevel('adx', 'above', (c) => Number(c.params.threshold))],
    [{ key: 'adx_cross_below', label: 'ADX crosses below the threshold', direction: 'neutral' }, lineVsLevel('adx', 'below', (c) => Number(c.params.threshold))],
    [{ key: 'di_bull_cross', label: '+DI crosses above -DI', direction: 'bullish' }, lineVsLine('plusDI', 'minusDI', 'above')],
    [{ key: 'di_bear_cross', label: '+DI crosses below -DI', direction: 'bearish' }, lineVsLine('plusDI', 'minusDI', 'below')],
  ],
  ATR: [
    [{ key: 'atr_above', label: 'ATR crosses above level (volatility up)', level: 'level', direction: 'neutral' }, lineVsLevel('value', 'above', (c) => c.level)],
    [{ key: 'atr_below', label: 'ATR crosses below level (volatility down)', level: 'level', direction: 'neutral' }, lineVsLevel('value', 'below', (c) => c.level)],
  ],
  SAR: [
    [{ key: 'bullish_reversal', label: 'Bullish reversal (SAR flips below price)', direction: 'bullish' }, (c) => v(c.out.trend, c.i - 1) === -1 && v(c.out.trend, c.i) === 1],
    [{ key: 'bearish_reversal', label: 'Bearish reversal (SAR flips above price)', direction: 'bearish' }, (c) => v(c.out.trend, c.i - 1) === 1 && v(c.out.trend, c.i) === -1],
  ],
  VOL: [
    [{ key: 'volume_spike', label: 'Volume above average × multiplier', level: 'mult', direction: 'neutral' }, (c) => { const a = v(c.out.average, c.i), x = v(c.out.value, c.i); return defined(a, x, c.level) && a! > 0 && x! > a! * c.level!; }],
  ],
  PRICE: [
    [{ key: 'cross_above_level', label: 'Price crosses above level', level: 'level', direction: 'bullish' }, lineVsLevel('value', 'above', (c) => c.level)],
    [{ key: 'cross_below_level', label: 'Price crosses below level', level: 'level', direction: 'bearish' }, lineVsLevel('value', 'below', (c) => c.level)],
  ],
  VWAP: [
    [{ key: 'price_cross_above', label: 'Price crosses above VWAP', direction: 'bullish' }, priceVs('value', 'above')],
    [{ key: 'price_cross_below', label: 'Price crosses below VWAP', direction: 'bearish' }, priceVs('value', 'below')],
  ],
};
export const conditionSpec = (ind: IndicatorKey, key: string) => CONDITIONS[ind]?.find(([s]) => s.key === key)?.[0];

export type PositionSideFilter = 'Buy' | 'Sell' | 'Both';
export type OwnerFilter = 'bot' | 'external' | 'all';
export type LossBasis = 'price' | 'roi';
export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  symbol: string;
  indicator: IndicatorKey;
  params: Params;
  period2?: number; // second moving average for MA crossovers
  timeframe: AlertTimeframe;
  condition: string;
  level?: number;
  /** false: market alert (no position needed). true: Smart MART recovery alert, only for confirmed open positions. */
  requirePosition: boolean;
  side: PositionSideFilter;
  owner: OwnerFilter;
  minLossPct?: number; // only when requirePosition; position must be losing at least this much
  lossBasis: LossBasis; // 'price' = underlying price move from entry; 'roi' = unrealised P&L / position margin (leveraged)
  mode: 'close' | 'intrabar';
  frequency: 'once' | 'every'; // once: disables itself after the first alert
  cooldownMin: number; // minimum minutes between two alerts of this rule (per position)
  createdAt: number;
  updatedAt: number;
  lastTriggeredAt?: number;
  lastCandle?: number; // start (s) of the last candle evaluated: restart recovery and duplicate prevention
}
export interface AlertEvent {
  id: string; // ruleId|candle|position (unique: duplicate prevention)
  ruleId: string;
  ruleName: string;
  symbol: string;
  marketWide?: boolean; // emitted by a '*' all-USDT-perpetual rule
  indicator: IndicatorKey;
  params: Params;
  period2?: number;
  timeframe: AlertTimeframe;
  condition: string;
  conditionLabel: string;
  mode: 'close' | 'intrabar';
  candleTime: number; // start (s) of the triggering candle
  price: number; // close of the triggering candle (intrabar: last price)
  indicatorValues: Record<string, number | null>;
  positionId?: string;
  positionSide?: 'Buy' | 'Sell';
  positionOwner?: 'bot' | 'external';
  positionPnl?: number;
  positionLossPct?: number;
  lossBasis?: LossBasis;
  at: number; // when the alert was raised
  status: 'new' | 'seen';
}

export const RULE_LIMIT = 200;
export const HISTORY_LIMIT = 2000;
const SYMBOL_RE = /^[A-Z0-9]{2,30}USDT$/;

/** Validate and normalise a rule from user input. Throws a readable error. */
export function normalizeRule(input: any, now: number, existing?: AlertRule): AlertRule {
  const indicator = String(input?.indicator || '') as IndicatorKey;
  if (!INDICATORS[indicator]) throw Error('Choose a supported indicator');
  const symbol = String(input?.symbol || '').toUpperCase();
  if (symbol !== '*' && !SYMBOL_RE.test(symbol)) throw Error('Enter a valid USDT perpetual symbol or * for all');
  const timeframe = String(input?.timeframe || '') as AlertTimeframe;
  if (!ALERT_TIMEFRAMES.some((t) => t.value === timeframe)) throw Error('Choose a supported timeframe');
  const params = normalizeParams(indicator, input?.params || {});
  const spec = conditionSpec(indicator, String(input?.condition || ''));
  if (!spec) throw Error('Choose a trigger condition for ' + INDICATORS[indicator].label);
  const num = (x: unknown) => (x === '' || x === null || x === undefined ? undefined : Number(x));
  const level = num(input?.level);
  if (spec.level && !(level !== undefined && Number.isFinite(level) && (spec.level === 'mult' ? level > 0 : true))) throw Error(spec.level === 'mult' ? 'Enter a multiplier above 0' : 'Enter the level for this condition');
  const period2 = num(input?.period2);
  if (spec.needsPeriod2 && !(Number.isInteger(period2) && period2! >= 1 && period2! <= 500 && period2 !== Number(params.period))) throw Error('Enter a second period (1–500) different from the first');
  const requirePosition = Boolean(input?.requirePosition);
  if (symbol === '*' && requirePosition) throw Error('All-market alerts cannot require a position');
  const side = (['Buy', 'Sell', 'Both'].includes(input?.side) ? input.side : 'Both') as PositionSideFilter;
  const owner = (['bot', 'external', 'all'].includes(input?.owner) ? input.owner : 'all') as OwnerFilter;
  const minLoss = num(input?.minLossPct);
  if (minLoss !== undefined && !(Number.isFinite(minLoss) && minLoss >= 0 && minLoss <= 10000)) throw Error('Minimum loss must be a percentage between 0 and 10000');
  const lossBasis = (input?.lossBasis === 'roi' ? 'roi' : 'price') as LossBasis;
  const cooldownMin = num(input?.cooldownMin) ?? 0;
  if (!(Number.isFinite(cooldownMin) && cooldownMin >= 0 && cooldownMin <= 10080)) throw Error('Cooldown must be 0–10080 minutes');
  const name = String(input?.name || '').trim().slice(0, 80) || `${symbol} ${INDICATORS[indicator].key} ${spec.label}`;
  return {
    id: existing?.id || String(input?.id || '') || 'rule-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    name, enabled: input?.enabled === undefined ? existing?.enabled ?? true : Boolean(input.enabled),
    symbol, indicator, params, period2: spec.needsPeriod2 ? period2 : undefined, timeframe, condition: spec.key,
    level: spec.level ? level : undefined, requirePosition, side, owner,
    minLossPct: requirePosition ? minLoss : undefined, lossBasis,
    mode: input?.mode === 'intrabar' ? 'intrabar' : 'close', frequency: input?.frequency === 'once' ? 'once' : 'every',
    cooldownMin, createdAt: existing?.createdAt || now, updatedAt: now,
    lastTriggeredAt: existing?.lastTriggeredAt,
    // a changed definition starts fresh from the next candle (no replay of old candles)
    lastCandle: existing && sameDefinition(existing, { indicator, params, period2, timeframe, condition: spec.key, level, symbol }) ? existing.lastCandle : undefined,
  };
}
const sameDefinition = (a: AlertRule, b: Pick<AlertRule, 'indicator' | 'params' | 'period2' | 'timeframe' | 'condition' | 'level' | 'symbol'>) =>
  a.symbol === b.symbol && a.indicator === b.indicator && a.timeframe === b.timeframe && a.condition === b.condition && a.level === b.level && a.period2 === b.period2 && JSON.stringify(a.params) === JSON.stringify(b.params);

/** Bars a rule needs (indicator warm-up + the comparison bar). */
export function barsNeeded(r: AlertRule): number {
  const w = warmupBars(r.indicator, r.params);
  const w2 = r.period2 ? warmupBars(r.indicator, { ...r.params, period: r.period2 }) : 0;
  return Math.min(1000, Math.max(w, w2) + 3);
}

/** Evaluate a rule's market condition on bar index i (i-1 is the comparison bar). */
export function evaluateCondition(r: AlertRule, bars: Bar[], i: number): { hit: boolean; values: Record<string, number | null> } {
  const entry = CONDITIONS[r.indicator]?.find(([s]) => s.key === r.condition);
  if (!entry || i < 1 || i >= bars.length) return { hit: false, values: {} };
  const out = compute(r.indicator, bars.slice(0, i + 1), r.params); // never sees bars after i
  const out2 = r.period2 ? compute(r.indicator, bars.slice(0, i + 1), { ...r.params, period: r.period2 }) : undefined;
  const hit = entry[1]({ bars, out, out2, i, params: r.params, level: r.level });
  const values: Record<string, number | null> = {};
  for (const [k, s] of Object.entries(out)) { const x = s[i]; values[k] = x === undefined || !Number.isFinite(x) ? null : x; }
  if (out2) { const x = out2.value?.[i]; values.value2 = x === undefined ? null : x; }
  return { hit, values };
}

/** Losing percentage of a position (positive = loss), on the chosen basis. null when it cannot be computed. */
export function lossPct(p: { side: 'Buy' | 'Sell'; entryPrice: number; markPrice: number; unrealizedPnl: number }, basis: LossBasis, margin: number | null): number | null {
  if (basis === 'price') {
    if (!(p.entryPrice > 0 && p.markPrice > 0)) return null;
    const move = ((p.markPrice - p.entryPrice) / p.entryPrice) * 100 * (p.side === 'Buy' ? 1 : -1);
    return -move;
  }
  if (!(margin !== null && margin > 0) || !Number.isFinite(p.unrealizedPnl)) return null;
  return (-p.unrealizedPnl / margin) * 100;
}

export const describeRule = (r: Pick<AlertRule, 'indicator' | 'params' | 'period2' | 'timeframe' | 'condition' | 'level'>) => {
  const spec = conditionSpec(r.indicator, r.condition);
  const p = Object.entries(r.params).filter(([k]) => k !== 'color' && k !== 'width').map(([, x]) => x).join(', ');
  return `${r.indicator}${p ? '(' + p + ')' : ''}${r.period2 ? ' vs ' + r.indicator + '(' + r.period2 + ')' : ''} · ${timeframeLabel(r.timeframe)} · ${spec?.label || r.condition}${r.level !== undefined ? ' ' + r.level : ''}`;
};
