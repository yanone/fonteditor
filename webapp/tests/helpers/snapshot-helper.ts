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
    // Startup sequencing can dispatch fontReady before this helper attaches
    // its listener. Wait for the underlying loaded-font state instead of
    // relying on a single event edge.
    await page.waitForFunction(
        () => {
            const currentFont = window.fontManager?.currentFont;
            return (
                !!currentFont &&
                !!(window.currentFontModel || currentFont.fontModel)
            );
        },
        { timeout: 15000 }
    );

    console.log('[Test] Waiting for font model to be ready');
    await page.waitForFunction(
        () => {
            const currentFont = window.fontManager?.currentFont;
            return (
                !!currentFont &&
                !!(window.currentFontModel || currentFont.fontModel)
            );
        },
        { timeout: 5000 }
    );

    console.log(
        '[Test] Wait for features and axes to be populated with actual data'
    );
    // Wait for features/axes signals.
    // During open-session, URL query params can update before stateManager keys
    // are fully propagated; use manager + URL signals with a bounded fallback.
    try {
        const waitStart = Date.now();
        await page.waitForFunction(
            (startedAt) => {
                const featuresManager = window.glyphCanvas?.featuresManager;
                const axesManager = window.glyphCanvas?.axesManager;
                const state =
                    window.stateManager?.getStateSnapshot?.()?.state || {};

                const modelReady =
                    !!window.currentFontModel &&
                    !!window.fontManager?.currentFont;
                const editorFile = state.editor_file || '';

                if (!featuresManager || !axesManager) {
                    // Bounded fallback: once core model is ready for long enough,
                    // allow progress instead of deadlocking on manager lag.
                    return Date.now() - startedAt > 8000 && modelReady;
                }

                const featureSettings = featuresManager.featureSettings || {};
                const variationSettings = axesManager.variationSettings || {};

                const featuresInSubset =
                    state.editor_opentype_features_in_subset || {};
                const featuresNotInSubset =
                    state.editor_opentype_features_not_in_subset || {};
                const variationLocation = state.editor_variation_location || {};

                const search = new URLSearchParams(window.location.search);
                const queryFeatures = search.get('features') || '';
                const queryLocation = search.get('location') || '';

                const hasManagerFeatures =
                    Object.keys(featureSettings).length > 0;
                const hasStateFeatures =
                    Object.keys(featuresInSubset).length > 0 ||
                    Object.keys(featuresNotInSubset).length > 0;
                const hasFeatureSignal =
                    hasManagerFeatures ||
                    hasStateFeatures ||
                    queryFeatures.length > 0;

                const variationMatch =
                    Object.keys(variationSettings).length === 0 ||
                    Object.keys(variationLocation).length > 0 ||
                    queryLocation.length > 0;

                const hasEditorFile =
                    typeof editorFile === 'string' && editorFile.length > 0;

                if (
                    hasFeatureSignal &&
                    variationMatch &&
                    hasEditorFile &&
                    modelReady
                ) {
                    return true;
                }

                return (
                    Date.now() - startedAt > 10000 &&
                    modelReady &&
                    hasEditorFile
                );
            },
            waitStart,
            { timeout: 20000 }
        );
    } catch (error) {
        const debugState = await page.evaluate(() => {
            const state =
                window.stateManager?.getStateSnapshot?.()?.state || {};
            const featureSettings =
                window.glyphCanvas?.featuresManager?.featureSettings || {};
            const variationSettings =
                window.glyphCanvas?.axesManager?.variationSettings || {};

            return {
                editorFile: state.editor_file || '',
                managerFeatureKeys: Object.keys(featureSettings),
                subsetFeatureKeys: Object.keys(
                    state.editor_opentype_features_in_subset || {}
                ),
                notInSubsetFeatureKeys: Object.keys(
                    state.editor_opentype_features_not_in_subset || {}
                ),
                variationSettings,
                variationLocation: state.editor_variation_location || {},
                glyphBufferLength:
                    window.glyphCanvas?.textRunEditor?.glyphNameBuffer
                        ?.length || 0
            };
        });

        throw new Error(
            `Timed out waiting for features/axes readiness: ${JSON.stringify(debugState)}`,
            { cause: error as Error }
        );
    }

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

    // Then wait for fontspector readiness.
    // Guard against race conditions where the event fired before listener setup.
    await page.evaluate(() => {
        return new Promise<void>((resolve, reject) => {
            const isReady = () => {
                const fullCompileStatus =
                    window.fullCompileManager?.getStatus?.() || null;
                const currentFont = window.fontManager?.currentFont || null;

                if (!fullCompileStatus || !currentFont) {
                    return false;
                }

                if (
                    !fullCompileStatus.isEnabled ||
                    fullCompileStatus.isCompiling
                ) {
                    return false;
                }

                const currentPath = currentFont.path || null;
                const currentVersion = currentFont.changeVersion;

                return (
                    fullCompileStatus.lastCompiledPath === currentPath &&
                    fullCompileStatus.lastCompiledVersion >= currentVersion
                );
            };

            const handler = (event: Event) => {
                const detail = (event as CustomEvent).detail;
                if (detail?.status === 'ready' || isReady()) {
                    window.clearTimeout(timeoutId);
                    window.removeEventListener('fontspectorUpdated', handler);
                    resolve();
                }
            };

            if (isReady()) {
                resolve();
                return;
            }

            const timeoutId = window.setTimeout(() => {
                window.removeEventListener('fontspectorUpdated', handler);
                const fullCompileStatus =
                    window.fullCompileManager?.getStatus?.() || null;
                const currentFont = window.fontManager?.currentFont || null;
                reject(
                    new Error(
                        `Timed out waiting for fontspectorUpdated ready status: ${JSON.stringify(
                            {
                                fullCompileStatus,
                                currentFontPath: currentFont?.path || null,
                                currentFontVersion:
                                    currentFont?.changeVersion ?? null
                            }
                        )}`
                    )
                );
            }, 15000);

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
    await page.evaluate(async () => {
        const manager = window.glyphOverviewFilterManager;
        if (!manager || !manager.isLoaded?.()) {
            return;
        }

        try {
            await manager.refreshPlugins?.({ deferCounts: false });
        } catch {
            // Keep waiting logic robust; waitForFunction below will enforce readiness.
        }
    });

    await page.waitForFunction(
        () => {
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

            const countElements = Array.from(
                document.querySelectorAll(
                    '#overview-filters .glyph-filter-item-count'
                )
            ) as HTMLElement[];

            if (countElements.length === 0) {
                return false;
            }

            return true;
        },
        { timeout: 30000 }
    );

    await page.evaluate(async () => {
        const timeoutMs = 20000;
        const start = Date.now();
        let lastRenderKickAt = 0;

        const countPaintedTileCanvases = (): number => {
            const canvases = Array.from(
                document.querySelectorAll(
                    '#glyph-overview-container .glyph-tile canvas'
                )
            ) as HTMLCanvasElement[];

            let paintedCount = 0;

            for (const canvas of canvases.slice(0, 24)) {
                const width = canvas.width || canvas.clientWidth;
                const height = canvas.height || canvas.clientHeight;

                if (width < 2 || height < 2) {
                    continue;
                }

                const ctx = canvas.getContext('2d', {
                    willReadFrequently: true
                });
                if (!ctx) {
                    continue;
                }

                const sampleW = Math.min(48, width);
                const sampleH = Math.min(48, height);
                let imageData: ImageData;
                try {
                    imageData = ctx.getImageData(0, 0, sampleW, sampleH);
                } catch {
                    continue;
                }

                const data = imageData.data;
                let hasInk = false;
                for (let idx = 3; idx < data.length; idx += 16) {
                    if (data[idx] > 0) {
                        hasInk = true;
                        break;
                    }
                }

                if (hasInk) {
                    paintedCount += 1;
                }
            }

            return paintedCount;
        };

        while (Date.now() - start < timeoutMs) {
            const manager = window.glyphOverviewFilterManager;
            if (!manager || !manager.isLoaded?.()) {
                await new Promise<void>((resolve) => {
                    window.setTimeout(() => resolve(), 250);
                });
                continue;
            }

            const overview = (window as any).glyphOverviewInstance;
            if (overview?.ensureTilesRendered) {
                try {
                    await overview.ensureTilesRendered(3);
                } catch {
                    // Keep looping and retry until timeout.
                }
            }

            try {
                await manager.refreshPlugins?.({ deferCounts: false });
            } catch {
                // Ignore transient refresh errors and keep retrying until timeout.
            }

            const renderStatus = overview?.getRenderStatus?.();
            const renderedTileCount = renderStatus?.renderedTileCount || 0;
            const canvasCount = document.querySelectorAll(
                '#glyph-overview-container .glyph-tile canvas'
            ).length;

            if (
                overview?.renderGlyphOutlines &&
                (renderStatus?.tileCount || 0) > 0 &&
                renderedTileCount === 0 &&
                Date.now() - lastRenderKickAt > 1200
            ) {
                try {
                    await overview.renderGlyphOutlines();
                    lastRenderKickAt = Date.now();
                } catch {
                    // Continue polling until the overview becomes renderable.
                }
            }

            const hasRenderedTiles = renderedTileCount >= 3 || canvasCount >= 3;
            const paintedTileCount = countPaintedTileCanvases();
            const hasPaintedTiles = paintedTileCount >= 3;

            const unresolvedDomCounts = Array.from(
                document.querySelectorAll(
                    '#overview-filters .glyph-filter-item[data-plugin-keyword] .glyph-filter-item-count'
                )
            )
                .map((el) => (el.textContent || '').trim())
                .filter((text) => text === '—');

            if (!hasRenderedTiles) {
                await new Promise<void>((resolve) => {
                    window.setTimeout(() => resolve(), 250);
                });
                continue;
            }

            if (!hasPaintedTiles) {
                await new Promise<void>((resolve) => {
                    window.setTimeout(() => resolve(), 250);
                });
                continue;
            }

            if (
                unresolvedDomCounts.length === 0 ||
                Date.now() - start >= 8000 ||
                manager.areAllLoadedPluginCountsResolved?.()
            ) {
                return;
            }

            await new Promise<void>((resolve) => {
                window.setTimeout(() => resolve(), 250);
            });
        }

        const manager = window.glyphOverviewFilterManager;
        const status = manager?.getPluginCountResolutionStatus?.();
        const renderStatus = (
            window as any
        ).glyphOverviewInstance?.getRenderStatus?.();
        const domCounts = Array.from(
            document.querySelectorAll(
                '#overview-filters .glyph-filter-item[data-plugin-keyword] .glyph-filter-item-count'
            )
        ).map((el) => (el.textContent || '').trim());
        throw new Error(
            `Timeout waiting for painted overview tiles and all loaded filter plugin counts: ${JSON.stringify({ status, renderStatus, domCounts, paintedTileCount: countPaintedTileCanvases() })}`
        );
    });

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
    maxDiffPixelRatio: number = 0.02
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
    const screenshotOptions = { maxDiffPixelRatio };

    await expect(
        page.locator('#glyph-canvas-container canvas')
    ).toHaveScreenshot(`${snapshotNumber}-${label}.png`, screenshotOptions);

    return snapshot;
}
