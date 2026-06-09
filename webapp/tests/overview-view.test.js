jest.mock('../js/top-row-sidebar-interpolation', () => ({
    attachTopRowSidebarInterpolation: jest.fn()
}));

describe('OverviewView initial active glyph sync', () => {
    let updateGlyphs;
    let renderGlyphOutlines;
    let syncActiveGlyphFocus;
    let originalPerformanceMark;
    let originalPerformanceMeasure;

    async function flushOverviewInit() {
        jest.advanceTimersByTime(500);
        await jest.runAllTimersAsync();
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
        renderGlyphOutlines = jest.fn().mockResolvedValue(undefined);
        syncActiveGlyphFocus = jest.fn();

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
            renderGlyphOutlines,
            syncActiveGlyphFocus
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

    test('marks the active glyph in the overview after the initial render', async () => {
        require('../js/overview-view');

        await flushOverviewInit();

        expect(updateGlyphs).toHaveBeenCalledTimes(1);
        expect(renderGlyphOutlines).toHaveBeenCalledTimes(1);
        expect(syncActiveGlyphFocus).toHaveBeenCalledTimes(1);
    });

    test('refreshes overview tiles on fontModelReady before fontReady', async () => {
        require('../js/overview-view');

        await flushOverviewInit();

        updateGlyphs.mockClear();
        renderGlyphOutlines.mockClear();

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

        expect(updateGlyphs).toHaveBeenCalledTimes(1);
        expect(updateGlyphs).toHaveBeenCalledWith([
            { id: '0', name: '.notdef' }
        ]);
        expect(renderGlyphOutlines).not.toHaveBeenCalled();
    });
});
