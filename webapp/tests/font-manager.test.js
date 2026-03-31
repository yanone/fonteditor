const fs = require('fs');
const path = require('path');

const fontManager = require('../js/font-manager').default;
const { fontCompilation } = require('../js/font-compilation');
const { Font } = require('../js/babelfont-model');
const { open_font_file } = require('../wasm-dist/babelfont_fontc_web');

function loadFontFile(filePath) {
    const fileName = path.basename(filePath);
    const fileContents = fs.readFileSync(filePath, 'utf-8');

    if (fileName.endsWith('.babelfont')) {
        return JSON.parse(fileContents);
    }

    return JSON.parse(open_font_file(fileName, fileContents));
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

describe('FontManager saveLayerData', () => {
    let originalOpenedFonts;
    let originalCurrentFontId;
    let originalPendingBabelfontJsonSyncAfterDrag;
    let originalScheduleFullCompileDebounce;
    let updateDirtyIndicatorSpy;
    let intermediateLayerData;
    let originalFontCompilationInitialized;
    let originalLastStoredFontJson;
    let sendMessageSpy;

    beforeAll(() => {
        const fixturePath = path.join(
            __dirname,
            '..',
            'examples',
            'intermediate_layer_on_a.glyphs'
        );
        intermediateLayerData = loadFontFile(fixturePath);
    });

    beforeEach(() => {
        originalOpenedFonts = fontManager.openedFonts;
        originalCurrentFontId = fontManager.currentFontId;
        originalPendingBabelfontJsonSyncAfterDrag =
            fontManager.pendingBabelfontJsonSyncAfterDrag;
        originalScheduleFullCompileDebounce =
            fontManager.scheduleFullCompileDebounce;

        const fontData = cloneJson(intermediateLayerData);
        const fakeCurrentFont = {
            babelfontJson: JSON.stringify(fontData),
            babelfontData: fontData,
            fontModel: Font.fromData(fontData),
            name: 'Sukoon',
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(function () {
                this.babelfontJson = this.fontModel.toJSONString();
            })
        };

        fontManager.openedFonts = new Map([['test-font', fakeCurrentFont]]);
        fontManager.currentFontId = 'test-font';
        fontManager.pendingBabelfontJsonSyncAfterDrag = false;
        fontManager.scheduleFullCompileDebounce = jest.fn();
        updateDirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();

        window.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        originalFontCompilationInitialized = fontCompilation.isInitialized;
        originalLastStoredFontJson = fontCompilation.lastStoredFontJson;
        fontCompilation.isInitialized = true;
        sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });
    });

    afterEach(() => {
        updateDirtyIndicatorSpy?.mockRestore();
        sendMessageSpy?.mockRestore();
        fontManager.openedFonts = originalOpenedFonts;
        fontManager.currentFontId = originalCurrentFontId;
        fontManager.pendingBabelfontJsonSyncAfterDrag =
            originalPendingBabelfontJsonSyncAfterDrag;
        fontManager.scheduleFullCompileDebounce =
            originalScheduleFullCompileDebounce;
        fontCompilation.isInitialized = originalFontCompilationInitialized;
        fontCompilation.lastStoredFontJson = originalLastStoredFontJson;
        delete window.autoCompileManager;
    });

    test('preserves brace layer location metadata when saving edited outlines', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const braceLayer = glyph.layers.find(
            (layer) => layer.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        expect(braceLayer).toBeDefined();
        expect(braceLayer.location).toEqual({ wght: 155, KSHD: 0, SWSH: 0 });

        const editedLayerData = {
            ...cloneJson(braceLayer),
            location: undefined,
            width: 538.25
        };

        await fontManager.saveLayerData(
            'a',
            '1FA54028-AD2E-4209-AA7B-72DF2DF16264',
            editedLayerData,
            'mouse-drag-outline'
        );

        const savedBraceLayer = fontManager.currentFont.babelfontData.glyphs
            .find((entry) => entry.name === 'a')
            .layers.find(
                (layer) => layer.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
            );

        expect(savedBraceLayer.location).toEqual({
            wght: 155,
            KSHD: 0,
            SWSH: 0
        });
        expect(savedBraceLayer.master).toEqual({
            type: 'AssociatedWithMaster',
            master: '3E7589AA-8194-470F-8E2F-13C1C581BE24'
        });
    });

    test('keeps live auto-compile for interactive outline drag saves', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        await fontManager.saveLayerData(
            'a',
            layer.id,
            cloneJson(layer),
            'mouse-drag-outline'
        );

        expect(fontManager.scheduleFullCompileDebounce).toHaveBeenCalledTimes(
            1
        );
        expect(
            window.autoCompileManager.checkAndSchedule
        ).toHaveBeenCalledTimes(1);
    });

    test('keeps live auto-compile for interactive anchor drag saves', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        await fontManager.saveLayerData(
            'a',
            layer.id,
            cloneJson(layer),
            'mouse-drag-anchor'
        );

        expect(fontManager.scheduleFullCompileDebounce).toHaveBeenCalledTimes(
            1
        );
        expect(
            window.autoCompileManager.checkAndSchedule
        ).toHaveBeenCalledTimes(1);
    });

    test('keeps live auto-compile for interactive keyboard outline saves', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        await fontManager.saveLayerData(
            'a',
            layer.id,
            cloneJson(layer),
            'keyboard-outline'
        );

        expect(fontManager.scheduleFullCompileDebounce).toHaveBeenCalledTimes(
            1
        );
        expect(
            window.autoCompileManager.checkAndSchedule
        ).toHaveBeenCalledTimes(1);
    });

    test('keeps live auto-compile for interactive keyboard anchor saves', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        await fontManager.saveLayerData(
            'a',
            layer.id,
            cloneJson(layer),
            'keyboard-anchor'
        );

        expect(fontManager.scheduleFullCompileDebounce).toHaveBeenCalledTimes(
            1
        );
        expect(
            window.autoCompileManager.checkAndSchedule
        ).toHaveBeenCalledTimes(1);
    });

    test('keeps immediate auto-compile for generic keyboard saves', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        await fontManager.saveLayerData(
            'a',
            layer.id,
            cloneJson(layer),
            'keyboard'
        );

        expect(fontManager.scheduleFullCompileDebounce).not.toHaveBeenCalled();
        expect(
            window.autoCompileManager.checkAndSchedule
        ).toHaveBeenCalledTimes(1);
    });

    test('keeps immediate auto-compile for guide drag saves without interactive debounce', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        await fontManager.saveLayerData(
            'a',
            layer.id,
            cloneJson(layer),
            'mouse-drag-guide'
        );

        expect(fontManager.scheduleFullCompileDebounce).not.toHaveBeenCalled();
        expect(
            window.autoCompileManager.checkAndSchedule
        ).toHaveBeenCalledTimes(1);
    });

    test('postpones debounced full compile until drag ends', () => {
        jest.useFakeTimers();

        fontManager.scheduleFullCompileDebounce =
            originalScheduleFullCompileDebounce;
        fontManager.lastCompilationMode = 'outline-only';
        fontManager.pendingBabelfontJsonSyncAfterDrag = true;

        const requestRecompileSpy = jest.fn();
        fontManager.currentFont.requestRecompileWithoutDataChange =
            requestRecompileSpy;
        const syncSpy = jest
            .spyOn(fontManager, 'syncBabelfontJsonFromCurrentModel')
            .mockReturnValue(true);

        window.glyphCanvas = {
            outlineEditor: {
                draggingSomething: true
            }
        };

        try {
            fontManager.scheduleFullCompileDebounce();
            jest.advanceTimersByTime(500);

            expect(syncSpy).not.toHaveBeenCalled();
            expect(requestRecompileSpy).not.toHaveBeenCalled();
            expect(fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(true);

            window.glyphCanvas.outlineEditor.draggingSomething = false;
            jest.advanceTimersByTime(500);

            expect(syncSpy).toHaveBeenCalledTimes(1);
            expect(requestRecompileSpy).toHaveBeenCalledTimes(1);
            expect(
                window.autoCompileManager.checkAndSchedule
            ).toHaveBeenCalledTimes(1);
            expect(fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(false);
        } finally {
            syncSpy.mockRestore();
            jest.useRealTimers();
            delete window.glyphCanvas;
        }
    });

    test('refreshGlyphsAfterModelBatch updates a single edited layer without storing the whole font', async () => {
        const currentFont = fontManager.currentFont;
        const syncSpy = jest.spyOn(currentFont, 'syncJsonFromModel');
        const glyphChangedHandler = jest.fn();
        const layerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';

        fontCompilation.lastStoredFontJson = currentFont.babelfontJson;
        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            await fontManager.refreshGlyphsAfterModelBatch(['a'], layerId);
        } finally {
            window.removeEventListener('glyphChanged', glyphChangedHandler);
            syncSpy.mockRestore();
        }

        expect(syncSpy).not.toHaveBeenCalled();
        expect(sendMessageSpy).toHaveBeenCalledTimes(1);
        expect(sendMessageSpy).toHaveBeenCalledWith({
            type: 'storeLayerData',
            glyphName: 'a',
            layerId,
            layerData: expect.any(Object)
        });
        expect(fontCompilation.lastStoredFontJson).toBeNull();
        expect(glyphChangedHandler).toHaveBeenCalledTimes(1);
        expect(glyphChangedHandler.mock.calls[0][0].detail).toEqual({
            glyphName: 'a',
            layerId
        });
    });

    test('refreshGlyphsAfterModelBatch drops invalid hybrid shapes before sending layer data to Rust', async () => {
        const currentFont = fontManager.currentFont;
        const glyph = currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const layer = glyph.layers.find((entry) => entry.id === layerId);

        layer.shapes = [
            {
                Path: {
                    nodes: '0 0 l 100 0 l',
                    closed: false
                },
                reference: 'acute',
                transform: [1, 0, 0, 1, 0, 0],
                isInterpolated: false
            },
            {
                nodes: '0 0 l 50 50 l',
                closed: false
            }
        ];

        await fontManager.refreshGlyphsAfterModelBatch(['a'], layerId);

        expect(sendMessageSpy).toHaveBeenCalledWith({
            type: 'storeLayerData',
            glyphName: 'a',
            layerId,
            layerData: expect.objectContaining({
                shapes: [
                    {
                        nodes: '0 0 l 100 0 l',
                        closed: false
                    },
                    {
                        nodes: '0 0 l 50 50 l',
                        closed: false
                    }
                ]
            })
        });
    });
});

