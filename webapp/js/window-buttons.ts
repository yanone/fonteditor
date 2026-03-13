/**
 * window-buttons.ts — Toolbar buttons for undo/redo and "Open in New Window".
 *
 * Wired up after DOM is ready. The undo/redo buttons reflect state from
 * the ChangeBridge; the "new window" button opens the same font URL
 * with a `sync` parameter.
 */

import { Logger } from './logger';

const console = new Logger('WindowButtons');

function initWindowButtons(): void {
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');
    const newWindowBtn = document.getElementById('open-new-window-btn');

    if (undoBtn) {
        undoBtn.addEventListener('click', () => {
            const bridge = window.changeBridge;
            if (!bridge) return;
            const glyphName = window.glyphCanvas?.outlineEditor?.active
                ? (window.glyphCanvas.getCurrentGlyphName() ?? undefined)
                : undefined;
            bridge.undo(glyphName);
        });
    }

    if (redoBtn) {
        redoBtn.addEventListener('click', () => {
            const bridge = window.changeBridge;
            if (!bridge) return;
            const glyphName = window.glyphCanvas?.outlineEditor?.active
                ? (window.glyphCanvas.getCurrentGlyphName() ?? undefined)
                : undefined;
            bridge.redo(glyphName);
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
