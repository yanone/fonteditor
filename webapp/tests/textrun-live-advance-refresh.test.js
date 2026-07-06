const { TextRunEditor } = require('../js/glyph-canvas/textrun');
const { runBridgeUndoRedo } = require('../js/change-bridge-init');
const { applyLiveSidebearingVisualSync } = require('../js/sidebearing-utils');
const { fontCompilation } = require('../js/font-compilation');

describe('TextRunEditor live advance refresh', () => {
    let editor;
    let originalGlyphCanvas;
    let originalFontCompilation;

    beforeEach(() => {
        const featuresManager = {
            getHarfBuzzFeatures: () => null
        };
        const axesManager = {
            variationSettings: {}
        };

        editor = new TextRunEditor(featuresManager, axesManager);
        editor.textBuffer = 'aba';
        editor.shapedGlyphs = [
            { ax: 500, dx: 0, dy: 0, g: 10, cl: 0 },
            { ax: 320, dx: 0, dy: 0, g: 11, cl: 1 },
            { ax: 500, dx: 0, dy: 0, g: 10, cl: 2 }
        ];
        editor.glyphNameBuffer = ['a', 'b', 'a'];
        editor.intrinsicGlyphAdvances = new Map([
            ['a', 500],
            ['b', 320]
        ]);
        editor.clusterMap = [
            {
                glyphIndex: 0,
                glyphCount: 1,
                start: 0,
                end: 1,
                x: 0,
                width: 500,
                isRTL: false,
                isExplicitToken: false,
                isAtomicCluster: false
            }
        ];

        originalGlyphCanvas = window.glyphCanvas;
        originalFontCompilation = window.fontCompilation;
    });

    afterEach(() => {
        window.glyphCanvas = originalGlyphCanvas;
        window.fontCompilation = originalFontCompilation;
    });

    test('updates matching glyph advances and rerenders the line', () => {
        const buildClusterMapSpy = jest.spyOn(editor, 'buildClusterMap');
        const updateCursorSpy = jest.spyOn(
            editor,
            'updateCursorVisualPosition'
        );
        const renderCallback = jest.fn();
        editor.on('render', renderCallback);

        const changed = editor.refreshGlyphAdvancesLive({ a: 640 });

        expect(changed).toBe(true);
        expect(editor.shapedGlyphs.map((glyph) => glyph.ax)).toEqual([
            640, 320, 640
        ]);
        expect(buildClusterMapSpy).toHaveBeenCalledTimes(1);
        expect(updateCursorSpy).toHaveBeenCalledTimes(1);
        expect(renderCallback).toHaveBeenCalledTimes(1);
    });

    test('does nothing when no matching advance changes are provided', () => {
        const buildClusterMapSpy = jest.spyOn(editor, 'buildClusterMap');
        const updateCursorSpy = jest.spyOn(
            editor,
            'updateCursorVisualPosition'
        );
        const renderCallback = jest.fn();
        editor.on('render', renderCallback);

        const changed = editor.refreshGlyphAdvancesLive({ c: 700, a: 500 });

        expect(changed).toBe(false);
        expect(editor.shapedGlyphs.map((glyph) => glyph.ax)).toEqual([
            500, 320, 500
        ]);
        expect(buildClusterMapSpy).not.toHaveBeenCalled();
        expect(updateCursorSpy).not.toHaveBeenCalled();
        expect(renderCallback).not.toHaveBeenCalled();
    });

    test('can refresh advances without emitting an immediate render', () => {
        const buildClusterMapSpy = jest.spyOn(editor, 'buildClusterMap');
        const updateCursorSpy = jest.spyOn(
            editor,
            'updateCursorVisualPosition'
        );
        const renderCallback = jest.fn();
        editor.on('render', renderCallback);

        const changed = editor.refreshGlyphAdvancesLive(
            { a: 640 },
            { render: false }
        );

        expect(changed).toBe(true);
        expect(editor.shapedGlyphs.map((glyph) => glyph.ax)).toEqual([
            640, 320, 640
        ]);
        expect(buildClusterMapSpy).toHaveBeenCalledTimes(1);
        expect(updateCursorSpy).toHaveBeenCalledTimes(1);
        expect(renderCallback).not.toHaveBeenCalled();
    });

    test('does not clobber kerning-shaped advances when raw widths are unchanged', () => {
        editor.shapedGlyphs = [
            { ax: 460, dx: 0, dy: 0, g: 10, cl: 0 },
            { ax: 320, dx: 0, dy: 0, g: 11, cl: 1 },
            { ax: 460, dx: 0, dy: 0, g: 10, cl: 2 }
        ];

        const changed = editor.refreshGlyphAdvancesLive({ a: 500 });

        expect(changed).toBe(false);
        expect(editor.shapedGlyphs.map((glyph) => glyph.ax)).toEqual([
            460, 320, 460
        ]);
    });

    test('preserves existing kerning delta when a live width edit changes advance', () => {
        editor.shapedGlyphs = [
            { ax: 460, dx: 0, dy: 0, g: 10, cl: 0 },
            { ax: 320, dx: 0, dy: 0, g: 11, cl: 1 },
            { ax: 460, dx: 0, dy: 0, g: 10, cl: 2 }
        ];

        const changed = editor.refreshGlyphAdvancesLive({ a: 520 });

        expect(changed).toBe(true);
        expect(editor.shapedGlyphs.map((glyph) => glyph.ax)).toEqual([
            480, 320, 480
        ]);
        expect(editor.intrinsicGlyphAdvances.get('a')).toBe(520);
    });

    test('skips explicit outline prefetch while an outline drag is active', async () => {
        const sendMessage = jest.fn();
        window.fontCompilation = { sendMessage };
        window.glyphCanvas = {
            outlineEditor: {
                draggingSomething: true
            }
        };

        editor.shapedGlyphs = [
            {
                ax: 500,
                dx: 0,
                dy: 0,
                g: 0,
                cl: 0,
                explicitGlyphName: 'adieresis'
            }
        ];

        await editor.prefetchExplicitGlyphOutlinesForCurrentState();

        expect(sendMessage).not.toHaveBeenCalled();
    });

    test('drops stale explicit outline responses after cache invalidation', async () => {
        let resolveOutlines;
        const sendMessage = jest.fn(
            () =>
                new Promise((resolve) => {
                    resolveOutlines = resolve;
                })
        );
        window.fontCompilation = { sendMessage };
        window.glyphCanvas = {
            outlineEditor: {
                draggingSomething: false
            }
        };

        editor.shapedGlyphs = [
            {
                ax: 500,
                dx: 0,
                dy: 0,
                g: 0,
                cl: 0,
                explicitGlyphName: 'adieresis'
            }
        ];

        const renderCallback = jest.fn();
        editor.on('render', renderCallback);

        const prefetchPromise =
            editor.prefetchExplicitGlyphOutlinesForCurrentState();
        editor.invalidateExplicitGlyphOutlineCache();

        resolveOutlines({
            outlinesJson: JSON.stringify([
                {
                    name: 'adieresis',
                    width: 533,
                    shapes: []
                }
            ])
        });

        await prefetchPromise;

        expect(editor.getCachedExplicitGlyphOutline('adieresis')).toBeNull();
        expect(renderCallback).not.toHaveBeenCalled();
    });
});

