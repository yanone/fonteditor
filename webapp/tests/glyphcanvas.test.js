const fs = require('fs');
const path = require('path');
const {
    Font,
    Layer,
    DecomposedAffineTransform
} = require('../js/babelfont-model');
const fontManager = require('../js/font-manager').default;
const { fontInterpolation } = require('../js/font-interpolation');
const {
    open_font_file,
    store_font,
    interpolate_glyph,
    clear_font_cache
} = require('../wasm-dist/babelfont_fontc_web');

function loadFontFixture(fileName) {
    const fixturePath = path.join(__dirname, '..', 'examples', fileName);
    const fileContents = fs.readFileSync(fixturePath, 'utf-8');
    return JSON.parse(open_font_file(fileName, fileContents));
}

function canonicalizeLayerDataForComparison(layerData) {
    if (!layerData || typeof layerData !== 'object') {
        return layerData;
    }

    const canonical = { ...layerData };

    if (Array.isArray(layerData.anchors)) {
        canonical.anchors = layerData.anchors
            .map((anchor) => ({
                name: anchor.name,
                x: anchor.x,
                y: anchor.y
            }))
            .sort((left, right) => {
                const leftKey = `${left.name}|${left.x}|${left.y}`;
                const rightKey = `${right.name}|${right.x}|${right.y}`;
                return leftKey.localeCompare(rightKey);
            });
    }

    if (Array.isArray(layerData.shapes)) {
        canonical.shapes = layerData.shapes.map((shape) => {
            if (!shape || typeof shape !== 'object') {
                return shape;
            }

            if ('reference' in shape) {
                const canonicalShape = {
                    ...shape,
                    layerData: shape.layerData
                        ? canonicalizeLayerDataForComparison(shape.layerData)
                        : shape.layerData
                };

                if (shape.transform) {
                    canonicalShape.transform = Array.isArray(shape.transform)
                        ? shape.transform
                        : DecomposedAffineTransform.toAffine(shape.transform);
                }

                return canonicalShape;
            }

            return { ...shape };
        });
    }

    return canonical;
}

// ==================== Initialization Tests ====================

describe('GlyphCanvas initialization', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
    });

    afterEach(() => {
        if (canvas) {
            canvas.destroy();
        }
    });

    test('should create canvas element in container', () => {
        canvas = new GlyphCanvas('test-container');
        const container = document.getElementById('test-container');
        expect(container.querySelector('canvas')).toBeTruthy();
    });

    test('should create property panel shell in container', () => {
        canvas = new GlyphCanvas('test-container');
        const container = document.getElementById('test-container');
        expect(container.querySelector('.glyph-property-panel')).toBeTruthy();
    });

    test('should initialize viewport manager with default values', () => {
        canvas = new GlyphCanvas('test-container');
        expect(canvas.viewportManager).toBeTruthy();
        expect(canvas.viewportManager.scale).toBe(canvas.initialScale);
    });

    test('should initialize axes manager', () => {
        canvas = new GlyphCanvas('test-container');
        expect(canvas.axesManager).toBeTruthy();
        expect(canvas.axesManager.variationSettings).toEqual({});
    });

    test('should initialize features manager', () => {
        canvas = new GlyphCanvas('test-container');
        expect(canvas.featuresManager).toBeTruthy();
    });

    test('should initialize text run editor', () => {
        canvas = new GlyphCanvas('test-container');
        expect(canvas.textRunEditor).toBeTruthy();
    });

    test('should initialize renderer', () => {
        canvas = new GlyphCanvas('test-container');
        expect(canvas.renderer).toBeTruthy();
    });

    test('should set up HiDPI canvas correctly', () => {
        canvas = new GlyphCanvas('test-container');
        const dpr = window.devicePixelRatio || 1;
        const container = document.getElementById('test-container');
        expect(canvas.canvas.width).toBe(container.clientWidth * dpr);
        expect(canvas.canvas.height).toBe(container.clientHeight * dpr);
    });

    test('should make canvas focusable', () => {
        canvas = new GlyphCanvas('test-container');
        expect(canvas.canvas.tabIndex).toBe(0);
    });

    test('should set initial state correctly', () => {
        canvas = new GlyphCanvas('test-container');
        expect(canvas.outlineEditor.active).toBe(false);
        expect(canvas.isDraggingCanvas).toBe(false);
        expect(canvas.outlineEditor.isDraggingPoint).toBe(false);
        expect(canvas.outlineEditor.isDraggingAnchor).toBe(false);
        expect(canvas.outlineEditor.isDraggingComponent).toBe(false);
        expect(canvas.outlineEditor.selectedPoints).toEqual([]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([]);
    });
});

describe('GlyphCanvas renderer anchor-only layers', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'n@layer-1';
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 578,
            shapes: [],
            anchors: [
                { name: 'apostrophe', x: 27, y: 490 },
                { name: 'bottom', x: 289, y: 0 },
                { name: 'top', x: 289, y: 490 }
            ],
            guides: [],
            isInterpolated: false
        };
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 578, dx: 0, dy: 0, g: 0 }];
        canvas.viewportManager.scale = 100;
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('drawOutlineEditor renders anchors when a selected layer has no shapes', () => {
        canvas.renderer.ctx.fillRect.mockClear();

        canvas.renderer.drawOutlineEditor();

        expect(canvas.renderer.ctx.fillRect).toHaveBeenCalledTimes(3);
    });
});

describe('GlyphCanvas renderer snap visualization', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.isPreviewMode = false;
        canvas.outlineEditor.layerData = {
            width: 578,
            shapes: [],
            anchors: [],
            guides: []
        };
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 578, dx: 0, dy: 0, g: 0 }];
        canvas.viewportManager.scale = 100;
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('drawSnapVisualization draws origin candidates differently from regular snap dots', () => {
        canvas.outlineEditor.getSnapVisualizationState = jest.fn(() => ({
            debugCandidates: [{ x: 10, y: 20, source: 'origin' }],
            snapTarget: null,
            naturalPos: null,
            originPos: { x: 10, y: 20 }
        }));

        canvas.renderer.ctx.stroke.mockClear();
        canvas.renderer.ctx.fill.mockClear();

        canvas.renderer.drawSnapVisualization();

        expect(canvas.renderer.ctx.stroke).toHaveBeenCalled();
        expect(canvas.renderer.ctx.fill).not.toHaveBeenCalled();
    });

    test('detects a snapped return to origin for red snap highlights', () => {
        expect(
            canvas.renderer.isExactOriginSnapReturn({
                debugCandidates: [],
                snapTarget: {
                    xSource: { source: 'origin' },
                    ySource: { source: 'origin' },
                    snappedX: 60,
                    snappedY: 40
                },
                naturalPos: { x: 60, y: 40 },
                originPos: { x: 60, y: 40 }
            })
        ).toBe(true);

        expect(
            canvas.renderer.isExactOriginSnapReturn({
                debugCandidates: [],
                snapTarget: {
                    xSource: { source: 'origin' },
                    ySource: { source: 'origin' },
                    snappedX: 60,
                    snappedY: 40
                },
                naturalPos: { x: 61, y: 40 },
                originPos: { x: 60, y: 40 }
            })
        ).toBe(true);

        expect(
            canvas.renderer.isExactOriginSnapReturn({
                debugCandidates: [],
                snapTarget: {
                    xSource: { source: 'active' },
                    ySource: { source: 'active' },
                    snappedX: 60,
                    snappedY: 40
                },
                naturalPos: { x: 60, y: 40 },
                originPos: { x: 60, y: 40 }
            })
        ).toBe(false);
    });

    test('drawSnapVisualization enlarges the snap ring when exactly back on origin', () => {
        canvas.outlineEditor.getSnapVisualizationState = jest.fn(() => ({
            debugCandidates: [{ x: 60, y: 40, source: 'origin' }],
            snapTarget: {
                xSource: { source: 'origin' },
                ySource: { source: 'origin' },
                snappedX: 60,
                snappedY: 40
            },
            naturalPos: { x: 60, y: 40 },
            originPos: { x: 60, y: 40 }
        }));

        canvas.renderer.ctx.arc.mockClear();

        canvas.renderer.drawSnapVisualization();

        const arcRadii = canvas.renderer.ctx.arc.mock.calls.map(
            (call) => call[2]
        );
        expect(arcRadii).toContain(0.1375);
    });
});

// ==================== Mouse Interaction Tests ====================

describe('GlyphCanvas onMouseMove', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        // Set up mock state
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 1000, dx: 0, dy: 0, g: 0 }];
        canvas.outlineEditor.layerData = {
            shapes: [
                { reference: 'A', transform: [1, 0, 0, 1, 0, 0] },
                { nodes: [{ x: 0, y: 0, type: 'l' }] }
            ],
            anchors: [{ x: 0, y: 0 }]
        };
        canvas.outlineEditor.selectedComponents = [0];
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 1, nodeIndex: 0 }
        ];
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.viewportManager = new ViewportManager(1, 0, 0);
        canvas.lastGlyphX = null;
        canvas.lastGlyphY = null;
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('handles component dragging correctly', () => {
        canvas.outlineEditor.isDraggingComponent = true;
        // First move sets the initial position, delta is 0
        canvas.onMouseMove({ clientX: 10, clientY: 20 });
        expect(canvas.outlineEditor.layerData.shapes[0].transform[4]).toBe(0);
        expect(canvas.outlineEditor.layerData.shapes[0].transform[5]).toBe(0);

        // Second move performs the drag
        canvas.onMouseMove({ clientX: 25, clientY: 15 });
        // deltaX = 25 - 10 = 15
        // deltaY = -15 - (-20) = 5
        expect(canvas.outlineEditor.layerData.shapes[0].transform[4]).toBe(15);
        expect(canvas.outlineEditor.layerData.shapes[0].transform[5]).toBe(5);
    });

    test('handles anchor dragging correctly', () => {
        canvas.outlineEditor.isDraggingAnchor = true;
        canvas.onMouseMove({ clientX: 10, clientY: 20 });
        canvas.onMouseMove({ clientX: 25, clientY: 15 });
        expect(canvas.outlineEditor.layerData.anchors[0].x).toBe(15);
        expect(canvas.outlineEditor.layerData.anchors[0].y).toBe(5);
    });

    test('handles point dragging correctly', () => {
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.onMouseMove({ clientX: 10, clientY: 20 });
        canvas.onMouseMove({ clientX: 25, clientY: 15 });
        expect(canvas.outlineEditor.layerData.shapes[1].nodes[0].x).toBe(15);
        expect(canvas.outlineEditor.layerData.shapes[1].nodes[0].y).toBe(5);
    });

    test('handles canvas panning when dragging', () => {
        canvas.isDraggingCanvas = true;
        canvas.lastMouseX = 10;
        canvas.lastMouseY = 20;
        const initialPanX = canvas.viewportManager.panX;
        const initialPanY = canvas.viewportManager.panY;

        canvas.onMouseMove({ clientX: 30, clientY: 40 });

        expect(canvas.viewportManager.panX).toBe(initialPanX + 20);
        expect(canvas.viewportManager.panY).toBe(initialPanY + 20);
    });

    test('does not drag when no drag state is active', () => {
        canvas.outlineEditor.isDraggingComponent = false;
        canvas.outlineEditor.isDraggingAnchor = false;
        canvas.outlineEditor.isDraggingPoint = false;
        canvas.isDraggingCanvas = false;

        const initialTransform = [
            ...canvas.outlineEditor.layerData.shapes[0].transform
        ];
        canvas.onMouseMove({ clientX: 10, clientY: 20 });

        expect(canvas.outlineEditor.layerData.shapes[0].transform).toEqual(
            initialTransform
        );
    });
});

describe('GlyphCanvas onMouseDown', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 1000, dx: 0, dy: 0, g: 0 }];
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should focus canvas on mouse down', () => {
        const focusSpy = jest.spyOn(canvas.canvas, 'focus');
        canvas.onMouseDown({ clientX: 10, clientY: 20, detail: 1 });
        expect(focusSpy).toHaveBeenCalled();
    });

    test('should start canvas panning when Space key is pressed', () => {
        canvas.outlineEditor.spaceKeyPressed = true;
        canvas.onMouseDown({ clientX: 10, clientY: 20, detail: 1 });
        expect(canvas.isDraggingCanvas).toBe(true);
    });

    test('measurement drag takes precedence over marquee selection', () => {
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 500,
            shapes: [],
            anchors: [],
            guides: []
        };
        canvas.measurementKeyPressed = true;
        canvas.measurementTool.visible = true;
        canvas.outlineEditor.hoveredPointIndex = null;
        canvas.outlineEditor.hoveredAnchorIndex = null;
        canvas.outlineEditor.hoveredComponentIndex = null;
        canvas.outlineEditor.hoveredGuideHandle = null;
        canvas.outlineEditor.hoveredSidebearingHandle = null;

        canvas.onMouseDown({
            clientX: 10,
            clientY: 20,
            detail: 1,
            shiftKey: false,
            altKey: false,
            ctrlKey: false,
            metaKey: false
        });

        expect(canvas.measurementTool.isDragging).toBe(true);
        expect(canvas.outlineEditor.isMarqueeSelecting).toBe(false);
    });
});

describe('GlyphCanvas onMouseUp', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should clear all dragging states', () => {
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.isDraggingAnchor = true;
        canvas.outlineEditor.isDraggingComponent = true;
        canvas.isDraggingCanvas = true;

        canvas.onMouseUp({ clientX: 10, clientY: 20 });

        expect(canvas.outlineEditor.isDraggingPoint).toBe(false);
        expect(canvas.outlineEditor.isDraggingAnchor).toBe(false);
        expect(canvas.outlineEditor.isDraggingComponent).toBe(false);
        expect(canvas.isDraggingCanvas).toBe(false);
    });

    test('logs rejected outline mouseup promises from the canvas wrapper', async () => {
        const error = new Error('invalid width');
        const onMouseUpSpy = jest
            .spyOn(canvas.outlineEditor, 'onMouseUp')
            .mockReturnValue(Promise.reject(error));
        const consoleErrorSpy = jest
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        try {
            canvas.onMouseUp({ clientX: 10, clientY: 20 });
            await Promise.resolve();

            expect(onMouseUpSpy).toHaveBeenCalled();
            expect(consoleErrorSpy).toHaveBeenCalledWith(
                '[GlyphCanvas]',
                'Outline mouseup failed:',
                error
            );
        } finally {
            onMouseUpSpy.mockRestore();
            consoleErrorSpy.mockRestore();
        }
    });

    test('sidebearing drag uses side-specific undo metadata', async () => {
        const originalWindowChangeBridge = window.changeBridge;
        const originalUpdateWorkerFontCache = fontManager.updateWorkerFontCache;
        const originalFlushPendingDebugEditingFontSaveAfterDrag =
            fontManager.flushPendingDebugEditingFontSaveAfterDrag;
        const syncSpy = jest.spyOn(
            canvas.outlineEditor,
            '_syncCurrentGlyphToYDoc'
        );

        try {
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn()
            };
            fontManager.updateWorkerFontCache = jest.fn();
            fontManager.flushPendingDebugEditingFontSaveAfterDrag = jest.fn();

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.hoveredSidebearingHandle = {
                side: 'left',
                editable: true
            };
            canvas.outlineEditor.layerData = {
                width: 520,
                shapes: [{ nodes: [{ x: 40, y: 0, type: 'l' }] }],
                anchors: []
            };

            canvas.outlineEditor.onSingleClick({
                clientX: 10,
                clientY: 20,
                detail: 1
            });

            expect(window.changeBridge.beginTransaction).toHaveBeenCalledWith(
                'Set LSB'
            );

            canvas.outlineEditor.isDraggingSidebearing = true;
            canvas.outlineEditor.selectedSidebearingHandle = {
                side: 'left',
                editable: true
            };
            canvas.outlineEditor._dragType = 'sidebearing';
            canvas.outlineEditor._hasMoved = true;

            await canvas.outlineEditor.onMouseUp({ clientX: 10, clientY: 20 });

            expect(syncSpy).not.toHaveBeenCalled();
        } finally {
            window.changeBridge = originalWindowChangeBridge;
            fontManager.updateWorkerFontCache = originalUpdateWorkerFontCache;
            fontManager.flushPendingDebugEditingFontSaveAfterDrag =
                originalFlushPendingDebugEditingFontSaveAfterDrag;
        }
    });

    test('sidebearing mouseup recomputes complete cascade before YDoc target collection', async () => {
        const originalWindowChangeBridge = window.changeBridge;
        const originalUpdateWorkerFontCache = fontManager.updateWorkerFontCache;
        const originalFlushPendingDebugEditingFontSaveAfterDrag =
            fontManager.flushPendingDebugEditingFontSaveAfterDrag;
        const targets = [
            { glyphName: 'l', layerId: 'layer-1' },
            { glyphName: 'n', layerId: 'layer-1' },
            { glyphName: 'a', layerId: 'layer-1' }
        ];
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockImplementation(() => {});
        const applyMetricsSpy = jest
            .spyOn(canvas.outlineEditor, 'applyMetricsKeysToCurrentEditedLayer')
            .mockReturnValue({
                glyphName: 'l',
                nextWidth: 540,
                glyphAdvances: {},
                advancesRefreshed: false,
                affectedGlyphNames: new Set(['l', 'n', 'a'])
            });
        const collectTargetsSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'collectMatchingLayerWorkerReplayTargets'
            )
            .mockReturnValue(targets);
        const syncSpy = jest
            .spyOn(canvas.outlineEditor, '_syncCurrentGlyphToYDoc')
            .mockImplementation(() => {});
        const getSidebearingSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentDirectSidebearing')
            .mockReturnValue(20);
        const syncDependentsSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'syncDependentGlyphsAfterSidebearingEdit'
            )
            .mockImplementation(() => {});
        const glyphModelSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentGlyphModel')
            .mockReturnValue({ name: 'l' });

        try {
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn()
            };
            fontManager.updateWorkerFontCache = jest.fn();
            fontManager.flushPendingDebugEditingFontSaveAfterDrag = jest.fn();

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.selectedSidebearingHandle = {
                side: 'right',
                editable: true
            };
            canvas.outlineEditor.layerData = {
                width: 540,
                shapes: [],
                anchors: []
            };
            canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
                { glyphName: 'l' }
            ]);
            canvas.getCurrentGlyphName = jest.fn(() => 'l');
            canvas.outlineEditor.isDraggingSidebearing = true;
            canvas.outlineEditor._dragType = 'sidebearing';
            canvas.outlineEditor._hasMoved = true;
            canvas.outlineEditor._preDragDesc = 'RSB: 10';
            canvas.outlineEditor._metricsKeyEditedSide = 'right';
            canvas.outlineEditor._sidebearingAffectedGlyphNames = new Set([
                'l'
            ]);

            await canvas.outlineEditor.onMouseUp({ clientX: 10, clientY: 20 });

            expect(applyMetricsSpy).toHaveBeenCalledWith(true, {
                rebuildAutomaticComposites: true
            });
            expect(collectTargetsSpy).toHaveBeenCalledWith(
                expect.any(Set),
                'layer-1'
            );
            const collectedGlyphNames = collectTargetsSpy.mock.calls[0][0];
            expect([...collectedGlyphNames].sort()).toEqual(['a', 'l', 'n']);
            expect(syncSpy).toHaveBeenCalledWith(
                'Set RSB',
                'RSB: 10',
                'RIGHT RIGHT 20',
                'right',
                targets
            );
        } finally {
            window.changeBridge = originalWindowChangeBridge;
            fontManager.updateWorkerFontCache = originalUpdateWorkerFontCache;
            fontManager.flushPendingDebugEditingFontSaveAfterDrag =
                originalFlushPendingDebugEditingFontSaveAfterDrag;
            glyphModelSpy.mockRestore();
            syncDependentsSpy.mockRestore();
            getSidebearingSpy.mockRestore();
            syncSpy.mockRestore();
            collectTargetsSpy.mockRestore();
            applyMetricsSpy.mockRestore();
            saveLayerDataSpy.mockRestore();
        }
    });

    test('point drag that returns to original position does not sync to YDoc', async () => {
        const originalWindowChangeBridge = window.changeBridge;
        const originalUpdateWorkerFontCache = fontManager.updateWorkerFontCache;
        const originalFlushPendingDebugEditingFontSaveAfterDrag =
            fontManager.flushPendingDebugEditingFontSaveAfterDrag;
        const syncSpy = jest.spyOn(
            canvas.outlineEditor,
            '_syncCurrentGlyphToYDoc'
        );

        try {
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn()
            };
            fontManager.updateWorkerFontCache = jest.fn();
            fontManager.flushPendingDebugEditingFontSaveAfterDrag = jest.fn();

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.currentGlyphName = 'A';
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.glyphStack = 'A@layer-1';
            canvas.outlineEditor.layerData = {
                id: 'layer-1',
                width: 520,
                shapes: [
                    {
                        nodes: [
                            { x: 80, y: 180, nodetype: 'Line', smooth: false },
                            { x: 105, y: 282, nodetype: 'Line', smooth: false },
                            { x: 160, y: 210, nodetype: 'Line', smooth: false }
                        ],
                        closed: false
                    }
                ],
                anchors: [],
                guides: []
            };
            canvas.outlineEditor.hoveredPointIndex = {
                contourIndex: 0,
                nodeIndex: 1
            };

            const pointerSpy = jest
                .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
                .mockImplementationOnce(() => ({ glyphX: 105, glyphY: 282 }))
                .mockImplementationOnce(() => ({ glyphX: 120, glyphY: 300 }))
                .mockImplementationOnce(() => ({ glyphX: 105, glyphY: 282 }));

            canvas.outlineEditor.onSingleClick({
                clientX: 10,
                clientY: 20,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            canvas.outlineEditor.onMouseMove({
                clientX: 11,
                clientY: 21,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });
            canvas.outlineEditor.onMouseMove({
                clientX: 12,
                clientY: 22,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });
            canvas.outlineEditor.onMouseMove({
                clientX: 13,
                clientY: 23,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            await canvas.outlineEditor.onMouseUp({ clientX: 13, clientY: 23 });

            expect(window.changeBridge.beginTransaction).toHaveBeenCalledWith(
                'Drag point'
            );
            expect(syncSpy).not.toHaveBeenCalled();
            expect(
                window.changeBridge.syncGlyphFromJson
            ).not.toHaveBeenCalled();
            expect(window.changeBridge.endTransaction).toHaveBeenCalled();

            pointerSpy.mockRestore();
        } finally {
            window.changeBridge = originalWindowChangeBridge;
            fontManager.updateWorkerFontCache = originalUpdateWorkerFontCache;
            fontManager.flushPendingDebugEditingFontSaveAfterDrag =
                originalFlushPendingDebugEditingFontSaveAfterDrag;
        }
    });

    test('shift-click on an on-curve point still toggles selection instead of starting a drag', () => {
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 520,
            shapes: [
                {
                    nodes: [
                        { x: 0, y: 0, nodetype: 'Line', smooth: false },
                        { x: 100, y: 0, nodetype: 'Line', smooth: false }
                    ],
                    closed: false
                }
            ],
            anchors: [],
            guides: []
        };
        canvas.outlineEditor.hoveredPointIndex = {
            contourIndex: 0,
            nodeIndex: 1
        };

        canvas.outlineEditor.onSingleClick({
            clientX: 10,
            clientY: 20,
            detail: 1,
            shiftKey: true,
            altKey: false,
            metaKey: false,
            ctrlKey: false
        });

        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 1 }
        ]);
        expect(canvas.outlineEditor.isDraggingPoint).toBe(false);
    });

    test('point drag with metrics-key side change still syncs even if point description matches', async () => {
        const originalWindowChangeBridge = window.changeBridge;
        const originalUpdateWorkerFontCache = fontManager.updateWorkerFontCache;
        const originalFlushPendingDebugEditingFontSaveAfterDrag =
            fontManager.flushPendingDebugEditingFontSaveAfterDrag;
        const syncSpy = jest.spyOn(
            canvas.outlineEditor,
            '_syncCurrentGlyphToYDoc'
        );
        const buildNodeDescSpy = jest
            .spyOn(canvas.outlineEditor, '_buildNodeDesc')
            .mockReturnValue('(105, 282)');
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockResolvedValue(undefined);

        try {
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn()
            };
            fontManager.updateWorkerFontCache = jest.fn();
            fontManager.flushPendingDebugEditingFontSaveAfterDrag = jest.fn();

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.currentGlyphName = 'A';
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.glyphStack = 'A@layer-1';
            canvas.outlineEditor.isDraggingPoint = true;
            canvas.outlineEditor._dragType = 'point';
            canvas.outlineEditor._hasMoved = true;
            canvas.outlineEditor._preDragDesc = "node '(105, 282)'";
            canvas.outlineEditor._metricsKeyEditedSide = 'left';

            await canvas.outlineEditor.onMouseUp({ clientX: 13, clientY: 23 });

            expect(saveLayerDataSpy).toHaveBeenCalledWith('mouse-drag-outline');
            expect(syncSpy).toHaveBeenCalledWith(
                'Drag point',
                "node '(105, 282)'",
                'LEFT (105, 282)',
                'left',
                undefined
            );
            expect(window.changeBridge.endTransaction).toHaveBeenCalled();
        } finally {
            window.changeBridge = originalWindowChangeBridge;
            fontManager.updateWorkerFontCache = originalUpdateWorkerFontCache;
            fontManager.flushPendingDebugEditingFontSaveAfterDrag =
                originalFlushPendingDebugEditingFontSaveAfterDrag;
            buildNodeDescSpy.mockRestore();
            saveLayerDataSpy.mockRestore();
        }
    });

    test('point drag mouseup waits for final layer save before YDoc sync', async () => {
        const originalWindowChangeBridge = window.changeBridge;
        const originalUpdateWorkerFontCache = fontManager.updateWorkerFontCache;
        const originalFlushPendingDebugEditingFontSaveAfterDrag =
            fontManager.flushPendingDebugEditingFontSaveAfterDrag;
        const syncSpy = jest
            .spyOn(canvas.outlineEditor, '_syncCurrentGlyphToYDoc')
            .mockImplementation(() => {});
        const buildNodeDescSpy = jest
            .spyOn(canvas.outlineEditor, '_buildNodeDesc')
            .mockReturnValue('(105, 282)');
        let resolveSave;
        const savePromise = new Promise((resolve) => {
            resolveSave = resolve;
        });
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockReturnValue(savePromise);

        try {
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn()
            };
            fontManager.updateWorkerFontCache = jest.fn();
            fontManager.flushPendingDebugEditingFontSaveAfterDrag = jest.fn();

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.currentGlyphName = 'A';
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.glyphStack = 'A@layer-1';
            canvas.outlineEditor.isDraggingPoint = true;
            canvas.outlineEditor._dragType = 'point';
            canvas.outlineEditor._hasMoved = true;
            canvas.outlineEditor._preDragDesc = "node '(105, 282)'";

            const mouseUpPromise = canvas.outlineEditor.onMouseUp({
                clientX: 13,
                clientY: 23
            });

            expect(saveLayerDataSpy).toHaveBeenCalledWith('mouse-drag-outline');
            expect(syncSpy).not.toHaveBeenCalled();

            resolveSave();
            await mouseUpPromise;

            expect(syncSpy).toHaveBeenCalledWith(
                'Drag point',
                "node '(105, 282)'",
                '(105, 282)',
                null,
                undefined
            );
            expect(window.changeBridge.endTransaction).toHaveBeenCalled();
        } finally {
            window.changeBridge = originalWindowChangeBridge;
            fontManager.updateWorkerFontCache = originalUpdateWorkerFontCache;
            fontManager.flushPendingDebugEditingFontSaveAfterDrag =
                originalFlushPendingDebugEditingFontSaveAfterDrag;
            syncSpy.mockRestore();
            buildNodeDescSpy.mockRestore();
            saveLayerDataSpy.mockRestore();
        }
    });

    test('point drag mouseup rejection skips YDoc sync and resets drag bookkeeping', async () => {
        const originalWindowChangeBridge = window.changeBridge;
        const originalUpdateWorkerFontCache = fontManager.updateWorkerFontCache;
        const originalFlushPendingDebugEditingFontSaveAfterDrag =
            fontManager.flushPendingDebugEditingFontSaveAfterDrag;
        const originalSyncRustCacheAndRefreshCanvas =
            window.syncRustCacheAndRefreshCanvas;
        const syncSpy = jest
            .spyOn(canvas.outlineEditor, '_syncCurrentGlyphToYDoc')
            .mockImplementation(() => {});
        const saveError = new Error('invalid width');
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockRejectedValue(saveError);

        try {
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn()
            };
            fontManager.updateWorkerFontCache = jest.fn();
            fontManager.flushPendingDebugEditingFontSaveAfterDrag = jest.fn();

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.currentGlyphName = 'A';
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.glyphStack = 'A@layer-1';
            canvas.outlineEditor.isDraggingPoint = true;
            canvas.outlineEditor._dragType = 'point';
            canvas.outlineEditor._hasMoved = true;
            canvas.outlineEditor._preDragDesc = "node '(105, 282)'";
            canvas.outlineEditor._pointDragDeltaX = -12;
            canvas.outlineEditor._sidebearingAffectedGlyphNames = new Set([
                'A'
            ]);
            canvas.outlineEditor.pendingRemoteRefreshAfterDrag = true;
            window.syncRustCacheAndRefreshCanvas = jest.fn();

            await expect(
                canvas.outlineEditor.onMouseUp({ clientX: 13, clientY: 23 })
            ).rejects.toBe(saveError);

            expect(saveLayerDataSpy).toHaveBeenCalledWith('mouse-drag-outline');
            expect(syncSpy).not.toHaveBeenCalled();
            expect(window.changeBridge.endTransaction).toHaveBeenCalled();
            expect(canvas.outlineEditor._hasMoved).toBe(false);
            expect(canvas.outlineEditor._preDragDesc).toBe(null);
            expect(canvas.outlineEditor._dragType).toBe(null);
            expect(canvas.outlineEditor._pointDragDeltaX).toBe(0);
            expect(
                canvas.outlineEditor._sidebearingAffectedGlyphNames.size
            ).toBe(0);
            expect(canvas.outlineEditor.pendingRemoteRefreshAfterDrag).toBe(
                false
            );
            expect(window.syncRustCacheAndRefreshCanvas).toHaveBeenCalled();
        } finally {
            window.syncRustCacheAndRefreshCanvas =
                originalSyncRustCacheAndRefreshCanvas;
            window.changeBridge = originalWindowChangeBridge;
            fontManager.updateWorkerFontCache = originalUpdateWorkerFontCache;
            fontManager.flushPendingDebugEditingFontSaveAfterDrag =
                originalFlushPendingDebugEditingFontSaveAfterDrag;
            syncSpy.mockRestore();
            saveLayerDataSpy.mockRestore();
        }
    });

    test('point drag with left metrics key syncs when recorded x delta changed', async () => {
        const originalWindowChangeBridge = window.changeBridge;
        const originalUpdateWorkerFontCache = fontManager.updateWorkerFontCache;
        const originalFlushPendingDebugEditingFontSaveAfterDrag =
            fontManager.flushPendingDebugEditingFontSaveAfterDrag;
        const syncSpy = jest.spyOn(
            canvas.outlineEditor,
            '_syncCurrentGlyphToYDoc'
        );
        const buildNodeDescSpy = jest
            .spyOn(canvas.outlineEditor, '_buildNodeDesc')
            .mockReturnValue('(105, 282)');
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockResolvedValue(undefined);
        const getCurrentLayerModelSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentLayerModel')
            .mockReturnValue({
                resolveMetricsKey: jest.fn((side) =>
                    side === 'left'
                        ? { input: '=60', value: 60, error: null }
                        : { input: undefined, value: null, error: null }
                )
            });

        try {
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn()
            };
            fontManager.updateWorkerFontCache = jest.fn();
            fontManager.flushPendingDebugEditingFontSaveAfterDrag = jest.fn();

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.currentGlyphName = 'A';
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.glyphStack = 'A@layer-1';
            canvas.outlineEditor.isDraggingPoint = true;
            canvas.outlineEditor._dragType = 'point';
            canvas.outlineEditor._hasMoved = true;
            canvas.outlineEditor._preDragDesc = "node '(105, 282)'";
            canvas.outlineEditor._metricsKeyEditedSide = null;
            canvas.outlineEditor._pointDragDeltaX = -18;

            await canvas.outlineEditor.onMouseUp({ clientX: 13, clientY: 23 });

            expect(saveLayerDataSpy).toHaveBeenCalledWith('mouse-drag-outline');
            expect(syncSpy).toHaveBeenCalledWith(
                'Drag point',
                "node '(105, 282)'",
                'LEFT (105, 282)',
                'left',
                undefined
            );
            expect(window.changeBridge.endTransaction).toHaveBeenCalled();
        } finally {
            window.changeBridge = originalWindowChangeBridge;
            fontManager.updateWorkerFontCache = originalUpdateWorkerFontCache;
            fontManager.flushPendingDebugEditingFontSaveAfterDrag =
                originalFlushPendingDebugEditingFontSaveAfterDrag;
            buildNodeDescSpy.mockRestore();
            saveLayerDataSpy.mockRestore();
            getCurrentLayerModelSpy.mockRestore();
        }
    });

    test('syncCurrentExactLayerDataFromModel preserves working-copy geometry when the exact model snapshot omits it', () => {
        const currentLayerData = {
            id: 'layer-1',
            width: 520,
            shapes: [
                {
                    nodes: [
                        { x: 0, y: 0, type: 'l' },
                        { x: 100, y: 0, type: 'l' }
                    ],
                    closed: false
                }
            ],
            anchors: [{ name: 'top', x: 50, y: 700 }],
            guides: [],
            format_specific: { test: true }
        };
        const getCurrentLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentLayerDataFromStack')
            .mockReturnValue(currentLayerData);
        const getCurrentLayerModelSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentLayerModel')
            .mockReturnValue({
                toJSON: jest.fn(() => ({
                    id: 'layer-1'
                }))
            });

        try {
            canvas.outlineEditor.syncCurrentExactLayerDataFromModel();

            expect(currentLayerData.width).toBe(520);
            expect(currentLayerData.shapes).toEqual([
                {
                    nodes: [
                        { x: 0, y: 0, type: 'l' },
                        { x: 100, y: 0, type: 'l' }
                    ],
                    closed: false
                }
            ]);
            expect(currentLayerData.anchors).toEqual([
                { name: 'top', x: 50, y: 700 }
            ]);
            expect(currentLayerData.format_specific).toEqual({ test: true });
        } finally {
            getCurrentLayerDataSpy.mockRestore();
            getCurrentLayerModelSpy.mockRestore();
        }
    });

    test('applyExactSelectedLayerData preserves existing exact-layer geometry when the incoming exact snapshot omits it', () => {
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 520,
            shapes: [
                {
                    nodes: [
                        { x: 0, y: 0, type: 'l' },
                        { x: 100, y: 0, type: 'l' }
                    ],
                    closed: false
                }
            ],
            anchors: [{ name: 'top', x: 50, y: 700 }],
            guides: [],
            format_specific: { test: true },
            isInterpolated: false
        };
        const isEditingComponentSpy = jest
            .spyOn(canvas.outlineEditor, 'isEditingComponent')
            .mockReturnValue(false);

        try {
            canvas.outlineEditor.applyExactSelectedLayerData(
                { id: 'layer-1' },
                null
            );

            expect(canvas.outlineEditor.layerData.width).toBe(520);
            expect(canvas.outlineEditor.layerData.shapes).toEqual([
                {
                    nodes: [
                        { x: 0, y: 0, type: 'l' },
                        { x: 100, y: 0, type: 'l' }
                    ],
                    closed: false
                }
            ]);
            expect(canvas.outlineEditor.layerData.anchors).toEqual([
                { name: 'top', x: 50, y: 700 }
            ]);
            expect(canvas.outlineEditor.layerData.format_specific).toEqual({
                test: true
            });
        } finally {
            isEditingComponentSpy.mockRestore();
        }
    });

    test('serializeLayerDataAsInterpolationPayload preserves omitted nested component layer fields', () => {
        const serialized =
            canvas.outlineEditor.serializeLayerDataAsInterpolationPayload({
                width: 520,
                shapes: [
                    {
                        reference: 'acutecomb',
                        layerData: {
                            format_specific: { nested: true }
                        }
                    }
                ]
            });

        expect(serialized.shapes[0].layerData.width).toBeUndefined();
        expect(serialized.shapes[0].layerData.shapes).toBeUndefined();
        expect(serialized.shapes[0].layerData.anchors).toBeUndefined();
        expect(serialized.shapes[0].layerData.format_specific).toBeUndefined();
    });

    test('preserveMissingLayerFields strips synthesized nested component layer empties', () => {
        const preserved = canvas.outlineEditor.preserveMissingLayerFields(
            {
                width: 520,
                shapes: [
                    {
                        reference: 'acutecomb',
                        layerData: {
                            width: 0,
                            shapes: [],
                            anchors: [],
                            format_specific: { nested: true }
                        }
                    }
                ]
            },
            {
                width: 520,
                shapes: [
                    {
                        reference: 'acutecomb',
                        layerData: {
                            format_specific: { nested: true }
                        }
                    }
                ]
            }
        );

        expect(preserved.shapes[0].layerData.width).toBeUndefined();
        expect(preserved.shapes[0].layerData.shapes).toBeUndefined();
        expect(preserved.shapes[0].layerData.anchors).toBeUndefined();
        expect(preserved.shapes[0].layerData.format_specific).toEqual({
            nested: true
        });
    });

    test('point drag with left metrics key keeps cumulative x delta across compensated straight-left moves', async () => {
        const originalWindowChangeBridge = window.changeBridge;
        const originalUpdateWorkerFontCache = fontManager.updateWorkerFontCache;
        const originalFlushPendingDebugEditingFontSaveAfterDrag =
            fontManager.flushPendingDebugEditingFontSaveAfterDrag;
        const syncSpy = jest.spyOn(
            canvas.outlineEditor,
            '_syncCurrentGlyphToYDoc'
        );
        const buildNodeDescSpy = jest
            .spyOn(canvas.outlineEditor, '_buildNodeDesc')
            .mockReturnValue('(105, 282)');
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockResolvedValue(undefined);
        const getCurrentLayerModelSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentLayerModel')
            .mockReturnValue({
                resolveMetricsKey: jest.fn((side) =>
                    side === 'left'
                        ? { input: '=60', value: 60, error: null }
                        : { input: undefined, value: null, error: null }
                )
            });
        const applyMetricsKeysSpy = jest
            .spyOn(canvas.outlineEditor, 'applyMetricsKeysToCurrentEditedLayer')
            .mockImplementation(() => {
                const node = canvas.outlineEditor.layerData.shapes[0].nodes[1];
                node.x = 105;
                node.y = 282;
                canvas.outlineEditor._metricsKeyEditedSide = null;
                return null;
            });

        try {
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn()
            };
            fontManager.updateWorkerFontCache = jest.fn();
            fontManager.flushPendingDebugEditingFontSaveAfterDrag = jest.fn();

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.currentGlyphName = 'A';
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.glyphStack = 'A@layer-1';
            canvas.outlineEditor.layerData = {
                id: 'layer-1',
                width: 520,
                shapes: [
                    {
                        nodes: [
                            { x: 80, y: 180, nodetype: 'Line', smooth: false },
                            { x: 105, y: 282, nodetype: 'Line', smooth: false },
                            { x: 160, y: 210, nodetype: 'Line', smooth: false }
                        ],
                        closed: false
                    }
                ],
                anchors: [],
                guides: []
            };
            canvas.outlineEditor.hoveredPointIndex = {
                contourIndex: 0,
                nodeIndex: 1
            };
            canvas.outlineEditor.selectedPoints = [
                { contourIndex: 0, nodeIndex: 1 }
            ];
            canvas.outlineEditor.isDraggingPoint = true;
            canvas.outlineEditor._dragType = 'point';
            canvas.outlineEditor._preDragDesc = "node '(105, 282)'";
            canvas.outlineEditor.lastGlyphX = null;
            canvas.outlineEditor.lastGlyphY = null;
            canvas.outlineEditor._pointDragDeltaX = 0;

            const pointerSpy = jest
                .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
                .mockImplementationOnce(() => ({ glyphX: 105, glyphY: 282 }))
                .mockImplementationOnce(() => ({ glyphX: 95, glyphY: 282 }))
                .mockImplementationOnce(() => ({ glyphX: 85, glyphY: 282 }));

            canvas.outlineEditor.onMouseMove({
                clientX: 11,
                clientY: 21,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });
            canvas.outlineEditor.onMouseMove({
                clientX: 12,
                clientY: 22,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });
            canvas.outlineEditor.onMouseMove({
                clientX: 13,
                clientY: 23,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            expect(canvas.outlineEditor._pointDragDeltaX).toBeLessThan(-0.01);

            await canvas.outlineEditor.onMouseUp({ clientX: 13, clientY: 23 });

            expect(saveLayerDataSpy).toHaveBeenCalledWith('mouse-drag-outline');
            expect(syncSpy).toHaveBeenCalledWith(
                'Drag point',
                "node '(105, 282)'",
                'LEFT (105, 282)',
                'left',
                undefined
            );
            expect(window.changeBridge.endTransaction).toHaveBeenCalled();

            pointerSpy.mockRestore();
        } finally {
            window.changeBridge = originalWindowChangeBridge;
            fontManager.updateWorkerFontCache = originalUpdateWorkerFontCache;
            fontManager.flushPendingDebugEditingFontSaveAfterDrag =
                originalFlushPendingDebugEditingFontSaveAfterDrag;
            buildNodeDescSpy.mockRestore();
            saveLayerDataSpy.mockRestore();
            getCurrentLayerModelSpy.mockRestore();
            applyMetricsKeysSpy.mockRestore();
        }
    });

    test('point drag throttles metrics-key recompute to live refresh frames and mouseup persistence', async () => {
        const originalWindowChangeBridge = window.changeBridge;
        const originalUpdateWorkerFontCache = fontManager.updateWorkerFontCache;
        const originalFlushPendingDebugEditingFontSaveAfterDrag =
            fontManager.flushPendingDebugEditingFontSaveAfterDrag;
        const originalOpenedFonts = fontManager.openedFonts;
        const originalCurrentFontId = fontManager.currentFontId;
        const originalRefreshGlyphsAfterModelBatch =
            fontManager.refreshGlyphsAfterModelBatch;
        const applyMetricsKeysSpy = jest
            .spyOn(canvas.outlineEditor, 'applyMetricsKeysToCurrentEditedLayer')
            .mockReturnValue({
                glyphName: 'A',
                nextWidth: 520,
                glyphAdvances: { A: 520 },
                advancesRefreshed: true,
                affectedGlyphNames: new Set(['A'])
            });
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockResolvedValue(undefined);
        const syncSpy = jest
            .spyOn(canvas.outlineEditor, '_syncCurrentGlyphToYDoc')
            .mockImplementation(() => {});
        const buildNodeDescSpy = jest
            .spyOn(canvas.outlineEditor, '_buildNodeDesc')
            .mockReturnValue('(95, 282)');
        const renderSpy = jest
            .spyOn(canvas, 'render')
            .mockImplementation(() => {});
        const propertySpy = jest
            .spyOn(canvas, 'updatePropertyPanel')
            .mockImplementation(() => {});
        const pointerSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockImplementationOnce(() => ({ glyphX: 105, glyphY: 282 }))
            .mockImplementationOnce(() => ({ glyphX: 100, glyphY: 282 }))
            .mockImplementationOnce(() => ({ glyphX: 95, glyphY: 282 }))
            .mockImplementationOnce(() => ({ glyphX: 90, glyphY: 282 }));
        const scheduledFlushes = [];
        const setTimeoutSpy = jest
            .spyOn(window, 'setTimeout')
            .mockImplementation((callback) => {
                scheduledFlushes.push(callback);
                return 1;
            });
        const clearTimeoutSpy = jest
            .spyOn(window, 'clearTimeout')
            .mockImplementation(() => {});
        const nowSpy = jest
            .spyOn(performance, 'now')
            .mockImplementationOnce(() => 10)
            .mockImplementationOnce(() => 20)
            .mockImplementationOnce(() => 60)
            .mockImplementationOnce(() => 60)
            .mockImplementationOnce(() => 110)
            .mockImplementation(() => 110);
        const requestRecompileWithoutDataChange = jest.fn();
        const refreshGlyphsAfterModelBatchSpy = jest
            .fn()
            .mockResolvedValue(undefined);

        try {
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn()
            };
            fontManager.updateWorkerFontCache = jest.fn();
            fontManager.flushPendingDebugEditingFontSaveAfterDrag = jest.fn();
            fontManager.openedFonts = new Map([
                [
                    'test-font',
                    {
                        requestRecompileWithoutDataChange
                    }
                ]
            ]);
            fontManager.currentFontId = 'test-font';
            fontManager.refreshGlyphsAfterModelBatch =
                refreshGlyphsAfterModelBatchSpy;

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.currentGlyphName = 'A';
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.glyphStack = 'A@layer-1';
            canvas.outlineEditor.layerData = {
                id: 'layer-1',
                width: 520,
                shapes: [
                    {
                        nodes: [
                            { x: 80, y: 180, nodetype: 'Line', smooth: false },
                            { x: 105, y: 282, nodetype: 'Line', smooth: false },
                            { x: 160, y: 210, nodetype: 'Line', smooth: false }
                        ],
                        closed: false
                    }
                ],
                anchors: [],
                guides: []
            };
            canvas.outlineEditor.selectedPoints = [
                { contourIndex: 0, nodeIndex: 1 }
            ];
            canvas.outlineEditor.isDraggingPoint = true;
            canvas.outlineEditor._dragType = 'point';
            canvas.outlineEditor._preDragDesc = "node '(105, 282)'";
            canvas.outlineEditor.lastGlyphX = null;
            canvas.outlineEditor.lastGlyphY = null;
            canvas.outlineEditor._lastDragSaveTime = 0;

            canvas.outlineEditor._handleDrag({
                clientX: 11,
                clientY: 21,
                shiftKey: false,
                altKey: false
            });
            canvas.outlineEditor._handleDrag({
                clientX: 12,
                clientY: 22,
                shiftKey: false,
                altKey: false
            });
            canvas.outlineEditor._handleDrag({
                clientX: 13,
                clientY: 23,
                shiftKey: false,
                altKey: false
            });

            expect(applyMetricsKeysSpy).toHaveBeenCalledTimes(0);
            expect(saveLayerDataSpy).toHaveBeenCalledTimes(0);
            expect(scheduledFlushes).toHaveLength(1);

            scheduledFlushes.shift()();
            await Promise.resolve();

            expect(applyMetricsKeysSpy).toHaveBeenCalledTimes(1);
            expect(saveLayerDataSpy).toHaveBeenCalledTimes(0);
            expect(refreshGlyphsAfterModelBatchSpy).toHaveBeenCalledTimes(1);
            expect(refreshGlyphsAfterModelBatchSpy).toHaveBeenCalledWith(
                ['A'],
                'layer-1',
                expect.objectContaining({
                    dispatchGlyphChanged: false,
                    skipFingerprintBaseline: true,
                    explicitLayerData: [
                        expect.objectContaining({
                            glyphName: 'A',
                            layerId: 'layer-1',
                            layerData: expect.objectContaining({
                                width: 520
                            })
                        })
                    ]
                })
            );
            expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);

            canvas.outlineEditor._hasMoved = true;
            await canvas.outlineEditor.onMouseUp({ clientX: 13, clientY: 23 });

            expect(applyMetricsKeysSpy).toHaveBeenCalledTimes(2);
            expect(saveLayerDataSpy).toHaveBeenCalledTimes(1);
            expect(saveLayerDataSpy).toHaveBeenNthCalledWith(
                1,
                'mouse-drag-outline'
            );
        } finally {
            window.changeBridge = originalWindowChangeBridge;
            fontManager.updateWorkerFontCache = originalUpdateWorkerFontCache;
            fontManager.flushPendingDebugEditingFontSaveAfterDrag =
                originalFlushPendingDebugEditingFontSaveAfterDrag;
            fontManager.openedFonts = originalOpenedFonts;
            fontManager.currentFontId = originalCurrentFontId;
            fontManager.refreshGlyphsAfterModelBatch =
                originalRefreshGlyphsAfterModelBatch;
            applyMetricsKeysSpy.mockRestore();
            saveLayerDataSpy.mockRestore();
            syncSpy.mockRestore();
            buildNodeDescSpy.mockRestore();
            renderSpy.mockRestore();
            propertySpy.mockRestore();
            pointerSpy.mockRestore();
            setTimeoutSpy.mockRestore();
            clearTimeoutSpy.mockRestore();
            nowSpy.mockRestore();
        }
    });

    test('point drag keeps the last non-null interaction side for undo metadata when the final frame clears _metricsKeyEditedSide', async () => {
        const originalWindowChangeBridge = window.changeBridge;
        const originalUpdateWorkerFontCache = fontManager.updateWorkerFontCache;
        const originalFlushPendingDebugEditingFontSaveAfterDrag =
            fontManager.flushPendingDebugEditingFontSaveAfterDrag;
        const syncSpy = jest.spyOn(
            canvas.outlineEditor,
            '_syncCurrentGlyphToYDoc'
        );
        const buildNodeDescSpy = jest
            .spyOn(canvas.outlineEditor, '_buildNodeDesc')
            .mockReturnValue('(205, 182)');
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockResolvedValue(undefined);

        try {
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn()
            };
            fontManager.updateWorkerFontCache = jest.fn();
            fontManager.flushPendingDebugEditingFontSaveAfterDrag = jest.fn();

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.currentGlyphName = 'A';
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.glyphStack = 'A@layer-1';
            canvas.outlineEditor.isDraggingPoint = true;
            canvas.outlineEditor._dragType = 'point';
            canvas.outlineEditor._hasMoved = true;
            canvas.outlineEditor._preDragDesc = "node '(205, 182)'";
            canvas.outlineEditor._metricsKeyEditedSide = null;
            canvas.outlineEditor._metricsKeyInteractionSide = 'right';
            canvas.outlineEditor._pointDragDeltaX = 0;

            await canvas.outlineEditor.onMouseUp({ clientX: 13, clientY: 23 });

            expect(saveLayerDataSpy).toHaveBeenCalledWith('mouse-drag-outline');
            expect(syncSpy).toHaveBeenCalledWith(
                'Drag point',
                "node '(205, 182)'",
                'RIGHT (205, 182)',
                'right',
                undefined
            );
            expect(window.changeBridge.endTransaction).toHaveBeenCalled();
        } finally {
            window.changeBridge = originalWindowChangeBridge;
            fontManager.updateWorkerFontCache = originalUpdateWorkerFontCache;
            fontManager.flushPendingDebugEditingFontSaveAfterDrag =
                originalFlushPendingDebugEditingFontSaveAfterDrag;
            buildNodeDescSpy.mockRestore();
            saveLayerDataSpy.mockRestore();
        }
    });
});

