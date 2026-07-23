import { getActiveAssistantPythonExecution } from './assistant-execution-context';

/** Reject font-model writes while a read-only Assistant Python execution is active. */
export function assertModelMutationAllowed(): void {
    if (getActiveAssistantPythonExecution()?.allowFontEdits === false) {
        throw new Error(
            'Assistant font editing is disabled for this prompt. You may inspect font data, but you cannot modify the font.'
        );
    }
}
