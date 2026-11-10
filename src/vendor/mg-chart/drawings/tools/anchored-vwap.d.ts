import type { PixelPoint } from '../primitives/hit-test';
import type { DrawingOptions } from '../../api/types';
export declare const anchoredVwapTool: {
    name: string;
    icon: string;
    pointCount: number;
    render(ctx: CanvasRenderingContext2D, points: PixelPoint[], options: DrawingOptions, _width: number, _height: number): void;
    hitTest(mouse: PixelPoint, points: PixelPoint[], threshold: number): boolean;
    getHandles(points: PixelPoint[]): PixelPoint[];
};
