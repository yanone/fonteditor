/**
 * Glyph overview type-to-select matching.
 *
 * - One character → match a glyph that encodes that Unicode codepoint
 * - Two or more characters within the 1s timeout window → prefix-match glyph names
 */

export const GLYPH_OVERVIEW_TYPEAHEAD_TIMEOUT_MS = 1000;

export type TypeaheadGlyph = {
    name: string;
    codepoints?: readonly number[] | null;
};

/**
 * Resolve which glyph a typeahead buffer should select.
 * `glyphs` must already be in the desired search order (usually visible overview order).
 */
export function matchGlyphOverviewTypeahead(
    buffer: string,
    glyphs: readonly TypeaheadGlyph[]
): string | null {
    if (!buffer || glyphs.length === 0) {
        return null;
    }

    if (buffer.length === 1) {
        const codepoint = buffer.codePointAt(0);
        if (codepoint === undefined) {
            return null;
        }
        for (const glyph of glyphs) {
            const codepoints = glyph.codepoints;
            if (!codepoints || codepoints.length === 0) {
                continue;
            }
            if (codepoints.includes(codepoint)) {
                return glyph.name;
            }
        }
        return null;
    }

    const prefix = buffer.toLowerCase();
    for (const glyph of glyphs) {
        if (glyph.name.toLowerCase().startsWith(prefix)) {
            return glyph.name;
        }
    }
    return null;
}

/**
 * Append a printable character to the typeahead buffer, respecting the idle timeout.
 */
export function appendGlyphOverviewTypeaheadBuffer(
    previousBuffer: string,
    character: string,
    elapsedMsSinceLastKey: number,
    timeoutMs: number = GLYPH_OVERVIEW_TYPEAHEAD_TIMEOUT_MS
): string {
    if (typeof character !== 'string' || character.length !== 1) {
        return previousBuffer;
    }
    if (
        elapsedMsSinceLastKey < 0 ||
        elapsedMsSinceLastKey > timeoutMs ||
        !previousBuffer
    ) {
        return character;
    }
    return previousBuffer + character;
}