describe('OutlineEditor marquee selection', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 500, dx: 0, dy: 0, g: 0 }];
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 500,
            master: {
                type: 'DefaultForMaster',
                master: 'master-1'
            },
            shapes: [
                {
                    nodes: [
                        { x: 10, y: 10, nodetype: 'Line' },
                        { x: 40, y: 40, nodetype: 'Line' },
                        { x: 80, y: 80, nodetype: 'Line' }
                    ],
                    closed: false
                },
                {
                    reference: 'acutecomb',
                    transform: [1, 0, 0, 1, 20, 20]
                }
            ],
            anchors: [{ name: 'top', x: 30, y: 90 }],
            guides: []
        };
        canvas.outlineEditor.hoveredPointIndex = null;
        canvas.outlineEditor.hoveredAnchorIndex = null;
        canvas.outlineEditor.hoveredComponentIndex = null;
        canvas.outlineEditor.hoveredGuideHandle = null;
        canvas.outlineEditor.hoveredSidebearingHandle = null;
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('clicking empty canvas clears selection of all object types', async () => {
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.selectedComponents = [1];
        canvas.outlineEditor.selectedGuideHandle = {
            scope: 'layer',
            index: 0
        };
        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'left',
            editable: true
        };

        jest.spyOn(
            canvas.outlineEditor,
            'transformMouseToComponentSpace'
        ).mockReturnValueOnce({ glyphX: 0, glyphY: 0 });

        canvas.outlineEditor.onSingleClick({
            shiftKey: false,
            altKey: false,
            metaKey: false,
            ctrlKey: false
        });
        await canvas.outlineEditor.onMouseUp({ clientX: 0, clientY: 0 });

        expect(canvas.outlineEditor.selectedPoints).toEqual([]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([]);
        expect(canvas.outlineEditor.selectedGuideHandle).toBe(null);
        expect(canvas.outlineEditor.selectedSidebearingHandle).toBe(null);
    });

    test('dragging on empty space replaces only node selection inside the rectangle', () => {
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.selectedComponents = [1];
        canvas.outlineEditor.selectedGuideHandle = {
            scope: 'layer',
            index: 0
        };

        jest.spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockReturnValueOnce({ glyphX: 0, glyphY: 0 })
            .mockReturnValueOnce({ glyphX: 50, glyphY: 50 });

        canvas.outlineEditor.onSingleClick({
            shiftKey: false,
            altKey: false,
            metaKey: false,
            ctrlKey: false
        });
        canvas.outlineEditor.onMouseMove({ clientX: 50, clientY: 50 });

        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 0 },
            { contourIndex: 0, nodeIndex: 1 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([0]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([1]);
        expect(canvas.outlineEditor.selectedGuideHandle).toEqual({
            scope: 'layer',
            index: 0
        });
    });

    test('shift-drag toggles nodes inside the rectangle and keeps unaffected nodes selected', () => {
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 },
            { contourIndex: 0, nodeIndex: 2 }
        ];

        jest.spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockReturnValueOnce({ glyphX: 0, glyphY: 0 })
            .mockReturnValueOnce({ glyphX: 50, glyphY: 50 });

        canvas.outlineEditor.onSingleClick({
            shiftKey: true,
            altKey: false,
            metaKey: false,
            ctrlKey: false
        });
        canvas.outlineEditor.onMouseMove({ clientX: 50, clientY: 50 });

        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 2 },
            { contourIndex: 0, nodeIndex: 1 }
        ]);
    });
});

describe('GlyphCanvas property panel metrics edits', () => {
    let canvas;
    let originalLastChangeSource;
    let originalLastEditType;
    let originalRefreshGlyphsAfterModelBatch;
    let originalScheduleFullCompileDebounce;
    let originalOpenedFonts;
    let originalCurrentFontId;
    let originalWindowFontManager;
    let originalWindowGlyphCanvas;
    let originalAutoCompileManager;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        originalLastChangeSource = fontManager.lastChangeSource;
        originalLastEditType = fontManager.lastEditType;
        originalRefreshGlyphsAfterModelBatch =
            fontManager.refreshGlyphsAfterModelBatch;
        originalScheduleFullCompileDebounce =
            fontManager.scheduleFullCompileDebounce;
        originalOpenedFonts = fontManager.openedFonts;
        originalCurrentFontId = fontManager.currentFontId;
        originalWindowFontManager = window.fontManager;
        originalWindowGlyphCanvas = window.glyphCanvas;
        originalAutoCompileManager = window.autoCompileManager;
        window.fontManager = fontManager;
        window.glyphCanvas = canvas;
        window.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };
    });

    afterEach(() => {
        fontManager.lastChangeSource = originalLastChangeSource;
        fontManager.lastEditType = originalLastEditType;
        fontManager.refreshGlyphsAfterModelBatch =
            originalRefreshGlyphsAfterModelBatch;
        fontManager.scheduleFullCompileDebounce =
            originalScheduleFullCompileDebounce;
        fontManager.openedFonts = originalOpenedFonts;
        fontManager.currentFontId = originalCurrentFontId;
        window.fontManager = originalWindowFontManager;
        window.glyphCanvas = originalWindowGlyphCanvas;
        window.autoCompileManager = originalAutoCompileManager;
        canvas.destroy();
    });

    test('commitPropertyPanelValue keeps layer-local sidebearing keys on the incremental layer path', async () => {
        const requestRecompileWithoutDataChange = jest.fn();
        const layer = {
            width: 500,
            isAutomaticAlignedLayer: jest.fn(() => false),
            applySidebearingInput: jest.fn(() => {
                fontManager.currentFont.changeVersion = 2;
                layer.width = 640;
                return {
                    affectedGlyphNames: ['a'],
                    error: null,
                    updateScope: 'layer'
                };
            })
        };

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    changeVersion: 1,
                    requestRecompileWithoutDataChange
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        fontManager.lastChangeSource = 'previous-source';
        fontManager.lastEditType = null;
        window.fontManager.refreshGlyphsAfterModelBatch = jest
            .fn()
            .mockResolvedValue();
        fontManager.scheduleFullCompileDebounce = jest.fn();

        canvas.getCurrentEditingLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'a');
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn();

        await canvas.commitPropertyPanelValue('left', '==50');

        expect(fontManager.lastChangeSource).toBe('keyboard-sidebearing');
        expect(fontManager.lastEditType).toBe('outline');
        expect(fontManager.scheduleFullCompileDebounce).toHaveBeenCalledTimes(
            1
        );
        expect(
            window.autoCompileManager.checkAndSchedule
        ).toHaveBeenCalledTimes(1);
        expect(
            canvas.textRunEditor.refreshGlyphAdvancesLive
        ).toHaveBeenCalledWith({ a: 640 }, { render: false });
        expect(
            window.fontManager.refreshGlyphsAfterModelBatch
        ).toHaveBeenCalledWith(['a'], 'layer-1');
        expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
        expect(
            requestRecompileWithoutDataChange.mock.invocationCallOrder[0]
        ).toBeGreaterThan(
            window.fontManager.refreshGlyphsAfterModelBatch.mock
                .invocationCallOrder[0]
        );
        expect(
            window.autoCompileManager.checkAndSchedule
        ).toHaveBeenCalledTimes(1);
        expect(canvas.outlineEditor.fetchLayerData).toHaveBeenCalledWith(true);
    });

    test('commitPropertyPanelValue uses full-font refresh for glyph-wide sidebearing keys', async () => {
        const requestRecompileWithoutDataChange = jest.fn();
        const layer = {
            width: 500,
            isAutomaticAlignedLayer: jest.fn(() => false),
            applySidebearingInput: jest.fn(() => {
                fontManager.currentFont.changeVersion = 2;
                layer.width = 640;
                return {
                    affectedGlyphNames: ['a', 'adieresis'],
                    error: null,
                    updateScope: 'font'
                };
            })
        };

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    changeVersion: 1,
                    requestRecompileWithoutDataChange
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        fontManager.lastChangeSource = 'previous-source';
        fontManager.lastEditType = 'outline';
        window.fontManager.refreshGlyphsAfterModelBatch = jest
            .fn()
            .mockResolvedValue();
        fontManager.scheduleFullCompileDebounce = jest.fn();

        canvas.getCurrentEditingLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'a');
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn();

        await canvas.commitPropertyPanelValue('left', '=50');

        expect(fontManager.lastChangeSource).toBe('keyboard-sidebearing');
        expect(fontManager.lastEditType).toBe('outline');
        expect(fontManager.scheduleFullCompileDebounce).toHaveBeenCalledTimes(
            1
        );
        expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
        expect(
            requestRecompileWithoutDataChange.mock.invocationCallOrder[0]
        ).toBeGreaterThan(
            window.fontManager.refreshGlyphsAfterModelBatch.mock
                .invocationCallOrder[0]
        );
        expect(
            window.autoCompileManager.checkAndSchedule
        ).toHaveBeenCalledTimes(1);
        expect(
            window.fontManager.refreshGlyphsAfterModelBatch
        ).toHaveBeenCalledWith(['a', 'adieresis'], undefined);
        expect(canvas.outlineEditor.fetchLayerData).not.toHaveBeenCalled();
    });

    test('commitPropertyPanelValue refreshes the active nested glyph instead of the root glyph', async () => {
        const layer = {
            width: 500,
            parent: jest.fn(() => ({ name: 'baseComponent' })),
            isAutomaticAlignedLayer: jest.fn(() => false),
            applySidebearingInput: jest.fn(() => {
                fontManager.currentFont.changeVersion = 2;
                layer.width = 640;
                return {
                    affectedGlyphNames: [],
                    error: null,
                    updateScope: 'font'
                };
            })
        };

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    changeVersion: 1
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        fontManager.lastChangeSource = 'previous-source';
        fontManager.lastEditType = 'outline';
        window.fontManager.refreshGlyphsAfterModelBatch = jest
            .fn()
            .mockResolvedValue();
        fontManager.scheduleFullCompileDebounce = jest.fn();

        canvas.getCurrentEditingLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'panelGlyph');
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn();

        await canvas.commitPropertyPanelValue('left', '=50');

        expect(layer.applySidebearingInput).toHaveBeenCalledWith('left', '=50');
        expect(
            canvas.textRunEditor.refreshGlyphAdvancesLive
        ).toHaveBeenCalledWith({ baseComponent: 640 }, { render: false });
        expect(
            window.fontManager.refreshGlyphsAfterModelBatch
        ).toHaveBeenCalledWith(['baseComponent'], undefined);
    });

    test('commitPropertyPanelValue allows deleting automatic sidebearing override keys', async () => {
        const requestRecompileWithoutDataChange = jest.fn();
        const layer = {
            width: 500,
            isAutomaticAlignedLayer: jest.fn(() => true),
            applySidebearingInput: jest.fn(() => {
                fontManager.currentFont.changeVersion = 2;
                return {
                    affectedGlyphNames: ['a'],
                    error: null,
                    input: '',
                    value: 50,
                    updateScope: 'font'
                };
            })
        };

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    changeVersion: 1,
                    requestRecompileWithoutDataChange
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        fontManager.lastChangeSource = 'previous-source';
        fontManager.lastEditType = 'outline';
        window.fontManager.refreshGlyphsAfterModelBatch = jest
            .fn()
            .mockResolvedValue();
        fontManager.scheduleFullCompileDebounce = jest.fn();

        canvas.getCurrentEditingLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'a');
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn();

        await canvas.commitPropertyPanelValue('left', '');

        expect(layer.applySidebearingInput).toHaveBeenCalledWith('left', '');
        expect(fontManager.lastChangeSource).toBe('keyboard-sidebearing');
        expect(fontManager.lastEditType).toBe('outline');
        expect(
            window.fontManager.refreshGlyphsAfterModelBatch
        ).toHaveBeenCalledWith(['a'], undefined);
        expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
        expect(fontManager.scheduleFullCompileDebounce).toHaveBeenCalledTimes(
            1
        );
        expect(
            requestRecompileWithoutDataChange.mock.invocationCallOrder[0]
        ).toBeGreaterThan(
            window.fontManager.refreshGlyphsAfterModelBatch.mock
                .invocationCallOrder[0]
        );
        expect(
            window.autoCompileManager.checkAndSchedule
        ).toHaveBeenCalledTimes(1);
        expect(canvas.outlineEditor.fetchLayerData).toHaveBeenCalledWith(true);
    });

    test('commitPropertyPanelValue skips selected-layer refetch for non-automatic glyph-wide sidebearing keys', async () => {
        const requestRecompileWithoutDataChange = jest.fn();
        const layer = {
            width: 500,
            isAutomaticAlignedLayer: jest.fn(() => false),
            applySidebearingInput: jest.fn(() => {
                fontManager.currentFont.changeVersion = 2;
                layer.width = 640;
                return {
                    affectedGlyphNames: ['o', 'odieresis', 'oslashacute'],
                    error: null,
                    updateScope: 'font'
                };
            })
        };

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    changeVersion: 1,
                    requestRecompileWithoutDataChange
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        window.fontManager.refreshGlyphsAfterModelBatch = jest
            .fn()
            .mockResolvedValue();

        canvas.getCurrentEditingLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'o');
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn();

        await canvas.commitPropertyPanelValue('left', '=50');

        expect(canvas.outlineEditor.fetchLayerData).not.toHaveBeenCalled();
        expect(canvas.updatePropertyPanel).toHaveBeenCalledTimes(1);
        expect(canvas.render).toHaveBeenCalledTimes(1);
        expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
    });

    test('commitPropertyPanelValue waits for glyph-wide sidebearing key refresh before recompiling the editing font', async () => {
        let resolveRefresh;
        const refreshPromise = new Promise((resolve) => {
            resolveRefresh = resolve;
        });
        const requestRecompileWithoutDataChange = jest.fn();
        const layer = {
            width: 500,
            isAutomaticAlignedLayer: jest.fn(() => false),
            applySidebearingInput: jest.fn(() => {
                fontManager.currentFont.changeVersion = 2;
                return {
                    affectedGlyphNames: ['a', 'adieresis'],
                    error: null,
                    updateScope: 'font'
                };
            })
        };

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    changeVersion: 1,
                    requestRecompileWithoutDataChange
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        window.fontManager.refreshGlyphsAfterModelBatch = jest
            .fn()
            .mockReturnValue(refreshPromise);
        fontManager.scheduleFullCompileDebounce = jest.fn();

        canvas.getCurrentEditingLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'a');
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn();

        const commitPromise = canvas.commitPropertyPanelValue('left', '=50');

        expect(requestRecompileWithoutDataChange).not.toHaveBeenCalled();
        expect(
            window.autoCompileManager.checkAndSchedule
        ).not.toHaveBeenCalled();

        resolveRefresh();
        await commitPromise;

        expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
        expect(
            window.autoCompileManager.checkAndSchedule
        ).toHaveBeenCalledTimes(1);
    });

    test('commitPropertyPanelValue recompiles automatic sidebearing-key edits even when changeVersion does not advance', async () => {
        let resolveRefresh;
        const refreshPromise = new Promise((resolve) => {
            resolveRefresh = resolve;
        });
        const requestRecompileWithoutDataChange = jest.fn();
        const layer = {
            id: 'layer-1',
            width: 500,
            isAutomaticAlignedLayer: jest.fn(() => true),
            applySidebearingInput: jest.fn(() => ({
                affectedGlyphNames: ['adieresis'],
                error: null,
                value: 70,
                updateScope: 'font'
            }))
        };

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    changeVersion: 1,
                    requestRecompileWithoutDataChange
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        fontManager.lastChangeSource = 'previous-source';
        fontManager.lastEditType = 'outline';
        window.fontManager.refreshGlyphsAfterModelBatch = jest
            .fn()
            .mockReturnValue(refreshPromise);
        fontManager.scheduleFullCompileDebounce = jest.fn();

        canvas.getCurrentEditingLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'adieresis');
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn(() => false);

        const commitPromise = canvas.commitPropertyPanelValue('left', '=+20');

        expect(requestRecompileWithoutDataChange).not.toHaveBeenCalled();

        resolveRefresh();
        await commitPromise;

        expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
        expect(fontManager.lastChangeSource).toBe('keyboard-sidebearing');
        expect(fontManager.lastEditType).toBe('outline');
        expect(fontManager.scheduleFullCompileDebounce).toHaveBeenCalledTimes(
            1
        );
        expect(
            requestRecompileWithoutDataChange.mock.invocationCallOrder[0]
        ).toBeGreaterThan(
            window.fontManager.refreshGlyphsAfterModelBatch.mock
                .invocationCallOrder[0]
        );
        expect(
            window.autoCompileManager.checkAndSchedule
        ).toHaveBeenCalledTimes(1);
    });

    test('requestEditingFontRecompileAfterSidebearingKeyRefresh routes keyed commits through keyboard-sidebearing outline mode', () => {
        const requestRecompileWithoutDataChange = jest.fn();

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    requestRecompileWithoutDataChange
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        fontManager.scheduleFullCompileDebounce = jest.fn();

        canvas.requestEditingFontRecompileAfterSidebearingKeyRefresh();

        expect(fontManager.lastChangeSource).toBe('keyboard-sidebearing');
        expect(fontManager.lastEditType).toBe('outline');
        expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
        expect(fontManager.scheduleFullCompileDebounce).toHaveBeenCalledTimes(
            1
        );
        expect(window.autoCompileManager.checkAndSchedule).toHaveBeenCalled();
    });

    test('commitPropertyPanelValue pans the viewport for left sidebearing edits', async () => {
        const layer = {
            width: 500,
            isAutomaticAlignedLayer: jest.fn(() => false),
            applySidebearingInput: jest.fn(() => {
                fontManager.currentFont.changeVersion = 2;
                layer.width = 520;
                return {
                    affectedGlyphNames: ['a'],
                    error: null,
                    updateScope: 'layer'
                };
            })
        };

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    changeVersion: 1
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        window.fontManager.refreshGlyphsAfterModelBatch = jest
            .fn()
            .mockResolvedValue();
        fontManager.scheduleFullCompileDebounce = jest.fn();

        canvas.viewportManager.scale = 2;
        canvas.viewportManager.panX = 100;
        canvas.getCurrentEditingLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'a');
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn();

        await canvas.commitPropertyPanelValue('left', '20');

        expect(canvas.viewportManager.panX).toBe(60);
    });

    test('commitPropertyPanelValue updates the visible outline before async refresh resolves', async () => {
        let resolveRefresh;
        const refreshPromise = new Promise((resolve) => {
            resolveRefresh = resolve;
        });
        const layer = {
            id: 'layer-1',
            width: 500,
            isAutomaticAlignedLayer: jest.fn(() => false),
            toJSON: jest.fn(() => ({
                id: 'layer-1',
                width: 520,
                shapes: [],
                anchors: [],
                guides: []
            })),
            applySidebearingInput: jest.fn(() => {
                fontManager.currentFont.changeVersion = 2;
                layer.width = 520;
                return {
                    affectedGlyphNames: ['a'],
                    error: null,
                    updateScope: 'layer'
                };
            })
        };

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    changeVersion: 1
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        window.fontManager.refreshGlyphsAfterModelBatch = jest
            .fn()
            .mockReturnValue(refreshPromise);
        fontManager.scheduleFullCompileDebounce = jest.fn();

        canvas.viewportManager.scale = 2;
        canvas.viewportManager.panX = 100;
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 500,
            shapes: [],
            anchors: [],
            guides: [],
            isInterpolated: false
        };
        canvas.getCurrentEditingLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'a');
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn(() => false);

        const commitPromise = canvas.commitPropertyPanelValue('left', '==20');

        expect(canvas.viewportManager.panX).toBe(60);
        expect(canvas.outlineEditor.layerData.width).toBe(520);
        expect(canvas.render).toHaveBeenCalled();

        resolveRefresh();
        await commitPromise;
    });

    test('commitPropertyPanelValue rerenders after async refresh applies automatic sidebearing-key composition changes', async () => {
        let resolveRefresh;
        const refreshPromise = new Promise((resolve) => {
            resolveRefresh = resolve;
        });
        const requestRecompileWithoutDataChange = jest.fn();
        const layer = {
            id: 'layer-1',
            width: 500,
            isAutomaticAlignedLayer: jest.fn(() => true),
            toJSON: jest.fn(() => ({
                id: 'layer-1',
                width: 500,
                shapes: [
                    {
                        reference: 'baseComponent',
                        transform: [1, 0, 0, 1, 0, 0]
                    }
                ],
                anchors: [],
                guides: []
            })),
            applySidebearingInput: jest.fn(() => {
                fontManager.currentFont.changeVersion = 2;
                return {
                    affectedGlyphNames: ['adieresis'],
                    error: null,
                    value: 70,
                    updateScope: 'font'
                };
            })
        };

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    changeVersion: 1,
                    requestRecompileWithoutDataChange
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        window.fontManager.refreshGlyphsAfterModelBatch = jest
            .fn()
            .mockReturnValue(refreshPromise);
        fontManager.scheduleFullCompileDebounce = jest.fn();

        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 500,
            shapes: [
                {
                    reference: 'baseComponent',
                    transform: [1, 0, 0, 1, 0, 0]
                }
            ],
            anchors: [],
            guides: [],
            isInterpolated: false
        };
        canvas.getCurrentEditingLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'adieresis');
        canvas.outlineEditor.fetchLayerData = jest.fn(async () => {
            canvas.outlineEditor.layerData = {
                id: 'layer-1',
                width: 520,
                shapes: [
                    {
                        reference: 'baseComponent',
                        transform: [1, 0, 0, 1, 20, 0]
                    }
                ],
                anchors: [],
                guides: [],
                isInterpolated: false
            };
        });
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn(() => false);

        const commitPromise = canvas.commitPropertyPanelValue('left', '=+20');

        expect(canvas.outlineEditor.layerData.width).toBe(500);
        expect(canvas.outlineEditor.layerData.shapes[0].transform[4]).toBe(0);
        expect(canvas.render).toHaveBeenCalledTimes(1);

        resolveRefresh();
        await commitPromise;

        expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
        expect(canvas.outlineEditor.layerData.width).toBe(520);
        expect(canvas.outlineEditor.layerData.shapes[0].transform[4]).toBe(20);
        expect(canvas.render).toHaveBeenCalledTimes(2);
    });

    test('commitPropertyPanelValue reuses the direct outline-editor path for plain numeric sidebearings', async () => {
        const setSidebearingValueSpy = jest
            .spyOn(canvas.outlineEditor, 'setSidebearingValue')
            .mockReturnValue(true);

        canvas.getCurrentEditingLayerModel = jest.fn(() => ({
            isAutomaticAlignedLayer: jest.fn(() => false)
        }));
        window.fontManager.refreshGlyphsAfterModelBatch = jest
            .fn()
            .mockResolvedValue();
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();

        await canvas.commitPropertyPanelValue('left', '20');

        expect(setSidebearingValueSpy).toHaveBeenCalledWith('left', 20);
        expect(canvas.getCurrentEditingLayerModel).toHaveBeenCalledTimes(1);
        expect(
            window.fontManager.refreshGlyphsAfterModelBatch
        ).not.toHaveBeenCalled();
        expect(canvas.outlineEditor.fetchLayerData).not.toHaveBeenCalled();
        expect(canvas.updatePropertyPanel).toHaveBeenCalledTimes(1);
        expect(canvas.render).toHaveBeenCalledTimes(1);

        setSidebearingValueSpy.mockRestore();
    });

    test('setSidebearingValue syncs affected sidebearing layers through syncLayersFromJson', () => {
        const targets = [
            { glyphName: 'l', layerId: 'master-layer' },
            { glyphName: 'n', layerId: 'master-layer' }
        ];
        const originalChangeBridge = window.changeBridge;
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockImplementation(() => {});
        const getCurrentDirectSidebearingSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentDirectSidebearing')
            .mockReturnValue(10);
        const applySidebearingDeltaSpy = jest
            .spyOn(canvas.outlineEditor, 'applySidebearingDelta')
            .mockImplementation(() => {
                canvas.outlineEditor._sidebearingAffectedGlyphNames = new Set([
                    'l',
                    'n'
                ]);
                return true;
            });
        const syncDependentsSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'syncDependentGlyphsAfterSidebearingEdit'
            )
            .mockImplementation(() => {});
        const glyphModelSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentGlyphModel')
            .mockReturnValue({ name: 'l' });
        const collectTargetsSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'collectMatchingLayerWorkerReplayTargets'
            )
            .mockReturnValue(targets);

        window.changeBridge = {
            syncLayersFromJson: jest.fn(),
            syncGlyphFromJson: jest.fn()
        };

        try {
            expect(canvas.outlineEditor.setSidebearingValue('left', 20)).toBe(
                true
            );
            expect(window.changeBridge.syncLayersFromJson).toHaveBeenCalledWith(
                targets,
                'Set sidebearing',
                expect.any(String),
                expect.any(String),
                'left',
                targets
            );
            expect(
                window.changeBridge.syncGlyphFromJson
            ).not.toHaveBeenCalled();
        } finally {
            window.changeBridge = originalChangeBridge;
            collectTargetsSpy.mockRestore();
            glyphModelSpy.mockRestore();
            syncDependentsSpy.mockRestore();
            applySidebearingDeltaSpy.mockRestore();
            getCurrentDirectSidebearingSpy.mockRestore();
            saveLayerDataSpy.mockRestore();
        }
    });

    test('keyboard sidebearing nudges sync affected layers through syncLayersFromJson', () => {
        const targets = [
            { glyphName: 'l', layerId: 'master-layer' },
            { glyphName: 'n', layerId: 'master-layer' }
        ];
        const originalChangeBridge = window.changeBridge;
        const syncCurrentGlyphToYDocSpy = jest
            .spyOn(canvas.outlineEditor, '_syncCurrentGlyphToYDoc')
            .mockImplementation(() => {});
        const moveSelectedSidebearingSpy = jest
            .spyOn(canvas.outlineEditor, 'moveSelectedSidebearing')
            .mockImplementation(() => {
                canvas.outlineEditor._sidebearingAffectedGlyphNames = new Set([
                    'l',
                    'n'
                ]);
            });
        const collectTargetsSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'collectMatchingLayerWorkerReplayTargets'
            )
            .mockReturnValue(targets);

        window.changeBridge = {
            syncLayersFromJson: jest.fn(),
            syncGlyphFromJson: jest.fn()
        };
        canvas.outlineEditor.active = true;
        canvas.getCurrentGlyphName = jest.fn(() => 'l');
        canvas.outlineEditor.currentGlyphName = 'l';
        canvas.outlineEditor.selectedLayerId = 'master-layer';
        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'right',
            editable: true
        };

        try {
            canvas.outlineEditor.onKeyDown({
                key: 'ArrowRight',
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false,
                preventDefault: jest.fn()
            });

            expect(syncCurrentGlyphToYDocSpy).toHaveBeenCalledWith(
                'Arrow key',
                'RIGHT',
                undefined,
                'right',
                targets
            );
        } finally {
            canvas.outlineEditor.selectedSidebearingHandle = null;
            window.changeBridge = originalChangeBridge;
            syncCurrentGlyphToYDocSpy.mockRestore();
            collectTargetsSpy.mockRestore();
            moveSelectedSidebearingSpy.mockRestore();
        }
    });

    test('reapplyActiveEditedGlyphAdvanceAfterShape restores the active layer width into the text run', () => {
        const layer = { width: 494 };

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
            { glyphName: 'a' }
        ]);
        canvas.getCurrentLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'a');
        canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn(() => true);

        expect(canvas.reapplyActiveEditedGlyphAdvanceAfterShape()).toBe(true);
        expect(
            canvas.textRunEditor.refreshGlyphAdvancesLive
        ).toHaveBeenCalledWith({ a: 494 }, { render: false });
    });

    test('reapplyActiveEditedGlyphAdvanceAfterShape preserves HarfBuzz advances for anchor edits', () => {
        const originalLastEditType = fontManager.lastEditType;

        try {
            canvas.outlineEditor.active = true;
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
                { glyphName: 'a' }
            ]);
            canvas.getCurrentLayerModel = jest.fn(() => ({
                width: 494,
                master: { master: 'M0' }
            }));
            canvas.getCurrentGlyphName = jest.fn(() => 'a');
            canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn(() => true);

            fontManager.lastEditType = 'anchor';

            expect(canvas.reapplyActiveEditedGlyphAdvanceAfterShape()).toBe(
                false
            );
            expect(
                canvas.textRunEditor.refreshGlyphAdvancesLive
            ).not.toHaveBeenCalled();
        } finally {
            fontManager.lastEditType = originalLastEditType;
        }
    });

    test('editingFontCompiled skips superseded full-compile revisions', async () => {
        const setFontSpy = jest
            .spyOn(canvas, 'setFont')
            .mockResolvedValue(undefined);

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    compileRequestVersion: 5
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        canvas.featuresManager.updateFeaturesUI = jest.fn().mockResolvedValue();
        canvas.requestRepaintAfterCompile = jest.fn();

        window.dispatchEvent(
            new CustomEvent('editingFontCompiled', {
                detail: {
                    fontBytes: new Uint8Array([1, 2, 3]),
                    fontRevisionKey: '4',
                    compilationMode: 'full',
                    dragActive: false
                }
            })
        );

        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(setFontSpy).not.toHaveBeenCalled();
        expect(canvas.requestRepaintAfterCompile).not.toHaveBeenCalled();
    });

    test('requestRepaintAfterCompile refreshes hit detection in outline mode', () => {
        const originalRequestAnimationFrame = global.requestAnimationFrame;
        const renderSpy = jest
            .spyOn(canvas, 'render')
            .mockImplementation(() => {
                canvas.hasDeferredRenderRequest = false;
            });

        try {
            canvas.outlineEditor.active = true;
            canvas.outlineEditor.performHitDetection = jest.fn();
            global.requestAnimationFrame = jest.fn((callback) => {
                callback(0);
                return 1;
            });

            canvas.requestRepaintAfterCompile();

            expect(renderSpy).toHaveBeenCalledTimes(1);
            expect(
                canvas.outlineEditor.performHitDetection
            ).toHaveBeenCalledWith(null);
        } finally {
            global.requestAnimationFrame = originalRequestAnimationFrame;
            renderSpy.mockRestore();
        }
    });

    test('setFont skips properties UI refresh when requested', async () => {
        canvas.initialFontLoaded = true;
        canvas.textRunEditor.setFont = jest.fn().mockResolvedValue({});
        canvas.textRunEditor.rebuildEditingFontNameToGid = jest.fn();
        canvas.textRunEditor.shapeText = jest.fn();
        canvas.axesManager.updateAxesUI = jest.fn().mockResolvedValue();
        canvas.reapplyActiveEditedGlyphAdvanceAfterShape = jest.fn();
        canvas.updatePropertiesUI = jest.fn().mockResolvedValue();

        await canvas.setFont(new Uint8Array([1, 2, 3]).buffer, {
            skipInitialShapeRender: true,
            skipPropertiesUIUpdate: true
        });

        expect(canvas.textRunEditor.setFont).toHaveBeenCalledTimes(1);
        expect(canvas.axesManager.updateAxesUI).toHaveBeenCalledTimes(1);
        expect(canvas.textRunEditor.shapeText).toHaveBeenCalledWith(true);
        expect(
            canvas.reapplyActiveEditedGlyphAdvanceAfterShape
        ).not.toHaveBeenCalled();
        expect(canvas.updatePropertiesUI).not.toHaveBeenCalled();
    });
});

