import type { Bar, Theme } from '../../api/types';
import type { RenderContext } from '../renderer/render-context';
import type { TimeScale } from '../renderer/time-axis';
export declare function renderVolume(ctx: RenderContext | CanvasRenderingContext2D, bars: readonly Bar[], firstBarIndex: number, maxVolume: number, timeScale: TimeScale, theme: Theme, chartWidth: number, chartHeight: number): void;
