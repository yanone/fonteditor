// Python-UI Synchronization Hooks
// These functions control when UI updates are paused/resumed during Python execution

import { Path } from './babelfont-model';

// Flag to skip dirty checks during font loading operations
let isLoadingFont = false;

// Debounce timer for dirty indicator updates
let dirtyCheckTimeout: ReturnType<typeof setTimeout> | null = null;

function createNormalizedFontSnapshot(): string | null {
    const currentFont = window.fontManager?.currentFont;
    if (!currentFont?.babelfontData) {
        return null;
    }

    const snapshot = JSON.parse(JSON.stringify(currentFont.babelfontData));
    for (const glyph of snapshot.glyphs || []) {
        for (const layer of glyph.layers || []) {
            for (const shape of layer.shapes || []) {
                if (Array.isArray(shape?.nodes)) {
                    shape.nodes = Path.nodesToString(shape.nodes);
                }
            }
        }
    }

    return JSON.stringify(snapshot);
}

/**
 * Called before any Python code execution begins.
 * Use this to pause UI updates and dirty tracking to avoid unnecessary redraws
 * while Python code is modifying font data.
 */
function beforePythonExecution(code?: string) {
    console.log(
        '[PythonUISync]',
        '🔒 UI updates paused (Python execution starting)'
    );
    window.pythonExecutionHistoryContext = {
        beforeFontDataJson: createNormalizedFontSnapshot(),
        code: code ?? null,
        label: 'Python script',
        startedAt: Date.now()
    };
    window.patchSyncEngine?.beginTransaction('Python script');
    window.patchSyncEngine?.setRecordingSuppressed(true);
}

/**
 * Called after Python code execution completes (success or failure).
 * Use this to resume UI updates and debounce dirty-indicator refreshes. The
 * committed-change funnel owns compilation after Python edits.
 */
function afterPythonExecution() {
    console.log(
        '[PythonUISync]',
        '🔓 UI updates resumed (Python execution finished)'
    );

    // Skip dirty checks if we're loading a font or font manager not ready
    if (isLoadingFont || !window.fontManager) {
        console.log(
            '[PythonUISync]',
            '⏭️ Skipping dirty checks (loading font or manager not ready)'
        );
        return;
    }

    // Debounce dirty indicator updates to avoid excessive calls
    if (dirtyCheckTimeout) {
        clearTimeout(dirtyCheckTimeout);
    }
    dirtyCheckTimeout = setTimeout(() => {
        if (window.fontManager) {
            window.fontManager.updateDirtyIndicator();
        }
    }, 100); // Wait 100ms after last execution before checking
}

// Make functions globally available
window.pythonExecutionHistoryContext = null;
window.beforePythonExecution = beforePythonExecution;
window.afterPythonExecution = afterPythonExecution;

// Expose flag control for font loading operations
window.setFontLoadingState = function (loading: boolean) {
    isLoadingFont = loading;
    if (!loading) {
        // After font loading completes, check dirty state once
        if (dirtyCheckTimeout) {
            clearTimeout(dirtyCheckTimeout);
        }
        dirtyCheckTimeout = setTimeout(() => {
            if (window.fontManager) {
                window.fontManager.updateDirtyIndicator();
            }
        }, 200);
    }
};
