/**
 * Automatic Glyph Composition — Canonical Tests
 *
 * These tests lock down the behavior described in APP.md § Automatic Glyph
 * Composition and the adjacent automatic-component editing rules:
 *
 *   - automatic composition only applies to component-only layers where every
 *     component is automatically aligned
 *   - anchor-family matching treats unsuffixed and suffixed anchors as one
 *     family, with explicit Component.anchor overrides selecting the exact
 *     target anchor
 *   - base-plus-mark compositions stack in component order and keep width
 *     derived from base components rather than attached marks
 *   - anchor edits on source glyphs rebuild downstream automatic composites
 *   - automatic layers reject direct sidebearing inputs and only accept
 *     =+/- and ==+/- adjustments
 *   - fully automatic layers expose anchor overrides and lock component
 *     translation fields in the property panel, while mixed layers keep
 *     components movable
 *   - automatic and manual components are rendered with distinct fill and
 *     explicit stroke styling
 */

const { Font } = require('../../js/babelfont-model');
const fontManager = require('../../js/font-manager').default;
const APP_SETTINGS = require('../../js/settings').default;

const GLYPHS_COMPONENT_ALIGNMENT_KEY = 'com.schriftgestalt.Glyphs.alignment';
const GLYPHS_COMPONENT_ANCHOR_KEY = 'com.schriftgestalt.Glyphs.componentAnchor';

function makeMaster() {
    return {
        id: 'M0',
        name: { en: 'Regular' },
        location: {},
        guides: [],
        metrics: {},
        kerning: {},
        custom_ot_values: {},
        format_specific: {}
    };
}

function makeRectPath(minX, minY, maxX, maxY) {
    return {
        nodes: `${minX} ${minY} l ${maxX} ${minY} l ${maxX} ${maxY} l ${minX} ${maxY} l`,
        closed: true
    };
}

function makeComponent(reference, options = {}) {
    const {
        x = 0,
        y = 0,
        auto = true,
        anchor,
        transform = {
            translation: [x, y],
            scale: [1, 1],
            rotation: 0,
            skew: [0, 0],
            tCenter: [0, 0],
            order: 'RestOfTheWorld'
        }
    } = options;
    const formatSpecific = {
        [GLYPHS_COMPONENT_ALIGNMENT_KEY]: auto ? 0 : 1
    };
    if (anchor) {
        formatSpecific[GLYPHS_COMPONENT_ANCHOR_KEY] = anchor;
    }
    return {
        reference,
        transform,
        format_specific: formatSpecific
    };
}

