/**
 * Change Log — Metadata for undo history entries.
 *
 * Each entry records a single property change (or an add/remove operation)
 * with enough context for the undo manager UI to display, filter, and
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
    | 'shape';

/** Operation type */
export type ChangeOp = 'set' | 'add' | 'remove';

/**
 * A single entry in the change log.
 */
export interface ChangeLogEntry {
    /** Unique ID for this entry (monotonically increasing) */
    id: number;
    /** Unix timestamp (ms) */
    timestamp: number;
    /** Source window identifier (e.g. "tab-1", "tab-2") */
    windowId: string;
    /** Transaction label, if this change is part of a batch */
    transactionLabel: string | null;
    /** Transaction ID, shared by all entries in the same batch */
    transactionId: number | null;
    /** Operation type */
    op: ChangeOp;
    /** High-level object type */
    objectType: ChangeObjectType;
    /** Human-readable object identifier (glyph name, layer ID, axis tag…) */
    objectId: string;
    /** Property name that changed (e.g. "x", "width", "name") */
    property: string;
    /** Full dot-delimited path: "glyphs.A.layers.uuid-1.shapes.0.nodes.2.x" */
    path: string;
    /** Value before the change (undefined for "add" ops) */
    oldValue: unknown;
    /** Value after the change (undefined for "remove" ops) */
    newValue: unknown;
}

let _nextId = 1;

/** Create a new ChangeLogEntry with an auto-incremented id. */
export function createLogEntry(
    fields: Omit<ChangeLogEntry, 'id'>
): ChangeLogEntry {
    return { id: _nextId++, ...fields };
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

    return { objectType: 'font', objectId: '' };
}
