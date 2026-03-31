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
import { deriveGlyphNamesFromPaths, type HistoryStackItem } from './change-log';
import {
    syncModelSidebearingEditToCanvas,
    inferSidebearingSideFromHistoryItem
} from './sidebearing-utils';

const console = new Logger('ChangeBridgeInit');
let bridgeSyncQueue: Promise<void> = Promise.resolve();

function enqueueBridgeSync(task: () => Promise<void>): Promise<void> {
    bridgeSyncQueue = bridgeSyncQueue.then(task, task);
    return bridgeSyncQueue;
}

function getLayerWidth(
    glyphName?: string | null,
    layerId?: string | null
): number | null {
    if (!glyphName || !layerId) {
        return null;
    }

    const layer = window.fontManager?.currentFont?.fontModel
        ?.findGlyph(glyphName)
        ?.findLayerById(layerId);
    if (!layer) {
        return null;
    }

    return Number.isFinite(layer.width) ? layer.width : null;
}

function refreshLiveTextRunAdvances(
    glyphNames: Iterable<string>,
    layerId?: string,
    options?: { compensatePanX?: boolean }
): void {
    const gc = window.glyphCanvas;
    const textRunEditor = gc?.textRunEditor;
    const fontModel = window.fontManager?.currentFont?.fontModel;
    if (!textRunEditor || !fontModel || !layerId) {
        return;
    }

    const glyphAdvances: Record<string, number> = {};

    for (const glyphName of glyphNames) {
        if (!glyphName || glyphName in glyphAdvances) {
            continue;
        }

        const glyph = fontModel.findGlyph(glyphName);
        const layer = glyph?.findLayerById(layerId);
        if (!layer) {
            continue;
        }

        glyphAdvances[glyphName] = layer.width;
    }

    if (Object.keys(glyphAdvances).length === 0) {
        return;
    }

    // Snapshot the preceding-advance delta BEFORE refreshing so we can
    // compensate panX for cascade-width changes in glyphs that precede
    // the active glyph in the buffer (e.g. 'a'/'n' reverted on undo of 'l').
    let precedingDelta = 0;
    if (options?.compensatePanX) {
        precedingDelta =
            textRunEditor.computePrecedingAdvanceDelta?.(glyphAdvances) ?? 0;
    }

    textRunEditor.refreshGlyphAdvancesLive(glyphAdvances, { render: false });

    if (options?.compensatePanX && Math.abs(precedingDelta) > 0.01) {
        const vm = gc?.viewportManager;
        if (vm) {
            vm.panX -= precedingDelta * vm.scale;
        }
    }
}

function getActiveEditedGlyphName(): string | null {
    const gc = window.glyphCanvas;
    const stackGlyphName = gc?.outlineEditor?.active
        ? gc.outlineEditor.parseGlyphStack()?.slice(-1)[0]?.glyphName
        : null;
    const currentGlyphName = gc?.getCurrentGlyphName?.();

    if (stackGlyphName) {
        return stackGlyphName;
    }

    if (currentGlyphName && currentGlyphName !== 'undefined') {
        return currentGlyphName;
    }

    return stackGlyphName ?? null;
}

/**
 * Update the Rust FONT_CACHE with the current babelfontJson and
 * refresh the outline editor canvas. Call after undo/redo/remote
 * changes so the Rust interpolation reads up-to-date layer data.
 */
