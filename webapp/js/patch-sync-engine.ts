/**
 * PatchSyncEngine — Central patch-driven sync processor.
 *
 * Every mutation to the babelfont model goes through this class.
 * It keeps a Yjs Y.Doc in sync with the JSON, manages per-glyph
 * UndoManagers, maintains the change log, and broadcasts updates
 * to other windows via BroadcastChannel.
 */

import * as Y from 'yjs';
import {
    jsonToYDoc,
    yDocToJson,
    fromYType,
    toYType,
    setYPath,
    deleteYPath,
    getYPath,
    setJsonPath,
    deleteJsonPath,
    getJsonPath,
    INDEXED_MAP_KEYS,
    diffYArray,
    applyIndexedMapArray as applyIndexedMapArrayToYMap
} from './change-bridge-ydoc';
import {
    buildHistoryStackItems,
    type ChangeLogEntry,
    type ChangeOp,
    type HistoryStackItem,
    type UndoScope,
    type WorkerReplayTarget,
    createLogEntry,
    deriveGlyphName,
    deriveLayerId,
    deriveGlyphNameFromPath,
    deriveGlyphNamesFromPaths,
    deriveLayerIdFromPath,
    deriveLayerIdsFromPaths,
    deriveObjectInfoFromPath,
    getPathSegments,
    joinPathWithGlyphSeparator,
    normalizeWorkerReplayTargets,
    normalizeChangeLogEntry,
    resolveHistoryTargetItem,
    resetLogCounter
} from './change-log';
import { Logger } from './logger';
import {
    collaborationMessageKey,
    createChangeLogEntriesFromCollaborationMessageEnvelope,
    createCollaborationMessageEnvelopeFromChangeLogEntries,
    type CollaborationMessageEnvelope,
    type DerivedForwardChange
} from './collaboration-message';
import { windowRole } from './window-role';

const console = new Logger('PatchSyncEngine');

type Unsafe = ReturnType<typeof JSON.parse>;
type YjsUpdate = Uint8Array<ArrayBufferLike>;

export type { ChangeLogEntry } from './change-log';

export type LocalUpdateListener = (
    update: YjsUpdate,
    collaborationMessage?: CollaborationMessageEnvelope | null,
    changeLogEntries?: ChangeLogEntry[]
) => void;

export type CommittedChangeOrigin = 'local' | 'remote';

export type CommittedChangeListener = (
    entries: ChangeLogEntry[],
    context: {
        origin: CommittedChangeOrigin;
        update: YjsUpdate;
    }
) => void;

export class MetadataFreeRemoteUpdateError extends Error {
    constructor() {
        super(
            'Refusing metadata-free non-noop remote Yjs update; semantic metadata is required for scoped model and compile convergence'
        );
        this.name = 'MetadataFreeRemoteUpdateError';
    }
}

export type CollaborationLogItem = {
    id: string;
    direction: 'local' | 'remote';
    timestamp: number;
    transactionDurationMs: number | null;
    summary: string;
    label: string | null;
    source: string;
    editSource: string | null;
    windowId: string | null;
    windowRoleLabel: string;
    historyItemId: string;
    historyAction: 'change' | 'undo' | 'redo';
    targetHistoryItemId: string | null;
    undoScope: UndoScope;
    updateByteLength: number;
    updateBase64Preview: string;
    changedGlyphNames: string[];
    changedLayerIds: string[];
    workerReplayTargets: WorkerReplayTarget[];
    changes: CollaborationMessageEnvelope['changes'];
    derivedForwardChanges: DerivedForwardChange[];
};

type SyntheticChangeOperation = {
    op: ChangeOp;
    path: (string | number)[];
    oldValue: unknown;
    newValue: unknown;
    editSource?: string | null;
    compileChangeSource?: string | null;
    compileEditType?: string | null;
    visualAnchorSide?: 'left' | 'right' | null;
    workerReplayTargets?: WorkerReplayTarget[];
};

export type BatchApplyMode = 'default' | 'glyph-snapshot' | 'layer-snapshot';

export type TransactionBufferedOperation = SyntheticChangeOperation & {
    applyPath?: (string | number)[];
    applyOldValue?: unknown;
    applyNewValue?: unknown;
    applyMode?: BatchApplyMode;
};

export type TransactionCommitResult = {
    changeLogEntries: ChangeLogEntry[];
    workerReplayTargets: WorkerReplayTarget[];
    changedGlyphNames: string[];
    changedLayerIds: string[];
};

type TransactionFinalizer = (
    operations: TransactionBufferedOperation[],
    context: {
        label: string | null;
        transactionId: number | null;
        historyItemId: string | null;
        historyTarget: TransactionHistoryTarget | null;
    }
) => TransactionBufferedOperation[] | null | undefined;

/**
 * Origin token used by Yjs transactions that represent same-user edits.
 * Linked windows should all be able to undo these changes.
 */
const USER_EDIT_ORIGIN = 'user-edit';
const SYSTEM_REMOTE_ORIGIN = 'system-remote';
const HISTORY_REPLAY_ORIGIN = 'history-replay';
const FONT_EDIT_ORIGIN = 'font-edit';
const GLYPH_EDIT_ORIGIN = 'glyph-edit';
const LAYER_EDIT_ORIGIN_PREFIX = 'layer-edit:';

type UndoTarget = {
    glyphName: string | null;
    layerId: string | null;
};

type UndoHistoryStacks = {
    active: string[];
    undone: string[];
};

type ResolvedUndoHistorySource = {
    historyItemId: string | null;
    historyItem: HistoryStackItem | null;
};

const FONT_UNDO_HISTORY_KEY = '__font-undo-history__';

function removeHistoryItemFromStack(stack: string[], itemId: string): void {
    const index = stack.lastIndexOf(itemId);
    if (index >= 0) {
        stack.splice(index, 1);
    }
}

function cloneChangeLogEntryForHistoryAction(
    entry: ChangeLogEntry,
    historyAction: 'undo' | 'redo',
    targetHistoryItemId: string | null,
    timestamp: number,
    windowId: string,
    windowRoleLabel: string
): ChangeLogEntry {
    const { semanticChangeLogEntries: _semanticChangeLogEntries, ...fields } =
        entry;
    return normalizeChangeLogEntry({
        ...fields,
        timestamp,
        windowId,
        windowRoleLabel,
        historyAction,
        targetHistoryItemId,
        transactionId: null
    });
}

function getSemanticEntriesForHistoryItem(
    item: HistoryStackItem | null | undefined,
    historyAction: 'undo' | 'redo',
    targetHistoryItemId: string | null,
    timestamp: number,
    windowId: string,
    windowRoleLabel: string
): ChangeLogEntry[] | null {
    const sourceEntries = item?.entries?.length
        ? item.entries[0].semanticChangeLogEntries?.length
            ? item.entries[0].semanticChangeLogEntries
            : item.entries
        : null;
    if (!sourceEntries?.length) {
        return null;
    }
    return sourceEntries.map((itemEntry) =>
        cloneChangeLogEntryForHistoryAction(
            itemEntry,
            historyAction,
            targetHistoryItemId,
            timestamp,
            windowId,
            windowRoleLabel
        )
    );
}

function getEffectiveEmissionEntries(
    changeLogEntries: ChangeLogEntry[]
): ChangeLogEntry[] {
    const semanticEntries = changeLogEntries.flatMap(
        (entry) => entry.semanticChangeLogEntries ?? []
    );
    return semanticEntries.length ? semanticEntries : changeLogEntries;
}

type HistoryTarget = {
    type: 'feature' | 'class' | 'prefix';
    key: string;
    label: string;
};

export type TransactionHistoryTarget = {
    type: 'feature' | 'class' | 'prefix';
    key: string;
    label: string;
};

export type UndoRedoResult = {
    scope: UndoScope;
    glyphName: string | null;
    layerId: string | null;
    historyItem: HistoryStackItem | null;
};

type UndoManagerWithScope = {
    manager: Y.UndoManager | null;
    scope: UndoScope;
};

type LayerFingerprintTarget = {
    glyphName: string;
    layerId: string;
};

type LayerFingerprintSnapshotEntry = LayerFingerprintTarget & {
    fingerprint: string | null;
};

function getLayerManagerKey(glyphName: string, layerId: string): string {
    return `${glyphName}@@${layerId}`;
}

function getLayerEditOrigin(glyphName: string, layerId: string): string {
    return `${LAYER_EDIT_ORIGIN_PREFIX}${glyphName}@@${layerId}`;
}

function getLayerFingerprintTargetKey(
    glyphName: string,
    layerId: string
): string {
    return `${glyphName}@@${layerId}`;
}

function normalizeLayerSignatureNodeType(nodeType: unknown): string {
    switch (nodeType) {
        case 'Move':
        case 'Line':
        case 'OffCurve':
        case 'Curve':
        case 'QCurve':
            return nodeType;
        default:
            return String(nodeType || 'Unknown');
    }
}

function getComponentReferenceFromShape(shape: Unsafe): string {
    if (!shape || typeof shape !== 'object') {
        return '';
    }

    if (
        'Component' in shape &&
        shape.Component &&
        typeof shape.Component === 'object'
    ) {
        return String((shape.Component as Unsafe).reference || '');
    }

    return String(shape.reference || '');
}

function getPathLikeShape(shape: Unsafe): Unsafe | null {
    if (!shape || typeof shape !== 'object') {
        return null;
    }

    if ('Path' in shape && shape.Path && typeof shape.Path === 'object') {
        return shape.Path as Unsafe;
    }

    if (Array.isArray(shape.nodes)) {
        return shape;
    }

    return null;
}

function getLayerFingerprintFromJson(layerJson: Unsafe): string | null {
    if (!layerJson || typeof layerJson !== 'object') {
        return null;
    }

    const shapes = Array.isArray(layerJson.shapes) ? layerJson.shapes : [];
    const anchors = Array.isArray(layerJson.anchors) ? layerJson.anchors : [];

    const componentSignatures = shapes
        .filter(
            (shape: unknown) =>
                !!shape &&
                typeof shape === 'object' &&
                ('Component' in shape || 'reference' in shape)
        )
        .map(
            (shape: unknown) =>
                `C:${getComponentReferenceFromShape(shape as Unsafe)}`
        );

    const pathSignatures = shapes
        .map((shape: unknown) => getPathLikeShape(shape as Unsafe))
        .filter((shape: Unsafe | null): shape is Unsafe => Boolean(shape))
        .map((pathShape: Unsafe) => {
            const nodes = Array.isArray(pathShape.nodes) ? pathShape.nodes : [];
            const nodeTypes = nodes.map((node: unknown) =>
                normalizeLayerSignatureNodeType((node as Unsafe)?.nodetype)
            );
            const closedFlag = pathShape.closed === false ? '0' : '1';
            return `P:${closedFlag}:${nodeTypes.length}:${nodeTypes.join(',')}`;
        });

    const anchorSignatures = anchors
        .map((anchor: unknown) => `A:${String((anchor as Unsafe)?.name || '')}`)
        .sort((a: string, b: string) => a.localeCompare(b));

    return [
        `components[${componentSignatures.join('|')}]`,
        `paths[${pathSignatures.join('|')}]`,
        `anchors[${anchorSignatures.join('|')}]`
    ].join(';');
}

/**
 * Central patch processor that keeps Yjs Y.Doc in sync with the
 * babelfont JSON object model.
 */
export class PatchSyncEngine {
    /** The Yjs document */
    readonly yDoc: Y.Doc;
    /** Root font map inside Y.Doc */
    readonly fontMap: Y.Map<unknown>;
    /** Per-glyph undo managers (keyed by glyph name) */
    private _undoManagers = new Map<string, Y.UndoManager>();
    /** Per-layer undo managers (keyed by glyph@@layer) */
    private _layerUndoManagers = new Map<
        string,
        { manager: Y.UndoManager; target: Y.Map<unknown> }
    >();
    /** "Font-level" undo manager for axes/masters/instances/font properties */
    private _fontUndoManager: Y.UndoManager | null = null;
    /** Local history-item stacks aligned with each undo-manager scope */
    private _undoHistoryStacks = new Map<string, UndoHistoryStacks>();
    /** Change log of all recorded changes */
    private _changeLog: ChangeLogEntry[] = [];
    /** Unique window identifier */
    readonly windowId: string;
    /** Reference to the raw babelfont JSON (the one babelfont-model.ts wraps) */
    private _fontJson: Record<string, Unsafe> | null = null;
    /** Transaction nesting depth */
    private _txDepth = 0;
    /** Current transaction label (outermost) */
    private _txLabel: string | null = null;
    /** Current transaction ID */
    private _txId: number | null = null;
    /** Wall-clock start time for the outermost transaction. */
    private _txStartTimeMs: number | null = null;
    /** Next transaction ID counter */
    private _nextTxId = 1;
    /** Next logical history item counter */
    private _nextHistoryItemId = 1;
    /** Current transaction-level history item ID */
    private _txHistoryItemId: string | null = null;
    /** Optional explicit history target for the current transaction */
    private _txHistoryTarget: TransactionHistoryTarget | null = null;
    /** Compact state-vector captured at the start of the outermost transaction. */
    private _txStartStateVector: Uint8Array | null = null;
    /** Buffered operations for the current outermost transaction */
    private _txBufferedOperations: TransactionBufferedOperation[] = [];
    /** Flag: currently applying remote update (suppress outbound broadcast) */
    private _isApplyingRemote = false;

    /**
     * Optional callback that receives every Yjs binary update (local and
     * remote) together with the ChangeLogEntry list so the compilation worker
     * can maintain its own Y.Doc without receiving the full font JSON on every
     * edit. Set via `setYjsWorkerCallback`.
     */
    private _yjsWorkerCallback:
        | ((update: YjsUpdate, changeLogEntries: ChangeLogEntry[]) => void)
        | null = null;
    /** Flag: suppress Y.Doc sync (during initFromJson) */
    private _isSyncing = false;
    /** Callback when a remote change arrives (for UI refresh) */
    private _onRemoteChange: ((entries: ChangeLogEntry[]) => void) | null =
        null;
    /** Flat log of local and remote collaboration messages */
    private _collaborationLog: CollaborationLogItem[] = [];
    /** Callback when the Y.Doc is updated locally (for broadcasting) */
    private _localUpdateListeners: Set<LocalUpdateListener> = new Set();
    /** Callbacks for committed local/remote changes after Yjs apply */
    private _committedChangeListeners: Set<CommittedChangeListener> = new Set();
    /** Callback to trigger dirty marking on the font manager side */
    private _onDirty: (() => void) | null = null;
    /** Callback after _syncJsonFromYDoc (undo/redo/remote) for external resync */
    private _onAfterSync: (() => void) | null = null;
    /** Suppress recording (used during undo/redo application) */
    private _suppressRecording = false;
    /** Index into _changeLog marking the last entry broadcast to peers */
    private _lastBroadcastLogIndex = 0;
    /** Index into _changeLog marking the last entry emitted to local-update listeners */
    private _lastLocalUpdateLogIndex = 0;
    /** Monotonic local sequence for emitted collaboration messages */
    private _nextCollaborationMessageSequence = 1;
    /** Subscribers for same-tab history UI updates */
    private _changeLogListeners = new Set<
        (entries: ChangeLogEntry[]) => void
    >();
    /** Subscribers for the flat collaboration message inspector */
    private _collaborationLogListeners = new Set<
        (items: CollaborationLogItem[]) => void
    >();
    /** Optional callback that can append derived operations before commit */
    private _transactionFinalizer: TransactionFinalizer | null = null;
    /** Suppress raw yDoc.on('update') broadcasting while emitting canonical diffs manually. */
    private _suppressAutomaticLocalUpdateEmission = false;
    /**
     * Compact Yjs state-vector (one clock entry per client, typically < 100 bytes)
     * captured after each local or remote Y.Doc mutation. Used to compute the
     * minimal incremental diff for outbound broadcasts without serialising the
     * entire font document.
     */
    private _lastBroadcastStateVector: Uint8Array = new Uint8Array(0);

    /**
     * Fast deep equality that is deterministic about object key order
     * (same semantics as the old _stableStringify comparison) but avoids
     * building intermediate normalized objects and stringifying.
     * Short-circuits on the first difference.
     */
    private _isDeepEqual(a: unknown, b: unknown): boolean {
        if (a === b) return true;
        if (typeof a !== typeof b) return false;
        if (a === null || b === null) return a === b;
        if (typeof a !== 'object') return a === b;

        if (Array.isArray(a)) {
            if (!Array.isArray(b) || a.length !== b.length) {
                return false;
            }
            for (let i = 0; i < a.length; i++) {
                if (!this._isDeepEqual(a[i], b[i])) return false;
            }
            return true;
        }

        if (Array.isArray(b)) return false;

        const aObj = a as Record<string, unknown>;
        const bObj = b as Record<string, unknown>;
        const aKeys = Object.keys(aObj).sort();
        const bKeys = Object.keys(bObj).sort();
        if (aKeys.length !== bKeys.length) return false;
        for (let i = 0; i < aKeys.length; i++) {
            if (aKeys[i] !== bKeys[i]) return false;
            if (!this._isDeepEqual(aObj[aKeys[i]], bObj[bKeys[i]])) {
                return false;
            }
        }
        return true;
    }
    private _getWindowRoleLabel(): string {
        return window.windowRole?.getRoleLabel() ?? windowRole.getRoleLabel();
    }

    private _createHistoryItemId(): string {
        return `history-item-${this._nextHistoryItemId++}`;
    }

    private _getCurrentHistoryItemId(): string {
        return this._txHistoryItemId ?? this._createHistoryItemId();
    }

    private _collectLayerFingerprintSnapshot(
        targets?: LayerFingerprintTarget[] | null
    ): Map<string, LayerFingerprintSnapshotEntry> {
        const snapshot = new Map<string, LayerFingerprintSnapshotEntry>();
        const glyphs = (this._fontJson as Unsafe)?.glyphs;
        if (!Array.isArray(glyphs)) {
            return snapshot;
        }

        // Targeted fast path: when the caller scoped this to a small set of
        // (glyph, layer) pairs, do an indexed lookup instead of iterating
        // every glyph and every layer in the font. For 1058 glyphs with
        // ~5 layers each, this is the difference between 5000+ iterations
        // and N (typically 1-20) per call. _syncJsonFromYDoc fires this
        // twice (before/after) on every Yjs sync (undo, remote, scoped).
        if (targets?.length) {
            // Build glyph-name → glyph index once. Build lazily so we only
            // pay the O(glyphs) cost on the first miss; if every target's
            // glyph is at the head of the array, we can avoid even that.
            let glyphIndex: Map<string, Unsafe> | null = null;
            const ensureGlyphIndex = (): Map<string, Unsafe> => {
                if (glyphIndex) return glyphIndex;
                const idx = new Map<string, Unsafe>();
                for (const glyph of glyphs) {
                    const name =
                        typeof glyph?.name === 'string' ? glyph.name : null;
                    if (name && !idx.has(name)) {
                        idx.set(name, glyph);
                    }
                }
                glyphIndex = idx;
                return idx;
            };

            const dedupe = new Set<string>();
            for (const target of targets) {
                const glyphName = target?.glyphName;
                const layerId = target?.layerId;
                if (!glyphName || !layerId) continue;

                const targetKey = getLayerFingerprintTargetKey(
                    glyphName,
                    layerId
                );
                if (dedupe.has(targetKey)) continue;
                dedupe.add(targetKey);

                const glyph = ensureGlyphIndex().get(glyphName);
                if (!glyph) continue;

                const layers = Array.isArray(glyph.layers) ? glyph.layers : [];
                // Layer counts per glyph are tiny (typically 1-10). A linear
                // find here is faster than building a per-glyph index.
                const layer = layers.find(
                    (l: Unsafe) => typeof l?.id === 'string' && l.id === layerId
                );
                if (!layer) continue;

                snapshot.set(targetKey, {
                    glyphName,
                    layerId,
                    fingerprint: getLayerFingerprintFromJson(layer)
                });
            }
            return snapshot;
        }

        // Untargeted path: full font scan. Used for full Yjs rebuilds.
        for (const glyph of glyphs) {
            const glyphName =
                typeof glyph?.name === 'string' ? glyph.name : null;
            if (!glyphName) {
                continue;
            }

            const layers = Array.isArray(glyph.layers) ? glyph.layers : [];
            for (const layer of layers) {
                const layerId = typeof layer?.id === 'string' ? layer.id : null;
                if (!layerId) {
                    continue;
                }

                const targetKey = getLayerFingerprintTargetKey(
                    glyphName,
                    layerId
                );
                snapshot.set(targetKey, {
                    glyphName,
                    layerId,
                    fingerprint: getLayerFingerprintFromJson(layer)
                });
            }
        }

        return snapshot;
    }

