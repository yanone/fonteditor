import { test, expect, type Page } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady,
    focusView,
    openFileFromFilesView
} from './helpers/snapshot-helper';

// ── Helpers ──────────────────────────────────────────────────────────

async function waitForBridgeReady(page: Page): Promise<void> {
    await page.waitForFunction(
        () =>
            !!(window as any).changeBridge &&
            !!(window as any).currentFontModel &&
            !!(window as any).fontManager?.currentFont,
        { timeout: 20000 }
    );
    await page.waitForTimeout(500);
}

/** Set text buffer to "ä" and enter edit mode on glyph 'a'. */
async function setupEditTextMode(page: Page): Promise<void> {
    await page.evaluate(async () => {
        const gc = (window as any).glyphCanvas;
        // Set text to "ä" (adieresis)
        gc.textRunEditor.setTextBuffer('ä');
        await gc.textRunEditor.selectGlyphByIndex(0, true);
    });
    await page.waitForTimeout(500);
    // Zoom to fit
    await page.keyboard.press('Meta+0');
    await page.waitForTimeout(300);
}

async function waitForWindowSyncReady(page: Page): Promise<void> {
    await page.waitForFunction(() => !!(window as any).windowSync, {
        timeout: 15000
    });
}

/** Wait for the linked window to receive full state from the main window. */
async function waitForFullStateSync(page: Page): Promise<void> {
    await page.waitForFunction(
        () => {
            const sync = (window as any).windowSync;
            const bridge = (window as any).changeBridge;
            if (!sync || !bridge) return false;
            // The linked window must have applied full state and have glyph data
            const glyphsMap = bridge.fontMap?.get('glyphs');
            if (!glyphsMap) return false;
            let glyphCount = 0;
            glyphsMap.forEach(() => glyphCount++);
            return glyphCount > 0;
        },
        { timeout: 20000 }
    );
    await page.waitForTimeout(500);
}

async function getLastFontModelSyncTime(page: Page): Promise<number> {
    return page.evaluate(() => (window as any).__lastFontModelSyncTime ?? 0);
}

/**
 * Wait for a remote change to arrive and be processed in the linked window.
 * Uses the `fontModelSync` event that fires after _onAfterSync,
 * which is called after every applyRemoteUpdate.
 */
async function waitForRemoteChange(
    linkedPage: Page,
    previousSyncTime: number
): Promise<void> {
    await linkedPage.evaluate((lastSeenSyncTime) => {
        return new Promise<void>((resolve) => {
            const currentSyncTime =
                (window as any).__lastFontModelSyncTime ?? 0;
            if (currentSyncTime > lastSeenSyncTime) {
                resolve();
                return;
            }
            const handler = () => {
                (window as any).__lastFontModelSyncTime = Date.now();
                window.removeEventListener('fontModelSync', handler);
                resolve();
            };
            window.addEventListener('fontModelSync', handler);
            // Safety timeout in case the event already fired
            setTimeout(() => {
                window.removeEventListener('fontModelSync', handler);
                resolve();
            }, 15000);
        });
    }, previousSyncTime);
    // Allow UI and compilation to settle
    await linkedPage.waitForTimeout(5000);
}

/**
 * Wait for the editing font to compile successfully (or at least attempt).
 */
async function waitForEditingCompile(page: Page): Promise<void> {
    await page.waitForFunction(
        () => {
            const fm = (window as any).fontManager;
            if (!fm?.currentFont) return false;
            // Either compiled successfully, or no pending recompile
            return !fm.currentFont.needsRecompile || fm.editingFont !== null;
        },
        { timeout: 20000 }
    );
    await page.waitForTimeout(300);
}

