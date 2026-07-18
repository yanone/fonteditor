const {
    assertAssistantFontEditAllowed,
    getActiveAssistantPythonExecution,
    isAssistantPythonExecutionActive,
    runAssistantPythonExecution,
    setActiveAssistantPythonExecution
} = require('../js/assistant-execution-context.ts');

describe('assistant execution context', () => {
    afterEach(() => setActiveAssistantPythonExecution(null));

    test('rejects persistent font edits during a frozen read-only prompt', () => {
        setActiveAssistantPythonExecution({
            id: 'prompt-1',
            allowFontEdits: false,
            historySummary: null
        });

        expect(isAssistantPythonExecutionActive()).toBe(true);
        expect(getActiveAssistantPythonExecution()?.id).toBe('prompt-1');
        expect(assertAssistantFontEditAllowed).toThrow(
            'Assistant font editing is disabled for this prompt'
        );
    });

    test('allows persistent font edits only when the frozen prompt permits them', () => {
        setActiveAssistantPythonExecution({
            id: 'prompt-2',
            allowFontEdits: true,
            historySummary: 'Adjust the width'
        });

        expect(assertAssistantFontEditAllowed).not.toThrow();
    });

    test('serializes assistant Python executions and clears their active context', async () => {
        let releaseFirstExecution;
        const firstExecution = new Promise((resolve) => {
            releaseFirstExecution = resolve;
        });
        const order = [];

        const first = runAssistantPythonExecution(
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
        const second = runAssistantPythonExecution(
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
        expect(isAssistantPythonExecutionActive()).toBe(false);
    });
});
