const {
    compareGlyphsBySearchRelevance,
    countGlyphSearchCaseMismatches,
    countUnicodeCharacterCaseMismatches,
    getNonAsciiCharacterCodepoints,
    getUnicodeTargetsForSearchTerm,
    glyphMatchesSearchTerms,
    glyphNameMatchesSearchTerms,
    parseGlyphSearchTerms,
    parseGlyphSearchTermsPreserveCase,
    parseHexUnicodeTerm
} = require('../js/glyph-search');

describe('glyph search', () => {
    test('normalizes space-separated glyph-name terms', () => {
        expect(parseGlyphSearchTerms('  A  LT  ')).toEqual(['a', 'lt']);
        expect(parseGlyphSearchTermsPreserveCase('  A  LT  ')).toEqual([
            'A',
            'LT'
        ]);
    });

    test('requires every search term to be present in the glyph name', () => {
        const terms = parseGlyphSearchTerms('acute comb');

        expect(glyphNameMatchesSearchTerms('acutecomb', terms)).toBe(true);
        expect(glyphNameMatchesSearchTerms('acute', terms)).toBe(false);
    });

    test('parses bare and prefixed hex Unicode terms', () => {
        expect(parseHexUnicodeTerm('00e4')).toBe(0xe4);
        expect(parseHexUnicodeTerm('00E4')).toBe(0xe4);
        expect(parseHexUnicodeTerm('e4')).toBe(0xe4);
        expect(parseHexUnicodeTerm('u+00e4')).toBe(0xe4);
        expect(parseHexUnicodeTerm('0x41')).toBe(0x41);
        expect(parseHexUnicodeTerm('adieresis')).toBeNull();
    });

    test('matches partial hex Unicode fragments against padded codepoints', () => {
        const letterL = { name: 'L', codepoints: [0x4c] };
        const adieresis = { name: 'adieresis', codepoints: [0xe4] };

        expect(glyphMatchesSearchTerms(letterL, ['004'])).toBe(true);
        expect(glyphMatchesSearchTerms(letterL, ['004c'])).toBe(true);
        expect(glyphMatchesSearchTerms(letterL, ['4c'])).toBe(true);
        expect(glyphMatchesSearchTerms(letterL, ['005'])).toBe(false);
        expect(glyphMatchesSearchTerms(adieresis, ['00e'])).toBe(true);
        expect(glyphMatchesSearchTerms(adieresis, ['u+00e'])).toBe(true);
    });

    test('maps non-ASCII characters to upper and lower codepoints', () => {
        expect(
            getNonAsciiCharacterCodepoints('ä').sort((a, b) => a - b)
        ).toEqual([0xc4, 0xe4]);
        expect(
            getNonAsciiCharacterCodepoints('Ä').sort((a, b) => a - b)
        ).toEqual([0xc4, 0xe4]);
        expect(getNonAsciiCharacterCodepoints('a')).toEqual([]);
        expect(getNonAsciiCharacterCodepoints('o')).toEqual([]);
    });

    test('matches Find Glyph terms by name or Unicode with AND semantics', () => {
        const adieresis = { name: 'adieresis', codepoints: [0xe4] };
        const acutecomb = { name: 'acutecomb', codepoints: [0x301] };
        const multi = { name: 'A', codepoints: [0x41, 0xe4] };

        expect(glyphMatchesSearchTerms(adieresis, ['ä'])).toBe(true);
        expect(glyphMatchesSearchTerms(adieresis, ['00e4'])).toBe(true);
        expect(glyphMatchesSearchTerms(adieresis, ['o'])).toBe(false);
        expect(glyphMatchesSearchTerms(acutecomb, ['acute', 'comb'])).toBe(
            true
        );
        expect(glyphMatchesSearchTerms(acutecomb, ['acute', 'grave'])).toBe(
            false
        );
        expect(glyphMatchesSearchTerms(multi, ['00e4'])).toBe(true);
    });

    test('ASCII letters do not Unicode-match their own codepoints', () => {
        const letterO = { name: 'x', codepoints: [0x6f] };
        const letterA = { name: 'x', codepoints: [0x61] };

        // "o" is not a hex digit; ASCII character matching is also excluded.
        expect(getUnicodeTargetsForSearchTerm('o')).toEqual([]);
        expect(glyphMatchesSearchTerms(letterO, ['o'])).toBe(false);

        // "a" can still accidentally match as bare hex containing "a" (e.g. U+000A).
        expect(getUnicodeTargetsForSearchTerm('a')).toEqual([]);
        expect(glyphMatchesSearchTerms(letterA, ['a'])).toBe(false);
        expect(
            glyphMatchesSearchTerms({ name: 'x', codepoints: [0xa] }, ['a'])
        ).toBe(true);
    });

    test('ranks exact name, unicode, prefix, then shorter coverage', () => {
        const glyphs = [
            { name: 'copyright', codepoints: [0xa9] },
            { name: 'odot', codepoints: [0x2299] },
            { name: 'o', codepoints: [0x6f] },
            { name: 'adieresis', codepoints: [0xe4] },
            { name: 'oe', codepoints: [0x153] }
        ];

        const byO = [...glyphs]
            .filter((glyph) => glyphMatchesSearchTerms(glyph, ['o']))
            .sort((left, right) =>
                compareGlyphsBySearchRelevance(left, right, ['o'], ['o'])
            )
            .map((glyph) => glyph.name);

        expect(byO).toEqual(['o', 'oe', 'odot', 'copyright']);

        const byADiaeresis = [...glyphs]
            .filter((glyph) => glyphMatchesSearchTerms(glyph, ['ä']))
            .sort((left, right) =>
                compareGlyphsBySearchRelevance(left, right, ['ä'], ['ä'])
            )
            .map((glyph) => glyph.name);

        expect(byADiaeresis).toEqual(['adieresis']);

        const byHex = [...glyphs]
            .filter((glyph) => glyphMatchesSearchTerms(glyph, ['00e4']))
            .sort((left, right) =>
                compareGlyphsBySearchRelevance(left, right, ['00e4'], ['00e4'])
            )
            .map((glyph) => glyph.name);

        expect(byHex).toEqual(['adieresis']);
    });

    test('keeps partial hex matches below name prefixes', () => {
        const glyphs = [
            { name: 'J', codepoints: [0x4a] },
            { name: 'a.ss01', codepoints: [] },
            { name: 'yen', codepoints: [0xa5] },
            { name: 'a', codepoints: [0x61] },
            { name: 'z', codepoints: [0x7a] }
        ];

        const byA = [...glyphs]
            .filter((glyph) => glyphMatchesSearchTerms(glyph, ['a']))
            .sort((left, right) =>
                compareGlyphsBySearchRelevance(left, right, ['a'], ['a'])
            )
            .map((glyph) => glyph.name);

        expect(byA).toEqual(['a', 'a.ss01', 'J', 'z', 'yen']);
    });

    test('prefers the Unicode character case that was typed', () => {
        const glyphs = [
            { name: 'Adieresis', codepoints: [0xc4] },
            { name: 'adieresis', codepoints: [0xe4] }
        ];

        expect(countUnicodeCharacterCaseMismatches([0xe4], ['ä'])).toBe(0);
        expect(countUnicodeCharacterCaseMismatches([0xc4], ['ä'])).toBe(1);
        expect(countUnicodeCharacterCaseMismatches([0xc4], ['Ä'])).toBe(0);
        expect(countUnicodeCharacterCaseMismatches([0xe4], ['Ä'])).toBe(1);

        const byLower = [...glyphs]
            .filter((glyph) => glyphMatchesSearchTerms(glyph, ['ä']))
            .sort((left, right) =>
                compareGlyphsBySearchRelevance(left, right, ['ä'], ['ä'])
            )
            .map((glyph) => glyph.name);
        expect(byLower).toEqual(['adieresis', 'Adieresis']);

        const byUpper = [...glyphs]
            .filter((glyph) => glyphMatchesSearchTerms(glyph, ['ä']))
            .sort((left, right) =>
                compareGlyphsBySearchRelevance(left, right, ['ä'], ['Ä'])
            )
            .map((glyph) => glyph.name);
        expect(byUpper).toEqual(['Adieresis', 'adieresis']);
    });

    test('deprioritizes opposite-case matches behind all same-case hits', () => {
        expect(countGlyphSearchCaseMismatches('o', ['o'])).toBe(0);
        expect(countGlyphSearchCaseMismatches('O', ['o'])).toBe(1);
        expect(countGlyphSearchCaseMismatches('O', ['O'])).toBe(0);

        const glyphs = [
            { name: 'O', codepoints: [0x4f] },
            { name: 'o', codepoints: [0x6f] },
            { name: 'oe', codepoints: [0x153] },
            { name: 'odot', codepoints: [0x2299] }
        ];

        const byLowerO = [...glyphs]
            .filter((glyph) => glyphMatchesSearchTerms(glyph, ['o']))
            .sort((left, right) =>
                compareGlyphsBySearchRelevance(left, right, ['o'], ['o'])
            )
            .map((glyph) => glyph.name);

        expect(byLowerO).toEqual(['o', 'oe', 'odot', 'O']);

        const byUpperO = [...glyphs]
            .filter((glyph) => glyphMatchesSearchTerms(glyph, ['o']))
            .sort((left, right) =>
                compareGlyphsBySearchRelevance(left, right, ['o'], ['O'])
            )
            .map((glyph) => glyph.name);

        expect(byUpperO).toEqual(['O', 'o', 'oe', 'odot']);
    });
});
