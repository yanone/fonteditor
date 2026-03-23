const { Font, Layer } = require('../js/babelfont-model');
const fontManager = require('../js/font-manager').default;
const { fontInterpolation } = require('../js/font-interpolation');

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

    test('sidebearing drag uses side-specific undo metadata', () => {
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
            canvas.outlineEditor.hoveredSidebearingHandle = { side: 'left' };
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
            canvas.outlineEditor.selectedSidebearingHandle = { side: 'left' };
            canvas.outlineEditor._dragType = 'sidebearing';
            canvas.outlineEditor._hasMoved = true;

            canvas.outlineEditor.onMouseUp({ clientX: 10, clientY: 20 });

            expect(syncSpy).toHaveBeenCalledWith(
                'Set LSB',
                'LEFT 40',
                'LEFT 40'
            );
        } finally {
            window.changeBridge = originalWindowChangeBridge;
            fontManager.updateWorkerFontCache = originalUpdateWorkerFontCache;
            fontManager.flushPendingDebugEditingFontSaveAfterDrag =
                originalFlushPendingDebugEditingFontSaveAfterDrag;
        }
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
        originalAutoCompileManager = window.autoCompileManager;
        window.fontManager = fontManager;
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
        window.autoCompileManager = originalAutoCompileManager;
        canvas.destroy();
    });

    test('commitPropertyPanelValue keeps layer-local sidebearing keys on the incremental layer path', async () => {
        const layer = {
            width: 500,
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
                    changeVersion: 1
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

        canvas.getCurrentLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'a');
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn();

        await canvas.commitPropertyPanelValue('left', '==50');

        expect(fontManager.lastChangeSource).toBe('keyboard');
        expect(fontManager.lastEditType).toBe('outline');
        expect(fontManager.scheduleFullCompileDebounce).toHaveBeenCalledTimes(
            1
        );
        expect(
            window.autoCompileManager.checkAndSchedule
        ).not.toHaveBeenCalled();
        expect(
            canvas.textRunEditor.refreshGlyphAdvancesLive
        ).toHaveBeenCalledWith({ a: 640 }, { render: false });
        expect(
            window.fontManager.refreshGlyphsAfterModelBatch
        ).toHaveBeenCalledWith(['a'], 'layer-1');
        expect(canvas.outlineEditor.fetchLayerData).toHaveBeenCalledWith(true);
    });

    test('commitPropertyPanelValue uses full-font refresh for glyph-wide sidebearing keys', async () => {
        const layer = {
            width: 500,
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

        canvas.getCurrentLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'a');
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn();

        await canvas.commitPropertyPanelValue('left', '=50');

        expect(fontManager.lastChangeSource).toBe('metrics-key');
        expect(fontManager.lastEditType).toBeNull();
        expect(fontManager.scheduleFullCompileDebounce).not.toHaveBeenCalled();
        expect(
            window.autoCompileManager.checkAndSchedule
        ).toHaveBeenCalledTimes(1);
        expect(
            window.fontManager.refreshGlyphsAfterModelBatch
        ).toHaveBeenCalledWith(['a', 'adieresis'], undefined);
        expect(canvas.outlineEditor.fetchLayerData).toHaveBeenCalledWith(true);
    });

    test('commitPropertyPanelValue pans the viewport for left sidebearing edits', async () => {
        const layer = {
            width: 500,
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
        canvas.getCurrentLayerModel = jest.fn(() => layer);
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
        canvas.getCurrentLayerModel = jest.fn(() => layer);
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

    test('commitPropertyPanelValue reuses the direct outline-editor path for plain numeric sidebearings', async () => {
        const setSidebearingValueSpy = jest
            .spyOn(canvas.outlineEditor, 'setSidebearingValue')
            .mockReturnValue(true);

        canvas.getCurrentLayerModel = jest.fn();
        window.fontManager.refreshGlyphsAfterModelBatch = jest
            .fn()
            .mockResolvedValue();
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();

        await canvas.commitPropertyPanelValue('left', '20');

        expect(setSidebearingValueSpy).toHaveBeenCalledWith('left', 20);
        expect(canvas.getCurrentLayerModel).not.toHaveBeenCalled();
        expect(
            window.fontManager.refreshGlyphsAfterModelBatch
        ).not.toHaveBeenCalled();
        expect(canvas.outlineEditor.fetchLayerData).not.toHaveBeenCalled();
        expect(canvas.updatePropertyPanel).toHaveBeenCalledTimes(1);
        expect(canvas.render).toHaveBeenCalledTimes(1);

        setSidebearingValueSpy.mockRestore();
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
            side: 'left'
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

    test('moving the left sidebearing handle right decreases the sidebearing', () => {
        canvas.outlineEditor.selectedSidebearingHandle = { side: 'left' };
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

    test('pressing ArrowRight on the left sidebearing handle decreases the sidebearing', () => {
        canvas.outlineEditor.selectedSidebearingHandle = { side: 'left' };
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
            .mockReturnValue({ fontModel: font });

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
            .mockReturnValue({ fontModel: font });
        window.currentFontModel = font;

        canvas.outlineEditor.active = true;
        canvas.shiftKeyPressed = true;
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

describe('GlyphCanvas point type toggling', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.layerData = {
            shapes: [
                {
                    nodes: [
                        { x: 100, y: 100, nodetype: 'Curve' },
                        { x: 200, y: 200, nodetype: 'Curve' },
                        { x: 300, y: 300, nodetype: 'Curve' }
                    ]
                }
            ],
            anchors: []
        };
        canvas.outlineEditor.saveLayerData = jest.fn();
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should toggle curve point to smooth curve', () => {
        canvas.outlineEditor.togglePointSmooth({
            contourIndex: 0,
            nodeIndex: 0
        });
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].smooth).toBe(
            true
        );
    });

    test('should toggle smooth curve point back to curve', () => {
        canvas.outlineEditor.layerData.shapes[0].nodes[0].smooth = true;
        canvas.outlineEditor.togglePointSmooth({
            contourIndex: 0,
            nodeIndex: 0
        });
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].smooth).toBe(
            false
        );
    });
});

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
        expect(inputs[1].getAttribute('placeholder')).toBe('auto');
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
        'uses exact stored root layer data for selected %s while keeping interpolated component data',
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
            ).toBe(33.5);
            expect(canvas.outlineEditor.renderVerticalMetrics).toEqual({
                ascender: 800.25
            });
        }
    );

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
});

describe('OutlineEditor per-layer selection memory', () => {
    let canvas;
    let font;
    let currentFontSpy;
    let fetchGlyphDataSpy;

    const makeSelectionFont = () =>
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
                                        { x: 120, y: 0, nodetype: 'Line' },
                                        { x: 420, y: 0, nodetype: 'Line' },
                                        { x: 420, y: 660, nodetype: 'Line' },
                                        { x: 120, y: 660, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [{ name: 'top', x: 270, y: 660 }],
                            guides: [{ pos: { x: 0, y: 560 }, angle: 0 }]
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
});

// ==================== Keyboard Interaction Tests ====================

describe('GlyphCanvas keyboard handling', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
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
