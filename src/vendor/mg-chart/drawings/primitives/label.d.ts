/**
 * Draw a data label with dark semi-transparent background.
 * Centered at (x, y). Text color = `color`.
 */
export declare function drawDataLabel(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, fontSize?: number): void;
/**
 * Draw a colored badge (solid background + white text).
 * Left-aligned at (x, y). Used for entry/TP/SL/labels.
 */
export declare function drawBadge(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, fontSize?: number): void;
/**
 * Draw a ratio label between two points (for harmonics, Elliott).
 * Offset to the right of the midpoint.
 */
export declare function drawRatioLabel(ctx: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number, text: string, color: string): void;
/**
 * Format a line data label: "angle° | N bars | +ΔPrice (+%)"
 */
export declare function formatLineLabel(data: {
    angle: number;
    bars: number;
    deltaPrice: number;
    pctChange: number;
}): string;
