import type { Bar, Indicator, IndicatorOutput } from '../api/types';
export interface IndicatorInstance {
    readonly id: string;
    readonly indicator: Indicator;
    params: Record<string, number | string | boolean>;
    outputs: IndicatorOutput[];
    visible: boolean;
}
export declare class IndicatorEngine {
    private instances;
    /** Add an indicator with optional param overrides. Returns instance ID. */
    add(indicator: Indicator, paramOverrides?: Record<string, number | string | boolean>): string;
    /** Remove an indicator by ID */
    remove(id: string): boolean;
    /** Update indicator params and clear cached output */
    updateParams(id: string, params: Record<string, number | string | boolean>): void;
    /** Toggle indicator visibility */
    setVisible(id: string, visible: boolean): void;
    /** Recompute all indicators from bar data */
    compute(bars: readonly Bar[]): void;
    /** Get all active instances */
    getAll(): IndicatorInstance[];
    /** Get overlay indicators (rendered on price chart) */
    getOverlays(): IndicatorInstance[];
    /** Get oscillator indicators (rendered in separate panes) */
    getOscillators(): IndicatorInstance[];
    /** Get instance by ID */
    get(id: string): IndicatorInstance | undefined;
    /** Get indicator output value at a specific bar index */
    getValueAt(id: string, barIndex: number): Record<string, number | undefined> | undefined;
}
