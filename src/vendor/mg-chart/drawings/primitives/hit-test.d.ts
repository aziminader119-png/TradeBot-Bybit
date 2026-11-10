export interface PixelPoint {
    x: number;
    y: number;
}
/** Distance from point to a line segment (p1→p2) */
export declare function pointToSegmentDist(p: PixelPoint, p1: PixelPoint, p2: PixelPoint): number;
/** Distance from point to an infinite line through p1 and p2 */
export declare function pointToLineDist(p: PixelPoint, p1: PixelPoint, p2: PixelPoint): number;
/** Distance from point to a horizontal line at yLevel */
export declare function pointToHorizontalLineDist(p: PixelPoint, yLevel: number): number;
/** Check if point is inside a rectangle defined by two corners */
export declare function pointInRect(p: PixelPoint, corner1: PixelPoint, corner2: PixelPoint, threshold: number): boolean;
/** Distance from point to a rectangle's border */
export declare function pointToRectBorderDist(p: PixelPoint, corner1: PixelPoint, corner2: PixelPoint): number;
/** Euclidean distance between two points */
export declare function pointDist(a: PixelPoint, b: PixelPoint): number;
