const {
    formatAdditionalMetricFamiliesLabel,
    getAdditionalDrawableMetricLineEntries,
    getAdditionalDrawableVerticalMetricValues
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
            formatAdditionalMetricFamiliesLabel([
                'typolinegap',
                'hhea',
                'hhealinegap'
            ])
        ).toBe('hhea+hhealinegap+typolinegap');
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
});
