/**
 * Y.Doc ↔ JSON synchronization utilities.
 *
 * These pure-ish functions convert between the plain babelfont JSON objects
 * and Yjs shared types (Y.Map / Y.Array). They are the only place that
 * touches the Yjs API directly when reading/writing document data.
 */

import * as Y from 'yjs';

type Unsafe = ReturnType<typeof JSON.parse>;

// ── helpers ──────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ── JSON → Y.Doc ────────────────────────────────────────────────────

/**
 * Convert a plain JS value into a Y.Map, Y.Array, or primitive suitable
 * for insertion into a Y.Doc.
 */
export function toYType(value: unknown): unknown {
    if (Array.isArray(value)) {
        const arr = new Y.Array();
        const items = value.map(toYType);
        arr.push(items);
        return arr;
    }
    if (isPlainObject(value)) {
        const map = new Y.Map();
        for (const [k, v] of Object.entries(value)) {
            map.set(k, toYType(v));
        }
        return map;
    }
    // primitives (string, number, boolean, null) are stored as-is
    return value;
}

/**
 * Populate a Y.Map from a babelfont Font JSON object.
 *
 * Glyphs are stored as a Y.Map keyed by glyph name (not an array).
 * Within each glyph, layers are stored as a Y.Map keyed by layer id.
 * Everything else follows the normal JSON→Y.Type mapping.
 */
export function jsonToYDoc(
    json: Record<string, unknown>,
    fontMap: Y.Map<unknown>
): void {
    for (const [key, value] of Object.entries(json)) {
        if (key === 'glyphs' && Array.isArray(value)) {
            // Glyphs → Y.Map keyed by name
            const glyphsMap = new Y.Map();
            for (const glyphJson of value as Record<string, unknown>[]) {
                const name = glyphJson.name as string;
                const glyphMap = new Y.Map();
                for (const [gk, gv] of Object.entries(glyphJson)) {
                    if (gk === 'layers' && Array.isArray(gv)) {
                        // Layers → Y.Map keyed by layer id
                        const layersMap = new Y.Map();
                        for (const layerJson of gv as Record<
                            string,
                            unknown
                        >[]) {
                            const layerId =
                                (layerJson.id as string) || crypto.randomUUID();
                            layersMap.set(
                                layerId,
                                toYType(layerJson) as Y.Map<unknown>
                            );
                        }
                        glyphMap.set('layers', layersMap);
                    } else {
                        glyphMap.set(gk, toYType(gv));
                    }
                }
                glyphsMap.set(name, glyphMap);
            }
            fontMap.set('glyphs', glyphsMap);
        } else {
            fontMap.set(key, toYType(value));
        }
    }
}

// ── Y.Doc → JSON ────────────────────────────────────────────────────

/**
 * Convert a Yjs shared type back into a plain JS value.
 */
export function fromYType(value: unknown): unknown {
    if (value instanceof Y.Map) {
        const obj: Record<string, unknown> = {};
        value.forEach((v: unknown, k: string) => {
            obj[k] = fromYType(v);
        });
        return obj;
    }
    if (value instanceof Y.Array) {
        const arr: unknown[] = [];
        value.forEach((v: unknown) => {
            arr.push(fromYType(v));
        });
        return arr;
    }
    return value;
}

/**
 * Extract the full babelfont Font JSON from a Y.Doc fontMap.
 *
 * Reverses the keyed-map structure for glyphs and layers back into arrays.
 */
export function yDocToJson(fontMap: Y.Map<unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    fontMap.forEach((value: unknown, key: string) => {
        if (key === 'glyphs' && value instanceof Y.Map) {
            // Glyphs Y.Map → array
            const glyphs: Record<string, unknown>[] = [];
            (value as Y.Map<unknown>).forEach(
                (glyphYMap: unknown, _name: string) => {
                    if (glyphYMap instanceof Y.Map) {
                        const glyphJson: Record<string, unknown> = {};
                        glyphYMap.forEach((gv: unknown, gk: string) => {
                            if (gk === 'layers' && gv instanceof Y.Map) {
                                // Layers Y.Map → array
                                const layers: Record<string, unknown>[] = [];
                                (gv as Y.Map<unknown>).forEach(
                                    (layerYMap: unknown, _layerId: string) => {
                                        layers.push(
                                            fromYType(layerYMap) as Record<
                                                string,
                                                unknown
                                            >
                                        );
                                    }
                                );
                                glyphJson['layers'] = layers;
                            } else {
                                glyphJson[gk] = fromYType(gv);
                            }
                        });
                        glyphs.push(glyphJson);
                    }
                }
            );
            result['glyphs'] = glyphs;
        } else {
            result[key] = fromYType(value);
        }
    });

    return result;
}

