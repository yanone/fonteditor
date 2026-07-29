const {
    countDeletedGlyphTokensInFeatureCode,
    stripDeletedGlyphTokensFromClassCode,
    commentOutFeatureLinesReferencingDeletedGlyphs
} = require('../js/delete-glyphs-preflight');
const {
    glyphStackReferencesDeletedGlyph
} = require('../js/delete-glyphs-ui-context');

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