/** Extract comparable glyph layer data from a page's font model. */
async function extractGlyphLayerData(
    page: Page,
    glyphNames: string[]
): Promise<Record<string, any>> {
    return page.evaluate((names) => {
        const result: Record<string, any> = {};
        const fontModel = (window as any).currentFontModel;
        if (!fontModel) return result;

        for (const name of names) {
            const glyph = fontModel.findGlyph(name);
            if (!glyph) {
                result[name] = null;
                continue;
            }

            const layers: Record<string, any> = {};
            for (const layer of glyph.layers || []) {
                const layerData: Record<string, any> = {
                    id: layer.id,
                    name: layer.name,
                    width: layer.width,
                    master: layer.master
                };

                // Shapes: extract nodes/paths and components separately
                const shapes = [];
                for (const shape of layer.shapes || []) {
                    try {
                        const path = shape.asPath?.();
                        if (path) {
                            shapes.push({
                                type: 'path',
                                nodes: path.nodes?.map((n: any) => ({
                                    x: n.x,
                                    y: n.y,
                                    nodetype: n.nodetype,
                                    smooth: n.smooth
                                })),
                                closed: path.closed
                            });
                            continue;
                        }
                    } catch {
                        // asPath throws for non-path shapes (components)
                    }
                    try {
                        const comp = shape.asComponent?.();
                        if (comp) {
                            shapes.push({
                                type: 'component',
                                reference: comp.reference,
                                transform: comp.transform
                            });
                            continue;
                        }
                    } catch {
                        // asComponent throws for non-component shapes
                    }
                    // Fallback: extract raw data
                    shapes.push({
                        type: 'unknown',
                        data: JSON.parse(JSON.stringify(shape.data || shape))
                    });
                }
                layerData.shapes = shapes;

                // Anchors
                layerData.anchors = (layer.anchors || []).map((a: any) => ({
                    name: a.name,
                    x: a.x,
                    y: a.y
                }));

                layers[layer.id] = layerData;
            }

            result[name] = { layers };
        }

        return result;
    }, glyphNames);
}

/** Extract raw babelfontData layer properties for a specific layer ID. */
async function extractRawLayerProperties(
    page: Page,
    glyphName: string,
    layerId: string
): Promise<Record<string, any> | null> {
    return page.evaluate(
        ({ glyphName, layerId }) => {
            const rawData = (window as any).fontManager?.currentFont
                ?.babelfontData;
            const glyph = rawData?.glyphs?.find(
                (g: any) => g.name === glyphName
            );
            const layer = glyph?.layers?.find((l: any) => l.id === layerId);
            if (!layer) return null;

            // Return a copy with all enumerable own properties
            const result: Record<string, any> = {};
            for (const key of Object.keys(layer)) {
                const value = layer[key];
                // Skip shapes/anchors for brevity (tested separately)
                if (key === 'shapes' || key === 'anchors') continue;
                result[key] =
                    value === undefined
                        ? undefined
                        : JSON.parse(JSON.stringify(value));
            }
            return result;
        },
        { glyphName, layerId }
    );
}

/** Extract Y.Doc layer keys for a specific layer. */
async function extractYDocLayerKeys(
    page: Page,
    glyphName: string,
    layerId: string
): Promise<string[]> {
    return page.evaluate(
        ({ glyphName, layerId }) => {
            const bridge = (window as any).changeBridge;
            if (!bridge) return [];
            const glyphsMap = bridge.fontMap?.get('glyphs');
            const glyphMap = glyphsMap?.get(glyphName);
            const layersMap = glyphMap?.get('layers');
            const layerMap = layersMap?.get(layerId);
            if (!layerMap) return [];

            const keys: string[] = [];
            layerMap.forEach((_v: any, k: string) => keys.push(k));
            return keys.sort();
        },
        { glyphName, layerId }
    );
}

/** Extract shapes from a specific layer via raw babelfontData for deep comparison. */
async function extractRawLayerShapes(
    page: Page,
    glyphName: string,
    layerId: string
): Promise<any> {
    return page.evaluate(
        ({ glyphName, layerId }) => {
            const rawData = (window as any).fontManager?.currentFont
                ?.babelfontData;
            const glyph = rawData?.glyphs?.find(
                (g: any) => g.name === glyphName
            );
            const layer = glyph?.layers?.find((l: any) => l.id === layerId);
            if (!layer) return null;
            return JSON.parse(JSON.stringify(layer.shapes));
        },
        { glyphName, layerId }
    );
}