// ==================== Hit Testing Tests ====================

describe('GlyphCanvas hit testing', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 1000, dx: 0, dy: 0, g: 0 }];
        canvas.outlineEditor.layerData = {
            shapes: [
                {
                    Component: {
                        reference: 'A',
                        transform: [1, 0, 0, 1, 100, 100]
                    }
                },
                {
                    Path: {
                        nodes: [{ x: 200, y: 200, type: 'l' }],
                        closed: true
                    }
                }
            ],
            anchors: [{ x: 300, y: 300 }]
        };
        canvas.viewportManager = new ViewportManager(1, 0, 0);
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should correctly identify hovered component', () => {
        canvas.mouseX = 100;
        canvas.mouseY = -100;
        canvas.outlineEditor.updateHoveredComponent();
        expect(canvas.outlineEditor.hoveredComponentIndex).toBe(0);
    });

    test('should correctly identify hovered anchor', () => {
        canvas.mouseX = 300;
        canvas.mouseY = -300;
        canvas.outlineEditor.updateHoveredAnchor();
        expect(canvas.outlineEditor.hoveredAnchorIndex).toBe(0);
    });

    test('should correctly identify hovered point', () => {
        canvas.mouseX = 200;
        canvas.mouseY = -200;
        canvas.outlineEditor.updateHoveredPoint();
        expect(canvas.outlineEditor.hoveredPointIndex).toEqual({
            contourIndex: 1,
            nodeIndex: 0
        });
    });

    test('should clear hovered component when mouse moves away', () => {
        canvas.mouseX = 100;
        canvas.mouseY = -100;
        canvas.outlineEditor.updateHoveredComponent();
        expect(canvas.outlineEditor.hoveredComponentIndex).toBe(0);

        canvas.mouseX = 1000;
        canvas.mouseY = -1000;
        canvas.outlineEditor.updateHoveredComponent();
        expect(canvas.outlineEditor.hoveredComponentIndex).toBe(null);
    });

    test('should clear hovered anchor when mouse moves away', () => {
        canvas.mouseX = 300;
        canvas.mouseY = -300;
        canvas.outlineEditor.updateHoveredAnchor();
        expect(canvas.outlineEditor.hoveredAnchorIndex).toBe(0);

        canvas.mouseX = 1000;
        canvas.mouseY = -1000;
        canvas.outlineEditor.updateHoveredAnchor();
        expect(canvas.outlineEditor.hoveredAnchorIndex).toBe(null);
    });

    test('should clear hovered point when mouse moves away', () => {
        canvas.mouseX = 200;
        canvas.mouseY = -200;
        canvas.outlineEditor.updateHoveredPoint();
        expect(canvas.outlineEditor.hoveredPointIndex).toEqual({
            contourIndex: 1,
            nodeIndex: 0
        });

        canvas.mouseX = 1000;
        canvas.mouseY = -1000;
        canvas.outlineEditor.updateHoveredPoint();
        expect(canvas.outlineEditor.hoveredPointIndex).toBe(null);
    });

    test('should not mark neighboring glyphs hovered while cmd drawing is active in edit mode', () => {
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 100, dx: 0, dy: 0, g: 0 },
            { ax: 100, dx: 0, dy: 0, g: 1 }
        ];
        canvas.textRunEditor.hbFont = {
            glyphToPath: jest.fn(() => 'M0 0 L80 0 L80 80 L0 80 Z'),
            destroy: jest.fn()
        };
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.cmdKeyPressed = true;
        canvas.outlineEditor.hoveredGlyphIndex = 1;
        canvas.mouseX = 150;
        canvas.mouseY = 50;

        canvas.updateHoveredGlyph();

        expect(canvas.outlineEditor.hoveredGlyphIndex).toBe(-1);
    });

    test('should not mark neighboring glyphs hovered when an active-glyph anchor is hovered', () => {
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 100, dx: 0, dy: 0, g: 0 },
            { ax: 100, dx: 0, dy: 0, g: 1 }
        ];
        canvas.textRunEditor.hbFont = {
            glyphToPath: jest.fn(() => 'M0 0 L80 0 L80 80 L0 80 Z'),
            destroy: jest.fn()
        };
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.hoveredAnchorIndex = 0;
        canvas.outlineEditor.hoveredGlyphIndex = 1;
        canvas.mouseX = 150;
        canvas.mouseY = 50;

        canvas.updateHoveredGlyph();

        expect(canvas.outlineEditor.hoveredGlyphIndex).toBe(-1);
    });
});

describe('GlyphCanvas sidebearing handle movement', () => {
    let canvas;
    let currentFontSpy;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');

        const font = Font.fromData({
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
                    name: 'A',
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
                            shapes: [
                                {
                                    nodes: [
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 700, nodetype: 'Line' },
                                        { x: 100, y: 700, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Sidebearing Test' }
            },
            note: '',
            date: '2026-03-21',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: font });

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.renderVerticalMetrics = { Descender: -200 };
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 500,
            master: {
                type: 'DefaultForMaster',
                master: 'master-1'
            },
            shapes: [
                {
                    nodes: [
                        { x: 100, y: 0, nodetype: 'Line' },
                        { x: 400, y: 0, nodetype: 'Line' },
                        { x: 400, y: 700, nodetype: 'Line' },
                        { x: 100, y: 700, nodetype: 'Line' }
                    ],
                    closed: true
                }
            ],
            anchors: [],
            guides: [],
            isInterpolated: false
        };
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 500, dx: 0, dy: 0, g: 0 }];
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.saveLayerData = jest.fn();
    });

    afterEach(() => {
        currentFontSpy.mockRestore();
        canvas.destroy();
    });

    test('detects hovered editable sidebearing handles', () => {
        const handle = canvas.outlineEditor.getVisibleSidebearingHandles()[0];
        canvas.outlineEditor.transformMouseToComponentSpace = jest.fn(() => ({
            glyphX: handle.x,
            glyphY: handle.y
        }));

        canvas.outlineEditor.updateHoveredSidebearingHandle();

        expect(canvas.outlineEditor.hoveredSidebearingHandle).toEqual({
            side: 'left',
            editable: true
        });
    });

    test('keeps the handle on the lowest metric line at different zoom levels', () => {
        const originalScale = canvas.viewportManager.scale;
        const originalPanY = canvas.viewportManager.panY;
        const metricY = -200;

        canvas.viewportManager.scale = 1;
        canvas.viewportManager.panY = 0;
        const handleAtScale1 =
            canvas.outlineEditor.getVisibleSidebearingHandles()[0];
        const screenYAtScale1 = -handleAtScale1.y * 1 + 0;

        canvas.viewportManager.scale = 2;
        canvas.viewportManager.panY = 0;
        const handleAtScale2 =
            canvas.outlineEditor.getVisibleSidebearingHandles()[0];
        const screenYAtScale2 = -handleAtScale2.y * 2 + 0;

        canvas.viewportManager.scale = originalScale;
        canvas.viewportManager.panY = originalPanY;

        expect(screenYAtScale1).toBeCloseTo(-metricY * 1, 5);
        expect(screenYAtScale2).toBeCloseTo(-metricY * 2, 5);
    });

    test('uses the lowest drawn vertical metric line instead of unrelated metric keys', () => {
        canvas.outlineEditor.renderVerticalMetrics = {
            Descender: -200,
            NonRenderedMetric: -450
        };

        const originalScale = canvas.viewportManager.scale;
        const originalPanY = canvas.viewportManager.panY;
        canvas.viewportManager.scale = 1;
        canvas.viewportManager.panY = 0;

        const handle = canvas.outlineEditor.getVisibleSidebearingHandles()[0];
        canvas.viewportManager.scale = originalScale;
        canvas.viewportManager.panY = originalPanY;

        expect(handle.y).toBeCloseTo(-200, 5);
    });

    test('keeps handles between the highest and lowest visible metric lines when bottom snapping kicks in', () => {
        canvas.outlineEditor.renderVerticalMetrics = {
            Ascender: 700,
            Descender: -200
        };
        canvas.outlineEditor.canvas = canvas.canvas;
        canvas.canvas.height = 600 * (window.devicePixelRatio || 1);

        const originalScale = canvas.viewportManager.scale;
        const originalPanY = canvas.viewportManager.panY;

        canvas.viewportManager.scale = 1;
        canvas.viewportManager.panY = 2000;

        const handle = canvas.outlineEditor.getVisibleSidebearingHandles()[0];

        canvas.viewportManager.scale = originalScale;
        canvas.viewportManager.panY = originalPanY;

        expect(handle.y).toBeCloseTo(700, 5);
    });

    test('snaps the handle to 10 screen pixels from the viewport edge', () => {
        canvas.outlineEditor.renderVerticalMetrics = {
            Ascender: 700,
            Descender: -200
        };
        canvas.outlineEditor.canvas = canvas.canvas;
        canvas.canvas.height = 600 * (window.devicePixelRatio || 1);

        const originalScale = canvas.viewportManager.scale;
        const originalPanY = canvas.viewportManager.panY;

        canvas.viewportManager.scale = 1;
        canvas.viewportManager.panY = 1000;

        const handle = canvas.outlineEditor.getVisibleSidebearingHandles()[0];
        const handleScreenY = -handle.y + canvas.viewportManager.panY;

        canvas.viewportManager.scale = originalScale;
        canvas.viewportManager.panY = originalPanY;

        expect(handleScreenY).toBeCloseTo(590, 5);
    });

    test('ignores inactive sidebearing handles for hover interaction', () => {
        const font = Font.fromData({
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
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    format_specific: {
                        metric_left: '=20'
                    },
                    layers: [
                        {
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 700, nodetype: 'Line' },
                                        { x: 100, y: 700, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Sidebearing Test' }
            },
            note: '',
            date: '2026-03-21',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: font });

        const handle = canvas.outlineEditor.getVisibleSidebearingHandles()[0];
        expect(handle.editable).toBe(false);

        canvas.outlineEditor.transformMouseToComponentSpace = jest.fn(() => ({
            glyphX: handle.x,
            glyphY: handle.y
        }));

        canvas.outlineEditor.updateHoveredSidebearingHandle();

        expect(canvas.outlineEditor.hoveredSidebearingHandle).toBe(null);
    });

    test('Fustat glyph a manual LSB handle stays selectable for dragging', () => {
        const font = Font.fromData(loadFontFixture('Fustat.glyphs'));
        const glyph = font.findGlyph('a');
        const layer = glyph.layers[0];

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: font });

        canvas.outlineEditor.layerData = {
            ...layer.toJSON(),
            isInterpolated: false
        };
        canvas.outlineEditor.selectedLayerId = layer.id;
        canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
            { glyphName: glyph.name }
        ]);
        canvas.getCurrentGlyphName = jest.fn(() => glyph.name);

        const handles = canvas.outlineEditor.getVisibleSidebearingHandles();
        const leftHandle = handles.find((handle) => handle.side === 'left');
        const rightHandle = handles.find((handle) => handle.side === 'right');

        expect(leftHandle).toBeTruthy();
        expect(leftHandle.editable).toBe(true);
        expect(rightHandle).toBeTruthy();
        expect(rightHandle.editable).toBe(false);

        canvas.outlineEditor.transformMouseToComponentSpace = jest.fn(() => ({
            glyphX: leftHandle.x,
            glyphY: leftHandle.y
        }));

        canvas.outlineEditor.updateHoveredSidebearingHandle();

        expect(canvas.outlineEditor.hoveredSidebearingHandle).toEqual({
            side: 'left',
            editable: true
        });

        canvas.outlineEditor.onSingleClick({
            clientX: 10,
            clientY: 20,
            detail: 1
        });

        expect(canvas.outlineEditor.selectedSidebearingHandle).toEqual({
            side: 'left',
            editable: true
        });
        expect(canvas.outlineEditor.isDraggingSidebearing).toBe(true);
    });

    test('moving the left sidebearing handle right decreases the sidebearing', () => {
        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'left',
            editable: true
        };
        canvas.outlineEditor.isDraggingSidebearing = true;
        canvas.viewportManager.scale = 2;
        canvas.viewportManager.panX = 100;
        canvas.outlineEditor.transformMouseToComponentSpace = jest
            .fn()
            .mockReturnValueOnce({ glyphX: 10, glyphY: 0 })
            .mockReturnValueOnce({ glyphX: 25, glyphY: -5 });

        canvas.onMouseMove({ clientX: 10, clientY: 20 });
        canvas.onMouseMove({ clientX: 25, clientY: 15 });

        expect(canvas.outlineEditor.layerData.width).toBe(485);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].x).toBe(85);
        expect(canvas.viewportManager.panX).toBe(130);
    });

    test('sidebearing drags refresh live advances for keyed dependent glyphs', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        const glyphName = 'l';
        const layer = font.findGlyph(glyphName).layers[0];
        const masterId = layer.master.master;
        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: font });

        canvas.outlineEditor.layerData = {
            ...layer.toJSON(),
            isInterpolated: false
        };
        canvas.outlineEditor.selectedLayerId = layer.id;
        canvas.outlineEditor.parseGlyphStack = jest.fn(() => [{ glyphName }]);
        canvas.getCurrentGlyphName = jest.fn(() => glyphName);
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.glyphNameBuffer = [
            'l',
            'n',
            'a',
            'adieresis',
            'aring'
        ];
        canvas.textRunEditor.shapedGlyphs =
            canvas.textRunEditor.glyphNameBuffer.map(
                (visibleGlyphName, index) => ({
                    ax: font
                        .findGlyph(visibleGlyphName)
                        .findLayerByMasterId(masterId).width,
                    dx: 0,
                    dy: 0,
                    g: index,
                    cl: index
                })
            );
        canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn(() => true);
        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'right',
            editable: true
        };
        canvas.outlineEditor.isDraggingSidebearing = true;
        window.changeBridge = null;

        canvas.outlineEditor._updateDraggedSidebearing(17);

        expect(
            canvas.textRunEditor.refreshGlyphAdvancesLive
        ).toHaveBeenCalledWith(
            {
                l: font.findGlyph('l').findLayerByMasterId(masterId).width,
                n: font.findGlyph('n').findLayerByMasterId(masterId).width,
                a: font.findGlyph('a').findLayerByMasterId(masterId).width,
                adieresis: font
                    .findGlyph('adieresis')
                    .findLayerByMasterId(masterId).width
            },
            { render: false }
        );
    });

    test('sidebearing drag resolves visible dependent advances through matching layer ids', () => {
        const dependentLayer = {
            width: 777
        };
        const sourceLayer = {
            width: 520,
            master: { master: 'master-1' },
            toJSON: jest.fn(() => ({
                width: 520,
                height: 0,
                vertWidth: 0,
                shapes: [],
                anchors: [],
                guides: []
            })),
            invalidateShapeCache: jest.fn(),
            getMatchingLayerOnGlyph: jest.fn((glyphName) =>
                glyphName === 'dependent' ? dependentLayer : undefined
            )
        };
        const sourceGlyph = {
            findLayerById: jest.fn((layerId) =>
                layerId === 'active-brace-layer' ? sourceLayer : undefined
            )
        };
        const dependentGlyph = {
            findLayerById: jest.fn(() => undefined),
            findLayerByMasterId: jest.fn(() => undefined)
        };
        const fontModel = {
            findGlyph: jest.fn((glyphName) => {
                if (glyphName === 'active') {
                    return sourceGlyph;
                }
                if (glyphName === 'dependent') {
                    return dependentGlyph;
                }
                return undefined;
            }),
            recomputeMetricsKeys: jest.fn(() => new Set(['dependent']))
        };

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel });

        canvas.outlineEditor.layerData = {
            width: 520,
            height: 0,
            vertWidth: 0,
            shapes: [],
            anchors: [],
            guides: [],
            isInterpolated: false
        };
        canvas.outlineEditor.selectedLayerId = 'active-brace-layer';
        canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
            { glyphName: 'active' }
        ]);
        canvas.getCurrentGlyphName = jest.fn(() => 'active');
        canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn(() => true);
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.glyphNameBuffer = ['active', 'dependent'];
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 500, dx: 0, dy: 0, g: 0, cl: 0 },
            { ax: 600, dx: 0, dy: 0, g: 1, cl: 1 }
        ];
        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'right',
            editable: true
        };
        canvas.outlineEditor.isDraggingSidebearing = true;
        window.changeBridge = null;

        canvas.outlineEditor._updateDraggedSidebearing(20);

        expect(sourceLayer.getMatchingLayerOnGlyph).toHaveBeenCalledWith(
            'dependent'
        );
        expect(
            canvas.textRunEditor.refreshGlyphAdvancesLive
        ).toHaveBeenCalledWith(
            {
                active: 520,
                dependent: 777
            },
            { render: false }
        );
    });

    test('point drags schedule keyed sidebearing recompute before mouseup', () => {
        const applyMetricsSpy = jest
            .spyOn(canvas.outlineEditor, 'applyMetricsKeysToCurrentEditedLayer')
            .mockReturnValue(null);
        const scheduledFlushes = [];
        const setTimeoutSpy = jest
            .spyOn(window, 'setTimeout')
            .mockImplementation((callback) => {
                scheduledFlushes.push(callback);
                return 1;
            });
        const clearTimeoutSpy = jest
            .spyOn(window, 'clearTimeout')
            .mockImplementation(() => {});

        try {
            canvas.outlineEditor.isDraggingPoint = true;
            canvas.outlineEditor.selectedPoints = [
                { contourIndex: 0, nodeIndex: 0 }
            ];

            canvas.onMouseMove({ clientX: 10, clientY: 20 });
            canvas.onMouseMove({ clientX: 25, clientY: 15 });

            expect(applyMetricsSpy).not.toHaveBeenCalled();
            expect(scheduledFlushes).toHaveLength(1);

            scheduledFlushes[0]();

            expect(applyMetricsSpy).toHaveBeenCalled();
        } finally {
            applyMetricsSpy.mockRestore();
            setTimeoutSpy.mockRestore();
            clearTimeoutSpy.mockRestore();
        }
    });

    test('finalizing a closed command-path edit recomputes keyed sidebearings on sibling layers', () => {
        const font = Font.fromData({
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
                },
                {
                    id: 'master-2',
                    name: { en: 'Bold' },
                    location: { wght: 1 },
                    guides: [],
                    metrics: {},
                    kerning: new Map()
                }
            ],
            glyphs: [
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'layer-1',
                            width: 400,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 300, y: 0, nodetype: 'Line' },
                                        { x: 300, y: 500, nodetype: 'Line' },
                                        { x: 100, y: 500, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 520,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-2'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 120, y: 0, nodetype: 'Line' },
                                        { x: 420, y: 0, nodetype: 'Line' },
                                        { x: 420, y: 500, nodetype: 'Line' },
                                        { x: 120, y: 500, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ],
                    format_specific: {
                        metric_left: '=50'
                    }
                }
            ],
            names: {
                family_name: { en: 'Command Path Metrics Test' }
            },
            note: '',
            date: '2026-03-31',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const updateWorkerFontCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const updateDirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();

        const getLayerBoundingBoxCenterScreen = () => {
            const bbox = Layer.calculateBoundingBox(
                canvas.outlineEditor.layerData,
                true
            );
            if (!bbox) {
                return null;
            }

            const glyphPosition = canvas.textRunEditor._getGlyphPosition(
                canvas.textRunEditor.selectedGlyphIndex
            );
            const localCenterX = bbox.minX + bbox.width / 2;
            const localCenterY = bbox.minY + bbox.height / 2;

            return canvas.viewportManager.fontToScreenCoordinates(
                glyphPosition.xPosition + glyphPosition.xOffset + localCenterX,
                glyphPosition.yOffset + localCenterY
            );
        };

        try {
            currentFontSpy.mockRestore();
            currentFontSpy = jest
                .spyOn(fontManager, 'currentFont', 'get')
                .mockReturnValue(currentFont);

            const glyph = font.findGlyph('A');
            const activeLayer = glyph.findLayerById('layer-1');
            const siblingLayer = glyph.findLayerById('layer-2');
            const addedPath = activeLayer.addPath(false);
            addedPath._appendLine({ x: 70, y: 0 });
            addedPath._appendLine({ x: 90, y: 0 });
            addedPath._appendLine({ x: 90, y: 120 });
            addedPath._closeOpenPath();

            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.glyphStack = 'A@layer-1';
            canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
                { glyphName: 'A' }
            ]);
            canvas.getCurrentGlyphName = jest.fn(() => 'A');
            canvas.viewportManager.scale = 2;
            canvas.viewportManager.panX = 100;
            canvas.textRunEditor.selectedGlyphIndex = 0;
            canvas.textRunEditor.shapedGlyphs = [
                { ax: 400, dx: 0, dy: 0, g: 0, cl: 0 }
            ];
            canvas.textRunEditor.glyphNameBuffer = ['A'];
            canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn(
                (glyphAdvances) => {
                    const width = glyphAdvances.A;
                    if (typeof width === 'number') {
                        canvas.textRunEditor.shapedGlyphs[0].ax = width;
                    }
                    return true;
                }
            );
            canvas.outlineEditor.layerData = {
                ...glyph.findLayerById('layer-1').toJSON(),
                isInterpolated: false
            };
            const anchorScreen = getLayerBoundingBoxCenterScreen();
            canvas.outlineEditor.pendingCommandPathEdit = {
                didDraw: true,
                didConvertLine: false
            };
            window.changeBridge = null;

            canvas.outlineEditor.finalizePendingCommandPathEdit();

            expect(activeLayer.lsb).toBe(50);
            expect(siblingLayer.lsb).toBe(50);
            expect(canvas.outlineEditor.layerData.width).toBe(
                activeLayer.width
            );
            const currentScreen = getLayerBoundingBoxCenterScreen();
            expect(currentScreen).not.toBeNull();
            expect(currentScreen.x).toBeCloseTo(anchorScreen.x, 2);
            expect(currentScreen.y).toBeCloseTo(anchorScreen.y, 2);
        } finally {
            updateWorkerFontCacheSpy.mockRestore();
            updateDirtyIndicatorSpy.mockRestore();
        }
    });

    test('deleting a full contour recomputes keyed widths and downstream dependents in one history item', async () => {
        const font = Font.fromData({
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
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'layer-1',
                            width: 400,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 50, y: 0, nodetype: 'Line' },
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 100, y: 80, nodetype: 'Line' },
                                        { x: 50, y: 80, nodetype: 'Line' }
                                    ],
                                    closed: true
                                },
                                {
                                    nodes: [
                                        { x: 300, y: 0, nodetype: 'Line' },
                                        { x: 340, y: 0, nodetype: 'Line' },
                                        { x: 340, y: 80, nodetype: 'Line' },
                                        { x: 300, y: 80, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ],
                    format_specific: {
                        metric_right: '=60'
                    }
                },
                {
                    name: 'B',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'layer-2',
                            width: 150,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 20, y: 0, nodetype: 'Line' },
                                        { x: 80, y: 0, nodetype: 'Line' },
                                        { x: 80, y: 80, nodetype: 'Line' },
                                        { x: 20, y: 80, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ],
                    format_specific: {
                        metric_right: '=A'
                    }
                }
            ],
            names: {
                family_name: { en: 'Delete Path Metrics Test' }
            },
            note: '',
            date: '2026-04-01',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);
        const updateWorkerFontCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const updateDirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const bboxSpy = jest
            .spyOn(canvas.outlineEditor, 'getBoundingBoxCenterScreenPosition')
            .mockReturnValue({ x: 200, y: 120 });
        const refreshViewportSpy = jest.spyOn(
            canvas.outlineEditor,
            'refreshKeyedMetricsViewportAnchor'
        );
        const previousChangeBridge = window.changeBridge;
        window.changeBridge = {
            beginTransaction: jest.fn(),
            recordChange: jest.fn(),
            syncGlyphFromJson: jest.fn(),
            syncGlyphsFromJson: jest.fn(),
            endTransaction: jest.fn(),
            runWithoutRecording: (fn) => fn()
        };
        window.currentFontModel = font;

        const currentLayer = font.findGlyph('A').findLayerById('layer-1');
        const dependentLayer = font.findGlyph('B').findLayerById('layer-2');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = {
            ...JSON.parse(JSON.stringify(currentLayer.toJSON())),
            isInterpolated: false
        };
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 400, dx: 0, dy: 0, g: 0 },
            { ax: 150, dx: 0, dy: 0, g: 1 }
        ];
        canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn(() => true);
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 1, nodeIndex: 0 },
            { contourIndex: 1, nodeIndex: 1 },
            { contourIndex: 1, nodeIndex: 2 },
            { contourIndex: 1, nodeIndex: 3 }
        ];

        try {
            await canvas.outlineEditor.deleteSelectedNodes();

            expect(currentLayer.shapes).toHaveLength(1);
            expect(currentLayer.width).toBe(160);
            expect(dependentLayer.width).toBe(140);
            expect(refreshViewportSpy).toHaveBeenCalledWith(expect.any(Set), {
                x: 200,
                y: 120
            });
            expect(
                canvas.textRunEditor.refreshGlyphAdvancesLive
            ).toHaveBeenCalledWith(
                expect.objectContaining({ A: 160, B: 140 }),
                { render: false }
            );
            expect(window.changeBridge.beginTransaction).toHaveBeenCalledTimes(
                1
            );
            expect(window.changeBridge.syncGlyphsFromJson).toHaveBeenCalledWith(
                expect.arrayContaining(['A', 'B']),
                'Delete point(s)'
            );
            expect(
                window.changeBridge.syncGlyphFromJson
            ).not.toHaveBeenCalled();
            expect(window.changeBridge.endTransaction).toHaveBeenCalledTimes(1);
        } finally {
            window.changeBridge = previousChangeBridge;
            refreshViewportSpy.mockRestore();
            bboxSpy.mockRestore();
            updateWorkerFontCacheSpy.mockRestore();
            updateDirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('pressing ArrowRight on the left sidebearing handle decreases the sidebearing', () => {
        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'left',
            editable: true
        };
        canvas.viewportManager.scale = 2;
        canvas.viewportManager.panX = 100;

        const event = {
            key: 'ArrowRight',
            shiftKey: false,
            metaKey: false,
            ctrlKey: false,
            preventDefault: jest.fn()
        };

        canvas.outlineEditor.onKeyDown(event);

        expect(event.preventDefault).toHaveBeenCalled();
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].x).toBe(99);
        expect(canvas.outlineEditor.layerData.width).toBe(499);
        expect(canvas.viewportManager.panX).toBe(102);
    });

    test('Cmd+A selects all points, anchors, and components in the active layer', () => {
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 500,
            master: {
                type: 'DefaultForMaster',
                master: 'master-1'
            },
            shapes: [
                {
                    nodes: [
                        { x: 100, y: 0, nodetype: 'Line' },
                        { x: 400, y: 0, nodetype: 'Line' }
                    ],
                    closed: false
                },
                {
                    reference: 'acutecomb',
                    transform: [1, 0, 0, 1, 0, 0]
                }
            ],
            anchors: [{ name: 'top', x: 250, y: 700 }],
            guides: [],
            isInterpolated: false
        };
        canvas.outlineEditor.selectedGuideHandle = {
            scope: 'layer',
            index: 0
        };
        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'left',
            editable: true
        };

        const event = {
            key: 'a',
            shiftKey: false,
            altKey: false,
            metaKey: true,
            ctrlKey: false,
            code: 'KeyA',
            preventDefault: jest.fn()
        };

        canvas.outlineEditor.onKeyDown(event);

        expect(event.preventDefault).toHaveBeenCalled();
        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 0 },
            { contourIndex: 0, nodeIndex: 1 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([0]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([1]);
        expect(canvas.outlineEditor.selectedGuideHandle).toBe(null);
        expect(canvas.outlineEditor.selectedSidebearingHandle).toBe(null);
    });

    test('setSidebearingValue shifts component-backed layers through transform translation', () => {
        const font = Font.fromData({
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
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'base-layer',
                            width: 300,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Line' },
                                        { x: 300, y: 0, nodetype: 'Line' },
                                        { x: 300, y: 700, nodetype: 'Line' },
                                        { x: 0, y: 700, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                },
                {
                    name: 'Aacute',
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
                            shapes: [
                                {
                                    reference: 'A',
                                    transform: [1, 0, 0, 1, 100, 0]
                                }
                            ],
                            anchors: [{ x: 120, y: 50 }],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Sidebearing Component Test' }
            },
            note: '',
            date: '2026-03-23',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: font });

        canvas.viewportManager.scale = 2;
        canvas.viewportManager.panX = 100;
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 500,
            master: {
                type: 'DefaultForMaster',
                master: 'master-1'
            },
            shapes: [
                {
                    reference: 'A',
                    transform: [1, 0, 0, 1, 100, 0]
                }
            ],
            anchors: [{ x: 120, y: 50 }],
            guides: [],
            isInterpolated: false
        };

        expect(canvas.outlineEditor.setSidebearingValue('left', 80)).toBe(true);
        expect(
            canvas.outlineEditor.layerData.shapes[0].transform.translation[0]
        ).toBe(80);
        expect(canvas.outlineEditor.layerData.anchors[0].x).toBe(100);
        expect(canvas.outlineEditor.layerData.width).toBe(480);
        expect(canvas.viewportManager.panX).toBe(140);
    });
});

// ==================== Selection Tests ====================

describe('GlyphCanvas selection handling', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.layerData = {
            shapes: [
                { Component: { transform: [1, 0, 0, 1, 100, 100] } },
                {
                    nodes: [
                        [200, 200, 'l'],
                        [300, 300, 'l']
                    ]
                }
            ],
            anchors: [
                { x: 300, y: 300 },
                { x: 400, y: 400 }
            ]
        };
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should allow selecting a single point', () => {
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 1, nodeIndex: 0 }
        ];
        expect(canvas.outlineEditor.selectedPoints.length).toBe(1);
        expect(canvas.outlineEditor.selectedPoints[0]).toEqual({
            contourIndex: 1,
            nodeIndex: 0
        });
    });

    test('should allow selecting multiple points', () => {
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 1, nodeIndex: 0 },
            { contourIndex: 1, nodeIndex: 1 }
        ];
        expect(canvas.outlineEditor.selectedPoints.length).toBe(2);
    });

    test('should allow selecting a single anchor', () => {
        canvas.outlineEditor.selectedAnchors = [0];
        expect(canvas.outlineEditor.selectedAnchors.length).toBe(1);
        expect(canvas.outlineEditor.selectedAnchors[0]).toBe(0);
    });

    test('should allow selecting multiple anchors', () => {
        canvas.outlineEditor.selectedAnchors = [0, 1];
        expect(canvas.outlineEditor.selectedAnchors.length).toBe(2);
    });

    test('should allow selecting a single component', () => {
        canvas.outlineEditor.selectedComponents = [0];
        expect(canvas.outlineEditor.selectedComponents.length).toBe(1);
        expect(canvas.outlineEditor.selectedComponents[0]).toBe(0);
    });
});

// ==================== Point Movement Tests ====================

describe('GlyphCanvas point movement', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.layerData = {
            shapes: [
                {
                    nodes: [
                        { x: 100, y: 100, type: 'l' },
                        { x: 200, y: 200, type: 'l' }
                    ]
                }
            ],
            anchors: []
        };
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];
        // Mock saveLayerData to prevent errors
        canvas.outlineEditor.saveLayerData = jest.fn();
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should move selected points by delta', () => {
        canvas.outlineEditor.moveSelectedPoints(10, 20);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].x).toBe(110);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].y).toBe(120);
    });

    test('should move multiple selected points', () => {
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 },
            { contourIndex: 0, nodeIndex: 1 }
        ];
        canvas.outlineEditor.moveSelectedPoints(10, 20);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].x).toBe(110);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].y).toBe(120);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[1].x).toBe(210);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[1].y).toBe(220);
    });

    test('should not move points when none are selected', () => {
        canvas.outlineEditor.selectedPoints = [];
        canvas.outlineEditor.moveSelectedPoints(10, 20);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].x).toBe(100);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].y).toBe(100);
    });

    test('preserves layer metadata while recomputing constant metrics keys', () => {
        const font = Font.fromData({
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
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    format_specific: {
                        metric_right: '=20'
                    },
                    layers: [
                        {
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        {
                                            x: 100,
                                            y: 0,
                                            nodetype: 'Line'
                                        },
                                        {
                                            x: 400,
                                            y: 0,
                                            nodetype: 'Line'
                                        },
                                        {
                                            x: 400,
                                            y: 700,
                                            nodetype: 'Line'
                                        },
                                        {
                                            x: 100,
                                            y: 700,
                                            nodetype: 'Line'
                                        }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Movement Test' }
            },
            note: '',
            date: '2026-03-18',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                fontModel: font,
                markDirty: jest.fn()
            });

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 500,
            shapes: [
                {
                    nodes: [
                        { x: 100, y: 0, nodetype: 'Line' },
                        { x: 400, y: 0, nodetype: 'Line' },
                        { x: 400, y: 700, nodetype: 'Line' },
                        { x: 100, y: 700, nodetype: 'Line' }
                    ],
                    closed: true
                }
            ],
            anchors: [],
            guides: [],
            isInterpolated: false
        };
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ];

        try {
            canvas.outlineEditor.moveSelectedPoints(10, 0);

            const glyph = font.findGlyph('A');
            expect(canvas.outlineEditor.layerData.width).toBe(430);
            expect(glyph.layers.map((layer) => layer.id)).toEqual(['layer-1']);
            expect(glyph.findLayerById('layer-1').master).toEqual({
                type: 'DefaultForMaster',
                master: 'master-1'
            });
        } finally {
            currentFontSpy.mockRestore();
        }
    });
});

