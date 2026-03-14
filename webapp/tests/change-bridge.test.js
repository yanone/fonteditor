/**
 * Comprehensive tests for ChangeBridge, Y.Doc sync, and WindowSync.
 *
 * Verifies that every property setter in the babelfont model correctly
 * records a change via the ChangeBridge, that the Y.Doc reflects the
 * change at the right path, and that undo/redo, transactions, and
 * cross-window sync all work as expected.
 */

const Y = require('yjs');
const { ChangeBridge } = require('../js/change-bridge');
const { WindowSync } = require('../js/window-sync');
const {
    jsonToYDoc,
    yDocToJson,
    getYPath,
    setYPath,
    deleteYPath,
    setJsonPath,
    deleteJsonPath,
    getJsonPath
} = require('../js/change-bridge-ydoc');
const {
    createLogEntry,
    resetLogCounter,
    deriveObjectInfo
} = require('../js/change-log');
const { Font } = require('../js/babelfont-model');

// ── Helpers ──────────────────────────────────────────────────────────

/** Minimal babelfont JSON fixture for testing */
function makeMinimalFont() {
    return {
        upm: 1000,
        version: [1, 0],
        note: '',
        date: '2024-01-01',
        names: { familyName: 'TestFont' },
        custom_ot_values: [],
        variation_sequences: {},
        features: '',
        first_kern_groups: {},
        second_kern_groups: {},
        format_specific: {},
        source: '',
        axes: [
            {
                name: 'Weight',
                tag: 'wght',
                id: 'weight-axis',
                min: 100,
                max: 900,
                default: 400,
                map: [],
                hidden: false,
                values: [],
                formatspecific: {}
            }
        ],
        masters: [
            {
                name: 'Regular',
                id: 'master-regular',
                location: { wght: 400 },
                metrics: {},
                kerning: {},
                custom_ot_values: [],
                format_specific: {}
            }
        ],
        instances: [
            {
                id: 'instance-regular',
                name: 'Regular',
                location: { wght: 400 },
                custom_names: {},
                variable: false,
                linked_style: '',
                format_specific: {}
            }
        ],
        glyphs: [
            {
                name: 'A',
                production_name: 'A',
                category: 'Base',
                codepoints: [65],
                exported: true,
                direction: 'LTR',
                formatspecific: {},
                layers: [
                    {
                        id: 'layer-1',
                        name: 'Regular',
                        width: 600,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-regular'
                        },
                        smart_component_location: {},
                        color: null,
                        layer_index: 0,
                        is_background: false,
                        background_layer_id: null,
                        location: {},
                        format_specific: {},
                        shapes: [
                            {
                                nodes: [
                                    {
                                        x: 100,
                                        y: 0,
                                        nodetype: 'line',
                                        smooth: false
                                    },
                                    {
                                        x: 300,
                                        y: 700,
                                        nodetype: 'line',
                                        smooth: false
                                    },
                                    {
                                        x: 500,
                                        y: 0,
                                        nodetype: 'line',
                                        smooth: false
                                    }
                                ],
                                closed: true
                            }
                        ],
                        anchors: [
                            {
                                x: 300,
                                y: 750,
                                name: 'top',
                                format_specific: {}
                            }
                        ],
                        guides: [
                            {
                                pos: 700,
                                name: 'cap-height',
                                color: null,
                                format_specific: {}
                            }
                        ]
                    }
                ]
            },
            {
                name: 'B',
                production_name: 'B',
                category: 'Base',
                codepoints: [66],
                exported: true,
                direction: 'LTR',
                formatspecific: {},
                layers: [
                    {
                        id: 'layer-2',
                        name: 'Regular',
                        width: 650,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-regular'
                        },
                        smart_component_location: {},
                        color: null,
                        layer_index: 0,
                        is_background: false,
                        background_layer_id: null,
                        location: {},
                        format_specific: {},
                        shapes: [
                            {
                                nodes: [
                                    {
                                        x: 80,
                                        y: 0,
                                        nodetype: 'line',
                                        smooth: false
                                    },
                                    {
                                        x: 80,
                                        y: 700,
                                        nodetype: 'line',
                                        smooth: false
                                    }
                                ],
                                closed: true
                            }
                        ],
                        anchors: [],
                        guides: []
                    }
                ]
            }
        ]
    };
}

/**
 * Create a ChangeBridge initialized with a minimal font,
 * plus a Font wrapper for model-level testing.
 */
function createTestBridge(windowId) {
    const fontJson = makeMinimalFont();
    const bridge = new ChangeBridge(windowId);
    bridge.initFromJson(fontJson);
    // Wrap in Font model
    const font = Font.fromData(fontJson);
    // Install bridge on window for model setters to find
    window.changeBridge = bridge;
    return { bridge, font, fontJson };
}

function flushTimers() {
    jest.runAllTimers();
}

// ── Test setup ───────────────────────────────────────────────────────

beforeEach(() => {
    jest.useFakeTimers();
    resetLogCounter();
    window.changeBridge = undefined;
    // Reset BroadcastChannel state
    if (globalThis.__broadcastChannels) {
        globalThis.__broadcastChannels.clear();
    }
});

