/**
 * Sidebearing Keys — Canonical Tests
 *
 * These tests lock down the behavior described in APP.md § Sidebearing Keys:
 *
 *   "Since sidebearings are not supposed to change when a user edits anything
 *    on a layer with inherited linked sidebearings, the sidebearings will be
 *    kept up-to-date if the glyph's left-most or right-most nodes or component
 *    bounding boxes are responsible for left or right side layer bounding box
 *    changes."
 *
 *   "During edits from mouse-dragging, the width of the active glyph in the
 *    buffer must be updated live and without any lag by adjusting all
 *    occurrences of its advance width in the harfbuzz buffer and immediately
 *    redrawing."
 *
 *   "Simultaneously, once a glyph's sidebearing changes, all downstream glyphs
 *    who inherit the active glyph's sidebearings must be updated as well."
 *
 *   "Update canvas panning: When sidebearings change, be it by editing outlines
 *    or components, or via the dedicated sidebearing handles on canvas, or via
 *    the property panel text fields, or via undo, update the canvas rendering as
 *    follows: If the RSB changes, anchor the canvas to the left edge of the glyph.
 *    If the LSB changes, anchor the canvas to the right edge of the glyph."
 *
 * Fixture: examples/metricskeys.glyphs
 *   - glyph a:        metricRight = n  (glyph-level, RSB key only)
 *   - glyph n:        metricLeft = "=l-5", metricRight = "=l-10"  (both keys)
 *   - glyph l:        no metrics keys  (source for n)
 *   - glyph adieresis / aring: composites of a
 */

const fs = require('fs');
const path = require('path');
const {
    Font,
    Path,
    DecomposedAffineTransform
} = require('../../js/babelfont-model');
const { LayerDataNormalizer } = require('../../js/layer-data-normalizer');
const fontManager = require('../../js/font-manager').default;
const {
    inferSidebearingPanSideFromMetricsKeys
} = require('../../js/sidebearing-utils');
const {
    open_font_file,
    store_font,
    interpolate_glyph,
    clear_font_cache
} = require('../../wasm-dist/babelfont_fontc_web');

function loadFontFixture(fileName) {
    const fixturePath = path.join(__dirname, '..', '..', 'examples', fileName);
    const fileContents = fs.readFileSync(fixturePath, 'utf-8');
    return JSON.parse(open_font_file(fileName, fileContents));
}

// ==================== Setup ====================

let canvas;
let currentFontSpy;

beforeEach(() => {
    document.body.innerHTML = '<div id="test-container"></div>';
    canvas = new GlyphCanvas('test-container');
    currentFontSpy = jest
        .spyOn(fontManager, 'currentFont', 'get')
        .mockReturnValue(null);
    window.changeBridge = null;
});

afterEach(() => {
    currentFontSpy.mockRestore();
    if (canvas) {
        canvas.destroy();
    }
});

// ==================== Helpers ====================

/**
 * Set up a canvas for editing a specific glyph in a font model.
 */
/**
 * Parse node data, handling both string and array formats.
 */
function ensureParsedNodes(nodesData) {
    if (typeof nodesData === 'string') {
        return Path.parseNodesString(nodesData);
    }
    return Array.isArray(nodesData) ? nodesData : [];
}

function setupCanvasForGlyph(font, glyphName) {
    const glyph = font.findGlyph(glyphName);
    const layer = glyph.layers[0];
    const masterId = layer.master.master;

    // Access model paths to trigger lazy string→array node conversion
    void layer.paths;

    currentFontSpy.mockRestore();
    currentFontSpy = jest
        .spyOn(fontManager, 'currentFont', 'get')
        .mockReturnValue({ fontModel: font });

    // Normalize layer data the same way the outline editor does (parses string
    // nodes into arrays, etc.) — this matches real app behavior.
    canvas.outlineEditor.layerData = LayerDataNormalizer.normalize(
        { ...layer.toJSON(), isInterpolated: false },
        false
    );
    canvas.outlineEditor.selectedLayerId = layer.id;
    canvas.outlineEditor.parseGlyphStack = jest.fn(() => [{ glyphName }]);
    canvas.getCurrentGlyphName = jest.fn(() => glyphName);
    canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn(() => true);

    return { glyph, layer, masterId };
}

// ==================== Tests ====================

describe('inferSidebearingPanSideFromMetricsKeys', () => {
    test('returns null when no metrics keys are set', () => {
        expect(
            inferSidebearingPanSideFromMetricsKeys(undefined, undefined)
        ).toBeNull();
    });

    test('returns null for RSB-only key (left edge already anchored at panX)', () => {
        expect(
            inferSidebearingPanSideFromMetricsKeys(undefined, '=n')
        ).toBeNull();
    });

    test('returns null when both keys are set (glyph fully locked by keys)', () => {
        expect(
            inferSidebearingPanSideFromMetricsKeys('=l-5', '=l-10')
        ).toBeNull();
    });

    test('returns left for LSB-only key (anchor right edge during width change)', () => {
        expect(inferSidebearingPanSideFromMetricsKeys('=ref', undefined)).toBe(
            'left'
        );
    });
});

