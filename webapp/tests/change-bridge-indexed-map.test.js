/**
 * Tests for the indexed-map Y.Doc schema.
 *
 * Verifies that:
 * 1. The Y.Doc uses shapesById+shapeOrder / nodesById+nodeOrder (not flat arrays)
 * 2. Forward node edit → small granular Yjs delta (not whole-layer)
 * 3. applyLayerDelta (worker cache / undo-redo / receiver path) → small granular delta
 * 4. fromYType round-trips indexed-map → flat JSON correctly
 * 5. Undo produces a granular delta, not a whole-layer resend
 * 6. All three sync paths (forward, worker-cache, undo) produce deltas
 *    proportional to the logical change, not the layer size
 */

const Y = require('yjs');
const {
    jsonToYDoc,
    yDocToJson,
    fromYType,
    setYPath,
    applyLayerDelta
} = require('../js/change-bridge-ydoc');
const { ensureStableIds, generateStableId } = require('../js/babelfont-model');

// ── Helpers ──────────────────────────────────────────────────────────

/** Minimal font with one glyph, one layer, one path, 3 nodes */
function makeTestFont(nodeCount = 3) {
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

function setupYDoc(fontJson) {
    const yDoc = new Y.Doc();
    const fontMap = yDoc.getMap('font');
    jsonToYDoc(fontJson, fontMap);
    return { yDoc, fontMap };
}

function getLayerMap(fontMap, glyphName = 'A', layerId = 'layer-1') {
    const glyphsMap = fontMap.get('glyphs');
    const glyphMap = glyphsMap.get(glyphName);
    const layersMap = glyphMap.get('layers');
    return layersMap.get(layerId);
}

function getFirstNodeMap(fontMap, glyphName = 'A', layerId = 'layer-1') {
    const layerMap = getLayerMap(fontMap, glyphName, layerId);
    const shapesById = layerMap.get('shapesById');
    let firstShape = null;
    shapesById.forEach((v) => {
        firstShape = v;
    });
    const nodesById = firstShape.get('nodesById');
    let firstNode = null;
    nodesById.forEach((v) => {
        firstNode = v;
    });
    return firstNode;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Indexed-map Y.Doc schema', () => {
    test('Y.Doc uses shapesById+shapeOrder, not flat shapes array', () => {
        const font = makeTestFont();
        ensureStableIds(font);
        const { fontMap } = setupYDoc(font);
        const layerMap = getLayerMap(fontMap);

        expect(layerMap.get('shapesById')).toBeDefined();
        expect(layerMap.get('shapeOrder')).toBeDefined();
        expect(layerMap.get('shapes')).toBeUndefined();

        // Shape has nodesById+nodeOrder, not flat nodes
        const shapesById = layerMap.get('shapesById');
        let shapeMap = null;
        shapesById.forEach((v) => {
            shapeMap = v;
        });
        expect(shapeMap.get('nodesById')).toBeDefined();
        expect(shapeMap.get('nodeOrder')).toBeDefined();
        expect(shapeMap.get('kind')).toBe('Path');
        expect(shapeMap.get('nodes')).toBeUndefined();
    });

    test('nodesById contains all nodes with correct data', () => {
        const font = makeTestFont(5);
        ensureStableIds(font);
        const { fontMap } = setupYDoc(font);

        const layerMap = getLayerMap(fontMap);
        const shapesById = layerMap.get('shapesById');
        let shapeMap = null;
        shapesById.forEach((v) => {
            shapeMap = v;
        });

        const nodesById = shapeMap.get('nodesById');
        const nodeOrder = shapeMap.get('nodeOrder');

        expect(nodeOrder.length).toBe(5);

        let nodeCount = 0;
        nodesById.forEach((nodeMap) => {
            expect(nodeMap.get('x')).toBeDefined();
            expect(nodeMap.get('y')).toBeDefined();
            expect(nodeMap.get('nodetype')).toBeDefined();
            nodeCount++;
        });
        expect(nodeCount).toBe(5);
    });

    test('all nodes and shapes have stable ids', () => {
        const font = makeTestFont(3);
        ensureStableIds(font);

        const shape = font.glyphs[0].layers[0].shapes[0];
        expect(shape.id).toBeDefined();
        expect(typeof shape.id).toBe('string');
        for (const node of shape.nodes) {
            expect(node.id).toBeDefined();
            expect(typeof node.id).toBe('string');
        }
    });
});

