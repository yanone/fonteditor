export type ScriptDocumentKind = 'general-script' | 'glyph-filter';

export type PythonDocumentKindInfo = {
    kind: ScriptDocumentKind | null;
    editorKind: ScriptDocumentKind;
    confidence: 'saved-path' | 'content-inferred' | 'unclassified-unsaved';
    message: string;
};

export function getPythonDocumentKindInfo(state: {
    kind?: string;
    path?: string | null;
    content?: string;
    isModified?: boolean;
}): PythonDocumentKindInfo {
    const editorKind: ScriptDocumentKind =
        state.kind === 'glyph-filter' ? 'glyph-filter' : 'general-script';
    if (state.path && !state.isModified) {
        return {
            kind: editorKind,
            editorKind,
            confidence: 'saved-path',
            message: `Document kind is authoritative from saved path ${state.path}.`
        };
    }

    const hasFilterFunction =
        /^\s*def\s+filter_glyphs\s*\(\s*font\s*\)\s*:/m.test(
            state.content || ''
        );
    if (hasFilterFunction) {
        return {
            kind: 'glyph-filter',
            editorKind,
            confidence: 'content-inferred',
            message: state.path
                ? 'This buffer has unsaved edits and defines filter_glyphs(font), so it is treated as a Glyph Overview filter until saved.'
                : 'Unsaved buffer has no saved Counterpunch/Filters path yet, but it defines filter_glyphs(font), so it is treated as a Glyph Overview filter.'
        };
    }
    return {
        kind: null,
        editorKind,
        confidence: 'unclassified-unsaved',
        message: state.path
            ? 'This buffer has unsaved edits and no longer defines filter_glyphs(font), so it is not treated as a Glyph Overview filter until saved.'
            : 'Unsaved buffer has no saved Counterpunch/Filters path and does not define filter_glyphs(font), so it is not treated as a Glyph Overview filter.'
    };
}
