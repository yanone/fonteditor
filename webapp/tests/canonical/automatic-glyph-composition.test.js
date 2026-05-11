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

function getSerializedTranslationX(shape) {
    const shapeData = 'Component' in shape ? shape.Component : shape;
    const transform = shapeData?.transform;
    return Array.isArray(transform)
        ? transform[4]
        : (transform?.translation?.[0] ?? 0);
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

function makeVisibleAnchorCascadeFont() {
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
                        shapes: [makeRectPath(0, 0, 500, 700)],
                        anchors: [{ name: 'top', x: 250, y: 700 }],
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
                        shapes: [makeRectPath(0, 0, 80, 120)],
                        anchors: [{ name: '_top', x: 40, y: 0 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'visibleComposite',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'VC0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeComponent('A'),
                            makeComponent('acutecomb')
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'hiddenComposite',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'HC0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeComponent('A'),
                            makeComponent('acutecomb')
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            }
        ],
        names: { family_name: { en: 'Visible Anchor Cascade' } },
        note: '',
        date: '2026-04-07',
        features: { classes: {}, prefixes: {}, features: [] },
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    });
}

function makeRecursiveDependencyFont() {
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
        masters: [makeMaster()],
        glyphs: [
            {
                name: 'source',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'SRC0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(0, 0, 100, 100)],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'directDependent',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'DD0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeComponent('source')],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'nestedDependent',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'ND0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeComponent('directDependent')],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'unrelated',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'U0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(0, 0, 80, 80)],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            }
        ],
        names: { family_name: { en: 'Recursive Dependency Canonical' } },
        note: '',
        date: '2026-05-11',
        features: { classes: {}, prefixes: {}, features: [] },
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    });
}

