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

import {
    PatchSyncEngine,
    type CommittedChangeOrigin
} from './patch-sync-engine';
import { fromYType } from './change-bridge-ydoc';
import { Font } from './babelfont-model';
import { WindowSync } from './window-sync';
import { fontCompilation, fullFontCompilation } from './font-compilation';
import { Logger } from './logger';
import { processCommittedEdit } from './compiled-edit-funnel';
import { computeLayerRecompositionClosure } from './recomposition-closure';
import { sidebarErrorDisplay } from './sidebar-error-display';
import APP_SETTINGS from './settings';
import {
    deriveGlyphNamesFromPaths,
    deriveGlyphName,
    deriveLayerId,
    getPathSegments,
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
let committedChangeRefreshQueue: Promise<void> = Promise.resolve();
let committedChangeRefreshGeneration = 0;
let pendingLocalUndoRedoContext: LocalUndoRedoVisualContext | null = null;

type Unsafe = ReturnType<typeof JSON.parse>;

function enqueueBridgeSync(task: () => Promise<void>): Promise<void> {
    bridgeSyncQueue = bridgeSyncQueue.then(task, task);
    return bridgeSyncQueue;
}

function enqueueCommittedChangeRefresh(
    task: () => Promise<void>
): Promise<void> {
    committedChangeRefreshGeneration += 1;
    committedChangeRefreshQueue = committedChangeRefreshQueue.then(task, task);
    return committedChangeRefreshQueue;
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

function collectWorkerLayerTargetsFromChangeLogEntries(
    changeLogEntries: ChangeLogEntry[]
): WorkerReplayTarget[] {
    const targets: WorkerReplayTarget[] = [];

    for (const entry of changeLogEntries) {
        if (Array.isArray(entry.workerReplayTargets)) {
            targets.push(...entry.workerReplayTargets);
        }

        const entryPath =
            typeof entry.path === 'string' && entry.path.length > 0
                ? getPathSegments(entry.path)
                : [];
        const glyphName = deriveGlyphName(entryPath);
        const layerId = deriveLayerId(entryPath);
        if (glyphName && layerId) {
            targets.push({ glyphName, layerId });
        }
    }

    return normalizeWorkerReplayTargets(targets);
}

export function shouldInvalidateLayoutClosureForCommittedEntries(
    changeLogEntries: ChangeLogEntry[]
): boolean {
    for (const entry of changeLogEntries) {
        const path = typeof entry.path === 'string' ? entry.path : '';
        const hasReplayTargets =
            normalizeWorkerReplayTargets(entry.workerReplayTargets).length > 0;
        if (!path) {
            continue;
        }

        if (
            entry.transactionLabel === 'Reinterpolate layer batch sync' &&
            hasReplayTargets
        ) {
            continue;
        }

        // Visual layer-scoped paths must NOT invalidate layout closure.
        // This covers outline, anchor, sidebearing, component, guide, and
        // layer-visual edits that only change data inside the existing
        // closed glyph set.
        if (path.includes('.layers.') || path.includes(':layers.')) {
            continue;
        }

        if (path.startsWith('features.')) {
            return true;
        }

        if (
            path.startsWith('glyphs.') &&
            !path.includes('.layers.') &&
            !path.includes(':layers.')
        ) {
            return true;
        }
    }

    return false;
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

/**
 * Check whether a cascade-triggering operation already carries complete
 * GUI recomposed layer snapshots, so the bridge finalizer can skip
 * duplicate recomposition.
 *
 * A transaction is considered complete when all cascade-triggering
 * operations are layer-scoped snapshot operations that already carry
 * explicit `workerReplayTargets` including the source and downstream
 * layers.
 */
function operationCarriesCompleteGuiReplayTargets(
    operation: TransactionBufferedOperation
): boolean {
    const applyPath = operation.applyPath ?? operation.path;
    const replayTargets = normalizeWorkerReplayTargets(
        operation.workerReplayTargets
    );

    if (!replayTargets.length) {
        return false;
    }

    const glyphName = deriveGlyphName(applyPath);
    const layerId = deriveLayerId(applyPath);
    if (!glyphName || !layerId) {
        return false;
    }

    return replayTargets.some(
        (target) => target.glyphName === glyphName && target.layerId === layerId
    );
}

export function buildCascadingRecompositionOperations(
    bridge: PatchSyncEngine,
    operations: TransactionBufferedOperation[]
): TransactionBufferedOperation[] {
    const sourceTargets = collectCascadeTriggerSourceTargets(operations);
    if (!sourceTargets.length) {
        return [];
    }

    // Check if every cascade-triggering operation already carries complete
    // GUI replay targets. If so, the producer already recomposed and
    // included the downstream layer snapshots — skip duplicate recomposition.
    const allOperationsComplete = operations.every((op) => {
        const applyPath = op.applyPath ?? op.path;
        // Only check operations that are cascade triggers
        if (
            !isWidthPath(applyPath) &&
            !isAnchorPath(applyPath) &&
            !(
                op.applyMode === 'layer-snapshot' &&
                applyPath.length === 4 &&
                applyPath[0] === 'glyphs' &&
                applyPath[2] === 'layers' &&
                (layerSnapshotTouchesCascade(op.applyOldValue) ||
                    layerSnapshotTouchesCascade(op.applyNewValue))
            ) &&
            !(
                op.applyMode === 'glyph-snapshot' &&
                applyPath.length === 2 &&
                applyPath[0] === 'glyphs'
            )
        ) {
            // Non-cascade-triggering operations don't affect completeness
            return true;
        }
        return operationCarriesCompleteGuiReplayTargets(op);
    });

    if (allOperationsComplete) {
        return [];
    }

    // Use the shared recomposition closure instead of the local
    // recomputeCascadeAffectedGlyphNames.  The bridge fallback path uses a
    // superset of edit kinds so all dependency types are covered.
    const fontModel = window.fontManager?.currentFont?.fontModel ?? null;
    if (!fontModel) {
        return [];
    }

    // Extract the first source target's layer ID for matching-layer lookup.
    const activeLayerId = sourceTargets[0]?.layerId ?? null;
    const sourceGlyphName = sourceTargets[0]?.glyphName ?? null;

    const closure = computeLayerRecompositionClosure({
        sourceTargets,
        editKinds: new Set(['outline', 'anchor', 'sidebearing', 'component']),
        scope: 'all',
        fontModel,
        activeLayerId,
        sourceGlyphName,
        suppressor: bridge
    });

    if (!closure.affectedGlyphNames.size) {
        return [];
    }

    // Build layer targets from the full affected set (source + dependents).
    // Source layer targets are included so buildCascadeLayerOperations can
    // detect model mutations that affected the source glyph's own layer
    // (e.g. anchor clearing triggered by recomputeMetricsKeys).
    const allCascadeTargets = normalizeWorkerReplayTargets([
        ...sourceTargets,
        ...closure.dependentTargets
    ]);
    if (!allCascadeTargets.length) {
        return [];
    }

    return buildCascadeLayerOperations(bridge, allCascadeTargets, operations);
}

/**
 * Infer the original edit type from committed change log entries,
 * so every window can use the matching compilation fast path
 * (anchor-only / outline-only) instead of always falling back to
 * a full compile after the Yjs commit lands.
 */
type CommittedCompileEditType =
    | 'anchor'
    | 'outline'
    | 'guide'
    | 'kerning-value'
    | 'kerning-groups'
    | null;

type NonGlyphChangeHint =
    | 'feature-code'
    | 'kerning-value'
    | 'kerning-groups'
    | 'masters';

function pathTouchesMasterKerning(path: string): boolean {
    return /(^|\.)masters\.[^.]+\.kerning(_rtl)?(\.|$)/.test(path);
}

function pathTouchesKerningGroups(path: string): boolean {
    return (
        path === 'first_kern_groups' ||
        path === 'second_kern_groups' ||
        path.startsWith('first_kern_groups.') ||
        path.startsWith('second_kern_groups.')
    );
}

function inferKerningEditTypeFromMetadata(
    label: string,
    path: string
): CommittedCompileEditType {
    const normalizedLabel = label.toLowerCase();
    if (
        normalizedLabel.includes('kern group membership') ||
        pathTouchesKerningGroups(path)
    ) {
        return 'kerning-groups';
    }
    if (
        normalizedLabel.includes('kerning pair') ||
        pathTouchesMasterKerning(path)
    ) {
        return 'kerning-value';
    }
    return null;
}

function collectNonGlyphChangeHints(
    entries: ChangeLogEntry[]
): NonGlyphChangeHint[] {
    const hints = new Set<NonGlyphChangeHint>();

    for (const entry of entries) {
        const path = entry.path ?? '';
        const kerningEditType = inferKerningEditTypeFromMetadata(
            entry.transactionLabel ?? '',
            path
        );
        if (path.startsWith('features.')) {
            hints.add('feature-code');
        }
        if (
            !kerningEditType &&
            (path === 'masters' || path.startsWith('masters.'))
        ) {
            hints.add('masters');
        }
        if (kerningEditType === 'kerning-value') {
            hints.add('kerning-value');
        }
        if (kerningEditType === 'kerning-groups') {
            hints.add('kerning-groups');
        }
    }

    return [...hints];
}

function isSidebearingKeyMetadataPath(path: string): boolean {
    return (
        path.endsWith('.format_specific.metric_left') ||
        path.endsWith('.format_specific.metric_right') ||
        path.endsWith(
            '.format_specific.com.schriftgestalt.Glyphs.metricLeft'
        ) ||
        path.endsWith('.format_specific.com.schriftgestalt.Glyphs.metricRight')
    );
}

function isSidebearingKeyCommittedEntry(entry: ChangeLogEntry): boolean {
    const label = (entry.transactionLabel ?? '').toLowerCase();
    if (!label.includes('sidebearing')) {
        return false;
    }

    const path = entry.path ?? '';
    return (
        entry.visualAnchorSide === 'left' ||
        entry.visualAnchorSide === 'right' ||
        path.includes('.layers.') ||
        path.includes(':layers.') ||
        isSidebearingKeyMetadataPath(path)
    );
}

function getExplicitCommittedCompileContext(entries: ChangeLogEntry[]): {
    editType: CommittedCompileEditType;
    changeSource: string;
} | null {
    for (const entry of entries) {
        if (!entry.compileChangeSource) {
            continue;
        }

        const compileEditType = entry.compileEditType;
        return {
            changeSource: entry.compileChangeSource,
            editType:
                compileEditType === 'anchor' ||
                compileEditType === 'outline' ||
                compileEditType === 'guide' ||
                compileEditType === 'kerning-value' ||
                compileEditType === 'kerning-groups'
                    ? compileEditType
                    : null
        };
    }

    return null;
}

function inferCommittedEditTypeFromEntries(
    entries: ChangeLogEntry[],
    origin: CommittedChangeOrigin
): {
    editType: CommittedCompileEditType;
    changeSource: string;
} {
    const explicitContext = getExplicitCommittedCompileContext(entries);
    if (explicitContext) {
        return explicitContext;
    }

    const changeSourceFor = (editType: CommittedCompileEditType): string =>
        getCommittedChangeSource(origin, editType);

    for (const entry of entries) {
        const label = entry.transactionLabel ?? '';
        const path = entry.path ?? '';
        const isLayerSnapshotWithShapes = (value: unknown): boolean => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                return false;
            }

            const snapshot = value as Record<string, unknown>;
            return Array.isArray(snapshot.shapes);
        };
        const hasReplayTargets =
            normalizeWorkerReplayTargets(entry.workerReplayTargets).length > 0;
        if (origin === 'local' && path.startsWith('features.')) {
            return {
                editType: null,
                changeSource: 'feature-code'
            };
        }
        if (
            hasReplayTargets &&
            (label === 'Reinterpolate layer batch sync' ||
                label === 'Reinterpolate layer sync' ||
                label === 'Add master')
        ) {
            return {
                editType: 'outline',
                changeSource:
                    origin === 'local' &&
                    label === 'Reinterpolate layer batch sync'
                        ? 'master-reinterpolate-batch'
                        : changeSourceFor('outline')
            };
        }
        if (
            label.toLowerCase().includes('anchor') ||
            /(^|\.)anchors(\.|$)/.test(path)
        ) {
            return {
                editType: 'anchor',
                changeSource: changeSourceFor('anchor')
            };
        }
        if (
            label.toLowerCase().includes('guide') ||
            /(^|\.)guides(\.|$)/.test(path)
        ) {
            return {
                editType: 'guide',
                changeSource: changeSourceFor('guide')
            };
        }
        if (
            isLayerSnapshotWithShapes(entry.replayOldValue) ||
            isLayerSnapshotWithShapes(entry.replayNewValue) ||
            isLayerSnapshotWithShapes(entry.oldValue) ||
            isLayerSnapshotWithShapes(entry.newValue)
        ) {
            return {
                editType: 'outline',
                changeSource: changeSourceFor('outline')
            };
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
            return {
                editType: 'outline',
                changeSource: changeSourceFor('outline')
            };
        }

        const kerningEditType = inferKerningEditTypeFromMetadata(label, path);
        if (kerningEditType) {
            return {
                editType: kerningEditType,
                changeSource: changeSourceFor(kerningEditType)
            };
        }
    }
    return { editType: null, changeSource: changeSourceFor(null) };
}

function getCommittedChangeSource(
    origin: CommittedChangeOrigin,
    editType: CommittedCompileEditType
): string {
    if (origin === 'remote') {
        if (editType === 'anchor') {
            return 'remote-anchor';
        }
        if (editType === 'outline') {
            return 'remote-outline';
        }
        if (editType === 'guide') {
            return 'remote-guide';
        }
        if (editType === 'kerning-value') {
            return 'remote-kerning-value';
        }
        if (editType === 'kerning-groups') {
            return 'remote-kerning-groups';
        }
        return 'remote-change';
    }

    if (editType === 'anchor') {
        return 'keyboard-anchor';
    }
    if (editType === 'outline') {
        return 'keyboard-outline';
    }
    if (editType === 'guide') {
        return 'keyboard-guide';
    }
    if (editType === 'kerning-value') {
        return 'keyboard-kerning-value';
    }
    if (editType === 'kerning-groups') {
        return 'keyboard-kerning-groups';
    }
    return 'change-bridge-local';
}

function inferLocalCompileContextFromHistoryItem(
    historyItem: HistoryStackItem | null
): {
    editType: CommittedCompileEditType;
    changeSource: string;
} {
    const entries = historyItem?.entries ?? [];
    const semanticEntries = entries.flatMap(
        (entry) => entry.semanticChangeLogEntries ?? []
    );
    return inferCommittedEditTypeFromEntries(
        semanticEntries.length > 0 ? semanticEntries : entries,
        'local'
    );
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

function collectReplayTargetsBeyondDirectEntryPaths(
    entries: ChangeLogEntry[]
): WorkerReplayTarget[] {
    const replayTargets = collectReplayTargetsFromEntries(entries);
    if (!replayTargets.length) {
        return [];
    }

    const directLayerKeys = new Set<string>();
    const directGlyphNames = new Set<string>();
    for (const entry of entries) {
        const entryPath =
            typeof entry.path === 'string' && entry.path.length > 0
                ? getPathSegments(entry.path)
                : [];
        const glyphName = deriveGlyphName(entryPath);
        if (!glyphName) {
            continue;
        }
        const layerId = deriveLayerId(entryPath);
        if (layerId) {
            directLayerKeys.add(`${glyphName}@@${layerId}`);
        } else {
            directGlyphNames.add(glyphName);
        }
    }

    return replayTargets.filter(
        (target) =>
            !directGlyphNames.has(target.glyphName) &&
            !directLayerKeys.has(`${target.glyphName}@@${target.layerId}`)
    );
}

function hasReplayTargetsBeyondDirectEntryPaths(
    entries: ChangeLogEntry[]
): boolean {
    return collectReplayTargetsBeyondDirectEntryPaths(entries).length > 0;
}

function normalizeLayerDataForWorkerDriftCheck(layerData: unknown): string {
    if (!layerData) {
        return 'null';
    }

    const normalizeLayerForRust = (window.fontManager as any)
        ?.normalizeLayerForRust as ((layer: unknown) => unknown) | undefined;
    if (typeof normalizeLayerForRust !== 'function') {
        return JSON.stringify(layerData);
    }

    return JSON.stringify(
        normalizeLayerForRust.call(window.fontManager, layerData)
    );
}

function isLocalKeyboardMoveCommittedPacket(
    entries: ChangeLogEntry[]
): boolean {
    return entries.some(
        (entry) =>
            entry?.transactionLabel === 'Arrow key' ||
            (entry as { label?: string } | null)?.label === 'Arrow key'
    );
}

async function showCommittedKeyboardWorkerDriftIfNeeded(
    entries: ChangeLogEntry[],
    localCompileContext: LocalCommittedCompileContext | null
): Promise<boolean> {
    if (!APP_SETTINGS.IN_BROWSER_LIVE_TESTS.ENABLE_WORKER_DRIFT_CHECKS) {
        if (window.fontManager) {
            window.fontManager.pendingCommittedKeyboardDriftCheckAfterDrag = false;
        }
        return false;
    }

    if (
        window.fontManager?.pendingCommittedKeyboardDriftCheckAfterDrag !== true
    ) {
        return false;
    }

    if (
        !localCompileContext ||
        (localCompileContext.editType !== 'outline' &&
            localCompileContext.editType !== 'anchor')
    ) {
        return false;
    }

    if (
        entries.some(
            (entry) =>
                entry.historyAction === 'undo' || entry.historyAction === 'redo'
        )
    ) {
        return false;
    }

    if (!isLocalKeyboardMoveCommittedPacket(entries)) {
        return false;
    }

    if (!fontCompilation?.isInitialized) {
        return false;
    }

    const replayTargets = collectReplayTargetsFromEntries(entries);
    if (replayTargets.length === 0) {
        return false;
    }

    const fontModel = window.fontManager?.currentFont?.fontModel;
    if (!fontModel) {
        return false;
    }

    const expectedSnapshots = replayTargets
        .map((target) => {
            const layer = fontModel
                .findGlyph(target.glyphName)
                ?.findLayerById(target.layerId);
            const layerData =
                typeof layer?.toJSON === 'function'
                    ? layer.toJSON()
                    : (layer as unknown);
            if (!layerData) {
                return null;
            }

            return {
                glyphName: target.glyphName,
                layerId: target.layerId,
                fingerprint: normalizeLayerDataForWorkerDriftCheck(layerData)
            };
        })
        .filter(
            (
                snapshot
            ): snapshot is {
                glyphName: string;
                layerId: string;
                fingerprint: string;
            } => !!snapshot
        );

    if (expectedSnapshots.length === 0) {
        return false;
    }

    const response = await fontCompilation.sendMessage({
        type: 'dumpLayerState',
        layerTargets: replayTargets
    });

    window.fontManager.pendingCommittedKeyboardDriftCheckAfterDrag = false;

    if (response?.error) {
        console.error(
            '[ChangeBridgeInit] Failed to inspect committed keyboard worker state:',
            response.error
        );
        return false;
    }

    const dump = response?.dumpJson ? JSON.parse(response.dumpJson) : null;
    const dumpTargets = Array.isArray(dump?.targets) ? dump.targets : [];
    const mismatches: string[] = [];
    const seenTargets = new Set<string>();
    const expectedByTarget = new Map(
        expectedSnapshots.map((snapshot) => [
            `${snapshot.glyphName}@@${snapshot.layerId}`,
            snapshot.fingerprint
        ])
    );

    for (const target of dumpTargets) {
        const glyphName =
            typeof target?.glyphName === 'string' ? target.glyphName : null;
        const layerId =
            typeof target?.layerId === 'string' ? target.layerId : null;
        if (!glyphName || !layerId) {
            continue;
        }

        const targetKey = `${glyphName}@@${layerId}`;
        seenTargets.add(targetKey);

        const expectedFingerprint = expectedByTarget.get(targetKey) ?? 'null';
        const rustCanonicalFingerprint = normalizeLayerDataForWorkerDriftCheck(
            target?.canonicalLayer
        );
        const rustSubsetFingerprint = normalizeLayerDataForWorkerDriftCheck(
            target?.subsetLayer
        );
        const rustYDocFingerprint = normalizeLayerDataForWorkerDriftCheck(
            target?.ydocLayer
        );

        if (
            expectedFingerprint !== rustCanonicalFingerprint ||
            expectedFingerprint !== rustSubsetFingerprint ||
            expectedFingerprint !== rustYDocFingerprint
        ) {
            mismatches.push(
                `${glyphName}/${layerId}: expected=${expectedFingerprint} rustCanonical=${rustCanonicalFingerprint} rustSubset=${rustSubsetFingerprint} rustYDoc=${rustYDocFingerprint}`
            );
        }
    }

    for (const target of replayTargets) {
        const targetKey = `${target.glyphName}@@${target.layerId}`;
        if (!seenTargets.has(targetKey)) {
            mismatches.push(
                `${target.glyphName}/${target.layerId}: missing from Rust dump response`
            );
        }
    }

    if (mismatches.length === 0) {
        return false;
    }

    const error = new Error(
        'Committed keyboard glyph data did not reach the compiled worker state after the authoritative commit.\n' +
            'Keyboard edits are no longer recompiling the editing font on fresh data.\n' +
            'Reload the font or app before continuing.\n\n' +
            mismatches.join('\n')
    );
    sidebarErrorDisplay.showError(error, 'editing', { sticky: true });
    console.error(
        '[ChangeBridgeInit] Committed keyboard worker drift detected:',
        error.message
    );
    return true;
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
 * Update the Rust FONT_CACHE with the current layer data and
 * refresh the outline editor canvas. Call after undo/redo/remote
 * changes so the Rust interpolation reads up-to-date layer data.
 */
async function refreshRustWorkerCache(
    rootGlyphName?: string,
    editedGlyphName?: string,
    options?: {
        workerReplayTargets?: WorkerReplayTarget[];
        allowSelectedLayerFallback?: boolean;
    }
): Promise<void> {
    const gc = window.glyphCanvas;
    const oe = gc?.outlineEditor;
    const parsedStack = oe?.parseGlyphStack?.() || [];
    const refreshRootGlyphName =
        rootGlyphName ?? parsedStack[0]?.glyphName ?? undefined;
    const selectedLayerId = oe?.selectedLayerId ?? undefined;

    const currentFont = window.fontManager?.currentFont;
    if (!currentFont || !fontCompilation?.isInitialized) {
        return;
    }

    try {
        let didStoreLayer = false;
        const replayTargets = normalizeWorkerReplayTargets(
            options?.workerReplayTargets
        );
        const allowSelectedLayerFallback =
            options?.allowSelectedLayerFallback !== false;
        if (
            replayTargets.length > 0 &&
            typeof window.fontManager?.refreshWorkerCacheForReplayTargets ===
                'function'
        ) {
            didStoreLayer =
                (await window.fontManager.refreshWorkerCacheForReplayTargets(
                    replayTargets
                )) === true;
        }
        if (!didStoreLayer && selectedLayerId && allowSelectedLayerFallback) {
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

export async function syncRustCacheAndRefreshCanvas(
    rootGlyphName?: string,
    editedGlyphName?: string,
    options?: {
        skipDeferredCanvasRepaint?: boolean;
        workerReplayTargets?: WorkerReplayTarget[];
        allowSelectedLayerFallback?: boolean;
    }
): Promise<void> {
    const gc = window.glyphCanvas;
    const oe = gc?.outlineEditor;
    const parsedStack = oe?.parseGlyphStack?.() || [];
    const refreshRootGlyphName =
        rootGlyphName ?? parsedStack[0]?.glyphName ?? undefined;

    await refreshRustWorkerCache(rootGlyphName, editedGlyphName, options);

    await refreshCanvasFromCommittedModelSync(
        refreshRootGlyphName,
        editedGlyphName,
        options
    );
}

async function refreshCanvasFromCommittedModelSync(
    rootGlyphName?: string,
    editedGlyphName?: string,
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

            if (typeof gc.outlineEditor?.fetchLayerData === 'function') {
                await gc.outlineEditor.fetchLayerData(
                    true,
                    refreshRootGlyphName
                );
            }

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
            if (typeof gc.requestRepaintAfterCompile === 'function') {
                gc.requestRepaintAfterCompile();
            } else if (typeof gc.render === 'function') {
                gc.render();
            }
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

/**
 * Derive cascading recomposition targets from the directly edited layers.
 *
 * Delegates to the shared `computeLayerRecompositionClosure` so every
 * edit path uses the same dependency derivation logic.
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

    const closure = computeLayerRecompositionClosure({
        sourceTargets,
        editKinds: new Set(['outline', 'anchor', 'sidebearing', 'component']),
        scope: 'all',
        fontModel,
        activeLayerId: sourceLayerId,
        sourceGlyphName
    });

    return closure.dependentTargets;
}

export function waitForEditingFontCompileRevision(
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

/**
 * Route a committed edit through the single post-commit funnel.
 *
 * Delegates to CompiledEditFunnel.processCommittedEdit() which owns:
 *   - compile context management
 *   - editing compile wakeup
 *   - deferred full-compile timer (replaces scheduleFullCompileDebounce)
 *
 * The guard that previously blocked incremental compiles when
 * lastFullDataVersion >= changeVersion is removed.  The funnel always
 * processes — redundant compiles are prevented by recompileEditingFont's
 * own check (no-op when compileRequestVersion hasn't changed).
 */
async function requestCommittedEditingFontCompile(
    changeSource: string,
    editType?: CommittedCompileEditType,
    options?: {
        forceTrigger?: boolean;
        waitForCompletion?: boolean;
    }
): Promise<void> {
    return processCommittedEdit(changeSource, editType ?? null, options);
}

async function awaitCommittedWorkerCacheSettled(
    awaitWorkerSync: () => Promise<void>
): Promise<void> {
    await awaitWorkerSync();

    const fontManager = window.fontManager as
        | {
              workerCacheUpdatePromise?: Promise<void> | null;
              awaitWorkerCacheUpdate?: () => Promise<void>;
          }
        | undefined;

    if (typeof fontManager?.awaitWorkerCacheUpdate !== 'function') {
        return;
    }

    let awaitedPromise: Promise<void> | null = null;
    for (;;) {
        const pendingPromise = fontManager.workerCacheUpdatePromise ?? null;
        if (!pendingPromise || pendingPromise === awaitedPromise) {
            return;
        }

        awaitedPromise = pendingPromise;
        await fontManager.awaitWorkerCacheUpdate();
        await awaitWorkerSync();
    }
}

type LocalCommittedCompileContext = {
    changeSource: string;
    editType: CommittedCompileEditType;
};

type LocalUndoRedoVisualContext = {
    rootGlyphName?: string;
    requestedGlyphName?: string;
    editedGlyphName?: string | null;
    layerId?: string | null;
    previousWidth?: number | null;
};

function isUndoRedoCommittedPacket(entries: ChangeLogEntry[]): boolean {
    return entries.some(
        (entry) =>
            entry.historyAction === 'undo' || entry.historyAction === 'redo'
    );
}

function getFallbackUndoRedoCommittedEntries(
    historyItem: HistoryStackItem | null,
    action: 'undo' | 'redo',
    context?: LocalUndoRedoVisualContext
): ChangeLogEntry[] {
    const sourceEntries = historyItem?.entries?.length
        ? historyItem.entries[0].semanticChangeLogEntries?.length
            ? historyItem.entries[0].semanticChangeLogEntries
            : historyItem.entries
        : [];

    const fallbackTargets = collectReplayTargetsFromEntries(sourceEntries);
    if (!fallbackTargets.length && historyItem?.workerReplayTargets?.length) {
        fallbackTargets.push(
            ...normalizeWorkerReplayTargets(historyItem.workerReplayTargets)
        );
    }
    const fallbackTouchedPath = historyItem?.touchedPaths?.[0];
    const fallbackLayerTarget =
        fallbackTargets[0] ??
        (context?.editedGlyphName && context?.layerId
            ? {
                  glyphName: context.editedGlyphName,
                  layerId: context.layerId
              }
            : null);
    const fallbackLayerPath =
        fallbackTouchedPath ??
        (fallbackLayerTarget
            ? `glyphs.${fallbackLayerTarget.glyphName}.layers.${fallbackLayerTarget.layerId}`
            : undefined);

    return sourceEntries.map((entry) => {
        const entryTargets = normalizeWorkerReplayTargets(
            entry.workerReplayTargets
        );
        return {
            ...entry,
            transactionLabel:
                entry.transactionLabel ?? historyItem?.transactionLabel ?? null,
            path: entry.path ?? fallbackLayerPath,
            workerReplayTargets: entryTargets.length
                ? entryTargets
                : fallbackTargets,
            historyAction: action
        } as ChangeLogEntry;
    });
}

function buildHistoryItemFromCommittedEntries(
    entries: ChangeLogEntry[]
): HistoryStackItem {
    return {
        entries,
        transactionLabel: entries[0]?.transactionLabel ?? null,
        touchedPaths: entries
            .map((entry) => entry.path)
            .filter((path): path is string => !!path),
        workerReplayTargets: collectReplayTargetsFromEntries(entries)
    } as HistoryStackItem;
}

function inferPreviousWidthFromUndoRedoEntries(
    entries: ChangeLogEntry[],
    action: 'undo' | 'redo'
): number | null {
    for (const entry of entries) {
        const previousValue =
            action === 'undo'
                ? (entry.replayNewValue ?? entry.newValue)
                : (entry.replayOldValue ?? entry.oldValue);
        if (
            previousValue &&
            typeof previousValue === 'object' &&
            !Array.isArray(previousValue)
        ) {
            const width = Number(
                (previousValue as Record<string, unknown>).width
            );
            if (Number.isFinite(width)) {
                return width;
            }
        }
    }

    return null;
}

function applyLocalUndoRedoVisualSync(
    entries: ChangeLogEntry[],
    context?: LocalUndoRedoVisualContext
): void {
    if (!isUndoRedoCommittedPacket(entries)) {
        return;
    }

    const historyItem = buildHistoryItemFromCommittedEntries(entries);
    const action =
        entries.find(
            (entry) =>
                entry.historyAction === 'undo' || entry.historyAction === 'redo'
        )?.historyAction === 'redo'
            ? 'redo'
            : 'undo';
    const side = inferSidebearingSideFromHistoryItem(historyItem);
    const entryPaths = entries
        .map((entry) => entry.path)
        .filter((path): path is string => !!path);
    const editedGlyphName =
        getActiveEditedGlyphName() ??
        context?.editedGlyphName ??
        context?.requestedGlyphName ??
        deriveGlyphNamesFromPaths(entryPaths)[0] ??
        null;
    const layerId =
        context?.layerId ??
        entries
            .map((entry) =>
                entry.path ? deriveLayerId(getPathSegments(entry.path)) : null
            )
            .find((candidate): candidate is string => !!candidate) ??
        null;
    const previousWidth =
        context?.previousWidth ??
        inferPreviousWidthFromUndoRedoEntries(entries, action);

    const appliedSidebearingSync =
        !!side &&
        previousWidth !== null &&
        applyImmediateUndoSidebearingSync(
            editedGlyphName,
            layerId,
            historyItem,
            previousWidth,
            context?.editedGlyphName,
            context?.layerId
        );

    const liveAdvanceGlyphNames = new Set<string>();
    for (const glyphName of deriveGlyphNamesFromPaths(entryPaths)) {
        liveAdvanceGlyphNames.add(glyphName);
    }
    for (const target of collectReplayTargetsFromEntries(entries)) {
        liveAdvanceGlyphNames.add(target.glyphName);
    }
    for (const glyphName of [
        context?.rootGlyphName,
        context?.requestedGlyphName,
        context?.editedGlyphName,
        editedGlyphName,
        getActiveEditedGlyphName()
    ]) {
        if (glyphName) {
            liveAdvanceGlyphNames.add(glyphName);
        }
    }

    refreshLiveTextRunAdvances(liveAdvanceGlyphNames, layerId ?? undefined, {
        compensatePanX: true,
        workerReplayTargets: collectReplayTargetsFromEntries(entries)
    });

    syncImmediateUndoOutlineLayerFromModel(editedGlyphName, layerId);
}

function inferHistoryItemKerningEditType(
    historyItem: HistoryStackItem | null
): CommittedCompileEditType {
    if (!historyItem) {
        return null;
    }

    const transactionLabel = historyItem.transactionLabel ?? '';
    for (const path of historyItem.touchedPaths ?? []) {
        const editType = inferKerningEditTypeFromMetadata(
            transactionLabel,
            path
        );
        if (editType) {
            return editType;
        }
    }

    return inferKerningEditTypeFromMetadata(transactionLabel, '');
}

function resolveLocalCommittedCompileContext(
    entries: ChangeLogEntry[]
): LocalCommittedCompileContext {
    return inferCommittedEditTypeFromEntries(entries, 'local');
}

async function awaitCommittedEditingCompileReady(
    isUndoRedoPacket: boolean,
    awaitWorkerSync: () => Promise<void>
): Promise<boolean> {
    if (
        !isUndoRedoPacket ||
        !fontCompilation?.isInitialized ||
        typeof fontCompilation.hasWorkerCacheDocument !== 'function' ||
        fontCompilation.hasWorkerCacheDocument()
    ) {
        return true;
    }

    await awaitCommittedWorkerCacheSettled(awaitWorkerSync);
    return fontCompilation.hasWorkerCacheDocument();
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
 * Refresh glyph overview tiles from a seed glyph set so local live edits
 * and committed local/remote change packets share the same invalidation
 * logic for dependent composites and fallback rendering.
 */
export async function refreshGlyphOverviewFromGlyphNames(
    glyphNames: Iterable<string>,
    options?: {
        layerId?: string | null;
        forceImmediateRefresh?: boolean;
        fallbackToFullRender?: boolean;
    }
): Promise<void> {
    const changedGlyphNames = new Set<string>();
    for (const glyphName of glyphNames) {
        if (typeof glyphName === 'string' && glyphName.length > 0) {
            changedGlyphNames.add(glyphName);
        }
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
                    glyphNames: glyphNamesArray,
                    ...(options?.layerId
                        ? { layerId: options.layerId }
                        : undefined),
                    ...(options?.forceImmediateRefresh
                        ? { forceImmediateRefresh: true }
                        : undefined)
                }
            })
        );
        return;
    }

    if (options?.fallbackToFullRender !== false) {
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

/**
 * Refresh the glyph overview from committed change metadata so both
 * sender and receiver windows invalidate the same set of tiles.
 */
async function refreshGlyphOverviewFromCommittedEntries(
    entries: ChangeLogEntry[]
): Promise<void> {
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

    await refreshGlyphOverviewFromGlyphNames(changedGlyphNames, {
        fallbackToFullRender: true
    });
}

/**
 * Refresh committed changes through one post-commit funnel for both the
 * local sender and remote receivers. Remote packets still run their
 * receiver-only pan compensation before the shared compile + overview
 * refresh steps.
 */
export async function handleCommittedChangeRefresh(
    entries: ChangeLogEntry[],
    origin: CommittedChangeOrigin,
    dependencies?: {
        requestCompile?: (
            changeSource: string,
            editType?: CommittedCompileEditType
        ) => Promise<void>;
        queueCacheRefresh?: (
            rootGlyphName?: string,
            editedGlyphName?: string,
            options?: {
                skipDeferredCanvasRepaint?: boolean;
                workerReplayTargets?: WorkerReplayTarget[];
                allowSelectedLayerFallback?: boolean;
            }
        ) => Promise<void>;
        awaitWorkerSync?: () => Promise<void>;
        localCompileContext?: LocalCommittedCompileContext;
        localUndoRedoContext?: LocalUndoRedoVisualContext;
    }
): Promise<void> {
    if (origin === 'remote' && entries.length === 0) {
        return;
    }

    const isUndoRedoPacket = isUndoRedoCommittedPacket(entries);

    const requestCompile =
        dependencies?.requestCompile ??
        ((changeSource, editType) =>
            requestCommittedEditingFontCompile(changeSource, editType, {
                forceTrigger: origin === 'remote' || isUndoRedoPacket,
                waitForCompletion:
                    origin === 'remote' ||
                    (origin === 'local' && isUndoRedoPacket)
            }));
    const localCompileContext =
        origin === 'local'
            ? (dependencies?.localCompileContext ??
              resolveLocalCommittedCompileContext(entries))
            : null;

    if (origin === 'remote') {
        applyRemoteSidebearingVisualSync(entries);

        const awaitWorkerSync =
            dependencies?.awaitWorkerSync ??
            (() => fontCompilation.awaitWorkerDocumentSync());
        await awaitCommittedWorkerCacheSettled(awaitWorkerSync);

        const replayTargets = collectReplayTargetsFromEntries(entries);
        await refreshCanvasFromCommittedModelSync(undefined, undefined, {
            ...(replayTargets.length > 0
                ? { workerReplayTargets: replayTargets }
                : {})
        });

        const { editType, changeSource } = inferCommittedEditTypeFromEntries(
            entries,
            'remote'
        );
        if (
            !(await awaitCommittedEditingCompileReady(
                isUndoRedoPacket,
                awaitWorkerSync
            ))
        ) {
            return;
        }
        await requestCompile(changeSource, editType);
    } else {
        applyLocalUndoRedoVisualSync(
            entries,
            dependencies?.localUndoRedoContext
        );

        const awaitWorkerSync =
            dependencies?.awaitWorkerSync ??
            (() => fontCompilation.awaitWorkerDocumentSync());
        await awaitCommittedWorkerCacheSettled(awaitWorkerSync);

        if (
            await showCommittedKeyboardWorkerDriftIfNeeded(
                entries,
                localCompileContext
            )
        ) {
            await refreshGlyphOverviewFromCommittedEntries(entries);
            return;
        }

        const { editType, changeSource } =
            localCompileContext ?? resolveLocalCommittedCompileContext(entries);
        if (
            !(await awaitCommittedEditingCompileReady(
                isUndoRedoPacket,
                awaitWorkerSync
            ))
        ) {
            return;
        }
        await requestCompile(changeSource, editType);
    }

    await refreshGlyphOverviewFromCommittedEntries(entries);
}

export async function handleRemoteChangeRefresh(
    entries: ChangeLogEntry[],
    dependencies?: {
        requestCompile?: (
            changeSource: string,
            editType?: CommittedCompileEditType
        ) => Promise<void>;
        queueCacheRefresh?: (
            rootGlyphName?: string,
            editedGlyphName?: string,
            options?: {
                skipDeferredCanvasRepaint?: boolean;
                workerReplayTargets?: WorkerReplayTarget[];
                allowSelectedLayerFallback?: boolean;
            }
        ) => Promise<void>;
        awaitWorkerSync?: () => Promise<void>;
    }
): Promise<void> {
    await handleCommittedChangeRefresh(entries, 'remote', dependencies);
}

export function queueRustCacheAndRefreshCanvas(
    rootGlyphName?: string,
    editedGlyphName?: string,
    options?: {
        skipDeferredCanvasRepaint?: boolean;
        workerReplayTargets?: WorkerReplayTarget[];
    }
): Promise<void> {
    return enqueueBridgeSync(async () => {
        await syncRustCacheAndRefreshCanvas(
            rootGlyphName,
            editedGlyphName,
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
        const activeElement = document.activeElement;

        const fontInfoRoot = document.querySelector(
            '#view-fontinfo.focused'
        ) as HTMLElement | null;
        const fontInfoDetailBefore = fontInfoRoot?.querySelector<HTMLElement>(
            '.fontinfo-records-detail'
        );
        const fontInfoListBefore = fontInfoRoot?.querySelector<HTMLElement>(
            '.fontinfo-records-list'
        );
        const fontInfoRootScrollTop = fontInfoRoot?.scrollTop ?? null;
        const fontInfoRootScrollLeft = fontInfoRoot?.scrollLeft ?? null;
        const fontInfoDetailScrollTop = fontInfoDetailBefore?.scrollTop ?? null;
        const fontInfoDetailScrollLeft =
            fontInfoDetailBefore?.scrollLeft ?? null;
        const fontInfoListScrollTop = fontInfoListBefore?.scrollTop ?? null;
        const fontInfoListScrollLeft = fontInfoListBefore?.scrollLeft ?? null;
        const restoreFontInfoScroll = () => {
            if (!fontInfoRoot) {
                return;
            }

            const applyRestore = () => {
                if (fontInfoRootScrollTop !== null) {
                    fontInfoRoot.scrollTop = fontInfoRootScrollTop;
                }
                if (fontInfoRootScrollLeft !== null) {
                    fontInfoRoot.scrollLeft = fontInfoRootScrollLeft;
                }

                const detailAfter = fontInfoRoot.querySelector<HTMLElement>(
                    '.fontinfo-records-detail'
                );
                if (detailAfter) {
                    if (fontInfoDetailScrollTop !== null) {
                        detailAfter.scrollTop = fontInfoDetailScrollTop;
                    }
                    if (fontInfoDetailScrollLeft !== null) {
                        detailAfter.scrollLeft = fontInfoDetailScrollLeft;
                    }
                }

                const listAfter = fontInfoRoot.querySelector<HTMLElement>(
                    '.fontinfo-records-list'
                );
                if (listAfter) {
                    if (fontInfoListScrollTop !== null) {
                        listAfter.scrollTop = fontInfoListScrollTop;
                    }
                    if (fontInfoListScrollLeft !== null) {
                        listAfter.scrollLeft = fontInfoListScrollLeft;
                    }
                }
            };

            applyRestore();
            requestAnimationFrame(applyRestore);
            requestAnimationFrame(() => requestAnimationFrame(applyRestore));
            setTimeout(applyRestore, 0);
            setTimeout(applyRestore, 50);
            setTimeout(applyRestore, 150);
        };

        if (
            activeElement instanceof HTMLElement &&
            activeElement.classList.contains('fontinfo-axis-map-input')
        ) {
            activeElement.blur();
            restoreFontInfoScroll();
        }

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
        const localUndoRedoContext: LocalUndoRedoVisualContext = {
            rootGlyphName: refreshRootGlyphName,
            requestedGlyphName: glyphName,
            editedGlyphName,
            layerId: layerId ?? null,
            previousWidth
        };
        const committedGenerationBefore = committedChangeRefreshGeneration;
        pendingLocalUndoRedoContext = localUndoRedoContext;

        const appliedChange =
            action === 'redo'
                ? bridge.redo(targetGlyph, layerId, historyTargetKey)
                : bridge.undo(targetGlyph, layerId, historyTargetKey);

        if (!appliedChange) {
            if (pendingLocalUndoRedoContext === localUndoRedoContext) {
                pendingLocalUndoRedoContext = null;
            }
            restoreFontInfoScroll();
            return;
        }

        restoreFontInfoScroll();

        if (committedChangeRefreshGeneration !== committedGenerationBefore) {
            await committedChangeRefreshQueue;
            return;
        }

        if (pendingLocalUndoRedoContext === localUndoRedoContext) {
            pendingLocalUndoRedoContext = null;
        }

        const historyItem =
            appliedChange.historyItem as HistoryStackItem | null;
        const fallbackEntries = getFallbackUndoRedoCommittedEntries(
            historyItem,
            action,
            localUndoRedoContext
        );
        if (!fallbackEntries.length) {
            return;
        }

        await handleCommittedChangeRefresh(fallbackEntries, 'local', {
            localUndoRedoContext
        });
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
    //   • The forceFullRustSync/storeFontJson fallback has been eliminated —
    //     the worker's seedYdoc handler (init_ydoc_from_state) populates all
    //     caches from binary Yjs state, and incremental replay-target or
    //     selected-layer paths handle all post-edit/undo/redo cache refreshes.
    //   • For the next full compile, compileEditingFont rebuilds babelfontJson
    //     via syncBabelfontJsonFromCurrentModel() before invoking fontc.
    bridge.onAfterSync(() => {
        const fm = window.fontManager;
        if (!fm?.currentFont) return;

        // Reset compilation state so next compile is a clean full build
        fm.clearEditingCompileContext?.();
        // Mark babelfontJson as stale; it will be rebuilt lazily (see comment above).
        fm.pendingBabelfontJsonSyncAfterDrag = true;

        // Rebuild Font model from the patched babelfontData
        fm.currentFont.fontModel = Font.fromData(fm.currentFont.babelfontData);
        window.currentFontModel = fm.currentFont.fontModel;

        window.dispatchEvent(new CustomEvent('fontModelSync'));
    });

    // Wire dirty marking: when PatchSyncEngine records a change, also mark
    // the font as unsaved. The committed-change funnel owns editing compile
    // requests so every request carries packet-explicit context.
    bridge.onDirty(() => {
        const fontManager = window.fontManager;
        if (fontManager?.currentFont) {
            fontManager.currentFont.markDirty(undefined, {
                requestEditingCompile: false
            });
            void fontManager.updateDirtyIndicator();
            window.saveButton?.updateButtonState?.();
        }
    });

    // Route committed local and remote Yjs packets through one serialized
    // post-commit reaction funnel. Local edits enter immediately after the
    // authoritative Yjs packet is emitted; remote edits enter after apply.
    // YJS_ONLY: This funnel processes Yjs binary updates, not full
    // JSON. Entries carry workerReplayTargets for incremental layer cache updates.
    bridge.onCommittedChange((entries, context) => {
        const localCompileContext =
            context.origin === 'local'
                ? resolveLocalCommittedCompileContext(entries)
                : undefined;
        const localUndoRedoContext =
            context.origin === 'local' &&
            pendingLocalUndoRedoContext &&
            isUndoRedoCommittedPacket(entries)
                ? pendingLocalUndoRedoContext
                : undefined;
        if (localUndoRedoContext) {
            pendingLocalUndoRedoContext = null;
        }
        void enqueueCommittedChangeRefresh(() =>
            handleCommittedChangeRefresh(entries, context.origin, {
                ...(localCompileContext ? { localCompileContext } : {}),
                ...(localUndoRedoContext ? { localUndoRedoContext } : {})
            })
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
    // YJS_ONLY: Binary Yjs update forwarded to worker — no full JSON
    // crossing. changedGlyphs hint enables targeted Rust-side cache patching.
    bridge.setYjsWorkerCallback((update, changeLogEntries) => {
        if (!fontCompilation?.isInitialized) return;

        // Extract affected glyph names from the change-log entries so Rust can
        // perform a targeted partial update instead of a full JSON rebuild.
        // ChangeLogEntry.path uses dot-delimited format: "glyphs.A.layers.uuid.shapes.0.nodes"
        const changedGlyphs = deriveGlyphNamesFromPaths(
            changeLogEntries.map((e) => e.path).filter(Boolean)
        );
        const nonGlyphChangeHints =
            collectNonGlyphChangeHints(changeLogEntries);
        const layerTargets =
            collectWorkerLayerTargetsFromChangeLogEntries(changeLogEntries);
        const invalidateLayoutClosure =
            shouldInvalidateLayoutClosureForCommittedEntries(changeLogEntries);

        void window.fontManager?.forwardWorkerYjsUpdate?.(
            update,
            changedGlyphs,
            {
                invalidateLayoutClosure,
                nonGlyphChangeHints,
                ...(layerTargets.length ? { layerTargets } : undefined)
            }
        );

        if (fullFontCompilation.hasWorkerCacheDocument()) {
            void fullFontCompilation
                .sendMessage({
                    type: 'applyYjsUpdate',
                    update,
                    changedGlyphs,
                    nonGlyphChangeHints,
                    ...(layerTargets.length ? { layerTargets } : undefined),
                    invalidateLayoutClosure
                })
                .catch((error) => {
                    console.warn(
                        'Failed to mirror Yjs update to full compile worker',
                        error
                    );
                    fullFontCompilation.setWorkerCacheDocumentReady(false);
                });
        }
    });

    // Seed the Rust Y.Doc immediately after bridge initialisation so that the
    // YJS_ONLY: Binary Yjs state sent to worker for seedYdoc (N3).
    if (
        !window.windowRole?.isLinkedWindow?.() &&
        fontCompilation?.isInitialized
    ) {
        // Use the bridge state (array-format nodes) — Rust now accepts arrays
        // natively via the updated serde deserialization.
        const fontManager = window.fontManager as
            | (typeof window.fontManager & {
                  buildWorkerSeedYjsState?: () => Uint8Array | null;
              })
            | undefined;
        const state = fontManager?.buildWorkerSeedYjsState?.();
        if (!state?.length) {
            console.warn(
                'Failed to build worker seed Yjs state for initial worker seed'
            );
            fontCompilation.setWorkerCacheDocumentReady(false);
        } else {
            fontManager?.replaceWorkerYjsMirrorFromState?.(state);
            void fontCompilation
                .sendMessage({
                    type: 'seedYdoc',
                    state
                })
                .catch((error) => {
                    console.warn(
                        'Failed to seed worker Y.Doc after bridge init',
                        error
                    );
                    fontCompilation.setWorkerCacheDocumentReady(false);
                });
        }
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
