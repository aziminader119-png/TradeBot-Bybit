export interface KeyboardAction {
    key: string;
    ctrl?: boolean;
    shift?: boolean;
    action: string;
}
export type KeyboardCallback = (action: string) => void;
export declare class KeyboardHandler {
    private element;
    private callback;
    private shortcuts;
    constructor(element: HTMLElement, callback: KeyboardCallback);
    private onKeyDown;
    destroy(): void;
}
