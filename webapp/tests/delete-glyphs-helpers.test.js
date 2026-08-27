const {
    countDeletedGlyphTokensInFeatureCode,
    stripDeletedGlyphTokensFromClassCode,
    commentOutFeatureLinesReferencingDeletedGlyphs,
    collectFeatureLinesReferencingDeletedGlyphs,
    buildAffectedKerningKeys,
    filterKerningMap,
    flattenKerningMap
} = require('../js/delete-glyphs-preflight');
const {
    glyphStackReferencesDeletedGlyph
} = require('../js/delete-glyphs-ui-context');
const { highlightFeaSource } = require('../js/delete-glyphs-dialog');

describe('delete glyphs helpers', () => {
    test('strips class tokens and comments out feature lines', () => {
        const deleted = new Set(['A']);
        expect(
            countDeletedGlyphTokensInFeatureCode(
                '# A stays\n@letters A B;\nsub A by B;',
                deleted
            )
        ).toBe(2);
        expect(
            stripDeletedGlyphTokensFromClassCode('@letters A B;', deleted)
        ).toBe('@letters B;');
        expect(
            commentOutFeatureLinesReferencingDeletedGlyphs(
                '# keep\nsub A by B;\nsub B by C;',
                deleted
            )
        ).toBe('# keep\n# [deleted glyph] sub A by B;\nsub B by C;');
    });

    test('affected kerning keys include class memberships', () => {
        const keys = buildAffectedKerningKeys(
            new Set(['A']),
            { A: ['A'], shared: ['A', 'Agrave'] },
            { T: ['T'], A: ['A'] }
        );
        expect([...keys.relatedLeftKeys].sort()).toEqual([
            '@A',
            '@shared',
            'A'
        ]);
        expect([...keys.removedLeftKeys].sort()).toEqual(['@A', 'A']);
        expect([...keys.relatedRightKeys].sort()).toEqual(['@A', 'A']);
        expect([...keys.removedRightKeys].sort()).toEqual(['@A', 'A']);
        expect(
            filterKerningMap(
                { '@A': { T: -80 }, '@shared': { T: -10 }, 'B': { C: -5 } },
                keys.removedLeftKeys,
                keys.removedRightKeys
            )
        ).toEqual({ '@shared:T': -10, 'B:C': -5 });
        expect(flattenKerningMap({ 'A': { V: -80 }, 'B:W': -10 })).toEqual({
            'A:V': -80,
            'B:W': -10
        });
    });

    test('keeps feature block wrappers when commenting rules', () => {
        const deleted = new Set(['a']);
        expect(
            commentOutFeatureLinesReferencingDeletedGlyphs(
                'feature liga {\n  sub a by b;\n  sub f f by f_f;\n} liga;',
                deleted
            )
        ).toBe(
            'feature liga {\n  # [deleted glyph] sub a by b;\n  sub f f by f_f;\n} liga;'
        );
    });

    test('does not touch featureNames description blocks', () => {
        const deleted = new Set(['a']);
        const code = [
            'feature ss01 {',
            '  featureNames {',
            '    name 3 1 0x409 "Alternate a form";',
            '  };',
            '  sub a by a.ss01;',
            '} ss01;'
        ].join('\n');
        expect(countDeletedGlyphTokensInFeatureCode(code, deleted)).toBe(1);
        expect(
            commentOutFeatureLinesReferencingDeletedGlyphs(code, deleted)
        ).toBe(
            [
                'feature ss01 {',
                '  featureNames {',
                '    name 3 1 0x409 "Alternate a form";',
                '  };',
                '  # [deleted glyph] sub a by a.ss01;',
                '} ss01;'
            ].join('\n')
        );
    });

    test('collects affected feature lines with numbers', () => {
        const deleted = new Set(['a']);
        expect(
            collectFeatureLinesReferencingDeletedGlyphs(
                'feature liga {\n  sub a by b;\n  sub f f by f_f;\n} liga;',
                deleted
            )
        ).toEqual([{ lineNumber: 2, text: '  sub a by b;' }]);
    });

    test('highlights FEA tokens for preview panels', () => {
        const html = highlightFeaSource(
            'sub @letters by a; # note',
            new Set(['a'])
        );
        expect(html).toContain('fea-keyword');
        expect(html).toContain('fea-class');
        expect(html).toContain('fea-comment');
        expect(html).toContain('fea-glyph-hit');
        expect(html).toContain('sub');
        expect(html).toContain('@letters');
    });

    test('detects deleted glyphs in the glyph stack', () => {
        expect(
            glyphStackReferencesDeletedGlyph(
                'A@layer1>B@layer1',
                new Set(['A'])
            )
        ).toBe(true);
        expect(
            glyphStackReferencesDeletedGlyph('B@layer1', new Set(['A']))
        ).toBe(false);
    });
});