    private _emitLayerFingerprintChangedEvents(
        previousSnapshot: Map<string, LayerFingerprintSnapshotEntry>,
        nextSnapshot: Map<string, LayerFingerprintSnapshotEntry>
    ): void {
        if (typeof window === 'undefined') {
            return;
        }

        const targetKeys = new Set<string>([
            ...previousSnapshot.keys(),
            ...nextSnapshot.keys()
        ]);

        for (const targetKey of targetKeys) {
            const previous = previousSnapshot.get(targetKey) ?? null;
            const next = nextSnapshot.get(targetKey) ?? null;
            const previousFingerprint = previous?.fingerprint ?? null;
            const nextFingerprint = next?.fingerprint ?? null;

            if (previousFingerprint === nextFingerprint) {
                continue;
            }

            const glyphName = next?.glyphName ?? previous?.glyphName;
            const layerId = next?.layerId ?? previous?.layerId;
            if (!glyphName || !layerId) {
                continue;
            }

            window.dispatchEvent(
                new CustomEvent('layerFingerprintChanged', {
                    detail: {
                        glyphName,
                        layerId
                    }
                })
            );
        }
    }

    constructor(windowId?: string) {
        this.windowId = windowId ?? windowRole.instanceId;
        this.yDoc = new Y.Doc({ gc: false });
        this.fontMap = this.yDoc.getMap('font');

        // Listen for Y.Doc updates.
        // Only broadcast updates whose origin is a known local edit origin.
        // Yjs CRDT reconciliation updates have origin=undefined and must NOT
        // be broadcast, or they create a ping-pong echo loop between windows.
        const LOCAL_EDIT_ORIGINS: Set<string> = new Set([
            USER_EDIT_ORIGIN,
            FONT_EDIT_ORIGIN,
            GLYPH_EDIT_ORIGIN,
            HISTORY_REPLAY_ORIGIN
        ]);
        const isLocalEditOrigin = (origin: unknown): boolean => {
            if (typeof origin !== 'string') return false;
            if (LOCAL_EDIT_ORIGINS.has(origin)) return true;
            if (origin.startsWith(LAYER_EDIT_ORIGIN_PREFIX)) return true;
            return false;
        };
        this.yDoc.on('update', (update: YjsUpdate, origin: unknown) => {
            if (
                isLocalEditOrigin(origin) &&
                !this._isApplyingRemote &&
                !this._suppressAutomaticLocalUpdateEmission
            ) {
                this._emitRawLocalUpdate(update);
            }
        });
    }

    private _emitRawLocalUpdate(update: YjsUpdate): void {
        if (!update.length) {
            this._lastLocalUpdateLogIndex = this._changeLog.length;
            this._lastBroadcastStateVector = Y.encodeStateVector(this.yDoc);
            return;
        }

        this._emitLocalUpdate(
            update,
            this._getNewChangeLogEntriesForLocalUpdate()
        );
        this._lastBroadcastStateVector = Y.encodeStateVector(this.yDoc);
    }

    private _emitLocalUpdate(
        update: YjsUpdate,
        changeLogEntries: ChangeLogEntry[]
    ): void {
        // Undo/redo may append a coarse control entry for history-stack state,
        // but every emitted Yjs packet must still be observed through the same
        // semantic metadata shape as the original forward edit. Unwrap control
        // rows here so worker/cache/compile/broadcast consumers never need an
        // undo-specific path.
        const emissionEntries = getEffectiveEmissionEntries(changeLogEntries);
        const collaborationMessage =
            createCollaborationMessageEnvelopeFromChangeLogEntries(
                emissionEntries,
                {
                    localSequence: this._nextCollaborationMessageSequence++,
                    source: 'change-bridge',
                    windowId: this.windowId
                }
            );
        if (collaborationMessage) {
            this._appendCollaborationLogItems([
                this._createCollaborationLogItem(
                    collaborationMessage,
                    update,
                    'local',
                    this._deriveForwardChangesFromChangeLogEntries(
                        emissionEntries
                    )
                )
            ]);
        }
        for (const cb of this._localUpdateListeners) {
            cb(update, collaborationMessage, emissionEntries);
        }
        this._yjsWorkerCallback?.(update, emissionEntries);
        for (const cb of this._committedChangeListeners) {
            cb(emissionEntries, { origin: 'local', update });
        }
    }

    private _emitCanonicalLocalUpdateSince(
        previousStateVector: Uint8Array
    ): void {
        // Compute only the operations added since previousStateVector — no need
        // to allocate two temporary Y.Doc instances; the live yDoc IS the current
        // state, so we just diff against the stored state vector.
        const incrementalUpdate = Y.encodeStateAsUpdate(
            this.yDoc,
            previousStateVector
        );
        this._lastBroadcastStateVector = Y.encodeStateVector(this.yDoc);

        if (incrementalUpdate.length === 0) {
            this._lastLocalUpdateLogIndex = this._changeLog.length;
            return;
        }

        this._emitLocalUpdate(
            incrementalUpdate,
            this._getNewChangeLogEntriesForLocalUpdate()
        );
    }

    private _emitCanonicalLocalUpdateFromBaseline(): void {
        this._emitCanonicalLocalUpdateSince(this._lastBroadcastStateVector);
    }

    getFontJsonSnapshot(): Record<string, Unsafe> | null {
        return this._fontJson;
    }

    // ── Lifecycle ────────────────────────────────────────────────

    /**
     * Initialize the Y.Doc from the current babelfont JSON.
     * Call this once after a font is loaded.
     */
    initFromJson(fontJson: Record<string, Unsafe>): void {
        // FULLJSON_UNNECESSARY (U8, low priority): Populates the Y.Doc from
        // the font JSON loaded by open_font_file. Could theoretically be done
        // in Rust via seedYdoc, but the JSON is already in JS memory here.
        this._fontJson = fontJson;
        this._isSyncing = true;
        this.yDoc.transact(() => {
            // Clear existing content
            this.fontMap.forEach((_v: unknown, k: string) => {
                this.fontMap.delete(k);
            });
            jsonToYDoc(fontJson, this.fontMap);
        }, USER_EDIT_ORIGIN);
        this._isSyncing = false;
        this._setupFontUndoManager();
        this._lastBroadcastStateVector = Y.encodeStateVector(this.yDoc);
    }

    /**
     * Set the font JSON reference without populating the Y.Doc.
     * Used by sync (secondary) windows that will receive the Y.Doc
     * state from a peer via applyFullState().
     */
    setFontJson(fontJson: Record<string, Unsafe>): void {
        this._fontJson = fontJson;
    }

    /** Register a callback for when a remote change modifies local JSON. */
    onRemoteChange(cb: (entries: ChangeLogEntry[]) => void): void {
        this._onRemoteChange = cb;
    }

    onCollaborationLogUpdate(
        cb: (items: CollaborationLogItem[]) => void
    ): () => void {
        this._collaborationLogListeners.add(cb);
        cb(this.getCollaborationLog());
        return () => {
            this._collaborationLogListeners.delete(cb);
        };
    }

    /** Register a callback for local Y.Doc updates (for broadcasting). */
    onLocalUpdate(cb: LocalUpdateListener): void {
        this._localUpdateListeners.add(cb);
    }

    /** Unregister a callback previously passed to onLocalUpdate. */
    offLocalUpdate(cb: LocalUpdateListener): void {
        this._localUpdateListeners.delete(cb);
    }

    /** Register a callback for committed local and remote changes. */
    onCommittedChange(cb: CommittedChangeListener): void {
        this._committedChangeListeners.add(cb);
    }

    /** Unregister a callback previously passed to onCommittedChange. */
    offCommittedChange(cb: CommittedChangeListener): void {
        this._committedChangeListeners.delete(cb);
    }

    /** Register a callback to mark the font as dirty. */
    onDirty(cb: () => void): void {
        this._onDirty = cb;
    }

    /** Register a callback for after _syncJsonFromYDoc (undo/redo/remote). */
    onAfterSync(cb: () => void): void {
        this._onAfterSync = cb;
    }

    setTransactionFinalizer(cb: TransactionFinalizer | null): void {
        this._transactionFinalizer = cb;
    }

    /** Clean up resources. */
    destroy(): void {
        for (const entry of this._layerUndoManagers.values()) {
            entry.manager.destroy();
        }
        this._layerUndoManagers.clear();
        for (const um of this._undoManagers.values()) {
            um.destroy();
        }
        this._undoManagers.clear();
        this._fontUndoManager?.destroy();
        this._fontUndoManager = null;
        this._undoHistoryStacks.clear();
        this.yDoc.destroy();
        this._fontJson = null;
        this._changeLog = [];
        this._collaborationLog = [];
        this._onRemoteChange = null;
        this._localUpdateListeners.clear();
        this._committedChangeListeners.clear();
        this._onDirty = null;
        this._onAfterSync = null;
        this._changeLogListeners.clear();
        this._collaborationLogListeners.clear();
        this._transactionFinalizer = null;
        this._txStartTimeMs = null;
        this._lastBroadcastStateVector = new Uint8Array(0);
    }

    onChangeLogUpdate(cb: (entries: ChangeLogEntry[]) => void): () => void {
        this._changeLogListeners.add(cb);
        cb(this.getChangeLog());
        return () => {
            this._changeLogListeners.delete(cb);
        };
    }

    // ── Change recording ─────────────────────────────────────────

    /**
     * Record a property change. Called by model setters.
     *
     * @param path   Array path from font root, e.g. ["glyphs","A","layers","uuid","width"]
     * @param prop   Terminal property name, e.g. "width"
     * @param oldVal Previous value
     * @param newVal New value
     */
    recordChange(
        path: (string | number)[],
        prop: string,
        oldVal: unknown,
        newVal: unknown
    ): void {
        if (this._suppressRecording || this._isSyncing) return;

        const fullPath = [...path, prop];
        this._queueOrCommitOperations([
            {
                op: 'set',
                path: fullPath,
                oldValue: cloneHistoryValue(oldVal),
                newValue: cloneHistoryValue(newVal)
            }
        ]);
    }

    /**
     * Record an add operation (new glyph, layer, shape, etc.).
     */
    recordAdd(path: (string | number)[], value: unknown): void {
        if (this._suppressRecording || this._isSyncing) return;

        this._queueOrCommitOperations([
            {
                op: 'add',
                path,
                oldValue: undefined,
                newValue: cloneHistoryValue(value)
            }
        ]);
    }

    /**
     * Record a remove operation.
     */
    recordRemove(path: (string | number)[], oldValue: unknown): void {
        if (this._suppressRecording || this._isSyncing) return;

        this._queueOrCommitOperations([
            {
                op: 'remove',
                path,
                oldValue: cloneHistoryValue(oldValue),
                newValue: undefined
            }
        ]);
    }

    applySyntheticChangeSet(
        label: string,
        operations: SyntheticChangeOperation[]
    ): void {
        if (
            !operations.length ||
            !this._fontJson ||
            this._suppressRecording ||
            this._isSyncing
        ) {
            return;
        }

        if (!operations.some((operation) => operation.path.length > 0)) {
            return;
        }

        this._queueOrCommitOperations(
            operations.map((operation) => ({
                op: operation.op,
                path: operation.path,
                oldValue: cloneHistoryValue(operation.oldValue),
                newValue: cloneHistoryValue(operation.newValue),
                visualAnchorSide: operation.visualAnchorSide ?? null,
                workerReplayTargets: normalizeWorkerReplayTargets(
                    operation.workerReplayTargets
                )
            })),
            label
        );
    }

    // ── Transactions ─────────────────────────────────────────────

    /**
     * Start a named batch transaction.
     * Nested calls increment a depth counter; only the outermost commits.
     */
    beginTransaction(
        label: string,
        historyTarget?: TransactionHistoryTarget | null
    ): void {
        this._txDepth++;
        if (this._txDepth === 1) {
            this._txLabel = label;
            this._txId = this._nextTxId++;
            this._txStartTimeMs = performance.now();
            this._txHistoryItemId = this._createHistoryItemId();
            this._txHistoryTarget = historyTarget ?? null;
            // Capture a compact state-vector (< 100 bytes) rather than the
            // full font serialization so the fallback canonical-diff path in
            // _emitCanonicalLocalUpdateSince stays cheap.
            this._txStartStateVector = Y.encodeStateVector(this.yDoc);
        }
    }

    /**
     * End the current batch transaction.
     */
    endTransaction(): TransactionCommitResult | null {
        if (this._txDepth <= 0) return null;
        this._txDepth--;
        let commitResult: TransactionCommitResult | null = null;
        if (this._txDepth === 0) {
            if (this._txBufferedOperations.length) {
                commitResult = this._commitOperations(
                    this._txBufferedOperations,
                    this._txLabel,
                    this._txId,
                    this._txHistoryItemId,
                    this._txHistoryTarget
                );
            }
            this._txBufferedOperations = [];
            this._txLabel = null;
            this._txId = null;
            this._txStartTimeMs = null;
            this._txHistoryItemId = null;
            this._txHistoryTarget = null;
            this._txStartStateVector = null;
        }
        return commitResult;
    }

    /** Whether a transaction is currently open. */
    get inTransaction(): boolean {
        return this._txDepth > 0;
    }

    setRecordingSuppressed(suppressed: boolean): void {
        this._suppressRecording = suppressed;
    }

    runWithoutRecording<T>(fn: () => T): T {
        const wasSuppressed = this._suppressRecording;
        this._suppressRecording = true;
        try {
            return fn();
        } finally {
            this._suppressRecording = wasSuppressed;
        }
    }

    // ── Bulk sync (after drag / external mutation) ───────────────

    /**
     * Sync a glyph's current JSON data into the Y.Doc.
     *
     * Call this after operations that mutate `babelfontData` directly
     * (e.g. outline-editor drag) instead of going through model setters.
     * Updates the existing Y.Map in-place so per-glyph UndoManagers
     * keep their scope reference.
     */
    syncGlyphFromJson(
        glyphName: string,
        label: string,
        oldValue?: string,
        newValue?: string,
        layerId?: string | null,
        visualAnchorSide?: 'left' | 'right' | null,
        workerReplayTargets?: WorkerReplayTarget[],
        editSource?: string | null,
        compileChangeSource?: string | null,
        compileEditType?: string | null
    ): void {
        this.syncGlyphsFromJson(
            [glyphName],
            label,
            oldValue,
            newValue,
            layerId,
            visualAnchorSide,
            workerReplayTargets,
            editSource,
            compileChangeSource,
            compileEditType
        );
    }

    /**
     * Sync multiple changed layers into Y.Doc in one transaction.
     * Each target stays on the layer fast path so linked windows only
     * receive the minimum changed layer snapshots.
     */
    syncLayersFromJson(
        layerTargets: WorkerReplayTarget[],
        label: string,
        oldValue?: string,
        newValue?: string,
        visualAnchorSide?: 'left' | 'right' | null,
        workerReplayTargets?: WorkerReplayTarget[],
        editSource?: string | null,
        compileChangeSource?: string | null,
        compileEditType?: string | null
    ): void {
        if (!this._fontJson || this._suppressRecording || this._isSyncing) {
            return;
        }

        const uniqueTargets = normalizeWorkerReplayTargets(layerTargets);
        if (!uniqueTargets.length) {
            return;
        }

        if (uniqueTargets.length === 1) {
            const [target] = uniqueTargets;
            this._trySyncSingleLayer(
                target.glyphName,
                target.layerId,
                label,
                oldValue,
                newValue,
                visualAnchorSide,
                workerReplayTargets,
                editSource,
                compileChangeSource,
                compileEditType
            );
            return;
        }

        const glyphs = (this._fontJson as Unsafe).glyphs;
        if (!Array.isArray(glyphs)) {
            return;
        }

        const glyphsMap = this.fontMap.get('glyphs') as
            | Y.Map<unknown>
            | undefined;
        if (!glyphsMap) {
            return;
        }

        const targets: Array<{
            glyphName: string;
            layerId: string;
            previousLayerSnapshot: unknown;
            layerSnapshot: unknown;
        }> = [];

        for (const { glyphName, layerId } of uniqueTargets) {
            const glyphJson = glyphs.find(
                (g: Record<string, unknown>) => g.name === glyphName
            ) as Record<string, unknown> | undefined;
            if (!glyphJson) {
                continue;
            }

            const glyphMap = glyphsMap.get(glyphName) as
                | Y.Map<unknown>
                | undefined;
            if (!glyphMap) {
                continue;
            }

            const layersMap = glyphMap.get('layers') as
                | Y.Map<unknown>
                | undefined;
            if (!layersMap) {
                continue;
            }

            const glyphLayers = (glyphJson.layers ?? []) as Array<
                Record<string, unknown>
            >;
            const layerJson = glyphLayers.find(
                (layer: Record<string, unknown>) => layer.id === layerId
            );
            if (!layerJson) {
                continue;
            }

            const yLayerMap = layersMap.get(layerId);
            // Build a delta: diff _fontJson layer against current Y.Doc state.
            // For layers not yet in Yjs (e.g. newly added master) the old state
            // is null — all fields are included and _applyLayerDelta will create
            // the entry from scratch.  For existing layers only changed fields
            // are included (sparse delta).
            const yLayerJson = yLayerMap ? fromYType(yLayerMap) : null;
            const delta: Record<string, unknown> = { id: layerId };
            let hasChanges = false;

            for (const [key, value] of Object.entries(layerJson)) {
                const oldValue = (
                    yLayerJson as Record<string, unknown> | null
                )?.[key];
                if (this._isDeepEqual(value, oldValue)) continue;

                delta[key] = value;
                hasChanges = true;
            }

            if (!hasChanges) {
                continue;
            }

            targets.push({
                glyphName,
                layerId,
                previousLayerSnapshot: cloneHistoryValue(yLayerJson),
                layerSnapshot: delta
            });
        }

        if (!targets.length) {
            return;
        }

        this._queueOrCommitOperations(
            targets.map((target) => ({
                op: 'set' as ChangeOp,
                path: ['glyphs', target.glyphName, 'layers', target.layerId],
                oldValue: cloneHistoryValue(target.previousLayerSnapshot),
                newValue: cloneHistoryValue(target.layerSnapshot),
                editSource: editSource ?? compileChangeSource ?? null,
                compileChangeSource,
                compileEditType,
                visualAnchorSide,
                workerReplayTargets,
                applyPath: [
                    'glyphs',
                    target.glyphName,
                    'layers',
                    target.layerId
                ],
                applyNewValue: target.layerSnapshot,
                applyMode: 'layer-snapshot' as BatchApplyMode
            })),
            label
        );

        console.log(
            `Layer sync committed for ${targets
                .map((target) => `${target.glyphName}/${target.layerId}`)
                .join(', ')} (${label}) [batched fast path]`
        );
    }

