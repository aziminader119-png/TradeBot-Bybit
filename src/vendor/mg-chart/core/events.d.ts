import type { Bar, Point, Timeframe } from '../api/types';
export interface ChartEventMap {
    crosshairMove: {
        time: number;
        price: number;
        bar?: Bar;
    };
    click: {
        time: number;
        price: number;
    };
    symbolChange: string;
    timeframeChange: Timeframe;
    chartTypeChange: string;
    drawingAdded: {
        id: string;
        tool: string;
        points: Point[];
    };
    drawingRemoved: string;
    drawingModified: {
        id: string;
        points: Point[];
    };
    visibleRangeChange: {
        from: number;
        to: number;
    };
    indicatorAdded: {
        id: string;
        name: string;
    };
    indicatorRemoved: string;
    dataLoaded: {
        symbol: string;
        bars: number;
    };
    barUpdate: Bar;
    drawingSelected: {
        id: string;
        drawing: any;
        clientX: number;
        clientY: number;
    };
    drawingDeselected: undefined;
    textInputRequested: {
        drawingId: string;
        toolName: string;
        clientX: number;
        clientY: number;
        currentText: string;
        color: string;
        lineWidth: number;
    };
    tradeRequested: {
        side: 'buy' | 'sell';
        price: number;
        type: 'market' | 'limit';
        action?: string;
    };
    orderLineMoved: {
        id: string;
        price: number;
    };
}
type Listener<T> = (data: T) => void;
export declare class EventEmitter {
    private listeners;
    /** Subscribe to an event */
    on<K extends keyof ChartEventMap>(event: K, listener: Listener<ChartEventMap[K]>): void;
    /** Unsubscribe from an event */
    off<K extends keyof ChartEventMap>(event: K, listener: Listener<ChartEventMap[K]>): void;
    /** Subscribe to an event — fires once then auto-unsubscribes */
    once<K extends keyof ChartEventMap>(event: K, listener: Listener<ChartEventMap[K]>): void;
    /** Emit an event to all listeners */
    emit<K extends keyof ChartEventMap>(event: K, data: ChartEventMap[K]): void;
    /** Remove all listeners */
    removeAll(): void;
}
export {};
