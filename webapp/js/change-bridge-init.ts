/**
 * change-bridge-init.ts — Initialize PatchSyncEngine and WindowSync when a font loads.
 *
 * Listens for the 'fontModelReady' CustomEvent and wires up:
 *  1. A PatchSyncEngine backed by the font's babelfontData JSON
 *  2. A WindowSync for cross-window collaboration
 *  3. Undo/redo dirty marking + babelfontJson resync callbacks
 *
 * If the URL contains `sync=true`, the bridge skips `initFromJson()` and
 * instead requests a full-state transfer from an existing peer window.
 */

import { PatchSyncEngine } from './patch-sync-engine';
import { fromYType } from './change-bridge-ydoc';
import { Font } from './babelfont-model';
import { WindowSync } from './window-sync';
import { fontCompilation } from './font-compilation';
import { Logger } from './logger';
import {
    deriveGlyphNamesFromPaths,
    deriveGlyphName,
    deriveLayerId,
    normalizeWorkerReplayTargets,
    type ChangeLogEntry,
    type HistoryStackItem,
    type WorkerReplayTarget
} from './change-log';
import {
    syncModelSidebearingEditToCanvas,
    inferSidebearingSideFromHistoryItem
} from './sidebearing-utils';
import type { TransactionBufferedOperation } from './patch-sync-engine';

const console = new Logger('ChangeBridgeInit');
let bridgeSyncQueue: Promise<void> = Promise.resolve();
let remoteChangeRefreshQueue: Promise<void> = Promise.resolve();

type Unsafe = ReturnType<typeof JSON.parse>;

function enqueueBridgeSync(task: () => Promise<void>): Promise<void> {
    bridgeSyncQueue = bridgeSyncQueue.then(task, task);
    return bridgeSyncQueue;
}

function enqueueRemoteChangeRefresh(task: () => Promise<void>): Promise<void> {
    remoteChangeRefreshQueue = remoteChangeRefreshQueue.then(task, task);
    return remoteChangeRefreshQueue;
}

function cloneBridgeValue<T>(value: T): T {
    if (value === undefined) {
        return value;
    }

    return JSON.parse(JSON.stringify(value)) as T;
}

function isAnchorPath(path: (string | number)[]): boolean {
    return (
        path.length >= 5 &&
        path[0] === 'glyphs' &&
        path[2] === 'layers' &&
        path[4] === 'anchors'
    );
}

function isWidthPath(path: (string | number)[]): boolean {
    return (
        path.length === 5 &&
        path[0] === 'glyphs' &&
        path[2] === 'layers' &&
        path[4] === 'width'
    );
}

function layerSnapshotTouchesCascade(snapshot: unknown): boolean {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        return false;
    }

    const layerSnapshot = snapshot as Record<string, unknown>;
    return 'width' in layerSnapshot || 'anchors' in layerSnapshot;
}

function collectGlyphSnapshotCascadeTargets(
    operation: TransactionBufferedOperation
): WorkerReplayTarget[] {
    const glyphName = deriveGlyphName(operation.applyPath ?? operation.path);
    if (!glyphName) {
        return [];
    }

    const beforeLayers = Array.isArray(
        (operation.applyOldValue as Unsafe)?.layers
    )
        ? ((operation.applyOldValue as Unsafe)?.layers as Unsafe[]) || []
        : [];
    const afterLayers = Array.isArray(
        (operation.applyNewValue as Unsafe)?.layers
    )
        ? ((operation.applyNewValue as Unsafe)?.layers as Unsafe[]) || []
        : [];
    const beforeLayerMap = new Map(
        beforeLayers
            .filter((layer) => typeof layer?.id === 'string')
            .map((layer) => [String(layer.id), layer] as const)
    );
    const afterLayerMap = new Map(
        afterLayers
            .filter((layer) => typeof layer?.id === 'string')
            .map((layer) => [String(layer.id), layer] as const)
    );
    const layerIds = new Set<string>([
        ...beforeLayerMap.keys(),
        ...afterLayerMap.keys()
    ]);

    const targets: WorkerReplayTarget[] = [];
    for (const layerId of layerIds) {
        const beforeLayer = beforeLayerMap.get(layerId);
        const afterLayer = afterLayerMap.get(layerId);
        if (
            layerSnapshotTouchesCascade(beforeLayer) ||
            layerSnapshotTouchesCascade(afterLayer)
        ) {
            targets.push({ glyphName, layerId });
        }
    }

    return targets;
}

function collectCascadeTriggerSourceTargets(
    operations: TransactionBufferedOperation[]
): WorkerReplayTarget[] {
    const targets: WorkerReplayTarget[] = [];

    for (const operation of operations) {
        const applyPath = operation.applyPath ?? operation.path;
        if (isWidthPath(applyPath) || isAnchorPath(applyPath)) {
            const glyphName = deriveGlyphName(applyPath);
            const layerId = deriveLayerId(applyPath);
            if (glyphName && layerId) {
                targets.push({ glyphName, layerId });
            }
            continue;
        }

        if (
            operation.applyMode === 'layer-snapshot' &&
            applyPath.length === 4 &&
            applyPath[0] === 'glyphs' &&
            applyPath[2] === 'layers' &&
            (layerSnapshotTouchesCascade(operation.applyOldValue) ||
                layerSnapshotTouchesCascade(operation.applyNewValue))
        ) {
            targets.push({
                glyphName: String(applyPath[1]),
                layerId: String(applyPath[3])
            });
            continue;
        }

        if (
            operation.applyMode === 'glyph-snapshot' &&
            applyPath.length === 2 &&
            applyPath[0] === 'glyphs'
        ) {
            targets.push(...collectGlyphSnapshotCascadeTargets(operation));
        }
    }

    return normalizeWorkerReplayTargets(targets);
}

function collectLayerTargetsForAffectedGlyphNames(
    affectedGlyphNames: Iterable<string>,
    sourceTargets: WorkerReplayTarget[]
): WorkerReplayTarget[] {
    const fontModel =
        window.fontManager?.currentFont?.fontModel ?? window.currentFontModel;
    if (!fontModel) {
        return [];
    }

    const targets: WorkerReplayTarget[] = [];
    for (const sourceTarget of sourceTargets) {
        const sourceLayer = fontModel
            .findGlyph(sourceTarget.glyphName)
            ?.findLayerById(sourceTarget.layerId);
        if (!sourceLayer) {
            continue;
        }

        for (const glyphName of affectedGlyphNames) {
            if (!glyphName) {
                continue;
            }

            const glyph = fontModel.findGlyph(glyphName);
            const matchedLayer =
                glyph?.findLayerById(sourceTarget.layerId) ??
                sourceLayer.getMatchingLayerOnGlyph?.(glyphName);
            if (matchedLayer?.id) {
                targets.push({ glyphName, layerId: matchedLayer.id });
            }
        }
    }

    return normalizeWorkerReplayTargets(targets);
}

