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
    });
});
