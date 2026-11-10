export interface UndoAction {
    type: 'add' | 'remove' | 'modify';
    drawingId: string;
    data: any;
}
export declare class UndoStack {
    private undoStack;
    private redoStack;
    push(action: UndoAction): void;
    canUndo(): boolean;
    canRedo(): boolean;
    undo(): UndoAction | null;
    redo(): UndoAction | null;
    clear(): void;
}
