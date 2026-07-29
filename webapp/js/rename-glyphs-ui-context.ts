/**
 * Rewrite editor text-buffer / glyph-stack strings after glyph renames.
 * Pure helpers so Jest can cover encoding without the full canvas.
 */

const WHITESPACE_RE = /\s/;

function isWhitespaceCharacter(char: string): boolean {
    return WHITESPACE_RE.test(char);
}

/**
 * Rewrite raw text-buffer syntax for a simultaneous glyph rename map.
 *
 * - `/oldName` explicit tokens become `/newName` (terminator preserved).
 * - Encoded Unicode characters whose codepoint belonged to a renamed glyph
 *   become `/newName`, with a trailing space when a following encoded
 *   character would otherwise glue onto the token.
 * - `//` literal-slash escapes are left intact.
 */
export function rewriteTextBufferForGlyphRenames(
    text: string,
    renames: ReadonlyMap<string, string>,
    codepointToNewName: ReadonlyMap<number, string>
): string {
    if (!text || (renames.size === 0 && codepointToNewName.size === 0)) {
        return text;
    }

    let result = '';
    let index = 0;
    while (index < text.length) {
        if (
            text[index] === '/' &&
            index + 1 < text.length &&
            text[index + 1] === '/'
        ) {
            result += '//';
            index += 2;
            continue;
        }

        if (text[index] === '/') {
            const nameStart = index + 1;
            let cursor = nameStart;
            while (
                cursor < text.length &&
                text[cursor] !== '/' &&
                !isWhitespaceCharacter(text[cursor])
            ) {
                cursor++;
            }
            const name = text.slice(nameStart, cursor);
            if (name) {
                result += `/${renames.get(name) || name}`;
                index = cursor;
                continue;
            }
            result += '/';
            index += 1;
            continue;
        }

        const codePoint = text.codePointAt(index);
        if (codePoint === undefined) {
            break;
        }
        const charLength = codePoint > 0xffff ? 2 : 1;
        const newName = codepointToNewName.get(codePoint);
        if (newName) {
            result += `/${newName}`;
            index += charLength;
            if (
                index < text.length &&
                text[index] !== '/' &&
                !isWhitespaceCharacter(text[index])
            ) {
                result += ' ';
            }
            continue;
        }

        result += text.slice(index, index + charLength);
        index += charLength;
    }

    return result;
}

/**
 * Rewrite glyph names inside a glyph_stack string.
 * Segments look like `glyph@layer` or `compIndex:glyph@layer`.
 */
export function rewriteGlyphStackForGlyphRenames(
    stack: string,
    renames: ReadonlyMap<string, string>
): string {
    if (!stack || renames.size === 0) {
        return stack;
    }

    return stack
        .split('>')
        .map((segment) => {
            let prefix = '';
            let rest = segment;
            const colonIndex = segment.indexOf(':');
            if (colonIndex > 0 && !segment.slice(0, colonIndex).includes('@')) {
                prefix = segment.slice(0, colonIndex + 1);
                rest = segment.slice(colonIndex + 1);
            }
            const atIndex = rest.lastIndexOf('@');
            if (atIndex <= 0) {
                return segment;
            }
            const glyphName = rest.slice(0, atIndex);
            const layerId = rest.slice(atIndex + 1);
            return `${prefix}${renames.get(glyphName) || glyphName}@${layerId}`;
        })
        .join('>');
}

export function buildCodepointToNewNameMap(
    renames: ReadonlyMap<string, string>,
    codepointsByOldName: ReadonlyMap<string, readonly number[]>
): Map<number, string> {
    const codepointToNewName = new Map<number, string>();
    for (const [oldName, codepoints] of codepointsByOldName) {
        const newName = renames.get(oldName);
        if (!newName || !codepoints?.length) {
            continue;
        }
        for (const codepoint of codepoints) {
            if (Number.isFinite(codepoint)) {
                codepointToNewName.set(codepoint, newName);
            }
        }
    }
    return codepointToNewName;
}

/**
 * Update live editor text buffer + glyph stack after a rename commits.
 */
export function applyGlyphRenameUiContext(
    renames: ReadonlyMap<string, string>,
    codepointsByOldName: ReadonlyMap<string, readonly number[]>
): void {
    if (renames.size === 0) {
        return;
    }

    const codepointToNewName = buildCodepointToNewNameMap(
        renames,
        codepointsByOldName
    );
    const canvas = window.glyphCanvas;
    const textRun = canvas?.textRunEditor;
    if (textRun) {
        const currentText = textRun.textBuffer || '';
        const nextText = rewriteTextBufferForGlyphRenames(
            currentText,
            renames,
            codepointToNewName
        );
        if (nextText !== currentText) {
            textRun.setTextBuffer(nextText);
        } else {
            textRun.shapeText();
            // Keep the editing subset/compile in sync with renamed names even
            // when the raw buffer string did not change.
            textRun.call('textchanged');
        }
    }

    const outlineEditor = canvas?.outlineEditor;
    if (!outlineEditor?.glyphStack) {
        return;
    }

    const nextStack = rewriteGlyphStackForGlyphRenames(
        outlineEditor.glyphStack,
        renames
    );
    if (nextStack === outlineEditor.glyphStack) {
        return;
    }

    outlineEditor.glyphStack = nextStack;
    const parsed = outlineEditor.parseGlyphStack();
    if (parsed.length > 0) {
        outlineEditor.currentGlyphName = parsed[parsed.length - 1].glyphName;
    }
    if (window.stateManager) {
        window.stateManager.editor_glyph_stack = nextStack;
    }
    window.dispatchEvent(
        new CustomEvent('glyphStackChanged', {
            detail: { glyphStack: nextStack }
        })
    );
    outlineEditor.onGlyphSelected?.();
    if (typeof canvas?.doUIUpdateAsync === 'function') {
        void canvas.doUIUpdateAsync();
    } else {
        canvas?.doUIUpdate?.();
    }
}
