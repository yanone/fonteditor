const fs = require('fs');
const path = require('path');
const Y = require('yjs');

const fontManager = require('../js/font-manager').default;
const { fontCompilation } = require('../js/font-compilation');
const { Font, withSuppressedModelRecording } = require('../js/babelfont-model');
const {
    deleteYPath,
    getYPath,
    jsonToYDoc,
    setYPath,
    yDocToJson
} = require('../js/change-bridge-ydoc');
const { open_font_file } = require('../wasm-dist/babelfont_fontc_web');
const { sidebarErrorDisplay } = require('../js/sidebar-error-display');
const { parseNodeString } = require('../js/node-encoding');

function makeWorkerCacheStatus(overrides = {}) {
    return {
        coherent: true,
        documentEpoch: 1,
        fontCacheEpoch: 1,
        filterEpoch: 1,
        subsetCacheEpoch: null,
        ...overrides
    };
}

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

function stripLayerStableIds(layer) {
    if (!layer || typeof layer !== 'object') {
        return layer;
    }

    return {
        ...layer,
        shapes: Array.isArray(layer.shapes)
            ? layer.shapes.map((shape) => {
                  const nextShape = { ...shape };
                  delete nextShape.id;
                  if (
                      Array.isArray(nextShape.nodes) ||
                      typeof nextShape.nodes === 'string'
                  ) {
                      nextShape.nodes = parseNodeString(nextShape.nodes).map(
                          ({ id, smooth, ...node }) =>
                              smooth === false ? node : { ...node, smooth }
                      );
                  }
                  return nextShape;
              })
            : layer.shapes,
        anchors: Array.isArray(layer.anchors)
            ? layer.anchors.map((anchor) => {
                  const nextAnchor = { ...anchor };
                  delete nextAnchor.id;
                  return nextAnchor;
              })
            : layer.anchors,
        guides: Array.isArray(layer.guides)
            ? layer.guides.map((guide) => {
                  const nextGuide = { ...guide };
                  delete nextGuide.id;
                  return nextGuide;
              })
            : layer.guides
    };
}

function encodeYjsStateFromFontData(fontData) {
    const doc = new Y.Doc();
    const fontMap = doc.getMap('font');
    doc.transact(() => {
        jsonToYDoc(JSON.parse(JSON.stringify(fontData)), fontMap);
    });
    return Y.encodeStateAsUpdate(doc);
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
        const initialWorkerState = fontManager.buildWorkerSeedYjsState();
        fontManager.replaceWorkerYjsMirrorFromState(initialWorkerState);
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
            .mockResolvedValue({
                success: true,
                workerCacheStatus: makeWorkerCacheStatus()
            });
    });

    afterEach(() => {
        updateDirtyIndicatorSpy?.mockRestore();
        sendMessageSpy?.mockRestore();
        delete window.patchSyncEngine;
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
        expect(fontCompilation.lastStoredFontJson).toBeNull();
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

    test('interactive outline drag saves wait for the committed Yjs compile funnel', async () => {
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

        // scheduleFullCompileDebounce is now handled by CompiledEditFunnel,
        // not by saveLayerData itself.
        expect(fontManager.scheduleFullCompileDebounce).toHaveBeenCalledTimes(
            0
        );
        expect(
            window.autoCompileManager.checkAndSchedule
        ).not.toHaveBeenCalled();
        expect(fontManager.currentFont.markDirty).toHaveBeenCalledWith(
            'mouse-drag-outline',
            { requestEditingCompile: false }
        );
        expect(fontManager.lastChangeSource).toBeNull();
        expect(fontManager.lastEditType).toBeNull();
    });

    test('interactive anchor drag saves wait for the committed Yjs compile funnel', async () => {
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

        // scheduleFullCompileDebounce is now handled by CompiledEditFunnel,
        // not by saveLayerData itself.
        expect(fontManager.scheduleFullCompileDebounce).toHaveBeenCalledTimes(
            0
        );
        expect(
            window.autoCompileManager.checkAndSchedule
        ).not.toHaveBeenCalled();
        expect(fontManager.currentFont.markDirty).toHaveBeenCalledWith(
            'mouse-drag-anchor',
            { requestEditingCompile: false }
        );
        expect(fontManager.lastChangeSource).toBeNull();
        expect(fontManager.lastEditType).toBeNull();
    });

    test('interactive anchor drag saves current source glyph shapes', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const currentShapes = cloneJson(layer.shapes);
        const staleStoredShapes = [];
        glyph.layers.find((entry) => entry.id === layer.id).shapes =
            staleStoredShapes;

        await fontManager.saveLayerData(
            'a',
            layer.id,
            {
                ...cloneJson(layer),
                shapes: currentShapes,
                anchors: [{ name: 'top', x: 180, y: 760 }]
            },
            'mouse-drag-anchor'
        );

        const savedLayer = glyph.layers.find((entry) => entry.id === layer.id);

        expect(
            stripLayerStableIds({ shapes: savedLayer.shapes }).shapes
        ).toEqual(stripLayerStableIds({ shapes: currentShapes }).shapes);
        expect(savedLayer.shapes).not.toBe(staleStoredShapes);
        expect(savedLayer.anchors).toEqual([{ name: 'top', x: 180, y: 760 }]);
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

    test('normalizeLayerForRust drops null optional numeric fields', () => {
        const normalized = fontManager.normalizeLayerForRust({
            width: 500,
            height: null,
            vertWidth: null,
            location: {
                wght: null,
                wdth: 75
            },
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
                    location: {
                        wght: null,
                        wdth: 75
                    }
                }
            ],
            guides: [
                {
                    pos: {
                        x: 1,
                        y: 2,
                        angle: null
                    },
                    name: 'baseline'
                }
            ]
        });

        expect(normalized.height).toBeUndefined();
        expect(normalized.vertWidth).toBeUndefined();
        expect(normalized.location).toEqual({ wdth: 75 });
        expect(normalized.shapes[0].location).toEqual({ wdth: 75 });
        expect(normalized.guides[0].pos).toEqual({ x: 1, y: 2 });
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

    test('interactive saves reject malformed path nodes before mutating stored data', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const originalLayerRef = layer;
        const editedLayer = cloneJson(layer);
        editedLayer.shapes = [
            {
                ...cloneJson(layer.shapes[0]),
                nodes: 42
            }
        ];

        await expect(
            fontManager.saveLayerData(
                'a',
                layer.id,
                editedLayer,
                'keyboard-outline'
            )
        ).rejects.toThrow(
            /Path shape nodes must be an array or upstream string/
        );

        const savedLayer = fontManager.currentFont.babelfontData.glyphs
            .find((entry) => entry.name === 'a')
            .layers.find((entry) => entry.id === layer.id);
        const modelLayer = fontManager.currentFont.fontModel
            .findGlyph('a')
            .findLayerById(layer.id);

        expect(savedLayer).toBe(originalLayerRef);
        expect(stripLayerStableIds(savedLayer).shapes).toEqual(
            stripLayerStableIds(layer).shapes
        );
        expect(stripLayerStableIds(modelLayer.toJSON()).shapes).toEqual(
            stripLayerStableIds(layer).shapes
        );
        expect(fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(false);
    });

    test('interactive saves rebind the bridge snapshot to the authoritative font JSON', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const editedLayer = cloneJson(layer);
        editedLayer.width = 645;

        window.patchSyncEngine = {
            setFontJson: jest.fn()
        };

        await fontManager.saveLayerData(
            'a',
            layer.id,
            editedLayer,
            'keyboard-outline'
        );

        expect(window.patchSyncEngine.setFontJson).toHaveBeenCalledWith(
            fontManager.currentFont.babelfontData
        );
    });

    test('keyboard saves do not send a duplicate worker cache update before the authoritative Yjs packet', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const editedLayer = cloneJson(layer);
        let resolveDirtyIndicator = null;
        const pendingDirtyIndicator = new Promise((resolve) => {
            resolveDirtyIndicator = resolve;
        });

        updateDirtyIndicatorSpy.mockRestore();
        updateDirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockImplementation(() => pendingDirtyIndicator);

        const savePromise = fontManager.saveLayerData(
            'a',
            layer.id,
            editedLayer,
            'keyboard-outline'
        );

        expect(sendMessageSpy).not.toHaveBeenCalled();

        resolveDirtyIndicator?.();
        await savePromise;

        expect(sendMessageSpy).not.toHaveBeenCalled();
        expect(fontManager.getBoundaryCrossingStats()).toEqual({
            submitBatchCalls: 0,
            layersTransmitted: 0,
            glyphsTransmitted: 0,
            fullFontCrossings: 0
        });
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
        expect(stripLayerStableIds(savedLayer).shapes).toEqual(
            stripLayerStableIds({ shapes: originalShapes }).shapes
        );
        expect(savedLayer.anchors).toEqual(originalAnchors);
        expect(stripLayerStableIds(modelLayer.toJSON()).shapes).toEqual(
            stripLayerStableIds({ shapes: originalShapes }).shapes
        );
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

    test('serializeLayerForStorage rejects malformed path nodes instead of repairing them', () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        expect(() =>
            fontManager.serializeLayerForStorage(
                'a',
                layer.id,
                {
                    ...cloneJson(layer),
                    shapes: [
                        {
                            nodes: 42,
                            closed: false
                        }
                    ]
                },
                undefined
            )
        ).toThrow(/Path shape nodes must be an array or upstream string/);
    });

    test('serializeLayerForStorage prunes semantically empty optional containers', () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        glyph.layers[glyph.layers.indexOf(layer)] = {
            ...cloneJson(layer),
            format_specific: undefined,
            guides: undefined
        };

        const serialized = fontManager.serializeLayerForStorage(
            'a',
            layer.id,
            {
                ...cloneJson(layer),
                format_specific: undefined,
                guides: [],
                anchors: [
                    {
                        name: 'top',
                        x: 100,
                        y: 200,
                        format_specific: {}
                    }
                ]
            },
            undefined
        );

        expect(serialized.guides).toBeUndefined();
        expect(serialized.format_specific).toBeUndefined();
        expect(serialized.anchors).toEqual([
            {
                name: 'top',
                x: 100,
                y: 200
            }
        ]);
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
            0
        );
        expect(
            window.autoCompileManager.checkAndSchedule
        ).not.toHaveBeenCalled();
        expect(sendMessageSpy).not.toHaveBeenCalled();
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
            0
        );
        expect(
            window.autoCompileManager.checkAndSchedule
        ).not.toHaveBeenCalled();
        expect(sendMessageSpy).not.toHaveBeenCalled();
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
        ).not.toHaveBeenCalled();
        expect(sendMessageSpy).not.toHaveBeenCalled();
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
        ).not.toHaveBeenCalled();
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
        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                invalidateLayoutClosure: false,
                update: expect.any(Uint8Array),
                changedGlyphs: ['a']
            })
        );
        expect(fontCompilation.lastStoredFontJson).toBe(
            currentFont.babelfontJson
        );
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
        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                invalidateLayoutClosure: false,
                update: expect.any(Uint8Array),
                changedGlyphs: ['a']
            })
        );
        expect(
            currentFont.babelfontData.glyphs
                .find((entry) => entry.name === 'a')
                .layers.find((entry) => entry.id === layerId).width
        ).toBe(explicitLayer.width);
    });

    test('refreshGlyphsAfterModelBatch rejects invalid path nodes before sending layer data to Rust', async () => {
        const currentFont = fontManager.currentFont;
        const glyph = currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const layer = glyph.layers.find((entry) => entry.id === layerId);

        layer.shapes = [
            {
                Path: {
                    nodes: 42,
                    closed: false
                },
                reference: 'acute',
                transform: [1, 0, 0, 1, 0, 0],
                isInterpolated: false
            },
            {
                nodes: 42,
                closed: false
            }
        ];

        await expect(
            fontManager.refreshGlyphsAfterModelBatch(['a'], layerId)
        ).rejects.toThrow(
            /Path shape nodes must be an array or upstream string/
        );
        expect(sendMessageSpy).not.toHaveBeenCalled();
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
        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                invalidateLayoutClosure: false,
                update: expect.any(Uint8Array),
                changedGlyphs: [firstGlyph.name, secondGlyph.name]
            })
        );
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
        const allGlyphNames = currentFont.fontModel.glyphs
            .slice(0, 2)
            .map((glyph) => glyph.name);

        fontCompilation.lastStoredFontJson = currentFont.babelfontJson;
        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            await fontManager.refreshGlyphsAfterModelBatch(allGlyphNames);
        } finally {
            window.removeEventListener('glyphChanged', glyphChangedHandler);
        }

        // Exactly one event must have fired, carrying all glyph names.
        expect(glyphChangedHandler).toHaveBeenCalledTimes(1);
        const detail = glyphChangedHandler.mock.calls[0][0].detail;
        expect(detail.glyphName).toBe(allGlyphNames[0]);
        expect(detail.glyphNames).toEqual(allGlyphNames);
        expect(detail.layerId).toBeUndefined();
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
        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                invalidateLayoutClosure: false,
                update: expect.any(Uint8Array),
                changedGlyphs: ['a']
            })
        );
        expect(fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(false);
    });

    test('updateWorkerFontCache batches a materialized background layer', async () => {
        const currentFont = fontManager.currentFont;
        const glyph = currentFont.fontModel.findGlyph('a');
        const foreground = glyph.addLayer(600);
        const background = glyph.addBackgroundLayer(foreground);
        const path = background.addPath(false);
        path._appendLine({ x: 100, y: 200 });
        expect(glyph.layers.some((layer) => layer.id === background.id)).toBe(
            false
        );
        expect(glyph.findLayerById(background.id)?.is_background).toBe(true);
        const submitLayerUpdatesSpy = jest
            .spyOn(fontManager, 'submitLayerUpdatesToWorkerCache')
            .mockResolvedValue(true);

        fontManager.pendingBabelfontJsonSyncAfterDrag = true;
        window.glyphCanvas = {
            outlineEditor: {
                currentGlyphName: 'a',
                selectedLayerId: background.id
            },
            getCurrentGlyphName: jest.fn(() => 'a')
        };

        try {
            await fontManager.updateWorkerFontCache();

            expect(submitLayerUpdatesSpy).toHaveBeenCalledWith([
                expect.objectContaining({
                    glyphName: 'a',
                    layerId: background.id,
                    layerData: expect.objectContaining({
                        id: background.id,
                        is_background: true
                    })
                })
            ]);
            expect(fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(false);
        } finally {
            delete window.glyphCanvas;
            submitLayerUpdatesSpy.mockRestore();
        }
    });
});

