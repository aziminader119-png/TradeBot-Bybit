// Chart wrappers around the shared indicator math (src/shared/indicators.ts): the chart and the server-side alert
// evaluator compute EMA, SMA, RSI, MACD, Bollinger, ADX, ATR, Parabolic SAR, Volume and VWAP with the SAME functions
// and parameters. Colour / thickness are display-only parameters baked into the plot definition per instance.
import type { Indicator, IndicatorOutput, PlotConfig } from '../../vendor/mg-chart/index.js';
import { compute, INDICATORS, normalizeParams, type IndicatorKey, type Params } from '../../shared/indicators.ts';

const PLOTS: Record<IndicatorKey, (p: Params) => PlotConfig[]> = {
  EMA: (p) => [{ key: 'value', type: 'line', color: String(p.color), lineWidth: Number(p.width) }],
  SMA: (p) => [{ key: 'value', type: 'line', color: String(p.color), lineWidth: Number(p.width) }],
  RSI: () => [{ key: 'value', type: 'line', color: '#7E57C2', lineWidth: 1.5 }, { key: 'ob', type: 'line', color: 'rgba(239,83,80,0.6)', lineWidth: 1 }, { key: 'os', type: 'line', color: 'rgba(38,166,154,0.6)', lineWidth: 1 }],
  MACD: () => [{ key: 'hist', type: 'histogram', color: '#26A69A' }, { key: 'macd', type: 'line', color: '#2962FF', lineWidth: 1.5 }, { key: 'signal', type: 'line', color: '#FF6D00', lineWidth: 1.5 }],
  BB: () => [{ key: 'upper', type: 'line', color: '#9C27B0', lineWidth: 1 }, { key: 'middle', type: 'line', color: '#9C27B0', lineWidth: 1 }, { key: 'lower', type: 'line', color: '#9C27B0', lineWidth: 1 }, { key: 'upper', type: 'band', bandPairKey: 'lower', color: 'rgba(156,39,176,0.08)' }],
  ADX: () => [{ key: 'adx', type: 'line', color: '#FF9800', lineWidth: 1.5 }, { key: 'plusDI', type: 'line', color: '#26A69A', lineWidth: 1 }, { key: 'minusDI', type: 'line', color: '#EF5350', lineWidth: 1 }, { key: 'threshold', type: 'line', color: 'rgba(158,158,158,0.6)', lineWidth: 1 }],
  ATR: () => [{ key: 'value', type: 'line', color: '#00897B', lineWidth: 1.5 }],
  SAR: () => [{ key: 'value', type: 'dots', color: '#E91E63' }],
  VOL: () => [{ key: 'value', type: 'columns', color: 'rgba(120,144,156,0.6)' }, { key: 'average', type: 'line', color: '#FFB300', lineWidth: 1 }],
  VWAP: () => [{ key: 'value', type: 'line', color: '#00BCD4', lineWidth: 1.5 }],
  PRICE: () => [{ key: 'value', type: 'line', color: '#EAA343', lineWidth: 1 }], // alerts only; not offered on the chart
};

/** An mg-chart indicator definition for one shared indicator and one parameter set. */
export function sharedIndicator(key: IndicatorKey, raw: Params = {}): Indicator {
  const spec = INDICATORS[key], p = normalizeParams(key, raw);
  return {
    name: spec.label, shortName: key, description: spec.label + ' (shared with server alerts)', overlay: spec.overlay,
    params: spec.params.filter((x) => x.kind !== 'source').map((x) => ({ name: x.name, type: x.kind === 'color' ? 'color' : 'number', default: x.default as any, min: x.min, max: x.max, step: x.step })),
    plots: PLOTS[key](p),
    calculate(bars) {
      const out = compute(key, bars as any, p);
      return bars.map((b, i): IndicatorOutput => {
        const values: Record<string, number | undefined> = {};
        for (const [k, s] of Object.entries(out)) if (k !== 'trend') values[k] = s[i];
        if (key === 'RSI') { values.ob = Number(p.overbought); values.os = Number(p.oversold); }
        if (key === 'ADX') values.threshold = Number(p.threshold);
        return { time: b.time, values };
      });
    },
  };
}
export const SHARED_INDICATOR_KEYS: IndicatorKey[] = ['EMA', 'SMA', 'RSI', 'MACD', 'BB', 'ADX', 'ATR', 'SAR', 'VOL', 'VWAP'];