function recomputeCascadeAffectedGlyphNames(
    bridge: PatchSyncEngine,
    sourceTargets: WorkerReplayTarget[]
): Set<string> {
    const fontModel =
        window.fontManager?.currentFont?.fontModel ?? window.currentFontModel;
    if (!fontModel) {
        return new Set();
    }

    const seedGlyphNames = new Set(
        sourceTargets
            .map((target) => target.glyphName)
            .filter((glyphName): glyphName is string => !!glyphName)
    );
    if (seedGlyphNames.size === 0) {
        return new Set();
    }

    const preferredSourceTarget = sourceTargets[0] ?? null;
    const recompute = () => {
        const affectedGlyphNames = new Set<string>();
        if (
            typeof fontModel.rebuildAutomaticCompositesForGlyphs === 'function'
        ) {
            for (const glyphName of fontModel.rebuildAutomaticCompositesForGlyphs(
                seedGlyphNames,
                preferredSourceTarget
                    ? {
                          preferredLayerId: preferredSourceTarget.layerId,
                          preferredSourceGlyphName:
                              preferredSourceTarget.glyphName
                      }
                    : undefined
            )) {
                affectedGlyphNames.add(glyphName);
            }
        }

        if (typeof fontModel.recomputeMetricsKeys === 'function') {
            for (const glyphName of fontModel.recomputeMetricsKeys(
                seedGlyphNames
            )) {
                affectedGlyphNames.add(glyphName);
            }
        }

        return affectedGlyphNames;
    };

    if (typeof bridge.runWithoutRecording === 'function') {
        return bridge.runWithoutRecording(recompute);
    }

    return recompute();
}

function applyDirectLayerOperationToSnapshot(
    snapshot: Record<string, unknown>,
    operation: TransactionBufferedOperation,
    glyphName: string,
    layerId: string
): Record<string, unknown> {
    const applyPath = operation.applyPath ?? operation.path;
    if (
        deriveGlyphName(applyPath) !== glyphName ||
        deriveLayerId(applyPath) !== layerId
    ) {
        return snapshot;
    }

    if (
        operation.applyMode === 'layer-snapshot' &&
        operation.applyNewValue &&
        typeof operation.applyNewValue === 'object' &&
        !Array.isArray(operation.applyNewValue)
    ) {
        const nextSnapshot = { ...snapshot };
        for (const [key, value] of Object.entries(
            operation.applyNewValue as Record<string, unknown>
        )) {
            if (value === null) {
                delete nextSnapshot[key];
                continue;
            }
            nextSnapshot[key] = cloneBridgeValue(value);
        }
        return nextSnapshot;
    }

    if (
        operation.applyMode === 'glyph-snapshot' &&
        operation.applyNewValue &&
        typeof operation.applyNewValue === 'object' &&
        !Array.isArray(operation.applyNewValue)
    ) {
        const glyphLayers = Array.isArray(
            (operation.applyNewValue as Unsafe).layers
        )
            ? ((operation.applyNewValue as Unsafe).layers as Unsafe[])
            : [];
        const nextLayerSnapshot = glyphLayers.find(
            (layer) => layer?.id === layerId
        );
        return nextLayerSnapshot && typeof nextLayerSnapshot === 'object'
            ? cloneBridgeValue(nextLayerSnapshot)
            : snapshot;
    }

    if (
        applyPath.length < 5 ||
        applyPath[0] !== 'glyphs' ||
        applyPath[2] !== 'layers'
    ) {
        return snapshot;
    }

    const propertyPath = applyPath.slice(4);
    const nextSnapshot = cloneBridgeValue(snapshot);

    const applyPathOperation = (
        rootValue: unknown,
        path: (string | number)[],
        op: 'set' | 'remove',
        value: unknown
    ): void => {
        if (!path.length || !rootValue || typeof rootValue !== 'object') {
            return;
        }

        let cursor = rootValue as Record<string, unknown> | unknown[];
        for (let index = 0; index < path.length - 1; index++) {
            const segment = path[index];
            const nextSegment = path[index + 1];

            if (Array.isArray(cursor)) {
                const numericIndex = Number(segment);
                if (!Number.isInteger(numericIndex) || numericIndex < 0) {
                    return;
                }
                if (
                    cursor[numericIndex] === undefined ||
                    cursor[numericIndex] === null ||
                    typeof cursor[numericIndex] !== 'object'
                ) {
                    cursor[numericIndex] =
                        typeof nextSegment === 'number' ? [] : {};
                }
                cursor = cursor[numericIndex] as
                    | Record<string, unknown>
                    | unknown[];
                continue;
            }

            const objectKey = String(segment);
            const currentValue = (cursor as Record<string, unknown>)[objectKey];
            if (
                currentValue === undefined ||
                currentValue === null ||
                typeof currentValue !== 'object'
            ) {
                (cursor as Record<string, unknown>)[objectKey] =
                    typeof nextSegment === 'number' ? [] : {};
            }
            cursor = (cursor as Record<string, unknown>)[objectKey] as
                | Record<string, unknown>
                | unknown[];
        }

        const terminalSegment = path[path.length - 1];
        if (Array.isArray(cursor)) {
            const numericIndex = Number(terminalSegment);
            if (!Number.isInteger(numericIndex) || numericIndex < 0) {
                return;
            }
            if (op === 'remove') {
                cursor.splice(numericIndex, 1);
                return;
            }
            cursor[numericIndex] = cloneBridgeValue(value);
            return;
        }

        const objectKey = String(terminalSegment);
        if (op === 'remove') {
            delete (cursor as Record<string, unknown>)[objectKey];
            return;
        }
        (cursor as Record<string, unknown>)[objectKey] =
            cloneBridgeValue(value);
    };

    applyPathOperation(
        nextSnapshot,
        propertyPath,
        operation.op === 'remove' ? 'remove' : 'set',
        operation.applyNewValue === undefined
            ? operation.newValue
            : operation.applyNewValue
    );

    return nextSnapshot;
}

function buildPostDirectLayerSnapshot(
    yLayerJson: Record<string, unknown>,
    operations: TransactionBufferedOperation[],
    glyphName: string,
    layerId: string
): Record<string, unknown> {
    return operations.reduce(
        (snapshot, operation) =>
            applyDirectLayerOperationToSnapshot(
                snapshot,
                operation,
                glyphName,
                layerId
            ),
        cloneBridgeValue(yLayerJson)
    );
}

