import { test } from '@playwright/test';

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

type JsonValue =
    | null
    | boolean
    | number
    | string
    | JsonValue[]
    | { [key: string]: JsonValue };

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sortJsonValue(value: unknown): JsonValue {
    if (Array.isArray(value)) {
        return value.map((entry) => sortJsonValue(entry));
    }

    if (isPlainObject(value)) {
        return Object.fromEntries(
            Object.keys(value)
                .sort((left, right) => left.localeCompare(right))
                .map((key) => [key, sortJsonValue(value[key])])
        );
    }

    return (value ?? null) as JsonValue;
}

function normalizeSnapshot(snapshot: AppSnapshot): AppSnapshot {
    return sortJsonValue(snapshot) as unknown as AppSnapshot;
}

async function readSnapshotFile(path: string): Promise<string> {
    const loadFsPromises = new Function(
        'modulePath',
        'return import(modulePath);'
    ) as (modulePath: string) => Promise<{
        readFile: (filePath: string, encoding: string) => Promise<string>;
    }>;

    const fsPromises = await loadFsPromises('fs/promises');
    return fsPromises.readFile(path, 'utf8');
}

/**
 * Prepare snapshot for comparison with stable key ordering.
 */
export function snapshotForComparison(snapshot: AppSnapshot): string {
    return JSON.stringify(normalizeSnapshot(snapshot), null, 4);
}

export async function expectJsonSnapshot(
    snapshot: AppSnapshot,
    snapshotName: string,
    expect: any
): Promise<void> {
    const normalizedSnapshot = normalizeSnapshot(snapshot);
    const snapshotText = snapshotForComparison(normalizedSnapshot);
    const testInfo = test.info();
    const snapshotPath = testInfo.snapshotPath(snapshotName);

    if (
        testInfo.config.updateSnapshots === 'all' ||
        testInfo.config.updateSnapshots === 'changed'
    ) {
        expect(snapshotText).toMatchSnapshot(snapshotName);
        return;
    }

    try {
        const expectedSnapshotText = await readSnapshotFile(snapshotPath);
        const expectedSnapshot = normalizeSnapshot(
            JSON.parse(expectedSnapshotText) as AppSnapshot
        );

        expect(normalizedSnapshot).toEqual(expectedSnapshot);
    } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') {
            throw error;
        }

        expect(snapshotText).toMatchSnapshot(snapshotName);
    }
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
        const textRunEditor = safeGet('glyphCanvas.textRunEditor');

        const snapshot: AppSnapshot = {
            label: snapshotLabel,
            state: JSON.parse(JSON.stringify(state || {}))
        };

        if (textRunEditor) {
            // Compact per-field strings are populated by state-sync.ts on every
            // render. Override with a live read to avoid race conditions between
            // render events and snapshot timing.
            const nameBuffer = Array.isArray(textRunEditor.glyphNameBuffer)
                ? textRunEditor.glyphNameBuffer
                : [];
            snapshot.state.editor_harfbuzz_glyph_names = nameBuffer.join(' ');

            const glyphBuffer = textRunEditor.shapedGlyphs || [];
            const gids: string[] = [];
            const dxs: string[] = [];
            const dys: string[] = [];
            const axs: string[] = [];
            const ays: string[] = [];
            const cls: string[] = [];
            for (const g of glyphBuffer) {
                gids.push(String(g.g ?? ''));
                dxs.push(String(g.dx ?? ''));
                dys.push(String(g.dy ?? ''));
                axs.push(String(g.ax ?? ''));
                ays.push(String(g.ay ?? ''));
                cls.push(String(g.cl ?? ''));
            }
            snapshot.state.editor_harfbuzz_gids = gids.join(' ');
            snapshot.state.editor_harfbuzz_dx = dxs.join(' ');
            snapshot.state.editor_harfbuzz_dy = dys.join(' ');
            snapshot.state.editor_harfbuzz_ax = axs.join(' ');
            snapshot.state.editor_harfbuzz_ay = ays.join(' ');
            snapshot.state.editor_harfbuzz_cl = cls.join(' ');
        }

        // Ensure everything is JSON-serializable by doing a round-trip
        return JSON.parse(JSON.stringify(snapshot));
    }, label);
}

/**
 * Wait for app to be fully loaded (loading overlay hidden)
 */