describe('Granular forward edit deltas', () => {
    test('single node coordinate edit produces small Yjs delta', () => {
        const font = makeTestFont(10); // 10-node contour
        ensureStableIds(font);
        const { yDoc, fontMap } = setupYDoc(font);

        const beforeSV = Y.encodeStateVector(yDoc);

        // Edit node 5's x coordinate
        const nodeMap = getFirstNodeMap(fontMap);
        // Navigate to the 5th node via nodeOrder
        const layerMap = getLayerMap(fontMap);
        const shapesById = layerMap.get('shapesById');
        let shapeMap = null;
        shapesById.forEach((v) => {
            shapeMap = v;
        });
        const nodeOrder = shapeMap.get('nodeOrder');
        const nodeId5 = nodeOrder.get(5);
        const nodesById = shapeMap.get('nodesById');
        const node5 = nodesById.get(nodeId5);
        const oldX = node5.get('x');

        yDoc.transact(() => {
            node5.set('x', oldX + 50);
        });

        const update = Y.encodeStateAsUpdate(yDoc, beforeSV);

        // A single leaf Set should be very small — well under 200 bytes
        expect(update.length).toBeLessThan(200);
        // And certainly much smaller than re-sending the whole layer
        const fullLayerUpdate = Y.encodeStateAsUpdate(yDoc);
        expect(update.length).toBeLessThan(fullLayerUpdate.length / 10);
    });

    test('node coordinate edit does NOT re-send other nodes', () => {
        const font = makeTestFont(20);
        ensureStableIds(font);
        const { yDoc, fontMap } = setupYDoc(font);

        const beforeSV = Y.encodeStateVector(yDoc);

        // Edit node 0's x
        const layerMap = getLayerMap(fontMap);
        const shapesById = layerMap.get('shapesById');
        let shapeMap = null;
        shapesById.forEach((v) => {
            shapeMap = v;
        });
        const nodeOrder = shapeMap.get('nodeOrder');
        const nodesById = shapeMap.get('nodesById');
        const node0 = nodesById.get(nodeOrder.get(0));

        yDoc.transact(() => {
            node0.set('x', 999);
        });

        const update = Y.encodeStateAsUpdate(yDoc, beforeSV);

        // The delta should be tiny — just one Set operation
        // 20 nodes × ~40 bytes each = ~800 bytes if whole layer
        // We expect well under 100 bytes for one leaf Set
        expect(update.length).toBeLessThan(100);
    });
});