function buildCascadeLayerOperations(
    bridge: PatchSyncEngine,
    layerTargets: WorkerReplayTarget[],
    directOperations: TransactionBufferedOperation[]
): TransactionBufferedOperation[] {
    const fontJson = bridge.getFontJsonSnapshot();
    const glyphs = Array.isArray((fontJson as Unsafe)?.glyphs)
        ? ((fontJson as Unsafe).glyphs as Unsafe[])
        : [];
    const glyphsMap = bridge.fontMap.get('glyphs') as
        | { get?: (key: string) => unknown }
        | undefined;
    if (!glyphsMap || !layerTargets.length) {
        return [];
    }

    const operations: TransactionBufferedOperation[] = [];
    for (const { glyphName, layerId } of layerTargets) {
        const glyphJson = glyphs.find((glyph) => glyph?.name === glyphName);
        const layerJson = Array.isArray(glyphJson?.layers)
            ? (glyphJson.layers as Unsafe[]).find(
                  (layer) => layer?.id === layerId
              )
            : null;
        if (!layerJson) {
            continue;
        }

        const glyphMap = glyphsMap.get?.(glyphName) as
            | { get?: (key: string) => unknown }
            | undefined;
        const yGlyphMap = glyphMap as
            | { get?: (key: string) => unknown }
            | undefined;
        const yLayersMap = yGlyphMap?.get?.('layers') as
            | { get?: (key: string) => unknown }
            | undefined;
        const yLayerMap = yLayersMap?.get?.(layerId);
        if (!yLayerMap) {
            continue;
        }

        const yLayerJson = fromYType(yLayerMap as never) as Record<
            string,
            unknown
        >;
        const baseLayerSnapshot = buildPostDirectLayerSnapshot(
            yLayerJson,
            directOperations,
            glyphName,
            layerId
        );
        const delta: Record<string, unknown> = { id: layerId };
        let hasChanges = false;

        for (const [key, value] of Object.entries(layerJson)) {
            if (
                JSON.stringify(value) ===
                JSON.stringify(baseLayerSnapshot?.[key])
            ) {
                continue;
            }

            delta[key] = cloneBridgeValue(value);
            hasChanges = true;
        }

        for (const key of Object.keys(baseLayerSnapshot || {})) {
            if (key === 'id' || key in (layerJson as Record<string, unknown>)) {
                continue;
            }

            delta[key] = null;
            hasChanges = true;
        }

        if (!hasChanges) {
            continue;
        }

        operations.push({
            op: 'set',
            path: ['glyphs', glyphName, 'layers', layerId],
            oldValue: cloneBridgeValue(baseLayerSnapshot),
            newValue: cloneBridgeValue(delta),
            applyPath: ['glyphs', glyphName, 'layers', layerId],
            applyNewValue: cloneBridgeValue(delta),
            applyMode: 'layer-snapshot',
            workerReplayTargets: [{ glyphName, layerId }]
        });
    }

    return operations;
}

export function buildCascadingRecompositionOperations(
    bridge: PatchSyncEngine,
    operations: TransactionBufferedOperation[]
): TransactionBufferedOperation[] {
    const sourceTargets = collectCascadeTriggerSourceTargets(operations);
    if (!sourceTargets.length) {
        return [];
    }

    const affectedGlyphNames = recomputeCascadeAffectedGlyphNames(
        bridge,
        sourceTargets
    );
    if (!affectedGlyphNames.size) {
        return [];
    }

    const cascadeTargets = collectLayerTargetsForAffectedGlyphNames(
        affectedGlyphNames,
        sourceTargets
    );
    if (!cascadeTargets.length) {
        return [];
    }

    return buildCascadeLayerOperations(bridge, cascadeTargets, operations);
}

/**
 * Infer the original edit type from remote change log entries,
 * so the linked window can use the matching compilation fast path
 * (anchor-only / outline-only) instead of always falling back to
 * a full compile.
 */
function inferRemoteEditTypeFromEntries(entries: ChangeLogEntry[]): {
    editType: 'anchor' | 'outline' | null;
    changeSource: string;
} {
    for (const entry of entries) {
        const label = entry.transactionLabel ?? '';
        const path = entry.path ?? '';
        if (
            label.toLowerCase().includes('anchor') ||
            /(^|\.)anchors(\.|$)/.test(path)
        ) {
            return { editType: 'anchor', changeSource: 'remote-anchor' };
        }
        if (
            entry.visualAnchorSide === 'left' ||
            entry.visualAnchorSide === 'right' ||
            label.toLowerCase().includes('sidebearing') ||
            label.toLowerCase().includes('lsb') ||
            label.toLowerCase().includes('rsb') ||
            /(^|\.)nodes(\.|$)/.test(path) ||
            /(^|\.)shapes(\.|$)/.test(path)
        ) {
            return { editType: 'outline', changeSource: 'remote-outline' };
        }
    }
    return { editType: null, changeSource: 'remote-change' };
}

/**
 * Collect all workerReplayTargets from remote change log entries,
 * so the linked window can do incremental layer updates to its
 * WASM worker cache instead of a full JSON resync.
 */
