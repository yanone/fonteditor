/**
 * Update live editor UI after glyphs are deleted.
 *
 * Text buffer contents are left intact so typed/encoded characters whose
 * glyphs were deleted continue to shape as .notdef. If glyph-edit mode is
 * focused on a deleted glyph, exit back to text mode.
 */

function segmentGlyphName(segment: string): string | null {
    let rest = segment;
    const colonIndex = segment.indexOf(':');
    if (colonIndex > 0 && !segment.slice(0, colonIndex).includes('@')) {
        rest = segment.slice(colonIndex + 1);
    }
    const atIndex = rest.lastIndexOf('@');
    if (atIndex <= 0) {
        return null;
    }
    return rest.slice(0, atIndex);
}

/** True when any glyph_stack segment names a deleted glyph. */
export function glyphStackReferencesDeletedGlyph(
    stack: string,
    deletedNames: ReadonlySet<string>
): boolean {
    if (!stack || deletedNames.size === 0) {
        return false;
    }
    return stack.split('>').some((segment) => {
        const glyphName = segmentGlyphName(segment);
        return !!glyphName && deletedNames.has(glyphName);
    });
}

export function applyGlyphDeleteUiContext(
    deletedNames: ReadonlySet<string>,
    _codepointsByDeletedName: ReadonlyMap<string, readonly number[]>
): void {
    if (deletedNames.size === 0) {
        return;
    }

    const canvas = window.glyphCanvas;
    const outlineEditor = canvas?.outlineEditor;
    const editingDeletedGlyph =
        !!outlineEditor?.active &&
        (deletedNames.has(outlineEditor.currentGlyphName || '') ||
            glyphStackReferencesDeletedGlyph(
                outlineEditor.glyphStack || '',
                deletedNames
            ));

    if (
        editingDeletedGlyph &&
        typeof canvas?.exitGlyphEditMode === 'function'
    ) {
        canvas.exitGlyphEditMode();
    }

    // Keep the text buffer unchanged so missing glyphs render as .notdef.
    const textRun = canvas?.textRunEditor;
    if (textRun) {
        textRun.shapeText?.();
        textRun.call?.('textchanged');
    }

    if (!outlineEditor) {
        return;
    }

    if (
        glyphStackReferencesDeletedGlyph(
            outlineEditor.glyphStack || '',
            deletedNames
        )
    ) {
        outlineEditor.glyphStack = '';
        if (window.stateManager) {
            window.stateManager.editor_glyph_stack = '';
        }
        window.dispatchEvent(
            new CustomEvent('glyphStackChanged', {
                detail: { glyphStack: '' }
            })
        );
    }

    if (typeof canvas?.doUIUpdateAsync === 'function') {
        void canvas.doUIUpdateAsync();
    } else {
        canvas?.doUIUpdate?.();
    }
}
