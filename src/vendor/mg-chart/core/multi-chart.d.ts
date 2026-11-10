import { Chart } from './chart';
import type { ChartOptions } from '../api/types';
export interface MultiChartConfig {
    /** Container element or CSS selector */
    container: HTMLElement | string;
    /** Grid layout: [rows, cols] */
    layout: [number, number];
    /** Chart configs per cell (row-major order) */
    charts: Array<Omit<ChartOptions, 'container'>>;
    /** Sync crosshair across all charts */
    syncCrosshair?: boolean;
    /** Sync timeframe across all charts */
    syncTimeframe?: boolean;
}
export declare class MultiChart {
    private container;
    private grid;
    private charts;
    private cells;
    constructor(config: MultiChartConfig);
    /** Get chart at grid position (0-indexed, row-major) */
    getChart(index: number): Chart | undefined;
    /** Get all charts */
    getAllCharts(): Chart[];
    /** Change grid layout (destroys and recreates) */
    setLayout(_rows: number, _cols: number, _configs: Array<Omit<ChartOptions, 'container'>>): void;
    /** Destroy all charts and clean up */
    destroy(): void;
}