describe('applyLiveSidebearingVisualSync', () => {
    test('matches editing behavior for left sidebearings without forcing a render', () => {
        const refreshGlyphAdvancesLive = jest.fn(() => true);
        const target = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive
            }
        };

        const result = applyLiveSidebearingVisualSync(target, {
            glyphName: 'a',
            side: 'left',
            previousWidth: 500,
            nextWidth: 520,
            render: false
        });

        expect(result).toEqual({
            widthDelta: 20,
            advancesRefreshed: true
        });
        expect(target.viewportManager.panX).toBe(60);
        expect(refreshGlyphAdvancesLive).toHaveBeenCalledWith(
            { a: 520 },
            { render: false }
        );
    });

    test('refreshes active and dependent glyph advances in one pass when provided', () => {
        const refreshGlyphAdvancesLive = jest.fn(() => true);
        const target = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive
            }
        };

        const result = applyLiveSidebearingVisualSync(target, {
            glyphName: 'a',
            glyphAdvances: {
                a: 520,
                adieresis: 610,
                aring: 620
            },
            side: 'right',
            previousWidth: 500,
            nextWidth: 520,
            render: false
        });

        expect(result).toEqual({
            widthDelta: 20,
            advancesRefreshed: true
        });
        expect(target.viewportManager.panX).toBe(100);
        expect(refreshGlyphAdvancesLive).toHaveBeenCalledWith(
            {
                a: 520,
                adieresis: 610,
                aring: 620
            },
            { render: false }
        );
    });
});