function collectReplayTargetsFromEntries(
    entries: ChangeLogEntry[]
): WorkerReplayTarget[] {
    const targets: WorkerReplayTarget[] = [];
    for (const entry of entries) {
        if (entry.workerReplayTargets?.length) {
            targets.push(...entry.workerReplayTargets);
        }
    }
    return normalizeWorkerReplayTargets(targets);
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
    options?: {
        compensatePanX?: boolean;
        workerReplayTargets?: WorkerReplayTarget[];
    }
): void {
    const gc = window.glyphCanvas;
    const textRunEditor = gc?.textRunEditor;
    const fontModel = window.fontManager?.currentFont?.fontModel;
    if (!textRunEditor || !fontModel || !layerId) {
        return;
    }

    const uniqueGlyphNames = Array.from(
        new Set(
            Array.from(glyphNames || []).filter(
                (glyphName): glyphName is string =>
                    typeof glyphName === 'string' && glyphName.length > 0
            )
        )
    );
    const replayTargetMap = new Map(
        normalizeWorkerReplayTargets(options?.workerReplayTargets).map(
            (target) => [target.glyphName, target.layerId] as const
        )
    );
    const sourceLayer =
        uniqueGlyphNames
            .map((glyphName) =>
                fontModel.findGlyph(glyphName)?.findLayerById(layerId)
            )
            .find((layer) => layer !== undefined) ||
        Array.from(replayTargetMap.entries())
            .map(([glyphName, replayLayerId]) =>
                fontModel.findGlyph(glyphName)?.findLayerById(replayLayerId)
            )
            .find((layer) => layer !== undefined);

    const glyphAdvances: Record<string, number> = {};

    for (const glyphName of uniqueGlyphNames) {
        if (glyphName in glyphAdvances) {
            continue;
        }

        const glyph = fontModel.findGlyph(glyphName);
        const replayLayerId = replayTargetMap.get(glyphName);
        const layer =
            (replayLayerId ? glyph?.findLayerById(replayLayerId) : undefined) ||
            glyph?.findLayerById(layerId) ||
            sourceLayer?.getMatchingLayerOnGlyph?.(glyphName);
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
    options?: {
        skipDeferredCanvasRepaint?: boolean;
        workerReplayTargets?: WorkerReplayTarget[];
    }
): Promise<void> {
    const gc = window.glyphCanvas;
    const oe = gc?.outlineEditor;
    const parsedStack = oe?.parseGlyphStack?.() || [];
    const refreshRootGlyphName =
        rootGlyphName ?? parsedStack[0]?.glyphName ?? undefined;
    let selectedLayerId = oe?.selectedLayerId ?? undefined;

    const currentFont = window.fontManager?.currentFont;
    if (currentFont?.babelfontJson && fontCompilation?.isInitialized) {
        try {
            let didStoreLayer = false;
            const replayTargets = normalizeWorkerReplayTargets(
                options?.workerReplayTargets
            );
            if (
                !forceFullRustSync &&
                replayTargets.length > 0 &&
                typeof window.fontManager
                    ?.refreshWorkerCacheForReplayTargets === 'function'
            ) {
                didStoreLayer =
                    (await window.fontManager.refreshWorkerCacheForReplayTargets(
                        replayTargets
                    )) === true;
            }
            if (!didStoreLayer && !forceFullRustSync && selectedLayerId) {
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

            await fontCompilation.awaitWorkerDocumentSync();
        } catch {
            // Non-fatal — the scheduled compile will update the cache later
        }
    }

    if (gc) {
        // If a drag is in progress, loading layer data from the model would
        // reset layerData to the pre-drag (Y.Doc) state, corrupting the drag
        // baseline and producing wrong undo history. Defer the refresh until
        // the drag ends (onMouseUp checks pendingRemoteRefreshAfterDrag).
        if (oe?.draggingSomething) {
            if (oe) {
                oe.pendingRemoteRefreshAfterDrag = true;
            }
            return;
        }

        await oe?.reconcileSelectionAfterModelSync?.({ skipRender: true });

        selectedLayerId = oe?.selectedLayerId ?? undefined;

        const refreshOutlineEditor = async () => {
            const shouldInterpolateActiveGlyph =
                gc.outlineEditor?.active && !selectedLayerId;

            if (shouldInterpolateActiveGlyph) {
                await gc.outlineEditor?.interpolateCurrentGlyph(true);
                return;
            }

            await gc.outlineEditor?.fetchLayerData(true, refreshRootGlyphName);

            refreshLiveTextRunAdvances(
                new Set(
                    [
                        ...normalizeWorkerReplayTargets(
                            options?.workerReplayTargets
                        ).map((target) => target.glyphName),
                        refreshRootGlyphName,
                        editedGlyphName,
                        getActiveEditedGlyphName()
                    ].filter((glyphName): glyphName is string => !!glyphName)
                ),
                selectedLayerId,
                {
                    workerReplayTargets: options?.workerReplayTargets
                }
            );
        };

        if (gc.outlineEditor?.runDeterministicRefresh) {
            await gc.outlineEditor.runDeterministicRefresh(
                refreshOutlineEditor
            );
        } else {
            await refreshOutlineEditor();
        }
        if (!options?.skipDeferredCanvasRepaint) {
            gc.requestRepaintAfterCompile();
        }
    }
}

function applyImmediateUndoSidebearingSync(
    appliedGlyphName: string | null,
    appliedLayerId: string | null,
    historyItem: HistoryStackItem | null,
    previousWidth: number | null,
    fallbackEditedGlyphName?: string | null,
    fallbackLayerId?: string | null
): boolean {
    const gc = window.glyphCanvas;
    const fontModel = window.fontManager?.currentFont?.fontModel;
    const side = inferSidebearingSideFromHistoryItem(historyItem);
    // Visual anchoring follows the user-visible active glyph/layer, not the
    // appliedChange target. Font-scoped undos (sidebearing edits that cascade
    // across many downstream glyphs) report appliedChange.glyphName/layerId as
    // null, but the canvas is still showing a specific glyph whose right/left
    // edge must remain stationary on screen.
    const editedGlyphName =
        getActiveEditedGlyphName() ??
        appliedGlyphName ??
        fallbackEditedGlyphName ??
        null;
    const editedLayerId = appliedLayerId ?? fallbackLayerId ?? null;
    if (!gc || !fontModel || !side || !editedGlyphName || !editedLayerId) {
        return false;
    }

    const layer = fontModel
        .findGlyph(editedGlyphName)
        ?.findLayerById(editedLayerId);
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
        historyItem?.transactionLabel === 'Set RSB' ||
        historyItem?.transactionLabel === 'Set sidebearing'
    );
}

function historyItemTouchesAnchors(
    historyItem: HistoryStackItem | null
): boolean {
    return (historyItem?.touchedPaths ?? []).some((path) =>
        /(^|\.)anchors(\.|$)/.test(path)
    );
}

function syncImmediateUndoOutlineLayerFromModel(
    glyphName: string | null,
    layerId: string | null
): void {
    const gc = window.glyphCanvas;
    const outlineEditor = gc?.outlineEditor as unknown as {
        parseGlyphStack?: () => Array<{ glyphName: string }>;
        replaceCurrentLayerDataInStack?: (layerData: unknown) => boolean;
        cancelPendingLayerSwitchAnimation?: () => void;
        performHitDetection?: (event: MouseEvent | null) => void;
    } | null;
    const fontModel = window.fontManager?.currentFont?.fontModel;
    const editedGlyphName = getActiveEditedGlyphName() ?? glyphName;
    if (!gc || !fontModel || !editedGlyphName || !layerId) {
        return;
    }

    outlineEditor?.cancelPendingLayerSwitchAnimation?.();

    const layer = fontModel.findGlyph(editedGlyphName)?.findLayerById(layerId);
    if (!layer) {
        return;
    }

    const parsedGlyphStack = outlineEditor?.parseGlyphStack?.() ?? [];
    const isNestedEditing = parsedGlyphStack.length > 1;

    if (isNestedEditing) {
        outlineEditor?.replaceCurrentLayerDataInStack?.(layer.toJSON());
    } else {
        gc.syncCurrentOutlineLayerDataFromModel?.(layer);
    }
    gc.updatePropertyPanel?.();
    outlineEditor?.performHitDetection?.(null);
    gc.render?.();
}

function shouldForceFullRustSyncAfterUndoRedo(
    scope: 'font' | 'glyph' | 'layer',
    historyItem: HistoryStackItem | null,
    workerReplayTargets?: WorkerReplayTarget[]
): boolean {
    const normalizedReplayTargets =
        normalizeWorkerReplayTargets(workerReplayTargets);
    if (
        normalizedReplayTargets.length > 0 &&
        historyItemHasIncrementalWorkerReplayTargets(historyItem) &&
        historyItemChangeEntriesAreLayerReplayable(historyItem)
    ) {
        return false;
    }

    if (scope === 'layer' && normalizedReplayTargets.length > 0) {
        return false;
    }

    if (scope !== 'layer') {
        return true;
    }

    return (
        historyItemTouchesAnchors(historyItem) ||
        historyItem?.transactionLabel === 'Scale selection' ||
        (historyItem?.transactionLabel === 'Drag point' &&
            inferSidebearingSideFromHistoryItem(historyItem) !== null) ||
        historyItem?.transactionLabel === 'Drag anchor' ||
        (inferSidebearingSideFromHistoryItem(historyItem) !== null &&
            !historyItemHasIncrementalWorkerReplayTargets(historyItem))
    );
}

function historyItemHasIncrementalWorkerReplayTargets(
    historyItem: HistoryStackItem | null
): boolean {
    return (
        normalizeWorkerReplayTargets(historyItem?.workerReplayTargets).length >
        0
    );
}

function historyItemChangeEntriesAreLayerReplayable(
    historyItem: HistoryStackItem | null
): boolean {
    const changeEntries = (historyItem?.entries ?? []).filter(
        (entry) => entry.historyAction === 'change'
    );
    if (!changeEntries.length) {
        return false;
    }

    return changeEntries.every(
        (entry) =>
            normalizeWorkerReplayTargets(entry.workerReplayTargets).length > 0
    );
}

function recomputeMetricsKeysAfterUndoRedo(
    bridge: PatchSyncEngine,
    historyItem: HistoryStackItem | null,
    glyphNames: Array<string | null | undefined>,
    layerId?: string | null
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

    const rebuildAutomaticComposites = () =>
        typeof fontModel.rebuildAutomaticCompositesForGlyphs === 'function'
            ? fontModel.rebuildAutomaticCompositesForGlyphs(seedGlyphNames, {
                  ...(layerId
                      ? {
                            preferredLayerId: layerId,
                            preferredSourceGlyphName:
                                glyphNames.find(
                                    (glyphName): glyphName is string =>
                                        !!glyphName && glyphName !== 'undefined'
                                ) ?? null
                        }
                      : undefined)
              })
            : new Set<string>();

    const recompute = () => {
        const affectedGlyphNames = new Set<string>();
        for (const glyphName of rebuildAutomaticComposites()) {
            affectedGlyphNames.add(glyphName);
        }
        for (const glyphName of fontModel.recomputeMetricsKeys(
            seedGlyphNames
        )) {
            affectedGlyphNames.add(glyphName);
        }
        return affectedGlyphNames;
    };
    if (typeof bridge.runWithoutRecording === 'function') {
        return bridge.runWithoutRecording(recompute);
    }

    return recompute();
}

function collectUndoRedoWorkerReplayTargets(
    historyItem: HistoryStackItem | null,
    glyphNames: Iterable<string | null | undefined>,
    layerId?: string | null
): WorkerReplayTarget[] {
    const replayTargets = normalizeWorkerReplayTargets(
        historyItem?.workerReplayTargets
    );
    if (!layerId) {
        return replayTargets;
    }

    const fontModel = window.fontManager?.currentFont?.fontModel;
    if (!fontModel) {
        return replayTargets;
    }

    const targetGlyphNames = new Set<string>();
    for (const glyphName of glyphNames) {
        if (glyphName && glyphName !== 'undefined') {
            targetGlyphNames.add(glyphName);
        }
    }
    for (const glyphName of deriveGlyphNamesFromPaths(
        historyItem?.touchedPaths ?? []
    )) {
        targetGlyphNames.add(glyphName);
    }

    const sourceGlyphName = Array.from(targetGlyphNames).find((glyphName) => {
        const glyph = fontModel.findGlyph?.(glyphName);
        return !!glyph?.findLayerById?.(layerId);
    });
    const sourceLayer = sourceGlyphName
        ? fontModel.findGlyph(sourceGlyphName)?.findLayerById(layerId)
        : null;

    const derivedTargets = [...replayTargets];
    for (const glyphName of targetGlyphNames) {
        const glyph = fontModel.findGlyph?.(glyphName);
        const matchedLayer =
            glyph?.findLayerById?.(layerId) ??
            sourceLayer?.getMatchingLayerOnGlyph?.(glyphName);
        const matchedLayerId = matchedLayer?.id;
        if (glyphName && matchedLayerId) {
            derivedTargets.push({ glyphName, layerId: matchedLayerId });
        }
    }

    return normalizeWorkerReplayTargets(derivedTargets);
}

/**
 * Derive cascading recomposition targets from the directly edited layers.
 *
 * For each (glyphName, layerId) source pair, discovers glyphs that depend
 * on it as a component reference, then finds the matching layer (same master)
 * on each dependent glyph. Returns all targets that need recomposition.
 *
 * The derivation works generically for any edit source — GUI glyph edits
 * (outline, anchor, sidebearing), Python scripts, or undo/redo.
 */
export function collectCascadeRecomposeTargets(
    sourceTargets: WorkerReplayTarget[],
    sourceGlyphName?: string | null,
    sourceLayerId?: string | null
): WorkerReplayTarget[] {
    const fontModel =
        window.fontManager?.currentFont?.fontModel ?? window.currentFontModel;
    if (!fontModel || !sourceTargets.length) {
        return [];
    }

    const sourceLayer = sourceGlyphName
        ? fontModel
              .findGlyph(sourceGlyphName)
              ?.findLayerById(sourceLayerId ?? '')
        : null;

    // Union: directly edited layers + dependent component glyphs
    const allGlyphNames = new Set<string>();
    for (const target of sourceTargets) {
        allGlyphNames.add(target.glyphName);
    }

    if (typeof fontModel.collectComponentDependentGlyphs === 'function') {
        for (const dependentGlyphName of fontModel.collectComponentDependentGlyphs(
            allGlyphNames
        )) {
            allGlyphNames.add(dependentGlyphName);
        }
    }

    // For each affected glyph, find the matching layer (same master)
    const recomposeTargets: WorkerReplayTarget[] = [];
    for (const glyphName of allGlyphNames) {
        // Skip glyphs already in source targets (already handled directly)
        const alreadySource = sourceTargets.some(
            (t) => t.glyphName === glyphName
        );
        if (alreadySource) continue;

        const glyph = fontModel.findGlyph(glyphName);
        if (!glyph) continue;

        // Try to find the matching layer by looking at source layer's master
        let matchedLayer = null;
        if (
            sourceLayer?.id &&
            typeof sourceLayer.getMatchingLayerOnGlyph === 'function'
        ) {
            matchedLayer = sourceLayer.getMatchingLayerOnGlyph(glyphName);
        }

        if (matchedLayer?.id) {
            recomposeTargets.push({
                glyphName,
                layerId: matchedLayer.id
            });
        }
    }

    return normalizeWorkerReplayTargets(recomposeTargets);
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
    if (fontModel?.collectComponentDependentGlyphs) {
        for (const dependentGlyphName of fontModel.collectComponentDependentGlyphs(
            refreshGlyphNames
        )) {
            addGlyphName(dependentGlyphName);
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
        window.dispatchEvent(
            new CustomEvent('glyphChanged', {
                detail:
                    refreshGlyphNames.length === 1
                        ? {
                              glyphName: refreshGlyphNames[0],
                              layerId: layerId ?? undefined
                          }
                        : {
                              glyphName: refreshGlyphNames[0],
                              glyphNames: refreshGlyphNames,
                              layerId: layerId ?? undefined
                          }
            })
        );
        return;
    }

    const glyphOverview = window.glyphOverviewInstance;
    if (typeof glyphOverview?.renderGlyphOutlines === 'function') {
        await glyphOverview.renderGlyphOutlines(
            glyphOverview.currentLocation ?? {}
        );
    }
}

function waitForEditingFontCompileRevision(
    targetRevision: number,
    timeoutMs: number = 4000
): Promise<void> {
    if (!Number.isFinite(targetRevision)) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        let settled = false;
        let timeoutId: number | null = null;

        const cleanup = () => {
            if (timeoutId !== null) {
                window.clearTimeout(timeoutId);
            }
            window.removeEventListener('editingFontCompiled', handler);
        };

        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve();
        };

        const handler = (event: Event) => {
            const detail = (event as CustomEvent).detail;
            const revision = Number(detail?.fontRevisionKey);
            if (!Number.isFinite(revision) || revision < targetRevision) {
                return;
            }
            finish();
        };

        timeoutId = window.setTimeout(() => {
            finish();
        }, timeoutMs);

        window.addEventListener('editingFontCompiled', handler);
    });
}

