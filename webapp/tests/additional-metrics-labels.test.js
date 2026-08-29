const {
    formatAdditionalMetricFamiliesLabel,
    getAdditionalDrawableMetricLineEntries,
    getAdditionalDrawableVerticalMetricValues,
    getCoreDrawableMetricLineEntries,
    getMetricOvershootBands
} = require('../js/glyph-canvas/vertical-metrics');

describe('additional vertical metric labels', () => {
    test('maps WinDescent to a negative draw Y while leaving others absolute', () => {
        const entries = getAdditionalDrawableMetricLineEntries({
            HheaAscender: 800,
            HheaDescender: -200,
            TypoAscender: 800,
            TypoDescender: -200,
            WinAscent: 900,
            WinDescent: 200
        });

        expect(entries).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ family: 'hhea', y: 800 }),
                expect.objectContaining({ family: 'hhea', y: -200 }),
                expect.objectContaining({ family: 'typo', y: 800 }),
                expect.objectContaining({ family: 'typo', y: -200 }),
                expect.objectContaining({ family: 'win', y: 900 }),
                expect.objectContaining({ family: 'win', y: -200 })
            ])
        );

        expect(
            getAdditionalDrawableVerticalMetricValues({
                WinDescent: 200,
                WinAscent: 900
            })
        ).toEqual(expect.arrayContaining([900, -200]));
    });

    test('formats combined family labels in stable order', () => {
        expect(formatAdditionalMetricFamiliesLabel(['win', 'hhea'])).toBe(
            'hhea+win'
        );
        expect(
            formatAdditionalMetricFamiliesLabel(['win', 'typo', 'hhea'])
        ).toBe('hhea+typo+win');
        expect(formatAdditionalMetricFamiliesLabel(['typo'])).toBe('typo');
        expect(
            formatAdditionalMetricFamiliesLabel(['typo', 'ascender', 'hhea'])
        ).toBe('ascender+hhea+typo');
        expect(
            formatAdditionalMetricFamiliesLabel([
                'descender',
                'baseline',
                'xheight'
            ])
        ).toBe('xheight+baseline+descender');
        expect(
            formatAdditionalMetricFamiliesLabel([
                'typolinegap',
                'hhea',
                'hhealinegap'
            ])
        ).toBe('hhea+hhealinegap+typolinegap');
    });

    test('emits core metric families including baseline', () => {
        const entries = getCoreDrawableMetricLineEntries({
            Ascender: 800,
            CapHeight: 700,
            XHeight: 500,
            Descender: -200
        });

        expect(entries).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ family: 'ascender', y: 800 }),
                expect.objectContaining({ family: 'capheight', y: 700 }),
                expect.objectContaining({ family: 'xheight', y: 500 }),
                expect.objectContaining({ family: 'descender', y: -200 }),
                expect.objectContaining({ family: 'baseline', y: 0 })
            ])
        );
    });

    test('draws non-zero Typo/Hhea line gaps under their descenders', () => {
        const entries = getAdditionalDrawableMetricLineEntries({
            TypoDescender: -200,
            TypoLineGap: 50,
            HheaDescender: -220,
            HheaLineGap: 80,
            WinDescent: 200
        });

        expect(entries).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    family: 'typolinegap',
                    y: -250,
                    key: 'TypoLineGap'
                }),
                expect.objectContaining({
                    family: 'hhealinegap',
                    y: -300,
                    key: 'HheaLineGap'
                })
            ])
        );
    });

    test('skips zero or missing line gaps', () => {
        const entries = getAdditionalDrawableMetricLineEntries({
            TypoDescender: -200,
            TypoLineGap: 0,
            HheaDescender: -220
        });

        expect(entries.some((entry) => entry.key === 'TypoLineGap')).toBe(
            false
        );
        expect(entries.some((entry) => entry.key === 'HheaLineGap')).toBe(
            false
        );
    });

    test('builds signed overshoot bands from companion keys', () => {
        const bands = getMetricOvershootBands({
            'Ascender': 800,
            'Ascender overshoot': 12,
            'Descender': -200,
            'Descender overshoot': -16,
            'baseline': 0,
            'baseline overshoot': -10,
            'italicAngle': -12,
            'italicAngle overshoot': 5,
            'xHeight overshoot': 0,
            'TypoDescender': -200,
            'TypoDescender overshoot': -8
        });

        expect(bands).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    baseKey: 'Ascender',
                    y: 800,
                    overshoot: 12
                }),
                expect.objectContaining({
                    baseKey: 'Descender',
                    y: -200,
                    overshoot: -16
                }),
                expect.objectContaining({
                    baseKey: 'baseline',
                    y: 0,
                    overshoot: -10
                }),
                expect.objectContaining({
                    baseKey: 'TypoDescender',
                    y: -200,
                    overshoot: -8
                })
            ])
        );
        expect(bands.some((band) => band.baseKey === 'italicAngle')).toBe(
            false
        );
        expect(bands.some((band) => band.baseKey === 'xHeight')).toBe(false);
    });

    test('omits additional-metric overshoots unless requested', () => {
        const bands = getMetricOvershootBands(
            {
                'Ascender': 800,
                'Ascender overshoot': 12,
                'TypoDescender': -200,
                'TypoDescender overshoot': -8
            },
            false
        );

        expect(bands).toEqual([
            expect.objectContaining({
                baseKey: 'Ascender',
                overshoot: 12
            })
        ]);
    });
});