describe('FontManager editing subset inclusion', () => {
    let originalOpenedFonts;
    let originalCurrentFontId;
    let originalGlyphCanvas;
    let compileEditingSpy;
    let originalFontCompilationInitialized;
    let saveEditingFontSpy;
    let hideErrorSpy;

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
        hideErrorSpy = jest
            .spyOn(sidebarErrorDisplay, 'hideError')
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
        hideErrorSpy?.mockRestore();
        fontManager.clearLiveDragPreview();
        fontManager.updateEditingSubsetSnapshot([]);
        fontManager.openedFonts = originalOpenedFonts;
        fontManager.currentFontId = originalCurrentFontId;
        window.glyphCanvas = originalGlyphCanvas;
        fontCompilation.isInitialized = originalFontCompilationInitialized;
    });

    function setRequestCompileContext(
        changeSource,
        editType,
        dataFreshnessMode = null
    ) {
        fontManager.setEditingCompileContext(changeSource, editType);
        fontManager.recordEditingCompileRequestContext(
            fontManager.currentFont.compileRequestVersion,
            { changeSource, editType, dataFreshnessMode }
        );
    }

    test('validateBabelfontJsonForRust preserves DefaultForMaster layer ids instead of rewriting them', () => {
        const fontData = cloneJson(fontManager.currentFont.babelfontData);
        fontData.glyphs[0].name = 'a';
        fontData.glyphs[0].layers[0].id = 'temp-layer-id';
        const masterId = fontData.masters[0].id;
        fontData.glyphs[0].layers[0].master = {
            type: 'DefaultForMaster',
            master: masterId
        };

        const validatedJson = fontManager['validateBabelfontJsonForRust'](
            JSON.stringify(fontData),
            true
        );
        const validatedData = JSON.parse(validatedJson);

        expect(validatedData.glyphs[0].layers[0].id).toBe('temp-layer-id');
        expect(validatedData.glyphs[0].layers[0].master).toEqual({
            type: 'DefaultForMaster',
            master: masterId
        });
    });

    test('validateBabelfontJsonForRust accepts canonical node strings without malformed-shape logs', () => {
        const fontData = cloneJson(fontManager.currentFont.babelfontData);
        fontData.glyphs[0].layers[0].shapes = [
            { nodes: '100 200 m', closed: false }
        ];
        fontData.glyphs[0].layers.push({
            id: 'background-layer-1',
            width: fontData.glyphs[0].layers[0].width,
            is_background: true,
            background_layer_id: fontData.glyphs[0].layers[0].id,
            shapes: [{ nodes: '100 200 l', closed: true }]
        });
        const errorSpy = jest
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        try {
            const validatedJson = fontManager['validateBabelfontJsonForRust'](
                JSON.stringify(fontData),
                true
            );

            expect(
                JSON.parse(validatedJson).glyphs[0].layers[0].shapes[0]
            ).toEqual({ nodes: '100 200 m', closed: false });
            expect(
                JSON.parse(validatedJson).glyphs[0].layers[1].shapes[0]
            ).toEqual({ nodes: '100 200 l', closed: true });
            expect(errorSpy).not.toHaveBeenCalled();
        } finally {
            errorSpy.mockRestore();
        }
    });

    test('validateBabelfontJsonForRust rejects missing layer widths instead of synthesizing zero', () => {
        const fontData = cloneJson(fontManager.currentFont.babelfontData);
        delete fontData.glyphs[0].layers[0].width;

        expect(() =>
            fontManager['validateBabelfontJsonForRust'](
                JSON.stringify(fontData),
                true
            )
        ).toThrow(/invalid width/);
    });

    test('validateBabelfontJsonForRust accepts object-shaped master kerning', () => {
        const fontData = cloneJson(fontManager.currentFont.babelfontData);
        fontData.masters[0].kerning = {
            'A:V': -80,
            'A:@RightGroup': -60
        };

        const validatedJson = fontManager['validateBabelfontJsonForRust'](
            JSON.stringify(fontData),
            true
        );
        const validatedData = JSON.parse(validatedJson);

        expect(validatedData.masters[0].kerning).toEqual({
            'A:V': -80,
            'A:@RightGroup': -60
        });
    });

    test('compileEditingFont adds the active edited glyph to the subset', async () => {
        setRequestCompileContext('keyboard-outline', 'outline');

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][2]).toEqual(['a', 'n']);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'keyboard-outline'
        });
    });

    test('structural outline compiles force full mode and skip incremental dirty-layer patching', async () => {
        setRequestCompileContext('keyboard-outline', 'outline');
        fontManager.forceFullEditingCacheRefresh = true;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][2]).toEqual(['a', 'n']);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'keyboard-outline'
        });
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).toBeUndefined();
        expect(fontManager.forceFullEditingCacheRefresh).toBe(false);
    });

    test('mouse-drag outline compiles keep the outline-only fast path even when dragging getter is false at compile time', async () => {
        setRequestCompileContext('mouse-drag-outline', 'outline');
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
            }
        });
    });

    test('compileEditingFont uses request-scoped context after live drag globals are cleared', async () => {
        fontManager.currentFont.compileRequestVersion = 2;
        compileEditingSpy.mockResolvedValueOnce({
            result: new Uint8Array([1, 2, 3]),
            filename: 'editing.ttf',
            time_taken: 1,
            fontRevisionKey: '2'
        });

        fontManager.setEditingCompileContext('mouse-drag-outline', 'outline');
        fontManager.recordEditingCompileRequestContext(2, {
            changeSource: 'mouse-drag-outline',
            editType: 'outline',
            dataFreshnessMode: 'live-drag-worker-preview'
        });
        fontManager.clearEditingCompileContext();
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
            }
        });
        expect(fontManager.lastChangeSource).toBeNull();
        expect(fontManager.lastEditType).toBeNull();
    });

    test('mouse-drag outline compiles do not force a full JSON sync when incremental layer patching is available', async () => {
        setRequestCompileContext(
            'mouse-drag-outline',
            'outline',
            'live-drag-worker-preview'
        );
        fontManager.pendingBabelfontJsonSyncAfterDrag = true;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(
            fontManager.currentFont.syncJsonFromModel
        ).not.toHaveBeenCalled();
        expect(fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(true);
        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'mouse-drag-outline',
            usePatchedWorkerCache: true,
            usePreviewLayerOverlay: true
        });
    });

    test('keyboard outline compile after a drag resyncs stale canonical JSON before compiling', async () => {
        setRequestCompileContext('keyboard-outline', 'outline');
        fontManager.pendingBabelfontJsonSyncAfterDrag = true;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(fontManager.currentFont.syncJsonFromModel).toHaveBeenCalledTimes(
            1
        );
        expect(fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(false);
        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'keyboard-outline',
            optionOverrides: {
                skip_features: true,
                skip_kerning: true,
                produce_varc_table: false
            }
        });
    });

    test('authoritative committed keyboard outline compile after a drag skips the stale canonical JSON resync', async () => {
        setRequestCompileContext(
            'keyboard-outline',
            'outline',
            'authoritative-worker-yjs'
        );
        fontManager.pendingBabelfontJsonSyncAfterDrag = true;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(
            fontManager.currentFont.syncJsonFromModel
        ).not.toHaveBeenCalled();
        expect(fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(true);
        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'keyboard-outline',
            optionOverrides: {
                skip_features: true,
                skip_kerning: true,
                produce_varc_table: false
            }
        });
    });

    test('remote outline compile after a drag resyncs stale canonical JSON before compiling', async () => {
        setRequestCompileContext('remote-outline', 'outline');
        fontManager.pendingBabelfontJsonSyncAfterDrag = true;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(fontManager.currentFont.syncJsonFromModel).toHaveBeenCalledTimes(
            1
        );
        expect(fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(false);
        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'remote-outline',
            optionOverrides: {
                skip_features: true,
                skip_kerning: true,
                produce_varc_table: false
            }
        });
    });

    test('authoritative committed remote outline compile after a drag skips the stale canonical JSON resync', async () => {
        setRequestCompileContext(
            'remote-outline',
            'outline',
            'authoritative-worker-yjs'
        );
        fontManager.pendingBabelfontJsonSyncAfterDrag = true;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(
            fontManager.currentFont.syncJsonFromModel
        ).not.toHaveBeenCalled();
        expect(fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(true);
        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'remote-outline',
            optionOverrides: {
                skip_features: true,
                skip_kerning: true,
                produce_varc_table: false
            }
        });
    });

    test('authoritative committed undo outline compile after a drag skips the stale canonical JSON resync', async () => {
        setRequestCompileContext(
            'keyboard-outline',
            'outline',
            'authoritative-worker-yjs'
        );
        fontManager.pendingBabelfontJsonSyncAfterDrag = true;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(
            fontManager.currentFont.syncJsonFromModel
        ).not.toHaveBeenCalled();
        expect(fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(true);
        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'keyboard-outline',
            optionOverrides: {
                skip_features: true,
                skip_kerning: true,
                produce_varc_table: false
            }
        });
    });

    test('keyboard-sidebearing compiles stay on the outline-only incremental fast path', async () => {
        setRequestCompileContext('keyboard-sidebearing', 'outline');

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'keyboard-sidebearing',
            optionOverrides: {
                skip_features: true,
                skip_kerning: true,
                produce_varc_table: false
            }
        });
    });

    test('master reinterpolation batch compiles stay on the outline-only incremental fast path', async () => {
        setRequestCompileContext('master-reinterpolate-batch', 'outline');

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(
            fontManager.currentFont.syncJsonFromModel
        ).not.toHaveBeenCalled();
        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'master-reinterpolate-batch',
            optionOverrides: {
                skip_features: true,
                skip_kerning: true,
                produce_varc_table: false
            }
        });
    });

    test('recompileEditingFont ignores stale ambient context without a request snapshot', async () => {
        fontManager.lastChangeSource = 'keyboard-outline';
        fontManager.lastEditType = 'outline';
        fontManager.currentFont.compileRequestVersion = 99;

        await fontManager.recompileEditingFont();

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).not.toMatchObject({
            compileSource: 'keyboard-outline'
        });
        expect(
            compileEditingSpy.mock.calls[0][3]?.optionOverrides
        ).toBeUndefined();
    });

    test('mouse-drag anchor compiles keep kerning enabled in anchor-only mode', async () => {
        setRequestCompileContext('mouse-drag-anchor', 'anchor');
        window.glyphCanvas.outlineEditor.draggingSomething = false;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'mouse-drag-anchor',
            dragActive: true,
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
    });

    test('keyboard-anchor compiles keep kerning enabled in anchor-only mode', async () => {
        setRequestCompileContext('keyboard-anchor', 'anchor');

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'keyboard-anchor',
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
    });

    test('remote-anchor compiles keep kerning enabled in anchor-only mode', async () => {
        setRequestCompileContext('remote-anchor', 'anchor');

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
    });

    test('anchor undo-redo compiles keep kerning enabled in anchor-only mode', async () => {
        setRequestCompileContext('keyboard-anchor', 'anchor');

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'keyboard-anchor',
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
    });

    test('keyboard kerning-value compiles use the kerning-only fast path', async () => {
        setRequestCompileContext('keyboard-kerning-value', 'kerning-value');

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'keyboard-kerning-value',
            optionOverrides: {
                produce_varc_table: false
            }
        });
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_outlines');
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_kerning');
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_features');
    });

    test('remote kern-group compiles use the kerning-only fast path', async () => {
        setRequestCompileContext('remote-kerning-groups', 'kerning-groups');

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'remote-kerning-groups',
            optionOverrides: {
                produce_varc_table: false
            }
        });
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_outlines');
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_kerning');
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_features');
    });

    test('debounced post-interaction full compiles do not send incremental dirty-layer patches', async () => {
        setRequestCompileContext(
            'debounced-post-interaction-full-compile',
            null
        );

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'debounced-post-interaction-full-compile'
        });
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).toBeUndefined();
    });

    test.each([
        ['keyboard-outline', 'outline', 'outline-only'],
        ['keyboard', 'outline', 'outline-only'],
        ['keyboard-sidebearing', 'outline', 'outline-only'],
        ['keyboard-anchor', 'anchor', 'anchor-only'],
        ['mouse-drag-outline', 'outline', 'outline-only'],
        ['mouse-drag-anchor', 'anchor', 'anchor-only'],
        ['debounced-post-interaction-full-compile', null, 'full']
    ])(
        'compileEditingFont clears processed compile context for %s',
        async (changeSource, editType, expectedMode) => {
            setRequestCompileContext(changeSource, editType);
            window.glyphCanvas.outlineEditor.draggingSomething = false;

            await fontManager.compileEditingFont('a', [], ['a']);

            expect(compileEditingSpy).toHaveBeenCalledTimes(1);
            expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
                compileSource: changeSource
            });
            expect(fontManager.lastCompilationMode).toBe(expectedMode);
            expect(fontManager.lastChangeSource).toBeNull();
            expect(fontManager.lastEditType).toBeNull();
        }
    );

    test('stale editing compile results do not clear a newer error state', async () => {
        const priorEditingFont = new Uint8Array([9, 9, 9]);
        fontManager.editingFont = priorEditingFont;
        setRequestCompileContext('keyboard-outline', 'outline');

        let resolveCompile;
        compileEditingSpy.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveCompile = resolve;
                })
        );

        const dispatchEventSpy = jest.spyOn(window, 'dispatchEvent');

        try {
            const compilePromise = fontManager.compileEditingFont(
                'a',
                [],
                ['a']
            );

            fontManager.currentFont.compileRequestVersion = 2;
            setRequestCompileContext('keyboard-anchor', 'anchor');

            resolveCompile({
                result: new Uint8Array([1, 2, 3]),
                filename: 'editing.ttf',
                time_taken: 1,
                fontRevisionKey: '1'
            });

            const returnedFont = await compilePromise;

            expect(returnedFont).toBe(priorEditingFont);
            expect(fontManager.editingFont).toBe(priorEditingFont);
            expect(hideErrorSpy).not.toHaveBeenCalled();
            expect(
                dispatchEventSpy.mock.calls.some(
                    ([event]) => event?.type === 'editingFontCompiled'
                )
            ).toBe(false);
            expect(fontManager.lastChangeSource).toBe('keyboard-anchor');
            expect(fontManager.lastEditType).toBe('anchor');
        } finally {
            dispatchEventSpy.mockRestore();
        }
    });

    test('failed editing compile clears the matching compile context', async () => {
        const error = new Error('compile failed');
        compileEditingSpy.mockRejectedValueOnce(error);
        setRequestCompileContext('keyboard-anchor', 'anchor');
        const showErrorSpy = jest
            .spyOn(sidebarErrorDisplay, 'showError')
            .mockImplementation(() => {});
        const consoleErrorSpy = jest
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        try {
            await expect(
                fontManager.compileEditingFont('a', [], ['a'])
            ).rejects.toThrow('compile failed');

            expect(fontManager.lastChangeSource).toBeNull();
            expect(fontManager.lastEditType).toBeNull();
        } finally {
            showErrorSpy.mockRestore();
            consoleErrorSpy.mockRestore();
        }
    });

    test('active mouse-drag compiles use the cached incremental worker path', async () => {
        const compileFromJsonSpy = jest
            .spyOn(fontCompilation, 'compileFromJson')
            .mockResolvedValue({
                result: new Uint8Array([4, 5, 6]),
                filename: 'editing.ttf',
                time_taken: 2
            });
        const stagePreviewSpy = jest
            .spyOn(fontManager, 'stageLiveDragPreviewFromModel')
            .mockImplementation(async () => {
                fontManager.pendingBabelfontJsonSyncAfterDrag = true;
            });

        try {
            window.glyphCanvas.outlineEditor.draggingSomething = true;
            setRequestCompileContext(
                'mouse-drag-outline',
                'outline',
                'live-drag-worker-preview'
            );
            await fontManager.stageLiveDragPreviewFromModel(['a'], 'layer-1', {
                dispatchGlyphChanged: false
            });

            await fontManager.compileEditingFont('a', [], ['a']);

            expect(compileFromJsonSpy).not.toHaveBeenCalled();
            expect(compileEditingSpy).toHaveBeenCalledWith(
                expect.any(String),
                expect.any(String),
                ['a', 'n'],
                expect.objectContaining({
                    dragActive: true,
                    compileSource: 'mouse-drag-outline',
                    optionOverrides: expect.objectContaining({
                        skip_features: true,
                        skip_kerning: true,
                        produce_varc_table: false
                    }),
                    usePatchedWorkerCache: true,
                    usePreviewLayerOverlay: true
                })
            );
        } finally {
            window.glyphCanvas.outlineEditor.draggingSomething = false;
            stagePreviewSpy.mockRestore();
            compileFromJsonSpy.mockRestore();
        }
    });

    test('failed stale editing compile does not clear newer context', async () => {
        let rejectCompile;
        compileEditingSpy.mockImplementation(
            () =>
                new Promise((resolve, reject) => {
                    rejectCompile = reject;
                })
        );
        setRequestCompileContext('keyboard-outline', 'outline');
        const showErrorSpy = jest
            .spyOn(sidebarErrorDisplay, 'showError')
            .mockImplementation(() => {});
        const consoleErrorSpy = jest
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        try {
            const compilePromise = fontManager.compileEditingFont(
                'a',
                [],
                ['a']
            );

            fontManager.currentFont.compileRequestVersion = 2;
            setRequestCompileContext('keyboard-anchor', 'anchor');
            rejectCompile(new Error('stale compile failed'));

            await expect(compilePromise).rejects.toThrow(
                'stale compile failed'
            );
            expect(fontManager.lastChangeSource).toBe('keyboard-anchor');
            expect(fontManager.lastEditType).toBe('anchor');
        } finally {
            showErrorSpy.mockRestore();
            consoleErrorSpy.mockRestore();
        }
    });

    test('skipped editing compile without subset glyphs clears matching context', async () => {
        setRequestCompileContext('keyboard-outline', 'outline');
        fontManager.updateEditingSubsetSnapshot([]);
        window.glyphCanvas.textRunEditor.textBuffer = '';
        window.glyphCanvas.textRunEditor.glyphNameBuffer = [];
        const deriveSubsetSpy = jest
            .spyOn(fontManager, 'deriveSubsetGlyphsFromText')
            .mockReturnValue([]);

        try {
            const returnedFont = await fontManager.compileEditingFont(
                '',
                [],
                undefined
            );

            expect(returnedFont).toBe(fontManager.editingFont);
            expect(compileEditingSpy).not.toHaveBeenCalled();
            expect(fontManager.lastChangeSource).toBeNull();
            expect(fontManager.lastEditType).toBeNull();
        } finally {
            deriveSubsetSpy.mockRestore();
        }
    });

    test('pre-compile model sync failure clears matching context', async () => {
        setRequestCompileContext('feature-code', null);
        const syncSpy = jest
            .spyOn(fontManager, 'syncBabelfontJsonFromCurrentModel')
            .mockReturnValue(false);

        try {
            await expect(
                fontManager.compileEditingFont('a', [], ['a'])
            ).rejects.toThrow(
                'Failed to sync font model before editing compile'
            );

            expect(compileEditingSpy).not.toHaveBeenCalled();
            expect(fontManager.lastChangeSource).toBeNull();
            expect(fontManager.lastEditType).toBeNull();
        } finally {
            syncSpy.mockRestore();
        }
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
                    collectComponentDependentGlyphs: jest.fn(
                        (
                            glyphNames,
                            {
                                includeSourceGlyphNames = false,
                                retainGlyphNames
                            } = {}
                        ) => {
                            const result = new Set();
                            const sources = Array.from(glyphNames || []);

                            if (includeSourceGlyphNames) {
                                for (const glyphName of sources) {
                                    result.add(glyphName);
                                }
                            }

                            const memo = new Map();
                            const visiting = new Set();
                            const reachesRetainedGlyph = (glyphName) => {
                                if (memo.has(glyphName)) {
                                    return memo.get(glyphName);
                                }
                                if (visiting.has(glyphName)) {
                                    return false;
                                }

                                visiting.add(glyphName);
                                let shouldRetain =
                                    retainGlyphNames?.has(glyphName) || false;
                                for (const dependentGlyphName of dependencyGraph[
                                    glyphName
                                ] || []) {
                                    if (
                                        reachesRetainedGlyph(dependentGlyphName)
                                    ) {
                                        result.add(dependentGlyphName);
                                        shouldRetain = true;
                                    }
                                }
                                visiting.delete(glyphName);
                                memo.set(glyphName, shouldRetain);
                                return shouldRetain;
                            };

                            for (const glyphName of sources) {
                                for (const dependentGlyphName of dependencyGraph[
                                    glyphName
                                ] || []) {
                                    if (
                                        reachesRetainedGlyph(dependentGlyphName)
                                    ) {
                                        result.add(dependentGlyphName);
                                    }
                                }
                            }

                            return result;
                        }
                    )
                }
            );

        expect(scopedGlyphNames).toEqual(
            new Set(['sourceGlyph', 'bridgeGlyph', 'visibleLeaf'])
        );
    });
});

