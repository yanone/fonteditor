/**
 * Outline Editing — Canonical Tests
 *
 * These tests lock down APP.md § Editing Existing Outlines:
 *
 *   - Shift-constrained dragging of smooth off-curve triplets
 *   - Alt-constrained dragging of smooth on-curve points
 *   - Alt-constrained dragging of non-smooth off-curve points
 *   - Smooth eligibility and loss of smoothness when a curve side disappears
 *   - Neighbor-glyph snap candidates always participating in snapping,
 *     ordered by distance from the dragged node's original position
 */

const { Font } = require('../../js/babelfont-model');
const fontManager = require('../../js/font-manager').default;

function activateEditableLayer(canvas, layerData) {
    canvas.outlineEditor.active = true;
    canvas.outlineEditor.currentGlyphName = 'A';
    canvas.outlineEditor.selectedLayerId = 'layer-1';
    canvas.outlineEditor.glyphStack = 'A@layer-1';
    canvas.outlineEditor.layerData = {
        id: 'layer-1',
        width: 520,
        shapes: [],
        anchors: [],
        guides: [],
        ...layerData
    };
}

function makeOpenTripletLayer({ smooth = true } = {}) {
    return {
        width: 520,
        shapes: [
            {
                nodes: [
                    { x: 0, y: 0, nodetype: 'Move', smooth: false },
                    { x: 20, y: 20, nodetype: 'OffCurve', smooth: false },
                    { x: 40, y: 60, nodetype: 'OffCurve', smooth: false },
                    { x: 60, y: 60, nodetype: 'Curve', smooth },
                    { x: 80, y: 60, nodetype: 'OffCurve', smooth: false },
                    { x: 100, y: 20, nodetype: 'OffCurve', smooth: false },
                    { x: 120, y: 0, nodetype: 'Curve', smooth: false }
                ],
                closed: false
            }
        ],
        anchors: [],
        guides: []
    };
}

function makeEligibleToggleLayer() {
    return {
        width: 520,
        shapes: [
            {
                nodes: [
                    { x: 0, y: 0, nodetype: 'Move', smooth: false },
                    { x: 20, y: 20, nodetype: 'OffCurve', smooth: false },
                    { x: 40, y: 60, nodetype: 'OffCurve', smooth: false },
                    { x: 60, y: 60, nodetype: 'Curve', smooth: false },
                    { x: 80, y: 40, nodetype: 'OffCurve', smooth: false },
                    { x: 100, y: 20, nodetype: 'OffCurve', smooth: false },
                    { x: 120, y: 0, nodetype: 'Curve', smooth: false }
                ],
                closed: false
            }
        ],
        anchors: [],
        guides: []
    };
}

function makeOneSidedCurveLayer() {
    return {
        width: 520,
        shapes: [
            {
                nodes: [
                    { x: 0, y: 0, nodetype: 'Move', smooth: false },
                    { x: 20, y: 20, nodetype: 'OffCurve', smooth: false },
                    { x: 40, y: 60, nodetype: 'OffCurve', smooth: false },
                    { x: 60, y: 60, nodetype: 'Curve', smooth: false },
                    { x: 120, y: 60, nodetype: 'Line', smooth: false }
                ],
                closed: false
            }
        ],
        anchors: [],
        guides: []
    };
}

function makeSinglePathFont(nodes, closed = false) {
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
                        shapes: [{ nodes, closed }],
                        anchors: [],
                        guides: []
                    }
                ]
            }
        ],
        names: { family_name: { en: 'Outline Editing Canonical' } },
        note: '',
        date: '2026-03-31',
        features: {},
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    });
}

