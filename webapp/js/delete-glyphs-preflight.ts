/**
 * Pure helpers for glyph-deletion preflight and feature-code cleanup.
 * Font.preflightDeleteGlyphs / Font.deleteGlyphs own font access.
 *
 * Feature/prefix cleanup is intentionally NOT a FEA parser: it comments out
 * individual source lines that contain deleted glyph-name tokens. That keeps
 * `feature tag { ... }` wrappers intact (unlike `;`-statement deletion).
 */

export type GlyphDeletePreflight = {
    /** Glyph-name tokens in features, classes, and prefixes. */
    featureReferences: number;
    /** Metrics keys that resolve to a deleted glyph. */
    metricsKeyReferences: number;
    /** Component instances on surviving glyphs that reference a deleted glyph. */
    componentReferences: number;
};

const FEA_TOKEN_RE = /#[^\n]*|@[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+/g;
const DELETED_GLYPH_COMMENT_MARKER = '[deleted glyph]';

/**
 * Strip # comments and "..." / '...' strings so brace/`featureNames`
 * detection is not confused by descriptive text.
 */
function stripFeaCommentsAndStrings(line: string): string {
    let result = '';
    let index = 0;
    while (index < line.length) {
        const char = line[index];
        if (char === '#') {
            break;
        }
        if (char === '"' || char === "'") {
            const quote = char;
            index += 1;
            while (index < line.length && line[index] !== quote) {
                if (line[index] === '\\') {
                    index += 2;
                    continue;
                }
                index += 1;
            }
            index += 1;
            result += ' ';
            continue;
        }
        result += char;
        index += 1;
    }
    return result;
}

type FeatureNamesScanState = {
    depth: number;
    pending: boolean;
};

function createFeatureNamesScanState(): FeatureNamesScanState {
    return { depth: 0, pending: false };
}

/**
 * Advance featureNames-section tracking for one source line.
 * Returns whether this line is inside (or entering) a featureNames block.
 */
function consumeFeatureNamesLine(
    line: string,
    state: FeatureNamesScanState
): boolean {
    const stripped = stripFeaCommentsAndStrings(line);
    const wasInside = state.depth > 0 || state.pending;

    if (!wasInside && /\bfeatureNames\b/.test(stripped)) {
        state.pending = true;
    }

    const inside = state.depth > 0 || state.pending;
    if (!inside) {
        return false;
    }

    for (const char of stripped) {
        if (char === '{') {
            state.depth += 1;
            state.pending = false;
        } else if (char === '}') {
            state.depth = Math.max(0, state.depth - 1);
        }
    }

    return wasInside || inside;
}

function forEachDeletedGlyphToken(
    code: string,
    deletedNames: ReadonlySet<string>,
    onMatch: () => void
): void {
    code.replace(FEA_TOKEN_RE, (token) => {
        if (
            !token.startsWith('#') &&
            !token.startsWith('@') &&
            deletedNames.has(token)
        ) {
            onMatch();
        }
        return token;
    });
}

/**
 * Walk feature/prefix code line-by-line, skipping featureNames { } sections
 * (name/description blocks, not glyph rules).
 */
function forEachFeatureCodeLineOutsideFeatureNames(
    code: string,
    onLine: (line: string, insideFeatureNames: boolean) => void
): void {
    const state = createFeatureNamesScanState();
    for (const line of code.split('\n')) {
        const insideFeatureNames = consumeFeatureNamesLine(line, state);
        onLine(line, insideFeatureNames);
    }
}

/** Count glyph-name tokens (not comments or @classes) that match deleted names. */
export function countDeletedGlyphTokensInFeatureCode(
    code: string,
    deletedNames: ReadonlySet<string>
): number {
    let count = 0;
    forEachFeatureCodeLineOutsideFeatureNames(
        code,
        (line, insideFeatureNames) => {
            if (insideFeatureNames) {
                return;
            }
            forEachDeletedGlyphToken(line, deletedNames, () => {
                count += 1;
            });
        }
    );
    return count;
}

export function featureCodeReferencesDeletedGlyph(
    code: string,
    deletedNames: ReadonlySet<string>
): boolean {
    let found = false;
    forEachDeletedGlyphToken(code, deletedNames, () => {
        found = true;
    });
    return found;
}

/**
 * Remove deleted glyph-name tokens from class source (space-separated lists).
 * Preserves comments and @class references; collapses leftover whitespace.
 */
export function stripDeletedGlyphTokensFromClassCode(
    code: string,
    deletedNames: ReadonlySet<string>
): string {
    const stripped = code.replace(FEA_TOKEN_RE, (token) => {
        if (
            !token.startsWith('#') &&
            !token.startsWith('@') &&
            deletedNames.has(token)
        ) {
            return '';
        }
        return token;
    });
    return stripped
        .split('\n')
        .map((line) =>
            line
                .replace(/[ \t]{2,}/g, ' ')
                .replace(/^[ \t]+/, '')
                .replace(/[ \t]+$/g, '')
        )
        .join('\n');
}

/**
 * @deprecated Use stripDeletedGlyphTokensFromClassCode or
 * commentOutFeatureLinesReferencingDeletedGlyphs.
 */
export function stripDeletedGlyphTokensFromFeatureCode(
    code: string,
    deletedNames: ReadonlySet<string>
): string {
    return stripDeletedGlyphTokensFromClassCode(code, deletedNames);
}

/**
 * Comment out feature/prefix source lines that reference deleted glyphs.
 * Line-based (not `;`-statement-based) so `feature tag {` headers stay intact.
 * Skips `featureNames { }` sections (localized names/descriptions).
 */
export function commentOutFeatureLinesReferencingDeletedGlyphs(
    code: string,
    deletedNames: ReadonlySet<string>
): string {
    if (!code || deletedNames.size === 0) {
        return code;
    }

    const lines: string[] = [];
    forEachFeatureCodeLineOutsideFeatureNames(
        code,
        (line, insideFeatureNames) => {
            if (insideFeatureNames) {
                lines.push(line);
                return;
            }

            const leading = line.match(/^\s*/)?.[0] ?? '';
            const body = line.slice(leading.length);
            if (!body || body.startsWith('#')) {
                lines.push(line);
                return;
            }
            if (!featureCodeReferencesDeletedGlyph(body, deletedNames)) {
                lines.push(line);
                return;
            }
            if (body.includes(DELETED_GLYPH_COMMENT_MARKER)) {
                lines.push(line);
                return;
            }
            lines.push(`${leading}# ${DELETED_GLYPH_COMMENT_MARKER} ${body}`);
        }
    );
    return lines.join('\n');
}
