const { PatchSyncEngine: ChangeBridge } = require('../js/patch-sync-engine');
const { yDocToJson } = require('../js/change-bridge-ydoc');

function makeLayerArrayReplacementFont() {
    return {
        upm: 1000,
        version: [1, 0],
        names: { familyName: 'TestFont' },
        glyphs: [
            {
                name: 'oacute',
                layers: [
                    {
                        id: 'L0',
                        width: 570,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'L0'
                        },
                        shapes: [
                            {
                                reference: 'o',
                                transform: {
                                    translation: [0, 0],
                                    rotation: 0,
                                    scale: [1, 1],
                                    skew: [0, 0],
                                    order: 'RestOfTheWorld'
                                }
                            },
                            {
                                reference: 'acutecomb',
                                transform: {
                                    translation: [238, 492],
                                    rotation: 0,
                                    scale: [1, 1],
                                    skew: [0, 0],
                                    order: 'Glyphs'
                                }
                            }
                        ],
                        anchors: [
                            { name: 'top', x: 285, y: 492 },
                            { name: 'bottom', x: 285, y: 0 }
                        ],
                        guides: []
                    }
                ]
            }
        ]
    };
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

describe('ChangeBridge layer snapshot array replacement', () => {
    test('preserves layer root identity while replacing visual arrays atomically', () => {
        const fontJson = makeLayerArrayReplacementFont();
        const bridge = new ChangeBridge();
        bridge.initFromJson(fontJson);

        const glyphsMap = bridge.fontMap.get('glyphs');
        const glyphMap = glyphsMap.get('oacute');
        const layersMap = glyphMap.get('layers');
        const layerMap = layersMap.get('L0');

        const initialLayerMap = layerMap;
        const initialShapesArray = layerMap.get('shapes');
        const initialAnchorsArray = layerMap.get('anchors');

        const updatedFontJson = cloneJson(fontJson);
        updatedFontJson.glyphs[0].layers[0].shapes[1].transform.translation = [
            238, 618
        ];
        updatedFontJson.glyphs[0].layers[0].anchors[0].y = 618;
        bridge.setFontJson(updatedFontJson);
        bridge.syncLayersFromJson(
            [{ glyphName: 'oacute', layerId: 'L0' }],
            'Drag anchor'
        );

        const afterFirstShapesArray = layerMap.get('shapes');
        const afterFirstAnchorsArray = layerMap.get('anchors');

        expect(layerMap).toBe(initialLayerMap);
        expect(afterFirstShapesArray).not.toBe(initialShapesArray);
        expect(afterFirstAnchorsArray).not.toBe(initialAnchorsArray);

        const secondFontJson = cloneJson(updatedFontJson);
        secondFontJson.glyphs[0].layers[0].shapes[1].transform.translation = [
            238, 744
        ];
        secondFontJson.glyphs[0].layers[0].anchors[0].y = 744;
        bridge.setFontJson(secondFontJson);
        bridge.syncLayersFromJson(
            [{ glyphName: 'oacute', layerId: 'L0' }],
            'Drag anchor'
        );

        const afterSecondShapesArray = layerMap.get('shapes');
        const afterSecondAnchorsArray = layerMap.get('anchors');

        expect(layerMap).toBe(initialLayerMap);
        expect(afterSecondShapesArray).not.toBe(afterFirstShapesArray);
        expect(afterSecondAnchorsArray).not.toBe(afterFirstAnchorsArray);

        const decoded = yDocToJson(bridge.fontMap);
        const glyph = decoded.glyphs.find((entry) => entry.name === 'oacute');
        const layer = glyph.layers.find((entry) => entry.id === 'L0');

        expect(layer.shapes[1].transform.translation).toEqual([238, 744]);
        expect(layer.anchors[0].y).toBe(744);
    });
});
