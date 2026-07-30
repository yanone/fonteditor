const {
    matchGlyphOverviewTypeahead,
    appendGlyphOverviewTypeaheadBuffer,
    GLYPH_OVERVIEW_TYPEAHEAD_TIMEOUT_MS
} = require('../js/glyph-overview-typeahead');

describe('glyph-overview-typeahead', () => {
    const glyphs = [
        { name: 'A', codepoints: [65] },
        { name: 'a', codepoints: [97] },
        { name: 'acute', codepoints: [] },
        { name: 'aacute', codepoints: [225] },
        { name: 'B', codepoints: [66] }
    ];

    test('single character matches Unicode codepoint in list order', () => {
        expect(matchGlyphOverviewTypeahead('a', glyphs)).toBe('a');
        expect(matchGlyphOverviewTypeahead('A', glyphs)).toBe('A');
        expect(matchGlyphOverviewTypeahead('á', glyphs)).toBe('aacute');
    });

    test('single character does not fall back to glyph name', () => {
        expect(matchGlyphOverviewTypeahead('x', glyphs)).toBeNull();
    });

    test('multi-character buffer prefix-matches glyph names case-insensitively', () => {
        expect(matchGlyphOverviewTypeahead('ac', glyphs)).toBe('acute');
        expect(matchGlyphOverviewTypeahead('Aa', glyphs)).toBe('aacute');
        expect(matchGlyphOverviewTypeahead('zz', glyphs)).toBeNull();
    });

    test('append resets after timeout and accumulates within timeout', () => {
        expect(
            appendGlyphOverviewTypeaheadBuffer(
                'a',
                'c',
                GLYPH_OVERVIEW_TYPEAHEAD_TIMEOUT_MS + 1
            )
        ).toBe('c');
        expect(appendGlyphOverviewTypeaheadBuffer('a', 'c', 100)).toBe('ac');
        expect(appendGlyphOverviewTypeaheadBuffer('', 'a', 0)).toBe('a');
    });
});
