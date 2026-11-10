import type { Pane } from './pane';
export declare class PaneManager {
    private panes;
    private totalHeight;
    constructor();
    /** Add an oscillator pane for an indicator */
    addOscillatorPane(indicatorId: string): string;
    /** Remove an oscillator pane */
    removePane(indicatorId: string): void;
    /** Set total available height and recompute layout */
    setHeight(totalHeight: number): void;
    /** Get all panes */
    getAll(): readonly Pane[];
    /** Get main pane */
    getMain(): Pane;
    /** Get pane at a Y coordinate */
    getPaneAtY(y: number): Pane | undefined;
    /** Get pane by indicator ID */
    getPaneForIndicator(indicatorId: string): Pane | undefined;
    /** Update Y-axis scale for a pane */
    setScale(paneId: string, min: number, max: number): void;
    /** Check if Y is near a resize handle between panes */
    getResizeHandle(y: number, threshold?: number): {
        index: number;
        y: number;
    } | null;
    /** Resize panes by dragging the border between pane[index] and pane[index+1] */
    resizeAt(index: number, deltaY: number): void;
    private recomputeLayout;
}
