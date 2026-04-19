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
    await page.waitForFunction(
        () => !!(window as any).windowSync,
        { timeout: 15000 }
    );
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

/**
 * Wait for a remote change to arrive in the linked window.
 * Checks for: 1) change log growth, 2) Y.Doc glyph width change, 3) model width change.
 */
async function waitForRemoteChange(
    linkedPage: Page,
    glyphName: string,
    regularLayerId: string,
    expectedWidth: number
): Promise<void> {
    // Wait for either change log growth OR the model layer width to change
    await linkedPage.waitForFunction(
        ({ glyphName, layerId, expectedWidth }) => {
            const bridge = (window as any).changeBridge;
            if (!bridge) return false;
            // Check if the font model has the expected width
            const fontModel = (window as any).currentFontModel;
            if (fontModel) {
                const glyph = fontModel.findGlyph(glyphName);
                const layer = glyph?.findLayerById(layerId);
                if (layer && Math.abs(layer.width - expectedWidth) < 0.01) {
                    return true;
                }
            }
            return false;
        },
        { glyphName, layerId: regularLayerId, expectedWidth },
        { timeout: 30000 }
    );
    // Allow UI and compilation to settle
    await linkedPage.waitForTimeout(2000);
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
): Promise<Record<string, any>> {
    return page.evaluate(
        ({ glyphName, layerId }) => {
            const rawData = (window as any).fontManager?.currentFont
                ?.babelfontData;
            const glyph = rawData?.glyphs?.find(
                (g: any) => g.name === glyphName
            );
            const layer = glyph?.layers?.find(
                (l: any) => l.id === layerId
            );
            if (!layer) return null;

            // Return a copy with all enumerable own properties
            const result: Record<string, any> = {};
            for (const key of Object.keys(layer)) {
                const value = layer[key];
                // Skip shapes/anchors for brevity (tested separately)
                if (key === 'shapes' || key === 'anchors') continue;
                result[key] = JSON.parse(JSON.stringify(value));
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
            const layer = glyph?.layers?.find(
                (l: any) => l.id === layerId
            );
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
            const layer = glyph?.layers?.find(
                (l: any) => l.id === layerId
            );
            if (!layer) return null;
            return JSON.parse(JSON.stringify(layer.anchors));
        },
        { glyphName, layerId }
    );
}

/** Find the Regular master's layer ID in the Fustat font. */
async function findRegularLayerId(page: Page): Promise<string> {
    return page.evaluate(() => {
        const fontModel = (window as any).currentFontModel;
        const masters = fontModel?.masters || [];
        // The Regular master in Fustat is the second one (index 1)
        // with wght:400 location. Its layer ID equals its master ID.
        for (const master of masters) {
            const name = master.name;
            const nameStr =
                typeof name === 'string'
                    ? name
                    : name?.dflt || '';
            const loc = master.location || {};
            if (loc.wght === 400 || nameStr === 'Regular') {
                return master.id;
            }
        }
        // Fallback: second master
        return masters[1]?.id || masters[0]?.id || '';
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
    test('linked window preserves all layer data after remote outline and anchor edits on Regular layer', async ({
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

        // Find the Regular master layer ID
        const regularLayerId = await findRegularLayerId(mainPage);
        expect(regularLayerId).toBeTruthy();
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
            regularLayerId
        );
        const linkedYDocKeys = await extractYDocLayerKeys(
            linkedPage,
            'a',
            regularLayerId
        );
        expect(linkedYDocKeys).toEqual(mainYDocKeys);
        // Sanity: Regular layer Y.Doc must have core properties
        expect(mainYDocKeys).toContain('width');
        expect(mainYDocKeys).toContain('master');
        expect(mainYDocKeys).toContain('shapes');
        expect(mainYDocKeys).toContain('anchors');

        // Baseline screenshots
        await mainPage.waitForTimeout(300);
        await expect(mainPage).toHaveScreenshot(
            '01-main-baseline.png',
            { maxDiffPixelRatio: 0.05 }
        );
        await expect(linkedPage).toHaveScreenshot(
            '01-linked-baseline.png',
            { maxDiffPixelRatio: 0.05 }
        );

        // ── 4. Select the Regular layer in the main window ──────
        await mainPage.evaluate(async (layerId) => {
            const gc = (window as any).glyphCanvas;
            const oe = gc?.outlineEditor;
            if (oe && oe.setSelectedLayer) {
                oe.setSelectedLayer(layerId);
            }
            gc?.render?.();
        }, regularLayerId);

        await mainPage.waitForTimeout(300);

        // ── 5. Outline edit: move first node ─────────────────────
        const outlineEditResult = await mainPage.evaluate(
            async (layerId) => {
                const fontModel = (window as any).currentFontModel;
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

                firstNode.x = oldX + 10;
                firstNode.y = oldY + 5;

                const bridge = (window as any).changeBridge;
                bridge.syncGlyphFromJson(
                    'a',
                    'Drag point',
                    undefined,
                    undefined,
                    layerId
                );

                return { oldX, oldY, newX: firstNode.x, newY: firstNode.y };
            },
            regularLayerId
        );

        expect(outlineEditResult).not.toHaveProperty('error');

        // Wait for remote change to arrive in linked window
        // After the outline edit, the width may or may not have changed;
        // use the current sender width as the expected value
        const senderWidthAfterOutline = await mainPage.evaluate(
            (layerId) => {
                const fontModel = (window as any).currentFontModel;
                const glyph = fontModel.findGlyph('a');
                const layer = glyph.findLayerById(layerId);
                return layer?.width ?? 0;
            },
            regularLayerId
        );
        await waitForRemoteChange(
            linkedPage,
            'a',
            regularLayerId,
            senderWidthAfterOutline
        );

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
            regularLayerId
        );
        const linkedYDocKeysAfterOutline = await extractYDocLayerKeys(
            linkedPage,
            'a',
            regularLayerId
        );
        expect(linkedYDocKeysAfterOutline).toEqual(
            mainYDocKeysAfterOutline
        );
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
            regularLayerId
        );
        const linkedRawProps = await extractRawLayerProperties(
            linkedPage,
            'a',
            regularLayerId
        );
        expect(linkedRawProps).toEqual(mainRawProps);

        // Shapes must have 'closed' field preserved (Y.Doc roundtrip
        // must not lose it — this is what causes compilation errors)
        const mainShapes = await extractRawLayerShapes(
            mainPage,
            'a',
            regularLayerId
        );
        const linkedShapes = await extractRawLayerShapes(
            linkedPage,
            'a',
            regularLayerId
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
        const anchorEditResult = await mainPage.evaluate(
            async (layerId) => {
                const fontModel = (window as any).currentFontModel;
                const glyph = fontModel.findGlyph('a');
                const layer = glyph.findLayerById(layerId);

                const anchors = layer.anchors;
                if (!anchors.length) return { error: 'No anchors found' };

                // Find the 'top' anchor
                const topAnchor =
                    anchors.find((a: any) => a.name === 'top') ||
                    anchors[0];
                const oldX = topAnchor.x;
                const oldY = topAnchor.y;

                topAnchor.x = oldX + 15;
                topAnchor.y = oldY - 10;

                const bridge = (window as any).changeBridge;
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
            },
            regularLayerId
        );

        expect(anchorEditResult).not.toHaveProperty('error');

        // Wait for remote change
        const senderWidthAfterAnchor = await mainPage.evaluate(
            (layerId) => {
                const fontModel = (window as any).currentFontModel;
                const glyph = fontModel.findGlyph('a');
                const layer = glyph.findLayerById(layerId);
                return layer?.width ?? 0;
            },
            regularLayerId
        );
        await waitForRemoteChange(
            linkedPage,
            'a',
            regularLayerId,
            senderWidthAfterAnchor
        );

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
            regularLayerId
        );
        const linkedYDocKeysAfterAnchor = await extractYDocLayerKeys(
            linkedPage,
            'a',
            regularLayerId
        );
        expect(linkedYDocKeysAfterAnchor).toEqual(
            mainYDocKeysAfterAnchor
        );
        expect(linkedYDocKeysAfterAnchor).toContain('width');
        expect(linkedYDocKeysAfterAnchor).toContain('master');
        expect(linkedYDocKeysAfterAnchor).toContain('shapes');
        expect(linkedYDocKeysAfterAnchor).toContain('anchors');

        // Raw properties
        const mainRawProps2 = await extractRawLayerProperties(
            mainPage,
            'a',
            regularLayerId
        );
        const linkedRawProps2 = await extractRawLayerProperties(
            linkedPage,
            'a',
            regularLayerId
        );
        expect(linkedRawProps2).toEqual(mainRawProps2);

        // Anchors must be identical
        const mainAnchors = await extractRawLayerAnchors(
            mainPage,
            'a',
            regularLayerId
        );
        const linkedAnchors = await extractRawLayerAnchors(
            linkedPage,
            'a',
            regularLayerId
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
