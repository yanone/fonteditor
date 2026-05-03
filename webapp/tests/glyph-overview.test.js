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

    test('batches multi-glyph change details from a single glyphChanged event', async () => {
        overview.tiles.set('glyph-b', {
            glyphId: 'glyph-b',
            glyphName: 'b',
            selected: false,
            element: document.createElement('div'),
            cachedData: { name: 'b', stale: true }
        });
        window.fontCompilation.sendMessage.mockResolvedValue({
            outlinesJson: JSON.stringify([{ name: 'a' }, { name: 'b' }])
        });

        window.dispatchEvent(
            new CustomEvent('glyphChanged', {
                detail: { glyphName: 'a', glyphNames: ['a', 'b'] }
            })
        );

        jest.advanceTimersByTime(500);
        await Promise.resolve();

        expect(window.fontCompilation.sendMessage).not.toHaveBeenCalled();

        window.glyphCanvas.outlineEditor.draggingSomething = false;
        jest.advanceTimersByTime(120);
        await Promise.resolve();
        await Promise.resolve();

        expect(window.fontCompilation.sendMessage).toHaveBeenLastCalledWith({
            type: 'getGlyphOutlines',
            glyphNames: ['a', 'b'],
            location: {},
            flattenComponents: false
        });
        expect(overview.renderTile).toHaveBeenCalledTimes(2);
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

describe('GlyphOverview scroll visibility queueing', () => {
    let GlyphOverview;
    let overview;
    let parent;

    const visibleRect = {
        top: 40,
        bottom: 140,
        left: 0,
        right: 120,
        width: 120,
        height: 100
    };

    beforeEach(() => {
        jest.useFakeTimers();
        jest.resetModules();

        global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
        global.cancelAnimationFrame = (id) => clearTimeout(id);

        global.IntersectionObserver = class IntersectionObserver {
            observe() {}

            disconnect() {}
        };
        window.IntersectionObserver = global.IntersectionObserver;

        require('../js/glyph-overview');
        GlyphOverview = window.GlyphOverview;

        document.body.innerHTML = '';
        parent = document.createElement('div');
        document.body.appendChild(parent);

        overview = new GlyphOverview(parent);
        overview.lazyLoadEnabled = true;

        overview.container.getBoundingClientRect = jest.fn(() => ({
            top: 0,
            bottom: 200,
            left: 0,
            right: 200,
            width: 200,
            height: 200
        }));

        jest.spyOn(overview, 'scheduleBatchRender').mockImplementation(
            () => {}
        );
        overview.setupLazyLoading();
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
        delete global.IntersectionObserver;
        delete window.IntersectionObserver;
        delete window.GlyphOverview;
    });

    function installUncachedTile(overviewInstance, glyphId, glyphName) {
        const element = document.createElement('div');
        element.dataset.glyphId = glyphId;
        const canvas = document.createElement('canvas');
        element.appendChild(canvas);
        overviewInstance.container.appendChild(element);

        const tile = {
            glyphId,
            glyphName,
            selected: false,
            element,
            canvas,
            cachedData: undefined
        };

        overviewInstance.tiles = new Map([[glyphId, tile]]);
        return tile;
    }

    test('queues newly visible uncached tiles when the overview container scrolls', () => {
        const tile = installUncachedTile(overview, 'glyph-1', 'g1');
        tile.element.getBoundingClientRect = jest
            .fn()
            .mockReturnValueOnce({
                top: 340,
                bottom: 440,
                left: 0,
                right: 120,
                width: 120,
                height: 100
            })
            .mockReturnValue(visibleRect);

        overview.container.dispatchEvent(new Event('scroll'));
        jest.runOnlyPendingTimers();
        expect(Array.from(overview.pendingGlyphIds)).toEqual([]);

        overview.container.dispatchEvent(new Event('scroll'));
        jest.runOnlyPendingTimers();

        expect(Array.from(overview.pendingGlyphIds)).toEqual(['glyph-1']);
        expect(overview.scheduleBatchRender).toHaveBeenCalledTimes(1);
    });

    test('queues newly visible uncached tiles when an ancestor overview surface scrolls', () => {
        const tile = installUncachedTile(overview, 'glyph-2', 'g2');
        tile.element.getBoundingClientRect = jest.fn(() => visibleRect);

        parent.dispatchEvent(new Event('scroll'));
        jest.runOnlyPendingTimers();

        expect(Array.from(overview.pendingGlyphIds)).toEqual(['glyph-2']);
        expect(overview.scheduleBatchRender).toHaveBeenCalledTimes(1);
    });
});

describe('GlyphOverview initial active tile highlighting', () => {
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

        overview = new GlyphOverview(parent);
        jest.spyOn(overview, 'scheduleHighlightedGlyphVisibilitySync');
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
        delete window.GlyphOverview;
    });

    test('applies the active highlight when the tile is created after the glyph name is already known', () => {
        overview.highlightedGlyphName = 'A';

        const tile = overview.createGlyphTile('glyph-1', 'A');

        expect(tile.element.style.boxShadow).toBe(
            'inset 0 0 0 2px var(--accent-blue)'
        );
    });

    test('reapplies the active highlight for the same glyph when sync runs again later', () => {
        overview.highlightedGlyphName = 'A';
        const tile = overview.createGlyphTile('glyph-1', 'A');
        tile.element.style.boxShadow = '';
        overview.tiles = new Map([['glyph-1', tile]]);

        overview.setEditingHighlight('A');

        expect(tile.element.style.boxShadow).toBe(
            'inset 0 0 0 2px var(--accent-blue)'
        );
        expect(
            overview.scheduleHighlightedGlyphVisibilitySync
        ).toHaveBeenCalledTimes(1);
    });
});

