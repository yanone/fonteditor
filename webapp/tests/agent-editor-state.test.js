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
        window.patchSyncEngine = {};
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
        ).resolves.toBe(
            'Prompt history summary will be used for subsequent edits.'
        );

        expect(agent.activePromptContext.historySummary).toBe('Update glyphs');
    });

    test('loads the detailed Python authoring guide for each document kind', async () => {
        const originalFetch = global.fetch;
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            text: jest.fn().mockResolvedValue('authoring guide')
        });
        global.fetch = fetchMock;
        const agent = new AIAgent();

        await expect(
            agent.executeToolCall({
                function: {
                    name: 'python_authoring_guide',
                    arguments: JSON.stringify({ kind: 'general-script' })
                }
            })
        ).resolves.toBe('authoring guide');
        await expect(
            agent.executeToolCall({
                function: {
                    name: 'python_authoring_guide',
                    arguments: JSON.stringify({ kind: 'glyph-filter' })
                }
            })
        ).resolves.toBe('authoring guide');
        await expect(
            agent.executeToolCall({
                function: {
                    name: 'python_authoring_guide',
                    arguments: JSON.stringify({ kind: 'other' })
                }
            })
        ).rejects.toThrow(
            'Choose general-script or glyph-filter for the Python authoring guide.'
        );

        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            '/handbook/python/04-writing-general-scripts.md'
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            '/handbook/python/05-writing-glyph-overview-filters.md'
        );
        global.fetch = originalFetch;
    });

    test('renders every enum parameter as a selectable tool-executor field', () => {
        const { AGENT_TOOLS } = require('../js/agent-config.ts');
        const agent = new AIAgent();
        const toolsWithEnums = AGENT_TOOLS.filter(({ function: tool }) =>
            Object.values(tool.parameters.properties || {}).some((schema) =>
                Array.isArray(schema.enum)
            )
        );

        for (const tool of toolsWithEnums) {
            const popup = agent.createToolInvocationPopup(tool);
            for (const [name, schema] of Object.entries(
                tool.function.parameters.properties
            )) {
                if (!Array.isArray(schema.enum)) continue;
                const selector = popup.querySelector(`select[name="${name}"]`);
                expect(selector).not.toBeNull();
                expect(
                    Array.from(selector.options).map((option) => option.value)
                ).toEqual(['', ...schema.enum]);
            }
        }
    });

    test('uses neutral invocation wording in the manual tool executor', () => {
        const { AGENT_TOOLS } = require('../js/agent-config.ts');
        const authoringGuide = AGENT_TOOLS.find(
            ({ function: tool }) => tool.name === 'python_authoring_guide'
        );
        const agent = new AIAgent();
        const popup = agent.createToolInvocationPopup(authoringGuide);

        expect(popup.textContent).toContain(
            'Fill parameters, then invoke this tool.'
        );
        expect(popup.textContent).not.toContain('live tool call');
    });

    test('rejects execute_python_code without invoking Python', async () => {
        const wrappedRunPythonAsync = jest.fn();
        const originalRunPythonAsync = jest.fn();
        window.pyodide = {
            runPythonAsync: wrappedRunPythonAsync,
            _originalRunPythonAsync: originalRunPythonAsync
        };
        const agent = new AIAgent();

        await expect(
            agent.executeToolCall({
                function: {
                    name: 'execute_python_code',
                    arguments: JSON.stringify({ code: 'print("test")' })
                }
            })
        ).rejects.toThrow('Agent tools do not execute Python code.');

        expect(wrappedRunPythonAsync).not.toHaveBeenCalled();
        expect(originalRunPythonAsync).not.toHaveBeenCalled();
    });

    test('reverts a Python tool edit only with the current revision and permission', () => {
        const replaceExactText = jest.fn(() => ({
            revision: 'revision-after-revert'
        }));
        window.scriptEditor = {
            getDocumentState: jest.fn(() => ({
                revision: 'revision-after-edit'
            })),
            replaceExactText
        };
        const agent = new AIAgent();
        agent.allowFontEdits = true;
        const meta = agent.createToolCallMetaElement(
            'replace_python_text_in_editor',
            { old_text: 'old text', new_text: 'new text' },
            'Edited /Counterpunch/Scripts/example.py (general-script)\nRevision: revision-after-edit\nModified, not saved',
            '1 ms'
        );

        meta.querySelector('[aria-label="Revert this Agent edit"]').click();

        expect(replaceExactText).toHaveBeenCalledWith(
            'new text',
            'old text',
            'revision-after-edit'
        );
        expect(meta.textContent).toContain('Agent edit reverted, not saved.');
    });

    test('does not revert a Python tool edit while Agent editing is disabled', () => {
        const replaceExactText = jest.fn();
        window.scriptEditor = {
            getDocumentState: jest.fn(() => ({
                revision: 'revision-after-edit'
            })),
            replaceExactText
        };
        const agent = new AIAgent();
        agent.allowFontEdits = false;
        const meta = agent.createToolCallMetaElement(
            'replace_python_text_in_editor',
            { old_text: 'old text', new_text: 'new text' },
            'Edited /Counterpunch/Scripts/example.py (general-script)\nRevision: revision-after-edit\nModified, not saved',
            '1 ms'
        );

        meta.querySelector('[aria-label="Revert this Agent edit"]').click();

        expect(replaceExactText).not.toHaveBeenCalled();
        expect(meta.textContent).toContain(
            'Enable editing in the Agent title bar before reverting.'
        );
    });
});
