import type { TimeScale } from '../renderer/time-axis';
export interface ScrollZoomState {
    timeScale: TimeScale;
    totalBars: number;
}
export type OnScaleChange = (scale: TimeScale) => void;
export declare class ScrollZoomHandler {
    private isDragging;
    private lastMouseX;
    private momentumVelocity;
    private momentumRaf;
    private pinchStartDist;
    private pinchStartSpacing;
    private state;
    private onChange;
    private element;
    enabled: boolean;
    constructor(element: HTMLElement, state: ScrollZoomState, onChange: OnScaleChange);
    updateState(state: ScrollZoomState): void;
    destroy(): void;
    private onMouseDown;
    private onMouseMove;
    private onMouseUp;
    private onWheel;
    private onTouchStart;
    private onTouchMove;
    private onTouchEnd;
    private getTouchDist;
    private pan;
    private zoom;
    private zoomTo;
    private clampFirstIndex;
    private applyScale;
    private startMomentum;
}
export declare function createDefaultTimeScale(totalBars: number, chartWidth: number): TimeScale;
