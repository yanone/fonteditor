// Application State Restoration from URL
// Restores application state from URL parameters on load

import { readUrlState, decodeLocation, decodeFeatures } from './url-state';
import { Logger } from './logger';
import type { GlyphCanvas } from './glyph-canvas';
import type { UserspaceLocation } from './locations';
import { enableSync, initStateSync } from './state-sync';

const console = new Logger('StateRestore');
let startupStateReady = false;
let startupStateReadyPromise: Promise<void> | null = null;

function waitForNextAnimationFrame(): Promise<void> {
    return new Promise((resolve) => {
        requestAnimationFrame(() => resolve());
    });
}

/** True after the first open's URL/state restore has finished. */
export function isStartupStateReady(): boolean {
    return startupStateReady;
}

/** Clear startup gate so the next font open re-runs URL/state restore. */
export function resetStartupStateReady(): void {
    startupStateReady = false;
    startupStateReadyPromise = null;
}

export async function ensureStartupStateReady(
    glyphCanvas: GlyphCanvas
): Promise<void> {
    if (startupStateReady) {
        return;
    }

    if (startupStateReadyPromise) {
        return startupStateReadyPromise;
    }

    startupStateReadyPromise = (async () => {
        try {
            if (!(glyphCanvas as any).hasInitializedStateSync) {
                (glyphCanvas as any).hasInitializedStateSync = true;
                initStateSync(glyphCanvas);
            }

            await restoreStateFromUrl(glyphCanvas);
            await waitForNextAnimationFrame();
            await waitForNextAnimationFrame();

            startupStateReady = true;
        } finally {
            enableSync();
        }
    })();

    try {
        await startupStateReadyPromise;
    } finally {
        if (!startupStateReady) {
            startupStateReadyPromise = null;
        }
    }
}

/**
 * Restore application state from URL parameters
 * Call this after font is loaded and glyphCanvas is ready
 * Writes to StateManager first, then applies to managers
 */
export async function restoreStateFromUrl(
    glyphCanvas: GlyphCanvas
): Promise<void> {
    const urlState = readUrlState();

    if (Object.keys(urlState).length === 0) {
        console.log('No state to restore from URL');
        return;
    }

    console.log('Restoring state from URL:', urlState);

    if (!window.stateManager) {
        console.error('StateManager not initialized!');
        return;
    }

    // Note: Sync is already disabled during initialization
    // It will be re-enabled after this function completes

    try {
        // Load URL state into StateManager (flat structure)

        // 0. Restore file URI
        if (urlState.file) {
            window.stateManager.editor_file = urlState.file;
        }

        // 1. Restore features from URL
        if (urlState.features !== undefined) {
            const features = urlState.features
                ? decodeFeatures(urlState.features)
                : [];

            // Convert array to object {liga: true, kern: false, ...}
            const featureSettings: Record<string, boolean> = {};
            if (features && features.length > 0) {
                for (const tag of features) {
                    featureSettings[tag] = true;
                }
            }
            window.stateManager.editor_opentype_features_in_subset =
                featureSettings;
            window.stateManager.editor_opentype_features_not_in_subset = {};
        }

        // 2. Restore userspace variation location
        if (urlState.location) {
            const location = decodeLocation(urlState.location);
            if (location) {
                // Round values to integers
                const roundedLocation: UserspaceLocation = {};
                for (const [tag, value] of Object.entries(location)) {
                    roundedLocation[tag] = Math.round(Number(value));
                }
                window.stateManager.editor_variation_location = roundedLocation;
            }
        }

        // 3. Restore text buffer
        if (urlState.text) {
            window.stateManager.editor_text_buffer = urlState.text;
        }

        // 4. Restore cursor position
        if (urlState.cursor !== null && urlState.cursor !== undefined) {
            window.stateManager.editor_cursor_position = urlState.cursor;
        }

        // 5. Restore mode (text vs editing)
        if (urlState.mode) {
            window.stateManager.editor_mode = urlState.mode;
        }

        console.log('StateManager updated');

        // Now apply the state from StateManager to the actual managers
        await applyStateToManagers(glyphCanvas);

        console.log('State restoration complete');
    } catch (error) {
        console.error('Error restoring state from URL:', error);
    }
}

/**
 * Apply state from StateManager to actual managers
 */
