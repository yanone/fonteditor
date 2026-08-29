const {
    CALIBRATION_CSS_CM,
    CM_PER_INCH,
    CSS_PX_PER_INCH,
    DEFAULT_UNIT_SCALE,
    POINTS_PER_INCH,
    SCREEN_UNIT_SCALE_STORAGE_KEY,
    computeUnitScaleFromMeasurement,
    emCssPxToPointSize,
    formatPointSize,
    getScreenUnitScale,
    parsePointSize,
    parseUnitScale,
    pointSizeToEmCssPx,
    pointSizeToViewportScale,
    resetScreenUnitScale,
    setScreenUnitScale,
    viewportScaleToPointSize
} = require('../js/glyph-canvas/point-size');

describe('point-size', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    test('uncalibrated 1000 UPM at scale 0.1 is 75 pt', () => {
        const pt = viewportScaleToPointSize(0.1, 1000, 1);
        expect(pt).toBeCloseTo(75, 6);
        expect(pointSizeToViewportScale(75, 1000, 1)).toBeCloseTo(0.1, 6);
    });

    test('uses CSS pixels: 1 em CSS px is 0.75 pt at unitScale 1', () => {
        expect(emCssPxToPointSize(1, 1)).toBeCloseTo(
            POINTS_PER_INCH / CSS_PX_PER_INCH,
            10
        );
        expect(pointSizeToEmCssPx(0.75, 1)).toBeCloseTo(1, 10);
    });

    test('unitScale stretches physical points without changing CSS pixels', () => {
        const emCss = 96;
        expect(emCssPxToPointSize(emCss, 1)).toBeCloseTo(72, 6);
        expect(emCssPxToPointSize(emCss, 1.2)).toBeCloseTo(72 / 1.2, 6);
        expect(pointSizeToEmCssPx(72, 1.2)).toBeCloseTo(96 * 1.2, 6);
    });

    test('round-trips zoom and point size at UPM 2048', () => {
        const scale = 0.0375;
        const pt = viewportScaleToPointSize(scale, 2048, 1);
        expect(pointSizeToViewportScale(pt, 2048, 1)).toBeCloseTo(scale, 8);
    });

    test('calibration scale is CSS length over measured length', () => {
        expect(computeUnitScaleFromMeasurement(10, 'cm')).toBeCloseTo(1, 10);
        expect(computeUnitScaleFromMeasurement(8, 'cm')).toBeCloseTo(
            10 / 8,
            10
        );
        const cssInches = CALIBRATION_CSS_CM / CM_PER_INCH;
        expect(computeUnitScaleFromMeasurement(cssInches, 'in')).toBeCloseTo(
            1,
            10
        );
        expect(computeUnitScaleFromMeasurement(0, 'cm')).toBeNull();
        expect(computeUnitScaleFromMeasurement(-1, 'in')).toBeNull();
    });

    test('parse helpers reject non-positive values', () => {
        expect(parseUnitScale(1.07)).toBe(1.07);
        expect(parseUnitScale('0')).toBeNull();
        expect(parseUnitScale('nope')).toBeNull();
        expect(parsePointSize('12.5')).toBe(12.5);
        expect(parsePointSize('0')).toBeNull();
        expect(formatPointSize(12.345)).toBe('12.35');
        expect(formatPointSize(12)).toBe('12');
    });

    test('localStorage unitScale fails open to 1', () => {
        expect(getScreenUnitScale()).toBe(DEFAULT_UNIT_SCALE);
        setScreenUnitScale(1.25);
        expect(localStorage.getItem(SCREEN_UNIT_SCALE_STORAGE_KEY)).toBe(
            '1.25'
        );
        expect(getScreenUnitScale()).toBe(1.25);
        resetScreenUnitScale();
        expect(localStorage.getItem(SCREEN_UNIT_SCALE_STORAGE_KEY)).toBeNull();
        expect(getScreenUnitScale()).toBe(1);
        localStorage.setItem(SCREEN_UNIT_SCALE_STORAGE_KEY, 'not-a-number');
        expect(getScreenUnitScale()).toBe(1);
    });
});