export async function waitForCanvasReady(page: any) {
    // Wait for loading overlay to be hidden (app fully initialized)
    // CI runners can lag on app bootstrap, so keep the startup gates tolerant
    // and include debug state when a readiness predicate stalls.
    const waitForStartupState = async (
        label: string,
        predicate: () => boolean,
        timeout: number
    ) => {
        try {
            await page.waitForFunction(predicate, { timeout });
        } catch (error) {
            const debugState = await page.evaluate(() => {
                const win = window as any;
                const loadingOverlay =
                    document.getElementById('loading-overlay');

                return {
                    loadingOverlayHidden:
                        !!loadingOverlay?.classList.contains('hidden'),
                    hasGlyphCanvas: !!win.glyphCanvas,
                    hasCanvasElement: !!win.glyphCanvas?.canvas,
                    hasRenderer: !!win.glyphCanvas?.renderer,
                    hasViewSettings: !!win.VIEW_SETTINGS,
                    hasGetCurrentFocusedView:
                        typeof win.getCurrentFocusedView === 'function',
                    hasFocusView: typeof win.focusView === 'function',
                    hasStateManager: !!win.stateManager,
                    hasInitFileBrowser:
                        typeof win.initFileBrowser === 'function',
                    hasWaitForFileBrowserReady:
                        typeof win.waitForFileBrowserReady === 'function'
                };
            });

            throw new Error(
                `Timed out waiting for canvas startup state: ${label}: ${JSON.stringify(debugState)}`,
                { cause: error as Error }
            );
        }
    };

    await waitForStartupState(
        'loading overlay hidden',
        () => {
            const loadingOverlay = document.getElementById('loading-overlay');
            return !!(
                loadingOverlay && loadingOverlay.classList.contains('hidden')
            );
        },
        20000
    );

    await waitForStartupState(
        'glyph canvas ready',
        () => {
            const win = window as any;
            return (
                !!win.glyphCanvas?.canvas &&
                !!win.glyphCanvas?.renderer &&
                !!win.stateManager
            );
        },
        15000
    );

    await waitForStartupState(
        'view helpers ready',
        () => {
            const win = window as any;
            return (
                !!win.VIEW_SETTINGS &&
                typeof win.getCurrentFocusedView === 'function' &&
                typeof win.focusView === 'function'
            );
        },
        15000
    );

    await page.evaluate(async () => {
        const win = window as any;
        if (typeof win.initFileBrowser === 'function') {
            await win.initFileBrowser();
        }
        if (typeof win.waitForFileBrowserReady === 'function') {
            await win.waitForFileBrowserReady(10000);
        }
    });
}

export async function waitForFileBrowserReady(page: any) {
    await page.evaluate(async () => {
        const win = window as any;
        if (typeof win.initFileBrowser === 'function') {
            await win.initFileBrowser();
        }
        if (typeof win.waitForFileBrowserReady === 'function') {
            await win.waitForFileBrowserReady(10000);
        }
    });
}

export async function focusView(page: any, shortcut: string, viewId: string) {
    const waitForFocusedView = async (timeout: number) => {
        await page.waitForFunction(
            (expectedViewId: string) => {
                const win = window as any;
                const focusedViewId = win.getCurrentFocusedView?.();
                if (focusedViewId === expectedViewId) {
                    return true;
                }

                const view = document.getElementById(expectedViewId);
                return !!view?.classList.contains('focused');
            },
            viewId,
            { timeout }
        );
    };

    await page.waitForFunction(
        () => {
            const win = window as any;
            return (
                typeof win.getCurrentFocusedView === 'function' &&
                typeof win.focusView === 'function'
            );
        },
        { timeout: 15000 }
    );

    await page.keyboard.press(shortcut);

    try {
        await waitForFocusedView(10000);
        return;
    } catch {
        await page.evaluate((targetViewId: string) => {
            const win = window as any;
            win.focusView?.(targetViewId, true);
        }, viewId);
    }

    await waitForFocusedView(15000);
}

export async function collapseView(page: any, viewId: string) {
    await page.evaluate((targetViewId: string) => {
        const win = window as any;
        win.collapseActiveView?.(targetViewId);
    }, viewId);

    await page.waitForFunction(
        (targetViewId: string) => {
            const view = document.getElementById(targetViewId);
            if (!view) {
                return true;
            }

            const isTopRow = view.closest('.top-row') !== null;
            const isBottomRow = view.closest('.bottom-row') !== null;

            if (isTopRow) {
                return view.getBoundingClientRect().width <= 30;
            }

            if (isBottomRow) {
                return view.getBoundingClientRect().height <= 30;
            }

            return !view.classList.contains('focused');
        },
        viewId,
        { timeout: 5000 }
    );
}

