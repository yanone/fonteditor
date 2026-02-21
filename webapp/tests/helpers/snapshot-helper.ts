/**
 * Test Snapshot Helper
 *
 * Captures comprehensive application state for snapshot testing.
 * Add new data points by extending the AppSnapshot interface and captureSnapshot function.
 */

export interface AppSnapshot {
    label: string;
    state: Record<string, any>;
}

/**
 * Prepare snapshot for comparison by removing timestamp
 */
export function snapshotForComparison(snapshot: AppSnapshot): string {
    return JSON.stringify(snapshot, null, 2);
}

/**
 * Capture complete application state snapshot
 * Call this from tests at points where you want to record state
 */
export async function captureSnapshot(
    page: any,
    label: string
): Promise<AppSnapshot> {
    return await page.evaluate((snapshotLabel: string) => {
        // Helper to safely access window properties
        const safeGet = (path: string) => {
            try {
                const parts = path.split('.');
                let obj: any = window;
                for (const part of parts) {
                    obj = obj?.[part];
                }
                return obj;
            } catch {
                return null;
            }
        };

        // Prefer centralized state from StateManager
        const stateSnapshot = safeGet('stateManager.getStateSnapshot')
            ? safeGet('stateManager').getStateSnapshot()
            : null;
        const state = stateSnapshot?.state || {};

        const snapshot: AppSnapshot = {
            label: snapshotLabel,
            state: JSON.parse(JSON.stringify(state || {}))
        };

        // Ensure everything is JSON-serializable by doing a round-trip
        return JSON.parse(JSON.stringify(snapshot));
    }, label);
}

/**
 * Compare two snapshots and return differences
 * Useful for debugging test failures
 */
export function compareSnapshots(
    snapshot1: AppSnapshot,
    snapshot2: AppSnapshot
): any {
    const differences: any = {};

    const keys = Object.keys(snapshot1.state || {});
    for (const key of keys) {
        const val1 = JSON.stringify(snapshot1.state[key]);
        const val2 = JSON.stringify(snapshot2.state[key]);

        if (val1 !== val2) {
            differences[key] = {
                before: snapshot1.state[key],
                after: snapshot2.state[key]
            };
        }
    }

    return differences;
}

/**
 * Wait for app to be fully loaded (loading overlay hidden)
 */
export async function waitForCanvasReady(page: any) {
    // Wait for loading overlay to be hidden (app fully initialized)
    // WebKit can be slower, so we use a longer timeout
    await page.waitForFunction(
        () => {
            const loadingOverlay = document.getElementById('loading-overlay');
            return (
                loadingOverlay && loadingOverlay.classList.contains('hidden')
            );
        },
        { timeout: 10000 } // 2 minutes for slower browsers like WebKit
    );

    // Additional check to ensure canvas is actually ready
    await page.waitForFunction(
        () => {
            return (
                window.glyphCanvas &&
                window.glyphCanvas.canvas &&
                window.glyphCanvas.renderer
            );
        },
        { timeout: 5000 }
    );
}

/**
 * Wait for font to be loaded
 */
