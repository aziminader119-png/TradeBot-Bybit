import type { Theme, Timeframe } from '../../api/types';
export declare const TIME_AXIS_HEIGHT = 28;
export interface TimeScale {
    /** First visible bar index */
    firstIndex: number;
    /** Number of visible bars */
    visibleCount: number;
    /** Pixels per bar (includes gap) */
    barSpacing: number;
    /** Offset in pixels for smooth scrolling */
    offsetX: number;
}
/** Converts a bar index to pixel X coordinate (center of the bar) */
export declare function barIndexToX(index: number, scale: TimeScale, _chartWidth: number): number;
/** Converts pixel X to fractional bar index */
export declare function xToBarIndex(x: number, scale: TimeScale): number;
export interface TimeTick {
    index: number;
    x: number;
    label: string;
    isMajor: boolean;
}
/** Generate time axis ticks for the visible range */
export declare function generateTimeTicks(times: (index: number) => number | undefined, scale: TimeScale, chartWidth: number, timeframe: Timeframe): TimeTick[];
/** Render the time axis bar at the bottom */
export declare function renderTimeAxis(ctx: CanvasRenderingContext2D, ticks: TimeTick[], theme: Theme, width: number, yTop: number): void;