export async function openFileFromFilesView(page: any, fileName: string) {
    await page.evaluate(async () => {
        await (window as any).showFontFileDialog?.({ mode: 'open' });
    });
    await page.locator('#font-file-dialog').waitFor({ state: 'visible' });
    await waitForFileBrowserReady(page);

    const fileItemSelector = `.file-item[data-name="${fileName}"]`;
    const getFileItem = () => page.locator(fileItemSelector).first();
    const locateTargetFile = async () => {
        await page.evaluate(async (targetFileName: string) => {
            const win = window as any;
            if (typeof win.locatePathInFileDialog !== 'function') {
                return;
            }

            const fullPath = targetFileName.startsWith('/')
                ? targetFileName
                : `/user/${targetFileName}`;
            const pathSegments = fullPath.split('/').filter(Boolean);
            const pluginId = pathSegments[0] || 'user';

            await win.locatePathInFileDialog(pluginId, fullPath);
        }, fileName);

        await page.locator('#font-file-dialog').waitFor({ state: 'visible' });
        await waitForFileBrowserReady(page);
    };

    const waitForTargetFile = async () => {
        await page.waitForFunction(
            (selector: string) => {
                const item = document.querySelector(
                    selector
                ) as HTMLElement | null;
                return !!item && item.offsetParent !== null;
            },
            fileItemSelector,
            { timeout: 30000 }
        );
        await getFileItem().waitFor({ state: 'visible', timeout: 30000 });
    };

    const waitForOpenedFile = async () => {
        await page.waitForFunction(
            (targetFileName: string) => {
                const editorFile =
                    (window as any).stateManager?.getStateSnapshot?.()?.state
                        ?.editor_file || '';
                const queryFile =
                    new URLSearchParams(window.location.search).get('file') ||
                    '';

                return (
                    editorFile.includes(targetFileName) ||
                    decodeURIComponent(queryFile).includes(targetFileName)
                );
            },
            fileName,
            { timeout: 20000 }
        );
    };

    try {
        await waitForTargetFile();
    } catch {
        await locateTargetFile();
        await page.evaluate(async () => {
            const win = window as any;
            if (typeof win.refreshFileSystem === 'function') {
                await win.refreshFileSystem();
            }
        });
        await waitForFileBrowserReady(page);
        await waitForTargetFile();
    }

    await getFileItem().scrollIntoViewIfNeeded();

    try {
        await Promise.all([
            waitForOpenedFile(),
            getFileItem().dblclick({ delay: 50 })
        ]);
    } catch {
        await locateTargetFile();
        await waitForTargetFile();
        await getFileItem().scrollIntoViewIfNeeded();
        await Promise.all([
            waitForOpenedFile(),
            getFileItem().dblclick({ delay: 50 })
        ]);
    }
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
        { timeout: 30000 }
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
        { timeout: 15000 }
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
    expectedFilename: string,
    options: { allowObservedPendingCompile?: boolean } = {}
) {
    // First, wait until the expected file is the active one
    await page.waitForFunction(
        (filename: string) => {
            const testWindow = window as any;
            const editorFile =
                testWindow.stateManager?.getStateSnapshot?.()?.state
                    ?.editor_file || '';
            return editorFile.includes(filename);
        },
        expectedFilename,
        { timeout: 15000 }
    );

    // Then wait for fontspector readiness.
    // Guard against race conditions where the event fired before listener setup.
    await page.evaluate(
        ({
            allowObservedPendingCompile
        }: {
            allowObservedPendingCompile: boolean;
        }) => {
            const testWindow = window as any;
            testWindow.__waitForFontspectorAllowObservedPendingCompile =
                !!allowObservedPendingCompile;
            return new Promise<void>((resolve, reject) => {
                const isReady = () => {
                    const fullCompileStatus =
                        testWindow.fullCompileManager?.getStatus?.() || null;
                    const currentFont =
                        testWindow.fontManager?.currentFont || null;

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

                const isObservedPendingCompile = () => {
                    const fullCompileStatus =
                        testWindow.fullCompileManager?.getStatus?.() || null;
                    const currentFont =
                        testWindow.fontManager?.currentFont || null;

                    if (!fullCompileStatus || !currentFont) {
                        return false;
                    }

                    const currentPath = currentFont.path || null;
                    const currentVersion = currentFont.changeVersion;

                    return (
                        !!fullCompileStatus.isEnabled &&
                        fullCompileStatus.isCompiling &&
                        fullCompileStatus.lastObservedPath === currentPath &&
                        fullCompileStatus.lastObservedVersion >= currentVersion
                    );
                };

                const handler = (event: Event) => {
                    const detail = (event as CustomEvent).detail;
                    if (detail?.status === 'ready' || isReady()) {
                        window.clearTimeout(timeoutId);
                        window.removeEventListener(
                            'fontspectorUpdated',
                            handler
                        );
                        resolve();
                    }
                };

                if (isReady()) {
                    resolve();
                    return;
                }

                const timeoutId = window.setTimeout(() => {
                    window.removeEventListener('fontspectorUpdated', handler);
                    if (
                        testWindow.__waitForFontspectorAllowObservedPendingCompile &&
                        isObservedPendingCompile()
                    ) {
                        resolve();
                        return;
                    }
                    const fullCompileStatus =
                        testWindow.fullCompileManager?.getStatus?.() || null;
                    const currentFont =
                        testWindow.fontManager?.currentFont || null;
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
        },
        {
            allowObservedPendingCompile: !!options.allowObservedPendingCompile
        }
    );
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

async function waitForEditorModeActivation(page: any) {
    await page.evaluate(async () => {
        const waitForNextPaint = async () => {
            await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve())
            );
            await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve())
            );
        };

        const getRenderState = () =>
            ((window as any).__glyphCanvasRenderState as
                | {
                      sequence?: number;
                      mode?: 'text' | 'edit';
                      selectedGlyphIndex?: number;
                      selectedLayerId?: string | null;
                      glyphStack?: string;
                      hasLayerData?: boolean;
                      isInterpolated?: boolean;
                  }
                | undefined) ?? null;

        const isExpectedModeRendered = () => {
            const state =
                window.stateManager?.getStateSnapshot?.()?.state || null;
            const glyphCanvas = (window as any).glyphCanvas;
            const outlineEditor = glyphCanvas?.outlineEditor;
            const textRunEditor = glyphCanvas?.textRunEditor;
            const renderState = getRenderState();

            if (!state || !glyphCanvas || !outlineEditor || !textRunEditor) {
                return false;
            }

            if (state.editor_mode === 'edit') {
                return (
                    outlineEditor.active === true &&
                    textRunEditor.selectedGlyphIndex >= 0 &&
                    renderState?.mode === 'edit' &&
                    renderState.selectedGlyphIndex ===
                        textRunEditor.selectedGlyphIndex &&
                    Boolean(renderState.glyphStack) &&
                    Boolean(renderState.hasLayerData) &&
                    (Boolean(renderState.selectedLayerId) ||
                        Boolean(renderState.isInterpolated))
                );
            }

            return (
                outlineEditor.active === false &&
                textRunEditor.selectedGlyphIndex === -1 &&
                renderState?.mode === 'text' &&
                renderState.selectedGlyphIndex === -1
            );
        };

        if (isExpectedModeRendered()) {
            await waitForNextPaint();
            return;
        }

        const state = window.stateManager?.getStateSnapshot?.()?.state || {};
        const expectedMode = state.editor_mode === 'edit' ? 'edit' : 'text';
        const eventName =
            expectedMode === 'edit' ? 'editModeActivated' : 'textModeActivated';

        await new Promise<void>((resolve, reject) => {
            const timeoutId = window.setTimeout(() => {
                cleanup();
                reject(
                    new Error(
                        `Timed out waiting for ${eventName} while state manager expected ${expectedMode} mode`
                    )
                );
            }, 5000);

            const onReadyCheck = () => {
                if (!isExpectedModeRendered()) {
                    return;
                }

                cleanup();
                resolve();
            };

            const cleanup = () => {
                window.clearTimeout(timeoutId);
                window.removeEventListener(eventName, onReadyCheck);
                window.removeEventListener('glyphCanvasRendered', onReadyCheck);
            };

            window.addEventListener(eventName, onReadyCheck);
            window.addEventListener('glyphCanvasRendered', onReadyCheck);
            onReadyCheck();
        });

        await waitForNextPaint();
    });
}

export async function waitForFeatureCompilationError(
    page: any,
    options?: { timeout?: number }
) {
    const timeout = options?.timeout ?? 7000;

    await page.waitForFunction(
        () => {
            const errorDisplay = document.getElementById(
                'sidebar-error-display'
            ) as HTMLElement | null;

            const sidebarVisible =
                !!errorDisplay &&
                errorDisplay.style.display !== 'none' &&
                !!errorDisplay.textContent?.trim();

            return sidebarVisible;
        },
        { timeout }
    );

    await page.evaluate(async () => {
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve())
        );
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve())
        );
    });

    await page.waitForTimeout(100);
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
    await waitForEditorModeActivation(page);
    await page.waitForTimeout(50);

    // Capture state snapshot
    const snapshot = await captureSnapshot(page, label);

    // Assert JSON snapshot
    await expectJsonSnapshot(
        snapshot,
        `${snapshotNumber}-${label}.json`,
        expect
    );

    // Assert PNG screenshot with optional threshold
    const screenshotOptions = { maxDiffPixelRatio };

    await expect(
        page.locator('#glyph-canvas-container canvas')
    ).toHaveScreenshot(`${snapshotNumber}-${label}.png`, screenshotOptions);

    return snapshot;
}
