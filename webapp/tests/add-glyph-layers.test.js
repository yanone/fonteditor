const { Font } = require('../js/babelfont-model');

describe('Font.addGlyph', () => {
    test('creates an empty default layer for every master', () => {
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            cross_axis_mappings: [],
            instances: [],
            masters: [
                {
                    id: 'master-regular',
                    name: { dflt: 'Regular' },
                    location: {},
                    guides: [],
                    metrics: {},
                    kerning: {}
                },
                {
                    id: 'master-bold',
                    name: { dflt: 'Bold' },
                    location: { wght: 700 },
                    guides: [],
                    metrics: {},
                    kerning: {}
                }
            ],
            glyphs: []
        });

        const glyph = font.addGlyph('newGlyph');

        expect(glyph.layers).toHaveLength(2);
        expect(glyph.layers.map((layer) => layer.id)).toEqual([
            'master-regular',
            'master-bold'
        ]);
        expect(glyph.layers.map((layer) => layer.master)).toEqual([
            { type: 'DefaultForMaster', master: 'master-regular' },
            { type: 'DefaultForMaster', master: 'master-bold' }
        ]);
        expect(glyph.layers.map((layer) => layer.width)).toEqual([500, 500]);
        expect(glyph.layers.map((layer) => layer.shapes)).toEqual([[], []]);
    });

    test('addLayer DefaultForMaster uses the master id as the layer id', () => {
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            cross_axis_mappings: [],
            instances: [],
            masters: [
                {
                    id: 'master-regular',
                    name: { dflt: 'Regular' },
                    location: {},
                    guides: [],
                    metrics: {},
                    kerning: {}
                }
            ],
            glyphs: []
        });

        const glyph = font.addGlyph('newGlyph');
        while (glyph.layers.length > 0) {
            glyph.removeLayer(0);
        }

        const layer = glyph.addLayer(600, {
            type: 'DefaultForMaster',
            master: 'master-regular'
        });

        expect(layer.id).toBe('master-regular');
        expect(layer.width).toBe(600);
        expect(layer.shapes).toEqual([]);
        expect(layer.master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-regular'
        });
    });
});
