/**
 * change-bridge-init.ts — Initialize ChangeBridge and WindowSync when a font loads.
 *
 * Listens for the 'fontModelReady' CustomEvent and wires up:
 *  1. A ChangeBridge backed by the font's babelfontData JSON
 *  2. A WindowSync for cross-window collaboration
 *  3. Undo/redo dirty marking + babelfontJson resync callbacks
 *
 * If the URL contains `sync=true`, the bridge skips `initFromJson()` and
 * instead requests a full-state transfer from an existing peer window.
 */

import { ChangeBridge } from './change-bridge';
import { Font } from './babelfont-model';
import { WindowSync } from './window-sync';
import { Logger } from './logger';

const console = new Logger('ChangeBridgeInit');

function isSyncWindow(): boolean {
    try {
        return new URLSearchParams(window.location.search).has('sync');
    } catch {
        return false;
    }
}

/**
 * Tear down any existing ChangeBridge / WindowSync before loading a new font.
 */
function destroyExisting(): void {
    if (window.windowSync) {
        window.windowSync.destroy();
        window.windowSync = undefined;
    }
    if (window.changeBridge) {
        window.changeBridge.destroy();
        window.changeBridge = undefined;
    }
}

window.addEventListener('fontModelReady', (event: Event) => {
    const detail = (event as CustomEvent).detail as {
        path: string;
        babelfontData: Record<string, unknown>;
    };

    destroyExisting();

    const bridge = new ChangeBridge();
    window.changeBridge = bridge;

    // Called after _syncJsonFromYDoc in undo/redo/remote.
    // Rebuilds the Font model and re-serializes babelfontJson so
    // the compilation pipeline sees the Y.Doc-driven changes.
    bridge.onAfterSync(() => {
        const fm = window.fontManager;
        if (!fm?.currentFont) return;

        // Reset compilation state so next compile is a clean full build
        fm.lastChangeSource = null;
        fm.lastEditType = null;
        fm.pendingBabelfontJsonSyncAfterDrag = false;

        // Rebuild Font model from the patched babelfontData
        fm.currentFont.fontModel = Font.fromData(fm.currentFont.babelfontData);
        window.currentFontModel = fm.currentFont.fontModel;

        // Re-serialize babelfontJson so the worker gets correct data
        fm.currentFont.syncJsonFromModel();
    });

    // Wire dirty marking: when ChangeBridge records a change, also mark
    // the font as needing recompilation via fontManager.
    bridge.onDirty(() => {
        if (window.fontManager?.currentFont) {
            window.fontManager.currentFont.markDirty();
        }
        if (window.autoCompileManager) {
            window.autoCompileManager.checkAndSchedule();
        }
    });

    // Callback for remote changes — trigger a canvas/overview refresh.
    // By the time this fires, onAfterSync has already re-synced
    // babelfontJson and rebuilt the model, so auto-compile will
    // produce correct output once the dirty flag triggers it.
    bridge.onRemoteChange(() => {
        const gc = window.glyphCanvas;
        if (gc) {
            // Re-fetch outline data so the editor shows updated geometry
            gc.outlineEditor?.fetchLayerData();
            gc.render();
        }
    });

    // Derive BroadcastChannel name from font path (or a fallback)
    const channelName = `counterpunch-font:${detail.path || 'unsaved'}`;

    // Always populate the Y.Doc from the loaded font data so the
    // bridge is never empty (even if a peer later sends its state).
    bridge.initFromJson(
        detail.babelfontData as Record<string, ReturnType<typeof JSON.parse>>
    );

    const sync = new WindowSync(bridge, channelName);
    window.windowSync = sync;

    if (isSyncWindow()) {
        // Secondary window: also request the full Y.Doc state from the
        // primary so undo history and pending edits are merged.
        sync.requestFullState();
        console.log('Sync window — initialised locally + requested peer state');

        // Strip ?sync from the URL so a reload won't re-enter sync mode
        const url = new URL(window.location.href);
        url.searchParams.delete('sync');
        window.history.replaceState(null, '', url.toString());
    } else {
        console.log('Primary window — ChangeBridge initialised');
    }
});

// Announce when this window is about to close
window.addEventListener('beforeunload', () => {
    window.windowSync?.announceClose();
});
