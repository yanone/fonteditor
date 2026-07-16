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
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
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

        expect(mockFontManager.buildWorkerSeedYjsState).toHaveBeenCalledTimes(
            1
        );
        expect(bootstrapWorkerCacheFromFontStateMock).toHaveBeenCalledWith(
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
        await Promise.resolve();

        expect(compileCachedMock).toHaveBeenCalledTimes(1);
        expect(showErrorMock).not.toHaveBeenCalled();
        expect(sendMessageMock).not.toHaveBeenCalled();

        jest.advanceTimersByTime(500);
        await Promise.resolve();
        await Promise.resolve();

        expect(compileCachedMock).toHaveBeenCalledTimes(2);
        expect(sendMessageMock).toHaveBeenCalledWith({
            type: 'runFontspector',
            fontBytes: expect.any(Uint8Array),
            profile: 'universal'
        });
    });

    test('shows the sidebar error when the worker Yjs document retry also fails', async () => {
        const qcUpdates = [];
        window.addEventListener('fontspectorUpdated', (event) => {
            qcUpdates.push(event.detail);
        });
        compileCachedMock.mockRejectedValue(
            new Error(
                'Cached compile requires a ready worker Yjs document; full babelfont JSON fallback is disabled'
            )
        );

        require('../js/full-font-compile-manager.ts');

        window.fullCompileManager.scheduleCompilation(0);
        jest.runOnlyPendingTimers();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        jest.advanceTimersByTime(500);
        await Promise.resolve();
        await Promise.resolve();

        expect(compileCachedMock).toHaveBeenCalledTimes(2);
        expect(showErrorMock).toHaveBeenCalledTimes(1);
        expect(qcUpdates.at(-1)).toEqual(
            expect.objectContaining({ status: 'error' })
        );

        jest.advanceTimersByTime(500);
        await Promise.resolve();

        expect(compileCachedMock).toHaveBeenCalledTimes(2);
    });

    test('retries one transient full-worker initialization failure without showing a sidebar error', async () => {
        compileCachedMock
            .mockRejectedValueOnce(
                new Error(
                    'babelfont-fontc WASM not available. Run ./build-fontc-wasm.sh and serve with CORS headers.'
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

        jest.advanceTimersByTime(500);
        await Promise.resolve();
        await Promise.resolve();

        expect(compileCachedMock).toHaveBeenCalledTimes(2);
        expect(sendMessageMock).toHaveBeenCalledWith({
            type: 'runFontspector',
            fontBytes: expect.any(Uint8Array),
            profile: 'universal'
        });
        expect(showErrorMock).not.toHaveBeenCalled();
    });

    test('shows the sidebar error when the full-worker initialization retry also fails', async () => {
        const qcUpdates = [];
        window.addEventListener('fontspectorUpdated', (event) => {
            qcUpdates.push(event.detail);
        });
        compileCachedMock.mockRejectedValue(
            new Error(
                'babelfont-fontc WASM not available. Run ./build-fontc-wasm.sh and serve with CORS headers.'
            )
        );

        require('../js/full-font-compile-manager.ts');

        window.fullCompileManager.scheduleCompilation(0);
        jest.runOnlyPendingTimers();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        jest.advanceTimersByTime(500);
        await Promise.resolve();
        await Promise.resolve();

        expect(compileCachedMock).toHaveBeenCalledTimes(2);
        expect(showErrorMock).toHaveBeenCalledTimes(1);
        expect(qcUpdates.at(-1)).toEqual(
            expect.objectContaining({ status: 'error' })
        );
    });

    test('does not grant another full-worker initialization retry when the monitor observes the same generation', async () => {
        compileCachedMock.mockRejectedValue(
            new Error(
                'babelfont-fontc WASM not available. Run ./build-fontc-wasm.sh and serve with CORS headers.'
            )
        );

        require('../js/full-font-compile-manager.ts');

        window.fullCompileManager.scheduleCompilation(0);
        jest.runOnlyPendingTimers();
        await Promise.resolve();
        await Promise.resolve();

        window.fullCompileManager.checkAndSchedule();
        jest.advanceTimersByTime(350);
        await Promise.resolve();
        await Promise.resolve();

        expect(compileCachedMock).toHaveBeenCalledTimes(2);
        expect(showErrorMock).toHaveBeenCalledTimes(1);
    });

    test('re-arms a pending full-worker initialization retry after an active drag ends', async () => {
        compileCachedMock
            .mockRejectedValueOnce(
                new Error(
                    'babelfont-fontc WASM not available. Run ./build-fontc-wasm.sh and serve with CORS headers.'
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

        window.glyphCanvas.outlineEditor.draggingSomething = true;
        jest.advanceTimersByTime(200);
        await Promise.resolve();
        await Promise.resolve();

        expect(compileCachedMock).toHaveBeenCalledTimes(1);

        window.glyphCanvas.outlineEditor.draggingSomething = false;
        jest.advanceTimersByTime(500);
        await Promise.resolve();
        await Promise.resolve();

        expect(compileCachedMock).toHaveBeenCalledTimes(2);
        expect(sendMessageMock).toHaveBeenCalledWith({
            type: 'runFontspector',
            fontBytes: expect.any(Uint8Array),
            profile: 'universal'
        });
        expect(showErrorMock).not.toHaveBeenCalled();
    });

    test('re-arms a pending full-worker initialization retry after auto compilation ends', async () => {
        compileCachedMock
            .mockRejectedValueOnce(
                new Error(
                    'babelfont-fontc WASM not available. Run ./build-fontc-wasm.sh and serve with CORS headers.'
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
        await Promise.resolve();

        window.autoCompileManager.getStatus.mockReturnValue({
            isCompiling: true
        });
        jest.advanceTimersByTime(500);
        await Promise.resolve();
        await Promise.resolve();

        expect(compileCachedMock).toHaveBeenCalledTimes(1);

        window.autoCompileManager.getStatus.mockReturnValue({
            isCompiling: false
        });
        jest.advanceTimersByTime(500);
        await Promise.resolve();
        await Promise.resolve();

        expect(compileCachedMock).toHaveBeenCalledTimes(2);
        expect(sendMessageMock).toHaveBeenCalledWith({
            type: 'runFontspector',
            fontBytes: expect.any(Uint8Array),
            profile: 'universal'
        });
        expect(showErrorMock).not.toHaveBeenCalled();
    });
});
