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

    test('renders replace_python_text_in_editor diffs inline in chat', async () => {
        const agent = new AIAgent();
        agent.promptInput.value = 'Update script';
        agent.messagesContainer = document.getElementById('agent-messages');
        const oldText = [
            '# Show init/medi/fina glyphs',
            '# Keywords: arabic, positional, initial, medial, final',
            '',
            'GROUPS = {',
            "    'init': {'description': 'Initial forms (.init)', 'color': '#E65100'},",
            "    'medi': {'description': 'Medial forms (.medi)', 'color': '#1565C0'},",
            "    'fina': {'description': 'Final forms (.fina)', 'color': '#2E7D32'}",
            '}',
            '',
            '',
            'def filter_glyphs(font):',
            '    for glyph in font.glyphs:'
        ].join('\n');
        const newText = [
            '# Show init/medi/fina/isol glyphs',
            '# Keywords: arabic, positional, initial, medial, final, isolated',
            '',
            'GROUPS = {',
            "    'init': {'description': 'Initial forms (.init)', 'color': '#E65100'},",
            "    'medi': {'description': 'Medial forms (.medi)', 'color': '#1565C0'},",
            "    'fina': {'description': 'Final forms (.fina)', 'color': '#2E7D32'},",
            "    'isol': {'description': 'Isolated forms (.isol)', 'color': '#6A1B9A'}",
            '}',
            '',
            '',
            'def filter_glyphs(font):',
            '    for glyph in font.glyphs:'
        ].join('\n');
        agent.streamRound = jest
            .fn()
            .mockResolvedValueOnce({
                text: '',
                toolCalls: [
                    {
                        id: 'tool-1',
                        function: {
                            name: 'replace_python_text_in_editor',
                            arguments: JSON.stringify({
                                old_text: oldText,
                                new_text: newText,
                                expected_revision: 'revision-before-edit'
                            })
                        }
                    }
                ],
                done: true
            })
            .mockResolvedValueOnce({
                text: 'Done.',
                toolCalls: [],
                done: true
            });
        agent.executeToolCall = jest
            .fn()
            .mockResolvedValue(
                [
                    'Edited /Counterpunch/Scripts/example.py (general-script)',
                    'Revision: revision-after-edit',
                    'Modified, not saved',
                    '',
                    '@@ Script Editor @@',
                    '-raw fallback should not be displayed',
                    '+raw fallback should not be displayed'
                ].join('\n')
            );

        await agent.sendPrompt();

        const inlineDiff = agent.messagesContainer.querySelector(
            '.agent-python-edit-diff'
        );
        expect(inlineDiff).not.toBeNull();
        expect(inlineDiff.textContent).toContain('Python edit diff');
        expect(inlineDiff.textContent).toContain(
            '# Show init/medi/fina glyphs'
        );
        expect(inlineDiff.textContent).toContain(
            '# Show init/medi/fina/isol glyphs'
        );
        expect(inlineDiff.textContent).toContain(
            "    'isol': {'description': 'Isolated forms (.isol)', 'color': '#6A1B9A'}"
        );
        expect(inlineDiff.textContent).toContain('unchanged lines hidden');
        expect(inlineDiff.textContent).not.toContain(
            'raw fallback should not be displayed'
        );
        expect(
            inlineDiff.querySelectorAll('.agent-python-edit-diff-row-added')
                .length
        ).toBeGreaterThan(0);
        expect(
            inlineDiff.querySelectorAll('.agent-python-edit-diff-row-removed')
                .length
        ).toBeGreaterThan(0);
    });

    test('validates Python syntax without running the document', async () => {
        const globals = new Map();
        const originalRunPython = jest.fn(() =>
            JSON.stringify({ valid: true, message: 'Python syntax is valid.' })
        );
        const wrappedRunPython = jest.fn();
        const wrappedRunPythonAsync = jest.fn();
        window.pyodide = {
            _originalRunPython: originalRunPython,
            runPython: wrappedRunPython,
            runPythonAsync: wrappedRunPythonAsync,
            globals: {
                set: jest.fn((key, value) => globals.set(key, value)),
                delete: jest.fn((key) => globals.delete(key))
            }
        };
        window.scriptEditor = {
            getDocumentState: jest.fn(() => ({
                kind: 'general-script',
                path: '/Counterpunch/Scripts/example.py',
                revision: 'revision-valid',
                content: 'print("not run during validation")'
            }))
        };
        const agent = new AIAgent();

        const result = JSON.parse(
            await agent.executeToolCall({
                function: {
                    name: 'validate_python_document',
                    arguments: '{}'
                }
            })
        );

        expect(result).toMatchObject({
            valid: true,
            syntaxChecked: true,
            syntaxValid: true,
            structureValid: true,
            kind: 'general-script',
            editorKind: 'general-script',
            kindConfidence: 'saved-path',
            message:
                'Python syntax and static structure are valid. Python was not run.'
        });
        expect(originalRunPython).toHaveBeenCalledWith(
            expect.stringContaining(
                'compile(source, "<script-editor>", "exec")'
            )
        );
        expect(
            globals.get('__counterpunch_agent_python_validation_source')
        ).toBe(undefined);
        expect(wrappedRunPython).not.toHaveBeenCalled();
        expect(wrappedRunPythonAsync).not.toHaveBeenCalled();
    });

    test('reports pathless default Python buffers as unclassified', async () => {
        window.pyodide = {
            _originalRunPython: jest.fn(() =>
                JSON.stringify({
                    valid: true,
                    message: 'Python syntax is valid.'
                })
            ),
            globals: {
                set: jest.fn(),
                delete: jest.fn()
            }
        };
        window.scriptEditor = {
            getDocumentState: jest.fn(() => ({
                kind: 'general-script',
                path: null,
                revision: 'script-0',
                content: 'print("unsaved")'
            }))
        };
        const agent = new AIAgent();

        const activeDocument = JSON.parse(
            await agent.executeToolCall({
                function: {
                    name: 'get_active_python_document',
                    arguments: '{}'
                }
            })
        );
        const validation = JSON.parse(
            await agent.executeToolCall({
                function: {
                    name: 'validate_python_document',
                    arguments: '{}'
                }
            })
        );

        expect(activeDocument).toMatchObject({
            kind: null,
            editorKind: 'general-script',
            kindConfidence: 'unclassified-unsaved'
        });
        expect(activeDocument.kindMessage).toContain(
            'editor fallback is general-script'
        );
        expect(validation).toMatchObject({
            kind: null,
            editorKind: 'general-script',
            kindConfidence: 'unclassified-unsaved',
            valid: true,
            syntaxValid: true,
            structureValid: true
        });
        expect(validation.message).toContain(
            'editor fallback is general-script'
        );
        expect(validation.message).toContain(
            'must not treat that as authoritative'
        );
    });

    test('reports Python syntax errors from validation', async () => {
        const globals = new Map();
        window.pyodide = {
            _originalRunPython: jest.fn(() =>
                JSON.stringify({
                    valid: false,
                    message: "expected ':'",
                    line: 1,
                    offset: 23,
                    text: 'def filter_glyphs(font)'
                })
            ),
            globals: {
                set: jest.fn((key, value) => globals.set(key, value)),
                delete: jest.fn((key) => globals.delete(key))
            }
        };
        window.scriptEditor = {
            getDocumentState: jest.fn(() => ({
                kind: 'glyph-filter',
                revision: 'revision-invalid',
                content: 'def filter_glyphs(font)\n    yield {}'
            }))
        };
        const agent = new AIAgent();

        const result = JSON.parse(
            await agent.executeToolCall({
                function: {
                    name: 'validate_python_document',
                    arguments: '{}'
                }
            })
        );

        expect(result).toMatchObject({
            valid: false,
            syntaxChecked: true,
            syntaxValid: false,
            structureValid: false,
            syntaxError: {
                message: "expected ':'",
                line: 1,
                offset: 23,
                text: 'def filter_glyphs(font)'
            }
        });
        expect(result.message).toContain(
            "Python syntax error on line 1, column 23: expected ':'"
        );
        expect(result.message).toContain(
            'Glyph filters must define filter_glyphs(font).'
        );
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
