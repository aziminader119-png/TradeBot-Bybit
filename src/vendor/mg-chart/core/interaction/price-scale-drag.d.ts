export interface PriceScaleDragCallbacks {
    onScale: (factor: number) => void;
    onAutoFit: () => void;
}
export declare class PriceScaleDragHandler {
    private isDragging;
    private lastY;
    private element;
    private chartWidth;
    private callbacks;
    constructor(element: HTMLElement, chartWidth: number, callbacks: PriceScaleDragCallbacks);
    updateChartWidth(w: number): void;
    private isOnPriceAxis;
    private onMouseDown;
    private onMouseMove;
    private onMouseUp;
    private onDblClick;
    destroy(): void;
}
