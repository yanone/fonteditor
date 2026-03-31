/**
 * Change Log — Metadata for undo history entries.
 *
 * Each entry records a single property change (or an add/remove operation)
 * with enough context for the history UI to display, filter, and
 * selectively revert changes.
 */

/** Object types that can appear in change log entries */
export type ChangeObjectType =
    | 'font'
    | 'glyph'
    | 'layer'
    | 'path'
    | 'node'
    | 'component'
    | 'anchor'
    | 'guide'
    | 'axis'
    | 'master'
    | 'instance'
    | 'shape'
    | 'feature'
    | 'class'
    | 'prefix';

export type HistoryTargetType = 'feature' | 'class' | 'prefix';

/** Operation type */
export type ChangeOp = 'set' | 'add' | 'remove';

/** Logical history action type */
export type HistoryAction = 'change' | 'undo' | 'redo';

/** Undo scope for a logical history item */
export type UndoScope = 'font' | 'glyph' | 'layer';

export function getLayerTouchKey(
    glyphName: string | null,
    layerId: string | null
): string | null {
    if (!glyphName || !layerId) {
        return null;
    }
    return `${glyphName}@@${layerId}`;
}

/**
 * A single entry in the change log.
 */
export interface ChangeLogEntry {
    /** Unique ID for this entry (monotonically increasing) */
    id: number;
    /** Unix timestamp (ms) */
    timestamp: number;
    /** Opaque source window instance identifier */
    windowId: string;
    /** Human-readable source window label */
    windowRoleLabel: string;
    /** Logical history stack item identifier */
    historyItemId: string;
    /** Whether this row is a change or an undo/redo control action */
    historyAction: HistoryAction;
    /** Linked logical history item affected by undo/redo, if known */
    targetHistoryItemId: string | null;
    /** Transaction label, if this change is part of a batch */
    transactionLabel: string | null;
    /** Transaction ID, shared by all entries in the same batch */
    transactionId: number | null;
    /** Operation type */
    op: ChangeOp;
    /** Effective undo scope for this entry */
    undoScope: UndoScope;
    /** Full dot-delimited path: "glyphs.A.layers.uuid-1.shapes.0.nodes.2.x" */
    path: string;
    /** Value before the change (undefined for "add" ops) */
    oldValue: unknown;
    /** Value after the change (undefined for "remove" ops) */
    newValue: unknown;
    /** Optional features-editor target type for scoped history */
    historyTargetType: HistoryTargetType | null;
    /** Optional stable-enough features-editor target key */
    historyTargetKey: string | null;
    /** Human-readable target label */
    historyTargetLabel: string | null;
    /** Which screen side stayed visually anchored for this edit */
    visualAnchorSide?: 'left' | 'right' | null;
}

let _nextId = 1;

/** Create a new ChangeLogEntry with an auto-incremented id. */
export function createLogEntry(
    fields: Omit<
        ChangeLogEntry,
        | 'id'
        | 'historyItemId'
        | 'historyAction'
        | 'targetHistoryItemId'
        | 'undoScope'
        | 'historyTargetType'
        | 'historyTargetKey'
        | 'historyTargetLabel'
    > & {
        historyItemId?: string;
        historyAction?: HistoryAction;
        targetHistoryItemId?: string | null;
        undoScope?: UndoScope;
        glyphName?: string | null;
        layerId?: string | null;
        objectType?: ChangeObjectType;
        objectId?: string;
        property?: string;
        touchedPaths?: string[];
        touchedGlyphNames?: string[];
        touchedLayerKeys?: string[];
        historyTargetType?: HistoryTargetType | null;
        historyTargetKey?: string | null;
        historyTargetLabel?: string | null;
        visualAnchorSide?: 'left' | 'right' | null;
    }
): ChangeLogEntry {
    const nextId = _nextId++;
    const glyphName = deriveGlyphNameFromPath(fields.path);
    const layerId = deriveLayerIdFromPath(fields.path);
    return attachDerivedEntryAccessors({
        id: nextId,
        historyItemId: fields.historyItemId ?? `history-item-${nextId}`,
        historyAction: fields.historyAction ?? 'change',
        targetHistoryItemId: fields.targetHistoryItemId ?? null,
        undoScope: fields.undoScope ?? deriveUndoScope(glyphName, layerId),
        timestamp: fields.timestamp,
        windowId: fields.windowId,
        windowRoleLabel: fields.windowRoleLabel,
        transactionLabel: fields.transactionLabel,
        transactionId: fields.transactionId,
        op: fields.op,
        path: fields.path,
        oldValue: fields.oldValue,
        newValue: fields.newValue,
        historyTargetType: fields.historyTargetType ?? null,
        historyTargetKey: fields.historyTargetKey ?? null,
        historyTargetLabel: fields.historyTargetLabel ?? null,
        visualAnchorSide: fields.visualAnchorSide ?? null
    });
}

