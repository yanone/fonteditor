describe('SidebarErrorDisplay copy report button', () => {
    let sidebarErrorDisplay;
    let buildErrorReportPayload;
    let writeTextMock;

    beforeEach(() => {
        jest.resetModules();
        document.body.innerHTML =
            '<div id="glyph-editor-sidebar"><div id="normal-sidebar-content">Normal</div></div>';

        buildErrorReportPayload = jest.fn().mockResolvedValue({
            error: {
                message: 'Compilation exploded',
                stack: 'mapped stack'
            },
            state: {
                editor_file: 'memory:///user/Test.glyphs'
            },
            history: [
                {
                    key: 'editor_text_buffer',
                    newValue: 'abc'
                }
            ],
            events: [
                {
                    type: 'text_changed',
                    source: 'TextRunEditor'
                }
            ],
            source: 'editor.compilation.sidebar',
            reason: 'Compilation exploded',
            runtimeContext: {
                readyState: 'complete'
            },
            url: 'https://localhost:8000',
            userAgent: 'Jest'
        });

        jest.doMock('../js/state-manager', () => ({
            buildErrorReportPayload
        }));

        writeTextMock = jest.fn().mockResolvedValue(undefined);
        Object.defineProperty(window.navigator, 'clipboard', {
            configurable: true,
            value: {
                writeText: writeTextMock
            }
        });

        window.fontInfoManager = {
            getFeatureCompilationErrorDetails: jest.fn(() => null),
            getFeatureCompilationErrorLocation: jest.fn(() => null),
            showFeatureCompilationError: jest.fn(),
            clearFeatureErrorHighlight: jest.fn(),
            openFeatureCompilationError: jest.fn()
        };

        ({ sidebarErrorDisplay } = require('../js/sidebar-error-display'));
    });

    afterEach(() => {
        delete window.fontInfoManager;
        jest.useRealTimers();
    });

    test('copies runtime-style error report payload JSON', async () => {
        jest.useFakeTimers();
        sidebarErrorDisplay.showError(new Error('Compilation exploded'));

        const button = document.getElementById('sidebar-copy-error-report-btn');
        expect(button).not.toBeNull();

        await button.click();

        expect(buildErrorReportPayload).toHaveBeenCalledWith(
            expect.any(Error),
            'editor.compilation.sidebar',
            'sidebar-error-display'
        );
        expect(writeTextMock).toHaveBeenCalledWith(
            JSON.stringify(
                await buildErrorReportPayload.mock.results[0].value,
                null,
                2
            )
        );
        expect(button.textContent).toBe('Copied');

        jest.advanceTimersByTime(1500);
        expect(button.textContent).toBe('Copy Error Report');
    });
});