describe('GlyphOverview double-click insertion', () => {
    let GlyphOverview;
    let overview;
    let parent;
    let insertText;
    let insertTextAfterSelectedGlyph;

    beforeEach(() => {
        jest.resetModules();

        require('../js/glyph-overview');
        GlyphOverview = window.GlyphOverview;

        document.body.innerHTML = '';
        parent = document.createElement('div');
        document.body.appendChild(parent);

        insertText = jest.fn();
        insertTextAfterSelectedGlyph = jest.fn();
        window.glyphCanvas = {
            outlineEditor: {
                active: false
            },
            textRunEditor: {
                insertText,
                insertTextAfterSelectedGlyph
            }
        };

        overview = new GlyphOverview(parent);
        jest.spyOn(overview, 'isViewActive').mockReturnValue(true);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete window.glyphCanvas;
        delete window.GlyphOverview;
    });

    test('inserts the double-clicked glyph even when restoring an older selection', () => {
        const tileA = overview.createGlyphTile('glyph-a', 'A');
        const tileB = overview.createGlyphTile('glyph-b', 'B');

        overview.tiles = new Map([
            ['glyph-a', tileA],
            ['glyph-b', tileB]
        ]);

        overview.selectTile('glyph-a');

        tileB.element.dispatchEvent(
            new MouseEvent('click', { bubbles: true, detail: 1 })
        );
        tileB.element.dispatchEvent(
            new MouseEvent('dblclick', { bubbles: true, detail: 2 })
        );

        expect(insertText).toHaveBeenCalledWith('/B ');
        expect(tileA.selected).toBe(true);
        expect(tileB.selected).toBe(false);
    });

    test('uses edit-mode insertion after the active glyph when the outline editor is active', () => {
        const tileB = overview.createGlyphTile('glyph-b', 'B');
        window.glyphCanvas.outlineEditor.active = true;

        tileB.element.dispatchEvent(
            new MouseEvent('dblclick', { bubbles: true, detail: 2 })
        );

        expect(insertTextAfterSelectedGlyph).toHaveBeenCalledWith('/B ');
        expect(insertText).not.toHaveBeenCalled();
    });
});
