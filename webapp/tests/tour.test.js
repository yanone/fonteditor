describe('tour intro', () => {
    let tour;

    function mountToolbar() {
        document.body.innerHTML = `
            <div class="toolbar-right">
                <button id="settings-btn" type="button">Settings</button>
            </div>
            <button id="editor-tool-text" type="button">Text</button>
            <div id="glyph-editor-scroll-content">
                <input
                    class="editor-axis-slider"
                    data-axis-tag="wght"
                    type="range"
                    min="400"
                    max="800"
                    value="800"
                />
                <div class="editor-feature-row">
                    <button type="button" data-feature-tag="ss03">ss03</button>
                    <span>Stylistic Set 3</span>
                </div>
            </div>
            <div id="glyph-properties-section">
                <div class="editor-layers-list">
                    <div class="editor-layer-item" data-master-id="regular">
                        <div class="master-item-name">Regular</div>
                    </div>
                    <div class="editor-layer-item" data-master-id="extrabold">
                        <div class="master-item-name">ExtraBold</div>
                    </div>
                </div>
            </div>
        `;
        document
            .querySelector('[data-feature-tag="ss03"]')
            .addEventListener('click', (event) => {
                event.currentTarget.classList.toggle('enabled');
            });
    }

    function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function waitForSlideFade() {
        await delay(1400);
    }

    async function waitForActionAdvance() {
        const {
            TOUR_FADE_MS,
            TOUR_POST_FADE_BEFORE_APPLY_MS,
            TOUR_AFTER_APPLY_MS
        } = require('../js/tour-spotlight');
        await delay(
            TOUR_FADE_MS * 2 +
                TOUR_POST_FADE_BEFORE_APPLY_MS +
                TOUR_AFTER_APPLY_MS +
                1000
        );
    }

    async function waitForSliderAdvance() {
        const { TOUR_AFTER_SLIDER_MS } = require('../js/tour-spotlight');
        await delay(TOUR_AFTER_SLIDER_MS + 500);
    }

    function mockTourStartDependencies() {
        window.pluginRegistry = {
            get: () => ({ getId: () => 'memory' })
        };
        window.openFont = jest.fn(async () => {
            window.dispatchEvent(
                new CustomEvent('fontInteractiveReady', {
                    detail: { path: '/user/Fustat.glyphs' }
                })
            );
        });
        window.fontManager = {
            currentFont: null,
            hasUnsyncedChanges: () => false
        };
        window.focusView = jest.fn();
        window.resizeView = jest.fn();
        window.currentFontModel = {
            masters: [
                {
                    id: 'regular',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 }
                },
                {
                    id: 'extrabold',
                    name: { dflt: 'ExtraBold' },
                    location: { wght: 800 }
                }
            ]
        };
        window.glyphCanvas = {
            canvas: document.createElement('canvas'),
            outlineEditor: { active: false },
            selectMaster: jest.fn().mockResolvedValue(undefined),
            textRunEditor: {
                setTextBuffer: jest.fn(),
                textBuffer: 'Hämburger',
                selectedGlyphIndex: -1,
                shapedGlyphs: [
                    { ax: 400, dx: 0, dy: 0, cl: 0, g: 1 },
                    { ax: 400, dx: 0, dy: 0, cl: 1, g: 2 },
                    { ax: 400, dx: 0, dy: 0, cl: 2, g: 3 }
                ]
            },
            viewportManager: {
                fontToScreenCoordinates: (x, y) => ({ x, y })
            },
            getTextModeVerticalMetricsBand: () => ({
                lowest: -200,
                highest: 800
            }),
            applyInitialViewportFit: jest.fn().mockResolvedValue(undefined),
            exitGlyphEditMode: jest.fn()
        };
    }

    beforeEach(() => {
        localStorage.clear();
        jest.resetModules();
        delete window.__tourHost;
        delete window.__tourSpotlightHost;
        document.body.innerHTML = '';
        window.isTestMode = () => false;
        mountToolbar();
        mockTourStartDependencies();
        tour = require('../js/tour');
    });

    afterEach(() => {
        require('../js/tour-spotlight').hideTourSpotlight();
        document.querySelector('.info-popup-overlay')?.remove();
    });

    test('does not auto-open until the folder auto-prompt settles', () => {
        expect(document.getElementById('tour-intro-title')).toBeNull();
    });

    test('opens after the folder auto-prompt settles', () => {
        window.dispatchEvent(
            new CustomEvent('folderPermissionsAutoPromptSettled')
        );

        expect(document.getElementById('tour-intro-title').textContent).toBe(
            'Take a Tour'
        );
        expect(
            document.querySelector('.tour-intro-overlay [data-action="start"]')
                .textContent
        ).toBe('Take a Tour');
    });

    test('does not auto-open in ?test=true sessions', () => {
        window.isTestMode = () => true;
        window.dispatchEvent(
            new CustomEvent('folderPermissionsAutoPromptSettled')
        );
        expect(document.getElementById('tour-intro-title')).toBeNull();
    });

    test('does not auto-open when the tour was skipped', () => {
        tour.skipTour();
        window.dispatchEvent(
            new CustomEvent('folderPermissionsAutoPromptSettled')
        );
        expect(document.getElementById('tour-intro-title')).toBeNull();
        expect(document.getElementById('tour-launch-chip').hidden).toBe(false);
    });

    test('skip stores status, closes the modal, and shows the launch chip', () => {
        tour.openTourIntro();
        document
            .querySelector('[data-action="skip"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(document.getElementById('tour-intro-title')).toBeNull();
        expect(localStorage.getItem('tourSkipped')).toBe('true');
        expect(tour.hasSkippedTour()).toBe(true);
        expect(document.getElementById('tour-launch-chip').hidden).toBe(false);
    });

    test('launch chip opens the intro and dismiss hides it', () => {
        tour.skipTour();
        const chip = document.getElementById('tour-launch-chip');
        chip.querySelector('.toolbar-tour-launch-btn').dispatchEvent(
            new MouseEvent('click', { bubbles: true })
        );
        expect(document.getElementById('tour-intro-title')).not.toBeNull();

        document
            .querySelector('[data-action="skip"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));

        chip.querySelector('.toolbar-tour-launch-dismiss').dispatchEvent(
            new MouseEvent('click', { bubbles: true })
        );
        expect(localStorage.getItem('tourLaunchButtonDismissed')).toBe('true');
        expect(chip.hidden).toBe(true);
    });

    test('Take a Tour opens Fustat, then the first spotlight slide', async () => {
        tour.openTourIntro();
        await tour.startTour();

        expect(window.openFont).toHaveBeenCalledWith(
            '/user/Fustat.glyphs',
            undefined,
            expect.objectContaining({
                sourcePluginOverride: expect.anything()
            })
        );
        expect(document.getElementById('tour-intro-title')).toBeNull();
        expect(localStorage.getItem('tourStarted')).toBe('true');
        expect(
            window.glyphCanvas.textRunEditor.setTextBuffer
        ).toHaveBeenCalledWith('Hämburger');
        expect(window.glyphCanvas.selectMaster).toHaveBeenCalledWith(
            'regular',
            { wght: 400 }
        );
        expect(window.focusView).toHaveBeenCalledWith('view-editor');
        expect(window.resizeView).toHaveBeenCalledWith('view-editor');
        expect(document.querySelector('.tour-tooltip h3').textContent).toBe(
            'Text Mode'
        );
        expect(
            document.querySelector('.tippy-box[data-theme="tour"] .tippy-arrow')
        ).not.toBeNull();
        expect(
            document.querySelector('[data-tour-action="continue"]').textContent
        ).toBe('Continue');
    });

    test('Cmd+Shift+R is not captured during the spotlight tour', async () => {
        tour.openTourIntro();
        await tour.startTour();

        const reload = new KeyboardEvent('keydown', {
            key: 'R',
            code: 'KeyR',
            metaKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true
        });
        document.dispatchEvent(reload);
        expect(reload.defaultPrevented).toBe(false);

        const blocked = new KeyboardEvent('keydown', {
            key: 'e',
            code: 'KeyE',
            metaKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true
        });
        document.dispatchEvent(blocked);
        expect(blocked.defaultPrevented).toBe(true);
    });

    test('Cancel on unsaved changes keeps the intro open', async () => {
        window.fontManager = {
            currentFont: {
                name: 'DirtyFont',
                path: '/disk/Other.glyphs',
                sourcePlugin: { getId: () => 'disk' },
                isCloudBacked: () => false
            },
            hasUnsyncedChanges: () => true
        };
        tour.openTourIntro();
        const startPromise = tour.startTour();
        await new Promise((resolve) => setTimeout(resolve, 0));
        document
            .querySelector('[data-action="cancel"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await startPromise;

        expect(document.getElementById('tour-intro-title')).not.toBeNull();
        expect(localStorage.getItem('tourStarted')).toBeNull();
        expect(window.openFont).not.toHaveBeenCalled();
        expect(
            document.querySelector('.tippy-box[data-theme="tour"]')
        ).toBeNull();
    });

    test('Help can open the intro after skip', () => {
        tour.skipTour();
        tour.openTourIntro();
        expect(document.getElementById('tour-intro-title')).not.toBeNull();
    });

    test('Continue opens the ss03 feature slide without a Continue button', async () => {
        tour.openTourIntro();
        await tour.startTour();
        document
            .querySelector('[data-tour-action="continue"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await waitForSlideFade();

        expect(document.querySelector('.tour-tooltip h3').textContent).toBe(
            'Active OpenType features'
        );
        expect(
            document.querySelector('[data-tour-action="continue"]')
        ).toBeNull();
        const paragraphs = [
            ...document.querySelectorAll('.tour-tooltip p')
        ].map((node) => node.textContent);
        expect(paragraphs).toEqual([
            'The OpenType feature buttons will substitute or position glyphs according to features definitions in the font.',
            'Click on Stylistic Set 3 (ss03) to activate it.'
        ]);
        expect(document.querySelector('.tour-tooltip em').textContent).toBe(
            'Click on Stylistic Set 3 (ss03) to activate it.'
        );
        expect(
            document.querySelector('.tour-tooltip em strong').textContent
        ).toBe('ss03');
        expect(window.__tourHost.slideIndex).toBe(1);
        expect(document.querySelector('.tour-spotlight-hit')).not.toBeNull();
    });

    test('clicking ss03 spotlights the sample text, then applies, then advances', async () => {
        const {
            TOUR_FADE_MS,
            TOUR_POST_FADE_BEFORE_APPLY_MS,
            TOUR_AFTER_APPLY_MS
        } = require('../js/tour-spotlight');
        tour.openTourIntro();
        await tour.startTour();
        document
            .querySelector('[data-tour-action="continue"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await waitForSlideFade();

        const button = document.querySelector('[data-feature-tag="ss03"]');
        const root = document.querySelector('.tour-spotlight-root');
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(button.classList.contains('enabled')).toBe(false);

        await delay(TOUR_FADE_MS);
        expect(root.classList.contains('is-visible')).toBe(true);
        expect(root.classList.contains('is-tooltip-visible')).toBe(false);
        expect(button.classList.contains('enabled')).toBe(false);

        await delay(TOUR_FADE_MS + TOUR_POST_FADE_BEFORE_APPLY_MS - 100);
        expect(button.classList.contains('enabled')).toBe(false);
        expect(root.classList.contains('is-visible')).toBe(true);

        await delay(200);
        expect(button.classList.contains('enabled')).toBe(true);

        await delay(TOUR_AFTER_APPLY_MS + TOUR_FADE_MS * 2 + 400);
        expect(window.__tourHost.slideIndex).toBe(2);
        expect(document.querySelector('.tour-tooltip h3').textContent).toBe(
            'Masters List'
        );
        expect(
            document.querySelector('[data-tour-master="ExtraBold"]')
        ).not.toBeNull();
    }, 25000);

    test('clicking ExtraBold opens the axis sliders slide', async () => {
        tour.openTourIntro();
        await tour.startTour();
        document
            .querySelector('[data-tour-action="continue"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await waitForSlideFade();
        document
            .querySelector('[data-feature-tag="ss03"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await waitForActionAdvance();
        await waitForSlideFade();
        document
            .querySelector('[data-master-id="extrabold"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await waitForActionAdvance();

        expect(window.__tourHost.slideIndex).toBe(3);
        expect(document.querySelector('.tour-tooltip h3').textContent).toBe(
            'Axis Sliders'
        );
        expect(
            document.getElementById('glyph-editor-scroll-content').scrollTop
        ).toBe(0);
    }, 25000);

    test('wght slider clamps into 500–700 then advances', async () => {
        const { getTourSlide } = require('../js/tour-slides');
        const { showTourSlide } = require('../js/tour-spotlight');
        let continued = false;
        await showTourSlide(getTourSlide('axis-sliders'), () => {
            continued = true;
        });
        const slider = document.querySelector('[data-axis-tag="wght"]');
        slider.value = '400';
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        expect(slider.value).toBe('500');
        slider.dispatchEvent(new Event('change', { bubbles: true }));
        expect(continued).toBe(false);
        await waitForSliderAdvance();
        expect(continued).toBe(true);

        continued = false;
        await showTourSlide(getTourSlide('axis-sliders'), () => {
            continued = true;
        });
        const again = document.querySelector('[data-axis-tag="wght"]');
        again.value = '650';
        again.dispatchEvent(new Event('input', { bubbles: true }));
        again.value = '800';
        again.dispatchEvent(new Event('input', { bubbles: true }));
        expect(again.value).toBe('700');
    }, 15000);

    test('ss03 prepare scrolls the feature row in the sidebar scroller', async () => {
        const { getTourSlide } = require('../js/tour-slides');
        const container = document.getElementById(
            'glyph-editor-scroll-content'
        );
        const row = document.querySelector('.editor-feature-row');
        Object.defineProperty(container, 'scrollHeight', {
            configurable: true,
            value: 400
        });
        Object.defineProperty(container, 'clientHeight', {
            configurable: true,
            value: 80
        });
        container.scrollTop = 0;
        container.getBoundingClientRect = () => ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 200,
            bottom: 80,
            width: 200,
            height: 80,
            toJSON() {}
        });
        row.getBoundingClientRect = () => ({
            x: 0,
            y: 300,
            left: 0,
            top: 300,
            right: 200,
            bottom: 324,
            width: 200,
            height: 24,
            toJSON() {}
        });

        await getTourSlide('ss03-features').prepare();

        expect(container.scrollTop).toBe(272);
    });

    test('interactive cutouts are not covered by hit pieces', async () => {
        const row = document.querySelector('.editor-feature-row');
        row.getBoundingClientRect = () => ({
            x: 100,
            y: 100,
            left: 100,
            top: 100,
            right: 300,
            bottom: 140,
            width: 200,
            height: 40,
            toJSON() {}
        });
        const { getTourSlide } = require('../js/tour-slides');
        const { showTourSlide } = require('../js/tour-spotlight');
        await showTourSlide(getTourSlide('ss03-features'), () => {});

        const pieces = [
            ...document.querySelectorAll('.tour-spotlight-hit-piece')
        ];
        expect(pieces.length).toBeGreaterThan(0);
        const coversHole = pieces.some((el) => {
            const left = parseFloat(el.style.left);
            const top = parseFloat(el.style.top);
            const right = left + parseFloat(el.style.width);
            const bottom = top + parseFloat(el.style.height);
            return 200 >= left && 200 <= right && 120 >= top && 120 <= bottom;
        });
        expect(coversHole).toBe(false);
    });
});

describe('tour slide order', () => {
    test('orders text, features, masters, sliders, then edit mode', () => {
        const { TOUR_SLIDE_ORDER, getTourSlide } = require('../js/tour-slides');
        expect(TOUR_SLIDE_ORDER).toEqual([
            'text-mode',
            'ss03-features',
            'masters-list',
            'axis-sliders',
            'enter-edit-mode'
        ]);
        expect(getTourSlide('ss03-features').tooltip.title).toBe(
            'Active OpenType features'
        );
        expect(
            getTourSlide('ss03-features').tooltip.continueLabel
        ).toBeUndefined();
        expect(getTourSlide('ss03-features').advanceOnClick).toBe(
            'button[data-feature-tag="ss03"]'
        );
        expect(getTourSlide('masters-list').tooltip.title).toBe('Masters List');
        expect(getTourSlide('axis-sliders').axisClamp).toEqual({
            selector: '.editor-axis-slider[data-axis-tag="wght"]',
            min: 500,
            max: 700,
            latchMaxWhenAtOrBelow: 700
        });
        expect(getTourSlide('enter-edit-mode').advanceOnGlyphDoubleClick).toBe(
            'm'
        );
        expect(getTourSlide('enter-edit-mode').cutouts[0].hitPadding).toBe(0);
    });
});
