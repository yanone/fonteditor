import { test, expect, type Page } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForFontLoaded
} from './helpers/snapshot-helper';
import { rectLineNodes } from './helpers/babelfont-test-data';

// ── Test font (simple, memory-based) ────────────────────────────────

function makeTestFont(): string {
    return JSON.stringify({
        upm: 1000,
        version: [1, 0],
        axes: [
            {
                name: { dflt: 'Weight' },
                tag: 'wght',
                id: 'weight',
                min: 100,
                default: 400,
                max: 900
            }
        ],
        instances: [],
        masters: [
            {
                name: { dflt: 'Regular' },
                id: 'M0',
                location: { wght: 400 },
                guides: [],
                metrics: {},
                kerning: {},
                custom_ot_values: {},
                format_specific: {}
            }
        ],
        glyphs: [
            {
                name: '.notdef',
                category: 'Base',
                layers: [
                    {
                        width: 600,
                        id: 'L0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            {
                                nodes: rectLineNodes(
                                    0,
                                    0,
                                    600,
                                    0,
                                    600,
                                    700,
                                    0,
                                    700
                                ),
                                closed: true
                            }
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                exported: true
            },
            {
                name: 'o',
                category: 'Base',
                codepoints: [111],
                layers: [
                    {
                        width: 500,
                        id: 'L0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            {
                                nodes: rectLineNodes(
                                    100,
                                    100,
                                    400,
                                    100,
                                    400,
                                    600,
                                    100,
                                    600
                                ),
                                closed: true
                            }
                        ],
                        anchors: [{ name: 'top', x: 250, y: 600 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                exported: true
            }
        ],
        date: new Date().toISOString(),
        names: { family_name: { dflt: 'MultiEditTest' } },
        features: { classes: {}, prefixes: {}, features: [] }
    });
}

async function loadTestFont(page: Page): Promise<void> {
    const fontJson = makeTestFont();
    await page.evaluate((json) => {
        const plugin = (window as any).pluginRegistry.get('memory');
        window.dispatchEvent(
            new CustomEvent('fontLoaded', {
                detail: {
                    path: '/test/MultiEditTest.babelfont',
                    babelfontJson: json,
                    sourcePlugin: plugin
                }
            })
        );
    }, fontJson);
}

// ── Helpers ──────────────────────────────────────────────────────────

async function waitForBridgeReady(page: Page): Promise<void> {
    await page.waitForFunction(
        () =>
            !!(window as any).patchSyncEngine &&
            !!(window as any).currentFontModel &&
            !!(window as any).fontManager?.currentFont,
        { timeout: 20000 }
    );
    await page.waitForTimeout(500);
}

async function waitForWindowSyncReady(page: Page): Promise<void> {
    await page.waitForFunction(() => !!(window as any).windowSync, {
        timeout: 15000
    });
}

async function waitForFullStateSync(page: Page): Promise<void> {
    await page.waitForFunction(
        () => {
            const sync = (window as any).windowSync;
            const bridge = (window as any).patchSyncEngine;
            if (!sync || !bridge) return false;
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

async function getLayerCheck(
    page: Page,
    glyphName: string,
    layerId: string
): Promise<{
    fontJsonNodes: string;
    ydKeys: string[];
    ydNodes: string;
}> {
    return page.evaluate(
        ({ glyphName, layerId }) => {
            const bridge = (window as any).patchSyncEngine;

            // Read from _fontJson
            const fj = bridge.getFontJsonSnapshot();
            const glyphs = fj?.glyphs || [];
            const g = glyphs.find(
                (gg: Record<string, unknown>) => gg.name === glyphName
            );
            const layers = (g as any)?.layers || [];
            const l = layers.find(
                (ll: Record<string, unknown>) => ll.id === layerId
            );
            const fontJsonNodes =
                l && Array.isArray(l.shapes) && l.shapes[0]
                    ? String(l.shapes[0].nodes)
                    : 'N/A';

            // Read from Y.Doc
            const gM = bridge.fontMap?.get('glyphs') as any;
            const gMap = gM?.get(glyphName);
            const lMapM = gMap?.get('layers');
            const lMap = lMapM?.get(layerId);
            const ydKeys: string[] = [];
            if (lMap && typeof lMap.forEach === 'function') {
                lMap.forEach((_v: unknown, k: string) => ydKeys.push(k));
            }
            let ydNodes = 'N/A';
            if (lMap) {
                const ydShapes = lMap.get('shapes');
                if (ydShapes && typeof ydShapes.get === 'function') {
                    const shape0 = ydShapes.get(0);
                    if (shape0 && typeof shape0.get === 'function') {
                        ydNodes = String(shape0.get('nodes') || 'N/A');
                    }
                } else {
                    const ydShapesById = lMap.get('shapesById');
                    const ydShapeOrder = lMap.get('shapeOrder');
                    if (
                        ydShapesById &&
                        typeof ydShapesById.get === 'function' &&
                        ydShapeOrder &&
                        typeof ydShapeOrder.get === 'function'
                    ) {
                        const shapeId = ydShapeOrder.get(0);
                        const shape0 = shapeId
                            ? ydShapesById.get(shapeId)
                            : null;
                        if (shape0 && typeof shape0.get === 'function') {
                            ydNodes = String(shape0.get('nodes') || 'N/A');
                        }
                    }
                }
            }

            return { fontJsonNodes, ydKeys: ydKeys.sort(), ydNodes };
        },
        { glyphName, layerId }
    );
}

async function editGlyphNode(
    page: Page,
    glyphName: string,
    layerId: string,
    deltaX: number,
    deltaY: number
): Promise<{
    before: { x: number; y: number };
    after: { x: number; y: number };
}> {
    return page.evaluate(
        ({ glyphName, layerId, deltaX, deltaY }) => {
            const bridge = (window as any).patchSyncEngine;
            const fontModel = (window as any).currentFontModel;
            const currentFont = (window as any).fontManager?.currentFont;
            const glyph = fontModel?.findGlyph?.(glyphName);
            const layer = glyph?.findLayerById?.(layerId);
            const path = layer?.paths?.[0];
            const node = path?.nodes?.[0];

            if (!bridge || !currentFont || !node) {
                throw new Error('Missing bridge, font, or target node');
            }

            const before = { x: Number(node.x), y: Number(node.y) };

            bridge.runWithoutRecording(() => {
                node.x = before.x + deltaX;
                node.y = before.y + deltaY;
            });

            currentFont.syncJsonFromModel();
            bridge.syncGlyphFromJson(
                glyphName,
                'Drag point',
                undefined,
                undefined,
                layerId
            );

            return {
                before,
                after: { x: Number(node.x), y: Number(node.y) }
            };
        },
        { glyphName, layerId, deltaX, deltaY }
    );
}

// ── Test ──────────────────────────────────────────────────────────────

test.describe('Multi-edit linked window sync', () => {
    test('propagates multiple sequential glyph edits to linked window without corruption', async ({
        browser
    }) => {
        test.setTimeout(300000);

        const context = await browser.newContext();
        const mainPage = await context.newPage();

        // ── 1. Open main window and load test font ─────────────────
        await mainPage.goto('/?test=true');
        await waitForCanvasReady(mainPage);
        await loadTestFont(mainPage);
        await waitForFontLoaded(mainPage);
        await waitForBridgeReady(mainPage);

        const layerId = 'L0';
        const glyphName = 'o';

        // ── 2. Open linked window ────────────────────────────────
        const [linkedPage] = await Promise.all([
            context.waitForEvent('page'),
            (async () => {
                await mainPage.locator('#toolbar-window-menu-btn').click();
                await mainPage
                    .locator('.tippy-box:visible .plugin-menu-item', {
                        hasText: 'Open In New Window'
                    })
                    .click();
            })()
        ]);

        await waitForCanvasReady(linkedPage);
        await loadTestFont(linkedPage);
        await waitForFontLoaded(linkedPage);
        await waitForFullStateSync(linkedPage);
        await waitForBridgeReady(linkedPage);
        await waitForWindowSyncReady(linkedPage);

        // Wait for peers to detect each other
        await linkedPage.waitForFunction(
            () => (window as any).windowSync?.peers?.size > 0,
            { timeout: 15000 }
        );
        await mainPage.waitForFunction(
            () => (window as any).windowSync?.peers?.size > 0,
            { timeout: 15000 }
        );
        await linkedPage.waitForTimeout(500);

        // ── 3. Verify baseline ─────────────────────────────────────
        const mainBaseline = await getLayerCheck(mainPage, glyphName, layerId);
        const linkedBaseline = await getLayerCheck(
            linkedPage,
            glyphName,
            layerId
        );
        expect(linkedBaseline).toEqual(mainBaseline);

        // ── 4. Do multiple sequential edits ────────────────────────
        const editCount = 7;

        for (let i = 0; i < editCount; i++) {
            const deltaX = 5 + i * 3;
            const deltaY = 3 + i * 2;
            const editResult = await editGlyphNode(
                mainPage,
                glyphName,
                layerId,
                deltaX,
                deltaY
            );

            expect(editResult.after.x).toBe(editResult.before.x + deltaX);
            expect(editResult.after.y).toBe(editResult.before.y + deltaY);

            // Wait for BroadcastChannel propagation
            await linkedPage.waitForTimeout(500);

            // Verify data identity after each edit
            const mainAfter = await getLayerCheck(mainPage, glyphName, layerId);
            const linkedAfter = await getLayerCheck(
                linkedPage,
                glyphName,
                layerId
            );

            expect(
                linkedAfter,
                `Edit ${i + 1}: linked data should match main`
            ).toEqual(mainAfter);

            // Verify Y.Doc layer keys are preserved
            expect(linkedAfter.ydKeys).toContain('width');
            expect(linkedAfter.ydKeys).toContain('master');
            expect(linkedAfter.ydKeys).toContain('shapeOrder');
            expect(linkedAfter.ydKeys).toContain('shapesById');
            expect(linkedAfter.ydKeys).toContain('anchorOrder');
            expect(linkedAfter.ydKeys).toContain('anchorsById');
        }

        // ── 5. All edits passed ───────────────────────────────────
        await context.close();
    });
});