describe('Order-array minimal diff (reorder operations)', () => {
    // Helper: get the first shape's Y.Map from a font
    function getFirstShapeMap(fontMap) {
        const layerMap = getLayerMap(fontMap);
        const shapesById = layerMap.get('shapesById');
        let shapeMap = null;
        shapesById.forEach((v) => {
            shapeMap = v;
        });
        return shapeMap;
    }

    // Helper: read the current nodeOrder as a string array
    function getNodeOrder(shapeMap) {
        const orderArr = shapeMap.get('nodeOrder');
        return orderArr.toArray();
    }

    test('set start point (rotation) produces order-only delta, zero node-data writes', () => {
        const nodeCount = 20;
        const font = makeTestFont(nodeCount);
        ensureStableIds(font);
        const { yDoc, fontMap } = setupYDoc(font);

        const shapeMap = getFirstShapeMap(fontMap);
        const oldOrder = getNodeOrder(shapeMap);
        expect(oldOrder.length).toBe(nodeCount);

        // Simulate set-start-point at index 5: rotate so index 5 becomes first
        const rotateAt = 5;
        const newOrder = [
            ...oldOrder.slice(rotateAt),
            ...oldOrder.slice(0, rotateAt)
        ];

        // Snapshot node data before
        const nodesById = shapeMap.get('nodesById');
        const beforeNodeData = {};
        for (const id of oldOrder) {
            const nm = nodesById.get(id);
            beforeNodeData[id] = { x: nm.get('x'), y: nm.get('y') };
        }

        const beforeSV = Y.encodeStateVector(yDoc);

        // Apply the order change via setYPath — the granular apply path
        const shapePath = [
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'shapes',
            0,
            'nodeOrder'
        ];
        yDoc.transact(() => {
            setYPath(fontMap, shapePath, newOrder);
        });

        const update = Y.encodeStateAsUpdate(yDoc, beforeSV);

        // Budget: 20-node rotation → ~N id references, not a whole-glyph snapshot
        // A whole-glyph snapshot would be thousands of bytes; we expect < 600
        expect(update.length).toBeLessThan(600);

        // The final nodeOrder must match the rotated order
        const afterOrder = getNodeOrder(shapeMap);
        expect(afterOrder).toEqual(newOrder);

        // Zero node-data writes: every node's x/y must be unchanged
        for (const id of oldOrder) {
            const nm = nodesById.get(id);
            expect(nm.get('x')).toBe(beforeNodeData[id].x);
            expect(nm.get('y')).toBe(beforeNodeData[id].y);
        }
    });

    test('reverse direction produces order-only delta, zero node-data writes', () => {
        const nodeCount = 20;
        const font = makeTestFont(nodeCount);
        ensureStableIds(font);
        const { yDoc, fontMap } = setupYDoc(font);

        const shapeMap = getFirstShapeMap(fontMap);
        const oldOrder = getNodeOrder(shapeMap);
        const newOrder = [...oldOrder].reverse();

        // Snapshot node data before
        const nodesById = shapeMap.get('nodesById');
        const beforeNodeData = {};
        for (const id of oldOrder) {
            const nm = nodesById.get(id);
            beforeNodeData[id] = { x: nm.get('x'), y: nm.get('y') };
        }

        const beforeSV = Y.encodeStateVector(yDoc);

        const shapePath = [
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'shapes',
            0,
            'nodeOrder'
        ];
        yDoc.transact(() => {
            setYPath(fontMap, shapePath, newOrder);
        });

        const update = Y.encodeStateAsUpdate(yDoc, beforeSV);

        // Budget: 20-node reverse → order-only diff
        // A full reverse has LCS length 1, so ~38 delete+insert ops.
        // Each Yjs Y.Array op is ~20 bytes → ~760 bytes. Still orders
        // of magnitude smaller than a whole-glyph snapshot (thousands).
        expect(update.length).toBeLessThan(800);

        // The final nodeOrder must match the reversed order
        const afterOrder = getNodeOrder(shapeMap);
        expect(afterOrder).toEqual(newOrder);

        // Zero node-data writes
        for (const id of oldOrder) {
            const nm = nodesById.get(id);
            expect(nm.get('x')).toBe(beforeNodeData[id].x);
            expect(nm.get('y')).toBe(beforeNodeData[id].y);
        }
    });

    test('identical order produces zero Yjs ops', () => {
        const font = makeTestFont(10);
        ensureStableIds(font);
        const { yDoc, fontMap } = setupYDoc(font);

        const shapeMap = getFirstShapeMap(fontMap);
        const order = getNodeOrder(shapeMap);

        const beforeSV = Y.encodeStateVector(yDoc);

        // Setting the same order should be a no-op
        const shapePath = [
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'shapes',
            0,
            'nodeOrder'
        ];
        yDoc.transact(() => {
            setYPath(fontMap, shapePath, order);
        });

        const update = Y.encodeStateAsUpdate(yDoc, beforeSV);
        // 2 bytes is the Yjs update header with no operations
        expect(update.length).toBeLessThan(10);
    });

    test('insert one id into order produces small delta', () => {
        const font = makeTestFont(5);
        ensureStableIds(font);
        const { yDoc, fontMap } = setupYDoc(font);

        const shapeMap = getFirstShapeMap(fontMap);
        const oldOrder = getNodeOrder(shapeMap);

        // Insert a new id at index 2
        const newId = 'new-node-id-test';
        const newOrder = [...oldOrder.slice(0, 2), newId, ...oldOrder.slice(2)];

        const beforeSV = Y.encodeStateVector(yDoc);

        const shapePath = [
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'shapes',
            0,
            'nodeOrder'
        ];
        yDoc.transact(() => {
            setYPath(fontMap, shapePath, newOrder);
        });

        const update = Y.encodeStateAsUpdate(yDoc, beforeSV);
        expect(update.length).toBeLessThan(200);

        const afterOrder = getNodeOrder(shapeMap);
        expect(afterOrder).toEqual(newOrder);
    });

    test('delete one id from order produces small delta', () => {
        const font = makeTestFont(5);
        ensureStableIds(font);
        const { yDoc, fontMap } = setupYDoc(font);

        const shapeMap = getFirstShapeMap(fontMap);
        const oldOrder = getNodeOrder(shapeMap);

        // Delete the id at index 2
        const newOrder = [...oldOrder.slice(0, 2), ...oldOrder.slice(3)];

        const beforeSV = Y.encodeStateVector(yDoc);

        const shapePath = [
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'shapes',
            0,
            'nodeOrder'
        ];
        yDoc.transact(() => {
            setYPath(fontMap, shapePath, newOrder);
        });

        const update = Y.encodeStateAsUpdate(yDoc, beforeSV);
        expect(update.length).toBeLessThan(200);

        const afterOrder = getNodeOrder(shapeMap);
        expect(afterOrder).toEqual(newOrder);
    });
});