export async function syncRustCacheAndRefreshCanvas(
    rootGlyphName?: string,
    editedGlyphName?: string,
    forceFullRustSync: boolean = false,
    options?: { skipDeferredCanvasRepaint?: boolean }
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
                // Ensure babelfontJson is current before sending to Rust.
                // It may be stale when _onAfterSync deferred the rebuild
                // (undo/redo/remote sync marks pendingBabelfontJsonSyncAfterDrag
                // instead of calling syncJsonFromModel() synchronously).
                const fm = window.fontManager;
                if (fm?.pendingBabelfontJsonSyncAfterDrag) {
                    fm.currentFont?.syncJsonFromModel();
                    fm.pendingBabelfontJsonSyncAfterDrag = false;
                }
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
        // If a drag is in progress, loading layer data from the model would
        // reset layerData to the pre-drag (Y.Doc) state, corrupting the drag
        // baseline and producing wrong undo history. Defer the refresh until
        // the drag ends (onMouseUp checks pendingRemoteRefreshAfterDrag).
        console.log(
            `[DRAG-DEBUG] syncRustCacheAndRefreshCanvas: gc exists, oe?.draggingSomething=${oe?.draggingSomething}`
        );
        if (oe?.draggingSomething) {
            console.warn(
                '[DRAG-DEBUG] DRAG IN PROGRESS — deferring fetchLayerData, setting pendingRemoteRefreshAfterDrag'
            );
            if (oe) {
                oe.pendingRemoteRefreshAfterDrag = true;
            }
            return;
        }

        if (gc.outlineEditor?.runDeterministicRefresh) {
            await gc.outlineEditor.runDeterministicRefresh(async () => {
                await gc.outlineEditor?.fetchLayerData(
                    true,
                    refreshRootGlyphName
                );

                refreshLiveTextRunAdvances(
                    new Set(
                        [
                            refreshRootGlyphName,
                            editedGlyphName,
                            getActiveEditedGlyphName()
                        ].filter(
                            (glyphName): glyphName is string => !!glyphName
                        )
                    ),
                    selectedLayerId
                );
            });
        } else {
            await gc.outlineEditor?.fetchLayerData(true, refreshRootGlyphName);

            refreshLiveTextRunAdvances(
                new Set(
                    [
                        refreshRootGlyphName,
                        editedGlyphName,
                        getActiveEditedGlyphName()
                    ].filter((glyphName): glyphName is string => !!glyphName)
                ),
                selectedLayerId
            );
        }
        if (!options?.skipDeferredCanvasRepaint) {
            gc.requestRepaintAfterCompile();
        }
    }
}

function applyImmediateUndoSidebearingSync(
    glyphName: string | null,
    layerId: string | null,
    historyItem: HistoryStackItem | null,
    previousWidth: number | null
): boolean {
    const gc = window.glyphCanvas;
    const fontModel = window.fontManager?.currentFont?.fontModel;
    const side = inferSidebearingSideFromHistoryItem(historyItem);
    const editedGlyphName = getActiveEditedGlyphName() ?? glyphName;
    if (
        !gc ||
        !fontModel ||
        !glyphName ||
        !layerId ||
        !side ||
        !editedGlyphName
    ) {
        return false;
    }

    const layer = fontModel.findGlyph(editedGlyphName)?.findLayerById(layerId);
    if (!layer || previousWidth === null) {
        return false;
    }

    syncModelSidebearingEditToCanvas(gc, {
        layer,
        glyphName: editedGlyphName,
        side,
        previousWidth,
        render: false
    });
    gc.updatePropertyPanel?.();
    gc.outlineEditor.performHitDetection?.(null);
    gc.render?.();

    return true;
}

function isDirectSidebearingUndoRedo(
    historyItem: HistoryStackItem | null
): boolean {
    return (
        historyItem?.transactionLabel === 'Set LSB' ||
        historyItem?.transactionLabel === 'Set RSB'
    );
}

function syncImmediateUndoOutlineLayerFromModel(
    glyphName: string | null,
    layerId: string | null
): void {
    const gc = window.glyphCanvas;
    const fontModel = window.fontManager?.currentFont?.fontModel;
    const editedGlyphName = getActiveEditedGlyphName() ?? glyphName;
    if (!gc || !fontModel || !editedGlyphName || !layerId) {
        return;
    }

    const layer = fontModel.findGlyph(editedGlyphName)?.findLayerById(layerId);
    if (!layer) {
        return;
    }

    gc.syncCurrentOutlineLayerDataFromModel?.(layer);
    gc.updatePropertyPanel?.();
    gc.outlineEditor.performHitDetection?.(null);
    gc.render?.();
}

function shouldForceFullRustSyncAfterUndoRedo(
    scope: 'font' | 'glyph' | 'layer',
    historyItem: HistoryStackItem | null
): boolean {
    if (scope !== 'layer') {
        return true;
    }

    return (
        historyItem?.transactionLabel === 'Drag point' &&
        inferSidebearingSideFromHistoryItem(historyItem) !== null
    );
}

