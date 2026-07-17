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

describe('split binary-font agent tools', () => {
    let AIAgent;

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
        window.fontManager = {
            currentFont: {
                sourcePlugin: { getId: jest.fn(() => 'memory') },
                path: 'memory:///font.glyphs',
                changeVersion: 1
            },
            deriveSubsetGlyphsFromText: jest.fn(() => ['A', 'B']),
            workerCacheUpdatePromise: null,
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([9, 8, 7]))
        };
        window.fontCompilation = {
            awaitWorkerDocumentSync: jest.fn().mockResolvedValue(),
            hasWorkerCacheDocument: jest.fn(() => true),
            compileBinaryFont: jest.fn(),
            compileCached: jest.fn(),
            compileCommittedDebugFont: jest.fn(),
            storeFontJson: jest.fn()
        };
        window.fullFontCompilation = {
            awaitWorkerDocumentSync: jest.fn().mockResolvedValue(),
            hasWorkerCacheDocument: jest.fn(() => true),
            bootstrapWorkerCacheFromFontState: jest.fn().mockResolvedValue(),
            compileBinaryFont: jest
                .fn()
                .mockResolvedValue({ fontHash: 'binary-hash-1' }),
            compileCommittedDebugFont: jest.fn().mockResolvedValue({
                result: new Uint8Array([4, 5, 6]),
                filename: 'debug-font.ttf',
                time_taken: 1,
                fontHash: 'editing-hash-1',
                closureGlyphCount: 2
            }),
            getDebugCachedFontBytes: jest
                .fn()
                .mockResolvedValue(new Uint8Array([4, 5, 6])),
            inspectDebugCachedFont: jest.fn().mockResolvedValue({
                values: [1000, 42]
            })
        };
        window.shapeTextWithFontDetailed = jest.fn(async () => ({
            glyphs: ['A'],
            gids: [36],
            advances: [600],
            advancesY: [0],
            offsetsX: [0],
            offsetsY: [0],
            clusters: [0]
        }));
        window.windowRole = { isMainWindow: jest.fn(() => true) };
        window.glyphCanvas = {
            outlineEditor: {
                draggingSomething: false,
                isPreviewMode: false,
                hasPendingKeyboardPreviewCommit: jest.fn(() => false)
            }
        };
    });

    test('compiles only after worker settlement, seeds the isolated worker, and returns a hash', async () => {
        const pendingUpdate = createDeferred();
        window.fontManager.workerCacheUpdatePromise = pendingUpdate.promise;
        const agent = new AIAgent();
        const toolCall = agent.executeToolCall({
            function: {
                name: 'compile_binary_font',
                arguments: JSON.stringify({ target: 'full' })
            }
        });

        await Promise.resolve();
        expect(
            window.fullFontCompilation.compileBinaryFont
        ).not.toHaveBeenCalled();
        pendingUpdate.resolve();

        await expect(toolCall).resolves.toBe('binary-hash-1');
        expect(
            window.fullFontCompilation.bootstrapWorkerCacheFromFontState
        ).toHaveBeenCalledWith(expect.any(Uint8Array));
        expect(
            window.fullFontCompilation.compileBinaryFont
        ).toHaveBeenCalledWith(
            'full',
            'agent-binary-font.ttf',
            expect.objectContaining({
                awaitWorkerDocumentSync: expect.any(Function),
                hasWorkerCacheDocument: expect.any(Function)
            })
        );
        expect(window.fontCompilation.compileBinaryFont).not.toHaveBeenCalled();
        expect(window.fontCompilation.storeFontJson).not.toHaveBeenCalled();
    });

    test('shape reads the requested hash and never compiles implicitly', async () => {
        const agent = new AIAgent();

        const result = JSON.parse(
            await agent.executeToolCall({
                function: {
                    name: 'shape_binary_font',
                    arguments: JSON.stringify({
                        fontHash: 'binary-hash-1',
                        text: 'A',
                        features: { kern: true, liga: false },
                        variationLocation: { wght: 500 }
                    })
                }
            })
        );

        expect(result.fontHash).toBe('binary-hash-1');
        expect(result.glyphs).toEqual(['A']);
        expect(
            window.fullFontCompilation.getDebugCachedFontBytes
        ).toHaveBeenCalledWith('binary-hash-1');
        expect(
            window.fullFontCompilation.compileBinaryFont
        ).not.toHaveBeenCalled();
    });

    test('subset target derives subset glyphs from text before compiling', async () => {
        const agent = new AIAgent();

        await expect(
            agent.executeToolCall({
                function: {
                    name: 'compile_binary_font',
                    arguments: JSON.stringify({
                        target: 'subset',
                        text: 'AB'
                    })
                }
            })
        ).resolves.toBe('editing-hash-1');

        expect(
            window.fontManager.deriveSubsetGlyphsFromText
        ).toHaveBeenCalledWith('AB');
        expect(
            window.fullFontCompilation.compileCommittedDebugFont
        ).toHaveBeenCalledWith(['A', 'B']);
        expect(
            window.fullFontCompilation.compileBinaryFont
        ).not.toHaveBeenCalled();
    });

    test('subset target requires text', async () => {
        const agent = new AIAgent();

        await expect(
            agent.executeToolCall({
                function: {
                    name: 'compile_binary_font',
                    arguments: JSON.stringify({ target: 'subset' })
                }
            })
        ).rejects.toThrow('target "subset" requires text (string).');
    });

    test('rejects non-object feature input for shape_binary_font', async () => {
        const agent = new AIAgent();

        await expect(
            agent.executeToolCall({
                function: {
                    name: 'shape_binary_font',
                    arguments: JSON.stringify({
                        fontHash: 'binary-hash-1',
                        text: 'A',
                        features: 'kern=1'
                    })
                }
            })
        ).rejects.toThrow('features must be an object when provided.');
    });

    test('inspection requires API docs, then preserves requested path order', async () => {
        const agent = new AIAgent();
        const inspection = {
            function: {
                name: 'inspect_binary_font',
                arguments: JSON.stringify({
                    fontHash: 'binary-hash-1',
                    fontIndex: 0,
                    paths: ['/tables/head/unitsPerEm', '/tables/maxp/numGlyphs']
                })
            }
        };

        await expect(agent.executeToolCall(inspection)).rejects.toThrow(
            'binary_font_api_docs'
        );
        await agent.executeToolCall({
            function: {
                name: 'binary_font_api_docs',
                arguments: '{}'
            }
        });

        await expect(agent.executeToolCall(inspection)).resolves.toBe(
            JSON.stringify({ values: [1000, 42] })
        );
        expect(
            window.fullFontCompilation.inspectDebugCachedFont
        ).toHaveBeenCalledWith('binary-hash-1', {
            fontIndex: 0,
            paths: ['/tables/head/unitsPerEm', '/tables/maxp/numGlyphs']
        });
        expect(
            window.fullFontCompilation.compileBinaryFont
        ).not.toHaveBeenCalled();
    });

    test.each([
        'compile_binary_font',
        'shape_binary_font',
        'inspect_binary_font'
    ])('rejects %s in a linked window or active preview', async (name) => {
        const agent = new AIAgent();
        const args =
            name === 'compile_binary_font'
                ? {}
                : name === 'shape_binary_font'
                  ? { fontHash: 'binary-hash-1', text: 'A' }
                  : {
                        fontHash: 'binary-hash-1',
                        paths: ['/tables/head/unitsPerEm']
                    };

        window.windowRole.isMainWindow.mockReturnValue(false);
        await expect(
            agent.executeToolCall({
                function: { name, arguments: JSON.stringify(args) }
            })
        ).rejects.toThrow('main window');

        window.windowRole.isMainWindow.mockReturnValue(true);
        window.glyphCanvas.outlineEditor.draggingSomething = true;
        await expect(
            agent.executeToolCall({
                function: { name, arguments: JSON.stringify(args) }
            })
        ).rejects.toThrow('edit preview');
    });

    test('fails visibly when a requested hash is absent', async () => {
        window.fullFontCompilation.getDebugCachedFontBytes.mockRejectedValue(
            new Error('Debug cached font bytes not found')
        );
        const agent = new AIAgent();

        await expect(
            agent.executeToolCall({
                function: {
                    name: 'shape_binary_font',
                    arguments: JSON.stringify({
                        fontHash: 'missing-hash',
                        text: 'A'
                    })
                }
            })
        ).rejects.toThrow('Debug cached font bytes not found');
        expect(
            window.fullFontCompilation.compileBinaryFont
        ).not.toHaveBeenCalled();
    });

    test('fails closed when committed worker synchronization rejects', async () => {
        window.fontCompilation.awaitWorkerDocumentSync.mockRejectedValue(
            new Error('worker document sync failed')
        );
        const agent = new AIAgent();

        await expect(
            agent.executeToolCall({
                function: {
                    name: 'compile_binary_font',
                    arguments: '{}'
                }
            })
        ).rejects.toThrow('worker document sync failed');
        expect(
            window.fullFontCompilation.compileBinaryFont
        ).not.toHaveBeenCalled();
    });

    test('fails closed when the editing worker cache is not ready', async () => {
        window.fontCompilation.hasWorkerCacheDocument.mockReturnValue(false);
        const agent = new AIAgent();

        await expect(
            agent.executeToolCall({
                function: {
                    name: 'compile_binary_font',
                    arguments: '{}'
                }
            })
        ).rejects.toThrow('requires the current font to finish synchronizing');
        expect(
            window.fullFontCompilation.compileBinaryFont
        ).not.toHaveBeenCalled();
    });

    test('rejects a preview that starts while worker state settles', async () => {
        const pendingUpdate = createDeferred();
        window.fontManager.workerCacheUpdatePromise = pendingUpdate.promise;
        const agent = new AIAgent();
        const toolCall = agent.executeToolCall({
            function: {
                name: 'compile_binary_font',
                arguments: '{}'
            }
        });

        await Promise.resolve();
        window.glyphCanvas.outlineEditor.draggingSomething = true;
        pendingUpdate.resolve();

        await expect(toolCall).rejects.toThrow(
            'unavailable while an edit preview is active'
        );
        expect(
            window.fullFontCompilation.compileBinaryFont
        ).not.toHaveBeenCalled();
    });
});