function makeAutomaticCompositionFont() {
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
        masters: [makeMaster()],
        glyphs: [
            {
                name: 'A',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'A0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(50, 0, 450, 700)],
                        anchors: [
                            { name: 'top', x: 250, y: 700 },
                            { name: 'top_alt', x: 320, y: 700 },
                            { name: 'bottom', x: 250, y: 0 }
                        ],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'B',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'B0',
                        width: 300,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(20, 0, 280, 650)],
                        anchors: [{ name: 'top', x: 150, y: 650 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'acutecomb',
                category: 'Mark',
                exported: true,
                layers: [
                    {
                        id: 'AC0',
                        width: 180,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(-40, 680, 40, 780)],
                        anchors: [
                            { name: '_top', x: 0, y: 720 },
                            { name: 'top', x: 0, y: 820 }
                        ],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'gravecomb',
                category: 'Mark',
                exported: true,
                layers: [
                    {
                        id: 'GC0',
                        width: 180,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(-35, 670, 35, 770)],
                        anchors: [{ name: '_top', x: 0, y: 710 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'adieresis',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'AD0',
                        width: 0,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeComponent('A'),
                            makeComponent('acutecomb'),
                            makeComponent('gravecomb')
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'AB',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'AB0',
                        width: 0,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeComponent('A'), makeComponent('B')],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'hybrid',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'HY0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeRectPath(0, 0, 100, 100),
                            makeComponent('A')
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'manualComposite',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'MC0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeComponent('A'),
                            makeComponent('acutecomb', { auto: false })
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            }
        ],
        names: { family_name: { en: 'Automatic Composition Canonical' } },
        note: '',
        date: '2026-04-06',
        features: { classes: {}, prefixes: {}, features: [] },
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    });
}

function makeSingleOffsetAutomaticFont() {
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
        masters: [makeMaster()],
        glyphs: [
            {
                name: 'acutecomb',
                category: 'Mark',
                exported: true,
                layers: [
                    {
                        id: 'AC0',
                        width: 180,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(-40, 680, 40, 780)],
                        anchors: [
                            { name: '_top', x: 0, y: 720 },
                            { name: 'top', x: 0, y: 820 }
                        ],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'acutecomb.case',
                category: 'Mark',
                exported: true,
                layers: [
                    {
                        id: 'ACC0',
                        width: 0,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeComponent('acutecomb', {
                                y: 190
                            })
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            }
        ],
        names: { family_name: { en: 'Automatic Offset Canonical' } },
        note: '',
        date: '2026-04-06',
        features: { classes: {}, prefixes: {}, features: [] },
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    });
}

function makeRotatedAutomaticBaseFont() {
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
        masters: [makeMaster()],
        glyphs: [
            {
                name: 'n',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'N0',
                        width: 571,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(40, 0, 531, 492)],
                        anchors: [
                            { name: 'bottom', x: 260, y: 0 },
                            { name: 'top', x: 280, y: 492 }
                        ],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'u',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'U0',
                        width: 0,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeComponent('n', {
                                transform: {
                                    translation: [571, 492],
                                    scale: [1, 1],
                                    rotation: Math.PI,
                                    skew: [0, 0],
                                    tCenter: [0, 0],
                                    order: 'Glyphs'
                                }
                            })
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            }
        ],
        names: { family_name: { en: 'Automatic Rotated Base Canonical' } },
        note: '',
        date: '2026-04-06',
        features: { classes: {}, prefixes: {}, features: [] },
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    });
}

function setupCanvasForLayer(canvas, font, glyphName, layerId) {
    canvas.outlineEditor.active = true;
    canvas.outlineEditor.selectedLayerId = layerId;
    canvas.outlineEditor.glyphStack = `${glyphName}@${layerId}`;
    canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
        { glyphName, layerId }
    ]);
    canvas.getCurrentGlyphName = jest.fn(() => glyphName);
    const layer = font.findGlyph(glyphName).findLayerById(layerId);
    canvas.outlineEditor.layerData = {
        ...layer.toJSON(),
        isInterpolated: false
    };
    return layer;
}

