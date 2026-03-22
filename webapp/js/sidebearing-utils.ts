import type { HistoryStackItem } from './change-log';

export type SidebearingSide = 'left' | 'right';

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
    } | null;
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

    const glyphName = options.glyphName;
    const advancesRefreshed =
        !!glyphName &&
        !!target.textRunEditor?.refreshGlyphAdvancesLive(
            { [glyphName]: nextWidth },
            { render: options.render }
        );

    return { widthDelta, advancesRefreshed };
}