export type ChangeLogEntryLike = Omit<
    ChangeLogEntry,
    'windowRoleLabel' | 'historyItemId' | 'historyAction' | 'undoScope'
> & {
    undoScope?: UndoScope | null;
    windowRoleLabel?: string | null;
    historyItemId?: string | null;
    historyAction?: HistoryAction | null;
    targetHistoryItemId?: string | null;
    glyphName?: string | null;
    layerId?: string | null;
    objectType?: ChangeObjectType | null;
    objectId?: string | null;
    property?: string | null;
    touchedPaths?: string[] | null;
    touchedGlyphNames?: string[] | null;
    touchedLayerKeys?: string[] | null;
    historyTargetType?: HistoryTargetType | null;
    historyTargetKey?: string | null;
    historyTargetLabel?: string | null;
    visualAnchorSide?: 'left' | 'right' | null;
};

export interface HistoryStackItem {
    id: string;
    entries: ChangeLogEntry[];
    timestamp: number;
    windowRoleLabel: string;
    transactionLabel: string | null;
    undoScope: UndoScope;
    touchedPaths: string[];
    isActive: boolean;
    lastAction: HistoryAction;
    historyTargetKeys: string[];
}

const FONT_SCOPE_KEY = '__font__';

function getGlyphScopeKey(glyphName: string | null): string {
    return glyphName ?? FONT_SCOPE_KEY;
}

function getLayerScopeKey(
    glyphName: string | null,
    layerId: string | null
): string | null {
    return getLayerTouchKey(glyphName, layerId);
}

function getPathSegments(path: string): string[] {
    if (!path || path === 'font') {
        return [];
    }
    return path.split('.');
}

function derivePropertyFromPath(path: string): string {
    const segments = getPathSegments(path);
    if (!segments.length) {
        return '';
    }

    const lastSegment = segments[segments.length - 1];
    if (typeof lastSegment !== 'string') {
        return '';
    }

    const fullObject = deriveObjectInfo(segments);
    const parentObject = deriveObjectInfo(segments.slice(0, -1));
    if (
        fullObject.objectType !== parentObject.objectType ||
        fullObject.objectId !== parentObject.objectId
    ) {
        return '';
    }

    return lastSegment;
}

function attachDerivedEntryAccessors(entry: ChangeLogEntry): ChangeLogEntry {
    Object.defineProperties(entry, {
        glyphName: {
            configurable: true,
            enumerable: false,
            get: () => deriveGlyphNameFromPath(entry.path)
        },
        layerId: {
            configurable: true,
            enumerable: false,
            get: () => deriveLayerIdFromPath(entry.path)
        },
        objectType: {
            configurable: true,
            enumerable: false,
            get: () => deriveObjectInfoFromPath(entry.path).objectType
        },
        objectId: {
            configurable: true,
            enumerable: false,
            get: () => deriveObjectInfoFromPath(entry.path).objectId
        },
        property: {
            configurable: true,
            enumerable: false,
            get: () => derivePropertyFromPath(entry.path)
        },
        touchedPaths: {
            configurable: true,
            enumerable: false,
            get: () => [entry.path]
        },
        touchedGlyphNames: {
            configurable: true,
            enumerable: false,
            get: () => deriveGlyphNamesFromPaths([entry.path])
        },
        touchedLayerKeys: {
            configurable: true,
            enumerable: false,
            get: () => deriveLayerTouchKeysFromPaths([entry.path])
        }
    });

    return entry;
}

