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

    test('syncs the glyph overview highlight after restoring edit mode from URL', async () => {
        global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
        global.cancelAnimationFrame = (id) => clearTimeout(id);

        const initStateSync = jest.fn();
        const enableSync = jest.fn();

        jest.doMock('../js/state-sync', () => ({
            initStateSync,
            enableSync
        }));

        const { restoreStateFromUrl } = require('../js/state-restore');

        window.history.replaceState({}, '', '/?text=ab&cursor=1&mode=edit');

        const selectGlyphByIndex = jest
            .fn()
            .mockImplementation(async (index) => {
                glyphCanvas.textRunEditor.selectedGlyphIndex = index;
            });
        const setTextBuffer = jest.fn();
        const updateCursorVisualPosition = jest.fn();
        const fetchLayerData = jest.fn().mockResolvedValue(undefined);
        const syncActiveGlyphFocus = jest.fn();
        const render = jest.fn();

        const glyphCanvas = {
            featuresManager: null,
            axesManager: null,
            textRunEditor: {
                textBuffer: 'ab',
                shapedGlyphs: [{}, {}],
                selectedGlyphIndex: -1,
                setTextBuffer,
                updateCursorVisualPosition,
                selectGlyphByIndex
            },
            outlineEditor: {
                active: false,
                selectedLayerId: 'layer-1',
                fetchLayerData,
                interpolateCurrentGlyph: jest.fn(),
                parseGlyphStack: jest.fn(() => [{ glyphName: 'b' }])
            },
            renderer: { render },
            autoSelectMatchingMaster: jest.fn().mockResolvedValue(undefined),
            alignTextModeEscapeStateWithCurrentMaster: jest.fn()
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
        window.glyphOverviewInstance = {
            syncActiveGlyphFocus
        };

        await restoreStateFromUrl(glyphCanvas);

        expect(selectGlyphByIndex).toHaveBeenCalledWith(1);
        expect(fetchLayerData).toHaveBeenCalledWith(true);
        expect(syncActiveGlyphFocus).toHaveBeenCalledTimes(1);

        delete global.requestAnimationFrame;
        delete global.cancelAnimationFrame;
        delete window.glyphOverviewInstance;
    });

    test('re-enables URL sync even when URL state parsing throws', async () => {
        global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
        global.cancelAnimationFrame = (id) => clearTimeout(id);

        const initStateSync = jest.fn();
        const enableSync = jest.fn();

        jest.doMock('../js/state-sync', () => ({
            initStateSync,
            enableSync
        }));
        jest.doMock('../js/url-state', () => ({
            readUrlState: jest.fn(() => {
                throw new Error('bad url state');
            }),
            decodeLocation: jest.fn(),
            decodeFeatures: jest.fn()
        }));

        const { ensureStartupStateReady } = require('../js/state-restore');

        window.stateManager = {
            editor_file: '',
            editor_text_buffer: '',
            editor_cursor_position: 0,
            editor_mode: 'text',
            editor_variation_location: {},
            editor_opentype_features_in_subset: {},
            editor_opentype_features_not_in_subset: {}
        };

        await expect(
            ensureStartupStateReady({
                axesManager: null,
                featuresManager: null,
                textRunEditor: null,
                outlineEditor: { active: false },
                renderer: null,
                autoSelectMatchingMaster: jest.fn(),
                alignTextModeEscapeStateWithCurrentMaster: jest.fn()
            })
        ).rejects.toThrow('bad url state');

        expect(initStateSync).toHaveBeenCalledTimes(1);
        expect(enableSync).toHaveBeenCalledTimes(1);

        delete global.requestAnimationFrame;
        delete global.cancelAnimationFrame;
    });
});
