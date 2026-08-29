const {
    applyLineLayoutToGlyphs,
    computeEmLineHeightUnit,
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

    test('100 percent line height is one em', () => {
        expect(computeEmLineHeightUnit(1000)).toBe(1000);
        expect(computeEmLineHeightUnit(2048)).toBe(2048);
        expect(computeEmLineHeightUnit(0)).toBe(1000);
        expect(computeEmLineHeightUnit(undefined)).toBe(1000);
        expect(computeUsedLineHeight(1000, 100)).toBe(1000);
        expect(computeUsedLineHeight(1000, 120)).toBe(1200);
        expect(lineBaselineY(1, 1000)).toBe(-1000);
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
