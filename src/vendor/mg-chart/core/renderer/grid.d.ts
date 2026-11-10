import type { Theme } from '../../api/types';
import type { RenderContext } from './render-context';
import type { PriceTick } from './price-axis';
import type { TimeTick } from './time-axis';
export declare function renderGrid(ctx: RenderContext | CanvasRenderingContext2D, priceTicks: PriceTick[], timeTicks: TimeTick[], theme: Theme, chartWidth: number, yTop: number, yBottom: number, showHorizontal?: boolean, showVertical?: boolean): void;
