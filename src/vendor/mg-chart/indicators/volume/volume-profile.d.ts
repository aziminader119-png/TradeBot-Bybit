import type { Bar, Theme } from '../../api/types';
import type { RenderContext } from '../../core/renderer/render-context';
import type { PriceScale } from '../../core/renderer/price-axis';
export interface VolumeProfileBin {
    priceFrom: number;
    priceTo: number;
    volume: number;
    buyVolume: number;
    sellVolume: number;
}
/** Compute volume profile bins from bar data */
export declare function computeVolumeProfile(bars: readonly Bar[], priceMin: number, priceMax: number, numBins?: number): VolumeProfileBin[];
/** Render volume profile as horizontal bars on the left side of the chart */
export declare function renderVolumeProfile(ctx: RenderContext | CanvasRenderingContext2D, bins: VolumeProfileBin[], priceScale: PriceScale, theme: Theme, chartWidth: number, chartHeight: number): void;
