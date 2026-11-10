export declare class WebGLBatchRenderer {
    readonly gl: WebGL2RenderingContext;
    private rectProg;
    private lineProg;
    private textProg;
    private quadVBO;
    private rectVAO;
    private rectInstanceBuf;
    private rectData;
    private rectCount;
    private lineVAO;
    private lineInstanceBuf;
    private lineVertexBuf;
    private lineData;
    private lineCount;
    private textVAO;
    private textInstanceBuf;
    private textData;
    private textCount;
    private textAtlasCanvas;
    private textAtlasCtx;
    private textTexture;
    private textCacheMap;
    private textAtlasCursorX;
    private textAtlasCursorY;
    private textAtlasRowHeight;
    private textAtlasDirty;
    private _width;
    private _height;
    constructor(canvas: HTMLCanvasElement);
    private initShaders;
    private initBuffers;
    private initTextTexture;
    resize(width: number, height: number, dpr: number): void;
    clear(r?: number, g?: number, b?: number, a?: number): void;
    pushRect(x: number, y: number, w: number, h: number, color: string, alpha?: number): void;
    pushRectRGBA(x: number, y: number, w: number, h: number, r: number, g: number, b: number, a: number): void;
    flushRects(): void;
    pushLine(x0: number, y0: number, x1: number, y1: number, width: number, color: string, alpha?: number): void;
    /** Push a line segment with pre-parsed RGBA (avoids color string parsing per call) */
    pushLineRGBA(x0: number, y0: number, x1: number, y1: number, width: number, r: number, g: number, b: number, a: number): void;
    flushLines(): void;
    /**
     * Render text to the atlas (if not cached) and queue a textured quad.
     * Returns the measured width.
     */
    pushText(text: string, x: number, y: number, font: string, color: string, align?: CanvasTextAlign, baseline?: CanvasTextBaseline): number;
    private rasterizeText;
    private resetTextAtlas;
    flushText(): void;
    flush(): void;
    setScissor(x: number, y: number, w: number, h: number): void;
    clearScissor(): void;
    measureText(text: string, font: string): TextMetrics;
    destroy(): void;
}
