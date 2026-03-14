/**
 * window-buttons.ts — Toolbar buttons for undo/redo and "Open in New Window".
 *
 * Wired up after DOM is ready. The undo/redo buttons reflect state from
 * the ChangeBridge; the "new window" button opens the same font URL
 * with a `sync` parameter.
 */

import { Logger } from './logger';
import { runBridgeUndoRedo } from './change-bridge-init';

const console = new Logger('WindowButtons');

function initWindowButtons(): void {
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');
    const newWindowBtn = document.getElementById('open-new-window-btn');

    if (undoBtn) {
        undoBtn.addEventListener('click', async () => {
            const bridge = window.changeBridge;
            if (!bridge) return;
            const oe = window.glyphCanvas?.outlineEditor;
            const parsedStack = oe?.active ? oe.parseGlyphStack() : [];
            const rootGlyphName = parsedStack[0]?.glyphName;
            const undoGlyphName =
                parsedStack[parsedStack.length - 1]?.glyphName;
            if (oe?.active && (!rootGlyphName || !undoGlyphName)) {
                console.warn(
                    'Skipping undo: active outline editor has incomplete glyph stack'
                );
                return;
            }
            await runBridgeUndoRedo('undo', undoGlyphName, rootGlyphName);
        });
    }

    if (redoBtn) {
        redoBtn.addEventListener('click', async () => {
            const bridge = window.changeBridge;
            if (!bridge) return;
            const oe = window.glyphCanvas?.outlineEditor;
            const parsedStack = oe?.active ? oe.parseGlyphStack() : [];
            const rootGlyphName = parsedStack[0]?.glyphName;
            const undoGlyphName =
                parsedStack[parsedStack.length - 1]?.glyphName;
            if (oe?.active && (!rootGlyphName || !undoGlyphName)) {
                console.warn(
                    'Skipping redo: active outline editor has incomplete glyph stack'
                );
                return;
            }
            await runBridgeUndoRedo('redo', undoGlyphName, rootGlyphName);
        });
    }

    if (newWindowBtn) {
        newWindowBtn.addEventListener('click', () => {
            const url = new URL(window.location.href);
            url.searchParams.set('sync', 'true');
            window.open(url.toString(), '_blank');
        });
    }

    const undoManagerBtn = document.getElementById('open-undo-manager-btn');
    if (undoManagerBtn) {
        undoManagerBtn.addEventListener('click', () => {
            const fontPath = window.fontManager?.currentFont?.path ?? 'unsaved';
            const channelName = `counterpunch-font:${fontPath}`;
            const url = new URL('undo-manager.html', window.location.href);
            url.searchParams.set('channel', channelName);
            window.open(url.toString(), '_blank', 'width=500,height=700');
        });
    }
}

// Initialize after DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWindowButtons);
} else {
    initWindowButtons();
}