async function requestUndoRedoEditingFontCompile(
    waitForCompletion: boolean = false,
    editType?: 'outline' | 'anchor' | null
): Promise<void> {
    const fm = window.fontManager;
    if (!fm?.currentFont) {
        return;
    }

    fm.lastChangeSource = editType ? 'keyboard-undo-redo' : 'undo-redo';
    // Preserve the edit-type hint from the undone history item so the
    // compile loop uses the matching fast-path mode (e.g. anchor-only)
    // instead of always falling back to a full compile. The trailing
    // debounced full compile restores correctness afterwards.
    fm.lastEditType = editType ?? null;

    const targetRevision = fm.currentFont.compileRequestVersion + 1;
    const canForceTrigger =
        typeof window.autoCompileManager?.forceTrigger === 'function';
    const waitPromise =
        waitForCompletion && canForceTrigger
            ? waitForEditingFontCompileRevision(targetRevision)
            : null;

    fm.currentFont.requestRecompileWithoutDataChange();
    window.autoCompileManager?.checkAndSchedule?.();

    if (!waitPromise || !canForceTrigger) {
        return;
    }

    try {
        await window.autoCompileManager.forceTrigger();
    } catch {
        // Fall through to the revision wait; the compile loop may still complete.
    }

    await waitPromise;
}

