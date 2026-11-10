import type { Indicator } from '../api/types';
/** Register a custom indicator */
export declare function registerIndicator(indicator: Indicator): void;
/** Get indicator definition by name */
export declare function getIndicator(name: string): Indicator | undefined;
/** Get all registered indicators */
export declare function getAllIndicators(): Indicator[];
/** Get overlay indicators only */
export declare function getOverlayIndicators(): Indicator[];
/** Get oscillator indicators only */
export declare function getOscillatorIndicators(): Indicator[];