describe('FontManager share button visibility', () => {
    let originalOpenedFonts;
    let originalCurrentFontId;
    let originalFontDisplay;
    let originalFontIconElement;
    let originalFontNameElement;
    let originalFontRoleBadgeElement;
    let originalCloudPlugin;
    let originalWindowRole;

    function mountDisplayDom() {
        document.body.innerHTML = `
            <div id="current-font-display" class="current-font-display">
                <span class="font-icon"></span>
                <span class="font-name"></span>
            </div>
            <button id="share-btn" class="share-button" title="Invite people">
                <span class="material-symbols-outlined">group_add</span>
            </button>
            <span id="cloud-access-role-badge" class="cloud-access-role-badge" aria-hidden="true"></span>
        `;

        fontManager.fontDisplay = document.getElementById(
            'current-font-display'
        );
        fontManager.fontIconElement =
            fontManager.fontDisplay.querySelector('.font-icon');
        fontManager.fontNameElement =
            fontManager.fontDisplay.querySelector('.font-name');
        fontManager.fontRoleBadgeElement = null;
    }

    function setCurrentFont({
        isCloudBacked = true,
        role = 'owner',
        path = '/cloud/TestFont.babelfont'
    } = {}) {
        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    name: 'TestFont',
                    path,
                    sourcePlugin: {
                        getIcon: () => '<span>cloud</span>',
                        getName: () => 'Cloud'
                    },
                    isCloudBacked: () => isCloudBacked
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        window.cloudPlugin = {
            getCurrentAssetRole: jest.fn(() => role),
            getAssetSizeWarningState: jest.fn(() => null),
            getAssetConnectionStatus: jest.fn(() => 'connected'),
            getAssetConnectionDetail: jest.fn(() => undefined),
            hasConnectionProblem: jest.fn(() => false),
            getAssetPendingSyncCount: jest.fn(() => 0)
        };
    }

    beforeEach(() => {
        originalOpenedFonts = fontManager.openedFonts;
        originalCurrentFontId = fontManager.currentFontId;
        originalFontDisplay = fontManager.fontDisplay;
        originalFontIconElement = fontManager.fontIconElement;
        originalFontNameElement = fontManager.fontNameElement;
        originalFontRoleBadgeElement = fontManager.fontRoleBadgeElement;
        originalCloudPlugin = window.cloudPlugin;
        originalWindowRole = window.windowRole;

        window.windowRole = {
            getRoleLabel: () => 'Main',
            getTitleSuffix: () => '(Main)',
            isMainWindow: () => true
        };

        mountDisplayDom();
    });

    afterEach(() => {
        fontManager.openedFonts = originalOpenedFonts;
        fontManager.currentFontId = originalCurrentFontId;
        fontManager.fontDisplay = originalFontDisplay;
        fontManager.fontIconElement = originalFontIconElement;
        fontManager.fontNameElement = originalFontNameElement;
        fontManager.fontRoleBadgeElement = originalFontRoleBadgeElement;
        window.cloudPlugin = originalCloudPlugin;
        window.windowRole = originalWindowRole;
        jest.useRealTimers();
        document.body.innerHTML = '';
    });

    test.each([
        ['editor', 'role-editor', 'edit'],
        ['viewer', 'role-viewer', 'visibility']
    ])(
        'hides the share button for cloud %s access',
        (role, expectedRoleClass, expectedIcon) => {
            setCurrentFont({ role });

            fontManager.updateFontDisplay();

            const shareButton = document.getElementById('share-btn');
            const cloudAccessRoleBadge = document.getElementById(
                'cloud-access-role-badge'
            );

            expect(shareButton.classList.contains('visible')).toBe(false);
            expect(cloudAccessRoleBadge.classList.contains('visible')).toBe(
                true
            );
            expect(
                cloudAccessRoleBadge.classList.contains(expectedRoleClass)
            ).toBe(true);
            expect(cloudAccessRoleBadge.innerHTML).toContain(expectedIcon);
        }
    );

    test('shows an icon-only share button for cloud owners', () => {
        setCurrentFont({ role: 'owner' });

        fontManager.updateFontDisplay();

        const shareButton = document.getElementById('share-btn');
        const cloudAccessRoleBadge = document.getElementById(
            'cloud-access-role-badge'
        );

        expect(shareButton.classList.contains('visible')).toBe(true);
        expect(shareButton.textContent.trim()).toBe('group_add');
        expect(cloudAccessRoleBadge.classList.contains('visible')).toBe(false);
    });

    test('hides cloud-only affordances when the cloud plugin is disabled in UI', () => {
        setCurrentFont({ role: 'owner', path: 'cloud://asset-1' });
        window.cloudPlugin.isVisibleInUI = jest.fn(() => false);
        window.cloudPlugin.hasConnectionProblem.mockReturnValue(true);
        window.cloudPlugin.getAssetConnectionStatus.mockReturnValue(
            'connecting'
        );

        fontManager.updateFontDisplay();

        const shareButton = document.getElementById('share-btn');
        const cloudAccessRoleBadge = document.getElementById(
            'cloud-access-role-badge'
        );
        const warningBadge = document.querySelector(
            '.cloud-connection-warning-badge'
        );

        expect(shareButton.classList.contains('visible')).toBe(false);
        expect(cloudAccessRoleBadge.classList.contains('visible')).toBe(false);
        expect(warningBadge.classList.contains('visible')).toBe(false);
        expect(warningBadge.hidden).toBe(true);
    });

    test('shows a connection warning badge next to the owner invite button while cloud sync is unstable', () => {
        setCurrentFont({ role: 'owner', path: 'cloud://asset-1' });
        window.cloudPlugin.hasConnectionProblem.mockReturnValue(true);
        window.cloudPlugin.getAssetConnectionStatus.mockReturnValue(
            'connecting'
        );
        window.cloudPlugin.getAssetConnectionDetail.mockReturnValue(
            'Access epoch is stale'
        );

        fontManager.updateFontDisplay();

        const warningBadge = document.querySelector(
            '.cloud-connection-warning-badge'
        );
        const shareButton = document.getElementById('share-btn');

        expect(shareButton.classList.contains('visible')).toBe(true);
        expect(warningBadge.classList.contains('visible')).toBe(true);
        expect(warningBadge.hidden).toBe(false);
        expect(warningBadge.getAttribute('title')).toBe(
            'Cloud status: Access epoch is stale'
        );
        expect(warningBadge.textContent).toContain('Reconnecting');
    });

    test('shows a persistent cloud size warning badge even when the connection is stable', () => {
        setCurrentFont({ role: 'owner', path: 'cloud://asset-1' });
        window.cloudPlugin.getAssetSizeWarningState.mockReturnValue({
            visible: true,
            title: 'Cloud status: Font is near the current cloud size limit (11.9 MiB of 16.0 MiB).',
            label: 'Near limit',
            icon: 'warning',
            tone: 'warning'
        });

        fontManager.updateFontDisplay();

        const warningBadge = document.querySelector(
            '.cloud-connection-warning-badge'
        );

        expect(warningBadge.classList.contains('visible')).toBe(true);
        expect(warningBadge.hidden).toBe(false);
        expect(warningBadge.getAttribute('title')).toBe(
            'Cloud status: Font is near the current cloud size limit (11.9 MiB of 16.0 MiB).'
        );
        expect(warningBadge.textContent).toContain('Near limit');
    });

    test('shows a connection warning badge for a cloud-backed font with no live adapter attached', () => {
        setCurrentFont({ role: 'owner', path: 'asset-1' });
        window.cloudPlugin.hasConnectionProblem.mockReturnValue(true);
        window.cloudPlugin.getAssetConnectionStatus.mockReturnValue(
            'disconnected'
        );

        fontManager.updateFontDisplay();

        const warningBadge = document.querySelector(
            '.cloud-connection-warning-badge'
        );

        expect(warningBadge.classList.contains('visible')).toBe(true);
        expect(warningBadge.hidden).toBe(false);
        expect(warningBadge.getAttribute('title')).toBe(
            'Cloud status: Cloud room is disconnected'
        );
        expect(warningBadge.textContent).toContain('Offline');
    });

    test('hides the connection warning badge while the cloud room is stable', () => {
        setCurrentFont({ role: 'editor', path: 'cloud://asset-1' });

        fontManager.updateFontDisplay();

        const warningBadge = document.querySelector(
            '.cloud-connection-warning-badge'
        );

        expect(warningBadge.classList.contains('visible')).toBe(false);
        expect(warningBadge.hidden).toBe(true);
    });

    test('does not show the connection warning badge during initial cloud authentication before any real connection problem exists', () => {
        setCurrentFont({ role: 'owner', path: 'cloud://asset-1' });
        window.cloudPlugin.getAssetConnectionStatus.mockReturnValue(
            'authenticating'
        );
        window.cloudPlugin.hasConnectionProblem.mockReturnValue(false);

        fontManager.updateFontDisplay();

        const warningBadge = document.querySelector(
            '.cloud-connection-warning-badge'
        );

        expect(warningBadge.classList.contains('visible')).toBe(false);
        expect(warningBadge.hidden).toBe(true);
        expect(warningBadge.getAttribute('title')).toBeNull();
    });

    test('shows a pending durable sync count while the cloud socket remains connected', () => {
        jest.useFakeTimers();
        setCurrentFont({ role: 'owner', path: 'cloud://asset-1' });
        window.cloudPlugin.getAssetPendingSyncCount.mockReturnValue(3);

        fontManager.updateFontDisplay();

        const warningBadge = document.querySelector(
            '.cloud-connection-warning-badge'
        );

        expect(warningBadge.classList.contains('visible')).toBe(false);
        expect(warningBadge.hidden).toBe(true);

        jest.advanceTimersByTime(1000);

        expect(warningBadge.classList.contains('visible')).toBe(true);
        expect(warningBadge.hidden).toBe(false);
        expect(warningBadge.getAttribute('title')).toBe(
            'Cloud status: 3 cloud edits waiting for durable sync'
        );
        expect(warningBadge.textContent).toContain('3 pending');
    });

    test('does not show the pending durable sync count if it clears before the 1s delay', () => {
        jest.useFakeTimers();
        setCurrentFont({ role: 'owner', path: 'cloud://asset-1' });
        window.cloudPlugin.getAssetPendingSyncCount.mockReturnValue(1);

        fontManager.updateFontDisplay();

        const warningBadge = document.querySelector(
            '.cloud-connection-warning-badge'
        );

        jest.advanceTimersByTime(500);
        window.cloudPlugin.getAssetPendingSyncCount.mockReturnValue(0);
        fontManager.updateFontDisplay();
        jest.advanceTimersByTime(1000);

        expect(warningBadge.classList.contains('visible')).toBe(false);
        expect(warningBadge.hidden).toBe(true);
    });

    test('cloud-backed fonts no longer use the dirty indicator for connection problems', async () => {
        setCurrentFont({ role: 'owner', path: 'cloud://asset-1' });
        fontManager.dirtyIndicator = document.createElement('span');
        window.cloudPlugin.hasConnectionProblem.mockReturnValue(true);

        await fontManager.updateDirtyIndicator();

        expect(fontManager.shouldShowDirtyState(fontManager.currentFont)).toBe(
            false
        );
        expect(fontManager.dirtyIndicator.classList.contains('visible')).toBe(
            false
        );
        expect(fontManager.dirtyIndicator.title).toBe(
            'Cloud font — changes sync continuously'
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

    test('preserves stored keyed sidebearing fallback when opening a font without marking it dirty', async () => {
        await fontManager.loadFont(
            JSON.stringify(cloneJson(intermediateLayerData)),
            '/user/intermediate_layer_on_a.glyphs',
            {}
        );

        const currentFont = fontManager.currentFont;
        withSuppressedModelRecording(() => {
            currentFont.fontModel.recomputeMetricsKeys();
        });
        currentFont.syncJsonFromModel();

        const glyph = currentFont.fontModel.findGlyph('a');
        const braceLayer = glyph.layers.find(
            (layer) => layer.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        expect(braceLayer.resolveMetricsKey('right').value).toBe(94);
        expect(braceLayer.rsb).toBe(94);
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
    //     `applyYjsUpdate` worker message (1 batch per commit, no matter
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
        fontManager.workerYjsSendQueue = Promise.resolve();
        fontManager.workerCacheUpdatePromise = null;
        fontManager.resetBoundaryCrossingStats();
        const initialWorkerState = fontManager.buildWorkerSeedYjsState();
        fontManager.replaceWorkerYjsMirrorFromState(initialWorkerState);

        updateDirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        window.autoCompileManager = { checkAndSchedule: jest.fn() };

        fontCompilation.isInitialized = true;
        fontCompilation.pendingWorkerDocumentSync = Promise.resolve();
        fontCompilation.setWorkerCacheDocumentReady(true);
        sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({
                success: true,
                workerCacheStatus: makeWorkerCacheStatus()
            });
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

        // Exactly one applyYjsUpdate message reached the worker, no storeFontJson.
        const messageTypes = sendMessageSpy.mock.calls.map(
            (args) => args[0]?.type
        );
        expect(messageTypes).toEqual(['applyYjsUpdate']);
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
        expect(messageTypes).toEqual(['applyYjsUpdate']);
        expect(sendMessageSpy.mock.calls[0][0]).toMatchObject({
            layerTargets: targets,
            invalidateLayoutClosure: false
        });
    });

    test('refreshWorkerCacheForReplayTargets reads active anchor replay targets from the bridge', async () => {
        const currentFont = fontManager.currentFont;
        const originalPatchSyncEngine = window.patchSyncEngine;
        const glyphName = 'a';
        const layerId = currentFont.fontModel.findGlyph(glyphName).layers[0].id;
        const bridgeDoc = new Y.Doc();
        jsonToYDoc(
            cloneJson(currentFont.babelfontData),
            bridgeDoc.getMap('font')
        );
        window.patchSyncEngine = {
            fontMap: bridgeDoc.getMap('font')
        };
        const bridgeLayer = yDocToJson(bridgeDoc.getMap('font'))
            .glyphs.find((glyph) => glyph.name === glyphName)
            .layers.find((layer) => layer.id === layerId);
        const pathIndex = bridgeLayer.shapes.findIndex(
            (shape) =>
                Array.isArray(shape.nodes) || typeof shape.nodes === 'string'
        );
        const bridgeNodes = parseNodeString(
            bridgeLayer.shapes[pathIndex].nodes
        );
        const bridgeNodeX = bridgeNodes[0].x + 101;
        const staleNodeX = bridgeNodes[0].x - 101;
        const serializeLayerForStorageSpy = jest.spyOn(
            fontManager,
            'serializeLayerForStorage'
        );

        setYPath(
            bridgeDoc.getMap('font'),
            [
                'glyphs',
                glyphName,
                'layers',
                layerId,
                'shapes',
                pathIndex,
                'nodes',
                0,
                'x'
            ],
            bridgeNodeX
        );
        currentFont.babelfontData.glyphs
            .find((glyph) => glyph.name === glyphName)
            .layers.find((layer) => layer.id === layerId).shapes[
            pathIndex
        ].nodes[0].x = staleNodeX;
        currentFont.fontModel = Font.fromData(
            cloneJson(currentFont.babelfontData)
        );

        window.glyphCanvas = {
            ...(window.glyphCanvas || {}),
            outlineEditor: {
                ...(window.glyphCanvas?.outlineEditor || {}),
                draggingSomething: true,
                currentGlyphName: glyphName,
                selectedLayerId: layerId
            }
        };
        fontManager.lastEditType = 'anchor';
        fontManager.lastChangeSource = 'mouse-drag-anchor';

        try {
            await fontManager.refreshWorkerCacheForReplayTargets([
                { glyphName, layerId }
            ]);

            expect(serializeLayerForStorageSpy).toHaveBeenCalledWith(
                glyphName,
                layerId,
                expect.objectContaining({ shapes: expect.any(Array) })
            );
            expect(serializeLayerForStorageSpy).not.toHaveBeenCalledWith(
                glyphName,
                layerId,
                expect.anything(),
                { preserveExistingShapes: true }
            );

            const storedLayer = currentFont.babelfontData.glyphs
                .find((glyph) => glyph.name === glyphName)
                .layers.find((layer) => layer.id === layerId);
            expect(
                parseNodeString(storedLayer.shapes[pathIndex].nodes)[0].x
            ).toBe(bridgeNodeX);

            const workerLayer = yDocToJson(
                fontManager.workerCacheYDoc.getMap('font')
            )
                .glyphs.find((glyph) => glyph.name === glyphName)
                .layers.find((layer) => layer.id === layerId);
            expect(
                parseNodeString(workerLayer.shapes[pathIndex].nodes)[0].x
            ).toBe(bridgeNodeX);
        } finally {
            serializeLayerForStorageSpy.mockRestore();
            fontManager.lastEditType = null;
            fontManager.lastChangeSource = null;
            window.patchSyncEngine = originalPatchSyncEngine;
        }
    });

    test('refreshWorkerCacheForReplayTargets does not preserve shapes for non-active anchor targets', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = currentFont.fontModel.findGlyph('a').layers[0].id;
        const serializeLayerForStorageSpy = jest.spyOn(
            fontManager,
            'serializeLayerForStorage'
        );

        window.glyphCanvas = {
            ...(window.glyphCanvas || {}),
            outlineEditor: {
                ...(window.glyphCanvas?.outlineEditor || {}),
                draggingSomething: false,
                currentGlyphName: 'a',
                selectedLayerId: 'different-layer'
            }
        };
        fontManager.lastEditType = 'anchor';
        fontManager.lastChangeSource = 'mouse-drag-anchor';

        try {
            await fontManager.refreshWorkerCacheForReplayTargets([
                { glyphName: 'a', layerId }
            ]);

            expect(serializeLayerForStorageSpy).toHaveBeenCalledWith(
                'a',
                layerId,
                expect.anything()
            );
            expect(serializeLayerForStorageSpy).not.toHaveBeenCalledWith(
                'a',
                layerId,
                expect.anything(),
                { preserveExistingShapes: true }
            );
        } finally {
            serializeLayerForStorageSpy.mockRestore();
            fontManager.lastEditType = null;
            fontManager.lastChangeSource = null;
        }
    });

    test('refreshWorkerCacheForReplayTargets falls back to babelfontData when the model layer is not materialized', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = currentFont.fontModel.findGlyph('a').layers[0].id;
        const jsonGlyph = currentFont.babelfontData.glyphs.find(
            (glyph) => glyph.name === 'a'
        );
        const jsonLayer = jsonGlyph.layers.find(
            (layer) => layer.id === layerId
        );
        const originalFindGlyph = currentFont.fontModel.findGlyph.bind(
            currentFont.fontModel
        );

        currentFont.fontModel.findGlyph = jest.fn((glyphName) => {
            const glyph = originalFindGlyph(glyphName);
            if (!glyph || glyphName !== 'a') {
                return glyph;
            }

            return {
                ...glyph,
                layers: glyph.layers.filter((layer) => layer.id !== layerId)
            };
        });

        try {
            await expect(
                fontManager.refreshWorkerCacheForReplayTargets([
                    { glyphName: 'a', layerId }
                ])
            ).resolves.toBe(true);

            expect(sendMessageSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'applyYjsUpdate',
                    layerTargets: [{ glyphName: 'a', layerId }]
                })
            );
            const storedGlyph = currentFont.babelfontData.glyphs.find(
                (glyph) => glyph.name === jsonGlyph.name
            );
            const storedLayer = storedGlyph.layers.find(
                (layer) => layer.id === layerId
            );
            expect(storedGlyph).toBeDefined();
            expect(stripLayerStableIds(storedLayer)).toEqual(
                stripLayerStableIds(jsonLayer)
            );
        } finally {
            currentFont.fontModel.findGlyph = originalFindGlyph;
        }
    });

    test('refreshWorkerCacheForReplayTargets bootstraps its worker mirror from babelfontData when babelfontJson is stale', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = currentFont.fontModel.findGlyph('a').layers[0].id;
        const originalBabelfontJson = currentFont.babelfontJson;
        const originalWorkerCacheYDoc = fontManager.workerCacheYDoc;

        currentFont.babelfontJson = '{';
        fontManager.workerCacheYDoc = null;

        try {
            await expect(
                fontManager.refreshWorkerCacheForReplayTargets([
                    { glyphName: 'a', layerId }
                ])
            ).resolves.toBe(true);

            expect(sendMessageSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'applyYjsUpdate',
                    layerTargets: [{ glyphName: 'a', layerId }]
                })
            );
        } finally {
            currentFont.babelfontJson = originalBabelfontJson;
            fontManager.workerCacheYDoc = originalWorkerCacheYDoc;
        }
    });

    test('refreshWorkerCacheForReplayTargets preserves the sparse baseline when the worker rejects the batch', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = currentFont.fontModel.findGlyph('a').layers[0].id;

        await expect(
            fontManager.refreshWorkerCacheForReplayTargets([
                { glyphName: 'a', layerId }
            ])
        ).resolves.toBe(true);

        const baselineState = Y.encodeStateAsUpdate(
            fontManager.workerCacheYDoc
        );
        sendMessageSpy
            .mockRejectedValueOnce(new Error('RuntimeError: unreachable'))
            .mockResolvedValueOnce({
                success: true,
                workerCacheStatus: makeWorkerCacheStatus()
            });

        await expect(
            fontManager.refreshWorkerCacheForReplayTargets([
                { glyphName: 'a', layerId }
            ])
        ).resolves.toBe(false);

        expect(
            Array.from(Y.encodeStateAsUpdate(fontManager.workerCacheYDoc))
        ).toEqual(Array.from(baselineState));

        await expect(
            fontManager.refreshWorkerCacheForReplayTargets([
                { glyphName: 'a', layerId }
            ])
        ).resolves.toBe(true);

        expect(sendMessageSpy).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                type: 'applyYjsUpdate',
                layerTargets: [{ glyphName: 'a', layerId }],
                invalidateLayoutClosure: false
            })
        );
        expect(sendMessageSpy).toHaveBeenNthCalledWith(
            3,
            expect.objectContaining({
                type: 'applyYjsUpdate',
                layerTargets: [{ glyphName: 'a', layerId }],
                invalidateLayoutClosure: false
            })
        );
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

    test('multi-layer Yjs batches preserve unrelated worker fingerprints while updating transmitted layers', async () => {
        const currentFont = fontManager.currentFont;
        const [first, second] = currentFont.fontModel.glyphs;
        const firstLayer = first.layers[0];
        const secondLayer = second.layers[0];

        firstLayer.width += 9;
        secondLayer.width += 13;
        fontManager.workerLayerFingerprintCache.set('stale::layer', 'stale');

        await fontManager.refreshGlyphsAfterModelBatch(
            [first.name, second.name],
            firstLayer.id
        );

        expect(
            fontManager.workerLayerFingerprintCache.get('stale::layer')
        ).toBe('stale');
        expect(
            fontManager.workerLayerFingerprintCache.has(
                `${first.name}::${firstLayer.id}`
            )
        ).toBe(true);
        expect(
            fontManager.workerLayerFingerprintCache.has(
                `${second.name}::${secondLayer.id}`
            )
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

    test('forceFullWorkerCacheUpdate performs an exhaustive incremental refresh without full-document crossings', async () => {
        await fontManager.forceFullWorkerCacheUpdate();

        expect(sendMessageSpy).toHaveBeenCalledTimes(1);
        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                changedGlyphs: expect.any(Array),
                invalidateLayoutClosure: true
            })
        );
        expect(fontManager.getBoundaryCrossingStats().fullFontCrossings).toBe(
            0
        );
    });

    test('forceFullWorkerCacheUpdate deletes removed layers from the worker cache incrementally', async () => {
        const currentFont = fontManager.currentFont;
        const glyphData = currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        expect(glyphData.layers.length).toBeGreaterThan(1);

        const removedLayer = glyphData.layers[glyphData.layers.length - 1];
        const nextFontData = cloneJson(currentFont.babelfontData);
        const nextGlyphData = nextFontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        nextGlyphData.layers = nextGlyphData.layers.filter(
            (entry) => entry.id !== removedLayer.id
        );
        currentFont.babelfontData = nextFontData;
        currentFont.babelfontJson = JSON.stringify(nextFontData);
        currentFont.fontModel = Font.fromData(nextFontData);
        fontManager.workerLayerFingerprintCache.set(
            `a::${removedLayer.id}`,
            'stale'
        );

        sendMessageSpy.mockClear();
        fontManager.resetBoundaryCrossingStats();

        await fontManager.forceFullWorkerCacheUpdate();

        const workerFontJson = yDocToJson(
            fontManager.workerCacheYDoc.getMap('font')
        );
        const workerGlyph = workerFontJson.glyphs.find(
            (entry) => entry.name === 'a'
        );

        expect(
            workerGlyph.layers.some((entry) => entry.id === removedLayer.id)
        ).toBe(false);
        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                changedGlyphs: expect.arrayContaining(['a']),
                invalidateLayoutClosure: true
            })
        );
        expect(
            sendMessageSpy.mock.calls.some(
                ([message]) =>
                    message?.type === 'storeFontJson' ||
                    message?.type === 'initYdoc'
            )
        ).toBe(false);
        expect(
            fontManager.workerLayerFingerprintCache.has(`a::${removedLayer.id}`)
        ).toBe(false);
        expect(fontManager.getBoundaryCrossingStats().fullFontCrossings).toBe(
            0
        );
    });

    test('forceFullWorkerCacheUpdate deletes removed glyphs from the worker cache incrementally', async () => {
        const currentFont = fontManager.currentFont;
        const removedGlyph = currentFont.babelfontData.glyphs.find(
            (entry) => entry?.name && entry.name !== 'a'
        );
        expect(removedGlyph).toBeTruthy();

        const nextFontData = cloneJson(currentFont.babelfontData);
        nextFontData.glyphs = nextFontData.glyphs.filter(
            (entry) => entry?.name !== removedGlyph.name
        );
        currentFont.babelfontData = nextFontData;
        currentFont.babelfontJson = JSON.stringify(nextFontData);
        currentFont.fontModel = Font.fromData(nextFontData);
        for (const layer of removedGlyph.layers || []) {
            if (layer?.id) {
                fontManager.workerLayerFingerprintCache.set(
                    `${removedGlyph.name}::${layer.id}`,
                    'stale'
                );
            }
        }

        sendMessageSpy.mockClear();
        fontManager.resetBoundaryCrossingStats();

        await fontManager.forceFullWorkerCacheUpdate();

        const workerFontJson = yDocToJson(
            fontManager.workerCacheYDoc.getMap('font')
        );

        expect(
            workerFontJson.glyphs.some(
                (entry) => entry.name === removedGlyph.name
            )
        ).toBe(false);
        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                changedGlyphs: expect.arrayContaining([removedGlyph.name]),
                invalidateLayoutClosure: true
            })
        );
        expect(
            sendMessageSpy.mock.calls.some(
                ([message]) =>
                    message?.type === 'storeFontJson' ||
                    message?.type === 'initYdoc'
            )
        ).toBe(false);
        expect(
            Array.from(fontManager.workerLayerFingerprintCache.keys()).some(
                (key) => key.startsWith(`${removedGlyph.name}::`)
            )
        ).toBe(false);
        expect(fontManager.getBoundaryCrossingStats().fullFontCrossings).toBe(
            0
        );
    });

    test('forwardWorkerYjsUpdate forwards font-wide updates with no glyph metadata as raw incremental Yjs', async () => {
        await expect(
            fontManager.forwardWorkerYjsUpdate(new Uint8Array([1, 2, 3]), [])
        ).resolves.toBe(true);

        expect(sendMessageSpy).toHaveBeenCalledTimes(1);
        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                changedGlyphs: [],
                invalidateLayoutClosure: true
            })
        );
    });

    test('stageLiveDragPreviewFromModel sends preview layer overlays without mutating the authoritative worker mirror', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const storedLayer = currentFont.babelfontData.glyphs
            .find((entry) => entry.name === 'a')
            .layers.find((entry) => entry.id === layerId);
        const previewLayer = {
            ...cloneJson(storedLayer),
            width: storedLayer.width + 21
        };
        const authoritativeBefore = yDocToJson(
            fontManager.workerCacheYDoc.getMap('font')
        );
        const encodeStateSpy = jest.spyOn(Y, 'encodeStateAsUpdate');

        try {
            await fontManager.stageLiveDragPreviewFromModel(['a'], layerId, {
                dispatchGlyphChanged: false,
                explicitLayerData: [
                    {
                        glyphName: 'a',
                        layerId,
                        layerData: previewLayer
                    }
                ]
            });
        } finally {
            expect(encodeStateSpy).not.toHaveBeenCalled();
            encodeStateSpy.mockRestore();
        }

        const authoritativeAfter = yDocToJson(
            fontManager.workerCacheYDoc.getMap('font')
        );

        expect(authoritativeAfter).toEqual(authoritativeBefore);
        expect(fontManager.workerPreviewYDoc).toBeUndefined();
        expect(sendMessageSpy).toHaveBeenCalledTimes(1);
        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyPreviewLayerOverlay',
                invalidateLayoutClosure: false,
                changedGlyphs: ['a'],
                layerUpdates: [
                    expect.objectContaining({
                        glyphName: 'a',
                        layerId,
                        layerData: expect.objectContaining({
                            width: previewLayer.width
                        })
                    })
                ],
                layerTargets: [{ glyphName: 'a', layerId }]
            })
        );
        expect(sendMessageSpy.mock.calls[0][0]).not.toHaveProperty('update');
        expect(
            sendMessageSpy.mock.calls.some(
                ([message]) => message?.type === 'applyYjsUpdate'
            )
        ).toBe(false);
    });

    test('clearLiveDragPreview drops preview state without touching the authoritative worker mirror', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const storedLayer = currentFont.babelfontData.glyphs
            .find((entry) => entry.name === 'a')
            .layers.find((entry) => entry.id === layerId);
        const previewLayer = {
            ...cloneJson(storedLayer),
            width: storedLayer.width + 17
        };
        const authoritativeBefore = yDocToJson(
            fontManager.workerCacheYDoc.getMap('font')
        );

        await fontManager.stageLiveDragPreviewFromModel(['a'], layerId, {
            dispatchGlyphChanged: false,
            explicitLayerData: [
                {
                    glyphName: 'a',
                    layerId,
                    layerData: previewLayer
                }
            ]
        });
        expect(fontManager.workerPreviewYDoc).toBeUndefined();

        sendMessageSpy.mockClear();
        fontManager.clearLiveDragPreview();
        await fontManager.workerYjsSendQueue;

        const authoritativeAfter = yDocToJson(
            fontManager.workerCacheYDoc.getMap('font')
        );

        expect(fontManager.workerPreviewYDoc).toBeUndefined();
        expect(authoritativeAfter).toEqual(authoritativeBefore);
        expect(sendMessageSpy).toHaveBeenCalledTimes(1);
        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'clearPreviewLayerOverlay'
            })
        );
        expect(
            sendMessageSpy.mock.calls.some(
                ([message]) => message?.type === 'applyYjsUpdate'
            )
        ).toBe(false);
    });

    test('forwardWorkerYjsUpdate exposes a pending cache update before the worker send runs', async () => {
        let resolveSend;
        sendMessageSpy.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveSend = resolve;
                })
        );

        const updatePromise = fontManager.forwardWorkerYjsUpdate(
            new Uint8Array([1, 2, 3]),
            []
        );

        expect(fontManager.workerCacheUpdatePromise).toBeTruthy();

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(resolveSend).toEqual(expect.any(Function));
        resolveSend({
            success: true,
            workerCacheStatus: makeWorkerCacheStatus({ documentEpoch: 1 })
        });
        await expect(updatePromise).resolves.toBe(true);
        await fontManager.awaitWorkerCacheUpdate();
        expect(fontManager.workerCacheUpdatePromise).toBeNull();
    });

    test('forwardWorkerYjsUpdate keeps the cache update promise alive until earlier queued sends settle', async () => {
        let resolveFirstSend;
        let resolveSecondSend;
        sendMessageSpy
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveFirstSend = resolve;
                    })
            )
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveSecondSend = resolve;
                    })
            );

        const firstUpdatePromise = fontManager.forwardWorkerYjsUpdate(
            new Uint8Array([1, 2, 3]),
            []
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(resolveFirstSend).toEqual(expect.any(Function));

        const secondUpdatePromise = fontManager.forwardWorkerYjsUpdate(
            new Uint8Array([4, 5, 6]),
            []
        );
        await Promise.resolve();
        await Promise.resolve();

        // The second send is serialized behind the first one.
        expect(resolveSecondSend).toBeUndefined();

        resolveFirstSend({
            success: true,
            workerCacheStatus: makeWorkerCacheStatus({ documentEpoch: 1 })
        });
        await expect(firstUpdatePromise).resolves.toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(resolveSecondSend).toEqual(expect.any(Function));

        // The later queue handle must remain visible until the queued tail settles.
        expect(fontManager.workerCacheUpdatePromise).toBeTruthy();

        resolveSecondSend({
            success: true,
            workerCacheStatus: makeWorkerCacheStatus({ documentEpoch: 2 })
        });
        await expect(secondUpdatePromise).resolves.toBe(true);
        await fontManager.awaitWorkerCacheUpdate();
        expect(fontManager.workerCacheUpdatePromise).toBeNull();
    });

    test('forwardWorkerYjsUpdate rejects a success response without a coherent worker cache acknowledgement', async () => {
        fontCompilation.setWorkerCacheDocumentReady(true);
        const previousDocumentEpoch = fontManager.lastWorkerDocumentEpoch;

        sendMessageSpy.mockResolvedValueOnce({
            success: true,
            workerCacheStatus: {
                coherent: false,
                documentEpoch: 4,
                fontCacheEpoch: 3,
                filterEpoch: 2,
                subsetCacheEpoch: null
            }
        });

        await expect(
            fontManager.forwardWorkerYjsUpdate(new Uint8Array([1, 2, 3]), [])
        ).resolves.toBe(false);

        expect(fontCompilation.hasWorkerCacheDocument()).toBe(false);
        expect(fontManager.lastWorkerDocumentEpoch).toBe(previousDocumentEpoch);
    });

    test('forwardWorkerYjsUpdate stores acknowledged worker cache epochs', async () => {
        sendMessageSpy.mockResolvedValueOnce({
            success: true,
            workerCacheStatus: makeWorkerCacheStatus({
                documentEpoch: 7,
                fontCacheEpoch: 11,
                filterEpoch: 13
            })
        });

        await expect(
            fontManager.forwardWorkerYjsUpdate(new Uint8Array([1, 2, 3]), [])
        ).resolves.toBe(true);

        expect(fontManager.lastWorkerDocumentEpoch).toBe(7);
        expect(fontManager.lastWorkerFontCacheEpoch).toBe(11);
        expect(fontManager.lastWorkerFilterEpoch).toBe(13);
    });

    test('forwardWorkerYjsUpdate forwards non-glyph kerning hints with font-wide updates', async () => {
        await expect(
            fontManager.forwardWorkerYjsUpdate(new Uint8Array([1, 2, 3]), [], {
                nonGlyphChangeHints: ['kerning-value']
            })
        ).resolves.toBe(true);

        expect(sendMessageSpy).toHaveBeenCalledTimes(1);
        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                changedGlyphs: [],
                nonGlyphChangeHints: ['kerning-value'],
                invalidateLayoutClosure: true
            })
        );
    });

    test('forwardWorkerYjsUpdate fails after applyYjsUpdate failure instead of repairing with a full resend', async () => {
        const rawUpdate = fontManager.buildWorkerSeedYjsState();
        sendMessageSpy.mockRejectedValueOnce(
            new Error('RuntimeError: unreachable')
        );

        await expect(
            fontManager.forwardWorkerYjsUpdate(rawUpdate, ['a'], {
                invalidateLayoutClosure: false
            })
        ).resolves.toBe(false);

        expect(fontManager.workerCacheYDoc).toBeTruthy();

        expect(sendMessageSpy).toHaveBeenCalledTimes(1);
        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                changedGlyphs: ['a'],
                invalidateLayoutClosure: false
            })
        );
    });

    test('refreshWorkerCacheForReplayTargets can recover after a raw applyYjsUpdate failure without reseeding the mirror', async () => {
        const rawUpdate = fontManager.buildWorkerSeedYjsState();
        const layerId =
            fontManager.currentFont.fontModel.findGlyph('a').layers[0].id;

        sendMessageSpy
            .mockRejectedValueOnce(new Error('RuntimeError: unreachable'))
            .mockResolvedValueOnce({
                success: true,
                workerCacheStatus: makeWorkerCacheStatus()
            });

        await expect(
            fontManager.forwardWorkerYjsUpdate(rawUpdate, ['a'], {
                invalidateLayoutClosure: false
            })
        ).resolves.toBe(false);

        expect(fontManager.workerCacheYDoc).toBeTruthy();

        await expect(
            fontManager.refreshWorkerCacheForReplayTargets([
                { glyphName: 'a', layerId }
            ])
        ).resolves.toBe(true);

        expect(sendMessageSpy).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                type: 'applyYjsUpdate',
                layerTargets: [{ glyphName: 'a', layerId }],
                invalidateLayoutClosure: false
            })
        );
    });

    test('consecutive raw Yjs layer updates forward each change as an incremental worker packet', async () => {
        const currentFont = fontManager.currentFont;
        const originalPatchSyncEngine = window.patchSyncEngine;
        const applyMirrorSpy = jest.spyOn(
            fontManager,
            'applyWorkerYjsUpdateToMirror'
        );
        const glyphName = 'a';
        const layerId = currentFont.fontModel.findGlyph(glyphName).layers[0].id;
        const originalFontData = cloneJson(currentFont.babelfontData);
        const firstEditedFontData = cloneJson(originalFontData);
        const firstEditedGlyph = firstEditedFontData.glyphs.find(
            (glyph) => glyph.name === glyphName
        );
        const firstEditedLayer = firstEditedGlyph.layers.find(
            (layer) => layer.id === layerId
        );
        const editedPathIndex = firstEditedLayer.shapes.findIndex((shape) =>
            Array.isArray(shape.nodes)
        );
        const firstNextX =
            firstEditedLayer.shapes[editedPathIndex].nodes[0].x + 37;
        const firstNextY =
            firstEditedLayer.shapes[editedPathIndex].nodes[0].y + 19;
        const secondEditedFontData = cloneJson(firstEditedFontData);
        const secondEditedGlyph = secondEditedFontData.glyphs.find(
            (glyph) => glyph.name === glyphName
        );
        const secondEditedLayer = secondEditedGlyph.layers.find(
            (layer) => layer.id === layerId
        );
        const secondNextX =
            secondEditedLayer.shapes[editedPathIndex].nodes[1].x - 21;
        const secondNextY =
            secondEditedLayer.shapes[editedPathIndex].nodes[1].y + 14;

        firstEditedLayer.shapes[editedPathIndex].nodes[0].x = firstNextX;
        firstEditedLayer.shapes[editedPathIndex].nodes[0].y = firstNextY;
        secondEditedLayer.shapes[editedPathIndex].nodes[0].x = firstNextX;
        secondEditedLayer.shapes[editedPathIndex].nodes[0].y = firstNextY;
        secondEditedLayer.shapes[editedPathIndex].nodes[1].x = secondNextX;
        secondEditedLayer.shapes[editedPathIndex].nodes[1].y = secondNextY;

        const workerDoc = new Y.Doc();
        jsonToYDoc(cloneJson(originalFontData), workerDoc.getMap('font'));
        const initialWorkerState = Y.encodeStateAsUpdate(workerDoc);
        window.patchSyncEngine = {
            fontMap: workerDoc.getMap('font')
        };
        const beforeStateVector = Y.encodeStateVector(workerDoc);
        try {
            workerDoc.transact(() => {
                setYPath(
                    workerDoc.getMap('font'),
                    [
                        'glyphs',
                        glyphName,
                        'layers',
                        layerId,
                        'shapes',
                        editedPathIndex,
                        'nodes',
                        0,
                        'x'
                    ],
                    firstNextX
                );
                setYPath(
                    workerDoc.getMap('font'),
                    [
                        'glyphs',
                        glyphName,
                        'layers',
                        layerId,
                        'shapes',
                        editedPathIndex,
                        'nodes',
                        0,
                        'y'
                    ],
                    firstNextY
                );
            });
            const firstRawUpdate = Y.encodeStateAsUpdate(
                workerDoc,
                beforeStateVector
            );

            fontManager.workerCacheYDoc = new Y.Doc();
            Y.applyUpdate(fontManager.workerCacheYDoc, initialWorkerState);
            fontManager.workerLayerFingerprintCache.clear();
            fontManager.workerLayerFingerprintCache.set(
                `${glyphName}::${layerId}`,
                JSON.stringify(
                    fontManager.normalizeLayerForRust(
                        originalFontData.glyphs
                            .find((glyph) => glyph.name === glyphName)
                            .layers.find((layer) => layer.id === layerId)
                    )
                )
            );

            currentFont.babelfontData = firstEditedFontData;
            currentFont.babelfontJson = JSON.stringify(firstEditedFontData);
            currentFont.fontModel = Font.fromData(cloneJson(originalFontData));

            await expect(
                fontManager.forwardWorkerYjsUpdate(
                    firstRawUpdate,
                    [glyphName],
                    {
                        invalidateLayoutClosure: false,
                        layerTargets: [{ glyphName, layerId }]
                    }
                )
            ).resolves.toBe(true);

            const secondBeforeStateVector = Y.encodeStateVector(workerDoc);
            workerDoc.transact(() => {
                setYPath(
                    workerDoc.getMap('font'),
                    [
                        'glyphs',
                        glyphName,
                        'layers',
                        layerId,
                        'shapes',
                        editedPathIndex,
                        'nodes',
                        1,
                        'x'
                    ],
                    secondNextX
                );
                setYPath(
                    workerDoc.getMap('font'),
                    [
                        'glyphs',
                        glyphName,
                        'layers',
                        layerId,
                        'shapes',
                        editedPathIndex,
                        'nodes',
                        1,
                        'y'
                    ],
                    secondNextY
                );
            });
            const secondRawUpdate = Y.encodeStateAsUpdate(
                workerDoc,
                secondBeforeStateVector
            );

            currentFont.babelfontData = secondEditedFontData;
            currentFont.babelfontJson = JSON.stringify(secondEditedFontData);
            currentFont.fontModel = Font.fromData(
                cloneJson(firstEditedFontData)
            );

            await expect(
                fontManager.forwardWorkerYjsUpdate(
                    secondRawUpdate,
                    [glyphName],
                    {
                        invalidateLayoutClosure: false,
                        layerTargets: [{ glyphName, layerId }]
                    }
                )
            ).resolves.toBe(true);

            const firstForwardedUpdate = applyMirrorSpy.mock.calls[0][0];
            const secondForwardedUpdate = applyMirrorSpy.mock.calls[1][0];
            expect(firstForwardedUpdate).toBeInstanceOf(Uint8Array);
            expect(secondForwardedUpdate).toBeInstanceOf(Uint8Array);
            expect(sendMessageSpy).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({
                    type: 'applyYjsUpdate',
                    update: firstForwardedUpdate,
                    changedGlyphs: [glyphName],
                    layerTargets: [{ glyphName, layerId }],
                    invalidateLayoutClosure: false
                })
            );
            expect(sendMessageSpy).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({
                    type: 'applyYjsUpdate',
                    update: secondForwardedUpdate,
                    changedGlyphs: [glyphName],
                    layerTargets: [{ glyphName, layerId }],
                    invalidateLayoutClosure: false
                })
            );
        } finally {
            applyMirrorSpy.mockRestore();
            window.patchSyncEngine = originalPatchSyncEngine;
        }
    });

    test('forwardWorkerYjsUpdate forwards raw layer-target Yjs updates as one incremental worker packet', async () => {
        const sourceDoc = new Y.Doc();
        jsonToYDoc(
            cloneJson(fontManager.currentFont.babelfontData),
            sourceDoc.getMap('font')
        );
        const rawUpdate = Y.encodeStateAsUpdate(sourceDoc);
        fontManager.workerCacheYDoc = new Y.Doc();
        Y.applyUpdate(fontManager.workerCacheYDoc, rawUpdate);
        const buildWorkerYjsLayerUpdateSpy = jest.spyOn(
            fontManager,
            'buildWorkerYjsLayerUpdate'
        );
        const applyMirrorSpy = jest.spyOn(
            fontManager,
            'applyWorkerYjsUpdateToMirror'
        );
        const syncJsonSpy = jest
            .spyOn(fontManager, 'syncBabelfontJsonFromCurrentModel')
            .mockReturnValue(false);
        const glyph = fontManager.currentFont.fontModel.findGlyph('a');
        const layerId = glyph.layers[0].id;
        fontManager.pendingBabelfontJsonSyncAfterDrag = true;

        expect(rawUpdate).toBeInstanceOf(Uint8Array);

        await expect(
            fontManager.forwardWorkerYjsUpdate(rawUpdate, ['a'], {
                invalidateLayoutClosure: false,
                layerTargets: [{ glyphName: 'a', layerId }]
            })
        ).resolves.toBe(true);

        expect(buildWorkerYjsLayerUpdateSpy).not.toHaveBeenCalled();
        const forwardedUpdate = applyMirrorSpy.mock.calls[0][0];
        expect(forwardedUpdate).toBeInstanceOf(Uint8Array);
        expect(syncJsonSpy).not.toHaveBeenCalled();
        expect(fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(true);
        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                update: forwardedUpdate,
                changedGlyphs: ['a'],
                layerTargets: [{ glyphName: 'a', layerId }],
                invalidateLayoutClosure: false
            })
        );
        expect(fontManager.getBoundaryCrossingStats()).toEqual({
            submitBatchCalls: 1,
            layersTransmitted: 1,
            glyphsTransmitted: 1,
            fullFontCrossings: 0
        });

        buildWorkerYjsLayerUpdateSpy.mockRestore();
        applyMirrorSpy.mockRestore();
        syncJsonSpy.mockRestore();
    });

    test('forwardWorkerYjsUpdate merges a missing replay layer into one incremental worker packet', async () => {
        const currentFont = fontManager.currentFont;
        const originalPatchSyncEngine = window.patchSyncEngine;
        const originalFontData = cloneJson(currentFont.babelfontData);
        const sourceGlyphName = 'a';
        const dependentGlyphName = 'worker-replay-target';
        const sourceGlyph = originalFontData.glyphs.find(
            (glyph) => glyph.name === sourceGlyphName
        );
        const concreteLayers = sourceGlyph.layers.filter(
            (layer) =>
                Number.isFinite(layer.width) &&
                layer.width > 0 &&
                !layer.is_background &&
                !layer.id.endsWith('.bg')
        );
        const [sourceLayer] = concreteLayers;
        const dependentLayer = {
            id: 'worker-replay-target-layer',
            width: 500,
            master: cloneJson(sourceLayer.master),
            shapes: []
        };
        originalFontData.glyphs.push({
            name: dependentGlyphName,
            exported: false,
            layers: [cloneJson(dependentLayer)]
        });
        const sourceWidth = sourceLayer.width + 17;
        const dependentWidth = dependentLayer.width + 23;
        const updatedFontData = cloneJson(originalFontData);
        const updatedSourceLayer = updatedFontData.glyphs
            .find((glyph) => glyph.name === sourceGlyphName)
            .layers.find((layer) => layer.id === sourceLayer.id);
        const updatedDependentLayer = updatedFontData.glyphs
            .find((glyph) => glyph.name === dependentGlyphName)
            .layers.find((layer) => layer.id === dependentLayer.id);
        updatedSourceLayer.width = sourceWidth;
        updatedDependentLayer.width = dependentWidth;

        const bridgeDoc = new Y.Doc();
        jsonToYDoc(originalFontData, bridgeDoc.getMap('font'));
        const initialWorkerState = Y.encodeStateAsUpdate(bridgeDoc);
        fontManager.replaceWorkerYjsMirrorFromState(initialWorkerState);
        fontManager.workerLayerFingerprintCache.set('baseline::layer', 'base');
        window.patchSyncEngine = { fontMap: bridgeDoc.getMap('font') };

        bridgeDoc.transact(() => {
            setYPath(
                bridgeDoc.getMap('font'),
                [
                    'glyphs',
                    dependentGlyphName,
                    'layers',
                    dependentLayer.id,
                    'width'
                ],
                dependentWidth
            );
        });
        // The source delta starts after this dependent mutation, so it cannot
        // contain the already-materialized dependent layer.
        const sourceStateVector = Y.encodeStateVector(bridgeDoc);
        bridgeDoc.transact(() => {
            setYPath(
                bridgeDoc.getMap('font'),
                ['glyphs', sourceGlyphName, 'layers', sourceLayer.id, 'width'],
                sourceWidth
            );
        });
        const sourceOnlyUpdate = Y.encodeStateAsUpdate(
            bridgeDoc,
            sourceStateVector
        );
        const staleWorkerDoc = new Y.Doc();
        Y.applyUpdate(staleWorkerDoc, initialWorkerState);
        const refreshReplayTargetsSpy = jest.spyOn(
            fontManager,
            'refreshWorkerCacheForReplayTargets'
        );

        currentFont.babelfontData = updatedFontData;
        currentFont.babelfontJson = JSON.stringify(updatedFontData);
        currentFont.fontModel = Font.fromData(cloneJson(updatedFontData));
        fontManager.resetBoundaryCrossingStats();

        try {
            await expect(
                fontManager.forwardWorkerYjsUpdate(
                    sourceOnlyUpdate,
                    [sourceGlyphName],
                    {
                        invalidateLayoutClosure: false,
                        layerTargets: [
                            {
                                glyphName: dependentGlyphName,
                                layerId: dependentLayer.id
                            }
                        ]
                    }
                )
            ).resolves.toBe(true);

            const getLayerWidth = (doc, glyphName, layerId) =>
                getYPath(doc.getMap('font'), [
                    'glyphs',
                    glyphName,
                    'layers',
                    layerId,
                    'width'
                ]);
            const forwardedUpdate = sendMessageSpy.mock.calls[0][0].update;

            expect(sendMessageSpy).toHaveBeenCalledTimes(1);
            expect(sendMessageSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'applyYjsUpdate',
                    update: expect.any(Uint8Array),
                    changedGlyphs: [sourceGlyphName],
                    layerTargets: [
                        {
                            glyphName: dependentGlyphName,
                            layerId: dependentLayer.id
                        }
                    ],
                    invalidateLayoutClosure: false
                })
            );
            expect(forwardedUpdate).not.toBe(sourceOnlyUpdate);
            expect(refreshReplayTargetsSpy).not.toHaveBeenCalled();
            expect(
                sendMessageSpy.mock.calls.some(
                    ([message]) =>
                        message?.type === 'storeFontJson' ||
                        message?.type === 'seedYdoc' ||
                        message?.type === 'initYdoc'
                )
            ).toBe(false);

            Y.applyUpdate(staleWorkerDoc, forwardedUpdate);
            expect(
                getLayerWidth(
                    staleWorkerDoc,
                    dependentGlyphName,
                    dependentLayer.id
                )
            ).toBe(dependentWidth);
            expect(
                getLayerWidth(
                    fontManager.workerCacheYDoc,
                    dependentGlyphName,
                    dependentLayer.id
                )
            ).toBe(dependentWidth);
            expect(fontManager.getBoundaryCrossingStats()).toEqual({
                submitBatchCalls: 1,
                layersTransmitted: 1,
                glyphsTransmitted: 1,
                fullFontCrossings: 0
            });
        } finally {
            refreshReplayTargetsSpy.mockRestore();
            window.patchSyncEngine = originalPatchSyncEngine;
        }
    });

    test('forwardWorkerYjsUpdate falls back to model shapes when the bridge target is shape-empty', async () => {
        const currentFont = fontManager.currentFont;
        const originalPatchSyncEngine = window.patchSyncEngine;
        const glyphName = 'a';
        const glyph = currentFont.fontModel.findGlyph(glyphName);
        const layerId = glyph.layers[0].id;
        const bridgeDoc = new Y.Doc();
        jsonToYDoc(
            cloneJson(currentFont.babelfontData),
            bridgeDoc.getMap('font')
        );
        window.patchSyncEngine = {
            fontMap: bridgeDoc.getMap('font')
        };

        setYPath(
            bridgeDoc.getMap('font'),
            ['glyphs', glyphName, 'layers', layerId, 'shapes'],
            []
        );

        const rawUpdate = fontManager.buildWorkerSeedYjsState();

        try {
            await expect(
                fontManager.forwardWorkerYjsUpdate(rawUpdate, [glyphName], {
                    invalidateLayoutClosure: false,
                    layerTargets: [{ glyphName, layerId }]
                })
            ).resolves.toBe(true);

            const workerLayer = yDocToJson(
                fontManager.workerCacheYDoc.getMap('font')
            )
                .glyphs.find((entry) => entry.name === glyphName)
                .layers.find((entry) => entry.id === layerId);

            expect(Array.isArray(workerLayer.shapes)).toBe(true);
            expect(workerLayer.shapes.length).toBeGreaterThan(0);
            expect(sendMessageSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'applyYjsUpdate',
                    changedGlyphs: [glyphName],
                    layerTargets: [{ glyphName, layerId }],
                    invalidateLayoutClosure: false
                })
            );
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
        }
    });

    test('buildWorkerYjsLayerUpdate prunes stale omitted layer fields from replay-target payloads', () => {
        const glyphName = 'a';
        const currentFont = fontManager.currentFont;
        const glyph = currentFont.fontModel.findGlyph(glyphName);
        const layer = glyph.layers[0];
        const layerId = layer.id;
        const normalizedLayer = fontManager.normalizeLayerForRust(
            cloneJson(layer.data)
        );

        const seedStaleLayerFields = (fontMap) => {
            setYPath(
                fontMap,
                ['glyphs', glyphName, 'layers', layerId, 'workerOnlyRootField'],
                'stale-root'
            );
            setYPath(
                fontMap,
                [
                    'glyphs',
                    glyphName,
                    'layers',
                    layerId,
                    'shapes',
                    0,
                    'workerOnlyNestedField'
                ],
                'stale-nested'
            );
        };

        const staleWorkerDoc = new Y.Doc();
        staleWorkerDoc.transact(() => {
            jsonToYDoc(
                cloneJson(currentFont.babelfontData),
                staleWorkerDoc.getMap('font')
            );
            seedStaleLayerFields(staleWorkerDoc.getMap('font'));
        });
        fontManager.replaceWorkerYjsMirrorFromState(
            Y.encodeStateAsUpdate(staleWorkerDoc)
        );

        const replayTargetUpdate = fontManager.buildWorkerYjsLayerUpdate([
            {
                glyphName,
                layerId,
                normalized: normalizedLayer
            }
        ]);

        expect(replayTargetUpdate).toBeTruthy();
        expect(replayTargetUpdate.changedGlyphs).toEqual([glyphName]);

        const recipientDoc = new Y.Doc();
        Y.applyUpdate(recipientDoc, Y.encodeStateAsUpdate(staleWorkerDoc));
        Y.applyUpdate(recipientDoc, replayTargetUpdate.update);

        const recipientLayer = yDocToJson(recipientDoc.getMap('font'))
            .glyphs.find((entry) => entry.name === glyphName)
            .layers.find((entry) => entry.id === layerId);
        const comparableActualLayer = stripLayerStableIds(
            fontManager.normalizeLayerForRust(recipientLayer)
        );
        const comparableExpectedLayer = stripLayerStableIds(normalizedLayer);

        expect(recipientLayer.workerOnlyRootField).toBeUndefined();
        expect(recipientLayer.shapes[0].workerOnlyNestedField).toBeUndefined();
        expect(comparableActualLayer).toEqual(comparableExpectedLayer);
    });

    test('forwardWorkerYjsUpdate counts sparse layer deletion targets as one worker packet', async () => {
        const glyphName = 'a';
        const modelGlyph =
            fontManager.currentFont.fontModel.findGlyph(glyphName);
        const removedLayerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const removedLayer = modelGlyph.data.layers.find(
            (entry) => entry.id === removedLayerId
        );
        expect(removedLayer).toBeTruthy();
        const sourceGlyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === glyphName
        );
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');

        doc.transact(() => {
            jsonToYDoc(
                cloneJson(fontManager.currentFont.babelfontData),
                fontMap
            );
        });
        const previousStateVector = Y.encodeStateVector(doc);
        doc.transact(() => {
            deleteYPath(fontMap, [
                'glyphs',
                glyphName,
                'layers',
                removedLayerId
            ]);
        });
        const rawUpdate = Y.encodeStateAsUpdate(doc, previousStateVector);

        const removedLayerIndex = modelGlyph.data.layers.findIndex(
            (entry) => entry.id === removedLayerId
        );
        expect(removedLayerIndex).toBeGreaterThanOrEqual(0);
        modelGlyph.removeLayer(removedLayerIndex);
        if (sourceGlyph.layers.some((entry) => entry.id === removedLayerId)) {
            sourceGlyph.layers = sourceGlyph.layers.filter(
                (entry) => entry.id !== removedLayerId
            );
        }
        expect(
            modelGlyph.data.layers.some((entry) => entry.id === removedLayerId)
        ).toBe(false);
        expect(
            fontManager.currentFont.fontModel.glyphs
                .find((entry) => entry.name === glyphName)
                .data.layers.some((entry) => entry.id === removedLayerId)
        ).toBe(false);
        fontManager.workerLayerFingerprintCache.set(
            `${glyphName}::${removedLayerId}`,
            'stale-fingerprint'
        );
        fontManager.resetBoundaryCrossingStats();

        await expect(
            fontManager.forwardWorkerYjsUpdate(rawUpdate, [], {
                invalidateLayoutClosure: false,
                layerTargets: [{ glyphName, layerId: removedLayerId }]
            })
        ).resolves.toBe(true);

        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                changedGlyphs: [],
                layerTargets: [{ glyphName, layerId: removedLayerId }],
                invalidateLayoutClosure: false
            })
        );
        expect(
            fontManager.workerLayerFingerprintCache.has(
                `${glyphName}::${removedLayerId}`
            )
        ).toBe(false);
        expect(fontManager.getBoundaryCrossingStats()).toEqual({
            submitBatchCalls: 1,
            layersTransmitted: 1,
            glyphsTransmitted: 1,
            fullFontCrossings: 0
        });
    });

    test('forwardWorkerYjsUpdate keeps the raw Yjs path alive for glyph removals', async () => {
        const glyphName = 'a';
        const removedGlyphEntry =
            fontManager.currentFont.babelfontData.glyphs.find(
                (entry) => entry.name === glyphName
            );
        const removedLayerIds = removedGlyphEntry.layers.map(
            (layer) => layer.id
        );
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');

        doc.transact(() => {
            jsonToYDoc(
                cloneJson(fontManager.currentFont.babelfontData),
                fontMap
            );
        });
        const previousStateVector = Y.encodeStateVector(doc);
        doc.transact(() => {
            deleteYPath(fontMap, ['glyphs', glyphName]);
        });
        const rawUpdate = Y.encodeStateAsUpdate(doc, previousStateVector);

        for (const layerId of removedLayerIds) {
            fontManager.workerLayerFingerprintCache.set(
                `${glyphName}::${layerId}`,
                'stale-fingerprint'
            );
        }

        fontManager.currentFont.fontModel.removeGlyph(glyphName);

        await expect(
            fontManager.forwardWorkerYjsUpdate(rawUpdate, [glyphName], {
                invalidateLayoutClosure: false
            })
        ).resolves.toBe(true);

        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                update: rawUpdate,
                changedGlyphs: [glyphName],
                invalidateLayoutClosure: false
            })
        );
        expect(
            Array.from(fontManager.workerLayerFingerprintCache.keys()).some(
                (key) => key.startsWith(`${glyphName}::`)
            )
        ).toBe(false);
    });

    test('updateWorkerFontCache waits for worker Yjs sync when no incremental layer target is available', async () => {
        fontManager.pendingBabelfontJsonSyncAfterDrag = true;
        const awaitWorkerDocumentSyncSpy = jest
            .spyOn(fontCompilation, 'awaitWorkerDocumentSync')
            .mockResolvedValue();
        window.glyphCanvas = {
            outlineEditor: {
                currentGlyphName: 'missing',
                selectedLayerId: 'missing-layer'
            },
            getCurrentGlyphName: jest.fn(() => 'missing')
        };

        try {
            await fontManager.updateWorkerFontCache();
        } finally {
            delete window.glyphCanvas;
        }

        expect(awaitWorkerDocumentSyncSpy).toHaveBeenCalledTimes(1);
        expect(
            sendMessageSpy.mock.calls.some(
                ([message]) =>
                    message?.type === 'storeFontJson' ||
                    message?.type === 'initYdoc'
            )
        ).toBe(false);

        awaitWorkerDocumentSyncSpy.mockRestore();
    });

    test('updateWorkerFontCache still waits for worker Yjs sync after a layer helper update or explicit recovery bootstrap', async () => {
        fontManager.pendingBabelfontJsonSyncAfterDrag = true;
        const awaitWorkerDocumentSyncSpy = jest
            .spyOn(fontCompilation, 'awaitWorkerDocumentSync')
            .mockResolvedValue();
        window.glyphCanvas = {
            outlineEditor: {
                currentGlyphName: 'a',
                selectedLayerId: '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
            },
            getCurrentGlyphName: jest.fn(() => 'a')
        };

        try {
            await fontManager.updateWorkerFontCache();
        } finally {
            delete window.glyphCanvas;
        }

        expect(
            sendMessageSpy.mock.calls.some(
                ([message]) =>
                    message?.type === 'applyYjsUpdate' ||
                    message?.type === 'storeFontJson'
            )
        ).toBe(true);
        expect(
            sendMessageSpy.mock.calls.some(
                ([message]) => message?.type === 'initYdoc'
            )
        ).toBe(false);
        expect(awaitWorkerDocumentSyncSpy).toHaveBeenCalledTimes(2);

        awaitWorkerDocumentSyncSpy.mockRestore();
    });

    test('refreshGlyphsAfterModelBatch rejects when incremental update reports an unseeded worker doc', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const modelLayer = currentFont.fontModel
            .findGlyph('a')
            .findLayerById(layerId);

        modelLayer.width += 19;
        sendMessageSpy.mockResolvedValueOnce({
            type: 'applyYjsUpdate',
            success: true,
            skipped: 'ydoc_not_initialized'
        });

        await expect(
            fontManager.refreshGlyphsAfterModelBatch(['a'], layerId)
        ).rejects.toThrow(
            'Incremental worker Yjs sync failed during editing batch refresh'
        );

        expect(sendMessageSpy).toHaveBeenCalledTimes(1);
        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate'
            })
        );
        expect(fontManager.getBoundaryCrossingStats().fullFontCrossings).toBe(
            0
        );
    });

    test('queues the first incremental update behind an in-flight worker seed', async () => {
        let releaseSeed;
        const seedSettled = new Promise((resolve) => {
            releaseSeed = resolve;
        });
        const originalInitialized = fontCompilation.isInitialized;
        const awaitWorkerDocumentSyncSpy = jest
            .spyOn(fontCompilation, 'awaitWorkerDocumentSync')
            .mockImplementation(() => seedSettled);

        fontCompilation.isInitialized = false;
        const sendPromise = fontManager.sendWorkerYjsUpdate(
            new Uint8Array([0]),
            ['a'],
            false,
            [],
            [
                {
                    glyphName: 'a',
                    layerId: '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
                }
            ]
        );

        await Promise.resolve();
        expect(sendMessageSpy).not.toHaveBeenCalled();

        fontCompilation.isInitialized = true;
        releaseSeed();

        await expect(sendPromise).resolves.toBe(true);
        expect(awaitWorkerDocumentSyncSpy).toHaveBeenCalled();
        expect(sendMessageSpy).toHaveBeenCalledTimes(1);
        expect(sendMessageSpy).toHaveBeenCalledWith({
            type: 'applyYjsUpdate',
            update: new Uint8Array([0]),
            changedGlyphs: ['a'],
            nonGlyphChangeHints: [],
            layerTargets: [
                {
                    glyphName: 'a',
                    layerId: '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
                }
            ],
            invalidateLayoutClosure: false
        });

        awaitWorkerDocumentSyncSpy.mockRestore();
        fontCompilation.isInitialized = originalInitialized;
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

    test('serializes overlapping incremental worker Yjs sends', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const modelLayer = currentFont.fontModel
            .findGlyph('a')
            .findLayerById(layerId);

        let inFlight = 0;
        let maxInFlight = 0;
        const resolvers = [];

        sendMessageSpy.mockReset();
        sendMessageSpy.mockImplementation((message) => {
            if (message?.type !== 'applyYjsUpdate') {
                return Promise.resolve({
                    success: true,
                    workerCacheStatus: makeWorkerCacheStatus()
                });
            }

            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);

            return new Promise((resolve) => {
                resolvers.push(() => {
                    inFlight -= 1;
                    resolve({
                        success: true,
                        workerCacheStatus: makeWorkerCacheStatus()
                    });
                });
            });
        });

        const flushMacrotask = () =>
            new Promise((resolve) => setTimeout(resolve, 0));

        let firstRefresh;
        let secondRefresh;
        try {
            modelLayer.width += 10;
            firstRefresh = fontManager.refreshGlyphsAfterModelBatch(
                ['a'],
                layerId,
                { skipFingerprintBaseline: true }
            );

            await flushMacrotask();
            expect(sendMessageSpy).toHaveBeenCalledTimes(1);
            expect(maxInFlight).toBe(1);

            modelLayer.width += 11;
            secondRefresh = fontManager.refreshGlyphsAfterModelBatch(
                ['a'],
                layerId,
                { skipFingerprintBaseline: true }
            );

            await flushMacrotask();
            expect(sendMessageSpy).toHaveBeenCalledTimes(1);
            expect(maxInFlight).toBe(1);

            resolvers.shift()?.();
            await flushMacrotask();
            await flushMacrotask();

            expect(sendMessageSpy).toHaveBeenCalledTimes(2);
            expect(maxInFlight).toBe(1);

            resolvers.shift()?.();
            await Promise.all([firstRefresh, secondRefresh]);

            expect(maxInFlight).toBe(1);
        } finally {
            while (resolvers.length) {
                resolvers.shift()?.();
            }
            await Promise.allSettled(
                [firstRefresh, secondRefresh].filter(Boolean)
            );
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

describe('FontManager worker seed export', () => {
    let originalOpenedFonts;
    let originalCurrentFontId;
    let originalPatchSyncEngine;
    let intermediateFontData;

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
        originalPatchSyncEngine = window.patchSyncEngine;

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
    });

    afterEach(() => {
        fontManager.openedFonts = originalOpenedFonts;
        fontManager.currentFontId = originalCurrentFontId;
        window.patchSyncEngine = originalPatchSyncEngine;
    });

    test('buildWorkerSeedYjsState prefers bridge-native export without parsing babelfontJson', () => {
        const workerDoc = new Y.Doc();
        jsonToYDoc(
            cloneJson(fontManager.currentFont.babelfontData),
            workerDoc.getMap('font')
        );

        const encodeBridgeState = jest.fn(() =>
            Y.encodeStateAsUpdate(workerDoc)
        );
        const parseSpy = jest.spyOn(JSON, 'parse');

        window.patchSyncEngine = {
            fontMap: workerDoc.getMap('font'),
            encodeBridgeState
        };

        try {
            const state = fontManager.buildWorkerSeedYjsState();
            const roundTripDoc = new Y.Doc();
            Y.applyUpdate(roundTripDoc, state);
            const roundTripJson = yDocToJson(roundTripDoc.getMap('font'));
            const firstGlyph = roundTripJson.glyphs.find(
                (glyph) => glyph.name === 'a'
            );
            const firstLayer = firstGlyph.layers[0];
            const firstPathShape = firstLayer.shapes.find(
                (shape) =>
                    !shape.reference &&
                    (Array.isArray(shape.nodes) ||
                        typeof shape.nodes === 'string')
            );

            expect(encodeBridgeState).toHaveBeenCalledTimes(1);
            expect(parseSpy).not.toHaveBeenCalled();
            expect(state).toBeInstanceOf(Uint8Array);
            expect(firstPathShape).toBeDefined();
        } finally {
            parseSpy.mockRestore();
        }
    });
});

describe('FontManager handleNewFont', () => {
    let originalOpenedFonts;
    let originalCurrentFontId;
    let originalCurrentFontModel;
    let originalPluginRegistry;
    let originalFontCompilationInitialized;
    let originalLastStoredFontJson;
    let originalCloudPlugin;
    let sendMessageSpy;
    let updateDirtyIndicatorSpy;
    let intermediateFontData;

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
        originalCurrentFontModel = window.currentFontModel;
        originalPluginRegistry = window.pluginRegistry;
        originalFontCompilationInitialized = fontCompilation.isInitialized;
        originalLastStoredFontJson = fontCompilation.lastStoredFontJson;
        originalCloudPlugin = window.cloudPlugin;

        // Provide a mock pluginRegistry so the disk plugin lookup works
        window.pluginRegistry = {
            get: (id) => {
                if (id === 'disk') {
                    return { getId: () => 'disk', getName: () => 'Disk' };
                }
                if (id === 'memory') {
                    return { getId: () => 'memory', getName: () => 'Memory' };
                }
                return null;
            }
        };

        fontCompilation.isInitialized = true;
        sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({
                success: true,
                workerCacheStatus: makeWorkerCacheStatus()
            });
        updateDirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();

        // Load an existing font first to simulate having a font open
        const fontData = cloneJson(intermediateFontData);
        const fakeCurrentFont = {
            babelfontJson: JSON.stringify(fontData),
            babelfontData: fontData,
            fontModel: Font.fromData(fontData),
            name: 'Sukoon',
            hasUnsavedChanges: false,
            isCloudBacked: () => false,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(function () {
                this.babelfontJson = this.fontModel.toJSONString();
            })
        };
        fontManager.openedFonts = new Map([['test-font', fakeCurrentFont]]);
        fontManager.currentFontId = 'test-font';
        window.currentFontModel = fakeCurrentFont.fontModel;
    });

    afterEach(() => {
        sendMessageSpy?.mockRestore();
        updateDirtyIndicatorSpy?.mockRestore();
        fontManager.openedFonts = originalOpenedFonts;
        fontManager.currentFontId = originalCurrentFontId;
        window.currentFontModel = originalCurrentFontModel;
        window.pluginRegistry = originalPluginRegistry;
        fontCompilation.isInitialized = originalFontCompilationInitialized;
        fontCompilation.lastStoredFontJson = originalLastStoredFontJson;
        window.cloudPlugin = originalCloudPlugin;
        delete window.patchSyncEngine;
    });

    test('generates valid empty font JSON that can be parsed by Font.fromData', () => {
        const json = fontManager.generateEmptyFontJson();
        expect(typeof json).toBe('string');
        const parsed = JSON.parse(json);
        expect(parsed.upm).toBe(1000);
        expect(parsed.names.family_name.dflt).toBe('Untitled');
        expect(parsed.masters.length).toBe(1);
        expect(typeof parsed.masters[0].name).toBe('object');
        expect(parsed.masters[0].name.dflt).toBe('Default Master');
        expect(parsed.masters[0].id).toBeTruthy();
        expect(parsed.glyphs.length).toBe(1);
        expect(parsed.glyphs[0].name).toBe('.notdef');
        expect(parsed.glyphs[0].category).toBe('Unknown');
        // exported defaults to true in Rust and is skipped from JSON when true
        expect(parsed.features).toBeDefined();
        expect(parsed.date).toBeTruthy();
        expect(parsed.version).toEqual([1, 0]);

        // Must be parseable by Font.fromData (the JS model)
        const fontObj = Font.fromData(parsed);
        expect(fontObj).toBeDefined();
        expect(fontObj.names.family_name.dflt).toBe('Untitled');
        expect(fontObj.glyphs[0].exported).toBe(true);
    });

    test('generateEmptyFontJson creates a valid font data structure for Font.fromData', () => {
        const json = fontManager.generateEmptyFontJson();
        expect(typeof json).toBe('string');
        const parsed = JSON.parse(json);
        expect(parsed.upm).toBe(1000);
        expect(parsed.names.family_name.dflt).toBe('Untitled');
        expect(parsed.masters.length).toBe(1);
        expect(parsed.masters[0].name.dflt).toBe('Default Master');
        expect(parsed.masters[0].metrics).toBeDefined();
        expect(parsed.glyphs.length).toBe(1);
        expect(parsed.glyphs[0].name).toBe('.notdef');
        expect(parsed.glyphs[0].category).toBe('Unknown');
        expect(parsed.glyphs[0].layers[0].width).toBe(600);
        expect(parsed.masters[0].id).toBeTruthy();
        expect(parsed.glyphs[0].layers[0].id).toBeTruthy();
        // exported, shapes, anchors, guides, etc. have Rust defaults and
        // are absent from the minimal JSON — Font.fromData fills in
        const fontObj = Font.fromData(parsed);
        expect(fontObj.glyphs[0].exported).toBe(true);
        expect(parsed.date).toBeTruthy();
        expect(parsed.version).toEqual([1, 0]);
        expect(parsed.features).toBeDefined();
    });

    test('generateEmptyFontJson round-trips through Font.fromData', () => {
        const json = fontManager.generateEmptyFontJson();
        const parsed = JSON.parse(json);
        const fontObj = Font.fromData(parsed);
        expect(fontObj).toBeDefined();
        expect(fontObj.names.family_name.dflt).toBe('Untitled');
        expect(fontObj.masters[0].name.dflt).toBe('Default Master');
        expect(fontObj.findGlyph('.notdef')).toBeDefined();
    });

    test('handleNewFont clears worker cache but does not store full font JSON before dispatching fontLoaded', async () => {
        const events = [];
        const onFontLoaded = (event) => events.push(event.detail);
        window.addEventListener('fontLoaded', onFontLoaded);

        try {
            await fontManager.handleNewFont();

            expect(sendMessageSpy).toHaveBeenCalledWith({ type: 'clearCache' });
            expect(sendMessageSpy).not.toHaveBeenCalledWith(
                expect.objectContaining({ type: 'storeFontJson' })
            );
            expect(events).toHaveLength(1);
            expect(events[0]).toEqual(
                expect.objectContaining({
                    path: 'untitled.babelfont'
                })
            );
        } finally {
            window.removeEventListener('fontLoaded', onFontLoaded);
        }
    });

    test('handleNewFont disconnects the previous cloud room before listeners observe the new untitled font', async () => {
        const fontData = cloneJson(intermediateFontData);
        const fakeCurrentFont = {
            babelfontJson: JSON.stringify(fontData),
            babelfontData: fontData,
            fontModel: Font.fromData(fontData),
            name: 'Cloud Source',
            path: 'cloud://asset-cloud-source',
            hasUnsavedChanges: false,
            isCloudBacked: () => true,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(function () {
                this.babelfontJson = this.fontModel.toJSONString();
            })
        };
        fontManager.openedFonts = new Map([['cloud-font', fakeCurrentFont]]);
        fontManager.currentFontId = 'cloud-font';
        window.currentFontModel = fakeCurrentFont.fontModel;

        const disconnectSpy = jest.fn(() => {
            window.cloudPlugin._activeAssetId = null;
            window.cloudPlugin._cloudAdapter = null;
        });
        window.cloudPlugin = {
            _activeAssetId: 'asset-cloud-source',
            _cloudAdapter: { disconnect: jest.fn() },
            disconnectFromRoom: disconnectSpy
        };

        const observedStates = [];
        const onFontLoaded = (event) => {
            observedStates.push({
                path: event.detail?.path,
                activeAssetId: window.cloudPlugin?._activeAssetId ?? null,
                cloudAdapter: window.cloudPlugin?._cloudAdapter ?? null
            });
        };
        window.addEventListener('fontLoaded', onFontLoaded);

        try {
            await fontManager.handleNewFont();

            expect(disconnectSpy).toHaveBeenCalledTimes(1);
            expect(observedStates).toEqual([
                {
                    path: 'untitled.babelfont',
                    activeAssetId: null,
                    cloudAdapter: null
                }
            ]);
        } finally {
            window.removeEventListener('fontLoaded', onFontLoaded);
        }
    });
});

