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

function normalizeComponentTransformRecord(
    transform: unknown
): Record<string, unknown> {
    if (
        !transform ||
        typeof transform !== 'object' ||
        Array.isArray(transform)
    ) {
        return {
            translation: [0, 0],
            rotation: 0,
            scale: [1, 1],
            skew: [0, 0],
            order: 'RestOfTheWorld'
        };
    }

    const record = transform as Record<string, unknown>;
    const translation = Array.isArray(record.translation)
        ? [
              Number(record.translation[0]) || 0,
              Number(record.translation[1]) || 0
          ]
        : [0, 0];
    const scale = Array.isArray(record.scale)
        ? [Number(record.scale[0]) || 1, Number(record.scale[1]) || 1]
        : [1, 1];
    const rawSkew = Array.isArray(record.skew)
        ? record.skew
        : [record.skew ?? 0, 0];

    return {
        translation,
        rotation: Number(record.rotation) || 0,
        scale,
        skew: [Number(rawSkew[0]) || 0, Number(rawSkew[1]) || 0],
        order:
            record.order === 'Glyphs' || record.order === 'RestOfTheWorld'
                ? record.order
                : 'RestOfTheWorld'
    };
}

function normalizeValueForYDocWrite(value: unknown): unknown {
    if (!isPlainObject(value)) {
        return value;
    }

    const record = value as Record<string, unknown>;

    if (
        'Path' in record &&
        record.Path &&
        typeof record.Path === 'object' &&
        !Array.isArray(record.Path)
    ) {
        return normalizeValueForYDocWrite(record.Path);
    }

    if (
        'Component' in record &&
        record.Component &&
        typeof record.Component === 'object' &&
        !Array.isArray(record.Component) &&
        !('Path' in record)
    ) {
        return normalizeValueForYDocWrite(record.Component);
    }

    if ('nodes' in record) {
        if (!Array.isArray(record.nodes)) {
            throw new TypeError(
                'Path shape nodes must be an array before writing to Y.Doc.'
            );
        }

        return {
            ...record,
            closed: record.closed === undefined ? false : record.closed
        };
    }

    // Ensure component transforms are normalized for Y.Doc storage
    if ('reference' in record) {
        const normalizedTransform = normalizeComponentTransformRecord(
            record.transform
        );
        const { tcenter: _tcenter, ...recordWithoutTcenter } = record;
        if (
            !isPlainObject(record.transform) ||
            JSON.stringify(record.transform) !==
                JSON.stringify(normalizedTransform) ||
            'tcenter' in record
        ) {
            return {
                ...recordWithoutTcenter,
                transform: normalizedTransform
            };
        }
    }

    return value;
}

function createYContainerForNextSegment(
    nextSegment: string | number
): Y.Map<unknown> | Y.Array<unknown> {
    return typeof nextSegment === 'number' ? new Y.Array() : new Y.Map();
}

// ── JSON → Y.Doc ────────────────────────────────────────────────────
// FULLJSON_UNNECESSARY (U4): Used by buildWorkerYjsStateFromCurrentFont
// which parses full babelfontJson then rebuilds Y.Doc → binary Yjs state.
// Should use bridge.encodeBridgeState() instead.
// TODO(feature-code): We investigated malformed feature-code edits that passed
// in tests but still showed no browser compile error. The live app proved the
// JS model/Y.Doc and post-commit compile request were correct, but the Rust
// worker still appeared to validate stale feature source after the Yjs update.
// We did not land a fix; if this is revisited, start by proving what feature
// code Rust sees after applyYjsUpdate instead of changing the commit funnel.
// Linked site: font-compilation.ts U2/A3 keeps feature-code compiles on the
// explicit full-JSON compile path as a workaround for this suspected stale Rust
// feature-cache read. Remove both comments together only after cached full-font
// feature validation produces the same inline errors without compileFromJson.

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
        const normalizedValue = normalizeValueForYDocWrite(value) as Record<
            string,
            unknown
        >;
        const map = new Y.Map();
        for (const [k, v] of Object.entries(normalizedValue)) {
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
 * Y.Map and Y.Array identity is preserved exactly; numeric string keys
 * remain object keys so malformed array containers fail visibly.
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
 *
 * FULLJSON_UNNECESSARY (B1/U3): Walks the entire Y.Doc tree.
 * Called from _syncJsonFromYDoc fallback and cloud plugin save.
 * Should only fire for cloud save; the _syncJsonFromYDoc fallback
 * should be eliminated by fixing _patchLayerFromYDoc.
 */
export function yDocToJson(fontMap: Y.Map<unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    fontMap.forEach((value: unknown, key: string) => {
        if (key === 'glyphs' && value instanceof Y.Map) {
            // Glyphs Y.Map → array
            const glyphs: Record<string, unknown>[] = [];
            (value as Y.Map<unknown>).forEach(
                (glyphYMap: unknown, glyphName: string) => {
                    if (glyphYMap instanceof Y.Map) {
                        const glyphJson: Record<string, unknown> = {};
                        glyphYMap.forEach((gv: unknown, gk: string) => {
                            if (gk === 'layers' && gv instanceof Y.Map) {
                                // Layers Y.Map → array
                                const layers: Record<string, unknown>[] = [];
                                (gv as Y.Map<unknown>).forEach(
                                    (layerYMap: unknown, layerId: string) => {
                                        const layerValue = fromYType(layerYMap);
                                        const layerJson =
                                            layerValue &&
                                            typeof layerValue === 'object' &&
                                            !Array.isArray(layerValue)
                                                ? (layerValue as Record<
                                                      string,
                                                      unknown
                                                  >)
                                                : {};
                                        if (
                                            typeof layerJson.id !== 'string' ||
                                            !layerJson.id.length
                                        ) {
                                            layerJson.id = layerId;
                                        }
                                        layers.push(layerJson);
                                    }
                                );
                                glyphJson['layers'] = layers;
                            } else {
                                glyphJson[gk] = fromYType(gv);
                            }
                        });
                        if (
                            typeof glyphJson.name !== 'string' ||
                            !glyphJson.name.length
                        ) {
                            glyphJson.name = glyphName;
                        }
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
 * Creates intermediate Y.Maps or Y.Arrays according to the next path segment.
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
                const newContainer = createYContainerForNextSegment(
                    path[i + 1]
                );
                current.set(String(seg), newContainer);
                next = newContainer;
            }
        } else if (current instanceof Y.Array) {
            const idx = Number(seg);
            if (!Number.isInteger(idx) || idx < 0 || idx > current.length) {
                return;
            }

            next = idx < current.length ? current.get(idx) : undefined;
            if (next === undefined) {
                const newContainer = createYContainerForNextSegment(
                    path[i + 1]
                );
                if (idx === current.length) {
                    current.insert(idx, [newContainer]);
                } else {
                    current.delete(idx, 1);
                    current.insert(idx, [newContainer]);
                }
                next = newContainer;
            }
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
