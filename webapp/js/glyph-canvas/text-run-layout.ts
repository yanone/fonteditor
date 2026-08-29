/** Line layout helpers for multiline text runs. */

export const DEFAULT_LINE_HEIGHT_PERCENT = 100;
export const DEFAULT_TEXT_ALIGN = 'left' as const;

export type TextAlign = 'left' | 'center' | 'right';

export type TextLineRange = {
    lineIndex: number;
    start: number;
    end: number;
    newlineIndex: number | null;
};

export type ShapedGlyphLayoutFields = {
    ax?: number;
    dx?: number;
    dy?: number;
    lineIndex?: number;
    lineOriginX?: number;
    baselineY?: number;
};

export type GlyphWorldPosition = {
    xPosition: number;
    xOffset: number;
    yOffset: number;
    baselineY: number;
    lineIndex: number;
};

export function isTextAlign(value: unknown): value is TextAlign {
    return value === 'left' || value === 'center' || value === 'right';
}

export function parseLineHeightPercent(value: unknown): number | null {
    const numeric =
        typeof value === 'number' ? value : Number.parseFloat(String(value));
    if (!Number.isFinite(numeric)) {
        return null;
    }
    return numeric;
}

export function normalizeTextNewlines(text: string): string {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function splitTextLines(text: string): TextLineRange[] {
    const lines: TextLineRange[] = [];
    let start = 0;
    let lineIndex = 0;

    for (let i = 0; i <= text.length; i++) {
        if (i === text.length || text[i] === '\n') {
            lines.push({
                lineIndex,
                start,
                end: i,
                newlineIndex: i < text.length ? i : null
            });
            lineIndex += 1;
            start = i + 1;
        }
    }

    if (lines.length === 0) {
        lines.push({
            lineIndex: 0,
            start: 0,
            end: 0,
            newlineIndex: null
        });
    }

    return lines;
}

export function lineRangeAt(text: string, position: number): TextLineRange {
    const lines = splitTextLines(text);
    const clamped = Math.max(0, Math.min(position, text.length));
    for (const line of lines) {
        const lineEnd =
            line.newlineIndex !== null ? line.newlineIndex : line.end;
        if (clamped <= lineEnd) {
            return line;
        }
    }
    return lines[lines.length - 1];
}

export function computeEmLineHeightUnit(upm: unknown): number {
    const numeric =
        typeof upm === 'number' ? upm : Number.parseFloat(String(upm));
    if (Number.isFinite(numeric) && numeric > 0) {
        return numeric;
    }
    return 1000;
}

export function computeUsedLineHeight(unit: number, percent: number): number {
    if (!Number.isFinite(unit) || !Number.isFinite(percent)) {
        return 0;
    }
    return unit * (percent / 100);
}

export function lineOriginX(
    align: TextAlign,
    lineWidth: number,
    maxWidth: number
): number {
    if (align === 'center') {
        return (maxWidth - lineWidth) / 2;
    }
    if (align === 'right') {
        return maxWidth - lineWidth;
    }
    return 0;
}

export function lineBaselineY(
    lineIndex: number,
    usedLineHeight: number
): number {
    return -lineIndex * usedLineHeight;
}

export function applyLineLayoutToGlyphs<T extends ShapedGlyphLayoutFields>(
    glyphs: T[],
    lineCount: number,
    usedLineHeight: number,
    align: TextAlign
): void {
    const widths = new Array(lineCount).fill(0);
    for (const glyph of glyphs) {
        const lineIndex = glyph.lineIndex ?? 0;
        if (lineIndex < 0 || lineIndex >= lineCount) {
            continue;
        }
        widths[lineIndex] += glyph.ax || 0;
    }

    const maxWidth = widths.reduce((max, width) => Math.max(max, width), 0);

    for (const glyph of glyphs) {
        const lineIndex = glyph.lineIndex ?? 0;
        glyph.baselineY = lineBaselineY(lineIndex, usedLineHeight);
        glyph.lineOriginX = lineOriginX(
            align,
            widths[lineIndex] ?? 0,
            maxWidth
        );
    }
}

export function getShapedGlyphPosition(
    shapedGlyphs: ShapedGlyphLayoutFields[] | null | undefined,
    glyphIndex: number
): GlyphWorldPosition {
    if (!Array.isArray(shapedGlyphs) || shapedGlyphs.length === 0) {
        return {
            xPosition: 0,
            xOffset: 0,
            yOffset: 0,
            baselineY: 0,
            lineIndex: 0
        };
    }

    const safeGlyphIndex = Math.max(0, glyphIndex);
    const glyph =
        shapedGlyphs[Math.min(safeGlyphIndex, shapedGlyphs.length - 1)];
    const lineIndex = glyph?.lineIndex ?? 0;
    const lineOriginXValue = glyph?.lineOriginX ?? 0;
    const baselineY = glyph?.baselineY ?? 0;
    const maxAdvanceIndex = Math.min(safeGlyphIndex, shapedGlyphs.length);
    let xPosition = lineOriginXValue;

    for (let i = 0; i < maxAdvanceIndex; i++) {
        const previousGlyph = shapedGlyphs[i];
        if ((previousGlyph?.lineIndex ?? 0) !== lineIndex) {
            continue;
        }
        xPosition += previousGlyph?.ax || 0;
    }

    return {
        xPosition,
        xOffset: glyph?.dx || 0,
        yOffset: (glyph?.dy || 0) + baselineY,
        baselineY,
        lineIndex
    };
}

export function findLineIndexForFontY(
    glyphY: number,
    lineCount: number,
    usedLineHeight: number
): number {
    if (lineCount <= 1) {
        return 0;
    }
    if (!(usedLineHeight > 0)) {
        return 0;
    }

    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < lineCount; i++) {
        const distance = Math.abs(glyphY - lineBaselineY(i, usedLineHeight));
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = i;
        }
    }
    return bestIndex;
}