function normalizeHistoryAction(
    historyAction: HistoryAction | null | undefined
): HistoryAction {
    if (
        historyAction === 'change' ||
        historyAction === 'undo' ||
        historyAction === 'redo'
    ) {
        return historyAction;
    }
    return 'change';
}

function normalizeHistoryItemId(
    historyItemId: string | null | undefined,
    entryId: number
): string {
    if (historyItemId?.trim()) {
        return historyItemId.trim();
    }
    return `history-item-${entryId}`;
}

function getStack(map: Map<string, string[]>, scopeKey: string): string[] {
    let stack = map.get(scopeKey);
    if (!stack) {
        stack = [];
        map.set(scopeKey, stack);
    }
    return stack;
}

function removeFromStack(stack: string[], itemId: string): void {
    const index = stack.lastIndexOf(itemId);
    if (index >= 0) {
        stack.splice(index, 1);
    }
}

function deriveUndoScope(
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

function deriveHistoryItemUndoScope(
    entries: ChangeLogEntry[],
    glyphNames: Set<string>,
    layerIds: Set<string>
): UndoScope {
    if (entries.some((entry) => entry.undoScope === 'font')) {
        return 'font';
    }
    if (glyphNames.size === 0) {
        return 'font';
    }
    if (glyphNames.size > 1) {
        return 'font';
    }
    if (entries.some((entry) => entry.undoScope === 'glyph')) {
        return 'glyph';
    }
    if (layerIds.size !== 1) {
        return 'glyph';
    }
    return 'layer';
}

function stripMutableHistoryItem(
    item: MutableHistoryStackItem
): HistoryStackItem {
    const {
        glyphNameSet: _glyphNameSet,
        layerIdSet: _layerIdSet,
        touchedPathSet: _touchedPathSet,
        touchedLayerKeySet: _touchedLayerKeySet,
        scopeKeys: _scopeKeys,
        historyTargetKeySet: _historyTargetKeySet,
        ...historyItem
    } = item;
    return historyItem;
}

type MutableHistoryStackItem = HistoryStackItem & {
    glyphNameSet: Set<string>;
    layerIdSet: Set<string>;
    touchedPathSet: Set<string>;
    touchedLayerKeySet: Set<string>;
    scopeKeys: Set<string>;
    historyTargetKeySet: Set<string>;
};

function computeHistoryState(entries: ChangeLogEntry[]): {
    orderedItemIds: string[];
    itemsById: Map<string, MutableHistoryStackItem>;
    activeByScope: Map<string, string[]>;
    undoneByScope: Map<string, string[]>;
} {
    const orderedItemIds: string[] = [];
    const itemsById = new Map<string, MutableHistoryStackItem>();
    const activeByScope = new Map<string, string[]>();
    const undoneByScope = new Map<string, string[]>();

    const ensureItem = (entry: ChangeLogEntry): MutableHistoryStackItem => {
        let item = itemsById.get(entry.historyItemId);
        if (!item) {
            item = {
                id: entry.historyItemId,
                entries: [],
                timestamp: entry.timestamp,
                windowRoleLabel: entry.windowRoleLabel,
                transactionLabel: entry.transactionLabel,
                undoScope: entry.undoScope,
                touchedPaths: [],
                glyphNameSet: new Set<string>(),
                layerIdSet: new Set<string>(),
                touchedPathSet: new Set<string>(),
                touchedLayerKeySet: new Set<string>(),
                scopeKeys: new Set<string>(),
                historyTargetKeySet: new Set<string>(),
                isActive: true,
                lastAction: 'change',
                historyTargetKeys: []
            };
            itemsById.set(entry.historyItemId, item);
            orderedItemIds.push(entry.historyItemId);
        }
        return item;
    };

    for (const entry of entries) {
        const entryGlyphName = deriveGlyphNameFromPath(entry.path);
        const entryLayerId = deriveLayerIdFromPath(entry.path);
        const glyphScopeKey = getGlyphScopeKey(entryGlyphName);

        if (entry.historyAction === 'change') {
            const item = ensureItem(entry);
            item.entries.push(entry);
            item.timestamp = entry.timestamp;
            item.windowRoleLabel = entry.windowRoleLabel;
            item.transactionLabel = entry.transactionLabel;
            item.isActive = true;
            item.lastAction = 'change';
            if (entryGlyphName && !item.glyphNameSet.has(entryGlyphName)) {
                item.glyphNameSet.add(entryGlyphName);
            }
            if (entryLayerId && !item.layerIdSet.has(entryLayerId)) {
                item.layerIdSet.add(entryLayerId);
            }
            if (!item.touchedPathSet.has(entry.path)) {
                item.touchedPathSet.add(entry.path);
                item.touchedPaths = [...item.touchedPathSet];
            }
            const touchedLayerKey = getLayerTouchKey(
                entryGlyphName,
                entryLayerId
            );
            if (
                touchedLayerKey &&
                !item.touchedLayerKeySet.has(touchedLayerKey)
            ) {
                item.touchedLayerKeySet.add(touchedLayerKey);
            }
            if (
                entry.historyTargetKey &&
                !item.historyTargetKeySet.has(entry.historyTargetKey)
            ) {
                item.historyTargetKeySet.add(entry.historyTargetKey);
                item.historyTargetKeys = [...item.historyTargetKeySet];
            }
            item.undoScope = deriveHistoryItemUndoScope(
                item.entries,
                item.glyphNameSet,
                item.layerIdSet
            );

            if (!item.scopeKeys.has(glyphScopeKey)) {
                item.scopeKeys.add(glyphScopeKey);
                getStack(activeByScope, glyphScopeKey).push(item.id);
            }

            const layerScopeKey = getLayerScopeKey(
                entryGlyphName,
                entryLayerId
            );
            if (layerScopeKey && !item.scopeKeys.has(layerScopeKey)) {
                item.scopeKeys.add(layerScopeKey);
                getStack(activeByScope, layerScopeKey).push(item.id);
            }

            getStack(undoneByScope, glyphScopeKey).length = 0;
            if (layerScopeKey) {
                getStack(undoneByScope, layerScopeKey).length = 0;
            }
            continue;
        }

        const sourceMap =
            entry.historyAction === 'undo' ? activeByScope : undoneByScope;
        const targetMap =
            entry.historyAction === 'undo' ? undoneByScope : activeByScope;
        const sourceStack = getStack(sourceMap, glyphScopeKey);
        const targetStack = getStack(targetMap, glyphScopeKey);
        const targetItemId =
            entry.targetHistoryItemId ?? sourceStack[sourceStack.length - 1];

        if (!targetItemId) {
            continue;
        }

        const item = itemsById.get(targetItemId);
        if (item) {
            const itemScopeKeys =
                item.scopeKeys.size > 0 ? [...item.scopeKeys] : [glyphScopeKey];
            for (const scopeKey of itemScopeKeys) {
                removeFromStack(getStack(sourceMap, scopeKey), targetItemId);
                getStack(targetMap, scopeKey).push(targetItemId);
            }
            item.isActive = entry.historyAction === 'redo';
            item.lastAction = entry.historyAction;
            item.timestamp = entry.timestamp;
        } else {
            removeFromStack(sourceStack, targetItemId);
            targetStack.push(targetItemId);
        }
    }

    return {
        orderedItemIds,
        itemsById,
        activeByScope,
        undoneByScope
    };
}

export function resolveHistoryTargetItemId(
    entries: ChangeLogEntry[],
    glyphName: string | null | undefined,
    historyAction: 'undo' | 'redo',
    layerId?: string | null
): string | null {
    return (
        resolveHistoryTargetItem(entries, {
            glyphName,
            layerId,
            historyAction
        })?.id ?? null
    );
}

export function resolveHistoryTargetItem(
    entries: ChangeLogEntry[],
    options: {
        glyphName?: string | null;
        layerId?: string | null;
        historyAction: 'undo' | 'redo';
        historyTargetKey?: string | null;
    }
): HistoryStackItem | null {
    const glyphName = options.glyphName ?? null;
    const layerId = options.layerId ?? null;
    const historyTargetKey = options.historyTargetKey ?? null;

    const visibleItems = buildHistoryStackItems(entries, {
        glyphName,
        layerId,
        includeUndone: true,
        historyTargetKey
    }).filter((item) =>
        options.historyAction === 'undo' ? item.isActive : !item.isActive
    );

    return visibleItems.length ? visibleItems[visibleItems.length - 1] : null;
}

export function buildHistoryStackItems(
    entries: ChangeLogEntry[],
    options?: {
        glyphName?: string | null;
        layerId?: string | null;
        includeUndone?: boolean;
        historyTargetKey?: string | null;
    }
): HistoryStackItem[] {
    const glyphName = options?.glyphName ?? null;
    const layerId = options?.layerId ?? null;
    const includeUndone = options?.includeUndone ?? false;
    const historyTargetKey = options?.historyTargetKey ?? null;
    const state = computeHistoryState(entries);

    return state.orderedItemIds
        .map((itemId) => state.itemsById.get(itemId))
        .filter((item): item is MutableHistoryStackItem => !!item)
        .filter((item) => {
            if (glyphName && !item.glyphNameSet.has(glyphName)) {
                return false;
            }
            const layerTouchKey = getLayerTouchKey(glyphName, layerId);
            if (layerTouchKey) {
                const isGlyphOrFontScopedItemForGlyph =
                    (item.undoScope === 'glyph' || item.undoScope === 'font') &&
                    !!glyphName &&
                    item.glyphNameSet.has(glyphName);
                if (
                    !item.touchedLayerKeySet.has(layerTouchKey) &&
                    !isGlyphOrFontScopedItemForGlyph
                ) {
                    return false;
                }
            }
            if (
                historyTargetKey &&
                !item.historyTargetKeySet.has(historyTargetKey)
            ) {
                return false;
            }
            if (!includeUndone && !item.isActive) {
                return false;
            }
            return true;
        })
        .map((item) => stripMutableHistoryItem(item));
}

export function normalizeWindowRoleLabel(
    windowRoleLabel: string | null | undefined,
    windowId: string
): string {
    if (windowRoleLabel?.trim()) {
        return windowRoleLabel.trim();
    }

    if (/^(main|primary)$/i.test(windowId)) {
        return 'Main';
    }

    const linkedMatch = windowId.match(
        /^(?:linked|secondary|remote)[- ]?(\d+)$/i
    );
    if (linkedMatch) {
        return `Linked ${linkedMatch[1]}`;
    }

    return 'Window';
}

/** Reset the ID counter (for tests). */
export function resetLogCounter(): void {
    _nextId = 1;
}

/**
 * Derive objectType and objectId from a path array.
 *
 * Path examples:
 *   ["glyphs", "A", "layers", "uuid", "shapes", 0, "nodes", 2, "x"]
 *   ["axes", 0, "tag"]
 *   ["upm"]
 */
export function deriveObjectInfo(path: (string | number)[]): {
    objectType: ChangeObjectType;
    objectId: string;
} {
    if (path.length === 0) return { objectType: 'font', objectId: '' };

    const first = path[0];

    if (first === 'glyphs' && path.length >= 2) {
        const glyphName = String(path[1]);
        if (path.length === 2)
            return { objectType: 'glyph', objectId: glyphName };
        if (path.length >= 4 && path[2] === 'layers') {
            const layerId = String(path[3]);
            if (path.length === 4)
                return { objectType: 'layer', objectId: layerId };
            if (path.length >= 6 && path[4] === 'shapes') {
                const shapeIdx = String(path[5]);
                if (path.length === 6)
                    return { objectType: 'shape', objectId: shapeIdx };
                if (path.length >= 8 && path[6] === 'nodes')
                    return {
                        objectType: 'node',
                        objectId: `${glyphName}/${layerId}/shape${shapeIdx}/node${path[7]}`
                    };
                // It might be a component or path sub-property
                return { objectType: 'shape', objectId: shapeIdx };
            }
            if (path.length >= 6 && path[4] === 'anchors')
                return {
                    objectType: 'anchor',
                    objectId: `${glyphName}/${layerId}/anchor${path[5]}`
                };
            if (path.length >= 6 && path[4] === 'guides')
                return {
                    objectType: 'guide',
                    objectId: `${glyphName}/${layerId}/guide${path[5]}`
                };
            return { objectType: 'layer', objectId: layerId };
        }
        return { objectType: 'glyph', objectId: glyphName };
    }

    if (first === 'axes' && path.length >= 2)
        return { objectType: 'axis', objectId: String(path[1]) };
    if (first === 'masters' && path.length >= 2)
        return { objectType: 'master', objectId: String(path[1]) };
    if (first === 'instances' && path.length >= 2)
        return { objectType: 'instance', objectId: String(path[1]) };
    if (first === 'features' && path.length >= 2) {
        if (path[1] === 'prefixes' && path.length >= 3) {
            return { objectType: 'prefix', objectId: String(path[2]) };
        }
        if (path[1] === 'classes' && path.length >= 3) {
            return { objectType: 'class', objectId: String(path[2]) };
        }
        if (path[1] === 'features' && path.length >= 3) {
            return { objectType: 'feature', objectId: String(path[2]) };
        }
    }

    return { objectType: 'font', objectId: '' };
}

export function deriveGlyphName(path: (string | number)[]): string | null {
    if (path[0] === 'glyphs' && typeof path[1] === 'string') {
        return path[1];
    }
    return null;
}

export function deriveLayerId(path: (string | number)[]): string | null {
    if (
        path[0] === 'glyphs' &&
        path[2] === 'layers' &&
        typeof path[3] === 'string'
    ) {
        return path[3];
    }
    return null;
}

export function deriveGlyphNameFromPath(path: string): string | null {
    if (!path) {
        return null;
    }
    return deriveGlyphName(getPathSegments(path));
}

export function deriveLayerIdFromPath(path: string): string | null {
    if (!path) {
        return null;
    }
    return deriveLayerId(getPathSegments(path));
}

export function deriveObjectInfoFromPath(path: string): {
    objectType: ChangeObjectType;
    objectId: string;
} {
    return deriveObjectInfo(getPathSegments(path));
}

export function deriveGlyphNamesFromPaths(paths: string[]): string[] {
    const glyphNames = new Set<string>();
    for (const path of paths) {
        const glyphName = deriveGlyphNameFromPath(path);
        if (glyphName) {
            glyphNames.add(glyphName);
        }
    }
    return [...glyphNames];
}

export function deriveLayerIdsFromPaths(paths: string[]): string[] {
    const layerIds = new Set<string>();
    for (const path of paths) {
        const layerId = deriveLayerIdFromPath(path);
        if (layerId) {
            layerIds.add(layerId);
        }
    }
    return [...layerIds];
}

export function deriveLayerTouchKeysFromPaths(paths: string[]): string[] {
    const layerKeys = new Set<string>();
    for (const path of paths) {
        const glyphName = deriveGlyphNameFromPath(path);
        const layerId = deriveLayerIdFromPath(path);
        const layerKey = getLayerTouchKey(glyphName, layerId);
        if (layerKey) {
            layerKeys.add(layerKey);
        }
    }
    return [...layerKeys];
}

export function normalizeChangeLogEntry(
    entry: ChangeLogEntryLike
): ChangeLogEntry {
    const glyphName = deriveGlyphNameFromPath(entry.path);
    const layerId = deriveLayerIdFromPath(entry.path);
    return attachDerivedEntryAccessors({
        id: entry.id,
        timestamp: entry.timestamp,
        windowId: entry.windowId,
        transactionLabel: entry.transactionLabel,
        transactionId: entry.transactionId,
        op: entry.op,
        path: entry.path,
        oldValue: entry.oldValue,
        newValue: entry.newValue,
        historyItemId: normalizeHistoryItemId(entry.historyItemId, entry.id),
        historyAction: normalizeHistoryAction(entry.historyAction),
        undoScope: entry.undoScope ?? deriveUndoScope(glyphName, layerId),
        targetHistoryItemId: entry.targetHistoryItemId ?? null,
        historyTargetType: entry.historyTargetType ?? null,
        historyTargetKey: entry.historyTargetKey ?? null,
        historyTargetLabel: entry.historyTargetLabel ?? null,
        visualAnchorSide: entry.visualAnchorSide ?? null,
        windowRoleLabel: normalizeWindowRoleLabel(
            entry.windowRoleLabel,
            entry.windowId
        )
    });
}