describe('FontCompilation worker cache readiness', () => {
    let originalInitialized;
    let sendMessageSpy;

    beforeEach(() => {
        originalInitialized = fontCompilation.isInitialized;
        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);
        sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({
                result: new Uint8Array([1, 2, 3]),
                filename: 'editing.ttf',
                time_taken: 1,
                fontRevisionKey: '1'
            });
    });

    afterEach(() => {
        sendMessageSpy?.mockRestore();
        fontCompilation.isInitialized = originalInitialized;
        fontCompilation.setWorkerCacheDocumentReady(false);
    });

    test('compileEditingFromJsonCached uses incremental sentinel when worker cache is ready from binary sync', async () => {
        fontCompilation.setWorkerCacheDocumentReady(true);

        await fontCompilation.compileEditingFromJsonCached(
            '{"glyphs":[]}',
            '1',
            ['a']
        );

        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'compileEditingCached',
                babelfontJson: '__incremental_layer__'
            })
        );
    });

    test('compileEditingFromJsonCached separates glyph subset key from feature-sensitive layout closure key', async () => {
        fontCompilation.setWorkerCacheDocumentReady(true);

        await fontCompilation.compileEditingFromJsonCached(
            '{"glyphs":[]}',
            '1',
            ['beh', 'alef'],
            {
                selectedFeatures: ['liga', 'kern']
            }
        );

        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'compileEditingCached',
                subsetKey: 'alef\u001fbeh',
                layoutClosureKey: 'alef\u001fbeh\u001ekern\u001fliga'
            })
        );
    });

    test('compileEditingFromJsonCached forwards undo/redo compile source metadata to the worker', async () => {
        fontCompilation.setWorkerCacheDocumentReady(true);

        await fontCompilation.compileEditingFromJsonCached(
            '{"glyphs":[]}',
            '12',
            ['o', 'odieresis'],
            {
                compileSource: 'keyboard-outline',
                selectedFeatures: ['kern']
            }
        );

        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'compileEditingCached',
                subsetGlyphs: ['o', 'odieresis'],
                layoutClosureKey: 'o\u001fodieresis\u001ekern',
                _compileSource: 'keyboard-outline'
            })
        );
    });

    test('compileEditingFromJsonCached keeps feature-code commits on the incremental worker path', async () => {
        fontCompilation.setWorkerCacheDocumentReady(true);

        await fontCompilation.compileEditingFromJsonCached(
            '{"glyphs":[]}',
            '1',
            ['o', 'odieresis'],
            {
                compileSource: 'feature-code'
            }
        );

        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'compileEditingCached',
                babelfontJson: '__incremental_layer__',
                subsetGlyphs: ['o', 'odieresis'],
                _compileSource: 'feature-code'
            })
        );
    });

    test('compileEditingFromJsonCached rejects when the worker cache is cold', async () => {
        await expect(
            fontCompilation.compileEditingFromJsonCached('{"glyphs":[]}', '1', [
                'a'
            ])
        ).rejects.toThrow(/worker Yjs document/);

        expect(sendMessageSpy).not.toHaveBeenCalled();
    });

    test('handleWorkerMessage resolves non-compiled worker results without byte normalization', () => {
        const resolve = jest.fn();
        const reject = jest.fn();

        fontCompilation.pendingCompilations.set(99, {
            resolve,
            reject,
            filename: 'worker-message',
            spanId: undefined,
            traceContext: {
                process: 'main',
                traceId: 'apply-yjs-update-99',
                requestId: '99'
            }
        });

        const message = {
            data: {
                id: 99,
                type: 'applyYjsUpdate',
                success: true,
                result: '{"changedGlyphs":["a"]}'
            }
        };

        fontCompilation.handleWorkerMessage(message);

        expect(resolve).toHaveBeenCalledWith(message.data);
        expect(reject).not.toHaveBeenCalled();
    });
});

