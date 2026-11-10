import type { Bar, Theme } from '../../api/types';
import type { TimeScale } from './time-axis';
export declare function renderSessionBreaks(ctx: CanvasRenderingContext2D, bars: readonly Bar[], firstBarIndex: number, timeScale: TimeScale, theme: Theme, chartWidth: number, chartHeight: number): void;