afterEach(() => {
    if (window.changeBridge) {
        window.changeBridge.destroy();
        window.changeBridge = undefined;
    }
    jest.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────
// 1. change-bridge-ydoc.ts — Y.Doc ↔ JSON round-trip
// ─────────────────────────────────────────────────────────────────────

describe('change-bridge-ydoc', () => {
    test('jsonToYDoc + yDocToJson round-trips a simple font', () => {
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');
        const json = makeMinimalFont();
        doc.transact(() => jsonToYDoc(json, fontMap));

        const result = yDocToJson(fontMap);
        // Glyphs: the Y.Doc stores them by name in a Map, so the order
        // in the output array may differ. Compare as sets.
        expect(result.upm).toBe(1000);
        expect(result.version).toEqual([1, 0]);
        expect(result.axes).toHaveLength(1);
        expect(result.masters).toHaveLength(1);
        expect(result.instances).toHaveLength(1);
        const glyphs = result.glyphs;
        expect(glyphs).toHaveLength(2);
        const glyphNames = glyphs.map((g) => g.name).sort();
        expect(glyphNames).toEqual(['A', 'B']);
    });

    test('glyphs stored as Y.Map keyed by name', () => {
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');
        const json = makeMinimalFont();
        doc.transact(() => jsonToYDoc(json, fontMap));

        const glyphsMap = fontMap.get('glyphs');
        expect(glyphsMap).toBeInstanceOf(Y.Map);
        expect(glyphsMap.get('A')).toBeInstanceOf(Y.Map);
        expect(glyphsMap.get('B')).toBeInstanceOf(Y.Map);
    });

    test('layers stored as Y.Map keyed by id', () => {
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');
        const json = makeMinimalFont();
        doc.transact(() => jsonToYDoc(json, fontMap));

        const glyphA = fontMap.get('glyphs').get('A');
        const layersMap = glyphA.get('layers');
        expect(layersMap).toBeInstanceOf(Y.Map);
        expect(layersMap.get('layer-1')).toBeInstanceOf(Y.Map);
    });

    test('deep format_specific fields round-trip', () => {
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');
        const json = makeMinimalFont();

        json.format_specific = {
            fontMeta: {
                provenance: {
                    source: 'glyphs',
                    flags: [1, 2, 3]
                }
            }
        };
        json.masters[0].format_specific = {
            masterMeta: {
                stems: { h: 80, v: 90 }
            }
        };
        json.glyphs[0].layers[0].format_specific = {
            layerMeta: {
                nested: {
                    foo: 'bar',
                    arr: [{ k: 1 }, { k: 2 }]
                }
            }
        };
        json.glyphs[0].layers[0].shapes[0].format_specific = {
            shapeMeta: {
                isSpecial: true
            }
        };

        doc.transact(() => jsonToYDoc(json, fontMap));
        const result = yDocToJson(fontMap);

        expect(result.format_specific).toEqual(json.format_specific);
        expect(result.masters[0].format_specific).toEqual(
            json.masters[0].format_specific
        );
        expect(result.glyphs[0].layers[0].format_specific).toEqual(
            json.glyphs[0].layers[0].format_specific
        );
        expect(result.glyphs[0].layers[0].shapes[0].format_specific).toEqual(
            json.glyphs[0].layers[0].shapes[0].format_specific
        );
    });

    test('getYPath reads nested values', () => {
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');
        const json = makeMinimalFont();
        doc.transact(() => jsonToYDoc(json, fontMap));

        expect(getYPath(fontMap, ['upm'])).toBe(1000);
        const glyphA = getYPath(fontMap, ['glyphs', 'A']);
        expect(glyphA).toBeInstanceOf(Y.Map);
        expect(getYPath(fontMap, ['glyphs', 'A', 'name'])).toBe('A');
    });

    test('setYPath writes nested values', () => {
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');
        const json = makeMinimalFont();
        doc.transact(() => jsonToYDoc(json, fontMap));

        doc.transact(() => {
            setYPath(fontMap, ['upm'], 2000);
        });
        expect(getYPath(fontMap, ['upm'])).toBe(2000);

        doc.transact(() => {
            setYPath(fontMap, ['glyphs', 'A', 'production_name'], 'uni0041');
        });
        expect(getYPath(fontMap, ['glyphs', 'A', 'production_name'])).toBe(
            'uni0041'
        );
    });

    test('deleteYPath removes keyed entries', () => {
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');
        const json = makeMinimalFont();
        doc.transact(() => jsonToYDoc(json, fontMap));

        doc.transact(() => {
            deleteYPath(fontMap, ['glyphs', 'B']);
        });
        expect(getYPath(fontMap, ['glyphs', 'B'])).toBeUndefined();
        expect(getYPath(fontMap, ['glyphs', 'A'])).toBeInstanceOf(Y.Map);
    });

    test('setJsonPath / getJsonPath / deleteJsonPath work on plain objects', () => {
        const obj = { a: { b: [1, 2, 3] } };
        expect(getJsonPath(obj, ['a', 'b', 1])).toBe(2);

        setJsonPath(obj, ['a', 'b', 1], 99);
        expect(obj.a.b[1]).toBe(99);

        deleteJsonPath(obj, ['a', 'b', 1]);
        expect(obj.a.b).toEqual([1, 3]);
    });
});

// ─────────────────────────────────────────────────────────────────────
// 2. change-log.ts — deriveObjectInfo
// ─────────────────────────────────────────────────────────────────────

describe('change-log', () => {
    test('deriveObjectInfo: font-level property', () => {
        const info = deriveObjectInfo(['upm']);
        expect(info.objectType).toBe('font');
    });

    test('deriveObjectInfo: glyph-level property', () => {
        const info = deriveObjectInfo(['glyphs', 'A', 'name']);
        expect(info.objectType).toBe('glyph');
        expect(info.objectId).toBe('A');
    });

    test('deriveObjectInfo: layer-level property', () => {
        const info = deriveObjectInfo([
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'width'
        ]);
        expect(info.objectType).toBe('layer');
        expect(info.objectId).toBe('layer-1');
    });

    test('deriveObjectInfo: node-level property', () => {
        const info = deriveObjectInfo([
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'shapes',
            0,
            'nodes',
            2,
            'x'
        ]);
        expect(info.objectType).toBe('node');
    });

    test('deriveObjectInfo: axis-level property', () => {
        const info = deriveObjectInfo(['axes', 0, 'tag']);
        expect(info.objectType).toBe('axis');
        expect(info.objectId).toBe('0');
    });

    test('deriveObjectInfo: master-level property', () => {
        const info = deriveObjectInfo(['masters', 0, 'name']);
        expect(info.objectType).toBe('master');
    });

    test('deriveObjectInfo: instance-level property', () => {
        const info = deriveObjectInfo(['instances', 0, 'name']);
        expect(info.objectType).toBe('instance');
    });

    test('deriveObjectInfo: anchor', () => {
        const info = deriveObjectInfo([
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'anchors',
            0,
            'x'
        ]);
        expect(info.objectType).toBe('anchor');
    });

    test('deriveObjectInfo: guide', () => {
        const info = deriveObjectInfo([
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'guides',
            0,
            'pos'
        ]);
        expect(info.objectType).toBe('guide');
    });

    test('createLogEntry auto-increments id', () => {
        resetLogCounter();
        const e1 = createLogEntry({
            timestamp: 1,
            windowId: 'w',
            transactionLabel: null,
            transactionId: null,
            op: 'set',
            objectType: 'font',
            objectId: '',
            property: 'upm',
            path: 'upm',
            oldValue: 1000,
            newValue: 2000
        });
        const e2 = createLogEntry({
            timestamp: 2,
            windowId: 'w',
            transactionLabel: null,
            transactionId: null,
            op: 'set',
            objectType: 'font',
            objectId: '',
            property: 'note',
            path: 'note',
            oldValue: '',
            newValue: 'hi'
        });
        expect(e1.id).toBe(1);
        expect(e2.id).toBe(2);
    });
});

// ─────────────────────────────────────────────────────────────────────
// 3. ChangeBridge — basic recording
// ─────────────────────────────────────────────────────────────────────

describe('ChangeBridge', () => {
    test('initFromJson populates Y.Doc', () => {
        const { bridge } = createTestBridge('test-1');
        expect(getYPath(bridge.fontMap, ['upm'])).toBe(1000);
        expect(getYPath(bridge.fontMap, ['glyphs', 'A', 'name'])).toBe('A');
    });

    test('recordChange updates Y.Doc and adds log entry', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            700
        );
        // Y.Doc updated
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(700);
        // Log entry recorded
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].op).toBe('set');
        expect(log[0].property).toBe('width');
        expect(log[0].oldValue).toBe(600);
        expect(log[0].newValue).toBe(700);
        expect(log[0].path).toBe('glyphs.A.layers.layer-1.width');
    });

    test('recordAdd stores new value in Y.Doc', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.recordAdd(['glyphs', 'C'], {
            name: 'C',
            layers: []
        });
        const glyphC = getYPath(bridge.fontMap, ['glyphs', 'C']);
        expect(glyphC).toBeDefined();
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].op).toBe('add');
    });

    test('recordRemove deletes from Y.Doc', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.recordRemove(['glyphs', 'B'], { name: 'B' });
        expect(getYPath(bridge.fontMap, ['glyphs', 'B'])).toBeUndefined();
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].op).toBe('remove');
    });

    test('change log is suppressed during initFromJson', () => {
        const { bridge } = createTestBridge('test-1');
        // initFromJson should not produce log entries
        expect(bridge.getChangeLog()).toHaveLength(0);
    });

    test('getFullState / applyFullState round-trips', () => {
        const { bridge: b1 } = createTestBridge('test-1');
        b1.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            800
        );

        const state = b1.getFullState();

        // Create a second bridge WITHOUT initFromJson (avoids conflicting CRDT state)
        const b2 = new ChangeBridge('test-2');
        b2.applyFullState(state);

        expect(
            getYPath(b2.fontMap, ['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(800);
        b2.destroy();
    });

    test('reset clears state', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.recordChange([], 'upm', 1000, 2000);
        expect(bridge.getChangeLog().length).toBeGreaterThan(0);
        bridge.reset();
        expect(bridge.getChangeLog()).toHaveLength(0);
    });
});