describe('Cloud disconnect on font switch', () => {
    const { CloudAdapter } = require('../js/cloud-adapter.ts');
    let originalCloudPlugin;
    let originalFontCompilationInitialized;
    let originalSendMessage;

    beforeAll(() => {
        originalCloudPlugin = window.cloudPlugin;
        originalFontCompilationInitialized = fontCompilation.isInitialized;
        originalSendMessage = fontCompilation.sendMessage;
    });

    beforeEach(() => {
        fontCompilation.isInitialized = true;
        fontCompilation.sendMessage = jest.fn().mockResolvedValue({});
    });

    afterEach(() => {
        delete window.cloudPlugin;
        delete window.patchSyncEngine;
        fontCompilation.isInitialized = originalFontCompilationInitialized;
        fontCompilation.sendMessage = originalSendMessage;
    });

    afterAll(() => {
        window.cloudPlugin = originalCloudPlugin;
    });

    test('CloudAdapter.disconnect resets all internal state', () => {
        const adapter = new CloudAdapter({ assetId: 'test-asset' });

        // Simulate a connected adapter by setting internal fields directly
        // (real connect() requires WebSocket + network which we don't have in Jest)
        const mockBridge = {
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };
        const mockWs = { close: jest.fn() };
        const fontModelReadyHandler = jest.fn();
        window.addEventListener('fontModelReady', fontModelReadyHandler);

        adapter._destroyed = false;
        adapter._bridge = mockBridge;
        adapter._ws = mockWs;
        adapter._localUpdateUnsubscribe = jest.fn();
        adapter._fontModelReadyHandler = fontModelReadyHandler;
        adapter._hasSynced = true;

        // Call disconnect — this is what disconnectFromRoom → _disconnectCurrent → disconnect does
        adapter.disconnect();

        // Verify the adapter is fully torn down
        expect(adapter._destroyed).toBe(true);
        expect(adapter._bridge).toBeNull();
        expect(adapter._ws).toBeNull();
        expect(adapter._localUpdateUnsubscribe).toBeNull();
        expect(adapter._directConnection).toBeNull();
        expect(adapter._pendingOutboundPackets).toEqual([]);
        expect(adapter._pendingInboundUpdates).toEqual([]);
        expect(adapter._initialServerStateApplied).toBe(false);
        expect(adapter.status).toBe('disconnected');
        expect(mockWs.close).toHaveBeenCalledWith(1000, 'disconnect');
    });

    test('fontLoaded triggers disconnect on a real CloudAdapter', () => {
        const adapter = new CloudAdapter({ assetId: 'test-asset' });

        // Simulate connected state
        adapter._destroyed = false;
        adapter._bridge = {
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };

        // Simulate a registered fontModelReady handler
        const fontModelReadyHandler = jest.fn();
        adapter._fontModelReadyHandler = fontModelReadyHandler;
        window.addEventListener('fontModelReady', fontModelReadyHandler);

        // Set up cloudPlugin with the real disconnectFromRoom logic
        window.cloudPlugin = {
            _cloudAdapter: adapter,
            _activeAssetId: 'test-asset',
            _disconnectCurrent() {
                this._cloudAdapter?.disconnect();
                this._cloudAdapter = null;
                this._activeAssetId = null;
            },
            disconnectFromRoom() {
                this._disconnectCurrent();
            }
        };

        // Dispatch fontLoaded — our handler calls disconnectFromRoom first
        window.dispatchEvent(
            new CustomEvent('fontLoaded', {
                detail: {
                    path: 'test.babelfont',
                    babelfontJson: JSON.stringify({ upm: 1000 }),
                    sourcePlugin: {
                        getId: () => 'memory'
                    }
                }
            })
        );

        // Verify the adapter was disconnected
        expect(adapter._destroyed).toBe(true);
        expect(adapter._bridge).toBeNull();
        expect(window.cloudPlugin._cloudAdapter).toBeNull();
        expect(window.cloudPlugin._activeAssetId).toBeNull();
    });
});
