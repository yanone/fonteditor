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
import { fontCompilation } from './font-compilation';
import { Logger } from './logger';

const console = new Logger('ChangeBridgeInit');
let bridgeSyncQueue: Promise<void> = Promise.resolve();

function enqueueBridgeSync(task: () => Promise<void>): Promise<void> {
    bridgeSyncQueue = bridgeSyncQueue.then(task, task);
    return bridgeSyncQueue;
}

/**
 * Update the Rust FONT_CACHE with the current babelfontJson and
 * refresh the outline editor canvas. Call after undo/redo/remote
 * changes so the Rust interpolation reads up-to-date layer data.
 */
export async function syncRustCacheAndRefreshCanvas(
    rootGlyphName?: string,
    editedGlyphName?: string,
    forceFullRustSync: boolean = false
): Promise<void> {
    const gc = window.glyphCanvas;
    const oe = gc?.outlineEditor;
    const parsedStack = oe?.parseGlyphStack?.() || [];
    const refreshRootGlyphName =
        rootGlyphName ?? parsedStack[0]?.glyphName ?? undefined;
    const selectedLayerId = oe?.selectedLayerId ?? undefined;

    const currentFont = window.fontManager?.currentFont;
    if (currentFont?.babelfontJson && fontCompilation?.isInitialized) {
        try {
            let didStoreLayer = false;
            if (!forceFullRustSync && selectedLayerId) {
                const cacheTargets = new Set<string>();
                if (refreshRootGlyphName) {
                    cacheTargets.add(refreshRootGlyphName);
                }
                if (editedGlyphName) {
                    cacheTargets.add(editedGlyphName);
                }

                if (cacheTargets.size > 0) {
                    didStoreLayer = true;
                    for (const glyphName of cacheTargets) {
                        const stored =
                            (await window.fontManager?.submitLayerToWorkerCache?.(
                                glyphName,
                                selectedLayerId
                            )) === true;
                        if (!stored) {
                            didStoreLayer = false;
                            break;
                        }
                    }
                }
            }

            if (!didStoreLayer) {
                // Force this explicit sync to reach Rust even when the JSON text
                // matches a previously stored payload. This path is used after
                // undo/redo/remote Yjs updates where Rust may still hold an
                // incrementally-mutated cache that no longer matches current JSON.
                fontCompilation.lastStoredFontJson = null;
                await fontCompilation.sendMessage({
                    type: 'storeFontJson',
                    babelfontJson: currentFont.babelfontJson,
                    forceStore: true
                });
            }
        } catch {
            // Non-fatal — the scheduled compile will update the cache later
        }
    }

    if (gc) {
        if (gc.outlineEditor?.runDeterministicRefresh) {
            await gc.outlineEditor.runDeterministicRefresh(async () => {
                await gc.outlineEditor?.fetchLayerData(
                    true,
                    refreshRootGlyphName
                );
            });
        } else {
            await gc.outlineEditor?.fetchLayerData(true, refreshRootGlyphName);
        }
        gc.requestRepaintAfterCompile();
    }
}

export function queueRustCacheAndRefreshCanvas(): Promise<void> {
    return enqueueBridgeSync(async () => {
        await syncRustCacheAndRefreshCanvas();
    });
}

export function runBridgeUndoRedo(
    action: 'undo' | 'redo',
    glyphName?: string,
    refreshRootGlyphName?: string
): Promise<void> {
    return enqueueBridgeSync(async () => {
        const bridge = window.changeBridge;
        if (!bridge) {
            return;
        }
        await window.fontManager?.awaitWorkerCacheUpdate?.();
        // Always undo/redo the glyph currently being edited.
        // This is the last glyph in glyph stack, passed as glyphName.
        const targetGlyph = glyphName;

        const didApply =
            action === 'redo'
                ? bridge.redo(targetGlyph)
                : bridge.undo(targetGlyph);

        if (!didApply) {
            return;
        }

        // Ensure undo/redo always triggers a full editing-font recompile path.
        // This keeps HarfBuzz-rendered text in sync even if dirty scheduling
        // from upstream callbacks is delayed or coalesced.
        const fm = window.fontManager;
        if (fm?.currentFont) {
            fm.lastChangeSource = 'undo-redo';
            fm.lastEditType = null;
            fm.currentFont.requestRecompileWithoutDataChange();
            window.autoCompileManager?.checkAndSchedule?.();
        }

        await syncRustCacheAndRefreshCanvas(
            refreshRootGlyphName,
            glyphName,
            true
        );
    });
}