describe('Outline Editing canonical behavior', () => {
    let canvas;
    let currentFontSpy;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(null);
        window.changeBridge = null;
        window.currentFontModel = null;
    });

    afterEach(() => {
        currentFontSpy.mockRestore();
        window.changeBridge = null;
        window.currentFontModel = null;
        canvas.destroy();
    });

    test('shift-constrained smooth off-curve dragging aligns the triplet to an axis', () => {
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockResolvedValue(undefined);

        try {
            activateEditableLayer(
                canvas,
                makeOpenTripletLayer({ smooth: true })
            );
            canvas.outlineEditor.hoveredPointIndex = {
                contourIndex: 0,
                nodeIndex: 4
            };
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn()
            };

            let pointer = { glyphX: 80, glyphY: 60 };
            const pointerSpy = jest
                .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
                .mockImplementation(() => pointer);

            canvas.outlineEditor.onSingleClick({
                clientX: 10,
                clientY: 20,
                detail: 1,
                shiftKey: true,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            canvas.outlineEditor.onMouseMove({
                clientX: 11,
                clientY: 21,
                shiftKey: true,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });
            pointer = { glyphX: 110, glyphY: 100 };
            canvas.outlineEditor.onMouseMove({
                clientX: 12,
                clientY: 22,
                shiftKey: true,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            const nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
            const anchor = nodes[3];
            const draggedHandle = nodes[4];
            const oppositeHandle = nodes[2];
            const horizontalAligned =
                draggedHandle.y === anchor.y && oppositeHandle.y === anchor.y;
            const verticalAligned =
                draggedHandle.x === anchor.x && oppositeHandle.x === anchor.x;

            expect(horizontalAligned || verticalAligned).toBe(true);

            pointerSpy.mockRestore();
        } finally {
            saveLayerDataSpy.mockRestore();
        }
    });

    test('alt toggling during smooth on-curve dragging constrains and restores movement on the handle axis', () => {
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockResolvedValue(undefined);

        try {
            activateEditableLayer(
                canvas,
                makeOpenTripletLayer({ smooth: true })
            );
            canvas.outlineEditor.hoveredPointIndex = {
                contourIndex: 0,
                nodeIndex: 3
            };
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn()
            };

            let pointer = { glyphX: 60, glyphY: 60 };
            const pointerSpy = jest
                .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
                .mockImplementation(() => pointer);

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
            pointer = { glyphX: 90, glyphY: 90 };
            canvas.outlineEditor.onMouseMove({
                clientX: 12,
                clientY: 22,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            let nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
            expect(nodes[3].x).toBe(90);
            expect(nodes[3].y).toBe(90);
            expect(nodes[2].y).toBe(90);
            expect(nodes[4].y).toBe(90);

            canvas.outlineEditor.setAltKeyPressed(true);
            nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
            expect(nodes[3].x).toBe(90);
            expect(nodes[3].y).toBe(60);
            expect(nodes[2].y).toBe(60);
            expect(nodes[4].y).toBe(60);

            canvas.outlineEditor.setAltKeyPressed(false);
            nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
            expect(nodes[3].x).toBe(90);
            expect(nodes[3].y).toBe(90);
            expect(nodes[2].y).toBe(90);
            expect(nodes[4].y).toBe(90);

            pointerSpy.mockRestore();
        } finally {
            saveLayerDataSpy.mockRestore();
        }
    });

    test('alt re-press during non-smooth off-curve dragging returns to the original drag-start direction', () => {
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockResolvedValue(undefined);

        try {
            activateEditableLayer(canvas, {
                width: 520,
                shapes: [
                    {
                        nodes: [
                            { x: 0, y: 0, nodetype: 'Curve', smooth: false },
                            {
                                x: 40,
                                y: 0,
                                nodetype: 'OffCurve',
                                smooth: false
                            },
                            {
                                x: 80,
                                y: 40,
                                nodetype: 'OffCurve',
                                smooth: false
                            },
                            {
                                x: 120,
                                y: 0,
                                nodetype: 'Curve',
                                smooth: false
                            }
                        ],
                        closed: false
                    }
                ],
                anchors: [],
                guides: []
            });
            canvas.outlineEditor.hoveredPointIndex = {
                contourIndex: 0,
                nodeIndex: 1
            };
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn()
            };

            let pointer = { glyphX: 40, glyphY: 0 };
            const pointerSpy = jest
                .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
                .mockImplementation(() => pointer);

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
            pointer = { glyphX: 60, glyphY: 30 };
            canvas.outlineEditor.onMouseMove({
                clientX: 12,
                clientY: 22,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            let draggedNode = canvas.outlineEditor.layerData.shapes[0].nodes[1];
            expect(draggedNode.x).toBe(60);
            expect(draggedNode.y).toBe(30);

            canvas.outlineEditor.setAltKeyPressed(true);
            draggedNode = canvas.outlineEditor.layerData.shapes[0].nodes[1];
            expect(draggedNode.x).toBe(60);
            expect(draggedNode.y).toBe(0);

            canvas.outlineEditor.setAltKeyPressed(false);
            draggedNode = canvas.outlineEditor.layerData.shapes[0].nodes[1];
            expect(draggedNode.x).toBe(60);
            expect(draggedNode.y).toBe(30);

            pointer = { glyphX: 90, glyphY: 50 };
            canvas.outlineEditor.onMouseMove({
                clientX: 13,
                clientY: 23,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });
            canvas.outlineEditor.setAltKeyPressed(true);

            draggedNode = canvas.outlineEditor.layerData.shapes[0].nodes[1];
            expect(draggedNode.x).toBe(90);
            expect(draggedNode.y).toBe(0);

            pointerSpy.mockRestore();
        } finally {
            saveLayerDataSpy.mockRestore();
        }
    });

    test('triplet on-curve points can toggle smooth and align the opposite handle to an existing axis', () => {
        activateEditableLayer(canvas, makeEligibleToggleLayer());
        canvas.outlineEditor.saveLayerData = jest.fn();

        canvas.outlineEditor.togglePointSmooth({
            contourIndex: 0,
            nodeIndex: 3
        });

        const nodes = canvas.outlineEditor.layerData.shapes[0].nodes;
        expect(nodes[3].smooth).toBe(true);
        expect(nodes[4].y).toBe(60);
    });

    test('on-curve points with a curve on only one side cannot be toggled smooth', () => {
        activateEditableLayer(canvas, makeOneSidedCurveLayer());
        canvas.outlineEditor.saveLayerData = jest.fn();

        canvas.outlineEditor.togglePointSmooth({
            contourIndex: 0,
            nodeIndex: 3
        });

        expect(
            canvas.outlineEditor.layerData.shapes[0].nodes[3].smooth
        ).not.toBe(true);
    });

    test('deleting a handle into a line clears smooth on the affected on-curve points', () => {
        const font = makeSinglePathFont(
            [
                { x: 0, y: 0, nodetype: 'Curve', smooth: true },
                { x: 30, y: 60, nodetype: 'OffCurve' },
                { x: 70, y: 60, nodetype: 'OffCurve' },
                { x: 100, y: 0, nodetype: 'Curve', smooth: true }
            ],
            false
        );
        const path = font.glyphs[0].layers[0].paths[0];

        expect(path._deleteNode(1)).toBe(true);
        expect(path.nodes.map((node) => node.nodetype)).toEqual([
            'Curve',
            'Line'
        ]);
        expect(path.nodes[0].smooth).toBe(false);
        expect(path.nodes[1].smooth).toBe(false);
    });

    test('neighbor glyph snap candidates always participate and remain globally sorted by distance from the drag origin', () => {
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
            names: { family_name: { en: 'Outline Snap Canonical' } },
            note: '',
            date: '2026-03-31',
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
        window.currentFontModel = font;

        activateEditableLayer(canvas, {
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
        });
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

        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.isSlidingSmoothPointAlongCurve = false;
        canvas.outlineEditor._snapDragStartMouseX = 100;
        canvas.outlineEditor._snapDragStartMouseY = 0;
        canvas.outlineEditor._snapDragStartNodePos = { x: 100, y: 0 };
        canvas.outlineEditor._rebuildSnapCandidateCache();

        const cache = canvas.outlineEditor._snapCandidateCache;
        expect(cache.allDragCandidates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ source: 'left', x: -280, y: 10 }),
                expect.objectContaining({ source: 'right', x: 440, y: 30 })
            ])
        );

        for (let index = 1; index < cache.allDragCandidates.length; index++) {
            const previous = cache.allDragCandidates[index - 1];
            const current = cache.allDragCandidates[index];
            const previousDistance = Math.hypot(previous.x - 100, previous.y);
            const currentDistance = Math.hypot(current.x - 100, current.y);
            expect(currentDistance).toBeGreaterThanOrEqual(previousDistance);
        }

        const snapped = canvas.outlineEditor._applySnapToDelta(
            338,
            28,
            438,
            28,
            100,
            0
        );
        expect(snapped.deltaX).toBe(340);
        expect(snapped.deltaY).toBe(30);
        expect(canvas.outlineEditor.activeSnapTarget).toEqual(
            expect.objectContaining({
                xSource: expect.objectContaining({ source: 'right' }),
                ySource: expect.objectContaining({ source: 'right' })
            })
        );
    });
});
