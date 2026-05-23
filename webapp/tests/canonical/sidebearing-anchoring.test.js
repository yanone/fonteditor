const { runBridgeUndoRedo } = require('../../js/change-bridge-init');
const fontManager = require('../../js/font-manager').default;

function snapshotAdvanceEdges(target) {
    return {
        left: target.viewportManager.panX,
        right:
            target.viewportManager.panX +
            target.outlineEditor.layerData.width * target.viewportManager.scale
    };
}

function expectAnchoredOppositeAdvanceEdge(target, beforeEdges, editedSide) {
    const afterEdges = snapshotAdvanceEdges(target);

    if (editedSide === 'left') {
        expect(afterEdges.right).toBeCloseTo(beforeEdges.right, 5);
        return;
    }

    expect(afterEdges.left).toBeCloseTo(beforeEdges.left, 5);
}

function setupUnkeyedCanvas(canvas) {
    canvas.outlineEditor.active = true;
    canvas.outlineEditor.currentGlyphName = 'a';
    canvas.outlineEditor.selectedLayerId = 'layer-1';
    canvas.outlineEditor.glyphStack = 'a@layer-1';
    canvas.outlineEditor.parseGlyphStack = jest.fn(() => [{ glyphName: 'a' }]);
    canvas.getCurrentGlyphName = jest.fn(() => 'a');
    canvas.viewportManager.scale = 2;
    canvas.viewportManager.panX = 100;
    canvas.outlineEditor.layerData = {
        id: 'layer-1',
        width: 500,
        shapes: [
            {
                nodes: [
                    { x: 100, y: 0, nodetype: 'Line', smooth: false },
                    { x: 400, y: 0, nodetype: 'Line', smooth: false },
                    { x: 400, y: 700, nodetype: 'Line', smooth: false },
                    { x: 100, y: 700, nodetype: 'Line', smooth: false }
                ],
                closed: true
            }
        ],
        anchors: [],
        guides: []
    };
    canvas.outlineEditor.saveLayerData = jest.fn();
    canvas.outlineEditor._syncCurrentGlyphToYDoc = jest.fn();
    canvas.outlineEditor.performHitDetection = jest.fn();
    canvas.updatePropertyPanel = jest.fn();
    canvas.render = jest.fn();
    canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn(() => true);
}

describe('Sidebearing anchoring matrix', () => {
    let canvas;
    let currentFontSpy;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(null);
        window.changeBridge = null;
        setupUnkeyedCanvas(canvas);
    });

    afterEach(() => {
        currentFontSpy.mockRestore();
        canvas.destroy();
    });

    test.each([
        {
            label: 'mouse LSB handle drag anchors the right edge',
            side: 'left',
            deltaX: 20
        },
        {
            label: 'mouse RSB handle drag anchors the left edge',
            side: 'right',
            deltaX: 20
        }
    ])('$label', ({ side, deltaX }) => {
        const beforeEdges = snapshotAdvanceEdges(canvas);

        canvas.outlineEditor.isDraggingSidebearing = true;
        canvas.outlineEditor.selectedSidebearingHandle = { side };
        canvas.outlineEditor._updateDraggedSidebearing(deltaX);

        expectAnchoredOppositeAdvanceEdge(canvas, beforeEdges, side);
    });

    test.each([
        {
            label: 'keyboard LSB handle nudge anchors the right edge',
            side: 'left'
        },
        {
            label: 'keyboard RSB handle nudge anchors the left edge',
            side: 'right'
        }
    ])('$label', ({ side }) => {
        const beforeEdges = snapshotAdvanceEdges(canvas);

        canvas.outlineEditor.selectedSidebearingHandle = { side };
        canvas.outlineEditor.onKeyDown({
            key: 'ArrowRight',
            shiftKey: false,
            metaKey: false,
            ctrlKey: false,
            preventDefault: jest.fn()
        });

        expectAnchoredOppositeAdvanceEdge(canvas, beforeEdges, side);
    });

    test.each([
        {
            label: 'property panel LSB numeric edit anchors the right edge',
            side: 'left',
            value: '80'
        },
        {
            label: 'property panel RSB numeric edit anchors the left edge',
            side: 'right',
            value: '120'
        }
    ])('$label', async ({ side, value }) => {
        const beforeEdges = snapshotAdvanceEdges(canvas);

        await canvas.commitPropertyPanelValue(side, value);

        expectAnchoredOppositeAdvanceEdge(canvas, beforeEdges, side);
    });
});