// Expose globally for non-module code (keyboard-navigation.ts IIFE)
window.syncRustCacheAndRefreshCanvas = syncRustCacheAndRefreshCanvas;
window.runBridgeUndoRedo = runBridgeUndoRedo;

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

function initializeBridge(detail: {
    path: string;
    babelfontData: Record<string, unknown>;
}): void {
    if (!detail?.babelfontData) {
        return;
    }

    destroyExisting();

    const bridge = new ChangeBridge(window.windowRole?.instanceId);
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

        // Invalidate the storeFontJson cache so syncRustCacheAndRefreshCanvas
        // always sends the updated JSON to Rust after undo/redo/remote-change.
        // Incremental compiles (update_cached_layer) can modify the Rust
        // FONT_CACHE without updating lastStoredFontJson, so the identical-JSON
        // check would otherwise skip the send and leave Rust with stale data.
        fontCompilation.lastStoredFontJson = null;
    });

    // Wire dirty marking: when ChangeBridge records a change, also mark
    // the font as needing recompilation via fontManager.
    bridge.onDirty(() => {
        const fontManager = window.fontManager;
        if (fontManager?.currentFont) {
            fontManager.currentFont.markDirty();
            void fontManager.updateDirtyIndicator();
            window.saveButton?.updateButtonState?.();
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
        queueRustCacheAndRefreshCanvas();
    });

    // Derive BroadcastChannel name from font path (or a fallback)
    const channelName = `counterpunch-font:${detail.path || 'unsaved'}`;

    if (isSyncWindow()) {
        // Sync (secondary) window: keep Y.Doc empty — the peer's
        // full-state response will populate it.  Only store the
        // babelfontData reference so _syncJsonFromYDoc can patch it.
        bridge.setFontJson(
            detail.babelfontData as Record<
                string,
                ReturnType<typeof JSON.parse>
            >
        );
    } else {
        // Primary window: populate Y.Doc from loaded font data.
        bridge.initFromJson(
            detail.babelfontData as Record<
                string,
                ReturnType<typeof JSON.parse>
            >
        );
    }

    const sync = new WindowSync(bridge, channelName);
    window.windowSync = sync;
    sync.onMainWindowClosing(() => {
        if (window.windowRole?.isLinkedWindow()) {
            window.close();
        }
    });

    if (isSyncWindow()) {
        // Linked window: also request the full Y.Doc state from the
        // main window so undo history and pending edits are merged.
        sync.requestFullState();
        console.log('Sync window — initialised locally + requested peer state');

        // Strip ?sync from the URL so a reload won't re-enter sync mode
        const url = new URL(window.location.href);
        url.searchParams.delete('sync');
        window.history.replaceState(null, '', url.toString());
    } else {
        console.log('Main window — ChangeBridge initialised');
    }
}

window.addEventListener('fontModelReady', (event: Event) => {
    const detail = (event as CustomEvent).detail as {
        path: string;
        babelfontData: Record<string, unknown>;
    };

    initializeBridge(detail);
});

// Fallback bootstrap: if a font is already loaded before this module
// subscribed to fontModelReady, initialize the bridge from currentFont.
queueMicrotask(() => {
    if (window.changeBridge && window.windowSync) {
        return;
    }
    const currentFont = window.fontManager?.currentFont;
    if (!currentFont?.babelfontData) {
        return;
    }
    initializeBridge({
        path: currentFont.path || 'unsaved',
        babelfontData: currentFont.babelfontData as Record<string, unknown>
    });
    console.log('Recovered ChangeBridge from currentFont fallback');
});

let didAnnounceWindowClose = false;

function announceWindowClose(): void {
    if (didAnnounceWindowClose) {
        return;
    }
    didAnnounceWindowClose = true;

    if (window.windowRole?.isMainWindow()) {
        window.windowSync?.announceMainWindowClosing();
    }
    window.windowSync?.announceClose();
}

window.addEventListener('pagehide', announceWindowClose);
window.addEventListener('unload', announceWindowClose);
