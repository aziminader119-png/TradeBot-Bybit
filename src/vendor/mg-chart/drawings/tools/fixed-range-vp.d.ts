import type { DrawingOptions } from '../../api/types';
import type { PixelPoint } from '../primitives/hit-test';
export declare const fixedRangeVPTool: {
    name: string;
    icon: string;
    pointCount: number;
    render(ctx: CanvasRenderingContext2D, points: PixelPoint[], options: DrawingOptions, width: number, height: number): void;
    hitTest(mouse: PixelPoint, points: PixelPoint[], threshold: number): boolean;
    getHandles(points: PixelPoint[]): PixelPoint[];
};
