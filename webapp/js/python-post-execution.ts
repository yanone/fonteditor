/**
 * Python Post-Execution Hooks
 *
 * Sets up hooks that run after Python code execution to translate snapshot
 * diffs into bridge operations. The shared committed-change funnel owns worker
 * sync, compilation, and overview refresh after the resulting Yjs commit.
 */

import { Logger } from './logger';
import type { WorkerReplayTarget } from './change-log';
import {
    createNamedChangePairFromJsonPatchPair,
    createSyntheticChangeOperationsFromNamedChangePairs,
    type JsonPatchOperation,
    type NamedChangePair
} from './collaboration-message';

const console = new Logger('PythonPostExecution');

type SyntheticChangeOperation = {
    op: 'set' | 'add' | 'remove';
    path: (string | number)[];
    oldValue: unknown;
    newValue: unknown;
    workerReplayTargets?: WorkerReplayTarget[];
};

function cloneJsonValue<T>(value: T): T {
    if (value === undefined) {
        return value;
    }
    return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function valuesDiffer(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) !== JSON.stringify(b);
}

type JsonPatchPair = {
    forward: JsonPatchOperation;
    inverse: JsonPatchOperation;
};

function toJsonPointerPath(path: (string | number)[]): string {
    if (!path.length) {
        return '';
    }

    return `/${path
        .map((segment) =>
            String(segment).replaceAll('~', '~0').replaceAll('/', '~1')
        )
        .join('/')}`;
}

function diffFontDataToJsonPatchPairs(
    beforeValue: unknown,
    afterValue: unknown,
    path: (string | number)[] = [],
    collectionKind: 'glyphs' | 'layers' | null = null,
    patchPairs: JsonPatchPair[] = []
): JsonPatchPair[] {
    if (beforeValue === undefined && afterValue === undefined) {
        return patchPairs;
    }

    if (beforeValue === undefined) {
        patchPairs.push({
            forward: {
                op: 'add',
                path: toJsonPointerPath(path),
                value: cloneJsonValue(afterValue)
            },
            inverse: {
                op: 'remove',
                path: toJsonPointerPath(path)
            }
        });
        return patchPairs;
    }

    if (afterValue === undefined) {
        patchPairs.push({
            forward: {
                op: 'remove',
                path: toJsonPointerPath(path)
            },
            inverse: {
                op: 'add',
                path: toJsonPointerPath(path),
                value: cloneJsonValue(beforeValue)
            }
        });
        return patchPairs;
    }

    if (Array.isArray(beforeValue) && Array.isArray(afterValue)) {
        if (collectionKind === 'glyphs' || collectionKind === 'layers') {
            const keyField = collectionKind === 'glyphs' ? 'name' : 'id';
            const beforeEntries = beforeValue.flatMap((item) => {
                if (!isPlainObject(item)) {
                    return [];
                }
                const key = String(item[keyField] ?? '');
                return key
                    ? ([[key, item]] as Array<
                          [string, Record<string, unknown>]
                      >)
                    : [];
            });
            const afterEntries = afterValue.flatMap((item) => {
                if (!isPlainObject(item)) {
                    return [];
                }
                const key = String(item[keyField] ?? '');
                return key
                    ? ([[key, item]] as Array<
                          [string, Record<string, unknown>]
                      >)
                    : [];
            });
            const beforeMap = new Map<string, Record<string, unknown>>(
                beforeEntries
            );
            const afterMap = new Map<string, Record<string, unknown>>(
                afterEntries
            );
            const keys = new Set<string>([
                ...beforeMap.keys(),
                ...afterMap.keys()
            ]);
            for (const key of keys) {
                diffFontDataToJsonPatchPairs(
                    beforeMap.get(key),
                    afterMap.get(key),
                    [...path, key],
                    null,
                    patchPairs
                );
            }
            return patchPairs;
        }

        const maxLength = Math.max(beforeValue.length, afterValue.length);
        for (let index = 0; index < maxLength; index++) {
            diffFontDataToJsonPatchPairs(
                beforeValue[index],
                afterValue[index],
                [...path, index],
                null,
                patchPairs
            );
        }
        return patchPairs;
    }

    if (isPlainObject(beforeValue) && isPlainObject(afterValue)) {
        const keys = new Set([
            ...Object.keys(beforeValue),
            ...Object.keys(afterValue)
        ]);
        for (const key of keys) {
            const nextCollectionKind =
                key === 'glyphs'
                    ? 'glyphs'
                    : key === 'layers'
                      ? 'layers'
                      : null;
            diffFontDataToJsonPatchPairs(
                beforeValue[key],
                afterValue[key],
                [...path, key],
                nextCollectionKind,
                patchPairs
            );
        }
        return patchPairs;
    }

    if (valuesDiffer(beforeValue, afterValue)) {
        patchPairs.push({
            forward: {
                op: 'replace',
                path: toJsonPointerPath(path),
                value: cloneJsonValue(afterValue)
            },
            inverse: {
                op: 'replace',
                path: toJsonPointerPath(path),
                value: cloneJsonValue(beforeValue)
            }
        });
    }

    return patchPairs;
}

