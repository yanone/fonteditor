/**
 * Convert a glyph search query into normalized, space-separated search terms.
 */
export function parseGlyphSearchTerms(query: string): string[] {
    return query
        .trim()
        .split(/\s+/)
        .filter((term) => term.length > 0)
        .map((term) => term.toLowerCase());
}

/**
 * Return whether a glyph name contains every normalized search term.
 */
export function glyphNameMatchesSearchTerms(
    glyphName: string,
    searchTerms: readonly string[]
): boolean {
    const normalizedGlyphName = glyphName.toLowerCase();
    return searchTerms.every((term) => normalizedGlyphName.includes(term));
}
