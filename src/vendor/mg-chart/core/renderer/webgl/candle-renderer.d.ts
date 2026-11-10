import type { Bar, Theme } from '../../../api/types';
import type { PriceScale } from '../price-axis';
import type { TimeScale } from '../time-axis';
export declare class CandleRenderer {
    private gl;
    private candleProg;
    private candleVAO;
    private candleBuf;
    private candleData;
    private candleUniforms;
    private volumeProg;
    private volumeVAO;
    private volumeBuf;
    private volumeData;
    private volumeUniforms;
    private bullColor;
    private bearColor;
    private bullWickColor;
    private bearWickColor;
    private volBullColor;
    private volBearColor;
    private lastThemeName;
    constructor(gl: WebGL2RenderingContext);
    private updateThemeColors;
    renderCandles(bars: readonly Bar[], firstBarIndex: number, timeScale: TimeScale, priceScale: PriceScale, theme: Theme, chartWidth: number, chartHeight: number, viewportWidth: number, viewportHeight: number): void;
    renderVolume(bars: readonly Bar[], firstBarIndex: number, maxVolume: number, timeScale: TimeScale, theme: Theme, chartWidth: number, chartHeight: number, viewportWidth: number, viewportHeight: number): void;
    destroy(): void;
}
