const {
    getGlyphRenamePreflightErrors,
    assertGlyphRenamePreflight
} = require('../js/rename-glyphs-preflight');

describe('glyph rename preflight', () => {
    const existing = ['A', 'B', 'C'];

    test('allows a free rename and a swap', () => {
        expect(
            getGlyphRenamePreflightErrors(new Map([['A', 'A.alt']]), existing)
                .size
        ).toBe(0);
        expect(
            getGlyphRenamePreflightErrors(
                new Map([
                    ['A', 'B'],
                    ['B', 'A']
                ]),
                existing
            ).size
        ).toBe(0);
    });

    test('rejects empty targets, collisions, and duplicate targets', () => {
        expect(
            getGlyphRenamePreflightErrors(new Map([['A', '']]), existing).get(
                'A'
            )
        ).toBe('Glyph names cannot be empty.');
        expect(
            getGlyphRenamePreflightErrors(new Map([['A', 'B']]), existing).get(
                'A'
            )
        ).toBe('already exists');
        const dupes = getGlyphRenamePreflightErrors(
            new Map([
                ['A', 'X'],
                ['B', 'X']
            ]),
            existing
        );
        expect(dupes.get('A')).toBe('Duplicates X.');
        expect(dupes.get('B')).toBe('Duplicates X.');
    });

    test('assertGlyphRenamePreflight requires sources and throws the first error', () => {
        expect(() =>
            assertGlyphRenamePreflight(new Map([['Z', 'Z.alt']]), existing)
        ).toThrow(/Cannot rename glyph "Z"/);
        expect(() =>
            assertGlyphRenamePreflight(new Map([['A', 'B']]), existing)
        ).toThrow(/already exists/);
    });
});
