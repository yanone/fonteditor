/** Always-drawn master metrics (plus baseline `0`). */
export const CORE_VERTICAL_METRIC_KEYS = new Set([
    'Ascender',
    'Descender',
    'ascender',
    'descender',
    'xHeight',
    'XHeight',
    'CapHeight'
]);

/**
 * Optional OS/2 / hhea / typo metric lines. Drawn only when Show All Metrics
 * is enabled, and slightly fainter than core lines. Non-zero Typo/Hhea line
 * gaps are derived separately (descender − gap) in
 * `getAdditionalDrawableMetricLineEntries`.
 */
export const ADDITIONAL_DRAWABLE_VERTICAL_METRIC_KEYS = new Set([
    'HheaAscender',
    'HheaDescender',
    'TypoAscender',
    'TypoDescender',
    'WinAscent',
    'WinDescent'
]);

/**
 * Masters panel "Additional metrics" fields. Canvas Show All Metrics draws
 * the geometric keys plus non-zero Typo/Hhea line gaps under their descenders.
 */
export const ADDITIONAL_METRICS_PANEL_KEYS = [
    'TypoAscender',
    'TypoDescender',
    'TypoLineGap',
    'HheaAscender',
    'HheaDescender',
    'HheaLineGap',
    'WinAscent',
    'WinDescent'
] as const;

export const ADDITIONAL_METRICS_PANEL_KEY_SET = new Set<string>(
    ADDITIONAL_METRICS_PANEL_KEYS
);

const ALL_GEOMETRIC_VERTICAL_METRIC_KEYS = new Set([
    ...CORE_VERTICAL_METRIC_KEYS,
    ...ADDITIONAL_DRAWABLE_VERTICAL_METRIC_KEYS
]);

function resolveDrawableMetricY(
    metricKey: string,
    metricValue: number
): number {
    // WinDescent is stored as a positive distance below the baseline.
    if (metricKey === 'WinDescent') {
        return -Math.abs(metricValue);
    }
    return metricValue;
}

