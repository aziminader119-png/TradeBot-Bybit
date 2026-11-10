import type { Bar } from '../../api/types';
export interface SnapResult {
    price: number;
    time: number;
    snapped: boolean;
    snapType?: 'open' | 'high' | 'low' | 'close';
}
/**
 * Snap a price to the nearest OHLC value of a bar, if within threshold.
 * @param price - The price to snap
 * @param bar - The bar to snap to
 * @param priceToY - Function to convert price to Y pixel
 * @param mouseY - Current mouse Y pixel
 */
export declare function snapToOHLC(price: number, bar: Bar, priceToY: (p: number) => number, mouseY: number): SnapResult;
