jest.mock('../js/glyph-tile-renderer-fast', () => ({
    fastGlyphTileRenderer: {
        renderToCanvas: jest.fn(),
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
                active: true,
                draggingSomething: true
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

    test('defers glyph outline refreshes while dragging and flushes once after drag ends', async () => {
        window.dispatchEvent(
            new CustomEvent('glyphChanged', {
                detail: { glyphName: 'a' }
            })
        );

        jest.advanceTimersByTime(500);
        await Promise.resolve();

        expect(window.fontCompilation.sendMessage).not.toHaveBeenCalled();

        window.glyphCanvas.outlineEditor.draggingSomething = false;
        jest.advanceTimersByTime(120);
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

describe('GlyphOverview virtualized lines rendering', () => {
    let GlyphOverview;
    let overview;
    let parent;
    let intersectionObserverCallback;
    let observeSpy;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.resetModules();

        global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
        global.cancelAnimationFrame = (id) => clearTimeout(id);

        observeSpy = jest.fn();
        global.IntersectionObserver = class IntersectionObserver {
            constructor(callback) {
                intersectionObserverCallback = callback;
            }

            observe(target) {
                observeSpy(target);
            }

            disconnect() {}
        };
        window.IntersectionObserver = global.IntersectionObserver;

        require('../js/glyph-overview');
        GlyphOverview = window.GlyphOverview;

        document.body.innerHTML = '';
        parent = document.createElement('div');
        document.body.appendChild(parent);

        overview = new GlyphOverview(parent);
        overview.getTileDimensions = jest.fn(() => ({
            width: 120,
            height: 140
        }));
        overview.getGridColumns = jest.fn(() => 1);

        Object.defineProperty(overview.container, 'clientHeight', {
            configurable: true,
            value: 280
        });
        Object.defineProperty(overview.container, 'scrollTop', {
            configurable: true,
            writable: true,
            value: 426
        });

        overview.visibleGlyphIds = ['glyph-0', 'glyph-1', 'glyph-2', 'glyph-3'];
        overview.glyphDataById = new Map(
            overview.visibleGlyphIds.map((glyphId, index) => [
                glyphId,
                { id: glyphId, name: `g${index}` }
            ])
        );

        const firstElement = document.createElement('div');
        firstElement.dataset.glyphId = 'glyph-0';
        const firstCanvas = document.createElement('canvas');
        firstElement.appendChild(firstCanvas);
        overview.tiles = new Map([
            [
                'glyph-0',
                {
                    glyphId: 'glyph-0',
                    glyphName: 'g0',
                    selected: false,
                    element: firstElement,
                    canvas: firstCanvas,
                    cachedData: undefined
                }
            ]
        ]);

        overview.setupLazyLoading();
        jest.spyOn(overview, 'scheduleBatchRender').mockImplementation(
            () => {}
        );
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
        delete global.IntersectionObserver;
        delete window.IntersectionObserver;
        delete window.GlyphOverview;
        intersectionObserverCallback = null;
    });

    test('creates and queues missing visible tiles when virtualization scrolls them into view', () => {
        overview.renderVirtualizedLinesWindow(true);

        expect(overview.tiles.size).toBe(4);
        expect(Array.from(overview.pendingGlyphIds)).toEqual([
            'glyph-0',
            'glyph-1',
            'glyph-2',
            'glyph-3'
        ]);
        expect(overview.scheduleBatchRender).toHaveBeenCalledTimes(1);
        expect(observeSpy).toHaveBeenCalledTimes(5);
        expect(intersectionObserverCallback).toBeInstanceOf(Function);
    });
});
