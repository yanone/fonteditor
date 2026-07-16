jest.mock('tippy.js', () => ({
    __esModule: true,
    default: jest.fn()
}));
jest.mock('tippy.js/dist/tippy.css', () => ({}), { virtual: true });

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
}

function createShapingResult(glyphs) {
    return {
        glyphs,
        gids: glyphs.map((_, index) => index + 1),
        advances: glyphs.map(() => 500),
        advancesY: glyphs.map(() => 0),
        offsetsX: glyphs.map(() => 0),
        offsetsY: glyphs.map(() => 0),
        clusters: glyphs.map((_, index) => index)
    };
}

describe('compile_and_shape_font committed worker state', () => {
    let AIAgent;
    let fullFont;
    let subsetFont;
    let workerSeedState;

    beforeAll(() => {
        document.body.innerHTML = `
            <textarea id="agent-prompt"></textarea>
            <button id="agent-send-btn"></button>
            <div id="agent-messages"></div>
            <div id="agent-chat-container"></div>
            <div id="agent-login-container"></div>
            <div id="agent-subscription-container"></div>
        `;
        window.authManager = {
            checkAuthStatus: jest.fn().mockResolvedValue(null),
            subscription: null,
            onAuthStateChanged: null
        };
        AIAgent = require('../js/ai-agent').default;
    });

    beforeEach(() => {
        fullFont = new Uint8Array([1]);
        subsetFont = new Uint8Array([2]);
        workerSeedState = new Uint8Array([3]);
        window.fontManager = {
            currentFont: {
                sourcePlugin: { getId: jest.fn(() => 'memory') },
                path: 'memory:///font.glyphs',
                changeVersion: 1
            },
            currentFontModel: { axes: [] },
            workerCacheUpdatePromise: null,
            buildWorkerSeedYjsState: jest.fn(() => workerSeedState),
            forceFullWorkerCacheUpdate: jest.fn(),
            submitLayerUpdatesToWorkerCache: jest.fn()
        };
        window.fontCompilation = {
            awaitWorkerDocumentSync: jest.fn().mockResolvedValue(),
            hasWorkerCacheDocument: jest.fn(() => true),
            compileCached: jest.fn().mockResolvedValue({ result: fullFont }),
            compileCommittedDebugFont: jest
                .fn()
                .mockResolvedValue({ result: subsetFont }),
            bootstrapWorkerCacheFromFontState: jest.fn(),
            storeFontJson: jest.fn()
        };
        window.fullFontCompilation = {
            bootstrapWorkerCacheFromFontState: jest.fn().mockResolvedValue(),
            compileCached: jest.fn().mockResolvedValue({ result: fullFont }),
            compileCommittedDebugFont: jest
                .fn()
                .mockResolvedValue({ result: subsetFont })
        };
        window.shapeTextWithFontDetailed = jest.fn(async (font) =>
            font === fullFont
                ? createShapingResult(['zero', 'slash', 'one', 'zero'])
                : createShapingResult(['zero', 'slash', 'one', 'zero'])
        );
        window.windowRole = { isMainWindow: jest.fn(() => true) };
        window.glyphCanvas = {
            outlineEditor: {
                draggingSomething: false,
                isPreviewMode: false,
                hasPendingKeyboardPreviewCommit: jest.fn(() => false)
            }
        };
    });

    test('waits for pending committed worker updates before compiling the latest revision', async () => {
        const pendingUpdate = createDeferred();
        window.fontManager.workerCacheUpdatePromise = pendingUpdate.promise;
        const agent = new AIAgent();
        const toolCall = agent.executeToolCall({
            function: {
                name: 'compile_and_shape_font',
                arguments: JSON.stringify({ text: '0/10' })
            }
        });

        await Promise.resolve();
        await Promise.resolve();
        expect(window.fontCompilation.compileCached).not.toHaveBeenCalled();
        expect(
            window.fontCompilation.compileCommittedDebugFont
        ).not.toHaveBeenCalled();

        window.fontManager.currentFont.changeVersion = 2;
        pendingUpdate.resolve();

        const result = JSON.parse(await toolCall);
        expect(result.fontRevision.changeVersion).toBe(2);
        expect(
            window.fullFontCompilation.bootstrapWorkerCacheFromFontState
        ).toHaveBeenCalledWith(workerSeedState);
        expect(window.fullFontCompilation.compileCached).toHaveBeenCalledWith(
            'full',
            'debug-full-font.ttf'
        );
        expect(
            window.fullFontCompilation.compileCommittedDebugFont
        ).toHaveBeenCalledWith(['zero', 'slash', 'one']);
        expect(result.gids).toBe('1 2 3 4');
        expect(
            window.fontManager.forceFullWorkerCacheUpdate
        ).not.toHaveBeenCalled();
        expect(
            window.fontManager.submitLayerUpdatesToWorkerCache
        ).not.toHaveBeenCalled();
        expect(window.fontCompilation.compileCached).not.toHaveBeenCalled();
        expect(
            window.fontCompilation.compileCommittedDebugFont
        ).not.toHaveBeenCalled();
        expect(
            window.fontCompilation.bootstrapWorkerCacheFromFontState
        ).not.toHaveBeenCalled();
        expect(window.fontCompilation.storeFontJson).not.toHaveBeenCalled();
    });

    test('reuses a matching isolated analysis result without reseeding', async () => {
        const agent = new AIAgent();
        const toolCall = {
            function: {
                name: 'compile_and_shape_font',
                arguments: JSON.stringify({ text: '0/10' })
            }
        };

        await agent.executeToolCall(toolCall);
        await agent.executeToolCall(toolCall);

        expect(
            window.fullFontCompilation.bootstrapWorkerCacheFromFontState
        ).toHaveBeenCalledTimes(1);
        expect(window.fullFontCompilation.compileCached).toHaveBeenCalledTimes(
            1
        );
        expect(
            window.fullFontCompilation.compileCommittedDebugFont
        ).toHaveBeenCalledTimes(1);
        expect(window.fontCompilation.compileCached).not.toHaveBeenCalled();
    });

    test('fails closed when the pending committed worker update rejects', async () => {
        const failedUpdate = createDeferred();
        window.fontManager.workerCacheUpdatePromise = failedUpdate.promise;
        const agent = new AIAgent();
        const toolCall = agent.executeToolCall({
            function: {
                name: 'compile_and_shape_font',
                arguments: JSON.stringify({ text: '0/10' })
            }
        });

        failedUpdate.reject(new Error('worker update failed'));

        await expect(toolCall).rejects.toThrow('worker update failed');
        expect(window.fontCompilation.compileCached).not.toHaveBeenCalled();
        expect(
            window.fontCompilation.compileCommittedDebugFont
        ).not.toHaveBeenCalled();
    });

    test('fails closed when the worker-document synchronization rejects', async () => {
        window.fontCompilation.awaitWorkerDocumentSync.mockRejectedValue(
            new Error('worker document sync failed')
        );
        const agent = new AIAgent();

        await expect(
            agent.executeToolCall({
                function: {
                    name: 'compile_and_shape_font',
                    arguments: JSON.stringify({ text: '0/10' })
                }
            })
        ).rejects.toThrow('worker document sync failed');
        expect(window.fontCompilation.compileCached).not.toHaveBeenCalled();
        expect(
            window.fontCompilation.compileCommittedDebugFont
        ).not.toHaveBeenCalled();
    });

    test('fails closed when the worker cache is not ready after synchronization', async () => {
        window.fontCompilation.hasWorkerCacheDocument.mockReturnValue(false);
        const agent = new AIAgent();

        await expect(
            agent.executeToolCall({
                function: {
                    name: 'compile_and_shape_font',
                    arguments: JSON.stringify({ text: '0/10' })
                }
            })
        ).rejects.toThrow('requires the current font to finish synchronizing');
        expect(window.fontCompilation.compileCached).not.toHaveBeenCalled();
        expect(
            window.fontCompilation.compileCommittedDebugFont
        ).not.toHaveBeenCalled();
    });

    test('rejects an active edit preview instead of compiling stale committed state', async () => {
        window.glyphCanvas.outlineEditor.draggingSomething = true;
        const agent = new AIAgent();

        await expect(
            agent.executeToolCall({
                function: {
                    name: 'compile_and_shape_font',
                    arguments: JSON.stringify({ text: '0/10' })
                }
            })
        ).rejects.toThrow('unavailable while an edit preview is active');
        expect(window.fontCompilation.compileCached).not.toHaveBeenCalled();
        expect(
            window.fontCompilation.compileCommittedDebugFont
        ).not.toHaveBeenCalled();
        expect(agent.compileAndShapeFontCache).toBeNull();
    });

    test('rejects a pending keyboard preview before compiling committed state', async () => {
        window.glyphCanvas.outlineEditor.hasPendingKeyboardPreviewCommit.mockReturnValue(
            true
        );
        const agent = new AIAgent();

        await expect(
            agent.executeToolCall({
                function: {
                    name: 'compile_and_shape_font',
                    arguments: JSON.stringify({ text: '0/10' })
                }
            })
        ).rejects.toThrow('unavailable while an edit preview is active');
        expect(window.fontCompilation.compileCached).not.toHaveBeenCalled();
        expect(
            window.fontCompilation.compileCommittedDebugFont
        ).not.toHaveBeenCalled();
    });

    test('rejects a keyboard preview that starts while worker state settles', async () => {
        const pendingUpdate = createDeferred();
        window.fontManager.workerCacheUpdatePromise = pendingUpdate.promise;
        const agent = new AIAgent();
        const toolCall = agent.executeToolCall({
            function: {
                name: 'compile_and_shape_font',
                arguments: JSON.stringify({ text: '0/10' })
            }
        });

        await Promise.resolve();
        window.glyphCanvas.outlineEditor.hasPendingKeyboardPreviewCommit.mockReturnValue(
            true
        );
        pendingUpdate.resolve();

        await expect(toolCall).rejects.toThrow(
            'unavailable while an edit preview is active'
        );
        expect(window.fontCompilation.compileCached).not.toHaveBeenCalled();
        expect(
            window.fontCompilation.compileCommittedDebugFont
        ).not.toHaveBeenCalled();
    });

    test('rejects a drag that starts while worker state settles', async () => {
        const pendingUpdate = createDeferred();
        window.fontManager.workerCacheUpdatePromise = pendingUpdate.promise;
        const agent = new AIAgent();
        const toolCall = agent.executeToolCall({
            function: {
                name: 'compile_and_shape_font',
                arguments: JSON.stringify({ text: '0/10' })
            }
        });

        await Promise.resolve();
        window.glyphCanvas.outlineEditor.draggingSomething = true;
        pendingUpdate.resolve();

        await expect(toolCall).rejects.toThrow(
            'unavailable while an edit preview is active'
        );
        expect(window.fontCompilation.compileCached).not.toHaveBeenCalled();
        expect(
            window.fontCompilation.compileCommittedDebugFont
        ).not.toHaveBeenCalled();
    });
});
