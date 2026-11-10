import type { Theme } from '../../api/types';
import type { RenderContext } from './render-context';
import type { PriceScale } from './price-axis';
export interface PositionOverlayData {
    side: 'long' | 'short';
    entryPrice: number;
    quantity: number;
    breakeven?: number;
    currentPrice: number;
    pnl: number;
    tpLevels: {
        price: number;
        quantity: number;
    }[];
    slLevels: {
        price: number;
        quantity: number;
    }[];
}
export declare function renderPositionOverlay(ctx: RenderContext | CanvasRenderingContext2D, pos: PositionOverlayData, priceScale: PriceScale, theme: Theme, chartWidth: number, chartHeight: number, precision: number): void;
