/**
 * ChangeBridge — Central change processor.
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
    toYType,
    setYPath,
    deleteYPath,
    getYPath,
    setJsonPath,
    deleteJsonPath,
    getJsonPath
} from './change-bridge-ydoc';
import {
    buildHistoryStackItems,
    type ChangeLogEntry,
    type ChangeOp,
    type HistoryStackItem,
    type UndoScope,
    createLogEntry,
    deriveGlyphName,
    deriveLayerId,
    deriveGlyphNameFromPath,
    deriveGlyphNamesFromPaths,
    deriveLayerIdFromPath,
    deriveLayerIdsFromPaths,
    normalizeChangeLogEntry,
    resolveHistoryTargetItem,
    resetLogCounter
} from './change-log';
import { Logger } from './logger';
import { windowRole } from './window-role';

const console = new Logger('ChangeBridge');

type Unsafe = ReturnType<typeof JSON.parse>;

type SyntheticChangeOperation = {
    op: ChangeOp;
    path: (string | number)[];
    oldValue: unknown;
    newValue: unknown;
};

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

type HistoryTarget = {
    type: 'feature' | 'class' | 'prefix';
    key: string;
    label: string;
};

type UndoManagerWithScope = {
    manager: Y.UndoManager | null;
    scope: UndoScope;
};

function getLayerManagerKey(glyphName: string, layerId: string): string {
    return `${glyphName}@@${layerId}`;
}

function getLayerEditOrigin(glyphName: string, layerId: string): string {
    return `${LAYER_EDIT_ORIGIN_PREFIX}${glyphName}@@${layerId}`;
}

/**
 * Central change processor that keeps Yjs Y.Doc in sync with the
 * babelfont JSON object model.
 */
export class ChangeBridge {
    /** The Yjs document */
    readonly yDoc: Y.Doc;
    /** Root font map inside Y.Doc */
    readonly fontMap: Y.Map<unknown>;
    /** Per-glyph undo managers (keyed by glyph name) */
    private _undoManagers = new Map<string, Y.UndoManager>();
    /** Per-layer undo managers (keyed by glyph@@layer) */
    private _layerUndoManagers = new Map<string, Y.UndoManager>();
    /** "Font-level" undo manager for axes/masters/instances/font properties */
    private _fontUndoManager: Y.UndoManager | null = null;
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
    /** Next transaction ID counter */
    private _nextTxId = 1;
    /** Next logical history item counter */
    private _nextHistoryItemId = 1;
    /** Current transaction-level history item ID */
    private _txHistoryItemId: string | null = null;
    /** Flag: currently applying remote update (suppress outbound broadcast) */
    private _isApplyingRemote = false;
    /** Flag: suppress Y.Doc sync (during initFromJson) */
    private _isSyncing = false;
    /** Callback when a remote change arrives (for UI refresh) */
    private _onRemoteChange: ((entries: ChangeLogEntry[]) => void) | null =
        null;
    /** Callback when the Y.Doc is updated locally (for broadcasting) */
    private _onLocalUpdate: ((update: Uint8Array) => void) | null = null;
    /** Callback to trigger dirty marking on the font manager side */
    private _onDirty: (() => void) | null = null;
    /** Callback after _syncJsonFromYDoc (undo/redo/remote) for external resync */
    private _onAfterSync: (() => void) | null = null;
    /** Suppress recording (used during undo/redo application) */
    private _suppressRecording = false;
    /** Index into _changeLog marking the last entry broadcast to peers */
    private _lastBroadcastLogIndex = 0;
    /** Subscribers for same-tab history UI updates */
    private _changeLogListeners = new Set<
        (entries: ChangeLogEntry[]) => void
    >();

    /**
     * Produce a deterministic JSON string so deep-equality checks are stable
     * even when object key insertion order differs.
     */
    private _stableStringify(value: unknown): string {
        const normalize = (input: unknown): unknown => {
            if (Array.isArray(input)) {
                return input.map((item) => normalize(item));
            }
            if (input && typeof input === 'object') {
                const entries = Object.entries(
                    input as Record<string, unknown>
                ).sort(([a], [b]) => a.localeCompare(b));
                const result: Record<string, unknown> = {};
                for (const [key, val] of entries) {
                    result[key] = normalize(val);
                }
                return result;
            }
            return input;
        };

        return JSON.stringify(normalize(value));
    }