    /**
     * Sync multiple glyph JSON payloads into Y.Doc in one transaction.
     * This keeps paired root/component edits aligned as a single undo step.
     */
    syncGlyphsFromJson(
        glyphNames: string[],
        label: string,
        oldValue?: string,
        newValue?: string,
        layerId?: string | null,
        visualAnchorSide?: 'left' | 'right' | null,
        workerReplayTargets?: WorkerReplayTarget[],
        editSource?: string | null,
        compileChangeSource?: string | null,
        compileEditType?: string | null
    ): void {
        if (!this._fontJson || this._suppressRecording || this._isSyncing)
            return;

        const uniqueGlyphNames = Array.from(
            new Set(glyphNames.filter((name) => typeof name === 'string'))
        );
        if (!uniqueGlyphNames.length) {
            return;
        }

        // Fast path: single glyph + known layer → compare and sync only
        // the affected layer, avoiding full-glyph JSON reconstruction,
        // deep-equality checks, and cloning.
        if (uniqueGlyphNames.length === 1 && layerId) {
            if (
                this._trySyncSingleLayer(
                    uniqueGlyphNames[0],
                    layerId,
                    label,
                    oldValue!,
                    newValue!,
                    visualAnchorSide,
                    workerReplayTargets,
                    editSource,
                    compileChangeSource,
                    compileEditType
                )
            ) {
                return;
            }
        }

        const glyphs = (this._fontJson as Unsafe).glyphs;
        if (!Array.isArray(glyphs)) return;

        const glyphsMap = this.fontMap.get('glyphs') as
            | Y.Map<unknown>
            | undefined;
        if (!glyphsMap) return;

        const targets: Array<{
            glyphName: string;
            previousGlyphJson: Record<string, unknown>;
            glyphJson: Record<string, unknown>;
        }> = [];

        for (const glyphName of uniqueGlyphNames) {
            const glyphJson = glyphs.find(
                (g: Record<string, unknown>) => g.name === glyphName
            ) as Record<string, unknown> | undefined;
            if (!glyphJson) {
                continue;
            }

            const glyphMap = glyphsMap.get(glyphName) as
                | Y.Map<unknown>
                | undefined;
            if (!glyphMap) {
                continue;
            }

            const yGlyphJson = yDocToJson(glyphMap);
            if (this._isDeepEqual(yGlyphJson, glyphJson)) {
                continue;
            }

            targets.push({
                glyphName,
                previousGlyphJson: cloneHistoryValue(yGlyphJson),
                glyphJson
            });
        }

        if (!targets.length) {
            return;
        }

        const undoScope = this._deriveBulkUndoScope(targets, layerId ?? null);
        this._queueOrCommitOperations(
            targets.map((target) => {
                const glyphLayers = (target.glyphJson.layers ?? []) as Array<
                    Record<string, unknown>
                >;
                const previousGlyphLayers = Array.isArray(
                    target.previousGlyphJson.layers
                )
                    ? (target.previousGlyphJson.layers as Array<
                          Record<string, unknown>
                      >)
                    : [];
                const glyphSnapshot = this._normalizeGlyphSnapshot(
                    target.glyphJson,
                    target.previousGlyphJson
                );
                const layerSnapshot = layerId
                    ? this._normalizeLayerSnapshot(
                          layerId,
                          glyphLayers.find(
                              (layer: Record<string, unknown>) =>
                                  layer.id === layerId
                          ),
                          previousGlyphLayers.find(
                              (layer: Record<string, unknown>) =>
                                  layer.id === layerId
                          )
                      )
                    : undefined;
                const previousLayerSnapshot = layerId
                    ? previousGlyphLayers.find(
                          (layer: Record<string, unknown>) =>
                              layer.id === layerId
                      )
                    : undefined;
                const isLayerScope = undoScope === 'layer' && layerId;

                return {
                    op: 'set' as ChangeOp,
                    path: isLayerScope
                        ? ['glyphs', target.glyphName, 'layers', layerId]
                        : ['glyphs', target.glyphName],
                    oldValue:
                        undoScope === 'font'
                            ? target.previousGlyphJson
                            : cloneHistoryValue(oldValue ?? target.glyphName),
                    newValue:
                        undoScope === 'font'
                            ? cloneHistoryValue(target.glyphJson)
                            : cloneHistoryValue(newValue ?? label),
                    editSource: editSource ?? compileChangeSource ?? null,
                    compileChangeSource,
                    compileEditType,
                    visualAnchorSide,
                    workerReplayTargets,
                    applyPath: isLayerScope
                        ? ['glyphs', target.glyphName, 'layers', layerId]
                        : ['glyphs', target.glyphName],
                    applyOldValue: isLayerScope
                        ? previousLayerSnapshot
                        : target.previousGlyphJson,
                    applyNewValue: isLayerScope ? layerSnapshot : glyphSnapshot,
                    applyMode: isLayerScope
                        ? 'layer-snapshot'
                        : 'glyph-snapshot'
                };
            }),
            label
        );

        console.log(
            `Glyph sync committed for ${targets.map((target) => target.glyphName).join(', ')} (${label})`
        );
    }

    /**
     * Instead of reconstructing the entire glyph from the Y.Doc,
     * deep-comparing the whole glyph, and cloning it multiple times,
     * this only touches the one affected layer — dramatically reducing
     * JSON serialization overhead for point-move operations.
     *
     * Returns true if the fast path handled the sync (even if no
     * changes were found), false if the caller should fall back to
     * the full glyph path.
     */
    private _trySyncSingleLayer(
        glyphName: string,
        layerId: string,
        label: string,
        oldValue?: string,
        newValue?: string,
        visualAnchorSide?: 'left' | 'right' | null,
        workerReplayTargets?: WorkerReplayTarget[],
        editSource?: string | null,
        compileChangeSource?: string | null,
        compileEditType?: string | null
    ): boolean {
        const glyphs = (this._fontJson as Unsafe).glyphs;
        if (!Array.isArray(glyphs)) return false;

        const glyphJson = glyphs.find(
            (g: Record<string, unknown>) => g.name === glyphName
        ) as Record<string, unknown> | undefined;
        if (!glyphJson) return false;

        const glyphsMap = this.fontMap.get('glyphs') as
            | Y.Map<unknown>
            | undefined;
        if (!glyphsMap) return false;

        const glyphMap = glyphsMap.get(glyphName) as Y.Map<unknown> | undefined;
        if (!glyphMap) return false;

        const layersMap = glyphMap.get('layers') as Y.Map<unknown> | undefined;
        if (!layersMap) return false;

        const yLayerMap = layersMap.get(layerId);
        if (!yLayerMap) return false;

        // Find the layer in the in-memory model
        const glyphLayers = (glyphJson.layers ?? []) as Array<
            Record<string, unknown>
        >;
        const layerJson = glyphLayers.find(
            (l: Record<string, unknown>) => l.id === layerId
        );
        if (!layerJson) return false;

        // Build a sparse delta: only include keys where _fontJson differs
        // from the pre-edit Y.Doc state. This avoids transmitting unchanged
        // fields and prevents receiver-side key stripping.
        const yLayerJson = fromYType(yLayerMap);
        const delta: Record<string, unknown> = { id: layerId };
        const oldValues: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(layerJson)) {
            const oldValue = (yLayerJson as Record<string, unknown> | null)?.[
                key
            ];
            if (this._isDeepEqual(value, oldValue)) continue;

            delta[key] = value;
            if (oldValue !== undefined) {
                oldValues[key] = oldValue;
            }
        }

        if (Object.keys(delta).length <= 1) {
            return false;
        }

        this._queueOrCommitOperations(
            [
                {
                    op: 'set' as ChangeOp,
                    path: ['glyphs', glyphName, 'layers', layerId],
                    oldValue: oldValue ?? glyphName,
                    newValue: newValue ?? label,
                    editSource: editSource ?? compileChangeSource ?? null,
                    compileChangeSource,
                    compileEditType,
                    visualAnchorSide,
                    workerReplayTargets,
                    applyPath: ['glyphs', glyphName, 'layers', layerId],
                    applyOldValue: oldValues,
                    applyNewValue: delta,
                    applyMode: 'layer-snapshot'
                }
            ],
            label
        );

