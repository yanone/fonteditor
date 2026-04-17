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
        expect(glyphChangedHandler).toHaveBeenCalledTimes(2);
        expect(glyphChangedHandler.mock.calls[0][0].detail.glyphName).toBe(
            firstGlyph.name
        );
        expect(glyphChangedHandler.mock.calls[1][0].detail.glyphName).toBe(
            secondGlyph.name
        );
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
