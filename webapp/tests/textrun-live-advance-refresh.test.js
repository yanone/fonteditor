const { TextRunEditor } = require('../js/glyph-canvas/textrun');
const { runBridgeUndoRedo } = require('../js/change-bridge-init');
const { applyLiveSidebearingVisualSync } = require('../js/sidebearing-utils');

describe('TextRunEditor live advance refresh', () => {
    let editor;

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
    const originalChangeBridge = originalWindow.changeBridge;
    const originalAutoCompileManager = originalWindow.autoCompileManager;

    afterEach(() => {
        originalWindow.glyphCanvas = originalGlyphCanvas;
        originalWindow.fontManager = originalFontManager;
        originalWindow.changeBridge = originalChangeBridge;
        originalWindow.autoCompileManager = originalAutoCompileManager;
        jest.clearAllMocks();
    });

    test('undoing a left sidebearing change keeps the glyph stationary and refreshes advances before repaint', async () => {
        const requestRepaintAfterCompile = jest.fn();
        const refreshGlyphAdvancesLive = jest.fn();
        const fetchLayerData = jest.fn().mockResolvedValue();
        const runDeterministicRefresh = jest.fn(async (task) => await task());

        const makeFontModel = (width) => ({
            findGlyph: jest.fn(() => ({
                findLayerById: jest.fn(() => ({ width }))
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
                runDeterministicRefresh
            },
            requestRepaintAfterCompile
        };
        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            lastChangeSource: null,
            lastEditType: null
        };
        originalWindow.changeBridge = {
            undo: jest.fn(() => {
                currentFont.fontModel = makeFontModel(520);
                return {
                    scope: 'layer',
                    glyphName: 'a',
                    layerId: 'layer-1',
                    historyItem: {
                        transactionLabel: 'Set sidebearing',
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

        expect(fetchLayerData).toHaveBeenCalledWith(true, 'a');
        expect(refreshGlyphAdvancesLive).toHaveBeenCalledWith(
            { a: 520 },
            { render: false }
        );
        expect(originalWindow.glyphCanvas.viewportManager.panX).toBe(60);
        expect(requestRepaintAfterCompile).toHaveBeenCalledTimes(1);
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
        originalWindow.changeBridge = {
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
        originalWindow.changeBridge = {
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
            lastEditType: null
        };

        originalWindow.changeBridge = {
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

        expect(recomputeMetricsKeys).toHaveBeenCalled();
        expect(
            refreshGlyphAdvancesLive.mock.calls.some(
                (call) =>
                    call?.[0]?.a === 520 &&
                    call?.[0]?.n === 600 &&
                    call?.[1]?.render === false
            )
        ).toBe(true);
    });
});
