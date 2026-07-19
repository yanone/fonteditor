/**
 * Tests for upstream-truthful path node storage in the Y.Doc bridge.
 */

const Y = require('yjs');
const {
    jsonToYDoc,
    yDocToJson,
    fromYType,
    setYPath,
    applyLayerDelta
} = require('../js/change-bridge-ydoc');
const {
    parseNodeString,
    serializeNodeArray,
    decodeNodeStringsForRuntime,
    encodeNodeArraysForStorage
} = require('../js/node-encoding');
const { Font, ensureStableIds } = require('../js/babelfont-model');

function makeTestFont(nodes = '100 200 l 300 300 l 500 400 l') {
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
                                nodes,
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

describe('node encoding boundary', () => {
    test('serializes runtime node arrays to upstream node strings', () => {
        expect(
            serializeNodeArray([
                { x: 100, y: 200, nodetype: 'Line', smooth: false },
                { x: 300, y: 400, nodetype: 'Curve', smooth: true }
            ])
        ).toBe('100 200 l 300 400 cs');
    });

    test('parses upstream node strings into runtime node arrays', () => {
        expect(parseNodeString('100 200 l 300 400 cs')).toEqual([
            { x: 100, y: 200, nodetype: 'Line', smooth: false },
            { x: 300, y: 400, nodetype: 'Curve', smooth: true }
        ]);
    });

    test('preserves node format_specific JSON during string round-trip', () => {
        const nodes = [
            {
                x: 100,
                y: 200,
                nodetype: 'Line',
                smooth: false,
                format_specific: { glyphs: { name: 'a b' } }
            }
        ];
        const encoded = serializeNodeArray(nodes);
        expect(encoded).toBe('100 200 l {"glyphs":{"name":"a b"}}');
        expect(parseNodeString(encoded)).toEqual(nodes);
    });

    test('deep helpers decode and encode only nodes fields', () => {
        const stored = makeTestFont();
        const runtime = decodeNodeStringsForRuntime(stored);
        expect(runtime.glyphs[0].layers[0].shapes[0].nodes).toEqual([
            { x: 100, y: 200, nodetype: 'Line', smooth: false },
            { x: 300, y: 300, nodetype: 'Line', smooth: false },
            { x: 500, y: 400, nodetype: 'Line', smooth: false }
        ]);
        expect(encodeNodeArraysForStorage(runtime)).toEqual(stored);
    });
});

describe('upstream-truthful Y.Doc node storage', () => {
    test('Y.Doc stores shapes as an ordered array with string nodes', () => {
        const { fontMap } = setupYDoc(makeTestFont());
        const layerMap = getLayerMap(fontMap);

        expect(layerMap.get('shapesById')).toBeUndefined();
        expect(layerMap.get('shapeOrder')).toBeUndefined();

        const shapes = layerMap.get('shapes');
        expect(shapes).toBeInstanceOf(Y.Array);
        const shapeMap = shapes.get(0);
        expect(shapeMap).toBeInstanceOf(Y.Map);
        expect(shapeMap.get('nodes')).toBe('100 200 l 300 300 l 500 400 l');
        expect(shapeMap.get('nodesById')).toBeUndefined();
        expect(shapeMap.get('nodeOrder')).toBeUndefined();
    });

    test('array-node input is normalized to string-node Y.Doc storage', () => {
        const font = makeTestFont([
            { x: 100, y: 200, nodetype: 'Line', smooth: false },
            { x: 300, y: 400, nodetype: 'Curve', smooth: true }
        ]);
        const { fontMap } = setupYDoc(font);
        const layerMap = getLayerMap(fontMap);
        const shapeMap = layerMap.get('shapes').get(0);

        expect(shapeMap.get('nodes')).toBe('100 200 l 300 400 cs');
        expect(yDocToJson(fontMap).glyphs[0].layers[0].shapes[0].nodes).toBe(
            '100 200 l 300 400 cs'
        );
    });

    test('fromYType round-trips string-node layers', () => {
        const { fontMap } = setupYDoc(makeTestFont());
        const layer = fromYType(getLayerMap(fontMap));

        expect(layer.shapes[0].nodes).toBe('100 200 l 300 300 l 500 400 l');
        expect(layer.shapes[0].id).toBeUndefined();
    });

    test('setYPath replaces a path node string without creating indexed nodes', () => {
        const { fontMap } = setupYDoc(makeTestFont());
        setYPath(
            fontMap,
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0, 'nodes'],
            '111 222 l 333 444 l'
        );

        const shapeMap = getLayerMap(fontMap).get('shapes').get(0);
        expect(shapeMap.get('nodes')).toBe('111 222 l 333 444 l');
        expect(shapeMap.get('nodesById')).toBeUndefined();
        expect(yDocToJson(fontMap).glyphs[0].layers[0].shapes[0].nodes).toBe(
            '111 222 l 333 444 l'
        );
    });

    test('logical node replay stays string-backed in Y.Doc and editable in the runtime model', () => {
        const { fontMap } = setupYDoc(makeTestFont());
        setYPath(
            fontMap,
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0, 'nodes', 1, 'x'],
            333
        );

        const shapeMap = getLayerMap(fontMap).get('shapes').get(0);
        expect(shapeMap.get('nodes')).toBe('100 200 l 333 300 l 500 400 l');

        const runtimeFont = Font.fromData(yDocToJson(fontMap));
        const path = runtimeFont.glyphs[0].layers[0].paths[0];
        expect(path.nodes[1].x).toBe(333);

        path.nodes[1].x = 350;

        const serialized = JSON.parse(runtimeFont.toJSONString());
        expect(serialized.glyphs[0].layers[0].shapes[0].nodes).toBe(
            '100 200 l 350 300 l 500 400 l'
        );
    });

    test('applyLayerDelta writes upstream string nodes', () => {
        const { fontMap } = setupYDoc(makeTestFont());
        applyLayerDelta(fontMap, 'A', 'layer-1', {
            shapes: [
                {
                    nodes: [
                        { x: 10, y: 20, nodetype: 'Line', smooth: false },
                        { x: 30, y: 40, nodetype: 'Line', smooth: false }
                    ],
                    closed: false
                }
            ]
        });

        const shapeMap = getLayerMap(fontMap).get('shapes').get(0);
        expect(shapeMap.get('nodes')).toBe('10 20 l 30 40 l');
        expect(shapeMap.get('nodesById')).toBeUndefined();
    });
});

