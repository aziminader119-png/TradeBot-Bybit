import type { Bar, Datafeed, Timeframe } from '../api/types';
import type { RenderContext } from './renderer/render-context';
import type { TimeScale } from './renderer/time-axis';
export interface CompareSymbol {
    symbol: string;
    bars: Bar[];
    color: string;
    visible: boolean;
}
export declare class CompareManager {
    private symbols;
    private datafeed;
    private timeframe;
    private colorIndex;
    setDatafeed(datafeed: Datafeed, timeframe: Timeframe): void;
    add(symbol: string): Promise<CompareSymbol>;
    remove(symbol: string): void;
    getAll(): CompareSymbol[];
    has(symbol: string): boolean;
    clear(): void;
}
/**
 * Render compare overlays.
 * Strategy: normalize both main and compare to % change from first visible bar,
 * then map compare's % change to the same pixel Y range as main chart.
 */
export declare function renderCompareOverlays(ctx: RenderContext | CanvasRenderingContext2D, compareSymbols: CompareSymbol[], mainBars: readonly Bar[], mainFirstIndex: number, timeScale: TimeScale, chartWidth: number, chartHeight: number, mainPriceMin: number, mainPriceMax: number): void;