describe('Sidebearing keys: live recompute during mouse drags', () => {
    test('dragging a point on a glyph with right sidebearing key adjusts width to preserve RSB', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        const { glyph, layer, masterId } = setupCanvasForGlyph(font, 'n');

        // n has rightMetricsKey = "=l-10", so n's RSB should always be l's RSB - 10
        const lLayer = font.findGlyph('l').findLayerByMasterId(masterId);
        const targetRsb = lLayer.rsb - 10;

        // Record the initial state
        const initialWidth =
            canvas.outlineEditor.getCurrentLayerDataFromStack().width;
        const initialRsb = layer.rsb;

        // Verify initial RSB matches the key
        expect(Math.abs(initialRsb - targetRsb)).toBeLessThanOrEqual(1);

        // Simulate a point drag: move rightmost point further right by 20 units.
        // This should cause RSB to decrease unless width is adjusted.
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        const currentLayerData =
            canvas.outlineEditor.getCurrentLayerDataFromStack();

        // Find the rightmost node and move it
        const shapes = currentLayerData.shapes || [];
        let maxX = -Infinity;
        let rightmostNode = null;
        for (const shape of shapes) {
            const nodes = shape.nodes || (shape.Path && shape.Path.nodes) || [];
            const nodesArray = ensureParsedNodes(nodes);
            for (const node of nodesArray) {
                if (node.x > maxX) {
                    maxX = node.x;
                    rightmostNode = node;
                }
            }
        }

        expect(rightmostNode).not.toBeNull();
        rightmostNode.x += 20; // Move rightmost point 20 units right

        // Call the metrics key recompute that happens during drag
        const result =
            canvas.outlineEditor.applyMetricsKeysToCurrentEditedLayer();

        // Width must have increased to maintain RSB
        const newWidth = currentLayerData.width;
        expect(newWidth).toBeGreaterThan(initialWidth);
        expect(newWidth - initialWidth).toBeCloseTo(20, 0);

        // The live advance widths should include the active glyph and downstream
        expect(result).not.toBeNull();
        expect(result.glyphAdvances).toBeDefined();
        expect(result.glyphAdvances.n).toBeDefined();
    });

    test('dragging a sidebearing on glyph l updates downstream glyph n width', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        const { glyph, layer, masterId } = setupCanvasForGlyph(font, 'l');

        // n has metricLeft = "=l-5" and metricRight = "=l-10"
        // Changing l's width should cascade to n, and from n possibly to a
        const nLayerBefore = font.findGlyph('n').findLayerByMasterId(masterId);
        const nWidthBefore = nLayerBefore.width;

        canvas.outlineEditor.isDraggingSidebearing = true;
        canvas.outlineEditor.selectedSidebearingHandle = { side: 'right' };

        // Move RSB by 17 (same as existing test — increases width by 17)
        canvas.outlineEditor._updateDraggedSidebearing(17);

        // n's width should have changed because n's sidebearing key references l
        const nWidthAfter = nLayerBefore.width;
        expect(nWidthAfter).not.toBe(nWidthBefore);

        // Advance widths should be refreshed
        expect(
            canvas.textRunEditor.refreshGlyphAdvancesLive
        ).toHaveBeenCalled();

        const advancesCall =
            canvas.textRunEditor.refreshGlyphAdvancesLive.mock.calls[0][0];
        expect(advancesCall).toHaveProperty('l');
        expect(advancesCall).toHaveProperty('n');
        expect(advancesCall).toHaveProperty('a');
    });

    test('point drag on glyph with LEFT sidebearing key adjusts width and pans to anchor right edge', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        const { masterId } = setupCanvasForGlyph(font, 'n');

        const scale = 2;
        canvas.viewportManager.scale = scale;
        const initialPanX = 100;
        canvas.viewportManager.panX = initialPanX;

        // n has leftMetricsKey = "=l-5" (and rightMetricsKey = "=l-10").
        // Moving the leftmost node left fires the LSB key. The key translates
        // ALL nodes rightward to restore LSB, widening the advance.  Because the
        // shapes translated, the right edge of the advance must stay on screen.
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        const currentLayerData =
            canvas.outlineEditor.getCurrentLayerDataFromStack();
        const widthBefore = currentLayerData.width;

        // Move ONLY the leftmost node left by 20 units.
        const shapes = currentLayerData.shapes || [];
        let minX = Infinity;
        let leftmostNode = null;
        for (const shape of shapes) {
            const nodesArray = ensureParsedNodes(
                shape.nodes || (shape.Path && shape.Path.nodes) || []
            );
            for (const node of nodesArray) {
                if (node.x < minX) {
                    minX = node.x;
                    leftmostNode = node;
                }
            }
        }
        expect(leftmostNode).not.toBeNull();
        leftmostNode.x -= 20;

        const result =
            canvas.outlineEditor.applyMetricsKeysToCurrentEditedLayer();

        const widthAfter = currentLayerData.width;
        const widthDelta = widthAfter - widthBefore;

        // Width must increase: LSB key translates nodes right, advance widens.
        expect(widthDelta).toBeGreaterThan(0.5);

        // panX must adjust to anchor the right edge of the advance on screen.
        expect(canvas.viewportManager.panX).toBeCloseTo(
            initialPanX - widthDelta * scale,
            1
        );

        // Advance widths include the active glyph and downstream dependents.
        expect(result).not.toBeNull();
        expect(result.glyphAdvances).toBeDefined();
    });

    test('full-font recomputeMetricsKeys must NOT be called during live drags', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        const { layer } = setupCanvasForGlyph(font, 'n');
        const fullRecomputeSpy = jest.spyOn(font, 'recomputeMetricsKeys');

        // Simulate point drag
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedLayer();

        expect(fullRecomputeSpy).not.toHaveBeenCalled();
        fullRecomputeSpy.mockRestore();
    });

    test('downstream cascade: editing n updates a+adieresis+aring advances', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        const { glyph, layer, masterId } = setupCanvasForGlyph(font, 'n');

        // record pre-drag widths
        const aWidthBefore = font
            .findGlyph('a')
            .findLayerByMasterId(masterId).width;

        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        // Move rightmost point so RSB key adjusts width → changes n's RSB →
        // which a inherits via metricRight = n
        const currentLayerData =
            canvas.outlineEditor.getCurrentLayerDataFromStack();
        const shapes = currentLayerData.shapes || [];
        for (const shape of shapes) {
            const nodes = shape.nodes || (shape.Path && shape.Path.nodes) || [];
            const nodesArray = ensureParsedNodes(nodes);
            for (const node of nodesArray) {
                node.x += 20; // shift all nodes right
            }
        }

        const result =
            canvas.outlineEditor.applyMetricsKeysToCurrentEditedLayer();

        expect(result).not.toBeNull();
        // a depends on n (metricRight = n), so a's advance should be in the result
        expect(result.glyphAdvances).toHaveProperty('a');
    });
});