export async function waitForFontLoaded(page: any) {
    console.log('[Test] Waiting for fontReady event');
    // Wait for fontReady event to be dispatched
    await page.evaluate(() => {
        return new Promise((resolve) => {
            window.addEventListener('fontReady', resolve, { once: true });
        });
    });

    console.log('[Test] Waiting for font model to be ready');
    await page.waitForFunction(
        () => {
            return window.currentFontModel && window.fontManager?.currentFont;
        },
        { timeout: 5000 }
    );

    console.log(
        '[Test] Wait for features and axes to be populated with actual data'
    );
    // Wait for features and axes to be populated with actual data — check both
    // the internal managers AND the stateManager snapshot, since the state
    // manager is updated asynchronously after the managers are ready and
    // snapshots read from stateManager.
    await page.waitForFunction(
        () => {
            const featuresManager = window.glyphCanvas?.featuresManager;
            const axesManager = window.glyphCanvas?.axesManager;

            // Check if managers exist
            if (!featuresManager || !axesManager) return false;

            const featureSettings = featuresManager.featureSettings;
            const variationSettings = axesManager.variationSettings;

            // Both should be objects (not null/undefined)
            if (!featureSettings || !variationSettings) return false;

            // Internal managers must have feature keys
            if (Object.keys(featureSettings).length === 0) return false;

            // stateManager must also have the subset features propagated
            const state =
                window.stateManager?.getStateSnapshot?.()?.state || {};
            const featuresInSubset =
                state.editor_opentype_features_in_subset || {};
            const featuresNotInSubset =
                state.editor_opentype_features_not_in_subset || {};
            const variationLocation = state.editor_variation_location || {};

            // Features must be reflected in state; variation location must be
            // present too (it will be {} for non-variable fonts, which is fine,
            // but for variable fonts it should match variationSettings).
            const hasStateFeaturesInSubset =
                Object.keys(featuresInSubset).length > 0;
            const hasStateFeaturesNotInSubset =
                Object.keys(featuresNotInSubset).length > 0;

            // For variable fonts, stateManager variation location should match
            // the manager's variationSettings; for non-variable fonts both are {}.
            const variationMatch =
                Object.keys(variationSettings).length === 0 ||
                Object.keys(variationLocation).length > 0;

            return (
                hasStateFeaturesInSubset &&
                hasStateFeaturesNotInSubset &&
                variationMatch
            );
        },
        { timeout: 10000 }
    );

    // Extra stabilization time for async initialization
    await page.waitForTimeout(200);
}

/**
 * Wait for first Fontspector QC results to be ready for the currently opened file
 */
export async function waitForFontspectorReady(
    page: any,
    expectedFilename: string
) {
    // First, wait until the expected file is the active one
    await page.waitForFunction(
        (filename) => {
            const editorFile =
                window.stateManager?.getStateSnapshot?.()?.state?.editor_file ||
                '';
            return editorFile.includes(filename);
        },
        expectedFilename,
        { timeout: 15000 }
    );

    // Then wait for the fontspectorUpdated event with status 'ready'
    await page.evaluate(() => {
        return new Promise<void>((resolve) => {
            const handler = (event: Event) => {
                const detail = (event as CustomEvent).detail;
                if (detail?.status === 'ready') {
                    window.removeEventListener('fontspectorUpdated', handler);
                    resolve();
                }
            };
            // Check if already ready
            if (window.fontManager?.fullFontQcSummary !== null) {
                const statusText =
                    document
                        .querySelector(
                            '#font-qc-summary-section .font-qc-status'
                        )
                        ?.textContent?.trim() || '';
                if (statusText === 'Up to date') {
                    resolve();
                    return;
                }
            }
            window.addEventListener('fontspectorUpdated', handler);
        });
    });
}

/**
 * Wait until startup gates are released for the current open session.
 * This corresponds to font.openSession ending after both canvas and
 * overview initial readiness are complete.
 */
export async function waitForOpenSessionReady(
    page: any,
    expectedFilename?: string
) {
    if (expectedFilename) {
        await page.waitForFunction(
            (filename) => {
                const editorFile =
                    window.stateManager?.getStateSnapshot?.()?.state
                        ?.editor_file || '';
                return editorFile.includes(filename);
            },
            expectedFilename,
            { timeout: 15000 }
        );
    }

    await page.waitForFunction(
        () => {
            const startupReleasedMarkCount = performance.getEntriesByName(
                'cp:font.lifecycle.startupReleased'
            ).length;

            const startupBlocked =
                window.autoCompileManager?.getStatus?.()?.isStartupBlocked;
            const fullCompileEnabled =
                window.fullCompileManager?.getStatus?.()?.isEnabled;

            return (
                startupReleasedMarkCount > 0 &&
                startupBlocked === false &&
                fullCompileEnabled === true
            );
        },
        { timeout: 20000 }
    );

    await page.waitForTimeout(100);
}

