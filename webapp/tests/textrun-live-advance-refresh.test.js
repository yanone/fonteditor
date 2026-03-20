const { TextRunEditor } = require('../js/glyph-canvas/textrun');

describe('TextRunEditor live advance refresh', () => {
    let editor;

    beforeEach(() => {
        const featuresManager = {
            getHarfBuzzFeatures: () => null
        };
        const axesManager = {
            variationSettings: {}
        };

        editor = new TextRunEditor(featuresManager, axesManager);
        editor.textBuffer = 'aba';
        editor.shapedGlyphs = [
            { ax: 500, dx: 0, dy: 0, g: 10, cl: 0 },
            { ax: 320, dx: 0, dy: 0, g: 11, cl: 1 },
            { ax: 500, dx: 0, dy: 0, g: 10, cl: 2 }
        ];
        editor.glyphNameBuffer = ['a', 'b', 'a'];
        editor.clusterMap = [
            {
                glyphIndex: 0,
                glyphCount: 1,
                start: 0,
                end: 1,
                x: 0,
                width: 500,
                isRTL: false,
                isExplicitToken: false,
                isAtomicCluster: false
            }
        ];
    });

    test('updates matching glyph advances and rerenders the line', () => {
        const buildClusterMapSpy = jest.spyOn(editor, 'buildClusterMap');
        const updateCursorSpy = jest.spyOn(
            editor,
            'updateCursorVisualPosition'
        );
        const renderCallback = jest.fn();
        editor.on('render', renderCallback);

        const changed = editor.refreshGlyphAdvancesLive({ a: 640 });

        expect(changed).toBe(true);
        expect(editor.shapedGlyphs.map((glyph) => glyph.ax)).toEqual([
            640, 320, 640
        ]);
        expect(buildClusterMapSpy).toHaveBeenCalledTimes(1);
        expect(updateCursorSpy).toHaveBeenCalledTimes(1);
        expect(renderCallback).toHaveBeenCalledTimes(1);
    });

    test('does nothing when no matching advance changes are provided', () => {
        const buildClusterMapSpy = jest.spyOn(editor, 'buildClusterMap');
        const updateCursorSpy = jest.spyOn(
            editor,
            'updateCursorVisualPosition'
        );
        const renderCallback = jest.fn();
        editor.on('render', renderCallback);

        const changed = editor.refreshGlyphAdvancesLive({ c: 700, a: 500 });

        expect(changed).toBe(false);
        expect(editor.shapedGlyphs.map((glyph) => glyph.ax)).toEqual([
            500, 320, 500
        ]);
        expect(buildClusterMapSpy).not.toHaveBeenCalled();
        expect(updateCursorSpy).not.toHaveBeenCalled();
        expect(renderCallback).not.toHaveBeenCalled();
    });
});
