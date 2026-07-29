const { Font } = require('../js/babelfont-model');
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const {
    deriveGlyphNamesFromPaths,
    joinPathWithGlyphSeparator
} = require('../js/change-log');
const {
    buildApplyYjsUpdateMetadataJson
} = require('../js/apply-yjs-update-metadata');

function createRenameFontData(glyphName = 'A') {
    return {
        upm: 1000,
        version: [1, 0],
        axes: [],
        cross_axis_mappings: [],
        instances: [],
        masters: [
            {
                name: { dflt: 'Regular' },
                id: 'master-regular',
                location: {},
                guides: [],
                metrics: {},
                kerning: {}
            }
        ],
        glyphs: [
            {
                name: glyphName,
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'layer-1',
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-regular'
                        },
                        width: 600,
                        shapes: [],
                        anchors: []
                    }
                ]
            }
        ],
        note: '',
        date: new Date('2020-01-01T00:00:00.000Z'),
        names: {},
        features: {
            classes: { renamed: { code: glyphName } },
            prefixes: {},
            features: []
        }
    };
}

describe('glyph rename PatchSync protocol', () => {
    test('Font.renameGlyphs emits a binary rename update before feature refresh', () => {
        const fontData = createRenameFontData();
        const font = Font.fromData(fontData);
        const bridge = new PatchSyncEngine('rename-test');
        const previousBridge = window.patchSyncEngine;
        const emittedUpdates = [];
        bridge.initFromJson(fontData);
        bridge.setYjsWorkerCallback((update, entries) => {
            emittedUpdates.push({ update, entries });
        });
        window.patchSyncEngine = bridge;

        try {
            font.renameGlyphs(new Map([['A', 'A.alt']]));

            expect(emittedUpdates).toHaveLength(1);
            expect(emittedUpdates[0].update).toBeInstanceOf(Uint8Array);
            expect(emittedUpdates[0].update.length).toBeGreaterThan(0);
            expect(emittedUpdates[0].entries).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        glyphRenames: [{ oldName: 'A', newName: 'A.alt' }]
                    }),
                    expect.objectContaining({ path: 'features' })
                ])
            );
            expect(font.findGlyph('A')).toBeUndefined();
            expect(font.findGlyph('A.alt')).toBeDefined();
        } finally {
            window.patchSyncEngine = previousBridge;
            bridge.destroy();
        }
    });

    test('glyph root rename paths preserve dotted glyph names for worker hints', () => {
        const oldName = 'fourFarsi-ar.locl';
        const newName = 'fourFarsi-arabic.locl';
        const fontData = createRenameFontData(oldName);
        const font = Font.fromData(fontData);
        const bridge = new PatchSyncEngine('rename-dotted-test');
        const previousBridge = window.patchSyncEngine;
        const emittedUpdates = [];
        bridge.initFromJson(fontData);
        bridge.setYjsWorkerCallback((update, entries) => {
            emittedUpdates.push({ update, entries });
        });
        window.patchSyncEngine = bridge;

        try {
            font.renameGlyphs(new Map([[oldName, newName]]));

            expect(emittedUpdates).toHaveLength(1);
            const glyphPaths = emittedUpdates[0].entries
                .map((entry) => entry.path)
                .filter((path) => path.startsWith('glyphs.'));
            const derivedNames = deriveGlyphNamesFromPaths(glyphPaths);

            expect(glyphPaths).toEqual(
                expect.arrayContaining([
                    joinPathWithGlyphSeparator(['glyphs', oldName]),
                    joinPathWithGlyphSeparator(['glyphs', newName])
                ])
            );
            expect(derivedNames).toEqual(
                expect.arrayContaining([oldName, newName])
            );
            expect(derivedNames).not.toContain('fourFarsi-ar');
            expect(derivedNames).not.toContain('fourFarsi-arabic');
        } finally {
            window.patchSyncEngine = previousBridge;
            bridge.destroy();
        }
    });
});

describe('glyph rename change-path encoding', () => {
    test('joinPathWithGlyphSeparator round-trips dotted glyph root paths', () => {
        for (const name of [
            'A',
            'A.alt',
            'fourFarsi-ar.locl',
            'fourFarsi-arabic.locl',
            'behDotless-ar.medi'
        ]) {
            const path = joinPathWithGlyphSeparator(['glyphs', name]);
            expect(deriveGlyphNamesFromPaths([path])).toEqual([name]);
        }
    });
});

describe('fontc-worker applyYjsUpdate metadata', () => {
    test('forwards glyphRenames into apply_yjs_update metadata JSON', () => {
        const metadata = JSON.parse(
            buildApplyYjsUpdateMetadataJson({
                changedGlyphs: ['fourFarsi-ar.locl'],
                nonGlyphChangeHints: ['feature-code'],
                layerTargets: [],
                glyphRenames: [
                    {
                        oldName: 'fourFarsi-ar.locl',
                        newName: 'fourFarsi-arabic.locl'
                    }
                ],
                invalidateLayoutClosure: true
            })
        );

        expect(metadata.glyphRenames).toEqual([
            {
                oldName: 'fourFarsi-ar.locl',
                newName: 'fourFarsi-arabic.locl'
            }
        ]);
        expect(metadata.changedGlyphs).toEqual(['fourFarsi-ar.locl']);
        expect(metadata.nonGlyphChangeHints).toEqual(['feature-code']);
        expect(metadata.invalidateLayoutClosure).toBe(true);
    });
});
