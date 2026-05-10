/**
 * Python Post-Execution Hooks
 *
 * Sets up hooks that run after Python code execution to trigger font recompilation.
 * The dirty flag is set automatically by the object model setters when data is modified.
 */

import { Logger } from './logger';
import { fontCompilation } from './font-compilation';
import type { WorkerReplayTarget } from './change-log';
import {
    createNamedChangePairFromJsonPatchPair,
    createSyntheticChangeOperationsFromNamedChangePairs,
    type JsonPatchOperation,
    type NamedChangePair
} from './collaboration-message';
import type { TransactionCommitResult } from './patch-sync-engine';

const console = new Logger('PythonPostExecution');

let postExecutionSyncInProgress = false;
let postExecutionSyncQueued = false;

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

/**
 * Extract (glyphName, layerId) pairs from a list of operations' paths.
 * Paths look like ["glyphs","A","layers","layer-1","width"].
 */
function deriveChangedLayerTargets(
    operations: SyntheticChangeOperation[]
): WorkerReplayTarget[] {
    const targets = new Map<string, WorkerReplayTarget>();
    for (const op of operations) {
        if (op.path.length < 4) continue;
        if (op.path[0] !== 'glyphs' || op.path[2] !== 'layers') continue;
        const glyphName = String(op.path[1]);
        const layerId = String(op.path[3]);
        if (!glyphName || !layerId) continue;
        const key = `${glyphName}::${layerId}`;
        if (!targets.has(key)) {
            targets.set(key, { glyphName, layerId });
        }
    }
    return Array.from(targets.values());
}

function isLayerScopedOperation(operation: SyntheticChangeOperation): boolean {
    return (
        operation.path.length >= 4 &&
        operation.path[0] === 'glyphs' &&
        operation.path[2] === 'layers'
    );
}

function normalizeWorkerReplayTargets(
    targets: Iterable<WorkerReplayTarget>
): WorkerReplayTarget[] {
    const dedupedTargets = new Map<string, WorkerReplayTarget>();
    for (const target of targets) {
        if (!target?.glyphName || !target?.layerId) {
            continue;
        }
        dedupedTargets.set(`${target.glyphName}@@${target.layerId}`, {
            glyphName: target.glyphName,
            layerId: target.layerId
        });
    }
    return Array.from(dedupedTargets.values());
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

async function syncRustAndRecompileEditingFont(
    commitResult: TransactionCommitResult | null,
    changedTargets: WorkerReplayTarget[]
): Promise<void> {
    if (postExecutionSyncInProgress) {
        postExecutionSyncQueued = true;
        return;
    }

    postExecutionSyncInProgress = true;

    try {
        do {
            postExecutionSyncQueued = false;

            const currentFont = window.fontManager?.currentFont;
            if (!currentFont) {
                return;
            }

            const layerScopedOnly =
                !!commitResult?.changeLogEntries.length &&
                commitResult.changeLogEntries.every(
                    (entry) =>
                        normalizeWorkerReplayTargets(entry.workerReplayTargets)
                            .length > 0
                );

            if (fontCompilation?.isInitialized) {
                try {
                    const updatedIncrementally =
                        layerScopedOnly && changedTargets.length
                            ? await window.fontManager?.refreshWorkerCacheForReplayTargets(
                                  changedTargets
                              )
                            : false;

                    if (!updatedIncrementally) {
                        await fontCompilation.sendMessage({
                            type: 'storeFontJson',
                            babelfontJson: currentFont.babelfontJson
                        });
                    }
                } catch (error) {
                    console.error(
                        '[PythonPostExec] Failed to sync font JSON to Rust cache:',
                        error
                    );
                }
            }

            try {
                await window.fontManager.recompileEditingFont();
            } catch (error) {
                console.error(
                    '[PythonPostExec] Failed to recompile editing font after Python execution:',
                    error
                );
            }
        } while (postExecutionSyncQueued);
    } finally {
        postExecutionSyncInProgress = false;
    }
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
                    let commitResult: TransactionCommitResult | null = null;

                    window.patchSyncEngine.setRecordingSuppressed(false);
                    if (directOperations.length) {
                        window.patchSyncEngine.applySyntheticChangeSet(
                            window.pythonExecutionHistoryContext?.label ??
                                'Python script',
                            directOperations
                        );
                    }

                    commitResult = window.patchSyncEngine.endTransaction();
                    currentFont.syncJsonFromModel();

                    const changedTargets = normalizeWorkerReplayTargets(
                        commitResult?.workerReplayTargets?.length
                            ? commitResult.workerReplayTargets
                            : deriveChangedLayerTargets(directOperations)
                    );

                    await syncRustAndRecompileEditingFont(
                        commitResult,
                        changedTargets
                    );

                    // Refresh canvas to pick up changes if in edit mode
                    // After syncJsonFromModel, nodes arrays have been converted to strings,
                    // so we need to refetch layer data to get fresh data
                    if (window.glyphCanvas?.outlineEditor) {
                        // Refetch layer data from Rust (now synced) to get fresh data
                        await window.glyphCanvas.outlineEditor.fetchLayerData();
                        window.glyphCanvas.render();
                    }
                } else {
                    await syncRustAndRecompileEditingFont(null, []);
                }
            }
        } finally {
            window.patchSyncEngine?.setRecordingSuppressed(false);
            if (window.patchSyncEngine?.inTransaction) {
                window.patchSyncEngine.endTransaction();
            }
            window.pythonExecutionHistoryContext = null;
        }

        // Trigger font recompilation via auto-compile manager
        // The dirty flag is already set by the object model setters when data was modified
        if (window.autoCompileManager) {
            window.autoCompileManager.scheduleCompilation();
        }

        if (window.fullCompileManager) {
            window.fullCompileManager.scheduleCompilation();
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
