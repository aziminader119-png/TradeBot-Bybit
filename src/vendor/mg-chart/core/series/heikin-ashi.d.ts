import type { Bar, Theme } from '../../api/types';
import type { PriceScale } from '../renderer/price-axis';
import type { TimeScale } from '../renderer/time-axis';
export type HeikinAshiBar = Bar;
/** Transform regular bars into Heikin Ashi bars */
export declare function toHeikinAshi(bars: readonly Bar[]): HeikinAshiBar[];
/** Render Heikin Ashi candles (transforms then delegates to candlestick renderer) */
export declare function renderHeikinAshi(ctx: CanvasRenderingContext2D, bars: readonly Bar[], firstBarIndex: number, timeScale: TimeScale, priceScale: PriceScale, theme: Theme, chartWidth: number, chartHeight: number): void;
