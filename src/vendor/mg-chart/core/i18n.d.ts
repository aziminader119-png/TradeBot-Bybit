export interface ChartLocale {
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
    long: string;
    short: string;
    tp: string;
    sl: string;
    entry: string;
    target: string;
    breakeven: string;
    pnl: string;
    expectedProfit: string;
    expectedLoss: string;
    riskReward: string;
    high24h: string;
    low24h: string;
    fvg: string;
    orderBlock: string;
    bos: string;
    choch: string;
    bullish: string;
    bearish: string;
    range: string;
    hh: string;
    lh: string;
    hl: string;
    ll: string;
    volumeProfile: string;
    poc: string;
    vah: string;
    val: string;
    gartley: string;
    butterfly: string;
    bat: string;
    crab: string;
    deepCrab: string;
    cypher: string;
    wLabel: string;
    xLabel: string;
    yLabel: string;
    zLabel: string;
    cycle: string;
    ghostBars: string;
    bars: string;
    seg: string;
    avwap: string;
    days: string;
    hours: string;
    minutes: string;
    seconds: string;
}
/** Get translated string by key */
export declare function t(key: keyof ChartLocale): string;
/** Set locale (partial — only override what you need) */
export declare function setLocale(locale: Partial<ChartLocale>): void;
/** Reset to English defaults */
export declare function resetLocale(): void;
/** Get current full locale object */
export declare function getLocale(): Readonly<ChartLocale>;