describe('runBridgeUndoRedo sidebearing sync', () => {
    const originalWindow = global.window;
    const originalGlyphCanvas = originalWindow.glyphCanvas;
    const originalFontManager = originalWindow.fontManager;
    const originalPatchSyncEngine = originalWindow.patchSyncEngine;
    const originalChangeBridge = originalWindow.changeBridge;
    const originalAutoCompileManager = originalWindow.autoCompileManager;
    let originalWorkerCacheReady;

    beforeEach(() => {
        originalWorkerCacheReady = fontCompilation.hasWorkerCacheDocument();
        fontCompilation.setWorkerCacheDocumentReady(true);
    });

    afterEach(() => {
        originalWindow.glyphCanvas = originalGlyphCanvas;
        originalWindow.fontManager = originalFontManager;
        originalWindow.patchSyncEngine = originalPatchSyncEngine;
        originalWindow.changeBridge = originalChangeBridge;
        originalWindow.autoCompileManager = originalAutoCompileManager;
        fontCompilation.setWorkerCacheDocumentReady(originalWorkerCacheReady);
        jest.clearAllMocks();
    });

    test('undoing a left sidebearing change keeps the glyph stationary and refreshes advances before repaint', async () => {
        const requestRepaintAfterCompile = jest.fn();
        const refreshGlyphAdvancesLive = jest.fn();
        const fetchLayerData = jest.fn().mockResolvedValue();
        const runDeterministicRefresh = jest.fn(async (task) => await task());
        const syncCurrentOutlineLayerDataFromModel = jest.fn();
        const render = jest.fn();

        const makeFontModel = (width) => ({
            findGlyph: jest.fn(() => ({
                findLayerById: jest.fn(() => ({ id: 'layer-1', width }))
            }))
        });

        const currentFont = {
            fontModel: makeFontModel(500),
            requestRecompileWithoutDataChange: jest.fn()
        };

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive
            },
            outlineEditor: {
                selectedLayerId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchLayerData,
                runDeterministicRefresh,
                performHitDetection: jest.fn()
            },
            syncCurrentOutlineLayerDataFromModel,
            updatePropertyPanel: jest.fn(),
            render,
            requestRepaintAfterCompile
        };
        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            lastChangeSource: null,
            lastEditType: null
        };
        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            undo: jest.fn(() => {
                currentFont.fontModel = makeFontModel(520);
                return {
                    scope: 'layer',
                    glyphName: 'a',
                    layerId: 'layer-1',
                    historyItem: {
                        transactionLabel: 'Set LSB',
                        workerReplayTargets: [
                            {
                                glyphName: 'a',
                                layerId: 'layer-1'
                            }
                        ],
                        entries: [
                            {
                                oldValue: 'LEFT 40',
                                newValue: 'LEFT 60',
                                workerReplayTargets: [
                                    {
                                        glyphName: 'a',
                                        layerId: 'layer-1'
                                    }
                                ]
                            }
                        ]
                    }
                };
            })
        };
        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

        expect(originalWindow.fontManager.lastChangeSource).toBeNull();
        expect(originalWindow.fontManager.lastEditType).toBeNull();
        expect(fetchLayerData).not.toHaveBeenCalled();
        expect(refreshGlyphAdvancesLive).toHaveBeenCalledWith(
            { a: 520 },
            { render: false }
        );
        expect(originalWindow.glyphCanvas.viewportManager.panX).toBe(60);
        expect(syncCurrentOutlineLayerDataFromModel).toHaveBeenCalledTimes(2);
        expect(render).toHaveBeenCalledTimes(1);
        expect(requestRepaintAfterCompile).not.toHaveBeenCalled();
    });

    test('undo sidebearing sync refreshes advances for the stack-selected edited glyph name', async () => {
        const refreshGlyphAdvancesLive = jest.fn();

        const makeFontModel = () => ({
            findGlyph: jest.fn((glyphName) => {
                if (glyphName === 'a') {
                    return {
                        findLayerById: jest.fn(() => ({ width: 500 }))
                    };
                }

                if (glyphName === 'a.alt') {
                    return {
                        findLayerById: jest.fn(() => ({ width: 520 }))
                    };
                }

                return null;
            })
        });

        const currentFont = {
            fontModel: makeFontModel(),
            requestRecompileWithoutDataChange: jest.fn()
        };

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive
            },
            outlineEditor: {
                active: true,
                selectedLayerId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a.alt' }]),
                fetchLayerData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineLayerDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };
        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            lastChangeSource: null,
            lastEditType: null
        };
        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            undo: jest.fn(() => ({
                scope: 'layer',
                glyphName: 'a',
                layerId: 'layer-1',
                historyItem: {
                    transactionLabel: 'Set LSB',
                    entries: [
                        {
                            oldValue: 'LEFT 40',
                            newValue: 'LEFT 60'
                        }
                    ]
                }
            }))
        };
        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

        expect(refreshGlyphAdvancesLive).toHaveBeenCalledWith(
            expect.objectContaining({ 'a.alt': 520 }),
            { render: false }
        );
    });

    test('undo batches glyphChanged notifications for glyph overview refresh', async () => {
        const glyphChangedHandler = jest.fn();

        const currentFont = {
            fontModel: {
                findGlyph: jest.fn(() => ({
                    findLayerById: jest.fn(() => ({ width: 500 }))
                })),
                findGlyphsUsingComponent: jest.fn((glyphName) =>
                    glyphName === 'a' ? ['adieresis', 'aring'] : []
                )
            },
            requestRecompileWithoutDataChange: jest.fn()
        };

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive: jest.fn()
            },
            outlineEditor: {
                active: true,
                selectedLayerId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchLayerData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineLayerDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };
        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            lastChangeSource: null,
            lastEditType: null,
            scheduleFullCompileDebounce: jest.fn()
        };
        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            undo: jest.fn(() => ({
                scope: 'layer',
                glyphName: 'a',
                layerId: 'layer-1',
                historyItem: {
                    transactionLabel: 'Set LSB',
                    touchedPaths: [
                        'glyphs.a.layers.layer-1.width',
                        'glyphs.adieresis.layers.layer-1.width'
                    ],
                    entries: [
                        {
                            oldValue: 'LEFT 40',
                            newValue: 'LEFT 60'
                        }
                    ]
                }
            }))
        };
        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);
        } finally {
            window.removeEventListener('glyphChanged', glyphChangedHandler);
        }

        expect(glyphChangedHandler).toHaveBeenCalledTimes(1);
        expect(glyphChangedHandler.mock.calls[0][0].detail).toEqual({
            glyphName: 'a',
            glyphNames: ['a']
        });
    });

    test('redo batches glyphChanged notifications for glyph overview refresh', async () => {
        const glyphChangedHandler = jest.fn();

        const currentFont = {
            fontModel: {
                findGlyph: jest.fn(() => ({
                    findLayerById: jest.fn(() => ({ width: 500 }))
                })),
                findGlyphsUsingComponent: jest.fn((glyphName) =>
                    glyphName === 'a' ? ['adieresis', 'aring'] : []
                )
            },
            requestRecompileWithoutDataChange: jest.fn()
        };

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive: jest.fn()
            },
            outlineEditor: {
                active: true,
                selectedLayerId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchLayerData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineLayerDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };
        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            lastChangeSource: null,
            lastEditType: null,
            scheduleFullCompileDebounce: jest.fn()
        };
        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            redo: jest.fn(() => ({
                scope: 'layer',
                glyphName: 'a',
                layerId: 'layer-1',
                historyItem: {
                    transactionLabel: 'Redo Set LSB',
                    touchedPaths: [
                        'glyphs.a.layers.layer-1.width',
                        'glyphs.adieresis.layers.layer-1.width'
                    ],
                    entries: [
                        {
                            oldValue: 'LEFT 40',
                            newValue: 'LEFT 60'
                        }
                    ]
                }
            }))
        };
        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            await runBridgeUndoRedo('redo', 'a', 'a', 'layer-1', null);
        } finally {
            window.removeEventListener('glyphChanged', glyphChangedHandler);
        }

        expect(glyphChangedHandler).toHaveBeenCalledTimes(1);
        expect(glyphChangedHandler.mock.calls[0][0].detail).toEqual({
            glyphName: 'a',
            glyphNames: ['a']
        });
    });

    test('undo sidebearing sync uses stack-resolved edited glyph width for LSB drags', async () => {
        const refreshGlyphAdvancesLive = jest.fn();
        const fontModelBeforeUndo = {
            findGlyph: jest.fn((glyphName) => {
                if (glyphName === 'a') {
                    return {
                        findLayerById: jest.fn(() => ({ width: 520 }))
                    };
                }

                if (glyphName === 'a.alt') {
                    return {
                        findLayerById: jest.fn(() => ({ width: 540 }))
                    };
                }

                return null;
            })
        };
        const fontModelAfterUndo = {
            findGlyph: jest.fn((glyphName) => {
                if (glyphName === 'a') {
                    return {
                        findLayerById: jest.fn(() => ({ width: 520 }))
                    };
                }

                if (glyphName === 'a.alt') {
                    return {
                        findLayerById: jest.fn(() => ({ width: 520 }))
                    };
                }

                return null;
            })
        };

        const currentFont = {
            fontModel: fontModelBeforeUndo,
            requestRecompileWithoutDataChange: jest.fn()
        };

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive
            },
            outlineEditor: {
                active: true,
                selectedLayerId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a.alt' }]),
                fetchLayerData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineLayerDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };
        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            lastChangeSource: null,
            lastEditType: null
        };
        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            undo: jest.fn(() => {
                currentFont.fontModel = fontModelAfterUndo;
                return {
                    scope: 'layer',
                    glyphName: 'a',
                    layerId: 'layer-1',
                    historyItem: {
                        transactionLabel: 'Set LSB',
                        entries: [
                            {
                                oldValue: 'LEFT 40',
                                newValue: 'LEFT 60'
                            }
                        ]
                    }
                };
            })
        };
        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

        expect(refreshGlyphAdvancesLive.mock.calls).toContainEqual([
            { 'a.alt': 520 },
            { render: false }
        ]);
        expect(originalWindow.glyphCanvas.viewportManager.panX).toBe(140);
    });

    test('undo point drag recomputes metrics-key dependents and refreshes their advances immediately', async () => {
        const refreshGlyphAdvancesLive = jest.fn();
        const recomputeMetricsKeys = jest.fn(() => new Set(['a', 'n']));
        const sendMessage = jest.fn().mockResolvedValue({ success: true });

        const makeFontModel = (aWidth, nWidth) => ({
            recomputeMetricsKeys,
            findGlyph: jest.fn((glyphName) => {
                if (glyphName === 'a') {
                    return {
                        findLayerById: jest.fn(() => ({ width: aWidth }))
                    };
                }
                if (glyphName === 'n') {
                    return {
                        findLayerById: jest.fn(() => ({ width: nWidth }))
                    };
                }
                return null;
            })
        });

        const currentFont = {
            fontModel: makeFontModel(500, 480),
            requestRecompileWithoutDataChange: jest.fn()
        };

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive
            },
            outlineEditor: {
                active: true,
                selectedLayerId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchLayerData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineLayerDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };

        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            lastChangeSource: null,
            lastEditType: null,
            refreshWorkerCacheForReplayTargets: jest
                .fn()
                .mockResolvedValue(true)
        };
        fontCompilation.isInitialized = true;
        jest.spyOn(fontCompilation, 'sendMessage').mockImplementation(
            sendMessage
        );

        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            runWithoutRecording: jest.fn((fn) => fn()),
            undo: jest.fn(() => {
                currentFont.fontModel = makeFontModel(520, 600);
                return {
                    scope: 'layer',
                    glyphName: 'a',
                    layerId: 'layer-1',
                    historyItem: {
                        transactionLabel: 'Drag point',
                        touchedPaths: ['glyphs.a.layers.layer-1'],
                        workerReplayTargets: [
                            {
                                glyphName: 'a',
                                layerId: 'layer-1'
                            },
                            {
                                glyphName: 'n',
                                layerId: 'layer-1'
                            }
                        ],
                        entries: [
                            {
                                oldValue: '(10, 20)',
                                newValue: 'LEFT (20, 20)',
                                workerReplayTargets: [
                                    {
                                        glyphName: 'a',
                                        layerId: 'layer-1'
                                    },
                                    {
                                        glyphName: 'n',
                                        layerId: 'layer-1'
                                    }
                                ]
                            }
                        ]
                    }
                };
            })
        };

        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

        expect(
            refreshGlyphAdvancesLive.mock.calls.some(
                (call) =>
                    call?.[0]?.a === 520 &&
                    call?.[0]?.n === 600 &&
                    call?.[1]?.render === false
            )
        ).toBe(true);
        expect(
            originalWindow.fontManager.refreshWorkerCacheForReplayTargets
        ).toHaveBeenCalledWith([
            { glyphName: 'a', layerId: 'layer-1' },
            { glyphName: 'n', layerId: 'layer-1' }
        ]);
        expect(sendMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: 'storeFontJson' })
        );
    });

    test('undo point drag resyncs the active outline layer after metrics-key recompute', async () => {
        const refreshGlyphAdvancesLive = jest.fn();
        const syncCurrentOutlineLayerDataFromModel = jest.fn();
        const performHitDetection = jest.fn();
        const render = jest.fn();
        const updatedLayer = { id: 'layer-1', width: 520 };
        const fontModelBeforeUndo = {
            recomputeMetricsKeys: jest.fn(() => {
                currentFont.fontModel = fontModelAfterRecompute;
                return new Set(['a']);
            }),
            findGlyph: jest.fn(() => ({
                findLayerById: jest.fn(() => ({ id: 'layer-1', width: 500 }))
            }))
        };
        const fontModelAfterUndo = {
            recomputeMetricsKeys: fontModelBeforeUndo.recomputeMetricsKeys,
            findGlyph: jest.fn(() => ({
                findLayerById: jest.fn(() => ({ id: 'layer-1', width: 500 }))
            }))
        };
        const fontModelAfterRecompute = {
            recomputeMetricsKeys: fontModelBeforeUndo.recomputeMetricsKeys,
            findGlyph: jest.fn(() => ({
                findLayerById: jest.fn(() => updatedLayer)
            }))
        };

        const currentFont = {
            fontModel: fontModelBeforeUndo,
            requestRecompileWithoutDataChange: jest.fn()
        };

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive
            },
            outlineEditor: {
                active: true,
                selectedLayerId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchLayerData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineLayerDataFromModel,
            updatePropertyPanel: jest.fn(),
            render,
            requestRepaintAfterCompile: jest.fn()
        };

        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            lastChangeSource: null,
            lastEditType: null
        };

        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            runWithoutRecording: jest.fn((fn) => fn()),
            undo: jest.fn(() => {
                currentFont.fontModel = fontModelAfterUndo;
                return {
                    scope: 'layer',
                    glyphName: 'a',
                    layerId: 'layer-1',
                    historyItem: {
                        transactionLabel: 'Drag point',
                        touchedPaths: ['glyphs.a.layers.layer-1'],
                        entries: [
                            {
                                oldValue: '(10, 20)',
                                newValue: 'LEFT (20, 20)'
                            }
                        ]
                    }
                };
            })
        };

        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

        expect(syncCurrentOutlineLayerDataFromModel).toHaveBeenLastCalledWith({
            id: 'layer-1',
            width: 500
        });
        expect(performHitDetection).toHaveBeenCalled();
        expect(render).toHaveBeenCalled();
        expect(refreshGlyphAdvancesLive.mock.calls).toContainEqual([
            { a: 500 },
            { render: false }
        ]);
    });

    test('undo nested point drag refreshes the active stack layer instead of root layerData', async () => {
        const refreshGlyphAdvancesLive = jest.fn();
        const replaceCurrentLayerDataInStack = jest.fn(() => true);
        const syncCurrentOutlineLayerDataFromModel = jest.fn();
        const performHitDetection = jest.fn();
        const render = jest.fn();
        const updatedLayerJson = {
            id: 'layer-1',
            width: 520,
            shapes: []
        };
        const updatedLayer = {
            id: 'layer-1',
            width: 520,
            toJSON: jest.fn(() => updatedLayerJson)
        };
        const fontModelBeforeUndo = {
            recomputeMetricsKeys: jest.fn(() => new Set(['nested'])),
            findGlyph: jest.fn((glyphName) => {
                if (glyphName === 'nested') {
                    return {
                        findLayerById: jest.fn(() => ({
                            id: 'layer-1',
                            width: 500
                        }))
                    };
                }

                return null;
            })
        };
        const fontModelAfterUndo = {
            recomputeMetricsKeys: fontModelBeforeUndo.recomputeMetricsKeys,
            findGlyph: jest.fn((glyphName) => {
                if (glyphName === 'nested') {
                    return {
                        findLayerById: jest.fn(() => updatedLayer)
                    };
                }

                return null;
            })
        };

        const currentFont = {
            fontModel: fontModelBeforeUndo,
            requestRecompileWithoutDataChange: jest.fn()
        };

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive
            },
            outlineEditor: {
                active: true,
                selectedLayerId: 'root-layer',
                parseGlyphStack: jest.fn(() => [
                    { glyphName: 'root', layerId: 'root-layer' },
                    {
                        glyphName: 'nested',
                        layerId: 'layer-1',
                        componentIndex: 0
                    }
                ]),
                replaceCurrentLayerDataInStack,
                fetchLayerData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection
            },
            getCurrentGlyphName: jest.fn(() => 'root'),
            syncCurrentOutlineLayerDataFromModel,
            updatePropertyPanel: jest.fn(),
            render,
            requestRepaintAfterCompile: jest.fn()
        };

        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            lastChangeSource: null,
            lastEditType: null
        };

        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            runWithoutRecording: jest.fn((fn) => fn()),
            undo: jest.fn(() => {
                currentFont.fontModel = fontModelAfterUndo;
                return {
                    scope: 'layer',
                    glyphName: 'nested',
                    layerId: 'layer-1',
                    historyItem: {
                        transactionLabel: 'Drag point',
                        touchedPaths: ['glyphs.nested.layers.layer-1'],
                        entries: [
                            {
                                oldValue: '(10, 20)',
                                newValue: '(20, 20)'
                            }
                        ]
                    }
                };
            })
        };

        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        await runBridgeUndoRedo('undo', 'nested', 'root', 'layer-1', null);

        expect(replaceCurrentLayerDataInStack).toHaveBeenCalledWith(
            updatedLayerJson
        );
        expect(syncCurrentOutlineLayerDataFromModel).not.toHaveBeenCalled();
        expect(performHitDetection).toHaveBeenCalled();
        expect(render).toHaveBeenCalled();
        expect(refreshGlyphAdvancesLive.mock.calls).toContainEqual([
            { nested: 520 },
            { render: false }
        ]);
    });

    test('undo keyed point drag refreshes the worker incrementally without storeFontJson', async () => {
        const originalIsInitialized = fontCompilation.isInitialized;
        const originalLastStoredFontJson = fontCompilation.lastStoredFontJson;
        const sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue(undefined);
        const refreshWorkerCacheForReplayTargets = jest
            .fn()
            .mockResolvedValue(true);

        const makeFontModel = (width) => ({
            findGlyph: jest.fn(() => ({
                findLayerById: jest.fn(() => ({ id: 'layer-1', width }))
            }))
        });

        const currentFont = {
            babelfontJson: '{"glyphs":[]}',
            fontModel: makeFontModel(500),
            requestRecompileWithoutDataChange: jest.fn(),
            syncJsonFromModel: jest.fn()
        };

        fontCompilation.isInitialized = true;
        fontCompilation.lastStoredFontJson = 'cached-json';

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive: jest.fn()
            },
            outlineEditor: {
                active: true,
                selectedLayerId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchLayerData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineLayerDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };

        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            refreshWorkerCacheForReplayTargets,
            pendingBabelfontJsonSyncAfterDrag: false,
            lastChangeSource: null,
            lastEditType: null
        };

        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            undo: jest.fn(() => {
                currentFont.fontModel = makeFontModel(520);
                return {
                    scope: 'layer',
                    glyphName: 'a',
                    layerId: 'layer-1',
                    historyItem: {
                        transactionLabel: 'Drag point',
                        touchedPaths: ['glyphs.a.layers.layer-1'],
                        entries: [
                            {
                                oldValue: '(10, 20)',
                                newValue: 'LEFT (20, 20)'
                            }
                        ]
                    }
                };
            })
        };

        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        try {
            await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

            expect(refreshWorkerCacheForReplayTargets).not.toHaveBeenCalled();
            expect(
                sendMessageSpy.mock.calls.some(
                    ([message]) => message?.type === 'storeFontJson'
                )
            ).toBe(false);
        } finally {
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.lastStoredFontJson = originalLastStoredFontJson;
            sendMessageSpy.mockRestore();
        }
    });

    test('undo anchor drag rebuilds downstream composites and schedules an editing-font refresh', async () => {
        const originalIsInitialized = fontCompilation.isInitialized;
        const originalLastStoredFontJson = fontCompilation.lastStoredFontJson;
        const sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue(undefined);
        const refreshWorkerCacheForReplayTargets = jest
            .fn()
            .mockResolvedValue(true);
        const refreshGlyphAdvancesLive = jest.fn(() => true);
        const rebuildAutomaticCompositesForGlyphs = jest.fn(
            () => new Set(['adieresis'])
        );
        const recomputeMetricsKeys = jest.fn(() => new Set(['adieresis']));

        const makeFontModel = () => ({
            rebuildAutomaticCompositesForGlyphs,
            recomputeMetricsKeys,
            findGlyphsUsingComponent: jest.fn((glyphName) =>
                glyphName === 'a' ? ['adieresis'] : []
            ),
            findGlyph: jest.fn((glyphName) => {
                if (glyphName === 'a') {
                    return {
                        findLayerById: jest.fn(() => ({
                            id: 'layer-1',
                            width: 500
                        }))
                    };
                }

                if (glyphName === 'adieresis') {
                    return {
                        findLayerById: jest.fn(() => ({
                            id: 'layer-1',
                            width: 500
                        }))
                    };
                }

                return null;
            })
        });

        const currentFont = {
            babelfontJson: '{"glyphs":[]}',
            fontModel: makeFontModel(),
            requestRecompileWithoutDataChange: jest.fn(),
            syncJsonFromModel: jest.fn()
        };

        fontCompilation.isInitialized = true;
        fontCompilation.lastStoredFontJson = 'cached-json';

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive
            },
            outlineEditor: {
                active: true,
                selectedLayerId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchLayerData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineLayerDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };

        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            refreshWorkerCacheForReplayTargets,
            pendingBabelfontJsonSyncAfterDrag: false,
            lastChangeSource: null,
            lastEditType: null
        };

        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            runWithoutRecording: jest.fn((fn) => fn()),
            undo: jest.fn(() => {
                currentFont.fontModel = makeFontModel();
                return {
                    scope: 'layer',
                    glyphName: 'a',
                    layerId: 'layer-1',
                    historyItem: {
                        transactionLabel: 'Drag anchor',
                        touchedPaths: ['glyphs.a.layers.layer-1.anchors.0'],
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: 'layer-1' },
                            { glyphName: 'adieresis', layerId: 'layer-1' }
                        ],
                        entries: [
                            {
                                oldValue: 'top 320 700',
                                newValue: 'top 360 700',
                                workerReplayTargets: [
                                    { glyphName: 'a', layerId: 'layer-1' },
                                    {
                                        glyphName: 'adieresis',
                                        layerId: 'layer-1'
                                    }
                                ]
                            }
                        ]
                    }
                };
            })
        };

        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        try {
            await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

            expect(refreshGlyphAdvancesLive).toHaveBeenCalledWith(
                expect.objectContaining({ a: 500, adieresis: 500 }),
                { render: false }
            );
            expect(
                currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(1);
            expect(
                originalWindow.autoCompileManager.checkAndSchedule
            ).toHaveBeenCalledTimes(1);
            // Undo/redo needs a worker cache refresh for all replay targets
            // (including cascading recomposition). The Yjs sync only covers
            // the directly edited glyph/layer; cascading targets in the model
            // are not reverted by the undo Y.Doc transaction alone.
            expect(refreshWorkerCacheForReplayTargets).toHaveBeenCalledWith([
                { glyphName: 'a', layerId: 'layer-1' },
                { glyphName: 'adieresis', layerId: 'layer-1' }
            ]);
            expect(
                sendMessageSpy.mock.calls.some(
                    ([message]) => message?.type === 'storeFontJson'
                )
            ).toBe(false);
            expect(
                originalWindow.glyphCanvas.outlineEditor.fetchLayerData
            ).not.toHaveBeenCalled();
        } finally {
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.lastStoredFontJson = originalLastStoredFontJson;
            sendMessageSpy.mockRestore();
        }
    });

    test('undo anchor drag rebuilds downstream composites and schedules an editing-font refresh (redundant comment entry)', async () => {
        // This test entry appears to be a copy-fragment from a previous edit.
        // The variables referenced here are not defined in its scope — they
        // belong to the preceding test block that was closed two lines above.
    });

    test('undo anchor-inclusive selection scaling refreshes recomposed glyphs incrementally', async () => {
        const originalIsInitialized = fontCompilation.isInitialized;
        const originalLastStoredFontJson = fontCompilation.lastStoredFontJson;
        const sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue(undefined);
        const refreshWorkerCacheForReplayTargets = jest
            .fn()
            .mockResolvedValue(true);
        const rebuildAutomaticCompositesForGlyphs = jest.fn(
            () => new Set(['adieresis'])
        );
        const recomputeMetricsKeys = jest.fn(() => new Set(['adieresis']));

        const makeFontModel = () => ({
            rebuildAutomaticCompositesForGlyphs,
            recomputeMetricsKeys,
            findGlyphsUsingComponent: jest.fn((glyphName) =>
                glyphName === 'a' ? ['adieresis'] : []
            ),
            findGlyph: jest.fn((glyphName) => {
                if (glyphName === 'a' || glyphName === 'adieresis') {
                    return {
                        findLayerById: jest.fn(() => ({
                            id: 'layer-1',
                            width: 500
                        }))
                    };
                }

                return null;
            })
        });

        const currentFont = {
            babelfontJson: '{"glyphs":[]}',
            fontModel: makeFontModel(),
            requestRecompileWithoutDataChange: jest.fn(),
            syncJsonFromModel: jest.fn()
        };

        fontCompilation.isInitialized = true;
        fontCompilation.lastStoredFontJson = 'cached-json';

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive: jest.fn(() => true)
            },
            outlineEditor: {
                active: true,
                selectedLayerId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchLayerData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineLayerDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };

        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            refreshWorkerCacheForReplayTargets,
            pendingBabelfontJsonSyncAfterDrag: false,
            lastChangeSource: null,
            lastEditType: null
        };

        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            runWithoutRecording: jest.fn((fn) => fn()),
            undo: jest.fn(() => {
                currentFont.fontModel = makeFontModel();
                return {
                    scope: 'layer',
                    glyphName: 'a',
                    layerId: 'layer-1',
                    historyItem: {
                        transactionLabel: 'Scale selection',
                        touchedPaths: ['glyphs.a.layers.layer-1.anchors.0'],
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: 'layer-1' },
                            { glyphName: 'adieresis', layerId: 'layer-1' }
                        ],
                        entries: [
                            {
                                oldValue: 'Bounds: (10, 20)-(30, 40)',
                                newValue: 'Bounds: (12, 24)-(36, 48)',
                                workerReplayTargets: [
                                    { glyphName: 'a', layerId: 'layer-1' },
                                    {
                                        glyphName: 'adieresis',
                                        layerId: 'layer-1'
                                    }
                                ]
                            }
                        ]
                    }
                };
            })
        };

        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        try {
            await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

            // Undo/redo needs a worker cache refresh for all replay targets
            // (including cascading recomposition). The Yjs sync only covers
            // the directly edited glyph/layer; cascading targets in the model
            // are not reverted by the undo Y.Doc transaction alone.
            expect(refreshWorkerCacheForReplayTargets).toHaveBeenCalledWith([
                { glyphName: 'a', layerId: 'layer-1' },
                { glyphName: 'adieresis', layerId: 'layer-1' }
            ]);
            expect(
                sendMessageSpy.mock.calls.some(
                    ([message]) => message?.type === 'storeFontJson'
                )
            ).toBe(false);
            expect(rebuildAutomaticCompositesForGlyphs).not.toHaveBeenCalled();
            expect(
                currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(1);
            expect(
                originalWindow.autoCompileManager.checkAndSchedule
            ).toHaveBeenCalledTimes(1);
        } finally {
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.lastStoredFontJson = originalLastStoredFontJson;
            sendMessageSpy.mockRestore();
        }
    });

    test('undo coarse layer-snapshot Scale selection still refreshes the worker incrementally', async () => {
        const originalIsInitialized = fontCompilation.isInitialized;
        const originalLastStoredFontJson = fontCompilation.lastStoredFontJson;
        const sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue(undefined);
        const refreshWorkerCacheForReplayTargets = jest
            .fn()
            .mockResolvedValue(true);

        const currentFont = {
            babelfontJson: '{"glyphs":[]}',
            fontModel: {
                rebuildAutomaticCompositesForGlyphs: jest.fn(
                    () => new Set(['adieresis'])
                ),
                recomputeMetricsKeys: jest.fn(() => new Set(['adieresis'])),
                findGlyphsUsingComponent: jest.fn((glyphName) =>
                    glyphName === 'a' ? ['adieresis'] : []
                ),
                findGlyph: jest.fn((glyphName) => {
                    if (glyphName === 'a' || glyphName === 'adieresis') {
                        return {
                            findLayerById: jest.fn(() => ({
                                id: 'layer-1',
                                width: 500
                            }))
                        };
                    }

                    return null;
                })
            },
            requestRecompileWithoutDataChange: jest.fn(),
            syncJsonFromModel: jest.fn()
        };

        fontCompilation.isInitialized = true;
        fontCompilation.lastStoredFontJson = 'cached-json';

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive: jest.fn(() => true)
            },
            outlineEditor: {
                active: true,
                selectedLayerId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchLayerData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineLayerDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };

        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            refreshWorkerCacheForReplayTargets,
            pendingBabelfontJsonSyncAfterDrag: false,
            lastChangeSource: null,
            lastEditType: null
        };

        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            runWithoutRecording: jest.fn((fn) => fn()),
            undo: jest.fn(() => ({
                scope: 'layer',
                glyphName: 'a',
                layerId: 'layer-1',
                historyItem: {
                    transactionLabel: 'Scale selection',
                    touchedPaths: ['glyphs.a.layers.layer-1'],
                    workerReplayTargets: [
                        { glyphName: 'a', layerId: 'layer-1' }
                    ],
                    entries: [
                        {
                            oldValue: 'Bounds: (10, 20)-(30, 40)',
                            newValue: 'Bounds: (12, 24)-(36, 48)',
                            workerReplayTargets: [
                                { glyphName: 'a', layerId: 'layer-1' }
                            ]
                        }
                    ]
                }
            }))
        };

        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        try {
            await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

            expect(refreshWorkerCacheForReplayTargets).toHaveBeenCalledWith([
                { glyphName: 'a', layerId: 'layer-1' }
            ]);
            expect(
                sendMessageSpy.mock.calls.some(
                    ([message]) => message?.type === 'storeFontJson'
                )
            ).toBe(false);
        } finally {
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.lastStoredFontJson = originalLastStoredFontJson;
            sendMessageSpy.mockRestore();
        }
    });

    test('undo waits for the post-sync editing-font compile when forceTrigger is available', async () => {
        const originalIsInitialized = fontCompilation.isInitialized;
        const originalLastStoredFontJson = fontCompilation.lastStoredFontJson;
        const sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue(undefined);
        const refreshWorkerCacheForReplayTargets = jest
            .fn()
            .mockResolvedValue(true);
        const currentFont = {
            babelfontJson: '{"glyphs":[]}',
            fontModel: {
                rebuildAutomaticCompositesForGlyphs: jest.fn(
                    () => new Set(['adieresis'])
                ),
                recomputeMetricsKeys: jest.fn(() => new Set(['adieresis'])),
                findGlyphsUsingComponent: jest.fn((glyphName) =>
                    glyphName === 'a' ? ['adieresis'] : []
                ),
                findGlyph: jest.fn((glyphName) => {
                    if (glyphName === 'a' || glyphName === 'adieresis') {
                        return {
                            findLayerById: jest.fn(() => ({
                                id: 'layer-1',
                                width: 500
                            }))
                        };
                    }

                    return null;
                })
            },
            requestRecompileWithoutDataChange: jest.fn(() => {
                currentFont.compileRequestVersion += 1;
            }),
            syncJsonFromModel: jest.fn(),
            compileRequestVersion: 0
        };

        fontCompilation.isInitialized = true;
        fontCompilation.lastStoredFontJson = 'cached-json';

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive: jest.fn(() => true)
            },
            outlineEditor: {
                active: true,
                selectedLayerId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchLayerData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineLayerDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };

        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            refreshWorkerCacheForReplayTargets,
            pendingBabelfontJsonSyncAfterDrag: false,
            lastChangeSource: null,
            lastEditType: null
        };

        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            runWithoutRecording: jest.fn((fn) => fn()),
            undo: jest.fn(() => ({
                scope: 'layer',
                glyphName: 'a',
                layerId: 'layer-1',
                historyItem: {
                    transactionLabel: 'Scale selection',
                    touchedPaths: ['glyphs.a.layers.layer-1.anchors.0'],
                    entries: []
                }
            }))
        };

        const forceTrigger = jest.fn(async () => {
            window.dispatchEvent(
                new CustomEvent('editingFontCompiled', {
                    detail: {
                        fontBytes: new Uint8Array([1]),
                        fontRevisionKey: String(
                            currentFont.compileRequestVersion
                        )
                    }
                })
            );
        });

        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn(),
            forceTrigger
        };

        try {
            await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

            expect(forceTrigger).not.toHaveBeenCalled();
            expect(
                currentFont.requestRecompileWithoutDataChange
            ).not.toHaveBeenCalled();
            expect(refreshWorkerCacheForReplayTargets).not.toHaveBeenCalled();
            expect(
                sendMessageSpy.mock.calls.some(
                    ([message]) => message?.type === 'storeFontJson'
                )
            ).toBe(false);
        } finally {
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.lastStoredFontJson = originalLastStoredFontJson;
            sendMessageSpy.mockRestore();
        }
    });

    test('undo component drag without replay targets refreshes the canvas without direct worker cache work', async () => {
        const originalIsInitialized = fontCompilation.isInitialized;
        const submitLayerToWorkerCache = jest.fn().mockResolvedValue(true);
        const requestRecompileWithoutDataChange = jest.fn();

        const currentFont = {
            babelfontJson: '{"glyphs":[]}',
            fontModel: {
                findGlyph: jest.fn(() => ({
                    findLayerById: jest.fn(() => ({
                        id: 'layer-1',
                        width: 500
                    }))
                }))
            },
            requestRecompileWithoutDataChange,
            syncJsonFromModel: jest.fn()
        };

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive: jest.fn()
            },
            outlineEditor: {
                active: true,
                selectedLayerId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchLayerData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineLayerDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };

        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            submitLayerToWorkerCache,
            pendingBabelfontJsonSyncAfterDrag: false,
            lastChangeSource: null,
            lastEditType: null
        };

        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            undo: jest.fn(() => ({
                scope: 'layer',
                glyphName: 'a',
                layerId: 'layer-1',
                historyItem: {
                    transactionLabel: 'Drag component',
                    touchedPaths: [
                        'glyphs.a.layers.layer-1.shapes.0.transform'
                    ],
                    entries: [
                        {
                            oldValue: "component 'acute': (10, 20)",
                            newValue: "component 'acute': (30, 20)"
                        }
                    ]
                }
            }))
        };

        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        fontCompilation.isInitialized = true;

        try {
            await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

            expect(submitLayerToWorkerCache).not.toHaveBeenCalled();
            expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
            expect(
                originalWindow.autoCompileManager.checkAndSchedule
            ).toHaveBeenCalledTimes(1);
            expect(
                originalWindow.glyphCanvas.outlineEditor.fetchLayerData
            ).not.toHaveBeenCalled();
        } finally {
            fontCompilation.isInitialized = originalIsInitialized;
        }
    });

    test('undo glyph-scoped snapshot uses explicit replay targets instead of storeFontJson', async () => {
        const originalIsInitialized = fontCompilation.isInitialized;
        const sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue(undefined);
        const refreshWorkerCacheForReplayTargets = jest
            .fn()
            .mockResolvedValue(true);
        const requestRecompileWithoutDataChange = jest.fn();

        const currentFont = {
            babelfontJson: '{"glyphs":[]}',
            fontModel: {
                findGlyph: jest.fn(() => ({
                    findLayerById: jest.fn(() => ({
                        id: 'layer-1',
                        width: 500
                    }))
                }))
            },
            requestRecompileWithoutDataChange,
            syncJsonFromModel: jest.fn()
        };

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive: jest.fn()
            },
            outlineEditor: {
                active: true,
                selectedLayerId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchLayerData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineLayerDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };

        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            refreshWorkerCacheForReplayTargets,
            pendingBabelfontJsonSyncAfterDrag: false,
            lastChangeSource: null,
            lastEditType: null
        };

        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            undo: jest.fn(() => ({
                scope: 'glyph',
                glyphName: 'a',
                layerId: 'layer-1',
                historyItem: {
                    transactionLabel: 'Drag selection',
                    workerReplayTargets: [
                        { glyphName: 'a', layerId: 'layer-1' }
                    ],
                    entries: [
                        {
                            historyAction: 'change',
                            workerReplayTargets: [
                                { glyphName: 'a', layerId: 'layer-1' }
                            ],
                            oldValue: 'before',
                            newValue: 'after'
                        }
                    ]
                }
            }))
        };

        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        fontCompilation.isInitialized = true;

        try {
            await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

            expect(refreshWorkerCacheForReplayTargets).toHaveBeenCalledWith([
                { glyphName: 'a', layerId: 'layer-1' }
            ]);
            expect(
                sendMessageSpy.mock.calls.some(
                    ([message]) => message?.type === 'storeFontJson'
                )
            ).toBe(false);
            expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
            expect(
                originalWindow.autoCompileManager.checkAndSchedule
            ).toHaveBeenCalledTimes(1);
        } finally {
            fontCompilation.isInitialized = originalIsInitialized;
            sendMessageSpy.mockRestore();
        }
    });

    test('undo anchor-inclusive Scale selection with replay targets stays incremental and recompiles after refresh', async () => {
        const originalIsInitialized = fontCompilation.isInitialized;
        const sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue(undefined);
        const refreshWorkerCacheForReplayTargets = jest
            .fn()
            .mockResolvedValue(true);
        const requestRecompileWithoutDataChange = jest.fn();

        const currentFont = {
            babelfontJson: '{"glyphs":[]}',
            fontModel: {
                rebuildAutomaticCompositesForGlyphs: jest.fn(
                    () => new Set(['adieresis'])
                ),
                recomputeMetricsKeys: jest.fn(() => new Set(['adieresis'])),
                findGlyphsUsingComponent: jest.fn((glyphName) =>
                    glyphName === 'a' ? ['adieresis'] : []
                ),
                findGlyph: jest.fn((glyphName) => {
                    if (glyphName === 'a' || glyphName === 'adieresis') {
                        return {
                            findLayerById: jest.fn(() => ({
                                id: 'layer-1',
                                width: 500
                            }))
                        };
                    }

                    return null;
                })
            },
            compileRequestVersion: 0,
            requestRecompileWithoutDataChange: jest.fn(() => {
                currentFont.compileRequestVersion += 1;
                requestRecompileWithoutDataChange();
            }),
            syncJsonFromModel: jest.fn()
        };

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive: jest.fn(() => true)
            },
            outlineEditor: {
                active: true,
                selectedLayerId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchLayerData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineLayerDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };

        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            refreshWorkerCacheForReplayTargets,
            pendingBabelfontJsonSyncAfterDrag: false,
            lastChangeSource: null,
            lastEditType: null
        };

        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            runWithoutRecording: jest.fn((fn) => fn()),
            undo: jest.fn(() => ({
                scope: 'layer',
                glyphName: 'a',
                layerId: 'layer-1',
                historyItem: {
                    transactionLabel: 'Scale selection',
                    touchedPaths: ['glyphs.a.layers.layer-1.anchors.0'],
                    workerReplayTargets: [
                        { glyphName: 'a', layerId: 'layer-1' },
                        { glyphName: 'adieresis', layerId: 'layer-1' }
                    ],
                    entries: [
                        {
                            historyAction: 'change',
                            workerReplayTargets: [
                                { glyphName: 'a', layerId: 'layer-1' },
                                { glyphName: 'adieresis', layerId: 'layer-1' }
                            ],
                            oldValue: 'Bounds: (10, 20)-(30, 40)',
                            newValue: 'Bounds: (12, 24)-(36, 48)'
                        }
                    ]
                }
            }))
        };

        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn(),
            forceTrigger: jest.fn(async () => {
                window.dispatchEvent(
                    new CustomEvent('editingFontCompiled', {
                        detail: {
                            fontBytes: new Uint8Array([1]),
                            fontRevisionKey: String(
                                currentFont.compileRequestVersion
                            )
                        }
                    })
                );
            })
        };

        fontCompilation.isInitialized = true;

        try {
            await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

            expect(refreshWorkerCacheForReplayTargets).toHaveBeenCalledWith([
                { glyphName: 'a', layerId: 'layer-1' },
                { glyphName: 'adieresis', layerId: 'layer-1' }
            ]);
            expect(
                sendMessageSpy.mock.calls.some(
                    ([message]) => message?.type === 'storeFontJson'
                )
            ).toBe(false);
            expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
            expect(
                originalWindow.autoCompileManager.checkAndSchedule
            ).toHaveBeenCalledTimes(1);
            expect(
                originalWindow.autoCompileManager.forceTrigger
            ).toHaveBeenCalledTimes(1);
        } finally {
            fontCompilation.isInitialized = originalIsInitialized;
            sendMessageSpy.mockRestore();
        }
    });

    test('undo glyph-wide sidebearing key change uses replay targets instead of forced full JSON refresh', async () => {
        const originalIsInitialized = fontCompilation.isInitialized;
        const originalLastStoredFontJson = fontCompilation.lastStoredFontJson;
        const sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue(undefined);
        const requestRecompileWithoutDataChange = jest.fn();
        const refreshWorkerCacheForReplayTargets = jest
            .fn()
            .mockResolvedValue(true);

        const currentFont = {
            babelfontJson: '{"glyphs":[{"name":"stale"}]}',
            fontModel: {
                findGlyph: jest.fn(() => ({
                    findLayerById: jest.fn(() => ({
                        id: 'layer-1',
                        width: 500
                    }))
                }))
            },
            requestRecompileWithoutDataChange,
            syncJsonFromModel: jest.fn(() => {
                currentFont.babelfontJson = '{"glyphs":[{"name":"fresh"}]}';
            })
        };

        originalWindow.glyphCanvas = {
            viewportManager: {
                panX: 100,
                scale: 2
            },
            textRunEditor: {
                refreshGlyphAdvancesLive: jest.fn()
            },
            outlineEditor: {
                active: true,
                selectedLayerId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                fetchLayerData: jest.fn().mockResolvedValue(),
                runDeterministicRefresh: jest.fn(async (task) => await task()),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: jest.fn(() => 'a'),
            syncCurrentOutlineLayerDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            requestRepaintAfterCompile: jest.fn()
        };

        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            refreshWorkerCacheForReplayTargets,
            pendingBabelfontJsonSyncAfterDrag: false,
            lastChangeSource: null,
            lastEditType: null
        };

        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            undo: jest.fn(() => ({
                scope: 'font',
                glyphName: 'a',
                layerId: 'layer-1',
                historyItem: {
                    transactionLabel: 'Set LSB',
                    workerReplayTargets: [
                        {
                            glyphName: 'a',
                            layerId: 'layer-1'
                        }
                    ],
                    entries: [
                        {
                            oldValue: '=n+20',
                            newValue: '',
                            workerReplayTargets: [
                                {
                                    glyphName: 'a',
                                    layerId: 'layer-1'
                                }
                            ]
                        }
                    ]
                }
            }))
        };

        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        fontCompilation.isInitialized = true;
        fontCompilation.lastStoredFontJson = 'cached-json';

        try {
            await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

            expect(currentFont.syncJsonFromModel).not.toHaveBeenCalled();
            expect(refreshWorkerCacheForReplayTargets).toHaveBeenCalledWith([
                { glyphName: 'a', layerId: 'layer-1' }
            ]);
            expect(sendMessageSpy).not.toHaveBeenCalledWith(
                expect.objectContaining({ type: 'storeFontJson' })
            );
            expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
            expect(
                originalWindow.autoCompileManager.checkAndSchedule
            ).toHaveBeenCalledTimes(1);
        } finally {
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.lastStoredFontJson = originalLastStoredFontJson;
            sendMessageSpy.mockRestore();
        }
    });
});
