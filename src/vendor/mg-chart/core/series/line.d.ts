import type { Bar, Theme } from '../../api/types';
import type { RenderContext } from '../renderer/render-context';
import type { PriceScale } from '../renderer/price-axis';
import type { TimeScale } from '../renderer/time-axis';
export declare function renderLineSeries(ctx: RenderContext | CanvasRenderingContext2D, bars: readonly Bar[], firstBarIndex: number, timeScale: TimeScale, priceScale: PriceScale, theme: Theme, chartWidth: number, chartHeight: number): void;
