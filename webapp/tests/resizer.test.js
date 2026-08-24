describe('ResizableViews startup layout restore', () => {
    function installTopRowMetrics() {
        const topRow = document.querySelector('.top-row');
        if (!topRow) {
            throw new Error('Missing top row');
        }

        Object.defineProperty(topRow, 'offsetWidth', {
            configurable: true,
            get: () => 1000
        });

        const views = Array.from(topRow.querySelectorAll('.view'));
        views.forEach((view) => {
            const element = view;
            const getWidth = () => {
                const flex = element.style.flex.trim();
                if (flex.startsWith('0 0')) {
                    const collapsedWidth = Number.parseFloat(
                        flex.split(' ')[2]
                    );
                    return Number.isFinite(collapsedWidth)
                        ? collapsedWidth
                        : 24;
                }

                const explicitWidth = Number.parseFloat(flex);
                if (Number.isFinite(explicitWidth) && explicitWidth > 0) {
                    if (explicitWidth <= 1.5) {
                        return explicitWidth * 1000;
                    }
                    return explicitWidth;
                }

                return element.id === 'view-editor' ? 952 : 24;
            };

            Object.defineProperty(element, 'offsetWidth', {
                configurable: true,
                get: getWidth
            });

            element.getBoundingClientRect = () => {
                const width = getWidth();
                return {
                    width,
                    height: 240,
                    top: 0,
                    left: 0,
                    right: width,
                    bottom: 240,
                    x: 0,
                    y: 0,
                    toJSON() {
                        return {};
                    }
                };
            };
        });
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

        Object.defineProperty(document, 'readyState', {
            configurable: true,
            value: 'complete'
        });

        document.body.innerHTML = `
            <div class="container">
                <div class="top-row">
                    <div id="view-fontinfo" class="view view-fontinfo"></div>
                    <div class="vertical-divider"></div>
                    <div id="view-overview" class="view view-overview"></div>
                    <div class="vertical-divider"></div>
                    <div id="view-editor" class="view view-editor"></div>
                </div>
                <div class="horizontal-divider"></div>
                <div class="bottom-row">
                    <div id="view-history" class="view view-history"></div>
                </div>
            </div>
        `;

        installTopRowMetrics();
        window.getViewVisitOrder = jest.fn(() => ({
            top: ['view-fontinfo', 'view-overview', 'view-editor'],
            bottom: ['view-history']
        }));
        window.setViewVisitOrder = jest.fn();

        localStorage.setItem(
            'windowUi.main',
            'v1;docs=-;rows=100,-;top=0,0,100'
        );
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
        localStorage.clear();
        delete window.resizableViews;
        delete globalThis.requestAnimationFrame;
        delete globalThis.cancelAnimationFrame;
        delete window.requestAnimationFrame;
        delete window.cancelAnimationFrame;
        delete window.getViewVisitOrder;
        delete window.setViewVisitOrder;
    });

    test('marks restored top-row collapsed panes as collapsed-width before interaction', () => {
        require('../js/resizer');

        jest.advanceTimersByTime(100);
        jest.runOnlyPendingTimers();

        expect(
            document
                .getElementById('view-fontinfo')
                .classList.contains('collapsed-width')
        ).toBe(true);
        expect(
            document
                .getElementById('view-overview')
                .classList.contains('collapsed-width')
        ).toBe(true);
        expect(
            document
                .getElementById('view-editor')
                .classList.contains('collapsed-width')
        ).toBe(false);
        expect(window.setViewVisitOrder).not.toHaveBeenCalled();
    });

    test('does not collapse a restored open editor when measured width is still 0', () => {
        localStorage.setItem(
            'windowUi.main',
            'v1;docs=-;rows=60,40;top=0,40,60;bottom=25,25,25,25'
        );
        require('../js/resizer');
        jest.advanceTimersByTime(100);
        jest.runOnlyPendingTimers();

        const editor = document.getElementById('view-editor');
        editor.getBoundingClientRect = () => ({
            width: 0,
            height: 0,
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            x: 0,
            y: 0,
            toJSON() {
                return {};
            }
        });
        Object.defineProperty(editor, 'offsetWidth', {
            configurable: true,
            get: () => 0
        });

        window.resizableViews.updateCollapsedStates({ allowFocusShift: false });

        expect(editor.classList.contains('collapsed-width')).toBe(false);
        expect(editor.style.flex.startsWith('0 0')).toBe(false);
    });

    test('strips width-collapse chrome from bottom-row panes', () => {
        require('../js/resizer');
        jest.advanceTimersByTime(100);
        jest.runOnlyPendingTimers();

        const history = document.getElementById('view-history');
        history.classList.add('collapsed-width');
        history.style.flex = '40 1 0%';
        Object.defineProperty(history, 'offsetWidth', {
            configurable: true,
            get: () => 400
        });
        Object.defineProperty(history.closest('.bottom-row'), 'offsetHeight', {
            configurable: true,
            get: () => 280
        });

        window.resizableViews.updateCollapsedStates({
            allowFocusShift: false
        });

        expect(history.classList.contains('collapsed-width')).toBe(false);
        expect(history.classList.contains('collapsed')).toBe(false);
    });

    test('persists chrome layout on the per-window UI string, not visit order', () => {
        require('../js/resizer');

        window.resizableViews.saveLayout();

        const stored = localStorage.getItem('windowUi.main');
        expect(stored).toMatch(/^v1;/);
        expect(stored).toContain('docs=-');
        expect(localStorage.getItem('viewLayout')).toBeNull();
        expect(stored).not.toContain('visitOrder');
    });
});
