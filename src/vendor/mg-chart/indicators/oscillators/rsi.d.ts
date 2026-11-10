import type { Bar, Indicator, IndicatorOutput } from '../../api/types';
export declare const rsi: Indicator;
export declare function calcRSI(bars: Bar[], period: number): IndicatorOutput[];
