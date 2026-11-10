import type { Bar, ChartOptions, ChartState, ChartType, Indicator, Theme, Timeframe } from '../api/types';
import type { ChartLocale } from './i18n';
import type { PositionOverlayData } from './renderer/position-overlay';
import type { OrderLine } from './renderer/order-lines';
import type { ChartEventMap } from './events';
export declare class Chart {
    /** Set library-wide log level: 'debug' | 'info' | 'warn' | 'error' | 'none' */
    static setLogLevel(level: import('./logger').LogLevel): void;
    /** Set custom log handler (e.g. for Sentry, DataDog) */
    static setLogHandler(handler: ((level: string, message: string, ...args: any[]) => void) | null): void;
    /** Set chart locale (partial — override only the keys you need) */
    static setLocale(locale: Partial<ChartLocale>): void;
    /** Reset locale to English defaults */
    static resetLocale(): void;
    private container;
    private layers;
    private dataSource;
    private theme;
    private timeframe;
    private symbol;
    private datafeed;
    private precision;
    private chartType;
    private priceScale;
    private timeScale;
    private scrollZoom;
    private crosshair;
    private indicatorEngine;
    private paneManager;
    private drawingEngine;
    private compareManager;
    private orderLineManager;
    private alertManager;
    private _lastAlertPrice;
    private undoStack;
    private keyboard;
    private priceScaleDrag;
    private touchHandler;
    private manualPriceScale;
    private events;
    private rafId;
    private needsRender;
    private autoScroll;
    private _loadingHistory;
    private _showVolumeProfile;
    private _showCountdown;
    private _showHighLow;
    private _showPriceLine;
    private _showGridVert;
    private _showGridHoriz;
    private _showSessionBreaks;
    private _showWatermark;
    private _showOhlcvLegend;
    private _showOverlayLegend;
    private _showIndicatorLegend;
    private _showBarChange;
    private _showVolume;
    private _magnetMode;
    private _stayInDrawingMode;
    private _activeToolName;
    private countdownTimer;
    private _goLiveBtn;
    private _draggingOrderLine;
    private _hoveredDrawingId;
    private _drawingInteraction;
    private _tradeMode;
    private _tradeOptions;
    private _tradeHoverY;
    private _pendingTradePrice;
    private _resizingPane;
    private contextMenu;
    private indicatorSettings;
    private _positionOverlays;
    private _priceMarkers;
    private _barMarkers;
    private unsubscribeStream;
    private resizeObserver;
    private get chartWidth();
    private get chartHeight();
    constructor(options: ChartOptions);
    /** Set chart data directly (alternative to datafeed) */
    setData(bars: Bar[]): void;
    /** Update the last bar or add a new bar (real-time) */
    updateBar(bar: Bar): void;
    /** Append a confirmed Renko batch and recompute indicators once. */
    updateBars(bars: Bar[]): void;
    /** Add an indicator to the chart. Returns instance ID for later removal. */
    addIndicator(indicator: Indicator, params?: Record<string, number | string | boolean>): string;
    /** Remove an indicator by its instance ID */
    removeIndicator(id: string): void;
    /** Update indicator parameters */
    updateIndicatorParams(id: string, params: Record<string, number | string | boolean>): void;
    /** Subscribe to chart events */
    on<K extends keyof ChartEventMap>(event: K, listener: (data: ChartEventMap[K]) => void): void;
    /** Unsubscribe from chart events */
    off<K extends keyof ChartEventMap>(event: K, listener: (data: ChartEventMap[K]) => void): void;
    /** Jump to the latest bar and re-enable auto-scroll */
    goToLive(): void;
    /** Zoom in (show fewer bars, more detail) */
    zoomIn(factor?: number): void;
    /** Zoom out (show more bars, less detail) */
    zoomOut(factor?: number): void;
    /** Scroll chart left by N bars */
    scrollLeft(bars?: number): void;
    /** Scroll chart right by N bars */
    scrollRight(bars?: number): void;
    /** Reset zoom to show default bar count and go to live */
    resetZoom(): void;
    /** Show data for the last N seconds (e.g., 86400 for 1 day, 2592000 for 30 days) */
    setVisibleRange(seconds: number): void;
    /**
     * Add price level markers on the price axis (bid, ask, mark, index, etc.)
     * These are separate from order lines — they're informational labels.
     */
    setPriceMarkers(markers: {
        price: number;
        label: string;
        color: string;
    }[]): void;
    /**
     * Add annotation markers on specific bars (Buy/Sell signals, events).
     * Each marker appears above or below the bar.
     */
    setBarMarkers(markers: {
        time: number;
        label: string;
        color: string;
        position: 'above' | 'below';
    }[]): void;
    /** Add a compare symbol overlay */
    addCompare(symbol: string): Promise<void>;
    /** Remove a compare symbol */
    removeCompare(symbol: string): void;
    /** Add an order/position line */
    addOrderLine(line: OrderLine): void;
    /** Remove an order line */
    removeOrderLine(id: string): void;
    /** Update an order line */
    updateOrderLine(id: string, updates: Partial<OrderLine>): void;
    /** Set position overlays (Bybit-style zones with TP/SL shading + PnL) */
    setPositionOverlays(positions: PositionOverlayData[]): void;
    /** Clear all order lines */
    clearOrderLines(): void;
    /** Get all order lines (for serialization) */
    getOrderLines(): OrderLine[];
    /** Load order lines from serialized data */
    loadOrderLines(lines: OrderLine[]): void;
    /** Toggle magnet mode (snap drawings to OHLC) */
    /** Set price scale mode: linear, logarithmic, or percentage */
    setPriceScale(mode: 'linear' | 'logarithmic' | 'percentage'): void;
    setMagnetMode(enabled: boolean): void;
    /** When enabled, drawing tool stays active after completing a drawing */
    setStayInDrawingMode(enabled: boolean): void;
    /** Lock all drawings */
    lockAllDrawings(): void;
    /** Unlock all drawings */
    unlockAllDrawings(): void;
    /** Hide all drawings */
    hideAllDrawings(): void;
    /** Show all drawings */
    showAllDrawings(): void;
    /** Enable/disable drawing interactions (selection, editing, creation) */
    setDrawingInteraction(enabled: boolean): void;
    /** Calculate price tick step for trade hover snapping */
    private _tradeTickStep;
    /** Enable/disable trade mode (price axis +, right-click trade menu) */
    setTradeMode(enabled: boolean, options?: Partial<import('../api/types').TradeOptions>): void;
    /** Update trade options without toggling mode */
    setTradeOptions(options: Partial<import('../api/types').TradeOptions>): void;
    /** Update chart feature flags */
    setFeatures(features: Partial<import('../api/types').ChartFeatures>): void;
    /** Toggle Volume Profile overlay */
    setVolumeProfile(enabled: boolean): void;
    /** Change chart type */
    setChartType(type: ChartType): void;
    /** Activate a drawing tool by name. Pass null to deactivate. */
    setDrawingTool(toolName: string | null): void;
    /** Get all drawings as serializable objects */
    getDrawings(): object[];
    /** Get all drawing instances (including hidden) for object list */
    getDrawingInstances(): {
        id: string;
        toolName: string;
        locked: boolean;
        visible: boolean;
        options: any;
    }[];
    /** Load drawings from serialized data */
    loadDrawings(data: object[]): void;
    /** Remove a specific drawing */
    removeDrawing(id: string): void;
    /** Clear all drawings */
    clearDrawings(): void;
    /** Update selected drawing properties */
    updateDrawing(id: string, opts: {
        color?: string;
        lineWidth?: number;
        lineStyle?: 'solid' | 'dashed' | 'dotted';
        text?: string;
    }): void;
    /** Toggle drawing lock */
    toggleDrawingLock(id: string): void;
    /** Toggle drawing visibility */
    toggleDrawingVisible(id: string): void;
    /** Get selected drawing */
    getSelectedDrawing(): {
        id: string;
        toolName: string;
        options: any;
        locked: boolean;
        visible: boolean;
    } | null;
    /** Reorder drawing z-index */
    reorderDrawing(id: string, toIndex: number): void;
    /** Bring drawing to front */
    bringDrawingToFront(id: string): void;
    /** Send drawing to back */
    sendDrawingToBack(id: string): void;
    /** Change symbol */
    setSymbol(symbol: string): Promise<void>;
    /** Change timeframe */
    setTimeframe(timeframe: Timeframe): Promise<void>;
    /** Add a price alert */
    addAlert(price: number, direction?: 'crossing' | 'above' | 'below', label?: string): string;
    /** Remove a price alert */
    removeAlert(id: string): void;
    /** Export chart as PNG */
    exportPNG(filename?: string): void;
    /** Copy chart image to clipboard */
    copyPNG(): Promise<void>;
    /** Change theme */
    setTheme(theme: ThemeName | Theme): void;
    /** Get current chart type */
    getChartType(): ChartType;
    /** Get current theme object */
    getTheme(): Theme;
    /** Get current price scale mode */
    getPriceScaleMode(): import('../api/types').PriceScaleMode;
    /** Get current feature flags */
    getFeatures(): Partial<import('../api/types').ChartFeatures>;
    /** Get magnet mode state */
    getMagnetMode(): boolean;
    /** Get stay-in-drawing-mode state */
    getStayInDrawingMode(): boolean;
    /** Get volume profile state */
    getVolumeProfile(): boolean;
    /** Get active indicators with params */
    getIndicators(): {
        name: string;
        params: Record<string, number | string | boolean>;
    }[];
    /** Get active compare symbols */
    getCompareSymbols(): string[];
    /** Export full chart state as a JSON-serializable object */
    exportState(): ChartState;
    /** Import chart state (restores everything). Partial — only provided fields are applied. */
    importState(state: Partial<ChartState>): Promise<void>;
    /** Get the active rendering backend ('canvas2d' or 'webgl') */
    getRendererBackend(): string;
    /** Destroy chart and clean up */
    destroy(): void;
    private loadInitialData;
    private loadMoreHistory;
    private recomputeIndicators;
    private fitToData;
    private recalcPriceRange;
    private recalcOscillatorScales;
    private pixelToPoint;
    private pointToPixel;
    private onKeyAction;
    private onContextMenu;
    private handleContextMenuAction;
    private onDoubleClick;
    private onDrawingClick;
    private onDrawingMouseDown;
    private emitSelectionEvent;
    private onDrawingMouseUp;
    private onMouseMove;
    private onMouseLeave;
    private scheduleRender;
    private render;
    private renderBackground;
    private renderSeriesLayer;
    private renderCrosshairLayer;
    private renderUILayer;
    private renderSeries;
    private renderDrawings;
}
type ThemeName = 'dark' | 'light' | 'colorblind-dark' | 'colorblind-light';
export {};

