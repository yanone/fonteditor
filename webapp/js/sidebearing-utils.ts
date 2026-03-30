import type { HistoryStackItem } from './change-log';

export type SidebearingSide = 'left' | 'right';

type SidebearingLayerSnapshot = {
    width: number;
};

type SidebearingVisualTarget = {
    viewportManager?: {
        panX: number;
        scale: number;
    } | null;
    textRunEditor?: {
        refreshGlyphAdvancesLive(
            glyphAdvances: Record<string, number>,
            options?: { render?: boolean }
        ): boolean;
        computePrecedingAdvanceDelta?(
            glyphAdvances: Record<string, number>
        ): number;
    } | null;
    syncCurrentOutlineLayerDataFromModel?(
        layer: SidebearingLayerSnapshot
    ): void;
};

export function getSidebearingTransactionLabel(side: SidebearingSide): string {
    return side === 'left' ? 'Set LSB' : 'Set RSB';
}

export function formatSidebearingHistoryValue(
    side: SidebearingSide,
    value: number
): string {
    return `${side.toUpperCase()} ${value}`;
}

export function inferSidebearingSideFromHistoryItem(
    historyItem: HistoryStackItem | null
): SidebearingSide | null {
    if (!historyItem) {
        return null;
    }

    if (historyItem.transactionLabel === 'Set LSB') {
        return 'left';
    }
    if (historyItem.transactionLabel === 'Set RSB') {
        return 'right';
    }

    for (const entry of historyItem.entries) {
        for (const value of [entry.oldValue, entry.newValue]) {
            if (typeof value !== 'string') {
                continue;
            }

            if (value.startsWith('LEFT ')) {
                return 'left';
            }
            if (value.startsWith('RIGHT ')) {
                return 'right';
            }
        }
    }

    return null;
}

export function applyLiveSidebearingVisualSync(
    target: SidebearingVisualTarget,
    options: {
        glyphName?: string | null;
        glyphAdvances?: Record<string, number> | null;
        side: SidebearingSide;
        previousWidth: number;
        nextWidth: number;
        render?: boolean;
    }
): {
    widthDelta: number;
    advancesRefreshed: boolean;
} {
    const previousWidth = Number(options.previousWidth);
    const nextWidth = Number(options.nextWidth);
    if (!Number.isFinite(previousWidth) || !Number.isFinite(nextWidth)) {
        return { widthDelta: 0, advancesRefreshed: false };
    }

    const widthDelta = nextWidth - previousWidth;
    if (Math.abs(widthDelta) <= 0.01) {
        return { widthDelta, advancesRefreshed: false };
    }

    if (options.side === 'left' && target.viewportManager) {
        target.viewportManager.panX -=
            widthDelta * target.viewportManager.scale;
    }

    const liveGlyphAdvances =
        options.glyphAdvances && Object.keys(options.glyphAdvances).length > 0
            ? options.glyphAdvances
            : options.glyphName
              ? { [options.glyphName]: nextWidth }
              : null;

    // Snapshot preceding-glyph advance delta BEFORE refreshing the buffer,
    // so the current ax values still reflect the pre-update state.
    const precedingDelta = liveGlyphAdvances
        ? (target.textRunEditor?.computePrecedingAdvanceDelta?.(
              liveGlyphAdvances
          ) ?? 0)
        : 0;

    const advancesRefreshed =
        !!liveGlyphAdvances &&
        !!target.textRunEditor?.refreshGlyphAdvancesLive(liveGlyphAdvances, {
            render: options.render
        });

    // Compensate panX for advance changes in glyphs preceding the active
    // glyph in the buffer (e.g. downstream metrics-key cascades).
    if (Math.abs(precedingDelta) > 0.01 && target.viewportManager) {
        target.viewportManager.panX -=
            precedingDelta * target.viewportManager.scale;
    }

    return { widthDelta, advancesRefreshed };
}

export function syncModelSidebearingEditToCanvas(
    target: SidebearingVisualTarget,
    options: {
        layer: SidebearingLayerSnapshot;
        glyphName?: string | null;
        side: SidebearingSide;
        previousWidth: number;
        render?: boolean;
    }
): {
    widthDelta: number;
    advancesRefreshed: boolean;
} {
    target.syncCurrentOutlineLayerDataFromModel?.(options.layer);

    return applyLiveSidebearingVisualSync(target, {
        glyphName: options.glyphName,
        side: options.side,
        previousWidth: options.previousWidth,
        nextWidth: options.layer.width,
        render: options.render
    });
}
