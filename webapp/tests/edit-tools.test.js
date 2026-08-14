const {
    resolveHighlightedEditTool,
    resolvePointerBadge,
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

    test('pointer badges follow insert/convert/cut highlights', () => {
        expect(resolvePointerBadgeTool('insert')).toBe('insert');
        expect(resolvePointerBadgeTool('convert')).toBe('convert');
        expect(resolvePointerBadgeTool('cut')).toBe('cut');
        expect(resolvePointerBadgeTool('pen')).toBeNull();
        expect(resolvePointerBadgeTool('text')).toBeNull();
    });

    test('Cmd hover over a cuttable node shows the cut badge without highlighting Cut', () => {
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
            resolvePointerBadge({
                highlightedTool: 'pen',
                cmdKeyPressed: true,
                hoveringCuttableNode: true
            })
        ).toBe('cut');

        expect(
            resolvePointerBadge({
                highlightedTool: 'pen',
                cmdKeyPressed: true,
                hoveringCuttableNode: false
            })
        ).toBeNull();
    });

    test('defaults to select even when the layer is empty', () => {
        expect(
            chooseDefaultStickyEditTool({
                text: true,
                select: true,
                pen: true,
                insert: false,
                convert: false,
                cut: false
            })
        ).toBe('select');

        expect(
            chooseDefaultStickyEditTool({
                text: true,
                select: false,
                pen: true,
                insert: false,
                convert: false,
                cut: false
            })
        ).toBe('select');

        expect(
            ensureStickyEditToolAvailable('insert', {
                text: true,
                select: true,
                pen: true,
                insert: false,
                convert: false,
                cut: false
            })
        ).toBe('select');

        expect(
            ensureStickyEditToolAvailable('cut', {
                text: true,
                select: true,
                pen: true,
                insert: false,
                convert: false,
                cut: false
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
        expect(shortcutKeyToStickyEditTool('x')).toBeNull();
        expect(shortcutKeyToStickyEditTool('k')).toBeNull();
    });
});
