import { getUndoRedoContext } from '../js/undo-redo-context';

describe('getUndoRedoContext', () => {
    const originalGlyphCanvas = window.glyphCanvas;
    const originalGetHistoryUndoContext = window.getHistoryUndoContext;
    let fontInfoView;
    let featuresTab;

    beforeEach(() => {
        fontInfoView = document.createElement('div');
        fontInfoView.id = 'view-fontinfo';
        document.body.appendChild(fontInfoView);

        featuresTab = document.createElement('div');
        featuresTab.id = 'fontinfo-features-content';
        featuresTab.style.display = 'none';
        document.body.appendChild(featuresTab);
    });

    afterEach(() => {
        window.glyphCanvas = originalGlyphCanvas;
        window.getHistoryUndoContext = originalGetHistoryUndoContext;
        fontInfoView?.remove();
        featuresTab?.remove();
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

    test('preserves font scope over active outline editor layer context', () => {
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
            scope: 'font',
            glyphName: null,
            layerId: null,
            historyTargetKey: null
        }));

        expect(getUndoRedoContext()).toEqual({
            rootGlyphName: 'a',
            undoGlyphName: undefined,
            undoLayerId: null,
            historyTargetKey: null
        });
    });

    test('preserves feature scope over active outline editor layer context', () => {
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
            scope: 'feature',
            glyphName: null,
            layerId: null,
            historyTargetKey: 'feature:kern'
        }));

        expect(getUndoRedoContext()).toEqual({
            rootGlyphName: 'a',
            undoGlyphName: undefined,
            undoLayerId: null,
            historyTargetKey: 'feature:kern'
        });
    });

    test('prefers font scope when Font Info view is focused on a non-feature tab', () => {
        fontInfoView.classList.add('focused');
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
            scope: 'layer',
            glyphName: 'a',
            layerId: 'layer-1',
            historyTargetKey: null
        }));

        expect(getUndoRedoContext()).toEqual({
            rootGlyphName: 'a',
            undoGlyphName: undefined,
            undoLayerId: null,
            historyTargetKey: null
        });
    });

    test('preserves feature scope when Font Info features tab is focused', () => {
        fontInfoView.classList.add('focused');
        featuresTab.style.display = 'block';
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
            scope: 'feature',
            glyphName: null,
            layerId: null,
            historyTargetKey: 'feature:kern'
        }));

        expect(getUndoRedoContext()).toEqual({
            rootGlyphName: 'a',
            undoGlyphName: undefined,
            undoLayerId: null,
            historyTargetKey: 'feature:kern'
        });
    });
});
