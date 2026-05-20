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

        localStorage.setItem(
            'viewLayout',
            JSON.stringify({
                horizontal: {
                    top: '1',
                    bottom: '0 0 24px'
                },
                vertical: {
                    top: ['0.01', '0.01', '0.98'],
                    bottom: ['1']
                }
            })
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
    });
});
