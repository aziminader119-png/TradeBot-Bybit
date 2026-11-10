import type { PlotConfig, IndicatorOutput } from '../../api/types';
import type { RenderContext } from './render-context';
import type { TimeScale } from './time-axis';
export interface IndicatorRenderParams {
    ctx: RenderContext | CanvasRenderingContext2D;
    outputs: IndicatorOutput[];
    plots: PlotConfig[];
    firstBarIndex: number;
    timeScale: TimeScale;
    chartWidth: number;
    /** Pane Y offset */
    yOffset: number;
    /** Pane height */
    paneHeight: number;
    /** Y-axis min value */
    scaleMin: number;
    /** Y-axis max value */
    scaleMax: number;
    /** Optional color overrides from params */
    colorOverride?: string;
}
export declare function renderIndicator(params: IndicatorRenderParams): void;
/** Compute min/max values from indicator outputs for Y-axis auto-ranging */
export declare function getIndicatorRange(outputs: IndicatorOutput[], plots: PlotConfig[], fromIndex: number, toIndex: number): {
    min: number;
    max: number;
} | null;