function recomputeMetricsKeysAfterUndoRedo(
    bridge: ChangeBridge,
    historyItem: HistoryStackItem | null,
    glyphNames: Array<string | null | undefined>
): Set<string> {
    const fontModel = window.fontManager?.currentFont?.fontModel;
    if (!fontModel || typeof fontModel.recomputeMetricsKeys !== 'function') {
        return new Set();
    }

    const seedGlyphNames = new Set<string>();
    const addGlyphName = (glyphName?: string | null) => {
        if (glyphName && glyphName !== 'undefined') {
            seedGlyphNames.add(glyphName);
        }
    };

    for (const glyphName of glyphNames) {
        addGlyphName(glyphName);
    }
    for (const glyphName of deriveGlyphNamesFromPaths(
        historyItem?.touchedPaths ?? []
    )) {
        addGlyphName(glyphName);
    }

    if (seedGlyphNames.size === 0) {
        return new Set();
    }

    const recompute = () => fontModel.recomputeMetricsKeys(seedGlyphNames);
    if (typeof bridge.runWithoutRecording === 'function') {
        return bridge.runWithoutRecording(recompute);
    }

    return recompute();
}

function collectUndoRedoOverviewGlyphNames(
    historyItem: HistoryStackItem | null,
    glyphNames: Array<string | null | undefined>
): string[] {
    const refreshGlyphNames = new Set<string>();
    const addGlyphName = (glyphName?: string | null) => {
        if (glyphName && glyphName !== 'undefined') {
            refreshGlyphNames.add(glyphName);
        }
    };

    for (const glyphName of glyphNames) {
        addGlyphName(glyphName);
    }

    for (const glyphName of deriveGlyphNamesFromPaths(
        historyItem?.touchedPaths ?? []
    )) {
        addGlyphName(glyphName);
    }

    const fontModel =
        window.fontManager?.currentFont?.fontModel ?? window.currentFontModel;
    if (fontModel?.findGlyphsUsingComponent) {
        for (const glyphName of [...refreshGlyphNames]) {
            for (const dependentGlyphName of fontModel.findGlyphsUsingComponent(
                glyphName
            )) {
                addGlyphName(dependentGlyphName);
            }
        }
    }

    return [...refreshGlyphNames];
}

async function refreshGlyphOverviewAfterUndoRedo(
    historyItem: HistoryStackItem | null,
    layerId: string | null,
    glyphNames: Array<string | null | undefined>
): Promise<void> {
    const refreshGlyphNames = collectUndoRedoOverviewGlyphNames(
        historyItem,
        glyphNames
    );

    if (refreshGlyphNames.length) {
        for (const glyphName of refreshGlyphNames) {
            window.dispatchEvent(
                new CustomEvent('glyphChanged', {
                    detail: {
                        glyphName,
                        layerId: layerId ?? undefined
                    }
                })
            );
        }
        return;
    }

    const glyphOverview = window.glyphOverviewInstance;
    if (typeof glyphOverview?.renderGlyphOutlines === 'function') {
        await glyphOverview.renderGlyphOutlines(
            glyphOverview.currentLocation ?? {}
        );
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
    refreshRootGlyphName?: string,
    layerId?: string | null,
    historyTargetKey?: string | null
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
        const editedGlyphName = getActiveEditedGlyphName() ?? targetGlyph;
        const previousWidth = getLayerWidth(editedGlyphName, layerId ?? null);

        const appliedChange =
            action === 'redo'
                ? bridge.redo(targetGlyph, layerId, historyTargetKey)
                : bridge.undo(targetGlyph, layerId, historyTargetKey);

        if (!appliedChange) {
            return;
        }

        const appliedImmediateSidebearingSync =
            applyImmediateUndoSidebearingSync(
                appliedChange.glyphName,
                appliedChange.layerId,
                appliedChange.historyItem as HistoryStackItem | null,
                previousWidth
            );

        const recomputedGlyphNames = recomputeMetricsKeysAfterUndoRedo(
            bridge,
            appliedChange.historyItem as HistoryStackItem | null,
            [appliedChange.glyphName, glyphName, editedGlyphName]
        );
        const isDirectSidebearingHistory = isDirectSidebearingUndoRedo(
            appliedChange.historyItem as HistoryStackItem | null
        );

        if (!(appliedImmediateSidebearingSync && isDirectSidebearingHistory)) {
            syncImmediateUndoOutlineLayerFromModel(
                appliedChange.glyphName,
                appliedChange.layerId ?? layerId ?? null
            );
        }

        refreshLiveTextRunAdvances(
            new Set(
                [
                    ...recomputedGlyphNames,
                    appliedChange.glyphName,
                    glyphName,
                    editedGlyphName,
                    getActiveEditedGlyphName()
                ].filter((name): name is string => !!name)
            ),
            appliedChange.layerId ?? layerId ?? undefined,
            { compensatePanX: true }
        );

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

        // For layer-scoped undo/redo, the incremental storeLayerData path
        // is sufficient (reads directly from the model, no babelfontJson needed).
        // For glyph/font scope, force a full Rust font cache refresh.
        const forceFullRustSync = shouldForceFullRustSyncAfterUndoRedo(
            appliedChange.scope,
            appliedChange.historyItem as HistoryStackItem | null
        );
        await syncRustCacheAndRefreshCanvas(
            refreshRootGlyphName,
            glyphName,
            forceFullRustSync,
            {
                skipDeferredCanvasRepaint:
                    appliedImmediateSidebearingSync &&
                    isDirectSidebearingHistory
            }
        );

        await refreshGlyphOverviewAfterUndoRedo(
            appliedChange.historyItem,
            appliedChange.layerId ?? layerId ?? null,
            [
                appliedChange.glyphName,
                glyphName,
                editedGlyphName,
                refreshRootGlyphName,
                getActiveEditedGlyphName()
            ]
        );
    });
}

