import type { Theme } from '../../api/types';
export interface ReferenceLineConfig {
    value: number;
    color?: string;
    lineWidth?: number;
    dashed?: boolean;
    /** Fill zone between this line and a pair value */
    zonePairValue?: number;
    zoneColor?: string;
}
/** Get reference lines for a known indicator */
export declare function getReferenceLinesForIndicator(indicatorName: string): ReferenceLineConfig[];
/** Render reference lines and zones on an oscillator pane */
export declare function renderReferenceLines(ctx: CanvasRenderingContext2D, lines: ReferenceLineConfig[], theme: Theme, chartWidth: number, yOffset: number, paneHeight: number, scaleMin: number, scaleMax: number): void;
