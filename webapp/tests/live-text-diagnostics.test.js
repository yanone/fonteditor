const { recordLiveTextDiagnostic } = require('../js/live-text-diagnostics');

describe('live text diagnostics', () => {
    let originalIsDevelopment;
    let originalIsTestMode;
    let originalIsTest;
    let originalDiagnostics;

    beforeEach(() => {
        originalIsDevelopment = window.isDevelopment;
        originalIsTestMode = window.isTestMode;
        originalIsTest = window.isTest;
        originalDiagnostics = window.__liveTextDiagnostics;
        window.isDevelopment = () => false;
        window.isTestMode = () => false;
        window.isTest = () => true;
        delete window.__liveTextDiagnostics;
    });

    afterEach(() => {
        window.isDevelopment = originalIsDevelopment;
        window.isTestMode = originalIsTestMode;
        window.isTest = originalIsTest;
        window.__liveTextDiagnostics = originalDiagnostics;
    });

    test('records per-glyph advances and cumulative rendering positions', () => {
        const recorded = jest.fn();
        window.addEventListener('liveTextDiagnosticsRecorded', recorded);

        try {
            recordLiveTextDiagnostic(
                'text.reshape.completed',
                {
                    textBuffer: 'Aa',
                    selectedGlyphIndex: 1,
                    glyphNameBuffer: ['A', 'a'],
                    shapedGlyphs: [
                        { ax: 600, dx: 0 },
                        { ax: 450, dx: 12 }
                    ]
                },
                { reason: 'test' }
            );

            expect(window.__liveTextDiagnostics.entries).toEqual([
                expect.objectContaining({
                    sequence: 1,
                    source: 'text.reshape.completed',
                    trace: expect.any(String),
                    text: 'Aa',
                    selectedGlyphIndex: 1,
                    totalAdvance: 1050,
                    detail: { reason: 'test' },
                    glyphs: [
                        {
                            index: 0,
                            name: 'A',
                            ax: 600,
                            dx: 0,
                            cumulativeX: 0
                        },
                        {
                            index: 1,
                            name: 'a',
                            ax: 450,
                            dx: 12,
                            cumulativeX: 600
                        }
                    ]
                })
            ]);
            expect(recorded).toHaveBeenCalledTimes(1);
        } finally {
            window.removeEventListener('liveTextDiagnosticsRecorded', recorded);
        }
    });
});
