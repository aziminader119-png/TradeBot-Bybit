import type { Theme } from '../../api/types';
import type { RenderContext } from './render-context';
import type { PriceScale } from './price-axis';
export type OrderLineSide = 'buy' | 'sell';
export type OrderLineType = 'limit' | 'stop' | 'tp' | 'sl' | 'entry' | 'liquidation' | 'breakeven';
export interface OrderLine {
    id: string;
    price: number;
    type: OrderLineType;
    side: OrderLineSide;
    label: string;
    color?: string;
    quantity?: number;
    /** Optional PnL for position lines */
    pnl?: number;
}
export declare class OrderLineManager {
    private lines;
    add(line: OrderLine): void;
    remove(id: string): void;
    update(id: string, updates: Partial<OrderLine>): void;
    getAll(): OrderLine[];
    clear(): void;
    /** Hit-test: find order line near a Y pixel position */
    hitTest(y: number, priceScale: PriceScale, chartHeight: number, threshold?: number): OrderLine | null;
}
export declare function renderOrderLines(ctx: RenderContext | CanvasRenderingContext2D, lines: OrderLine[], priceScale: PriceScale, theme: Theme, chartWidth: number, chartHeight: number, precision: number): void;