async function applyStateToManagers(glyphCanvas: GlyphCanvas): Promise<void> {
    // 1. Apply features FIRST (before text, as it affects shaping)
    const featuresInSubset =
        window.stateManager.editor_opentype_features_in_subset || {};
    const featuresNotInSubset =
        window.stateManager.editor_opentype_features_not_in_subset || {};
    const features = {
        ...featuresInSubset,
        ...featuresNotInSubset
    };
    if (features && glyphCanvas.featuresManager) {
        console.log('Applying features:', features);

        const enabledFeatures = Object.entries(features)
            .filter(([, enabled]) => enabled)
            .map(([tag]) => tag);

        await glyphCanvas.featuresManager.setEnabledFeatures(enabledFeatures);
        // Note: no explicit recompile here — the text buffer restore in step 3
        // calls setTextBuffer() which triggers a debounced subset compile.
    }

    // 2. Apply userspace variation location
    const location = window.stateManager.editor_variation_location;
    if (location && glyphCanvas.axesManager) {
        console.log('Applying location:', location);

        const appliedLocation: UserspaceLocation = {};

        for (const [tag, value] of Object.entries(location)) {
            const numericValue = Number(value);
            appliedLocation[tag] = numericValue;
            glyphCanvas.axesManager.setAxisValue(tag, numericValue);
        }

        // Update UI and trigger layer selection if in editing mode
        glyphCanvas.axesManager.updateAxisSliders();

        window.dispatchEvent(
            new CustomEvent('variationLocationChanged', {
                detail: { location: appliedLocation }
            })
        );

        // If we're going to be in editing mode, select matching layer
        const mode = window.stateManager.editor_mode;
        if (mode === 'edit' && glyphCanvas.outlineEditor) {
            try {
                await glyphCanvas.outlineEditor.autoSelectMatchingLayer();
            } catch (error) {
                console.warn(
                    'autoSelectMatchingLayer failed during restore; continuing:',
                    error
                );
            }
        }
    }

    // 3. Apply text buffer
    const textBuffer = window.stateManager.editor_text_buffer;
    if (textBuffer && glyphCanvas.textRunEditor) {
        console.log('Applying text:', textBuffer);
        glyphCanvas.textRunEditor.setTextBuffer(textBuffer);
    }

    // 4. Apply cursor position
    const cursorPosition = window.stateManager.editor_cursor_position;
    if (
        cursorPosition !== null &&
        cursorPosition !== undefined &&
        glyphCanvas.textRunEditor
    ) {
        console.log('Applying cursor position:', cursorPosition);

        const maxPos = glyphCanvas.textRunEditor.textBuffer.length;
        const cursorPos = Math.min(cursorPosition, maxPos);

        glyphCanvas.textRunEditor.cursorPosition = cursorPos;
        glyphCanvas.textRunEditor.updateCursorVisualPosition();

        // Trigger render to show cursor at restored position
        glyphCanvas.renderer?.render();
    }

    // 5. Apply mode (text vs editing)
    const mode = window.stateManager.editor_mode;
    if (mode) {
        console.log('Applying mode:', mode);

        if (mode === 'edit') {
            // Enter editing mode
            // Use cursor position to select the glyph
            let glyphIndex = cursorPosition ?? 0;

            // Ensure glyph index is within bounds
            const maxIndex = glyphCanvas.textRunEditor!.shapedGlyphs.length - 1;
            glyphIndex = Math.max(0, Math.min(glyphIndex, maxIndex));

            console.log('Selecting glyph at index:', glyphIndex);
            try {
                await glyphCanvas.textRunEditor!.selectGlyphByIndex(glyphIndex);
            } catch (error) {
                console.warn(
                    'selectGlyphByIndex failed during restore; continuing in edit mode when possible:',
                    error
                );
            }

            // Activate editing mode
            if (glyphCanvas.textRunEditor!.selectedGlyphIndex >= 0) {
                glyphCanvas.outlineEditor.active = true;

                // Ensure layer data + render metrics are initialized on startup restore.
                // Without this, metric underlay lines may not appear until a manual layer switch.
                if (glyphCanvas.outlineEditor.selectedLayerId !== null) {
                    try {
                        await glyphCanvas.outlineEditor.fetchLayerData(true);
                    } catch (error) {
                        console.warn(
                            'fetchLayerData failed during restore; continuing:',
                            error
                        );
                    }
                } else {
                    try {
                        await glyphCanvas.outlineEditor.interpolateCurrentGlyph(
                            true
                        );
                    } catch (error) {
                        console.warn(
                            'interpolateCurrentGlyph failed during restore; continuing:',
                            error
                        );
                    }
                }

                glyphCanvas.renderer?.render();
            } else {
                // If glyph selection failed, keep state as text mode to avoid inconsistent UI
                glyphCanvas.outlineEditor.active = false;
                glyphCanvas.renderer?.render();
            }
        } else {
            // Ensure we're in text mode
            glyphCanvas.outlineEditor.active = false;
            try {
                await glyphCanvas.autoSelectMatchingMaster();
                glyphCanvas.alignTextModeEscapeStateWithCurrentMaster();
            } catch (error) {
                console.warn(
                    'autoSelectMatchingMaster failed during text-mode restore; continuing:',
                    error
                );
            }
            glyphCanvas.renderer?.render();
        }
    } else if (!glyphCanvas.outlineEditor.active) {
        try {
            await glyphCanvas.autoSelectMatchingMaster();
            glyphCanvas.alignTextModeEscapeStateWithCurrentMaster();
        } catch (error) {
            console.warn(
                'autoSelectMatchingMaster failed during default text-mode restore; continuing:',
                error
            );
        }
    }
}

// Export for use in window
(window as any).restoreStateFromUrl = restoreStateFromUrl;