    private _isDeepEqual(a: unknown, b: unknown): boolean {
        return this._stableStringify(a) === this._stableStringify(b);
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

    constructor(windowId?: string) {
        this.windowId = windowId ?? windowRole.instanceId;
        this.yDoc = new Y.Doc();
        this.fontMap = this.yDoc.getMap('font');

        // Listen for Y.Doc updates.
        // Broadcast all non-system-remote updates (user edits + UndoManager)
        // so undo/redo propagates to other windows too.
        this.yDoc.on('update', (update: Uint8Array, origin: unknown) => {
            if (origin !== SYSTEM_REMOTE_ORIGIN && !this._isApplyingRemote) {
                this._onLocalUpdate?.(update);
            }
        });
    }

    // ── Lifecycle ────────────────────────────────────────────────

    /**
     * Initialize the Y.Doc from the current babelfont JSON.
     * Call this once after a font is loaded.
     */
    initFromJson(fontJson: Record<string, Unsafe>): void {
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

    /** Register a callback for local Y.Doc updates (for broadcasting). */
    onLocalUpdate(cb: (update: Uint8Array) => void): void {
        this._onLocalUpdate = cb;
    }

    /** Register a callback to mark the font as dirty. */
    onDirty(cb: () => void): void {
        this._onDirty = cb;
    }

    /** Register a callback for after _syncJsonFromYDoc (undo/redo/remote). */
    onAfterSync(cb: () => void): void {
        this._onAfterSync = cb;
    }

    /** Clean up resources. */
    destroy(): void {
        for (const um of this._layerUndoManagers.values()) {
            um.destroy();
        }
        this._layerUndoManagers.clear();
        for (const um of this._undoManagers.values()) {
            um.destroy();
        }
        this._undoManagers.clear();
        this._fontUndoManager?.destroy();
        this._fontUndoManager = null;
        this.yDoc.destroy();
        this._fontJson = null;
        this._changeLog = [];
        this._onRemoteChange = null;
        this._onLocalUpdate = null;
        this._onDirty = null;
        this._onAfterSync = null;
        this._changeLogListeners.clear();
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
        const glyphName = deriveGlyphName(fullPath);
        const layerId = deriveLayerId(fullPath);
        const undoScope = this._deriveUndoScope(glyphName, layerId);
        const origin = this._getEditOrigin(glyphName, layerId, undoScope);

        if (undoScope === 'layer' && glyphName && layerId) {
            this.getLayerUndoManager(glyphName, layerId);
        } else if (undoScope === 'glyph' && glyphName) {
            this.getGlyphUndoManager(glyphName);
        }

        // Log entry (before Y.Doc transaction so it's available for broadcast)
        const historyTarget = this._deriveHistoryTarget(fullPath);
        const entry = createLogEntry({
            timestamp: Date.now(),
            windowId: this.windowId,
            transactionLabel: this._txLabel,
            windowRoleLabel: this._getWindowRoleLabel(),
            historyItemId: this._getCurrentHistoryItemId(),
            historyAction: 'change',
            transactionId: this._txId,
            op: 'set' as ChangeOp,
            undoScope,
            path: fullPath.join('.'),
            oldValue: oldVal,
            newValue: newVal,
            historyTargetType: historyTarget?.type ?? null,
            historyTargetKey: historyTarget?.key ?? null,
            historyTargetLabel: historyTarget?.label ?? null
        });
        this._appendChangeLogEntry(entry);

        // Update Y.Doc
        const yPath = this._toYDocPath(fullPath);
        this.yDoc.transact(() => {
            setYPath(this.fontMap, yPath, newVal);
        }, origin);

        // Mark dirty
        this._onDirty?.();

        console.log(`[ChangeBridge] Change recorded: ${entry.path}`);
    }

    /**
     * Record an add operation (new glyph, layer, shape, etc.).
     */
    recordAdd(path: (string | number)[], value: unknown): void {
        if (this._suppressRecording || this._isSyncing) return;

        const glyphName = deriveGlyphName(path);
        const layerId = deriveLayerId(path);
        const undoScope = this._deriveUndoScope(glyphName, layerId);
        const origin = this._getEditOrigin(glyphName, layerId, undoScope);

        if (undoScope === 'layer' && glyphName && layerId) {
            this.getLayerUndoManager(glyphName, layerId);
        } else if (undoScope === 'glyph' && glyphName) {
            this.getGlyphUndoManager(glyphName);
        }

        const historyTarget = this._deriveHistoryTarget(path);
        const entry = createLogEntry({
            timestamp: Date.now(),
            windowId: this.windowId,
            transactionLabel: this._txLabel,
            windowRoleLabel: this._getWindowRoleLabel(),
            historyItemId: this._getCurrentHistoryItemId(),
            historyAction: 'change',
            transactionId: this._txId,
            op: 'add' as ChangeOp,
            undoScope,
            path: path.join('.'),
            oldValue: undefined,
            newValue: value,
            historyTargetType: historyTarget?.type ?? null,
            historyTargetKey: historyTarget?.key ?? null,
            historyTargetLabel: historyTarget?.label ?? null
        });
        this._appendChangeLogEntry(entry);

        const yPath = this._toYDocPath(path);
        this.yDoc.transact(() => {
            setYPath(this.fontMap, yPath, value);
        }, origin);

        this._onDirty?.();
    }

    /**
     * Record a remove operation.
     */
    recordRemove(path: (string | number)[], oldValue: unknown): void {
        if (this._suppressRecording || this._isSyncing) return;

        const glyphName = deriveGlyphName(path);
        const layerId = deriveLayerId(path);
        const undoScope = this._deriveUndoScope(glyphName, layerId);
        const origin = this._getEditOrigin(glyphName, layerId, undoScope);

        if (undoScope === 'layer' && glyphName && layerId) {
            this.getLayerUndoManager(glyphName, layerId);
        } else if (undoScope === 'glyph' && glyphName) {
            this.getGlyphUndoManager(glyphName);
        }

        const historyTarget = this._deriveHistoryTarget(path);
        const entry = createLogEntry({
            timestamp: Date.now(),
            windowId: this.windowId,
            transactionLabel: this._txLabel,
            windowRoleLabel: this._getWindowRoleLabel(),
            historyItemId: this._getCurrentHistoryItemId(),
            historyAction: 'change',
            transactionId: this._txId,
            op: 'remove' as ChangeOp,
            undoScope,
            path: path.join('.'),
            oldValue,
            newValue: undefined,
            historyTargetType: historyTarget?.type ?? null,
            historyTargetKey: historyTarget?.key ?? null,
            historyTargetLabel: historyTarget?.label ?? null
        });
        this._appendChangeLogEntry(entry);

        const yPath = this._toYDocPath(path);
        this.yDoc.transact(() => {
            deleteYPath(this.fontMap, yPath);
        }, origin);

        this._onDirty?.();
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

        const normalizedOperations = operations.filter(
            (operation) => operation.path.length > 0
        );
        if (!normalizedOperations.length) {
            return;
        }

        const touchedGlyphNames = new Set<string>();
        const touchedLayerKeys = new Set<string>();
        let hasFontScopedChange = false;
        let hasGlyphScopedChange = false;

        for (const operation of normalizedOperations) {
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

        let overallScope: UndoScope = 'font';
        let origin = FONT_EDIT_ORIGIN;
        let glyphUndoManager: Y.UndoManager | null = null;
        let layerUndoManager: Y.UndoManager | null = null;

        if (!hasFontScopedChange && touchedGlyphNames.size === 1) {
            const glyphName = [...touchedGlyphNames][0];
            if (!hasGlyphScopedChange && touchedLayerKeys.size === 1) {
                const [managerKey] = [...touchedLayerKeys];
                const [, layerId] = managerKey.split('@@');
                overallScope = 'layer';
                origin = getLayerEditOrigin(glyphName, layerId);
                layerUndoManager = this.getLayerUndoManager(glyphName, layerId);
                layerUndoManager?.stopCapturing();
            } else {
                overallScope = 'glyph';
                origin = GLYPH_EDIT_ORIGIN;
                glyphUndoManager = this.getGlyphUndoManager(glyphName);
                glyphUndoManager?.stopCapturing();
            }
        } else {
            this._fontUndoManager?.stopCapturing();
        }

        const historyItemId = this._getCurrentHistoryItemId();
        const timestamp = Date.now();

        for (const operation of normalizedOperations) {
            const pathString = operation.path.join('.');
            const historyTarget = this._deriveHistoryTarget(operation.path);

            const entry = createLogEntry({
                timestamp,
                windowId: this.windowId,
                transactionLabel: this._txLabel ?? label,
                windowRoleLabel: this._getWindowRoleLabel(),
                historyItemId,
                historyAction: 'change',
                transactionId: this._txId,
                op: operation.op,
                undoScope: this._deriveUndoScope(
                    deriveGlyphName(operation.path),
                    deriveLayerId(operation.path)
                ),
                path: pathString,
                oldValue: operation.oldValue,
                newValue: operation.newValue,
                historyTargetType: historyTarget?.type ?? null,
                historyTargetKey: historyTarget?.key ?? null,
                historyTargetLabel: historyTarget?.label ?? null
            });
            this._appendChangeLogEntry(entry);
        }

        this.yDoc.transact(() => {
            for (const operation of normalizedOperations) {
                if (operation.op === 'remove') {
                    deleteYPath(this.fontMap, this._toYDocPath(operation.path));
                    continue;
                }

                setYPath(
                    this.fontMap,
                    this._toYDocPath(operation.path),
                    operation.newValue
                );
            }
        }, origin);

        glyphUndoManager?.stopCapturing();
        layerUndoManager?.stopCapturing();
        if (overallScope === 'font') {
            this._fontUndoManager?.stopCapturing();
        }

        this._onDirty?.();
    }

    // ── Transactions ─────────────────────────────────────────────

    /**
     * Start a named batch transaction.
     * Nested calls increment a depth counter; only the outermost commits.
     */
    beginTransaction(label: string): void {
        this._txDepth++;
        if (this._txDepth === 1) {
            this._txLabel = label;
            this._txId = this._nextTxId++;
            this._txHistoryItemId = this._createHistoryItemId();
        }
    }

    /**
     * End the current batch transaction.
     */
    endTransaction(): void {
        if (this._txDepth <= 0) return;
        this._txDepth--;
        if (this._txDepth === 0) {
            this._txLabel = null;
            this._txId = null;
            this._txHistoryItemId = null;
        }
    }

    /** Whether a transaction is currently open. */
    get inTransaction(): boolean {
        return this._txDepth > 0;
    }

    setRecordingSuppressed(suppressed: boolean): void {
        this._suppressRecording = suppressed;
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
        layerId?: string | null
    ): void {
        this.syncGlyphsFromJson(
            [glyphName],
            label,
            oldValue,
            newValue,
            layerId
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
        layerId?: string | null
    ): void {
        if (!this._fontJson || this._suppressRecording || this._isSyncing)
            return;

        const uniqueGlyphNames = Array.from(
            new Set(glyphNames.filter((name) => typeof name === 'string'))
        );
        if (!uniqueGlyphNames.length) {
            return;
        }

        const glyphs = (this._fontJson as Unsafe).glyphs;
        if (!Array.isArray(glyphs)) return;

        const glyphsMap = this.fontMap.get('glyphs') as
            | Y.Map<unknown>
            | undefined;
        if (!glyphsMap) return;

        const targets: Array<{
            glyphName: string;
            glyphJson: Record<string, unknown>;
            glyphMap: Y.Map<unknown>;
            glyphUndoManager: Y.UndoManager | null;
            layerUndoManager: Y.UndoManager | null;
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

            const glyphUndoManager = this.getGlyphUndoManager(glyphName);
            const layerUndoManager = layerId
                ? this.getLayerUndoManager(glyphName, layerId)
                : null;
            glyphUndoManager?.stopCapturing();
            layerUndoManager?.stopCapturing();

            targets.push({
                glyphName,
                glyphJson,
                glyphMap,
                glyphUndoManager,
                layerUndoManager
            });
        }

        if (!targets.length) {
            return;
        }

        const undoScope = this._deriveBulkUndoScope(targets, layerId ?? null);
        const origin = this._getBulkEditOrigin(
            targets,
            layerId ?? null,
            undoScope
        );

        const historyItemId = this._createHistoryItemId();
        for (const target of targets) {
            const entry = createLogEntry({
                timestamp: Date.now(),
                windowId: this.windowId,
                windowRoleLabel: this._getWindowRoleLabel(),
                historyItemId,
                historyAction: 'change',
                transactionLabel: label,
                transactionId: null,
                op: 'set' as ChangeOp,
                undoScope,
                path:
                    undoScope === 'layer' && layerId
                        ? `glyphs.${target.glyphName}.layers.${layerId}`
                        : `glyphs.${target.glyphName}`,
                oldValue: oldValue ?? target.glyphName,
                newValue: newValue ?? label
            });
            this._appendChangeLogEntry(entry);
        }

        // Update all target glyph Y.Maps in one transaction.
        this.yDoc.transact(() => {
            for (const target of targets) {
                const { glyphJson, glyphMap } = target;
                const glyphKeys = new Set(Object.keys(glyphJson));

                for (const [gk, gv] of Object.entries(glyphJson)) {
                    if (gk === 'layers' && Array.isArray(gv)) {
                        let layersMap = glyphMap.get('layers') as
                            | Y.Map<unknown>
                            | undefined;
                        if (!layersMap) {
                            layersMap = new Y.Map();
                            glyphMap.set('layers', layersMap);
                        }
                        const nextLayerIds = new Set<string>();
                        for (const layerJson of gv as Record<
                            string,
                            unknown
                        >[]) {
                            const nextLayerId = (layerJson.id as string) ?? '';
                            if (!nextLayerId) {
                                continue;
                            }
                            nextLayerIds.add(nextLayerId);

                            const existingLayerMap = layersMap.get(
                                nextLayerId
                            ) as Y.Map<unknown> | undefined;
                            if (!(existingLayerMap instanceof Y.Map)) {
                                layersMap.set(nextLayerId, toYType(layerJson));
                                continue;
                            }

                            const layerKeys = new Set(Object.keys(layerJson));
                            for (const [layerKey, layerValue] of Object.entries(
                                layerJson
                            )) {
                                existingLayerMap.set(
                                    layerKey,
                                    toYType(layerValue)
                                );
                            }

                            existingLayerMap.forEach(
                                (_value: unknown, key: string) => {
                                    if (!layerKeys.has(key)) {
                                        existingLayerMap.delete(key);
                                    }
                                }
                            );
                        }
                        // Remove layers no longer present in source JSON
                        layersMap.forEach((_v: unknown, key: string) => {
                            if (!nextLayerIds.has(key)) {
                                layersMap?.delete(key);
                            }
                        });
                    } else {
                        glyphMap.set(gk, toYType(gv));
                    }
                }

                // Remove glyph keys no longer present in source JSON
                glyphMap.forEach((_v: unknown, key: string) => {
                    if (!glyphKeys.has(key)) {
                        glyphMap.delete(key);
                    }
                });
            }
        }, origin);

        // Also split after this transaction so the next sync starts a fresh
        // logical undo step even under rapid consecutive edits.
        for (const target of targets) {
            target.glyphUndoManager?.stopCapturing();
            target.layerUndoManager?.stopCapturing();
        }

        this._onDirty?.();
        console.log(
            `Glyph sync committed for ${targets.map((target) => target.glyphName).join(', ')} (${label})`
        );
    }

    // ── Undo / Redo ──────────────────────────────────────────────

    /**
     * Undo the last change for a specific glyph, or font-level if no
     * glyph name is given.
     */
    undo(
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
        if (scope !== 'font' && (!um || um.undoStack.length === 0)) {
            return false;
        }
        if (scope === 'font' && !targetItem) {
            return false;
        }
        this._suppressRecording = true;
        try {
            const targetHistoryItemId = targetItem?.id ?? null;
            // Log entry before um.undo() so it's available when the
            // Y.Doc update event fires and WindowSync broadcasts it.
            const entry = createLogEntry({
                timestamp: Date.now(),
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
                newValue: 'undo'
            });
            this._appendChangeLogEntry(entry);

            if (scope === 'font' && targetItem) {
                this._applyHistoryItem(targetItem, 'undo');
            } else {
                um?.undo();
            }
            this._syncJsonFromYDoc();
            this._onAfterSync?.();
            this._onDirty?.();
            return true;
        } finally {
            this._suppressRecording = false;
        }
    }

    /**
     * Redo the last undone change.
     */
    redo(
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
        if (scope !== 'font' && (!um || um.redoStack.length === 0)) {
            return false;
        }
        if (scope === 'font' && !targetItem) {
            return false;
        }
        this._suppressRecording = true;
        try {
            const targetHistoryItemId = targetItem?.id ?? null;
            // Log entry before um.redo() so it's available for broadcast.
            const entry = createLogEntry({
                timestamp: Date.now(),
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
                newValue: 'redo'
            });
            this._appendChangeLogEntry(entry);

            if (scope === 'font' && targetItem) {
                this._applyHistoryItem(targetItem, 'redo');
            } else {
                um?.redo();
            }
            this._syncJsonFromYDoc();
            this._onAfterSync?.();
            this._onDirty?.();
            return true;
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
        if (scope === 'font') {
            return !!targetItem;
        }
        return um ? um.undoStack.length > 0 : false;
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
        if (scope === 'font') {
            return !!targetItem;
        }
        return um ? um.redoStack.length > 0 : false;
    }

    // ── Cross-window ─────────────────────────────────────────────

    /**
     * Apply a remote Y.Doc update from another window.
     * Optionally import accompanying change log entries.
     */
    applyRemoteUpdate(
        update: Uint8Array,
        remoteEntries?: ChangeLogEntry[]
    ): void {
        this._isApplyingRemote = true;
        try {
            if (!this._fontJson) this._fontJson = {};
            if (remoteEntries?.length) {
                const glyphNames = new Set(
                    remoteEntries
                        .map((entry) => deriveGlyphNameFromPath(entry.path))
                        .filter((glyphName): glyphName is string => !!glyphName)
                );
                for (const glyphName of glyphNames) {
                    this.getGlyphUndoManager(glyphName);
                }
                for (const entry of remoteEntries) {
                    const glyphName = deriveGlyphNameFromPath(entry.path);
                    const layerId = deriveLayerIdFromPath(entry.path);
                    if (glyphName && layerId) {
                        this.getLayerUndoManager(glyphName, layerId);
                    }
                }
            }
            // Apply linked-window updates using the shared same-user origin so
            // every window can undo the combined edit history.
            Y.applyUpdate(
                this.yDoc,
                update,
                this._getRemoteUpdateOrigin(remoteEntries)
            );
            this._syncJsonFromYDoc();
            this._onAfterSync?.();
            this._onDirty?.();
            if (remoteEntries && remoteEntries.length > 0) {
                this._appendChangeLogEntries(remoteEntries);
            }
            this._onRemoteChange?.(remoteEntries ?? []);
        } finally {
            this._isApplyingRemote = false;
        }
    }

    /**
     * Export the full Y.Doc state for bootstrapping a new window.
     */
    getFullState(): Uint8Array {
        return Y.encodeStateAsUpdate(this.yDoc);
    }

    /**
     * Apply a full state snapshot (for new window bootstrap).
     * The receiving window should NOT call initFromJson() before this —
     * independently initialised Y.Docs have conflicting CRDT state.
     */
    applyFullState(state: Uint8Array): void {
        this._isApplyingRemote = true;
        try {
            if (!this._fontJson) this._fontJson = {};
            Y.applyUpdate(this.yDoc, state, SYSTEM_REMOTE_ORIGIN);
            this._syncJsonFromYDoc();
            // Set up undo managers so this window can undo/redo too
            this._setupFontUndoManager();
            this._onAfterSync?.();
            this._onRemoteChange?.([]);
        } finally {
            this._isApplyingRemote = false;
        }
    }

    // ── Change log ───────────────────────────────────────────────

    /** Get the full change log. */
    getChangeLog(): ChangeLogEntry[] {
        return this._changeLog;
    }

    getChangeLogForGlyph(glyphName?: string | null): ChangeLogEntry[] {
        if (!glyphName) {
            return this._changeLog;
        }
        return this._changeLog.filter(
            (entry) => deriveGlyphNameFromPath(entry.path) === glyphName
        );
    }

    /** Import change log entries (e.g. from another window). */
    importChangeLog(entries: ChangeLogEntry[]): void {
        this._changeLog = entries.map((entry) =>
            normalizeChangeLogEntry(entry)
        );
        this._lastBroadcastLogIndex = this._changeLog.length;
        this._notifyChangeLogListeners();
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

    /** Reset state (for tests). */
    reset(): void {
        this._changeLog = [];
        this._lastBroadcastLogIndex = 0;
        this._txDepth = 0;
        this._txLabel = null;
        this._txId = null;
        this._txHistoryItemId = null;
        this._nextTxId = 1;
        this._nextHistoryItemId = 1;
        resetLogCounter();
        for (const um of this._layerUndoManagers.values()) {
            um.destroy();
        }
        this._layerUndoManagers.clear();
        for (const um of this._undoManagers.values()) {
            um.destroy();
        }
        this._undoManagers.clear();
        this._fontUndoManager?.destroy();
        this._fontUndoManager = null;
        this._notifyChangeLogListeners();
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
     */
    private _syncJsonFromYDoc(): void {
        if (!this._fontJson) return;
        // Re-read the Y.Doc and patch the live babelfontData object.
        // We preserve array references (via splice) so that model wrapper
        // objects whose _parent points to the array stay valid.
        const freshJson = yDocToJson(this.fontMap);

        // Patch top-level keys. For glyphs, we need to convert the keyed
        // map back to an array format that the babelfont model expects.
        for (const key of Object.keys(freshJson)) {
            (this._fontJson as Unsafe)[key] = freshJson[key];
        }
        // Remove keys that no longer exist
        for (const key of Object.keys(this._fontJson)) {
            if (!(key in freshJson)) {
                delete (this._fontJson as Unsafe)[key];
            }
        }
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
        if (this._layerUndoManagers.has(managerKey)) {
            return this._layerUndoManagers.get(managerKey)!;
        }
        const glyphsMap = this.fontMap.get('glyphs');
        if (!(glyphsMap instanceof Y.Map)) return null;
        const glyphMap = glyphsMap.get(glyphName);
        if (!(glyphMap instanceof Y.Map)) return null;
        const layersMap = glyphMap.get('layers');
        if (!(layersMap instanceof Y.Map)) return null;
        const layerMap = layersMap.get(layerId);
        if (!(layerMap instanceof Y.Map)) return null;

        const um = new Y.UndoManager(layerMap, {
            trackedOrigins: new Set([getLayerEditOrigin(glyphName, layerId)]),
            captureTimeout: 0
        });
        this._layerUndoManagers.set(managerKey, um);
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

    private _getBulkEditOrigin(
        targets: Array<{ glyphName: string }>,
        layerId: string | null,
        scope: UndoScope
    ): string {
        if (scope === 'layer' && targets.length === 1 && layerId) {
            return getLayerEditOrigin(targets[0].glyphName, layerId);
        }
        if (scope === 'glyph') {
            return GLYPH_EDIT_ORIGIN;
        }
        return FONT_EDIT_ORIGIN;
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
                .map((entry) => deriveGlyphNameFromPath(entry.path))
                .filter((glyphName): glyphName is string => !!glyphName)
        );
        const layerKeys = new Set(
            remoteEntries
                .filter((entry) => entry.undoScope === 'layer')
                .map((entry) => {
                    const glyphName = deriveGlyphNameFromPath(entry.path);
                    const layerId = deriveLayerIdFromPath(entry.path);
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
                        !!deriveGlyphNameFromPath(candidate.path) &&
                        !!deriveLayerIdFromPath(candidate.path)
                );
            if (entry) {
                const glyphName = deriveGlyphNameFromPath(entry.path);
                const layerId = deriveLayerIdFromPath(entry.path);
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

    private _resolveUndoHistoryItem(
        glyphName: string | undefined,
        layerId: string | null | undefined,
        historyAction: 'undo' | 'redo',
        historyTargetKey?: string | null
    ): HistoryStackItem | null {
        return resolveHistoryTargetItem(this._changeLog, {
            glyphName: glyphName ?? null,
            layerId: layerId ?? null,
            historyAction,
            historyTargetKey: historyTargetKey ?? null
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

    private _parseEntryPath(path: string): (string | number)[] {
        if (!path || path === 'font') {
            return [];
        }
        return path
            .split('.')
            .map((segment) =>
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
                if (direction === 'undo') {
                    if (entry.op === 'add') {
                        deleteYPath(this.fontMap, path);
                        continue;
                    }
                    if (entry.op === 'remove' || entry.op === 'set') {
                        setYPath(this.fontMap, path, entry.oldValue);
                    }
                    continue;
                }

                if (entry.op === 'remove') {
                    deleteYPath(this.fontMap, path);
                    continue;
                }
                setYPath(this.fontMap, path, entry.newValue);
            }
        }, HISTORY_REPLAY_ORIGIN);
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

    private _notifyChangeLogListeners(): void {
        const entries = this.getChangeLog();
        for (const listener of this._changeLogListeners) {
            listener(entries);
        }
    }
}