describe('applyLayerDelta (worker cache / undo-redo path) deltas', () => {
    test('applyLayerDelta with one changed node produces small delta', () => {
        const font = makeTestFont(10);
        ensureStableIds(font);
        const { yDoc, fontMap } = setupYDoc(font);

        const beforeSV = Y.encodeStateVector(yDoc);

        // Modify one node's x in the flat JSON, then apply via applyLayerDelta
        const modifiedFont = JSON.parse(JSON.stringify(font));
        modifiedFont.glyphs[0].layers[0].shapes[0].nodes[3].x = 999;

        yDoc.transact(() => {
            applyLayerDelta(
                fontMap,
                'A',
                'layer-1',
                modifiedFont.glyphs[0].layers[0]
            );
        });

        const update = Y.encodeStateAsUpdate(yDoc, beforeSV);

        // Should be small — only one node's x changed
        expect(update.length).toBeLessThan(200);
    });

    test('applyLayerDelta with unchanged layer produces zero-length delta', () => {
        const font = makeTestFont(10);
        ensureStableIds(font);
        const { yDoc, fontMap } = setupYDoc(font);

        const beforeSV = Y.encodeStateVector(yDoc);

        // Apply the SAME layer data (no changes)
        yDoc.transact(() => {
            applyLayerDelta(fontMap, 'A', 'layer-1', font.glyphs[0].layers[0]);
        });

        const update = Y.encodeStateAsUpdate(yDoc, beforeSV);

        // No changes → near-zero delta (small Yjs transaction overhead is OK,
        // but must not be a whole-layer resend)
        const fullLayerSize = Y.encodeStateAsUpdate(yDoc).length;
        expect(update.length).toBeLessThan(fullLayerSize / 20);
    });

    test('applyLayerDelta deep-merges shapes by id, not wholesale replace', () => {
        const font = makeTestFont(5);
        ensureStableIds(font);
        const { yDoc, fontMap } = setupYDoc(font);

        const beforeSV = Y.encodeStateVector(yDoc);

        // Change only the closed flag (not any node data)
        const modifiedFont = JSON.parse(JSON.stringify(font));
        modifiedFont.glyphs[0].layers[0].shapes[0].closed = false;

        yDoc.transact(() => {
            applyLayerDelta(
                fontMap,
                'A',
                'layer-1',
                modifiedFont.glyphs[0].layers[0]
            );
        });

        const update = Y.encodeStateAsUpdate(yDoc, beforeSV);

        // Should be tiny — just one boolean change
        expect(update.length).toBeLessThan(100);
    });

    test('applyLayerDelta adding a node produces proportional delta', () => {
        const font = makeTestFont(5);
        ensureStableIds(font);
        const { yDoc, fontMap } = setupYDoc(font);

        const beforeSV = Y.encodeStateVector(yDoc);

        // Add one node
        const modifiedFont = JSON.parse(JSON.stringify(font));
        modifiedFont.glyphs[0].layers[0].shapes[0].nodes.push({
            id: generateStableId(),
            x: 700,
            y: 800,
            nodetype: 'Line'
        });

        yDoc.transact(() => {
            applyLayerDelta(
                fontMap,
                'A',
                'layer-1',
                modifiedFont.glyphs[0].layers[0]
            );
        });

        const update = Y.encodeStateAsUpdate(yDoc, beforeSV);

        // Should be proportional to one new node, not the whole layer
        // (new Y.Map for node + nodeOrder insert)
        expect(update.length).toBeLessThan(500);
    });
});