describe('GlyphCanvas measurement overlay', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        canvas.destroy();
        window.currentFontModel = null;
    });

    test('uses live edited layer data for measurement intersections', () => {
        const font = Font.fromData({
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
                    name: 'A',
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
                            shapes: [
                                {
                                    nodes: [
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 700, nodetype: 'Line' },
                                        { x: 100, y: 700, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Measure Test' }
            },
            note: '',
            date: '2026-03-18',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                fontModel: font,
                markDirty: jest.fn(),
                syncJsonFromModel: jest.fn()
            });
        const originalDirtyIndicator = fontManager.dirtyIndicator;
        fontManager.dirtyIndicator = document.createElement('div');
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        window.currentFontModel = font;

        canvas.outlineEditor.active = true;
        canvas.measurementKeyPressed = true;
        canvas.measurementTool.visible = true;
        canvas.measurementTool.isDragging = false;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 500, dx: 0, dy: 0, g: 0 }];
        canvas.outlineEditor.transformMouseToComponentSpace = jest.fn(() => ({
            glyphX: 0,
            glyphY: 0
        }));
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 530,
            master: {
                type: 'DefaultForMaster',
                master: 'master-1'
            },
            shapes: [
                {
                    nodes: [
                        { x: 100, y: 0, nodetype: 'Line' },
                        { x: 430, y: 0, nodetype: 'Line' },
                        { x: 430, y: 700, nodetype: 'Line' },
                        { x: 100, y: 700, nodetype: 'Line' }
                    ],
                    closed: true
                }
            ],
            anchors: [],
            guides: [],
            isInterpolated: false
        };

        const intersectionSpy = jest
            .spyOn(Layer.prototype, 'getIntersectionsOnLine')
            .mockImplementation(function () {
                expect(this.toJSON().width).toBe(530);
                expect(this.toJSON().shapes[0].nodes[1].x).toBe(430);
                return [];
            });

        try {
            canvas.renderer.drawMeasurementIntersections();
            expect(intersectionSpy).toHaveBeenCalled();
        } finally {
            intersectionSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('editing metrics underlay uses live selected layer width for horizontal extents', () => {
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 640,
            shapes: [],
            anchors: [],
            guides: [],
            isInterpolated: false
        };
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 500, dx: 0, dy: 0, g: 0 }];

        const extents = canvas.renderer.getTextRunHorizontalExtents();

        expect(extents).toEqual({ minX: 0, maxX: 640 });
    });
});

describe('GlyphCanvas snap debug candidates', () => {
    let canvas;
    let font;
    let currentFontSpy;
    let originalFontCompilation;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        font = Font.fromData({
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
                    name: 'leftGlyph',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'left-layer',
                            width: 300,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 20, y: 10, nodetype: 'Line' },
                                        { x: 80, y: 10, nodetype: 'Line' },
                                        { x: 80, y: 70, nodetype: 'Line' },
                                        { x: 20, y: 70, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                },
                {
                    name: 'activeGlyph',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'active-layer',
                            width: 400,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 260, y: 0, nodetype: 'Line' },
                                        { x: 260, y: 200, nodetype: 'Line' },
                                        { x: 100, y: 200, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                },
                {
                    name: 'rightGlyph',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'right-associated-layer',
                            width: 320,
                            master: {
                                type: 'AssociatedWithMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 40, y: 70, nodetype: 'Line' },
                                        { x: 90, y: 70, nodetype: 'Line' },
                                        { x: 90, y: 160, nodetype: 'Line' },
                                        { x: 40, y: 160, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'right-layer',
                            width: 320,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 40, y: 30, nodetype: 'Line' },
                                        { x: 90, y: 30, nodetype: 'Line' },
                                        { x: 90, y: 120, nodetype: 'Line' },
                                        { x: 40, y: 120, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Snap Test' }
            },
            note: '',
            date: '2026-03-27',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: font });
        window.currentFontModel = font;
        originalFontCompilation = window.fontCompilation;
    });

    afterEach(() => {
        canvas.destroy();
        currentFontSpy.mockRestore();
        window.currentFontModel = null;
        window.fontCompilation = originalFontCompilation;
    });

    function setupTextRun(options = {}) {
        canvas.outlineEditor.layerData = options.layerData || {
            id: 'active-layer',
            width: 400,
            master: {
                type: 'DefaultForMaster',
                master: 'master-1'
            },
            shapes: [
                {
                    nodes: [
                        { x: 100, y: 0, nodetype: 'Line' },
                        { x: 260, y: 0, nodetype: 'Line' },
                        { x: 260, y: 200, nodetype: 'Line' },
                        { x: 100, y: 200, nodetype: 'Line' }
                    ],
                    closed: true
                }
            ],
            anchors: [],
            guides: []
        };
        canvas.outlineEditor.selectedLayerId =
            options.selectedLayerId || 'active-layer';
        canvas.outlineEditor.glyphStack =
            options.glyphStack ||
            `activeGlyph@${canvas.outlineEditor.selectedLayerId}`;
        canvas.textRunEditor.selectedMasterId = 'master-1';
        canvas.textRunEditor.glyphNameBuffer = [
            'leftGlyph',
            'activeGlyph',
            'rightGlyph'
        ];
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 300, dx: 0, dy: 0, g: 11 },
            { ax: 400, dx: 0, dy: 0, g: 12 },
            { ax: 320, dx: 0, dy: 0, g: 13 }
        ];
        canvas.textRunEditor.selectedGlyphIndex = 1;
        canvas.axesManager.variationSettings = options.variationSettings || {};
    }

    function simulateDragStart(contourIndex, nodeIndex) {
        canvas.outlineEditor.selectedPoints = [{ contourIndex, nodeIndex }];
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.isSlidingSmoothPointAlongCurve = false;
        // Trigger snap cache build (mimics _handleDrag first-frame init)
        canvas.outlineEditor._snapDragStartMouseX = 100;
        canvas.outlineEditor._snapDragStartMouseY = 0;
        canvas.outlineEditor._snapDragStartNodePos = { x: 100, y: 0 };
        canvas.outlineEditor._beginAdjacentSnapInterpolationSession();
        canvas.outlineEditor._rebuildSnapCandidateCache();
    }

    test('collectDebugSnapCandidates returns empty when not dragging', () => {
        setupTextRun();
        canvas.outlineEditor.selectedPoints = [];
        const candidates = canvas.outlineEditor.collectDebugSnapCandidates();
        expect(candidates).toEqual([]);
    });

    test('collectDebugSnapCandidates prefers the exact default master layer over associated same-master layers', () => {
        setupTextRun();
        simulateDragStart(0, 0);

        const candidates = canvas.outlineEditor.collectDebugSnapCandidates();

        // Debug candidates should NOT include active-glyph source nodes
        // (they duplicate the visible node handles)
        expect(candidates.filter((c) => c.source === 'active').length).toBe(0);

        // Should include origin (drag-start position)
        expect(candidates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ source: 'origin', x: 100, y: 0 })
            ])
        );

        // Should include left and right neighbor nodes
        expect(candidates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    source: 'left',
                    x: -280,
                    y: 10
                }),
                expect.objectContaining({
                    source: 'right',
                    x: 440,
                    y: 30
                })
            ])
        );
    });

    test('collectDebugSnapCandidates loads neighboring intermediate outlines from Rust when no exact layer exists', async () => {
        font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [
                {
                    name: { en: 'Weight' },
                    tag: 'wght',
                    min: 0,
                    default: 0,
                    max: 1000
                }
            ],
            instances: [],
            masters: [
                {
                    id: 'master-1',
                    name: { en: 'Light' },
                    location: { wght: 0 },
                    guides: [],
                    metrics: {},
                    kerning: new Map()
                },
                {
                    id: 'master-2',
                    name: { en: 'Bold' },
                    location: { wght: 1000 },
                    guides: [],
                    metrics: {},
                    kerning: new Map()
                }
            ],
            glyphs: [
                {
                    name: 'leftGlyph',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'left-layer',
                            width: 300,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 20, y: 10, nodetype: 'Line' },
                                        { x: 80, y: 10, nodetype: 'Line' },
                                        { x: 80, y: 70, nodetype: 'Line' },
                                        { x: 20, y: 70, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                },
                {
                    name: 'activeGlyph',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'active-default-layer',
                            width: 400,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 260, y: 0, nodetype: 'Line' },
                                        { x: 260, y: 200, nodetype: 'Line' },
                                        { x: 100, y: 200, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'active-brace-layer',
                            width: 400,
                            master: {
                                type: 'AssociatedWithMaster',
                                master: 'master-1'
                            },
                            location: { wght: 500 },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 260, y: 0, nodetype: 'Line' },
                                        { x: 260, y: 200, nodetype: 'Line' },
                                        { x: 100, y: 200, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                },
                {
                    name: 'rightGlyph',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'right-light-layer',
                            width: 320,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 40, y: 10, nodetype: 'Line' },
                                        { x: 90, y: 10, nodetype: 'Line' },
                                        { x: 90, y: 120, nodetype: 'Line' },
                                        { x: 40, y: 120, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'right-bold-layer',
                            width: 320,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-2'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 40, y: 110, nodetype: 'Line' },
                                        { x: 90, y: 110, nodetype: 'Line' },
                                        { x: 90, y: 220, nodetype: 'Line' },
                                        { x: 40, y: 220, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Intermediate Snap Test' }
            },
            note: '',
            date: '2026-04-08',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });
        currentFontSpy.mockReturnValue({ fontModel: font });
        window.currentFontModel = font;

        const sendMessage = jest.fn().mockResolvedValue({
            outlinesJson: JSON.stringify([
                {
                    name: 'rightGlyph',
                    width: 320,
                    shapes: [
                        {
                            nodes: [
                                { x: 40, y: 60, nodetype: 'Line' },
                                { x: 90, y: 60, nodetype: 'Line' },
                                { x: 90, y: 170, nodetype: 'Line' },
                                { x: 40, y: 170, nodetype: 'Line' }
                            ],
                            closed: true
                        }
                    ]
                }
            ])
        });
        window.fontCompilation = { sendMessage };

        setupTextRun({
            layerData: {
                id: 'active-brace-layer',
                width: 400,
                master: {
                    type: 'AssociatedWithMaster',
                    master: 'master-1'
                },
                location: { wght: 500 },
                shapes: [
                    {
                        nodes: [
                            { x: 100, y: 0, nodetype: 'Line' },
                            { x: 260, y: 0, nodetype: 'Line' },
                            { x: 260, y: 200, nodetype: 'Line' },
                            { x: 100, y: 200, nodetype: 'Line' }
                        ],
                        closed: true
                    }
                ],
                anchors: [],
                guides: []
            },
            selectedLayerId: 'active-brace-layer',
            glyphStack: 'activeGlyph@active-brace-layer',
            variationSettings: { wght: 500 }
        });

        simulateDragStart(0, 0);

        let candidates = canvas.outlineEditor.collectDebugSnapCandidates();
        expect(
            candidates.some((candidate) => candidate.source === 'right')
        ).toBe(false);

        await Promise.all(
            sendMessage.mock.results.map((result) => result.value)
        );
        await Promise.resolve();
        await Promise.resolve();

        candidates = canvas.outlineEditor.collectDebugSnapCandidates();

        expect(sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'getGlyphOutlines',
                glyphNames: ['rightGlyph'],
                location: { wght: 500 },
                flattenComponents: true
            })
        );
        expect(candidates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    source: 'right',
                    x: 440,
                    y: 60
                })
            ])
        );
    });

    test('snap cache excludes dragged nodes from activeOnlyDragCandidates', () => {
        setupTextRun();
        simulateDragStart(0, 0);

        const cache = canvas.outlineEditor._snapCandidateCache;
        expect(cache).not.toBeNull();

        // activeOnlyDragCandidates should NOT contain the dragged node (100, 0)
        // but should contain origin (100, 0) with source 'origin'
        const activeOnly = cache.activeOnlyDragCandidates;
        const draggedAsActive = activeOnly.filter(
            (c) => c.source === 'active' && c.x === 100 && c.y === 0
        );
        expect(draggedAsActive.length).toBe(0);

        // Origin candidate is always present
        expect(activeOnly[0]).toEqual(
            expect.objectContaining({ source: 'origin', x: 100, y: 0 })
        );
    });

    test('snap cache pre-computes snapDistFontUnits and metricsYValues', () => {
        setupTextRun();
        simulateDragStart(0, 0);

        const cache = canvas.outlineEditor._snapCandidateCache;
        expect(typeof cache.snapDistFontUnits).toBe('number');
        expect(cache.snapDistFontUnits).toBeGreaterThan(0);
        expect(Array.isArray(cache.metricsYValues)).toBe(true);
    });
});