/** Extract anchors from a specific layer via raw babelfontData. */
async function extractRawLayerAnchors(
    page: Page,
    glyphName: string,
    layerId: string
): Promise<any> {
    return page.evaluate(
        ({ glyphName, layerId }) => {
            const rawData = (window as any).fontManager?.currentFont
                ?.babelfontData;
            const glyph = rawData?.glyphs?.find(
                (g: any) => g.name === glyphName
            );
            const layer = glyph?.layers?.find((l: any) => l.id === layerId);
            if (!layer) return null;
            return JSON.parse(JSON.stringify(layer.anchors));
        },
        { glyphName, layerId }
    );
}

/** Find the Regular master's layer ID in the Fustat font. */
async function findThinLayerId(page: Page): Promise<string> {
    // Find the Y.Doc layer for glyph 'a' that has both 'anchors' and 'shapes'
    // and belongs to the Thin (wght:200) master. This is the first master
    // in Fustat and definitely has its own outline data (not interpolated).
    return page.evaluate(() => {
        const bridge = (window as any).changeBridge;
        try {
            const glyphsMap = bridge?.fontMap?.get('glyphs');
            const glyphMap = glyphsMap?.get('a');
            const layersMap = glyphMap?.get('layers');
            if (!layersMap) return '';

            // Find the Thin master ID (wght:200)
            const fontModel = (window as any).currentFontModel;
            const masters = fontModel?.masters || [];
            let thinMasterId = '';
            for (const master of masters) {
                const nameStr =
                    typeof master.name === 'string'
                        ? master.name
                        : master.name?.dflt || '';
                if (master.location?.wght === 200 || nameStr === 'Thin') {
                    thinMasterId = master.id;
                    break;
                }
            }
            if (!thinMasterId) thinMasterId = masters[0]?.id || '';

            // Search Y.Doc layers for one that has anchors + shapes + matching master
            let result = '';
            layersMap.forEach((layerMap: any, layerId: string) => {
                if (result) return;
                if (!layerMap || typeof layerMap.forEach !== 'function') return;

                let hasAnchors = false;
                let hasShapes = false;
                let masterRef = '';
                layerMap.forEach((v: any, k: string) => {
                    if (k === 'anchors') hasAnchors = true;
                    if (k === 'shapes') hasShapes = true;
                    if (k === 'master') {
                        if (typeof v === 'string') masterRef = v;
                        else if (v && typeof v === 'object') {
                            if (typeof v.get === 'function') {
                                masterRef =
                                    v.get('master') ||
                                    v.get('DefaultForMaster') ||
                                    '';
                            } else {
                                masterRef =
                                    v.master || v.DefaultForMaster || '';
                            }
                        }
                    }
                });

                if (hasAnchors && hasShapes && masterRef === thinMasterId) {
                    result = layerId;
                }
            });

            return result;
        } catch {
            return '';
        }
    });
}

/** Count layers in the model for a glyph (only default master layers). */
async function countModelLayers(
    page: Page,
    glyphName: string
): Promise<number> {
    return page.evaluate((name) => {
        const glyph = (window as any).currentFontModel?.findGlyph(name);
        return glyph?.layers?.length || 0;
    }, glyphName);
}

// ── Test ──────────────────────────────────────────────────────────────