async function requestRemoteEditingFontCompile(
    changeSource: string,
    editType?: 'outline' | 'anchor' | null
): Promise<void> {
    const fm = window.fontManager;
    if (!fm?.currentFont) {
        return;
    }

    fm.lastChangeSource = changeSource;
    fm.lastEditType = editType ?? null;

    fm.currentFont.requestRecompileWithoutDataChange();
    window.autoCompileManager?.checkAndSchedule?.();

    // Fire-and-forget: do NOT await compile completion.
    //
    // Awaiting here serialises every remote update behind compile latency
    // (100–500 ms each) inside the enqueueRemoteChangeRefresh serial queue.
    // If five rapid edits land from a peer, each would be blocked until the
    // previous compile finished — creating a multi-second pipeline stall.
    //
    // Instead we trigger the compile and return immediately. The autoCompile
    // manager's own scheduling logic (checkAndSchedule / forceTrigger) will
    // run the compile as soon as the thread is free, coalescing any queued
    // compiles automatically.
    if (typeof window.autoCompileManager?.forceTrigger === 'function') {
        try {
            window.autoCompileManager.forceTrigger();
        } catch {
            // Compile errors are reported through the normal error path.
        }
    }
}

/**
 * Apply the receiver-side viewport pan compensation when a remote sidebearing
 * edit lands on a linked window. Mirrors the sender's live pan so the active
 * glyph's opposite edge stays visually anchored on screen during undo/redo
 * and live edits forwarded from a peer window.
 *
 * Returns true when a pan was applied so the caller can avoid duplicate work.
 */
function applyRemoteSidebearingVisualSync(entries: ChangeLogEntry[]): boolean {
    const gc = window.glyphCanvas;
    const fontModel = window.fontManager?.currentFont?.fontModel;
    if (!gc || !fontModel) {
        return false;
    }

    const editedGlyphName = getActiveEditedGlyphName();
    if (!editedGlyphName) {
        return false;
    }

    const activeLayerId = gc.outlineEditor?.selectedLayerId ?? null;
    if (!activeLayerId) {
        return false;
    }

    const matchingEntry = entries.find((entry) => {
        if (
            entry.visualAnchorSide !== 'left' &&
            entry.visualAnchorSide !== 'right'
        ) {
            return false;
        }
        const path = entry.path ?? '';
        return path === `glyphs.${editedGlyphName}.layers.${activeLayerId}`;
    });

    if (!matchingEntry) {
        return false;
    }

    const previousLayerSnapshot = matchingEntry.oldValue as
        | { width?: number }
        | string
        | null
        | undefined;
    const previousWidth =
        previousLayerSnapshot && typeof previousLayerSnapshot === 'object'
            ? Number(previousLayerSnapshot.width)
            : NaN;
    if (!Number.isFinite(previousWidth)) {
        return false;
    }

    const layer = fontModel
        .findGlyph(editedGlyphName)
        ?.findLayerById(activeLayerId);
    if (!layer) {
        return false;
    }

    syncModelSidebearingEditToCanvas(gc, {
        layer,
        glyphName: editedGlyphName,
        side: matchingEntry.visualAnchorSide as 'left' | 'right',
        previousWidth,
        render: false
    });
    gc.updatePropertyPanel?.();
    gc.outlineEditor?.performHitDetection?.(null);
    gc.render?.();

    return true;
}

