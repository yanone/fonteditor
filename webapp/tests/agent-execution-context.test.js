const {
    assertAgentFontEditAllowed,
    getActiveAgentPythonExecution,
    isAgentPythonExecutionActive,
    runAgentPythonExecution,
    setActiveAgentPythonExecution
} = require('../js/agent-execution-context.ts');

describe('agent execution context', () => {
    afterEach(() => setActiveAgentPythonExecution(null));

    test('rejects persistent font edits during a frozen read-only prompt', () => {
        setActiveAgentPythonExecution({
            id: 'prompt-1',
            allowFontEdits: false,
            historySummary: null
        });

        expect(isAgentPythonExecutionActive()).toBe(true);
        expect(getActiveAgentPythonExecution()?.id).toBe('prompt-1');
        expect(assertAgentFontEditAllowed).toThrow(
            'Agent font editing is disabled for this prompt'
        );
    });

    test('allows persistent font edits only when the frozen prompt permits them', () => {
        setActiveAgentPythonExecution({
            id: 'prompt-2',
            allowFontEdits: true,
            historySummary: 'Adjust the width'
        });

        expect(assertAgentFontEditAllowed).not.toThrow();
    });

    test('serializes agent Python executions and clears their active context', async () => {
        let releaseFirstExecution;
        const firstExecution = new Promise((resolve) => {
            releaseFirstExecution = resolve;
        });
        const order = [];

        const first = runAgentPythonExecution(
            {
                id: 'prompt-1',
                allowFontEdits: true,
                historySummary: null
            },
            async () => {
                order.push('first-start');
                await firstExecution;
                order.push('first-finish');
            }
        );
        const second = runAgentPythonExecution(
            {
                id: 'prompt-2',
                allowFontEdits: true,
                historySummary: null
            },
            async () => {
                order.push('second-start');
            }
        );

        await Promise.resolve();
        expect(order).toEqual(['first-start']);
        releaseFirstExecution();
        await Promise.all([first, second]);

        expect(order).toEqual(['first-start', 'first-finish', 'second-start']);
        expect(isAgentPythonExecutionActive()).toBe(false);
    });
});