test.describe('Cross-window ChangeBridge sync', () => {
    test('linked window preserves all layer data after remote outline and anchor edits on Thin layer', async ({
        browser
    }) => {
        test.setTimeout(180000);

        // ── 1. Open main window ──────────────────────────────────
        const context = await browser.newContext();
        const mainPage = await context.newPage();

        // Track console errors
        const mainErrors: string[] = [];
        mainPage.on('pageerror', (err) => mainErrors.push(err.message));

        await mainPage.goto('/?test=true');
        await waitForCanvasReady(mainPage);
        await openFileFromFilesView(mainPage, 'Fustat.glyphs');
        await waitForOpenSessionReady(mainPage, 'Fustat.glyphs');
        await waitForBridgeReady(mainPage);

        // Focus editor view, set text to "ä", enter edit mode on glyph 'a'
        await focusView(mainPage, 'Meta+Shift+E', 'view-editor');
        await setupEditTextMode(mainPage);

        // Find the Thin master layer ID
        const thinLayerId = await findThinLayerId(mainPage);
        expect(thinLayerId).toBeTruthy();
        console.log('thinLayerId:', thinLayerId);
        const glyphNames = ['a', 'adieresis', 'aacute'];

        // ── 2. Open linked window ────────────────────────────────
        const [linkedPage] = await Promise.all([
            context.waitForEvent('page'),
            mainPage.locator('#open-new-window-btn').click()
        ]);

        await waitForCanvasReady(linkedPage);
        await waitForFontLoaded(linkedPage);
        await waitForFullStateSync(linkedPage);
        await waitForBridgeReady(linkedPage);
        await waitForWindowSyncReady(linkedPage);

        // Wait for the linked window's WindowSync to detect the main window as a peer
        await linkedPage.waitForFunction(
            () => (window as any).windowSync?.peers?.size > 0,
            { timeout: 15000 }
        );
        // Also ensure the main window's WindowSync knows about the linked window
        await mainPage.waitForFunction(
            () => (window as any).windowSync?.peers?.size > 0,
            { timeout: 15000 }
        );
        await linkedPage.waitForTimeout(500);

        const linkedErrors: string[] = [];
        linkedPage.on('pageerror', (err) => linkedErrors.push(err.message));

        // ── 3. Baseline: verify both windows start with the same data ──
        const mainBaselineData = await extractGlyphLayerData(
            mainPage,
            glyphNames
        );
        const linkedBaselineData = await extractGlyphLayerData(
            linkedPage,
            glyphNames
        );
        expect(linkedBaselineData).toEqual(mainBaselineData);

        // Verify Y.Doc has all expected keys for the Regular layer
        const mainYDocKeys = await extractYDocLayerKeys(
            mainPage,
            'a',
            thinLayerId
        );
        const linkedYDocKeys = await extractYDocLayerKeys(
            linkedPage,
            'a',
            thinLayerId
        );
        expect(linkedYDocKeys).toEqual(mainYDocKeys);
        // Sanity: Regular layer Y.Doc must have core properties
        expect(mainYDocKeys).toContain('width');
        expect(mainYDocKeys).toContain('shapes');

        // Baseline screenshots
        await mainPage.waitForTimeout(300);
        await expect(mainPage).toHaveScreenshot('01-main-baseline.png', {
            maxDiffPixelRatio: 0.05
        });
        await expect(linkedPage).toHaveScreenshot('01-linked-baseline.png', {
            maxDiffPixelRatio: 0.05
        });

        // ── 4. Select the Regular layer in the main window ──────
        // (Layer selection is handled by the glyph canvas internally
        // based on the current location; no explicit API needed)
        await mainPage.waitForTimeout(300);

        // ── 5. Outline edit: move first node ─────────────────────
        // Use runWithoutRecording to suppress model setter recording,
        // then sync babelfontJson from model, then syncGlyphFromJson.
        // This matches how the outline editor does it: direct data
        // mutation → syncGlyphFromJson (not model setters).
        const outlineLastSyncTime = await getLastFontModelSyncTime(linkedPage);
        const outlineEditResult = await mainPage.evaluate(async (layerId) => {
            const bridge = (window as any).changeBridge;
            const fontModel = (window as any).currentFontModel;
            const currentFont = (window as any).fontManager?.currentFont;
            const glyph = fontModel.findGlyph('a');
            const layer = glyph.findLayerById(layerId);

            const paths = layer.paths;
            if (!paths.length) return { error: 'No paths found' };

            const firstPath = paths[0];
            const nodes = firstPath.nodes;
            if (!nodes.length) return { error: 'No nodes found' };

            const firstNode = nodes[0];
            const oldX = firstNode.x;
            const oldY = firstNode.y;

            // Move node via model setter inside runWithoutRecording
            // so recordChange is suppressed (syncGlyphFromJson handles it)
            bridge.runWithoutRecording(() => {
                firstNode.x = oldX + 10;
                firstNode.y = oldY + 5;
            });

            // Sync babelfontJson from model (converts array nodes to strings)
            currentFont.syncJsonFromModel();

            // Now sync to Y.Doc via change bridge (fast path)
            bridge.syncGlyphFromJson(
                'a',
                'Drag point',
                undefined,
                undefined,
                layerId
            );

            // Check what the Y.Doc looks like AFTER sync
            const Y = (window as any).Y;
            let yDocKeysAfter: string[] = [];
            try {
                const glyphsMap = bridge.fontMap.get('glyphs');
                const glyphMap = glyphsMap.get('a');
                const layersMap = glyphMap.get('layers');
                const layerMap = layersMap.get(layerId);
                if (layerMap) {
                    layerMap.forEach((_v: any, k: string) =>
                        yDocKeysAfter.push(k)
                    );
                }
            } catch (e: any) {
                yDocKeysAfter = ['err:' + e.message];
            }

            return {
                oldX,
                oldY,
                newX: firstNode.x,
                newY: firstNode.y,
                yDocKeysAfterSync: yDocKeysAfter.sort()
            };
        }, thinLayerId);

        expect(outlineEditResult).not.toHaveProperty('error');
        console.log('Outline edit result:', JSON.stringify(outlineEditResult));

        // Wait for remote change to arrive and be processed in linked window
        // Before waiting, install a Y.Doc observer on the linked window
        // to trace what happens when the Yjs update is applied
        await linkedPage.evaluate((layerId) => {
            const bridge = (window as any).changeBridge;
            const Y = (window as any).Y;
            const glyphsMap = bridge.fontMap.get('glyphs');
            const glyphMap = glyphsMap.get('a');
            const layersMap = glyphMap.get('layers');
            const layerMap = layersMap.get(layerId);

            // Observe the layerMap for changes
            if (layerMap) {
                (window as any).__layerObserverLog = [];
                layerMap.observe((event: any) => {
                    const log = (window as any).__layerObserverLog;
                    log.push({
                        keysChanged: [...event.keysChanged],
                        transactionOrigin: event.transaction?.origin,
                        added: [...(event.added ?? [])].map((i: any) =>
                            i.id?.toString?.()
                        ),
                        deleted: [...(event.deleted ?? [])].map((i: any) =>
                            i.id?.toString?.()
                        )
                    });
                });

                // Also observe the top-level fontMap
                (window as any).__fontMapObserverLog = [];
                bridge.fontMap.observe((event: any) => {
                    const log = (window as any).__fontMapObserverLog;
                    log.push({
                        keysChanged: [...event.keysChanged]
                    });
                });
            }
        }, thinLayerId);

        await waitForRemoteChange(linkedPage, outlineLastSyncTime);

        // Check the observer log
        const observerLog = await linkedPage.evaluate((layerId) => {
            const bridge = (window as any).changeBridge;
            let keys: string[] = [];
            try {
                const glyphsMap = bridge.fontMap.get('glyphs');
                const glyphMap = glyphsMap.get('a');
                const layersMap = glyphMap.get('layers');
                const layerMap = layersMap.get(layerId);
                if (layerMap && typeof layerMap.forEach === 'function') {
                    layerMap.forEach((_v: any, k: string) => keys.push(k));
                }
            } catch {}
            return {
                layerKeysAfterSync: keys.sort(),
                layerObserverLog: (window as any).__layerObserverLog || [],
                fontMapObserverLog: (window as any).__fontMapObserverLog || []
            };
        }, thinLayerId);
        console.log('Observer log:', JSON.stringify(observerLog));

        // Debug: check linked window's Y.Doc and model state
        const linkedDebug = await linkedPage.evaluate((layerId) => {
            const bridge = (window as any).changeBridge;
            const fontModel = (window as any).currentFontModel;

            // Check Y.Doc: how many layers does glyph 'a' have?
            let yDocLayerCount = 0;
            let yDocLayerKeysAtTarget: string[] = [];
            try {
                const glyphsMap = bridge?.fontMap?.get('glyphs');
                const glyphMap = glyphsMap?.get('a');
                const layersMap = glyphMap?.get('layers');
                layersMap?.forEach((layerMap: any, layerId2: string) => {
                    yDocLayerCount++;
                    if (
                        layerId2 === layerId &&
                        layerMap &&
                        typeof layerMap.forEach === 'function'
                    ) {
                        layerMap.forEach((_v: any, k: string) =>
                            yDocLayerKeysAtTarget.push(k)
                        );
                    }
                });
            } catch {}

            // Check model
            const glyph = fontModel?.findGlyph('a');
            const modelLayerCount = glyph?.layers?.length;

            return {
                yDocLayerCount,
                yDocLayerKeysAtTarget: yDocLayerKeysAtTarget.sort(),
                modelLayerCount,
                targetLayerId: layerId
            };
        }, thinLayerId);
        console.log('Linked debug:', JSON.stringify(linkedDebug));

        // ── 6. Assert data identity after outline edit ────────────
        const mainDataAfterOutline = await extractGlyphLayerData(
            mainPage,
            glyphNames
        );
        const linkedDataAfterOutline = await extractGlyphLayerData(
            linkedPage,
            glyphNames
        );
        expect(linkedDataAfterOutline).toEqual(mainDataAfterOutline);

        // Y.Doc layer keys must be preserved in the linked window
        const mainYDocKeysAfterOutline = await extractYDocLayerKeys(
            mainPage,
            'a',
            thinLayerId
        );
        const linkedYDocKeysAfterOutline = await extractYDocLayerKeys(
            linkedPage,
            'a',
            thinLayerId
        );
        expect(linkedYDocKeysAfterOutline).toEqual(mainYDocKeysAfterOutline);
        // CRITICAL: The Regular layer must still have core properties
        // (this is the bug — currently fails because only 'shapes' remains)
        expect(linkedYDocKeysAfterOutline).toContain('width');
        expect(linkedYDocKeysAfterOutline).toContain('master');
        expect(linkedYDocKeysAfterOutline).toContain('shapes');
        expect(linkedYDocKeysAfterOutline).toContain('anchors');

        // Raw babelfontData layer properties must be preserved
        const mainRawProps = await extractRawLayerProperties(
            mainPage,
            'a',
            thinLayerId
        );
        const linkedRawProps = await extractRawLayerProperties(
            linkedPage,
            'a',
            thinLayerId
        );
        expect(linkedRawProps).toEqual(mainRawProps);

        // Shapes must have 'closed' field preserved (Y.Doc roundtrip
        // must not lose it — this is what causes compilation errors)
        const mainShapes = await extractRawLayerShapes(
            mainPage,
            'a',
            thinLayerId
        );
        const linkedShapes = await extractRawLayerShapes(
            linkedPage,
            'a',
            thinLayerId
        );
        expect(linkedShapes).toEqual(mainShapes);
        // Verify 'closed' field exists on path shapes
        const pathShapes = (linkedShapes || []).filter(
            (s: any) => 'nodes' in s
        );
        for (const shape of pathShapes) {
            expect(shape).toHaveProperty('closed');
        }

        // Model layer count must stay at 3 (ExtraLight, Regular, ExtraBold)
        const mainLayerCount = await countModelLayers(mainPage, 'a');
        const linkedLayerCount = await countModelLayers(linkedPage, 'a');
        expect(linkedLayerCount).toBe(mainLayerCount);
        expect(linkedLayerCount).toBe(3);

        // Screenshots after outline edit
        await expect(mainPage).toHaveScreenshot(
            '02-main-after-outline-edit.png',
            { maxDiffPixelRatio: 0.05 }
        );
        await expect(linkedPage).toHaveScreenshot(
            '02-linked-after-outline-edit.png',
            { maxDiffPixelRatio: 0.05 }
        );

        // ── 7. Anchor edit: move top anchor ──────────────────────
        const anchorLastSyncTime = await getLastFontModelSyncTime(linkedPage);
        const anchorEditResult = await mainPage.evaluate(async (layerId) => {
            const bridge = (window as any).changeBridge;
            const fontModel = (window as any).currentFontModel;
            const currentFont = (window as any).fontManager?.currentFont;
            const glyph = fontModel.findGlyph('a');
            const layer = glyph.findLayerById(layerId);

            const anchors = layer.anchors;
            if (!anchors.length) return { error: 'No anchors found' };

            // Find the 'top' anchor
            const topAnchor =
                anchors.find((a: any) => a.name === 'top') || anchors[0];
            const oldX = topAnchor.x;
            const oldY = topAnchor.y;

            // Move anchor via model setter inside runWithoutRecording
            bridge.runWithoutRecording(() => {
                topAnchor.x = oldX + 15;
                topAnchor.y = oldY - 10;
            });

            // Sync babelfontJson from model
            currentFont.syncJsonFromModel();

            // Sync to Y.Doc (with layerId for fast path)
            bridge.syncGlyphFromJson(
                'a',
                'Drag anchor',
                undefined,
                undefined,
                layerId
            );

            return {
                anchorName: topAnchor.name,
                oldX,
                oldY,
                newX: topAnchor.x,
                newY: topAnchor.y
            };
        }, thinLayerId);

        expect(anchorEditResult).not.toHaveProperty('error');

        // Wait for remote change
        await waitForRemoteChange(linkedPage, anchorLastSyncTime);

        // ── 8. Assert data identity after anchor edit ─────────────
        const mainDataAfterAnchor = await extractGlyphLayerData(
            mainPage,
            glyphNames
        );
        const linkedDataAfterAnchor = await extractGlyphLayerData(
            linkedPage,
            glyphNames
        );
        expect(linkedDataAfterAnchor).toEqual(mainDataAfterAnchor);

        // Y.Doc layer keys still preserved
        const mainYDocKeysAfterAnchor = await extractYDocLayerKeys(
            mainPage,
            'a',
            thinLayerId
        );
        const linkedYDocKeysAfterAnchor = await extractYDocLayerKeys(
            linkedPage,
            'a',
            thinLayerId
        );
        expect(linkedYDocKeysAfterAnchor).toEqual(mainYDocKeysAfterAnchor);
        expect(linkedYDocKeysAfterAnchor).toContain('width');
        expect(linkedYDocKeysAfterAnchor).toContain('master');
        expect(linkedYDocKeysAfterAnchor).toContain('shapes');
        expect(linkedYDocKeysAfterAnchor).toContain('anchors');

        // Raw properties
        const mainRawProps2 = await extractRawLayerProperties(
            mainPage,
            'a',
            thinLayerId
        );
        const linkedRawProps2 = await extractRawLayerProperties(
            linkedPage,
            'a',
            thinLayerId
        );
        expect(linkedRawProps2).toEqual(mainRawProps2);

        // Anchors must be identical
        const mainAnchors = await extractRawLayerAnchors(
            mainPage,
            'a',
            thinLayerId
        );
        const linkedAnchors = await extractRawLayerAnchors(
            linkedPage,
            'a',
            thinLayerId
        );
        expect(linkedAnchors).toEqual(mainAnchors);

        // ── 9. Compilation check ──────────────────────────────────
        // Wait for compilation to settle in both windows
        await waitForEditingCompile(mainPage);
        await waitForEditingCompile(linkedPage);

        // Check that editing font compiled in the linked window
        const linkedEditingFont = await linkedPage.evaluate(() => {
            return !!(window as any).fontManager?.editingFont;
        });
        expect(linkedEditingFont).toBe(true);

        // Check for compilation error banner in linked window
        const linkedCompilationError = await linkedPage.evaluate(() => {
            const errorBanner = document.querySelector(
                '.compilation-error-banner, .compile-error'
            );
            return errorBanner?.textContent || null;
        });
        expect(linkedCompilationError).toBeNull();

        // Main window should also have a valid editing font
        const mainEditingFont = await mainPage.evaluate(() => {
            return !!(window as any).fontManager?.editingFont;
        });
        expect(mainEditingFont).toBe(true);

        // ── 10. Final screenshots ────────────────────────────────
        await expect(mainPage).toHaveScreenshot(
            '03-main-after-anchor-edit.png',
            { maxDiffPixelRatio: 0.05 }
        );
        await expect(linkedPage).toHaveScreenshot(
            '03-linked-after-anchor-edit.png',
            { maxDiffPixelRatio: 0.05 }
        );

        // ── Cleanup ──────────────────────────────────────────────
        await context.close();
    });
});