function collectUniqueMetricValues(
    verticalMetrics: Record<string, number> | null | undefined,
    keySet: Set<string>,
    options: { includeBaseline?: boolean } = {}
): number[] {
    if (!verticalMetrics) {
        return [];
    }

    const metricValues: number[] = [];
    for (const [metricKey, metricValue] of Object.entries(verticalMetrics)) {
        if (!keySet.has(metricKey)) {
            continue;
        }
        if (!Number.isFinite(metricValue)) {
            continue;
        }
        metricValues.push(resolveDrawableMetricY(metricKey, metricValue));
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

    if (options.includeBaseline !== false) {
        const hasBaseline = uniqueMetricValues.some(
            (value) => Math.abs(value) < 0.25
        );
        if (!hasBaseline) {
            uniqueMetricValues.push(0);
        }
    }

    return uniqueMetricValues;
}

/** Core metrics always drawn in edit mode (includes baseline). */
export function getCoreVerticalMetricValues(
    verticalMetrics: Record<string, number> | null | undefined
): number[] {
    return collectUniqueMetricValues(
        verticalMetrics,
        CORE_VERTICAL_METRIC_KEYS,
        { includeBaseline: true }
    );
}

/**
 * Additional drawable metric Y values. Does not force baseline (core lines
 * already include it). Callers should skip values already covered by core.
 * `WinDescent` is treated as a positive stored value and drawn at `-abs(y)`.
 */
export function getAdditionalDrawableVerticalMetricValues(
    verticalMetrics: Record<string, number> | null | undefined
): number[] {
    return getAdditionalDrawableMetricLineEntries(verticalMetrics).map(
        (entry) => entry.y
    );
}

export type AdditionalMetricFamily =
    'hhea' | 'hhealinegap' | 'typo' | 'typolinegap' | 'win';

export interface AdditionalMetricLineEntry {
    family: AdditionalMetricFamily;
    y: number;
    key: string;
}

const ADDITIONAL_METRIC_KEY_TO_FAMILY: Record<string, AdditionalMetricFamily> =
    {
        HheaAscender: 'hhea',
        HheaDescender: 'hhea',
        TypoAscender: 'typo',
        TypoDescender: 'typo',
        WinAscent: 'win',
        WinDescent: 'win'
    };

const LINE_GAP_DRAW_SPECS: ReadonlyArray<{
    gapKey: 'TypoLineGap' | 'HheaLineGap';
    descenderKey: 'TypoDescender' | 'HheaDescender';
    family: AdditionalMetricFamily;
}> = [
    {
        gapKey: 'TypoLineGap',
        descenderKey: 'TypoDescender',
        family: 'typolinegap'
    },
    {
        gapKey: 'HheaLineGap',
        descenderKey: 'HheaDescender',
        family: 'hhealinegap'
    }
];

/**
 * Resolve drawable additional-metric lines with short family names.
 * `WinDescent` is stored positive and drawn negative; other values are absolute.
 * Non-zero `TypoLineGap` / `HheaLineGap` add a line at `descender - gap`,
 * labeled `typolinegap` / `hhealinegap`.
 */
export function getAdditionalDrawableMetricLineEntries(
    verticalMetrics: Record<string, number> | null | undefined
): AdditionalMetricLineEntry[] {
    if (!verticalMetrics) {
        return [];
    }

    const entries: AdditionalMetricLineEntry[] = [];
    for (const [metricKey, family] of Object.entries(
        ADDITIONAL_METRIC_KEY_TO_FAMILY
    )) {
        const rawValue = verticalMetrics[metricKey];
        if (!Number.isFinite(rawValue)) {
            continue;
        }
        const y = resolveDrawableMetricY(metricKey, Number(rawValue));
        entries.push({ family, y, key: metricKey });
    }

    for (const { gapKey, descenderKey, family } of LINE_GAP_DRAW_SPECS) {
        const gap = Number(verticalMetrics[gapKey]);
        const descender = Number(verticalMetrics[descenderKey]);
        if (!Number.isFinite(gap) || gap === 0) {
            continue;
        }
        if (!Number.isFinite(descender)) {
            continue;
        }
        const y = resolveDrawableMetricY(descenderKey, descender) - gap;
        entries.push({ family, y, key: gapKey });
    }

    return entries;
}

export function formatAdditionalMetricFamiliesLabel(
    families: Iterable<AdditionalMetricFamily>
): string {
    const order: AdditionalMetricFamily[] = [
        'hhea',
        'hhealinegap',
        'typo',
        'typolinegap',
        'win'
    ];
    const present = new Set(families);
    return order.filter((family) => present.has(family)).join('+');
}

/**
 * All geometric vertical metric Y values (core + additional drawable,
 * including non-zero Typo/Hhea line-gap lines). Used for extents, empty-glyph
 * hits, and similar layout math.
 */
export function getVisibleVerticalMetricValues(
    verticalMetrics: Record<string, number> | null | undefined
): number[] {
    const merged = collectUniqueMetricValues(
        verticalMetrics,
        ALL_GEOMETRIC_VERTICAL_METRIC_KEYS,
        { includeBaseline: true }
    );
    for (const value of getAdditionalDrawableVerticalMetricValues(
        verticalMetrics
    )) {
        const alreadyPresent = merged.some(
            (existingValue) => Math.abs(existingValue - value) < 0.25
        );
        if (!alreadyPresent) {
            merged.push(value);
        }
    }
    return merged;
}

/**
 * Metric Y values that should participate in edit-mode snapping: core always,
 * plus additional drawable metrics when Show All Metrics is on.
 */
export function getSnappableVerticalMetricValues(
    verticalMetrics: Record<string, number> | null | undefined,
    includeAdditional: boolean
): number[] {
    const core = getCoreVerticalMetricValues(verticalMetrics);
    if (!includeAdditional) {
        return core;
    }

    const additional =
        getAdditionalDrawableVerticalMetricValues(verticalMetrics);
    const merged = [...core];
    for (const value of additional) {
        const alreadyPresent = merged.some(
            (existingValue) => Math.abs(existingValue - value) < 0.25
        );
        if (!alreadyPresent) {
            merged.push(value);
        }
    }
    return merged;
}

export function getLowestVisibleVerticalMetricValue(
    verticalMetrics: Record<string, number> | null | undefined
): number | null {
    const metricValues = getVisibleVerticalMetricValues(verticalMetrics);
    return metricValues.length ? Math.min(...metricValues) : null;
}

export function getHighestVisibleVerticalMetricValue(
    verticalMetrics: Record<string, number> | null | undefined
): number | null {
    const metricValues = getVisibleVerticalMetricValues(verticalMetrics);
    return metricValues.length ? Math.max(...metricValues) : null;
}

export function isAdditionalMetricsPanelKey(metricKey: string): boolean {
    return ADDITIONAL_METRICS_PANEL_KEY_SET.has(metricKey);
}

/**
 * Master metrics that exist on Glyphs imports but are not useful in Font Info.
 * `baseline` is always 0; italic angle has no meaningful overshoot zone.
 */
export function isHiddenMasterMetricsPanelKey(metricKey: string): boolean {
    const normalized = metricKey.trim().toLowerCase();
    return normalized === 'baseline' || normalized === 'italicangle overshoot';
}
