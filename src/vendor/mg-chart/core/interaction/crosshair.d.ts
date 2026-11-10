import type { Bar, Theme } from '../../api/types';
import type { PriceScale } from '../renderer/price-axis';
import type { TimeScale } from '../renderer/time-axis';
export interface CrosshairState {
    /** CSS pixel X (relative to chart area) */
    x: number;
    /** CSS pixel Y (relative to chart area) */
    y: number;
    /** Whether crosshair is visible */
    visible: boolean;
    /** Snapped bar index */
    barIndex: number;
    /** Snapped bar data */
    bar: Bar | null;
}
export declare function renderCrosshair(ctx: CanvasRenderingContext2D, state: CrosshairState, priceScale: PriceScale, timeScale: TimeScale, theme: Theme, chartWidth: number, chartHeight: number, precision: number, getBarTime: (index: number) => number | undefined, tradeMode?: boolean): void;
