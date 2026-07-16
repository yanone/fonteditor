describe('AI assistant Python execution', () => {
    afterEach(() => {
        jest.resetModules();
        delete window.pyodide;
        delete window.patchSyncEngine;
        delete window.fontManager;
        delete window.beforePythonExecution;
    });

    test('uses the active prompt identity for generated Python changes', async () => {
        let AIAssistant;
        let setActiveAgentPythonExecution;
        jest.isolateModules(() => {
            ({ AIAssistant } = require('../js/ai-assistant.ts'));
            ({
                setActiveAgentPythonExecution
            } = require('../js/agent-execution-context.ts'));
            require('../js/python-ui-sync.ts');
        });

        const beginTransaction = jest.fn();
        window.patchSyncEngine = {
            beginTransaction,
            setRecordingSuppressed: jest.fn()
        };
        window.fontManager = {
            currentFont: {
                babelfontData: { glyphs: [] }
            }
        };
        window.pyodide = {
            _originalRunPythonAsync: jest.fn(async () => '(no output)'),
            runPythonAsync: jest.fn(async (code) => {
                await window.beforePythonExecution(code);
            })
        };

        const assistant = Object.create(AIAssistant.prototype);
        assistant.activePromptExecutionContext = {
            id: 'assistant-prompt-1',
            allowFontEdits: true,
            historySummary: 'Assistant changes'
        };

        await assistant.executePython('font.features.features.reverse()');

        expect(beginTransaction).toHaveBeenCalledWith(
            'Assistant changes',
            null,
            {
                historyItemId: 'assistant-prompt-1',
                promptGroupId: 'assistant-prompt-1',
                historySummary: 'Assistant changes'
            }
        );
        expect(window.pyodide.runPythonAsync).toHaveBeenCalledTimes(1);
        setActiveAgentPythonExecution(null);
    });

    test('waits for its own committed refresh before resolving', async () => {
        let AIAssistant;
        let setActiveAgentPythonExecutionCommit;
        jest.isolateModules(() => {
            ({ AIAssistant } = require('../js/ai-assistant.ts'));
            ({
                setActiveAgentPythonExecutionCommit
            } = require('../js/agent-execution-context.ts'));
        });

        let resolveCommittedRefresh;
        const committedRefresh = new Promise((resolve) => {
            resolveCommittedRefresh = resolve;
        });
        window.pyodide = {
            _originalRunPythonAsync: jest.fn(async () => '(no output)'),
            runPythonAsync: jest.fn(async (code) => {
                if (code === 'font.features.features.reverse()') {
                    setActiveAgentPythonExecutionCommit(
                        'committed',
                        committedRefresh
                    );
                }
            })
        };

        const assistant = Object.create(AIAssistant.prototype);
        assistant.activePromptExecutionContext = {
            id: 'assistant-prompt-2',
            allowFontEdits: true,
            historySummary: 'Assistant changes'
        };

        let didResolve = false;
        const execution = assistant
            .executePython('font.features.features.reverse()')
            .then(() => {
                didResolve = true;
            });

        await Promise.resolve();
        await Promise.resolve();
        expect(didResolve).toBe(false);

        resolveCommittedRefresh();
        await execution;
        expect(didResolve).toBe(true);
    });

    test('restores stdout when its committed refresh rejects', async () => {
        let AIAssistant;
        let setActiveAgentPythonExecutionCommit;
        jest.isolateModules(() => {
            ({ AIAssistant } = require('../js/ai-assistant.ts'));
            ({
                setActiveAgentPythonExecutionCommit
            } = require('../js/agent-execution-context.ts'));
        });

        const committedRefreshError = new Error('Committed refresh failed');
        const runInternalPythonAsync = jest.fn(async () => '(no output)');
        window.pyodide = {
            _originalRunPythonAsync: runInternalPythonAsync,
            runPythonAsync: jest.fn(async (code) => {
                if (code === 'font.features.features.reverse()') {
                    setActiveAgentPythonExecutionCommit(
                        'committed',
                        Promise.reject(committedRefreshError)
                    );
                }
            })
        };

        const assistant = Object.create(AIAssistant.prototype);
        assistant.activePromptExecutionContext = {
            id: 'assistant-prompt-3',
            allowFontEdits: true,
            historySummary: 'Assistant changes'
        };

        await expect(
            assistant.executePython('font.features.features.reverse()')
        ).rejects.toThrow('Committed refresh failed');
        expect(runInternalPythonAsync).toHaveBeenCalledWith(
            expect.stringContaining("if '_original_stdout' in dir()")
        );
    });

    test('reports a partial commit when its committed refresh rejects', async () => {
        let AIAssistant;
        let setActiveAgentPythonExecutionCommit;
        jest.isolateModules(() => {
            ({ AIAssistant } = require('../js/ai-assistant.ts'));
            ({
                setActiveAgentPythonExecutionCommit
            } = require('../js/agent-execution-context.ts'));
        });

        const committedRefreshError = new Error('Committed refresh failed');
        window.pyodide = {
            _originalRunPythonAsync: jest.fn(async () => '(no output)'),
            runPythonAsync: jest.fn(async (code) => {
                if (code === 'font.features.features.reverse()') {
                    setActiveAgentPythonExecutionCommit(
                        'partial',
                        Promise.reject(committedRefreshError)
                    );
                    throw new Error('Python failed after changing features');
                }
            })
        };

        const assistant = Object.create(AIAssistant.prototype);
        assistant.activePromptExecutionContext = {
            id: 'assistant-prompt-4',
            allowFontEdits: true,
            historySummary: 'Assistant changes'
        };

        await expect(
            assistant.executePython('font.features.features.reverse()')
        ).resolves.toBe(
            JSON.stringify({
                error: 'Python failed after changing features',
                changesCommitted: true,
                state: 'partial',
                refreshError: 'Committed refresh failed'
            })
        );
    });

    test('reports a partial commit after a successful committed refresh', async () => {
        let AIAssistant;
        let setActiveAgentPythonExecutionCommit;
        jest.isolateModules(() => {
            ({ AIAssistant } = require('../js/ai-assistant.ts'));
            ({
                setActiveAgentPythonExecutionCommit
            } = require('../js/agent-execution-context.ts'));
        });

        window.pyodide = {
            _originalRunPythonAsync: jest.fn(async () => '(no output)'),
            runPythonAsync: jest.fn(async (code) => {
                if (code === 'font.features.features.reverse()') {
                    setActiveAgentPythonExecutionCommit(
                        'partial',
                        Promise.resolve()
                    );
                    throw new Error('Python failed after changing features');
                }
            })
        };

        const assistant = Object.create(AIAssistant.prototype);
        assistant.activePromptExecutionContext = {
            id: 'assistant-prompt-5',
            allowFontEdits: true,
            historySummary: 'Assistant changes'
        };

        await expect(
            assistant.executePython('font.features.features.reverse()')
        ).resolves.toBe(
            JSON.stringify({
                error: 'Python failed after changing features',
                changesCommitted: true,
                state: 'partial'
            })
        );
    });
});