describe('FontManager loadFont', () => {
    let originalOpenedFonts;
    let originalCurrentFontId;
    let originalCurrentFontModel;
    let intermediateLayerData;

    beforeAll(() => {
        const fixturePath = path.join(
            __dirname,
            '..',
            'examples',
            'intermediate_layer_on_a.glyphs'
        );
        intermediateLayerData = loadFontFile(fixturePath);
    });

    beforeEach(() => {
        originalOpenedFonts = fontManager.openedFonts;
        originalCurrentFontId = fontManager.currentFontId;
        originalCurrentFontModel = window.currentFontModel;
        fontManager.openedFonts = new Map();
        fontManager.currentFontId = null;
        window.currentFontModel = null;
    });

    afterEach(() => {
        fontManager.openedFonts = originalOpenedFonts;
        fontManager.currentFontId = originalCurrentFontId;
        window.currentFontModel = originalCurrentFontModel;
    });

    test('normalizes keyed sidebearings when opening a font without marking it dirty', async () => {
        await fontManager.loadFont(
            JSON.stringify(cloneJson(intermediateLayerData)),
            '/user/intermediate_layer_on_a.glyphs',
            {}
        );

        const currentFont = fontManager.currentFont;
        const glyph = currentFont.fontModel.findGlyph('a');
        const braceLayer = glyph.layers.find(
            (layer) => layer.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        expect(braceLayer.resolveMetricsKey('right').value).toBe(50);
        expect(braceLayer.rsb).toBe(50);
        expect(currentFont.hasUnsavedChanges).toBe(false);
        expect(currentFont.needsRecompile).toBe(false);
        expect(
            JSON.parse(currentFont.babelfontJson)
                .glyphs.find((entry) => entry.name === 'a')
                .layers.find(
                    (layer) =>
                        layer.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
                ).width
        ).toBeCloseTo(braceLayer.width);
    });
});
