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
    createLogEntry,
    deriveObjectInfo,
    deriveGlyphName,
    deriveLayerId,
    normalizeChangeLogEntry,
    resolveHistoryTargetItemId,
    resetLogCounter
} from './change-log';
import { Logger } from './logger';
import { windowRole } from './window-role';

const console = new Logger('ChangeBridge');

type Unsafe = ReturnType<typeof JSON.parse>;

/**
 * Origin token used by Yjs transactions that represent same-user edits.
 * Linked windows should all be able to undo these changes.
 */
const USER_EDIT_ORIGIN = 'user-edit';
const SYSTEM_REMOTE_ORIGIN = 'system-remote';

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
        const { objectType, objectId } = deriveObjectInfo(fullPath);
        const glyphName = deriveGlyphName(fullPath);
        const layerId = deriveLayerId(fullPath);

        // Ensure per-glyph UndoManager exists for glyph-scoped changes
        if (fullPath[0] === 'glyphs' && typeof fullPath[1] === 'string') {
            this.getGlyphUndoManager(fullPath[1] as string);
        }

        // Log entry (before Y.Doc transaction so it's available for broadcast)
        const entry = createLogEntry({
            timestamp: Date.now(),
            windowId: this.windowId,
            transactionLabel: this._txLabel,
            windowRoleLabel: this._getWindowRoleLabel(),
            historyItemId: this._getCurrentHistoryItemId(),
            historyAction: 'change',
            transactionId: this._txId,
            op: 'set' as ChangeOp,
            objectType,
            objectId,
            glyphName,
            layerId,
            property: prop,
            path: fullPath.join('.'),
            oldValue: oldVal,
            newValue: newVal
        });
        this._appendChangeLogEntry(entry);

        // Update Y.Doc
        const yPath = this._toYDocPath(fullPath);
        this.yDoc.transact(() => {
            setYPath(this.fontMap, yPath, newVal);
        }, USER_EDIT_ORIGIN);

        // Mark dirty
        this._onDirty?.();

        console.log(`[ChangeBridge] Change recorded: ${entry.path}`);
    }

    /**
     * Record an add operation (new glyph, layer, shape, etc.).
     */
    recordAdd(path: (string | number)[], value: unknown): void {
        if (this._suppressRecording || this._isSyncing) return;

        const { objectType, objectId } = deriveObjectInfo(path);
        const glyphName = deriveGlyphName(path);
        const layerId = deriveLayerId(path);

        // Ensure per-glyph UndoManager exists for glyph-scoped changes
        if (path[0] === 'glyphs' && typeof path[1] === 'string') {
            this.getGlyphUndoManager(path[1] as string);
        }

        const entry = createLogEntry({
            timestamp: Date.now(),
            windowId: this.windowId,
            transactionLabel: this._txLabel,
            windowRoleLabel: this._getWindowRoleLabel(),
            historyItemId: this._getCurrentHistoryItemId(),
            historyAction: 'change',
            transactionId: this._txId,
            op: 'add' as ChangeOp,
            objectType,
            objectId,
            glyphName,
            layerId,
            property: '',
            path: path.join('.'),
            oldValue: undefined,
            newValue: value
        });
        this._appendChangeLogEntry(entry);

        const yPath = this._toYDocPath(path);
        this.yDoc.transact(() => {
            setYPath(this.fontMap, yPath, value);
        }, USER_EDIT_ORIGIN);

        this._onDirty?.();
    }

    /**
     * Record a remove operation.
     */
    recordRemove(path: (string | number)[], oldValue: unknown): void {
        if (this._suppressRecording || this._isSyncing) return;

        const { objectType, objectId } = deriveObjectInfo(path);
        const glyphName = deriveGlyphName(path);
        const layerId = deriveLayerId(path);

        // Ensure per-glyph UndoManager exists for glyph-scoped changes
        if (path[0] === 'glyphs' && typeof path[1] === 'string') {
            this.getGlyphUndoManager(path[1] as string);
        }

        const entry = createLogEntry({
            timestamp: Date.now(),
            windowId: this.windowId,
            transactionLabel: this._txLabel,
            windowRoleLabel: this._getWindowRoleLabel(),
            historyItemId: this._getCurrentHistoryItemId(),
            historyAction: 'change',
            transactionId: this._txId,
            op: 'remove' as ChangeOp,
            objectType,
            objectId,
            glyphName,
            layerId,
            property: '',
            path: path.join('.'),
            oldValue,
            newValue: undefined
        });
        this._appendChangeLogEntry(entry);

        const yPath = this._toYDocPath(path);
        this.yDoc.transact(() => {
            deleteYPath(this.fontMap, yPath);
        }, USER_EDIT_ORIGIN);

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
            um: Y.UndoManager | null;
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

            const um = this.getGlyphUndoManager(glyphName);
            um?.stopCapturing();

            targets.push({ glyphName, glyphJson, glyphMap, um });
        }

        if (!targets.length) {
            return;
        }

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
                objectType: layerId ? 'layer' : 'glyph',
                objectId: layerId ?? target.glyphName,
                glyphName: target.glyphName,
                layerId: layerId ?? null,
                property: '',
                path: layerId
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
                            const layerId = (layerJson.id as string) ?? '';
                            if (layerId) {
                                nextLayerIds.add(layerId);
                                layersMap.set(layerId, toYType(layerJson));
                            }
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
        }, USER_EDIT_ORIGIN);

        // Also split after this transaction so the next sync starts a fresh
        // logical undo step even under rapid consecutive edits.
        for (const target of targets) {
            target.um?.stopCapturing();
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
    undo(glyphName?: string): boolean {
        const um = glyphName
            ? this._undoManagers.get(glyphName)
            : this._fontUndoManager;
        if (!um || um.undoStack.length === 0) return false;
        this._suppressRecording = true;
        try {
            const targetHistoryItemId = resolveHistoryTargetItemId(
                this._changeLog,
                glyphName ?? null,
                'undo'
            );
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
                objectType: glyphName ? 'glyph' : 'font',
                objectId: glyphName ?? '',
                glyphName: glyphName ?? null,
                layerId: null,
                property: '',
                path: glyphName ? `glyphs.${glyphName}` : 'font',
                oldValue: undefined,
                newValue: 'undo'
            });
            this._appendChangeLogEntry(entry);

            um.undo();
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
    redo(glyphName?: string): boolean {
        const um = glyphName
            ? this._undoManagers.get(glyphName)
            : this._fontUndoManager;
        if (!um || um.redoStack.length === 0) return false;
        this._suppressRecording = true;
        try {
            const targetHistoryItemId = resolveHistoryTargetItemId(
                this._changeLog,
                glyphName ?? null,
                'redo'
            );
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
                objectType: glyphName ? 'glyph' : 'font',
                objectId: glyphName ?? '',
                glyphName: glyphName ?? null,
                layerId: null,
                property: '',
                path: glyphName ? `glyphs.${glyphName}` : 'font',
                oldValue: undefined,
                newValue: 'redo'
            });
            this._appendChangeLogEntry(entry);

            um.redo();
            this._syncJsonFromYDoc();
            this._onAfterSync?.();
            this._onDirty?.();
            return true;
        } finally {
            this._suppressRecording = false;
        }
    }

    /** Check if undo is available. */
    canUndo(glyphName?: string): boolean {
        const um = glyphName
            ? this._undoManagers.get(glyphName)
            : this._fontUndoManager;
        return um ? um.undoStack.length > 0 : false;
    }

    /** Check if redo is available. */
    canRedo(glyphName?: string): boolean {
        const um = glyphName
            ? this._undoManagers.get(glyphName)
            : this._fontUndoManager;
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
                        .map((entry) => entry.glyphName)
                        .filter((glyphName): glyphName is string => !!glyphName)
                );
                for (const glyphName of glyphNames) {
                    this.getGlyphUndoManager(glyphName);
                }
            }
            // Apply linked-window updates using the shared same-user origin so
            // every window can undo the combined edit history.
            Y.applyUpdate(this.yDoc, update, USER_EDIT_ORIGIN);
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
        return this._changeLog.filter((entry) => entry.glyphName === glyphName);
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
        // The path from the model already uses glyph names and layer IDs,
        // so we can pass it through directly. Y.Map.get() accepts strings,
        // and Y.Array.get() accepts numbers.
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
            trackedOrigins: new Set([USER_EDIT_ORIGIN]),
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
            trackedOrigins: new Set([USER_EDIT_ORIGIN]),
            captureTimeout: 0
        });
        this._undoManagers.set(glyphName, um);
        return um;
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