/**
 * Wait until overview tiles have actual rendered canvas content.
 */
export async function waitForOverviewTilesRendered(page: any) {
    await page.waitForFunction(
        () => {
            const lifecycleCount = performance.getEntriesByName(
                'cp:font.lifecycle.overviewInitialRenderComplete'
            ).length;

            if (lifecycleCount === 0) {
                return false;
            }

            const glyphModelCount =
                window.currentFontModel?.glyphs?.length || 0;
            if (glyphModelCount === 0) {
                return false;
            }

            const tileCount = document.querySelectorAll(
                '#glyph-overview-container .glyph-tile'
            ).length;
            if (tileCount === 0) {
                return false;
            }

            const tileCanvases = Array.from(
                document.querySelectorAll(
                    '#glyph-overview-container .glyph-tile canvas'
                )
            ) as HTMLCanvasElement[];

            if (tileCanvases.length === 0) {
                return false;
            }

            const sampleSize = Math.min(tileCanvases.length, 80);
            let renderedCanvasCount = 0;

            for (let index = 0; index < sampleSize; index += 1) {
                const canvas = tileCanvases[index];
                const width = canvas.width;
                const height = canvas.height;

                if (!width || !height) {
                    continue;
                }

                try {
                    const ctx = canvas.getContext('2d', {
                        willReadFrequently: true
                    });
                    if (!ctx) {
                        continue;
                    }

                    const imageData = ctx.getImageData(
                        0,
                        0,
                        width,
                        height
                    ).data;
                    let hasNonTransparentPixel = false;

                    for (
                        let pixelIndex = 3;
                        pixelIndex < imageData.length;
                        pixelIndex += 4
                    ) {
                        if (imageData[pixelIndex] !== 0) {
                            hasNonTransparentPixel = true;
                            break;
                        }
                    }

                    if (hasNonTransparentPixel) {
                        renderedCanvasCount += 1;
                        if (renderedCanvasCount >= 3) {
                            break;
                        }
                    }
                } catch {
                    return false;
                }
            }

            if (renderedCanvasCount < 3) {
                return false;
            }

            const countElements = Array.from(
                document.querySelectorAll(
                    '#overview-filters .glyph-filter-item-count'
                )
            ) as HTMLElement[];

            if (countElements.length === 0) {
                return false;
            }

            const activeCountElement = document.querySelector(
                '#overview-filters .glyph-filter-item.active .glyph-filter-item-count'
            ) as HTMLElement | null;

            if (!activeCountElement) {
                return false;
            }

            const activeCountText = (
                activeCountElement.textContent || ''
            ).trim();

            if (activeCountText === '—') {
                return false;
            }

            if (/^\d+$/.test(activeCountText)) {
                return true;
            }

            return !!activeCountElement.querySelector(
                '.glyph-filter-error-icon'
            );
        },
        { timeout: 30000 }
    );

    await page.evaluate(async () => {
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve())
        );
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve())
        );
    });

    await page.waitForTimeout(150);
}

/**
 * Take a complete snapshot (JSON + PNG) with a 100ms wait
 * This wrapper combines both snapshot types and adds a stabilization delay
 */
export async function takeSnapshot(
    page: any,
    snapshotNumber: string,
    label: string,
    expect: any,
    maxDiffPixelRatio?: number
): Promise<any> {
    // Wait 100ms for rendering to stabilize
    await page.waitForTimeout(100);

    // Capture state snapshot
    const snapshot = await captureSnapshot(page, label);

    // Assert JSON snapshot
    expect(snapshotForComparison(snapshot)).toMatchSnapshot(
        `${snapshotNumber}-${label}.json`
    );

    // Assert PNG screenshot with optional threshold
    const screenshotOptions =
        maxDiffPixelRatio !== undefined ? { maxDiffPixelRatio } : {};

    await expect(
        page.locator('#glyph-canvas-container canvas')
    ).toHaveScreenshot(`${snapshotNumber}-${label}.png`, screenshotOptions);

    return snapshot;
}
