import type { Bar, Theme, Timeframe } from '../../api/types';
import type { RenderContext } from './render-context';
import type { PriceScale } from './price-axis';
export declare function renderCurrentPriceMarker(ctx: RenderContext | CanvasRenderingContext2D, bar: Bar, priceScale: PriceScale, theme: Theme, chartWidth: number, chartHeight: number, precision: number, timeframe?: Timeframe): void;
/** Render high/low markers for the visible range */
export declare function renderHighLowMarkers(ctx: CanvasRenderingContext2D, highPrice: number, lowPrice: number, highY: number, lowY: number, theme: Theme, precision: number): void;
