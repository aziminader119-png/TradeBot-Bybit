import type { Theme, PriceScaleMode } from '../../api/types';
import type { RenderContext } from './render-context';
export declare const PRICE_AXIS_WIDTH = 84;
export interface PriceScale {
    /** Visible price range min (bottom of chart) */
    min: number;
    /** Visible price range max (top of chart) */
    max: number;
    /** Scale mode */
    mode: PriceScaleMode;
}
/** Convert price to Y pixel (top of chart area = max price, bottom = min price) */
export declare function priceToY(price: number, scale: PriceScale, chartHeight: number): number;
/** Convert Y pixel to price */
export declare function yToPrice(y: number, scale: PriceScale, chartHeight: number): number;
export interface PriceTick {
    price: number;
    y: number;
    label: string;
}
/** Generate nice price ticks for the visible range */
export declare function generatePriceTicks(scale: PriceScale, chartHeight: number, precision: number): PriceTick[];
/** Render the price axis column on the right */
export declare function renderPriceAxis(ctx: RenderContext | CanvasRenderingContext2D, ticks: PriceTick[], theme: Theme, xLeft: number, yTop: number, height: number): void;
/** Format price with given decimal precision */
export declare function formatPrice(price: number, precision: number): string;
/** Auto-detect precision from a price value */
export declare function detectPrecision(price: number): number;