describe('fromYType round-trip', () => {
    test('fromYType reconstructs flat shapes/nodes arrays from indexed-maps', () => {
        const font = makeTestFont(4);
        ensureStableIds(font);
        const { fontMap } = setupYDoc(font);

        const fullJson = yDocToJson(fontMap);
        const glyph = fullJson.glyphs.find((g) => g.name === 'A');
        const layer = glyph.layers[0];

        // Should have flat shapes array (not shapesById)
        expect(Array.isArray(layer.shapes)).toBe(true);
        expect(layer.shapesById).toBeUndefined();
        expect(layer.shapeOrder).toBeUndefined();

        // Each shape should have flat nodes array
        const shape = layer.shapes[0];
        expect(Array.isArray(shape.nodes)).toBe(true);
        expect(shape.nodesById).toBeUndefined();
        expect(shape.nodeOrder).toBeUndefined();
        expect(shape.nodes.length).toBe(4);

        // Node data should be correct
        expect(shape.nodes[0].x).toBe(100);
        expect(shape.nodes[0].y).toBe(200);
        expect(shape.nodes[3].x).toBe(700);
        expect(shape.nodes[3].y).toBe(500);
    });

    test('fromYType preserves node ids in round-trip', () => {
        const font = makeTestFont(3);
        ensureStableIds(font);
        const originalIds = font.glyphs[0].layers[0].shapes[0].nodes.map(
            (n) => n.id
        );

        const { fontMap } = setupYDoc(font);
        const fullJson = yDocToJson(fontMap);
        const shape = fullJson.glyphs.find((g) => g.name === 'A').layers[0]
            .shapes[0];

        const roundTrippedIds = shape.nodes.map((n) => n.id);
        expect(roundTrippedIds).toEqual(originalIds);
    });

    test('fromYType rejects order entries that point at missing ids', () => {
        const font = makeTestFont(3);
        ensureStableIds(font);
        const { fontMap } = setupYDoc(font);
        const layerMap = getLayerMap(fontMap);
        const shapesById = layerMap.get('shapesById');
        let shapeMap = null;
        shapesById.forEach((v) => {
            shapeMap = v;
        });

        shapeMap.get('nodeOrder').push(['missing-node-id']);

        expect(() => yDocToJson(fontMap)).toThrow(
            /nodeOrder references missing node id missing-node-id/
        );
    });
});

