import { test, expect, type Page } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForFontLoaded
} from './helpers/snapshot-helper';
import { rectLineNodes } from './helpers/babelfont-test-data';

function makeTestFont(): string {
    return JSON.stringify({
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
        masters: [
            {
                name: { dflt: 'Regular' },
                id: 'M0',
                location: {},
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
        names: { family_name: { dflt: 'LinkedCompileTest' } },
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
                    path: '/test/LinkedCompileTest.babelfont',
                    babelfontJson: json,
                    sourcePlugin: plugin
                }
            })
        );
    }, fontJson);
}

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
            if (!sync || !bridge) {
                return false;
            }
            const glyphsMap = bridge.fontMap?.get('glyphs');
            if (!glyphsMap) {
                return false;
            }
            let glyphCount = 0;
            glyphsMap.forEach(() => glyphCount++);
            return glyphCount > 0;
        },
        { timeout: 20000 }
    );
    await page.waitForTimeout(500);
}

async function installEditingFontCompileTracker(page: Page): Promise<void> {
    await page.evaluate(() => {
        const testWindow = window as any;
        if (testWindow.__linkedCompileTrackerInstalled) {
            return;
        }

        const hashBytes = (bytes: Uint8Array | null | undefined): string => {
            if (!bytes?.length) {
                return 'none';
            }
            let hash = 2166136261;
            for (let index = 0; index < bytes.length; index += 1) {
                hash ^= bytes[index];
                hash = Math.imul(hash, 16777619);
            }
            return `${bytes.length}:${(hash >>> 0).toString(16)}`;
        };

        testWindow.__editingFontCompiledCount = 0;
        testWindow.__lastEditingFontCompiledRevision = -1;
        testWindow.__lastEditingFontHash = hashBytes(
            (window as any).fontManager?.editingFont
        );

        window.addEventListener('editingFontCompiled', (event) => {
            const detail = (event as CustomEvent).detail;
            testWindow.__editingFontCompiledCount += 1;
            testWindow.__lastEditingFontCompiledRevision = Number(
                detail?.fontRevisionKey ?? -1
            );
            testWindow.__lastEditingFontHash = hashBytes(
                detail?.fontBytes as Uint8Array | null | undefined
            );
        });

        testWindow.__linkedCompileTrackerInstalled = true;
    });
}

async function getEditingFontCompileTracker(page: Page): Promise<{
    count: number;
    revision: number;
    hash: string;
}> {
    return page.evaluate(() => ({
        count: (window as any).__editingFontCompiledCount ?? 0,
        revision: (window as any).__lastEditingFontCompiledRevision ?? -1,
        hash: (window as any).__lastEditingFontHash ?? 'none'
    }));
}

async function waitForEditingFontCompileEvent(
    page: Page,
    previousCount: number
): Promise<void> {
    await page.waitForFunction(
        (count) => ((window as any).__editingFontCompiledCount ?? 0) > count,
        previousCount,
        { timeout: 20000 }
    );
}

async function setEditingContext(
    page: Page,
    glyphName: string,
    layerId: string
): Promise<void> {
    await page.evaluate(
        async ({ glyphName, layerId }) => {
            const glyphCanvas = (window as any).glyphCanvas;
            const textRunEditor = glyphCanvas?.textRunEditor;
            const outlineEditor = glyphCanvas?.outlineEditor;
            if (!glyphCanvas || !textRunEditor || !outlineEditor) {
                throw new Error('Missing glyph canvas editor dependencies');
            }

            textRunEditor.setTextBuffer(glyphName);
            await textRunEditor.selectGlyphByIndex(0, true);
            outlineEditor.active = true;
            outlineEditor.currentGlyphName = glyphName;
            outlineEditor.selectedLayerId = layerId;
            await glyphCanvas.doUIUpdateAsync?.();
        },
        { glyphName, layerId }
    );
}

async function forceEditingCompile(
    page: Page,
    glyphName: string
): Promise<void> {
    await page.evaluate(async (activeGlyphName) => {
        await (window as any).fontManager.compileEditingFont(
            activeGlyphName,
            [],
            [activeGlyphName]
        );
    }, glyphName);
}

async function editGlyphNode(
    page: Page,
    glyphName: string,
    layerId: string,
    deltaX: number,
    deltaY: number
): Promise<void> {
    await page.evaluate(
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

            bridge.runWithoutRecording(() => {
                node.x = Number(node.x) + deltaX;
                node.y = Number(node.y) + deltaY;
            });

            currentFont.syncJsonFromModel();
            bridge.syncGlyphFromJson(
                glyphName,
                'Drag point',
                undefined,
                undefined,
                layerId
            );
        },
        { glyphName, layerId, deltaX, deltaY }
    );
}

test.describe('Linked window editing compile regression', () => {
    test('linked window emits fresh editing-font compiles for remote and local edits', async ({
        browser
    }) => {
        test.setTimeout(300000);

        const glyphName = 'o';
        const layerId = 'L0';

        const context = await browser.newContext();
        const mainPage = await context.newPage();

        await mainPage.goto('/?test=true');
        await waitForCanvasReady(mainPage);
        await loadTestFont(mainPage);
        await waitForFontLoaded(mainPage);
        await waitForBridgeReady(mainPage);

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

        await linkedPage.waitForFunction(
            () => (window as any).windowSync?.peers?.size > 0,
            { timeout: 15000 }
        );
        await mainPage.waitForFunction(
            () => (window as any).windowSync?.peers?.size > 0,
            { timeout: 15000 }
        );

        await installEditingFontCompileTracker(mainPage);
        await installEditingFontCompileTracker(linkedPage);

        await setEditingContext(mainPage, glyphName, layerId);
        await setEditingContext(linkedPage, glyphName, layerId);

        const linkedInitialTracker =
            await getEditingFontCompileTracker(linkedPage);
        await forceEditingCompile(linkedPage, glyphName);
        await waitForEditingFontCompileEvent(
            linkedPage,
            linkedInitialTracker.count
        );

        const beforeRemote = await getEditingFontCompileTracker(linkedPage);
        await editGlyphNode(mainPage, glyphName, layerId, 17, 0);
        await waitForEditingFontCompileEvent(linkedPage, beforeRemote.count);
        const afterRemote = await getEditingFontCompileTracker(linkedPage);

        expect(afterRemote.count).toBeGreaterThan(beforeRemote.count);
        expect(afterRemote.revision).toBeGreaterThan(beforeRemote.revision);
        expect(afterRemote.hash).not.toBe(beforeRemote.hash);

        const beforeLocal = await getEditingFontCompileTracker(linkedPage);
        await editGlyphNode(linkedPage, glyphName, layerId, 0, 19);
        await waitForEditingFontCompileEvent(linkedPage, beforeLocal.count);
        const afterLocal = await getEditingFontCompileTracker(linkedPage);

        expect(afterLocal.count).toBeGreaterThan(beforeLocal.count);
        expect(afterLocal.revision).toBeGreaterThan(beforeLocal.revision);
        expect(afterLocal.hash).not.toBe(beforeLocal.hash);

        await context.close();
    });
});
