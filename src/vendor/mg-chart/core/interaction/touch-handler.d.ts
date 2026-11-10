export interface TouchCallbacks {
    onPan: (dx: number) => void;
    onPinch: (scale: number, centerX: number) => void;
    onLongPress: (x: number, y: number) => void;
    onLongPressMove: (x: number, y: number) => void;
    onLongPressEnd: () => void;
    onDoubleTap: () => void;
    onMomentum: (velocity: number) => void;
}
export declare class TouchHandler {
    private element;
    private callbacks;
    private longPressTimer;
    private isLongPressing;
    private lastTapTime;
    private startX;
    private startY;
    private lastX;
    private velocity;
    private pinchStartDist;
    constructor(element: HTMLElement, callbacks: TouchCallbacks);
    private onTouchStart;
    private onTouchMove;
    private onTouchEnd;
    private cancelLongPress;
    private getTouchDist;
    destroy(): void;
}