describe('Sidebearing undo visual anchoring', () => {
    const originalWindow = global.window;
    const originalGlyphCanvas = originalWindow.glyphCanvas;
    const originalFontManager = originalWindow.fontManager;
    const originalPatchSyncEngine = originalWindow.patchSyncEngine;
    const originalChangeBridge = originalWindow.changeBridge;
    const originalAutoCompileManager = originalWindow.autoCompileManager;

    afterEach(() => {
        originalWindow.glyphCanvas = originalGlyphCanvas;
        originalWindow.fontManager = originalFontManager;
        originalWindow.patchSyncEngine = originalPatchSyncEngine;
        originalWindow.changeBridge = originalChangeBridge;
        originalWindow.autoCompileManager = originalAutoCompileManager;
        jest.clearAllMocks();
    });

    function installUndoHarness(historyItem, previousWidth, nextWidth) {
        const refreshGlyphAdvancesLive = jest.fn(() => true);
        const glyphCanvas = {
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

        const currentFont = {
            fontModel: {
                findGlyph: jest.fn(() => ({
                    findLayerById: jest.fn(() => ({ width: previousWidth }))
                }))
            },
            requestRecompileWithoutDataChange: jest.fn()
        };

        originalWindow.glyphCanvas = glyphCanvas;
        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            lastChangeSource: null,
            lastEditType: null,
            setEditingCompileContext(changeSource, editType) {
                this.lastChangeSource = changeSource;
                this.lastEditType = editType;
            },
            clearEditingCompileContext() {
                this.lastChangeSource = null;
                this.lastEditType = null;
            }
        };
        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            undo: jest.fn(() => {
                currentFont.fontModel = {
                    findGlyph: jest.fn(() => ({
                        findLayerById: jest.fn(() => ({ width: nextWidth }))
                    }))
                };

                return {
                    scope: 'layer',
                    glyphName: 'a',
                    layerId: 'layer-1',
                    historyItem
                };
            })
        };
        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        return { glyphCanvas, refreshGlyphAdvancesLive };
    }

    function snapshotUndoEdges(glyphCanvas, width) {
        return {
            left: glyphCanvas.viewportManager.panX,
            right:
                glyphCanvas.viewportManager.panX +
                width * glyphCanvas.viewportManager.scale
        };
    }

    test.each([
        {
            label: 'undo Set LSB keeps the right edge stationary',
            historyItem: {
                transactionLabel: 'Set LSB',
                entries: [{ oldValue: 'LEFT 100', newValue: 'LEFT 80' }]
            },
            side: 'left'
        },
        {
            label: 'undo Set RSB keeps the left edge stationary',
            historyItem: {
                transactionLabel: 'Set RSB',
                entries: [{ oldValue: 'RIGHT 100', newValue: 'RIGHT 120' }]
            },
            side: 'right'
        }
    ])('$label', async ({ historyItem, side }) => {
        const previousWidth = 500;
        const nextWidth = 520;
        const { glyphCanvas, refreshGlyphAdvancesLive } = installUndoHarness(
            historyItem,
            previousWidth,
            nextWidth
        );
        const beforeEdges = snapshotUndoEdges(glyphCanvas, previousWidth);

        await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

        const afterEdges = snapshotUndoEdges(glyphCanvas, nextWidth);
        if (side === 'left') {
            expect(afterEdges.right).toBeCloseTo(beforeEdges.right, 5);
        } else {
            expect(afterEdges.left).toBeCloseTo(beforeEdges.left, 5);
        }
        expect(refreshGlyphAdvancesLive).toHaveBeenCalledWith(
            { a: nextWidth },
            { render: false }
        );
    });

    test.each([
        {
            label: 'undo drag metadata with visualAnchorSide left keeps the right edge stationary',
            side: 'left'
        },
        {
            label: 'undo drag metadata with visualAnchorSide right keeps the left edge stationary',
            side: 'right'
        }
    ])('$label', async ({ side }) => {
        const previousWidth = 500;
        const nextWidth = 520;
        const historyItem = {
            transactionLabel: 'Drag point',
            entries: [
                {
                    oldValue: '(10, 20)',
                    newValue: '(20, 20)',
                    visualAnchorSide: side
                }
            ]
        };
        const { glyphCanvas } = installUndoHarness(
            historyItem,
            previousWidth,
            nextWidth
        );
        const beforeEdges = snapshotUndoEdges(glyphCanvas, previousWidth);

        await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

        const afterEdges = snapshotUndoEdges(glyphCanvas, nextWidth);
        if (side === 'left') {
            expect(afterEdges.right).toBeCloseTo(beforeEdges.right, 5);
        } else {
            expect(afterEdges.left).toBeCloseTo(beforeEdges.left, 5);
        }
    });

    // Regression guard: a 'Set sidebearing' edit that cascades across many
    // metrics-key dependents resolves to a font-scoped undo, so the bridge's
    // appliedChange.glyphName and appliedChange.layerId are null. Visual
    // anchoring must still pan the canvas using the active edited glyph/layer
    // passed into runBridgeUndoRedo so the active glyph's opposite edge stays
    // stationary on screen during undo and redo.
    function installFontScopedUndoHarness(
        historyItem,
        previousWidth,
        nextWidth
    ) {
        const refreshGlyphAdvancesLive = jest.fn(() => true);
        const glyphCanvas = {
            viewportManager: { panX: 100, scale: 2 },
            textRunEditor: { refreshGlyphAdvancesLive },
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

        let currentWidth = previousWidth;
        const currentFont = {
            fontModel: {
                findGlyph: jest.fn(() => ({
                    findLayerById: jest.fn(() => ({ width: currentWidth }))
                }))
            },
            requestRecompileWithoutDataChange: jest.fn()
        };

        originalWindow.glyphCanvas = glyphCanvas;
        originalWindow.fontManager = {
            currentFont,
            awaitWorkerCacheUpdate: jest.fn().mockResolvedValue(),
            lastChangeSource: null,
            lastEditType: null,
            setEditingCompileContext(changeSource, editType) {
                this.lastChangeSource = changeSource;
                this.lastEditType = editType;
            },
            clearEditingCompileContext() {
                this.lastChangeSource = null;
                this.lastEditType = null;
            }
        };
        originalWindow.patchSyncEngine = originalWindow.changeBridge = {
            undo: jest.fn(() => {
                currentWidth = nextWidth;
                // Font-scoped: appliedChange has no glyphName/layerId.
                return {
                    scope: 'font',
                    glyphName: null,
                    layerId: null,
                    historyItem
                };
            }),
            redo: jest.fn(() => {
                currentWidth = nextWidth;
                return {
                    scope: 'font',
                    glyphName: null,
                    layerId: null,
                    historyItem
                };
            })
        };
        originalWindow.autoCompileManager = { checkAndSchedule: jest.fn() };

        return { glyphCanvas, refreshGlyphAdvancesLive };
    }

    test.each([
        {
            label: 'font-scoped undo of "Set sidebearing" left keeps the active glyph right edge stationary',
            side: 'left'
        },
        {
            label: 'font-scoped undo of "Set sidebearing" right keeps the active glyph left edge stationary',
            side: 'right'
        }
    ])('$label', async ({ side }) => {
        const previousWidth = 670;
        const nextWidth = 620; // undo shrinks width back
        const historyItem = {
            transactionLabel: 'Set sidebearing',
            entries: Array.from({ length: 5 }, (_, i) => ({
                historyAction: 'change',
                oldValue: { width: previousWidth },
                newValue: { width: nextWidth },
                visualAnchorSide: side,
                path: `glyphs.glyph${i}.layers.layer-1`
            }))
        };
        const { glyphCanvas } = installFontScopedUndoHarness(
            historyItem,
            previousWidth,
            nextWidth
        );
        const beforeEdges = snapshotUndoEdges(glyphCanvas, previousWidth);

        await runBridgeUndoRedo('undo', 'a', 'a', 'layer-1', null);

        const afterEdges = snapshotUndoEdges(glyphCanvas, nextWidth);
        if (side === 'left') {
            expect(afterEdges.right).toBeCloseTo(beforeEdges.right, 5);
        } else {
            expect(afterEdges.left).toBeCloseTo(beforeEdges.left, 5);
        }
    });

    test.each([
        {
            label: 'font-scoped redo of "Set sidebearing" left keeps the active glyph right edge stationary',
            side: 'left'
        },
        {
            label: 'font-scoped redo of "Set sidebearing" right keeps the active glyph left edge stationary',
            side: 'right'
        }
    ])('$label', async ({ side }) => {
        const previousWidth = 620;
        const nextWidth = 670; // redo grows width back
        const historyItem = {
            transactionLabel: 'Set sidebearing',
            entries: [
                {
                    historyAction: 'change',
                    oldValue: { width: previousWidth },
                    newValue: { width: nextWidth },
                    visualAnchorSide: side,
                    path: 'glyphs.a.layers.layer-1'
                }
            ]
        };
        const { glyphCanvas } = installFontScopedUndoHarness(
            historyItem,
            previousWidth,
            nextWidth
        );
        const beforeEdges = snapshotUndoEdges(glyphCanvas, previousWidth);

        await runBridgeUndoRedo('redo', 'a', 'a', 'layer-1', null);

        const afterEdges = snapshotUndoEdges(glyphCanvas, nextWidth);
        if (side === 'left') {
            expect(afterEdges.right).toBeCloseTo(beforeEdges.right, 5);
        } else {
            expect(afterEdges.left).toBeCloseTo(beforeEdges.left, 5);
        }
    });
});
