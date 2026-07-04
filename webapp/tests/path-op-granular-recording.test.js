/**
 * Tests for granular id-based change-log recording in model path operations.
 *
 * Verifies Phase 2 of the Y.Doc Granular Schema Rewrite:
 * - _setStartNode records nodeOrder change (not whole nodes array)
 * - _setStartNode produces zero node-data entries for a pure rotation
 * - Node identity (.id) is preserved through reorder operations
 */

const {
    Font,
    ensureStableIds,
    withSuppressedModelRecording
} = require('../js/babelfont-model');
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const Y = require('yjs');

// ── Helpers ──────────────────────────────────────────────────────────

/** Minimal font with one glyph, one layer, one closed path, N nodes */
function makeTestFont(nodeCount = 5) {
    const nodes = [];
    for (let i = 0; i < nodeCount; i++) {
        nodes.push({
            x: 100 + i * 200,
            y: 200 + i * 100,
            nodetype: 'Line',
            smooth: false
        });
    }
    return {
        upm: 1000,
        version: [1, 0],
        date: '2024-01-01',
        names: { familyName: 'TestFont' },
        features: { classes: {}, prefixes: {}, features: [] },
        masters: [
            {
                id: 'master-1',
                name: 'Regular',
                location: {},
                guides: [],
                metrics: {},
                kerning: {},
                custom_ot_values: {},
                format_specific: {}
            }
        ],
        glyphs: [
            {
                name: 'A',
                category: 'Base',
                codepoints: [65],
                exported: true,
                layers: [
                    {
                        id: 'layer-1',
                        name: 'Regular',
                        width: 600,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-1'
                        },
                        shapes: [
                            {
                                nodes: nodes,
                                closed: true
                            }
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            }
        ],
        format_specific: {}
    };
}

/** Mock bridge that captures recordChange/recordAdd/recordRemove calls */
function makeMockBridge() {
    const calls = [];
    const mock = {
        recordChange(path, prop, oldVal, newVal) {
            calls.push({ op: 'set', path: [...path, prop], oldVal, newVal });
        },
        recordAdd(path, value) {
            calls.push({
                op: 'add',
                path,
                oldValue: undefined,
                newValue: value
            });
        },
        recordRemove(path, oldValue) {
            calls.push({ op: 'remove', path, oldValue, newValue: undefined });
        },
        beginTransaction() {},
        endTransaction() {
            return null;
        },
        get inTransaction() {
            return false;
        },
        _calls: calls
    };
    return mock;
}

function setupBridge(bridge) {
    global.window = global.window || {};
    global.window.patchSyncEngine = bridge;
}

function teardownBridge() {
    if (global.window) {
        delete global.window.patchSyncEngine;
    }
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Path._setStartNode — granular id-based recording', () => {
    let originalBridge;

    beforeEach(() => {
        originalBridge = global.window?.patchSyncEngine;
    });

    afterEach(() => {
        if (originalBridge !== undefined) {
            global.window = global.window || {};
            global.window.patchSyncEngine = originalBridge;
        } else {
            teardownBridge();
        }
    });

    test('records nodeOrder change, not whole nodes array', () => {
        const fontJson = makeTestFont(5);
        ensureStableIds(fontJson);
        const font = new Font(fontJson);
        const glyph = font.glyphs[0];
        const layer = glyph.layers[0];
        const path = layer.paths[0];

        // Verify nodes have ids
        const nodeIds = path.data.nodes.map((n) => n.id);
        expect(nodeIds.length).toBe(5);
        expect(new Set(nodeIds).size).toBe(5); // all unique

        const bridge = makeMockBridge();
        setupBridge(bridge);

        const result = path._setStartNode(2);

        expect(result).toBe(true);

        // Should have recorded at least one entry
        expect(bridge._calls.length).toBeGreaterThanOrEqual(1);

        // Find the nodeOrder entry
        const orderEntry = bridge._calls.find(
            (c) => c.path[c.path.length - 1] === 'nodeOrder'
        );
        expect(orderEntry).toBeDefined();
        expect(orderEntry.op).toBe('set');
        expect(Array.isArray(orderEntry.oldVal)).toBe(true);
        expect(Array.isArray(orderEntry.newVal)).toBe(true);
        expect(orderEntry.oldVal.length).toBe(5);
        expect(orderEntry.newVal.length).toBe(5);

        // The old and new orders should have the same set of ids
        const oldSet = new Set(orderEntry.oldVal);
        const newSet = new Set(orderEntry.newVal);
        expect(oldSet.size).toBe(5);
        expect(newSet.size).toBe(5);
        for (const id of oldSet) {
            expect(newSet.has(id)).toBe(true);
        }

        // The new order should be a rotation of the old order
        expect(orderEntry.newVal).not.toEqual(orderEntry.oldVal);

        // Should NOT have a 'nodes' whole-array entry
        const nodesEntry = bridge._calls.find(
            (c) => c.path[c.path.length - 1] === 'nodes'
        );
        expect(nodesEntry).toBeUndefined();
    });

    test('produces zero node-data entries for pure rotation', () => {
        const fontJson = makeTestFont(10);
        ensureStableIds(fontJson);
        const font = new Font(fontJson);
        const glyph = font.glyphs[0];
        const layer = glyph.layers[0];
        const path = layer.paths[0];

        const bridge = makeMockBridge();
        setupBridge(bridge);

        path._setStartNode(3);

        // For a pure rotation of a closed path with Line nodes,
        // normalization should be a no-op — only the order entry.
        const nodeDataEntries = bridge._calls.filter((c) => {
            const last = c.path[c.path.length - 1];
            return (
                last === 'nodetype' ||
                last === 'smooth' ||
                last === 'x' ||
                last === 'y'
            );
        });
        expect(nodeDataEntries.length).toBe(0);
    });

    test('preserves node identity through rotation', () => {
        const fontJson = makeTestFont(5);
        ensureStableIds(fontJson);
        const font = new Font(fontJson);
        const glyph = font.glyphs[0];
        const layer = glyph.layers[0];
        const path = layer.paths[0];

        const beforeIds = path.data.nodes.map((n) => n.id);

        path._setStartNode(2);

        const afterIds = path.data.nodes.map((n) => n.id);

        // Same set of ids, different order
        expect(new Set(afterIds)).toEqual(new Set(beforeIds));
        expect(afterIds).not.toEqual(beforeIds);

        // The first id after should be the id that was at index 2 before
        expect(afterIds[0]).toBe(beforeIds[2]);
    });

    test('does not record when path is not closed', () => {
        const fontJson = makeTestFont(5);
        fontJson.glyphs[0].layers[0].shapes[0].closed = false;
        ensureStableIds(fontJson);
        const font = new Font(fontJson);
        const path = font.glyphs[0].layers[0].paths[0];

        const bridge = makeMockBridge();
        setupBridge(bridge);

        const result = path._setStartNode(2);

        expect(result).toBe(false);
        expect(bridge._calls.length).toBe(0);
    });

    test('does not record when nodeIndex is 0', () => {
        const fontJson = makeTestFont(5);
        ensureStableIds(fontJson);
        const font = new Font(fontJson);
        const path = font.glyphs[0].layers[0].paths[0];

        const bridge = makeMockBridge();
        setupBridge(bridge);

        const result = path._setStartNode(0);

        expect(result).toBe(false);
        expect(bridge._calls.length).toBe(0);
    });
});

describe('Path._reverseDirection — granular id-based recording', () => {
    let originalBridge;

    beforeEach(() => {
        originalBridge = global.window?.patchSyncEngine;
    });

    afterEach(() => {
        if (originalBridge !== undefined) {
            global.window = global.window || {};
            global.window.patchSyncEngine = originalBridge;
        } else {
            teardownBridge();
        }
    });

    test('records nodeOrder change, not whole nodes array', () => {
        const fontJson = makeTestFont(5);
        ensureStableIds(fontJson);
        const font = new Font(fontJson);
        const path = font.glyphs[0].layers[0].paths[0];

        const bridge = makeMockBridge();
        setupBridge(bridge);

        const result = path._reverseDirection();

        expect(result).toBe(true);

        // Find the nodeOrder entry
        const orderEntry = bridge._calls.find(
            (c) => c.path[c.path.length - 1] === 'nodeOrder'
        );
        expect(orderEntry).toBeDefined();
        expect(orderEntry.oldVal.length).toBe(5);
        expect(orderEntry.newVal.length).toBe(5);

        // Same set of ids, different order
        const oldSet = new Set(orderEntry.oldVal);
        const newSet = new Set(orderEntry.newVal);
        for (const id of oldSet) {
            expect(newSet.has(id)).toBe(true);
        }
        expect(orderEntry.newVal).not.toEqual(orderEntry.oldVal);

        // Should NOT have a 'nodes' whole-array entry
        const nodesEntry = bridge._calls.find(
            (c) => c.path[c.path.length - 1] === 'nodes'
        );
        expect(nodesEntry).toBeUndefined();
    });

    test('produces zero node-data entries for closed path with Line nodes', () => {
        const fontJson = makeTestFont(10);
        ensureStableIds(fontJson);
        const font = new Font(fontJson);
        const path = font.glyphs[0].layers[0].paths[0];

        const bridge = makeMockBridge();
        setupBridge(bridge);

        path._reverseDirection();

        // For a closed path with all-Line nodes, the reverse is a pure
        // reorder — normalization should not change any nodetype/smooth.
        const nodeDataEntries = bridge._calls.filter((c) => {
            const last = c.path[c.path.length - 1];
            return (
                last === 'nodetype' ||
                last === 'smooth' ||
                last === 'x' ||
                last === 'y'
            );
        });
        expect(nodeDataEntries.length).toBe(0);
    });

    test('preserves node identity through reverse', () => {
        const fontJson = makeTestFont(5);
        ensureStableIds(fontJson);
        const font = new Font(fontJson);
        const path = font.glyphs[0].layers[0].paths[0];

        const beforeIds = path.data.nodes.map((n) => n.id);

        path._reverseDirection();

        const afterIds = path.data.nodes.map((n) => n.id);

        // Same set of ids
        expect(new Set(afterIds)).toEqual(new Set(beforeIds));
        // Different order
        expect(afterIds).not.toEqual(beforeIds);
    });
});

// ── Integration: model → bridge → Y.Doc byte budget ─────────────────

describe('Integration: set-start-point and reverse-direction byte budgets', () => {
    let originalBridge;

    beforeEach(() => {
        originalBridge = global.window?.patchSyncEngine;
    });

    afterEach(() => {
        if (originalBridge !== undefined) {
            global.window = global.window || {};
            global.window.patchSyncEngine = originalBridge;
        } else {
            teardownBridge();
        }
    });

    test('set start point on 20-node contour produces < 600 byte Yjs delta', () => {
        const fontJson = makeTestFont(20);
        ensureStableIds(fontJson);

        const bridge = new PatchSyncEngine('integration-set-start');
        bridge.initFromJson(fontJson);
        setupBridge(bridge);

        const font = new Font(fontJson);
        const path = font.glyphs[0].layers[0].paths[0];

        const beforeSV = Y.encodeStateVector(bridge.yDoc);

        path._setStartNode(5);

        // Debug: check change-log
        const log = bridge.getChangeLog();
        expect(log.length).toBeGreaterThanOrEqual(1);
        const orderEntry = log.find(
            (e) => e.path && e.path.includes('nodeOrder')
        );
        expect(orderEntry).toBeDefined();

        // Debug: check the recorded oldValue and newValue
        const oldOrder = orderEntry.oldValue;
        const newOrder = orderEntry.newValue;
        expect(Array.isArray(oldOrder)).toBe(true);
        expect(Array.isArray(newOrder)).toBe(true);
        expect(oldOrder.length).toBe(20);
        expect(newOrder.length).toBe(20);
        // For a rotation at index 5: newOrder should be [old[5], old[6], ..., old[4]]
        // i.e. newOrder[0] should equal oldOrder[5]
        expect(newOrder[0]).toBe(oldOrder[5]);

        const update = Y.encodeStateAsUpdate(bridge.yDoc, beforeSV);

        // Budget: 20-node rotation → ~N id references, not a whole-glyph snapshot.
        // A whole-glyph snapshot would be thousands of bytes.
        expect(update.length).toBeLessThan(600);

        // Verify the Y.Doc state is correct — nodeOrder should be rotated
        const layerMap = bridge.fontMap
            .get('glyphs')
            .get('A')
            .get('layers')
            .get('layer-1');
        const shapesById = layerMap.get('shapesById');
        let shapeMap = null;
        shapesById.forEach((v) => {
            shapeMap = v;
        });
        const nodeOrder = shapeMap.get('nodeOrder');
        expect(nodeOrder.length).toBe(20);

        // The first id in nodeOrder should be the id that was at index 5
        const beforeIds = fontJson.glyphs[0].layers[0].shapes[0].nodes.map(
            (n) => n.id
        );
        // Debug: check what nodeOrder actually contains vs what we expect
        const afterIds = nodeOrder.toArray();
        // Check if the newOrder from the change-log matches afterIds
        expect(afterIds).toEqual(newOrder);
    });

    test('reverse direction on 20-node contour produces < 800 byte Yjs delta', () => {
        const fontJson = makeTestFont(20);
        ensureStableIds(fontJson);

        const bridge = new PatchSyncEngine('integration-reverse');
        bridge.initFromJson(fontJson);
        setupBridge(bridge);

        const font = new Font(fontJson);
        const path = font.glyphs[0].layers[0].paths[0];

        const beforeSV = Y.encodeStateVector(bridge.yDoc);

        path._reverseDirection();

        const update = Y.encodeStateAsUpdate(bridge.yDoc, beforeSV);

        // Budget: 20-node reverse → order-only diff, ~38 delete+insert ops.
        // Still orders of magnitude smaller than a whole-glyph snapshot.
        // (May be 0 if the reverse produces the same order for this test font.)
        expect(update.length).toBeLessThan(800);
    });

    test('node coordinate drag produces < 200 byte Yjs delta', () => {
        const fontJson = makeTestFont(10);
        ensureStableIds(fontJson);

        const bridge = new PatchSyncEngine('integration-node-drag');
        bridge.initFromJson(fontJson);
        setupBridge(bridge);

        const font = new Font(fontJson);
        const path = font.glyphs[0].layers[0].paths[0];
        const nodes = path.nodes;
        const oldX = nodes[0].x;

        const beforeSV = Y.encodeStateVector(bridge.yDoc);

        nodes[0].x = oldX + 50;

        const update = Y.encodeStateAsUpdate(bridge.yDoc, beforeSV);

        // A single leaf Set should be very small
        expect(update.length).toBeLessThan(200);
    });
});
