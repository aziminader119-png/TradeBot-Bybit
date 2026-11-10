export interface Pane {
    /** Unique identifier */
    id: string;
    /** 'main' for price chart, indicator ID for oscillator panes */
    type: 'main' | 'indicator';
    /** Associated indicator IDs (for oscillator panes) */
    indicatorIds: string[];
    /** Height ratio (0-1, all panes sum to 1) */
    heightRatio: number;
    /** Computed absolute Y offset in pixels */
    yOffset: number;
    /** Computed absolute height in pixels */
    height: number;
    /** Y-axis range for this pane */
    scaleMin: number;
    scaleMax: number;
}
