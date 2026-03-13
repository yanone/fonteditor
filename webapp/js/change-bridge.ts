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
    type ChangeLogEntry,
    type ChangeOp,
    createLogEntry,
    deriveObjectInfo,
    resetLogCounter
} from './change-log';
import { Logger } from './logger';

const console = new Logger('ChangeBridge');

type Unsafe = ReturnType<typeof JSON.parse>;

/**
 * Origin token used by Yjs transactions that originate from
 * the local model. Remote updates use other origin values.
 */
const LOCAL_ORIGIN = 'local';
const REMOTE_ORIGIN = 'remote';

let _nextWindowId = 1;

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

    constructor(windowId?: string) {
        this.windowId = windowId ?? `tab-${_nextWindowId++}`;
        this.yDoc = new Y.Doc();
        this.fontMap = this.yDoc.getMap('font');

        // Listen for Y.Doc updates
        this.yDoc.on('update', (update: Uint8Array, origin: unknown) => {
            if (origin === LOCAL_ORIGIN && !this._isApplyingRemote) {
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
        }, LOCAL_ORIGIN);
        this._isSyncing = false;
        this._setupFontUndoManager();
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

        // Ensure per-glyph UndoManager exists for glyph-scoped changes
        if (fullPath[0] === 'glyphs' && typeof fullPath[1] === 'string') {
            this.getGlyphUndoManager(fullPath[1] as string);
        }

        // Update Y.Doc
        const yPath = this._toYDocPath(fullPath);
        this.yDoc.transact(() => {
            setYPath(this.fontMap, yPath, newVal);
        }, LOCAL_ORIGIN);

        // Log entry
        const entry = createLogEntry({
            timestamp: Date.now(),
            windowId: this.windowId,
            transactionLabel: this._txLabel,
            transactionId: this._txId,
            op: 'set' as ChangeOp,
            objectType,
            objectId,
            property: prop,
            path: fullPath.join('.'),
            oldValue: oldVal,
            newValue: newVal
        });
        this._changeLog.push(entry);

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

        // Ensure per-glyph UndoManager exists for glyph-scoped changes
        if (path[0] === 'glyphs' && typeof path[1] === 'string') {
            this.getGlyphUndoManager(path[1] as string);
        }

        const yPath = this._toYDocPath(path);
        this.yDoc.transact(() => {
            setYPath(this.fontMap, yPath, value);
        }, LOCAL_ORIGIN);

        const entry = createLogEntry({
            timestamp: Date.now(),
            windowId: this.windowId,
            transactionLabel: this._txLabel,
            transactionId: this._txId,
            op: 'add' as ChangeOp,
            objectType,
            objectId,
            property: '',
            path: path.join('.'),
            oldValue: undefined,
            newValue: value
        });
        this._changeLog.push(entry);
        this._onDirty?.();
    }

    /**
     * Record a remove operation.
     */
    recordRemove(path: (string | number)[], oldValue: unknown): void {
        if (this._suppressRecording || this._isSyncing) return;

        const { objectType, objectId } = deriveObjectInfo(path);

        // Ensure per-glyph UndoManager exists for glyph-scoped changes
        if (path[0] === 'glyphs' && typeof path[1] === 'string') {
            this.getGlyphUndoManager(path[1] as string);
        }

        const yPath = this._toYDocPath(path);
        this.yDoc.transact(() => {
            deleteYPath(this.fontMap, yPath);
        }, LOCAL_ORIGIN);

        const entry = createLogEntry({
            timestamp: Date.now(),
            windowId: this.windowId,
            transactionLabel: this._txLabel,
            transactionId: this._txId,
            op: 'remove' as ChangeOp,
            objectType,
            objectId,
            property: '',
            path: path.join('.'),
            oldValue,
            newValue: undefined
        });
        this._changeLog.push(entry);
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
    syncGlyphFromJson(glyphName: string, label: string): void {
        if (!this._fontJson || this._suppressRecording || this._isSyncing)
            return;

        const glyphs = (this._fontJson as Unsafe).glyphs;
        if (!Array.isArray(glyphs)) return;
        const glyphJson = glyphs.find(
            (g: Record<string, unknown>) => g.name === glyphName
        ) as Record<string, unknown> | undefined;
        if (!glyphJson) return;

        const glyphsMap = this.fontMap.get('glyphs') as
            | Y.Map<unknown>
            | undefined;
        if (!glyphsMap) return;
        const glyphMap = glyphsMap.get(glyphName) as Y.Map<unknown> | undefined;
        if (!glyphMap) return;

        // Ensure per-glyph UndoManager exists
        this.getGlyphUndoManager(glyphName);

        // Update the glyph Y.Map in place
        this.yDoc.transact(() => {
            for (const [gk, gv] of Object.entries(glyphJson)) {
                if (gk === 'layers' && Array.isArray(gv)) {
                    let layersMap = glyphMap.get('layers') as
                        | Y.Map<unknown>
                        | undefined;
                    if (!layersMap) {
                        layersMap = new Y.Map();
                        glyphMap.set('layers', layersMap);
                    }
                    for (const layerJson of gv as Record<string, unknown>[]) {
                        const layerId = (layerJson.id as string) ?? '';
                        if (layerId) {
                            layersMap.set(layerId, toYType(layerJson));
                        }
                    }
                } else {
                    glyphMap.set(gk, toYType(gv));
                }
            }
        }, LOCAL_ORIGIN);

        // Log entry
        const entry = createLogEntry({
            timestamp: Date.now(),
            windowId: this.windowId,
            transactionLabel: label,
            transactionId: null,
            op: 'set' as ChangeOp,
            objectType: 'glyph',
            objectId: glyphName,
            property: '',
            path: `glyphs.${glyphName}`,
            oldValue: undefined,
            newValue: undefined
        });
        this._changeLog.push(entry);
        this._onDirty?.();
        console.log(`Glyph "${glyphName}" synced to Y.Doc (${label})`);
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
     */
    applyRemoteUpdate(update: Uint8Array): void {
        this._isApplyingRemote = true;
        try {
            if (!this._fontJson) this._fontJson = {};
            Y.applyUpdate(this.yDoc, update, REMOTE_ORIGIN);
            this._syncJsonFromYDoc();
            this._onAfterSync?.();
            this._onDirty?.();
            this._onRemoteChange?.([]);
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
            Y.applyUpdate(this.yDoc, state, REMOTE_ORIGIN);
            this._syncJsonFromYDoc();
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

    /** Import change log entries (e.g. from another window). */
    importChangeLog(entries: ChangeLogEntry[]): void {
        this._changeLog = [...entries];
    }

    /** Reset state (for tests). */
    reset(): void {
        this._changeLog = [];
        this._txDepth = 0;
        this._txLabel = null;
        this._txId = null;
        this._nextTxId = 1;
        resetLogCounter();
        for (const um of this._undoManagers.values()) {
            um.destroy();
        }
        this._undoManagers.clear();
        this._fontUndoManager?.destroy();
        this._fontUndoManager = null;
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
            trackedOrigins: new Set([LOCAL_ORIGIN])
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
            trackedOrigins: new Set([LOCAL_ORIGIN])
        });
        this._undoManagers.set(glyphName, um);
        return um;
    }
}
