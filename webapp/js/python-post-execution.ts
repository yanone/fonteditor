/**
 * Python Post-Execution Hooks
 *
 * Sets up hooks that run after Python code execution to trigger font recompilation.
 * The dirty flag is set automatically by the object model setters when data is modified.
 */

import { Logger } from './logger';
import { fontCompilation } from './font-compilation';
import { collectCascadeRecomposeTargets } from './change-bridge-init';
import type { WorkerReplayTarget } from './change-log';

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

function diffFontData(
    beforeValue: unknown,
    afterValue: unknown,
    path: (string | number)[] = [],
    collectionKind: 'glyphs' | 'layers' | null = null,
    operations: SyntheticChangeOperation[] = []
): SyntheticChangeOperation[] {
    if (beforeValue === undefined && afterValue === undefined) {
        return operations;
    }

    if (beforeValue === undefined) {
        operations.push({
            op: 'add',
            path,
            oldValue: undefined,
            newValue: cloneJsonValue(afterValue)
        });
        return operations;
    }

    if (afterValue === undefined) {
        operations.push({
            op: 'remove',
            path,
            oldValue: cloneJsonValue(beforeValue),
            newValue: undefined
        });
        return operations;
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
                diffFontData(
                    beforeMap.get(key),
                    afterMap.get(key),
                    [...path, key],
                    null,
                    operations
                );
            }
            return operations;
        }

        const maxLength = Math.max(beforeValue.length, afterValue.length);
        for (let index = 0; index < maxLength; index++) {
            diffFontData(
                beforeValue[index],
                afterValue[index],
                [...path, index],
                null,
                operations
            );
        }
        return operations;
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
            diffFontData(
                beforeValue[key],
                afterValue[key],
                [...path, key],
                nextCollectionKind,
                operations
            );
        }
        return operations;
    }

    if (valuesDiffer(beforeValue, afterValue)) {
        operations.push({
            op: 'set',
            path,
            oldValue: cloneJsonValue(beforeValue),
            newValue: cloneJsonValue(afterValue)
        });
    }

    return operations;
}

async function syncRustAndRecompileEditingFont(): Promise<void> {
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

            if (fontCompilation?.isInitialized) {
                try {
                    await fontCompilation.sendMessage({
                        type: 'storeFontJson',
                        babelfontJson: currentFont.babelfontJson
                    });
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
                window.fontManager.currentFont.syncJsonFromModel();

                const beforeFontDataJson =
                    window.pythonExecutionHistoryContext?.beforeFontDataJson;
                if (beforeFontDataJson && window.patchSyncEngine) {
                    const operations = diffFontData(
                        JSON.parse(beforeFontDataJson),
                        JSON.parse(window.fontManager.currentFont.babelfontJson)
                    );
                    window.patchSyncEngine.setRecordingSuppressed(false);
                    if (operations.length) {
                        // Derive cascading recompose targets from changed layers
                        const changedTargets =
                            deriveChangedLayerTargets(operations);
                        if (changedTargets.length) {
                            const cascadeTargets =
                                collectCascadeRecomposeTargets(
                                    changedTargets,
                                    changedTargets[0]?.glyphName,
                                    changedTargets[0]?.layerId
                                );
                            if (cascadeTargets.length) {
                                operations[0].workerReplayTargets =
                                    cascadeTargets;
                            }
                        }

                        window.patchSyncEngine.applySyntheticChangeSet(
                            window.pythonExecutionHistoryContext?.label ??
                                'Python script',
                            operations
                        );
                    }
                }

                // Keep Rust-side cache in sync after Python manipulations,
                // then recompile the editing font from the updated source JSON.
                // Must complete before fetchLayerData() since it reads from Rust.
                await syncRustAndRecompileEditingFont();

                // Refresh canvas to pick up changes if in edit mode
                // After syncJsonFromModel, nodes arrays have been converted to strings,
                // so we need to refetch layer data to get fresh data
                if (window.glyphCanvas?.outlineEditor) {
                    // Refetch layer data from Rust (now synced) to get fresh data
                    await window.glyphCanvas.outlineEditor.fetchLayerData();
                    window.glyphCanvas.render();
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
