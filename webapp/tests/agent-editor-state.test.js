jest.mock('tippy.js', () => ({
    __esModule: true,
    default: jest.fn()
}));
jest.mock('tippy.js/dist/tippy.css', () => ({}), { virtual: true });

describe('get_editor_state text-buffer interpretation', () => {
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
        window.__counterpunchPythonPostExecutionHookInstalled = true;
        window.patchSyncEngine = {
            updatePromptHistorySummary: jest.fn()
        };
        window.fontManager = { currentFontModel: { axes: [] } };
        window.stateManager = {
            getStateSnapshot: jest.fn(() => ({
                state: {
                    editor_text_buffer: '0/10',
                    editor_harfbuzz_glyph_names: '',
                    editor_harfbuzz_gids: '',
                    editor_harfbuzz_ax: '',
                    editor_harfbuzz_cl: '',
                    editor_opentype_features_in_subset: {},
                    editor_opentype_features_not_in_subset: {}
                }
            }))
        };
        window.glyphCanvas = {
            textRunEditor: {
                textBuffer: '0/10',
                displayTextBuffer: '0/10',
                explicitGlyphTokens: [],
                glyphNameBuffer: [],
                shapedGlyphs: []
            }
        };
    });

    test('reports a single slash exactly as raw state rather than inferring an escape pair', async () => {
        const agent = new AIAgent();
        const result = JSON.parse(
            await agent.executeToolCall({
                function: { name: 'get_editor_state', arguments: '{}' }
            })
        );

        expect(result).toMatchObject({
            textBuffer: '0/10',
            textBufferRaw: '0/10',
            textBufferDisplay: '0/10',
            textBufferInterpretationIsCurrent: true,
            explicitGlyphTokens: []
        });
        expect(result.textBufferRaw).not.toContain('//');
        expect(result.textBufferSyntax).toContain('Never infer //');
    });

    test('distinguishes raw escaped slashes from displayed text', async () => {
        window.stateManager.getStateSnapshot.mockReturnValue({
            state: {
                editor_text_buffer: '0//10',
                editor_opentype_features_in_subset: {},
                editor_opentype_features_not_in_subset: {}
            }
        });
        window.glyphCanvas.textRunEditor = {
            textBuffer: '0//10',
            displayTextBuffer: '0/10',
            explicitGlyphTokens: []
        };

        const agent = new AIAgent();
        const result = JSON.parse(
            await agent.executeToolCall({
                function: { name: 'get_editor_state', arguments: '{}' }
            })
        );

        expect(result.textBufferRaw).toBe('0//10');
        expect(result.textBufferDisplay).toBe('0/10');
        expect(result.explicitGlyphTokens).toEqual([]);
    });

    test('reports the current explicit glyph token interpretation', async () => {
        window.stateManager.getStateSnapshot.mockReturnValue({
            state: {
                editor_text_buffer: '0/ten',
                editor_opentype_features_in_subset: {},
                editor_opentype_features_not_in_subset: {}
            }
        });
        window.glyphCanvas.textRunEditor = {
            textBuffer: '0/ten',
            displayTextBuffer: '0/ten',
            explicitGlyphTokens: [{ name: 'ten', start: 1, end: 5 }]
        };

        const agent = new AIAgent();
        const result = JSON.parse(
            await agent.executeToolCall({
                function: { name: 'get_editor_state', arguments: '{}' }
            })
        );

        expect(result.explicitGlyphTokens).toEqual([
            { name: 'ten', start: 1, end: 5 }
        ]);
    });

    test('prefers the live shaping buffers after a skip-render feature reorder', async () => {
        window.stateManager.getStateSnapshot.mockReturnValue({
            state: {
                editor_text_buffer: '0/10',
                editor_harfbuzz_glyph_names:
                    'zero.numr fraction one.dnom zero.dnom',
                editor_harfbuzz_gids: '10 11 12 13',
                editor_harfbuzz_ax: '500 200 300 400',
                editor_harfbuzz_cl: '0 1 2 3',
                editor_opentype_features_in_subset: {},
                editor_opentype_features_not_in_subset: {}
            }
        });
        window.glyphCanvas.textRunEditor = {
            textBuffer: '0/10',
            displayTextBuffer: '0/10',
            explicitGlyphTokens: [],
            glyphNameBuffer: ['zero.zero', 'fraction', 'one.dnom', 'zero.zero'],
            shapedGlyphs: [
                { g: 20, ax: 600, cl: 0 },
                { g: 21, ax: 210, cl: 1 },
                { g: 22, ax: 310, cl: 2 },
                { g: 23, ax: 610, cl: 3 }
            ]
        };

        const agent = new AIAgent();
        const result = JSON.parse(
            await agent.executeToolCall({
                function: { name: 'get_editor_state', arguments: '{}' }
            })
        );

        expect(result).toMatchObject({
            glyphs: 'zero.zero fraction one.dnom zero.zero',
            gids: '20 21 22 23',
            advances: '600 210 310 610',
            clusters: '0 1 2 3',
            shapingStateSource: 'live-text-run'
        });
    });

    test('stores a prompt summary for the next grouped Python transaction', async () => {
        window.patchSyncEngine = {
            updatePromptHistorySummary: jest.fn()
        };
        const agent = new AIAgent();
        agent.activePromptContext = {
            id: 'prompt-1',
            allowFontEdits: true,
            historySummary: 'Agent changes'
        };

        await expect(
            agent.executeToolCall({
                function: {
                    name: 'set_prompt_history_summary',
                    arguments: JSON.stringify({ summary: 'Update glyphs' })
                }
            })
        ).resolves.toBe('Prompt history summary recorded.');

        expect(agent.activePromptContext.historySummary).toBe('Update glyphs');
        expect(
            window.patchSyncEngine.updatePromptHistorySummary
        ).toHaveBeenCalledWith('prompt-1', 'Update glyphs');
    });

    test('runs only the feature-reorder script through the Python mutation lifecycle', async () => {
        const featureReorderCode = `
font = Font()
features = font.features.features
features[16], features[17] = features[17], features[16]
        `;
        const wrappedRunPythonAsync = jest.fn(async () => undefined);
        const originalRunPythonAsync = jest
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce('zero\nfrac');
        window.pyodide = {
            runPythonAsync: wrappedRunPythonAsync,
            _originalRunPythonAsync: originalRunPythonAsync
        };
        const agent = new AIAgent();
        agent.activePromptContext = {
            id: 'prompt-feature-reorder',
            allowFontEdits: true,
            historySummary: 'Reorder features'
        };

        await expect(
            agent.executeToolCall({
                function: {
                    name: 'execute_python_code',
                    arguments: JSON.stringify({ code: featureReorderCode })
                }
            })
        ).resolves.toBe('zero\nfrac');

        expect(wrappedRunPythonAsync).toHaveBeenCalledTimes(1);
        expect(wrappedRunPythonAsync).toHaveBeenCalledWith(featureReorderCode);
        expect(originalRunPythonAsync).toHaveBeenCalledTimes(2);
        expect(agent.activePromptContext).toEqual(
            expect.objectContaining({ id: 'prompt-feature-reorder' })
        );
    });

    test('fails closed until the Python wrapper exposes its original executor', async () => {
        const wrappedRunPythonAsync = jest.fn();
        window.pyodide = {
            runPythonAsync: wrappedRunPythonAsync
        };
        const agent = new AIAgent();

        await expect(
            agent.executeToolCall({
                function: {
                    name: 'execute_python_code',
                    arguments: JSON.stringify({ code: 'print("ready")' })
                }
            })
        ).rejects.toThrow('Python execution wrapper is not ready yet');

        expect(wrappedRunPythonAsync).not.toHaveBeenCalled();
    });

    test('fails closed until the post-execution commit hook is installed', async () => {
        window.__counterpunchPythonPostExecutionHookInstalled = false;
        const wrappedRunPythonAsync = jest.fn();
        window.pyodide = {
            runPythonAsync: wrappedRunPythonAsync,
            _originalRunPythonAsync: jest.fn()
        };
        const agent = new AIAgent();

        await expect(
            agent.executeToolCall({
                function: {
                    name: 'execute_python_code',
                    arguments: JSON.stringify({ code: 'print("ready")' })
                }
            })
        ).rejects.toThrow('Python edit lifecycle is not ready yet');

        expect(wrappedRunPythonAsync).not.toHaveBeenCalled();
    });

    test('fails closed until the PatchSyncEngine is ready', async () => {
        delete window.patchSyncEngine;
        const wrappedRunPythonAsync = jest.fn();
        window.pyodide = {
            runPythonAsync: wrappedRunPythonAsync,
            _originalRunPythonAsync: jest.fn()
        };
        const agent = new AIAgent();

        await expect(
            agent.executeToolCall({
                function: {
                    name: 'execute_python_code',
                    arguments: JSON.stringify({ code: 'print("ready")' })
                }
            })
        ).rejects.toThrow('Python edit bridge is not ready yet');

        expect(wrappedRunPythonAsync).not.toHaveBeenCalled();
    });

    test('preserves the user Python error when stdout restoration fails', async () => {
        const userError = new Error('feature reorder failed');
        const wrappedRunPythonAsync = jest.fn().mockRejectedValue(userError);
        const originalRunPythonAsync = jest
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('stdout restore failed'));
        window.pyodide = {
            runPythonAsync: wrappedRunPythonAsync,
            _originalRunPythonAsync: originalRunPythonAsync
        };
        const agent = new AIAgent();
        agent.activePromptContext = {
            id: 'prompt-python-error',
            allowFontEdits: true,
            historySummary: 'Reorder features'
        };

        await expect(
            agent.executeToolCall({
                function: {
                    name: 'execute_python_code',
                    arguments: JSON.stringify({ code: 'raise Exception()' })
                }
            })
        ).rejects.toThrow('Python error: feature reorder failed');

        expect(wrappedRunPythonAsync).toHaveBeenCalledTimes(1);
        expect(originalRunPythonAsync).toHaveBeenCalledTimes(2);
    });

    test('marks a stopped prompt summary as interrupted without closing another transaction', () => {
        window.patchSyncEngine = {
            updatePromptHistorySummary: jest.fn()
        };
        const agent = new AIAgent();
        agent.activePromptContext = {
            id: 'prompt-1',
            allowFontEdits: true,
            historySummary: 'Agent changes'
        };
        agent.finishPromptTransaction(true);

        expect(agent.activePromptContext.historySummary).toBe(
            'Agent changes (interrupted)'
        );
        expect(
            window.patchSyncEngine.updatePromptHistorySummary
        ).toHaveBeenCalledWith('prompt-1', 'Agent changes (interrupted)');
        expect(agent.promptTransactionOpen).toBe(false);
    });
});