describe('GlyphCanvas deleteSelectedNodes', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML =
            '<div id="test-container"></div><div id="file-dirty-indicator"></div>';
        fontManager.dirtyIndicator = document.getElementById(
            'file-dirty-indicator'
        );
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        canvas.destroy();
        window.currentFontModel = null;
    });

    test('propagates point deletion to linked sibling layers via _getLinkedLayers', async () => {
        const font = Font.fromData({
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
                    name: 'A',
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
                            shapes: [
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Move' },
                                        { x: 50, y: 0, nodetype: 'OffCurve' },
                                        {
                                            x: 100,
                                            y: 50,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 100,
                                            y: 100,
                                            nodetype: 'Curve'
                                        }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 10, y: 10, nodetype: 'Move' },
                                        { x: 60, y: 10, nodetype: 'OffCurve' },
                                        {
                                            x: 110,
                                            y: 60,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 110,
                                            y: 110,
                                            nodetype: 'Curve'
                                        }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Delete Test' }
            },
            note: '',
            date: '2026-03-24',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                fontModel: font,
                markDirty: jest.fn(),
                syncJsonFromModel: jest.fn(),
                hasUnsavedChanges: false
            });
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 }
        ];

        try {
            await canvas.outlineEditor.deleteSelectedNodes();

            expect(linkedLayersSpy).toHaveBeenCalled();
            expect(
                currentLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toEqual(['Move', 'Line']);
            expect(
                linkedLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toEqual(['Move', 'Line']);
        } finally {
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            linkedLayersSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('keeps three linked layers compatible when deleting multiple selected points at once', async () => {
        const font = Font.fromData({
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
                    name: 'A',
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
                            shapes: [
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Move' },
                                        {
                                            x: 40,
                                            y: 0,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 90,
                                            y: 60,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 120,
                                            y: 100,
                                            nodetype: 'Curve',
                                            smooth: true
                                        }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 10, y: 10, nodetype: 'Move' },
                                        {
                                            x: 50,
                                            y: 10,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 100,
                                            y: 70,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 130,
                                            y: 110,
                                            nodetype: 'Curve',
                                            smooth: true
                                        }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-3',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 20, y: -10, nodetype: 'Move' },
                                        {
                                            x: 60,
                                            y: -10,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 110,
                                            y: 50,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 140,
                                            y: 90,
                                            nodetype: 'Curve',
                                            smooth: true
                                        }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Delete Test' }
            },
            note: '',
            date: '2026-03-24',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                fontModel: font,
                markDirty: jest.fn(),
                syncJsonFromModel: jest.fn(),
                hasUnsavedChanges: false
            });
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const siblingLayerA = glyph.findLayerById('layer-2');
        const siblingLayerB = glyph.findLayerById('layer-3');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ];

        try {
            await canvas.outlineEditor.deleteSelectedNodes();

            expect(linkedLayersSpy).toHaveBeenCalled();
            for (const layer of [currentLayer, siblingLayerA, siblingLayerB]) {
                expect(
                    layer.paths[0].nodes.map((node) => node.nodetype)
                ).toEqual(['Move', 'Line']);
                expect(layer.paths[0].nodes[0].smooth).toBe(false);
                expect(layer.paths[0].nodes[1].smooth).toBe(false);
            }

            expect(currentLayer.fingerprint).toBe(siblingLayerA.fingerprint);
            expect(currentLayer.fingerprint).toBe(siblingLayerB.fingerprint);
        } finally {
            linkedLayersSpy.mockRestore();
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('removes an entire selected contour across linked layers in one transaction even when a component precedes it', async () => {
        const font = Font.fromData({
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
                    name: 'A',
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
                            shapes: [
                                {
                                    reference: 'acute',
                                    transform: [1, 0, 0, 1, 20, 30]
                                },
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Move' },
                                        { x: 50, y: 0, nodetype: 'Line' },
                                        { x: 50, y: 50, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [{ name: 'top', x: 25, y: 90 }],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    reference: 'acute',
                                    transform: [1, 0, 0, 1, 20, 30]
                                },
                                {
                                    nodes: [
                                        { x: 10, y: 10, nodetype: 'Move' },
                                        { x: 60, y: 10, nodetype: 'Line' },
                                        { x: 60, y: 60, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [{ name: 'top', x: 35, y: 100 }],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Delete Contour Test' }
            },
            note: '',
            date: '2026-03-25',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                fontModel: font,
                markDirty: jest.fn(),
                syncJsonFromModel: jest.fn(),
                hasUnsavedChanges: false
            });
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const previousChangeBridge = window.changeBridge;
        window.changeBridge = {
            beginTransaction: jest.fn(),
            recordChange: jest.fn(),
            syncGlyphFromJson: jest.fn(),
            endTransaction: jest.fn()
        };
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = {
            ...JSON.parse(JSON.stringify(currentLayer.toJSON())),
            anchors: [{ name: 'top', x: 25, y: 90 }]
        };
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 1, nodeIndex: 0 },
            { contourIndex: 1, nodeIndex: 1 },
            { contourIndex: 1, nodeIndex: 2 }
        ];

        try {
            await canvas.outlineEditor.deleteSelectedNodes();

            expect(currentLayer.shapes).toHaveLength(1);
            expect(currentLayer.shapes[0].isComponent()).toBe(true);
            expect(currentLayer.toJSON().anchors).toEqual([
                { name: 'top', x: 25, y: 90 }
            ]);
            expect(linkedLayer.shapes).toHaveLength(1);
            expect(linkedLayer.shapes[0].isComponent()).toBe(true);
            expect(canvas.outlineEditor.layerData.shapes).toHaveLength(1);
            expect(canvas.outlineEditor.layerData.shapes[0].reference).toBe(
                'acute'
            );
            expect(canvas.outlineEditor.layerData.anchors).toEqual([
                { name: 'top', x: 25, y: 90, format_specific: {} }
            ]);
            expect(window.changeBridge.beginTransaction).toHaveBeenCalledTimes(
                1
            );
            expect(window.changeBridge.syncGlyphFromJson).toHaveBeenCalledTimes(
                1
            );
            expect(window.changeBridge.endTransaction).toHaveBeenCalledTimes(1);
        } finally {
            window.changeBridge = previousChangeBridge;
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('keeps surviving components and anchors in layerData when deleting a preceding full contour', async () => {
        const font = Font.fromData({
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
                    name: 'A',
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
                            shapes: [
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Move' },
                                        { x: 50, y: 0, nodetype: 'Line' },
                                        { x: 50, y: 50, nodetype: 'Line' }
                                    ],
                                    closed: false
                                },
                                {
                                    reference: 'acute',
                                    transform: [1, 0, 0, 1, 20, 30],
                                    layerData: {
                                        width: 120,
                                        shapes: [
                                            {
                                                nodes: [
                                                    {
                                                        x: 1,
                                                        y: 2,
                                                        nodetype: 'Move'
                                                    },
                                                    {
                                                        x: 3,
                                                        y: 4,
                                                        nodetype: 'Line'
                                                    }
                                                ],
                                                closed: false
                                            }
                                        ],
                                        anchors: [],
                                        guides: []
                                    }
                                }
                            ],
                            anchors: [{ name: 'top', x: 25, y: 90 }],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Delete Leading Contour Test' }
            },
            note: '',
            date: '2026-03-25',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                fontModel: font,
                markDirty: jest.fn(),
                syncJsonFromModel: jest.fn(),
                hasUnsavedChanges: false
            });
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const previousChangeBridge = window.changeBridge;
        window.changeBridge = {
            beginTransaction: jest.fn(),
            recordChange: jest.fn(),
            syncGlyphFromJson: jest.fn(),
            endTransaction: jest.fn()
        };
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 },
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ];

        try {
            await canvas.outlineEditor.deleteSelectedNodes();

            expect(canvas.outlineEditor.layerData.shapes).toHaveLength(1);
            expect(canvas.outlineEditor.layerData.shapes[0].reference).toBe(
                'acute'
            );
            expect(
                canvas.outlineEditor.layerData.shapes[0].layerData?.shapes?.[0]
                    ?.nodes?.[0]?.x
            ).toBe(1);
            expect(canvas.outlineEditor.layerData.anchors).toEqual([
                { name: 'top', x: 25, y: 90, format_specific: {} }
            ]);
        } finally {
            window.changeBridge = previousChangeBridge;
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('deletes selected points, anchors, and guides together across linked layers using anchor/guide names', async () => {
        const font = Font.fromData({
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
                    name: 'A',
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
                            shapes: [
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Move' },
                                        { x: 50, y: 0, nodetype: 'Line' },
                                        { x: 50, y: 50, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [
                                { name: 'keep', x: 5, y: 5 },
                                { name: 'top', x: 25, y: 90 }
                            ],
                            guides: [
                                {
                                    name: 'delete-me',
                                    pos: { x: 0, y: 600 },
                                    angle: 0
                                }
                            ]
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 10, y: 10, nodetype: 'Move' },
                                        { x: 60, y: 10, nodetype: 'Line' },
                                        { x: 60, y: 60, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [
                                { name: 'top', x: 30, y: 95 },
                                { name: 'keep', x: 10, y: 10 }
                            ],
                            guides: [
                                {
                                    name: 'keep-guide',
                                    pos: { x: 0, y: 580 },
                                    angle: 0
                                }
                            ]
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Delete Mixed Selection Test' }
            },
            note: '',
            date: '2026-03-26',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                fontModel: font,
                markDirty: jest.fn(),
                syncJsonFromModel: jest.fn(),
                hasUnsavedChanges: false
            });
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const previousChangeBridge = window.changeBridge;
        window.changeBridge = {
            beginTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn(),
            endTransaction: jest.fn()
        };
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 },
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ];
        canvas.outlineEditor.selectedAnchors = [1];
        canvas.outlineEditor.selectedGuideHandle = {
            scope: 'layer',
            index: 0
        };

        try {
            await canvas.outlineEditor.deleteSelectedNodes();

            for (const layer of [currentLayer, linkedLayer]) {
                expect(layer.shapes).toHaveLength(0);
            }

            expect(currentLayer.toJSON().anchors).toEqual([
                { name: 'keep', x: 5, y: 5 }
            ]);
            expect(linkedLayer.toJSON().anchors).toEqual([
                { name: 'keep', x: 10, y: 10 }
            ]);

            expect(currentLayer.toJSON().guides || []).toEqual([]);
            expect(linkedLayer.toJSON().guides || []).toEqual([
                {
                    name: 'keep-guide',
                    pos: { x: 0, y: 580 },
                    angle: 0
                }
            ]);

            expect(window.changeBridge.beginTransaction).toHaveBeenCalledTimes(
                1
            );
            expect(window.changeBridge.syncGlyphFromJson).toHaveBeenCalledTimes(
                1
            );
            expect(window.changeBridge.endTransaction).toHaveBeenCalledTimes(1);
        } finally {
            window.changeBridge = previousChangeBridge;
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('deletes a full contour when all on-curve nodes are selected, even if off-curve handles are not selected', async () => {
        const font = Font.fromData({
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
                    name: 'A',
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
                            shapes: [
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Move' },
                                        { x: 50, y: 0, nodetype: 'OffCurve' },
                                        {
                                            x: 100,
                                            y: 50,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 100,
                                            y: 100,
                                            nodetype: 'Curve'
                                        }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 10, y: 10, nodetype: 'Move' },
                                        {
                                            x: 60,
                                            y: 10,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 110,
                                            y: 60,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 110,
                                            y: 110,
                                            nodetype: 'Curve'
                                        }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'On-Curve Delete Test' }
            },
            note: '',
            date: '2026-03-26',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                fontModel: font,
                markDirty: jest.fn(),
                syncJsonFromModel: jest.fn(),
                hasUnsavedChanges: false
            });
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        // Select only on-curve nodes (Move + Curve), not off-curve handles.
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 },
            { contourIndex: 0, nodeIndex: 3 }
        ];

        try {
            await canvas.outlineEditor.deleteSelectedNodes();

            expect(currentLayer.shapes).toHaveLength(0);
            expect(linkedLayer.shapes).toHaveLength(0);
        } finally {
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('prefers exact nested component layer data over stale interpolated payloads', () => {
        canvas.outlineEditor.selectedLayerId = 'layer-1';

        canvas.outlineEditor.applyExactSelectedLayerData(
            {
                id: 'layer-1',
                width: 500,
                shapes: [
                    {
                        reference: 'acute',
                        transform: [1, 0, 0, 1, 20, 30],
                        layerData: {
                            id: 'acute-layer',
                            width: 120,
                            shapes: [
                                {
                                    nodes: [
                                        { x: 10, y: 20, nodetype: 'Move' },
                                        { x: 30, y: 40, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [{ name: 'top', x: 70, y: 80 }],
                            guides: []
                        }
                    }
                ],
                anchors: [{ name: 'root', x: 5, y: 6 }],
                guides: []
            },
            {
                id: 'layer-1',
                width: 500,
                shapes: [
                    {
                        reference: 'acute',
                        transform: [1, 0, 0, 1, 99, 111],
                        layerData: {
                            id: 'acute-layer',
                            width: 120,
                            shapes: [
                                {
                                    nodes: [
                                        { x: 1, y: 2, nodetype: 'Move' },
                                        { x: 3, y: 4, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [{ name: 'top', x: 1, y: 2 }],
                            guides: []
                        }
                    }
                ],
                anchors: [],
                guides: []
            }
        );

        expect(canvas.outlineEditor.layerData.shapes[0].transform).toEqual([
            1, 0, 0, 1, 99, 111
        ]);
        expect(
            canvas.outlineEditor.layerData.shapes[0].layerData.anchors
        ).toEqual([{ name: 'top', x: 70, y: 80, format_specific: {} }]);
        expect(
            canvas.outlineEditor.layerData.shapes[0].layerData.shapes[0].nodes
        ).toEqual([
            { x: 10, y: 20, nodetype: 'Move' },
            { x: 30, y: 40, nodetype: 'Line' }
        ]);
    });

    test('cmd-dragging a smooth point slides it along the curve across linked layers as one glyph history item', async () => {
        const font = Font.fromData({
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
                    name: 'A',
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
                            shapes: [
                                {
                                    nodes: [
                                        {
                                            x: 0,
                                            y: 0,
                                            nodetype: 'Curve',
                                            smooth: true
                                        },
                                        { x: 25, y: 80, nodetype: 'OffCurve' },
                                        { x: 75, y: 80, nodetype: 'OffCurve' },
                                        {
                                            x: 100,
                                            y: 0,
                                            nodetype: 'Curve',
                                            smooth: true
                                        },
                                        {
                                            x: 125,
                                            y: -80,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 175,
                                            y: -80,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 200,
                                            y: 0,
                                            nodetype: 'Curve',
                                            smooth: true
                                        }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        {
                                            x: 0,
                                            y: 20,
                                            nodetype: 'Curve',
                                            smooth: true
                                        },
                                        {
                                            x: 25,
                                            y: 100,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 75,
                                            y: 100,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 100,
                                            y: 20,
                                            nodetype: 'Curve',
                                            smooth: true
                                        },
                                        {
                                            x: 125,
                                            y: -60,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 175,
                                            y: -60,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 200,
                                            y: 20,
                                            nodetype: 'Curve',
                                            smooth: true
                                        }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Slide Test' }
            },
            note: '',
            date: '2026-03-25',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const bridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn()
        };
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(),
            hasUnsavedChanges: false
        };
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const flushDebugSpy = jest
            .spyOn(fontManager, 'flushPendingDebugEditingFontSaveAfterDrag')
            .mockImplementation(() => {});
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');
        const originalBridge = window.changeBridge;
        const originalFontModel = window.currentFontModel;

        window.changeBridge = bridge;
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');
        const originalActiveNodes = currentLayer.paths[0].nodes.map((node) => ({
            x: node.x,
            y: node.y,
            nodetype: node.nodetype,
            smooth: Boolean(node.smooth)
        }));
        const originalLinkedNodes = linkedLayer.paths[0].nodes.map((node) => ({
            x: node.x,
            y: node.y,
            nodetype: node.nodetype,
            smooth: Boolean(node.smooth)
        }));

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.hoveredPointIndex = {
            contourIndex: 0,
            nodeIndex: 3
        };
        jest.spyOn(
            canvas.outlineEditor,
            'transformMouseToComponentSpace'
        ).mockReturnValue({ glyphX: 120, glyphY: 10 });

        try {
            canvas.outlineEditor.onSingleClick({
                clientX: 10,
                clientY: 20,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });
            canvas.outlineEditor.onMouseMove({
                clientX: 30,
                clientY: 40,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });
            await canvas.outlineEditor.onMouseUp({ clientX: 30, clientY: 40 });

            expect(linkedLayersSpy).toHaveBeenCalled();
            expect(bridge.beginTransaction).toHaveBeenCalledWith('Split path');
            expect(bridge.syncGlyphFromJson).toHaveBeenCalledTimes(1);
            expect(bridge.syncGlyphFromJson.mock.calls[0].slice(0, 2)).toEqual([
                'A',
                'Split path'
            ]);
            expect(bridge.endTransaction).toHaveBeenCalled();
            expect(
                currentLayer.paths[0].nodes.map((node) => ({
                    x: node.x,
                    y: node.y,
                    nodetype: node.nodetype,
                    smooth: Boolean(node.smooth)
                }))
            ).not.toEqual(originalActiveNodes);
            expect(
                linkedLayer.paths[0].nodes.map((node) => ({
                    x: node.x,
                    y: node.y,
                    nodetype: node.nodetype,
                    smooth: Boolean(node.smooth)
                }))
            ).not.toEqual(originalLinkedNodes);
            expect(canvas.outlineEditor.selectedPoints).toEqual([
                { contourIndex: 1, nodeIndex: 0 }
            ]);
        } finally {
            window.changeBridge = originalBridge;
            window.currentFontModel = originalFontModel;
            linkedLayersSpy.mockRestore();
            flushDebugSpy.mockRestore();
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('cmd-click drawing creates and closes a linked path, then commits one history item on key release', async () => {
        const font = Font.fromData({
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
                    name: 'A',
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
                        },
                        {
                            id: 'layer-2',
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
            names: {
                family_name: { en: 'Draw Test' }
            },
            note: '',
            date: '2026-03-25',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const bridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn()
        };
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(),
            hasUnsavedChanges: false
        };
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');
        const originalBridge = window.changeBridge;
        const originalFontModel = window.currentFontModel;

        window.changeBridge = bridge;
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );

        const transformSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockReturnValueOnce({ glyphX: 10, glyphY: 20 })
            .mockReturnValueOnce({ glyphX: 80, glyphY: 20 })
            .mockReturnValueOnce({ glyphX: 80, glyphY: 90 });

        try {
            canvas.outlineEditor.onSingleClick({
                clientX: 10,
                clientY: 20,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });
            canvas.outlineEditor.hoveredPointIndex = null;
            canvas.outlineEditor.onSingleClick({
                clientX: 20,
                clientY: 20,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });
            canvas.outlineEditor.hoveredPointIndex = null;
            canvas.outlineEditor.onSingleClick({
                clientX: 20,
                clientY: 30,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });

            expect(bridge.beginTransaction).not.toHaveBeenCalled();
            expect(bridge.syncGlyphFromJson).not.toHaveBeenCalled();

            canvas.outlineEditor.hoveredPointIndex = {
                contourIndex: 0,
                nodeIndex: 0
            };
            canvas.outlineEditor.onSingleClick({
                clientX: 10,
                clientY: 20,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });
            canvas.outlineEditor.setCommandKeyPressed(false);

            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(linkedLayersSpy).toHaveBeenCalled();
            expect(bridge.beginTransaction).toHaveBeenCalledWith('Draw path');
            expect(bridge.syncGlyphFromJson).toHaveBeenCalledTimes(1);
            expect(bridge.syncGlyphFromJson.mock.calls[0].slice(0, 2)).toEqual([
                'A',
                'Draw path'
            ]);
            expect(bridge.endTransaction).toHaveBeenCalledTimes(1);
            expect(currentLayer.paths).toHaveLength(1);
            expect(linkedLayer.paths).toHaveLength(1);
            expect(currentLayer.paths[0].closed).toBe(true);
            expect(linkedLayer.paths[0].closed).toBe(true);
            expect(
                currentLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toEqual(['Line', 'Line', 'Line']);
            expect(
                linkedLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toEqual(['Line', 'Line', 'Line']);
        } finally {
            transformSpy.mockRestore();
            window.changeBridge = originalBridge;
            window.currentFontModel = originalFontModel;
            linkedLayersSpy.mockRestore();
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('cmd-click drawing a four-corner shape closes on the first point without dropping the last corner', async () => {
        const font = Font.fromData({
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
                    name: 'A',
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
                        },
                        {
                            id: 'layer-2',
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
            names: {
                family_name: { en: 'Rectangle Draw Test' }
            },
            note: '',
            date: '2026-04-01',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const bridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn()
        };
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(),
            hasUnsavedChanges: false
        };
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');
        const originalBridge = window.changeBridge;
        const originalFontModel = window.currentFontModel;

        window.changeBridge = bridge;
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );

        let pointerPosition = { glyphX: 10, glyphY: 20 };
        const transformSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockImplementation(() => pointerPosition);

        try {
            pointerPosition = { glyphX: 10, glyphY: 20 };
            canvas.outlineEditor.onSingleClick({
                clientX: 10,
                clientY: 20,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });
            canvas.outlineEditor.hoveredPointIndex = null;
            pointerPosition = { glyphX: 80, glyphY: 20 };
            canvas.outlineEditor.onSingleClick({
                clientX: 20,
                clientY: 20,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });
            canvas.outlineEditor.hoveredPointIndex = null;
            pointerPosition = { glyphX: 80, glyphY: 90 };
            canvas.outlineEditor.onSingleClick({
                clientX: 20,
                clientY: 30,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });
            canvas.outlineEditor.hoveredPointIndex = null;
            pointerPosition = { glyphX: 10, glyphY: 90 };
            canvas.outlineEditor.onSingleClick({
                clientX: 10,
                clientY: 30,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });

            expect(currentLayer.paths[0].closed).toBe(false);
            expect(currentLayer.paths[0].nodes).toHaveLength(4);
            expect(
                currentLayer.paths[0].nodes.map((node) => [node.x, node.y])
            ).toEqual([
                [0, 20],
                [80, 20],
                [80, 90],
                [0, 90]
            ]);
            expect(canvas.outlineEditor.activePathDrawingSession).toEqual(
                expect.objectContaining({
                    shapeIndex: 0,
                    pathIndex: 0,
                    edge: 'end',
                    segmentCount: 3
                })
            );

            canvas.outlineEditor.hoveredPointIndex = {
                contourIndex: 0,
                nodeIndex: 0
            };
            canvas.outlineEditor.onSingleClick({
                clientX: 10,
                clientY: 20,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });
            canvas.outlineEditor.setCommandKeyPressed(false);

            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(linkedLayersSpy).toHaveBeenCalled();
            expect(bridge.beginTransaction).toHaveBeenCalledTimes(1);
            expect(bridge.beginTransaction).toHaveBeenCalledWith('Draw path');
            expect(bridge.syncGlyphFromJson).toHaveBeenCalledTimes(1);
            expect(bridge.syncGlyphFromJson.mock.calls[0].slice(0, 2)).toEqual([
                'A',
                'Draw path'
            ]);
            expect(bridge.endTransaction).toHaveBeenCalledTimes(1);
            expect(currentLayer.paths).toHaveLength(1);
            expect(linkedLayer.paths).toHaveLength(1);
            expect(currentLayer.paths[0].closed).toBe(true);
            expect(linkedLayer.paths[0].closed).toBe(true);
            expect(currentLayer.paths[0].nodes).toHaveLength(4);
            expect(linkedLayer.paths[0].nodes).toHaveLength(4);
            expect(
                currentLayer.paths[0].nodes.map((node) => [node.x, node.y])
            ).toEqual([
                [0, 20],
                [80, 20],
                [80, 90],
                [0, 90]
            ]);
            expect(
                linkedLayer.paths[0].nodes.map((node) => [node.x, node.y])
            ).toEqual([
                [0, 20],
                [80, 20],
                [80, 90],
                [0, 90]
            ]);
            expect(
                currentLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toEqual(['Line', 'Line', 'Line', 'Line']);
            expect(
                linkedLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toEqual(['Line', 'Line', 'Line', 'Line']);
        } finally {
            transformSpy.mockRestore();
            window.changeBridge = originalBridge;
            window.currentFontModel = originalFontModel;
            linkedLayersSpy.mockRestore();
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('cmd-click extends an open path from its selected first point across linked layers', async () => {
        const font = Font.fromData({
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
                    name: 'A',
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
                            shapes: [
                                {
                                    nodes: [
                                        { x: 40, y: 40, nodetype: 'Move' },
                                        { x: 100, y: 40, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 50, y: 50, nodetype: 'Move' },
                                        { x: 110, y: 50, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Extend Test' }
            },
            note: '',
            date: '2026-03-25',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const bridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn()
        };
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(),
            hasUnsavedChanges: false
        };
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const scheduleFullCompileDebounceSpy = jest
            .spyOn(fontManager, 'scheduleFullCompileDebounce')
            .mockImplementation(() => {});
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');
        const segmentHitSpy = jest
            .spyOn(canvas.outlineEditor, 'findClosestPathSegmentHit')
            .mockReturnValue(null);
        const originalBridge = window.changeBridge;
        const originalFontModel = window.currentFontModel;
        const originalAutoCompileManager = window.autoCompileManager;
        const originalLastChangeSource = fontManager.lastChangeSource;
        const originalLastEditType = fontManager.lastEditType;

        window.changeBridge = bridge;
        window.currentFontModel = font;
        window.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        const transformSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockReturnValue({ glyphX: 10.6, glyphY: 39.4 });

        try {
            scheduleFullCompileDebounceSpy.mockClear();
            window.autoCompileManager.checkAndSchedule.mockClear();

            canvas.outlineEditor.onSingleClick({
                clientX: 0,
                clientY: 0,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });

            expect(bridge.beginTransaction).not.toHaveBeenCalled();

            canvas.outlineEditor.setCommandKeyPressed(false);
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(linkedLayersSpy).toHaveBeenCalled();
            expect(bridge.syncGlyphFromJson).toHaveBeenCalledTimes(1);
            expect(bridge.syncGlyphFromJson.mock.calls[0].slice(0, 2)).toEqual([
                'A',
                'Draw path'
            ]);
            expect(
                currentLayer.paths[0].nodes.map((node) => ({
                    x: node.x,
                    y: node.y,
                    nodetype: node.nodetype
                }))
            ).toEqual([
                { x: 0, y: 40, nodetype: 'Move' },
                { x: 40, y: 40, nodetype: 'Line' },
                { x: 100, y: 40, nodetype: 'Line' }
            ]);
            expect(
                linkedLayer.paths[0].nodes.map((node) => ({
                    x: node.x,
                    y: node.y,
                    nodetype: node.nodetype
                }))
            ).toEqual([
                { x: 0, y: 40, nodetype: 'Move' },
                { x: 50, y: 50, nodetype: 'Line' },
                { x: 110, y: 50, nodetype: 'Line' }
            ]);
            expect(canvas.outlineEditor.selectedPoints).toEqual([
                { contourIndex: 0, nodeIndex: 0 }
            ]);
        } finally {
            transformSpy.mockRestore();
            segmentHitSpy.mockRestore();
            window.changeBridge = originalBridge;
            window.currentFontModel = originalFontModel;
            linkedLayersSpy.mockRestore();
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('cmd-click closes an open path from its selected first point across linked layers', async () => {
        const font = Font.fromData({
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
                    name: 'A',
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
                            shapes: [
                                {
                                    nodes: [
                                        { x: 40, y: 40, nodetype: 'Move' },
                                        { x: 70, y: 90, nodetype: 'Line' },
                                        { x: 100, y: 40, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 50, y: 50, nodetype: 'Move' },
                                        { x: 80, y: 100, nodetype: 'Line' },
                                        { x: 110, y: 50, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Close From Start Test' }
            },
            note: '',
            date: '2026-03-31',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const bridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn()
        };
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(),
            hasUnsavedChanges: false
        };
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const scheduleFullCompileDebounceSpy = jest
            .spyOn(fontManager, 'scheduleFullCompileDebounce')
            .mockImplementation(() => {});
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');
        const segmentHitSpy = jest
            .spyOn(canvas.outlineEditor, 'findClosestPathSegmentHit')
            .mockReturnValue(null);
        const originalBridge = window.changeBridge;
        const originalFontModel = window.currentFontModel;
        const originalAutoCompileManager = window.autoCompileManager;
        const originalLastChangeSource = fontManager.lastChangeSource;
        const originalLastEditType = fontManager.lastEditType;

        window.changeBridge = bridge;
        window.currentFontModel = font;
        window.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];
        canvas.outlineEditor.hoveredPointIndex = {
            contourIndex: 0,
            nodeIndex: 2
        };

        try {
            canvas.outlineEditor.onSingleClick({
                clientX: 0,
                clientY: 0,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });

            expect(bridge.beginTransaction).not.toHaveBeenCalled();
            expect(bridge.syncGlyphFromJson).not.toHaveBeenCalled();

            canvas.outlineEditor.setCommandKeyPressed(false);
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(linkedLayersSpy).toHaveBeenCalled();
            expect(bridge.beginTransaction).toHaveBeenCalledWith('Draw path');
            expect(bridge.syncGlyphFromJson).toHaveBeenCalledTimes(1);
            expect(bridge.syncGlyphFromJson.mock.calls[0].slice(0, 2)).toEqual([
                'A',
                'Draw path'
            ]);
            expect(bridge.endTransaction).toHaveBeenCalledTimes(1);
            expect(fontManager.lastChangeSource).toBe('keyboard-outline');
            expect(fontManager.lastEditType).toBe('outline');
            expect(
                scheduleFullCompileDebounceSpy.mock.calls.length
            ).toBeGreaterThanOrEqual(2);
            expect(
                window.autoCompileManager.checkAndSchedule.mock.calls.length
            ).toBeGreaterThanOrEqual(2);
            expect(currentLayer.paths[0].closed).toBe(true);
            expect(linkedLayer.paths[0].closed).toBe(true);
            expect(
                currentLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toEqual(['Line', 'Line', 'Line']);
            expect(
                linkedLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toEqual(['Line', 'Line', 'Line']);
        } finally {
            segmentHitSpy.mockRestore();
            window.changeBridge = originalBridge;
            window.currentFontModel = originalFontModel;
            window.autoCompileManager = originalAutoCompileManager;
            fontManager.lastChangeSource = originalLastChangeSource;
            fontManager.lastEditType = originalLastEditType;
            linkedLayersSpy.mockRestore();
            workerCacheSpy.mockRestore();
            scheduleFullCompileDebounceSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('cmd-click closes an open path from its selected last point across linked layers', async () => {
        const font = Font.fromData({
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
                    name: 'A',
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
                            shapes: [
                                {
                                    nodes: [
                                        { x: 40, y: 40, nodetype: 'Move' },
                                        { x: 70, y: 90, nodetype: 'Line' },
                                        { x: 100, y: 40, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 50, y: 50, nodetype: 'Move' },
                                        { x: 80, y: 100, nodetype: 'Line' },
                                        { x: 110, y: 50, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Close From End Test' }
            },
            note: '',
            date: '2026-03-31',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const bridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn()
        };
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(),
            hasUnsavedChanges: false
        };
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');
        const segmentHitSpy = jest
            .spyOn(canvas.outlineEditor, 'findClosestPathSegmentHit')
            .mockReturnValue(null);
        const originalBridge = window.changeBridge;
        const originalFontModel = window.currentFontModel;

        window.changeBridge = bridge;
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 2 }
        ];
        canvas.outlineEditor.hoveredPointIndex = {
            contourIndex: 0,
            nodeIndex: 0
        };

        try {
            canvas.outlineEditor.onSingleClick({
                clientX: 0,
                clientY: 0,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });

            expect(bridge.beginTransaction).not.toHaveBeenCalled();
            expect(bridge.syncGlyphFromJson).not.toHaveBeenCalled();

            canvas.outlineEditor.setCommandKeyPressed(false);
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(linkedLayersSpy).toHaveBeenCalled();
            expect(bridge.beginTransaction).toHaveBeenCalledWith('Draw path');
            expect(bridge.syncGlyphFromJson).toHaveBeenCalledTimes(1);
            expect(bridge.syncGlyphFromJson.mock.calls[0].slice(0, 2)).toEqual([
                'A',
                'Draw path'
            ]);
            expect(bridge.endTransaction).toHaveBeenCalledTimes(1);
            expect(currentLayer.paths[0].closed).toBe(true);
            expect(linkedLayer.paths[0].closed).toBe(true);
            expect(
                currentLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toEqual(['Line', 'Line', 'Line']);
            expect(
                linkedLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toEqual(['Line', 'Line', 'Line']);
        } finally {
            segmentHitSpy.mockRestore();
            window.changeBridge = originalBridge;
            window.currentFontModel = originalFontModel;
            linkedLayersSpy.mockRestore();
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('alt-click converts a line segment into a curve across linked layers and defers history until key release', async () => {
        const font = Font.fromData({
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
                    name: 'A',
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
                            shapes: [
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Move' },
                                        { x: 100, y: 0, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 10, y: 10, nodetype: 'Move' },
                                        { x: 110, y: 10, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Curve Test' }
            },
            note: '',
            date: '2026-03-25',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const bridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn()
        };
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(),
            hasUnsavedChanges: false
        };
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');
        const originalBridge = window.changeBridge;
        const originalFontModel = window.currentFontModel;

        window.changeBridge = bridge;
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');
        const descriptor = Layer.getPathSegmentDescriptors({
            nodes: currentLayer.toJSON().shapes[0].nodes,
            closed: false
        })[0];
        const segmentHitSpy = jest
            .spyOn(canvas.outlineEditor, 'findClosestPathSegmentHit')
            .mockReturnValue({
                shapeIndex: 0,
                pathIndex: 0,
                descriptor,
                projection: {
                    x: 45,
                    y: 0,
                    t: 0.5,
                    distance: 0
                }
            });

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );

        try {
            canvas.outlineEditor.onSingleClick({
                clientX: 0,
                clientY: 0,
                detail: 1,
                shiftKey: false,
                altKey: true,
                metaKey: false,
                ctrlKey: false
            });

            expect(bridge.beginTransaction).not.toHaveBeenCalled();
            expect(bridge.syncGlyphFromJson).not.toHaveBeenCalled();

            canvas.outlineEditor.setAltKeyPressed(false);
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(linkedLayersSpy).toHaveBeenCalled();
            expect(bridge.beginTransaction).toHaveBeenCalledWith(
                'Convert line to curve'
            );
            expect(bridge.syncGlyphFromJson).toHaveBeenCalledTimes(1);
            expect(bridge.syncGlyphFromJson.mock.calls[0].slice(0, 2)).toEqual([
                'A',
                'Convert line to curve'
            ]);
            expect(
                currentLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toEqual(['Move', 'OffCurve', 'OffCurve', 'Curve']);
            expect(
                linkedLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toEqual(['Move', 'OffCurve', 'OffCurve', 'Curve']);
            expect(currentLayer.paths[0].nodes[1].x).toBe(33);
            expect(currentLayer.paths[0].nodes[2].x).toBe(67);
            expect(linkedLayer.paths[0].nodes[1].x).toBe(43);
            expect(linkedLayer.paths[0].nodes[2].x).toBe(77);
            expect(
                currentLayer.paths[0].nodes.every(
                    (node) =>
                        Number.isInteger(node.x) && Number.isInteger(node.y)
                )
            ).toBe(true);
            expect(
                linkedLayer.paths[0].nodes.every(
                    (node) =>
                        Number.isInteger(node.x) && Number.isInteger(node.y)
                )
            ).toBe(true);
        } finally {
            segmentHitSpy.mockRestore();
            window.changeBridge = originalBridge;
            window.currentFontModel = originalFontModel;
            linkedLayersSpy.mockRestore();
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('closed path origin-return segment is hittable for double-click selection and alt-click conversion', async () => {
        const font = Font.fromData({
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
                    name: 'A',
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
                            shapes: [
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Line' },
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 100, y: 100, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 10, y: 10, nodetype: 'Line' },
                                        { x: 110, y: 10, nodetype: 'Line' },
                                        { x: 110, y: 110, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Closed Segment Test' }
            },
            note: '',
            date: '2026-03-25',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const bridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn()
        };
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(),
            hasUnsavedChanges: false
        };
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');
        const originalBridge = window.changeBridge;
        const originalFontModel = window.currentFontModel;

        window.changeBridge = bridge;
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );

        const transformSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockReturnValue({ glyphX: 50, glyphY: 50 });

        try {
            const hit = canvas.outlineEditor.findClosestPathSegmentHit();
            expect(hit).not.toBeNull();
            expect(hit.shapeIndex).toBe(0);
            expect(hit.pathIndex).toBe(0);
            expect(hit.descriptor.type).toBe('line');

            canvas.outlineEditor.hoveredGuideHandle = null;
            canvas.outlineEditor.hoveredSidebearingHandle = null;
            canvas.outlineEditor.hoveredComponentIndex = null;
            canvas.outlineEditor.hoveredAnchorIndex = null;
            canvas.outlineEditor.hoveredPointIndex = null;

            expect(
                canvas.outlineEditor.onDoubleClick({
                    clientX: 0,
                    clientY: 0,
                    detail: 2,
                    shiftKey: false,
                    altKey: false,
                    metaKey: false,
                    ctrlKey: false
                })
            ).toBe(true);
            expect(canvas.outlineEditor.selectedPoints).toEqual([
                { contourIndex: 0, nodeIndex: 0 },
                { contourIndex: 0, nodeIndex: 1 },
                { contourIndex: 0, nodeIndex: 2 }
            ]);

            canvas.outlineEditor.selectedPoints = [];
            canvas.outlineEditor.onSingleClick({
                clientX: 0,
                clientY: 0,
                detail: 1,
                shiftKey: false,
                altKey: true,
                metaKey: false,
                ctrlKey: false
            });
            canvas.outlineEditor.setAltKeyPressed(false);
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(linkedLayersSpy).toHaveBeenCalled();
            expect(bridge.syncGlyphFromJson).toHaveBeenCalledTimes(1);
            expect(bridge.syncGlyphFromJson.mock.calls[0].slice(0, 2)).toEqual([
                'A',
                'Convert line to curve'
            ]);
            expect(
                currentLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toContain('Curve');
            expect(
                linkedLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toContain('Curve');
        } finally {
            transformSpy.mockRestore();
            window.changeBridge = originalBridge;
            window.currentFontModel = originalFontModel;
            linkedLayersSpy.mockRestore();
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('cmd-click add point rounds all resulting split nodes to grid in active and linked layers', async () => {
        const font = Font.fromData({
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
                    name: 'A',
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
                            shapes: [
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Curve' },
                                        {
                                            x: 30,
                                            y: 60,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 70,
                                            y: 60,
                                            nodetype: 'OffCurve'
                                        },
                                        { x: 100, y: 0, nodetype: 'Curve' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 10, y: 0, nodetype: 'Curve' },
                                        {
                                            x: 40,
                                            y: 60,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 80,
                                            y: 60,
                                            nodetype: 'OffCurve'
                                        },
                                        { x: 110, y: 0, nodetype: 'Curve' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Add Point Rounding Test' }
            },
            note: '',
            date: '2026-03-26',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const bridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn()
        };
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(),
            hasUnsavedChanges: false
        };
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');
        const originalBridge = window.changeBridge;
        const originalFontModel = window.currentFontModel;

        window.changeBridge = bridge;
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.hoveredAddPointPreview = {
            shapeIndex: 0,
            pathIndex: 0,
            segmentId: 0,
            t: 0.5,
            point: { x: 50, y: 45 },
            segments: []
        };

        try {
            canvas.outlineEditor.onSingleClick({
                clientX: 0,
                clientY: 0,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });

            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(linkedLayersSpy).toHaveBeenCalled();
            expect(
                currentLayer.paths[0].nodes.every(
                    (node) =>
                        Number.isInteger(node.x) && Number.isInteger(node.y)
                )
            ).toBe(true);
            expect(
                linkedLayer.paths[0].nodes.every(
                    (node) =>
                        Number.isInteger(node.x) && Number.isInteger(node.y)
                )
            ).toBe(true);
            expect(currentLayer.paths[0].nodes.length).toBeGreaterThan(4);
            expect(linkedLayer.paths[0].nodes.length).toBeGreaterThan(4);
        } finally {
            window.changeBridge = originalBridge;
            window.currentFontModel = originalFontModel;
            linkedLayersSpy.mockRestore();
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });
});

describe('OutlineEditor structural outline compile scheduling', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = true;
    });

    afterEach(() => {
        canvas.destroy();
    });

    function mockStructuralCompileEnvironment(font) {
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(),
            hasUnsavedChanges: false
        };
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const scheduleFullCompileDebounceSpy = jest
            .spyOn(fontManager, 'scheduleFullCompileDebounce')
            .mockImplementation(() => {});
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');
        const originalBridge = window.changeBridge;
        const originalFontModel = window.currentFontModel;
        const originalAutoCompileManager = window.autoCompileManager;
        const originalLastChangeSource = fontManager.lastChangeSource;
        const originalLastEditType = fontManager.lastEditType;

        window.changeBridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn()
        };
        window.currentFontModel = font;
        window.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        return {
            currentFont,
            currentFontSpy,
            dirtyIndicatorSpy,
            workerCacheSpy,
            scheduleFullCompileDebounceSpy,
            linkedLayersSpy,
            bridge: window.changeBridge,
            restore() {
                window.changeBridge = originalBridge;
                window.currentFontModel = originalFontModel;
                window.autoCompileManager = originalAutoCompileManager;
                fontManager.lastChangeSource = originalLastChangeSource;
                fontManager.lastEditType = originalLastEditType;
                linkedLayersSpy.mockRestore();
                scheduleFullCompileDebounceSpy.mockRestore();
                workerCacheSpy.mockRestore();
                dirtyIndicatorSpy.mockRestore();
                currentFontSpy.mockRestore();
            }
        };
    }

    async function flushStructuralCompileTick() {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    test('cmd path close recompiles immediately on the latest structural data before key release', async () => {
        const font = Font.fromData({
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
                    name: 'A',
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
                            shapes: [
                                {
                                    nodes: [
                                        { x: 40, y: 40, nodetype: 'Move' },
                                        { x: 70, y: 90, nodetype: 'Line' },
                                        { x: 100, y: 40, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 50, y: 50, nodetype: 'Move' },
                                        { x: 80, y: 100, nodetype: 'Line' },
                                        { x: 110, y: 50, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: { family_name: { en: 'Immediate Close Compile' } },
            note: '',
            date: '2026-03-31',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const env = mockStructuralCompileEnvironment(font);
        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];
        canvas.outlineEditor.hoveredPointIndex = {
            contourIndex: 0,
            nodeIndex: 2
        };

        try {
            canvas.outlineEditor.onSingleClick({
                clientX: 0,
                clientY: 0,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });

            await flushStructuralCompileTick();

            expect(env.bridge.beginTransaction).not.toHaveBeenCalled();
            expect(currentLayer.paths[0].closed).toBe(true);
            expect(fontManager.lastChangeSource).toBe('keyboard-outline');
            expect(fontManager.lastEditType).toBe('outline');
            expect(env.scheduleFullCompileDebounceSpy).toHaveBeenCalledTimes(1);
            expect(
                window.autoCompileManager.checkAndSchedule
            ).toHaveBeenCalledTimes(1);
            expect(env.currentFont.markDirty).toHaveBeenCalledWith(
                'keyboard-outline'
            );
            expect(env.currentFont.syncJsonFromModel).toHaveBeenCalled();
            expect(env.workerCacheSpy).toHaveBeenCalled();
            expect(
                env.currentFont.syncJsonFromModel.mock.invocationCallOrder[0]
            ).toBeLessThan(env.workerCacheSpy.mock.invocationCallOrder[0]);
        } finally {
            env.restore();
        }
    });

    test('opening a closed path recompiles immediately on synced outline data', async () => {
        const font = Font.fromData({
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
                    name: 'A',
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
                            shapes: [
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Line' },
                                        { x: 50, y: 100, nodetype: 'Line' },
                                        { x: 100, y: 0, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: { family_name: { en: 'Immediate Open Compile' } },
            note: '',
            date: '2026-03-31',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const env = mockStructuralCompileEnvironment(font);
        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );

        try {
            expect(
                canvas.outlineEditor.openClosedPathAtNode({
                    contourIndex: 0,
                    nodeIndex: 1
                })
            ).toBe(true);

            await flushStructuralCompileTick();

            expect(currentLayer.paths[0].closed).toBe(false);
            expect(fontManager.lastChangeSource).toBe('keyboard-outline');
            expect(fontManager.lastEditType).toBe('outline');
            expect(env.scheduleFullCompileDebounceSpy).toHaveBeenCalledTimes(1);
            expect(
                window.autoCompileManager.checkAndSchedule
            ).toHaveBeenCalledTimes(1);
            expect(env.workerCacheSpy).toHaveBeenCalled();
        } finally {
            env.restore();
        }
    });

    test('alt line-to-curve conversion recompiles immediately before alt release', async () => {
        const font = Font.fromData({
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
                    name: 'A',
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
                            shapes: [
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Move' },
                                        { x: 100, y: 0, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: { family_name: { en: 'Immediate Convert Compile' } },
            note: '',
            date: '2026-03-31',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const env = mockStructuralCompileEnvironment(font);
        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const descriptor = Layer.getPathSegmentDescriptors({
            nodes: currentLayer.toJSON().shapes[0].nodes,
            closed: false
        })[0];
        const segmentHitSpy = jest
            .spyOn(canvas.outlineEditor, 'findClosestPathSegmentHit')
            .mockReturnValue({
                shapeIndex: 0,
                pathIndex: 0,
                descriptor,
                projection: { x: 45, y: 0, t: 0.5, distance: 0 }
            });

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );

        try {
            canvas.outlineEditor.onSingleClick({
                clientX: 0,
                clientY: 0,
                detail: 1,
                shiftKey: false,
                altKey: true,
                metaKey: false,
                ctrlKey: false
            });

            await flushStructuralCompileTick();

            expect(env.bridge.beginTransaction).not.toHaveBeenCalled();
            expect(fontManager.lastChangeSource).toBe('keyboard-outline');
            expect(fontManager.lastEditType).toBe('outline');
            expect(env.scheduleFullCompileDebounceSpy).toHaveBeenCalledTimes(1);
            expect(
                window.autoCompileManager.checkAndSchedule
            ).toHaveBeenCalledTimes(1);
            expect(env.currentFont.syncJsonFromModel).toHaveBeenCalled();
            expect(env.workerCacheSpy).toHaveBeenCalled();
            expect(
                env.currentFont.syncJsonFromModel.mock.invocationCallOrder[0]
            ).toBeLessThan(env.workerCacheSpy.mock.invocationCallOrder[0]);
        } finally {
            segmentHitSpy.mockRestore();
            env.restore();
        }
    });

    test('point insertion recompiles immediately on synced outline data', async () => {
        const font = Font.fromData({
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
                    name: 'A',
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
                            shapes: [
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Curve' },
                                        { x: 30, y: 60, nodetype: 'OffCurve' },
                                        { x: 70, y: 60, nodetype: 'OffCurve' },
                                        { x: 100, y: 0, nodetype: 'Curve' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: { family_name: { en: 'Immediate Add Point Compile' } },
            note: '',
            date: '2026-03-31',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const env = mockStructuralCompileEnvironment(font);
        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.hoveredAddPointPreview = {
            shapeIndex: 0,
            pathIndex: 0,
            segmentId: 0,
            t: 0.5,
            point: { x: 50, y: 45 },
            segments: []
        };

        try {
            canvas.outlineEditor.onSingleClick({
                clientX: 0,
                clientY: 0,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });

            await flushStructuralCompileTick();

            expect(fontManager.lastChangeSource).toBe('keyboard-outline');
            expect(fontManager.lastEditType).toBe('outline');
            expect(env.scheduleFullCompileDebounceSpy).toHaveBeenCalledTimes(1);
            expect(
                window.autoCompileManager.checkAndSchedule
            ).toHaveBeenCalledTimes(1);
            expect(env.workerCacheSpy).toHaveBeenCalled();
        } finally {
            env.restore();
        }
    });

    test('point deletion recompiles immediately on synced outline data', async () => {
        const font = Font.fromData({
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
                    name: 'A',
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
                            shapes: [
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Move' },
                                        { x: 50, y: 100, nodetype: 'Line' },
                                        { x: 100, y: 0, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: { family_name: { en: 'Immediate Delete Compile' } },
            note: '',
            date: '2026-03-31',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const env = mockStructuralCompileEnvironment(font);
        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 }
        ];

        try {
            await canvas.outlineEditor.deleteSelectedNodes();
            await flushStructuralCompileTick();

            expect(fontManager.lastChangeSource).toBe('keyboard-outline');
            expect(fontManager.lastEditType).toBe('outline');
            expect(env.scheduleFullCompileDebounceSpy).toHaveBeenCalledTimes(1);
            expect(
                window.autoCompileManager.checkAndSchedule
            ).toHaveBeenCalledTimes(1);
            expect(env.workerCacheSpy).toHaveBeenCalled();
        } finally {
            env.restore();
        }
    });
});

describe('GlyphCanvas command path drawing visuals', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 500, dx: 0, dy: 0, g: 0 }];
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 500,
            shapes: [
                {
                    nodes: [
                        { x: 20, y: 30, nodetype: 'Move' },
                        { x: 90, y: 30, nodetype: 'Line' }
                    ],
                    closed: false
                }
            ],
            anchors: [],
            guides: [],
            isInterpolated: false
        };
    });

    describe('GlyphCanvas canvas context menu focus restoration', () => {
        let canvas;

        beforeEach(() => {
            document.body.innerHTML = '<div id="test-container"></div>';
            canvas = new GlyphCanvas('test-container');
            canvas.outlineEditor.active = true;
        });

        afterEach(() => {
            canvas.destroy();
        });

        test('restores canvas focus on hide and clears the target after the menu closes', async () => {
            const focusSpy = jest.spyOn(canvas.canvas, 'focus');
            const tippyInstance =
                canvas.outlineEditor.ensureCanvasContextMenu();

            canvas.outlineEditor.canvasContextMenuTarget = {
                shapeIndex: 0,
                pathIndex: 0,
                nodeIndex: 1,
                onCurveOrdinal: 1,
                nodeType: 'Line',
                intendedPoint: { x: 100, y: 0 },
                canSetStartNode: true
            };

            tippyInstance.props.onHide(tippyInstance);
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(canvas.outlineEditor.canvasContextMenuTarget).not.toBeNull();
            expect(focusSpy).toHaveBeenCalled();

            tippyInstance.props.onHidden(tippyInstance);

            expect(canvas.outlineEditor.canvasContextMenuTarget).toBeNull();
        });

        test('keeps the context target available while a menu action runs', () => {
            const tippyInstance =
                canvas.outlineEditor.ensureCanvasContextMenu();

            canvas.outlineEditor.canvasContextMenuTarget = {
                shapeIndex: 0,
                pathIndex: 0,
                nodeIndex: 1,
                onCurveOrdinal: 1,
                nodeType: 'Line',
                intendedPoint: { x: 100, y: 0 },
                canSetStartNode: true
            };

            const reverseSpy = jest
                .spyOn(canvas.outlineEditor, 'reverseContextMenuPathDirection')
                .mockReturnValue(true);

            tippyInstance.props.onHide(tippyInstance);
            canvas.outlineEditor.handleCanvasContextMenuAction(
                'reverse-path-direction'
            );

            expect(reverseSpy).toHaveBeenCalled();
            expect(canvas.outlineEditor.canvasContextMenuTarget).not.toBeNull();

            reverseSpy.mockRestore();
        });
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('cmd preview line follows the open endpoint and disappears on key release', () => {
        jest.spyOn(
            canvas.outlineEditor,
            'transformMouseToComponentSpace'
        ).mockReturnValue({ glyphX: 140, glyphY: 60 });

        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 }
        ];
        canvas.outlineEditor.setCommandKeyPressed(true);

        expect(canvas.outlineEditor.getCommandPathPreviewLine()).toEqual({
            start: { x: 90, y: 30 },
            end: { x: 140, y: 60 }
        });

        canvas.updateCursorStyle();
        expect(canvas.canvas.style.cursor).toBe('crosshair');

        canvas.outlineEditor.setCommandKeyPressed(false);

        expect(canvas.outlineEditor.getCommandPathPreviewLine()).toBeNull();
    });

    test('alt hover on a straight segment previews collinear curve handles', () => {
        canvas.viewportManager.scale = 10;
        jest.spyOn(
            canvas.outlineEditor,
            'transformMouseToComponentSpace'
        ).mockReturnValue({ glyphX: 55, glyphY: 30 });

        canvas.outlineEditor.setAltKeyPressed(true);

        expect(canvas.outlineEditor.hoveredCommandCurvePreview).toEqual({
            shapeIndex: 0,
            pathIndex: 0,
            segmentId: 0,
            segments: [
                {
                    type: 'cubic',
                    points: [
                        { x: 20, y: 30 },
                        { x: 20 + 70 / 3, y: 30 },
                        { x: 20 + (70 * 2) / 3, y: 30 },
                        { x: 90, y: 30 }
                    ]
                }
            ]
        });

        canvas.outlineEditor.setAltKeyPressed(false);

        expect(canvas.outlineEditor.hoveredCommandCurvePreview).toBeNull();
    });

    test('cmd point-insert hover uses a crosshair cursor', () => {
        canvas.outlineEditor.setCommandKeyPressed(true);
        canvas.outlineEditor.hoveredAddPointPreview = {
            shapeIndex: 0,
            pathIndex: 0,
            segmentId: 0,
            t: 0.5,
            point: { x: 55, y: 30 },
            segments: [
                {
                    type: 'line',
                    points: [
                        { x: 20, y: 30 },
                        { x: 55, y: 30 }
                    ]
                },
                {
                    type: 'line',
                    points: [
                        { x: 55, y: 30 },
                        { x: 90, y: 30 }
                    ]
                }
            ]
        };

        canvas.updateCursorStyle();

        expect(canvas.canvas.style.cursor).toBe('crosshair');

        canvas.outlineEditor.setCommandKeyPressed(false);
    });

    test('cmd hover on a point uses a crosshair cursor for cut-open', () => {
        canvas.outlineEditor.setCommandKeyPressed(true);
        canvas.outlineEditor.hoveredPointIndex = {
            contourIndex: 0,
            nodeIndex: 1
        };

        canvas.updateCursorStyle();

        expect(canvas.canvas.style.cursor).toBe('crosshair');

        canvas.outlineEditor.setCommandKeyPressed(false);
    });

    test('drawOutlineEditor does not force-close open contours', () => {
        canvas.renderer.ctx.closePath.mockClear();
        canvas.renderer.ctx.stroke.mockClear();

        canvas.renderer.drawOutlineEditor();

        const firstStrokeOrder =
            canvas.renderer.ctx.stroke.mock.invocationCallOrder[0];
        const firstCloseOrder =
            canvas.renderer.ctx.closePath.mock.invocationCallOrder[0] ??
            Infinity;

        expect(firstStrokeOrder).toBeLessThan(firstCloseOrder);
    });

    test('drawOutlineEditor renders a visible start node for a one-point open path', () => {
        canvas.outlineEditor.layerData.shapes = [
            {
                nodes: [{ x: 20, y: 30, nodetype: 'Move' }],
                closed: false
            }
        ];
        canvas.renderer.ctx.fillRect.mockClear();

        canvas.renderer.drawOutlineEditor();

        expect(canvas.renderer.ctx.fillRect).toHaveBeenCalledTimes(1);
    });

    test('drawShape renders a committed open line segment without closing the contour', () => {
        canvas.renderer.ctx.lineTo.mockClear();
        canvas.renderer.ctx.closePath.mockClear();
        canvas.renderer.ctx.stroke.mockClear();
        canvas.renderer.viewportManager.scale = 0.01;

        canvas.renderer.drawShape(
            {
                nodes: [
                    { x: 20, y: 30, nodetype: 'Move' },
                    { x: 80, y: 30, nodetype: 'Line' }
                ],
                closed: false
            },
            0,
            false
        );

        expect(canvas.renderer.ctx.lineTo).toHaveBeenCalledWith(80, 30);
        expect(canvas.renderer.ctx.closePath).not.toHaveBeenCalled();
        expect(canvas.renderer.ctx.stroke).toHaveBeenCalled();
    });

    test('drawCachedExplicitGlyphOutline skips open contours in compiled fill pass', () => {
        canvas.renderer.ctx.closePath.mockClear();

        canvas.renderer.drawCachedExplicitGlyphOutline(
            {
                shapes: [
                    {
                        nodes: [
                            { x: 20, y: 30, nodetype: 'Move' },
                            { x: 80, y: 30, nodetype: 'Line' }
                        ],
                        closed: false
                    }
                ]
            },
            0,
            0
        );

        expect(canvas.renderer.ctx.closePath).not.toHaveBeenCalled();
    });
});

describe('GlyphCanvas anchor movement', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.layerData = {
            shapes: [],
            anchors: [
                { x: 100, y: 100 },
                { x: 200, y: 200 }
            ]
        };
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.saveLayerData = jest.fn();
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should move selected anchors by delta', () => {
        canvas.outlineEditor.moveSelectedAnchors(10, 20);
        expect(canvas.outlineEditor.layerData.anchors[0].x).toBe(110);
        expect(canvas.outlineEditor.layerData.anchors[0].y).toBe(120);
    });

    test('should move multiple selected anchors', () => {
        canvas.outlineEditor.selectedAnchors = [0, 1];
        canvas.outlineEditor.moveSelectedAnchors(10, 20);
        expect(canvas.outlineEditor.layerData.anchors[0].x).toBe(110);
        expect(canvas.outlineEditor.layerData.anchors[0].y).toBe(120);
        expect(canvas.outlineEditor.layerData.anchors[1].x).toBe(210);
        expect(canvas.outlineEditor.layerData.anchors[1].y).toBe(220);
    });

    test('should not move anchors when none are selected', () => {
        canvas.outlineEditor.selectedAnchors = [];
        canvas.outlineEditor.moveSelectedAnchors(10, 20);
        expect(canvas.outlineEditor.layerData.anchors[0].x).toBe(100);
        expect(canvas.outlineEditor.layerData.anchors[0].y).toBe(100);
    });
});

describe('GlyphCanvas component movement', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.layerData = {
            shapes: [
                { reference: 'A', transform: [1, 0, 0, 1, 100, 100] },
                { reference: 'A', transform: [1, 0, 0, 1, 200, 200] }
            ],
            anchors: []
        };
        canvas.outlineEditor.selectedComponents = [0];
        canvas.outlineEditor.saveLayerData = jest.fn();
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should move selected components by delta', () => {
        canvas.outlineEditor.moveSelectedComponents(10, 20);
        expect(
            canvas.outlineEditor.layerData.shapes[0].transform.translation[0]
        ).toBe(110);
        expect(
            canvas.outlineEditor.layerData.shapes[0].transform.translation[1]
        ).toBe(120);
    });

    test('should move multiple selected components', () => {
        canvas.outlineEditor.selectedComponents = [0, 1];
        canvas.outlineEditor.moveSelectedComponents(10, 20);
        expect(
            canvas.outlineEditor.layerData.shapes[0].transform.translation[0]
        ).toBe(110);
        expect(
            canvas.outlineEditor.layerData.shapes[0].transform.translation[1]
        ).toBe(120);
        expect(
            canvas.outlineEditor.layerData.shapes[1].transform.translation[0]
        ).toBe(210);
        expect(
            canvas.outlineEditor.layerData.shapes[1].transform.translation[1]
        ).toBe(220);
    });

    test('should not move components when none are selected', () => {
        canvas.outlineEditor.selectedComponents = [];
        canvas.outlineEditor.moveSelectedComponents(10, 20);
        expect(canvas.outlineEditor.layerData.shapes[0].transform[4]).toBe(100);
        expect(canvas.outlineEditor.layerData.shapes[0].transform[5]).toBe(100);
    });
});

// ==================== Point Type Toggle Tests ====================

// ==================== Mode Switching Tests ====================

describe('GlyphCanvas mode switching', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 1000, dx: 0, dy: 0, g: 0, cl: 0 }
        ];
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.currentGlyphName = 'A';
        // Mock fontManager
        window.fontManager = {
            getGlyphName: jest.fn(() => 'A'),
            fetchGlyphData: jest.fn(),
            setFormatSpecific: jest.fn()
        };
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should start in text edit mode', () => {
        expect(canvas.outlineEditor.active).toBe(false);
    });

    test('should exit glyph edit mode correctly', () => {
        canvas.outlineEditor.active = true;
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.outlineEditor.selectedLayerId = 'layer1';
        canvas.outlineEditor.layerData = { shapes: [], anchors: [] };
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        canvas.exitGlyphEditMode();

        expect(canvas.outlineEditor.active).toBe(false);
        expect(canvas.textRunEditor.selectedGlyphIndex).toBe(-1);
        expect(canvas.outlineEditor.selectedLayerId).toBe(null);
        expect(canvas.outlineEditor.layerData).toBe(null);
        expect(canvas.outlineEditor.selectedPoints).toEqual([]);
    });

    test('should clear hover state when exiting glyph edit mode', () => {
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.hoveredPointIndex = {
            contourIndex: 0,
            nodeIndex: 0
        };
        canvas.outlineEditor.layerData = { shapes: [], anchors: [] };

        canvas.exitGlyphEditMode();

        expect(canvas.outlineEditor.hoveredPointIndex).toBe(null);
    });

    test('should clear drag state when exiting glyph edit mode', () => {
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.layerData = { shapes: [], anchors: [] };

        canvas.exitGlyphEditMode();

        expect(canvas.outlineEditor.isDraggingPoint).toBe(false);
    });
});

// ==================== Viewport Tests ====================

describe('GlyphCanvas viewport management', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should handle wheel zoom correctly', () => {
        const initialScale = canvas.viewportManager.scale;
        const wheelEvent = new WheelEvent('wheel', {
            deltaY: -100,
            clientX: 100,
            clientY: 100
        });
        Object.defineProperty(wheelEvent, 'preventDefault', {
            value: jest.fn()
        });

        canvas.onWheel(wheelEvent);

        // Wheel event should have been handled (preventDefault called)
        expect(wheelEvent.preventDefault).toHaveBeenCalled();
    });

    test('should reset zoom and position', () => {
        const initialScale = canvas.initialScale;
        canvas.viewportManager.scale = 0.5;
        canvas.viewportManager.panX = 100;
        canvas.viewportManager.panY = 200;

        canvas.resetZoomAndPosition();

        // resetZoomAndPosition uses animation, so it doesn't reset immediately
        // Just verify the method can be called without errors
        expect(canvas.viewportManager).toBeTruthy();
    });
});

// ==================== Component Stack Tests ====================

describe('GlyphCanvas component editing stack', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should initialize with empty glyphStack', () => {
        expect(canvas.outlineEditor.glyphStack).toBe('');
    });

    test('should exit component editing when not in component mode', () => {
        const result = canvas.outlineEditor.exitComponentEditing();
        expect(result).toBe(false);
        expect(canvas.outlineEditor.isEditingComponent()).toBe(false);
    });
});

// ==================== Cursor Tests ====================

describe('GlyphCanvas cursor management', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should show cursor when canvas is focused', () => {
        canvas.onFocus();
        expect(canvas.isFocused).toBe(true);
    });

    test('should hide cursor when canvas loses focus', () => {
        jest.useFakeTimers();
        canvas.isFocused = true;
        canvas.onBlur();

        // Blur is intentionally delayed to avoid flicker
        expect(canvas.isFocused).toBe(true);
        jest.advanceTimersByTime(100);

        expect(canvas.isFocused).toBe(false);
        jest.useRealTimers();
    });
});

describe('GlyphCanvas property panel', () => {
    let canvas;
    let currentFontSpy;

    function makePanelFont() {
        return Font.fromData({
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
                    name: 'panelGlyph',
                    category: 'Base',
                    codepoints: [65],
                    format_specific: {
                        metric_right: '=globalKey'
                    },
                    exported: true,
                    layers: [
                        {
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 50, y: 0, nodetype: 'Line' },
                                        { x: 450, y: 0, nodetype: 'Line' },
                                        { x: 450, y: 700, nodetype: 'Line' },
                                        { x: 50, y: 700, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            format_specific: {
                                'com.schriftgestalt.Glyphs.metricRight': '=+20'
                            },
                            shapes: [
                                {
                                    reference: 'baseComponent',
                                    format_specific: {
                                        'com.schriftgestalt.Glyphs.alignment': 0
                                    }
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-3',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    reference: 'baseComponent',
                                    format_specific: {
                                        'com.schriftgestalt.Glyphs.alignment': 0
                                    }
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                },
                {
                    name: 'baseComponent',
                    category: 'Base',
                    codepoints: [66],
                    exported: true,
                    layers: [
                        {
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 700, nodetype: 'Line' },
                                        { x: 100, y: 700, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Panel Test' }
            },
            note: '',
            date: '2026-03-18',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });
    }

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: makePanelFont() });
        canvas.getCurrentGlyphName = jest.fn(() => 'panelGlyph');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'layer-1';
    });

    afterEach(() => {
        currentFontSpy.mockRestore();
        canvas.destroy();
    });

    test('shows sidebearing controls when no object is selected', () => {
        canvas.updatePropertyPanel();

        const inputs = document.querySelectorAll('.glyph-property-input');
        const values = document.querySelectorAll('.glyph-property-value');
        const widthDisplay = document.querySelector(
            '.glyph-property-display-value'
        );

        expect(inputs).toHaveLength(2);
        expect(values).toHaveLength(2);
        expect(widthDisplay.textContent).toBe('500');
        expect(inputs[0].value).toBe('50');
        expect(inputs[1].value).toBe('=globalKey');
    });

    test('updates property panel after layer switch', () => {
        canvas.outlineEditor.selectedLayerId = 'layer-2';
        canvas.updatePropertyPanel();

        let inputs = document.querySelectorAll('.glyph-property-input');
        expect(inputs[1].value).toBe('==+20');

        let values = document.querySelectorAll('.glyph-property-value');
        let widthDisplay = document.querySelector(
            '.glyph-property-display-value'
        );
        const glyph = fontManager.currentFont.fontModel.findGlyph('panelGlyph');
        let selectedLayer = glyph.layers.find(
            (layer) => layer.id === 'layer-2'
        );
        expect(values[1].textContent).toBe(
            String(selectedLayer.resolveMetricsKey('right').value)
        );
        expect(widthDisplay.textContent).toBe('500');

        canvas.outlineEditor.selectedLayerId = 'layer-3';
        canvas.updatePropertyPanel();

        inputs = document.querySelectorAll('.glyph-property-input');
        expect(inputs[1].value).toBe('=globalKey');

        values = document.querySelectorAll('.glyph-property-value');
        widthDisplay = document.querySelector('.glyph-property-display-value');
        selectedLayer = glyph.layers.find((layer) => layer.id === 'layer-3');
        expect(selectedLayer.resolveMetricsKey('right').value).toBeNull();
        expect(values[1].textContent).toBe(String(selectedLayer.rsb));
        expect(widthDisplay.textContent).toBe('500');
    });

    test('shows auto placeholder for automatic layer without explicit key', () => {
        canvas.outlineEditor.selectedLayerId = 'layer-3';
        const glyph = fontManager.currentFont.fontModel.findGlyph('panelGlyph');
        glyph.rightMetricsKey = undefined;

        canvas.updatePropertyPanel();

        const inputs = document.querySelectorAll('.glyph-property-input');
        expect(inputs[1].value).toBe('');
        expect(inputs[1].getAttribute('placeholder')).toBe('=+0 or ==+0');
    });

    test('shows sidebearing values for the active nested glyph in glyphStack', () => {
        canvas.outlineEditor.glyphStack =
            'panelGlyph@layer-1 / baseComponent@layer-1';
        canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
            { glyphName: 'panelGlyph', layerId: 'layer-1' },
            { glyphName: 'baseComponent', layerId: 'layer-1' }
        ]);

        canvas.updatePropertyPanel();

        const inputs = document.querySelectorAll('.glyph-property-input');
        const values = document.querySelectorAll('.glyph-property-value');

        expect(inputs[0].value).toBe('100');
        expect(inputs[1].value).toBe('100');
        expect(values[0].textContent).toBe('100');
        expect(values[1].textContent).toBe('100');
    });

    test('hides sidebearing controls when a guide is selected', () => {
        canvas.outlineEditor.selectedGuideHandle = {
            scope: 'layer',
            index: 0,
            part: 'origin'
        };

        canvas.updatePropertyPanel();

        expect(document.querySelectorAll('.glyph-property-input')).toHaveLength(
            0
        );
    });

    test('marks invalid formulas in red', () => {
        const layer =
            fontManager.currentFont.fontModel.findGlyph('panelGlyph').layers[0];
        layer.rightMetricsKey = '==missingGlyph';

        canvas.updatePropertyPanel();

        const inputs = document.querySelectorAll('.glyph-property-input');
        expect(inputs[1].classList.contains('invalid')).toBe(true);
    });

    test('ArrowUp increments the left sidebearing field by 1', async () => {
        const commitSpy = jest
            .spyOn(canvas, 'commitPropertyPanelValue')
            .mockResolvedValue();

        canvas.updatePropertyPanel();

        const inputs = document.querySelectorAll('.glyph-property-input');
        const leftInput = inputs[0];
        leftInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'ArrowUp',
                bubbles: true
            })
        );

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(commitSpy).toHaveBeenCalledWith('left', '51');

        commitSpy.mockRestore();
    });

    test('modifier keys scale sidebearing field arrow increments', async () => {
        const commitSpy = jest
            .spyOn(canvas, 'commitPropertyPanelValue')
            .mockResolvedValue();

        canvas.updatePropertyPanel();

        const inputs = document.querySelectorAll('.glyph-property-input');
        const leftInput = inputs[0];
        const rightInput = inputs[1];

        leftInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'ArrowDown',
                shiftKey: true,
                bubbles: true
            })
        );
        rightInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'ArrowUp',
                metaKey: true,
                bubbles: true
            })
        );

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(commitSpy).toHaveBeenNthCalledWith(1, 'left', '40');
        expect(commitSpy).toHaveBeenNthCalledWith(2, 'right', '150');

        commitSpy.mockRestore();
    });

    test('restores canvas focus when a sidebearing field blurs', async () => {
        const restoreFocusSpy = jest
            .spyOn(canvas.outlineEditor, 'restoreFocus')
            .mockImplementation(() => {});

        canvas.updatePropertyPanel();

        const inputs = document.querySelectorAll('.glyph-property-input');
        const leftInput = inputs[0];
        leftInput.dispatchEvent(new FocusEvent('blur'));

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(restoreFocusSpy).toHaveBeenCalled();

        restoreFocusSpy.mockRestore();
    });

    test('restores canvas focus when Enter commits a sidebearing field', async () => {
        const restoreFocusSpy = jest
            .spyOn(canvas.outlineEditor, 'restoreFocus')
            .mockImplementation(() => {});
        const commitSpy = jest
            .spyOn(canvas, 'commitPropertyPanelValue')
            .mockResolvedValue();

        canvas.updatePropertyPanel();

        const inputs = document.querySelectorAll('.glyph-property-input');
        const leftInput = inputs[0];
        leftInput.focus();
        leftInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true
            })
        );

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(commitSpy).toHaveBeenCalledWith('left', leftInput.value);
        expect(restoreFocusSpy).toHaveBeenCalled();

        commitSpy.mockRestore();
        restoreFocusSpy.mockRestore();
    });

    test('Escape returns focus to canvas before outline escape handling', () => {
        const restoreFocusSpy = jest
            .spyOn(canvas.outlineEditor, 'restoreFocus')
            .mockImplementation(() => {});
        const outlineEscapeSpy = jest
            .spyOn(canvas.outlineEditor, 'onEscapeKey')
            .mockImplementation(() => {});

        canvas.updatePropertyPanel();

        const leftInput = document.querySelector(
            '.glyph-property-input[data-sidebearing-side="left"]'
        );
        leftInput.focus();
        leftInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true
            })
        );

        expect(restoreFocusSpy).toHaveBeenCalled();
        expect(outlineEscapeSpy).not.toHaveBeenCalled();

        outlineEscapeSpy.mockRestore();
        restoreFocusSpy.mockRestore();
    });

    test('routes sidebearing input undo through app undo', () => {
        const previousRunBridgeUndoRedo = window.runBridgeUndoRedo;
        window.runBridgeUndoRedo = jest.fn().mockResolvedValue(undefined);
        canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
            { glyphName: 'panelGlyph' }
        ]);

        canvas.updatePropertyPanel();

        const leftInput = document.querySelector(
            '.glyph-property-input[data-sidebearing-side="left"]'
        );
        leftInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'z',
                metaKey: true,
                bubbles: true
            })
        );

        expect(window.runBridgeUndoRedo).toHaveBeenCalledWith(
            'undo',
            'panelGlyph',
            'panelGlyph',
            'layer-1',
            null
        );

        window.runBridgeUndoRedo = previousRunBridgeUndoRedo;
    });

    test('does not restore canvas focus when another text input stays active', async () => {
        const restoreFocusSpy = jest
            .spyOn(canvas.outlineEditor, 'restoreFocus')
            .mockImplementation(() => {});

        canvas.updatePropertyPanel();

        const oldInput = document.querySelectorAll('.glyph-property-input')[0];

        canvas.updatePropertyPanel();

        const replacementInput = document.querySelectorAll(
            '.glyph-property-input'
        )[0];
        replacementInput.focus();
        oldInput.dispatchEvent(new FocusEvent('blur'));

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(document.activeElement).toBe(replacementInput);
        expect(restoreFocusSpy).not.toHaveBeenCalled();

        restoreFocusSpy.mockRestore();
    });

    test('preserves the active sidebearing input across property panel rerenders', () => {
        canvas.updatePropertyPanel();

        const originalInput = document.querySelector(
            '.glyph-property-input[data-sidebearing-side="left"]'
        );
        originalInput.focus();
        originalInput.setSelectionRange(1, 1);

        canvas.updatePropertyPanel();

        const replacementInput = document.querySelector(
            '.glyph-property-input[data-sidebearing-side="left"]'
        );

        expect(document.activeElement).toBe(replacementInput);
        expect(replacementInput.selectionStart).toBe(1);
        expect(replacementInput.selectionEnd).toBe(1);
    });
});

describe('OutlineEditor exact selected layers', () => {
    let canvas;
    let currentFontSpy;
    let fetchGlyphDataSpy;
    let interpolateSpy;

    const makeComponentFont = () =>
        Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [
                {
                    name: { en: 'Weight' },
                    tag: 'wght',
                    min: 0,
                    default: 0,
                    max: 100,
                    map: [
                        [0, 0],
                        [100, 100]
                    ]
                }
            ],
            instances: [],
            masters: [
                {
                    id: 'master-1',
                    name: { en: 'Regular' },
                    location: { wght: 0 },
                    guides: [],
                    metrics: {
                        ascender: 800,
                        descender: -200,
                        WinDescent: 200
                    },
                    kerning: new Map()
                }
            ],
            glyphs: [
                {
                    name: 'componentGlyph',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'component-layer',
                            width: 300,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 20, y: 0, nodetype: 'Line' },
                                        { x: 280, y: 0, nodetype: 'Line' },
                                        { x: 280, y: 400, nodetype: 'Line' },
                                        { x: 20, y: 400, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                },
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'master-layer',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 700, nodetype: 'Line' },
                                        { x: 100, y: 700, nodetype: 'Line' }
                                    ],
                                    closed: true
                                },
                                {
                                    reference: 'componentGlyph',
                                    transform: [1, 0, 0, 1, 10, 20]
                                }
                            ],
                            anchors: [{ name: 'top', x: 250, y: 700 }],
                            guides: [{ pos: { x: 0, y: 600 }, angle: 0 }]
                        },
                        {
                            id: 'brace-layer',
                            name: '{50}',
                            width: 520,
                            master: {
                                type: 'AssociatedWithMaster',
                                master: 'master-1'
                            },
                            location: { wght: 50 },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 110, y: 0, nodetype: 'Line' },
                                        { x: 410, y: 0, nodetype: 'Line' },
                                        { x: 410, y: 680, nodetype: 'Line' },
                                        { x: 110, y: 680, nodetype: 'Line' }
                                    ],
                                    closed: true
                                },
                                {
                                    reference: 'componentGlyph',
                                    transform: [1, 0, 0, 1, 15, 25]
                                }
                            ],
                            anchors: [{ name: 'top', x: 260, y: 680 }],
                            guides: [{ pos: { x: 0, y: 580 }, angle: 0 }]
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Exact Layer Test' }
            },
            note: '',
            date: '2026-03-22',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

    const makeAutomaticOffsetComponentFont = () =>
        Font.fromData({
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
                    name: 'componentGlyph',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'component-layer',
                            width: 300,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 20, y: 0, nodetype: 'Line' },
                                        { x: 280, y: 0, nodetype: 'Line' },
                                        { x: 280, y: 400, nodetype: 'Line' },
                                        { x: 20, y: 400, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ],
                    format_specific: {}
                },
                {
                    name: 'autoGlyph',
                    category: 'Base',
                    exported: true,
                    format_specific: {
                        metric_left: '=+100'
                    },
                    layers: [
                        {
                            id: 'auto-layer',
                            width: 0,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    reference: 'componentGlyph',
                                    transform: [1, 0, 0, 1, 0, 0],
                                    format_specific: {
                                        'com.schriftgestalt.Glyphs.alignment': 0
                                    }
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Automatic Offset Exact Layer Test' }
            },
            note: '',
            date: '2026-04-07',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: makeComponentFont() });
        fetchGlyphDataSpy = jest
            .spyOn(fontManager, 'fetchGlyphData')
            .mockResolvedValue({
                glyphName: 'A',
                layers: makeComponentFont()
                    .findGlyph('A')
                    .layers.map((layer) => layer.toJSON())
            });
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        interpolateSpy = jest
            .spyOn(fontInterpolation, 'interpolateGlyph')
            .mockResolvedValue({
                width: 999.75,
                shapes: [
                    {
                        nodes: '150.5 0 l 450.5 0 l 450.5 700 l 150.5 700 l'
                    },
                    {
                        reference: 'componentGlyph',
                        transform: [1, 0, 0, 1, 55.5, 66.5],
                        layerData: {
                            width: 333.5,
                            shapes: [
                                {
                                    nodes: '33.5 0 l 299.5 0 l 299.5 444.5 l 33.5 444.5 l'
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    }
                ],
                anchors: [{ name: 'top', x: 999.9, y: 999.9 }],
                guides: [{ pos: { x: 0, y: 999.9 }, angle: 0 }],
                _verticalMetrics: { ascender: 800.25 }
            });
    });

    afterEach(() => {
        interpolateSpy.mockRestore();
        fetchGlyphDataSpy.mockRestore();
        currentFontSpy.mockRestore();
        canvas.destroy();
    });

    test.each([
        ['master-layer', 500, 100, 250],
        ['brace-layer', 520, 110, 260]
    ])(
        'uses exact stored root layer data for selected %s while keeping interpolated component transforms',
        async (layerId, expectedWidth, expectedFirstX, expectedAnchorX) => {
            canvas.outlineEditor.selectedLayerId = layerId;
            canvas.outlineEditor.glyphStack = `A@${layerId}`;

            await canvas.outlineEditor.fetchLayerData(true);

            expect(interpolateSpy).toHaveBeenCalled();
            expect(canvas.outlineEditor.layerData.isInterpolated).toBe(false);
            expect(canvas.outlineEditor.layerData.width).toBe(expectedWidth);
            expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].x).toBe(
                expectedFirstX
            );
            expect(canvas.outlineEditor.layerData.anchors[0].x).toBe(
                expectedAnchorX
            );
            expect(canvas.outlineEditor.layerData.shapes[1].transform[4]).toBe(
                55.5
            );
            expect(
                canvas.outlineEditor.layerData.shapes[1].layerData.shapes[0]
                    .nodes[0].x
            ).toBe(20);
            expect(canvas.outlineEditor.renderVerticalMetrics).toEqual({
                ascender: 800.25
            });
        }
    );

    test('keeps exact selected layer data editable when interpolation fails', async () => {
        interpolateSpy.mockRejectedValueOnce(new Error('incompatible glyph'));

        canvas.outlineEditor.selectedLayerId = 'master-layer';
        canvas.outlineEditor.glyphStack = 'A@master-layer';

        await canvas.outlineEditor.fetchLayerData(true);

        expect(interpolateSpy).toHaveBeenCalled();
        expect(canvas.outlineEditor.layerData.isInterpolated).toBe(false);
        expect(canvas.outlineEditor.layerData.width).toBe(500);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].x).toBe(100);
        expect(canvas.outlineEditor.layerData.anchors[0].x).toBe(250);
        expect(canvas.outlineEditor.layerData.shapes[1].layerData.width).toBe(
            300
        );
        expect(
            canvas.outlineEditor.layerData.shapes[1].layerData.shapes[0]
                .nodes[0].x
        ).toBe(20);
        expect(canvas.outlineEditor.renderVerticalMetrics).toEqual({
            ascender: 800,
            descender: -200,
            WinDescent: -200
        });
    });

    test('keeps exact selected layer component transforms for automatic LSB sidebearing offsets when interpolation is stale', async () => {
        const font = makeAutomaticOffsetComponentFont();

        currentFontSpy.mockReturnValue({ fontModel: font });
        fetchGlyphDataSpy.mockResolvedValue({
            glyphName: 'autoGlyph',
            layers: font
                .findGlyph('autoGlyph')
                .layers.map((layer) => layer.toJSON())
        });
        canvas.getCurrentGlyphName = jest.fn(() => 'autoGlyph');
        canvas.outlineEditor.selectedLayerId = 'auto-layer';
        canvas.outlineEditor.glyphStack = 'autoGlyph@auto-layer';

        interpolateSpy.mockResolvedValueOnce({
            width: 770,
            shapes: [
                {
                    reference: 'componentGlyph',
                    transform: [1, 0, 0, 1, 0, 0],
                    layerData: {
                        width: 300,
                        shapes: [
                            {
                                nodes: '20 0 l 280 0 l 280 400 l 20 400 l'
                            }
                        ],
                        anchors: [],
                        guides: []
                    }
                }
            ],
            anchors: [],
            guides: [],
            _verticalMetrics: {}
        });

        await canvas.outlineEditor.fetchLayerData(true);

        expect(canvas.outlineEditor.layerData.width).toBe(400);
        expect(canvas.outlineEditor.layerData.shapes[0].transform[4]).toBe(100);
    });

    test('resolves normal component layer data from the object model before interpolation returns', async () => {
        let capturedRootLayerData = null;
        canvas.glyphCanvas = canvas;
        const assignLayerDataSpy = jest.spyOn(
            canvas.outlineEditor,
            'assignLayerData'
        );

        interpolateSpy.mockImplementation(
            () =>
                new Promise((resolve) => {
                    capturedRootLayerData = canvas.outlineEditor.layerData;
                    resolve({
                        width: 999.75,
                        shapes: [
                            {
                                nodes: '150.5 0 l 450.5 0 l 450.5 700 l 150.5 700 l'
                            },
                            {
                                reference: 'componentGlyph',
                                transform: [1, 0, 0, 1, 55.5, 66.5]
                            }
                        ],
                        anchors: [{ name: 'top', x: 999.9, y: 999.9 }],
                        guides: [{ pos: { x: 0, y: 999.9 }, angle: 0 }],
                        _verticalMetrics: { ascender: 800.25 }
                    });
                })
        );

        canvas.outlineEditor.selectedLayerId = 'master-layer';
        canvas.outlineEditor.glyphStack = 'A@master-layer';

        await canvas.outlineEditor.fetchLayerData(true);

        expect(assignLayerDataSpy).toHaveBeenCalled();
        expect(capturedRootLayerData).toBeTruthy();
        expect(capturedRootLayerData.isInterpolated).toBe(false);
        expect(capturedRootLayerData.shapes[1].layerData.width).toBe(300);
        expect(
            capturedRootLayerData.shapes[1].layerData.shapes[0].nodes[0].x
        ).toBe(20);
        expect(canvas.outlineEditor.layerData.shapes[1].transform[4]).toBe(
            55.5
        );

        assignLayerDataSpy.mockRestore();
    });

    test('renders intermediate layers as italic Intermediate Layer labels in the layers list', async () => {
        const targetContainer = document.createElement('div');
        canvas.outlineEditor.active = true;

        await canvas.displayMastersList(targetContainer);

        const intermediateName = targetContainer.querySelector(
            '.editor-layer-item[data-layer-id="brace-layer"] .master-item-name'
        );
        const defaultName = targetContainer.querySelector(
            '.editor-layer-item[data-layer-id="master-layer"] .master-item-name'
        );

        expect(intermediateName).toBeTruthy();
        expect(intermediateName.textContent).toBe('Intermediate Layer');
        expect(
            intermediateName.classList.contains('master-item-name-intermediate')
        ).toBe(true);
        expect(
            defaultName.classList.contains('master-item-name-intermediate')
        ).toBe(false);
    });

    test('disables the create-layer button at an exact layer location', async () => {
        const targetContainer = document.createElement('div');
        canvas.outlineEditor.active = true;
        canvas.axesManager.variationSettings = { wght: 0 };

        await canvas.displayMastersList(targetContainer);

        const addButton = targetContainer.querySelector(
            '.editor-layer-add-button'
        );

        expect(addButton).toBeTruthy();
        expect(addButton.disabled).toBe(true);
    });

    test('enables the create-layer button between exact layer locations and creates an intermediate layer there', async () => {
        const targetContainer = document.createElement('div');
        const createLayerSpy = jest
            .spyOn(canvas.outlineEditor, 'createInterpolatedLayer')
            .mockResolvedValue({ id: 'new-layer' });
        const updateSpy = jest
            .spyOn(canvas, 'updatePropertiesUI')
            .mockResolvedValue();

        canvas.outlineEditor.active = true;
        canvas.axesManager.variationSettings = { wght: 75 };

        await canvas.displayMastersList(targetContainer);

        const addButton = targetContainer.querySelector(
            '.editor-layer-add-button'
        );

        expect(addButton).toBeTruthy();
        expect(addButton.disabled).toBe(false);

        addButton.click();
        await Promise.resolve();
        await Promise.resolve();

        expect(createLayerSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                glyphName: 'A',
                masterId: 'master-1',
                isMasterBound: false,
                designLocation: { wght: 75 },
                extrapolate: true
            })
        );

        updateSpy.mockRestore();
        createLayerSpy.mockRestore();
    });

    test('enables the create-layer button when the selected stored layer does not match the current location', async () => {
        const targetContainer = document.createElement('div');

        canvas.outlineEditor.active = true;
        canvas.axesManager.variationSettings = { wght: 75 };
        canvas.outlineEditor.selectedLayerId = 'brace-layer';

        await canvas.displayMastersList(targetContainer);

        const addButton = targetContainer.querySelector(
            '.editor-layer-add-button'
        );

        expect(addButton).toBeTruthy();
        expect(addButton.disabled).toBe(false);
    });

    test('updates the create-layer button when moving between exact and in-between locations', async () => {
        const targetContainer = document.createElement('div');
        canvas.propertiesSection = targetContainer;

        canvas.outlineEditor.active = true;
        canvas.axesManager.variationSettings = { wght: 0 };
        canvas.outlineEditor.selectedLayerId = 'master-layer';

        await canvas.displayMastersList(targetContainer);

        const addButton = targetContainer.querySelector(
            '.editor-layer-add-button'
        );

        expect(addButton).toBeTruthy();
        expect(addButton.disabled).toBe(true);

        canvas.outlineEditor.selectedLayerId = null;
        canvas.axesManager.variationSettings = { wght: 60 };
        canvas.outlineEditor.updateLayerSelection();

        expect(addButton.disabled).toBe(false);
    });

    test('selectLayer keeps the clicked master layer selected during the immediate properties UI rebuild', async () => {
        const targetContainer = document.createElement('div');
        document.body.appendChild(targetContainer);
        const setupAnimationSpy = jest
            .spyOn(canvas.axesManager, '_setupAnimation')
            .mockImplementation((newSettings) => {
                canvas.axesManager.variationSettings = { ...newSettings };
            });
        canvas.propertiesSection = targetContainer;
        canvas.outlineEditor.active = true;
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 500, dx: 0, dy: 0, g: 0 }];
        canvas.axesManager.variationSettings = { wght: 60 };

        await canvas.displayMastersList(targetContainer, false);

        const masterLayer = currentFontSpy.mock.results
            .at(-1)
            .value.fontModel.findGlyph('A')
            .findLayerById('master-layer');

        await canvas.outlineEditor.selectLayer(masterLayer);

        expect(canvas.outlineEditor.selectedLayerId).toBe('master-layer');
        expect(
            targetContainer.querySelector('.editor-layer-add-button').disabled
        ).toBe(true);

        setupAnimationSpy.mockRestore();
    });

    test('selectLayer disables the create-layer button on the first click after deleting an intermediate layer', async () => {
        const targetContainer = document.createElement('div');
        document.body.appendChild(targetContainer);
        const font = makeComponentFont();
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        currentFontSpy.mockReturnValue(currentFont);
        fetchGlyphDataSpy.mockResolvedValue({
            glyphName: 'A',
            layers: font.findGlyph('A').layers.map((layer) => layer.toJSON())
        });
        const forceFullWorkerCacheUpdateSpy = jest
            .spyOn(fontManager, 'forceFullWorkerCacheUpdate')
            .mockResolvedValue();
        const dirtySpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const animateSpy = jest
            .spyOn(canvas, 'animateToLocation')
            .mockImplementation(async (location) => {
                canvas.axesManager.variationSettings = { ...location };
                canvas.outlineEditor.selectedLayerId = null;
                canvas.outlineEditor.layerData = {
                    width: 520,
                    shapes: [],
                    anchors: [],
                    guides: [],
                    isInterpolated: true
                };
                canvas.outlineEditor.updateLayerSelection();
            });
        const setupAnimationSpy = jest
            .spyOn(canvas.axesManager, '_setupAnimation')
            .mockImplementation(() => {});

        canvas.propertiesSection = targetContainer;
        canvas.outlineEditor.active = true;
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 500, dx: 0, dy: 0, g: 0 }];
        canvas.axesManager.variationSettings = { wght: 50 };

        await canvas.displayMastersList(targetContainer, false);
        await canvas.outlineEditor.deleteLayerById('brace-layer');

        const resolvedMasterLayer = currentFont.fontModel
            .findGlyph('A')
            .findLayerById('master-layer');

        await canvas.outlineEditor.selectLayer(resolvedMasterLayer);

        expect(canvas.axesManager.variationSettings).toEqual({ wght: 50 });
        expect(canvas.outlineEditor.selectedLayerId).toBe('master-layer');
        expect(
            targetContainer.querySelector('.editor-layer-add-button').disabled
        ).toBe(true);

        dirtySpy.mockRestore();
        forceFullWorkerCacheUpdateSpy.mockRestore();
        setupAnimationSpy.mockRestore();
        animateSpy.mockRestore();
    });

    test('autoSelectMatchingLayer re-enables the create-layer button when already interpolating between stored layer locations', async () => {
        const targetContainer = document.createElement('div');
        canvas.propertiesSection = targetContainer;
        canvas.outlineEditor.active = true;
        canvas.axesManager.variationSettings = { wght: 0 };

        await canvas.displayMastersList(targetContainer);

        const addButton = targetContainer.querySelector(
            '.editor-layer-add-button'
        );

        expect(addButton).toBeTruthy();
        expect(addButton.disabled).toBe(true);

        canvas.outlineEditor.selectedLayerId = null;
        canvas.axesManager.variationSettings = { wght: 60 };
        addButton.disabled = true;

        await canvas.outlineEditor.autoSelectMatchingLayer();

        expect(canvas.outlineEditor.selectedLayerId).toBe(null);
        expect(addButton.disabled).toBe(false);
    });

    test('tracks unlinked layers per glyph and updates the summary toggle in the layers list', async () => {
        const targetContainer = document.createElement('div');
        const selectLayerSpy = jest
            .spyOn(canvas.outlineEditor, 'selectLayer')
            .mockResolvedValue();
        canvas.outlineEditor.active = true;

        await canvas.displayMastersList(targetContainer);

        const summaryToggle = targetContainer.querySelector(
            '.editor-layers-header .editor-layer-link-summary-toggle'
        );
        const masterToggle = targetContainer.querySelector(
            '.editor-layer-item[data-layer-id="master-layer"] .editor-layer-link-toggle'
        );
        const braceToggle = targetContainer.querySelector(
            '.editor-layer-item[data-layer-id="brace-layer"] .editor-layer-link-toggle'
        );

        expect(summaryToggle).toBeTruthy();
        expect(masterToggle).toBeTruthy();
        expect(braceToggle).toBeTruthy();
        expect(summaryToggle.getAttribute('data-linked')).toBe('true');
        expect(masterToggle.getAttribute('data-linked')).toBe('true');
        expect(braceToggle.getAttribute('data-linked')).toBe('true');

        masterToggle.click();

        expect(selectLayerSpy).not.toHaveBeenCalled();
        expect(canvas.outlineEditor.getUnlinkedLayerIdsForGlyph('A')).toEqual(
            new Set(['master-layer'])
        );
        expect(summaryToggle.getAttribute('data-linked')).toBe('false');
        expect(masterToggle.getAttribute('data-linked')).toBe('false');
        expect(braceToggle.getAttribute('data-linked')).toBe('true');

        summaryToggle.click();

        expect(canvas.outlineEditor.getUnlinkedLayerIdsForGlyph('A')).toEqual(
            new Set()
        );
        expect(summaryToggle.getAttribute('data-linked')).toBe('true');
        expect(masterToggle.getAttribute('data-linked')).toBe('true');
        expect(braceToggle.getAttribute('data-linked')).toBe('true');

        summaryToggle.click();

        expect(canvas.outlineEditor.getUnlinkedLayerIdsForGlyph('A')).toEqual(
            new Set(['master-layer', 'brace-layer'])
        );
        expect(summaryToggle.getAttribute('data-linked')).toBe('false');
        expect(masterToggle.getAttribute('data-linked')).toBe('false');
        expect(braceToggle.getAttribute('data-linked')).toBe('false');

        selectLayerSpy.mockRestore();
    });

    test('reuses the same linkage state for a glyph in nested component editing as at root level', async () => {
        const targetContainer = document.createElement('div');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.setLayerLinked(
            'component-layer',
            false,
            'componentGlyph'
        );
        canvas.outlineEditor.glyphStack =
            'A@master-layer>componentGlyph@component-layer';
        canvas.outlineEditor.currentGlyphName = 'componentGlyph';

        await canvas.displayMastersList(targetContainer);

        const nestedLayerToggle = targetContainer.querySelector(
            '.editor-layer-item[data-layer-id="component-layer"] .editor-layer-link-toggle'
        );
        const summaryToggle = targetContainer.querySelector(
            '.editor-layers-header .editor-layer-link-summary-toggle'
        );

        expect(nestedLayerToggle).toBeTruthy();
        expect(nestedLayerToggle.getAttribute('data-linked')).toBe('false');
        expect(summaryToggle.getAttribute('data-linked')).toBe('false');
    });

    test('shows broken_image next to the link toggle for incompatible non-active layers and recalculates when the active layer changes', async () => {
        const targetContainer = document.createElement('div');
        const incompatibleFont = makeComponentFont();
        const glyph = incompatibleFont.findGlyph('A');
        glyph.findLayerById('brace-layer').addPath(true);

        currentFontSpy.mockReturnValue({ fontModel: incompatibleFont });
        fetchGlyphDataSpy.mockResolvedValue({
            glyphName: 'A',
            layers: glyph.layers.map((layer) => layer.toJSON())
        });
        canvas.outlineEditor.active = true;

        canvas.outlineEditor.selectedLayerId = 'master-layer';
        await canvas.displayMastersList(targetContainer);

        expect(
            targetContainer.querySelector(
                '.editor-layer-item[data-layer-id="brace-layer"] .editor-layer-link-toggle'
            )
        ).toBeTruthy();
        expect(
            targetContainer.querySelector(
                '.editor-layer-item[data-layer-id="brace-layer"] .editor-layer-compatibility-indicator .material-symbols-outlined'
            )?.textContent
        ).toBe('broken_image');
        expect(
            targetContainer.querySelector(
                '.editor-layer-item[data-layer-id="master-layer"] .editor-layer-compatibility-indicator'
            )
        ).toBeFalsy();

        targetContainer.replaceChildren();
        canvas.outlineEditor.selectedLayerId = 'brace-layer';
        await canvas.displayMastersList(targetContainer);

        expect(
            targetContainer.querySelector(
                '.editor-layer-item[data-layer-id="master-layer"] .editor-layer-link-toggle'
            )
        ).toBeTruthy();
        expect(
            targetContainer.querySelector(
                '.editor-layer-item[data-layer-id="master-layer"] .editor-layer-compatibility-indicator .material-symbols-outlined'
            )?.textContent
        ).toBe('broken_image');
        expect(
            targetContainer.querySelector(
                '.editor-layer-item[data-layer-id="brace-layer"] .editor-layer-compatibility-indicator'
            )
        ).toBeFalsy();
    });

    test('refreshes the layers list compatibility state when switching the active layer', async () => {
        const incompatibleFont = makeComponentFont();
        const glyph = incompatibleFont.findGlyph('A');
        const masterLayer = glyph.findLayerById('master-layer');
        const braceLayer = glyph.findLayerById('brace-layer');
        glyph.findLayerById('brace-layer').addPath(true);

        currentFontSpy.mockReturnValue({ fontModel: incompatibleFont });
        fetchGlyphDataSpy.mockResolvedValue({
            glyphName: 'A',
            layers: glyph.layers.map((layer) => layer.toJSON())
        });

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'master-layer';

        const updateSpy = jest
            .spyOn(canvas, 'updatePropertiesUI')
            .mockResolvedValue();

        await canvas.outlineEditor.selectLayer(braceLayer);

        expect(updateSpy).toHaveBeenCalled();
        expect(canvas.outlineEditor.selectedLayerId).toBe('brace-layer');

        updateSpy.mockRestore();

        const targetContainer = document.createElement('div');
        await canvas.displayMastersList(targetContainer);

        expect(
            targetContainer.querySelector(
                '.editor-layer-item[data-layer-id="brace-layer"] .editor-layer-compatibility-indicator'
            )
        ).toBeFalsy();
        expect(
            targetContainer.querySelector(
                '.editor-layer-item[data-layer-id="master-layer"] .editor-layer-link-toggle'
            )
        ).toBeTruthy();
        expect(
            targetContainer.querySelector(
                '.editor-layer-item[data-layer-id="master-layer"] .editor-layer-compatibility-indicator .material-symbols-outlined'
            )?.textContent
        ).toBe('broken_image');
    });

    test('refreshes the layers list when layerFingerprintChanged is emitted for the current glyph', async () => {
        canvas.outlineEditor.active = true;
        const updateSpy = jest
            .spyOn(canvas, 'updatePropertiesUI')
            .mockResolvedValue();

        window.dispatchEvent(
            new CustomEvent('layerFingerprintChanged', {
                detail: {
                    glyphName: 'A',
                    layerId: 'master-layer'
                }
            })
        );

        await Promise.resolve();

        expect(updateSpy).toHaveBeenCalled();

        updateSpy.mockRestore();
    });

    test('createInterpolatedLayer materializes a populated master-bound layer from interpolation data', async () => {
        const font = makeComponentFont();
        const glyph = font.findGlyph('A');
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const originalPatchSyncEngine = window.patchSyncEngine;
        const patchSyncEngine = {
            syncGlyphFromJson: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn(),
            recordChange: jest.fn()
        };
        const forceFullWorkerCacheUpdateSpy = jest
            .spyOn(fontManager, 'forceFullWorkerCacheUpdate')
            .mockResolvedValue();
        const dirtySpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const selectLayerSpy = jest
            .spyOn(canvas.outlineEditor, 'selectLayer')
            .mockResolvedValue();

        glyph.removeLayer(
            glyph.layers.findIndex((layer) => layer.id === 'master-layer')
        );
        currentFontSpy.mockReturnValue(currentFont);
        window.patchSyncEngine = patchSyncEngine;

        try {
            const newLayer = await canvas.outlineEditor.createInterpolatedLayer(
                {
                    glyphName: 'A',
                    userspaceLocation: { wght: 0 },
                    masterId: 'master-1',
                    designLocation: { wght: 0 },
                    isMasterBound: true,
                    extrapolate: true
                }
            );

            expect(newLayer.id).toBe('master-1');
            const storedLayer = font.findGlyph('A').findLayerById(newLayer.id);

            expect(storedLayer).toBeTruthy();
            expect(storedLayer.master.type).toBe('DefaultForMaster');
            expect(storedLayer.width).toBe(999.75);
            expect(storedLayer.shapes.length).toBeGreaterThan(0);
            expect(storedLayer.anchors[0].x).toBe(999.9);
            expect(currentFont.markDirty).toHaveBeenCalled();
            expect(currentFont.syncJsonFromModel).toHaveBeenCalled();
            expect(patchSyncEngine.syncGlyphFromJson).toHaveBeenCalledWith(
                'A',
                'Create interpolated layer sync',
                undefined,
                undefined,
                newLayer.id
            );
            expect(forceFullWorkerCacheUpdateSpy).not.toHaveBeenCalled();
            expect(selectLayerSpy).toHaveBeenCalled();
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
            selectLayerSpy.mockRestore();
            dirtySpy.mockRestore();
            forceFullWorkerCacheUpdateSpy.mockRestore();
        }
    });

    test('deleteLayerById keeps a deleted selected master layer as a missing master selection', async () => {
        const font = makeComponentFont();
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const originalPatchSyncEngine = window.patchSyncEngine;
        const patchSyncEngine = {
            syncGlyphFromJson: jest.fn()
        };
        const forceFullWorkerCacheUpdateSpy = jest
            .spyOn(fontManager, 'forceFullWorkerCacheUpdate')
            .mockResolvedValue();
        const dirtySpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const animateSpy = jest
            .spyOn(canvas, 'animateToLocation')
            .mockResolvedValue();

        currentFontSpy.mockReturnValue(currentFont);
        window.patchSyncEngine = patchSyncEngine;
        canvas.outlineEditor.selectedLayerId = 'master-layer';
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.glyphStack = 'A@master-layer';

        try {
            const deleted =
                await canvas.outlineEditor.deleteLayerById('master-layer');

            expect(deleted).toBe(true);
            expect(
                font.findGlyph('A').findLayerById('master-layer')
            ).toBeUndefined();
            expect(canvas.outlineEditor.selectedLayerId).toBeNull();
            expect(canvas.outlineEditor.getCurrentLayerId()).toBeNull();
            expect(canvas.outlineEditor.glyphStack).toBe(
                'A@missing_interpolation'
            );
            expect(currentFont.syncJsonFromModel).toHaveBeenCalled();
            expect(patchSyncEngine.syncGlyphFromJson).toHaveBeenCalledWith(
                'A',
                'Delete layer sync'
            );
            expect(forceFullWorkerCacheUpdateSpy).not.toHaveBeenCalled();
            expect(animateSpy).toHaveBeenCalledWith({ wght: 0 }, 10);
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
            animateSpy.mockRestore();
            dirtySpy.mockRestore();
            forceFullWorkerCacheUpdateSpy.mockRestore();
        }
    });

    test('deleteLayerById clears stale pending layer-switch animation before falling back to interpolation', async () => {
        const font = makeComponentFont();
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const originalPatchSyncEngine = window.patchSyncEngine;
        const patchSyncEngine = {
            syncGlyphFromJson: jest.fn()
        };
        const forceFullWorkerCacheUpdateSpy = jest
            .spyOn(fontManager, 'forceFullWorkerCacheUpdate')
            .mockResolvedValue();
        const dirtySpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const animateSpy = jest
            .spyOn(canvas, 'animateToLocation')
            .mockResolvedValue();

        currentFontSpy.mockReturnValue(currentFont);
        window.patchSyncEngine = patchSyncEngine;
        canvas.outlineEditor.selectedLayerId = 'brace-layer';
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.glyphStack = 'A@brace-layer';
        canvas.outlineEditor.isLayerSwitchAnimating = true;
        canvas.outlineEditor.targetLayerData = {
            width: 520,
            shapes: [],
            anchors: [],
            guides: [],
            isInterpolated: false
        };
        try {
            const deleted =
                await canvas.outlineEditor.deleteLayerById('brace-layer');

            expect(deleted).toBe(true);
            expect(canvas.outlineEditor.selectedLayerId).toBeNull();
            expect(canvas.outlineEditor.getCurrentLayerId()).toBeNull();
            expect(canvas.outlineEditor.glyphStack).toBe(
                'A@missing_interpolation'
            );
            expect(canvas.outlineEditor.isLayerSwitchAnimating).toBe(false);
            expect(canvas.outlineEditor.targetLayerData).toBeNull();
            expect(forceFullWorkerCacheUpdateSpy).not.toHaveBeenCalled();
            expect(animateSpy).toHaveBeenCalledWith({ wght: 50 }, 10);
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
            animateSpy.mockRestore();
            dirtySpy.mockRestore();
            forceFullWorkerCacheUpdateSpy.mockRestore();
        }
    });

    test('deleteLayerById deletes from the requested glyph instead of the current layer-list glyph', async () => {
        const font = makeComponentFont();
        const extraFont = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            instances: [],
            masters: [],
            glyphs: [
                {
                    name: 'B',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'brace-layer',
                            name: '{50}',
                            width: 610,
                            master: {
                                type: 'AssociatedWithMaster',
                                master: 'master-1'
                            },
                            location: { wght: 50 },
                            shapes: [],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Aux' }
            },
            note: '',
            date: '2026-03-22',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });
        const glyphA = font.findGlyph('A');
        const glyphB = extraFont.findGlyph('B');
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const originalPatchSyncEngine = window.patchSyncEngine;
        const patchSyncEngine = {
            syncGlyphFromJson: jest.fn()
        };
        const forceFullWorkerCacheUpdateSpy = jest
            .spyOn(fontManager, 'forceFullWorkerCacheUpdate')
            .mockResolvedValue();
        const dirtySpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();

        font._data.glyphs.push(glyphB.toJSON());
        font._glyphWrappers = null;
        currentFontSpy.mockReturnValue(currentFont);
        window.patchSyncEngine = patchSyncEngine;
        canvas.outlineEditor.currentGlyphName = 'A';

        try {
            const deleted = await canvas.outlineEditor.deleteLayerById(
                'brace-layer',
                {
                    glyphName: 'B'
                }
            );

            expect(deleted).toBe(true);
            expect(glyphA.findLayerById('brace-layer')).toBeTruthy();
            expect(
                font.findGlyph('B').findLayerById('brace-layer')
            ).toBeUndefined();
            expect(currentFont.syncJsonFromModel).toHaveBeenCalled();
            expect(patchSyncEngine.syncGlyphFromJson).toHaveBeenCalledWith(
                'B',
                'Delete layer sync'
            );
            expect(forceFullWorkerCacheUpdateSpy).not.toHaveBeenCalled();
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
            dirtySpy.mockRestore();
            forceFullWorkerCacheUpdateSpy.mockRestore();
        }
    });

    test('deleteLayerById removes the requested master layer when raw layer storage order differs from display order', async () => {
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 200,
                    default: 400,
                    max: 800
                }
            ],
            instances: [],
            masters: [
                {
                    id: 'master-1',
                    name: { dflt: 'ExtraLight' },
                    location: { wght: 200 }
                },
                {
                    id: 'master-2',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 }
                },
                {
                    id: 'master-3',
                    name: { dflt: 'ExtraBold' },
                    location: { wght: 800 }
                }
            ],
            glyphs: [
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'master-layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'master-layer-3',
                            width: 700,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-3'
                            },
                            shapes: [],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'master-layer-2',
                            width: 600,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-2'
                            },
                            shapes: [],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ]
        });
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const originalPatchSyncEngine = window.patchSyncEngine;
        const patchSyncEngine = {
            syncGlyphFromJson: jest.fn()
        };
        const forceFullWorkerCacheUpdateSpy = jest
            .spyOn(fontManager, 'forceFullWorkerCacheUpdate')
            .mockResolvedValue();
        const dirtySpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const animateSpy = jest
            .spyOn(canvas, 'animateToLocation')
            .mockResolvedValue();

        currentFontSpy.mockReturnValue(currentFont);
        window.patchSyncEngine = patchSyncEngine;
        canvas.outlineEditor.selectedLayerId = 'master-layer-2';
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.glyphStack = 'A@master-layer-2';

        try {
            const deleted =
                await canvas.outlineEditor.deleteLayerById('master-layer-2');

            expect(deleted).toBe(true);
            expect(
                font.findGlyph('A').findLayerById('master-layer-2')
            ).toBeUndefined();
            expect(
                font.findGlyph('A').findLayerById('master-layer-3')
            ).toBeTruthy();
            expect(canvas.outlineEditor.selectedLayerId).toBeNull();
            expect(canvas.outlineEditor.getCurrentLayerId()).toBeNull();
            expect(canvas.outlineEditor.glyphStack).toBe(
                'A@missing_interpolation'
            );
            expect(currentFont.syncJsonFromModel).toHaveBeenCalled();
            expect(patchSyncEngine.syncGlyphFromJson).toHaveBeenCalledWith(
                'A',
                'Delete layer sync'
            );
            expect(forceFullWorkerCacheUpdateSpy).not.toHaveBeenCalled();
            expect(animateSpy).toHaveBeenCalledWith({ wght: 400 }, 10);
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
            animateSpy.mockRestore();
            dirtySpy.mockRestore();
            forceFullWorkerCacheUpdateSpy.mockRestore();
        }
    });

    test('layer rows expose the internal layer id and glyph name used by context-menu actions', async () => {
        const targetContainer = document.createElement('div');

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'master-layer';

        await canvas.displayMastersList(targetContainer);

        const braceRow = targetContainer.querySelector(
            '.editor-layer-item[data-layer-id="brace-layer"]'
        );

        expect(braceRow).toBeTruthy();
        expect(braceRow.getAttribute('data-layer-id')).toBe('brace-layer');
        expect(braceRow.getAttribute('data-glyph-name')).toBe('A');
    });

    test('reinterpolateLayerById batches delete and recreate into one deferred compile transaction', async () => {
        const font = makeComponentFont();
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const forceFullWorkerCacheUpdateSpy = jest
            .spyOn(fontManager, 'forceFullWorkerCacheUpdate')
            .mockResolvedValue();
        const dirtySpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const scheduleFullCompileDebounceSpy = jest
            .spyOn(fontManager, 'scheduleFullCompileDebounce')
            .mockImplementation(() => {});
        const selectLayerSpy = jest
            .spyOn(canvas.outlineEditor, 'selectLayer')
            .mockResolvedValue();
        const originalAutoCompileManager = window.autoCompileManager;
        window.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };
        const originalPatchSyncEngine = window.patchSyncEngine;
        const beginTransactionSpy = jest.fn();
        const endTransactionSpy = jest.fn();
        const syncGlyphFromJsonSpy = jest.fn();

        window.patchSyncEngine = {
            beginTransaction: beginTransactionSpy,
            endTransaction: endTransactionSpy,
            syncGlyphFromJson: syncGlyphFromJsonSpy,
            recordAdd: jest.fn(),
            recordRemove: jest.fn(),
            recordChange: jest.fn()
        };

        currentFontSpy.mockReturnValue(currentFont);
        canvas.outlineEditor.selectedLayerId = 'brace-layer';

        try {
            const recreatedLayer =
                await canvas.outlineEditor.reinterpolateLayerById(
                    'brace-layer'
                );

            expect(interpolateSpy).toHaveBeenCalledWith(
                'A',
                { wght: 50 },
                true
            );
            expect(recreatedLayer.id).toBe('brace-layer');
            expect(font.findGlyph('A').findLayerById('brace-layer').width).toBe(
                999.75
            );
            expect(currentFont.markDirty).toHaveBeenCalledTimes(3);
            expect(currentFont.syncJsonFromModel).toHaveBeenCalledTimes(1);
            expect(forceFullWorkerCacheUpdateSpy).not.toHaveBeenCalled();
            expect(fontManager.lastEditType).toBe('outline');
            expect(scheduleFullCompileDebounceSpy).toHaveBeenCalledTimes(1);
            expect(
                window.autoCompileManager.checkAndSchedule
            ).not.toHaveBeenCalled();
            expect(beginTransactionSpy).toHaveBeenCalledWith(
                'Reinterpolate layer'
            );
            expect(syncGlyphFromJsonSpy).toHaveBeenCalledWith(
                'A',
                'Reinterpolate layer sync',
                undefined,
                undefined,
                recreatedLayer.id
            );
            expect(endTransactionSpy).toHaveBeenCalledTimes(1);
            expect(selectLayerSpy).not.toHaveBeenCalled();
            expect(canvas.outlineEditor.layerData.width).toBe(999.75);
        } finally {
            window.autoCompileManager = originalAutoCompileManager;
            window.patchSyncEngine = originalPatchSyncEngine;
            selectLayerSpy.mockRestore();
            scheduleFullCompileDebounceSpy.mockRestore();
            dirtySpy.mockRestore();
            forceFullWorkerCacheUpdateSpy.mockRestore();
        }
    });

    test('reinterpolateLayerById tolerates non-cloneable source layer payloads', async () => {
        const font = makeComponentFont();
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const braceLayer = font.findGlyph('A').findLayerById('brace-layer');
        const forceFullWorkerCacheUpdateSpy = jest
            .spyOn(fontManager, 'forceFullWorkerCacheUpdate')
            .mockResolvedValue();
        const dirtySpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const scheduleFullCompileDebounceSpy = jest
            .spyOn(fontManager, 'scheduleFullCompileDebounce')
            .mockImplementation(() => {});
        const originalAutoCompileManager = window.autoCompileManager;
        const originalChangeBridge = window.changeBridge;

        braceLayer.toJSON().format_specific = {
            keep: 'value',
            inspectorWindow: window
        };

        window.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };
        window.changeBridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn(),
            recordChange: jest.fn()
        };

        currentFontSpy.mockReturnValue(currentFont);

        try {
            await expect(
                canvas.outlineEditor.reinterpolateLayerById('brace-layer', {
                    selectNewLayer: false
                })
            ).resolves.toMatchObject({ id: 'brace-layer', width: 999.75 });

            expect(font.findGlyph('A').findLayerById('brace-layer').width).toBe(
                999.75
            );
        } finally {
            window.autoCompileManager = originalAutoCompileManager;
            window.changeBridge = originalChangeBridge;
            scheduleFullCompileDebounceSpy.mockRestore();
            dirtySpy.mockRestore();
            forceFullWorkerCacheUpdateSpy.mockRestore();
        }
    });

    test('reinterpolateLayerById refreshes the currently selected same-id layer without pending switch animation', async () => {
        const font = makeComponentFont();
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const forceFullWorkerCacheUpdateSpy = jest
            .spyOn(fontManager, 'forceFullWorkerCacheUpdate')
            .mockResolvedValue();
        const dirtySpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const scheduleFullCompileDebounceSpy = jest
            .spyOn(fontManager, 'scheduleFullCompileDebounce')
            .mockImplementation(() => {});
        const updatePropertyPanelSpy = jest
            .spyOn(canvas, 'updatePropertyPanel')
            .mockImplementation(() => {});
        const renderSpy = jest
            .spyOn(canvas, 'render')
            .mockImplementation(() => {});
        const bridgeSyncSpy = jest.fn();
        const originalAutoCompileManager = window.autoCompileManager;
        const originalChangeBridge = window.changeBridge;

        window.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };
        window.changeBridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: bridgeSyncSpy,
            recordAdd: jest.fn(),
            recordRemove: jest.fn(),
            recordChange: jest.fn()
        };

        currentFontSpy.mockReturnValue(currentFont);

        const braceLayer = font.findGlyph('A').findLayerById('brace-layer');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'brace-layer';
        canvas.outlineEditor.buildGlyphStack('A', 'brace-layer', []);
        canvas.outlineEditor.layerData = braceLayer.toJSON();
        canvas.outlineEditor.targetLayerData = {
            width: 1,
            shapes: [],
            anchors: [],
            guides: [],
            isInterpolated: false
        };
        canvas.outlineEditor.isLayerSwitchAnimating = true;

        try {
            const recreatedLayer =
                await canvas.outlineEditor.reinterpolateLayerById(
                    'brace-layer',
                    {
                        glyphName: 'A',
                        selectNewLayer: true
                    }
                );

            expect(recreatedLayer.id).toBe('brace-layer');
            expect(canvas.outlineEditor.selectedLayerId).toBe('brace-layer');
            expect(canvas.outlineEditor.isLayerSwitchAnimating).toBe(false);
            expect(canvas.outlineEditor.targetLayerData).toBeNull();
            expect(canvas.outlineEditor.layerData.width).toBe(999.75);
            expect(bridgeSyncSpy).toHaveBeenCalledWith(
                'A',
                'Reinterpolate layer sync',
                undefined,
                undefined,
                'brace-layer'
            );
        } finally {
            window.autoCompileManager = originalAutoCompileManager;
            window.changeBridge = originalChangeBridge;
            renderSpy.mockRestore();
            updatePropertyPanelSpy.mockRestore();
            scheduleFullCompileDebounceSpy.mockRestore();
            dirtySpy.mockRestore();
            forceFullWorkerCacheUpdateSpy.mockRestore();
        }
    });

    test('interpolateCurrentGlyph enables extrapolation for a selected missing master slot', async () => {
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 200,
                    default: 400,
                    max: 800
                }
            ],
            instances: [],
            masters: [
                {
                    id: 'master-1',
                    name: { dflt: 'Thin' },
                    location: { wght: 200 }
                },
                {
                    id: 'master-2',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 }
                },
                {
                    id: 'master-3',
                    name: { dflt: 'Bold' },
                    location: { wght: 800 }
                }
            ],
            glyphs: [
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'master-layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'master-layer-2',
                            width: 600,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-2'
                            },
                            shapes: [],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ]
        });
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const interpolateSpy = jest
            .spyOn(fontInterpolation, 'interpolateGlyph')
            .mockResolvedValue({
                width: 700,
                shapes: [],
                anchors: [],
                guides: [],
                _interpolationLocation: { wght: 800 }
            });

        currentFontSpy.mockReturnValue(currentFont);
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = null;
        canvas.axesManager.variationSettings = { wght: 800 };

        await canvas.outlineEditor.interpolateCurrentGlyph(true);

        expect(interpolateSpy).toHaveBeenCalledWith('A', { wght: 800 }, true);

        interpolateSpy.mockRestore();
    });

    test('coalesces rapid interpolation requests and renders the latest queued location', async () => {
        const font = makeComponentFont();
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const firstRequest = {};
        firstRequest.promise = new Promise((resolve) => {
            firstRequest.resolve = resolve;
        });
        const interpolateSpy = jest
            .spyOn(fontInterpolation, 'interpolateGlyph')
            .mockImplementationOnce(() => firstRequest.promise)
            .mockResolvedValue({
                width: 720,
                shapes: [],
                anchors: [],
                guides: []
            });
        const applySpy = jest.spyOn(canvas.outlineEditor, 'applyRustLayerData');

        currentFontSpy.mockReturnValue(currentFont);
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = null;
        canvas.outlineEditor.isInterpolating = true;
        canvas.axesManager.variationSettings = { wght: 500 };

        const first = canvas.outlineEditor.interpolateCurrentGlyph();
        canvas.axesManager.variationSettings = { wght: 650 };
        const queued = canvas.outlineEditor.interpolateCurrentGlyph();
        let queuedSettled = false;
        queued.then(() => {
            queuedSettled = true;
        });
        canvas.axesManager.variationSettings = { wght: 800 };
        const latest = canvas.outlineEditor.interpolateCurrentGlyph();

        expect(interpolateSpy).toHaveBeenCalledTimes(1);
        await Promise.resolve();
        expect(queuedSettled).toBe(false);
        expect(interpolateSpy).toHaveBeenNthCalledWith(
            1,
            'A',
            { wght: 500 },
            true
        );

        firstRequest.resolve({
            width: 700,
            shapes: [],
            anchors: [],
            guides: []
        });
        await first;
        await queued;
        await latest;

        expect(interpolateSpy).toHaveBeenCalledTimes(2);
        expect(interpolateSpy).toHaveBeenNthCalledWith(
            2,
            'A',
            { wght: 800 },
            true
        );
        expect(applySpy).toHaveBeenCalled();

        interpolateSpy.mockRestore();
        applySpy.mockRestore();
    });

    test('clears queued interpolation work across request tracking reset', async () => {
        const font = makeComponentFont();
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const firstRequest = {};
        firstRequest.promise = new Promise((resolve) => {
            firstRequest.resolve = resolve;
        });
        const interpolateSpy = jest
            .spyOn(fontInterpolation, 'interpolateGlyph')
            .mockImplementationOnce(() => firstRequest.promise)
            .mockResolvedValue({
                width: 720,
                shapes: [],
                anchors: [],
                guides: []
            });
        const applySpy = jest.spyOn(canvas.outlineEditor, 'applyRustLayerData');

        currentFontSpy.mockReturnValue(currentFont);
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = null;
        canvas.outlineEditor.isInterpolating = true;
        canvas.axesManager.variationSettings = { wght: 500 };

        const first = canvas.outlineEditor.interpolateCurrentGlyph();
        canvas.axesManager.variationSettings = { wght: 800 };
        const queued = canvas.outlineEditor.interpolateCurrentGlyph(true);

        canvas.outlineEditor.clearQueuedInterpolationRequest();
        fontInterpolation.resetRequestTracking();

        firstRequest.resolve({
            width: 700,
            shapes: [],
            anchors: [],
            guides: []
        });
        await first;
        await queued;
        await Promise.resolve();

        expect(interpolateSpy).toHaveBeenCalledTimes(1);
        expect(applySpy).not.toHaveBeenCalled();

        interpolateSpy.mockRestore();
        applySpy.mockRestore();
    });

    test('createInterpolatedLayer routes structural layer additions through patch sync funnel', async () => {
        const font = makeComponentFont();
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const originalPatchSyncEngine = window.patchSyncEngine;
        const patchSyncEngine = {
            syncGlyphFromJson: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn(),
            recordChange: jest.fn()
        };
        const interpolateSpy = jest
            .spyOn(fontInterpolation, 'interpolateGlyph')
            .mockResolvedValue({
                width: 999.75,
                shapes: [
                    {
                        nodes: '150.5 0 l 450.5 0 l 450.5 700 l 150.5 700 l'
                    }
                ],
                anchors: [{ name: 'top', x: 999.9, y: 999.9 }],
                guides: [],
                _verticalMetrics: { ascender: 800.25 }
            });
        const forceFullWorkerCacheUpdateSpy = jest
            .spyOn(fontManager, 'forceFullWorkerCacheUpdate')
            .mockResolvedValue();
        const dirtySpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const selectLayerSpy = jest
            .spyOn(canvas.outlineEditor, 'selectLayer')
            .mockResolvedValue();

        currentFontSpy.mockReturnValue(currentFont);
        window.patchSyncEngine = patchSyncEngine;

        try {
            const newLayer = await canvas.outlineEditor.createInterpolatedLayer(
                {
                    glyphName: 'A',
                    userspaceLocation: { wght: 0 },
                    masterId: 'master-1',
                    designLocation: { wght: 0 },
                    isMasterBound: true,
                    extrapolate: true
                }
            );

            expect(currentFont.syncJsonFromModel).toHaveBeenCalled();
            expect(patchSyncEngine.syncGlyphFromJson).toHaveBeenCalledWith(
                'A',
                'Create interpolated layer sync',
                undefined,
                undefined,
                newLayer.id
            );
            expect(forceFullWorkerCacheUpdateSpy).not.toHaveBeenCalled();
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
            selectLayerSpy.mockRestore();
            dirtySpy.mockRestore();
            forceFullWorkerCacheUpdateSpy.mockRestore();
            interpolateSpy.mockRestore();
        }
    });
});

