describe('full font compile manager', () => {
    let compileCachedMock;
    let hasWorkerCacheDocumentMock;
    let bootstrapWorkerCacheFromFontStateMock;
    let sendMessageMock;
    let showErrorMock;
    let mockFontManager;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.resetModules();

        compileCachedMock = jest.fn().mockResolvedValue({
            result: new Uint8Array([1, 2, 3, 4]).buffer
        });
        hasWorkerCacheDocumentMock = jest.fn(() => true);
        bootstrapWorkerCacheFromFontStateMock = jest
            .fn()
            .mockResolvedValue(undefined);
        sendMessageMock = jest.fn().mockResolvedValue({
            summary: { fails: 0, warns: 0, infos: 0 },
            checks: []
        });
        showErrorMock = jest.fn();

        mockFontManager = {
            currentFont: {
                path: '/tmp/TestFont.babelfont',
                changeVersion: 1,
                babelfontJson: '{"glyphs":[]}',
                syncJsonFromModel: jest.fn()
            },
            buildNormalizedWorkerYjsState: jest.fn(
                () => new Uint8Array([1, 2, 3])
            ),
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
                compileCached: compileCachedMock,
                hasWorkerCacheDocument: hasWorkerCacheDocumentMock,
                bootstrapWorkerCacheFromFontState:
                    bootstrapWorkerCacheFromFontStateMock,
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
                showError: showErrorMock
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

        expect(compileCachedMock).toHaveBeenCalledTimes(1);
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

        expect(compileCachedMock).not.toHaveBeenCalled();
        expect(sendMessageMock).not.toHaveBeenCalled();
    });

    test('bootstraps the full compile worker cache from authoritative state before the first cached compile', async () => {
        hasWorkerCacheDocumentMock.mockReturnValue(false);

        require('../js/full-font-compile-manager.ts');

        window.fullCompileManager.scheduleCompilation(0);
        jest.runOnlyPendingTimers();
        await Promise.resolve();
        await Promise.resolve();

        expect(
            mockFontManager.buildNormalizedWorkerYjsState
        ).toHaveBeenCalledTimes(1);
        expect(bootstrapWorkerCacheFromFontStateMock).toHaveBeenCalledWith(
            mockFontManager.currentFont.babelfontJson,
            expect.any(Uint8Array)
        );
        expect(compileCachedMock).toHaveBeenCalledTimes(1);
    });

    test('retries quietly when cached full compile runs before the worker Yjs doc is ready', async () => {
        compileCachedMock
            .mockRejectedValueOnce(
                new Error(
                    'Cached compile requires a ready worker Yjs document; full babelfont JSON fallback is disabled'
                )
            )
            .mockResolvedValueOnce({
                result: new Uint8Array([1, 2, 3, 4]).buffer
            });

        require('../js/full-font-compile-manager.ts');

        window.fullCompileManager.scheduleCompilation(0);
        jest.runOnlyPendingTimers();
        await Promise.resolve();
        await Promise.resolve();

        expect(compileCachedMock).toHaveBeenCalledTimes(1);
        expect(showErrorMock).not.toHaveBeenCalled();
        expect(sendMessageMock).not.toHaveBeenCalled();

        jest.advanceTimersByTime(200);
        await Promise.resolve();
        await Promise.resolve();

        expect(compileCachedMock).toHaveBeenCalledTimes(2);
        expect(sendMessageMock).toHaveBeenCalledWith({
            type: 'runFontspector',
            fontBytes: expect.any(Uint8Array),
            profile: 'universal'
        });
    });
});
