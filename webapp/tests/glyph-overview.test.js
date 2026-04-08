jest.mock('../js/glyph-tile-renderer-fast', () => ({
    fastGlyphTileRenderer: {
        updateThemeColors: jest.fn()
    }
}));

jest.mock('../js/glyph-overview-filters', () => ({}));

describe('GlyphOverview glyphChanged refresh scheduling', () => {
    let GlyphOverview;
    let overview;
    let parent;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.resetModules();

        global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
        global.cancelAnimationFrame = (id) => clearTimeout(id);

        require('../js/glyph-overview');
        GlyphOverview = window.GlyphOverview;

        document.body.innerHTML = '';
        parent = document.createElement('div');
        document.body.appendChild(parent);

        window.fontCompilation = {
            sendMessage: jest.fn().mockResolvedValue({
                outlinesJson: JSON.stringify([{ name: 'a' }])
            })
        };
        window.glyphCanvas = {
            outlineEditor: {
                active: true
            }
        };

        overview = new GlyphOverview(parent);
        overview.tiles = new Map([
            [
                'glyph-a',
                {
                    glyphId: 'glyph-a',
                    glyphName: 'a',
                    selected: false,
                    element: document.createElement('div'),
                    cachedData: { name: 'a', stale: true }
                }
            ]
        ]);
        overview.renderTile = jest.fn();
        overview.getTileDimensions = jest.fn(() => ({
            width: 120,
            height: 140
        }));
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
        delete window.fontCompilation;
        delete window.glyphCanvas;
        delete window.GlyphOverview;
    });

    test('defers glyph outline refreshes while outline editing is active and flushes once on text mode', async () => {
        window.dispatchEvent(
            new CustomEvent('glyphChanged', {
                detail: { glyphName: 'a' }
            })
        );

        jest.advanceTimersByTime(500);
        await Promise.resolve();

        expect(window.fontCompilation.sendMessage).not.toHaveBeenCalled();

        window.glyphCanvas.outlineEditor.active = false;
        window.dispatchEvent(
            new CustomEvent('editorModeChanged', {
                detail: { mode: 'text' }
            })
        );

        jest.advanceTimersByTime(0);
        await Promise.resolve();
        await Promise.resolve();

        expect(window.fontCompilation.sendMessage).toHaveBeenCalledTimes(1);
        expect(window.fontCompilation.sendMessage).toHaveBeenCalledWith({
            type: 'getGlyphOutlines',
            glyphNames: ['a'],
            location: {},
            flattenComponents: false
        });
        expect(overview.renderTile).toHaveBeenCalledTimes(1);
    });
});
