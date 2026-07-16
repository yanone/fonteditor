const {
    assertAgentFontEditAllowed,
    getActiveAgentPythonExecution,
    isAgentPythonExecutionActive,
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
});