describe('upstream-truthful model serialization', () => {
    test('Font.toJSONString emits string nodes without editor shape/node ids', () => {
        const runtimeFont = decodeNodeStringsForRuntime(makeTestFont());
        ensureStableIds(runtimeFont);

        const serialized = JSON.parse(
            Font.fromData(runtimeFont).toJSONString()
        );
        const shape = serialized.glyphs[0].layers[0].shapes[0];

        expect(shape.nodes).toBe('100 200 l 300 300 l 500 400 l');
        expect(shape.id).toBeUndefined();
        expect(shape.nodesById).toBeUndefined();
        expect(shape.nodeOrder).toBeUndefined();
    });

    test('Font.toJSONString strips editor component ids', () => {
        const runtimeFont = makeTestFont();
        runtimeFont.glyphs[0].layers[0].shapes = [
            {
                id: 'component-editor-id',
                reference: 'A',
                transform: {
                    translation: [0, 0],
                    rotation: 0,
                    scale: [1, 1],
                    skew: [0, 0],
                    order: 'RestOfTheWorld'
                }
            }
        ];

        const serialized = JSON.parse(
            Font.fromData(runtimeFont).toJSONString()
        );

        expect(serialized.glyphs[0].layers[0].shapes[0].id).toBeUndefined();
        expect(serialized.glyphs[0].layers[0].shapes[0].reference).toBe('A');
    });
});
