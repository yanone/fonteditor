export type AgentPromptExecutionContext = {
    id: string;
    allowFontEdits: boolean;
    historySummary: string | null;
    commitState?: 'none' | 'committed' | 'partial';
    settled?: Promise<void>;
};

let activeAgentPythonExecution: AgentPromptExecutionContext | null = null;
let agentPythonExecutionQueue: Promise<void> = Promise.resolve();

export function setActiveAgentPythonExecution(
    context: AgentPromptExecutionContext | null
): void {
    activeAgentPythonExecution = context;
}

export function getActiveAgentPythonExecution(): AgentPromptExecutionContext | null {
    return activeAgentPythonExecution;
}

/** Run one agent-owned Python execution without allowing lifecycle overlap. */
export function runAgentPythonExecution<T>(
    context: AgentPromptExecutionContext,
    run: () => Promise<T>
): Promise<T> {
    const execution = agentPythonExecutionQueue.then(async () => {
        if (activeAgentPythonExecution) {
            throw new Error('An agent Python execution is already active.');
        }
        activeAgentPythonExecution = {
            ...context,
            commitState: 'none',
            settled: Promise.resolve()
        };
        try {
            return await run();
        } finally {
            activeAgentPythonExecution = null;
        }
    });
    agentPythonExecutionQueue = execution.then(
        () => undefined,
        () => undefined
    );
    return execution;
}

/** Record the exact committed-packet completion owned by the active execution. */
export function setActiveAgentPythonExecutionCommit(
    state: 'committed' | 'partial',
    settled: Promise<void>
): void {
    if (!activeAgentPythonExecution) {
        return;
    }
    activeAgentPythonExecution.commitState = state;
    activeAgentPythonExecution.settled = settled;
}

/** Wait for the active execution's own committed Yjs refresh, if any. */
export function awaitActiveAgentPythonExecutionSettled(): Promise<void> {
    return activeAgentPythonExecution?.settled ?? Promise.resolve();
}

export function isAgentPythonExecutionActive(): boolean {
    return activeAgentPythonExecution !== null;
}

export function assertAgentFontEditAllowed(): void {
    if (activeAgentPythonExecution?.allowFontEdits === false) {
        throw new Error(
            'Agent font editing is disabled for this prompt. You may inspect font data or change editor UI state, but you cannot modify the font.'
        );
    }
}
