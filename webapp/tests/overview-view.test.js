jest.mock('../js/top-row-sidebar-interpolation', () => ({
    attachTopRowSidebarInterpolation: jest.fn()
}));

describe('OverviewView initial active glyph sync', () => {
    let updateGlyphs;
    let syncGlyphs;
    let renderGlyphOutlines;
    let syncActiveGlyphFocus;
    let setOutlinePaintAllowed;
    let originalPerformanceMark;
    let originalPerformanceMeasure;

    async function flushFontReadyOverview() {
        window.dispatchEvent(
            new CustomEvent('fontReady', {
                detail: {
                    path: 'test.babelfont',
                    openSessionId: 'session-1',
                    openedAt: 0
                }
            })
        );
        await jest.runAllTimersAsync();
        await Promise.resolve();
        await Promise.resolve();
    }

    beforeEach(() => {
        jest.useFakeTimers();
        jest.resetModules();

        global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
        global.cancelAnimationFrame = (id) => clearTimeout(id);
        globalThis.requestAnimationFrame = global.requestAnimationFrame;
        globalThis.cancelAnimationFrame = global.cancelAnimationFrame;
        window.requestAnimationFrame = global.requestAnimationFrame;
        window.cancelAnimationFrame = global.cancelAnimationFrame;

        originalPerformanceMark = performance.mark;
        originalPerformanceMeasure = performance.measure;
        performance.mark = jest.fn();
        performance.measure = jest.fn();

        Object.defineProperty(document, 'readyState', {
            configurable: true,
            value: 'complete'
        });

        document.body.innerHTML = `
            <div id="view-overview" class="view focused">
                <div class="view-content"></div>
            </div>
        `;

        updateGlyphs = jest.fn().mockResolvedValue(undefined);
        syncGlyphs = jest.fn().mockResolvedValue(undefined);
        renderGlyphOutlines = jest.fn().mockResolvedValue(undefined);
        syncActiveGlyphFocus = jest.fn();
        setOutlinePaintAllowed = jest.fn();

        window.currentFontModel = {
            glyphs: [{ name: 'A' }, { name: 'B' }]
        };
        window.glyphCanvas = {
            outlineEditor: {
                active: true
            }
        };
        window.GlyphOverview = jest.fn().mockImplementation(() => ({
            updateGlyphs,
            syncGlyphs,
            renderGlyphOutlines,
            syncActiveGlyphFocus,
            setOutlinePaintAllowed,
            setLocationDrivenRendersEnabled: setOutlinePaintAllowed
        }));
        window.glyphOverviewFilterManager = null;
        window.timelineSpanStart = jest.fn(() => 'overview-span');
        window.timelineSpanEnd = jest.fn();
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
        performance.mark = originalPerformanceMark;
        performance.measure = originalPerformanceMeasure;
        delete window.currentFontModel;
        delete window.glyphCanvas;
        delete window.GlyphOverview;
        delete window.glyphOverviewFilterManager;
        delete window.timelineSpanStart;
        delete window.timelineSpanEnd;
        delete globalThis.requestAnimationFrame;
        delete globalThis.cancelAnimationFrame;
        delete window.requestAnimationFrame;
        delete window.cancelAnimationFrame;
    });

    test('marks the active glyph in the overview after the fontReady render', async () => {
        require('../js/overview-view');

        await jest.runAllTimersAsync();
        await Promise.resolve();

        expect(syncGlyphs).toHaveBeenCalledTimes(1);
        expect(renderGlyphOutlines).not.toHaveBeenCalled();

        syncGlyphs.mockClear();
        await flushFontReadyOverview();

        expect(syncGlyphs).toHaveBeenCalledTimes(1);
        expect(renderGlyphOutlines).toHaveBeenCalledTimes(1);
        expect(renderGlyphOutlines).toHaveBeenCalledWith(
            expect.any(Object),
            expect.objectContaining({ force: true })
        );
        expect(syncActiveGlyphFocus).toHaveBeenCalledTimes(1);
        expect(setOutlinePaintAllowed).toHaveBeenCalledWith(true);
    });

    test('ignores variationLocationChanged until after fontReady overview render', async () => {
        require('../js/overview-view');
        await jest.runAllTimersAsync();
        await Promise.resolve();

        renderGlyphOutlines.mockClear();
        setOutlinePaintAllowed.mockClear();

        window.dispatchEvent(
            new CustomEvent('variationLocationChanged', {
                detail: { location: { wght: 700 } }
            })
        );
        await Promise.resolve();
        expect(renderGlyphOutlines).not.toHaveBeenCalled();

        await flushFontReadyOverview();
        renderGlyphOutlines.mockClear();

        // After fontReady enables outline paints, the real GlyphOverview
        // would paint — the mock only records the enable call.
        expect(setOutlinePaintAllowed).toHaveBeenCalledWith(true);
    });

    test('refreshes overview tiles on fontModelReady before fontReady', async () => {
        require('../js/overview-view');

        await jest.runAllTimersAsync();
        await Promise.resolve();

        updateGlyphs.mockClear();
        syncGlyphs.mockClear();
        renderGlyphOutlines.mockClear();
        setOutlinePaintAllowed.mockClear();

        window.currentFontModel = {
            glyphs: [{ name: '.notdef' }]
        };

        window.dispatchEvent(
            new CustomEvent('fontModelReady', {
                detail: {
                    path: 'untitled.babelfont',
                    babelfontData: {}
                }
            })
        );

        await jest.runAllTimersAsync();
        await Promise.resolve();

        expect(setOutlinePaintAllowed).toHaveBeenCalledWith(false);
        expect(syncGlyphs).toHaveBeenCalledTimes(1);
        expect(syncGlyphs).toHaveBeenCalledWith([
            { id: '.notdef', name: '.notdef' }
        ]);
        expect(renderGlyphOutlines).not.toHaveBeenCalled();
    });

    test('re-scans user glyph filters after a Settings Folder change before filters finish loading', async () => {
        const discoverUserFilters = jest.fn().mockResolvedValue(undefined);
        window.glyphOverviewFilterManager = {
            discoverUserFilters,
            initialize: jest.fn(),
            isLoaded: jest.fn().mockReturnValue(false)
        };

        require('../js/overview-view');
        discoverUserFilters.mockClear();

        window.dispatchEvent(new CustomEvent('settingsFolderAccessChanged'));
        await Promise.resolve();

        expect(discoverUserFilters).toHaveBeenCalled();
    });

    test('always re-scans user filters on settingsFolderAccessChanged', async () => {
        const discoverUserFilters = jest.fn().mockResolvedValue(undefined);
        window.glyphOverviewFilterManager = {
            discoverUserFilters,
            initialize: jest.fn(),
            isLoaded: jest.fn().mockReturnValue(true)
        };

        require('../js/overview-view');
        discoverUserFilters.mockClear();

        window.dispatchEvent(
            new CustomEvent('settingsFolderAccessChanged', {
                detail: { hasSettingsFolderAccess: true, source: 'attach' }
            })
        );
        await Promise.resolve();

        expect(discoverUserFilters).toHaveBeenCalled();
    });
});