/**
 * Refresh receiver-side Rust/cache state for a remote edit and request
 * editing compilation only after the refresh has been queued.
 */
export async function handleRemoteChangeRefresh(
    entries: ChangeLogEntry[],
    dependencies?: {
        requestCompile?: (
            changeSource: string,
            editType?: 'outline' | 'anchor' | null
        ) => Promise<void>;
        queueCacheRefresh?: (
            rootGlyphName?: string,
            editedGlyphName?: string,
            forceFullRustSync?: boolean,
            options?: {
                skipDeferredCanvasRepaint?: boolean;
                workerReplayTargets?: WorkerReplayTarget[];
            }
        ) => Promise<void>;
    }
): Promise<void> {
    // Receiver-side visual pan: when a remote sidebearing edit (live, undo, or
    // redo) lands and matches the linked window's active glyph/layer, pan the
    // canvas so the opposite edge stays stationary, mirroring the sender's
    // local behavior.
    applyRemoteSidebearingVisualSync(entries);

    const { editType, changeSource } = inferRemoteEditTypeFromEntries(entries);
    const replayTargets = collectReplayTargetsFromEntries(entries);
    const requestCompile =
        dependencies?.requestCompile ?? requestRemoteEditingFontCompile;
    const queueCacheRefresh =
        dependencies?.queueCacheRefresh ?? queueRustCacheAndRefreshCanvas;

    await queueCacheRefresh(
        undefined,
        undefined,
        false,
        replayTargets.length > 0
            ? { workerReplayTargets: replayTargets }
            : undefined
    );

    await requestCompile(changeSource, editType);

    // Refresh the glyph overview for the receiving window. Extract affected
    // glyph names from workerReplayTargets and entry paths, then dispatch
    // glyphChanged so the overview invalidates cached tile data and
    // schedules a re-render.
    const changedGlyphNames = new Set<string>();
    for (const entry of entries) {
        for (const target of normalizeWorkerReplayTargets(
            entry.workerReplayTargets
        )) {
            if (target.glyphName) {
                changedGlyphNames.add(target.glyphName);
            }
        }
    }
    const entryPaths = entries
        .map((e) => e.path)
        .filter((p): p is string => !!p);
    for (const glyphName of deriveGlyphNamesFromPaths(entryPaths)) {
        changedGlyphNames.add(glyphName);
    }

    // Include dependent composite glyphs (glyphs that use any changed
    // glyph as a component). Their rendered outlines also change when
    // the source glyph's outline, anchors, or sidebearings are modified.
    const fontModel =
        window.fontManager?.currentFont?.fontModel ?? window.currentFontModel;
    if (fontModel?.collectComponentDependentGlyphs) {
        for (const dependentGlyphName of fontModel.collectComponentDependentGlyphs(
            changedGlyphNames
        )) {
            changedGlyphNames.add(dependentGlyphName);
        }
    }

    if (changedGlyphNames.size > 0) {
        const glyphNamesArray = [...changedGlyphNames];
        window.dispatchEvent(
            new CustomEvent('glyphChanged', {
                detail: {
                    glyphName: glyphNamesArray[0],
                    glyphNames: glyphNamesArray
                }
            })
        );
    } else {
        // Fallback: full overview re-render when no specific glyphs
        // can be identified from the change entries.
        const glyphOverview = window.glyphOverviewInstance;
        if (typeof glyphOverview?.renderGlyphOutlines === 'function') {
            await glyphOverview.renderGlyphOutlines(
                glyphOverview.currentLocation ?? {}
            );
        }
    }
}