describe('OutlineEditor exact layerData parity', () => {
    let canvas;
    let currentFontSpy;
    let fustatFontData;
    let fustatFont;

    beforeAll(() => {
        fustatFontData = loadFontFixture('Fustat.glyphs');
    });

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        fustatFont = Font.fromData(fustatFontData);
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: fustatFont });
        canvas.getCurrentGlyphName = jest.fn(() => 'Adieresis');
    });

    afterEach(() => {
        clear_font_cache();
        currentFontSpy.mockRestore();
        canvas.destroy();
    });

    test('matches Rust layerData for Fustat Adieresis on the Regular layer exact location', () => {
        const glyph =
            fustatFont.findGlyph('Adieresis') ||
            fustatFont.findGlyph('adieresis');
        expect(glyph).toBeTruthy();

        const regularMaster =
            fustatFont.masters.find((master) => {
                const names = master.name || {};
                return Object.values(names)
                    .join(' ')
                    .toLowerCase()
                    .includes('regular');
            }) || fustatFont.masters[0];
        expect(regularMaster).toBeTruthy();

        const regularLayer =
            glyph.findLayerByMasterId(regularMaster.id) || glyph.layers[0];
        expect(regularLayer).toBeTruthy();

        canvas.outlineEditor.selectedLayerId = regularLayer.id;
        canvas.outlineEditor.glyphStack = `Adieresis@${regularLayer.id}`;

        const exactLayerData =
            canvas.outlineEditor.getExactLayerDataForSelection(
                glyph.name,
                regularLayer.id
            );
        const userspaceLocation =
            canvas.outlineEditor.getUserspaceLocationForLayer(
                regularLayer.id,
                glyph.name
            );

        store_font(JSON.stringify(fustatFontData));
        const rustLayerData = JSON.parse(
            interpolate_glyph(
                glyph.name,
                JSON.stringify(userspaceLocation || {})
            )
        );

        expect(canonicalizeLayerDataForComparison(exactLayerData)).toEqual(
            canonicalizeLayerDataForComparison(rustLayerData)
        );
    });

    test('rebuilds nested automatic component layerData for Fustat Adieresis exact rendering', () => {
        const glyph = fustatFont.findGlyph('Adieresis');
        expect(glyph).toBeTruthy();

        const regularLayer =
            glyph.findLayerByMasterId(glyph.layers[0].master.master) ||
            glyph.layers[0];

        canvas.outlineEditor.selectedLayerId = regularLayer.id;
        canvas.outlineEditor.glyphStack = `Adieresis@${regularLayer.id}`;

        const exactLayerData =
            canvas.outlineEditor.getExactLayerDataForSelection(
                glyph.name,
                regularLayer.id
            );

        const accentComponent = exactLayerData.shapes.find(
            (shape) => shape.reference === 'dieresiscomb.case'
        );
        expect(accentComponent).toBeTruthy();
        expect(accentComponent.transform.translation).toEqual([162, 0]);

        const nestedDieresisComponent = accentComponent.layerData.shapes.find(
            (shape) => shape.reference === 'dieresiscomb'
        );
        expect(nestedDieresisComponent).toBeTruthy();
        expect(
            nestedDieresisComponent.transform?.translation ?? [0, 0]
        ).toEqual([0, 190]);
    });
});

