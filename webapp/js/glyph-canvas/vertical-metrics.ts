const RELEVANT_VERTICAL_METRIC_KEYS = new Set([
    'Ascender',
    'Descender',
    'ascender',
    'descender',
    'HheaAscender',
    'HheaDescender',
    'TypoAscender',
    'TypoDescender',
    'WinAscent',
    'WinDescent',
    'xHeight',
    'XHeight',
    'CapHeight'
]);

export function getVisibleVerticalMetricValues(
    verticalMetrics: Record<string, number> | null | undefined
): number[] {
    if (!verticalMetrics) {
        return [];
    }

    const metricValues: number[] = [];
    for (const [metricKey, metricValue] of Object.entries(verticalMetrics)) {
        if (!RELEVANT_VERTICAL_METRIC_KEYS.has(metricKey)) {
            continue;
        }
        if (!Number.isFinite(metricValue)) {
            continue;
        }
        metricValues.push(metricValue);
    }

    const uniqueMetricValues: number[] = [];
    for (const metricValue of metricValues) {
        const alreadyPresent = uniqueMetricValues.some(
            (existingValue) => Math.abs(existingValue - metricValue) < 0.25
        );
        if (!alreadyPresent) {
            uniqueMetricValues.push(metricValue);
        }
    }

    if (uniqueMetricValues.length === 0) {
        return [];
    }

    uniqueMetricValues.push(0);
    return uniqueMetricValues;
}

export function getLowestVisibleVerticalMetricValue(
    verticalMetrics: Record<string, number> | null | undefined
): number | null {
    const metricValues = getVisibleVerticalMetricValues(verticalMetrics);
    return metricValues.length ? Math.min(...metricValues) : null;
}
