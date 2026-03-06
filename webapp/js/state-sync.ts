// Application State Synchronization
// Monitors application state changes and syncs with StateManager (which syncs to URL)

import { Logger } from './logger';
import type { GlyphCanvas } from './glyph-canvas';

const console = new Logger('StateSync');

let isInitialized = false;

/**
 * Disable URL synchronization temporarily (e.g., during state restoration)
 */
export function disableSync() {
    window.stateManager?.disableUrlSync();
    console.log('URL sync disabled');
}

/**
 * Re-enable URL synchronization
 */
export function enableSync() {
    window.stateManager?.enableUrlSync();

    // Seed StateManager with current runtime variation settings immediately.
    // Without this, editor_variation_location stays empty until the first
    // axis animation completes.
    const axesManager = window.glyphCanvas?.axesManager;
    if (axesManager && window.stateManager) {
        const location = axesManager.variationSettings || {};
        const roundedLocation: Record<string, number> = {};
        for (const [tag, value] of Object.entries(location)) {
            roundedLocation[tag] = Math.round(value);
        }
        window.stateManager.editor_variation_location = roundedLocation;
    }

    console.log('URL sync enabled');
}

/**
 * Check if URL synchronization is enabled
 */
export function isSyncEnabled(): boolean {
    return window.stateManager?.isUrlSyncEnabled() || false;
}

/**
 * Initialize state synchronization
 * Call this after glyphCanvas and fontManager are initialized
 * Bridges between legacy managers and new StateManager
 */