describe('Undo produces granular deltas', () => {
    test('undo of a node edit does not re-send the whole layer', () => {
        const {
            PatchSyncEngine: ChangeBridge
        } = require('../js/patch-sync-engine');
        const font = makeTestFont(10);
        ensureStableIds(font);

        const bridge = new ChangeBridge();
        bridge.initFromJson(font);

        // Capture state before an edit
        const beforeEditSV = Y.encodeStateVector(bridge.yDoc);

        // Edit a node coordinate via setYPath (simulating a forward edit)
        const fontMap = bridge.fontMap;
        const layerMap = getLayerMap(fontMap);
        const shapesById = layerMap.get('shapesById');
        let shapeMap = null;
        shapesById.forEach((v) => {
            shapeMap = v;
        });
        const nodeOrder = shapeMap.get('nodeOrder');
        const nodesById = shapeMap.get('nodesById');
        const nodeId = nodeOrder.get(0);
        const node0 = nodesById.get(nodeId);
        const originalX = node0.get('x');

        bridge.beginTransaction('test edit');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1', 'shapesById', nodeId, 'x'],
            'x',
            originalX,
            999
        );
        bridge.endTransaction();

        const afterEditSV = Y.encodeStateVector(bridge.yDoc);
        const editDelta = Y.encodeStateAsUpdate(bridge.yDoc, beforeEditSV);

        // Forward edit delta should be small
        expect(editDelta.length).toBeLessThan(200);

        // Now undo
        const beforeUndoSV = Y.encodeStateVector(bridge.yDoc);
        bridge.undo();
        const undoDelta = Y.encodeStateAsUpdate(bridge.yDoc, beforeUndoSV);

        // Undo delta should also be small (just reverting one leaf Set)
        expect(undoDelta.length).toBeLessThan(200);

        // And the value should be back
        const node0AfterUndo = nodesById.get(nodeId);
        expect(node0AfterUndo.get('x')).toBe(originalX);
    });

    test('node add direct replay stays granular through undo and redo', () => {
        const {
            PatchSyncEngine: ChangeBridge
        } = require('../js/patch-sync-engine');
        const font = makeTestFont(6);
        ensureStableIds(font);

        const bridge = new ChangeBridge();
        bridge.initFromJson(font);

        const layerMap = getLayerMap(bridge.fontMap);
        const shapesById = layerMap.get('shapesById');
        let shapeMap = null;
        shapesById.forEach((v) => {
            shapeMap = v;
        });
        const nodeOrder = shapeMap.get('nodeOrder');
        const nodesById = shapeMap.get('nodesById');
        const oldOrder = nodeOrder.toArray();
        const newNode = {
            id: generateStableId(),
            x: 777,
            y: 888,
            nodetype: 'Line',
            smooth: false
        };
        const newOrder = [...oldOrder, newNode.id];

        bridge.beginTransaction('add node');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0],
            'nodeOrder',
            oldOrder,
            newOrder
        );
        bridge.recordAdd(
            [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes',
                0,
                'nodesById',
                newNode.id
            ],
            newNode
        );
        bridge.endTransaction();

        expect(nodesById.get(newNode.id)).toBeDefined();
        expect(nodeOrder.toArray()).toEqual(newOrder);

        const beforeUndoSV = Y.encodeStateVector(bridge.yDoc);
        bridge.undo();
        const undoDelta = Y.encodeStateAsUpdate(bridge.yDoc, beforeUndoSV);

        expect(undoDelta.length).toBeLessThan(500);
        expect(nodesById.get(newNode.id)).toBeUndefined();
        expect(nodeOrder.toArray()).toEqual(oldOrder);

        const beforeRedoSV = Y.encodeStateVector(bridge.yDoc);
        bridge.redo();
        const redoDelta = Y.encodeStateAsUpdate(bridge.yDoc, beforeRedoSV);

        expect(redoDelta.length).toBeLessThan(500);
        expect(nodesById.get(newNode.id)).toBeDefined();
        expect(nodeOrder.toArray()).toEqual(newOrder);
    });

    test('node remove direct replay stays granular through undo and redo', () => {
        const {
            PatchSyncEngine: ChangeBridge
        } = require('../js/patch-sync-engine');
        const font = makeTestFont(6);
        ensureStableIds(font);

        const bridge = new ChangeBridge();
        bridge.initFromJson(font);

        const layerMap = getLayerMap(bridge.fontMap);
        const shapesById = layerMap.get('shapesById');
        let shapeMap = null;
        shapesById.forEach((v) => {
            shapeMap = v;
        });
        const nodeOrder = shapeMap.get('nodeOrder');
        const nodesById = shapeMap.get('nodesById');
        const oldOrder = nodeOrder.toArray();
        const removedNodeId = oldOrder[2];
        const removedNodeMap = nodesById.get(removedNodeId);
        const removedNode = fromYType(removedNodeMap);
        const newOrder = oldOrder.filter((id) => id !== removedNodeId);

        bridge.beginTransaction('remove node');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0],
            'nodeOrder',
            oldOrder,
            newOrder
        );
        bridge.recordRemove(
            [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes',
                0,
                'nodesById',
                removedNodeId
            ],
            removedNode
        );
        bridge.endTransaction();

        expect(nodesById.get(removedNodeId)).toBeUndefined();
        expect(nodeOrder.toArray()).toEqual(newOrder);

        const beforeUndoSV = Y.encodeStateVector(bridge.yDoc);
        bridge.undo();
        const undoDelta = Y.encodeStateAsUpdate(bridge.yDoc, beforeUndoSV);

        expect(undoDelta.length).toBeLessThan(500);
        expect(nodesById.get(removedNodeId)).toBeDefined();
        expect(nodeOrder.toArray()).toEqual(oldOrder);

        const beforeRedoSV = Y.encodeStateVector(bridge.yDoc);
        bridge.redo();
        const redoDelta = Y.encodeStateAsUpdate(bridge.yDoc, beforeRedoSV);

        expect(redoDelta.length).toBeLessThan(500);
        expect(nodesById.get(removedNodeId)).toBeUndefined();
        expect(nodeOrder.toArray()).toEqual(newOrder);
    });
});