describe('Sidebearing keys: viewport panning', () => {
    // ── RSB key (glyph a): left edge of advance is anchored, no pan change ──

    test('RSB-only key: panX is unchanged after point drag changes width (left edge anchored)', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        // glyph a has only metricRight = n (RSB key, no LSB key)
        const { masterId } = setupCanvasForGlyph(font, 'a');

        canvas.viewportManager.scale = 2;
        const initialPanX = 100;
        canvas.viewportManager.panX = initialPanX;

        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        const currentLayerData =
            canvas.outlineEditor.getCurrentLayerDataFromStack();
        // Move all nodes right to trigger RSB key
        const shapes = currentLayerData.shapes || [];
        for (const shape of shapes) {
            const nodes = shape.nodes || (shape.Path && shape.Path.nodes) || [];
            const nodesArray = ensureParsedNodes(nodes);
            for (const node of nodesArray) {
                node.x += 20;
            }
        }

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedLayer();

        // panX must not change: RSB key drives a width change but the left edge
        // of the advance (glyph origin = font X=0) stays at the same screen X.
        expect(canvas.viewportManager.panX).toBe(initialPanX);
    });

    // ── Both keys (glyph n): leftmost-only drag fires LSB key → right edge anchored ──

    test('both keys: dragging only the leftmost node pans to anchor the right edge of advance', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        // glyph n has both metricLeft = "=l-5" and metricRight = "=l-10".
        // When only the leftmost node moves, the LSB key fires (translates all
        // nodes) and the RSB key finds RSB unchanged — so the net effect is a
        // width change driven solely by the LSB correction.
        setupCanvasForGlyph(font, 'n');

        const scale = 2;
        canvas.viewportManager.scale = scale;
        const initialPanX = 100;
        canvas.viewportManager.panX = initialPanX;

        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        const currentLayerData =
            canvas.outlineEditor.getCurrentLayerDataFromStack();
        const widthBefore = currentLayerData.width;

        // Move ONLY the leftmost node left by 20 units.
        const shapes = currentLayerData.shapes || [];
        let minX = Infinity;
        let leftmostNode = null;
        for (const shape of shapes) {
            const nodesArray = ensureParsedNodes(
                shape.nodes || (shape.Path && shape.Path.nodes) || []
            );
            for (const node of nodesArray) {
                if (node.x < minX) {
                    minX = node.x;
                    leftmostNode = node;
                }
            }
        }
        expect(leftmostNode).not.toBeNull();
        leftmostNode.x -= 20;

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedLayer();

        const widthAfter = currentLayerData.width;
        const widthDelta = widthAfter - widthBefore;

        // Width must increase: the LSB key translates nodes right, widening the advance.
        expect(widthDelta).toBeGreaterThan(0.5);

        // Right edge of the advance anchored: panX -= widthDelta * scale.
        expect(canvas.viewportManager.panX).toBeCloseTo(
            initialPanX - widthDelta * scale,
            1
        );
    });

    test('both keys: dragging only the rightmost node keeps left edge anchored (no panX change)', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        setupCanvasForGlyph(font, 'n');

        const scale = 2;
        canvas.viewportManager.scale = scale;
        const initialPanX = 100;
        canvas.viewportManager.panX = initialPanX;

        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        const currentLayerData =
            canvas.outlineEditor.getCurrentLayerDataFromStack();

        const shapes = currentLayerData.shapes || [];
        let maxX = -Infinity;
        let rightmostNode = null;
        for (const shape of shapes) {
            const nodesArray = ensureParsedNodes(
                shape.nodes || (shape.Path && shape.Path.nodes) || []
            );
            for (const node of nodesArray) {
                if (node.x > maxX) {
                    maxX = node.x;
                    rightmostNode = node;
                }
            }
        }

        expect(rightmostNode).not.toBeNull();
        rightmostNode.x += 20;

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedLayer();

        expect(canvas.viewportManager.panX).toBeCloseTo(initialPanX, 2);
    });

    // ── _metricsKeyEditedSide: records which side changed for history encoding ──

    test('LSB key fires: _metricsKeyEditedSide is set to left', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        setupCanvasForGlyph(font, 'n'); // n has both LSB and RSB keys

        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        const currentLayerData =
            canvas.outlineEditor.getCurrentLayerDataFromStack();
        const shapes = currentLayerData.shapes || [];
        let minX = Infinity;
        let leftmostNode = null;
        for (const shape of shapes) {
            const nodesArray = ensureParsedNodes(
                shape.nodes || (shape.Path && shape.Path.nodes) || []
            );
            for (const node of nodesArray) {
                if (node.x < minX) {
                    minX = node.x;
                    leftmostNode = node;
                }
            }
        }
        expect(leftmostNode).not.toBeNull();
        leftmostNode.x -= 20; // move leftmost node left → LSB key fires

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedLayer();

        expect(canvas.outlineEditor._metricsKeyEditedSide).toBe('left');
    });

    test('RSB key fires: _metricsKeyEditedSide is set to right', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        setupCanvasForGlyph(font, 'n'); // n has both LSB and RSB keys

        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        const currentLayerData =
            canvas.outlineEditor.getCurrentLayerDataFromStack();
        const shapes = currentLayerData.shapes || [];
        let maxX = -Infinity;
        let rightmostNode = null;
        for (const shape of shapes) {
            const nodesArray = ensureParsedNodes(
                shape.nodes || (shape.Path && shape.Path.nodes) || []
            );
            for (const node of nodesArray) {
                if (node.x > maxX) {
                    maxX = node.x;
                    rightmostNode = node;
                }
            }
        }
        expect(rightmostNode).not.toBeNull();
        rightmostNode.x += 20; // move rightmost node right → RSB key fires

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedLayer();

        expect(canvas.outlineEditor._metricsKeyEditedSide).toBe('right');
    });

    // ── LSB key only: right edge anchored, panX adjusted for width delta ──

    test('LSB-only key: panX is adjusted by -widthDelta*scale to anchor right edge', () => {
        // Build a minimal font with a reference glyph and a glyph with only
        // a LSB metrics key (no RSB key). Moving a node causes the LSB key to
        // translate the content, widening the advance, and the viewport must
        // compensate so the right edge of the advance stays fixed on screen.
        const babelfontData = {
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
                // Reference glyph "ref": simple bar from x=10 to x=490
                {
                    name: 'ref',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'ref-layer',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 10, y: 0, nodetype: 'Line' },
                                        { x: 490, y: 0, nodetype: 'Line' },
                                        { x: 490, y: 700, nodetype: 'Line' },
                                        { x: 10, y: 700, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                },
                // Keyed glyph "keyed": LSB key = "=ref" (only LSB, no RSB key)
                {
                    name: 'keyed',
                    category: 'Base',
                    exported: true,
                    format_specific: { metric_left: 'ref' },
                    layers: [
                        {
                            id: 'keyed-layer',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 10, y: 0, nodetype: 'Line' },
                                        { x: 450, y: 0, nodetype: 'Line' },
                                        { x: 450, y: 700, nodetype: 'Line' },
                                        { x: 10, y: 700, nodetype: 'Line' }
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
            names: { family_name: { en: 'Pan Test' } },
            note: '',
            date: '2026-03-29',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        };

        const font = Font.fromData(babelfontData);
        setupCanvasForGlyph(font, 'keyed');

        const scale = 2;
        canvas.viewportManager.scale = scale;
        const initialPanX = 100;
        canvas.viewportManager.panX = initialPanX;

        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        const currentLayerData =
            canvas.outlineEditor.getCurrentLayerDataFromStack();
        const widthBefore = currentLayerData.width;

        // Move the leftmost node further left by 15 units so the LSB key fires
        // and translates the entire content rightward (adjusting width).
        const shapes = currentLayerData.shapes || [];
        for (const shape of shapes) {
            const nodes = shape.nodes || (shape.Path && shape.Path.nodes) || [];
            const nodesArray = ensureParsedNodes(nodes);
            for (const node of nodesArray) {
                if (node.x <= 10 + 1) {
                    node.x -= 15;
                }
            }
        }

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedLayer();

        const widthAfter = currentLayerData.width;
        const widthDelta = widthAfter - widthBefore;

        // Width must have changed for this test to be meaningful
        expect(Math.abs(widthDelta)).toBeGreaterThan(0.5);

        // panX must be adjusted by -widthDelta*scale to keep the right edge
        // of the advance at the same screen position.
        expect(canvas.viewportManager.panX).toBeCloseTo(
            initialPanX - widthDelta * scale,
            1
        );
    });

    // ── Sidebearing handle drag (RSB on l): panX unchanged (glyph a downstream) ──

    test('RSB sidebearing handle drag on glyph l: panX unchanged (left edge anchored)', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        setupCanvasForGlyph(font, 'l');

        canvas.viewportManager.scale = 2;
        const initialPanX = 100;
        canvas.viewportManager.panX = initialPanX;

        canvas.outlineEditor.isDraggingSidebearing = true;
        canvas.outlineEditor.selectedSidebearingHandle = { side: 'right' };

        canvas.outlineEditor._updateDraggedSidebearing(20);

        // Right-sidebearing drag: no panX adjustment.
        expect(canvas.viewportManager.panX).toBe(initialPanX);
    });

    // ── RSB drag on l in text run "anl": panX compensates for preceding a+n advances ──
    // APP.md: "The canvas must even be panned and anchored to the active glyph
    // if only the right sidebearing gets edited and the width changes, because
    // the entire line may contain other glyphs before it or repetitions of the
    // same glyph whose width gets adjusted in the same transaction."

    test('RSB handle drag on l: panX compensates for preceding a+n advance changes in "anl" text run', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        const { masterId } = setupCanvasForGlyph(font, 'l');

        const scale = 2;
        canvas.viewportManager.scale = scale;
        const initialPanX = 100;
        canvas.viewportManager.panX = initialPanX;

        // Capture current model widths for a, n, l (used as starting ax values).
        // Must be captured as plain numbers because the model layer objects are
        // mutated in-place during the drag and would no longer hold the old width.
        const lOldWidth = font
            .findGlyph('l')
            .findLayerByMasterId(masterId).width;
        const nOldWidth = font
            .findGlyph('n')
            .findLayerByMasterId(masterId).width;
        const aOldWidth = font
            .findGlyph('a')
            .findLayerByMasterId(masterId).width;

        // Simulate text run "anl": a at index 0, n at index 1, l at index 2.
        // Set the existing TextRunEditor's shapedGlyphs/glyphNameBuffer so that
        // computePrecedingAdvanceDeltaByIndex can see the pre-drag ax values.
        canvas.textRunEditor.shapedGlyphs = [
            { ax: aOldWidth, dx: 0, dy: 0, g: 1, cl: 0 },
            { ax: nOldWidth, dx: 0, dy: 0, g: 2, cl: 1 },
            { ax: lOldWidth, dx: 0, dy: 0, g: 3, cl: 2 }
        ];
        canvas.textRunEditor.glyphNameBuffer = ['a', 'n', 'l'];
        // Mark l as the selected (active) glyph in the run.
        canvas.textRunEditor.selectedGlyphIndex = 2;

        canvas.outlineEditor.isDraggingSidebearing = true;
        canvas.outlineEditor.selectedSidebearingHandle = { side: 'right' };
        // Drag RSB of l rightward by 20 pixels at scale 2 → +20 units RSB delta.
        canvas.outlineEditor._updateDraggedSidebearing(20);

        // The cascade should have propagated to n (metricRight=l-10) and a
        // (metricRight=n).  Read the advances passed to refreshGlyphAdvancesLive.
        expect(
            canvas.textRunEditor.refreshGlyphAdvancesLive
        ).toHaveBeenCalled();
        const advancesArg =
            canvas.textRunEditor.refreshGlyphAdvancesLive.mock.calls[0][0];

        // Both a and n should be in the updated advances map.
        expect(advancesArg).toHaveProperty('a');
        expect(advancesArg).toHaveProperty('n');

        const aNew = advancesArg.a;
        const nNew = advancesArg.n;
        const aDelta = aNew - aOldWidth;
        const nDelta = nNew - nOldWidth;
        const totalPrecedingDelta = aDelta + nDelta;

        // Both downstream glyphs must have widened (their RSB inherited from l).
        expect(aDelta).toBeGreaterThan(0.5);
        expect(nDelta).toBeGreaterThan(0.5);

        // panX must be adjusted by -totalPrecedingDelta * scale so that l's
        // left edge stays anchored at the same screen position.
        expect(canvas.viewportManager.panX).toBeCloseTo(
            initialPanX - totalPrecedingDelta * scale,
            1
        );
    });

    // ── LSB sidebearing handle drag on l: panX adjusts to anchor right edge ──

    test('LSB sidebearing handle drag: panX adjusted to anchor right edge', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        setupCanvasForGlyph(font, 'l');

        const scale = 2;
        canvas.viewportManager.scale = scale;
        const initialPanX = 100;
        canvas.viewportManager.panX = initialPanX;

        const layerData = canvas.outlineEditor.getCurrentLayerDataFromStack();
        const widthBefore = layerData.width;

        canvas.outlineEditor.isDraggingSidebearing = true;
        canvas.outlineEditor.selectedSidebearingHandle = { side: 'left' };

        // LSB decreases by 15 (positive deltaX → left handle right → LSB shrinks)
        canvas.outlineEditor._updateDraggedSidebearing(15);

        const widthAfter =
            canvas.outlineEditor.getCurrentLayerDataFromStack().width;
        const widthDelta = widthAfter - widthBefore;

        // Width must have changed
        expect(Math.abs(widthDelta)).toBeGreaterThan(0.5);

        // panX adjusted to anchor right edge: panX -= widthDelta * scale
        expect(canvas.viewportManager.panX).toBeCloseTo(
            initialPanX - widthDelta * scale,
            1
        );
    });

    // ── Sequential drags: RSB drag followed by LSB drag both correct correctly ──

    test('after RSB drag widens advance, subsequent leftmost drag still corrects width and pans', () => {
        // Regression: after saveLayerData the layer model's _shapeWrappers can
        // become stale. syncLiveLayerData must invalidate them so that
        // translateLayerContentsX (called from setDirectSidebearing inside
        // recomputeOwnMetricsKeys) operates on the current drag-state shapes.
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        setupCanvasForGlyph(font, 'n');

        const scale = 2;
        canvas.viewportManager.scale = scale;
        canvas.viewportManager.panX = 100;

        const currentLayerData =
            canvas.outlineEditor.getCurrentLayerDataFromStack();
        const initialWidth = currentLayerData.width;

        // ── Phase 1: RSB drag (moves rightmost node right by 20) ──────────────
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        {
            const shapes = currentLayerData.shapes || [];
            let maxX = -Infinity;
            let rightmostNode = null;
            for (const shape of shapes) {
                const nodesArray = ensureParsedNodes(
                    shape.nodes || (shape.Path && shape.Path.nodes) || []
                );
                for (const node of nodesArray) {
                    if (node.x > maxX) {
                        maxX = node.x;
                        rightmostNode = node;
                    }
                }
            }
            expect(rightmostNode).not.toBeNull();
            rightmostNode.x += 20;
        }

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedLayer();
        canvas.outlineEditor.isDraggingPoint = false;

        const widthAfterRsb = currentLayerData.width;
        // RSB key maintained → advance widened by rightmost-node displacement
        expect(widthAfterRsb).toBeGreaterThan(initialWidth);

        const panXAfterRsb = canvas.viewportManager.panX;
        // RSB drag: left edge anchored, no pan should have been applied
        expect(panXAfterRsb).toBe(100);

        // ── Phase 2: LSB drag (moves leftmost node left by 15) ────────────────
        canvas.outlineEditor.isDraggingPoint = true;

        {
            const shapes = currentLayerData.shapes || [];
            let minX = Infinity;
            let leftmostNode = null;
            for (const shape of shapes) {
                const nodesArray = ensureParsedNodes(
                    shape.nodes || (shape.Path && shape.Path.nodes) || []
                );
                for (const node of nodesArray) {
                    if (node.x < minX) {
                        minX = node.x;
                        leftmostNode = node;
                    }
                }
            }
            expect(leftmostNode).not.toBeNull();
            leftmostNode.x -= 15;
        }

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedLayer();

        const widthAfterLsb = currentLayerData.width;

        // LSB key must still fire and update the width even after a prior RSB drag.
        expect(widthAfterLsb).not.toBe(widthAfterRsb);
        // panX must have shifted to anchor the right edge of the advance.
        expect(canvas.viewportManager.panX).not.toBe(panXAfterRsb);
    });
});

