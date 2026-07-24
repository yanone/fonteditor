/**
 * Cascading Layer Recomposition Closure — Canonical Tests
 *
 * Locks the lean recomposition engine:
 *
 *   - `recomposeTargets` receive model writes / Yjs layer snapshots
 *   - `invalidateTargets` are stamped only as workerReplayTargets
 *   - Manual composites keep stored width/translates when the base LSB changes
 *   - Automatic composites still recompose from base metrics / anchors
 *   - Irrelevant / unused anchors do not expand recompose targets
 *   - Metrics-key dependents still recompose on sidebearing and outline edits
 *   - Bridge finalizer infers edit kinds and writes only recompose targets
 */

const { Font, DecomposedAffineTransform } = require('../../js/babelfont-model');
const {
    computeLayerRecompositionClosure,
    deriveEditKindsFromOperations,
    resolveLayerSyncTargetsFromClosure
} = require('../../js/recomposition-closure');
const { PatchSyncEngine: ChangeBridge } = require('../../js/patch-sync-engine');
const {
    buildCascadingRecompositionOperations
} = require('../../js/change-bridge-init');

const GLYPHS_COMPONENT_ALIGNMENT_KEY = 'com.schriftgestalt.Glyphs.alignment';

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
        nodes: [
            { type: 'l', x: minX, y: minY },
            { type: 'l', x: maxX, y: minY },
            { type: 'l', x: maxX, y: maxY },
            { type: 'l', x: minX, y: maxY }
        ],
        closed: true
    };
}

function makeComponent(reference, options = {}) {
    const {
        x = 0,
        y = 0,
        auto = true,
        transform = {
            translation: [x, y],
            scale: [1, 1],
            rotation: 0,
            skew: [0, 0],
            tCenter: [0, 0],
            order: 'RestOfTheWorld'
        }
    } = options;
    return {
        reference,
        transform,
        format_specific: {
            [GLYPHS_COMPONENT_ALIGNMENT_KEY]: auto ? 1 : -1
        }
    };
}

function makeLeanRecompositionFont() {
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
        masters: [makeMaster()],
        glyphs: [
            {
                name: 'a',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'a0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(50, 0, 450, 700)],
                        anchors: [
                            { name: 'top', x: 250, y: 700 },
                            { name: 'orphan', x: 10, y: 10 }
                        ],
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
                        id: 'dc0',
                        width: 200,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(20, 0, 180, 120)],
                        anchors: [{ name: '_top', x: 100, y: 0 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'adieresisManual',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'adm0',
                        width: 520,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeComponent('a', {
                                auto: false,
                                x: 10,
                                y: 0
                            }),
                            makeComponent('dieresiscomb', {
                                auto: false,
                                x: 40,
                                y: 720
                            })
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'adieresisAuto',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'ada0',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [
                            makeComponent('a', { auto: true }),
                            makeComponent('dieresiscomb', { auto: true })
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'n',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'n0',
                        width: 480,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'M0'
                        },
                        shapes: [makeRectPath(40, 0, 440, 700)],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {
                    metric_left: '=a'
                }
            }
        ],
        names: { family_name: { en: 'Lean Recomposition Canonical' } },
        note: '',
        date: '2026-07-24',
        features: { classes: {}, prefixes: {}, features: [] },
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    });
}

function getComponentTranslation(layer, index) {
    const shape = layer.shapes[index];
    const component = shape.isComponent?.() ? shape.asComponent() : shape;
    const transform = component.transform;
    if (Array.isArray(transform)) {
        return { x: transform[4], y: transform[5] };
    }
    if (transform instanceof DecomposedAffineTransform) {
        return {
            x: transform.translation[0],
            y: transform.translation[1]
        };
    }
    return {
        x: transform?.translation?.[0] ?? 0,
        y: transform?.translation?.[1] ?? 0
    };
}