// ── Deep path access on Y.Doc ───────────────────────────────────────

/**
 * Resolve a path through the Y.Doc tree.
 * Returns the Y.Map / Y.Array / primitive at the given path, or undefined.
 *
 * Path segments are strings (map keys) or numbers (array indices).
 */
export function getYPath(
    root: Y.Map<unknown>,
    path: (string | number)[]
): unknown {
    let current: unknown = root;
    for (const seg of path) {
        if (current instanceof Y.Map) {
            current = current.get(String(seg));
        } else if (current instanceof Y.Array) {
            current = current.get(Number(seg));
        } else {
            return undefined;
        }
        if (current === undefined) return undefined;
    }
    return current;
}

/**
 * Set a value at a deep path in a Y.Doc tree.
 * Creates intermediate Y.Maps as needed.
 * The final segment determines where the value is written.
 */
export function setYPath(
    root: Y.Map<unknown>,
    path: (string | number)[],
    value: unknown
): void {
    if (path.length === 0) return;
    let current: unknown = root;
    // Navigate to the parent of the target
    for (let i = 0; i < path.length - 1; i++) {
        const seg = path[i];
        let next: unknown;
        if (current instanceof Y.Map) {
            next = current.get(String(seg));
            if (next === undefined) {
                // Auto-create intermediate Y.Map
                const newMap = new Y.Map();
                current.set(String(seg), newMap);
                next = newMap;
            }
        } else if (current instanceof Y.Array) {
            next = current.get(Number(seg));
        } else {
            return; // Can't navigate further
        }
        current = next;
    }

    const lastSeg = path[path.length - 1];
    const yValue = toYType(value);
    if (current instanceof Y.Map) {
        current.set(String(lastSeg), yValue);
    } else if (current instanceof Y.Array) {
        const idx = Number(lastSeg);
        if (idx === current.length) {
            current.insert(idx, [yValue]);
        } else if (idx >= 0 && idx < current.length) {
            current.delete(idx, 1);
            current.insert(idx, [yValue]);
        }
    }
}

/**
 * Delete a key/index at a deep path in a Y.Doc tree.
 */
export function deleteYPath(
    root: Y.Map<unknown>,
    path: (string | number)[]
): void {
    if (path.length === 0) return;
    const parent = path.length > 1 ? getYPath(root, path.slice(0, -1)) : root;
    const lastSeg = path[path.length - 1];

    if (parent instanceof Y.Map) {
        parent.delete(String(lastSeg));
    } else if (parent instanceof Y.Array) {
        const idx = Number(lastSeg);
        if (idx >= 0 && idx < parent.length) {
            parent.delete(idx, 1);
        }
    }
}

// ── Apply Y.Doc change back to plain JSON ───────────────────────────

/**
 * Set a value at a deep path in a plain JS object tree.
 * Creates intermediate objects/arrays as needed.
 */
export function setJsonPath(
    root: Record<string, Unsafe>,
    path: (string | number)[],
    value: unknown
): void {
    if (path.length === 0) return;
    let current: Unsafe = root;
    for (let i = 0; i < path.length - 1; i++) {
        const seg = path[i];
        if (current[seg] === undefined || current[seg] === null) {
            // Guess whether to create object or array based on next segment type
            const nextSeg = path[i + 1];
            current[seg] = typeof nextSeg === 'number' ? [] : {};
        }
        current = current[seg];
    }
    const lastSeg = path[path.length - 1];
    current[lastSeg] = value;
}

/**
 * Delete a key/index at a deep path in a plain JS object tree.
 */
export function deleteJsonPath(
    root: Record<string, Unsafe>,
    path: (string | number)[]
): void {
    if (path.length === 0) return;
    let current: Unsafe = root;
    for (let i = 0; i < path.length - 1; i++) {
        const seg = path[i];
        current = current[seg];
        if (current === undefined || current === null) return;
    }
    const lastSeg = path[path.length - 1];
    if (Array.isArray(current) && typeof lastSeg === 'number') {
        current.splice(lastSeg, 1);
    } else if (typeof current === 'object' && current !== null) {
        delete current[lastSeg];
    }
}

/**
 * Read a value at a deep path in a plain JS object tree.
 */
export function getJsonPath(
    root: Record<string, Unsafe>,
    path: (string | number)[]
): unknown {
    let current: Unsafe = root;
    for (const seg of path) {
        if (current === undefined || current === null) return undefined;
        current = current[seg];
    }
    return current;
}
