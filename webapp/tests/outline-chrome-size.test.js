describe('outline chrome size interpolation', () => {
    let interpolateOutlineChromeScreenSize;
    let outlineChromeStateScale;
    let settings;

    beforeAll(() => {
        const settingsModule = require('../js/settings');
        interpolateOutlineChromeScreenSize =
            settingsModule.interpolateOutlineChromeScreenSize;
        outlineChromeStateScale = settingsModule.outlineChromeStateScale;
        settings = settingsModule.default.OUTLINE_EDITOR;
    });

    test('keeps min, mid, and max knots', () => {
        expect(
            interpolateOutlineChromeScreenSize(
                settings.MIN_ZOOM_FOR_HANDLES,
                settings.NODE_SIZE_AT_MIN_ZOOM,
                settings.NODE_SIZE_AT_MID_ZOOM,
                settings.NODE_SIZE_AT_MAX_ZOOM
            )
        ).toBe(settings.NODE_SIZE_AT_MIN_ZOOM);

        expect(
            interpolateOutlineChromeScreenSize(
                settings.HANDLE_SIZE_INTERPOLATION_MID,
                settings.NODE_SIZE_AT_MIN_ZOOM,
                settings.NODE_SIZE_AT_MID_ZOOM,
                settings.NODE_SIZE_AT_MAX_ZOOM
            )
        ).toBe(settings.NODE_SIZE_AT_MID_ZOOM);

        expect(
            interpolateOutlineChromeScreenSize(
                settings.HANDLE_SIZE_INTERPOLATION_MAX,
                settings.NODE_SIZE_AT_MIN_ZOOM,
                settings.NODE_SIZE_AT_MID_ZOOM,
                settings.NODE_SIZE_AT_MAX_ZOOM
            )
        ).toBe(settings.NODE_SIZE_AT_MAX_ZOOM);
    });

    test('grows faster below the 20% mid knot than above it', () => {
        const atTenPercent = interpolateOutlineChromeScreenSize(
            0.1,
            settings.NODE_SIZE_AT_MIN_ZOOM,
            settings.NODE_SIZE_AT_MID_ZOOM,
            settings.NODE_SIZE_AT_MAX_ZOOM
        );
        const atOneHundredPercent = interpolateOutlineChromeScreenSize(
            1,
            settings.NODE_SIZE_AT_MIN_ZOOM,
            settings.NODE_SIZE_AT_MID_ZOOM,
            settings.NODE_SIZE_AT_MAX_ZOOM
        );

        expect(atTenPercent).toBeGreaterThan(settings.NODE_SIZE_AT_MIN_ZOOM);
        expect(atTenPercent).toBeLessThan(settings.NODE_SIZE_AT_MID_ZOOM);
        expect(atOneHundredPercent).toBeGreaterThan(
            settings.NODE_SIZE_AT_MID_ZOOM
        );
        expect(atOneHundredPercent).toBeLessThan(
            settings.NODE_SIZE_AT_MAX_ZOOM
        );
    });

    test('standalone anchors match diamond node size; coincident anchors stay larger', () => {
        const largestNodeRatio = Math.max(
            settings.NODE_SMOOTH_SIZE_RATIO,
            settings.NODE_DIAMOND_SIZE_RATIO
        );
        expect(settings.ANCHOR_SIZE_RATIO).toBeGreaterThan(largestNodeRatio);
        expect(settings.NODE_DIAMOND_SIZE_RATIO).toBeCloseTo(Math.sqrt(2));

        for (const scale of [
            settings.MIN_ZOOM_FOR_HANDLES,
            settings.HANDLE_SIZE_INTERPOLATION_MID,
            settings.HANDLE_SIZE_INTERPOLATION_MAX
        ]) {
            const nodeSize = interpolateOutlineChromeScreenSize(
                scale,
                settings.NODE_SIZE_AT_MIN_ZOOM,
                settings.NODE_SIZE_AT_MID_ZOOM,
                settings.NODE_SIZE_AT_MAX_ZOOM
            );
            const diamondSize = nodeSize * settings.NODE_DIAMOND_SIZE_RATIO;
            const coincidentSize = nodeSize * settings.ANCHOR_SIZE_RATIO;
            expect(coincidentSize).toBeGreaterThan(diamondSize);
        }
    });

    test('selection scale wins over hover', () => {
        expect(outlineChromeStateScale(false, false)).toBe(1);
        expect(outlineChromeStateScale(false, true)).toBe(
            settings.HANDLE_HOVER_SCALE
        );
        expect(outlineChromeStateScale(true, true)).toBe(
            settings.HANDLE_SELECTED_SCALE
        );
    });

    test('zone halo tracks object size; diamonds are √2 thicker', () => {
        const objectRadius = 4;
        const squareHalo = objectRadius * settings.NODE_ZONE_HALO_SIZE_RATIO;
        expect(squareHalo).toBeGreaterThan(0);
        expect(squareHalo).toBeLessThan(objectRadius);
        expect(squareHalo * settings.NODE_DIAMOND_SIZE_RATIO).toBeCloseTo(
            squareHalo * Math.sqrt(2)
        );
    });
});
