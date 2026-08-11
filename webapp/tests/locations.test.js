const { extendAxesForDesignspaceLocation } = require('../js/locations');

describe('extendAxesForDesignspaceLocation', () => {
    test('extends unmapped axis min/max to cover an out-of-range designspace location', () => {
        const { axes, changed } = extendAxesForDesignspaceLocation(
            [
                {
                    tag: 'wght',
                    name: { dflt: 'Weight' },
                    min: 100,
                    default: 400,
                    max: 900
                }
            ],
            { wght: 1100 }
        );

        expect(changed).toBe(true);
        expect(axes[0].min).toBe(100);
        expect(axes[0].max).toBe(1100);
    });

    test('does not change axes when the location is already inside an unmapped range', () => {
        const source = [
            {
                tag: 'wght',
                name: { dflt: 'Weight' },
                min: 100,
                default: 400,
                max: 900
            }
        ];
        const { axes, changed } = extendAxesForDesignspaceLocation(source, {
            wght: 700
        });

        expect(changed).toBe(false);
        expect(axes[0].min).toBe(100);
        expect(axes[0].max).toBe(900);
    });

    test('extends mapped axis userspace max and map endpoint past the designspace extrema', () => {
        const { axes, changed } = extendAxesForDesignspaceLocation(
            [
                {
                    tag: 'wght',
                    name: { dflt: 'Weight' },
                    min: 200,
                    default: 400,
                    max: 800,
                    map: [
                        [200, 30],
                        [400, 75],
                        [800, 135]
                    ]
                }
            ],
            { wght: 150 }
        );

        expect(changed).toBe(true);
        expect(axes[0].max).toBe(900);
        expect(axes[0].map).toEqual([
            [200, 30],
            [400, 75],
            [800, 135],
            [900, 150]
        ]);
    });

    test('extends mapped axis userspace min below the designspace extrema', () => {
        const { axes, changed } = extendAxesForDesignspaceLocation(
            [
                {
                    tag: 'wght',
                    name: { dflt: 'Weight' },
                    min: 200,
                    default: 400,
                    max: 800,
                    map: [
                        [200, 30],
                        [400, 75],
                        [800, 135]
                    ]
                }
            ],
            { wght: 0 }
        );

        expect(changed).toBe(true);
        expect(axes[0].min).toBeLessThan(200);
        expect(axes[0].map[0][1]).toBe(0);
        expect(axes[0].map[0][0]).toBe(axes[0].min);
    });
});
