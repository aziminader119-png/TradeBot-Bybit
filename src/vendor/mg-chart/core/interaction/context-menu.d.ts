export interface ContextMenuItem {
    label: string;
    action: string;
    icon?: string;
    danger?: boolean;
    toggle?: boolean;
    active?: boolean;
}
export type ContextMenuCallback = (action: string, drawingId: string) => void;
export declare class ContextMenu {
    private el;
    private drawingId;
    private callback;
    constructor(container: HTMLElement, callback: ContextMenuCallback);
    show(x: number, y: number, drawingId: string, items: ContextMenuItem[]): void;
    hide(): void;
    destroy(): void;
}
export declare function getDrawingContextMenuItems(locked: boolean): ContextMenuItem[];
