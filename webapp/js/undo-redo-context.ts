export type UndoRedoContext = {
    rootGlyphName: string | undefined;
    undoGlyphName: string | undefined;
    undoLayerId: string | null;
    historyTargetKey: string | null;
};

function isFontInfoViewFocused(): boolean {
    return (
        document
            .querySelector('#view-fontinfo')
            ?.classList.contains('focused') ?? false
    );
}

function isFontInfoFeaturesTabVisible(): boolean {
    const featuresTab = document.getElementById('fontinfo-features-content');
    if (!featuresTab) {
        return false;
    }

    return featuresTab.style.display !== 'none';
}

export function getUndoRedoContext(): UndoRedoContext {
    const oe = window.glyphCanvas?.outlineEditor;
    const parsedStack = oe?.active ? oe.parseGlyphStack() : [];
    const currentGlyphName =
        oe?.currentGlyphName ?? window.glyphCanvas?.getCurrentGlyphName?.();
    const rootGlyphName = parsedStack[0]?.glyphName ?? currentGlyphName;
    const fallbackUndoGlyphName =
        parsedStack[parsedStack.length - 1]?.glyphName ?? currentGlyphName;
    const fallbackUndoLayerId = oe?.selectedLayerId ?? null;
    const historyContext = window.getHistoryUndoContext?.();
    const fontInfoFocused = isFontInfoViewFocused();
    const featuresTabVisible = isFontInfoFeaturesTabVisible();

    if (fontInfoFocused && historyContext?.scope === 'feature') {
        return {
            rootGlyphName,
            undoGlyphName: undefined,
            undoLayerId: null,
            historyTargetKey: historyContext.historyTargetKey
        };
    }

    if (fontInfoFocused && !featuresTabVisible) {
        return {
            rootGlyphName,
            undoGlyphName: undefined,
            undoLayerId: null,
            historyTargetKey: null
        };
    }

    if (oe?.active && fallbackUndoGlyphName && fallbackUndoLayerId) {
        return {
            rootGlyphName,
            undoGlyphName: fallbackUndoGlyphName,
            undoLayerId: fallbackUndoLayerId,
            historyTargetKey: null
        };
    }

    if (!historyContext) {
        return {
            rootGlyphName,
            undoGlyphName: fallbackUndoGlyphName,
            undoLayerId: fallbackUndoLayerId,
            historyTargetKey: null
        };
    }

    if (historyContext.scope === 'font') {
        return {
            rootGlyphName,
            undoGlyphName: undefined,
            undoLayerId: null,
            historyTargetKey: null
        };
    }

    if (historyContext.scope === 'feature') {
        return {
            rootGlyphName,
            undoGlyphName: undefined,
            undoLayerId: null,
            historyTargetKey: historyContext.historyTargetKey
        };
    }

    if (historyContext.scope === 'glyph') {
        return {
            rootGlyphName:
                rootGlyphName ?? historyContext.glyphName ?? undefined,
            undoGlyphName: historyContext.glyphName ?? fallbackUndoGlyphName,
            undoLayerId: null,
            historyTargetKey: null
        };
    }

    return {
        rootGlyphName: rootGlyphName ?? historyContext.glyphName ?? undefined,
        undoGlyphName: historyContext.glyphName ?? fallbackUndoGlyphName,
        undoLayerId: historyContext.layerId ?? fallbackUndoLayerId,
        historyTargetKey: null
    };
}

window.getUndoRedoContext = getUndoRedoContext;