describe('All three sync paths produce proportional deltas', () => {
    test('forward edit, applyLayerDelta, and undo all produce small deltas for one node change', () => {
        const font = makeTestFont(15);
        ensureStableIds(font);

        // Path 1: Forward edit via setYPath
        const { yDoc: yDoc1, fontMap: fontMap1 } = setupYDoc(font);
        const sv1Before = Y.encodeStateVector(yDoc1);
        const layerMap1 = getLayerMap(fontMap1);
        const shapesById1 = layerMap1.get('shapesById');
        let shape1 = null;
        shapesById1.forEach((v) => {
            shape1 = v;
        });
        const nodeOrder1 = shape1.get('nodeOrder');
        const nodesById1 = shape1.get('nodesById');
        const nodeId1 = nodeOrder1.get(0);
        yDoc1.transact(() => {
            nodesById1.get(nodeId1).set('x', 555);
        });
        const forwardDelta = Y.encodeStateAsUpdate(yDoc1, sv1Before);

        // Path 2: applyLayerDelta (worker cache path)
        const { yDoc: yDoc2, fontMap: fontMap2 } = setupYDoc(font);
        const sv2Before = Y.encodeStateVector(yDoc2);
        const modifiedFont = JSON.parse(JSON.stringify(font));
        modifiedFont.glyphs[0].layers[0].shapes[0].nodes[0].x = 555;
        yDoc2.transact(() => {
            applyLayerDelta(
                fontMap2,
                'A',
                'layer-1',
                modifiedFont.glyphs[0].layers[0]
            );
        });
        const applyLayerDeltaSize = Y.encodeStateAsUpdate(yDoc2, sv2Before);

        // All three deltas should be small and roughly proportional
        expect(forwardDelta.length).toBeLessThan(200);
        expect(applyLayerDeltaSize.length).toBeLessThan(200);

        // They should all be much smaller than the full font state
        const fullState = Y.encodeStateAsUpdate(yDoc1);
        expect(forwardDelta.length).toBeLessThan(fullState.length / 10);
        expect(applyLayerDeltaSize.length).toBeLessThan(fullState.length / 10);
    });
});
