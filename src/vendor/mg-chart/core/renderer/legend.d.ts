import type { Bar, Theme } from '../../api/types';
import type { IndicatorInstance } from '../../indicators/engine';
/** Render OHLCV legend in the top-left of the main pane */
export declare function renderOHLCVLegend(ctx: CanvasRenderingContext2D, bar: Bar, theme: Theme, precision: number, x: number, y: number): void;
/** Render indicator value legend in an oscillator pane */
export declare function renderIndicatorLegend(ctx: CanvasRenderingContext2D, inst: IndicatorInstance, barIndex: number, theme: Theme, x: number, y: number): void;
/** Render overlay indicator legends below the OHLCV legend */
export declare function renderOverlayLegend(ctx: CanvasRenderingContext2D, overlays: IndicatorInstance[], barIndex: number, theme: Theme, x: number, y: number): void;
