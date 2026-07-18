export type AssistantPromptExecutionContext = {
    id: string;
    allowFontEdits: boolean;
    historySummary: string | null;
    commitState?: 'none' | 'committed' | 'partial';
    settled?: Promise<void>;
};

let activeAssistantPythonExecution: AssistantPromptExecutionContext | null =
    null;
let assistantPythonExecutionQueue: Promise<void> = Promise.resolve();

export function setActiveAssistantPythonExecution(
    context: AssistantPromptExecutionContext | null
): void {
    activeAssistantPythonExecution = context;
}

export function getActiveAssistantPythonExecution(): AssistantPromptExecutionContext | null {
    return activeAssistantPythonExecution;
}

/** Run one assistant-owned Python execution without allowing lifecycle overlap. */
export function runAssistantPythonExecution<T>(
    context: AssistantPromptExecutionContext,
    run: () => Promise<T>
): Promise<T> {
    const execution = assistantPythonExecutionQueue.then(async () => {
        if (activeAssistantPythonExecution) {
            throw new Error('An assistant Python execution is already active.');
        }
        activeAssistantPythonExecution = {
            ...context,
            commitState: 'none',
            settled: Promise.resolve()
        };
        try {
            return await run();
        } finally {
            activeAssistantPythonExecution = null;
        }
    });
    assistantPythonExecutionQueue = execution.then(
        () => undefined,
        () => undefined
    );
    return execution;
}

/** Record the exact committed-packet completion owned by the active execution. */
export function setActiveAssistantPythonExecutionCommit(
    state: 'committed' | 'partial',
    settled: Promise<void>
): void {
    if (!activeAssistantPythonExecution) {
        return;
    }
    activeAssistantPythonExecution.commitState = state;
    activeAssistantPythonExecution.settled = settled;
}

/** Wait for the active execution's own committed Yjs refresh, if any. */
export function awaitActiveAssistantPythonExecutionSettled(): Promise<void> {
    return activeAssistantPythonExecution?.settled ?? Promise.resolve();
}

export function isAssistantPythonExecutionActive(): boolean {
    return activeAssistantPythonExecution !== null;
}

export function assertAssistantFontEditAllowed(): void {
    if (activeAssistantPythonExecution?.allowFontEdits === false) {
        throw new Error(
            'Assistant font editing is disabled for this prompt. You may inspect font data or change editor UI state, but you cannot modify the font.'
        );
    }
}
