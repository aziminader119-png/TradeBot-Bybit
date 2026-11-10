import type { Bar, Theme } from '../../api/types';
import type { PriceScale } from './price-axis';
export declare function render24hHighLow(ctx: CanvasRenderingContext2D, bars: readonly Bar[], priceScale: PriceScale, theme: Theme, chartWidth: number, chartHeight: number, precision: number): void;
