import type { IndicatorInstance } from '../../indicators/engine';
export type OnSettingsApply = (id: string, params: Record<string, any>) => void;
export type OnSettingsRemove = (id: string) => void;
export declare class IndicatorSettingsPopup {
    private el;
    private instance;
    private onApply;
    private onRemove;
    constructor(container: HTMLElement, onApply: OnSettingsApply, onRemove: OnSettingsRemove);
    show(x: number, y: number, instance: IndicatorInstance): void;
    hide(): void;
    destroy(): void;
}
