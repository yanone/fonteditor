describe('state-sync variation initialization', () => {
    function createAxesManager(initialVariationSettings = {}) {
        const callbacks = {};

        return {
            variationSettings: { ...initialVariationSettings },
            isAnimating: false,
            on: jest.fn((event, callback) => {
                callbacks[event] = callback;
            }),
            emit: async (event) => {
                if (callbacks[event]) {
                    await callbacks[event]();
                }
            }
        };
    }

    beforeEach(() => {
        jest.resetModules();
        delete window.stateManager;
        delete window.initStateSync;
        delete window.disableSync;
        delete window.enableSync;
    });

    test('syncs variation location after axes defaults are installed', async () => {
        const axesManager = createAxesManager();
        const glyphCanvas = {
            textRunEditor: null,
            axesManager,
            featuresManager: null,
            outlineEditor: null
        };

        window.stateManager = {
            editor_variation_location: {},
            editor_isAnimating: false,
            editor_isInterpolating: false,
            isUrlSyncEnabled: jest.fn(() => true),
            recordEvent: jest.fn()
        };

        let initStateSync;
        jest.isolateModules(() => {
            ({ initStateSync } = require('../js/state-sync'));
        });

        initStateSync(glyphCanvas);

        expect(window.stateManager.editor_variation_location).toEqual({});

        axesManager.variationSettings = { wght: 200 };
        await axesManager.emit('updated');

        expect(window.stateManager.editor_variation_location).toEqual({
            wght: 200
        });
        expect(window.stateManager.recordEvent).toHaveBeenCalledWith(
            'variation_location_initialized',
            'AxesManager',
            { axisCount: 1 }
        );
    });

    test('keeps edit-mode URL cursor as the selected glyph index after reshape', () => {
        const callbacks = {};
        const glyphCanvas = {
            outlineEditor: { active: true },
            axesManager: null,
            featuresManager: null,
            textRunEditor: {
                cursorPosition: 15,
                selectedGlyphIndex: 2,
                shapedGlyphs: [],
                glyphNameBuffer: [],
                on: jest.fn((event, callback) => {
                    callbacks[event] = callback;
                })
            }
        };

        window.stateManager = {
            editor_cursor_position: 2,
            isUrlSyncEnabled: jest.fn(() => true),
            recordEvent: jest.fn()
        };

        let initStateSync;
        jest.isolateModules(() => {
            ({ initStateSync } = require('../js/state-sync'));
        });

        initStateSync(glyphCanvas);
        callbacks.cursormoved();

        expect(window.stateManager.editor_cursor_position).toBe(2);
        expect(window.stateManager.recordEvent).toHaveBeenCalledWith(
            'cursor_moved',
            'TextRunEditor',
            { cursor: 2 }
        );
    });
});
