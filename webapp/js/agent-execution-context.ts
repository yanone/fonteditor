export type AgentPromptExecutionContext = {
    id: string;
    allowFontEdits: boolean;
    historySummary: string | null;
};

let activeAgentPythonExecution: AgentPromptExecutionContext | null = null;

export function setActiveAgentPythonExecution(
    context: AgentPromptExecutionContext | null
): void {
    activeAgentPythonExecution = context;
}

export function getActiveAgentPythonExecution(): AgentPromptExecutionContext | null {
    return activeAgentPythonExecution;
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
