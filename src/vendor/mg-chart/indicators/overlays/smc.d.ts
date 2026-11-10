import type { Indicator } from '../../api/types';
export interface SwingPoint {
    idx: number;
    price: number;
    isHigh: boolean;
}
export interface OrderBlock {
    high: number;
    low: number;
    candleIndex: number;
    type: 'bullish' | 'bearish';
    mitigated: boolean;
    mitigatedIndex: number;
    volumePct: number;
}
export interface FairValueGap {
    type: 'bullish' | 'bearish';
    low: number;
    high: number;
    candleIndex: number;
    filled: boolean;
    mitigatedIndex: number;
    gapSizePct: number;
}
export interface BOSEvent {
    type: 'bos' | 'choch';
    direction: 'bullish' | 'bearish';
    level: number;
    candleIndex: number;
}
export type StructureType = 'uptrend' | 'downtrend' | 'ranging' | 'unknown';
export interface SMCData {
    swings: SwingPoint[];
    orderBlocks: OrderBlock[];
    fvgs: FairValueGap[];
    bosEvents: BOSEvent[];
    structure: StructureType;
}
export declare function getLastSMCData(): SMCData | null;
/** @internal — for testing only */
export declare function _setTestSMCData(data: SMCData | null): void;
export declare const smc: Indicator;