// ==================== Component Sidebearing Key Tests ====================

/**
 * Build a synthetic font with composite glyphs for testing component
 * drag interactions with sidebearing keys.
 *
 * Layout:
 *   base    – paths x=60..460, width=520
 *   accent  – paths x=0..100,  width=100
 *
 * Composites (all reference base + accent):
 *   composite – LSB key "60",  base@tx=0  accent@tx=200
 *               bbox: minX=60 (from base paths), LSB=60 ✓
 *               width=520
 *
 *   comp_rsb  – RSB key "60",  base@tx=0  accent@tx=420
 *               accent paths transformed: 420..520, maxX=520
 *               width=580 (so RSB = 580-520 = 60 ✓)
 *
 *   mixed     – LSB key "30",  one inline path (x=30..250) + accent@tx=300
 *               minX=30 (from inline path), LSB=30 ✓
 *               width=500
 */
function buildComponentFont() {
    const master = {
        id: 'master-1',
        name: { en: 'Regular' },
        location: {},
        guides: [],
        metrics: {},
        kerning: new Map()
    };
    const defaultMaster = {
        type: 'DefaultForMaster',
        master: 'master-1'
    };

    const identityTransform = () => ({
        translation: [0, 0],
        scale: [1, 1],
        rotation: 0,
        skew: [0, 0]
    });

    return {
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
        masters: [master],
        glyphs: [
            {
                name: 'base',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'base-layer',
                        width: 520,
                        master: defaultMaster,
                        shapes: [
                            {
                                nodes: [
                                    { x: 60, y: 0, nodetype: 'Line' },
                                    { x: 460, y: 0, nodetype: 'Line' },
                                    { x: 460, y: 700, nodetype: 'Line' },
                                    { x: 60, y: 700, nodetype: 'Line' }
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
                name: 'accent',
                category: 'Mark',
                exported: true,
                layers: [
                    {
                        id: 'accent-layer',
                        width: 100,
                        master: defaultMaster,
                        shapes: [
                            {
                                nodes: [
                                    { x: 0, y: 0, nodetype: 'Line' },
                                    { x: 100, y: 0, nodetype: 'Line' },
                                    { x: 100, y: 100, nodetype: 'Line' },
                                    { x: 0, y: 100, nodetype: 'Line' }
                                ],
                                closed: true
                            }
                        ],
                        anchors: [],
                        guides: []
                    }
                ]
            },
            // composite: LSB key = 60, base@identity, accent@(200,700)
            // bbox minX=60 (base), maxX=460 (base), width=520, LSB=60 ✓
            {
                name: 'composite',
                category: 'Base',
                exported: true,
                format_specific: { metric_left: '60' },
                layers: [
                    {
                        id: 'composite-layer',
                        width: 520,
                        master: defaultMaster,
                        shapes: [
                            {
                                reference: 'base',
                                transform: identityTransform()
                            },
                            {
                                reference: 'accent',
                                transform: {
                                    ...identityTransform(),
                                    translation: [200, 700]
                                }
                            }
                        ],
                        anchors: [],
                        guides: []
                    }
                ]
            },
            // comp_rsb: RSB key = 60, base@identity, accent@(420,700)
            // accent paths transformed: 420..520, maxX=520
            // width = 520 + 60 = 580, RSB = 580-520 = 60 ✓
            {
                name: 'comp_rsb',
                category: 'Base',
                exported: true,
                format_specific: { metric_right: '60' },
                layers: [
                    {
                        id: 'comp_rsb-layer',
                        width: 580,
                        master: defaultMaster,
                        shapes: [
                            {
                                reference: 'base',
                                transform: identityTransform()
                            },
                            {
                                reference: 'accent',
                                transform: {
                                    ...identityTransform(),
                                    translation: [420, 700]
                                }
                            }
                        ],
                        anchors: [],
                        guides: []
                    }
                ]
            },
            // mixed: LSB key = 30, inline path (30..250) + accent@(300,700)
            // minX=30 (path), width=500, LSB=30 ✓
            {
                name: 'mixed',
                category: 'Base',
                exported: true,
                format_specific: { metric_left: '30' },
                layers: [
                    {
                        id: 'mixed-layer',
                        width: 500,
                        master: defaultMaster,
                        shapes: [
                            {
                                nodes: [
                                    { x: 30, y: 0, nodetype: 'Line' },
                                    { x: 250, y: 0, nodetype: 'Line' },
                                    { x: 250, y: 700, nodetype: 'Line' },
                                    { x: 30, y: 700, nodetype: 'Line' }
                                ],
                                closed: true
                            },
                            {
                                reference: 'accent',
                                transform: {
                                    ...identityTransform(),
                                    translation: [300, 700]
                                }
                            }
                        ],
                        anchors: [],
                        guides: []
                    }
                ]
            }
        ],
        names: { family_name: { en: 'Component Test' } },
        note: '',
        date: '2026-03-30',
        features: {},
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    };
}

/**
 * Get the X translation from a component shape in layerData.
 */
function getComponentTranslationX(shape) {
    const t = shape.transform;
    if (!t) return 0;
    if (Array.isArray(t)) return t[4] || 0;
    return (t.translation && t.translation[0]) || 0;
}

describe('Sidebearing keys: component drags', () => {
    test('dragging accent component right on glyph with RSB key increases width', () => {
        // comp_rsb: accent@(420,700), bbox maxX=520, width=580, RSB=60
        // Moving accent +30 → maxX=550 → RSB=30≠60 → key fires → width=610
        const font = Font.fromData(buildComponentFont());
        setupCanvasForGlyph(font, 'comp_rsb');

        canvas.outlineEditor.isDraggingComponent = true;
        canvas.outlineEditor.selectedComponents = [1];
        canvas.outlineEditor._dragType = 'component';
        canvas.outlineEditor._componentDragDeltaX = 0;

        const currentLayerData =
            canvas.outlineEditor.getCurrentLayerDataFromStack();
        const widthBefore = currentLayerData.width;

        // Move accent right by 30 (tx 420→450, accent paths 450..550, maxX 520→550)
        currentLayerData.shapes[1].transform.translation[0] += 30;

        const result =
            canvas.outlineEditor.applyMetricsKeysToCurrentEditedLayer();

        const widthAfter = currentLayerData.width;
        expect(widthAfter).toBeGreaterThan(widthBefore);
        expect(widthAfter - widthBefore).toBeCloseTo(30, 0);
        expect(result).not.toBeNull();
        expect(canvas.outlineEditor._metricsKeyEditedSide).toBe('right');
    });

    test('dragging base component left on glyph with LSB key: right edge anchored', () => {
        // composite: base@identity, bbox minX=60, width=520, LSB=60
        // Moving base tx -20 → base paths at 40..440 → minX=40 → LSB=40≠60
        // → key fires: shift all +20 → base back to 60..460, accent 200→220
        // → width 520→540, panX adjusts
        const font = Font.fromData(buildComponentFont());
        setupCanvasForGlyph(font, 'composite');

        const scale = 2;
        canvas.viewportManager.scale = scale;
        const initialPanX = 100;
        canvas.viewportManager.panX = initialPanX;

        canvas.outlineEditor.isDraggingComponent = true;
        canvas.outlineEditor.selectedComponents = [0];
        canvas.outlineEditor._dragType = 'component';
        canvas.outlineEditor._componentDragDeltaX = 0;

        const currentLayerData =
            canvas.outlineEditor.getCurrentLayerDataFromStack();
        const widthBefore = currentLayerData.width;
        const accentTxBefore = getComponentTranslationX(
            currentLayerData.shapes[1]
        );

        // Move base component left by 20
        currentLayerData.shapes[0].transform.translation[0] -= 20;

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedLayer();

        const widthAfter = currentLayerData.width;
        const widthDelta = widthAfter - widthBefore;

        // Width must increase (LSB key shifts content right, widening advance)
        expect(widthDelta).toBeGreaterThan(0.5);

        // The accent (non-dragged)'s tx must have increased by the LSB restore offset
        const accentTxAfter = getComponentTranslationX(
            currentLayerData.shapes[1]
        );
        expect(accentTxAfter).toBeGreaterThan(accentTxBefore);

        // panX anchors right edge
        expect(canvas.viewportManager.panX).toBeCloseTo(
            initialPanX - widthDelta * scale,
            1
        );

        expect(canvas.outlineEditor._metricsKeyEditedSide).toBe('left');
    });

    test('dragging base component right on glyph with RSB key: left edge anchored', () => {
        // comp_rsb: base@identity, maxX=520, width=580, RSB=60
        // Moving base tx +20 → base paths at 80..480 → maxX=max(480,520)=520
        // (accent still at 420..520) → no change. So we move base far enough
        // that base paths exceed accent: tx=+80 → paths 140..540 → maxX=540 > 520
        // RSB=580-540=40≠60 → key fires → width=600
        const font = Font.fromData(buildComponentFont());
        setupCanvasForGlyph(font, 'comp_rsb');

        const scale = 2;
        canvas.viewportManager.scale = scale;
        const initialPanX = 100;
        canvas.viewportManager.panX = initialPanX;

        canvas.outlineEditor.isDraggingComponent = true;
        canvas.outlineEditor.selectedComponents = [0];
        canvas.outlineEditor._dragType = 'component';
        canvas.outlineEditor._componentDragDeltaX = 0;

        const currentLayerData =
            canvas.outlineEditor.getCurrentLayerDataFromStack();
        const widthBefore = currentLayerData.width;

        // Move base far enough right so that base maxX exceeds accent maxX
        currentLayerData.shapes[0].transform.translation[0] += 80;

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedLayer();

        const widthAfter = currentLayerData.width;
        expect(widthAfter).toBeGreaterThan(widthBefore);

        // RSB key → left edge anchored → panX unchanged
        expect(canvas.viewportManager.panX).toBe(initialPanX);
        expect(canvas.outlineEditor._metricsKeyEditedSide).toBe('right');
    });

    test('mixed paths+components: dragging component past path left edge fires LSB key', () => {
        // mixed: inline path (30..250) + accent@(300,700), LSB=30, width=500
        // Move accent left by 340 → tx=-40, accent paths at -40..60
        // minX = min(30, -40) = -40, LSB=-40≠30 → key fires
        // → shift all +70 → path nodes 30→100, accent -40→30
        // → width increases by 70
        const font = Font.fromData(buildComponentFont());
        setupCanvasForGlyph(font, 'mixed');

        const scale = 2;
        canvas.viewportManager.scale = scale;
        const initialPanX = 100;
        canvas.viewportManager.panX = initialPanX;

        canvas.outlineEditor.isDraggingComponent = true;
        canvas.outlineEditor.selectedComponents = [1];
        canvas.outlineEditor._dragType = 'component';
        canvas.outlineEditor._componentDragDeltaX = 0;

        const currentLayerData =
            canvas.outlineEditor.getCurrentLayerDataFromStack();
        const widthBefore = currentLayerData.width;

        // Move accent component left by 340 → tx=300-340=-40
        currentLayerData.shapes[1].transform.translation[0] -= 340;

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedLayer();

        const widthAfter = currentLayerData.width;
        const widthDelta = widthAfter - widthBefore;

        // Width should increase
        expect(widthDelta).toBeGreaterThan(0.5);

        // Path nodes should have been shifted right by the LSB restoration
        const pathShape = currentLayerData.shapes[0];
        const pathNodes =
            pathShape.nodes || (pathShape.Path && pathShape.Path.nodes) || [];
        const nodesArray = ensureParsedNodes(pathNodes);
        // Original leftmost was 30; after LSB shift it should be > 30
        const minPathX = Math.min(...nodesArray.map((n) => n.x));
        expect(minPathX).toBeGreaterThan(30);

        // panX adjusts for right-edge anchoring
        expect(canvas.viewportManager.panX).toBeCloseTo(
            initialPanX - widthDelta * scale,
            1
        );
    });

    test('component drag records _metricsKeyEditedSide for undo', () => {
        const font = Font.fromData(buildComponentFont());
        setupCanvasForGlyph(font, 'composite');

        canvas.outlineEditor.isDraggingComponent = true;
        canvas.outlineEditor.selectedComponents = [0];
        canvas.outlineEditor._dragType = 'component';
        canvas.outlineEditor._componentDragDeltaX = 0;

        const currentLayerData =
            canvas.outlineEditor.getCurrentLayerDataFromStack();

        // Move base component left → LSB changes → side = 'left'
        currentLayerData.shapes[0].transform.translation[0] -= 20;

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedLayer();

        expect(canvas.outlineEditor._metricsKeyEditedSide).toBe('left');
    });
});
