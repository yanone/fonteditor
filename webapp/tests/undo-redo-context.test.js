import { getUndoRedoContext } from '../js/undo-redo-context';

describe('getUndoRedoContext', () => {
    const originalGlyphCanvas = window.glyphCanvas;
    const originalGetHistoryUndoContext = window.getHistoryUndoContext;

    afterEach(() => {
        window.glyphCanvas = originalGlyphCanvas;
        window.getHistoryUndoContext = originalGetHistoryUndoContext;
    });

    test('prefers active outline editor stack and layer over history-view glyph scope', () => {
        window.glyphCanvas = {
            outlineEditor: {
                active: true,
                selectedLayerId: 'layer-1',
                parseGlyphStack: jest.fn(() => [
                    { glyphName: 'a' },
                    { glyphName: 'a.alt' }
                ])
            }
        };
        window.getHistoryUndoContext = jest.fn(() => ({
            scope: 'glyph',
            glyphName: 'a',
            layerId: null,
            historyTargetKey: null
        }));

        expect(getUndoRedoContext()).toEqual({
            rootGlyphName: 'a',
            undoGlyphName: 'a.alt',
            undoLayerId: 'layer-1',
            historyTargetKey: null
        });
    });
});
