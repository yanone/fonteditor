import { test, expect, type Page } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForFontLoaded
} from './helpers/snapshot-helper';

function makeCloudTestFont(): string {
    const nodes = (
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        x3: number,
        y3: number,
        x4: number,
        y4: number
    ) => `${x1} ${y1} l ${x2} ${y2} l ${x3} ${y3} l ${x4} ${y4} l`;

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
                        id: 'NL0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            {
                                nodes: '0 0 l 600 0 l 600 700 l 0 700 l',
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
                name: 'A',
                category: 'Base',
                codepoints: [65],
                layers: [
                    {
                        width: 600,
                        id: 'L0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            {
                                nodes: nodes(
                                    80,
                                    80,
                                    420,
                                    80,
                                    420,
                                    620,
                                    80,
                                    620
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
                                nodes: nodes(0, 0, 500, 0, 500, 700, 0, 700),
                                closed: true
                            }
                        ],
                        anchors: [{ name: 'top', x: 250, y: 700 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                exported: true
            },
            {
                name: 'dieresiscomb',
                category: 'Mark',
                codepoints: [776],
                layers: [
                    {
                        width: 180,
                        id: 'L0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            {
                                nodes: nodes(0, 0, 80, 0, 80, 120, 0, 120),
                                closed: true
                            }
                        ],
                        anchors: [{ name: '_top', x: 40, y: 0 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                exported: true
            },
            {
                name: 'odieresis',
                category: 'Base',
                codepoints: [246],
                layers: [
                    {
                        width: 600,
                        id: 'L0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            {
                                reference: 'o',
                                transform: {
                                    translation: [0, 0],
                                    scale: [1, 1],
                                    rotation: 0,
                                    skew: [0, 0],
                                    tCenter: [0, 0],
                                    order: 'RestOfTheWorld'
                                },
                                format_specific: {
                                    'com.schriftgestalt.Glyphs.alignment': 0
                                }
                            },
                            {
                                reference: 'dieresiscomb',
                                transform: {
                                    translation: [0, 0],
                                    scale: [1, 1],
                                    rotation: 0,
                                    skew: [0, 0],
                                    tCenter: [0, 0],
                                    order: 'RestOfTheWorld'
                                },
                                format_specific: {
                                    'com.schriftgestalt.Glyphs.alignment': 0
                                }
                            }
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                exported: true
            }
        ],
        date: new Date().toISOString(),
        names: { family_name: { dflt: 'CloudLocalTest' } },
        features: { classes: {}, prefixes: {}, features: [] }
    });
}

async function loadCloudTestFont(page: Page): Promise<void> {
    const fontJson = makeCloudTestFont();
    await page.evaluate((json) => {
        const plugin = (window as any).pluginRegistry.get('memory');
        window.dispatchEvent(
            new CustomEvent('fontLoaded', {
                detail: {
                    path: '/test/CloudLocalTest.babelfont',
                    babelfontJson: json,
                    sourcePlugin: plugin
                }
            })
        );
    }, fontJson);
}

async function bootstrapCloudSession(
    page: Page,
    email = 'local-dev@counterpunch.test'
): Promise<void> {
    await page.evaluate(async (nextEmail) => {
        await (window as any).cloudDebug.bootstrapLocalSession(nextEmail);
    }, email);

    await page.waitForFunction(
        () => !!(window as any).authManager?.isAuthenticated?.(),
        { timeout: 15000 }
    );
}

async function waitForCloudConnected(page: Page): Promise<void> {
    await page.waitForFunction(
        () => (window as any).cloudDebug?.getStatus?.() === 'connected',
        { timeout: 30000 }
    );
}

async function waitForPythonReady(page: Page): Promise<void> {
    await page.waitForFunction(
        () => typeof (window as any).pyodide?.runPythonAsync === 'function',
        { timeout: 30000 }
    );
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

async function openLinkedWindow(page: Page, assetId?: string): Promise<Page> {
    const context = page.context();
    const [linkedPage] = await Promise.all([
        context.waitForEvent('page'),
        (async () => {
            await page.locator('#toolbar-window-menu-btn').click();
            await page
                .locator('.tippy-box:visible .plugin-menu-item', {
                    hasText: 'Open In New Window'
                })
                .click();
        })()
    ]);

    await waitForCanvasReady(linkedPage);

    if (assetId) {
        await linkedPage.evaluate(async (nextAssetId) => {
            await (window as any).cloudPlugin.openAsset(nextAssetId);
        }, assetId);
    }

    await waitForFontLoaded(linkedPage);
    await waitForFullStateSync(linkedPage);
    await waitForBridgeReady(linkedPage);
    await waitForWindowSyncReady(linkedPage);
    await linkedPage.waitForFunction(
        () => (window as any).windowSync?.peers?.size > 0,
        { timeout: 30000 }
    );

    await page.waitForFunction(
        () => (window as any).windowSync?.peers?.size > 0,
        { timeout: 30000 }
    );

    return linkedPage;
}

async function setupEditTextMode(
    page: Page,
    textBuffer: string = 'ö'
): Promise<void> {
    await page.evaluate(async (nextTextBuffer) => {
        const glyphCanvas = (window as any).glyphCanvas;
        glyphCanvas.textRunEditor.setTextBuffer(nextTextBuffer);
        await glyphCanvas.textRunEditor.selectGlyphByIndex(0, true);
    }, textBuffer);
    await page.waitForTimeout(500);
}

async function waitForEditingCompile(page: Page): Promise<void> {
    await page.waitForFunction(
        () => {
            const fontManager = (window as any).fontManager;
            if (!fontManager?.currentFont) {
                return false;
            }

            return (
                !fontManager.currentFont.needsRecompile ||
                fontManager.editingFont !== null
            );
        },
        { timeout: 20000 }
    );
    await page.waitForTimeout(300);
}

async function installEditingFontCompileTracker(page: Page): Promise<void> {
    await page.evaluate(() => {
        const testWindow = window as any;
        if (testWindow.__editingFontCompileTrackerInstalled) {
            return;
        }

        testWindow.__editingFontCompiledCount = 0;
        testWindow.__lastEditingFontCompiledRevision = -1;
        window.addEventListener('editingFontCompiled', (event) => {
            testWindow.__editingFontCompiledCount += 1;
            testWindow.__lastEditingFontCompiledRevision = Number(
                (event as CustomEvent)?.detail?.revision ?? -1
            );
        });
        testWindow.__editingFontCompileTrackerInstalled = true;
    });
}

async function getEditingFontCompileTracker(page: Page): Promise<{
    count: number;
    revision: number;
}> {
    return page.evaluate(() => ({
        count: (window as any).__editingFontCompiledCount ?? 0,
        revision: (window as any).__lastEditingFontCompiledRevision ?? -1
    }));
}

async function waitForEditingFontCompileEvent(
    page: Page,
    previousCount: number
): Promise<void> {
    await page.waitForFunction(
        (count) => ((window as any).__editingFontCompiledCount ?? 0) > count,
        previousCount,
        { timeout: 30000 }
    );
}

async function getCompiledGlyphBounds(
    page: Page,
    glyphName: string
): Promise<{ x1: number; y1: number; x2: number; y2: number }> {
    return page.evaluate((targetGlyphName) => {
        const glyphCanvas = (window as any).glyphCanvas;
        const textRunEditor = (window as any).glyphCanvas?.textRunEditor;
        const glyphBounds = Array.isArray(glyphCanvas?.glyphBounds)
            ? glyphCanvas.glyphBounds
            : [];
        if (!textRunEditor || glyphBounds.length === 0) {
            throw new Error('Compiled glyph bounds are not available');
        }

        const shapedGlyphs = Array.isArray(textRunEditor?.shapedGlyphs)
            ? textRunEditor.shapedGlyphs
            : [];
        const glyphNameBuffer = Array.isArray(textRunEditor?.glyphNameBuffer)
            ? textRunEditor.glyphNameBuffer
            : [];

        for (let index = 0; index < shapedGlyphs.length; index += 1) {
            const shapedGlyph = shapedGlyphs[index];
            const resolvedName =
                shapedGlyph?.explicitGlyphName || glyphNameBuffer[index];
            if (resolvedName === targetGlyphName && glyphBounds[index]) {
                return {
                    x1: Number(glyphBounds[index].x1),
                    y1: Number(glyphBounds[index].y1),
                    x2: Number(glyphBounds[index].x2),
                    y2: Number(glyphBounds[index].y2)
                };
            }
        }

        throw new Error(
            `Glyph ${targetGlyphName} is not present in compiled glyph bounds`
        );
    }, glyphName);
}

async function waitForPrimaryNodePosition(
    page: Page,
    expected: { x: number; y: number }
): Promise<void> {
    await expect
        .poll(async () => await getPrimaryNodePosition(page), {
            timeout: 15000
        })
        .toEqual(expected);
}

async function fetchRoomStatus(page: Page, assetId: string) {
    return page.evaluate(async (nextAssetId) => {
        const response = await fetch(
            `http://localhost:8787/room/${encodeURIComponent(nextAssetId)}/status`
        );
        if (!response.ok) {
            throw new Error(`status request failed: ${response.status}`);
        }
        return await response.json();
    }, assetId);
}

async function getPrimaryNodePosition(page: Page): Promise<{
    x: number;
    y: number;
}> {
    return page.evaluate(() => {
        const glyph = (window as any).currentFontModel?.findGlyph?.('A');
        const layer = glyph?.findLayerById?.('L0');
        const path = layer?.paths?.[0];
        const node = path?.nodes?.[0];
        return {
            x: Number(node?.x ?? NaN),
            y: Number(node?.y ?? NaN)
        };
    });
}

async function movePrimaryNode(
    page: Page,
    deltaX: number,
    deltaY: number
): Promise<{
    before: { x: number; y: number };
    after: { x: number; y: number };
}> {
    return page.evaluate(
        ({ nextDeltaX, nextDeltaY }) => {
            const bridge = (window as any).patchSyncEngine;
            const fontModel = (window as any).currentFontModel;
            const currentFont = (window as any).fontManager?.currentFont;
            const glyph = fontModel?.findGlyph?.('A');
            const layer = glyph?.findLayerById?.('L0');
            const path = layer?.paths?.[0];
            const node = path?.nodes?.[0];

            if (!bridge || !currentFont || !node) {
                throw new Error('Missing bridge, font, or target node');
            }

            const before = { x: Number(node.x), y: Number(node.y) };

            bridge.runWithoutRecording(() => {
                node.x = before.x + nextDeltaX;
                node.y = before.y + nextDeltaY;
            });

            currentFont.syncJsonFromModel();
            bridge.syncGlyphFromJson(
                'A',
                'Cloud live point move',
                undefined,
                undefined,
                'L0'
            );

            return {
                before,
                after: { x: Number(node.x), y: Number(node.y) }
            };
        },
        { nextDeltaX: deltaX, nextDeltaY: deltaY }
    );
}

test.describe('Local cloud collaboration', () => {
    test('saves and reopens a cloud asset against the local stack', async ({
        browser
    }) => {
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await context.newPage();
        const reopenedPage = await context.newPage();

        await page.goto('/?test=true');
        await waitForCanvasReady(page);

        await loadCloudTestFont(page);
        await waitForFontLoaded(page);

        const assetId = await page.evaluate(async () => {
            return await (window as any).cloudPlugin.saveAs(
                `Playwright Cloud ${Date.now()}`
            );
        });

        expect(assetId).toBeTruthy();
        await waitForCloudConnected(page);

        await page.waitForFunction(
            () => !!(window as any).authManager?.isAuthenticated?.(),
            { timeout: 15000 }
        );

        await reopenedPage.goto('/?test=true');
        await waitForCanvasReady(reopenedPage);

        await reopenedPage.evaluate(async (nextAssetId) => {
            await (window as any).cloudPlugin.openAsset(nextAssetId);
        }, assetId);

        await waitForFontLoaded(reopenedPage);
        await waitForCloudConnected(reopenedPage);
        await reopenedPage.waitForFunction(
            () => !!(window as any).authManager?.isAuthenticated?.(),
            { timeout: 15000 }
        );

        const reopenedState = await reopenedPage.evaluate(() => {
            const font = (window as any).currentFontModel;
            return {
                path: (window as any).fontManager?.currentFont?.path ?? null,
                familyName:
                    font?.names?.family_name?.dflt ??
                    font?.names?.familyName?.dflt ??
                    null,
                glyphNames: Array.isArray(font?.glyphs)
                    ? font.glyphs.map((glyph: { name: string }) => glyph.name)
                    : []
            };
        });

        expect(reopenedState.path).toBe(`cloud://${assetId}`);
        expect(reopenedState.familyName).toBe('CloudLocalTest');
        expect(reopenedState.glyphNames).toContain('A');
        expect(reopenedState.glyphNames).toContain('.notdef');

        await context.close();
    });

    test('propagates a live glyph edit between two cloud-connected pages', async ({
        browser
    }) => {
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        const mainPage = await context.newPage();
        const linkedPage = await context.newPage();

        await mainPage.goto('/?test=true');
        await waitForCanvasReady(mainPage);

        await loadCloudTestFont(mainPage);
        await waitForFontLoaded(mainPage);

        const assetId = await mainPage.evaluate(async () => {
            return await (window as any).cloudPlugin.saveAs(
                `Playwright Live ${Date.now()}`
            );
        });

        expect(assetId).toBeTruthy();
        await waitForCloudConnected(mainPage);
        await mainPage.waitForFunction(
            () => !!(window as any).authManager?.isAuthenticated?.(),
            { timeout: 15000 }
        );
        await linkedPage.goto('/?test=true');
        await waitForCanvasReady(linkedPage);
        await linkedPage.evaluate(async (nextAssetId) => {
            await (window as any).cloudPlugin.openAsset(nextAssetId);
        }, assetId);

        await waitForFontLoaded(linkedPage);
        await waitForCloudConnected(linkedPage);
        await linkedPage.waitForFunction(
            () => !!(window as any).authManager?.isAuthenticated?.(),
            { timeout: 15000 }
        );

        const beforeMain = await getPrimaryNodePosition(mainPage);
        const beforeLinked = await getPrimaryNodePosition(linkedPage);
        expect(beforeLinked).toEqual(beforeMain);

        const mutation = await movePrimaryNode(mainPage, 17, 9);
        expect(mutation.after.x).toBe(mutation.before.x + 17);
        expect(mutation.after.y).toBe(mutation.before.y + 9);

        await expect
            .poll(async () => {
                const status = await fetchRoomStatus(mainPage, assetId);
                return {
                    totalUpdatesApplied: status.totalUpdatesApplied,
                    roomVersion: status.roomVersion
                };
            })
            .toMatchObject({
                totalUpdatesApplied: expect.any(Number),
                roomVersion: expect.any(Number)
            });

        const roomStatusAfterMutation = await fetchRoomStatus(
            mainPage,
            assetId
        );
        expect(roomStatusAfterMutation.totalUpdatesApplied).toBeGreaterThan(1);
        expect(roomStatusAfterMutation.roomVersion).toBeGreaterThan(1);

        await waitForPrimaryNodePosition(linkedPage, mutation.after);

        const afterMain = await getPrimaryNodePosition(mainPage);
        const afterLinked = await getPrimaryNodePosition(linkedPage);

        expect(afterMain).toEqual(mutation.after);
        expect(afterLinked).toEqual(mutation.after);

        await context.close();
    });

    test('propagates a live glyph edit between two separate browser contexts', async ({
        browser
    }) => {
        const email = `playwright-${Date.now()}@counterpunch.test`;
        const sourceContext = await browser.newContext({
            ignoreHTTPSErrors: true
        });
        const targetContext = await browser.newContext({
            ignoreHTTPSErrors: true
        });
        const sourcePage = await sourceContext.newPage();
        const targetPage = await targetContext.newPage();

        await sourcePage.goto('/?test=true');
        await waitForCanvasReady(sourcePage);
        await bootstrapCloudSession(sourcePage, email);

        await loadCloudTestFont(sourcePage);
        await waitForFontLoaded(sourcePage);

        const assetId = await sourcePage.evaluate(async () => {
            return await (window as any).cloudPlugin.saveAs(
                `Playwright Cross Context ${Date.now()}`
            );
        });

        expect(assetId).toBeTruthy();
        await waitForCloudConnected(sourcePage);

        await targetPage.goto('/?test=true');
        await waitForCanvasReady(targetPage);
        await bootstrapCloudSession(targetPage, email);
        await targetPage.evaluate(async (nextAssetId) => {
            await (window as any).cloudPlugin.openAsset(nextAssetId);
        }, assetId);

        await waitForFontLoaded(targetPage);
        await waitForCloudConnected(targetPage);

        const beforeSource = await getPrimaryNodePosition(sourcePage);
        const beforeTarget = await getPrimaryNodePosition(targetPage);
        expect(beforeTarget).toEqual(beforeSource);

        const mutation = await movePrimaryNode(sourcePage, 23, 11);
        expect(mutation.after.x).toBe(mutation.before.x + 23);
        expect(mutation.after.y).toBe(mutation.before.y + 11);

        await expect
            .poll(async () => {
                const status = await fetchRoomStatus(sourcePage, assetId);
                return {
                    totalUpdatesApplied: status.totalUpdatesApplied,
                    roomVersion: status.roomVersion
                };
            })
            .toMatchObject({
                totalUpdatesApplied: expect.any(Number),
                roomVersion: expect.any(Number)
            });

        const roomStatusAfterMutation = await fetchRoomStatus(
            sourcePage,
            assetId
        );
        expect(roomStatusAfterMutation.totalUpdatesApplied).toBeGreaterThan(1);
        expect(roomStatusAfterMutation.roomVersion).toBeGreaterThan(1);

        const propagationStart = Date.now();
        await waitForPrimaryNodePosition(targetPage, mutation.after);
        const propagationLatencyMs = Date.now() - propagationStart;

        const afterSource = await getPrimaryNodePosition(sourcePage);
        const afterTarget = await getPrimaryNodePosition(targetPage);

        expect(afterSource).toEqual(mutation.after);
        expect(afterTarget).toEqual(mutation.after);
        expect(propagationLatencyMs).toBeLessThan(5000);

        const roomStatusBeforeFlush = await fetchRoomStatus(
            sourcePage,
            assetId
        );
        expect(roomStatusBeforeFlush.totalCheckpoints).toBe(0);
        expect(roomStatusBeforeFlush.lastJournalUpdateBytes).toBeGreaterThan(0);
        expect(roomStatusBeforeFlush.dirtyJournalRows).toBeGreaterThan(0);
        expect(roomStatusBeforeFlush.checkpointAlarmAt).toBeTruthy();

        await targetContext.close();

        await sourcePage.evaluate(() => {
            (window as any).cloudPlugin.disconnectFromRoom();
        });

        await expect
            .poll(
                async () => {
                    const status = await fetchRoomStatus(sourcePage, assetId);
                    return {
                        totalCheckpoints: status.totalCheckpoints,
                        dirtyJournalRows: status.dirtyJournalRows
                    };
                },
                { timeout: 15000 }
            )
            .toEqual({ totalCheckpoints: 1, dirtyJournalRows: 0 });

        await sourceContext.close();
    });

    test('supports linked-window sync and cloud sync simultaneously', async ({
        browser
    }) => {
        const email = `playwright-mixed-${Date.now()}@counterpunch.test`;
        const mainContext = await browser.newContext({
            ignoreHTTPSErrors: true
        });
        const remoteContext = await browser.newContext({
            ignoreHTTPSErrors: true
        });
        const mainPage = await mainContext.newPage();
        const remotePage = await remoteContext.newPage();

        await mainPage.goto('/?test=true');
        await waitForCanvasReady(mainPage);
        await bootstrapCloudSession(mainPage, email);

        await loadCloudTestFont(mainPage);
        await waitForFontLoaded(mainPage);
        await installEditingFontCompileTracker(mainPage);

        const assetId = await mainPage.evaluate(async () => {
            return await (window as any).cloudPlugin.saveAs(
                `Playwright Mixed Topology ${Date.now()}`
            );
        });

        expect(assetId).toBeTruthy();
        await waitForCloudConnected(mainPage);

        await mainPage.evaluate(async (nextAssetId) => {
            await (window as any).cloudPlugin.openAsset(nextAssetId);
        }, assetId);
        await waitForFontLoaded(mainPage);
        await waitForCloudConnected(mainPage);

        const linkedPage = await openLinkedWindow(mainPage);
        await waitForCloudConnected(linkedPage);
        await installEditingFontCompileTracker(linkedPage);

        await remotePage.goto('/?test=true');
        await waitForCanvasReady(remotePage);
        await bootstrapCloudSession(remotePage, email);
        await remotePage.evaluate(async (nextAssetId) => {
            await (window as any).cloudPlugin.openAsset(nextAssetId);
        }, assetId);
        await waitForFontLoaded(remotePage);
        await waitForCloudConnected(remotePage);
        await installEditingFontCompileTracker(remotePage);

        await setupEditTextMode(mainPage, 'ö');
        await setupEditTextMode(linkedPage, 'ö');
        await setupEditTextMode(remotePage, 'ö');
        await waitForEditingCompile(mainPage);
        await waitForEditingCompile(linkedPage);
        await waitForEditingCompile(remotePage);

        const beforeAnchorCompileMain =
            await getEditingFontCompileTracker(mainPage);
        const beforeAnchorCompileLinked =
            await getEditingFontCompileTracker(linkedPage);
        const beforeAnchorCompileRemote =
            await getEditingFontCompileTracker(remotePage);
        const beforeBoundsMain = await getCompiledGlyphBounds(
            mainPage,
            'odieresis'
        );
        const beforeBoundsLinked = await getCompiledGlyphBounds(
            linkedPage,
            'odieresis'
        );
        const beforeBoundsRemote = await getCompiledGlyphBounds(
            remotePage,
            'odieresis'
        );

        expect(beforeBoundsLinked).toEqual(beforeBoundsMain);
        expect(beforeBoundsRemote).toEqual(beforeBoundsMain);

        await waitForPythonReady(mainPage);
        await mainPage.evaluate(async () => {
            await (window as any).pyodide.runPythonAsync(`import js
font = js.currentFontModel
glyph_o = font.findGlyph('o')
if glyph_o is None:
    raise RuntimeError('Glyph o is not available')
layer = glyph_o.findLayerById('L0')
if layer is None:
    raise RuntimeError('Layer L0 is not available on glyph o')
top_anchor = layer.findAnchor('top')
if top_anchor is None:
    raise RuntimeError('Top anchor is not available on glyph o')
top_anchor.y += 100`);
        });

        await waitForEditingFontCompileEvent(
            mainPage,
            beforeAnchorCompileMain.count
        );
        await waitForEditingFontCompileEvent(
            linkedPage,
            beforeAnchorCompileLinked.count
        );
        await waitForEditingFontCompileEvent(
            remotePage,
            beforeAnchorCompileRemote.count
        );
        await waitForEditingCompile(mainPage);
        await waitForEditingCompile(linkedPage);
        await waitForEditingCompile(remotePage);

        const afterBoundsMain = await getCompiledGlyphBounds(
            mainPage,
            'odieresis'
        );
        const afterBoundsLinked = await getCompiledGlyphBounds(
            linkedPage,
            'odieresis'
        );
        const afterBoundsRemote = await getCompiledGlyphBounds(
            remotePage,
            'odieresis'
        );

        expect(afterBoundsMain.y2 - beforeBoundsMain.y2).toBe(100);
        expect(afterBoundsLinked.y2 - beforeBoundsLinked.y2).toBe(100);
        expect(afterBoundsRemote.y2 - beforeBoundsRemote.y2).toBe(100);

        await remoteContext.close();
        await mainContext.close();
    });
});