// ─────────────────────────────────────────────────────────────────────
// 4. Transactions
// ─────────────────────────────────────────────────────────────────────

describe('Transactions', () => {
    test('batch changes share transactionId and label', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.beginTransaction('Drag node');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0, 'nodes', 0],
            'x',
            100,
            110
        );
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0, 'nodes', 0],
            'y',
            0,
            10
        );
        bridge.endTransaction();

        const log = bridge.getChangeLog();
        expect(log).toHaveLength(2);
        expect(log[0].transactionLabel).toBe('Drag node');
        expect(log[1].transactionLabel).toBe('Drag node');
        expect(log[0].transactionId).toBe(log[1].transactionId);
        expect(log[0].transactionId).not.toBeNull();
    });

    test('nested transactions share outermost label', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.beginTransaction('Outer');
        bridge.beginTransaction('Inner');
        bridge.recordChange([], 'upm', 1000, 2000);
        bridge.endTransaction();
        bridge.endTransaction();

        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].transactionLabel).toBe('Outer');
    });

    test('inTransaction flag tracks depth', () => {
        const { bridge } = createTestBridge('test-1');
        expect(bridge.inTransaction).toBe(false);
        bridge.beginTransaction('tx');
        expect(bridge.inTransaction).toBe(true);
        bridge.beginTransaction('nested');
        expect(bridge.inTransaction).toBe(true);
        bridge.endTransaction();
        expect(bridge.inTransaction).toBe(true);
        bridge.endTransaction();
        expect(bridge.inTransaction).toBe(false);
    });

    test('changes outside transaction have null transactionId', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.recordChange([], 'upm', 1000, 2000);
        expect(bridge.getChangeLog()[0].transactionId).toBeNull();
        expect(bridge.getChangeLog()[0].transactionLabel).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────
// 5. Model setter → ChangeBridge integration
// ─────────────────────────────────────────────────────────────────────

describe('Model setter change recording', () => {
    // -- Font properties --

    test('Font.upm setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.upm = 2000;
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].property).toBe('upm');
        expect(log[0].oldValue).toBe(1000);
        expect(log[0].newValue).toBe(2000);
        expect(log[0].objectType).toBe('font');
        // Y.Doc reflects the new value
        expect(getYPath(bridge.fontMap, ['upm'])).toBe(2000);
    });

    test('Font.version setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.version = [2, 0];
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].property).toBe('version');
    });

    test('Font.note setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.note = 'Hello';
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].property).toBe('note');
        expect(log[0].newValue).toBe('Hello');
    });

    test('Font.features setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.features = 'feature liga {}';
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].property).toBe('features');
    });

    test('Font.source setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.source = '/path/to/font.glyphs';
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].property).toBe('source');
    });

    // -- Axis properties --

    test('Axis.name setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        const axis = font.axes[0];
        axis.name = 'Width';
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].property).toBe('name');
        expect(log[0].oldValue).toBe('Weight');
        expect(log[0].newValue).toBe('Width');
        expect(log[0].objectType).toBe('axis');
    });

    test('Axis.tag setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.axes[0].tag = 'wdth';
        expect(bridge.getChangeLog()[0].property).toBe('tag');
    });

    test('Axis.min setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.axes[0].min = 50;
        expect(bridge.getChangeLog()[0].property).toBe('min');
        expect(bridge.getChangeLog()[0].newValue).toBe(50);
    });

    test('Axis.max setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.axes[0].max = 1000;
        expect(bridge.getChangeLog()[0].property).toBe('max');
    });

    test('Axis.default setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.axes[0].default = 300;
        expect(bridge.getChangeLog()[0].property).toBe('default');
    });

    test('Axis.hidden setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.axes[0].hidden = true;
        expect(bridge.getChangeLog()[0].property).toBe('hidden');
        expect(bridge.getChangeLog()[0].newValue).toBe(true);
    });

    // -- Master properties --

    test('Master.name setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.masters[0].name = 'Bold';
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].property).toBe('name');
        expect(log[0].objectType).toBe('master');
    });

    test('Master.id setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.masters[0].id = 'new-id';
        expect(bridge.getChangeLog()[0].property).toBe('id');
    });

    test('Master.location setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.masters[0].location = { wght: 700 };
        expect(bridge.getChangeLog()[0].property).toBe('location');
    });

    // -- Instance properties --

    test('Instance.name setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.instances[0].name = 'Bold';
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].property).toBe('name');
        expect(log[0].objectType).toBe('instance');
    });

    test('Instance.location setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.instances[0].location = { wght: 700 };
        expect(bridge.getChangeLog()[0].property).toBe('location');
    });

    // -- Glyph properties --

    test('Glyph.name setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        const glyph = font.glyphs[0]; // glyph A
        glyph.name = 'A.alt';
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].property).toBe('name');
        expect(log[0].objectType).toBe('glyph');
    });

    test('Glyph.production_name setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        const glyph = font.glyphs[0];
        glyph.production_name = 'uni0041';
        expect(bridge.getChangeLog()[0].property).toBe('production_name');
    });

    test('Glyph.exported setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        const glyph = font.glyphs[0];
        glyph.exported = false;
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].property).toBe('exported');
        expect(log[0].oldValue).toBe(true);
        expect(log[0].newValue).toBe(false);
    });

    test('Glyph.direction setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.glyphs[0].direction = 'RTL';
        expect(bridge.getChangeLog()[0].property).toBe('direction');
    });

    // -- Layer properties --

    test('Layer.width setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        const layer = font.glyphs[0].layers[0];
        layer.width = 700;
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].property).toBe('width');
        expect(log[0].oldValue).toBe(600);
        expect(log[0].newValue).toBe(700);
        expect(log[0].objectType).toBe('layer');
    });

    test('Layer.name setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.glyphs[0].layers[0].name = 'Light';
        expect(bridge.getChangeLog()[0].property).toBe('name');
    });

    test('Layer.color setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.glyphs[0].layers[0].color = '#FF0000';
        expect(bridge.getChangeLog()[0].property).toBe('color');
    });

    test('Layer.is_background setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.glyphs[0].layers[0].is_background = true;
        expect(bridge.getChangeLog()[0].property).toBe('is_background');
    });

    test('Layer.format_specific setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.glyphs[0].layers[0].format_specific = { custom: 123 };
        expect(bridge.getChangeLog()[0].property).toBe('format_specific');
    });

    // -- Node properties --

    test('Node.x setter records change with correct path', () => {
        const { bridge, font } = createTestBridge('test-1');
        const node = font.glyphs[0].layers[0].shapes[0].asPath().nodes[0];
        node.x = 150;
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].property).toBe('x');
        expect(log[0].oldValue).toBe(100);
        expect(log[0].newValue).toBe(150);
        expect(log[0].objectType).toBe('node');
        // Verify Y.Doc reflects the change
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes',
                0,
                'nodes',
                0,
                'x'
            ])
        ).toBe(150);
    });

    test('Node.y setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        const node = font.glyphs[0].layers[0].shapes[0].asPath().nodes[1];
        node.y = 800;
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].property).toBe('y');
        expect(log[0].oldValue).toBe(700);
        expect(log[0].newValue).toBe(800);
    });

    test('Node.nodetype setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        const node = font.glyphs[0].layers[0].shapes[0].asPath().nodes[0];
        node.nodetype = 'curve';
        expect(bridge.getChangeLog()[0].property).toBe('nodetype');
        expect(bridge.getChangeLog()[0].oldValue).toBe('line');
        expect(bridge.getChangeLog()[0].newValue).toBe('curve');
    });

    test('Node.smooth setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        const node = font.glyphs[0].layers[0].shapes[0].asPath().nodes[0];
        node.smooth = true;
        expect(bridge.getChangeLog()[0].property).toBe('smooth');
    });

    // -- Anchor properties --

    test('Anchor.x setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        const anchor = font.glyphs[0].layers[0].anchors[0];
        anchor.x = 350;
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].property).toBe('x');
        expect(log[0].oldValue).toBe(300);
        expect(log[0].newValue).toBe(350);
        expect(log[0].objectType).toBe('anchor');
    });

    test('Anchor.y setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.glyphs[0].layers[0].anchors[0].y = 800;
        expect(bridge.getChangeLog()[0].property).toBe('y');
    });

    test('Anchor.name setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.glyphs[0].layers[0].anchors[0].name = 'bottom';
        expect(bridge.getChangeLog()[0].property).toBe('name');
    });

    // -- Guide properties --

    test('Guide.pos setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        const guide = font.glyphs[0].layers[0].guides[0];
        guide.pos = 800;
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].property).toBe('pos');
        expect(log[0].oldValue).toBe(700);
        expect(log[0].newValue).toBe(800);
        expect(log[0].objectType).toBe('guide');
    });

    test('Guide.name setter records change', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.glyphs[0].layers[0].guides[0].name = 'ascender';
        expect(bridge.getChangeLog()[0].property).toBe('name');
    });
});

