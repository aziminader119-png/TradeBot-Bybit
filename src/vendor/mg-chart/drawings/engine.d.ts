import type { Point, DrawingOptions } from '../api/types';
import type { PixelPoint } from './primitives/hit-test';
export interface DrawingInstance {
    id: string;
    toolName: string;
    points: Point[];
    options: DrawingOptions;
    locked: boolean;
    visible: boolean;
}
export interface InternalDrawingTool {
    name: string;
    icon: string;
    /** Number of clicks to create */
    pointCount: number;
    /** Render the drawing on canvas */
    render(ctx: CanvasRenderingContext2D, points: PixelPoint[], options: DrawingOptions, width: number, height: number): void;
    /** Hit test: is mouse near this drawing? Returns distance in pixels */
    hitTest(mouse: PixelPoint, points: PixelPoint[], threshold: number): boolean;
    /** Get handle positions (for editing) */
    getHandles(points: PixelPoint[]): PixelPoint[];
}
export type DrawingState = {
    mode: 'idle';
} | {
    mode: 'creating';
    toolName: string;
    points: Point[];
    previewPoint: Point | null;
} | {
    mode: 'editing';
    drawingId: string;
    handleIndex: number;
} | {
    mode: 'moving';
    drawingId: string;
    startMouse: Point;
    startPoints: Point[];
};
export declare class DrawingEngine {
    private drawings;
    private tools;
    state: DrawingState;
    /** Currently selected drawing ID (persists across idle/edit/move states) */
    selectedId: string | null;
    /** Select a drawing. Returns the drawing or null. */
    select(id: string | null): DrawingInstance | null;
    /** Get the currently selected drawing */
    getSelected(): DrawingInstance | null;
    /** Deselect */
    deselect(): void;
    /** Register a drawing tool */
    registerTool(tool: InternalDrawingTool): void;
    /** Get a registered tool */
    getTool(name: string): InternalDrawingTool | undefined;
    /** Start creating a drawing with the given tool */
    startCreating(toolName: string): void;
    /** Add a point during creation. Returns true if drawing is complete. */
    addPoint(point: Point): DrawingInstance | null;
    /** Update preview point during creation (mouse move) */
    setPreviewPoint(point: Point | null): void;
    /** Cancel current creation */
    cancelCreating(): void;
    private createDrawing;
    /** Remove a drawing */
    remove(id: string): boolean;
    /** Get a drawing by ID */
    get(id: string): DrawingInstance | undefined;
    /** Get all visible drawings */
    getAll(): DrawingInstance[];
    /** Get all drawing instances (including hidden) for object list */
    getAllInstances(): DrawingInstance[];
    /** Update drawing points (after editing) */
    updatePoints(id: string, points: Point[]): void;
    /** Update drawing options */
    updateOptions(id: string, options: Partial<DrawingOptions>): void;
    /** Toggle lock */
    toggleLock(id: string): void;
    /** Toggle visibility */
    toggleVisible(id: string): void;
    /** Start editing a handle */
    startEditing(drawingId: string, handleIndex: number): void;
    /** Start moving an entire drawing */
    startMoving(drawingId: string, mousePoint: Point): void;
    /** Update during drag */
    dragTo(point: Point): void;
    /** End editing/moving */
    endDrag(): void;
    /** Find drawing at pixel position. Returns drawing ID or null. */
    hitTest(mouse: PixelPoint, pointToPixel: (p: Point) => PixelPoint, threshold: number): {
        drawingId: string;
        handleIndex: number;
    } | {
        drawingId: string;
    } | null;
    /** Serialize all drawings to JSON */
    serialize(): object[];
    /** Load drawings from serialized data */
    deserialize(data: object[]): void;
    /** Move a drawing to a specific index (for z-order) */
    reorder(id: string, toIndex: number): void;
    /** Bring drawing to front (render last = topmost) */
    bringToFront(id: string): void;
    /** Send drawing to back (render first = bottommost) */
    sendToBack(id: string): void;
    /** Clear all drawings */
    clear(): void;
}