function createNamedPatchPairsFromJsonSnapshots(
    beforeSnapshot: Record<string, unknown>,
    afterSnapshot: Record<string, unknown>,
    workerReplayTargets: WorkerReplayTarget[]
): NamedChangePair[] {
    const jsonPatchPairs = diffFontDataToJsonPatchPairs(
        beforeSnapshot,
        afterSnapshot
    );

    return jsonPatchPairs.map((patchPair) =>
        createNamedChangePairFromJsonPatchPair(
            patchPair.forward,
            patchPair.inverse,
            {
                forwardSnapshot:
                    patchPair.forward.op === 'remove'
                        ? beforeSnapshot
                        : afterSnapshot,
                inverseSnapshot:
                    patchPair.inverse.op === 'remove'
                        ? afterSnapshot
                        : beforeSnapshot,
                replayOldValue:
                    patchPair.inverse.op === 'remove'
                        ? undefined
                        : patchPair.inverse.value,
                replayNewValue:
                    patchPair.forward.op === 'remove'
                        ? undefined
                        : patchPair.forward.value,
                workerReplayTargets
            }
        )
    );
}

console.log('🔧 Module loaded, setting up post-execution hooks...');

// Wait for required globals to be available
function setupHooks() {
    console.log(
        '[PythonPostExec]',
        'setupHooks called, checking for autoCompileManager:',
        !!window.autoCompileManager
    );

    if (!window.autoCompileManager) {
        console.log('[PythonPostExec]', 'Waiting for autoCompileManager...');
        setTimeout(setupHooks, 500);
        return;
    }

    console.log(
        '[PythonPostExec]',
        '✅ autoCompileManager found, installing afterPythonExecution hook...'
    );

    // Save any existing hook so we can call it too (chaining)
    const existingHook = window.afterPythonExecution;
    console.log(
        '[PythonPostExec]',
        '   Existing hook:',
        typeof existingHook === 'function' ? 'found' : 'none'
    );

    /**
     * Hook that runs after every Python code execution
     * Triggers font recompilation
     */
    window.afterPythonExecution = async function () {
        try {
            // Sync changes from object model back to JSON string (for compilation)
            // The babelfontData object is already modified in place by the object model,
            // we only need to update the JSON string for the compiler
            if (window.fontManager?.currentFont) {
                const currentFont = window.fontManager.currentFont;
                currentFont.syncJsonFromModel();

                const beforeFontDataJson =
                    window.pythonExecutionHistoryContext?.beforeFontDataJson;
                if (beforeFontDataJson && window.patchSyncEngine) {
                    const beforeSnapshot = JSON.parse(
                        beforeFontDataJson
                    ) as Record<string, unknown>;
                    const firstAfterSnapshot = JSON.parse(
                        currentFont.babelfontJson
                    ) as Record<string, unknown>;
                    const initialPatchPairs = diffFontDataToJsonPatchPairs(
                        beforeSnapshot,
                        firstAfterSnapshot
                    );
                    const directOperations =
                        createSyntheticChangeOperationsFromNamedChangePairs(
                            initialPatchPairs.map((patchPair) =>
                                createNamedChangePairFromJsonPatchPair(
                                    patchPair.forward,
                                    patchPair.inverse,
                                    {
                                        forwardSnapshot:
                                            patchPair.forward.op === 'remove'
                                                ? beforeSnapshot
                                                : firstAfterSnapshot,
                                        inverseSnapshot:
                                            patchPair.inverse.op === 'remove'
                                                ? firstAfterSnapshot
                                                : beforeSnapshot
                                    }
                                )
                            )
                        );
                    window.patchSyncEngine.setRecordingSuppressed(false);
                    if (directOperations.length) {
                        window.patchSyncEngine.applySyntheticChangeSet(
                            window.pythonExecutionHistoryContext?.label ??
                                'Python script',
                            directOperations
                        );
                    }

                    window.patchSyncEngine.endTransaction();
                }
            }
        } finally {
            window.patchSyncEngine?.setRecordingSuppressed(false);
            if (window.patchSyncEngine?.inTransaction) {
                window.patchSyncEngine.endTransaction();
            }
            window.pythonExecutionHistoryContext = null;
        }

        if (typeof existingHook === 'function') {
            await existingHook();
        }
    };

    console.log(
        '[PythonPostExec]',
        '✅ Post-execution hooks installed successfully'
    );
    console.log(
        '[PythonPostExec]',
        'window.afterPythonExecution is now:',
        typeof window.afterPythonExecution
    );
}

// Start setup when DOM is ready
console.log('[PythonPostExec]', 'Document ready state:', document.readyState);
if (document.readyState === 'loading') {
    console.log('[PythonPostExec]', 'Adding DOMContentLoaded listener...');
    document.addEventListener('DOMContentLoaded', setupHooks);
} else {
    console.log(
        '[PythonPostExec]',
        'DOM already ready, calling setupHooks immediately...'
    );
    setupHooks();
}

console.log('[PythonPostExec]', '📦 Module initialization complete');

// Immediately invoke setup to ensure this code runs
// (prevents webpack from tree-shaking this module)
(function () {
    console.log('[PythonPostExec]', '🚀 IIFE executing...');
})();