// Expose globally for non-module code (keyboard-navigation.ts IIFE)
window.syncRustCacheAndRefreshCanvas =
    syncRustCacheAndRefreshCanvas as Window['syncRustCacheAndRefreshCanvas'];
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
    // Rebuilds the Font model from the already-patched babelfontData.
    // babelfontJson is marked stale and rebuilt lazily:
    //   • For layer-scoped undo/redo, syncRustCacheAndRefreshCanvas uses the
    //     incremental storeLayerData path which reads directly from the model
    //     (no babelfontJson needed).
    //   • If the fallback full-sync path is needed, syncRustCacheAndRefreshCanvas
    //     rebuilds babelfontJson just before sending it to the Rust worker.
    //   • For the next full compile, compileEditingFont rebuilds babelfontJson
    //     via syncBabelfontJsonFromCurrentModel() before invoking fontc.
    bridge.onAfterSync(() => {
        const fm = window.fontManager;
        if (!fm?.currentFont) return;

        // Reset compilation state so next compile is a clean full build
        const oe2 = window.glyphCanvas?.outlineEditor;
        console.log(
            `[DRAG-DEBUG] onAfterSync called — draggingSomething=${oe2?.draggingSomething}`
        );
        fm.lastChangeSource = null;
        fm.lastEditType = null;
        // Mark babelfontJson as stale; it will be rebuilt lazily (see comment above).
        fm.pendingBabelfontJsonSyncAfterDrag = true;

        // Rebuild Font model from the patched babelfontData
        fm.currentFont.fontModel = Font.fromData(fm.currentFont.babelfontData);
        window.currentFontModel = fm.currentFont.fontModel;

        // Invalidate the storeFontJson cache so syncRustCacheAndRefreshCanvas
        // always sends the updated JSON to Rust after undo/redo/remote-change.
        // Incremental compiles (update_cached_layer) can modify the Rust
        // FONT_CACHE without updating lastStoredFontJson, so the identical-JSON
        // check would otherwise skip the send and leave Rust with stale data.
        fontCompilation.lastStoredFontJson = null;

        window.dispatchEvent(new CustomEvent('fontModelSync'));
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
        const oeRef = window.glyphCanvas?.outlineEditor;
        console.log(
            `[DRAG-DEBUG] onRemoteChange fired — draggingSomething=${oeRef?.draggingSomething}, pendingRemoteRefreshAfterDrag=${oeRef?.pendingRemoteRefreshAfterDrag}`
        );
        void queueRustCacheAndRefreshCanvas().then(() => {
            const fontManager = window.fontManager;
            if (!fontManager?.currentFont) {
                return;
            }

            fontManager.lastChangeSource = 'remote-change';
            fontManager.lastEditType = null;
            fontManager.currentFont.requestRecompileWithoutDataChange();
            window.autoCompileManager?.checkAndSchedule?.();
        });
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
