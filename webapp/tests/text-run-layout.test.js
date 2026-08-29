const {
    applyLineLayoutToGlyphs,
    computeTypoLineHeightUnit,
    computeUsedLineHeight,
    getShapedGlyphPosition,
    lineBaselineY,
    lineOriginX,
    lineRangeAt,
    splitTextLines
} = require('../js/glyph-canvas/text-run-layout');

describe('text-run-layout', () => {
    test('splits on newlines including a trailing empty line', () => {
        const lines = splitTextLines('ab\ncd\n');
        expect(
            lines.map((line) => [line.start, line.end, line.newlineIndex])
        ).toEqual([
            [0, 2, 2],
            [3, 5, 5],
            [6, 6, null]
        ]);
    });

    test('typo stack is ascender plus abs descender plus line gap', () => {
        expect(
            computeTypoLineHeightUnit({
                TypoAscender: 800,
                TypoDescender: -200,
                TypoLineGap: 50
            })
        ).toBe(1050);
        expect(computeUsedLineHeight(1050, 120)).toBe(1260);
        expect(lineBaselineY(1, 1260)).toBe(-1260);
    });

    test('falls back to Ascender/Descender when typo metrics are missing', () => {
        expect(
            computeTypoLineHeightUnit({
                Ascender: 700,
                Descender: -250
            })
        ).toBe(950);
    });

    test('aligns lines to the longest width', () => {
        expect(lineOriginX('left', 100, 200)).toBe(0);
        expect(lineOriginX('center', 100, 200)).toBe(50);
        expect(lineOriginX('right', 100, 200)).toBe(100);
    });

    test('positions a second-line glyph without summing the first line', () => {
        const glyphs = [
            { ax: 400, dx: 0, dy: 0, lineIndex: 0 },
            { ax: 300, dx: 0, dy: 10, lineIndex: 1 }
        ];
        applyLineLayoutToGlyphs(glyphs, 2, 1000, 'left');
        expect(glyphs[1].baselineY).toBe(-1000);
        const position = getShapedGlyphPosition(glyphs, 1);
        expect(position.xPosition).toBe(0);
        expect(position.yOffset).toBe(-990);
    });

    test('caret after a newline belongs to the following line', () => {
        expect(lineRangeAt('HA\n', 2).lineIndex).toBe(0);
        expect(lineRangeAt('HA\n', 3).lineIndex).toBe(1);
        expect(lineRangeAt('HA\nHB', 3).lineIndex).toBe(1);
    });
});
