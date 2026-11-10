import type { RenderContext } from './render-context';
import { WebGLBatchRenderer } from './webgl/batch-renderer';
import { CandleRenderer } from './webgl/candle-renderer';
export type LayerName = 'background' | 'series' | 'crosshair' | 'ui';
export type RendererBackend = 'canvas2d' | 'webgl';
export interface CanvasLayer {
    readonly name: LayerName;
    readonly canvas: HTMLCanvasElement;
    /** Canvas 2D context. Null for WebGL-backed layers. */
    readonly ctx: CanvasRenderingContext2D;
    /** Render context — works for both Canvas 2D and WebGL backends. */
    readonly rc: RenderContext;
    dirty: boolean;
}
export declare class LayerManager {
    private container;
    private layers;
    private _width;
    private _height;
    private _dpr;
    private _backend;
    private webglBatch;
    private _candleRenderer;
    get width(): number;
    get height(): number;
    get dpr(): number;
    get backend(): RendererBackend;
    /** Get the WebGL batch renderer (null if Canvas 2D backend) */
    get batchRenderer(): WebGLBatchRenderer | null;
    /** Get the GPU candlestick/volume renderer (null if Canvas 2D backend) */
    get candleRenderer(): CandleRenderer | null;
    /** Logical pixel dimensions (CSS pixels, not device pixels) */
    get logicalWidth(): number;
    get logicalHeight(): number;
    constructor(container: HTMLElement, backend?: RendererBackend);
    /** Get a layer by name */
    get(name: LayerName): CanvasLayer;
    /** Mark a layer as needing repaint */
    markDirty(name: LayerName): void;
    /** Mark all layers dirty */
    markAllDirty(): void;
    /** Clear a layer's canvas */
    clear(name: LayerName): void;
    /** Resize all canvases to match container. Call on window resize / container resize. */
    resize(): void;
    /** Iterate dirty layers, call render callback, clear dirty flag */
    renderDirty(renderFn: (layer: CanvasLayer) => void): void;
    /** Remove all canvases from DOM */
    destroy(): void;
}
