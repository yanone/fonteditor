const {
    glyphNameMatchesSearchTerms,
    parseGlyphSearchTerms
} = require('../js/glyph-search');

describe('glyph search', () => {
    test('normalizes space-separated glyph-name terms', () => {
        expect(parseGlyphSearchTerms('  A  LT  ')).toEqual(['a', 'lt']);
    });

    test('requires every search term to be present in the glyph name', () => {
        const terms = parseGlyphSearchTerms('acute comb');

        expect(glyphNameMatchesSearchTerms('acutecomb', terms)).toBe(true);
        expect(glyphNameMatchesSearchTerms('acute', terms)).toBe(false);
    });
});
