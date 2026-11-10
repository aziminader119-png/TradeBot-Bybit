import type { Theme } from '../../api/types';
export interface PaneControlHit {
    paneId: string;
    action: 'settings' | 'hide' | 'close';
}
/** Render pane control buttons. Returns button positions for hit testing. */
export declare function renderPaneControls(ctx: CanvasRenderingContext2D, theme: Theme, paneId: string, chartWidth: number, yOffset: number): void;
/** Hit test pane control buttons. Returns action or null. */
export declare function hitTestPaneControls(mouseX: number, mouseY: number, chartWidth: number, yOffset: number): 'close' | 'hide' | 'settings' | null;
