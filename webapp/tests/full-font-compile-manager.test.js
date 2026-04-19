describe('full font compile manager', () => {
    let compileFromJsonMock;
    let sendMessageMock;
    let mockFontManager;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.resetModules();

        compileFromJsonMock = jest.fn().mockResolvedValue({
            result: new Uint8Array([1, 2, 3, 4]).buffer
        });
        sendMessageMock = jest.fn().mockResolvedValue({
            summary: { fails: 0, warns: 0, infos: 0 },
            checks: []
        });

        mockFontManager = {
            currentFont: {
                path: '/tmp/TestFont.babelfont',
                changeVersion: 1,
                babelfontJson: '{"glyphs":[]}',
                syncJsonFromModel: jest.fn()
            },
            fullFontQcSummary: null,
            fullFont: null
        };

        jest.doMock('../js/settings', () => ({
            __esModule: true,
            default: {
                FONT_MANAGER: {
                    SAVE_DEBUG_FONTS: false
                }
            }
        }));
        jest.doMock('../js/font-compilation', () => ({
            fullFontCompilation: {
                compileFromJson: compileFromJsonMock,
                sendMessage: sendMessageMock
            }
        }));
        jest.doMock('../js/font-manager', () => ({
            __esModule: true,
            default: mockFontManager
        }));
        jest.doMock('../js/logger', () => ({
            Logger: class {
                log() {}
                warn() {}
                error() {}
            }
        }));
        jest.doMock('../js/perf-timeline', () => ({
            timelineSpanStart: jest.fn().mockReturnValue('span'),
            timelineSpanEnd: jest.fn()
        }));
        jest.doMock('../js/sidebar-error-display', () => ({
            sidebarErrorDisplay: {
                showError: jest.fn()
            }
        }));
        jest.doMock('../js/feature-error-parser', () => ({
            extractFeatureIssuesFromCompilationError: jest.fn(() => [])
        }));

        window.autoCompileManager = {
            getStatus: jest.fn(() => ({ isCompiling: false }))
        };
        window.glyphCanvas = {
            outlineEditor: {
                active: true,
                draggingSomething: false
            }
        };
    });

    afterEach(() => {
        jest.useRealTimers();
        delete window.autoCompileManager;
        delete window.glyphCanvas;
        delete window.fullCompileManager;
        jest.clearAllMocks();
        jest.dontMock('../js/settings');
        jest.dontMock('../js/font-compilation');
        jest.dontMock('../js/font-manager');
        jest.dontMock('../js/logger');
        jest.dontMock('../js/perf-timeline');
        jest.dontMock('../js/sidebar-error-display');
        jest.dontMock('../js/feature-error-parser');
    });

    test('compiles while outline editor is active but idle', async () => {
        require('../js/full-font-compile-manager.ts');

        window.fullCompileManager.scheduleCompilation(0);
        jest.runOnlyPendingTimers();
        await Promise.resolve();
        await Promise.resolve();

        expect(compileFromJsonMock).toHaveBeenCalledTimes(1);
        expect(sendMessageMock).toHaveBeenCalledWith({
            type: 'runFontspector',
            fontBytes: expect.any(Uint8Array),
            profile: 'universal'
        });
    });

    test('does not compile while actively dragging in outline editor', async () => {
        window.glyphCanvas.outlineEditor.draggingSomething = true;

        require('../js/full-font-compile-manager.ts');

        window.fullCompileManager.scheduleCompilation(0);
        jest.runOnlyPendingTimers();
        await Promise.resolve();

        expect(compileFromJsonMock).not.toHaveBeenCalled();
        expect(sendMessageMock).not.toHaveBeenCalled();
    });
});
