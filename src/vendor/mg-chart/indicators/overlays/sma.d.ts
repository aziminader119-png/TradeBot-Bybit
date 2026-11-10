import type { Indicator } from '../../api/types';
export declare const sma: Indicator;
/** Standalone SMA calculation for use by other indicators */
export declare function calcSMA(values: number[], period: number): (number | undefined)[];
