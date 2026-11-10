import type { DrawingOptions, Point, Bar } from '../../api/types';
import type { PixelPoint } from '../../drawings/primitives/hit-test';
import type { PriceScale } from './price-axis';
export interface DataInjectorContext {
    nearestIndex: (time: number) => number;
    getRange: (from: number, to: number) => Bar[];
    precision: number;
    priceScale: PriceScale;
    mainPaneHeight: number;
    barIndexToX?: (barIndex: number) => number;
}
/**
 * Inject chart data into drawing options for tools that need calculations.
 * Returns modified options (or original if no injection needed).
 */
export declare function injectDrawingData(toolName: string, points: Point[], pixelPoints: PixelPoint[], options: DrawingOptions, ctx: DataInjectorContext): DrawingOptions;
