const Y = require('yjs');
const {
    jsonToYDoc,
    yDocToJson,
    fromYType,
    setYPath,
    applyLayerDelta
} = require('../js/change-bridge-ydoc');
const { Font, ensureStableIds } = require('../js/babelfont-model');

const nodes = [
    { x: 100, y: 200, nodetype: 'Move', smooth: false },
    { x: 300, y: 300, nodetype: 'Line', smooth: false },
    { x: 500, y: 400, nodetype: 'Curve', smooth: true }
];

function makeTestFont(pathNodes = nodes) {
    return {
        upm: 1000,
        version: [1, 0],
        date: '2024-01-01',
        names: { familyName: 'TestFont' },
        features: { classes: {}, prefixes: {}, features: [] },
        masters: [{ id: 'master-1', name: 'Regular', location: {} }],
        glyphs: [
            {
                name: 'A',
                codepoints: [65],
                layers: [
                    {
                        id: 'layer-1',
                        width: 600,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-1'
                        },
                        shapes: [{ nodes: pathNodes, closed: true }],
                        anchors: [],
                        guides: []
                    }
                ]
            }
        ]
    };
}

function setupYDoc(fontJson) {
    const yDoc = new Y.Doc();
    const fontMap = yDoc.getMap('font');
    jsonToYDoc(fontJson, fontMap);
    return { yDoc, fontMap };
}

function getShapeMap(fontMap) {
    return fontMap
        .get('glyphs')
        .get('A')
        .get('layers')
        .get('layer-1')
        .get('shapes')
        .get(0);
}

describe('array-only Y.Doc path nodes', () => {
    test('stores nodes as a Y.Array of Y.Maps and round-trips arrays', () => {
        const { fontMap } = setupYDoc(makeTestFont());
        const nodeArray = getShapeMap(fontMap).get('nodes');

        expect(nodeArray).toBeInstanceOf(Y.Array);
        expect(nodeArray.get(0)).toBeInstanceOf(Y.Map);
        expect(fromYType(nodeArray)).toEqual(nodes);
        expect(yDocToJson(fontMap).glyphs[0].layers[0].shapes[0].nodes).toEqual(
            nodes
        );
    });

    test('rejects string node payloads at the bridge boundary', () => {
        const { fontMap } = setupYDoc(makeTestFont());
        const nodesPath = [
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'shapes',
            0,
            'nodes'
        ];

        expect(() => setYPath(fontMap, nodesPath, '100 200 l')).toThrow(
            'Y.Doc path nodes must be arrays.'
        );
        expect(fromYType(getShapeMap(fontMap).get('nodes'))).toEqual(nodes);
    });

    test('rejects Y.Text node values when reading from the Y.Doc', () => {
        const { fontMap } = setupYDoc(makeTestFont());
        const shapeMap = getShapeMap(fontMap);
        shapeMap.set('nodes', new Y.Text('100 200 l'));

        expect(() => fromYType(shapeMap.get('nodes'))).toThrow(
            'Y.Text values are not supported in the font Y.Doc.'
        );
        expect(() =>
            applyLayerDelta(fontMap, 'A', 'layer-1', {
                shapes: [{ nodes: '300 400 l', closed: true }]
            })
        ).toThrow('Y.Doc path nodes must be arrays.');
    });

    test('atomically replaces array nodes during replay and keeps them editable', () => {
        const { fontMap } = setupYDoc(makeTestFont());
        const replacement = [
            { x: 111, y: 222, nodetype: 'Move', smooth: false },
            { x: 333, y: 444, nodetype: 'Line', smooth: false }
        ];
        setYPath(
            fontMap,
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0, 'nodes'],
            replacement
        );

        const runtimeFont = Font.fromData(yDocToJson(fontMap));
        const path = runtimeFont.glyphs[0].layers[0].paths[0];
        expect(path.nodes.map((node) => node.x)).toEqual([111, 333]);
        path.nodes[1].x = 350;

        expect(
            JSON.parse(runtimeFont.toJSONString()).glyphs[0].layers[0].shapes[0]
                .nodes[1].x
        ).toBe(350);
        expect(yDocToJson(fontMap).glyphs[0].layers[0].shapes[0].nodes).toEqual(
            replacement
        );
    });

    test('applyLayerDelta writes array nodes and strips editor shape ids on serialization', () => {
        const { fontMap } = setupYDoc(makeTestFont());
        applyLayerDelta(fontMap, 'A', 'layer-1', {
            shapes: [{ id: 'editor-shape-id', nodes, closed: false }]
        });

        expect(fromYType(getShapeMap(fontMap).get('nodes'))).toEqual(nodes);
        const font = Font.fromData(yDocToJson(fontMap));
        ensureStableIds(font.data);
        const shape = JSON.parse(font.toJSONString()).glyphs[0].layers[0]
            .shapes[0];
        expect(shape.nodes).toEqual(nodes);
        expect(shape.id).toBeUndefined();
    });
});
