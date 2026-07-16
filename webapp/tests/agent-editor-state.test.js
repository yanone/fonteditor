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

    test('updates the active prompt transaction when recording a summary', async () => {
        window.patchSyncEngine = {
            updateTransactionMetadata: jest.fn(() => true)
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

        expect(
            window.patchSyncEngine.updateTransactionMetadata
        ).toHaveBeenCalledWith('prompt-1', 'Update glyphs', 'Update glyphs');
        expect(agent.activePromptContext.historySummary).toBe('Update glyphs');
    });

    test('marks a stopped prompt transaction as interrupted before committing', () => {
        window.patchSyncEngine = {
            updateTransactionMetadata: jest.fn(() => true),
            endTransaction: jest.fn()
        };
        const agent = new AIAgent();
        agent.activePromptContext = {
            id: 'prompt-1',
            allowFontEdits: true,
            historySummary: 'Agent changes'
        };
        agent.promptTransactionOpen = true;

        agent.finishPromptTransaction(true);

        expect(
            window.patchSyncEngine.updateTransactionMetadata
        ).toHaveBeenCalledWith(
            'prompt-1',
            'Agent changes (interrupted)',
            'Agent changes (interrupted)'
        );
        expect(window.patchSyncEngine.endTransaction).toHaveBeenCalledTimes(1);
        expect(agent.promptTransactionOpen).toBe(false);
    });

    test('releases prompt ownership without ending a mismatched transaction', () => {
        window.patchSyncEngine = {
            updateTransactionMetadata: jest.fn(() => false),
            endTransaction: jest.fn()
        };
        const agent = new AIAgent();
        agent.activePromptContext = {
            id: 'prompt-1',
            allowFontEdits: true,
            historySummary: 'Agent changes'
        };
        agent.promptTransactionOpen = true;

        expect(() => agent.finishPromptTransaction(true)).not.toThrow();
        expect(window.patchSyncEngine.endTransaction).not.toHaveBeenCalled();
        expect(agent.promptTransactionOpen).toBe(false);
    });
});