// ─────────────────────────────────────────────────────────────────────
// 6. Undo / Redo
// ─────────────────────────────────────────────────────────────────────

describe('Undo / Redo', () => {
    test('font-level undo reverts property change', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.recordChange([], 'upm', 1000, 2000);
        expect(getYPath(bridge.fontMap, ['upm'])).toBe(2000);

        bridge.undo();
        expect(getYPath(bridge.fontMap, ['upm'])).toBe(1000);
    });

    test('font-level redo restores change', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.recordChange([], 'upm', 1000, 2000);
        bridge.undo();
        expect(getYPath(bridge.fontMap, ['upm'])).toBe(1000);

        bridge.redo();
        expect(getYPath(bridge.fontMap, ['upm'])).toBe(2000);
    });

    test('canUndo / canRedo report correctly', () => {
        const { bridge } = createTestBridge('test-1');
        expect(bridge.canUndo()).toBe(false);
        expect(bridge.canRedo()).toBe(false);

        bridge.recordChange([], 'upm', 1000, 2000);
        expect(bridge.canUndo()).toBe(true);
        expect(bridge.canRedo()).toBe(false);

        bridge.undo();
        expect(bridge.canUndo()).toBe(false);
        expect(bridge.canRedo()).toBe(true);
    });

    test('per-glyph undo only affects that glyph', () => {
        const { bridge } = createTestBridge('test-1');
        // Set up per-glyph undo manager for glyph A
        bridge.getGlyphUndoManager('A');

        // Make changes to glyph A and glyph B
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            700
        );

        // Undo glyph A
        bridge.undo('A');
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(600);
    });

    test('undo returns false when nothing to undo', () => {
        const { bridge } = createTestBridge('test-1');
        expect(bridge.undo()).toBe(false);
        expect(bridge.undo('nonexistent')).toBe(false);
    });

    test('redo returns false when nothing to redo', () => {
        const { bridge } = createTestBridge('test-1');
        expect(bridge.redo()).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────
// 7. Cross-window sync via WindowSync
// ─────────────────────────────────────────────────────────────────────

describe('WindowSync', () => {
    test('BroadcastChannel mock delivers messages between instances', () => {
        const ch1 = new BroadcastChannel('test-channel');
        const ch2 = new BroadcastChannel('test-channel');

        const received = [];
        ch2.onmessage = (ev) => {
            received.push(ev.data);
        };

        ch1.postMessage({ hello: 'world' });
        flushTimers();

        expect(received).toEqual([{ hello: 'world' }]);
        ch1.close();
        ch2.close();
    });

    test('local change broadcasts to remote bridge', () => {
        const fontJson1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('win-1');
        bridge1.initFromJson(fontJson1);

        // Bridge2 gets its state from bridge1 (no independent initFromJson)
        const bridge2 = new ChangeBridge('win-2');
        bridge2.applyFullState(bridge1.getFullState());

        const sync1 = new WindowSync(bridge1, 'font-channel');
        const sync2 = new WindowSync(bridge2, 'font-channel');

        // Make a local change on bridge1
        bridge1.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            800
        );

        // Verify bridge1's Y.Doc was updated
        expect(
            getYPath(bridge1.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(800);

        // Flush to deliver BroadcastChannel messages
        flushTimers();

        const width = getYPath(bridge2.fontMap, [
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'width'
        ]);
        expect(width).toBe(800);

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('full state request/response bootstraps new window', () => {
        const fontJson1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('win-1');
        bridge1.initFromJson(fontJson1);
        bridge1.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            999
        );

        // Bridge2 starts empty — will be bootstrapped via full-state-response
        const bridge2 = new ChangeBridge('win-2');

        const sync1 = new WindowSync(bridge1, 'font-channel');
        const sync2 = new WindowSync(bridge2, 'font-channel');

        // Window 2 requests full state
        sync2.requestFullState();
        // First flush delivers the request to sync1
        flushTimers();
        // Second flush delivers the response from sync1 to sync2
        flushTimers();

        const width = getYPath(bridge2.fontMap, [
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'width'
        ]);
        expect(width).toBe(999);
        expect(bridge2.getChangeLog().length).toBeGreaterThan(0);

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('only first full-state response is applied', () => {
        const fontA = makeMinimalFont();
        fontA.glyphs[0].layers[0].width = 710;
        const bridgeA = new ChangeBridge('win-a');
        bridgeA.initFromJson(fontA);

        const fontB = makeMinimalFont();
        fontB.glyphs[0].layers[0].width = 930;
        const bridgeB = new ChangeBridge('win-b');
        bridgeB.initFromJson(fontB);

        const receiver = new ChangeBridge('win-rx');

        const syncA = new WindowSync(bridgeA, 'font-channel-first-response');
        const syncB = new WindowSync(bridgeB, 'font-channel-first-response');
        const syncRx = new WindowSync(receiver, 'font-channel-first-response');

        syncRx.requestFullState();
        flushTimers();
        flushTimers();

        const width = getYPath(receiver.fontMap, [
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'width'
        ]);

        // Response ordering is deterministic in this test setup:
        // syncA is registered before syncB, so receiver should keep A's snapshot.
        expect(width).toBe(710);

        syncA.destroy();
        syncB.destroy();
        syncRx.destroy();
        bridgeA.destroy();
        bridgeB.destroy();
        receiver.destroy();
    });

    test('window-closing removes peer', () => {
        const fontJson1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('win-1');
        bridge1.initFromJson(fontJson1);

        // Bridge2 gets state from bridge1
        const bridge2 = new ChangeBridge('win-2');
        bridge2.applyFullState(bridge1.getFullState());

        const sync1 = new WindowSync(bridge1, 'font-channel');
        const sync2 = new WindowSync(bridge2, 'font-channel');

        // Exchange a message so they know about each other
        bridge1.recordChange([], 'upm', 1000, 1001);
        flushTimers();

        // Now window 1 closes
        sync1.destroy();
        flushTimers();

        // sync2 should have removed win-1 from peers
        expect(sync2.peers.has('win-1')).toBe(false);

        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });
});

// ─────────────────────────────────────────────────────────────────────
// 8. Path resolution (getPath / getPathSegment on model objects)
// ─────────────────────────────────────────────────────────────────────

describe('Model path resolution', () => {
    test('Font.getPath returns empty array', () => {
        const { font } = createTestBridge('test-1');
        expect(font.getPath()).toEqual([]);
    });

    test('Glyph.getPath returns ["glyphs", "<name>"]', () => {
        const { font } = createTestBridge('test-1');
        expect(font.glyphs[0].getPath()).toEqual(['glyphs', 'A']);
    });

    test('Layer.getPath includes glyph and layer id', () => {
        const { font } = createTestBridge('test-1');
        const layer = font.glyphs[0].layers[0];
        expect(layer.getPath()).toEqual(['glyphs', 'A', 'layers', 'layer-1']);
    });

    test('Node.getPath includes full path from font root', () => {
        const { font } = createTestBridge('test-1');
        const node = font.glyphs[0].layers[0].shapes[0].asPath().nodes[0];
        const path = node.getPath();
        // Should be: glyphs, A, layers, layer-1, shapes, 0, nodes, 0
        expect(path[0]).toBe('glyphs');
        expect(path[1]).toBe('A');
        expect(path[2]).toBe('layers');
        expect(path[3]).toBe('layer-1');
        expect(path[4]).toBe('shapes');
        expect(path[5]).toBe(0);
        expect(path[6]).toBe('nodes');
        expect(path[7]).toBe(0);
    });

    test('Axis.getPath returns ["axes", index]', () => {
        const { font } = createTestBridge('test-1');
        expect(font.axes[0].getPath()).toEqual(['axes', 0]);
    });

    test('Master.getPath returns ["masters", index]', () => {
        const { font } = createTestBridge('test-1');
        expect(font.masters[0].getPath()).toEqual(['masters', 0]);
    });

    test('Instance.getPath returns ["instances", index]', () => {
        const { font } = createTestBridge('test-1');
        expect(font.instances[0].getPath()).toEqual(['instances', 0]);
    });

    test('Anchor.getPath includes layer and anchor index', () => {
        const { font } = createTestBridge('test-1');
        const anchor = font.glyphs[0].layers[0].anchors[0];
        const path = anchor.getPath();
        expect(path).toEqual([
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'anchors',
            0
        ]);
    });

    test('Guide.getPath includes layer and guide index', () => {
        const { font } = createTestBridge('test-1');
        const guide = font.glyphs[0].layers[0].guides[0];
        const path = guide.getPath();
        expect(path).toEqual(['glyphs', 'A', 'layers', 'layer-1', 'guides', 0]);
    });
});

// ─────────────────────────────────────────────────────────────────────
// 9. Multiple sequential changes
// ─────────────────────────────────────────────────────────────────────

describe('Sequential changes', () => {
    test('multiple node moves produce independent log entries', () => {
        const { bridge, font } = createTestBridge('test-1');
        const node = font.glyphs[0].layers[0].shapes[0].asPath().nodes[0];
        node.x = 110;
        node.x = 120;
        node.x = 130;
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(3);
        expect(log[0].oldValue).toBe(100);
        expect(log[0].newValue).toBe(110);
        expect(log[1].oldValue).toBe(110);
        expect(log[1].newValue).toBe(120);
        expect(log[2].oldValue).toBe(120);
        expect(log[2].newValue).toBe(130);
    });

    test('changes across different glyphs produce correct paths', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.glyphs[0].layers[0].width = 700; // glyph A
        font.glyphs[1].layers[0].width = 800; // glyph B
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(2);
        expect(log[0].path).toContain('A');
        expect(log[1].path).toContain('B');
    });
});

// ─────────────────────────────────────────────────────────────────────
// 10. syncGlyphFromJson — bulk glyph sync
// ─────────────────────────────────────────────────────────────────────

describe('syncGlyphFromJson', () => {
    test('first sync fires Y.Doc local update', () => {
        const { bridge, fontJson } = createTestBridge('test-1');
        const updates = [];
        bridge.onLocalUpdate((u) => updates.push(u));

        // Mutate babelfontData directly (simulating outline-editor drag)
        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson('A', 'Drag');

        expect(updates.length).toBe(1);
        // Y.Doc should reflect the new width
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(700);
    });

    test('consecutive syncs both fire Y.Doc local updates', () => {
        const { bridge, fontJson } = createTestBridge('test-1');
        const updates = [];
        bridge.onLocalUpdate((u) => updates.push(u));

        // First drag
        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson('A', 'Drag');
        expect(updates.length).toBe(1);

        // Second drag
        fontJson.glyphs[0].layers[0].width = 800;
        bridge.syncGlyphFromJson('A', 'Drag');
        expect(updates.length).toBe(2);

        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(800);
    });

    test('undo works after syncGlyphFromJson', () => {
        const { bridge, fontJson } = createTestBridge('test-1');

        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson('A', 'Drag');

        expect(bridge.canUndo('A')).toBe(true);
        bridge.undo('A');
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(600);
    });

    test('undo works after two consecutive syncs - each sync is a separate undo step', () => {
        const { bridge, fontJson } = createTestBridge('test-1');

        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson('A', 'Drag 1');

        fontJson.glyphs[0].layers[0].width = 800;
        bridge.syncGlyphFromJson('A', 'Drag 2');

        // stopCapturing() is called after each syncGlyphFromJson, so each sync
        // becomes its own undo step regardless of the 500ms captureTimeout.
        expect(bridge.canUndo('A')).toBe(true);
        bridge.undo('A');
        // First undo reverts Drag 2: width goes back to 700
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(700);

        // Second undo reverts Drag 1: width goes back to original 600
        expect(bridge.canUndo('A')).toBe(true);
        bridge.undo('A');
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(600);
    });

    test('syncGlyphFromJson prunes removed layers from Y.Doc', () => {
        const { bridge, fontJson } = createTestBridge('test-1');

        // Add an extra layer and sync it first
        fontJson.glyphs[0].layers.push({
            id: 'layer-temp',
            name: 'Temp',
            width: 500,
            master: {
                type: 'DefaultForMaster',
                master: 'master-regular'
            },
            smart_component_location: {},
            color: null,
            layer_index: 1,
            is_background: false,
            background_layer_id: null,
            location: {},
            format_specific: {},
            shapes: []
        });
        bridge.syncGlyphFromJson('A', 'Add temp layer');

        expect(
            getYPath(bridge.fontMap, ['glyphs', 'A', 'layers', 'layer-temp'])
        ).toBeDefined();

        // Remove from source JSON and sync again; Y.Doc should prune it
        fontJson.glyphs[0].layers = fontJson.glyphs[0].layers.filter(
            (layer) => layer.id !== 'layer-temp'
        );
        bridge.syncGlyphFromJson('A', 'Remove temp layer');

        expect(
            getYPath(bridge.fontMap, ['glyphs', 'A', 'layers', 'layer-temp'])
        ).toBeUndefined();
    });

    test('second window receives both consecutive syncs', () => {
        // Primary
        const font1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('primary');
        bridge1.initFromJson(font1);
        // Secondary bootstraps from primary's state (matching real setup)
        const bridge2 = new ChangeBridge('secondary');
        bridge2.applyFullState(bridge1.getFullState());

        const sync1 = new WindowSync(bridge1, 'test-sync-consecutive');
        const sync2 = new WindowSync(bridge2, 'test-sync-consecutive');

        const remoteEntries = [];
        bridge2.onRemoteChange((entries) => remoteEntries.push('update'));

        // First drag
        font1.glyphs[0].layers[0].width = 700;
        bridge1.syncGlyphFromJson('A', 'Drag');
        flushTimers();

        expect(remoteEntries.length).toBe(1);
        expect(
            getYPath(bridge2.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(700);

        // Second drag
        font1.glyphs[0].layers[0].width = 800;
        bridge1.syncGlyphFromJson('A', 'Drag');
        flushTimers();

        expect(remoteEntries.length).toBe(2);
        expect(
            getYPath(bridge2.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(800);

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('change log entry has meaningful values', () => {
        const { bridge, fontJson } = createTestBridge('test-1');

        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson('A', 'Drag');

        const log = bridge.getChangeLog();
        const entry = log[log.length - 1];
        expect(entry.objectType).toBe('glyph');
        expect(entry.objectId).toBe('A');
        expect(entry.transactionLabel).toBe('Drag');
        // oldValue = glyph name, newValue = label
        expect(entry.oldValue).toBe('A');
        expect(entry.newValue).toBe('Drag');
    });

    test('change log entries are broadcast to remote window', () => {
        const font1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('primary');
        bridge1.initFromJson(font1);
        const bridge2 = new ChangeBridge('secondary');
        bridge2.applyFullState(bridge1.getFullState());

        const sync1 = new WindowSync(bridge1, 'test-log-sync');
        const sync2 = new WindowSync(bridge2, 'test-log-sync');

        bridge2.onRemoteChange(() => {});

        // Make an edit
        font1.glyphs[0].layers[0].width = 700;
        bridge1.syncGlyphFromJson('A', 'Drag');
        flushTimers();

        // Remote bridge should have the change log entry
        const remoteLog = bridge2.getChangeLog();
        expect(remoteLog.length).toBe(1);
        expect(remoteLog[0].objectId).toBe('A');
        expect(remoteLog[0].transactionLabel).toBe('Drag');

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('undo changes broadcast to remote window', () => {
        const font1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('primary');
        bridge1.initFromJson(font1);
        const bridge2 = new ChangeBridge('secondary');
        bridge2.applyFullState(bridge1.getFullState());

        const sync1 = new WindowSync(bridge1, 'test-undo-sync');
        const sync2 = new WindowSync(bridge2, 'test-undo-sync');

        const remoteUpdates = [];
        bridge2.onRemoteChange(() => remoteUpdates.push('update'));

        // Make an edit then undo
        font1.glyphs[0].layers[0].width = 700;
        bridge1.syncGlyphFromJson('A', 'Drag');
        flushTimers();

        expect(
            getYPath(bridge2.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(700);

        bridge1.undo('A');
        flushTimers();

        // Undo should propagate
        expect(
            getYPath(bridge2.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(600);

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('undo/redo add change log entries for undo-manager window', () => {
        const { bridge, fontJson } = createTestBridge('test-1');

        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson('A', 'Drag');

        const logBefore = bridge.getChangeLog().length;
        bridge.undo('A');
        const logAfter = bridge.getChangeLog().length;

        // Undo should add a log entry
        expect(logAfter).toBe(logBefore + 1);
        const undoEntry = bridge.getChangeLog()[logAfter - 1];
        expect(undoEntry.transactionLabel).toBe('Undo');
        expect(undoEntry.objectType).toBe('glyph');
        expect(undoEntry.objectId).toBe('A');

        bridge.redo('A');
        const logAfterRedo = bridge.getChangeLog().length;
        expect(logAfterRedo).toBe(logAfter + 1);
        const redoEntry = bridge.getChangeLog()[logAfterRedo - 1];
        expect(redoEntry.transactionLabel).toBe('Redo');
    });

    test('sync window receives edits without calling initFromJson', () => {
        // Primary: initialized normally
        const font1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('primary');
        bridge1.initFromJson(font1);

        // Secondary: only setFontJson (no initFromJson — no divergent CRDT state)
        const font2 = makeMinimalFont();
        const bridge2 = new ChangeBridge('secondary');
        bridge2.setFontJson(font2);

        const sync1 = new WindowSync(bridge1, 'test-sync-noinit');
        const sync2 = new WindowSync(bridge2, 'test-sync-noinit');

        // Bootstrap via full state request/response
        sync2.requestFullState();
        flushTimers();

        // Secondary should now have the font data from primary's Y.Doc
        expect(
            getYPath(bridge2.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(600);

        const remoteUpdates = [];
        bridge2.onRemoteChange(() => remoteUpdates.push('update'));

        // Primary makes edits
        font1.glyphs[0].layers[0].width = 700;
        bridge1.syncGlyphFromJson('A', 'Drag 1');
        flushTimers();

        expect(remoteUpdates.length).toBe(1);
        expect(
            getYPath(bridge2.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(700);

        // Second edit
        font1.glyphs[0].layers[0].width = 800;
        bridge1.syncGlyphFromJson('A', 'Drag 2');
        flushTimers();

        expect(remoteUpdates.length).toBe(2);
        expect(
            getYPath(bridge2.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(800);

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });
});
