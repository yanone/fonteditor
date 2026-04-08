describe('ensureStartupStateReady', () => {
    beforeEach(() => {
        jest.resetModules();
        document.body.innerHTML = '';
        window.history.replaceState({}, '', '/');
        delete window.stateManager;
    });

    test('initializes state sync once and applies startup location before resolving', async () => {
        const initStateSync = jest.fn();
        const enableSync = jest.fn();

        jest.doMock('../js/state-sync', () => ({
            initStateSync,
            enableSync
        }));

        const { ensureStartupStateReady } = require('../js/state-restore');

        window.history.replaceState({}, '', '/?location=wght:540');

        const setAxisValue = jest.fn();
        const updateAxisSliders = jest.fn();
        const autoSelectMatchingMaster = jest.fn().mockResolvedValue();
        const alignTextModeEscapeStateWithCurrentMaster = jest.fn();
        const render = jest.fn();
        const glyphCanvas = {
            axesManager: {
                setAxisValue,
                updateAxisSliders
            },
            featuresManager: null,
            textRunEditor: null,
            outlineEditor: { active: false },
            renderer: { render },
            autoSelectMatchingMaster,
            alignTextModeEscapeStateWithCurrentMaster
        };

        window.stateManager = {
            editor_file: '',
            editor_text_buffer: '',
            editor_cursor_position: 0,
            editor_mode: 'text',
            editor_variation_location: {},
            editor_opentype_features_in_subset: {},
            editor_opentype_features_not_in_subset: {}
        };

        const variationListener = jest.fn();
        window.addEventListener('variationLocationChanged', variationListener);

        await ensureStartupStateReady(glyphCanvas);
        await ensureStartupStateReady(glyphCanvas);

        expect(initStateSync).toHaveBeenCalledTimes(1);
        expect(enableSync).toHaveBeenCalledTimes(1);
        expect(glyphCanvas.hasInitializedStateSync).toBe(true);
        expect(setAxisValue).toHaveBeenCalledWith('wght', 540);
        expect(updateAxisSliders).toHaveBeenCalledTimes(1);
        expect(autoSelectMatchingMaster).toHaveBeenCalledTimes(1);
        expect(alignTextModeEscapeStateWithCurrentMaster).toHaveBeenCalledTimes(
            1
        );
        expect(render).toHaveBeenCalledTimes(1);
        expect(variationListener).toHaveBeenCalledTimes(1);

        window.removeEventListener(
            'variationLocationChanged',
            variationListener
        );
    });
});
