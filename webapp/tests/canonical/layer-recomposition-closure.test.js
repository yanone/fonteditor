/**
 * Cascading Layer Recomposition Closure — Canonical Tests
 *
 * Locks the lean recomposition engine:
 *
 *   - `recomposeTargets` receive model writes / Yjs layer snapshots
 *   - `invalidateTargets` are stamped only as workerReplayTargets
 *   - Manual composites keep stored width/translates when the base LSB changes
 *   - Automatic composites still recompose from base metrics / anchors
 *   - Anchor commits persist automatic dependents even after a no-op rebuild
 *     (orphan anchors do not mutate marks, but still snapshot autos for Yjs)
 *   - Metrics-key dependents still recompose on sidebearing and outline edits
 *   - Bridge finalizer infers edit kinds and writes only recompose targets
 */

const { Font, DecomposedAffineTransform } = require('../../js/babelfont-model');
const {
    computeLayerRecompositionClosure,
    deriveEditKindsFromOperations,
    deriveEditKindsFromChangeLogEntries,
    shouldResettleDerivedLayersOnHistoryReplay,
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

function makeMirroredSidebearingCascadeFont() {
    return new Font({
        upm: 1000,
        version: [1, 0],
        axes: [],
        masters: [makeMaster()],
        instances: [],
        glyphs: [
            {
                name: 'source',
                layers: [
                    {
                        id: 'source0',
                        width: 500,
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [makeRectPath(100, 0, 400, 700)],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'mirrored',
                layers: [
                    {
                        id: 'mirrored0',
                        width: 500,
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [makeRectPath(80, 0, 400, 700)],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: { metric_right: '=|source' }
            },
            {
                name: 'downstream',
                layers: [
                    {
                        id: 'downstream0',
                        width: 500,
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [makeRectPath(70, 0, 400, 700)],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: { metric_right: '=mirrored' }
            }
        ],
        names: {},
        features: { classes: {}, prefixes: {}, features: [] },
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    });
}

describe('lean cascading layer recomposition', () => {
    const originalFontManager = window.fontManager;
    const originalCurrentFontModel = window.currentFontModel;

    afterEach(() => {
        window.fontManager = originalFontManager;
        window.currentFontModel = originalCurrentFontModel;
    });

    test('keeps =| sidebearings and downstream metrics keys identical during visible and settled recomposition', () => {
        const runClosure = (scope) => {
            const font = makeMirroredSidebearingCascadeFont();
            const sourceLayer = font
                .findGlyph('source')
                .findLayerById('source0');
            const mirroredLayer = font
                .findGlyph('mirrored')
                .findLayerById('mirrored0');
            const downstreamLayer = font
                .findGlyph('downstream')
                .findLayerById('downstream0');

            sourceLayer.setDirectSidebearing('left', 140);
            const closure = computeLayerRecompositionClosure({
                sourceTargets: [{ glyphName: 'source', layerId: 'source0' }],
                editKinds: new Set(['sidebearing']),
                scope,
                fontModel: font,
                activeLayerId: 'source0',
                sourceGlyphName: 'source',
                visibleGlyphNames: new Set(['source', 'mirrored', 'downstream'])
            });

            return {
                sourceLeft: sourceLayer.lsb,
                mirroredRight: mirroredLayer.rsb,
                downstreamRight: downstreamLayer.rsb,
                replayTargets: closure.allTargets.map(
                    ({ glyphName, layerId }) => `${glyphName}@${layerId}`
                ),
                recomposedTargets: closure.recomposeTargets.map(
                    ({ glyphName, layerId }) => `${glyphName}@${layerId}`
                )
            };
        };

        const live = runClosure('visible');
        const committed = runClosure('all');

        expect(live.sourceLeft).toBe(140);
        expect(live.mirroredRight).toBe(140);
        expect(live.downstreamRight).toBe(140);
        expect(live).toEqual(committed);
        expect(live.replayTargets).toEqual(
            expect.arrayContaining([
                'source@source0',
                'mirrored@mirrored0',
                'downstream@downstream0'
            ])
        );
        expect(live.recomposedTargets).toEqual(
            expect.arrayContaining([
                'mirrored@mirrored0',
                'downstream@downstream0'
            ])
        );
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

    test('sidebearing metrics chains rebuild automatic composites from their final base width', () => {
        // Mixed dependency graph:
        // l RSB -> n RSB -> a RSB -> adieresis (automatic component edge).
        // The final edge must run after metrics-key propagation changes a.
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            instances: [],
            masters: [makeMaster()],
            glyphs: [
                {
                    name: 'l',
                    layers: [
                        {
                            id: 'l0',
                            width: 400,
                            master: { type: 'DefaultForMaster', master: 'M0' },
                            shapes: [makeRectPath(40, 0, 360, 700)],
                            anchors: [],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                },
                {
                    name: 'n',
                    layers: [
                        {
                            id: 'n0',
                            width: 380,
                            master: { type: 'DefaultForMaster', master: 'M0' },
                            shapes: [makeRectPath(40, 0, 340, 700)],
                            anchors: [],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: { metric_right: '=l-10' }
                },
                {
                    name: 'a',
                    layers: [
                        {
                            id: 'a0',
                            width: 500,
                            master: { type: 'DefaultForMaster', master: 'M0' },
                            shapes: [makeRectPath(50, 0, 450, 700)],
                            anchors: [{ name: 'top', x: 250, y: 700 }],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: { metric_right: '=n' }
                },
                {
                    name: 'dieresiscomb',
                    layers: [
                        {
                            id: 'dc0',
                            width: 200,
                            master: { type: 'DefaultForMaster', master: 'M0' },
                            shapes: [makeRectPath(20, 0, 180, 120)],
                            anchors: [{ name: '_top', x: 100, y: 0 }],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                },
                {
                    name: 'adieresis',
                    layers: [
                        {
                            id: 'ad0',
                            width: 500,
                            master: { type: 'DefaultForMaster', master: 'M0' },
                            shapes: [
                                makeComponent('a'),
                                makeComponent('dieresiscomb')
                            ],
                            anchors: [],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                }
            ],
            names: {},
            features: { classes: {}, prefixes: {}, features: [] },
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const lLayer = font.findGlyph('l').findLayerById('l0');
        const nLayer = font.findGlyph('n').findLayerById('n0');
        const aLayer = font.findGlyph('a').findLayerById('a0');
        const adieresisLayer = font.findGlyph('adieresis').findLayerById('ad0');

        lLayer.setDirectSidebearing('right', 100);

        const closure = computeLayerRecompositionClosure({
            sourceTargets: [{ glyphName: 'l', layerId: 'l0' }],
            editKinds: new Set(['sidebearing']),
            scope: 'all',
            fontModel: font,
            activeLayerId: 'l0',
            sourceGlyphName: 'l'
        });

        expect(nLayer.rsb).toBe(90);
        expect(aLayer.rsb).toBe(90);
        expect(adieresisLayer.width).toBe(aLayer.width);
        expect(adieresisLayer.rsb).toBe(aLayer.rsb);
        expect(closure.recomposeGlyphNames.has('n')).toBe(true);
        expect(closure.recomposeGlyphNames.has('a')).toBe(true);
        expect(closure.recomposeGlyphNames.has('adieresis')).toBe(true);

        // The live closure is the same mixed graph, merely restricted to the
        // visible text-run closure. It must reach the same fixed point.
        lLayer.setDirectSidebearing('right', 110);
        const visibleClosure = computeLayerRecompositionClosure({
            sourceTargets: [{ glyphName: 'l', layerId: 'l0' }],
            editKinds: new Set(['sidebearing']),
            scope: 'visible',
            fontModel: font,
            activeLayerId: 'l0',
            sourceGlyphName: 'l',
            visibleGlyphNames: new Set(['l', 'n', 'a', 'adieresis'])
        });

        expect(nLayer.rsb).toBe(100);
        expect(aLayer.rsb).toBe(100);
        expect(adieresisLayer.width).toBe(aLayer.width);
        expect(adieresisLayer.rsb).toBe(aLayer.rsb);
        expect(visibleClosure.recomposeGlyphNames.has('adieresis')).toBe(true);

        // The all-scope settlement sees the already-converged visible model as
        // a no-op, but must still snapshot the exact layers the live closure
        // mutated or the worker will reshape from stale a/adieresis data.
        const settledClosure = computeLayerRecompositionClosure({
            sourceTargets: [{ glyphName: 'l', layerId: 'l0' }],
            editKinds: new Set(['sidebearing']),
            scope: 'all',
            fontModel: font,
            activeLayerId: 'l0',
            sourceGlyphName: 'l'
        });
        const settledTargets = resolveLayerSyncTargetsFromClosure(
            settledClosure,
            [{ glyphName: 'l', layerId: 'l0' }],
            visibleClosure.recomposeTargets
        );

        expect(
            settledTargets.changedLayerTargets.map((target) => target.glyphName)
        ).toEqual(expect.arrayContaining(['n', 'a', 'adieresis']));
    });

    test('visible scope includes hidden metrics-key prerequisites', () => {
        // Text can visibly contain a.ss03 while its =n key references hidden
        // n, which in turn references the edited l. The live closure must
        // include n as a prerequisite or commit resolves a.ss03 differently.
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            instances: [],
            masters: [makeMaster()],
            glyphs: [
                {
                    name: 'l',
                    layers: [
                        {
                            id: 'l0',
                            width: 400,
                            master: { type: 'DefaultForMaster', master: 'M0' },
                            shapes: [makeRectPath(40, 0, 360, 700)],
                            anchors: [],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: {}
                },
                {
                    name: 'n',
                    layers: [
                        {
                            id: 'n0',
                            width: 380,
                            master: { type: 'DefaultForMaster', master: 'M0' },
                            shapes: [makeRectPath(40, 0, 340, 700)],
                            anchors: [],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: { metric_right: '=l-10' }
                },
                {
                    name: 'a.ss03',
                    layers: [
                        {
                            id: 'ss0',
                            width: 500,
                            master: { type: 'DefaultForMaster', master: 'M0' },
                            shapes: [makeRectPath(50, 0, 450, 700)],
                            anchors: [],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: { metric_right: '=n' }
                }
            ],
            names: {},
            features: { classes: {}, prefixes: {}, features: [] },
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });
        const lLayer = font.findGlyph('l').findLayerById('l0');
        const nLayer = font.findGlyph('n').findLayerById('n0');
        const ssLayer = font.findGlyph('a.ss03').findLayerById('ss0');

        lLayer.setDirectSidebearing('right', 100);
        const closure = computeLayerRecompositionClosure({
            sourceTargets: [{ glyphName: 'l', layerId: 'l0' }],
            editKinds: new Set(['sidebearing']),
            scope: 'visible',
            fontModel: font,
            activeLayerId: 'l0',
            sourceGlyphName: 'l',
            // n is intentionally omitted: it must be retained from a.ss03's
            // metrics-key prerequisite closure.
            visibleGlyphNames: new Set(['l', 'a.ss03'])
        });

        expect(nLayer.rsb).toBe(90);
        expect(ssLayer.rsb).toBe(90);
        expect(closure.recomposeGlyphNames.has('n')).toBe(true);
        expect(closure.recomposeGlyphNames.has('a.ss03')).toBe(true);
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

    test('unused orphan anchor does not mutate automatic composites but still persists them', () => {
        const font = makeLeanRecompositionFont();
        font.findGlyph('adieresisAuto')
            .findLayerById('ada0')
            .rebuildAutomaticComposition();
        const auto = font.findGlyph('adieresisAuto').findLayerById('ada0');
        const markBefore = getComponentTranslation(auto, 1);

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

        // Orphan anchors do not move marks, but commit must still snapshot
        // automatic dependents so a prior live converge cannot leave Yjs stale.
        expect(getComponentTranslation(auto, 1)).toEqual(markBefore);
        expect(closure.recomposeGlyphNames.has('adieresisAuto')).toBe(true);
        expect(closure.recomposeGlyphNames.has('adieresisManual')).toBe(false);
        expect([...closure.invalidateGlyphNames].sort()).toEqual(
            expect.arrayContaining(['adieresisManual'])
        );
        // Anchor-only must not run metrics-key inheritance.
        expect(closure.recomposeGlyphNames.has('n')).toBe(false);
    });

    test('anchor commit still persists automatic composites after a no-op rebuild', () => {
        const font = makeLeanRecompositionFont();
        const auto = font.findGlyph('adieresisAuto').findLayerById('ada0');
        auto.rebuildAutomaticComposition();

        const top = font
            .findGlyph('a')
            .findLayerById('a0')
            .anchors.find((anchor) => anchor.name === 'top');
        top.y = 760;
        // Live pass applies the mark move.
        font.rebuildAutomaticCompositesForGlyphs(new Set(['a']));
        const markAfterLive = getComponentTranslation(auto, 1);

        // Commit-time closure after live already converged: rebuild reports
        // no further mutations, but changedLayerTargets must still include
        // the automatic composite for Yjs persistence.
        const rebuildSpy = jest
            .spyOn(font, 'rebuildAutomaticCompositesForGlyphs')
            .mockReturnValue(new Set());
        const closure = computeLayerRecompositionClosure({
            sourceTargets: [{ glyphName: 'a', layerId: 'a0' }],
            editKinds: new Set(['anchor']),
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
        expect(getComponentTranslation(auto, 1)).toEqual(markAfterLive);
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

        expect(metricsSpy).toHaveBeenCalledWith(new Set(['a']), {
            skipInitialAutomaticCompositeRebuild: true
        });
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

describe('undo/redo derived-layer resettle helpers', () => {
    test('detects cascade kinds and derived glyphs', () => {
        const entries = [
            {
                path: 'glyphs.A:layers.layer-1',
                oldValue: { id: 'layer-1', anchors: [] },
                newValue: { id: 'layer-1', anchors: [{ name: 'top' }] }
            },
            {
                path: 'glyphs.B:layers.layer-2',
                oldValue: { id: 'layer-2', width: 650 },
                newValue: { id: 'layer-2', width: 777 }
            }
        ];
        const kinds = deriveEditKindsFromChangeLogEntries(entries);
        expect(kinds.has('anchor')).toBe(true);
        expect(
            shouldResettleDerivedLayersOnHistoryReplay(
                {
                    originatingGlyphName: 'A',
                    entries,
                    workerReplayTargets: [
                        { glyphName: 'A', layerId: 'layer-1' },
                        { glyphName: 'B', layerId: 'layer-2' }
                    ]
                },
                true
            )
        ).toBe(true);
        expect(
            shouldResettleDerivedLayersOnHistoryReplay(
                {
                    originatingGlyphName: 'A',
                    entries: [
                        {
                            path: 'glyphs.A:layers.layer-1.anchors',
                            oldValue: [],
                            newValue: [{ name: 'top' }]
                        },
                        {
                            path: 'glyphs.B:layers.layer-2',
                            oldValue: { id: 'layer-2', width: 650, shapes: [] },
                            newValue: {
                                id: 'layer-2',
                                width: 777,
                                shapes: [{ type: 'component' }]
                            }
                        }
                    ],
                    workerReplayTargets: [
                        { glyphName: 'A', layerId: 'layer-1' },
                        { glyphName: 'B', layerId: 'layer-2' }
                    ]
                },
                true
            )
        ).toBe(true);
        expect(
            shouldResettleDerivedLayersOnHistoryReplay(
                {
                    originatingGlyphName: 'A',
                    entries,
                    workerReplayTargets: [
                        { glyphName: 'A', layerId: 'layer-1' },
                        { glyphName: 'B', layerId: 'layer-2' }
                    ]
                },
                false
            )
        ).toBe(false);
    });
});