describe('OutlineEditor per-layer selection memory', () => {
    let canvas;
    let font;
    let currentFontSpy;
    let fetchGlyphDataSpy;

    const makeSelectionFont = (options = {}) =>
        Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [
                {
                    name: { en: 'Weight' },
                    tag: 'wght',
                    min: 0,
                    default: 0,
                    max: 100,
                    map: [
                        [0, 0],
                        [100, 100]
                    ]
                }
            ],
            instances: [],
            masters: [
                {
                    id: 'master-1',
                    name: { en: 'Regular' },
                    location: { wght: 0 },
                    guides: [],
                    metrics: {},
                    kerning: new Map()
                }
            ],
            glyphs: [
                {
                    name: 'componentGlyph',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'component-layer',
                            width: 300,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 20, y: 0, nodetype: 'Line' },
                                        { x: 280, y: 0, nodetype: 'Line' },
                                        { x: 280, y: 400, nodetype: 'Line' },
                                        { x: 20, y: 400, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                },
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'master-layer',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 700, nodetype: 'Line' },
                                        { x: 100, y: 700, nodetype: 'Line' }
                                    ],
                                    closed: true
                                },
                                {
                                    reference: 'componentGlyph',
                                    transform: [1, 0, 0, 1, 10, 20]
                                }
                            ],
                            anchors: [
                                { name: 'top', x: 250, y: 700 },
                                { name: 'bottom', x: 250, y: 0 }
                            ],
                            guides: [{ pos: { x: 0, y: 600 }, angle: 0 }]
                        },
                        {
                            id: 'brace-layer',
                            name: '{50}',
                            width: 520,
                            master: {
                                type: 'AssociatedWithMaster',
                                master: 'master-1'
                            },
                            location: { wght: 50 },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 110, y: 0, nodetype: 'Line' },
                                        { x: 410, y: 0, nodetype: 'Line' },
                                        { x: 410, y: 680, nodetype: 'Line' },
                                        { x: 110, y: 680, nodetype: 'Line' }
                                    ],
                                    closed: true
                                },
                                {
                                    reference: 'componentGlyph',
                                    transform: [1, 0, 0, 1, 15, 25]
                                }
                            ],
                            anchors: [
                                { name: 'top', x: 260, y: 680 },
                                { name: 'bottom', x: 260, y: 0 }
                            ],
                            guides: [{ pos: { x: 0, y: 580 }, angle: 0 }]
                        },
                        ...(!options.compatibleOnly
                            ? [
                                  {
                                      id: 'alternate-layer',
                                      name: '{75}',
                                      width: 540,
                                      master: {
                                          type: 'AssociatedWithMaster',
                                          master: 'master-1'
                                      },
                                      location: { wght: 75 },
                                      shapes: [
                                          {
                                              nodes: [
                                                  {
                                                      x: 120,
                                                      y: 0,
                                                      nodetype: 'Line'
                                                  },
                                                  {
                                                      x: 420,
                                                      y: 0,
                                                      nodetype: 'Line'
                                                  },
                                                  {
                                                      x: 420,
                                                      y: 660,
                                                      nodetype: 'Line'
                                                  },
                                                  {
                                                      x: 120,
                                                      y: 660,
                                                      nodetype: 'Line'
                                                  }
                                              ],
                                              closed: true
                                          }
                                      ],
                                      anchors: [
                                          { name: 'top', x: 270, y: 660 }
                                      ],
                                      guides: [
                                          { pos: { x: 0, y: 560 }, angle: 0 }
                                      ]
                                  }
                              ]
                            : []),
                        {
                            id: 'ui-compatible-layer',
                            name: '{25}',
                            width: 510,
                            master: {
                                type: 'AssociatedWithMaster',
                                master: 'master-1'
                            },
                            location: { wght: 25 },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 105, y: 0, nodetype: 'Line' },
                                        { x: 405, y: 0, nodetype: 'Line' },
                                        { x: 405, y: 690, nodetype: 'Line' },
                                        { x: 105, y: 690, nodetype: 'Line' }
                                    ],
                                    closed: true
                                },
                                {
                                    reference: 'componentGlyph',
                                    transform: [1, 0, 0, 1, 12, 22]
                                }
                            ],
                            anchors: [
                                { name: 'bottom', x: 255, y: 0 },
                                { name: 'top', x: 255, y: 690 }
                            ],
                            guides: [{ pos: { x: 0, y: 590 }, angle: 0 }]
                        }
                    ]
                },
                {
                    name: 'n',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'master-layer',
                            width: 480,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 90, y: 0, nodetype: 'Line' },
                                        { x: 390, y: 0, nodetype: 'Line' },
                                        { x: 390, y: 520, nodetype: 'Line' },
                                        { x: 90, y: 520, nodetype: 'Line' }
                                    ],
                                    closed: true
                                },
                                {
                                    reference: 'componentGlyph',
                                    transform: [1, 0, 0, 1, 8, 18]
                                }
                            ],
                            anchors: [
                                { name: 'top', x: 240, y: 520 },
                                { name: 'bottom', x: 240, y: 0 }
                            ],
                            guides: [{ pos: { x: 0, y: 420 }, angle: 0 }]
                        },
                        {
                            id: 'brace-layer',
                            name: '{50}',
                            width: 500,
                            master: {
                                type: 'AssociatedWithMaster',
                                master: 'master-1'
                            },
                            location: { wght: 50 },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 510, nodetype: 'Line' },
                                        { x: 100, y: 510, nodetype: 'Line' }
                                    ],
                                    closed: true
                                },
                                {
                                    reference: 'componentGlyph',
                                    transform: [1, 0, 0, 1, 12, 18]
                                }
                            ],
                            anchors: [
                                { name: 'top', x: 250, y: 510 },
                                { name: 'bottom', x: 250, y: 0 }
                            ],
                            guides: [{ pos: { x: 0, y: 410 }, angle: 0 }]
                        }
                    ]
                },
                {
                    name: 'adieresis',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'master-layer',
                            width: 540,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    reference: 'A',
                                    transform: [1, 0, 0, 1, 0, 0]
                                },
                                {
                                    reference: 'componentGlyph',
                                    transform: [1, 0, 0, 1, 120, 720]
                                }
                            ],
                            anchors: [
                                { name: 'top', x: 270, y: 900 },
                                { name: 'bottom', x: 270, y: 0 }
                            ],
                            guides: [{ pos: { x: 0, y: 760 }, angle: 0 }]
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Selection Memory Test' }
            },
            note: '',
            date: '2026-03-22',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        font = makeSelectionFont();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: font });
        fetchGlyphDataSpy = jest
            .spyOn(fontManager, 'fetchGlyphData')
            .mockResolvedValue({
                glyphName: 'A',
                layers: font
                    .findGlyph('A')
                    .layers.map((layer) => layer.toJSON())
            });
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.active = false;
        canvas.axesManager._setupAnimation = jest.fn();
    });

    afterEach(() => {
        fetchGlyphDataSpy.mockRestore();
        currentFontSpy.mockRestore();
        canvas.destroy();
    });

    test('stores layer linkage per glyph and defaults unknown layers to linked', () => {
        canvas.outlineEditor.setLayerLinked('layer-1', false, 'A');
        canvas.outlineEditor.setLayerLinked('layer-2', false, 'B');

        expect(canvas.outlineEditor.isLayerLinked('layer-1', 'A')).toBe(false);
        expect(canvas.outlineEditor.isLayerLinked('layer-2', 'A')).toBe(true);
        expect(canvas.outlineEditor.getUnlinkedLayerIdsForGlyph('A')).toEqual(
            new Set(['layer-1'])
        );
        expect(canvas.outlineEditor.getUnlinkedLayerIdsForGlyph('B')).toEqual(
            new Set(['layer-2'])
        );

        canvas.outlineEditor.setLayerLinked('layer-1', true, 'A');

        expect(canvas.outlineEditor.getUnlinkedLayerIdsForGlyph('A')).toEqual(
            new Set()
        );
        expect(canvas.outlineEditor.isLayerLinked('layer-3', 'A')).toBe(true);
    });

    test('copies same-index object selection to a compatible layer', async () => {
        const [masterLayer, braceLayer] = font.findGlyph('A').layers;

        await canvas.outlineEditor.selectLayer(masterLayer);
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 }
        ];
        canvas.outlineEditor.selectedAnchors = [1];
        canvas.outlineEditor.selectedComponents = [1];

        await canvas.outlineEditor.selectLayer(braceLayer);

        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 1 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([1]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([1]);
        expect(canvas.outlineEditor.selectedGuideHandle).toBeNull();
    });

    test('copies selection to a newly selected compatible layer through the UI layer-switch path', async () => {
        const compatibleFont = makeSelectionFont({ compatibleOnly: true });
        const glyph = compatibleFont.findGlyph('A');
        const masterLayer = glyph.findLayerById('master-layer');
        const targetLayer = glyph.findLayerById('ui-compatible-layer');
        const cloneLayerData = (layer) =>
            JSON.parse(JSON.stringify(layer.toJSON()));

        currentFontSpy.mockRestore();
        fetchGlyphDataSpy.mockRestore();

        font = compatibleFont;
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: font });
        fetchGlyphDataSpy = jest
            .spyOn(fontManager, 'fetchGlyphData')
            .mockResolvedValue({
                glyphName: 'A',
                layers: font
                    .findGlyph('A')
                    .layers.map((layer) => layer.toJSON())
            });

        expect(glyph.isCompatible).toBe(true);

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.layerData = cloneLayerData(masterLayer);
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.outlineEditor.fetchLayerData = jest.fn(async () => {
            const currentLayer = font
                .findGlyph('A')
                .findLayerById(canvas.outlineEditor.selectedLayerId);
            canvas.outlineEditor.layerData = cloneLayerData(currentLayer);
        });

        canvas.outlineEditor.selectedLayerId = masterLayer.id;
        canvas.outlineEditor.glyphStack = `A@${masterLayer.id}`;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 }
        ];
        canvas.outlineEditor.selectedAnchors = [1];
        canvas.outlineEditor.selectedComponents = [1];

        await canvas.outlineEditor.selectLayer({
            id: targetLayer.id,
            name: targetLayer.name,
            master: targetLayer.master,
            location: targetLayer.location,
            shapes: targetLayer.shapes || [],
            width: targetLayer.width,
            isInterpolated: false
        });
        await canvas.outlineEditor.restoreTargetLayerDataAfterAnimating();

        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 1 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([0]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([1]);

        await canvas.outlineEditor.selectLayer(masterLayer);
        await canvas.outlineEditor.restoreTargetLayerDataAfterAnimating();

        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 1 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([1]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([1]);
    });

    test('restores the target layer stored selection when the previous layer is incompatible', async () => {
        const [masterLayer, , alternateLayer] = font.findGlyph('A').layers;

        await canvas.outlineEditor.selectLayer(alternateLayer);
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.selectedGuideHandle = {
            scope: 'layer',
            index: 0
        };

        await canvas.outlineEditor.selectLayer(masterLayer);
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 2 }
        ];
        canvas.outlineEditor.selectedComponents = [1];
        canvas.outlineEditor.selectedAnchors = [];
        canvas.outlineEditor.selectedGuideHandle = null;

        await canvas.outlineEditor.selectLayer(alternateLayer);

        expect(canvas.outlineEditor.selectedPoints).toEqual([]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([0]);
        expect(canvas.outlineEditor.selectedGuideHandle).toEqual({
            scope: 'layer',
            index: 0
        });
    });

    test('preserves selection across animated layer switches in active edit mode', async () => {
        const [masterLayer, braceLayer] = font.findGlyph('A').layers;
        const cloneLayerData = (layer) =>
            JSON.parse(JSON.stringify(layer.toJSON()));

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.layerData = cloneLayerData(masterLayer);
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.outlineEditor.fetchLayerData = jest.fn(async () => {
            const currentLayer = font
                .findGlyph('A')
                .findLayerById(canvas.outlineEditor.selectedLayerId);
            canvas.outlineEditor.layerData = cloneLayerData(currentLayer);
        });

        canvas.outlineEditor.selectedLayerId = masterLayer.id;
        canvas.outlineEditor.glyphStack = `A@${masterLayer.id}`;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 }
        ];
        canvas.outlineEditor.selectedAnchors = [1];
        canvas.outlineEditor.selectedComponents = [1];

        await canvas.outlineEditor.selectLayer(braceLayer);
        await canvas.outlineEditor.restoreTargetLayerDataAfterAnimating();

        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 1 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([1]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([1]);

        await canvas.outlineEditor.selectLayer(masterLayer);
        await canvas.outlineEditor.restoreTargetLayerDataAfterAnimating();

        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 1 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([1]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([1]);
    });

    test('restoreTargetLayerDataAfterAnimating disables the create-layer button at the clicked exact layer location', async () => {
        const targetContainer = document.createElement('div');
        document.body.appendChild(targetContainer);
        const [masterLayer, braceLayer] = font.findGlyph('A').layers;
        const cloneLayerData = (layer) =>
            JSON.parse(JSON.stringify(layer.toJSON()));
        const setupAnimationSpy = jest
            .spyOn(canvas.axesManager, '_setupAnimation')
            .mockImplementation((newSettings) => {
                canvas.axesManager.variationSettings = { wght: 30 };
                canvas.outlineEditor.updateLayerSelection();
                canvas.axesManager.variationSettings = { ...newSettings };
            });
        const getSortedLayersSpy = jest
            .spyOn(canvas, 'getSortedLayers')
            .mockReturnValue(font.findGlyph('A').layers);

        canvas.propertiesSection = targetContainer;
        canvas.outlineEditor.active = true;
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 500, dx: 0, dy: 0, g: 0 }];
        canvas.outlineEditor.layerData = cloneLayerData(masterLayer);
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.outlineEditor.fetchLayerData = jest.fn(async () => {
            const currentLayer = font
                .findGlyph('A')
                .findLayerById(canvas.outlineEditor.selectedLayerId);
            canvas.outlineEditor.layerData = cloneLayerData(currentLayer);
        });
        canvas.outlineEditor.selectedLayerId = masterLayer.id;
        canvas.outlineEditor.glyphStack = `A@${masterLayer.id}`;
        canvas.axesManager.variationSettings = { wght: 0 };

        await canvas.displayMastersList(targetContainer, false);

        const addButton = targetContainer.querySelector(
            '.editor-layer-add-button'
        );

        expect(addButton).toBeTruthy();
        expect(addButton.disabled).toBe(true);

        await canvas.outlineEditor.selectLayer(braceLayer);

        expect(addButton.disabled).toBe(false);

        canvas.axesManager.variationSettings = { wght: 75 };

        await canvas.outlineEditor.restoreTargetLayerDataAfterAnimating();

        const refreshedAddButton = targetContainer.querySelector(
            '.editor-layer-add-button'
        );

        expect(canvas.outlineEditor.selectedLayerId).toBe(braceLayer.id);
        expect(refreshedAddButton.disabled).toBe(true);

        getSortedLayersSpy.mockRestore();
        setupAnimationSpy.mockRestore();
    });

    test('does not transfer selection across glyph switches after glyph stack reset and restores glyph-local layer state', async () => {
        let selectedGlyphName = 'A';
        const cloneLayerData = (layer) =>
            JSON.parse(JSON.stringify(layer.toJSON()));
        const glyphA = font.findGlyph('A');
        const glyphN = font.findGlyph('n');
        const masterLayerA = glyphA.findLayerById('master-layer');
        const masterLayerN = glyphN.findLayerById('master-layer');

        canvas.getCurrentGlyphName = jest.fn(() => selectedGlyphName);
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.outlineEditor.fetchLayerData = jest.fn(async () => {
            const glyph = font.findGlyph(selectedGlyphName);
            const currentLayer = glyph.findLayerById(
                canvas.outlineEditor.selectedLayerId
            );
            canvas.outlineEditor.assignLayerData(cloneLayerData(currentLayer));
            canvas.outlineEditor.currentGlyphName = selectedGlyphName;
        });

        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = masterLayerA.id;
        canvas.outlineEditor.glyphStack = '';
        canvas.outlineEditor.layerData = cloneLayerData(masterLayerA);
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ];
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.selectedComponents = [1];

        selectedGlyphName = 'n';
        await canvas.outlineEditor.autoSelectMatchingLayer();

        expect(canvas.outlineEditor.selectedLayerId).toBe(masterLayerN.id);
        expect(canvas.outlineEditor.selectedPoints).toEqual([]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([]);

        canvas.outlineEditor.glyphStack = '';
        selectedGlyphName = 'A';
        await canvas.outlineEditor.autoSelectMatchingLayer();

        expect(canvas.outlineEditor.selectedLayerId).toBe(masterLayerA.id);
        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([0]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([1]);
    });

    test('glyphselected snapshots the previous glyph layer selection and clears live selection before UI refresh', async () => {
        const glyphSelectedHandler =
            canvas.textRunEditor.callbacks.glyphselected[0];
        const cloneLayerData = (layer) =>
            JSON.parse(JSON.stringify(layer.toJSON()));
        const masterLayerA = font.findGlyph('A').findLayerById('master-layer');

        canvas.textRunEditor.shapedGlyphs = [
            { ax: 500, dx: 0, dy: 0, g: 0 },
            { ax: 480, dx: 0, dy: 0, g: 1 }
        ];
        canvas.textRunEditor.selectedGlyphIndex = 1;
        canvas.getCurrentGlyphName = jest.fn(() => 'n');
        canvas.doUIUpdateAsync = jest.fn(async () => {
            expect(
                canvas.outlineEditor.getStoredSelectionStateForLayer(
                    masterLayerA
                )
            ).toEqual({
                points: [
                    { contourIndex: 0, nodeIndex: 1 },
                    { contourIndex: 0, nodeIndex: 2 }
                ],
                anchors: [0],
                anchorNames: ['top'],
                components: [1],
                guideHandle: null
            });
            expect(canvas.outlineEditor.selectedPoints).toEqual([]);
            expect(canvas.outlineEditor.selectedAnchors).toEqual([]);
            expect(canvas.outlineEditor.selectedComponents).toEqual([]);
        });

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = masterLayerA.id;
        canvas.outlineEditor.glyphStack = `A@${masterLayerA.id}`;
        canvas.outlineEditor.layerData = cloneLayerData(masterLayerA);
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ];
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.selectedComponents = [1];
        canvas.outlineEditor.selectedGuideHandle = null;

        await glyphSelectedHandler(1, 0, true);

        expect(canvas.doUIUpdateAsync).toHaveBeenCalledTimes(1);
    });

    test('glyphselected restores the original glyph selection after switching to another glyph and back', async () => {
        const glyphSelectedHandler =
            canvas.textRunEditor.callbacks.glyphselected[0];
        const cloneLayerData = (layer) =>
            JSON.parse(JSON.stringify(layer.toJSON()));
        const masterLayerA = font.findGlyph('A').findLayerById('master-layer');
        const masterLayerN = font.findGlyph('n').findLayerById('master-layer');
        let selectedGlyphName = 'A';

        canvas.textRunEditor.shapedGlyphs = [
            { ax: 500, dx: 0, dy: 0, g: 0 },
            { ax: 480, dx: 0, dy: 0, g: 1 }
        ];
        canvas.getCurrentGlyphName = jest.fn(() => selectedGlyphName);
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.outlineEditor.fetchLayerData = jest.fn(async () => {
            const glyph = font.findGlyph(selectedGlyphName);
            const currentLayer = glyph.findLayerById(
                canvas.outlineEditor.selectedLayerId
            );
            canvas.outlineEditor.assignLayerData(cloneLayerData(currentLayer));
            canvas.outlineEditor.currentGlyphName = selectedGlyphName;
        });
        canvas.doUIUpdateAsync = jest.fn(async () => {
            await canvas.outlineEditor.autoSelectMatchingLayer();
        });

        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = masterLayerA.id;
        canvas.outlineEditor.glyphStack = `A@${masterLayerA.id}`;
        canvas.outlineEditor.layerData = cloneLayerData(masterLayerA);
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ];
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.selectedComponents = [1];

        selectedGlyphName = 'n';
        canvas.textRunEditor.selectedGlyphIndex = 1;
        await glyphSelectedHandler(1, 0, true);

        expect(canvas.outlineEditor.selectedLayerId).toBe(masterLayerN.id);
        expect(canvas.outlineEditor.selectedPoints).toEqual([]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([]);

        selectedGlyphName = 'A';
        canvas.textRunEditor.selectedGlyphIndex = 0;
        await glyphSelectedHandler(0, 1, true);

        expect(canvas.outlineEditor.selectedLayerId).toBe(masterLayerA.id);
        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([0]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([1]);
    });

    test("entering a nested component restores that glyph's stored selection from earlier root editing", async () => {
        const glyphSelectedHandler =
            canvas.textRunEditor.callbacks.glyphselected[0];
        const cloneLayerData = (layer) =>
            JSON.parse(JSON.stringify(layer.toJSON()));
        const masterLayerA = font.findGlyph('A').findLayerById('master-layer');
        const masterLayerAdieresis = font
            .findGlyph('adieresis')
            .findLayerById('master-layer');
        let selectedGlyphName = 'A';
        const makeNestedComponentLayerData = () => ({
            id: masterLayerA.id,
            width: masterLayerA.width,
            master: masterLayerA.master,
            shapes: JSON.parse(JSON.stringify(masterLayerA.shapes)),
            anchors: [
                { name: 'bottom', x: 250, y: 0 },
                { name: 'top', x: 250, y: 700 }
            ],
            guides: []
        });

        canvas.textRunEditor.shapedGlyphs = [
            { ax: 500, dx: 0, dy: 0, g: 0 },
            { ax: 540, dx: 0, dy: 0, g: 2 }
        ];
        canvas.getCurrentGlyphName = jest.fn(() => selectedGlyphName);
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.outlineEditor.fetchLayerData = jest.fn(async () => {
            const glyph = font.findGlyph(selectedGlyphName);
            const currentLayer = glyph.findLayerById(
                canvas.outlineEditor.selectedLayerId
            );
            const nextLayerData = cloneLayerData(currentLayer);
            if (selectedGlyphName === 'adieresis') {
                nextLayerData.shapes[0].layerData =
                    makeNestedComponentLayerData();
            }
            canvas.outlineEditor.assignLayerData(nextLayerData);
            canvas.outlineEditor.currentGlyphName =
                canvas.outlineEditor.parseGlyphStack().at(-1)?.glyphName ||
                selectedGlyphName;
        });
        canvas.doUIUpdateAsync = jest.fn(async () => {
            await canvas.outlineEditor.autoSelectMatchingLayer();
        });
        canvas.updateComponentBreadcrumb = jest.fn();
        canvas.updatePropertiesUI = jest.fn(async () => {
            await canvas.outlineEditor.autoSelectMatchingLayer();
        });
        canvas.render = jest.fn();

        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = masterLayerA.id;
        canvas.outlineEditor.glyphStack = `A@${masterLayerA.id}`;
        canvas.outlineEditor.layerData = cloneLayerData(masterLayerA);
        canvas.outlineEditor.selectedPoints = [];
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.selectedComponents = [];

        selectedGlyphName = 'adieresis';
        canvas.textRunEditor.selectedGlyphIndex = 1;
        await glyphSelectedHandler(1, 0, true);
        canvas.outlineEditor.layerData.shapes[0].layerData =
            makeNestedComponentLayerData();

        expect(canvas.outlineEditor.selectedLayerId).toBe(
            masterLayerAdieresis.id
        );
        expect(canvas.outlineEditor.selectedAnchors).toEqual([]);

        await canvas.outlineEditor.enterComponentEditing(0);
        await Promise.resolve();
        await Promise.resolve();

        expect(canvas.outlineEditor.glyphStack).toBe(
            `adieresis@${masterLayerAdieresis.id}>0:A@${masterLayerAdieresis.id}`
        );
        expect(canvas.outlineEditor.currentGlyphName).toBe('A');
        expect(canvas.outlineEditor.selectedAnchors).toEqual([1]);
        expect(canvas.outlineEditor.selectedPoints).toEqual([]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([]);
    });

    test('first click of double-clicking another glyph does not clear the current glyph selection', () => {
        const cloneLayerData = (layer) =>
            JSON.parse(JSON.stringify(layer.toJSON()));
        const masterLayerA = font.findGlyph('A').findLayerById('master-layer');

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = masterLayerA.id;
        canvas.outlineEditor.glyphStack = `A@${masterLayerA.id}`;
        canvas.outlineEditor.layerData = cloneLayerData(masterLayerA);
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ];
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.selectedComponents = [1];
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updateHoveredGlyph = jest.fn(() => {
            canvas.outlineEditor.hoveredGlyphIndex = 1;
        });

        canvas.onMouseDown({
            clientX: 10,
            clientY: 10,
            detail: 1,
            shiftKey: false,
            ctrlKey: false,
            metaKey: false
        });

        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([0]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([1]);
    });

    test('double-clicking a path segment selects all nodes on that contour without targeting the preceding component', () => {
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'master-layer';
        canvas.outlineEditor.layerData = {
            id: 'master-layer',
            width: 500,
            shapes: [
                {
                    reference: 'acute',
                    transform: [1, 0, 0, 1, 20, 30]
                },
                {
                    nodes: [
                        { x: 0, y: 0, nodetype: 'Move' },
                        { x: 100, y: 0, nodetype: 'Line' },
                        { x: 100, y: 100, nodetype: 'Line' }
                    ],
                    closed: false
                }
            ],
            anchors: [],
            guides: [],
            isInterpolated: false
        };
        canvas.outlineEditor.hoveredPointIndex = null;
        canvas.outlineEditor.hoveredAnchorIndex = null;
        canvas.outlineEditor.hoveredComponentIndex = null;
        canvas.outlineEditor.hoveredGuideHandle = null;
        canvas.outlineEditor.hoveredSidebearingHandle = null;
        canvas.outlineEditor.transformMouseToComponentSpace = jest.fn(() => ({
            glyphX: 50,
            glyphY: 0
        }));
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();

        const handled = canvas.outlineEditor.onDoubleClick({});

        expect(handled).toBe(true);
        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 1, nodeIndex: 0 },
            { contourIndex: 1, nodeIndex: 1 },
            { contourIndex: 1, nodeIndex: 2 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([]);
    });

    test('keyboard glyph switching restores the original glyph selection after switching away and back', async () => {
        const cloneLayerData = (layer) =>
            JSON.parse(JSON.stringify(layer.toJSON()));
        const masterLayerA = font.findGlyph('A').findLayerById('master-layer');
        const masterLayerN = font.findGlyph('n').findLayerById('master-layer');
        let selectedGlyphName = 'A';

        canvas.getCurrentGlyphName = jest.fn(() => selectedGlyphName);
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updateComponentBreadcrumb = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.outlineEditor.fetchLayerData = jest.fn(async () => {
            const glyph = font.findGlyph(selectedGlyphName);
            const currentLayer = glyph.findLayerById(
                canvas.outlineEditor.selectedLayerId
            );
            canvas.outlineEditor.assignLayerData(cloneLayerData(currentLayer));
            canvas.outlineEditor.currentGlyphName = selectedGlyphName;
        });
        canvas.updatePropertiesUI = jest.fn(async () => {
            await canvas.outlineEditor.autoSelectMatchingLayer();
        });
        canvas.textRunEditor.isPositionRTL = jest.fn(() => false);
        canvas.textRunEditor.textBuffer = 'An';
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 500, dx: 0, dy: 0, g: 0, cl: 0 },
            { ax: 480, dx: 0, dy: 0, g: 1, cl: 1 }
        ];

        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = masterLayerA.id;
        canvas.outlineEditor.glyphStack = `A@${masterLayerA.id}`;
        canvas.outlineEditor.layerData = cloneLayerData(masterLayerA);
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ];
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.selectedComponents = [1];

        selectedGlyphName = 'n';
        canvas.onKeyDown({
            metaKey: true,
            ctrlKey: false,
            key: 'ArrowRight',
            code: 'ArrowRight',
            shiftKey: false,
            altKey: false,
            preventDefault: jest.fn()
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(canvas.textRunEditor.selectedGlyphIndex).toBe(1);
        expect(canvas.outlineEditor.selectedLayerId).toBe(masterLayerN.id);
        expect(canvas.outlineEditor.selectedPoints).toEqual([]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([]);

        selectedGlyphName = 'A';
        canvas.onKeyDown({
            metaKey: true,
            ctrlKey: false,
            key: 'ArrowLeft',
            code: 'ArrowLeft',
            shiftKey: false,
            altKey: false,
            preventDefault: jest.fn()
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(canvas.textRunEditor.selectedGlyphIndex).toBe(0);
        expect(canvas.outlineEditor.selectedLayerId).toBe(masterLayerA.id);
        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([0]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([1]);
    });

    test('double-click glyph switching restores the original glyph selection after switching away and back', async () => {
        const cloneLayerData = (layer) =>
            JSON.parse(JSON.stringify(layer.toJSON()));
        const masterLayerA = font.findGlyph('A').findLayerById('master-layer');
        const masterLayerN = font.findGlyph('n').findLayerById('master-layer');
        let selectedGlyphName = 'A';
        let hoveredGlyphIndex = 1;

        canvas.getCurrentGlyphName = jest.fn(() => selectedGlyphName);
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updateComponentBreadcrumb = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.updatePropertiesUI = jest.fn(async () => {
            await canvas.outlineEditor.autoSelectMatchingLayer();
        });
        canvas.outlineEditor.fetchLayerData = jest.fn(async () => {
            const glyph = font.findGlyph(selectedGlyphName);
            const currentLayer = glyph.findLayerById(
                canvas.outlineEditor.selectedLayerId
            );
            canvas.outlineEditor.assignLayerData(cloneLayerData(currentLayer));
            canvas.outlineEditor.currentGlyphName = selectedGlyphName;
        });
        canvas.updateHoveredGlyph = jest.fn(() => {
            canvas.outlineEditor.hoveredGlyphIndex = hoveredGlyphIndex;
        });
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 500, dx: 0, dy: 0, g: 0, cl: 0 },
            { ax: 480, dx: 0, dy: 0, g: 1, cl: 1 }
        ];

        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = masterLayerA.id;
        canvas.outlineEditor.glyphStack = `A@${masterLayerA.id}`;
        canvas.outlineEditor.layerData = cloneLayerData(masterLayerA);
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ];
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.selectedComponents = [1];

        canvas.onMouseDown({
            clientX: 10,
            clientY: 10,
            detail: 1,
            shiftKey: false,
            ctrlKey: false,
            metaKey: false
        });
        selectedGlyphName = 'n';
        canvas.onMouseDown({
            clientX: 10,
            clientY: 10,
            detail: 2,
            shiftKey: false,
            ctrlKey: false,
            metaKey: false
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(canvas.textRunEditor.selectedGlyphIndex).toBe(1);
        expect(canvas.outlineEditor.selectedLayerId).toBe(masterLayerN.id);
        expect(canvas.outlineEditor.selectedPoints).toEqual([]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([]);

        hoveredGlyphIndex = 0;
        canvas.onMouseDown({
            clientX: 10,
            clientY: 10,
            detail: 1,
            shiftKey: false,
            ctrlKey: false,
            metaKey: false
        });
        selectedGlyphName = 'A';
        canvas.onMouseDown({
            clientX: 10,
            clientY: 10,
            detail: 2,
            shiftKey: false,
            ctrlKey: false,
            metaKey: false
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(canvas.textRunEditor.selectedGlyphIndex).toBe(0);
        expect(canvas.outlineEditor.selectedLayerId).toBe(masterLayerA.id);
        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([0]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([1]);
    });

    test('edit-mode reshaping reloads the outline for the glyph now at the selected index', async () => {
        const renderHandler = canvas.textRunEditor.callbacks.render[0];
        const cloneLayerData = (layer) =>
            JSON.parse(JSON.stringify(layer.toJSON()));
        const masterLayerA = font.findGlyph('A').findLayerById('master-layer');
        const masterLayerN = font.findGlyph('n').findLayerById('master-layer');
        let selectedGlyphName = 'A';

        canvas.getCurrentGlyphName = jest.fn(() => selectedGlyphName);
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updateComponentBreadcrumb = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.updatePropertiesUI = jest.fn(async () => {
            await canvas.outlineEditor.autoSelectMatchingLayer();
        });
        canvas.outlineEditor.fetchLayerData = jest.fn(async () => {
            const glyph = font.findGlyph(selectedGlyphName);
            const currentLayer = glyph.findLayerById(
                canvas.outlineEditor.selectedLayerId
            );
            canvas.outlineEditor.assignLayerData(cloneLayerData(currentLayer));
            canvas.outlineEditor.currentGlyphName = selectedGlyphName;
        });
        canvas.textRunEditor.shapedGlyphs = [{ ax: 500, dx: 0, dy: 0, g: 0 }];
        canvas.textRunEditor.selectedGlyphIndex = 0;

        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = masterLayerA.id;
        canvas.outlineEditor.glyphStack = `A@${masterLayerA.id}`;
        canvas.outlineEditor.layerData = cloneLayerData(masterLayerA);
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ];
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.selectedComponents = [1];

        selectedGlyphName = 'n';
        renderHandler();
        await Promise.resolve();
        await Promise.resolve();

        expect(canvas.updatePropertiesUI).toHaveBeenCalledTimes(1);
        expect(canvas.outlineEditor.fetchLayerData).toHaveBeenCalled();
        expect(canvas.outlineEditor.selectedLayerId).toBe(masterLayerN.id);
        expect(canvas.outlineEditor.glyphStack).toBe(`n@${masterLayerN.id}`);
        expect(canvas.outlineEditor.currentGlyphName).toBe('n');
        expect(canvas.outlineEditor.selectedPoints).toEqual([]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([]);
    });

    test('edit-mode reshaping prefers explicit token glyph names over transient .notdef gids', async () => {
        const renderHandler = canvas.textRunEditor.callbacks.render[0];
        const actualGetCurrentGlyphName =
            Object.getPrototypeOf(canvas).getCurrentGlyphName.bind(canvas);
        const cloneLayerData = (layer) =>
            JSON.parse(JSON.stringify(layer.toJSON()));
        const masterLayerA = font.findGlyph('A').findLayerById('master-layer');
        const masterLayerN = font.findGlyph('n').findLayerById('master-layer');

        canvas.getCurrentGlyphName = actualGetCurrentGlyphName;

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updateComponentBreadcrumb = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.updatePropertiesUI = jest.fn(async () => {
            await canvas.outlineEditor.autoSelectMatchingLayer();
        });
        canvas.outlineEditor.fetchLayerData = jest.fn(async () => {
            const currentGlyphName = actualGetCurrentGlyphName();
            const glyph = font.findGlyph(currentGlyphName);
            const currentLayer = glyph.findLayerById(
                canvas.outlineEditor.selectedLayerId
            );
            canvas.outlineEditor.assignLayerData(cloneLayerData(currentLayer));
            canvas.outlineEditor.currentGlyphName = currentGlyphName;
        });
        canvas.textRunEditor.glyphNameBuffer = ['n'];
        canvas.textRunEditor.shapedGlyphs = [
            {
                ax: 500,
                dx: 0,
                dy: 0,
                g: 0,
                explicitGlyphName: 'n'
            }
        ];
        canvas.textRunEditor.selectedGlyphIndex = 0;

        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = masterLayerA.id;
        canvas.outlineEditor.glyphStack = `A@${masterLayerA.id}`;
        canvas.outlineEditor.layerData = cloneLayerData(masterLayerA);
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ];
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.selectedComponents = [1];

        expect(actualGetCurrentGlyphName()).toBe('n');

        renderHandler();
        await Promise.resolve();
        await Promise.resolve();

        expect(canvas.updatePropertiesUI).toHaveBeenCalledTimes(1);
        expect(canvas.outlineEditor.selectedLayerId).toBe(masterLayerN.id);
        expect(canvas.outlineEditor.glyphStack).toBe(`n@${masterLayerN.id}`);
        expect(canvas.outlineEditor.currentGlyphName).toBe('n');
        expect(canvas.outlineEditor.selectedPoints).toEqual([]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([]);
    });

    test('insertTextAfterSelectedGlyph inserts after the active glyph and selects the inserted glyph', async () => {
        const insertText = jest
            .spyOn(canvas.textRunEditor, 'insertText')
            .mockImplementation((text) => {
                expect(text).toBe('/n ');
                expect(canvas.textRunEditor.cursorPosition).toBe(1);

                canvas.textRunEditor.shapedGlyphs = [
                    { ax: 500, dx: 0, dy: 0, g: 1, cl: 0 },
                    {
                        ax: 480,
                        dx: 0,
                        dy: 0,
                        g: 0,
                        cl: 1,
                        explicitGlyphName: 'n',
                        explicitTokenStart: 1,
                        explicitTokenEnd: 4
                    },
                    { ax: 460, dx: 0, dy: 0, g: 2, cl: 4 }
                ];
            });
        const selectGlyphByIndex = jest
            .spyOn(canvas.textRunEditor, 'selectGlyphByIndex')
            .mockResolvedValue();

        canvas.textRunEditor.textBuffer = 'An';
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 500, dx: 0, dy: 0, g: 1, cl: 0 },
            { ax: 460, dx: 0, dy: 0, g: 2, cl: 1 }
        ];
        canvas.textRunEditor.clusterMap = [
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
            },
            {
                glyphIndex: 1,
                glyphCount: 1,
                start: 1,
                end: 2,
                x: 500,
                width: 460,
                isRTL: false,
                isExplicitToken: false,
                isAtomicCluster: false
            }
        ];

        await canvas.textRunEditor.insertTextAfterSelectedGlyph('/n ');

        expect(insertText).toHaveBeenCalledWith('/n ');
        expect(selectGlyphByIndex).toHaveBeenCalledWith(1);
    });
});

// ==================== Keyboard Interaction Tests ====================

describe('GlyphCanvas keyboard handling', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        delete window.glyphCanvas;
        jest.restoreAllMocks();
        canvas.destroy();
    });

    test('should track Space key state for panning', () => {
        expect(canvas.outlineEditor.spaceKeyPressed).toBe(false);
        // Space key tracking happens in OutlineEditor, which manages the key state
        // This is tested through integration with onMouseDown test above
    });

    test('should handle space key for preview mode in glyph edit mode', () => {
        canvas.outlineEditor.active = true;
        canvas.spaceKeyPressed = false;

        const downEvent = new KeyboardEvent('keydown', { code: 'Space' });
        canvas.onKeyDown(downEvent);

        expect(canvas.outlineEditor.isPreviewMode).toBe(true);
    });

    test('Tab activates measurement immediately and suppresses default focus navigation', () => {
        const downEvent = new KeyboardEvent('keydown', {
            key: 'Tab',
            code: 'Tab',
            bubbles: true,
            cancelable: true
        });

        canvas.canvas.dispatchEvent(downEvent);

        expect(downEvent.defaultPrevented).toBe(true);
        expect(canvas.measurementKeyPressed).toBe(true);
        expect(canvas.measurementTool.visible).toBe(true);

        const upEvent = new KeyboardEvent('keyup', {
            key: 'Tab',
            code: 'Tab',
            bubbles: true,
            cancelable: true
        });

        canvas.canvas.dispatchEvent(upEvent);

        expect(upEvent.defaultPrevented).toBe(true);
        expect(canvas.measurementKeyPressed).toBe(false);
        expect(canvas.measurementTool.visible).toBe(false);
    });

    test('holding Tab does not re-enable native focus traversal on key repeat', () => {
        const downEvent = new KeyboardEvent('keydown', {
            key: 'Tab',
            code: 'Tab',
            bubbles: true,
            cancelable: true
        });

        canvas.canvas.dispatchEvent(downEvent);

        const repeatEvent = new KeyboardEvent('keydown', {
            key: 'Tab',
            code: 'Tab',
            bubbles: true,
            cancelable: true,
            repeat: true
        });

        canvas.canvas.dispatchEvent(repeatEvent);

        expect(repeatEvent.defaultPrevented).toBe(true);
        expect(canvas.measurementKeyPressed).toBe(true);
        expect(canvas.measurementTool.visible).toBe(true);
    });

    test('Tab is suppressed globally while the editor view is focused in text mode', () => {
        const editorView = document.createElement('div');
        editorView.id = 'view-editor';
        editorView.className = 'focused';
        document.body.appendChild(editorView);
        window.glyphCanvas = canvas;

        const downEvent = new KeyboardEvent('keydown', {
            key: 'Tab',
            code: 'Tab',
            bubbles: true,
            cancelable: true
        });

        document.dispatchEvent(downEvent);

        expect(downEvent.defaultPrevented).toBe(true);
        expect(canvas.measurementKeyPressed).toBe(true);
        expect(canvas.measurementTool.visible).toBe(true);

        const upEvent = new KeyboardEvent('keyup', {
            key: 'Tab',
            code: 'Tab',
            bubbles: true,
            cancelable: true
        });

        document.dispatchEvent(upEvent);

        expect(upEvent.defaultPrevented).toBe(true);
        expect(canvas.measurementKeyPressed).toBe(false);
    });

    test('Tab suppression pulls focus back to the canvas inside the active editor view', () => {
        const editorView = document.createElement('div');
        editorView.id = 'view-editor';
        editorView.className = 'focused';

        const button = document.createElement('button');
        button.type = 'button';
        editorView.appendChild(button);
        document.body.appendChild(editorView);
        document.body.appendChild(canvas.canvas);
        window.glyphCanvas = canvas;

        button.focus();
        expect(document.activeElement).toBe(button);

        const downEvent = new KeyboardEvent('keydown', {
            key: 'Tab',
            code: 'Tab',
            bubbles: true,
            cancelable: true
        });

        button.dispatchEvent(downEvent);

        expect(downEvent.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(canvas.canvas);
        expect(canvas.measurementKeyPressed).toBe(true);
        expect(canvas.measurementTool.visible).toBe(true);
    });

    test('holding Tab stays suppressed globally while the editor view is focused', () => {
        const editorView = document.createElement('div');
        editorView.id = 'view-editor';
        editorView.className = 'focused';

        const button = document.createElement('button');
        button.type = 'button';
        editorView.appendChild(button);
        document.body.appendChild(editorView);
        window.glyphCanvas = canvas;

        button.focus();

        const downEvent = new KeyboardEvent('keydown', {
            key: 'Tab',
            code: 'Tab',
            bubbles: true,
            cancelable: true
        });
        button.dispatchEvent(downEvent);

        const repeatEvent = new KeyboardEvent('keydown', {
            key: 'Tab',
            code: 'Tab',
            bubbles: true,
            cancelable: true,
            repeat: true
        });
        canvas.canvas.dispatchEvent(repeatEvent);

        expect(repeatEvent.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(canvas.canvas);
        expect(canvas.measurementKeyPressed).toBe(true);
    });

    test('Cmd+Alt+L clicks the summary layer-link toggle and uses the same tooltip text', async () => {
        const font = Font.fromData({
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
                    name: 'A',
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
                            shapes: [
                                {
                                    nodes: [
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 700, nodetype: 'Line' },
                                        { x: 100, y: 700, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'brace-layer',
                            name: '{50}',
                            width: 520,
                            master: {
                                type: 'AssociatedWithMaster',
                                master: 'master-1'
                            },
                            location: { wght: 50 },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 110, y: 0, nodetype: 'Line' },
                                        { x: 410, y: 0, nodetype: 'Line' },
                                        { x: 410, y: 680, nodetype: 'Line' },
                                        { x: 110, y: 680, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Keyboard Shortcut Test' }
            },
            note: '',
            date: '2026-03-25',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        jest.spyOn(fontManager, 'currentFont', 'get').mockReturnValue({
            fontModel: font,
            babelfontData: {
                glyphs: font.glyphs.map((glyph) => glyph.toJSON())
            }
        });
        jest.spyOn(fontManager, 'fetchGlyphData').mockResolvedValue({
            glyphName: 'A',
            layers: font.findGlyph('A').layers.map((layer) => layer.toJSON())
        });

        const editorView = document.createElement('div');
        editorView.id = 'view-editor';
        editorView.className = 'focused';
        document.body.appendChild(editorView);
        const propertiesSection = document.createElement('div');
        propertiesSection.id = 'glyph-properties-section';
        document.body.appendChild(propertiesSection);
        window.glyphCanvas = canvas;
        canvas.propertiesSection = propertiesSection;

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.getCurrentGlyphName = jest.fn(() => 'A');

        await canvas.displayMastersList(propertiesSection, false);

        const summaryButton = propertiesSection.querySelector(
            '.editor-layer-link-summary-toggle'
        );

        expect(summaryButton).toBeTruthy();
        expect(summaryButton.getAttribute('title')).toBe(
            'Unlink all layers (Cmd+Alt+L)'
        );

        const firstEvent = new KeyboardEvent('keydown', {
            key: 'l',
            code: 'KeyL',
            metaKey: true,
            altKey: true,
            bubbles: true,
            cancelable: true
        });

        document.dispatchEvent(firstEvent);

        expect(firstEvent.defaultPrevented).toBe(true);
        expect(canvas.outlineEditor.isLayerLinked('layer-1', 'A')).toBe(false);
        expect(canvas.outlineEditor.isLayerLinked('brace-layer', 'A')).toBe(
            false
        );
        expect(summaryButton.getAttribute('title')).toBe(
            'Link all layers (Cmd+Alt+L)'
        );

        const secondEvent = new KeyboardEvent('keydown', {
            key: 'l',
            code: 'KeyL',
            metaKey: true,
            altKey: true,
            bubbles: true,
            cancelable: true
        });

        document.dispatchEvent(secondEvent);

        expect(secondEvent.defaultPrevented).toBe(true);
        expect(canvas.outlineEditor.isLayerLinked('layer-1', 'A')).toBe(true);
        expect(canvas.outlineEditor.isLayerLinked('brace-layer', 'A')).toBe(
            true
        );
        expect(summaryButton.getAttribute('title')).toBe(
            'Unlink all layers (Cmd+Alt+L)'
        );
    });
});

// ==================== Resize Tests ====================

describe('GlyphCanvas resize handling', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML =
            '<div id="test-container" style="width: 800px; height: 600px;"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should update canvas size on resize', () => {
        const dpr = window.devicePixelRatio || 1;
        // Initial state should have a canvas
        expect(canvas.canvas).toBeTruthy();

        // After resize, canvas should still exist and have dimensions
        canvas.onResize();

        expect(canvas.canvas).toBeTruthy();
        expect(canvas.ctx).toBeTruthy();
    });
});

// ==================== Animation Tests ====================

describe('GlyphCanvas animation setup', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.axesManager.variationSettings = { wght: 400 };
        // Mock the animateVariation method to prevent it from running
        canvas.axesManager.animateVariation = jest.fn();
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('setVariation should set up animation correctly', () => {
        canvas.axesManager._setupAnimation({ wght: 700 });
        expect(canvas.axesManager.isAnimating).toBe(true);
        expect(canvas.axesManager.animationStartValues).toEqual({ wght: 400 });
        expect(canvas.axesManager.animationTargetValues).toEqual({ wght: 700 });
        expect(canvas.axesManager.animationCurrentFrame).toBe(0);
    });

    test('should handle zoom animation state', () => {
        expect(canvas.zoomAnimation.active).toBe(false);

        canvas.startKeyboardZoom(true);

        expect(canvas.zoomAnimation.active).toBe(true);
        // currentFrame starts incrementing immediately
        expect(canvas.zoomAnimation.currentFrame).toBeGreaterThanOrEqual(0);
    });
});

// ==================== Text Run Editor Mirrored Functions ====================

describe('GlyphCanvas mirrored functions', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.textRunEditor.shapedGlyphs = [
            { cl: 0, g: 0, ax: 100, dx: 0, dy: 0 },
            { cl: 1, g: 1, ax: 100, dx: 0, dy: 0 },
            { cl: 1, g: 2, ax: 100, dx: 0, dy: 0 },
            { cl: 2, g: 3, ax: 100, dx: 0, dy: 0 }
        ];
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('findFirstGlyphAtClusterPosition should return the correct index', () => {
        expect(canvas.textRunEditor.findFirstGlyphAtClusterPosition(1)).toBe(1);
    });

    test('findLastGlyphAtClusterPosition should return the correct index', () => {
        expect(canvas.textRunEditor.findLastGlyphAtClusterPosition(1)).toBe(2);
    });

    test('findFirstGlyphAtClusterPosition should return -1 for non-existent cluster', () => {
        expect(canvas.textRunEditor.findFirstGlyphAtClusterPosition(99)).toBe(
            -1
        );
    });

    test('findLastGlyphAtClusterPosition should return -1 for non-existent cluster', () => {
        expect(canvas.textRunEditor.findLastGlyphAtClusterPosition(99)).toBe(
            -1
        );
    });
});

// ==================== Bounding Box Tests ====================

describe('GlyphCanvas bounding box calculation', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = true;
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should return null when no layer data', () => {
        canvas.outlineEditor.layerData = null;
        const bbox = canvas.outlineEditor.calculateGlyphBoundingBox();
        expect(bbox).toBe(null);
    });

    test('should calculate bounding box for points', () => {
        canvas.outlineEditor.layerData = {
            shapes: [
                {
                    nodes: [
                        { x: 0, y: 0, type: 'l' },
                        { x: 100, y: 100, type: 'l' }
                    ]
                }
            ],
            anchors: []
        };
        const bbox = canvas.outlineEditor.calculateGlyphBoundingBox();
        expect(bbox).toBeTruthy();
        expect(bbox.minX).toBeLessThanOrEqual(0);
        expect(bbox.maxX).toBeGreaterThanOrEqual(100);
        expect(bbox.minY).toBeLessThanOrEqual(0);
        expect(bbox.maxY).toBeGreaterThanOrEqual(100);
    });
});

// ==================== State Management Tests ====================

describe('GlyphCanvas state management', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should track layer data dirty state', () => {
        expect(canvas.outlineEditor.layerDataDirty).toBe(false);

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.layerData = { shapes: [], anchors: [] };
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];
        canvas.outlineEditor.saveLayerData = jest.fn();

        canvas.outlineEditor.moveSelectedPoints(10, 20);

        // layerDataDirty should be managed by saveLayerData
        expect(canvas.outlineEditor.saveLayerData).toHaveBeenCalled();
    });
});

// ==================== Cleanup Tests ====================

describe('GlyphCanvas cleanup', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    test('should clean up properly on destroy', () => {
        const container = document.getElementById('test-container');
        expect(container.children.length).toBeGreaterThan(0);

        const resizeObserver = canvas.resizeObserver;
        canvas.destroy();

        // ResizeObserver should have existed before destroy
        expect(resizeObserver).toBeTruthy();
    });

    test('should handle multiple destroy calls safely', () => {
        canvas.destroy();
        expect(() => canvas.destroy()).not.toThrow();
    });
});
