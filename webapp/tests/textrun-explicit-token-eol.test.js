const { TextRunEditor } = require('../js/glyph-canvas/textrun');

describe('TextRunEditor explicit token EOL append behavior', () => {
    const makeEditor = () => {
        const featuresManager = {
            getHarfBuzzFeatures: jest.fn(() => null)
        };
        const axesManager = {
            variationSettings: {}
        };
        const editor = new TextRunEditor(featuresManager, axesManager);
        return editor;
    };

    beforeEach(() => {
        window.currentFontModel = {
            findGlyph: jest.fn((name) => {
                if (name === 'A') {
                    return { name: 'A' };
                }
                return null;
            })
        };
    });

    test('keeps EOL token boundary when first trailing space is typed', () => {
        const editor = makeEditor();
        editor.textBuffer = '/A ';
        editor.buildDisplayTextMapping();

        const tokens = editor.parseExplicitGlyphTokens([
            { name: 'A', start: 0, end: 2 }
        ]);

        expect(tokens).toEqual([{ name: 'A', start: 0, end: 2 }]);
    });

    test('keeps EOL token boundary when first trailing letter is typed', () => {
        const editor = makeEditor();
        editor.textBuffer = '/Ab';
        editor.buildDisplayTextMapping();

        const tokens = editor.parseExplicitGlyphTokens([
            { name: 'A', start: 0, end: 2 }
        ]);

        expect(tokens).toEqual([{ name: 'A', start: 0, end: 2 }]);
    });
});
