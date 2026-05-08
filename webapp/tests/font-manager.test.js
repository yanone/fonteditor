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

    test('keeps live editing auto-compile for interactive outline drag saves', async () => {
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

    test('keeps live editing auto-compile for interactive anchor drag saves', async () => {
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

    test('normalizeLayerForRust canonicalizes malformed component transforms', () => {
        const normalized = fontManager.normalizeLayerForRust({
            width: 500,
            shapes: [
                {
                    reference: 'A',
                    transform: {
                        translation: [0, 0],
                        rotation: 0,
                        scale: [1, 1],
                        skew: 0,
                        tcenter: [0, 0]
                    },
                    format_specific: {
                        'com.schriftgestalt.Glyphs.alignment': 0
                    }
                }
            ]
        });

        expect(normalized.shapes[0].transform).toEqual({
            translation: [0, 0],
            rotation: 0,
            scale: [1, 1],
            skew: [0, 0],
            order: 'RestOfTheWorld'
        });
        expect(normalized.shapes[0].transform.tcenter).toBeUndefined();
    });

    test('updates the live object model layer during interactive saves', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const editedLayer = cloneJson(layer);
        editedLayer.width = 612;
        editedLayer.anchors = (editedLayer.anchors || []).map((anchor) =>
            anchor.name === 'top' ? { ...anchor, x: 333, y: anchor.y } : anchor
        );

        await fontManager.saveLayerData(
            'a',
            layer.id,
            editedLayer,
            'mouse-drag-anchor'
        );

        const modelLayer = fontManager.currentFont.fontModel
            .findGlyph('a')
            .findLayerById(layer.id);
        const topAnchor = (modelLayer.anchors || []).find(
            (anchor) => anchor.name === 'top'
        );

        expect(modelLayer.toJSON().width).toBe(612);
        expect(topAnchor?.x).toBe(333);
    });

    test('preserves existing shapes and anchors when outline save payload omits them', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const originalWidth = layer.width;
        const originalShapes = cloneJson(layer.shapes);
        const originalAnchors = cloneJson(layer.anchors);

        await fontManager.saveLayerData(
            'a',
            layer.id,
            {
                id: layer.id,
                width: originalWidth + 25,
                master: cloneJson(layer.master)
            },
            'mouse-drag-outline'
        );

        const savedLayer = fontManager.currentFont.babelfontData.glyphs
            .find((entry) => entry.name === 'a')
            .layers.find((entry) => entry.id === layer.id);
        const modelLayer = fontManager.currentFont.fontModel
            .findGlyph('a')
            .findLayerById(layer.id);

        expect(savedLayer.width).toBe(originalWidth + 25);
        expect(savedLayer.shapes).toEqual(originalShapes);
        expect(savedLayer.anchors).toEqual(originalAnchors);
        expect(modelLayer.toJSON().shapes).toEqual(originalShapes);
        expect(modelLayer.toJSON().anchors).toEqual(originalAnchors);
    });

    test('serializeLayerForStorage does not synthesize empty shapes for skeletal layers', () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        glyph.layers[glyph.layers.indexOf(layer)] = {
            id: layer.id,
            width: 0,
            master: cloneJson(layer.master)
        };

        const serialized = fontManager.serializeLayerForStorage(
            'a',
            layer.id,
            {
                id: layer.id,
                width: 640,
                master: cloneJson(layer.master)
            },
            undefined
        );

        expect(serialized.width).toBe(640);
        expect(serialized.shapes).toBeUndefined();
    });

    test('saveLayerData rejects missing layer widths before mutating stored data', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const originalLayer = cloneJson(layer);
        const editedLayer = cloneJson(layer);
        delete editedLayer.width;

        await expect(
            fontManager.saveLayerData(
                'a',
                layer.id,
                editedLayer,
                'mouse-drag-outline'
            )
        ).rejects.toThrow(/invalid width/);

        const storedLayer = fontManager.currentFont.babelfontData.glyphs
            .find((entry) => entry.name === 'a')
            .layers.find((entry) => entry.id === layer.id);

        expect(storedLayer).toEqual(originalLayer);
        expect(fontManager.currentFont.markDirty).not.toHaveBeenCalled();
        expect(sendMessageSpy).not.toHaveBeenCalled();
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

    test('keeps immediate editing auto-compile for guide drag saves', async () => {
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
            expect(fontManager.lastChangeSource).toBe(
                'debounced-post-interaction-full-compile'
            );
            expect(fontManager.lastEditType).toBeNull();
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
            type: 'storeLayerUpdates',
            updates: [
                {
                    glyphName: 'a',
                    layerId,
                    layerData: expect.any(Object)
                }
            ]
        });
        expect(fontCompilation.lastStoredFontJson).toBeNull();
        expect(glyphChangedHandler).toHaveBeenCalledTimes(1);
        expect(glyphChangedHandler.mock.calls[0][0].detail).toEqual({
            glyphName: 'a',
            layerId
        });
    });

    test('refreshGlyphsAfterModelBatch uses explicit live layer data without serializing the model layer', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const modelLayer = currentFont.fontModel
            .findGlyph('a')
            .findLayerById(layerId);
        const storedLayer = currentFont.babelfontData.glyphs
            .find((entry) => entry.name === 'a')
            .layers.find((entry) => entry.id === layerId);
        const explicitLayer = {
            ...cloneJson(storedLayer),
            width: storedLayer.width + 37
        };
        const toJSONSpy = jest.spyOn(modelLayer, 'toJSON');

        try {
            await fontManager.refreshGlyphsAfterModelBatch(['a'], layerId, {
                dispatchGlyphChanged: false,
                skipFingerprintBaseline: true,
                explicitLayerData: [
                    {
                        glyphName: 'a',
                        layerId,
                        layerData: explicitLayer
                    }
                ]
            });
        } finally {
            toJSONSpy.mockRestore();
        }

        expect(toJSONSpy).not.toHaveBeenCalled();
        expect(sendMessageSpy).toHaveBeenCalledWith({
            type: 'storeLayerUpdates',
            updates: [
                {
                    glyphName: 'a',
                    layerId,
                    layerData: expect.objectContaining({
                        width: explicitLayer.width
                    })
                }
            ]
        });
        expect(
            currentFont.babelfontData.glyphs
                .find((entry) => entry.name === 'a')
                .layers.find((entry) => entry.id === layerId).width
        ).toBe(explicitLayer.width);
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
            type: 'storeLayerUpdates',
            updates: [
                {
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
                }
            ]
        });
    });

    test('refreshGlyphsAfterModelBatch incrementally patches multiple changed glyph layers', async () => {
        const currentFont = fontManager.currentFont;
        const syncSpy = jest.spyOn(currentFont, 'syncJsonFromModel');
        const glyphChangedHandler = jest.fn();
        const [firstGlyph, secondGlyph] = currentFont.fontModel.glyphs;

        expect(firstGlyph).toBeDefined();
        expect(secondGlyph).toBeDefined();

        const firstLayer = firstGlyph.layers[0];
        const secondLayer = secondGlyph.layers[0];

        firstLayer.width += 11;
        secondLayer.width += 17;

        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            await fontManager.refreshGlyphsAfterModelBatch(
                [firstGlyph.name, secondGlyph.name],
                firstLayer.id
            );
        } finally {
            window.removeEventListener('glyphChanged', glyphChangedHandler);
            syncSpy.mockRestore();
        }

        expect(syncSpy).not.toHaveBeenCalled();
        expect(sendMessageSpy).toHaveBeenCalledTimes(1);
        expect(sendMessageSpy).toHaveBeenCalledWith({
            type: 'storeLayerUpdates',
            updates: [
                {
                    glyphName: firstGlyph.name,
                    layerId: firstLayer.id,
                    layerData: expect.objectContaining({
                        width: firstLayer.width
                    })
                },
                {
                    glyphName: secondGlyph.name,
                    layerId: secondLayer.id,
                    layerData: expect.objectContaining({
                        width: secondLayer.width
                    })
                }
            ]
        });
        expect(fontCompilation.lastStoredFontJson).toBeNull();
        expect(
            fontManager.currentFont.babelfontData.glyphs
                .find((entry) => entry.name === firstGlyph.name)
                .layers.find((entry) => entry.id === firstLayer.id).width
        ).toBe(firstLayer.width);
        expect(
            fontManager.currentFont.babelfontData.glyphs
                .find((entry) => entry.name === secondGlyph.name)
                .layers.find((entry) => entry.id === secondLayer.id).width
        ).toBe(secondLayer.width);
        expect(glyphChangedHandler).toHaveBeenCalledTimes(1);
        expect(glyphChangedHandler.mock.calls[0][0].detail).toEqual({
            glyphName: firstGlyph.name,
            glyphNames: [firstGlyph.name, secondGlyph.name],
            layerId: firstLayer.id
        });
    });

    test('refreshGlyphsAfterModelBatch emits exactly one glyphChanged for source + all downstream glyphs', async () => {
        // Regression guard for the sidebearing perf fix: the old code in
        // syncDependentGlyphsAfterSidebearingEdit dispatched one glyphChanged
        // per downstream glyph *on top of* the single batched event from
        // refreshGlyphsAfterModelBatch.  Each event synchronously re-rendered
        // the HistoryView (~200 ms), causing a ~10 s freeze on large fonts.
        // refreshGlyphsAfterModelBatch is the authoritative source of the
        // batched notification and must never fire more than once per call.
        const currentFont = fontManager.currentFont;
        const glyphChangedHandler = jest.fn();
        const layerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';

        // Simulate a sidebearing cascade: source glyph 'a' plus four
        // downstream dependents (as would happen when 'a' has a metrics key
        // referenced by adieresis, aacute, agrave, aring etc.).
        const allGlyphNames = ['a', 'adieresis', 'aacute', 'agrave', 'aring'];

        fontCompilation.lastStoredFontJson = currentFont.babelfontJson;
        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            await fontManager.refreshGlyphsAfterModelBatch(
                allGlyphNames,
                layerId
            );
        } finally {
            window.removeEventListener('glyphChanged', glyphChangedHandler);
        }

        // Exactly one event must have fired, carrying all glyph names.
        expect(glyphChangedHandler).toHaveBeenCalledTimes(1);
        const detail = glyphChangedHandler.mock.calls[0][0].detail;
        expect(detail.glyphName).toBe('a');
        expect(detail.glyphNames).toEqual(allGlyphNames);
        expect(detail.layerId).toBe(layerId);
    });

    test('updateWorkerFontCache batches the incremental post-drag layer refresh', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';

        fontManager.pendingBabelfontJsonSyncAfterDrag = true;
        window.glyphCanvas = {
            outlineEditor: {
                currentGlyphName: 'a',
                selectedLayerId: layerId
            },
            getCurrentGlyphName: jest.fn(() => 'a')
        };
        window.currentFontModel = currentFont.fontModel;

        try {
            await fontManager.updateWorkerFontCache();
        } finally {
            delete window.glyphCanvas;
            delete window.currentFontModel;
        }

        expect(sendMessageSpy).toHaveBeenCalledTimes(1);
        expect(sendMessageSpy).toHaveBeenCalledWith({
            type: 'storeLayerUpdates',
            updates: [
                {
                    glyphName: 'a',
                    layerId,
                    layerData: expect.any(Object)
                }
            ]
        });
        expect(fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(false);
    });
});