describe('Automatic Glyph Composition canonical behavior', () => {
    test('components without an explicit automatic-alignment flag stay manual', () => {
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            instances: [],
            masters: [makeMaster()],
            glyphs: [
                {
                    name: 'dotaccentcomb',
                    category: 'Mark',
                    exported: true,
                    layers: [
                        {
                            id: 'DOT0',
                            width: 200,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M0'
                            },
                            shapes: [makeRectPath(0, 0, 60, 60)],
                            anchors: [{ name: '_top', x: 30, y: 30 }],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                },
                {
                    name: 'dieresiscomb',
                    category: 'Mark',
                    exported: true,
                    layers: [
                        {
                            id: 'DIER0',
                            width: 200,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M0'
                            },
                            shapes: [
                                {
                                    reference: 'dotaccentcomb',
                                    transform: [1, 0, 0, 1, 0, 0]
                                },
                                {
                                    reference: 'dotaccentcomb',
                                    transform: [1, 0, 0, 1, 120, 0]
                                }
                            ],
                            anchors: [],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                }
            ],
            names: { family_name: { en: 'Automatic Alignment Explicit Only' } },
            note: '',
            date: '2026-04-06',
            features: { classes: {}, prefixes: {}, features: [] },
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const layer = font.findGlyph('dieresiscomb').layers[0];

        expect(layer.components[0].isAutomaticAligned()).toBe(false);
        expect(layer.components[1].isAutomaticAligned()).toBe(false);
        expect(layer.isAutomaticAlignedLayer()).toBe(false);
    });

    test('only component-only layers with all-auto components participate in automatic composition', () => {
        const font = makeAutomaticCompositionFont();

        expect(
            font.findGlyph('adieresis').layers[0].isAutomaticAlignedLayer()
        ).toBe(true);
        expect(font.findGlyph('AB').layers[0].isAutomaticAlignedLayer()).toBe(
            true
        );
        expect(
            font.findGlyph('hybrid').layers[0].isAutomaticAlignedLayer()
        ).toBe(false);
        expect(
            font
                .findGlyph('manualComposite')
                .layers[0].isAutomaticAlignedLayer()
        ).toBe(false);
    });

    test('base-plus-mark compositions stack by shape order and keep width derived from bases', () => {
        const font = makeAutomaticCompositionFont();
        const layer = font.findGlyph('adieresis').layers[0];
        const changed = layer.rebuildAutomaticComposition();
        const [base, acute, grave] = layer.components;

        expect(changed).toBe(true);
        expect(base.toAffineArray()[4]).toBeCloseTo(0, 5);
        expect(base.toAffineArray()[5]).toBeCloseTo(0, 5);
        expect(acute.toAffineArray()[4]).toBeCloseTo(250, 5);
        expect(acute.toAffineArray()[5]).toBeCloseTo(-20, 5);
        expect(grave.toAffineArray()[4]).toBeCloseTo(250, 5);
        expect(grave.toAffineArray()[5]).toBeCloseTo(90, 5);
        expect(layer.width).toBeCloseTo(500, 5);
    });

    test('multiple base components advance in component order', () => {
        const font = makeAutomaticCompositionFont();
        const layer = font.findGlyph('AB').layers[0];
        const changed = layer.rebuildAutomaticComposition();
        const [leftBase, rightBase] = layer.components;

        expect(changed).toBe(true);
        expect(leftBase.toAffineArray()[4]).toBeCloseTo(0, 5);
        expect(rightBase.toAffineArray()[4]).toBeCloseTo(500, 5);
        expect(layer.width).toBeCloseTo(800, 5);
    });

    test('single unattached automatic components preserve stored offsets', () => {
        const font = makeSingleOffsetAutomaticFont();
        const layer = font.findGlyph('acutecomb.case').layers[0];
        const changed = layer.rebuildAutomaticComposition();
        const [base] = layer.components;

        expect(changed).toBe(true);
        expect(layer.isAutomaticAlignedLayer()).toBe(true);
        expect(base.toAffineArray()[4]).toBeCloseTo(0, 5);
        expect(base.toAffineArray()[5]).toBeCloseTo(190, 5);
        expect(layer.width).toBeCloseTo(180, 5);
    });

    test('rotated unattached automatic bases keep positive width and in-width placement', () => {
        const font = makeRotatedAutomaticBaseFont();
        const layer = font.findGlyph('u').layers[0];
        const changed = layer.rebuildAutomaticComposition();
        const [base] = layer.components;

        expect(changed).toBe(true);
        expect(layer.isAutomaticAlignedLayer()).toBe(true);
        expect(base.toAffineArray()[4]).toBeCloseTo(571, 5);
        expect(base.toAffineArray()[5]).toBeCloseTo(492, 5);
        expect(layer.width).toBeCloseTo(571, 5);
        expect(layer.lsb).toBeCloseTo(40, 5);
        expect(layer.rsb).toBeCloseTo(40, 5);
    });

    test('anchor families expose override choices and explicit overrides pick the exact target anchor', () => {
        const font = makeAutomaticCompositionFont();
        const layer = font.findGlyph('adieresis').layers[0];
        const acute = layer.components[1];
        const grave = layer.components[2];

        expect(layer.getAutomaticComponentTargetAnchorOptions(acute)).toEqual([
            'top',
            'top_alt'
        ]);

        acute.anchor = 'top_alt';
        layer.rebuildAutomaticComposition();

        expect(acute.anchor).toBe('top_alt');
        expect(acute.toAffineArray()[4]).toBeCloseTo(320, 5);
        expect(grave.toAffineArray()[4]).toBeCloseTo(320, 5);
    });

    test('moving a source anchor rebuilds downstream automatic composites', () => {
        const font = makeAutomaticCompositionFont();
        const baseLayer = font.findGlyph('A').layers[0];
        const compositeLayer = font.findGlyph('adieresis').layers[0];
        const acute = compositeLayer.components[1];

        acute.anchor = 'top_alt';
        compositeLayer.rebuildAutomaticComposition();
        expect(acute.toAffineArray()[4]).toBeCloseTo(320, 5);

        const topAlt = baseLayer.anchors.find(
            (anchor) => anchor.name === 'top_alt'
        );
        topAlt.x = 360;

        const rebuiltGlyphNames = font.rebuildAutomaticCompositesForGlyphs(
            new Set(['A'])
        );

        expect(rebuiltGlyphNames.has('adieresis')).toBe(true);
        expect(compositeLayer.components[1].toAffineArray()[4]).toBeCloseTo(
            360,
            5
        );
    });

    test('automatic layers reject direct sidebearing values and accept automatic offsets', () => {
        const font = makeAutomaticCompositionFont();
        const glyph = font.findGlyph('adieresis');
        const layer = glyph.layers[0];

        layer.rebuildAutomaticComposition();
        const rejected = layer.applySidebearingInput('left', '50');
        const accepted = layer.applySidebearingInput('left', '=+20');

        expect(rejected.error).toBe(
            'Automatic sidebearings only accept =+/- or ==+/- adjustments'
        );
        expect(glyph.leftMetricsKey).toBe('=+20');
        expect(accepted.error).toBeNull();
        expect(accepted.value).not.toBeNull();
        expect(layer.resolveMetricsKey('left').value).not.toBeNull();
    });
});

describe('Automatic component editing canonical behavior', () => {
    let canvas;
    let font;
    let currentFontSpy;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        font = makeAutomaticCompositionFont();
        font.findGlyph('adieresis').layers[0].rebuildAutomaticComposition();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: font });
        window.changeBridge = null;
    });

    afterEach(() => {
        currentFontSpy.mockRestore();
        canvas.destroy();
    });

    test('property panel disables component translation for fully automatic layers and exposes anchor override choices', () => {
        const layer = setupCanvasForLayer(canvas, font, 'adieresis', 'AD0');
        canvas.outlineEditor.selectedComponents = [1];
        canvas.outlineEditor.selectedPoints = [];
        canvas.outlineEditor.selectedAnchors = [];

        canvas.updatePropertyPanel();

        const translateX = canvas.propertyPanel.querySelector(
            'input[data-property-field="component-translateX"]'
        );
        const translateY = canvas.propertyPanel.querySelector(
            'input[data-property-field="component-translateY"]'
        );
        const anchorSelect = canvas.propertyPanel.querySelector(
            'select[data-property-field="component-anchor"]'
        );

        expect(layer.components[1].isAutomaticAligned()).toBe(true);
        expect(translateX).toBeTruthy();
        expect(translateY).toBeTruthy();
        expect(translateX.disabled).toBe(true);
        expect(translateY.disabled).toBe(true);
        expect(translateX.title).toBe(
            'Automatic component translation is derived from anchor alignment'
        );
        expect(anchorSelect).toBeTruthy();
        expect(
            Array.from(anchorSelect.options).map((option) => option.value)
        ).toEqual(['', 'top', 'top_alt']);
    });

    test('mixed layers keep automatic-marked components movable', () => {
        const layer = setupCanvasForLayer(
            canvas,
            font,
            'manualComposite',
            'MC0'
        );
        canvas.outlineEditor.saveLayerData = jest.fn();
        canvas.outlineEditor.selectedComponents = [0];
        canvas.outlineEditor.selectedPoints = [];
        canvas.outlineEditor.selectedAnchors = [];

        canvas.updatePropertyPanel();

        const translateX = canvas.propertyPanel.querySelector(
            'input[data-property-field="component-translateX"]'
        );
        const translateY = canvas.propertyPanel.querySelector(
            'input[data-property-field="component-translateY"]'
        );
        const anchorSelect = canvas.propertyPanel.querySelector(
            'select[data-property-field="component-anchor"]'
        );

        expect(layer.isAutomaticAlignedLayer()).toBe(false);
        expect(layer.components[0].isAutomaticAligned()).toBe(true);
        expect(translateX).toBeTruthy();
        expect(translateY).toBeTruthy();
        expect(translateX.disabled).toBe(false);
        expect(translateY.disabled).toBe(false);
        expect(anchorSelect).toBeNull();

        canvas.outlineEditor.moveSelectedComponents(15, 25);

        expect(
            canvas.outlineEditor.layerData.shapes[0].transform.translation[0]
        ).toBe(15);
        expect(
            canvas.outlineEditor.layerData.shapes[0].transform.translation[1]
        ).toBe(25);
    });

    test('renderer uses distinct fill and stroke styling for automatic and manual components', () => {
        const assignedFillStyles = [];
        const assignedStrokeStyles = [];
        const assignedLineWidths = [];
        let fillStyleValue = '';
        let strokeStyleValue = '';
        let lineWidthValue = 1;
        Object.defineProperty(canvas.renderer.ctx, 'fillStyle', {
            configurable: true,
            get: () => fillStyleValue,
            set: (value) => {
                fillStyleValue = value;
                assignedFillStyles.push(value);
            }
        });
        Object.defineProperty(canvas.renderer.ctx, 'strokeStyle', {
            configurable: true,
            get: () => strokeStyleValue,
            set: (value) => {
                strokeStyleValue = value;
                assignedStrokeStyles.push(value);
            }
        });
        Object.defineProperty(canvas.renderer.ctx, 'lineWidth', {
            configurable: true,
            get: () => lineWidthValue,
            set: (value) => {
                lineWidthValue = value;
                assignedLineWidths.push(value);
            }
        });

        const outlineShapes = [
            {
                nodes: [
                    { x: 0, y: 0, nodetype: 'Line' },
                    { x: 100, y: 0, nodetype: 'Line' },
                    { x: 100, y: 100, nodetype: 'Line' },
                    { x: 0, y: 100, nodetype: 'Line' }
                ],
                closed: true
            }
        ];

        canvas.renderer.drawComponentWithOutlines(
            outlineShapes,
            false,
            false,
            false,
            false,
            1,
            false
        );
        const manualFill = assignedFillStyles[assignedFillStyles.length - 1];
        const manualStroke =
            assignedStrokeStyles[assignedStrokeStyles.length - 1];
        const manualLineWidth =
            assignedLineWidths[assignedLineWidths.length - 1];

        canvas.renderer.drawComponentWithOutlines(
            outlineShapes,
            false,
            false,
            true,
            false,
            1,
            false
        );
        const automaticFill = assignedFillStyles[assignedFillStyles.length - 1];
        const automaticStroke =
            assignedStrokeStyles[assignedStrokeStyles.length - 1];
        const automaticLineWidth =
            assignedLineWidths[assignedLineWidths.length - 1];

        expect(manualFill).toBeTruthy();
        expect(automaticFill).toBeTruthy();
        expect(manualStroke).toBeTruthy();
        expect(automaticStroke).toBeTruthy();
        expect(automaticFill).not.toBe(manualFill);
        expect(automaticStroke).not.toBe(manualStroke);
        expect(manualStroke).not.toBe(manualFill);
        expect(automaticStroke).not.toBe(automaticFill);
        expect(manualLineWidth).toBe(2);
        expect(automaticLineWidth).toBe(2);
        expect(automaticFill).toContain('143');
        expect(
            APP_SETTINGS.OUTLINE_EDITOR.COLORS_LIGHT.COMPONENT_FILL_AUTO_NORMAL
        ).toBe('#8f8f8fcc');
    });
});
