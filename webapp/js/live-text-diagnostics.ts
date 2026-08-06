interface DiagnosticGlyph {
    index: number;
    name: string | null;
    ax: number;
    dx: number;
    cumulativeX: number;
}

export interface LiveTextDiagnosticEntry {
    sequence: number;
    timestamp: number;
    source: string;
    text: string;
    selectedGlyphIndex: number;
    glyphs: DiagnosticGlyph[];
    totalAdvance: number;
    detail: Record<string, unknown>;
}

interface TextRunSnapshotSource {
    textBuffer?: string;
    selectedGlyphIndex?: number;
    shapedGlyphs?: Array<{
        ax?: number;
        dx?: number;
        explicitGlyphName?: string;
    }>;
    glyphNameBuffer?: string[];
}

const MAX_ENTRIES = 2000;

function getDiagnosticsState(): Window['__liveTextDiagnostics'] | null {
    const diagnosticsAllowed =
        window.isDevelopment?.() || window.isTestMode?.() || window.isTest?.();
    if (!diagnosticsAllowed) {
        return null;
    }

    if (!window.__liveTextDiagnostics) {
        window.__liveTextDiagnostics = {
            enabled: true,
            entries: []
        };
    }

    return window.__liveTextDiagnostics?.enabled
        ? window.__liveTextDiagnostics
        : null;
}

/** Record a compact text-layout snapshot when development diagnostics are on. */
export function recordLiveTextDiagnostic(
    source: string,
    textRunEditor: TextRunSnapshotSource | null | undefined,
    detail: Record<string, unknown> = {}
): void {
    const state = getDiagnosticsState();
    if (!state) {
        return;
    }

    let cumulativeX = 0;
    const glyphs = (textRunEditor?.shapedGlyphs || []).map((glyph, index) => {
        const ax = Number.isFinite(glyph.ax) ? glyph.ax! : 0;
        const snapshot = {
            index,
            name:
                glyph.explicitGlyphName ||
                textRunEditor?.glyphNameBuffer?.[index] ||
                null,
            ax,
            dx: Number.isFinite(glyph.dx) ? glyph.dx! : 0,
            cumulativeX
        };
        cumulativeX += ax;
        return snapshot;
    });
    const entries = state.entries;
    const entry: LiveTextDiagnosticEntry = {
        sequence: (entries[entries.length - 1]?.sequence || 0) + 1,
        timestamp: performance.now(),
        source,
        text: textRunEditor?.textBuffer || '',
        selectedGlyphIndex: textRunEditor?.selectedGlyphIndex ?? -1,
        glyphs,
        totalAdvance: cumulativeX,
        detail
    };

    entries.push(entry);
    if (entries.length > MAX_ENTRIES) {
        entries.splice(0, entries.length - MAX_ENTRIES);
    }
    window.dispatchEvent(
        new CustomEvent('liveTextDiagnosticsRecorded', { detail: entry })
    );
}