describe('FontManager editing subset inclusion', () => {
    let originalOpenedFonts;
    let originalCurrentFontId;
    let originalGlyphCanvas;
    let compileEditingSpy;
    let originalFontCompilationInitialized;
    let saveEditingFontSpy;

    beforeEach(() => {
        originalOpenedFonts = fontManager.openedFonts;
        originalCurrentFontId = fontManager.currentFontId;
        originalGlyphCanvas = window.glyphCanvas;
        originalFontCompilationInitialized = fontCompilation.isInitialized;

        const fontData = {
            upm: 1000,
            version: [1, 0],
            axes: [],
            instances: [],
            masters: [
                {
                    id: 'master-1',
                    name: { en: 'Regular' },
                    location: {},
                    guides: [],
                    metrics: {},
                    kerning: new Map()
                }
            ],
            glyphs: [
                {
                    name: 'a',
                    exported: true,
                    layers: [
                        {
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [],
                            anchors: [],
                            guides: []
                        }
                    ]
                },
                {
                    name: 'n',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: { family_name: { en: 'Subset Test' } },
            note: '',
            date: '2026-03-31',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        };
        const fakeCurrentFont = {
            babelfontJson: JSON.stringify(fontData),
            babelfontData: fontData,
            fontModel: Font.fromData(fontData),
            name: 'Sukoon',
            compileRequestVersion: 1,
            changeVersion: 1,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(function () {
                this.babelfontJson = this.fontModel.toJSONString();
            })
        };

        fontManager.openedFonts = new Map([['test-font', fakeCurrentFont]]);
        fontManager.currentFontId = 'test-font';
        fontCompilation.isInitialized = true;
        compileEditingSpy = jest
            .spyOn(fontCompilation, 'compileEditingFromJsonCached')
            .mockResolvedValue({
                result: new Uint8Array([1, 2, 3]),
                filename: 'editing.ttf',
                time_taken: 1,
                fontRevisionKey: '1'
            });
        saveEditingFontSpy = jest
            .spyOn(fontManager, 'saveEditingFontToFileSystem')
            .mockImplementation(() => {});

        window.glyphCanvas = {
            outlineEditor: {
                currentGlyphName: 'n',
                selectedLayerId: 'layer-1',
                draggingSomething: false
            },
            getCurrentGlyphName: jest.fn(() => 'n'),
            textRunEditor: {
                textBuffer: 'a',
                glyphNameBuffer: ['a']
            }
        };
    });

    afterEach(() => {
        compileEditingSpy?.mockRestore();
        saveEditingFontSpy?.mockRestore();
        fontManager.updateEditingSubsetSnapshot([]);
        fontManager.openedFonts = originalOpenedFonts;
        fontManager.currentFontId = originalCurrentFontId;
        window.glyphCanvas = originalGlyphCanvas;
        fontCompilation.isInitialized = originalFontCompilationInitialized;
    });

    test('validateAndFixBabelfontJsonForRust canonicalizes DefaultForMaster layer ids to their master ids', () => {
        const fontData = cloneJson(fontManager.currentFont.babelfontData);
        fontData.glyphs[0].name = 'a';
        fontData.glyphs[0].layers[0].id = 'temp-layer-id';
        fontData.glyphs[0].layers[0].master = {
            type: 'DefaultForMaster',
            master: 'master-1'
        };

        const validatedJson = fontManager['validateAndFixBabelfontJsonForRust'](
            JSON.stringify(fontData),
            true
        );
        const validatedData = JSON.parse(validatedJson);

        expect(validatedData.glyphs[0].layers[0].id).toBe('master-1');
        expect(validatedData.glyphs[0].layers[0].master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-1'
        });
    });

    test('validateAndFixBabelfontJsonForRust rejects missing layer widths instead of synthesizing zero', () => {
        const fontData = cloneJson(fontManager.currentFont.babelfontData);
        delete fontData.glyphs[0].layers[0].width;

        expect(() =>
            fontManager['validateAndFixBabelfontJsonForRust'](
                JSON.stringify(fontData),
                true
            )
        ).toThrow(/invalid width/);
    });

    test('compileEditingFont adds the active edited glyph to the subset', async () => {
        fontManager.lastChangeSource = 'keyboard-outline';
        fontManager.lastEditType = 'outline';

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][2]).toEqual(['a', 'n']);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'keyboard-outline',
            dirtyLayerUpdates: [
                {
                    glyphName: 'n',
                    layerId: 'layer-1',
                    layerData: expect.any(Object)
                }
            ]
        });
    });

    test('structural outline compiles keep outline-only mode but skip incremental dirty-layer patching', async () => {
        fontManager.lastChangeSource = 'keyboard-outline';
        fontManager.lastEditType = 'outline';
        fontManager.forceFullEditingCacheRefresh = true;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][2]).toEqual(['a', 'n']);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'keyboard-outline',
            optionOverrides: {
                skip_features: true,
                skip_kerning: true,
                produce_varc_table: false
            }
        });
        expect(
            compileEditingSpy.mock.calls[0][3].dirtyLayerUpdates
        ).toBeUndefined();
        expect(fontManager.forceFullEditingCacheRefresh).toBe(false);
    });

    test('mouse-drag outline compiles keep the outline-only fast path even when dragging getter is false at compile time', async () => {
        fontManager.lastChangeSource = 'mouse-drag-outline';
        fontManager.lastEditType = 'outline';
        window.glyphCanvas.outlineEditor.draggingSomething = false;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'mouse-drag-outline',
            dragActive: true,
            optionOverrides: {
                skip_features: true,
                skip_kerning: true,
                produce_varc_table: false
            },
            dirtyLayerUpdates: [
                {
                    glyphName: 'n',
                    layerId: 'layer-1',
                    layerData: expect.any(Object)
                }
            ]
        });
    });

    test('mouse-drag outline compiles do not force a full JSON sync when incremental layer patching is available', async () => {
        fontManager.lastChangeSource = 'mouse-drag-outline';
        fontManager.lastEditType = 'outline';
        fontManager.pendingBabelfontJsonSyncAfterDrag = true;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(
            fontManager.currentFont.syncJsonFromModel
        ).not.toHaveBeenCalled();
        expect(fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(true);
        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'mouse-drag-outline',
            dirtyLayerUpdates: [
                {
                    glyphName: 'n',
                    layerId: 'layer-1',
                    layerData: expect.any(Object)
                }
            ]
        });
    });

    test('keyboard-sidebearing compiles stay on the outline-only incremental fast path', async () => {
        fontManager.lastChangeSource = 'keyboard-sidebearing';
        fontManager.lastEditType = 'outline';

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'keyboard-sidebearing',
            optionOverrides: {
                skip_features: true,
                skip_kerning: true,
                produce_varc_table: false
            },
            dirtyLayerUpdates: [
                {
                    glyphName: 'n',
                    layerId: 'layer-1',
                    layerData: expect.any(Object)
                }
            ]
        });
    });

    test('mouse-drag anchor compiles keep kerning enabled in anchor-only mode', async () => {
        fontManager.lastChangeSource = 'mouse-drag-anchor';
        fontManager.lastEditType = 'anchor';
        window.glyphCanvas.outlineEditor.draggingSomething = false;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'mouse-drag-anchor',
            dragActive: true,
            optionOverrides: {
                produce_varc_table: false
            },
            dirtyLayerUpdates: [
                {
                    glyphName: 'n',
                    layerId: 'layer-1',
                    layerData: expect.any(Object)
                }
            ]
        });
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_kerning');
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_features');
    });

    test('keyboard-anchor compiles keep kerning enabled in anchor-only mode', async () => {
        fontManager.lastChangeSource = 'keyboard-anchor';
        fontManager.lastEditType = 'anchor';

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'keyboard-anchor',
            optionOverrides: {
                produce_varc_table: false
            },
            dirtyLayerUpdates: [
                {
                    glyphName: 'n',
                    layerId: 'layer-1',
                    layerData: expect.any(Object)
                }
            ]
        });
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_kerning');
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_features');
    });

    test('remote-anchor compiles keep kerning enabled in anchor-only mode', async () => {
        fontManager.lastChangeSource = 'remote-anchor';
        fontManager.lastEditType = 'anchor';

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'remote-anchor',
            optionOverrides: {
                produce_varc_table: false
            }
        });
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_kerning');
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_features');
        expect(
            compileEditingSpy.mock.calls[0][3].dirtyLayerUpdates
        ).toBeUndefined();
    });

    test('anchor undo-redo compiles keep kerning enabled in anchor-only mode', async () => {
        fontManager.lastChangeSource = 'keyboard-undo-redo';
        fontManager.lastEditType = 'anchor';

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'keyboard-undo-redo',
            optionOverrides: {
                produce_varc_table: false
            },
            dirtyLayerUpdates: [
                {
                    glyphName: 'n',
                    layerId: 'layer-1',
                    layerData: expect.any(Object)
                }
            ]
        });
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_kerning');
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_features');
    });

    test('debounced post-interaction full compiles do not send incremental dirty-layer patches', async () => {
        fontManager.lastChangeSource =
            'debounced-post-interaction-full-compile';
        fontManager.lastEditType = null;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'debounced-post-interaction-full-compile'
        });
        expect(
            compileEditingSpy.mock.calls[0][3].dirtyLayerUpdates
        ).toBeUndefined();
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).toBeUndefined();
    });

    test('recompileEditingFont waits for replay-target worker refresh before compiling', async () => {
        const currentFont = fontManager.currentFont;
        currentFont.needsRecompile = true;

        let resolveSubmitLayerUpdates;
        const submitLayerUpdatesPromise = new Promise((resolve) => {
            resolveSubmitLayerUpdates = resolve;
        });

        const submitLayerUpdatesSpy = jest
            .spyOn(fontManager, 'submitLayerUpdatesToWorkerCache')
            .mockImplementation(() => submitLayerUpdatesPromise);
        const recompileCompileSpy = jest
            .spyOn(fontManager, 'compileEditingFont')
            .mockResolvedValue(new Uint8Array([1, 2, 3]));

        try {
            const refreshPromise =
                fontManager.refreshWorkerCacheForReplayTargets([
                    { glyphName: 'n', layerId: 'layer-1' }
                ]);
            const recompilePromise = fontManager.recompileEditingFont();

            await Promise.resolve();
            expect(fontManager.workerCacheUpdatePromise).not.toBeNull();
            expect(recompileCompileSpy).not.toHaveBeenCalled();

            resolveSubmitLayerUpdates(true);

            await refreshPromise;
            await recompilePromise;

            expect(recompileCompileSpy).toHaveBeenCalledTimes(1);
        } finally {
            submitLayerUpdatesSpy.mockRestore();
            recompileCompileSpy.mockRestore();
            fontManager.workerCacheUpdatePromise = null;
        }
    });

    test('getLiveVisibleGlyphNames merges subset snapshot, rendered run, and active glyph', () => {
        fontManager.updateEditingSubsetSnapshot(['adieresis', 'visibleAccent']);
        window.glyphCanvas.textRunEditor.glyphNameBuffer = [
            'visibleAccent',
            'runOnlyGlyph'
        ];
        window.glyphCanvas.outlineEditor.currentGlyphName = 'editedGlyph';
        window.glyphCanvas.getCurrentGlyphName = jest.fn(() => 'editedGlyph');

        expect(fontManager.getLiveVisibleGlyphNames()).toEqual([
            'adieresis',
            'visibleAccent',
            'runOnlyGlyph',
            'editedGlyph'
        ]);
    });

    test('getAutomaticCompositionDragScopeGlyphNames keeps only visible dependents and required bridges', () => {
        fontManager.updateEditingSubsetSnapshot(['visibleLeaf']);
        window.glyphCanvas.textRunEditor.glyphNameBuffer = [];
        window.glyphCanvas.outlineEditor.currentGlyphName = 'sourceGlyph';
        window.glyphCanvas.getCurrentGlyphName = jest.fn(() => 'sourceGlyph');

        const dependencyGraph = {
            sourceGlyph: ['bridgeGlyph', 'hiddenSibling'],
            bridgeGlyph: ['visibleLeaf'],
            hiddenSibling: ['hiddenLeaf'],
            visibleLeaf: [],
            hiddenLeaf: []
        };

        const scopedGlyphNames =
            fontManager.getAutomaticCompositionDragScopeGlyphNames(
                'sourceGlyph',
                {
                    findGlyphsUsingComponent: jest.fn(
                        (glyphName) => dependencyGraph[glyphName] || []
                    )
                }
            );

        expect(scopedGlyphNames).toEqual(
            new Set(['sourceGlyph', 'bridgeGlyph', 'visibleLeaf'])
        );
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

describe('FontManager boundary-crossing budget', () => {
    // Lock down the JS <-> Rust/worker traffic per the compilation policy:
    //   - every interactive edit must funnel through the batched
    //     `storeLayerUpdates` worker message (1 batch per commit, no matter
    //     how many layers are in the batch),
    //   - no full-font `storeFontJson` crossings during interactive edits,
    //   - no progressive growth in per-edit work after many edits.
    // See developer-docs/COMPILATION_EDIT_POLICY.md.

    let originalOpenedFonts;
    let originalCurrentFontId;
    let originalFontCompilationInitialized;
    let originalLastStoredFontJson;
    let intermediateFontData;
    let updateDirtyIndicatorSpy;
    let sendMessageSpy;

    beforeAll(() => {
        const fixturePath = path.join(
            __dirname,
            '..',
            'examples',
            'intermediate_layer_on_a.glyphs'
        );
        intermediateFontData = loadFontFile(fixturePath);
    });

    beforeEach(() => {
        originalOpenedFonts = fontManager.openedFonts;
        originalCurrentFontId = fontManager.currentFontId;
        originalFontCompilationInitialized = fontCompilation.isInitialized;
        originalLastStoredFontJson = fontCompilation.lastStoredFontJson;

        const fontData = cloneJson(intermediateFontData);
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
        fontManager.workerLayerFingerprintCache = new Map();
        fontManager.resetBoundaryCrossingStats();

        updateDirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        window.autoCompileManager = { checkAndSchedule: jest.fn() };

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
        fontCompilation.isInitialized = originalFontCompilationInitialized;
        fontCompilation.lastStoredFontJson = originalLastStoredFontJson;
        delete window.autoCompileManager;
    });

    test('getLayerFingerprintsFromStoredJson does not parse babelfontJson on the hot path', () => {
        const currentFont = fontManager.currentFont;
        const parseSpy = jest.spyOn(JSON, 'parse');

        try {
            const fingerprints = fontManager.getLayerFingerprintsFromStoredJson(
                ['a', 'aacute', 'n']
            );
            expect(fingerprints.size).toBe(0);
            // Must NOT touch the megabyte-scale babelfontJson string.
            const touched = parseSpy.mock.calls.some(
                (args) => args[0] === currentFont.babelfontJson
            );
            expect(touched).toBe(false);
        } finally {
            parseSpy.mockRestore();
        }
    });

    test('single-layer commit crosses the boundary exactly once with no full-font sync', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const modelLayer = currentFont.fontModel
            .findGlyph('a')
            .findLayerById(layerId);
        modelLayer.width += 23;

        await fontManager.refreshGlyphsAfterModelBatch(['a'], layerId);

        const stats = fontManager.getBoundaryCrossingStats();
        expect(stats.submitBatchCalls).toBe(1);
        expect(stats.layersTransmitted).toBe(1);
        expect(stats.glyphsTransmitted).toBe(1);
        expect(stats.fullFontCrossings).toBe(0);

        // Exactly one storeLayerUpdates message reached the worker, no storeFontJson.
        const messageTypes = sendMessageSpy.mock.calls.map(
            (args) => args[0]?.type
        );
        expect(messageTypes).toEqual(['storeLayerUpdates']);
    });

    test('multi-glyph cascade batches all layers into a single boundary crossing', async () => {
        const currentFont = fontManager.currentFont;
        const [first, second] = currentFont.fontModel.glyphs;
        const firstLayer = first.layers[0];
        const secondLayer = second.layers[0];

        firstLayer.width += 11;
        secondLayer.width += 17;

        await fontManager.refreshGlyphsAfterModelBatch(
            [first.name, second.name],
            firstLayer.id
        );

        const stats = fontManager.getBoundaryCrossingStats();
        expect(stats.submitBatchCalls).toBe(1);
        expect(stats.layersTransmitted).toBe(2);
        expect(stats.glyphsTransmitted).toBe(2);
        expect(stats.fullFontCrossings).toBe(0);
    });

    test('refreshWorkerCacheForReplayTargets uses the same single-batch path as direct edits', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = currentFont.fontModel.findGlyph('a').layers[0].id;
        const layerN = currentFont.fontModel.findGlyph('n');
        const layerNId = layerN ? layerN.layers[0].id : null;

        const targets = [{ glyphName: 'a', layerId }];
        if (layerNId) {
            targets.push({ glyphName: 'n', layerId: layerNId });
        }

        await fontManager.refreshWorkerCacheForReplayTargets(targets);

        const stats = fontManager.getBoundaryCrossingStats();
        expect(stats.submitBatchCalls).toBe(1);
        expect(stats.layersTransmitted).toBe(targets.length);
        expect(stats.fullFontCrossings).toBe(0);
        const messageTypes = sendMessageSpy.mock.calls.map(
            (args) => args[0]?.type
        );
        expect(messageTypes).toEqual(['storeLayerUpdates']);
    });

    test('submitLayerToWorkerCache routes the singular receiver-fallback path through the batched API', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = currentFont.fontModel.findGlyph('a').layers[0].id;

        await fontManager.submitLayerToWorkerCache('a', layerId);

        const stats = fontManager.getBoundaryCrossingStats();
        expect(stats.submitBatchCalls).toBe(1);
        expect(stats.layersTransmitted).toBe(1);
        expect(stats.glyphsTransmitted).toBe(1);
        expect(stats.fullFontCrossings).toBe(0);
        expect(
            fontManager.workerLayerFingerprintCache.has(`a::${layerId}`)
        ).toBe(true);
    });

    test('recordFullFontCrossing clears the layer fingerprint cache', () => {
        fontManager.workerLayerFingerprintCache.set('a::layer-1', 'abc');
        fontManager.workerLayerFingerprintCache.set('n::layer-1', 'def');

        fontManager.recordFullFontCrossing();

        const stats = fontManager.getBoundaryCrossingStats();
        expect(stats.fullFontCrossings).toBe(1);
        expect(fontManager.workerLayerFingerprintCache.size).toBe(0);
    });

    test('per-edit boundary cost stays flat across 50 sequential commits', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const modelLayer = currentFont.fontModel
            .findGlyph('a')
            .findLayerById(layerId);

        for (let i = 0; i < 50; i++) {
            fontManager.resetBoundaryCrossingStats();
            modelLayer.width += 1;

            await fontManager.refreshGlyphsAfterModelBatch(['a'], layerId);

            const stats = fontManager.getBoundaryCrossingStats();
            // EVERY commit must cost exactly 1 batch crossing for 1 layer of
            // 1 glyph and zero full-font crossings -- no progressive growth.
            expect(stats).toEqual({
                submitBatchCalls: 1,
                layersTransmitted: 1,
                glyphsTransmitted: 1,
                fullFontCrossings: 0
            });
        }
    });

    test('undo/redo replay targets keep boundary crossing budget at zero full-font crossings', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const modelLayer = currentFont.fontModel
            .findGlyph('a')
            .findLayerById(layerId);

        // Make an edit to create undo history
        modelLayer.width += 50;
        await fontManager.refreshGlyphsAfterModelBatch(['a'], layerId);

        // Reset stats and simulate undo via replay targets
        fontManager.resetBoundaryCrossingStats();
        await fontManager.refreshWorkerCacheForReplayTargets([
            { glyphName: 'a', layerId }
        ]);

        const stats = fontManager.getBoundaryCrossingStats();
        expect(stats.submitBatchCalls).toBe(1);
        expect(stats.fullFontCrossings).toBe(0);
    });
});
