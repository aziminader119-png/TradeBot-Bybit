import type { Indicator } from '../../api/types';
export declare const ema: Indicator;
/** Standalone EMA calculation for use by other indicators */
export declare function calcEMA(values: number[], period: number): (number | undefined)[];
