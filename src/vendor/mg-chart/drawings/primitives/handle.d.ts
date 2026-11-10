import type { PixelPoint } from './hit-test';
export declare const HANDLE_RADIUS = 5;
export declare const HANDLE_HIT_RADIUS = 10;
/** Render a circular handle at a pixel position */
export declare function renderHandle(ctx: CanvasRenderingContext2D, pos: PixelPoint, color: string, active?: boolean): void;
/** Check if a mouse position hits a handle */
export declare function hitTestHandle(mouse: PixelPoint, handlePos: PixelPoint): boolean;