describe('lean cascading layer recomposition', () => {
    const originalFontManager = window.fontManager;
    const originalCurrentFontModel = window.currentFontModel;

    afterEach(() => {
        window.fontManager = originalFontManager;
        window.currentFontModel = originalCurrentFontModel;
    });

    test('sidebearing edit invalidates manual composites but does not recompose them', () => {
        const font = makeLeanRecompositionFont();
        const manual = font.findGlyph('adieresisManual').findLayerById('adm0');
        const auto = font.findGlyph('adieresisAuto').findLayerById('ada0');
        auto.rebuildAutomaticComposition();

        const manualWidthBefore = manual.width;
        const manualTranslateBefore = getComponentTranslation(manual, 0);
        const autoWidthBefore = auto.width;

        const aLayer = font.findGlyph('a').findLayerById('a0');
        aLayer.setDirectSidebearing('left', aLayer.lsb + 40);

        const closure = computeLayerRecompositionClosure({
            sourceTargets: [{ glyphName: 'a', layerId: 'a0' }],
            editKinds: new Set(['sidebearing']),
            scope: 'all',
            fontModel: font,
            activeLayerId: 'a0',
            sourceGlyphName: 'a'
        });

        expect([...closure.invalidateGlyphNames].sort()).toEqual(
            expect.arrayContaining(['adieresisManual', 'adieresisAuto'])
        );
        expect(closure.recomposeGlyphNames.has('adieresisManual')).toBe(false);
        expect(closure.recomposeGlyphNames.has('adieresisAuto')).toBe(true);
        expect(closure.recomposeGlyphNames.has('n')).toBe(true);

        expect(manual.width).toBe(manualWidthBefore);
        expect(getComponentTranslation(manual, 0)).toEqual(
            manualTranslateBefore
        );
        expect(auto.width).not.toBe(autoWidthBefore);

        const syncTargets = resolveLayerSyncTargetsFromClosure(closure, [
            { glyphName: 'a', layerId: 'a0' }
        ]);
        expect(
            syncTargets.changedLayerTargets.map((t) => t.glyphName).sort()
        ).toEqual(expect.arrayContaining(['a', 'adieresisAuto', 'n']));
        expect(
            syncTargets.changedLayerTargets.some(
                (t) => t.glyphName === 'adieresisManual'
            )
        ).toBe(false);
        expect(
            syncTargets.workerReplayTargets.some(
                (t) => t.glyphName === 'adieresisManual'
            )
        ).toBe(true);
    });

    test('sidebearing commit still persists automatic composites after a no-op rebuild', () => {
        const font = makeLeanRecompositionFont();
        const auto = font.findGlyph('adieresisAuto').findLayerById('ada0');
        auto.rebuildAutomaticComposition();

        const aLayer = font.findGlyph('a').findLayerById('a0');
        aLayer.setDirectSidebearing('left', aLayer.lsb + 40);
        // First pass applies the live recomposition.
        font.rebuildAutomaticCompositesForGlyphs(new Set(['a']));
        const autoWidthAfterLive = auto.width;

        // Second pass mimics commit-time closure after live already converged:
        // rebuild reports no further mutations, but changedLayerTargets must
        // still include the automatic composite for Yjs persistence.
        const rebuildSpy = jest
            .spyOn(font, 'rebuildAutomaticCompositesForGlyphs')
            .mockReturnValue(new Set());
        const closure = computeLayerRecompositionClosure({
            sourceTargets: [{ glyphName: 'a', layerId: 'a0' }],
            editKinds: new Set(['sidebearing']),
            scope: 'all',
            fontModel: font,
            activeLayerId: 'a0',
            sourceGlyphName: 'a'
        });

        expect(rebuildSpy).toHaveBeenCalled();
        expect(closure.recomposeGlyphNames.has('adieresisAuto')).toBe(true);
        expect(closure.recomposeGlyphNames.has('adieresisManual')).toBe(false);
        expect(
            resolveLayerSyncTargetsFromClosure(closure, [
                { glyphName: 'a', layerId: 'a0' }
            ]).changedLayerTargets.some(
                (target) => target.glyphName === 'adieresisAuto'
            )
        ).toBe(true);
        expect(auto.width).toBe(autoWidthAfterLive);
    });

    test('unused orphan anchor does not recompose component dependents', () => {
        const font = makeLeanRecompositionFont();
        font.findGlyph('adieresisAuto')
            .findLayerById('ada0')
            .rebuildAutomaticComposition();

        const orphan = font
            .findGlyph('a')
            .findLayerById('a0')
            .anchors.find((anchor) => anchor.name === 'orphan');
        orphan.x = 99;
        orphan.y = 88;

        const closure = computeLayerRecompositionClosure({
            sourceTargets: [{ glyphName: 'a', layerId: 'a0' }],
            editKinds: new Set(['anchor']),
            scope: 'all',
            fontModel: font,
            activeLayerId: 'a0',
            sourceGlyphName: 'a'
        });

        expect(closure.recomposeTargets).toEqual([]);
        expect(closure.recomposeGlyphNames.size).toBe(0);
        expect([...closure.invalidateGlyphNames].sort()).toEqual(
            expect.arrayContaining(['adieresisManual', 'adieresisAuto'])
        );
        // Anchor-only must not run metrics-key inheritance.
        expect(closure.recomposeGlyphNames.has('n')).toBe(false);
    });

    test('composition-relevant top anchor recomposes automatic dependents only', () => {
        const font = makeLeanRecompositionFont();
        const auto = font.findGlyph('adieresisAuto').findLayerById('ada0');
        auto.rebuildAutomaticComposition();
        const markTranslateBefore = getComponentTranslation(auto, 1);

        const top = font
            .findGlyph('a')
            .findLayerById('a0')
            .anchors.find((anchor) => anchor.name === 'top');
        top.y = 760;

        const closure = computeLayerRecompositionClosure({
            sourceTargets: [{ glyphName: 'a', layerId: 'a0' }],
            editKinds: new Set(['anchor']),
            scope: 'all',
            fontModel: font,
            activeLayerId: 'a0',
            sourceGlyphName: 'a'
        });

        expect(closure.recomposeGlyphNames.has('adieresisAuto')).toBe(true);
        expect(closure.recomposeGlyphNames.has('adieresisManual')).toBe(false);
        expect(getComponentTranslation(auto, 1).y).not.toBe(
            markTranslateBefore.y
        );
    });

    test('outline edit kinds invoke metrics-key recomposition', () => {
        const font = makeLeanRecompositionFont();
        const metricsSpy = jest
            .spyOn(font, 'recomputeMetricsKeys')
            .mockReturnValue(new Set(['n']));
        jest.spyOn(font, 'rebuildAutomaticCompositesForGlyphs').mockReturnValue(
            new Set()
        );
        jest.spyOn(font, 'collectComponentDependentGlyphs').mockReturnValue(
            new Set(['adieresisManual'])
        );

        const closure = computeLayerRecompositionClosure({
            sourceTargets: [{ glyphName: 'a', layerId: 'a0' }],
            editKinds: new Set(['outline']),
            scope: 'all',
            fontModel: font,
            activeLayerId: 'a0',
            sourceGlyphName: 'a'
        });

        expect(metricsSpy).toHaveBeenCalledWith(new Set(['a']));
        expect(closure.recomposeGlyphNames.has('n')).toBe(true);
        expect(closure.invalidateGlyphNames.has('adieresisManual')).toBe(true);
        expect(
            closure.recomposeTargets.some((target) => target.glyphName === 'n')
        ).toBe(true);
        expect(
            resolveLayerSyncTargetsFromClosure(closure, [
                { glyphName: 'a', layerId: 'a0' }
            ]).changedLayerTargets.some(
                (target) => target.glyphName === 'adieresisManual'
            )
        ).toBe(false);
    });

    test('deriveEditKindsFromOperations is path-accurate', () => {
        expect([
            ...deriveEditKindsFromOperations([
                {
                    path: ['glyphs', 'a', 'layers', 'a0', 'width'],
                    newValue: 600
                }
            ])
        ]).toEqual(['sidebearing']);
        expect([
            ...deriveEditKindsFromOperations([
                {
                    path: ['glyphs', 'a', 'layers', 'a0', 'anchors', 0],
                    newValue: { name: 'top', x: 1, y: 2 }
                }
            ])
        ]).toEqual(['anchor']);
    });

    test('finalizer writes only recomposed dependents for width cascade', () => {
        const fontJson = {
            glyphs: [
                {
                    name: 'a',
                    layers: [
                        {
                            id: 'a0',
                            width: 500,
                            anchors: [],
                            shapes: []
                        }
                    ]
                },
                {
                    name: 'adieresisManual',
                    layers: [
                        {
                            id: 'adm0',
                            width: 520,
                            anchors: [],
                            shapes: []
                        }
                    ]
                },
                {
                    name: 'adieresisAuto',
                    layers: [
                        {
                            id: 'ada0',
                            width: 500,
                            anchors: [],
                            shapes: []
                        }
                    ]
                },
                {
                    name: 'n',
                    layers: [
                        {
                            id: 'n0',
                            width: 480,
                            anchors: [],
                            shapes: []
                        }
                    ]
                }
            ]
        };
        const bridge = new ChangeBridge('lean-cascade-test');
        bridge.initFromJson(fontJson);

        fontJson.glyphs[0].layers[0].width = 560;

        const sourceLayer = {
            id: 'a0',
            getMatchingLayerOnGlyph: jest.fn((glyphName) => {
                if (glyphName === 'adieresisManual') return { id: 'adm0' };
                if (glyphName === 'adieresisAuto') return { id: 'ada0' };
                if (glyphName === 'n') return { id: 'n0' };
                return null;
            })
        };

        window.fontManager = {
            currentFont: {
                fontModel: {
                    findGlyph: jest.fn((glyphName) => {
                        if (glyphName === 'a') {
                            return {
                                findLayerById: jest.fn((layerId) =>
                                    layerId === 'a0' ? sourceLayer : null
                                )
                            };
                        }
                        const layerIdByGlyph = {
                            adieresisManual: 'adm0',
                            adieresisAuto: 'ada0',
                            n: 'n0'
                        };
                        const layerId = layerIdByGlyph[glyphName];
                        if (!layerId) {
                            return null;
                        }
                        return {
                            findLayerById: jest.fn((id) =>
                                id === layerId ? { id: layerId } : null
                            )
                        };
                    }),
                    collectComponentDependentGlyphs: jest.fn(
                        () => new Set(['adieresisManual', 'adieresisAuto'])
                    ),
                    rebuildAutomaticCompositesForGlyphs: jest.fn(() => {
                        fontJson.glyphs.find(
                            (glyph) => glyph.name === 'adieresisAuto'
                        ).layers[0].width = 560;
                        return new Set(['adieresisAuto']);
                    }),
                    recomputeMetricsKeys: jest.fn(() => {
                        fontJson.glyphs.find(
                            (glyph) => glyph.name === 'n'
                        ).layers[0].width = 540;
                        return new Set(['n']);
                    })
                }
            }
        };

        const operations = buildCascadingRecompositionOperations(bridge, [
            {
                op: 'set',
                path: ['glyphs', 'a', 'layers', 'a0', 'width'],
                oldValue: 500,
                newValue: 560
            }
        ]);

        const glyphNames = operations.map((op) => op.path[1]);
        expect(glyphNames).toEqual(
            expect.arrayContaining(['adieresisAuto', 'n'])
        );
        expect(glyphNames).not.toContain('adieresisManual');
        expect(
            window.fontManager.currentFont.fontModel
                .rebuildAutomaticCompositesForGlyphs
        ).toHaveBeenCalled();
        expect(
            window.fontManager.currentFont.fontModel.recomputeMetricsKeys
        ).toHaveBeenCalled();
    });

    test('finalizer does not run metrics for anchor-only packets', () => {
        const fontJson = {
            glyphs: [
                {
                    name: 'a',
                    layers: [
                        {
                            id: 'a0',
                            width: 500,
                            anchors: [{ name: 'orphan', x: 1, y: 2 }],
                            shapes: []
                        }
                    ]
                },
                {
                    name: 'adieresisManual',
                    layers: [
                        {
                            id: 'adm0',
                            width: 520,
                            anchors: [],
                            shapes: []
                        }
                    ]
                }
            ]
        };
        const bridge = new ChangeBridge('lean-anchor-cascade-test');
        bridge.initFromJson(fontJson);

        fontJson.glyphs[0].layers[0].anchors = [{ name: 'orphan', x: 9, y: 9 }];

        const sourceLayer = {
            id: 'a0',
            getMatchingLayerOnGlyph: jest.fn((glyphName) =>
                glyphName === 'adieresisManual' ? { id: 'adm0' } : null
            )
        };

        window.fontManager = {
            currentFont: {
                fontModel: {
                    findGlyph: jest.fn((glyphName) => {
                        if (glyphName === 'a') {
                            return {
                                findLayerById: jest.fn((layerId) =>
                                    layerId === 'a0' ? sourceLayer : null
                                )
                            };
                        }
                        if (glyphName === 'adieresisManual') {
                            return {
                                findLayerById: jest.fn((layerId) =>
                                    layerId === 'adm0' ? { id: 'adm0' } : null
                                )
                            };
                        }
                        return null;
                    }),
                    collectComponentDependentGlyphs: jest.fn(
                        () => new Set(['adieresisManual'])
                    ),
                    rebuildAutomaticCompositesForGlyphs: jest.fn(
                        () => new Set()
                    ),
                    recomputeMetricsKeys: jest.fn(() => new Set(['n']))
                }
            }
        };

        const operations = buildCascadingRecompositionOperations(bridge, [
            {
                op: 'set',
                path: ['glyphs', 'a', 'layers', 'a0', 'anchors', 0],
                oldValue: { name: 'orphan', x: 1, y: 2 },
                newValue: { name: 'orphan', x: 9, y: 9 }
            }
        ]);

        expect(operations).toEqual([]);
        expect(
            window.fontManager.currentFont.fontModel.recomputeMetricsKeys
        ).not.toHaveBeenCalled();
        expect(
            window.fontManager.currentFont.fontModel
                .rebuildAutomaticCompositesForGlyphs
        ).toHaveBeenCalled();
    });
});
