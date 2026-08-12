const { TextRunEditor } = require('../js/glyph-canvas/textrun');

describe('TextRunEditor mouse selection', () => {
    const makeEditor = () => {
        const featuresManager = {
            getHarfBuzzFeatures: jest.fn(() => null)
        };
        const axesManager = {
            variationSettings: {}
        };
        const editor = new TextRunEditor(featuresManager, axesManager);
        editor.updateCursorVisualPosition = jest.fn();
        editor.reshapeAndRender = jest.fn();
        editor.textBuffer = 'Hamburge';
        editor.cursorPosition = 0;
        return editor;
    };

    test('click without drag leaves a caret and no selection', () => {
        const editor = makeEditor();
        editor.beginMouseSelection(3);
        editor.finishMouseSelection();

        expect(editor.cursorPosition).toBe(3);
        expect(editor.hasSelection()).toBe(false);
        expect(editor.selectionStart).toBeNull();
        expect(editor.selectionEnd).toBeNull();
    });

    test('click-drag selects the dragged range', () => {
        const editor = makeEditor();
        editor.beginMouseSelection(2);
        editor.extendMouseSelection(6);
        editor.finishMouseSelection();

        expect(editor.hasSelection()).toBe(true);
        expect(editor.getSelectionRange()).toEqual({ start: 2, end: 6 });
        expect(editor.cursorPosition).toBe(6);
        expect(editor.textBuffer.slice(2, 6)).toBe('mbur');
    });

    test('drag backward keeps the original anchor', () => {
        const editor = makeEditor();
        editor.beginMouseSelection(5);
        editor.extendMouseSelection(1);
        editor.finishMouseSelection();

        expect(editor.getSelectionRange()).toEqual({ start: 1, end: 5 });
        expect(editor.cursorPosition).toBe(1);
        expect(editor.selectionStart).toBe(5);
        expect(editor.selectionEnd).toBe(1);
    });

    test('Shift-click extends from the current caret', () => {
        const editor = makeEditor();
        editor.cursorPosition = 2;
        editor.beginMouseSelection(7, true);
        editor.finishMouseSelection();

        expect(editor.getSelectionRange()).toEqual({ start: 2, end: 7 });
        expect(editor.cursorPosition).toBe(7);
    });

    test('Shift-click extends from an existing selection anchor', () => {
        const editor = makeEditor();
        editor.selectionStart = 1;
        editor.selectionEnd = 4;
        editor.cursorPosition = 4;

        editor.beginMouseSelection(7, true);
        editor.finishMouseSelection();

        expect(editor.getSelectionRange()).toEqual({ start: 1, end: 7 });
        expect(editor.cursorPosition).toBe(7);
    });

    test('far left/right clicks snap to run ends', () => {
        const editor = makeEditor();
        editor.clusterMap = [
            { start: 0, end: 1, x: 100, width: 50, isRTL: false },
            { start: 1, end: 2, x: 150, width: 60, isRTL: false },
            { start: 2, end: 3, x: 210, width: 40, isRTL: false }
        ];

        expect(editor.getGlyphIndexAtClick(-5000, 0)).toBe(0);
        expect(editor.getGlyphIndexAtClick(8000, 0)).toBe(3);
        // Mid-glyph prefers the nearer caret edge (left edge of second cluster).
        expect(editor.getGlyphIndexAtClick(175, 0)).toBe(1);
    });
});
