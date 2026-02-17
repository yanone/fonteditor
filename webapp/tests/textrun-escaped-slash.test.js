const { TextRunEditor } = require('../js/glyph-canvas/textrun');

describe('TextRunEditor escaped slash atomic behavior', () => {
    const makeEditor = () => {
        const featuresManager = {
            getHarfBuzzFeatures: jest.fn(() => null)
        };
        const axesManager = {
            variationSettings: {}
        };
        const editor = new TextRunEditor(featuresManager, axesManager);

        // Avoid rendering/shaping side effects in unit tests
        editor.updateCursorVisualPosition = jest.fn();
        editor.reshapeAndRender = jest.fn();

        return editor;
    };

    test('moves cursor backward over // as one unit', () => {
        const editor = makeEditor();
        editor.textBuffer = 'a//b';

        editor.cursorPosition = 3;
        editor.moveCursorLogicalBackward();
        expect(editor.cursorPosition).toBe(1);

        editor.cursorPosition = 2;
        editor.moveCursorLogicalBackward();
        expect(editor.cursorPosition).toBe(1);
    });

    test('moves cursor forward over // as one unit', () => {
        const editor = makeEditor();
        editor.textBuffer = 'a//b';

        editor.cursorPosition = 1;
        editor.moveCursorLogicalForward();
        expect(editor.cursorPosition).toBe(3);

        editor.cursorPosition = 2;
        editor.moveCursorLogicalForward();
        expect(editor.cursorPosition).toBe(3);
    });

    test('backspace deletes // pair atomically', () => {
        const editor = makeEditor();
        editor.textBuffer = 'a//b';
        editor.cursorPosition = 3;

        editor.deleteBackward();

        expect(editor.textBuffer).toBe('ab');
        expect(editor.cursorPosition).toBe(1);
        expect(editor.reshapeAndRender).toHaveBeenCalledTimes(1);
    });

    test('delete key deletes // pair atomically', () => {
        const editor = makeEditor();
        editor.textBuffer = 'a//b';
        editor.cursorPosition = 1;

        editor.deleteForward();

        expect(editor.textBuffer).toBe('ab');
        expect(editor.cursorPosition).toBe(1);
        expect(editor.reshapeAndRender).toHaveBeenCalledTimes(1);
    });

    test('buildClusterMap marks // cluster as atomic', () => {
        const editor = makeEditor();
        editor.textBuffer = 'a//b';
        editor.shapedGlyphs = [
            { cl: 0, ax: 100, dx: 0, dy: 0, g: 1 },
            { cl: 1, ax: 100, dx: 0, dy: 0, g: 2 },
            { cl: 3, ax: 100, dx: 0, dy: 0, g: 3 }
        ];

        editor.buildClusterMap();

        const escapedCluster = editor.clusterMap.find((c) => c.start === 1);
        expect(escapedCluster).toBeTruthy();
        expect(escapedCluster.end).toBe(3);
        expect(escapedCluster.isAtomicCluster).toBe(true);
    });

    test('click in middle of // cluster snaps to boundary, not interior', () => {
        const editor = makeEditor();
        editor.textBuffer = 'a//b';
        editor.clusterMap = [
            {
                glyphIndex: 1,
                glyphCount: 1,
                start: 1,
                end: 3,
                x: 100,
                width: 100,
                isRTL: false,
                isExplicitToken: false,
                isAtomicCluster: true
            }
        ];

        const logicalPos = editor.getGlyphIndexAtClick(150, 0);
        expect(logicalPos).toBe(1);
    });

    test('handleKeyDown keeps escaped slash atomic through typing, arrows, and backspace', () => {
        const editor = makeEditor();
        editor.textBuffer = '';
        editor.cursorPosition = 0;
        const makeEvent = (key, extra = {}) => ({
            key,
            code: key === ' ' ? 'Space' : key,
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
            preventDefault: jest.fn(),
            ...extra
        });

        const slashEvent = makeEvent('/');
        editor.handleKeyDown(slashEvent);

        expect(slashEvent.preventDefault).toHaveBeenCalled();
        expect(editor.textBuffer).toBe('//');
        expect(editor.cursorPosition).toBe(2);

        const leftEvent = makeEvent('ArrowLeft');
        editor.handleKeyDown(leftEvent);
        expect(editor.cursorPosition).toBe(0);

        const rightEvent = makeEvent('ArrowRight');
        editor.handleKeyDown(rightEvent);
        expect(editor.cursorPosition).toBe(2);

        const backspaceEvent = makeEvent('Backspace');
        editor.handleKeyDown(backspaceEvent);
        expect(editor.textBuffer).toBe('');
        expect(editor.cursorPosition).toBe(0);
    });

    test('handleKeyDown delete removes escaped slash atomically', () => {
        const editor = makeEditor();
        editor.textBuffer = '';
        editor.cursorPosition = 0;
        const makeEvent = (key, extra = {}) => ({
            key,
            code: key === ' ' ? 'Space' : key,
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
            preventDefault: jest.fn(),
            ...extra
        });

        const slashEvent = makeEvent('/');
        editor.handleKeyDown(slashEvent);
        expect(editor.textBuffer).toBe('//');
        expect(editor.cursorPosition).toBe(2);

        const leftEvent = makeEvent('ArrowLeft');
        editor.handleKeyDown(leftEvent);
        expect(editor.cursorPosition).toBe(0);

        const deleteEvent = makeEvent('Delete');
        editor.handleKeyDown(deleteEvent);
        expect(deleteEvent.preventDefault).toHaveBeenCalled();
        expect(editor.textBuffer).toBe('');
        expect(editor.cursorPosition).toBe(0);
    });
});
