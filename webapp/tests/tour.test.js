describe('tour intro', () => {
    let tour;

    function mountToolbar() {
        document.body.innerHTML = `
            <div class="toolbar-right">
                <button id="settings-btn" type="button">Settings</button>
            </div>
            <button id="editor-tool-text" type="button">Text</button>
        `;
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
        window.glyphCanvas = {
            canvas: document.createElement('canvas'),
            outlineEditor: { active: false },
            textRunEditor: {
                setTextBuffer: jest.fn(),
                shapedGlyphs: [{ ax: 400, dx: 0, dy: 0 }]
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
});

describe('tour slide order', () => {
    test('starts with text-mode and can insert ids later', () => {
        const { TOUR_SLIDE_ORDER, getTourSlide } = require('../js/tour-slides');
        expect(TOUR_SLIDE_ORDER[0]).toBe('text-mode');
        expect(getTourSlide('text-mode').tooltip.title).toBe('Text Mode');
    });
});