function makeNestedVisibleAnchorCascadeFont() {
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
                        shapes: [makeRectPath(0, 0, 500, 700)],
                        anchors: [{ name: 'top', x: 250, y: 700 }],
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
                        shapes: [makeRectPath(0, 0, 80, 120)],
                        anchors: [{ name: '_top', x: 40, y: 0 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'visibleComposite',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'VC0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeComponent('A'),
                            makeComponent('acutecomb')
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'nestedVisibleComposite',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'NVC0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeComponent('visibleComposite')],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            }
        ],
        names: { family_name: { en: 'Nested Visible Anchor Cascade' } },
        note: '',
        date: '2026-05-11',
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

function makeChainedBaseAutomaticFont() {
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
        masters: [makeMaster()],
        glyphs: [
            {
                name: 'leftBase',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'LB0',
                        width: 400,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(40, 0, 360, 300)],
                        anchors: [{ name: '#exit', x: 340, y: 150 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'middleBase',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'MB0',
                        width: 350,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(20, 0, 320, 300)],
                        anchors: [
                            { name: '#entry', x: 20, y: 150 },
                            { name: '#exit', x: 300, y: 150 }
                        ],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'rightBase',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'RB0',
                        width: 280,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(10, 0, 250, 300)],
                        anchors: [{ name: '#entry', x: 30, y: 150 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'chainedWord',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'CW0',
                        width: 0,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeComponent('leftBase'),
                            makeComponent('middleBase'),
                            makeComponent('rightBase')
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            }
        ],
        names: { family_name: { en: 'Automatic Chained Bases Canonical' } },
        note: '',
        date: '2026-04-07',
        features: { classes: {}, prefixes: {}, features: [] },
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    });
}

function makeChainedBaseSidebearingKeyFont() {
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
        masters: [makeMaster()],
        glyphs: [
            {
                name: 'leftChainBase',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'LCB0',
                        width: 420,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(45, 0, 365, 300)],
                        anchors: [{ name: '#exit', x: 340, y: 150 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'rightChainBase',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'RCB0',
                        width: 360,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(30, 0, 300, 300)],
                        anchors: [{ name: '#entry', x: 30, y: 150 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'sidebearingChain',
                category: 'Letter',
                exported: true,
                layers: [
                    {
                        id: 'SBC0',
                        width: 0,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeComponent('leftChainBase'),
                            makeComponent('rightChainBase')
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            }
        ],
        names: { family_name: { en: 'Automatic Chained Sidebearing Keys' } },
        note: '',
        date: '2026-04-07',
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

    test('chained base components align by #exit and #entry and derive metrics from the chain ends', () => {
        const font = makeChainedBaseAutomaticFont();
        const layer = font.findGlyph('chainedWord').layers[0];
        const changed = layer.rebuildAutomaticComposition();
        const [leftBase, middleBase, rightBase] = layer.components;

        expect(changed).toBe(true);
        expect(layer.isAutomaticAlignedLayer()).toBe(true);
        expect(leftBase.toAffineArray()[4]).toBeCloseTo(0, 5);
        expect(middleBase.toAffineArray()[4]).toBeCloseTo(320, 5);
        expect(rightBase.toAffineArray()[4]).toBeCloseTo(590, 5);
        expect(layer.width).toBeCloseTo(870, 5);
        expect(layer.lsb).toBeCloseTo(40, 5);
        expect(layer.rsb).toBeCloseTo(30, 5);
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

    test('live automatic placement keeps attached components anchored after scaling raw layer data', () => {
        const font = makeAutomaticCompositionFont();
        const layer = font.findGlyph('adieresis').layers[0];

        layer.rebuildAutomaticComposition();
        const liveLayerData = layer.toJSON();
        liveLayerData.shapes[0].transform.scale = [2, 2];

        const changed =
            layer.applyAutomaticCompositionToLayerData(liveLayerData);
        const [baseShape, acuteShape, graveShape] = liveLayerData.shapes;

        expect(changed).toBe(true);
        expect(getSerializedTranslationX(baseShape)).toBeCloseTo(0, 5);
        expect(getSerializedTranslationX(acuteShape)).toBeCloseTo(500, 5);
        expect(getSerializedTranslationX(graveShape)).toBeCloseTo(500, 5);
        expect(liveLayerData.width).toBeCloseTo(1000, 5);
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

    test('editing chained base anchors rebuilds inheriting composites in the same automatic recomposition pass', () => {
        const font = makeChainedBaseAutomaticFont();
        const middleBaseLayer = font.findGlyph('middleBase').layers[0];
        const compositeLayer = font.findGlyph('chainedWord').layers[0];

        compositeLayer.rebuildAutomaticComposition();
        expect(compositeLayer.components[2].toAffineArray()[4]).toBeCloseTo(
            590,
            5
        );

        const exitAnchor = middleBaseLayer.anchors.find(
            (anchor) => anchor.name === '#exit'
        );
        exitAnchor.x = 330;

        const rebuiltGlyphNames = font.rebuildAutomaticCompositesForGlyphs(
            new Set(['middleBase'])
        );

        expect(rebuiltGlyphNames.has('chainedWord')).toBe(true);
        expect(compositeLayer.components[2].toAffineArray()[4]).toBeCloseTo(
            620,
            5
        );
        expect(compositeLayer.width).toBeCloseTo(900, 5);
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

    test('automatic chained layers ignore imported direct-reference metrics keys and keep implicit derived sidebearings', () => {
        const font = makeChainedBaseAutomaticFont();
        const glyph = font.findGlyph('chainedWord');
        const layer = glyph.layers[0];

        glyph.leftMetricsKey = '=leftBase';
        glyph.rightMetricsKey = '=rightBase';

        layer.rebuildAutomaticComposition();

        expect(layer.resolveMetricsKey('left').input).toBe('');
        expect(layer.resolveMetricsKey('right').input).toBe('');
        expect(layer.resolveMetricsKey('left').value).toBeCloseTo(40, 5);
        expect(layer.resolveMetricsKey('right').value).toBeCloseTo(30, 5);
    });

    test('automatic chained layers apply sidebearing key offsets from the implicitly derived chain sidebearings', () => {
        const font = makeChainedBaseSidebearingKeyFont();
        const glyph = font.findGlyph('sidebearingChain');
        const layer = glyph.layers[0];

        layer.rebuildAutomaticComposition();

        expect(layer.lsb).toBeCloseTo(45, 5);
        expect(layer.rsb).toBeCloseTo(60, 5);
        expect(layer.components[0].toAffineArray()[4]).toBeCloseTo(0, 5);
        expect(layer.components[1].toAffineArray()[4]).toBeCloseTo(310, 5);
        expect(layer.width).toBeCloseTo(670, 5);

        const leftAdjusted = layer.applySidebearingInput('left', '=+10');
        const rightAdjusted = layer.applySidebearingInput('right', '=-10');

        expect(leftAdjusted.error).toBeNull();
        expect(rightAdjusted.error).toBeNull();
        expect(layer.resolveMetricsKey('left').value).toBeCloseTo(55, 5);
        expect(layer.resolveMetricsKey('right').value).toBeCloseTo(50, 5);

        const serialized = layer.toJSON();
        expect(getSerializedTranslationX(serialized.shapes[0])).toBeCloseTo(
            10,
            5
        );
        expect(getSerializedTranslationX(serialized.shapes[1])).toBeCloseTo(
            320,
            5
        );
        expect(serialized.width).toBeCloseTo(670, 5);
    });

    test('automatic LSB offsets move serialized component positions while RSB offsets only widen the serialized advance', () => {
        const leftFont = makeChainedBaseSidebearingKeyFont();
        const leftLayer = leftFont.findGlyph('sidebearingChain').layers[0];

        leftLayer.rebuildAutomaticComposition();
        leftLayer.applySidebearingInput('left', '=+100');

        const leftSerialized = leftLayer.toJSON();
        expect(getSerializedTranslationX(leftSerialized.shapes[0])).toBeCloseTo(
            100,
            5
        );
        expect(getSerializedTranslationX(leftSerialized.shapes[1])).toBeCloseTo(
            410,
            5
        );
        expect(leftSerialized.width).toBeCloseTo(770, 5);

        const rightFont = makeChainedBaseSidebearingKeyFont();
        const rightLayer = rightFont.findGlyph('sidebearingChain').layers[0];

        rightLayer.rebuildAutomaticComposition();
        rightLayer.applySidebearingInput('right', '=+100');

        const rightSerialized = rightLayer.toJSON();
        expect(
            getSerializedTranslationX(rightSerialized.shapes[0])
        ).toBeCloseTo(0, 5);
        expect(
            getSerializedTranslationX(rightSerialized.shapes[1])
        ).toBeCloseTo(310, 5);
        expect(rightSerialized.width).toBeCloseTo(770, 5);
    });

    test('automatic layers clear sidebearing override keys back to implicit auto when input is deleted', () => {
        const font = makeChainedBaseSidebearingKeyFont();
        const glyph = font.findGlyph('sidebearingChain');
        const layer = glyph.layers[0];

        layer.rebuildAutomaticComposition();
        layer.applySidebearingInput('left', '=+10');
        layer.applySidebearingInput('right', '=-10');

        expect(layer.resolveMetricsKey('left').value).toBeCloseTo(55, 5);
        expect(layer.resolveMetricsKey('right').value).toBeCloseTo(60 - 10, 5);

        const clearedLeft = layer.applySidebearingInput('left', '');
        const clearedRight = layer.applySidebearingInput('right', '');

        expect(clearedLeft.error).toBeNull();
        expect(clearedRight.error).toBeNull();
        expect(glyph.leftMetricsKey).toBeUndefined();
        expect(glyph.rightMetricsKey).toBeUndefined();
        expect(layer.resolveMetricsKey('left').input).toBe('');
        expect(layer.resolveMetricsKey('right').input).toBe('');
        expect(layer.resolveMetricsKey('left').value).toBeCloseTo(45, 5);
        expect(layer.resolveMetricsKey('right').value).toBeCloseTo(60, 5);
    });

    test('Font.toJSONString() includes offset-applied component positions for automatic layers with =+ sidebearing keys', () => {
        // This test guards against the regression where Font.toJSONString() serialized
        // raw _data (base component positions) instead of Layer.toJSON() output
        // (offset-applied positions), causing the editing font to compile with wrong data.
        const font = makeChainedBaseSidebearingKeyFont();
        const layer = font.findGlyph('sidebearingChain').layers[0];

        layer.rebuildAutomaticComposition();

        // Baseline: before any key, toJSONString must have base positions (x=0 for first component)
        const baseJson = JSON.parse(font.toJSONString());
        const baseLayer = baseJson.glyphs.find(
            (g) => g.name === 'sidebearingChain'
        ).layers[0];
        expect(getSerializedTranslationX(baseLayer.shapes[0])).toBeCloseTo(
            0,
            5
        );
        expect(baseLayer.width).toBeCloseTo(670, 5);

        // Apply a left sidebearing offset of +100
        layer.applySidebearingInput('left', '=+100');

        // After applying the key, toJSONString must carry the offset-applied positions
        // so the Rust compiler sees the correct component placement.
        const adjustedJson = JSON.parse(font.toJSONString());
        const adjustedLayer = adjustedJson.glyphs.find(
            (g) => g.name === 'sidebearingChain'
        ).layers[0];

        expect(getSerializedTranslationX(adjustedLayer.shapes[0])).toBeCloseTo(
            100,
            5
        );
        expect(getSerializedTranslationX(adjustedLayer.shapes[1])).toBeCloseTo(
            410,
            5
        );
        expect(adjustedLayer.width).toBeCloseTo(770, 5);
    });

    test('Font.toJSONString() includes offset-applied width for automatic layers with =+ RSB keys', () => {
        const font = makeChainedBaseSidebearingKeyFont();
        const layer = font.findGlyph('sidebearingChain').layers[0];

        layer.rebuildAutomaticComposition();
        layer.applySidebearingInput('right', '=+100');

        const adjustedJson = JSON.parse(font.toJSONString());
        const adjustedLayer = adjustedJson.glyphs.find(
            (g) => g.name === 'sidebearingChain'
        ).layers[0];

        // RSB offset widens the advance but does not shift component positions
        expect(getSerializedTranslationX(adjustedLayer.shapes[0])).toBeCloseTo(
            0,
            5
        );
        expect(getSerializedTranslationX(adjustedLayer.shapes[1])).toBeCloseTo(
            310,
            5
        );
        expect(adjustedLayer.width).toBeCloseTo(770, 5);
    });

    test('Font.toJSONString() reverts to base positions after the sidebearing key is cleared', () => {
        const font = makeChainedBaseSidebearingKeyFont();
        const layer = font.findGlyph('sidebearingChain').layers[0];

        layer.rebuildAutomaticComposition();
        layer.applySidebearingInput('left', '=+100');
        layer.applySidebearingInput('left', '');

        const clearedJson = JSON.parse(font.toJSONString());
        const clearedLayer = clearedJson.glyphs.find(
            (g) => g.name === 'sidebearingChain'
        ).layers[0];

        expect(getSerializedTranslationX(clearedLayer.shapes[0])).toBeCloseTo(
            0,
            5
        );
        expect(clearedLayer.width).toBeCloseTo(670, 5);
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

    test('automatic chained layers show auto placeholders instead of imported direct-reference metrics keys', () => {
        const chainedFont = makeChainedBaseAutomaticFont();
        const glyph = chainedFont.findGlyph('chainedWord');
        const layer = glyph.layers[0];

        glyph.leftMetricsKey = '=leftBase';
        glyph.rightMetricsKey = '=rightBase';
        layer.rebuildAutomaticComposition();

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: chainedFont });

        setupCanvasForLayer(canvas, chainedFont, 'chainedWord', 'CW0');
        canvas.updatePropertyPanel();

        const inputs = document.querySelectorAll('.glyph-property-input');
        expect(inputs[0].value).toBe('');
        expect(inputs[1].value).toBe('');
        expect(inputs[0].getAttribute('placeholder')).toBe('=+0 or ==+0');
        expect(inputs[1].getAttribute('placeholder')).toBe('=+0 or ==+0');
    });

    test('anchor drag limits downstream automatic recomposition to visible glyphs and uses incremental cache refresh', async () => {
        const dragFont = makeVisibleAnchorCascadeFont();
        const currentFont = {
            fontModel: dragFont,
            syncJsonFromModel: jest.fn(),
            requestRecompileWithoutDataChange: jest.fn()
        };

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);

        const refreshGlyphsAfterModelBatchSpy = jest
            .spyOn(fontManager, 'refreshGlyphsAfterModelBatch')
            .mockResolvedValue();
        const refreshWorkerCacheForReplayTargetsSpy = jest
            .spyOn(fontManager, 'refreshWorkerCacheForReplayTargets')
            .mockResolvedValue(true);
        const glyphChangedHandler = jest.fn();
        const forceFullWorkerCacheUpdateSpy = jest
            .spyOn(fontManager, 'forceFullWorkerCacheUpdate')
            .mockResolvedValue();
        const autoCompileManager = window.autoCompileManager;
        window.autoCompileManager = {
            ...(autoCompileManager || {}),
            checkAndSchedule: jest.fn()
        };
        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            setupCanvasForLayer(canvas, dragFont, 'A', 'A0');
            fontManager.updateEditingSubsetSnapshot(['visibleComposite']);
            canvas.textRunEditor.glyphNameBuffer = ['visibleComposite'];

            const topAnchor = canvas.outlineEditor.layerData.anchors.find(
                (anchor) => anchor.name === 'top'
            );
            topAnchor.x = 320;

            const affectedGlyphNames =
                canvas.outlineEditor.rebuildAutomaticCompositesForCurrentEditedGlyph(
                    {
                        limitToDragVisibleGlyphs: true
                    }
                );

            expect(Array.from(affectedGlyphNames)).toEqual([
                'A',
                'visibleComposite'
            ]);

            canvas.outlineEditor.syncDependentGlyphsAfterAnchorEdit(
                'A',
                affectedGlyphNames,
                { liveVisibleOnly: true }
            );

            // Fire-and-forget path: flush microtask queue + macrotask
            await new Promise((resolve) => setTimeout(resolve, 0));
            await new Promise((resolve) => setTimeout(resolve, 0));

            // liveVisibleOnly skips syncJsonFromModel (deferred to mouseup)
            expect(currentFont.syncJsonFromModel).not.toHaveBeenCalled();
            expect(refreshGlyphsAfterModelBatchSpy).toHaveBeenCalledTimes(1);
            expect(refreshGlyphsAfterModelBatchSpy.mock.calls[0][0]).toEqual([
                'visibleComposite'
            ]);
            expect(refreshGlyphsAfterModelBatchSpy.mock.calls[0][1]).toBe('A0');
            expect(refreshGlyphsAfterModelBatchSpy.mock.calls[0][2]).toEqual({
                dispatchGlyphChanged: false,
                skipFingerprintBaseline: true
            });
            expect(glyphChangedHandler).toHaveBeenCalledTimes(1);
            expect(glyphChangedHandler.mock.calls[0][0].detail).toEqual({
                glyphName: 'A',
                glyphNames: ['A', 'visibleComposite'],
                layerId: 'A0',
                forceImmediateRefresh: true
            });
            expect(refreshWorkerCacheForReplayTargetsSpy).toHaveBeenCalledTimes(
                1
            );
            expect(
                refreshWorkerCacheForReplayTargetsSpy.mock.calls[0][0]
            ).toEqual([{ glyphName: 'A', layerId: 'A0' }]);
            expect(
                refreshWorkerCacheForReplayTargetsSpy.mock
                    .invocationCallOrder[0]
            ).toBeLessThan(
                refreshGlyphsAfterModelBatchSpy.mock.invocationCallOrder[0]
            );
            expect(
                currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(1);
            expect(
                window.autoCompileManager.checkAndSchedule
            ).toHaveBeenCalledTimes(1);
            expect(forceFullWorkerCacheUpdateSpy).not.toHaveBeenCalled();
        } finally {
            window.removeEventListener('glyphChanged', glyphChangedHandler);
            window.autoCompileManager = autoCompileManager;
            refreshGlyphsAfterModelBatchSpy.mockRestore();
            refreshWorkerCacheForReplayTargetsSpy.mockRestore();
            forceFullWorkerCacheUpdateSpy.mockRestore();
            fontManager.updateEditingSubsetSnapshot([]);
        }
    });

    test('anchor drag reuses component source serialization across dependent composite rebuilds', () => {
        const dragFont = makeVisibleAnchorCascadeFont();

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: dragFont });

        setupCanvasForLayer(canvas, dragFont, 'A', 'A0');

        const sourceLayer = dragFont.findGlyph('A').layers[0];
        const layerPrototype = Object.getPrototypeOf(sourceLayer);
        const originalToJSON = layerPrototype.toJSON;
        const toJSONGlyphNames = [];
        const layerToJSONSpy = jest
            .spyOn(layerPrototype, 'toJSON')
            .mockImplementation(function (...args) {
                toJSONGlyphNames.push(this.parent()?.name || null);
                return originalToJSON.apply(this, args);
            });

        try {
            const topAnchor = canvas.outlineEditor.layerData.anchors.find(
                (anchor) => anchor.name === 'top'
            );
            topAnchor.x = 320;

            const affectedGlyphNames =
                canvas.outlineEditor.rebuildAutomaticCompositesForCurrentEditedGlyph();

            expect(Array.from(affectedGlyphNames)).toEqual([
                'A',
                'visibleComposite',
                'hiddenComposite'
            ]);
            expect(
                toJSONGlyphNames.filter((glyphName) => glyphName === 'A')
            ).toHaveLength(1);
            expect(
                toJSONGlyphNames.filter(
                    (glyphName) => glyphName === 'acutecomb'
                )
            ).toHaveLength(1);
        } finally {
            layerToJSONSpy.mockRestore();
        }
    });

    test('anchor drag still requests a live anchor-only recompile when no downstream composites are affected', async () => {
        const dragFont = makeVisibleAnchorCascadeFont();
        const currentFont = {
            fontModel: dragFont,
            syncJsonFromModel: jest.fn(),
            requestRecompileWithoutDataChange: jest.fn()
        };

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);

        const refreshGlyphsAfterModelBatchSpy = jest
            .spyOn(fontManager, 'refreshGlyphsAfterModelBatch')
            .mockResolvedValue();
        const refreshWorkerCacheForReplayTargetsSpy = jest
            .spyOn(fontManager, 'refreshWorkerCacheForReplayTargets')
            .mockResolvedValue(true);
        const glyphChangedHandler = jest.fn();
        const autoCompileManager = window.autoCompileManager;
        window.autoCompileManager = {
            ...(autoCompileManager || {}),
            checkAndSchedule: jest.fn()
        };
        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            setupCanvasForLayer(canvas, dragFont, 'A', 'A0');

            await canvas.outlineEditor.syncDependentGlyphsAfterAnchorEdit(
                'A',
                new Set(['A']),
                { liveVisibleOnly: true }
            );

            expect(currentFont.syncJsonFromModel).not.toHaveBeenCalled();
            expect(refreshWorkerCacheForReplayTargetsSpy).toHaveBeenCalledTimes(
                1
            );
            expect(
                refreshWorkerCacheForReplayTargetsSpy.mock.calls[0][0]
            ).toEqual([{ glyphName: 'A', layerId: 'A0' }]);
            expect(refreshGlyphsAfterModelBatchSpy).not.toHaveBeenCalled();
            expect(glyphChangedHandler).toHaveBeenCalledTimes(1);
            expect(glyphChangedHandler.mock.calls[0][0].detail).toEqual({
                glyphName: 'A',
                layerId: 'A0',
                forceImmediateRefresh: true
            });
            expect(
                currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(1);
            expect(
                window.autoCompileManager.checkAndSchedule
            ).toHaveBeenCalledTimes(1);
        } finally {
            window.removeEventListener('glyphChanged', glyphChangedHandler);
            window.autoCompileManager = autoCompileManager;
            refreshGlyphsAfterModelBatchSpy.mockRestore();
            refreshWorkerCacheForReplayTargetsSpy.mockRestore();
        }
    });

    test('rebuild helper includes dependent composites even when their placement does not change', () => {
        const dragFont = makeVisibleAnchorCascadeFont();
        const currentFont = {
            fontModel: dragFont,
            syncJsonFromModel: jest.fn(),
            requestRecompileWithoutDataChange: jest.fn()
        };

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);

        setupCanvasForLayer(canvas, dragFont, 'A', 'A0');
        canvas.outlineEditor.layerData.shapes = [makeRectPath(0, 0, 520, 700)];

        const affectedGlyphNames =
            canvas.outlineEditor.rebuildAutomaticCompositesForCurrentEditedGlyph();

        expect(Array.from(affectedGlyphNames)).toEqual([
            'A',
            'visibleComposite',
            'hiddenComposite'
        ]);
    });

    test('findGlyphsUsingComponent returns the full recursive dependent closure', () => {
        const font = makeRecursiveDependencyFont();

        expect(font.findDirectGlyphsUsingComponent('source')).toEqual([
            'directDependent'
        ]);
        expect(new Set(font.findGlyphsUsingComponent('source'))).toEqual(
            new Set(['directDependent', 'nestedDependent'])
        );
    });

    test('rebuild helper includes nested transitive dependents whose rendered outlines change', () => {
        const dragFont = makeNestedVisibleAnchorCascadeFont();
        const currentFont = {
            fontModel: dragFont,
            syncJsonFromModel: jest.fn(),
            requestRecompileWithoutDataChange: jest.fn()
        };

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);

        setupCanvasForLayer(canvas, dragFont, 'A', 'A0');
        canvas.outlineEditor.layerData.shapes = [makeRectPath(0, 0, 520, 700)];

        const affectedGlyphNames =
            canvas.outlineEditor.rebuildAutomaticCompositesForCurrentEditedGlyph();

        expect(Array.from(affectedGlyphNames)).toEqual([
            'A',
            'visibleComposite',
            'nestedVisibleComposite'
        ]);
    });

    test('anchor drag mouseup still performs the downstream settle for hidden composites', async () => {
        const dragFont = makeVisibleAnchorCascadeFont();
        const currentFont = {
            fontModel: dragFont,
            syncJsonFromModel: jest.fn(),
            requestRecompileWithoutDataChange: jest.fn()
        };

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);

        const refreshGlyphsAfterModelBatchSpy = jest
            .spyOn(fontManager, 'refreshGlyphsAfterModelBatch')
            .mockResolvedValue();
        const refreshWorkerCacheForReplayTargetsSpy = jest
            .spyOn(fontManager, 'refreshWorkerCacheForReplayTargets')
            .mockResolvedValue(true);
        const updateWorkerFontCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const flushPendingDebugEditingFontSaveAfterDragSpy = jest
            .spyOn(fontManager, 'flushPendingDebugEditingFontSaveAfterDrag')
            .mockImplementation(() => {});

        try {
            setupCanvasForLayer(canvas, dragFont, 'A', 'A0');
            fontManager.updateEditingSubsetSnapshot(['visibleComposite']);
            canvas.textRunEditor.glyphNameBuffer = ['visibleComposite'];
            const topAnchor = canvas.outlineEditor.layerData.anchors.find(
                (anchor) => anchor.name === 'top'
            );
            topAnchor.x = 320;

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.isDraggingAnchor = true;
            canvas.outlineEditor._dragType = 'anchor';
            canvas.outlineEditor._hasMoved = false;
            canvas.outlineEditor.glyphCanvas.updatePropertyPanel = jest.fn();
            canvas.outlineEditor.onMouseUp({});
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(currentFont.syncJsonFromModel).toHaveBeenCalledTimes(1);
            expect(
                currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(1);
            expect(refreshGlyphsAfterModelBatchSpy).toHaveBeenCalledTimes(1);
            expect(refreshGlyphsAfterModelBatchSpy.mock.calls[0][0]).toEqual([
                'visibleComposite',
                'hiddenComposite'
            ]);
            expect(refreshGlyphsAfterModelBatchSpy.mock.calls[0][1]).toBe('A0');
            expect(refreshWorkerCacheForReplayTargetsSpy).toHaveBeenCalledTimes(
                1
            );
            expect(
                refreshWorkerCacheForReplayTargetsSpy.mock.calls[0][0]
            ).toEqual([{ glyphName: 'A', layerId: 'A0' }]);
            expect(
                refreshWorkerCacheForReplayTargetsSpy.mock
                    .invocationCallOrder[0]
            ).toBeLessThan(
                refreshGlyphsAfterModelBatchSpy.mock.invocationCallOrder[0]
            );
            const visibleLayer =
                dragFont.findGlyph('visibleComposite').layers[0];
            const hiddenLayer = dragFont.findGlyph('hiddenComposite').layers[0];
            expect(
                getSerializedTranslationX(visibleLayer.toJSON().shapes[1])
            ).toBeCloseTo(280);
            expect(
                getSerializedTranslationX(hiddenLayer.toJSON().shapes[1])
            ).toBeCloseTo(280);
            expect(updateWorkerFontCacheSpy).not.toHaveBeenCalled();
            expect(
                flushPendingDebugEditingFontSaveAfterDragSpy
            ).toHaveBeenCalledTimes(1);
        } finally {
            refreshGlyphsAfterModelBatchSpy.mockRestore();
            refreshWorkerCacheForReplayTargetsSpy.mockRestore();
            updateWorkerFontCacheSpy.mockRestore();
            flushPendingDebugEditingFontSaveAfterDragSpy.mockRestore();
            fontManager.updateEditingSubsetSnapshot([]);
        }
    });

    test('anchor-inclusive resize mouseup refreshes overview glyphs through the batch cache path', async () => {
        const dragFont = makeVisibleAnchorCascadeFont();
        const currentFont = {
            fontModel: dragFont,
            syncJsonFromModel: jest.fn(),
            requestRecompileWithoutDataChange: jest.fn()
        };

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);

        const refreshGlyphsAfterModelBatchSpy = jest
            .spyOn(fontManager, 'refreshGlyphsAfterModelBatch')
            .mockResolvedValue();
        const refreshWorkerCacheForReplayTargetsSpy = jest
            .spyOn(fontManager, 'refreshWorkerCacheForReplayTargets')
            .mockResolvedValue(true);
        const updateWorkerFontCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const flushPendingDebugEditingFontSaveAfterDragSpy = jest
            .spyOn(fontManager, 'flushPendingDebugEditingFontSaveAfterDrag')
            .mockImplementation(() => {});

        try {
            setupCanvasForLayer(canvas, dragFont, 'A', 'A0');
            const topAnchor = canvas.outlineEditor.layerData.anchors.find(
                (anchor) => anchor.name === 'top'
            );
            topAnchor.x = 320;

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.isResizingSelection = true;
            canvas.outlineEditor._dragType = 'transform';
            canvas.outlineEditor.selectionResizeSnapshot = {
                points: [],
                anchors: [
                    {
                        anchorIndex: 0,
                        startX: 300,
                        startY: 700,
                        name: 'top'
                    }
                ],
                components: [],
                bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
                includesGeometry: false,
                includesAnchors: true,
                centered: false
            };
            canvas.outlineEditor._hasMoved = false;
            canvas.outlineEditor.glyphCanvas.updatePropertyPanel = jest.fn();
            canvas.outlineEditor.onMouseUp({});
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(currentFont.syncJsonFromModel).toHaveBeenCalledTimes(1);
            expect(refreshGlyphsAfterModelBatchSpy).toHaveBeenCalledTimes(1);
            expect(refreshGlyphsAfterModelBatchSpy.mock.calls[0][0]).toEqual([
                'visibleComposite',
                'hiddenComposite'
            ]);
            expect(refreshGlyphsAfterModelBatchSpy.mock.calls[0][1]).toBe('A0');
            expect(refreshWorkerCacheForReplayTargetsSpy).toHaveBeenCalledTimes(
                1
            );
            expect(
                refreshWorkerCacheForReplayTargetsSpy.mock.calls[0][0]
            ).toEqual([{ glyphName: 'A', layerId: 'A0' }]);
            expect(
                refreshWorkerCacheForReplayTargetsSpy.mock
                    .invocationCallOrder[0]
            ).toBeLessThan(
                refreshGlyphsAfterModelBatchSpy.mock.invocationCallOrder[0]
            );
            expect(updateWorkerFontCacheSpy).not.toHaveBeenCalled();
            expect(
                flushPendingDebugEditingFontSaveAfterDragSpy
            ).toHaveBeenCalledTimes(1);
        } finally {
            refreshGlyphsAfterModelBatchSpy.mockRestore();
            refreshWorkerCacheForReplayTargetsSpy.mockRestore();
            updateWorkerFontCacheSpy.mockRestore();
            flushPendingDebugEditingFontSaveAfterDragSpy.mockRestore();
        }
    });
});