export function initStateSync(glyphCanvas: GlyphCanvas) {
    if (isInitialized) {
        console.warn('State sync already initialized');
        return;
    }

    isInitialized = true;
    console.log('Initializing state synchronization...');

    if (!window.stateManager) {
        console.error('StateManager not initialized!');
        return;
    }

    // Monitor text buffer changes
    if (glyphCanvas.textRunEditor) {
        glyphCanvas.textRunEditor.on('textchanged', () => {
            if (!window.stateManager.isUrlSyncEnabled()) return;

            const text = glyphCanvas.textRunEditor!.textBuffer;
            // Update StateManager, which will sync to URL
            window.stateManager.editor_text_buffer = text;
            window.stateManager.recordEvent('text_changed', 'TextRunEditor', {
                length: text.length
            });
        });

        // Monitor cursor position changes
        glyphCanvas.textRunEditor.on('cursormoved', () => {
            if (!window.stateManager.isUrlSyncEnabled()) return;

            const cursor = glyphCanvas.textRunEditor!.cursorPosition;
            window.stateManager.editor_cursor_position = cursor;
            window.stateManager.recordEvent('cursor_moved', 'TextRunEditor', {
                cursor
            });
        });
    }

    // Monitor glyph selection in editing mode
    window.addEventListener('editorModeChanged', ((e: CustomEvent) => {
        if (!window.stateManager.isUrlSyncEnabled()) return;

        // When in editing mode, sync the selected glyph index as cursor
        if (e.detail.mode === 'edit' && glyphCanvas.textRunEditor) {
            const cursor = glyphCanvas.textRunEditor.selectedGlyphIndex;
            if (cursor >= 0) {
                window.stateManager.editor_cursor_position = cursor;
                window.stateManager.recordEvent(
                    'glyph_selected_in_edit_mode',
                    'TextRunEditor',
                    { cursor }
                );
            }
        }
    }) as EventListener);

    // Monitor glyph stack changes from outline editor navigation
    window.addEventListener('glyphStackChanged', ((e: CustomEvent) => {
        if (!window.stateManager.isUrlSyncEnabled()) return;
        const glyphStack = e.detail?.glyphStack || '';
        window.stateManager.editor_glyph_stack = glyphStack;
        window.stateManager.recordEvent(
            'glyph_stack_changed',
            'OutlineEditor',
            {
                depth: glyphStack ? glyphStack.split('>').length - 1 : 0
            }
        );
    }) as EventListener);

    // Monitor axis/location changes
    if (glyphCanvas.axesManager) {
        const syncVariationLocation = (
            eventType:
                | 'variation_location_initialized'
                | 'variation_location_changed'
        ) => {
            const location = glyphCanvas.axesManager!.variationSettings || {};
            const roundedLocation: Record<string, number> = {};
            for (const [tag, value] of Object.entries(location)) {
                roundedLocation[tag] = Math.round(value);
            }

            window.stateManager.editor_variation_location = roundedLocation;

            // Notify glyph overview and other listeners about location change
            window.dispatchEvent(
                new CustomEvent('variationLocationChanged', {
                    detail: { location: roundedLocation }
                })
            );

            // Only record events when URL sync is active.
            if (!window.stateManager.isUrlSyncEnabled()) return;

            window.stateManager.recordEvent(eventType, 'AxesManager', {
                axisCount: Object.keys(roundedLocation).length
            });
        };

        const syncAnimationFlags = () => {
            window.stateManager.editor_isAnimating =
                !!glyphCanvas.axesManager!.isAnimating;
            window.stateManager.editor_isInterpolating =
                !!glyphCanvas.outlineEditor?.isInterpolating;
        };

        glyphCanvas.axesManager.on('sliderMouseDown', () => {
            if (!window.stateManager.isUrlSyncEnabled()) return;
            syncAnimationFlags();
        });

        glyphCanvas.axesManager.on('animationInProgress', () => {
            if (!window.stateManager.isUrlSyncEnabled()) return;
            syncAnimationFlags();
        });

        glyphCanvas.axesManager.on('sliderMouseUp', () => {
            if (!window.stateManager.isUrlSyncEnabled()) return;
            syncAnimationFlags();
            syncVariationLocation('variation_location_changed');
        });

        // Listen to animation complete - this fires when sliders finish moving
        glyphCanvas.axesManager.on('animationComplete', () => {
            syncVariationLocation('variation_location_changed');

            if (!window.stateManager.isUrlSyncEnabled()) return;

            syncAnimationFlags();
        });

        glyphCanvas.axesManager.on('textFieldAnimationComplete', () => {
            if (!window.stateManager.isUrlSyncEnabled()) return;
            syncAnimationFlags();
            syncVariationLocation('variation_location_changed');
        });

        // Capture current defaults at startup/font load even before any user axis interaction.
        syncVariationLocation('variation_location_initialized');
    }

    // Monitor feature changes
    if (glyphCanvas.featuresManager) {
        const syncOpenTypeFeaturesState = (
            eventType:
                | 'opentype_features_changed'
                | 'opentype_features_initialized'
        ) => {
            if (!window.stateManager.isUrlSyncEnabled()) return;

            // Clone to avoid sharing mutable references with FeaturesManager.
            // This ensures StateManager change detection/history works reliably.
            const featureSettings = {
                ...glyphCanvas.featuresManager!.featureSettings
            };
            const availabilityBySubset = {
                ...glyphCanvas.featuresManager!
                    .featureAvailabilityInEditingSubset
            };

            const featuresInSubset: Record<string, boolean> = {};
            const featuresNotInSubset: Record<string, boolean> = {};

            for (const [tag, enabled] of Object.entries(featureSettings)) {
                // Match sidebar button logic: available unless explicitly false.
                const isInSubset = availabilityBySubset[tag] !== false;
                if (isInSubset) {
                    featuresInSubset[tag] = enabled;
                } else {
                    featuresNotInSubset[tag] = enabled;
                }
            }

            window.stateManager.editor_opentype_features_in_subset =
                featuresInSubset;
            window.stateManager.editor_opentype_features_not_in_subset =
                featuresNotInSubset;

            const enabledInSubsetCount =
                Object.values(featuresInSubset).filter(Boolean).length;
            const enabledNotInSubsetCount =
                Object.values(featuresNotInSubset).filter(Boolean).length;
            window.stateManager.recordEvent(eventType, 'FeaturesManager', {
                enabledInSubsetCount,
                enabledNotInSubsetCount,
                inSubsetCount: Object.keys(featuresInSubset).length,
                notInSubsetCount: Object.keys(featuresNotInSubset).length
            });
        };

        glyphCanvas.featuresManager.on('change', () => {
            syncOpenTypeFeaturesState('opentype_features_changed');
        });

        // Capture initial/default-on state when features are (re)built.
        glyphCanvas.featuresManager.on('updated', () => {
            syncOpenTypeFeaturesState('opentype_features_initialized');
        });
    }

    // Monitor mode changes by listening to custom event
    window.addEventListener('editorModeChanged', ((e: CustomEvent) => {
        if (!window.stateManager.isUrlSyncEnabled()) return;

        const mode = e.detail.mode as 'text' | 'edit';
        console.log('Mode changed to:', mode);
        window.stateManager.editor_mode = mode;
        window.stateManager.recordEvent(
            'editor_mode_changed',
            'OutlineEditor',
            {
                mode
            }
        );
    }) as EventListener);

    console.log('State synchronization initialized');
}

// Export for use in window
(window as any).initStateSync = initStateSync;
(window as any).disableSync = disableSync;
(window as any).enableSync = enableSync;