        console.log(
            `Glyph sync committed for ${glyphName} layer ${layerId} (${label}) [fast path]`
        );
        return true;
    }

    // ── Undo / Redo ──────────────────────────────────────────────

    /**
     * Undo the last change for a specific glyph, or font-level if no
     * glyph name is given.
     *
     * YJS_ONLY: Both the native UndoManager branch and history-replay branch
     * emit a canonical binary Yjs update into the standard post-commit funnel.
     */
    undo(
        glyphName?: string,
        layerId?: string | null,
        historyTargetKey?: string | null
    ): UndoRedoResult | null {
        const targetItem = this._resolveUndoHistoryItem(
            glyphName,
            layerId,
            'undo',
            historyTargetKey
        );
        const target = this._resolveUndoTarget(
            glyphName,
            layerId,
            'undo',
            targetItem
        );
        const { manager: um, scope } = this._getUndoManagerForTarget(target);
        const shouldReplayHistoryItem = !!(
            targetItem && this._canReplayHistoryItemDirectly(targetItem, 'undo')
        );
        const authoritativeHistory = this._resolveAuthoritativeUndoHistory(
            'undo',
            targetItem,
            scope,
            target.glyphName,
            target.layerId
        );
        if (
            scope !== 'font' &&
            !shouldReplayHistoryItem &&
            (!um ||
                um.undoStack.length === 0 ||
                !authoritativeHistory.historyItem)
        ) {
            if (!authoritativeHistory.historyItem) {
                return null;
            }
        }
        if (scope === 'font' && !authoritativeHistory.historyItem) {
            return null;
        }
        const localUpdateLogIndexBeforeUndo = this._lastLocalUpdateLogIndex;
        const localUpdateBaseline = Y.encodeStateVector(this.yDoc);
        this._suppressRecording = true;
        try {
            const targetHistoryItemId = authoritativeHistory.historyItemId;
            const semanticHistoryItem = authoritativeHistory.historyItem;
            const timestamp = Date.now();
            const metadataEntries = getSemanticEntriesForHistoryItem(
                semanticHistoryItem,
                'undo',
                targetHistoryItemId,
                timestamp,
                this.windowId,
                this._getWindowRoleLabel()
            );
            const workerReplayTargets = normalizeWorkerReplayTargets([
                ...(targetItem?.workerReplayTargets ?? []),
                ...(target.glyphName && target.layerId
                    ? [{ glyphName: target.glyphName, layerId: target.layerId }]
                    : [])
            ]);
            // Log entry before um.undo() so it's available when the
            // Y.Doc update event fires and WindowSync broadcasts it.
            const entry = createLogEntry({
                timestamp,
                windowId: this.windowId,
                windowRoleLabel: this._getWindowRoleLabel(),
                historyAction: 'undo',
                targetHistoryItemId,
                transactionLabel: 'Undo',
                transactionId: null,
                op: 'set' as ChangeOp,
                undoScope: scope,
                path:
                    scope === 'layer' && target.glyphName && target.layerId
                        ? `glyphs.${target.glyphName}.layers.${target.layerId}`
                        : scope === 'glyph' && target.glyphName
                          ? `glyphs.${target.glyphName}`
                          : 'font',
                oldValue: undefined,
                newValue: 'undo',
                workerReplayTargets,
                semanticChangeLogEntries: metadataEntries ?? undefined
            });
            this._appendChangeLogEntry(entry);

            const isHistoryReplay =
                !!targetItem && (scope === 'font' || shouldReplayHistoryItem);

            if (isHistoryReplay) {
                this._applyHistoryItem(targetItem, 'undo');
            } else {
                um?.undo();
            }

            this._syncJsonFromYDoc(
                workerReplayTargets.length > 0
                    ? workerReplayTargets
                    : scope === 'layer' && target.glyphName && target.layerId
                      ? { glyphName: target.glyphName, layerId: target.layerId }
                      : null
            );

            this._onAfterSync?.();
            this._onDirty?.();
            if (
                this._lastLocalUpdateLogIndex ===
                    localUpdateLogIndexBeforeUndo &&
                !this._isApplyingRemote &&
                !this._suppressAutomaticLocalUpdateEmission
            ) {
                this._emitCanonicalLocalUpdateSince(localUpdateBaseline);
            }
            this._advanceUndoHistoryItem(
                scope,
                target.glyphName,
                target.layerId,
                'undo',
                targetHistoryItemId
            );
            return {
                scope,
                glyphName: target.glyphName,
                layerId: target.layerId,
                historyItem: semanticHistoryItem
            };
        } finally {
            this._suppressRecording = false;
        }
    }

    /**
     * Redo the last undone change.
     *
     * YJS_ONLY: Both the native UndoManager branch and history-replay branch
     * emit a canonical binary Yjs update into the standard post-commit funnel.
     */
    redo(
        glyphName?: string,
        layerId?: string | null,
        historyTargetKey?: string | null
    ): UndoRedoResult | null {
        const targetItem = this._resolveUndoHistoryItem(
            glyphName,
            layerId,
            'redo',
            historyTargetKey
        );
        const target = this._resolveUndoTarget(
            glyphName,
            layerId,
            'redo',
            targetItem
        );
        const { manager: um, scope } = this._getUndoManagerForTarget(target);
        const shouldReplayHistoryItem = !!(
            targetItem && this._canReplayHistoryItemDirectly(targetItem, 'redo')
        );
        const authoritativeHistory = this._resolveAuthoritativeUndoHistory(
            'redo',
            targetItem,
            scope,
            target.glyphName,
            target.layerId
        );
        if (
            scope !== 'font' &&
            !shouldReplayHistoryItem &&
            (!um ||
                um.redoStack.length === 0 ||
                !authoritativeHistory.historyItem)
        ) {
            if (!authoritativeHistory.historyItem) {
                return null;
            }
        }
        if (scope === 'font' && !authoritativeHistory.historyItem) {
            return null;
        }
        const localUpdateLogIndexBeforeRedo = this._lastLocalUpdateLogIndex;
        const localUpdateBaseline = Y.encodeStateVector(this.yDoc);
        this._suppressRecording = true;
        try {
            const targetHistoryItemId = authoritativeHistory.historyItemId;
            const semanticHistoryItem = authoritativeHistory.historyItem;
            const timestamp = Date.now();
            const metadataEntries = getSemanticEntriesForHistoryItem(
                semanticHistoryItem,
                'redo',
                targetHistoryItemId,
                timestamp,
                this.windowId,
                this._getWindowRoleLabel()
            );
            const workerReplayTargets = normalizeWorkerReplayTargets([
                ...(targetItem?.workerReplayTargets ?? []),
                ...(target.glyphName && target.layerId
                    ? [{ glyphName: target.glyphName, layerId: target.layerId }]
                    : [])
            ]);
            // Log entry before um.redo() so it's available for broadcast.
            const entry = createLogEntry({
                timestamp,
                windowId: this.windowId,
                windowRoleLabel: this._getWindowRoleLabel(),
                historyAction: 'redo',
                targetHistoryItemId,
                transactionLabel: 'Redo',
                transactionId: null,
                op: 'set' as ChangeOp,
                undoScope: scope,
                path:
                    scope === 'layer' && target.glyphName && target.layerId
                        ? `glyphs.${target.glyphName}.layers.${target.layerId}`
                        : scope === 'glyph' && target.glyphName
                          ? `glyphs.${target.glyphName}`
                          : 'font',
                oldValue: undefined,
                newValue: 'redo',
                workerReplayTargets,
                semanticChangeLogEntries: metadataEntries ?? undefined
            });
            this._appendChangeLogEntry(entry);

            const isHistoryReplay =
                !!targetItem && (scope === 'font' || shouldReplayHistoryItem);

            if (isHistoryReplay) {
                this._applyHistoryItem(targetItem, 'redo');
            } else {
                um?.redo();
            }

            this._syncJsonFromYDoc(
                workerReplayTargets.length > 0
                    ? workerReplayTargets
                    : scope === 'layer' && target.glyphName && target.layerId
                      ? { glyphName: target.glyphName, layerId: target.layerId }
                      : null
            );

            this._onAfterSync?.();
            this._onDirty?.();
            if (
                this._lastLocalUpdateLogIndex ===
                    localUpdateLogIndexBeforeRedo &&
                !this._isApplyingRemote &&
                !this._suppressAutomaticLocalUpdateEmission
            ) {
                this._emitCanonicalLocalUpdateSince(localUpdateBaseline);
            }
            this._advanceUndoHistoryItem(
                scope,
                target.glyphName,
                target.layerId,
                'redo',
                targetHistoryItemId
            );
            return {
                scope,
                glyphName: target.glyphName,
                layerId: target.layerId,
                historyItem: semanticHistoryItem
            };
        } finally {
            this._suppressRecording = false;
        }
    }

    /** Check if undo is available. */
    canUndo(
        glyphName?: string,
        layerId?: string | null,
        historyTargetKey?: string | null
    ): boolean {
        const targetItem = this._resolveUndoHistoryItem(
            glyphName,
            layerId,
            'undo',
            historyTargetKey
        );
        const target = this._resolveUndoTarget(
            glyphName,
            layerId,
            'undo',
            targetItem
        );
        const { manager: um, scope } = this._getUndoManagerForTarget(target);
        const authoritativeHistory = this._resolveAuthoritativeUndoHistory(
            'undo',
            targetItem,
            scope,
            target.glyphName,
            target.layerId
        );
        if (scope === 'font') {
            return !!authoritativeHistory.historyItem;
        }
        if (
            targetItem &&
            this._canReplayHistoryItemDirectly(targetItem, 'undo')
        ) {
            return true;
        }
        return (
            !!authoritativeHistory.historyItem &&
            !!um &&
            um.undoStack.length > 0
        );
    }

    /** Check if redo is available. */
    canRedo(
        glyphName?: string,
        layerId?: string | null,
        historyTargetKey?: string | null
    ): boolean {
        const targetItem = this._resolveUndoHistoryItem(
            glyphName,
            layerId,
            'redo',
            historyTargetKey
        );
        const target = this._resolveUndoTarget(
            glyphName,
            layerId,
            'redo',
            targetItem
        );
        const { manager: um, scope } = this._getUndoManagerForTarget(target);
        const authoritativeHistory = this._resolveAuthoritativeUndoHistory(
            'redo',
            targetItem,
            scope,
            target.glyphName,
            target.layerId
        );
        if (scope === 'font') {
            return !!authoritativeHistory.historyItem;
        }
        if (
            targetItem &&
            this._canReplayHistoryItemDirectly(targetItem, 'redo')
        ) {
            return true;
        }
        return (
            !!authoritativeHistory.historyItem &&
            !!um &&
            um.redoStack.length > 0
        );
    }

    // ── Cross-window ─────────────────────────────────────────────

    /**
     * Apply a remote Y.Doc update from another window.
     * Optionally import accompanying change log entries.
     *
     * YJS_ONLY (binary): The remote binary Yjs update is applied and
     * the worker also receives it via _yjsWorkerCallback.
     * Remote JSON/model sync must stay branch-scoped: top-level keys, glyphs,
     * and layers are patched from the authoritative Y.Doc without any full
     * yDocToJson rebuild on the receiving window hot path.
     */
    applyRemoteUpdate(
        update: Uint8Array,
        remoteEntries?: ChangeLogEntry[],
        remoteCollaborationMessages?: CollaborationMessageEnvelope[]
    ): void {
        this._isApplyingRemote = true;
        try {
            if (!this._fontJson) this._fontJson = {};
            const effectiveRemoteEntries = remoteEntries?.length
                ? remoteEntries
                : (remoteCollaborationMessages?.flatMap((message) =>
                      createChangeLogEntriesFromCollaborationMessageEnvelope(
                          message,
                          {
                              windowRoleLabel: this._getWindowRoleLabel()
                          }
                      )
                  ) ?? []);
            if (!effectiveRemoteEntries.length) {
                if (this._isRemoteUpdateNoop(update)) {
                    return;
                }
                throw new MetadataFreeRemoteUpdateError();
            }
            // Apply linked-window updates using the shared same-user origin so
            // every window can undo the combined edit history.
            Y.applyUpdate(
                this.yDoc,
                update,
                this._getRemoteUpdateOrigin(effectiveRemoteEntries)
            );
            if (effectiveRemoteEntries?.length) {
                const glyphNames = new Set(
                    effectiveRemoteEntries
                        .map((entry) =>
                            this._deriveGlyphNameFromPath(entry.path)
                        )
                        .filter((glyphName): glyphName is string => !!glyphName)
                );
                for (const glyphName of glyphNames) {
                    this.getGlyphUndoManager(glyphName);
                }
                for (const entry of effectiveRemoteEntries) {
                    const glyphName = this._deriveGlyphNameFromPath(entry.path);
                    const layerId = this._deriveLayerIdFromPath(entry.path);
                    if (glyphName && layerId) {
                        this.getLayerUndoManager(glyphName, layerId);
                    }
                }
            }
            this._syncRemoteJsonFromYDoc(effectiveRemoteEntries);
            this._yjsWorkerCallback?.(update, effectiveRemoteEntries);
            this._onAfterSync?.();
            this._onDirty?.();
            if (effectiveRemoteEntries && effectiveRemoteEntries.length > 0) {
                this._appendChangeLogEntries(effectiveRemoteEntries);
                this._lastBroadcastLogIndex = this._changeLog.length;
                this._lastLocalUpdateLogIndex = this._changeLog.length;
            }
            if (remoteCollaborationMessages?.length) {
                this._appendCollaborationLogItems(
                    remoteCollaborationMessages.map((message) =>
                        this._createCollaborationLogItem(
                            message,
                            update,
                            'remote',
                            this._deriveForwardChangesFromCollaborationMessage(
                                message
                            )
                        )
                    )
                );
            }
            this._onRemoteChange?.(effectiveRemoteEntries ?? []);
            for (const cb of this._committedChangeListeners) {
                cb(effectiveRemoteEntries ?? [], {
                    origin: 'remote',
                    update
                });
            }
            this._lastBroadcastStateVector = Y.encodeStateVector(this.yDoc);
        } finally {
            this._isApplyingRemote = false;
        }
    }

    private _isRemoteUpdateNoop(update: Uint8Array): boolean {
        const probeDoc = new Y.Doc({ gc: false });
        try {
            Y.applyUpdate(probeDoc, Y.encodeStateAsUpdate(this.yDoc));
            const beforeState = Y.encodeStateAsUpdate(probeDoc);
            Y.applyUpdate(probeDoc, update);
            const afterState = Y.encodeStateAsUpdate(probeDoc);
            return (
                beforeState.length === afterState.length &&
                beforeState.every((value, index) => value === afterState[index])
            );
        } finally {
            probeDoc.destroy();
        }
    }

    /**
     * Patch live babelfont JSON for a remote Yjs update using only the
     * touched branches identified by change-log metadata.
     */
    private _syncRemoteJsonFromYDoc(remoteEntries?: ChangeLogEntry[]): void {
        if (!this._fontJson) {
            return;
        }

        const entries = remoteEntries ?? [];
        const layerTargets = new Map<
            string,
            { glyphName: string; layerId: string }
        >();
        const glyphNames = new Set<string>();
        const topLevelKeys = new Set<string>();
        let syncEntireFont = entries.length === 0;

        for (const entry of entries) {
            const pathSegments = this._getPathSegments(
                String(entry.path || '')
            );
            if (!pathSegments.length) {
                syncEntireFont = true;
                continue;
            }

            const topLevelKey = pathSegments[0];
            if (topLevelKey !== 'glyphs') {
                topLevelKeys.add(topLevelKey);
                continue;
            }

            const glyphName = this._deriveGlyphNameFromPath(entry.path);
            const layerId = this._deriveLayerIdFromPath(entry.path);
            const explicitLayerTargets = normalizeWorkerReplayTargets(
                entry.workerReplayTargets
            );
            const hasExplicitLayerTargets = explicitLayerTargets.length > 0;
            if (!glyphName) {
                syncEntireFont = true;
                continue;
            }

            const isWholeGlyphChange = !layerId && entry.undoScope !== 'layer';
            const isWholeLayerChange =
                layerId !== null &&
                pathSegments.length === 4 &&
                pathSegments[2] === 'layers' &&
                !hasExplicitLayerTargets;

            if (isWholeGlyphChange || isWholeLayerChange) {
                glyphNames.add(glyphName);
                continue;
            }
        }

        if (!syncEntireFont) {
            for (const entry of entries) {
                const explicitLayerTargets = normalizeWorkerReplayTargets(
                    entry.workerReplayTargets
                );
                if (explicitLayerTargets.length > 0) {
                    for (const target of explicitLayerTargets) {
                        if (glyphNames.has(target.glyphName)) {
                            continue;
                        }
                        layerTargets.set(
                            getLayerFingerprintTargetKey(
                                target.glyphName,
                                target.layerId
                            ),
                            target
                        );
                    }
                    continue;
                }

                const glyphName = this._deriveGlyphNameFromPath(entry.path);
                const layerId = this._deriveLayerIdFromPath(entry.path);
                if (!glyphName || !layerId || glyphNames.has(glyphName)) {
                    continue;
                }

                layerTargets.set(
                    getLayerFingerprintTargetKey(glyphName, layerId),
                    { glyphName, layerId }
                );
            }
        }

        const fingerprintTargets = this._collectRemoteFingerprintTargets(
            syncEntireFont,
            glyphNames,
            Array.from(layerTargets.values())
        );
        const previousFingerprintSnapshot =
            fingerprintTargets !== undefined
                ? this._collectLayerFingerprintSnapshot(fingerprintTargets)
                : null;

        if (syncEntireFont) {
            this._syncEntireFontJsonFromYDoc();
        } else {
            for (const glyphName of glyphNames) {
                this._patchGlyphFromYDoc(glyphName);
            }
            const fallbackGlyphNames = new Set<string>();
            for (const target of layerTargets.values()) {
                if (glyphNames.has(target.glyphName)) {
                    continue;
                }
                if (!this._patchLayerFromYDoc(target)) {
                    fallbackGlyphNames.add(target.glyphName);
                }
            }
            for (const glyphName of fallbackGlyphNames) {
                this._patchGlyphFromYDoc(glyphName);
            }
            for (const key of topLevelKeys) {
                this._syncTopLevelFontKeyFromYDoc(key);
            }
        }

        this._applyExplicitPropertyRemovalsToFontJson(entries);

        if (previousFingerprintSnapshot) {
            this._emitLayerFingerprintChangedEvents(
                previousFingerprintSnapshot,
                this._collectLayerFingerprintSnapshot(fingerprintTargets)
            );
        }
    }

    /**
     * Sync every top-level font key and glyph snapshot from the current Y.Doc.
     * Used for bootstrap-style full-state syncs and for defensive recovery when
     * remote metadata is missing, without converting the whole Y.Doc in one walk.
     */
    private _syncEntireFontJsonFromYDoc(): void {
        if (!this._fontJson) {
            return;
        }

        const fontRecord = this._fontJson as Record<string, unknown>;
        const nextTopLevelKeys = new Set<string>();
        this.fontMap.forEach((_value: unknown, key: string) => {
            nextTopLevelKeys.add(key);
        });

        this._syncAllGlyphsFromYDoc();

        for (const key of nextTopLevelKeys) {
            if (key === 'glyphs') {
                continue;
            }
            this._syncTopLevelFontKeyFromYDoc(key);
        }

        for (const key of Object.keys(fontRecord)) {
            if (key === 'glyphs') {
                continue;
            }
            if (!nextTopLevelKeys.has(key)) {
                delete fontRecord[key];
            }
        }
    }

    private _collectRemoteFingerprintTargets(
        syncEntireFont: boolean,
        glyphNames: Set<string>,
        layerTargets: Array<{ glyphName: string; layerId: string }>
    ): LayerFingerprintTarget[] | null | undefined {
        if (syncEntireFont) {
            return null;
        }

        const targets = normalizeWorkerReplayTargets(layerTargets);
        for (const glyphName of glyphNames) {
            this._appendGlyphLayerFingerprintTargets(glyphName, targets);
        }

        return targets.length > 0
            ? normalizeWorkerReplayTargets(targets)
            : undefined;
    }

    private _appendGlyphLayerFingerprintTargets(
        glyphName: string,
        targets: LayerFingerprintTarget[]
    ): void {
        const seen = new Set(
            targets.map((target) =>
                getLayerFingerprintTargetKey(target.glyphName, target.layerId)
            )
        );
        const pushTarget = (layerId: string | null) => {
            if (!layerId) {
                return;
            }
            const targetKey = getLayerFingerprintTargetKey(glyphName, layerId);
            if (seen.has(targetKey)) {
                return;
            }
            seen.add(targetKey);
            targets.push({ glyphName, layerId });
        };

        const glyphs = Array.isArray((this._fontJson as Unsafe)?.glyphs)
            ? (((this._fontJson as Unsafe).glyphs as Unsafe[]).find(
                  (glyph) => glyph?.name === glyphName
              ) as Unsafe | undefined)
            : undefined;
        const existingLayers = Array.isArray(glyphs?.layers)
            ? (glyphs.layers as Unsafe[])
            : [];
        for (const layer of existingLayers) {
            pushTarget(typeof layer?.id === 'string' ? layer.id : null);
        }

        const yGlyphsMap = this.fontMap.get('glyphs');
        if (!(yGlyphsMap instanceof Y.Map)) {
            return;
        }
        const glyphMap = yGlyphsMap.get(glyphName);
        if (!(glyphMap instanceof Y.Map)) {
            return;
        }
        const layersMap = glyphMap.get('layers');
        if (!(layersMap instanceof Y.Map)) {
            return;
        }
        layersMap.forEach((_value: unknown, layerId: string) => {
            pushTarget(layerId);
        });
    }

    private _syncAllGlyphsFromYDoc(): void {
        if (!this._fontJson) {
            return;
        }

        const fontRecord = this._fontJson as Record<string, unknown>;
        const yGlyphsMap = this.fontMap.get('glyphs');
        if (!(yGlyphsMap instanceof Y.Map)) {
            delete fontRecord.glyphs;
            return;
        }

        const existingGlyphs = Array.isArray(fontRecord.glyphs)
            ? (fontRecord.glyphs as Unsafe[])
            : [];
        const existingGlyphsByName = new Map<string, Unsafe>(
            existingGlyphs
                .filter(
                    (glyph): glyph is Unsafe =>
                        !!glyph && typeof glyph?.name === 'string'
                )
                .map((glyph) => [String(glyph.name), glyph])
        );

        const nextGlyphs: Unsafe[] = [];
        yGlyphsMap.forEach((_value: unknown, glyphName: string) => {
            const glyphSnapshot = this._readNormalizedGlyphSnapshotFromYDoc(
                glyphName,
                existingGlyphsByName.get(glyphName)
            );
            if (glyphSnapshot) {
                nextGlyphs.push(glyphSnapshot);
            }
        });

        fontRecord.glyphs = nextGlyphs;
    }

    private _syncTopLevelFontKeyFromYDoc(key: string): void {
        if (!this._fontJson) {
            return;
        }

        if (key === 'glyphs') {
            this._syncAllGlyphsFromYDoc();
            return;
        }

        const fontRecord = this._fontJson as Record<string, unknown>;
        const value = this.fontMap.get(key);
        if (value === undefined) {
            delete fontRecord[key];
            return;
        }

        fontRecord[key] = cloneHistoryValue(fromYType(value));
    }

    private _readNormalizedGlyphSnapshotFromYDoc(
        glyphName: string,
        existingGlyphSnapshot?: unknown
    ): Unsafe | null {
        const glyphsMap = this.fontMap.get('glyphs');
        if (!(glyphsMap instanceof Y.Map)) {
            return null;
        }

        const glyphMap = glyphsMap.get(glyphName);
        if (!(glyphMap instanceof Y.Map)) {
            return null;
        }

        const glyphSnapshot = this._normalizeGlyphSnapshot(
            fromYType(glyphMap),
            existingGlyphSnapshot
        ) as Unsafe;
        return glyphSnapshot;
    }

    private _patchGlyphFromYDoc(glyphName: string): boolean {
        if (!this._fontJson) {
            return false;
        }

        const fontRecord = this._fontJson as Record<string, unknown>;
        const glyphs = Array.isArray(fontRecord.glyphs)
            ? (fontRecord.glyphs as Unsafe[])
            : [];
        if (!Array.isArray(fontRecord.glyphs)) {
            fontRecord.glyphs = glyphs;
        }

        const glyphIndex = glyphs.findIndex(
            (glyph) => glyph?.name === glyphName
        );
        const glyphSnapshot = this._readNormalizedGlyphSnapshotFromYDoc(
            glyphName,
            glyphIndex >= 0 ? glyphs[glyphIndex] : undefined
        );

        if (!glyphSnapshot) {
            if (glyphIndex >= 0) {
                glyphs.splice(glyphIndex, 1);
            }
            return true;
        }

        if (glyphIndex >= 0) {
            glyphs[glyphIndex] = glyphSnapshot;
            return true;
        }

        const yGlyphsMap = this.fontMap.get('glyphs');
        if (!(yGlyphsMap instanceof Y.Map)) {
            glyphs.push(glyphSnapshot);
            return true;
        }

        const orderedGlyphNames: string[] = [];
        yGlyphsMap.forEach((_value: unknown, nextGlyphName: string) => {
            orderedGlyphNames.push(nextGlyphName);
        });
        const glyphOrderIndex = orderedGlyphNames.indexOf(glyphName);
        if (glyphOrderIndex < 0) {
            glyphs.push(glyphSnapshot);
            return true;
        }

        const followingGlyphName = orderedGlyphNames
            .slice(glyphOrderIndex + 1)
            .find((candidateGlyphName) =>
                glyphs.some((glyph) => glyph?.name === candidateGlyphName)
            );
        if (!followingGlyphName) {
            glyphs.push(glyphSnapshot);
            return true;
        }

        const insertIndex = glyphs.findIndex(
            (glyph) => glyph?.name === followingGlyphName
        );
        if (insertIndex < 0) {
            glyphs.push(glyphSnapshot);
            return true;
        }

        glyphs.splice(insertIndex, 0, glyphSnapshot);
        return true;
    }

    private _applyExplicitPropertyRemovalsToFontJson(
        remoteEntries?: ChangeLogEntry[]
    ): void {
        if (!remoteEntries?.length || !this._fontJson) {
            return;
        }

        const glyphs = Array.isArray((this._fontJson as Unsafe).glyphs)
            ? ((this._fontJson as Unsafe).glyphs as Unsafe[])
            : null;
        if (!glyphs) {
            return;
        }

        for (const entry of remoteEntries) {
            if (entry.op !== 'remove') {
                continue;
            }

            const pathSegments = this._getPathSegments(
                String(entry.path || '')
            );
            if (pathSegments[0] !== 'glyphs') {
                continue;
            }

            const glyphName = pathSegments[1];
            const glyphRecord = glyphs.find(
                (glyph) => glyph?.name === glyphName
            );

            if (!glyphRecord) {
                continue;
            }

            if (pathSegments.length === 3) {
                delete glyphRecord[pathSegments[2]];
                continue;
            }

            if (pathSegments.length === 4 && pathSegments[2] === 'layers') {
                const layerId = pathSegments[3];
                const layers = Array.isArray(glyphRecord.layers)
                    ? (glyphRecord.layers as Unsafe[])
                    : null;
                if (!layers) {
                    continue;
                }

                const layerIndex = layers.findIndex(
                    (layer) => layer?.id === layerId
                );
                if (layerIndex >= 0) {
                    layers.splice(layerIndex, 1);
                }
                continue;
            }

            if (pathSegments.length !== 5 || pathSegments[2] !== 'layers') {
                continue;
            }

            const layerId = pathSegments[3];
            const propertyKey = pathSegments[4];
            const layers = Array.isArray(glyphRecord.layers)
                ? (glyphRecord.layers as Unsafe[])
                : null;
            const layerRecord = layers?.find((layer) => layer?.id === layerId);
            if (!layerRecord) {
                continue;
            }

            delete layerRecord[propertyKey];
        }
    }

    /**
     * Export the full Y.Doc state for bootstrapping a new window.
     */
    getFullState(): YjsUpdate {
        // YJS_ONLY (N2/B3): Binary Yjs state, not JSON.
        // Used for linked-window bootstrap and cloud-font baseline.
        return Y.encodeStateAsUpdate(this.yDoc);
    }

    /**
     * Apply a full state snapshot (for new window bootstrap).
     * The receiving window should NOT call initFromJson() before this —
     * independently initialised Y.Docs have conflicting CRDT state.
     *
     * YJS_ONLY (N2): Binary Yjs state — no JSON crossing.
     * The _syncJsonFromYDoc() call below rehydrates the live JSON/model from
     * branch-scoped Y.Doc reads instead of a single whole-document walk.
     */
    applyFullState(state: YjsUpdate): void {
        this._isApplyingRemote = true;
        try {
            if (!this._fontJson) this._fontJson = {};
            Y.applyUpdate(this.yDoc, state, SYSTEM_REMOTE_ORIGIN);
            this._syncJsonFromYDoc();
            this._canonicalizeFullStateRawFontJson();
            // Set up undo managers so this window can undo/redo too
            this._setupFontUndoManager();
            this._onAfterSync?.();
            this._onRemoteChange?.([]);
            this._lastBroadcastStateVector = Y.encodeStateVector(this.yDoc);
        } finally {
            this._isApplyingRemote = false;
        }
    }

    /** Encode the full Y.Doc state as a Yjs update binary. */
    encodeBridgeState(): YjsUpdate {
        return Y.encodeStateAsUpdate(this.yDoc);
    }

    /** Encode the Y.Doc state vector (compact — one entry per known client). */
    encodeBridgeStateVector(): YjsUpdate {
        return Y.encodeStateVector(this.yDoc);
    }

    /**
     * Encode the minimal update diff that a peer (described by peerStateVector)
     * is missing. Returns an empty update if we have nothing new to share.
     */
    encodeStateDiff(peerStateVector: YjsUpdate): YjsUpdate {
        return Y.encodeStateAsUpdate(this.yDoc, peerStateVector);
    }

    /**
     * Register a callback that will be called with every binary Yjs update
     * (both local edits and remote/undo changes) and the accompanying
     * ChangeLogEntry list. Pass `null` to unregister.
     *
     * The callback is intended to forward updates to the WASM compilation
     * worker so it can maintain its own Rust Y.Doc without receiving the full
     * font JSON on every edit.
     */
    setYjsWorkerCallback(
        cb:
            | ((update: YjsUpdate, changeLogEntries: ChangeLogEntry[]) => void)
            | null
    ): void {
        this._yjsWorkerCallback = cb;
    }

    /**
     * Apply a Yjs update directly to the Y.Doc without triggering compilation
     * or JSON synchronisation.  Used by CloudAdapter to re-seed the Y.Doc
     * after a bridge replacement (fontModelReady) so that subsequent
     * incremental updates from remote peers can be applied (their left-sibling
     * references will be resolvable).
     */
    applyYDocUpdateSilent(update: YjsUpdate): void {
        if (!update || update.length === 0) return;
        Y.applyUpdate(this.yDoc, update);
        this._lastBroadcastStateVector = Y.encodeStateVector(this.yDoc);
    }

    applyLocalGeneratedYjsUpdate(
        update: YjsUpdate,
        operations: TransactionBufferedOperation[],
        label: string | null,
        historyTarget?: TransactionHistoryTarget | null
    ): TransactionCommitResult | null {
        const normalizedOperations = operations
            .filter((operation) => operation.path.length > 0)
            .map((operation) => this._normalizeBufferedOperation(operation));
        if (!update?.length || !normalizedOperations.length) {
            return null;
        }
        if (this._txDepth > 0) {
            throw new Error(
                'applyLocalGeneratedYjsUpdate does not support open transactions'
            );
        }

        const scopeInfo = this._deriveBufferedScope(normalizedOperations);
        this._prepareBatchUndoManagers(scopeInfo);

        const nextHistoryItemId = this._createHistoryItemId();
        const timestamp = Date.now();
        const changeLogEntries: ChangeLogEntry[] = normalizedOperations.map(
            (operation) => {
                const operationHistoryTarget =
                    historyTarget ?? this._deriveHistoryTarget(operation.path);
                const workerReplayTargets =
                    this._deriveWorkerReplayTargets(operation);
                return createLogEntry({
                    timestamp,
                    windowId: this.windowId,
                    windowRoleLabel: this._getWindowRoleLabel(),
                    historyItemId: nextHistoryItemId,
                    historyAction: 'change',
                    transactionLabel: label,
                    transactionId: null,
                    op: operation.op,
                    undoScope: this._deriveUndoScope(
                        deriveGlyphName(operation.path),
                        deriveLayerId(operation.path)
                    ),
                    path: joinPathWithGlyphSeparator(operation.path),
                    oldValue: operation.oldValue,
                    newValue: operation.newValue,
                    compileChangeSource: operation.compileChangeSource ?? null,
                    compileEditType: operation.compileEditType ?? null,
                    replayOldValue:
                        operation.op !== 'set'
                            ? undefined
                            : cloneHistoryValue(
                                  operation.applyOldValue === undefined
                                      ? operation.oldValue
                                      : operation.applyOldValue
                              ),
                    replayNewValue:
                        operation.op !== 'set'
                            ? undefined
                            : cloneHistoryValue(
                                  operation.applyNewValue === undefined
                                      ? operation.newValue
                                      : operation.applyNewValue
                              ),
                    visualAnchorSide: operation.visualAnchorSide ?? null,
                    workerReplayTargets,
                    historyTargetType: operationHistoryTarget?.type ?? null,
                    historyTargetKey: operationHistoryTarget?.key ?? null,
                    historyTargetLabel: operationHistoryTarget?.label ?? null
                });
            }
        );

        this._appendChangeLogEntries(changeLogEntries);
        const localUpdateLogIndexBeforeCommit = this._lastLocalUpdateLogIndex;

        this._suppressAutomaticLocalUpdateEmission = true;
        try {
            Y.applyUpdate(this.yDoc, update, scopeInfo.origin);
            this._syncRemoteJsonFromYDoc(changeLogEntries);
            this._onAfterSync?.();
            this._onDirty?.();
            this._lastBroadcastStateVector = Y.encodeStateVector(this.yDoc);

            if (
                this._lastLocalUpdateLogIndex ===
                    localUpdateLogIndexBeforeCommit &&
                !this._isApplyingRemote
            ) {
                this._lastLocalUpdateLogIndex = this._changeLog.length;
                this._emitLocalUpdate(update, changeLogEntries);
            }
        } finally {
            this._suppressAutomaticLocalUpdateEmission = false;
            this._finishBatchUndoManagers(scopeInfo);
        }

        return {
            changeLogEntries,
            workerReplayTargets: normalizeWorkerReplayTargets(
                changeLogEntries.flatMap((entry) => entry.workerReplayTargets)
            ),
            changedGlyphNames: [
                ...new Set(
                    changeLogEntries
                        .map((entry) => deriveGlyphNameFromPath(entry.path))
                        .filter((glyphName): glyphName is string =>
                            Boolean(glyphName)
                        )
                )
            ],
            changedLayerIds: [
                ...new Set(
                    changeLogEntries
                        .map((entry) => deriveLayerIdFromPath(entry.path))
                        .filter((layerId): layerId is string =>
                            Boolean(layerId)
                        )
                )
            ]
        };
    }

    // ── Change log ───────────────────────────────────────────────

    /** Get the full change log. */
    getChangeLog(): ChangeLogEntry[] {
        return this._changeLog;
    }

    getCollaborationLog(): CollaborationLogItem[] {
        return this._collaborationLog;
    }

    getChangeLogForGlyph(glyphName?: string | null): ChangeLogEntry[] {
        if (!glyphName) {
            return this._changeLog;
        }
        return this._changeLog.filter(
            (entry) => this._deriveGlyphNameFromPath(entry.path) === glyphName
        );
    }

    /** Import change log entries (e.g. from another window). */
    importChangeLog(entries: ChangeLogEntry[]): void {
        this._changeLog = entries.map((entry) =>
            normalizeChangeLogEntry(entry)
        );
        this._lastBroadcastLogIndex = this._changeLog.length;
        this._lastLocalUpdateLogIndex = this._changeLog.length;
        this._notifyChangeLogListeners();
    }

    importCollaborationMessages(messages: CollaborationLogItem[]): void {
        this._collaborationLog = [...messages];
        this._notifyCollaborationLogListeners();
    }

    /**
     * Replace the imported baseline while preserving unsent local entries.
     * Used by cloud bootstrap so reconnects do not discard offline edits.
     */
    mergeImportedChangeLog(entries: ChangeLogEntry[]): void {
        const importedEntries = entries.map((entry) =>
            normalizeChangeLogEntry(entry)
        );
        const pendingBroadcastEntries = this._changeLog
            .slice(this._lastBroadcastLogIndex)
            .map((entry) => normalizeChangeLogEntry(entry));
        const mergedEntries = [...importedEntries, ...pendingBroadcastEntries];
        const seenEntryKeys = new Set<string>();

        this._changeLog = mergedEntries.filter((entry) => {
            const entryKey = [
                entry.windowId,
                String(entry.transactionId),
                String(entry.timestamp),
                entry.historyAction,
                entry.op,
                entry.path
            ].join(':');
            if (seenEntryKeys.has(entryKey)) {
                return false;
            }
            seenEntryKeys.add(entryKey);
            return true;
        });
        this._lastBroadcastLogIndex = importedEntries.length;
        this._lastLocalUpdateLogIndex = this._changeLog.length;
        this._notifyChangeLogListeners();
    }

    mergeImportedCollaborationMessages(messages: CollaborationLogItem[]): void {
        const existing = new Map<string, CollaborationLogItem>();
        for (const item of [...messages, ...this._collaborationLog]) {
            existing.set(item.id, item);
        }
        this._collaborationLog = [...existing.values()].sort(
            (left, right) => left.timestamp - right.timestamp
        );
        this._notifyCollaborationLogListeners();
    }

    /**
     * Get change log entries added since the last call.
     * Used by WindowSync to piggyback entries on yjs-update messages.
     */
    getNewChangeLogEntries(): ChangeLogEntry[] {
        const entries = this._changeLog.slice(this._lastBroadcastLogIndex);
        this._lastBroadcastLogIndex = this._changeLog.length;
        return entries;
    }

    advanceBroadcastLogCursor(entryCount: number): void {
        if (!Number.isFinite(entryCount) || entryCount <= 0) {
            return;
        }

        this._lastBroadcastLogIndex = Math.min(
            this._changeLog.length,
            this._lastBroadcastLogIndex + Math.floor(entryCount)
        );
    }

    private _getNewChangeLogEntriesForLocalUpdate(): ChangeLogEntry[] {
        const entries = this._changeLog.slice(this._lastLocalUpdateLogIndex);
        this._lastLocalUpdateLogIndex = this._changeLog.length;
        return entries;
    }

    /** Reset state (for tests). */
    reset(): void {
        this._changeLog = [];
        this._collaborationLog = [];
        this._lastBroadcastLogIndex = 0;
        this._lastLocalUpdateLogIndex = 0;
        this._txDepth = 0;
        this._txLabel = null;
        this._txId = null;
        this._txStartTimeMs = null;
        this._txHistoryItemId = null;
        this._txHistoryTarget = null;
        this._txBufferedOperations = [];
        this._nextTxId = 1;
        this._nextHistoryItemId = 1;
        this._nextCollaborationMessageSequence = 1;
        resetLogCounter();
        for (const entry of this._layerUndoManagers.values()) {
            entry.manager.destroy();
        }
        this._layerUndoManagers.clear();
        for (const um of this._undoManagers.values()) {
            um.destroy();
        }
        this._undoManagers.clear();
        this._fontUndoManager?.destroy();
        this._fontUndoManager = null;
        this._undoHistoryStacks.clear();
        this._notifyChangeLogListeners();
        this._notifyCollaborationLogListeners();
    }

    // ── Internal ─────────────────────────────────────────────────

    /**
     * Convert a babelfont JSON path to a Y.Doc path.
     *
     * Glyphs and layers in Y.Doc are keyed by name/ID (Y.Map) rather than
     * array index. So ["glyphs", 0, "layers", 2, "width"] becomes
     * ["glyphs", "A", "layers", "layer-uuid", "width"] etc.
     *
     * Since the model already passes human-readable keys (glyph names,
     * layer IDs) for these segments, this function only needs to ensure
     * numeric array indices remain numbers for Y.Array segments.
     */
    private _toYDocPath(path: (string | number)[]): (string | number)[] {
        if (
            path[0] === 'features' &&
            path[1] === 'features' &&
            typeof path[2] === 'string'
        ) {
            const match = String(path[2]).match(/^feature-index:(\d+)$/);
            if (match) {
                return [
                    path[0],
                    path[1],
                    Number.parseInt(match[1], 10),
                    ...path.slice(3)
                ];
            }
        }

        return path;
    }

    /**
     * Sync the local babelfont JSON from the current Y.Doc state.
     * Called after remote updates or undo/redo.
     *
     * YJS_ONLY when fast path succeeds: _patchLayerFromYDoc applies
     * only the touched layers — no full JSON rebuild.
     * When scope hints are unavailable, the live JSON/model is rebuilt from
     * branch-scoped reads of top-level keys and glyph snapshots, not from a
     * monolithic yDocToJson conversion.
     */
    /**
     * Patch the live babelfontData object from the current Y.Doc state.
     *
     * When `scopeHint` is provided (layer-scoped undo/redo), only that one
     * layer is reconstructed from Y.Doc — ~100-1000× faster than a full
     * font rebuild for large fonts. Falls through to the full sync if any
     * Y.Doc path lookup fails.
     *
     * YJS_ONLY when _patchLayerFromYDoc succeeds for all scopeHints
     * (per-layer Y.Doc→JSON, no full rebuild).
     */
    private _syncJsonFromYDoc(
        scopeHints?:
            | { glyphName: string; layerId: string }
            | Array<{ glyphName: string; layerId: string }>
            | null
    ): void {
        const normalizedScopeHints = Array.isArray(scopeHints)
            ? normalizeWorkerReplayTargets(scopeHints)
            : scopeHints
              ? normalizeWorkerReplayTargets([scopeHints])
              : [];
        if (!this._fontJson) return;

        const fingerprintTargets =
            normalizedScopeHints.length > 0 ? normalizedScopeHints : null;
        const previousFingerprintSnapshot =
            this._collectLayerFingerprintSnapshot(fingerprintTargets);

        // Fast path: only reconstruct the touched layers from Y.Doc.
        if (
            normalizedScopeHints.length > 0 &&
            normalizedScopeHints.every((scopeHint) =>
                this._patchLayerFromYDoc(scopeHint)
            )
        ) {
            this._emitLayerFingerprintChangedEvents(
                previousFingerprintSnapshot,
                this._collectLayerFingerprintSnapshot(fingerprintTargets)
            );
            return;
        }

        this._syncEntireFontJsonFromYDoc();

        this._emitLayerFingerprintChangedEvents(
            previousFingerprintSnapshot,
            this._collectLayerFingerprintSnapshot(fingerprintTargets)
        );
    }

    private _patchLayerFromYDoc(scopeHint: {
        glyphName: string;
        layerId: string;
    }): boolean {
        const glyphsMap = this.fontMap.get('glyphs');
        if (!(glyphsMap instanceof Y.Map)) {
            return false;
        }

        const glyphMap = glyphsMap.get(scopeHint.glyphName);
        if (!(glyphMap instanceof Y.Map)) {
            return false;
        }

        const layersMap = glyphMap.get('layers');
        if (!(layersMap instanceof Y.Map)) {
            return false;
        }

        const layerMap = layersMap.get(scopeHint.layerId);
        if (!(layerMap instanceof Y.Map)) {
            return false;
        }

        const glyphs = (this._fontJson as Unsafe).glyphs as
            | Unsafe[]
            | undefined;
        const glyphIdx =
            glyphs?.findIndex((g: Unsafe) => g.name === scopeHint.glyphName) ??
            -1;
        if (glyphIdx < 0 || !glyphs) {
            return false;
        }

        const layers = glyphs[glyphIdx].layers as Unsafe[] | undefined;
        const layerIdx =
            layers?.findIndex((l: Unsafe) => l.id === scopeHint.layerId) ?? -1;
        if (layerIdx < 0 || !layers) {
            return false;
        }

        const patchedLayer = this._normalizeLayerSnapshot(
            scopeHint.layerId,
            fromYType(layerMap),
            layers[layerIdx]
        ) as Unsafe;

        if (
            patchedLayer &&
            typeof patchedLayer === 'object' &&
            !Array.isArray(patchedLayer)
        ) {
            const layerRecord = patchedLayer as Record<string, unknown>;
            if (!('width' in layerRecord)) {
                console.warn(
                    `[PatchSyncEngine] _syncJsonFromYDoc: layer ${scopeHint.layerId} missing "width" after fromYType. Keys: ${Object.keys(layerRecord).join(',')}`
                );
                const yKeys: string[] = [];
                layerMap.forEach((_v: unknown, k: string) => {
                    yKeys.push(k);
                });
                console.warn(
                    `[PatchSyncEngine] Y.Map keys for layer: ${yKeys.join(',')}`
                );
            }
        }

        layers[layerIdx] = patchedLayer;
        return true;
    }

    /**
     * Setup the font-level UndoManager (everything outside glyphs).
     * Scoped to the root fontMap but excludes the "glyphs" sub-map.
     */
    private _setupFontUndoManager(): void {
        this._fontUndoManager?.destroy();
        // Track all top-level keys in the font map
        this._fontUndoManager = new Y.UndoManager(this.fontMap, {
            trackedOrigins: new Set([FONT_EDIT_ORIGIN]),
            captureTimeout: 0
        });
    }

    /**
     * Get or create a per-glyph UndoManager.
     */
    getGlyphUndoManager(glyphName: string): Y.UndoManager | null {
        if (this._undoManagers.has(glyphName)) {
            return this._undoManagers.get(glyphName)!;
        }
        const glyphsMap = this.fontMap.get('glyphs');
        if (!(glyphsMap instanceof Y.Map)) return null;
        const glyphMap = glyphsMap.get(glyphName);
        if (!(glyphMap instanceof Y.Map)) return null;

        const um = new Y.UndoManager(glyphMap, {
            trackedOrigins: new Set([GLYPH_EDIT_ORIGIN]),
            captureTimeout: 0
        });
        this._undoManagers.set(glyphName, um);
        return um;
    }

    getLayerUndoManager(
        glyphName: string,
        layerId: string
    ): Y.UndoManager | null {
        const managerKey = getLayerManagerKey(glyphName, layerId);
        const glyphsMap = this.fontMap.get('glyphs');
        if (!(glyphsMap instanceof Y.Map)) return null;
        const glyphMap = glyphsMap.get(glyphName);
        if (!(glyphMap instanceof Y.Map)) return null;
        const layersMap = glyphMap.get('layers');
        if (!(layersMap instanceof Y.Map)) return null;

        const existingEntry = this._layerUndoManagers.get(managerKey);
        if (existingEntry) {
            if (existingEntry.target === layersMap) {
                return existingEntry.manager;
            }
            existingEntry.manager.destroy();
            this._layerUndoManagers.delete(managerKey);
        }

        const um = new Y.UndoManager(layersMap, {
            trackedOrigins: new Set([getLayerEditOrigin(glyphName, layerId)]),
            captureTimeout: 0
        });
        this._layerUndoManagers.set(managerKey, {
            manager: um,
            target: layersMap
        });
        return um;
    }

    private _deriveUndoScope(
        glyphName: string | null,
        layerId: string | null
    ): UndoScope {
        if (!glyphName) {
            return 'font';
        }
        if (layerId) {
            return 'layer';
        }
        return 'glyph';
    }

    private _queueOrCommitOperations(
        operations: TransactionBufferedOperation[],
        label?: string | null
    ): TransactionCommitResult | null {
        const normalizedOperations = operations
            .filter((operation) => operation.path.length > 0)
            .map((operation) => this._normalizeBufferedOperation(operation));
        if (!normalizedOperations.length) {
            return null;
        }

        if (this._txDepth > 0) {
            // Clone values before buffering — the model may mutate while the
            // transaction is still open.
            this._txBufferedOperations.push(
                ...normalizedOperations.map((op) =>
                    this._cloneBufferedOperation(op)
                )
            );
            return null;
        }

        return this._commitOperations(
            normalizedOperations,
            label ?? null,
            null,
            null
        );
    }

    private _normalizeBufferedOperation(
        operation: TransactionBufferedOperation
    ): TransactionBufferedOperation {
        return {
            op: operation.op,
            path: [...operation.path],
            oldValue: operation.oldValue,
            newValue: operation.newValue,
            editSource: operation.editSource ?? null,
            compileChangeSource: operation.compileChangeSource ?? null,
            compileEditType: operation.compileEditType ?? null,
            visualAnchorSide: operation.visualAnchorSide ?? null,
            workerReplayTargets: normalizeWorkerReplayTargets(
                operation.workerReplayTargets
            ),
            applyPath: operation.applyPath
                ? [...operation.applyPath]
                : undefined,
            applyOldValue: operation.applyOldValue,
            applyNewValue: operation.applyNewValue,
            applyMode: operation.applyMode ?? 'default'
        };
    }

    private _cloneBufferedOperation(
        operation: TransactionBufferedOperation
    ): TransactionBufferedOperation {
        return {
            ...operation,
            path: [...operation.path],
            oldValue: cloneHistoryValue(operation.oldValue),
            newValue: cloneHistoryValue(operation.newValue),
            editSource: operation.editSource ?? null,
            compileChangeSource: operation.compileChangeSource ?? null,
            compileEditType: operation.compileEditType ?? null,
            workerReplayTargets: normalizeWorkerReplayTargets(
                operation.workerReplayTargets
            ),
            applyPath: operation.applyPath
                ? [...operation.applyPath]
                : undefined,
            applyOldValue:
                operation.applyOldValue === undefined
                    ? undefined
                    : cloneHistoryValue(operation.applyOldValue),
            applyNewValue:
                operation.applyNewValue === undefined
                    ? undefined
                    : cloneHistoryValue(operation.applyNewValue),
            applyMode: operation.applyMode ?? 'default'
        };
    }

    private _commitOperations(
        operations: TransactionBufferedOperation[],
        label: string | null,
        transactionId: number | null,
        historyItemId?: string | null,
        historyTarget?: TransactionHistoryTarget | null
    ): TransactionCommitResult | null {
        const normalizedOperations = operations.filter(
            (operation) => operation.path.length > 0
        );
        if (!normalizedOperations.length) {
            return null;
        }

        let finalizedOperations = normalizedOperations;
        if (this._transactionFinalizer) {
            const derivedOperations = this._transactionFinalizer(
                normalizedOperations.map((operation) =>
                    this._cloneBufferedOperation(operation)
                ),
                {
                    label,
                    transactionId,
                    historyItemId: historyItemId ?? this._txHistoryItemId,
                    historyTarget: historyTarget ?? this._txHistoryTarget
                }
            );
            if (derivedOperations?.length) {
                finalizedOperations = [
                    ...normalizedOperations,
                    ...derivedOperations.map((operation) =>
                        this._normalizeBufferedOperation(operation)
                    )
                ];
            }
        }

        // Snapshot-mode operations carry a full layer/glyph object and are
        // always material changes, so skip the no-op reduction. Default-mode
        // property changes (e.g. feature code edits) may be no-ops and still
        // need the reduction to filter them out.
        const effectiveOperations =
            finalizedOperations.length === 1 &&
            (finalizedOperations[0].applyMode === 'layer-snapshot' ||
                finalizedOperations[0].applyMode === 'glyph-snapshot')
                ? finalizedOperations
                : this._reduceToNetChangingOperations(finalizedOperations);
        if (!effectiveOperations.length) {
            return null;
        }

        const scopeInfo = this._deriveBufferedScope(effectiveOperations);
        this._prepareBatchUndoManagers(scopeInfo);

        const nextHistoryItemId =
            historyItemId ?? this._getCurrentHistoryItemId();
        const timestamp = Date.now();
        const transactionDurationMs =
            transactionId !== null && this._txStartTimeMs !== null
                ? Math.max(0, performance.now() - this._txStartTimeMs)
                : null;
        const changeLogEntries: ChangeLogEntry[] = [];

        for (const operation of effectiveOperations) {
            const operationHistoryTarget =
                historyTarget ?? this._deriveHistoryTarget(operation.path);
            const workerReplayTargets =
                this._deriveWorkerReplayTargets(operation);
            const entry = createLogEntry({
                timestamp,
                windowId: this.windowId,
                windowRoleLabel: this._getWindowRoleLabel(),
                historyItemId: nextHistoryItemId,
                historyAction: 'change',
                transactionLabel: label,
                transactionId,
                transactionDurationMs,
                op: operation.op,
                undoScope: this._deriveUndoScope(
                    deriveGlyphName(operation.path),
                    deriveLayerId(operation.path)
                ),
                path: joinPathWithGlyphSeparator(operation.path),
                oldValue: operation.oldValue,
                newValue: operation.newValue,
                editSource: operation.editSource ?? null,
                compileChangeSource: operation.compileChangeSource ?? null,
                compileEditType: operation.compileEditType ?? null,
                replayOldValue: this._cloneReplayValue(
                    operation.applyOldValue === undefined
                        ? operation.oldValue
                        : operation.applyOldValue
                ),
                replayNewValue: this._cloneReplayValue(
                    operation.applyNewValue === undefined
                        ? operation.newValue
                        : operation.applyNewValue
                ),
                visualAnchorSide: operation.visualAnchorSide ?? null,
                workerReplayTargets,
                historyTargetType: operationHistoryTarget?.type ?? null,
                historyTargetKey: operationHistoryTarget?.key ?? null,
                historyTargetLabel: operationHistoryTarget?.label ?? null
            });
            changeLogEntries.push(entry);
        }

        this._appendChangeLogEntries(changeLogEntries);

        const localUpdateBaseline =
            this._txStartStateVector ?? this._lastBroadcastStateVector;

        this._suppressAutomaticLocalUpdateEmission = true;
        try {
            this.yDoc.transact(() => {
                for (const operation of effectiveOperations) {
                    this._applyBufferedOperation(operation);
                }
            }, scopeInfo.origin);
        } finally {
            this._suppressAutomaticLocalUpdateEmission = false;
        }

        const exactCommitUpdate = Y.encodeStateAsUpdate(
            this.yDoc,
            localUpdateBaseline
        );
        this._lastBroadcastStateVector = Y.encodeStateVector(this.yDoc);

        if (!this._isApplyingRemote) {
            this._lastLocalUpdateLogIndex = this._changeLog.length;
            if (exactCommitUpdate.length > 0) {
                this._emitLocalUpdate(exactCommitUpdate, changeLogEntries);
            }
        }

        this._recordUndoHistoryItem(
            scopeInfo.scope,
            scopeInfo.glyphName,
            scopeInfo.layerId,
            nextHistoryItemId
        );

        this._finishBatchUndoManagers(scopeInfo);
        this._onDirty?.();

        if (effectiveOperations.length === 1) {
            console.log(
                `[PatchSyncEngine] Change recorded: ${joinPathWithGlyphSeparator(effectiveOperations[0].path)}`
            );
        }

        return {
            changeLogEntries,
            workerReplayTargets: normalizeWorkerReplayTargets(
                changeLogEntries.flatMap((entry) => entry.workerReplayTargets)
            ),
            changedGlyphNames: [
                ...new Set(
                    changeLogEntries
                        .map((entry) => deriveGlyphNameFromPath(entry.path))
                        .filter((glyphName): glyphName is string =>
                            Boolean(glyphName)
                        )
                )
            ],
            changedLayerIds: [
                ...new Set(
                    changeLogEntries
                        .map((entry) => deriveLayerIdFromPath(entry.path))
                        .filter((layerId): layerId is string =>
                            Boolean(layerId)
                        )
                )
            ]
        };
    }

    private _deriveWorkerReplayTargets(
        operation: TransactionBufferedOperation
    ): WorkerReplayTarget[] {
        const explicitTargets = normalizeWorkerReplayTargets(
            operation.workerReplayTargets
        );
        if (explicitTargets.length) {
            return explicitTargets;
        }

        const applyPath = operation.applyPath ?? operation.path;
        const glyphName = deriveGlyphName(applyPath);
        const layerId = deriveLayerId(applyPath);

        if (glyphName && layerId) {
            return [{ glyphName, layerId }];
        }

        if (
            operation.applyMode !== 'glyph-snapshot' ||
            operation.op !== 'set' ||
            !glyphName
        ) {
            return [];
        }

        const glyphSnapshot =
            operation.applyNewValue === undefined
                ? operation.newValue
                : operation.applyNewValue;
        if (!glyphSnapshot || typeof glyphSnapshot !== 'object') {
            return [];
        }

        const layers = Array.isArray((glyphSnapshot as Unsafe).layers)
            ? ((glyphSnapshot as Unsafe).layers as Unsafe[])
            : [];
        return normalizeWorkerReplayTargets(
            layers.map((layer) => {
                const snapshotLayerId =
                    layer && typeof layer === 'object'
                        ? String(layer.id || '')
                        : '';
                return snapshotLayerId
                    ? {
                          glyphName,
                          layerId: snapshotLayerId
                      }
                    : null;
            })
        );
    }

    private _reduceToNetChangingOperations(
        operations: TransactionBufferedOperation[]
    ): TransactionBufferedOperation[] {
        const byApplyPath = new Map<
            string,
            {
                originalValue: unknown;
                finalValue: unknown;
            }
        >();

        operations.forEach((operation) => {
            const applyPath = this._toYDocPath(
                operation.applyPath ?? operation.path
            );
            const pathKey = JSON.stringify(applyPath);
            const existing = byApplyPath.get(pathKey);
            const finalValue =
                operation.op === 'remove'
                    ? undefined
                    : cloneHistoryValue(
                          operation.applyNewValue === undefined
                              ? operation.newValue
                              : operation.applyNewValue
                      );

            if (!existing) {
                byApplyPath.set(pathKey, {
                    finalValue,
                    originalValue: cloneHistoryValue(
                        getYPath(this.fontMap, applyPath)
                    )
                });
                return;
            }

            existing.finalValue = finalValue;
        });

        const noOpPathKeys = new Set(
            Array.from(byApplyPath.entries())
                .filter(([, entry]) =>
                    this._isDeepEqual(entry.originalValue, entry.finalValue)
                )
                .map(([pathKey]) => pathKey)
        );

        if (!noOpPathKeys.size) {
            return operations;
        }

        return operations.filter((operation) => {
            const applyPath = this._toYDocPath(
                operation.applyPath ?? operation.path
            );
            const pathKey = JSON.stringify(applyPath);
            return !noOpPathKeys.has(pathKey);
        });
    }

    private _applyBufferedOperation(
        operation: TransactionBufferedOperation
    ): void {
        const applyPath = this._toYDocPath(
            operation.applyPath ?? operation.path
        );
        const applyValue =
            operation.applyNewValue === undefined
                ? operation.newValue
                : operation.applyNewValue;

        if (operation.op === 'remove') {
            deleteYPath(this.fontMap, applyPath);
            return;
        }

        if (
            operation.applyMode === 'glyph-snapshot' &&
            operation.op === 'set' &&
            this._isGlyphRootPath(applyPath)
        ) {
            this._applyGlyphSnapshot(String(applyPath[1]), applyValue);
            return;
        }

        if (
            operation.applyMode === 'layer-snapshot' &&
            operation.op === 'set' &&
            applyPath.length === 4 &&
            applyPath[0] === 'glyphs' &&
            applyPath[2] === 'layers'
        ) {
            this._applyLayerDelta(
                String(applyPath[1]),
                String(applyPath[3]),
                applyValue
            );
            return;
        }

        setYPath(this.fontMap, applyPath, applyValue);
    }

    private _deriveBufferedScope(operations: TransactionBufferedOperation[]): {
        scope: UndoScope;
        origin: string;
        glyphName: string | null;
        layerId: string | null;
    } {
        const touchedGlyphNames = new Set<string>();
        const touchedLayerKeys = new Set<string>();
        let hasFontScopedChange = false;
        let hasGlyphScopedChange = false;

        for (const operation of operations) {
            const glyphName = deriveGlyphName(operation.path);
            const layerId = deriveLayerId(operation.path);
            if (!glyphName) {
                hasFontScopedChange = true;
            }
            if (glyphName) {
                touchedGlyphNames.add(glyphName);
            }
            if (glyphName && layerId) {
                touchedLayerKeys.add(getLayerManagerKey(glyphName, layerId));
            } else if (glyphName) {
                hasGlyphScopedChange = true;
            }
        }

        if (!hasFontScopedChange && touchedGlyphNames.size === 1) {
            const glyphName = [...touchedGlyphNames][0];
            if (!hasGlyphScopedChange && touchedLayerKeys.size === 1) {
                const [managerKey] = [...touchedLayerKeys];
                const [, layerId] = managerKey.split('@@');
                return {
                    scope: 'layer',
                    origin: this._getEditOrigin(glyphName, layerId, 'layer'),
                    glyphName,
                    layerId
                };
            }
            return {
                scope: 'glyph',
                origin: this._getEditOrigin(glyphName, null, 'glyph'),
                glyphName,
                layerId: null
            };
        }

        return {
            scope: 'font',
            origin: FONT_EDIT_ORIGIN,
            glyphName: null,
            layerId: null
        };
    }

    private _prepareBatchUndoManagers(scopeInfo: {
        scope: UndoScope;
        glyphName: string | null;
        layerId: string | null;
    }): void {
        if (
            scopeInfo.scope === 'layer' &&
            scopeInfo.glyphName &&
            scopeInfo.layerId
        ) {
            this.getLayerUndoManager(
                scopeInfo.glyphName,
                scopeInfo.layerId
            )?.stopCapturing();
            return;
        }
        if (scopeInfo.scope === 'glyph' && scopeInfo.glyphName) {
            this.getGlyphUndoManager(scopeInfo.glyphName)?.stopCapturing();
            return;
        }
        this._fontUndoManager?.stopCapturing();
    }

    private _finishBatchUndoManagers(scopeInfo: {
        scope: UndoScope;
        glyphName: string | null;
        layerId: string | null;
    }): void {
        if (
            scopeInfo.scope === 'layer' &&
            scopeInfo.glyphName &&
            scopeInfo.layerId
        ) {
            this.getLayerUndoManager(
                scopeInfo.glyphName,
                scopeInfo.layerId
            )?.stopCapturing();
            return;
        }
        if (scopeInfo.scope === 'glyph' && scopeInfo.glyphName) {
            this.getGlyphUndoManager(scopeInfo.glyphName)?.stopCapturing();
            return;
        }
        this._fontUndoManager?.stopCapturing();
    }

    private _getEditOrigin(
        glyphName: string | null,
        layerId: string | null,
        scope: UndoScope
    ): string {
        if (scope === 'layer' && glyphName && layerId) {
            return getLayerEditOrigin(glyphName, layerId);
        }
        if (scope === 'glyph') {
            return GLYPH_EDIT_ORIGIN;
        }
        return FONT_EDIT_ORIGIN;
    }

    private _getUndoHistoryScopeKey(
        scope: UndoScope,
        glyphName: string | null,
        layerId: string | null
    ): string {
        if (scope === 'layer' && glyphName && layerId) {
            return getLayerManagerKey(glyphName, layerId);
        }
        if (scope === 'glyph' && glyphName) {
            return glyphName;
        }
        return FONT_UNDO_HISTORY_KEY;
    }

    private _getUndoHistoryStacksForScope(
        scope: UndoScope,
        glyphName: string | null,
        layerId: string | null
    ): UndoHistoryStacks {
        const key = this._getUndoHistoryScopeKey(scope, glyphName, layerId);
        const existing = this._undoHistoryStacks.get(key);
        if (existing) {
            return existing;
        }

        const created: UndoHistoryStacks = { active: [], undone: [] };
        this._undoHistoryStacks.set(key, created);
        return created;
    }

    private _recordUndoHistoryItem(
        scope: UndoScope,
        glyphName: string | null,
        layerId: string | null,
        historyItemId: string
    ): void {
        const stacks = this._getUndoHistoryStacksForScope(
            scope,
            glyphName,
            layerId
        );
        removeHistoryItemFromStack(stacks.active, historyItemId);
        removeHistoryItemFromStack(stacks.undone, historyItemId);
        stacks.active.push(historyItemId);
        stacks.undone.length = 0;
    }

    private _peekUndoHistoryItemId(
        scope: UndoScope,
        glyphName: string | null,
        layerId: string | null,
        historyAction: 'undo' | 'redo'
    ): string | null {
        const stacks = this._getUndoHistoryStacksForScope(
            scope,
            glyphName,
            layerId
        );
        const sourceStack =
            historyAction === 'undo' ? stacks.active : stacks.undone;
        return sourceStack.length ? sourceStack[sourceStack.length - 1] : null;
    }

    private _advanceUndoHistoryItem(
        scope: UndoScope,
        glyphName: string | null,
        layerId: string | null,
        historyAction: 'undo' | 'redo',
        historyItemId: string | null
    ): void {
        if (!historyItemId) {
            return;
        }

        const stacks = this._getUndoHistoryStacksForScope(
            scope,
            glyphName,
            layerId
        );
        const sourceStack =
            historyAction === 'undo' ? stacks.active : stacks.undone;
        const targetStack =
            historyAction === 'undo' ? stacks.undone : stacks.active;
        removeHistoryItemFromStack(sourceStack, historyItemId);
        removeHistoryItemFromStack(targetStack, historyItemId);
        targetStack.push(historyItemId);
    }

    private _findHistoryItemById(
        historyItemId: string | null
    ): HistoryStackItem | null {
        if (!historyItemId) {
            return null;
        }

        return (
            buildHistoryStackItems(this._changeLog, {
                includeUndone: true
            }).find((item) => item.id === historyItemId) ?? null
        );
    }

    private _resolveAuthoritativeUndoHistory(
        historyAction: 'undo' | 'redo',
        targetItem: HistoryStackItem | null,
        scope: UndoScope,
        glyphName: string | null,
        layerId: string | null
    ): ResolvedUndoHistorySource {
        const historyItemId =
            targetItem?.id ??
            this._peekUndoHistoryItemId(
                scope,
                glyphName,
                layerId,
                historyAction
            );

        return {
            historyItemId,
            historyItem: targetItem ?? this._findHistoryItemById(historyItemId)
        };
    }

    private _deriveBulkUndoScope(
        targets: Array<{ glyphName: string }>,
        layerId: string | null
    ): UndoScope {
        const glyphNames = new Set(targets.map((target) => target.glyphName));
        if (glyphNames.size !== 1) {
            return 'font';
        }
        if (layerId) {
            return 'layer';
        }
        return 'glyph';
    }

    private _getRemoteUpdateOrigin(remoteEntries?: ChangeLogEntry[]): string {
        if (!remoteEntries?.length) {
            return USER_EDIT_ORIGIN;
        }

        const targetItem = remoteEntries.find(
            (entry) => entry.historyAction === 'change'
        );
        const glyphNames = new Set(
            remoteEntries
                .map((entry) => this._deriveGlyphNameFromPath(entry.path))
                .filter((glyphName): glyphName is string => !!glyphName)
        );
        const layerKeys = new Set(
            remoteEntries
                .filter((entry) => entry.undoScope === 'layer')
                .map((entry) => {
                    const glyphName = this._deriveGlyphNameFromPath(entry.path);
                    const layerId = this._deriveLayerIdFromPath(entry.path);
                    return glyphName && layerId
                        ? getLayerManagerKey(glyphName, layerId)
                        : null;
                })
                .filter((key): key is string => !!key)
        );

        if (remoteEntries.some((entry) => entry.undoScope === 'font')) {
            return FONT_EDIT_ORIGIN;
        }
        if (layerKeys.size === 1 && glyphNames.size === 1) {
            const entry =
                targetItem ??
                remoteEntries.find(
                    (candidate) =>
                        !!this._deriveGlyphNameFromPath(candidate.path) &&
                        !!this._deriveLayerIdFromPath(candidate.path)
                );
            if (entry) {
                const glyphName = this._deriveGlyphNameFromPath(entry.path);
                const layerId = this._deriveLayerIdFromPath(entry.path);
                if (glyphName && layerId) {
                    return getLayerEditOrigin(glyphName, layerId);
                }
            }
        }
        if (glyphNames.size === 1) {
            return GLYPH_EDIT_ORIGIN;
        }
        return FONT_EDIT_ORIGIN;
    }

    private _getRemoteLayerSyncScopes(
        remoteEntries?: ChangeLogEntry[]
    ): Array<{ glyphName: string; layerId: string }> | null {
        if (!remoteEntries?.length) {
            return null;
        }

        if (
            remoteEntries.some((entry) => {
                const glyphName = this._deriveGlyphNameFromPath(entry.path);
                const layerId = this._deriveLayerIdFromPath(entry.path);
                return !!glyphName && !layerId;
            })
        ) {
            return null;
        }

        const targets = normalizeWorkerReplayTargets(
            remoteEntries.flatMap((entry) => {
                if (entry.workerReplayTargets?.length) {
                    return entry.workerReplayTargets;
                }

                if (entry.undoScope !== 'layer') {
                    return [];
                }

                const glyphName = this._deriveGlyphNameFromPath(entry.path);
                const layerId = this._deriveLayerIdFromPath(entry.path);
                return glyphName && layerId ? [{ glyphName, layerId }] : [];
            })
        );

        if (!targets.length) {
            return null;
        }

        return targets;
    }

    private _hasMaterializedLayerRoot(
        glyphName: string,
        layerId: string
    ): boolean {
        const layerValue = getYPath(this.fontMap, [
            'glyphs',
            glyphName,
            'layers',
            layerId
        ]);
        if (!(layerValue instanceof Y.Map)) {
            return false;
        }

        const layerSnapshot = fromYType(layerValue);
        if (
            !layerSnapshot ||
            typeof layerSnapshot !== 'object' ||
            Array.isArray(layerSnapshot)
        ) {
            return false;
        }

        const layerRecord = layerSnapshot as Record<string, unknown>;
        return (
            typeof layerRecord.id === 'string' &&
            layerRecord.id.length > 0 &&
            layerRecord.id === layerId
        );
    }

    private _resolveUndoHistoryItem(
        glyphName: string | undefined,
        layerId: string | null | undefined,
        historyAction: 'undo' | 'redo',
        historyTargetKey?: string | null
    ): HistoryStackItem | null {
        const resolvedGlyphName = glyphName ?? null;
        const resolvedLayerId = layerId ?? null;
        const resolvedHistoryTargetKey = historyTargetKey ?? null;

        // Prefer the newest visible history item whose backing UndoManager
        // still has stack depth. This prevents stale change-log entries from
        // blocking undo/redo after branch edits clear a manager's stack.
        const candidates = buildHistoryStackItems(this._changeLog, {
            glyphName: resolvedGlyphName,
            layerId: resolvedLayerId,
            includeUndone: true,
            historyTargetKey: resolvedHistoryTargetKey
        }).filter((item) =>
            historyAction === 'undo' ? item.isActive : !item.isActive
        );

        for (let index = candidates.length - 1; index >= 0; index--) {
            const candidate = candidates[index];
            const target = this._targetFromHistoryItem(
                candidate,
                resolvedGlyphName,
                resolvedLayerId
            );
            const { manager, scope } = this._getUndoManagerForTarget(target);
            if (scope === 'font') {
                return candidate;
            }
            if (!manager) {
                continue;
            }
            const stackDepth =
                historyAction === 'undo'
                    ? manager.undoStack.length
                    : manager.redoStack.length;
            if (stackDepth > 0) {
                return candidate;
            }
        }

        return resolveHistoryTargetItem(this._changeLog, {
            glyphName: resolvedGlyphName,
            layerId: resolvedLayerId,
            historyAction,
            historyTargetKey: resolvedHistoryTargetKey
        });
    }

    private _resolveUndoTarget(
        glyphName: string | undefined,
        layerId: string | null | undefined,
        historyAction: 'undo' | 'redo',
        targetItem?: HistoryStackItem | null
    ): UndoTarget {
        if (targetItem) {
            return this._targetFromHistoryItem(
                targetItem,
                glyphName ?? null,
                layerId ?? null
            );
        }
        return {
            glyphName: glyphName ?? null,
            layerId: layerId ?? null
        };
    }

    private _deriveHistoryTarget(
        path: (string | number)[]
    ): HistoryTarget | null {
        if (!this._fontJson || path[0] !== 'features' || path.length < 3) {
            return null;
        }

        if (path[1] === 'prefixes' && typeof path[2] === 'string') {
            return {
                type: 'prefix',
                key: `prefix:${path[2]}`,
                label: String(path[2])
            };
        }

        if (path[1] === 'classes' && typeof path[2] === 'string') {
            return {
                type: 'class',
                key: `class:${path[2]}`,
                label: String(path[2])
            };
        }

        if (path[1] !== 'features' || typeof path[2] !== 'number') {
            return null;
        }

        const features = ((this._fontJson as Unsafe).features?.features ??
            []) as Array<[string, unknown]>;
        const featureIndex = path[2];
        const featureEntry = features[featureIndex];
        if (!featureEntry) {
            return null;
        }

        const tag = String(featureEntry[0] ?? '');
        if (!tag) {
            return {
                type: 'feature',
                key: `feature-index:${featureIndex}`,
                label: `#${featureIndex + 1}`
            };
        }

        let occurrence = 0;
        for (let index = 0; index <= featureIndex; index++) {
            if (String(features[index]?.[0] ?? '') === tag) {
                occurrence += 1;
            }
        }

        return {
            type: 'feature',
            key: `feature:${tag}:${occurrence}`,
            label: occurrence > 1 ? `${tag} #${occurrence}` : tag
        };
    }

    private _getPathSegments(path: string): string[] {
        return getPathSegments(path);
    }

    private _deriveGlyphNameFromPath(path: string): string | null {
        return deriveGlyphNameFromPath(path);
    }

    private _deriveLayerIdFromPath(path: string): string | null {
        return deriveLayerIdFromPath(path);
    }

    private _parseEntryPath(path: string): (string | number)[] {
        return this._getPathSegments(path).map((segment) =>
            /^\d+$/.test(segment) ? Number.parseInt(segment, 10) : segment
        );
    }

    private _applyHistoryItem(
        item: HistoryStackItem,
        direction: 'undo' | 'redo'
    ): void {
        const entries =
            direction === 'undo' ? [...item.entries].reverse() : item.entries;

        this.yDoc.transact(() => {
            for (const entry of entries) {
                const path = this._toYDocPath(this._parseEntryPath(entry.path));
                const replayValue = this._getHistoryReplayValue(
                    entry,
                    direction
                );
                if (this._isGlyphRootPath(path) && replayValue) {
                    this._applyGlyphSnapshot(String(path[1]), replayValue);
                    continue;
                }
                if (
                    path.length === 4 &&
                    path[0] === 'glyphs' &&
                    path[2] === 'layers' &&
                    typeof path[1] === 'string' &&
                    typeof path[3] === 'string' &&
                    replayValue !== undefined
                ) {
                    this._applyLayerDelta(path[1], path[3], replayValue);
                    continue;
                }
                if (direction === 'undo') {
                    if (entry.op === 'add') {
                        deleteYPath(this.fontMap, path);
                        continue;
                    }
                    if (entry.op === 'remove' || entry.op === 'set') {
                        setYPath(this.fontMap, path, replayValue);
                    }
                    continue;
                }

                if (entry.op === 'remove') {
                    deleteYPath(this.fontMap, path);
                    continue;
                }
                setYPath(this.fontMap, path, replayValue);
            }
        }, HISTORY_REPLAY_ORIGIN);
    }

    private _getHistoryReplayValue(
        entry: ChangeLogEntry,
        direction: 'undo' | 'redo'
    ): unknown {
        if (direction === 'undo') {
            return entry.replayOldValue ?? entry.oldValue;
        }
        return entry.replayNewValue ?? entry.newValue;
    }

    private _cloneReplayValue(value: unknown): unknown {
        return value === undefined ? undefined : cloneHistoryValue(value);
    }

    private _canReplayHistoryItemDirectly(
        item: HistoryStackItem,
        direction: 'undo' | 'redo'
    ): boolean {
        if (!item.entries.length) {
            return false;
        }

        return item.entries.every((entry) => {
            // Direct replay supports 'set', 'add', and 'remove' ops.
            // 'add' on undo → deleteYPath (no replay value needed).
            // 'remove' on redo → deleteYPath (no replay value needed).
            // 'set' always needs a replay value.
            const needsReplayValue =
                entry.op === 'set' ||
                (entry.op === 'remove' && direction === 'undo') ||
                (entry.op === 'add' && direction === 'redo');

            if (needsReplayValue) {
                const replayValue =
                    direction === 'undo'
                        ? entry.replayOldValue
                        : entry.replayNewValue;
                if (replayValue === undefined) {
                    return false;
                }

                const path = this._toYDocPath(this._parseEntryPath(entry.path));

                if (this._isGlyphRootPath(path)) {
                    return !!replayValue && typeof replayValue === 'object';
                }

                if (
                    path.length === 4 &&
                    path[0] === 'glyphs' &&
                    path[2] === 'layers' &&
                    typeof path[1] === 'string' &&
                    typeof path[3] === 'string'
                ) {
                    return !!replayValue && typeof replayValue === 'object';
                }
            }

            return true;
        });
    }

    private _isGlyphRootPath(path: (string | number)[]): boolean {
        return path.length === 2 && path[0] === 'glyphs' && !!path[1];
    }

    /**
     * Replace a Y.Array's contents without replacing the array object itself.
     * This keeps the shared container identity stable across windows.
     *
     * Uses LCS-based minimal diff (diffYArray) instead of full teardown
     * to produce smaller Yjs deltas for length-changing edits to
     * features.features, kern-group lists, and codepoints.
     */
    private _replaceYArrayContents(
        targetArray: Y.Array<unknown>,
        nextValues: unknown[]
    ): void {
        diffYArray(targetArray, nextValues);
    }

    private _replaceYArrayEntry(
        targetArray: Y.Array<unknown>,
        index: number,
        nextValue: unknown
    ): void {
        const currentValue = targetArray.get(index);
        const currentJsonValue =
            currentValue instanceof Y.Map || currentValue instanceof Y.Array
                ? fromYType(currentValue)
                : currentValue;

        if (this._isDeepEqual(currentJsonValue, nextValue)) {
            return;
        }

        if (Array.isArray(nextValue)) {
            if (currentValue instanceof Y.Array) {
                this._replaceYArrayContents(currentValue, nextValue);
            } else {
                targetArray.delete(index, 1);
                targetArray.insert(index, [toYType(nextValue)]);
            }
            return;
        }

        if (
            nextValue &&
            typeof nextValue === 'object' &&
            !Array.isArray(nextValue)
        ) {
            const nextRecord = nextValue as Record<string, unknown>;
            if (currentValue instanceof Y.Map) {
                this._replaceYMapContents(currentValue, nextRecord);
            } else {
                targetArray.delete(index, 1);
                targetArray.insert(index, [toYType(nextRecord)]);
            }
            return;
        }

        targetArray.delete(index, 1);
        targetArray.insert(index, [nextValue]);
    }

    /**
     * Replace a Y.Map's entries in place, deleting keys absent from the
     * incoming snapshot and recursively reusing nested shared containers.
     */
    private _replaceYMapContents(
        targetMap: Y.Map<unknown>,
        nextRecord: Record<string, unknown>
    ): void {
        const nextKeys = new Set(Object.keys(nextRecord));
        targetMap.forEach((_value: unknown, key: string) => {
            if (!nextKeys.has(key)) {
                targetMap.delete(key);
            }
        });

        for (const [key, value] of Object.entries(nextRecord)) {
            this._replaceYMapEntry(targetMap, key, value);
        }
    }

    /**
     * Replace one Y.Map entry while preserving nested Y.Map/YArray objects
     * when the incoming value has the same container shape.
     */
    private _replaceYMapEntry(
        targetMap: Y.Map<unknown>,
        key: string,
        nextValue: unknown
    ): void {
        const currentValue = targetMap.get(key);
        const currentJsonValue =
            currentValue instanceof Y.Map || currentValue instanceof Y.Array
                ? fromYType(currentValue)
                : currentValue;

        if (this._isDeepEqual(currentJsonValue, nextValue)) {
            return;
        }

        if (Array.isArray(nextValue)) {
            if (currentValue instanceof Y.Array) {
                this._replaceYArrayContents(currentValue, nextValue);
            } else {
                targetMap.set(key, toYType(nextValue));
            }
            return;
        }

        if (
            nextValue &&
            typeof nextValue === 'object' &&
            !Array.isArray(nextValue)
        ) {
            const nextRecord = nextValue as Record<string, unknown>;
            if (currentValue instanceof Y.Map) {
                this._replaceYMapContents(currentValue, nextRecord);
            } else {
                const nestedMap = new Y.Map<unknown>();
                targetMap.set(key, nestedMap);
                this._replaceYMapContents(nestedMap, nextRecord);
            }
            return;
        }

        targetMap.set(key, nextValue);
    }

    private _applyGlyphSnapshot(
        glyphName: string,
        glyphSnapshot: unknown
    ): void {
        if (!glyphSnapshot || typeof glyphSnapshot !== 'object') {
            setYPath(this.fontMap, ['glyphs', glyphName], glyphSnapshot);
            return;
        }

        const glyphsMap = this.fontMap.get('glyphs');
        if (!(glyphsMap instanceof Y.Map)) {
            return;
        }

        let glyphMap = glyphsMap.get(glyphName) as Y.Map<unknown> | undefined;
        if (!(glyphMap instanceof Y.Map)) {
            glyphMap = new Y.Map<unknown>();
            glyphsMap.set(glyphName, glyphMap);
        }

        const existingGlyphSnapshot =
            fromYType(glyphMap) ??
            (this._fontJson as Unsafe)?.glyphs?.find(
                (glyph: Record<string, unknown>) => glyph?.name === glyphName
            );
        const glyphJson = this._normalizeGlyphSnapshot(
            glyphSnapshot,
            existingGlyphSnapshot
        ) as Record<string, unknown>;

        for (const [gk, gv] of Object.entries(glyphJson)) {
            if (gk === 'layers' && Array.isArray(gv)) {
                let layersMap = glyphMap.get('layers') as
                    | Y.Map<unknown>
                    | undefined;
                if (!(layersMap instanceof Y.Map)) {
                    layersMap = new Y.Map<unknown>();
                    glyphMap.set('layers', layersMap);
                }

                const nextLayerIds = new Set<string>();
                for (const layerJson of gv as Record<string, unknown>[]) {
                    const layerId = (layerJson.id as string) ?? '';
                    if (!layerId) {
                        continue;
                    }
                    nextLayerIds.add(layerId);
                    // Patch the existing layerMap in place to preserve the
                    // Y.Map instance reference so layer UndoManagers (which
                    // register on the specific Y.Map object) remain valid
                    // after a glyph snapshot is applied.
                    let layerMap = layersMap.get(layerId) as
                        | Y.Map<unknown>
                        | undefined;
                    if (!(layerMap instanceof Y.Map)) {
                        layerMap = new Y.Map<unknown>();
                        layersMap.set(layerId, layerMap);
                    }
                    const normalizedLayerJson = this._normalizeLayerSnapshot(
                        layerId,
                        layerJson,
                        fromYType(layerMap)
                    ) as Record<string, unknown>;
                    this._replaceYMapContents(layerMap, normalizedLayerJson);
                }

                // Remove layers that are no longer in the snapshot
                layersMap.forEach((_value: unknown, key: string) => {
                    if (!nextLayerIds.has(key)) {
                        layersMap?.delete(key);
                    }
                });
                continue;
            }

            this._replaceYMapEntry(glyphMap, gk, gv);
        }

        // Remove glyph-level keys no longer in the snapshot
        const glyphKeys = new Set(Object.keys(glyphJson));
        glyphMap.forEach((_value: unknown, key: string) => {
            if (!glyphKeys.has(key)) {
                glyphMap?.delete(key);
            }
        });
    }

    private _normalizeFontSnapshot(
        fontSnapshot: unknown,
        existingFontSnapshot?: unknown
    ): unknown {
        if (
            !fontSnapshot ||
            typeof fontSnapshot !== 'object' ||
            Array.isArray(fontSnapshot)
        ) {
            return fontSnapshot;
        }

        const existingFontRecord =
            existingFontSnapshot &&
            typeof existingFontSnapshot === 'object' &&
            !Array.isArray(existingFontSnapshot)
                ? (cloneHistoryValue(existingFontSnapshot) as Record<
                      string,
                      unknown
                  >)
                : {};
        const normalizedFontRecord = cloneHistoryValue(fontSnapshot) as Record<
            string,
            unknown
        >;

        if (
            Object.prototype.hasOwnProperty.call(normalizedFontRecord, 'glyphs')
        ) {
            const incomingGlyphs = this._coerceFontGlyphSnapshots(
                normalizedFontRecord.glyphs
            );
            const existingGlyphs = this._coerceFontGlyphSnapshots(
                existingFontRecord.glyphs
            );
            const existingGlyphsByName = new Map(
                existingGlyphs
                    .filter(
                        (glyph): glyph is Record<string, unknown> =>
                            !!glyph && typeof glyph === 'object'
                    )
                    .map((glyph) => [String(glyph.name || ''), glyph])
            );

            normalizedFontRecord.glyphs = incomingGlyphs
                .map((glyph) => {
                    const glyphName =
                        glyph && typeof glyph === 'object'
                            ? String(glyph.name || '')
                            : '';
                    if (!glyphName) {
                        return null;
                    }

                    return this._normalizeGlyphSnapshot(
                        glyph,
                        existingGlyphsByName.get(glyphName)
                    );
                })
                .filter((glyph): glyph is Record<string, unknown> => !!glyph);
        }

        return normalizedFontRecord;
    }

    private _coerceFontGlyphSnapshots(
        glyphsSnapshot: unknown
    ): Array<Record<string, unknown>> {
        if (Array.isArray(glyphsSnapshot)) {
            return glyphsSnapshot.filter(
                (glyph): glyph is Record<string, unknown> =>
                    !!glyph &&
                    typeof glyph === 'object' &&
                    !Array.isArray(glyph)
            );
        }

        if (
            glyphsSnapshot &&
            typeof glyphsSnapshot === 'object' &&
            !Array.isArray(glyphsSnapshot)
        ) {
            return Object.entries(glyphsSnapshot as Record<string, unknown>)
                .filter(([, glyph]) => !!glyph && typeof glyph === 'object')
                .map(([glyphName, glyph]) => {
                    const glyphRecord = cloneHistoryValue(glyph) as Record<
                        string,
                        unknown
                    >;
                    if (
                        typeof glyphRecord.name !== 'string' ||
                        !glyphRecord.name.length
                    ) {
                        glyphRecord.name = glyphName;
                    }
                    return glyphRecord;
                });
        }

        return [];
    }

    private _normalizeGlyphSnapshot(
        glyphSnapshot: unknown,
        existingGlyphSnapshot?: unknown
    ): unknown {
        if (
            !glyphSnapshot ||
            typeof glyphSnapshot !== 'object' ||
            Array.isArray(glyphSnapshot)
        ) {
            return glyphSnapshot;
        }

        const existingGlyphRecord =
            existingGlyphSnapshot &&
            typeof existingGlyphSnapshot === 'object' &&
            !Array.isArray(existingGlyphSnapshot)
                ? (cloneHistoryValue(existingGlyphSnapshot) as Record<
                      string,
                      unknown
                  >)
                : {};
        const incomingGlyphRecord = cloneHistoryValue(glyphSnapshot) as Record<
            string,
            unknown
        >;
        const mergedGlyphRecord = {
            ...existingGlyphRecord,
            ...incomingGlyphRecord
        };

        if (
            Object.prototype.hasOwnProperty.call(incomingGlyphRecord, 'layers')
        ) {
            const incomingLayers = this._coerceGlyphLayerSnapshots(
                incomingGlyphRecord.layers
            );
            const existingLayers = this._coerceGlyphLayerSnapshots(
                existingGlyphRecord.layers
            );
            const existingLayersById = new Map(
                existingLayers
                    .filter(
                        (layer): layer is Record<string, unknown> =>
                            !!layer && typeof layer === 'object'
                    )
                    .map((layer) => [String(layer.id || ''), layer])
            );

            mergedGlyphRecord.layers = incomingLayers
                .map((layer) => {
                    const layerId =
                        layer && typeof layer === 'object'
                            ? String(layer.id || '')
                            : '';
                    if (!layerId) {
                        return null;
                    }
                    return this._normalizeLayerSnapshot(
                        layerId,
                        layer,
                        existingLayersById.get(layerId)
                    );
                })
                .filter((layer): layer is Record<string, unknown> => !!layer);
        }

        return mergedGlyphRecord;
    }

    private _coerceGlyphLayerSnapshots(
        layersSnapshot: unknown
    ): Array<Record<string, unknown>> {
        if (Array.isArray(layersSnapshot)) {
            return layersSnapshot.filter(
                (layer): layer is Record<string, unknown> =>
                    !!layer &&
                    typeof layer === 'object' &&
                    !Array.isArray(layer)
            );
        }

        if (
            layersSnapshot &&
            typeof layersSnapshot === 'object' &&
            !Array.isArray(layersSnapshot)
        ) {
            return Object.entries(layersSnapshot as Record<string, unknown>)
                .filter(([, layer]) => !!layer && typeof layer === 'object')
                .map(([layerId, layer]) => {
                    const layerRecord = cloneHistoryValue(layer) as Record<
                        string,
                        unknown
                    >;
                    if (
                        typeof layerRecord.id !== 'string' ||
                        !layerRecord.id.length
                    ) {
                        layerRecord.id = layerId;
                    }
                    return layerRecord;
                });
        }

        return [];
    }

    private _canonicalizeFullStateRawFontJson(): void {
        const fontJson = this._fontJson as Unsafe;
        if (
            !fontJson ||
            typeof fontJson !== 'object' ||
            Array.isArray(fontJson)
        ) {
            return;
        }

        const masterNameById = new Map<string, string>();
        const masters = Array.isArray(fontJson.masters)
            ? (fontJson.masters as Unsafe[])
            : [];

        for (const master of masters) {
            if (
                !master ||
                typeof master !== 'object' ||
                Array.isArray(master)
            ) {
                continue;
            }

            const masterId =
                typeof master.id === 'string' && master.id.length
                    ? master.id
                    : '';
            const masterName =
                typeof master.name === 'string'
                    ? master.name
                    : master.name &&
                        typeof master.name === 'object' &&
                        typeof (master.name as Record<string, unknown>).dflt ===
                            'string'
                      ? String(
                            (master.name as Record<string, unknown>).dflt || ''
                        )
                      : '';

            if (masterId && masterName) {
                masterNameById.set(masterId, masterName);
            }
        }

        const glyphs = Array.isArray(fontJson.glyphs)
            ? (fontJson.glyphs as Unsafe[])
            : [];
        for (const glyph of glyphs) {
            if (!glyph || typeof glyph !== 'object' || Array.isArray(glyph)) {
                continue;
            }

            const layers = Array.isArray(glyph.layers)
                ? (glyph.layers as Unsafe[])
                : [];
            for (const layer of layers) {
                if (
                    !layer ||
                    typeof layer !== 'object' ||
                    Array.isArray(layer)
                ) {
                    continue;
                }

                if (layer.height === undefined) {
                    delete layer.height;
                }
                if (layer.vertWidth === undefined) {
                    delete layer.vertWidth;
                }
                if (layer.isInterpolated === false) {
                    delete layer.isInterpolated;
                }
                if (layer.name === undefined) {
                    delete layer.name;
                }

                const master = layer.master;
                if (
                    !master ||
                    typeof master !== 'object' ||
                    Array.isArray(master) ||
                    master.type !== 'DefaultForMaster' ||
                    typeof master.master !== 'string' ||
                    !master.master.length
                ) {
                    continue;
                }

                const masterName = masterNameById.get(master.master);
                if (
                    typeof layer.name === 'string' &&
                    (!layer.name.length ||
                        (masterName && layer.name === masterName))
                ) {
                    delete layer.name;
                }
            }
        }
    }

    private _getKnownMasterIds(): Set<string> {
        const masterIds = new Set<string>();
        const masters = (this._fontJson as Unsafe)?.masters;
        if (!Array.isArray(masters)) {
            return masterIds;
        }

        for (const master of masters) {
            const masterId =
                master && typeof master === 'object'
                    ? String((master as Record<string, unknown>).id || '')
                    : '';
            if (masterId) {
                masterIds.add(masterId);
            }
        }

        return masterIds;
    }

    private _normalizeLayerMasterSnapshot(
        layerId: string,
        layerRecord: Record<string, unknown>,
        existingLayerRecord: Record<string, unknown>
    ): void {
        const normalizeMasterValue = (
            masterValue: unknown
        ): Record<string, unknown> | null => {
            if (!masterValue || typeof masterValue !== 'object') {
                if (typeof masterValue === 'string' && masterValue.length) {
                    return {
                        type: 'DefaultForMaster',
                        master: masterValue
                    };
                }
                return null;
            }

            if (Array.isArray(masterValue)) {
                return null;
            }

            const masterRecord = cloneHistoryValue(masterValue) as Record<
                string,
                unknown
            >;

            if (masterRecord.type === 'FreeFloating') {
                return { type: 'FreeFloating' };
            }

            if (
                (masterRecord.type === 'DefaultForMaster' ||
                    masterRecord.type === 'AssociatedWithMaster') &&
                typeof masterRecord.master === 'string' &&
                masterRecord.master.length
            ) {
                return {
                    type: masterRecord.type,
                    master: masterRecord.master
                };
            }

            if (
                typeof masterRecord.master === 'string' &&
                masterRecord.master.length
            ) {
                return {
                    type: 'DefaultForMaster',
                    master: masterRecord.master
                };
            }

            if (
                typeof masterRecord.DefaultForMaster === 'string' &&
                masterRecord.DefaultForMaster.length
            ) {
                return {
                    type: 'DefaultForMaster',
                    master: masterRecord.DefaultForMaster
                };
            }

            if (
                typeof masterRecord.default_for_master === 'string' &&
                masterRecord.default_for_master.length
            ) {
                return {
                    type: 'DefaultForMaster',
                    master: masterRecord.default_for_master
                };
            }

            if (
                typeof masterRecord.AssociatedWithMaster === 'string' &&
                masterRecord.AssociatedWithMaster.length
            ) {
                return {
                    type: 'AssociatedWithMaster',
                    master: masterRecord.AssociatedWithMaster
                };
            }

            if (
                typeof masterRecord.associated_with_master === 'string' &&
                masterRecord.associated_with_master.length
            ) {
                return {
                    type: 'AssociatedWithMaster',
                    master: masterRecord.associated_with_master
                };
            }

            if ('FreeFloating' in masterRecord) {
                return { type: 'FreeFloating' };
            }

            return null;
        };

        const normalizedMaster =
            normalizeMasterValue(layerRecord.master) ??
            normalizeMasterValue(existingLayerRecord.master);

        if (normalizedMaster) {
            layerRecord.master = normalizedMaster;
            return;
        }

        if (
            layerRecord.is_background !== true &&
            this._getKnownMasterIds().has(layerId)
        ) {
            layerRecord.master = {
                type: 'DefaultForMaster',
                master: layerId
            };
        }
    }

    private _normalizeLayerSnapshot(
        layerId: string,
        layerSnapshot: unknown,
        existingLayerSnapshot?: unknown,
        preserveMissingKeys = true,
        isExistingFresh?: boolean
    ): unknown {
        if (
            !layerSnapshot ||
            typeof layerSnapshot !== 'object' ||
            Array.isArray(layerSnapshot)
        ) {
            return layerSnapshot;
        }

        const existingLayerRecord =
            existingLayerSnapshot &&
            typeof existingLayerSnapshot === 'object' &&
            !Array.isArray(existingLayerSnapshot)
                ? isExistingFresh
                    ? (existingLayerSnapshot as Record<string, unknown>)
                    : (cloneHistoryValue(existingLayerSnapshot) as Record<
                          string,
                          unknown
                      >)
                : {};
        const incomingLayerRecord = cloneHistoryValue(layerSnapshot) as Record<
            string,
            unknown
        >;
        const mergedLayerRecord = preserveMissingKeys
            ? {
                  ...existingLayerRecord,
                  ...incomingLayerRecord
              }
            : { ...incomingLayerRecord };

        if (
            typeof mergedLayerRecord.id !== 'string' ||
            !mergedLayerRecord.id.length
        ) {
            mergedLayerRecord.id = layerId;
        }

        this._normalizeLayerMasterSnapshot(
            layerId,
            mergedLayerRecord,
            existingLayerRecord
        );

        const layerMaster = mergedLayerRecord.master as
            | Record<string, unknown>
            | undefined;
        if (
            layerMaster &&
            typeof layerMaster === 'object' &&
            !Array.isArray(layerMaster) &&
            layerMaster.type === 'DefaultForMaster' &&
            typeof layerMaster.master === 'string' &&
            typeof mergedLayerRecord.name === 'string'
        ) {
            const masterName = Array.isArray(
                (this._fontJson as Unsafe)?.masters
            )
                ? (((this._fontJson as Unsafe).masters as Unsafe[]).find(
                      (master) => master?.id === layerMaster.master
                  )?.name as string | { dflt?: string } | undefined)
                : undefined;
            const normalizedMasterName =
                typeof masterName === 'string'
                    ? masterName
                    : masterName && typeof masterName === 'object'
                      ? String(masterName.dflt || '')
                      : '';
            if (
                !mergedLayerRecord.name.length ||
                (normalizedMasterName &&
                    mergedLayerRecord.name === normalizedMasterName)
            ) {
                delete mergedLayerRecord.name;
            }
        }

        if (
            typeof mergedLayerRecord.width !== 'number' ||
            !Number.isFinite(mergedLayerRecord.width)
        ) {
            const incomingHasWidth = Object.prototype.hasOwnProperty.call(
                incomingLayerRecord,
                'width'
            );
            const existingWidth = existingLayerRecord.width;
            if (
                !incomingHasWidth &&
                typeof existingWidth === 'number' &&
                Number.isFinite(existingWidth)
            ) {
                mergedLayerRecord.width = existingWidth;
            } else {
                throw new Error(
                    `[PatchSyncEngine] Layer ${layerId} has invalid width; refusing to normalize malformed layer snapshot.`
                );
            }
        }

        for (const [key, value] of Object.entries(mergedLayerRecord)) {
            if (value === undefined) {
                delete mergedLayerRecord[key];
            }
        }

        if (mergedLayerRecord.isInterpolated === false) {
            delete mergedLayerRecord.isInterpolated;
        }

        return mergedLayerRecord;
    }

    /**
     * Apply a sparse layer delta to the Y.Doc.
     *
     * The delta contains ONLY the fields that changed.  Fields absent
     * from the delta are left untouched in the Y.Doc — this is the
     * fundamental contract that prevents key loss during cross-window
     * and cloud sync.
     *
     * Scalar/object fields in the delta replace the existing value.
     * Array fields (shapes, anchors, guides) in the delta replace the
     * entire array.  Fields with value `null` are deleted from the
     * Y.Map.
     */
    private _applyLayerDelta(
        glyphName: string,
        layerId: string,
        delta: unknown
    ): void {
        const glyphsMap = this.fontMap.get('glyphs');
        if (!(glyphsMap instanceof Y.Map)) {
            return;
        }

        const glyphMap = glyphsMap.get(glyphName);
        if (!(glyphMap instanceof Y.Map)) {
            return;
        }

        let layersMap = glyphMap.get('layers') as Y.Map<unknown> | undefined;
        if (!(layersMap instanceof Y.Map)) {
            layersMap = new Y.Map<unknown>();
            glyphMap.set('layers', layersMap);
        }

        if (!delta || typeof delta !== 'object' || Array.isArray(delta)) {
            console.warn(
                `[PatchSyncEngine] Ignoring malformed layer delta for ${glyphName}/${layerId}; expected object payload.`
            );
            return;
        }

        const deltaRecord = delta as Record<string, unknown>;

        // Empty delta → nothing to apply.
        const deltaKeys = Object.keys(deltaRecord);
        if (deltaKeys.length === 0) {
            return;
        }

        const existingLayerValue = layersMap.get(layerId);
        let layerMap =
            existingLayerValue instanceof Y.Map
                ? existingLayerValue
                : undefined;

        // Creating a new layer from a sparse delta requires width and master.
        if (!(layerMap instanceof Y.Map)) {
            const hasWidth =
                typeof deltaRecord.width === 'number' &&
                Number.isFinite(deltaRecord.width);
            const hasMaster =
                !!deltaRecord.master &&
                typeof deltaRecord.master === 'object' &&
                !Array.isArray(deltaRecord.master);
            if (!hasWidth || !hasMaster) {
                console.warn(
                    `[PatchSyncEngine] Ignoring sparse layer delta for missing ${glyphName}/${layerId}; cannot create layer root from sparse payload.`
                );
                return;
            }
            layerMap = new Y.Map<unknown>();
            layersMap.set(layerId, layerMap);
        }

        // Read existing Y.Doc state for master normalization context.
        const existingYDocRecord = fromYType(layerMap) as Record<
            string,
            unknown
        > | null;

        // Clone the delta — _normalizeLayerMasterSnapshot mutates it.
        const workingRecord = cloneHistoryValue(deltaRecord) as Record<
            string,
            unknown
        >;

        // Normalize master if it changed.
        if ('master' in workingRecord) {
            this._normalizeLayerMasterSnapshot(
                layerId,
                workingRecord,
                existingYDocRecord ?? {}
            );
        }

        // Validate width if it's in the delta.
        if ('width' in workingRecord) {
            if (
                typeof workingRecord.width !== 'number' ||
                !Number.isFinite(workingRecord.width)
            ) {
                console.warn(
                    `[PatchSyncEngine] Layer delta for ${glyphName}/${layerId} has invalid width; refusing to apply width.`
                );
                delete workingRecord.width;
            }
        }

        // Validate master if it's in the delta.
        if ('master' in workingRecord && !workingRecord.master) {
            console.warn(
                `[PatchSyncEngine] Layer delta for ${glyphName}/${layerId} has invalid master; refusing to apply master.`
            );
            delete workingRecord.master;
        }

        // Strip isInterpolated if set to false in the delta.
        if (workingRecord.isInterpolated === false) {
            workingRecord.isInterpolated = null;
        }

        // Apply each delta key to the Y.Map.
        for (const [key, value] of Object.entries(workingRecord)) {
            if (value === null || value === undefined) {
                // For indexed-map keys, delete the *ById+*Order keys
                // so downstream readers see the data as absent (not
                // empty), preserving merge semantics.
                if (INDEXED_MAP_KEYS[key]) {
                    const mapping = INDEXED_MAP_KEYS[key]!;
                    layerMap.delete(mapping.byId);
                    layerMap.delete(mapping.order);
                } else {
                    layerMap.delete(key);
                }
            } else {
                // Shapes/anchors/guides are stored as indexed-maps
                // (shapesById+shapeOrder, etc.) in the Y.Doc. Apply the
                // array delta element-by-element via deep-merge so only
                // changed shapes/nodes produce Yjs operations.
                if (
                    (key === 'shapes' ||
                        key === 'anchors' ||
                        key === 'guides') &&
                    Array.isArray(value)
                ) {
                    applyIndexedMapArrayToYMap(layerMap, key, value);
                    continue;
                }

                this._replaceYMapEntry(layerMap, key, value);
            }
        }
    }

    private _targetFromHistoryItem(
        item: HistoryStackItem,
        fallbackGlyphName: string | null,
        fallbackLayerId: string | null
    ): UndoTarget {
        const glyphNames = deriveGlyphNamesFromPaths(item.touchedPaths);
        const layerIds = deriveLayerIdsFromPaths(item.touchedPaths);
        if (item.undoScope === 'layer') {
            return {
                glyphName: glyphNames[0] ?? fallbackGlyphName,
                layerId: layerIds[0] ?? fallbackLayerId
            };
        }
        if (item.undoScope === 'glyph') {
            return {
                glyphName: glyphNames[0] ?? fallbackGlyphName,
                layerId: null
            };
        }
        return {
            glyphName: null,
            layerId: null
        };
    }

    private _getUndoManagerForTarget(target: UndoTarget): UndoManagerWithScope {
        if (target.glyphName && target.layerId) {
            return {
                manager: this.getLayerUndoManager(
                    target.glyphName,
                    target.layerId
                ),
                scope: 'layer'
            };
        }
        if (target.glyphName) {
            return {
                manager: this.getGlyphUndoManager(target.glyphName),
                scope: 'glyph'
            };
        }
        return {
            manager: this._fontUndoManager,
            scope: 'font'
        };
    }

    private _appendChangeLogEntry(entry: ChangeLogEntry): void {
        this._changeLog.push(normalizeChangeLogEntry(entry));
        this._notifyChangeLogListeners();
    }

    private _appendChangeLogEntries(entries: ChangeLogEntry[]): void {
        if (!entries.length) {
            return;
        }
        this._changeLog.push(
            ...entries.map((entry) => normalizeChangeLogEntry(entry))
        );
        this._notifyChangeLogListeners();
    }

    private _deriveForwardChangesFromChangeLogEntries(
        entries: ChangeLogEntry[]
    ): DerivedForwardChange[] {
        return entries.map((entry) => ({
            path: entry.path,
            op: entry.op,
            oldValue: cloneHistoryValue(
                entry.replayOldValue === undefined
                    ? entry.oldValue
                    : entry.replayOldValue
            ),
            newValue: cloneHistoryValue(
                entry.replayNewValue === undefined
                    ? entry.newValue
                    : entry.replayNewValue
            ),
            objectType: deriveObjectInfoFromPath(entry.path).objectType
        }));
    }

    private _deriveForwardChangesFromCollaborationMessage(
        message: CollaborationMessageEnvelope
    ): DerivedForwardChange[] {
        return message.changes.map((change) => ({
            path: change.path,
            op: change.op,
            oldValue: cloneHistoryValue(change.replayOldValue),
            newValue: cloneHistoryValue(change.replayNewValue),
            objectType: deriveObjectInfoFromPath(change.path).objectType
        }));
    }

    private _createCollaborationLogItem(
        message: CollaborationMessageEnvelope,
        update: Uint8Array,
        direction: 'local' | 'remote',
        derivedForwardChanges: DerivedForwardChange[]
    ): CollaborationLogItem {
        return {
            id: collaborationMessageKey(message),
            direction,
            timestamp: message.timestamp,
            transactionDurationMs:
                message.metadata.transactionDurationMs ?? null,
            summary: message.summary,
            label: message.label,
            source: message.source,
            editSource: message.metadata.editSource ?? null,
            windowId: message.windowId,
            windowRoleLabel:
                message.metadata.sourceWindowRoleLabel ??
                this._getWindowRoleLabel(),
            historyItemId: message.metadata.historyItemId,
            historyAction: message.metadata.historyAction,
            targetHistoryItemId: message.metadata.targetHistoryItemId ?? null,
            undoScope: message.metadata.undoScope,
            updateByteLength: update.byteLength,
            updateBase64Preview: this._toUpdateBase64Preview(update),
            changedGlyphNames: [...message.metadata.changedGlyphNames],
            changedLayerIds: [...message.metadata.changedLayerIds],
            workerReplayTargets: normalizeWorkerReplayTargets(
                message.metadata.workerReplayTargets
            ),
            changes: message.changes.map((change) => ({
                ...change,
                workerReplayTargets: change.workerReplayTargets
                    ? [...change.workerReplayTargets]
                    : undefined
            })),
            derivedForwardChanges
        };
    }

    private _appendCollaborationLogItems(items: CollaborationLogItem[]): void {
        if (!items.length) {
            return;
        }

        const existingIds = new Set(
            this._collaborationLog.map((item) => item.id)
        );
        let didAddItem = false;
        let lastTimestamp =
            this._collaborationLog.length > 0
                ? this._collaborationLog[this._collaborationLog.length - 1]
                      .timestamp
                : Number.NEGATIVE_INFINITY;
        let requiresSort = false;

        for (const item of items) {
            if (existingIds.has(item.id)) {
                continue;
            }
            if (item.timestamp < lastTimestamp) {
                requiresSort = true;
            }
            this._collaborationLog.push(item);
            existingIds.add(item.id);
            lastTimestamp = item.timestamp;
            didAddItem = true;
        }

        if (!didAddItem) {
            return;
        }

        if (requiresSort) {
            this._collaborationLog.sort(
                (left, right) => left.timestamp - right.timestamp
            );
        }
        this._notifyCollaborationLogListeners();
    }

    private _notifyCollaborationLogListeners(): void {
        const items = this.getCollaborationLog();
        for (const listener of this._collaborationLogListeners) {
            listener(items);
        }
    }

    private _toUpdateBase64Preview(update: Uint8Array): string {
        let binary = '';
        const previewLength = Math.min(update.length, 96);
        for (let index = 0; index < previewLength; index++) {
            binary += String.fromCharCode(update[index]);
        }
        const base64 = btoa(binary);
        return update.length > previewLength ? `${base64}...` : base64;
    }

    private _notifyChangeLogListeners(): void {
        const entries = this.getChangeLog();
        for (const listener of this._changeLogListeners) {
            listener(entries);
        }
    }
}

function cloneHistoryValue<T>(value: T): T {
    if (value === undefined) {
        return value;
    }
    return JSON.parse(JSON.stringify(value)) as T;
}
