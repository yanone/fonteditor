const {
    resolveHighlightedEditTool,
    resolvePointerBadgeTool,
    chooseDefaultStickyEditTool,
    ensureStickyEditToolAvailable,
    shortcutKeyToStickyEditTool
} = require('../js/glyph-canvas/edit-tools.ts');

describe('edit-tools helpers', () => {
    test('text mode always highlights the text tool', () => {
        expect(
            resolveHighlightedEditTool({
                isEditMode: false,
                stickyTool: 'select',
                cmdKeyPressed: true,
                altKeyPressed: true,
                hasAddPointPreview: true
            })
        ).toBe('text');
    });

    test('maps Cmd/Alt modifiers onto toolbar highlights', () => {
        expect(
            resolveHighlightedEditTool({
                isEditMode: true,
                stickyTool: 'select',
                cmdKeyPressed: true,
                altKeyPressed: false,
                hasAddPointPreview: false
            })
        ).toBe('pen');

        expect(
            resolveHighlightedEditTool({
                isEditMode: true,
                stickyTool: 'select',
                cmdKeyPressed: true,
                altKeyPressed: false,
                hasAddPointPreview: true
            })
        ).toBe('insert');

        expect(
            resolveHighlightedEditTool({
                isEditMode: true,
                stickyTool: 'select',
                cmdKeyPressed: false,
                altKeyPressed: true,
                hasAddPointPreview: false
            })
        ).toBe('convert');
    });

    test('restores sticky tool when modifiers are released', () => {
        expect(
            resolveHighlightedEditTool({
                isEditMode: true,
                stickyTool: 'select',
                cmdKeyPressed: false,
                altKeyPressed: false,
                hasAddPointPreview: false
            })
        ).toBe('select');
    });

    test('pointer badges follow insert/convert highlights', () => {
        expect(resolvePointerBadgeTool('insert')).toBe('insert');
        expect(resolvePointerBadgeTool('convert')).toBe('convert');
        expect(resolvePointerBadgeTool('pen')).toBeNull();
        expect(resolvePointerBadgeTool('text')).toBeNull();
    });

    test('defaults to select even when the layer is empty', () => {
        expect(
            chooseDefaultStickyEditTool({
                text: true,
                select: true,
                pen: true,
                insert: false,
                convert: false
            })
        ).toBe('select');

        expect(
            chooseDefaultStickyEditTool({
                text: true,
                select: false,
                pen: true,
                insert: false,
                convert: false
            })
        ).toBe('select');

        expect(
            ensureStickyEditToolAvailable('insert', {
                text: true,
                select: true,
                pen: true,
                insert: false,
                convert: false
            })
        ).toBe('select');
    });

    test('maps tool shortcut keys including I for insert', () => {
        expect(shortcutKeyToStickyEditTool('t')).toBe('text');
        expect(shortcutKeyToStickyEditTool('V')).toBe('select');
        expect(shortcutKeyToStickyEditTool('p')).toBe('pen');
        expect(shortcutKeyToStickyEditTool('i')).toBe('insert');
        expect(shortcutKeyToStickyEditTool('n')).toBeNull();
        expect(shortcutKeyToStickyEditTool('c')).toBe('convert');
    });
});
