export interface Bar {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}
export interface Tick {
    time: number;
    price: number;
    volume: number;
}
export interface Point {
    /** Price value (Y axis) */
    price: number;
    /** Unix timestamp in seconds (X axis) */
    time: number;
}
export type Timeframe = '1s' | '5s' | '15s' | '30s' | '1m' | '3m' | '5m' | '15m' | '30m' | '1H' | '2H' | '4H' | '6H' | '8H' | '12H' | '1D' | '3D' | '1W' | '1M';
export type PriceScaleMode = 'linear' | 'logarithmic' | 'percentage';
export type ChartType = 'candlestick' | 'heikin_ashi' | 'bar' | 'line' | 'area' | 'baseline' | 'hollow_candle' | 'line_markers' | 'step_line' | 'hlc_area' | 'columns' | 'high_low';
export interface ChartOptions {
    /** Container element or CSS selector */
    container: HTMLElement | string;
    /** Initial symbol */
    symbol: string;
    /** Initial timeframe */
    timeframe: Timeframe;
    /** Chart type */
    chartType?: ChartType;
    /** Price scale mode */
    priceScale?: PriceScaleMode;
    /** Theme name or custom theme object */
    theme?: 'dark' | 'light' | 'colorblind-dark' | 'colorblind-light' | Theme;
    /** Locale for number/date formatting */
    locale?: string;
    /** Datafeed implementation (required) */
    datafeed: Datafeed;
    /** Number of decimal places for price display (auto-detected if omitted) */
    pricePrecision?: number;
    /** Enable/disable features */
    features?: Partial<ChartFeatures>;
    /** Rendering backend: 'webgl' for GPU-accelerated series, 'canvas2d' for classic.
     *  Default: 'canvas2d'. WebGL falls back to Canvas 2D if WebGL2 is unavailable. */
    renderer?: 'canvas2d' | 'webgl';
    /** Trading mode configuration */
    trading?: Partial<TradeOptions>;
}
export interface ChartFeatures {
    crosshair: boolean;
    tooltip: boolean;
    drawings: boolean;
    indicators: boolean;
    volume: boolean;
    grid: boolean;
    /** Show bid/ask spread on price axis */
    bidAskLine: boolean;
    /** Show vertical grid lines */
    gridVertical: boolean;
    /** Show horizontal grid lines */
    gridHorizontal: boolean;
    /** Show bar countdown timer */
    countdown: boolean;
    /** Show 24h high/low markers */
    highLow: boolean;
    /** Show current price line */
    priceLine: boolean;
    /** Show session break lines */
    sessionBreaks: boolean;
    /** Show symbol/timeframe watermark */
    watermark: boolean;
    /** Show OHLCV legend */
    ohlcvLegend: boolean;
    /** Show overlay indicator values in legend */
    overlayLegend: boolean;
    /** Show oscillator indicator values in legend */
    indicatorLegend: boolean;
    /** Show bar change percentage */
    barChange: boolean;
}
export interface ChartStateIndicator {
    /** Indicator name (unique key for registry lookup) */
    name: string;
    /** Active params */
    params: Record<string, number | string | boolean>;
}
export interface ChartState {
    /** Chart type */
    chartType: ChartType;
    /** Theme (name string or full custom object) */
    theme: string | Theme;
    /** Price scale mode */
    priceScaleMode: PriceScaleMode;
    /** Feature flags */
    features: Partial<ChartFeatures>;
    /** Magnet mode (snap to OHLC) */
    magnetMode: boolean;
    /** Stay in drawing mode after placing */
    stayInDrawingMode: boolean;
    /** Volume profile enabled */
    volumeProfile: boolean;
    /** Active indicators with params */
    indicators: ChartStateIndicator[];
    /** Serialized drawings */
    drawings: object[];
    /** Compare overlay symbols */
    compareSymbols: string[];
}
export interface TradeActionData {
    /** Price at the click location */
    price: number;
    /** Pixel coordinates (for positioning custom UI) */
    clientX: number;
    clientY: number;
    /** 'buy' or 'sell' hint based on price vs last close */
    suggestedSide: 'buy' | 'sell';
}
export interface TradeContextItem {
    label: string;
    action: string;
    /** Optional group separator before this item */
    separator?: boolean;
}
export interface TradeOptions {
    /** Show the "+" button on price axis when hovering. Default: true */
    showPlusButton: boolean;
    /** Show built-in right-click trade menu (Buy/Sell Limit/Market). Default: true */
    showContextMenu: boolean;
    /** Allow dragging order lines to change price. Default: true */
    draggableOrderLines: boolean;
    /**
     * Called when user clicks the "+" button on price axis.
     * If provided, overrides the default context menu.
     * The exchange shows its own order entry UI.
     */
    onTradeAction?: (data: TradeActionData) => void;
    /**
     * Custom items for the right-click trade context menu.
     * If provided, replaces the default Buy/Sell Limit/Market items.
     * When user clicks an item, `tradeRequested` event fires with `{ action, price }`.
     */
    contextMenuItems?: (price: number) => TradeContextItem[];
    /**
     * Called when user finishes dragging an order line.
     * If not provided, the default `orderLineMoved` event still fires.
     */
    onOrderLineDrag?: (id: string, newPrice: number) => void;
}
export interface Theme {
    name: string;
    bg: string;
    gridLine: string;
    borderColor: string;
    textPrimary: string;
    textSecondary: string;
    textMuted: string;
    /** Font family for all chart text. Default: system sans-serif */
    fontFamily?: string;
    crosshairLine: string;
    crosshairLabel: string;
    crosshairLabelText: string;
    bullCandle: string;
    bullCandleWick: string;
    bearCandle: string;
    bearCandleWick: string;
    volumeBull: string;
    volumeBear: string;
    lineDefault: string;
    selectionHighlight: string;
    tooltipBg: string;
    tooltipBorder: string;
    tooltipText: string;
    /** Take-profit color. Default: bullCandle */
    tpColor?: string;
    /** Stop-loss color. Default: bearCandle */
    slColor?: string;
    /** Limit order line color */
    limitOrderColor?: string;
    /** Stop order line color */
    stopOrderColor?: string;
    /** Entry line color */
    entryColor?: string;
    /** Breakeven line color */
    breakevenColor?: string;
    /** Liquidation line color */
    liquidationColor?: string;
    /** Badge text color (on colored backgrounds) */
    badgeText?: string;
    /** Order Block bullish fill/border */
    smcOBBull?: string;
    /** Order Block bearish fill/border */
    smcOBBear?: string;
    /** Fair Value Gap bullish */
    smcFVGBull?: string;
    /** Fair Value Gap bearish */
    smcFVGBear?: string;
    /** BOS (Break of Structure) line */
    smcBOS?: string;
    /** CHoCH (Change of Character) line */
    smcCHoCH?: string;
    /** Volume Profile buy bars */
    vpBuy?: string;
    /** Volume Profile sell bars */
    vpSell?: string;
    /** Point of Control line */
    vpPOC?: string;
    /** Value Area lines */
    vpVA?: string;
    /** Volume histogram height ratio (0-1, default 0.15 = 15% of chart) */
    volumeHeightRatio?: number;
}
export interface SymbolInfo {
    symbol: string;
    name: string;
    exchange: string;
    type: 'spot' | 'perpetual' | 'futures' | 'option';
    pricePrecision: number;
    qtyPrecision: number;
    minMove: number;
}
export type Unsubscribe = () => void;
export interface Datafeed {
    /** Load historical bars. Called on init and when user scrolls left. */
    getBars(params: {
        symbol: string;
        timeframe: Timeframe;
        from: number;
        to: number;
        limit: number;
    }): Promise<Bar[]>;
    /** Subscribe to real-time bar/tick updates. */
    subscribe(params: {
        symbol: string;
        timeframe: Timeframe;
        onBar: (bar: Bar) => void;
        onTick: (tick: Tick) => void;
    }): Unsubscribe;
    /** Search for symbols. */
    searchSymbols(query: string): Promise<SymbolInfo[]>;
    /** Resolve symbol info (precision, min move, etc.) */
    resolveSymbol?(symbol: string): Promise<SymbolInfo>;
}
export interface IndicatorParam {
    name: string;
    type: 'number' | 'color' | 'boolean';
    default: number | string | boolean;
    min?: number;
    max?: number;
    step?: number;
}
export type PlotType = 'line' | 'histogram' | 'band' | 'dots' | 'columns';
export interface PlotConfig {
    key: string;
    type: PlotType;
    color?: string;
    lineWidth?: number;
    /** For 'band' type: the key of the second series to fill between */
    bandPairKey?: string;
}
export interface IndicatorValue {
    time: number;
    [key: string]: number | undefined;
}
export interface IndicatorOutput {
    time: number;
    values: Record<string, number | undefined>;
}
/** Render context passed to custom indicator renderers */
export interface CustomRenderContext {
    ctx: CanvasRenderingContext2D;
    outputs: IndicatorOutput[];
    params: Record<string, number | string | boolean>;
    timeScale: {
        firstIndex: number;
        visibleCount: number;
        barSpacing: number;
        offsetX: number;
    };
    priceScale: {
        min: number;
        max: number;
        mode: PriceScaleMode;
    };
    chartWidth: number;
    chartHeight: number;
    precision: number;
}
export interface Indicator {
    name: string;
    shortName: string;
    description: string;
    /** true = render on price chart, false = separate pane */
    overlay: boolean;
    params: IndicatorParam[];
    plots: PlotConfig[];
    calculate(bars: Bar[], params: Record<string, number | string | boolean>): IndicatorOutput[];
    /** Custom overlay renderer. Called instead of standard renderIndicator() when defined. */
    customRender?: (rc: CustomRenderContext) => void;
}
export interface DrawingOptions {
    color: string;
    lineWidth: number;
    lineStyle: 'solid' | 'dashed' | 'dotted';
    text?: string;
    /** Fibonacci-specific: level percentages */
    fibLevels?: number[];
    /** Whether the drawing extends to screen edge */
    extendLeft?: boolean;
    extendRight?: boolean;
}
export interface DrawingTool {
    name: string;
    icon: string;
    /** Number of clicks to create (1 = horizontal line, 2 = trend line, etc.) */
    pointCount: number;
    render(ctx: CanvasRenderingContext2D, points: Point[], options: DrawingOptions, viewport: Viewport): void;
    hitTest(mousePos: Point, points: Point[], threshold: number): boolean;
    serialize(points: Point[], options: DrawingOptions): object;
    deserialize(data: object): {
        points: Point[];
        options: DrawingOptions;
    };
}
export interface Viewport {
    /** Visible time range */
    timeFrom: number;
    timeTo: number;
    /** Visible price range */
    priceFrom: number;
    priceTo: number;
    /** Canvas dimensions */
    width: number;
    height: number;
    /** Convert price/time to canvas pixel coordinates */
    priceToY(price: number): number;
    timeToX(time: number): number;
    yToPrice(y: number): number;
    xToTime(x: number): number;
}
export interface ChartEvents {
    crosshairMove: (data: {
        time: number;
        price: number;
        bar?: Bar;
    }) => void;
    click: (data: {
        time: number;
        price: number;
    }) => void;
    symbolChange: (symbol: string) => void;
    timeframeChange: (timeframe: Timeframe) => void;
    drawingAdded: (drawing: {
        id: string;
        tool: string;
        points: Point[];
    }) => void;
    drawingRemoved: (id: string) => void;
    drawingModified: (drawing: {
        id: string;
        points: Point[];
    }) => void;
    visibleRangeChange: (range: {
        from: number;
        to: number;
    }) => void;
}
