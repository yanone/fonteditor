/**
 * Printer-point size of on-screen text from canvas zoom, in CSS pixels.
 *
 * Viewport `scale` maps 1 font unit to 1 CSS pixel (the 2D context is already
 * scaled by devicePixelRatio). Uncalibrated: 96 CSS px = 1 in, 1 pt = 1/72 in.
 * Optional screen calibration stores a unitScale (CSS length / measured length)
 * in localStorage (`editorScreenUnitScale`; default 1).
 */

export const CSS_PX_PER_INCH = 96;
export const POINTS_PER_INCH = 72;
export const CM_PER_INCH = 2.54;
export const DEFAULT_UNIT_SCALE = 1;
export const CALIBRATION_CSS_CM = 10;
export const MIN_VIEWPORT_SCALE = 0.01;
export const MAX_VIEWPORT_SCALE = 100;

/** Persists the CSS-to-physical unit scale from screen calibration. Default 1. */
export const SCREEN_UNIT_SCALE_STORAGE_KEY = 'editorScreenUnitScale';

export const SCREEN_UNIT_SCALE_CHANGED_EVENT = 'screenUnitScaleChanged';

/** Canvas zoom (viewport.scale) changed. */
export const GLYPH_CANVAS_VIEWPORT_CHANGED_EVENT = 'glyphCanvasViewportChanged';

export type ScreenCalibrationUnit = 'cm' | 'in';

export function parseUnitScale(value: unknown): number | null {
    const numeric =
        typeof value === 'number' ? value : Number.parseFloat(String(value));
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return null;
    }
    return numeric;
}

export function getScreenUnitScale(): number {
    try {
        const stored = localStorage.getItem(SCREEN_UNIT_SCALE_STORAGE_KEY);
        const parsed = parseUnitScale(stored);
        return parsed ?? DEFAULT_UNIT_SCALE;
    } catch {
        return DEFAULT_UNIT_SCALE;
    }
}

export function setScreenUnitScale(unitScale: number): void {
    const parsed = parseUnitScale(unitScale);
    const next = parsed ?? DEFAULT_UNIT_SCALE;
    try {
        if (next === DEFAULT_UNIT_SCALE) {
            localStorage.removeItem(SCREEN_UNIT_SCALE_STORAGE_KEY);
        } else {
            localStorage.setItem(SCREEN_UNIT_SCALE_STORAGE_KEY, String(next));
        }
    } catch {
        // Ignore localStorage access failures.
    }

    // Screen calibration unitScale changed. Detail keys: unitScale.
    window.dispatchEvent(
        new CustomEvent(SCREEN_UNIT_SCALE_CHANGED_EVENT, {
            detail: { unitScale: next }
        })
    );
}

export function resetScreenUnitScale(): void {
    setScreenUnitScale(DEFAULT_UNIT_SCALE);
}

/**
 * unitScale = CSS length / measured physical length (Tab Atkins / CSSWG FAQ).
 */
export function computeUnitScaleFromMeasurement(
    measured: number,
    unit: ScreenCalibrationUnit,
    cssLengthCm: number = CALIBRATION_CSS_CM
): number | null {
    if (!Number.isFinite(measured) || measured <= 0) {
        return null;
    }
    if (!Number.isFinite(cssLengthCm) || cssLengthCm <= 0) {
        return null;
    }
    const cssInMeasuredUnit =
        unit === 'in' ? cssLengthCm / CM_PER_INCH : cssLengthCm;
    return cssInMeasuredUnit / measured;
}

export function resolveUpm(upm: unknown): number {
    const numeric =
        typeof upm === 'number' ? upm : Number.parseFloat(String(upm));
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return 1000;
    }
    return numeric;
}

export function emCssPxToPointSize(
    emCssPx: number,
    unitScale: number = getScreenUnitScale()
): number {
    const scale = parseUnitScale(unitScale) ?? DEFAULT_UNIT_SCALE;
    return (emCssPx * POINTS_PER_INCH) / (CSS_PX_PER_INCH * scale);
}

export function pointSizeToEmCssPx(
    pointSize: number,
    unitScale: number = getScreenUnitScale()
): number {
    const scale = parseUnitScale(unitScale) ?? DEFAULT_UNIT_SCALE;
    return (pointSize * CSS_PX_PER_INCH * scale) / POINTS_PER_INCH;
}

export function viewportScaleToPointSize(
    viewportScale: number,
    upm: unknown,
    unitScale: number = getScreenUnitScale()
): number {
    return emCssPxToPointSize(viewportScale * resolveUpm(upm), unitScale);
}

export function pointSizeToViewportScale(
    pointSize: number,
    upm: unknown,
    unitScale: number = getScreenUnitScale()
): number {
    return pointSizeToEmCssPx(pointSize, unitScale) / resolveUpm(upm);
}

export function formatPointSize(pointSize: number): string {
    if (!Number.isFinite(pointSize)) {
        return '';
    }
    return (Math.round(pointSize * 10) / 10).toFixed(1);
}

export function parsePointSize(value: string): number | null {
    const numeric = Number.parseFloat(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return null;
    }
    return numeric;
}
