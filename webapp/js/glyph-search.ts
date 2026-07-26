/**
 * Split a glyph search query into space-separated terms, preserving case.
 */
export function parseGlyphSearchTermsPreserveCase(query: string): string[] {
    return query
        .trim()
        .split(/\s+/)
        .filter((term) => term.length > 0);
}

/**
 * Convert a glyph search query into normalized, space-separated search terms.
 */
export function parseGlyphSearchTerms(query: string): string[] {
    return parseGlyphSearchTermsPreserveCase(query).map((term) =>
        term.toLowerCase()
    );
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

/** Glyph fields used by Find Glyph dialog search. */
export interface GlyphSearchTarget {
    name: string;
    codepoints?: readonly number[];
}

const ASCII_MAX = 0x7f;

/**
 * Parse a hex Unicode term into a codepoint, or null if not hex.
 * Bare hex is the primary form; optional U+/0x prefixes are accepted.
 */
export function parseHexUnicodeTerm(term: string): number | null {
    const normalized = term.trim().toLowerCase();
    if (!normalized) {
        return null;
    }

    let hex = normalized;
    if (hex.startsWith('u+')) {
        hex = hex.slice(2);
    } else if (hex.startsWith('0x')) {
        hex = hex.slice(2);
    }

    if (!hex.length || !/^[0-9a-f]+$/.test(hex)) {
        return null;
    }

    const codepoint = Number.parseInt(hex, 16);
    if (!Number.isInteger(codepoint) || codepoint < 0 || codepoint > 0x10ffff) {
        return null;
    }

    return codepoint;
}

/**
 * Return non-ASCII character codepoints implied by a term, including
 * simple upper/lower case variants. ASCII characters never contribute.
 */
export function getNonAsciiCharacterCodepoints(term: string): number[] {
    const characters = Array.from(term);
    if (characters.length !== 1) {
        return [];
    }

    const codepoint = characters[0].codePointAt(0);
    if (codepoint === undefined || codepoint <= ASCII_MAX) {
        return [];
    }

    const targets = new Set<number>([codepoint]);
    const character = String.fromCodePoint(codepoint);
    for (const cased of [character.toLowerCase(), character.toUpperCase()]) {
        const casedPoints = Array.from(cased).map((unit) =>
            unit.codePointAt(0)!
        );
        if (casedPoints.length === 1 && casedPoints[0] > ASCII_MAX) {
            targets.add(casedPoints[0]);
        }
    }

    return Array.from(targets);
}

/**
 * Unicode codepoints a search term can match via character or hex forms.
 */
export function getUnicodeTargetsForSearchTerm(term: string): number[] {
    const targets = new Set<number>(getNonAsciiCharacterCodepoints(term));
    const hex = parseHexUnicodeTerm(term);
    if (hex !== null) {
        targets.add(hex);
    }
    return Array.from(targets);
}

function glyphHasAnyCodepoint(
    codepoints: readonly number[] | undefined,
    targets: readonly number[]
): boolean {
    if (!codepoints?.length || !targets.length) {
        return false;
    }

    return targets.some((target) => codepoints.includes(target));
}

/**
 * Return whether one search term matches a glyph by name or Unicode.
 */
export function glyphMatchesSearchTerm(
    glyph: GlyphSearchTarget,
    term: string
): boolean {
    if (glyph.name.toLowerCase().includes(term)) {
        return true;
    }

    return glyphHasAnyCodepoint(
        glyph.codepoints,
        getUnicodeTargetsForSearchTerm(term)
    );
}

/**
 * Return whether a glyph matches every Find Glyph search term (AND).
 * Each term may match via name substring or Unicode (non-ASCII char / hex).
 */
export function glyphMatchesSearchTerms(
    glyph: GlyphSearchTarget,
    searchTerms: readonly string[]
): boolean {
    if (!searchTerms.length) {
        return true;
    }

    return searchTerms.every((term) => glyphMatchesSearchTerm(glyph, term));
}

enum GlyphSearchMatchTier {
    ExactName = 0,
    ExactUnicode = 1,
    NamePrefix = 2,
    NameSubstring = 3,
    UnicodeOnly = 4
}

interface GlyphSearchRelevance {
    tier: GlyphSearchMatchTier;
    coverage: number;
    matchIndex: number;
    caseMismatch: number;
    nameLength: number;
    normalizedName: string;
}

/**
 * Count case mismatches between the typed terms and the glyph name at each
 * case-insensitive match site. Lower is better; 0 is a fully case-sensitive hit.
 */
export function countGlyphSearchCaseMismatches(
    glyphName: string,
    casePreservedTerms: readonly string[]
): number {
    if (!casePreservedTerms.length) {
        return 0;
    }

    const normalizedName = glyphName.toLowerCase();
    let mismatches = 0;

    for (const term of casePreservedTerms) {
        const normalizedTerm = term.toLowerCase();
        const index = normalizedName.indexOf(normalizedTerm);
        if (index < 0) {
            continue;
        }

        const slice = glyphName.slice(index, index + term.length);
        if (slice !== term) {
            mismatches += 1;
        }
    }

    return mismatches;
}

function earliestNameMatchIndex(
    normalizedName: string,
    searchTerms: readonly string[]
): number {
    let earliest = Number.POSITIVE_INFINITY;
    for (const term of searchTerms) {
        const index = normalizedName.indexOf(term);
        if (index >= 0 && index < earliest) {
            earliest = index;
        }
    }
    return earliest;
}

function nameCoverage(
    normalizedName: string,
    searchTerms: readonly string[]
): number {
    if (!normalizedName.length || !searchTerms.length) {
        return 0;
    }

    const matchedLength = searchTerms.reduce(
        (total, term) =>
            normalizedName.includes(term) ? total + term.length : total,
        0
    );
    return matchedLength / normalizedName.length;
}

/**
 * Score a glyph for Find Glyph dialog ranking under the active search terms.
 */
export function getGlyphSearchRelevance(
    glyph: GlyphSearchTarget,
    searchTerms: readonly string[],
    casePreservedTerms: readonly string[] = searchTerms
): GlyphSearchRelevance {
    const normalizedName = glyph.name.toLowerCase();
    const nameLength = normalizedName.length;
    const joinedTerms = searchTerms.join('');
    const spacedTerms = searchTerms.join(' ');
    const caseMismatch = countGlyphSearchCaseMismatches(
        glyph.name,
        casePreservedTerms
    );
    const base = {
        caseMismatch,
        nameLength,
        normalizedName
    };

    if (
        searchTerms.length > 0 &&
        (normalizedName === joinedTerms || normalizedName === spacedTerms)
    ) {
        return {
            ...base,
            tier: GlyphSearchMatchTier.ExactName,
            coverage: 1,
            matchIndex: 0
        };
    }

    const allTermsInName = searchTerms.every((term) =>
        normalizedName.includes(term)
    );
    const unicodeTargets = searchTerms.flatMap((term) =>
        getUnicodeTargetsForSearchTerm(term)
    );
    const hasUnicodeMatch = glyphHasAnyCodepoint(
        glyph.codepoints,
        unicodeTargets
    );

    // Prefer Unicode identity when the name itself does not already explain
    // the match (e.g. typing "ä" or "00e4" for adieresis).
    if (hasUnicodeMatch && !allTermsInName) {
        return {
            ...base,
            tier: GlyphSearchMatchTier.ExactUnicode,
            coverage: 1,
            matchIndex: Number.POSITIVE_INFINITY
        };
    }

    const isPrefix =
        searchTerms.length > 0 &&
        (normalizedName.startsWith(joinedTerms) ||
            normalizedName.startsWith(searchTerms[0]));

    if (allTermsInName && isPrefix) {
        return {
            ...base,
            tier: GlyphSearchMatchTier.NamePrefix,
            coverage: nameCoverage(normalizedName, searchTerms),
            matchIndex: 0
        };
    }

    if (allTermsInName) {
        return {
            ...base,
            tier: GlyphSearchMatchTier.NameSubstring,
            coverage: nameCoverage(normalizedName, searchTerms),
            matchIndex: earliestNameMatchIndex(normalizedName, searchTerms)
        };
    }

    return {
        ...base,
        tier: GlyphSearchMatchTier.UnicodeOnly,
        coverage: hasUnicodeMatch ? 1 : 0,
        matchIndex: Number.POSITIVE_INFINITY
    };
}

/**
 * Compare glyphs for Find Glyph dialog search ranking (ascending = better).
 * Correct casing for the typed query is required before any other relevance
 * signal, so opposite-case hits sort after every same-case match. Alphabetical
 * lowercased name is the final tiebreak.
 */
export function compareGlyphsBySearchRelevance(
    left: GlyphSearchTarget,
    right: GlyphSearchTarget,
    searchTerms: readonly string[],
    casePreservedTerms: readonly string[] = searchTerms
): number {
    const leftScore = getGlyphSearchRelevance(
        left,
        searchTerms,
        casePreservedTerms
    );
    const rightScore = getGlyphSearchRelevance(
        right,
        searchTerms,
        casePreservedTerms
    );

    if (leftScore.caseMismatch !== rightScore.caseMismatch) {
        return leftScore.caseMismatch - rightScore.caseMismatch;
    }
    if (leftScore.tier !== rightScore.tier) {
        return leftScore.tier - rightScore.tier;
    }
    if (leftScore.coverage !== rightScore.coverage) {
        return rightScore.coverage - leftScore.coverage;
    }
    if (leftScore.matchIndex !== rightScore.matchIndex) {
        return leftScore.matchIndex - rightScore.matchIndex;
    }
    if (leftScore.nameLength !== rightScore.nameLength) {
        return leftScore.nameLength - rightScore.nameLength;
    }
    if (leftScore.normalizedName < rightScore.normalizedName) {
        return -1;
    }
    if (leftScore.normalizedName > rightScore.normalizedName) {
        return 1;
    }
    return 0;
}