export function queueRustCacheAndRefreshCanvas(
    rootGlyphName?: string,
    editedGlyphName?: string,
    forceFullRustSync?: boolean,
    options?: {
        skipDeferredCanvasRepaint?: boolean;
        workerReplayTargets?: WorkerReplayTarget[];
    }
): Promise<void> {
    return enqueueBridgeSync(async () => {
        await syncRustCacheAndRefreshCanvas(
            rootGlyphName,
            editedGlyphName,
            forceFullRustSync,
            options
        );
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
        const bridge = window.patchSyncEngine;
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
                previousWidth,
                editedGlyphName ?? null,
                layerId ?? null
            );

        const recomputedGlyphNames = recomputeMetricsKeysAfterUndoRedo(
            bridge,
            appliedChange.historyItem as HistoryStackItem | null,
            [appliedChange.glyphName, glyphName, editedGlyphName],
            appliedChange.layerId ?? layerId ?? null
        );
        const workerReplayTargets = collectUndoRedoWorkerReplayTargets(
            appliedChange.historyItem as HistoryStackItem | null,
            [
                ...recomputedGlyphNames,
                appliedChange.glyphName,
                glyphName,
                editedGlyphName,
                refreshRootGlyphName,
                getActiveEditedGlyphName()
            ],
            appliedChange.layerId ?? layerId ?? null
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

        // For layer-scoped undo/redo, the incremental layer-update batch path
        // is sufficient (reads directly from the model, no babelfontJson needed).
        // For glyph/font scope, force a full Rust font cache refresh.
        // When the undone history item was an anchor edit, propagate the
        // edit type so the compile loop uses anchor-only mode (keep
        // positioning tables live, skip VARC) instead of falling back to a
        // full compile.
        // When the undone history item was a sidebearing edit, use outline-only
        // mode for the same speed benefit.
        const historyItem =
            appliedChange.historyItem as HistoryStackItem | null;
        const undoEditType = historyItemTouchesAnchors(historyItem)
            ? 'anchor'
            : inferSidebearingSideFromHistoryItem(historyItem) !== null
              ? 'outline'
              : null;
        const forceFullRustSync = shouldForceFullRustSyncAfterUndoRedo(
            appliedChange.scope,
            appliedChange.historyItem as HistoryStackItem | null,
            workerReplayTargets
        );
        const rustCacheRefreshPromise = syncRustCacheAndRefreshCanvas(
            refreshRootGlyphName,
            glyphName,
            forceFullRustSync,
            {
                workerReplayTargets,
                skipDeferredCanvasRepaint:
                    appliedImmediateSidebearingSync &&
                    isDirectSidebearingHistory
            }
        );

        // Start the Rust/cache refresh before requesting an editing compile so
        // the compile loop can observe the in-flight worker update and wait for it.
        await requestUndoRedoEditingFontCompile(false, undoEditType);
        await rustCacheRefreshPromise;

        // Undo/redo can request a compile before the Rust cache refresh above
        // has finished, which risks compiling against stale worker data.
        // Re-request compilation after the refresh completes so the editing
        // font is rebuilt from the restored state.
        await requestUndoRedoEditingFontCompile(true, undoEditType);

        // Anchor-only and outline-only compiles still use the interactive
        // fast path; schedule a trailing debounced full compile so the editor
        // returns to a fully correct font (same pattern as the forward edit path).
        if (undoEditType === 'anchor' || undoEditType === 'outline') {
            window.fontManager?.scheduleFullCompileDebounce?.();
        }

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
 * Tear down any existing PatchSyncEngine / WindowSync before loading a new font.
 */
function destroyExisting(): void {
    if (window.windowSync) {
        window.windowSync.destroy();
        window.windowSync = undefined;
    }
    if (window.patchSyncEngine) {
        window.patchSyncEngine.destroy();
        window.patchSyncEngine = undefined;
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

    const bridge = new PatchSyncEngine(window.windowRole?.instanceId);
    bridge.setTransactionFinalizer((operations) =>
        buildCascadingRecompositionOperations(bridge, operations)
    );
    window.patchSyncEngine = bridge;
    window.changeBridge = bridge;
    const bootstrapState = (
        window as Window & {
            __pendingCloudBridgeBootstrapState?: Uint8Array;
            __pendingCloudBridgeBootstrapChangeLog?: ChangeLogEntry[];
        }
    ).__pendingCloudBridgeBootstrapState;
    const bootstrapChangeLog = (
        window as Window & {
            __pendingCloudBridgeBootstrapState?: Uint8Array;
            __pendingCloudBridgeBootstrapChangeLog?: ChangeLogEntry[];
        }
    ).__pendingCloudBridgeBootstrapChangeLog;
    delete (
        window as Window & {
            __pendingCloudBridgeBootstrapState?: Uint8Array;
            __pendingCloudBridgeBootstrapChangeLog?: ChangeLogEntry[];
        }
    ).__pendingCloudBridgeBootstrapState;
    delete (
        window as Window & {
            __pendingCloudBridgeBootstrapState?: Uint8Array;
            __pendingCloudBridgeBootstrapChangeLog?: ChangeLogEntry[];
        }
    ).__pendingCloudBridgeBootstrapChangeLog;

    // Called after _syncJsonFromYDoc in undo/redo/remote.
    // Rebuilds the Font model from the already-patched babelfontData.
    // babelfontJson is marked stale and rebuilt lazily:
    //   • For layer-scoped undo/redo, syncRustCacheAndRefreshCanvas uses the
    //     incremental layer-update batch path which reads directly from the model
    //     (no babelfontJson needed).
    //   • If the fallback full-sync path is needed, syncRustCacheAndRefreshCanvas
    //     rebuilds babelfontJson just before sending it to the Rust worker.
    //   • For the next full compile, compileEditingFont rebuilds babelfontJson
    //     via syncBabelfontJsonFromCurrentModel() before invoking fontc.
    bridge.onAfterSync(() => {
        const fm = window.fontManager;
        if (!fm?.currentFont) return;

        // Reset compilation state so next compile is a clean full build
        fm.lastChangeSource = null;
        fm.lastEditType = null;
        // Mark babelfontJson as stale; it will be rebuilt lazily (see comment above).
        fm.pendingBabelfontJsonSyncAfterDrag = true;

        // Rebuild Font model from the patched babelfontData
        fm.currentFont.fontModel = Font.fromData(fm.currentFont.babelfontData);
        window.currentFontModel = fm.currentFont.fontModel;

        window.dispatchEvent(new CustomEvent('fontModelSync'));
    });

    // Wire dirty marking: when PatchSyncEngine records a change, also mark
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

    // Local and remote edits both refresh the worker cache from the local
    // model state. The collaboration envelope now carries semantic operations
    // and replay targets for history/compile metadata, not raw JSON patches.

    // Callback for remote changes — trigger a canvas/overview refresh.
    // By the time this fires, onAfterSync has already re-synced
    // babelfontJson and rebuilt the model, so auto-compile will
    // produce correct output once the dirty flag triggers it.
    //
    // The entries carry workerReplayTargets and edit-type metadata
    // from the source window.  Use them to:
    //   1. Pass replay targets to syncRustCacheAndRefreshCanvas for
    //      incremental layer updates (instead of full JSON resync).
    //   2. Infer the original edit type so the linked window's editing
    //      compile uses the matching fast path (anchor-only / outline-only)
    //      instead of always falling back to the slowest full mode.
    bridge.onRemoteChange((entries: ChangeLogEntry[]) => {
        void enqueueRemoteChangeRefresh(() =>
            handleRemoteChangeRefresh(entries)
        );
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
    } else if (bootstrapState && bootstrapState.length > 0) {
        bridge.setFontJson(
            detail.babelfontData as Record<
                string,
                ReturnType<typeof JSON.parse>
            >
        );
        bridge.applyFullState(bootstrapState);
        if (bootstrapChangeLog?.length) {
            bridge.importChangeLog(bootstrapChangeLog);
        }
    } else {
        // Primary window: populate Y.Doc from loaded font data.
        bridge.initFromJson(
            detail.babelfontData as Record<
                string,
                ReturnType<typeof JSON.parse>
            >
        );
    }

    // ── Wire Yjs updates → Rust compilation worker ───────────────────────
    // Every local edit and remote change emits a small binary Yjs update.
    // Forward it to the WASM worker so the Rust Y.Doc + CANONICAL_JSON_CACHE
    // stay current without the expensive full-JSON round-trip.
    bridge.setYjsWorkerCallback((update, changeLogEntries) => {
        if (!fontCompilation?.isInitialized) return;
        const isDragging =
            window.glyphCanvas?.outlineEditor?.draggingSomething === true;

        // Extract affected glyph names from the change-log entries so Rust can
        // perform a targeted partial update instead of a full JSON rebuild.
        // ChangeLogEntry.path uses dot-delimited format: "glyphs.A.layers.uuid.shapes.0.nodes"
        const changedGlyphs = deriveGlyphNamesFromPaths(
            changeLogEntries.map((e) => e.path).filter(Boolean)
        );

        void fontCompilation.sendMessage({
            type: 'applyYjsUpdate',
            update,
            changedGlyphs,
            invalidateLayoutClosure: !isDragging
        });
    });

    // Seed the Rust Y.Doc immediately after bridge initialisation so that the
    // first `apply_yjs_update` call has a baseline. For linked windows the
    // full state arrives via WindowSync, so skip the initial seed there.
    if (!isSyncWindow() && fontCompilation?.isInitialized) {
        void fontCompilation.sendMessage({
            type: 'seedYdoc',
            state: bridge.encodeBridgeState()
        });
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
        console.log('Main window — PatchSyncEngine initialised');
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
    if (window.patchSyncEngine && window.windowSync) {
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
    console.log('Recovered PatchSyncEngine from currentFont fallback');
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
