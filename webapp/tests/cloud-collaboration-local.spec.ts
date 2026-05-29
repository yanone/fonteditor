import { test, expect, type Page } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForFontLoaded,
    focusView,
    waitForFontspectorReady
} from './helpers/snapshot-helper';
import {
    ensureLocalCollabServices,
    type LocalCollabServicesController
} from './helpers/local-collab-services';
import { rectLineNodes } from './helpers/babelfont-test-data';

function makeCloudTestFont(): string {
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
                                nodes: rectLineNodes(
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
                                nodes: rectLineNodes(
                                    0,
                                    0,
                                    500,
                                    0,
                                    500,
                                    700,
                                    0,
                                    700
                                ),
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
                                nodes: rectLineNodes(
                                    0,
                                    0,
                                    80,
                                    0,
                                    80,
                                    120,
                                    0,
                                    120
                                ),
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

async function getCloudConnectionStatus(page: Page): Promise<string | null> {
    return page.evaluate(() => {
        const status = (window as any).cloudDebug?.getStatus?.();
        return typeof status === 'string' ? status : null;
    });
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

async function waitForCloudPageReady(page: Page): Promise<void> {
    await page.waitForFunction(
        () => {
            const win = window as any;
            const loadingOverlay = document.getElementById('loading-overlay');
            return (
                !!loadingOverlay?.classList.contains('hidden') &&
                !!win.glyphCanvas?.canvas &&
                !!win.glyphCanvas?.renderer &&
                !!win.stateManager &&
                !!win.fontManager &&
                typeof win.cloudDebug?.bootstrapLocalSession === 'function' &&
                typeof win.cloudPlugin?.openAsset === 'function'
            );
        },
        { timeout: 30000 }
    );
}

async function waitForWindowSyncReady(page: Page): Promise<void> {
    await page.waitForFunction(() => !!(window as any).windowSync, {
        timeout: 15000
    });
}

async function waitForFullFontCompileReady(page: Page): Promise<void> {
    await page.waitForFunction(
        () => {
            const testWindow = window as any;
            const fullCompileStatus =
                testWindow.fullCompileManager?.getStatus?.() || null;
            const currentFont = testWindow.fontManager?.currentFont || null;

            if (!fullCompileStatus || !currentFont) {
                return false;
            }

            if (!fullCompileStatus.isEnabled || fullCompileStatus.isCompiling) {
                return false;
            }

            const currentPath = currentFont.path || null;
            const currentVersion = currentFont.changeVersion;

            return (
                fullCompileStatus.lastCompiledPath === currentPath &&
                fullCompileStatus.lastCompiledVersion >= currentVersion
            );
        },
        { timeout: 20000 }
    );
}

async function installFullFontEventTracker(page: Page): Promise<void> {
    await page.evaluate(() => {
        const testWindow = window as any;
        if (testWindow.__fullFontEventTrackerInstalled) {
            return;
        }

        testWindow.__fullFontEventTrackerInstalled = true;
        testWindow.__fullFontEventTrackerEvents = [];

        window.addEventListener('fullFontCompiled', (event: Event) => {
            const detail = (event as CustomEvent).detail || {};
            testWindow.__fullFontEventTrackerEvents.push({
                type: 'fullFontCompiled',
                changeVersion: detail.changeVersion ?? null
            });
        });
    });
}

async function resetFullFontEventTracker(page: Page): Promise<void> {
    await page.evaluate(() => {
        const testWindow = window as any;
        testWindow.__fullFontEventTrackerEvents = [];
        testWindow.__fullFontEventTrackerBaselineVersion =
            testWindow.fontManager?.currentFont?.changeVersion ?? null;
    });
}

async function getFullFontEventTrackerSnapshot(page: Page): Promise<{
    baselineVersion: number | null;
    currentChangeVersion: number | null;
    fullFontCompiledCount: number;
}> {
    return page.evaluate(() => {
        const testWindow = window as any;
        const events = Array.isArray(testWindow.__fullFontEventTrackerEvents)
            ? testWindow.__fullFontEventTrackerEvents
            : [];

        return {
            baselineVersion:
                testWindow.__fullFontEventTrackerBaselineVersion ?? null,
            currentChangeVersion:
                testWindow.fontManager?.currentFont?.changeVersion ?? null,
            fullFontCompiledCount: events.filter(
                (entry: { type?: string }) => entry?.type === 'fullFontCompiled'
            ).length
        };
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
        const textRunEditor = glyphCanvas?.textRunEditor;
        const outlineEditor = glyphCanvas?.outlineEditor;
        const fontModel = (window as any).currentFontModel;
        const fontManager = (window as any).fontManager;
        if (!glyphCanvas || !textRunEditor || !outlineEditor) {
            throw new Error('Missing glyph canvas editor state');
        }

        textRunEditor.setTextBuffer(nextTextBuffer);
        await textRunEditor.selectGlyphByIndex(0, true);
        await glyphCanvas.enterGlyphEditModeAtCursor?.();

        const firstCodepoint = nextTextBuffer.codePointAt(0);
        const glyphFromCodepoint =
            firstCodepoint === undefined
                ? null
                : (fontModel?.findGlyphByCodepoint?.(firstCodepoint)?.name ??
                  null);
        const targetGlyphName =
            textRunEditor.shapedGlyphs?.[0]?.explicitGlyphName ||
            textRunEditor.glyphNameBuffer?.[0] ||
            glyphFromCodepoint ||
            nextTextBuffer;

        outlineEditor.active = true;
        outlineEditor.currentGlyphName = targetGlyphName;
        await glyphCanvas.doUIUpdateAsync?.();
        await outlineEditor.autoSelectMatchingLayer?.();

        const explicitLayer = fontModel
            ?.findGlyph?.(targetGlyphName)
            ?.findLayerById?.('L0');
        if (explicitLayer && typeof outlineEditor.selectLayer === 'function') {
            await outlineEditor.selectLayer(explicitLayer);
        }
        await outlineEditor.fetchLayerData?.(true, targetGlyphName);
        await glyphCanvas.doUIUpdateAsync?.();
        const glyphStack = `${targetGlyphName}@${
            explicitLayer?.id || outlineEditor.selectedLayerId || 'L0'
        }`;
        outlineEditor.glyphStack = glyphStack;
        if ((window as any).stateManager) {
            (window as any).stateManager.editor_glyph_stack = glyphStack;
        }
        window.dispatchEvent(
            new CustomEvent('glyphStackChanged', {
                detail: { glyphStack }
            })
        );

        glyphCanvas.render?.();
    }, textBuffer);
    await page.waitForTimeout(200);
}

async function nudgeEditingCompile(page: Page): Promise<void> {
    await page.evaluate(async () => {
        const glyphCanvas = (window as any).glyphCanvas;
        const textRunEditor = glyphCanvas?.textRunEditor;
        const fontManager = (window as any).fontManager;
        if (!glyphCanvas || !textRunEditor || !fontManager?.currentFont) {
            return;
        }

        const hasUsableBounds =
            Array.isArray(glyphCanvas.glyphBounds) &&
            glyphCanvas.glyphBounds.length > 0;
        if (
            hasUsableBounds &&
            fontManager.editingFont !== null &&
            !fontManager.currentFont.needsRecompile
        ) {
            return;
        }

        if (
            fontManager.currentFont.needsRecompile ||
            fontManager.editingFont === null
        ) {
            await Promise.race([
                Promise.resolve(
                    fontManager.compileEditingFont?.(
                        textRunEditor.textBuffer || ''
                    )
                ).catch(() => undefined),
                new Promise<void>((resolve) =>
                    window.setTimeout(() => resolve(), 15000)
                )
            ]);
        }

        textRunEditor.shapeText?.(true);
        await glyphCanvas.doUIUpdateAsync?.();
        glyphCanvas.render?.();
    });
}

async function ensureTextRunTargetsGlyph(
    page: Page,
    glyphName: string
): Promise<void> {
    await page.evaluate(async (targetGlyphName: string) => {
        const glyphCanvas = (window as any).glyphCanvas;
        const textRunEditor = glyphCanvas?.textRunEditor;
        const outlineEditor = glyphCanvas?.outlineEditor;
        const fontModel = (window as any).currentFontModel;
        const fontManager = (window as any).fontManager;
        const stateManager = (window as any).stateManager;
        if (!glyphCanvas || !textRunEditor || !outlineEditor || !fontModel) {
            return;
        }

        const targetGlyph = fontModel.findGlyph?.(targetGlyphName);
        const targetCodepoint = Array.isArray(targetGlyph?.codepoints)
            ? targetGlyph.codepoints[0]
            : Array.isArray(targetGlyph?.unicodes)
              ? targetGlyph.unicodes[0]
              : null;
        if (typeof targetCodepoint !== 'number') {
            return;
        }

        const targetTextBuffer = String.fromCodePoint(targetCodepoint);

        const shapedGlyphs = Array.isArray(textRunEditor.shapedGlyphs)
            ? textRunEditor.shapedGlyphs
            : [];
        const glyphNameBuffer = Array.isArray(textRunEditor.glyphNameBuffer)
            ? textRunEditor.glyphNameBuffer
            : [];
        const firstCodepoint = String(
            textRunEditor.textBuffer || ''
        ).codePointAt(0);
        const resolvedGlyphFromCodepoint =
            firstCodepoint === undefined
                ? null
                : (fontModel.findGlyphByCodepoint?.(firstCodepoint)?.name ??
                  null);
        const currentResolvedGlyphName =
            shapedGlyphs[0]?.explicitGlyphName ||
            glyphNameBuffer[0] ||
            resolvedGlyphFromCodepoint ||
            null;

        if (
            currentResolvedGlyphName === targetGlyphName &&
            textRunEditor.textBuffer === targetTextBuffer &&
            stateManager?.editor_text_buffer === targetTextBuffer
        ) {
            return;
        }

        if (stateManager) {
            stateManager.editor_text_buffer = targetTextBuffer;
            stateManager.editor_cursor_position = 0;
            stateManager.editor_mode = 'edit';
        }
        if (fontManager) {
            fontManager.currentText = targetTextBuffer;
            fontManager.updateEditingSubsetSnapshot?.([targetGlyphName]);
        }
        try {
            localStorage.setItem('glyphCanvasTextBuffer', targetTextBuffer);
        } catch {
            // Ignore localStorage failures in test environments.
        }

        textRunEditor.setTextBuffer(targetTextBuffer);
        await textRunEditor.selectGlyphByIndex(0, true);
        await glyphCanvas.enterGlyphEditModeAtCursor?.();

        outlineEditor.active = true;
        outlineEditor.currentGlyphName = targetGlyphName;
        await glyphCanvas.doUIUpdateAsync?.();
        await outlineEditor.autoSelectMatchingLayer?.();

        const explicitLayer = targetGlyph?.findLayerById?.('L0');
        if (explicitLayer && typeof outlineEditor.selectLayer === 'function') {
            await outlineEditor.selectLayer(explicitLayer);
        }
        await outlineEditor.fetchLayerData?.(true, targetGlyphName);
        await glyphCanvas.doUIUpdateAsync?.();

        const glyphStack = `${targetGlyphName}@$${
            explicitLayer?.id || outlineEditor.selectedLayerId || 'L0'
        }`;
        outlineEditor.glyphStack = glyphStack;
        if ((window as any).stateManager) {
            (window as any).stateManager.editor_glyph_stack = glyphStack;
        }
        window.dispatchEvent(
            new CustomEvent('glyphStackChanged', {
                detail: { glyphStack }
            })
        );
    }, glyphName);
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
        testWindow.__editingFontCompileEvents = [];
        window.addEventListener('editingFontCompiled', (event) => {
            const detail = (event as CustomEvent)?.detail || {};
            testWindow.__editingFontCompiledCount += 1;
            testWindow.__lastEditingFontCompiledRevision = Number(
                detail?.fontRevisionKey ?? -1
            );
            testWindow.__editingFontCompileEvents.push({
                compilationMode:
                    typeof detail?.compilationMode === 'string'
                        ? detail.compilationMode
                        : null,
                changeSource:
                    typeof detail?.changeSource === 'string'
                        ? detail.changeSource
                        : null,
                editType:
                    typeof detail?.editType === 'string'
                        ? detail.editType
                        : null,
                fontRevisionKey:
                    detail?.fontRevisionKey === undefined ||
                    detail?.fontRevisionKey === null
                        ? null
                        : String(detail.fontRevisionKey)
            });
        });
        testWindow.__editingFontCompileTrackerInstalled = true;
    });
}

async function resetEditingFontCompileTracker(page: Page): Promise<void> {
    await page.evaluate(() => {
        const testWindow = window as any;
        testWindow.__editingFontCompiledCount = 0;
        testWindow.__lastEditingFontCompiledRevision = -1;
        testWindow.__editingFontCompileEvents = [];
    });
}

async function waitForAuthenticatedCloudSession(page: Page): Promise<void> {
    await page.waitForFunction(
        () => !!(window as any).authManager?.isAuthenticated?.(),
        { timeout: 15000 }
    );
    await waitForPythonReady(page);
    await waitForBridgeReady(page);
}

async function waitForCloudFontModelReady(page: Page): Promise<void> {
    await page.waitForFunction(
        () => {
            const font = (window as any).currentFontModel;
            return (
                !!font &&
                Array.isArray(font.glyphs) &&
                font.glyphs.length > 0 &&
                !!(window as any).fontManager?.currentFont
            );
        },
        { timeout: 30000 }
    );
}

async function openShareDialog(page: Page): Promise<void> {
    await page.locator('#share-btn').click();
    await expect(page.locator('.share-dialog')).toBeVisible();
}

async function createInvitationFromShareDialog(
    page: Page,
    email: string,
    role: 'editor' | 'viewer'
): Promise<string> {
    const result = await page.evaluate(
        async ({ nextEmail, nextRole }) => {
            return await (window as any).cloudPlugin.inviteUser(
                nextEmail,
                nextRole
            );
        },
        {
            nextEmail: email,
            nextRole: role
        }
    );

    expect(result?.inviteUrl).toBeTruthy();
    return String(result.inviteUrl);
}

async function createOwnershipTransferFromShareDialog(
    page: Page,
    email: string,
    previousOwnerRole: 'editor' | 'viewer' | 'remove'
): Promise<string> {
    await openShareDialog(page);

    await page
        .locator('.share-dialog-transfer-form input[name="email"]')
        .fill(email);
    await page
        .locator('.share-dialog-transfer-form select[name="previousOwnerRole"]')
        .selectOption(previousOwnerRole);
    await page
        .getByRole('button', { name: /Request transfer|Replace transfer/ })
        .click();

    const linkInput = page
        .locator('.share-dialog-banner', { hasText: 'Latest transfer link' })
        .locator('.share-dialog-link-input');
    await expect(linkInput).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.share-dialog-banner-success')).toContainText(
        `Ownership transfer requested for ${email}.`
    );
    return await linkInput.inputValue();
}

async function acceptInvitationAndOpenEditor(
    page: Page,
    inviteUrl: string,
    options: { requireConnected?: boolean } = {}
): Promise<void> {
    const requireConnected = options.requireConnected ?? true;
    await page.goto(inviteUrl);
    await page.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(
        page.getByRole('link', { name: 'Open in editor' })
    ).toBeVisible({
        timeout: 15000
    });
    await page.getByRole('link', { name: 'Open in editor' }).click();
    await waitForCanvasReady(page);
    await waitForCloudFontModelReady(page);
    if (requireConnected) {
        await waitForCloudConnected(page);
    }
    await waitForAuthenticatedCloudSession(page);
}

async function acceptOwnershipTransferAndOpenEditor(
    page: Page,
    transferUrl: string
): Promise<void> {
    await page.goto(transferUrl);
    await page.getByRole('button', { name: 'Accept transfer' }).click();
    await expect(
        page.getByRole('link', { name: 'Open in editor' })
    ).toBeVisible({ timeout: 15000 });
    await page.getByRole('link', { name: 'Open in editor' }).click();
    await waitForCanvasReady(page);
    await waitForCloudFontModelReady(page);
    await waitForCloudConnected(page);
    await waitForAuthenticatedCloudSession(page);
}

async function tryOpenCloudAsset(
    page: Page,
    assetId: string
): Promise<{ ok: boolean; message: string | null }> {
    return page.evaluate(async (nextAssetId) => {
        try {
            await (window as any).cloudPlugin.openAsset(nextAssetId);
            return { ok: true, message: null };
        } catch (error) {
            return {
                ok: false,
                message: error instanceof Error ? error.message : String(error)
            };
        }
    }, assetId);
}

async function getCloudShareState(
    page: Page,
    assetId?: string
): Promise<{
    asset: {
        id: string;
        role: 'owner' | 'editor' | 'viewer';
        ownerUserId: string;
        ownerEmail: string | null;
    };
    permissions: {
        canManage: boolean;
    };
    members: Array<{
        userId: string;
        email: string;
        role: 'owner' | 'editor' | 'viewer';
    }>;
    invitations: Array<{
        id: string;
        email: string;
        role: 'editor' | 'viewer';
    }>;
    ownershipTransfer: {
        id: string;
        email: string;
        previousOwnerRole: 'editor' | 'viewer' | 'remove';
    } | null;
}> {
    return page.evaluate(async (nextAssetId) => {
        return await (window as any).cloudPlugin.getShareState(nextAssetId);
    }, assetId);
}

async function updateCloudMemberRole(
    page: Page,
    userId: string,
    role: 'editor' | 'viewer',
    assetId?: string
): Promise<void> {
    await page.evaluate(
        async ({ nextUserId, nextRole, nextAssetId }) => {
            await (window as any).cloudPlugin.updateMemberRole(
                nextUserId,
                nextRole,
                nextAssetId
            );
        },
        {
            nextUserId: userId,
            nextRole: role,
            nextAssetId: assetId ?? null
        }
    );
}

async function removeCloudMember(
    page: Page,
    userId: string,
    assetId?: string
): Promise<void> {
    await page.evaluate(
        async ({ nextUserId, nextAssetId }) => {
            await (window as any).cloudPlugin.removeMember(
                nextUserId,
                nextAssetId
            );
        },
        {
            nextUserId: userId,
            nextAssetId: assetId ?? null
        }
    );
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

async function getEditingFontCompileEvents(page: Page): Promise<
    Array<{
        compilationMode: string | null;
        changeSource: string | null;
        editType: string | null;
        fontRevisionKey: string | null;
    }>
> {
    return page.evaluate(() => {
        const events = (window as any).__editingFontCompileEvents;
        return Array.isArray(events) ? [...events] : [];
    });
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
        const outlineEditor = glyphCanvas?.outlineEditor;
        const fontModel = (window as any).currentFontModel;
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
        const textBuffer = String(textRunEditor?.textBuffer ?? '');
        const firstCodepoint = textBuffer.codePointAt(0);
        const resolvedGlyphFromCodepoint =
            firstCodepoint === undefined
                ? null
                : (fontModel?.findGlyphByCodepoint?.(firstCodepoint)?.name ??
                  null);
        const activeGlyphName =
            outlineEditor?.currentGlyphName ||
            outlineEditor?.glyphStack?.split?.('@')?.[0] ||
            null;

        const matchesTarget = (candidate: unknown): boolean => {
            return (
                typeof candidate === 'string' && candidate === targetGlyphName
            );
        };

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

        if (
            glyphBounds.length === 1 &&
            (matchesTarget(resolvedGlyphFromCodepoint) ||
                matchesTarget(activeGlyphName))
        ) {
            return {
                x1: Number(glyphBounds[0].x1),
                y1: Number(glyphBounds[0].y1),
                x2: Number(glyphBounds[0].x2),
                y2: Number(glyphBounds[0].y2)
            };
        }

        throw new Error(
            `Glyph ${targetGlyphName} is not present in compiled glyph bounds`
        );
    }, glyphName);
}

async function getAnchorPosition(
    page: Page,
    glyphName: string,
    layerId: string,
    anchorName: string
): Promise<{ x: number; y: number }> {
    return page.evaluate(
        ({ nextGlyphName, nextLayerId, nextAnchorName }) => {
            const glyph = (window as any).currentFontModel?.findGlyph?.(
                nextGlyphName
            );
            const layer = glyph?.findLayerById?.(nextLayerId);
            const anchor = layer?.findAnchor?.(nextAnchorName);
            if (!anchor) {
                throw new Error(
                    `Anchor ${nextGlyphName}/${nextLayerId}/${nextAnchorName} is not available`
                );
            }
            return {
                x: Number(anchor.x),
                y: Number(anchor.y)
            };
        },
        {
            nextGlyphName: glyphName,
            nextLayerId: layerId,
            nextAnchorName: anchorName
        }
    );
}

async function waitForPrimaryNodePosition(
    page: Page,
    expected: { x: number; y: number }
): Promise<void> {
    try {
        await expect
            .poll(async () => await getPrimaryNodePosition(page), {
                timeout: 15000
            })
            .toEqual(expected);
    } catch (error) {
        const diagnostics = await page.evaluate(() => {
            const fontModel = (window as any).currentFontModel;
            const glyph = fontModel?.findGlyph?.('A');
            const layer = glyph?.findLayerById?.('L0');
            const path = layer?.paths?.[0];
            const node = path?.nodes?.[0];
            const rawGlyph = (
                window as any
            ).fontManager?.currentFont?.babelfontData?.glyphs?.find(
                (entry: { name?: string }) => entry?.name === 'A'
            );
            const rawLayer = rawGlyph?.layers?.find(
                (entry: { id?: string }) => entry?.id === 'L0'
            );
            const rawNodes = rawLayer?.shapes?.[0]?.nodes ?? null;
            const bridgeNodes =
                (window as any).patchSyncEngine
                    ?.getFontJsonSnapshot?.()
                    ?.glyphs?.find?.(
                        (entry: { name?: string }) => entry?.name === 'A'
                    )
                    ?.layers?.find?.(
                        (entry: { id?: string }) => entry?.id === 'L0'
                    )?.shapes?.[0]?.nodes ?? null;
            const yDocNodes =
                (window as any).patchSyncEngine?.fontMap?.toJSON?.()?.glyphs?.A
                    ?.layers?.L0?.shapes?.[0]?.nodes ?? null;
            const rawFirstPair =
                typeof rawNodes === 'string'
                    ? rawNodes.trim().split(/\s+/).slice(0, 2)
                    : Array.isArray(rawNodes)
                      ? [rawNodes[0]?.x, rawNodes[0]?.y]
                      : [null, null];

            return {
                assetId: (window as any).cloudPlugin?.activeAssetId ?? null,
                hasPatchSyncEngine: !!(window as any).patchSyncEngine,
                hasChangeBridge: !!(window as any).changeBridge,
                glyphFound: !!glyph,
                layerFound: !!layer,
                pathFound: !!path,
                nodeFound: !!node,
                nodePosition: {
                    x: Number(rawFirstPair[0] ?? NaN),
                    y: Number(rawFirstPair[1] ?? NaN)
                },
                bridgeNodes,
                yDocNodes,
                lastCloudInboundUpdateBase64:
                    (
                        window as Window & {
                            __lastCloudInboundUpdateBase64?: string;
                        }
                    ).__lastCloudInboundUpdateBase64 ?? null,
                lastCloudInboundUpdateCount:
                    (
                        window as Window & {
                            __lastCloudInboundUpdateCount?: number;
                        }
                    ).__lastCloudInboundUpdateCount ?? 0,
                rawLayer,
                changeLogLength:
                    (window as any).patchSyncEngine?.getChangeLog?.()?.length ??
                    null
            };
        });

        const roomStatus = diagnostics.assetId
            ? await fetchRoomStatus(page, diagnostics.assetId).catch(
                  (statusError) => ({
                      error:
                          statusError instanceof Error
                              ? statusError.message
                              : String(statusError)
                  })
              )
            : null;

        throw new Error(
            `${(error as Error).message}\nCloud node diagnostics: ${JSON.stringify(
                diagnostics
            )}\nRoom status diagnostics: ${JSON.stringify(roomStatus)}`
        );
    }
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

async function getBridgeStateSha(page: Page): Promise<string | null> {
    return page.evaluate(async () => {
        const bridge = (window as any).patchSyncEngine;
        if (!bridge?.encodeBridgeState) {
            return null;
        }

        const bytes = bridge.encodeBridgeState();
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, '0')
        ).join('');
    });
}

async function waitForCompiledGlyphBounds(
    page: Page,
    glyphName: string
): Promise<void> {
    try {
        await expect
            .poll(
                async () => {
                    await ensureTextRunTargetsGlyph(page, glyphName);
                    await nudgeEditingCompile(page);
                    try {
                        return await getCompiledGlyphBounds(page, glyphName);
                    } catch {
                        return null;
                    }
                },
                {
                    timeout: 30000
                }
            )
            .toMatchObject({
                x1: expect.any(Number),
                y1: expect.any(Number),
                x2: expect.any(Number),
                y2: expect.any(Number)
            });
    } catch (error) {
        const diagnostics = await page.evaluate(() => {
            const glyphCanvas = (window as any).glyphCanvas;
            const textRunEditor = glyphCanvas?.textRunEditor;
            const outlineEditor = glyphCanvas?.outlineEditor;
            const fontManager = (window as any).fontManager;
            return {
                glyphStack: outlineEditor?.glyphStack ?? null,
                stateGlyphStack:
                    (window as any).stateManager?.editor_glyph_stack ?? null,
                outlineCurrentGlyphName:
                    outlineEditor?.currentGlyphName ?? null,
                canvasCurrentGlyphName:
                    glyphCanvas?.getCurrentGlyphName?.() ?? null,
                selectedLayerId: outlineEditor?.selectedLayerId ?? null,
                outlineActive: !!outlineEditor?.active,
                glyphEditMode: !!glyphCanvas?.editMode,
                textBuffer: textRunEditor?.textBuffer ?? null,
                glyphNameBuffer: Array.isArray(textRunEditor?.glyphNameBuffer)
                    ? [...textRunEditor.glyphNameBuffer]
                    : null,
                shapedGlyphs: Array.isArray(textRunEditor?.shapedGlyphs)
                    ? textRunEditor.shapedGlyphs.map(
                          (entry: { explicitGlyphName?: string | null }) =>
                              entry?.explicitGlyphName ?? null
                      )
                    : null,
                glyphBoundsCount: Array.isArray(glyphCanvas?.glyphBounds)
                    ? glyphCanvas.glyphBounds.length
                    : null,
                needsRecompile:
                    fontManager?.currentFont?.needsRecompile ?? null,
                hasEditingFont: fontManager?.editingFont !== null,
                currentFontGlyphNames: Array.isArray(
                    fontManager?.currentFont?.babelfontData?.glyphs
                )
                    ? fontManager.currentFont.babelfontData.glyphs
                          .slice(0, 8)
                          .map(
                              (entry: { name?: string }) => entry?.name ?? null
                          )
                    : null
            };
        });
        throw new Error(
            `${(error as Error).message}\nCompiled glyph diagnostics: ${JSON.stringify(
                diagnostics
            )}`
        );
    }
}

async function getBridgeStateBase64(page: Page): Promise<string | null> {
    return page.evaluate(() => {
        const bridge = (window as any).patchSyncEngine;
        if (!bridge?.encodeBridgeState) {
            return null;
        }

        const bytes = bridge.encodeBridgeState();
        let binary = '';
        for (let index = 0; index < bytes.length; index++) {
            binary += String.fromCharCode(bytes[index]);
        }
        return btoa(binary);
    });
}

async function getCloudAdapterBindingDiagnostics(page: Page): Promise<{
    adapterPresent: boolean;
    adapterUsesLiveBridge: boolean;
    bridgeUsesCurrentFontJson: boolean;
    adapterStatus: string | null;
    adapterClientId: string | null;
    liveBridgeSha: string | null;
    adapterBridgeSha: string | null;
    liveBridgeLayerNodes: string | null;
    adapterBridgeLayerNodes: string | null;
}> {
    return page.evaluate(async () => {
        const liveBridge = (window as any).patchSyncEngine;
        const adapter = (window as any).cloudPlugin?._cloudAdapter ?? null;
        const adapterBridge = adapter?._bridge ?? null;
        const currentFontJson =
            (window as any).fontManager?.currentFont?.babelfontData ?? null;

        const shaFor = async (bridge: any) => {
            if (!bridge?.encodeBridgeState) {
                return null;
            }
            const bytes = bridge.encodeBridgeState();
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            return Array.from(new Uint8Array(digest), (byte) =>
                byte.toString(16).padStart(2, '0')
            ).join('');
        };

        const layerNodesFor = (bridge: any) => {
            const rawNodes =
                bridge
                    ?.getFontJsonSnapshot?.()
                    ?.glyphs?.find?.((entry: any) => entry?.name === 'A')
                    ?.layers?.find?.((entry: any) => entry?.id === 'L0')
                    ?.shapes?.[0]?.nodes ?? null;
            if (typeof rawNodes === 'string') {
                return rawNodes;
            }
            if (Array.isArray(rawNodes)) {
                return JSON.stringify(rawNodes);
            }
            return rawNodes == null ? null : String(rawNodes);
        };

        return {
            adapterPresent: !!adapter,
            adapterUsesLiveBridge:
                !!liveBridge && !!adapterBridge && adapterBridge === liveBridge,
            bridgeUsesCurrentFontJson:
                !!liveBridge &&
                !!currentFontJson &&
                liveBridge.getFontJsonSnapshot?.() === currentFontJson,
            adapterStatus:
                typeof adapter?.status === 'string' ? adapter.status : null,
            adapterClientId:
                typeof adapter?._clientId === 'string'
                    ? adapter._clientId
                    : null,
            liveBridgeSha: await shaFor(liveBridge),
            adapterBridgeSha: await shaFor(adapterBridge),
            liveBridgeLayerNodes: layerNodesFor(liveBridge),
            adapterBridgeLayerNodes: layerNodesFor(adapterBridge)
        };
    });
}

async function getLastCollaborationLogItem(page: Page): Promise<{
    updateByteLength: number | null;
    updateBase64Preview: string | null;
    summary: string | null;
} | null> {
    return page.evaluate(() => {
        const item = (window as any).patchSyncEngine
            ?.getCollaborationLog?.()
            ?.slice?.(-1)?.[0];
        if (!item) {
            return null;
        }
        return {
            updateByteLength:
                typeof item.updateByteLength === 'number'
                    ? item.updateByteLength
                    : null,
            updateBase64Preview:
                typeof item.updateBase64Preview === 'string'
                    ? item.updateBase64Preview
                    : null,
            summary: typeof item.summary === 'string' ? item.summary : null
        };
    });
}

async function getPrimaryNodePosition(page: Page): Promise<{
    x: number;
    y: number;
}> {
    return page.evaluate(() => {
        const rawLayer = (
            window as any
        ).fontManager?.currentFont?.babelfontData?.glyphs
            ?.find?.((entry: { name?: string }) => entry?.name === 'A')
            ?.layers?.find?.((entry: { id?: string }) => entry?.id === 'L0');
        const rawNodes = rawLayer?.shapes?.[0]?.nodes ?? null;
        const rawFirstPair =
            typeof rawNodes === 'string'
                ? rawNodes.trim().split(/\s+/).slice(0, 2)
                : Array.isArray(rawNodes)
                  ? [rawNodes[0]?.x, rawNodes[0]?.y]
                  : [null, null];
        return {
            x: Number(rawFirstPair[0] ?? NaN),
            y: Number(rawFirstPair[1] ?? NaN)
        };
    });
}

async function focusEditorGlyph(page: Page, glyphName = 'A'): Promise<void> {
    await focusView(page, 'Meta+Shift+E', 'view-editor');
    await page.evaluate(async (nextGlyphName) => {
        const glyphCanvas = (window as any).glyphCanvas;
        const textRunEditor = glyphCanvas?.textRunEditor;
        const outlineEditor = glyphCanvas?.outlineEditor;
        if (!glyphCanvas || !textRunEditor || !outlineEditor) {
            throw new Error('Missing glyph canvas editor state');
        }

        textRunEditor.setTextBuffer(nextGlyphName);
        await textRunEditor.selectGlyphByIndex(0, true);
        await glyphCanvas.enterGlyphEditModeAtCursor?.();
        outlineEditor.active = true;
        outlineEditor.currentGlyphName = nextGlyphName;
        await glyphCanvas.doUIUpdateAsync?.();
        await outlineEditor.autoSelectMatchingLayer?.();
        const explicitLayer = (window as any).currentFontModel
            ?.findGlyph?.(nextGlyphName)
            ?.findLayerById?.('L0');
        if (explicitLayer) {
            if (typeof outlineEditor.selectLayer !== 'function') {
                throw new Error('outlineEditor.selectLayer is unavailable');
            }
            await outlineEditor.selectLayer(explicitLayer);
        } else if (!outlineEditor.selectedLayerId) {
            await outlineEditor.autoSelectMatchingLayer?.();
        }
        if (typeof outlineEditor.fetchLayerData !== 'function') {
            throw new Error('outlineEditor.fetchLayerData is unavailable');
        }
        await outlineEditor.fetchLayerData(true, nextGlyphName);
        await glyphCanvas.doUIUpdateAsync?.();
        const glyphStack = `${nextGlyphName}@${
            explicitLayer?.id || outlineEditor.selectedLayerId || 'L0'
        }`;
        outlineEditor.glyphStack = glyphStack;
        if ((window as any).stateManager) {
            (window as any).stateManager.editor_glyph_stack = glyphStack;
        }
        window.dispatchEvent(
            new CustomEvent('glyphStackChanged', {
                detail: { glyphStack }
            })
        );
        glyphCanvas.render?.();

        if (!outlineEditor.selectedLayerId || !outlineEditor.layerData) {
            throw new Error(
                `Editor layer activation failed: ${JSON.stringify({
                    selectedLayerId: outlineEditor.selectedLayerId ?? null,
                    hasLayerData: !!outlineEditor.layerData,
                    currentGlyphName: outlineEditor.currentGlyphName ?? null,
                    canvasCurrentGlyphName:
                        glyphCanvas.getCurrentGlyphName?.() ?? null,
                    explicitLayerId: explicitLayer?.id ?? null,
                    glyphStack: outlineEditor.glyphStack ?? null
                })}`
            );
        }
    }, glyphName);
    await page.keyboard.press('Meta+0');
    await page.waitForFunction(
        (nextGlyphName) => {
            const glyphCanvas = (window as any).glyphCanvas;
            const glyph = (window as any).currentFontModel?.findGlyph?.(
                nextGlyphName
            );
            const layer = glyph?.findLayerById?.('L0');
            const node = layer?.paths?.[0]?.nodes?.[0];
            return (
                !!glyphCanvas?.viewportManager &&
                !!glyphCanvas?.textRunEditor &&
                Number.isFinite(Number(node?.x)) &&
                Number.isFinite(Number(node?.y))
            );
        },
        glyphName,
        { timeout: 15000 }
    );
    await page.waitForTimeout(500);
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
        async ({ nextDeltaX, nextDeltaY }) => {
            const glyphCanvas = (window as any).glyphCanvas;
            const outlineEditor = glyphCanvas?.outlineEditor;
            const bridge = (window as any).patchSyncEngine;
            const textRunEditor = glyphCanvas?.textRunEditor;
            const fontManager = (window as any).fontManager;
            const currentFont = (window as any).fontManager?.currentFont;
            const outboundSeqBeforeMove = (
                window as Window & {
                    __lastCloudOutboundUpdateSeq?: number;
                }
            ).__lastCloudOutboundUpdateSeq;

            if (
                !glyphCanvas ||
                !outlineEditor ||
                !bridge ||
                !textRunEditor ||
                !fontManager ||
                !currentFont
            ) {
                throw new Error('Missing live editor point move state');
            }

            textRunEditor.setTextBuffer('A');
            await textRunEditor.selectGlyphByIndex(0, true);
            outlineEditor.active = true;
            outlineEditor.currentGlyphName = 'A';
            const explicitLayer = (window as any).currentFontModel
                ?.findGlyph?.('A')
                ?.findLayerById?.('L0');
            if (
                explicitLayer &&
                typeof outlineEditor.selectLayer === 'function'
            ) {
                await outlineEditor.selectLayer(explicitLayer);
            } else {
                await outlineEditor.autoSelectMatchingLayer?.();
            }
            await outlineEditor.fetchLayerData?.(true, 'A');
            await glyphCanvas.doUIUpdateAsync?.();

            const glyph = (window as any).currentFontModel?.findGlyph?.('A');
            const layer = glyph?.findLayerById?.('L0');
            const currentLayerData =
                outlineEditor?.layerData ||
                outlineEditor?.getCurrentLayerDataFromStack?.() ||
                null;
            const modelNode = layer?.paths?.[0]?.nodes?.[0] ?? null;

            if (
                !glyphCanvas ||
                !outlineEditor ||
                !bridge ||
                !currentLayerData ||
                !modelNode
            ) {
                throw new Error(
                    `Missing live editor point move state: ${JSON.stringify({
                        hasGlyphCanvas: !!glyphCanvas,
                        hasOutlineEditor: !!outlineEditor,
                        hasBridge: !!bridge,
                        hasGlyph: !!glyph,
                        hasLayer: !!layer,
                        selectedLayerId: outlineEditor?.selectedLayerId ?? null,
                        hasLayerData: !!outlineEditor?.layerData,
                        hasCurrentLayerData: !!currentLayerData,
                        shapeCount: Array.isArray(currentLayerData?.shapes)
                            ? currentLayerData.shapes.length
                            : null,
                        modelNodePosition: modelNode
                            ? {
                                  x: Number(modelNode.x),
                                  y: Number(modelNode.y)
                              }
                            : null
                    })}`
                );
            }

            const forcedGlyphStack = 'A@L0';
            outlineEditor.glyphStack = forcedGlyphStack;
            if ((window as any).stateManager) {
                (window as any).stateManager.editor_glyph_stack =
                    forcedGlyphStack;
            }
            window.dispatchEvent(
                new CustomEvent('glyphStackChanged', {
                    detail: { glyphStack: forcedGlyphStack }
                })
            );

            const before = {
                x: Number(modelNode.x),
                y: Number(modelNode.y)
            };
            let editorNodeAfterMove: { x: number; y: number } | null = null;
            let serializedNodesBeforeSave: string | null = null;
            let bridgeNodesBeforeSync: string | null = null;
            let commitChangeLogLength: number | null = null;
            let adapterHookPresentAfterCommit = false;

            bridge.beginTransaction('Drag point');
            outlineEditor.selectedPoints = [
                {
                    contourIndex: 0,
                    nodeIndex: 0
                }
            ];
            outlineEditor.isDraggingPoint = true;
            outlineEditor._hasMoved = true;
            outlineEditor._dragType = 'point';
            outlineEditor._preDragDesc =
                outlineEditor._buildNodeDesc?.() ?? null;
            outlineEditor.applySelectedPointMove?.(
                currentLayerData,
                nextDeltaX,
                nextDeltaY,
                false
            );
            outlineEditor.applyMetricsKeysToCurrentEditedLayer?.();

            const editorShapeAfterMove = currentLayerData?.shapes?.[0] ?? null;
            const editorNodeCandidate = Array.isArray(
                editorShapeAfterMove?.Path?.nodes
            )
                ? (editorShapeAfterMove.Path.nodes[0] ?? null)
                : Array.isArray(editorShapeAfterMove?.nodes)
                  ? (editorShapeAfterMove.nodes[0] ?? null)
                  : null;
            editorNodeAfterMove = editorNodeCandidate
                ? {
                      x: Number(editorNodeCandidate.x),
                      y: Number(editorNodeCandidate.y)
                  }
                : null;
            const serializedLayerBeforeSave =
                fontManager.serializeLayerForStorage?.(
                    'A',
                    'L0',
                    currentLayerData
                );
            serializedNodesBeforeSave =
                serializedLayerBeforeSave?.shapes?.[0]?.nodes ?? null;

            await outlineEditor.onMouseUp?.(new MouseEvent('mouseup'));

            bridgeNodesBeforeSync =
                bridge
                    .getFontJsonSnapshot?.()
                    ?.glyphs?.find?.((entry: any) => entry?.name === 'A')
                    ?.layers?.find?.((entry: any) => entry?.id === 'L0')
                    ?.shapes?.[0]?.nodes ?? null;
            adapterHookPresentAfterCommit = Boolean(
                (window as any).cloudPlugin?._cloudAdapter
                    ?._localUpdateUnsubscribe
            );

            const waitDeadline = Date.now() + 5000;
            while (Date.now() < waitDeadline) {
                if (
                    (
                        window as Window & {
                            __lastCloudOutboundUpdateSeq?: number;
                        }
                    ).__lastCloudOutboundUpdateSeq !== outboundSeqBeforeMove
                ) {
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
            }

            glyphCanvas.render?.();

            const storedNodesAfterSave =
                (window as any).fontManager?.currentFont?.babelfontData?.glyphs
                    ?.find?.((entry: any) => entry?.name === 'A')
                    ?.layers?.find?.((entry: any) => entry?.id === 'L0')
                    ?.shapes?.[0]?.nodes ?? null;
            const yDocNodesRaw =
                bridge.fontMap
                    ?.get?.('glyphs')
                    ?.get?.('A')
                    ?.get?.('layers')
                    ?.get?.('L0')
                    ?.get?.('shapes')
                    ?.get?.(0)
                    ?.get?.('nodes') ?? null;
            const yDocNodesAfterSync =
                yDocNodesRaw != null &&
                typeof (yDocNodesRaw as any).toJSON === 'function'
                    ? (yDocNodesRaw as any).toJSON()
                    : yDocNodesRaw;
            const storedFirstPair =
                typeof storedNodesAfterSave === 'string'
                    ? storedNodesAfterSave.trim().split(/\s+/).slice(0, 2)
                    : Array.isArray(storedNodesAfterSave)
                      ? [storedNodesAfterSave[0]?.x, storedNodesAfterSave[0]?.y]
                      : [null, null];
            const outboundBase64 = (
                window as Window & {
                    __lastCloudOutboundUpdateBase64?: string;
                    __lastCloudOutboundUpdateSeq?: number;
                }
            ).__lastCloudOutboundUpdateBase64;
            const outboundSeq = (
                window as Window & {
                    __lastCloudOutboundUpdateBase64?: string;
                    __lastCloudOutboundUpdateSeq?: number;
                }
            ).__lastCloudOutboundUpdateSeq;
            const outboundSha = outboundBase64
                ? (() => {
                      const binary = atob(outboundBase64);
                      const bytes = new Uint8Array(binary.length);
                      for (let index = 0; index < binary.length; index++) {
                          bytes[index] = binary.charCodeAt(index);
                      }
                      return crypto.subtle
                          .digest('SHA-256', bytes)
                          .then((digest) =>
                              Array.from(new Uint8Array(digest), (byte) =>
                                  byte.toString(16).padStart(2, '0')
                              ).join('')
                          );
                  })()
                : null;

            return {
                before,
                after: {
                    x: Number(storedFirstPair[0] ?? NaN),
                    y: Number(storedFirstPair[1] ?? NaN)
                },
                debug: {
                    editorNodeAfterMove,
                    serializedNodesBeforeSave,
                    bridgeNodesBeforeSync,
                    storedNodesAfterSave,
                    yDocNodesAfterSync,
                    commitChangeLogLength,
                    adapterHookPresentAfterCommit,
                    pyodideReady:
                        typeof (window as any).pyodide?.runPythonAsync ===
                        'function',
                    selectedLayerId: outlineEditor?.selectedLayerId ?? null,
                    layerDataId: outlineEditor?.layerData?.id ?? null,
                    layerIsInterpolated:
                        outlineEditor?.layerData?.isInterpolated ?? null,
                    outlineCurrentGlyphName:
                        outlineEditor?.currentGlyphName ?? null,
                    canvasCurrentGlyphName:
                        glyphCanvas?.getCurrentGlyphName?.() ?? null,
                    glyphStack: outlineEditor?.glyphStack ?? null,
                    outboundSeq: outboundSeq ?? null,
                    outboundSha: outboundSha ? await outboundSha : null
                }
            };
        },
        { nextDeltaX: deltaX, nextDeltaY: deltaY }
    );
}

test.describe('Local cloud collaboration', () => {
    let localCollabServices: LocalCollabServicesController | null = null;

    test.beforeAll(async ({}, testInfo) => {
        testInfo.setTimeout(300000);
        localCollabServices = await ensureLocalCollabServices();
    });

    test.afterAll(async () => {
        await localCollabServices?.dispose();
        localCollabServices = null;
    });

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
        await focusEditorGlyph(mainPage, 'A');

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
        await focusEditorGlyph(linkedPage, 'A');
        await linkedPage.waitForFunction(
            () => !!(window as any).authManager?.isAuthenticated?.(),
            { timeout: 15000 }
        );

        const beforeMain = await getPrimaryNodePosition(mainPage);
        const beforeLinked = await getPrimaryNodePosition(linkedPage);
        expect(beforeLinked).toEqual(beforeMain);

        const roomStatusBeforeMutation = await fetchRoomStatus(
            mainPage,
            assetId
        );
        const sourceBridgeShaBeforeMutation = await getBridgeStateSha(mainPage);
        const sourceBridgeStateBase64BeforeMutation =
            await getBridgeStateBase64(mainPage);
        const linkedBridgeShaBeforeMutation =
            await getBridgeStateSha(linkedPage);
        const sourceAdapterBindingBeforeMutation =
            await getCloudAdapterBindingDiagnostics(mainPage);
        const linkedAdapterBindingBeforeMutation =
            await getCloudAdapterBindingDiagnostics(linkedPage);
        console.log(
            '[Test pre-mutation state]',
            JSON.stringify({
                roomStateSha:
                    roomStatusBeforeMutation.liveDoc?.fullStateSha256 ?? null,
                sourceBridgeShaBeforeMutation,
                sourceBridgeStateBase64BeforeMutation,
                linkedBridgeShaBeforeMutation,
                sourceAdapterBindingBeforeMutation,
                linkedAdapterBindingBeforeMutation
            })
        );

        const mutation = await movePrimaryNode(mainPage, 17, 9);
        const sourceAdapterBindingAfterMutation =
            await getCloudAdapterBindingDiagnostics(mainPage);
        const sourceBridgeStateBase64AfterMutation =
            await getBridgeStateBase64(mainPage);
        const sourceLastCollaborationLogItem =
            await getLastCollaborationLogItem(mainPage);
        console.log(
            '[Test mutation]',
            JSON.stringify({
                ...mutation,
                sourceAdapterBindingAfterMutation,
                sourceBridgeStateBase64AfterMutation,
                sourceLastCollaborationLogItem
            })
        );
        if (
            mutation.after.x !== mutation.before.x + 17 ||
            mutation.after.y !== mutation.before.y + 9
        ) {
            throw new Error(
                `Primary node move did not persist: ${JSON.stringify(
                    mutation,
                    null,
                    2
                )}`
            );
        }
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
        await waitForAuthenticatedCloudSession(sourcePage);

        await targetPage.goto('/?test=true');
        await waitForCanvasReady(targetPage);
        await bootstrapCloudSession(targetPage, email);
        await targetPage.evaluate(async (nextAssetId) => {
            await (window as any).cloudPlugin.openAsset(nextAssetId);
        }, assetId);

        await waitForFontLoaded(targetPage);
        await waitForCloudConnected(targetPage);
        await waitForAuthenticatedCloudSession(targetPage);
        await focusEditorGlyph(sourcePage, 'A');
        await focusEditorGlyph(targetPage, 'A');

        const beforeSource = await getPrimaryNodePosition(sourcePage);
        const beforeTarget = await getPrimaryNodePosition(targetPage);
        expect(beforeTarget).toEqual(beforeSource);

        const roomStatusBeforeMutation = await fetchRoomStatus(
            sourcePage,
            assetId
        );
        const sourceBridgeShaBeforeMutation =
            await getBridgeStateSha(sourcePage);
        const targetBridgeShaBeforeMutation =
            await getBridgeStateSha(targetPage);
        const sourceAdapterBindingBeforeMutation =
            await getCloudAdapterBindingDiagnostics(sourcePage);
        const targetAdapterBindingBeforeMutation =
            await getCloudAdapterBindingDiagnostics(targetPage);
        console.log(
            '[Cross-context pre-mutation state]',
            JSON.stringify({
                roomStateSha:
                    roomStatusBeforeMutation.liveDoc?.fullStateSha256 ?? null,
                sourceBridgeShaBeforeMutation,
                targetBridgeShaBeforeMutation,
                sourceAdapterBindingBeforeMutation,
                targetAdapterBindingBeforeMutation
            })
        );

        const mutation = await movePrimaryNode(sourcePage, 23, 11);
        console.log('[Cross-context mutation]', JSON.stringify(mutation));
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

    test('opening a second browser context does not recompile an idle cloud peer', async ({
        browser
    }) => {
        test.setTimeout(240000);
        const email = `playwright-peer-join-${Date.now()}@counterpunch.test`;
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
                `Playwright Peer Join ${Date.now()}`
            );
        });

        expect(assetId).toBeTruthy();
        await waitForCloudConnected(sourcePage);
        await waitForAuthenticatedCloudSession(sourcePage);
        await waitForFullFontCompileReady(sourcePage);
        await installFullFontEventTracker(sourcePage);
        const sourceBridgeShaBeforeJoin = await getBridgeStateSha(sourcePage);
        await resetFullFontEventTracker(sourcePage);

        await targetPage.goto('/?test=true');
        await waitForCanvasReady(targetPage);
        await bootstrapCloudSession(targetPage, email);
        await targetPage.evaluate(async (nextAssetId) => {
            await (window as any).cloudPlugin.openAsset(nextAssetId);
        }, assetId);

        await waitForFontLoaded(targetPage);
        await waitForCloudConnected(targetPage);
        await waitForAuthenticatedCloudSession(targetPage);
        await waitForFullFontCompileReady(targetPage);
        await waitForFullFontCompileReady(sourcePage);
        await sourcePage.waitForTimeout(1500);

        const trackerSnapshot =
            await getFullFontEventTrackerSnapshot(sourcePage);
        const sourceBridgeShaAfterJoin = await getBridgeStateSha(sourcePage);

        expect(trackerSnapshot.currentChangeVersion).toBe(
            trackerSnapshot.baselineVersion
        );
        expect(trackerSnapshot.fullFontCompiledCount).toBe(0);
        expect(sourceBridgeShaAfterJoin).toBe(sourceBridgeShaBeforeJoin);

        await sourceContext.close();
        await targetContext.close();
    });

    test('accepts an editor invite and allows live edits in both directions', async ({
        browser
    }) => {
        test.setTimeout(240000);
        const ownerEmail = `owner-${Date.now()}@counterpunch.test`;
        const editorEmail = `editor-${Date.now()}@counterpunch.test`;
        const ownerContext = await browser.newContext({
            ignoreHTTPSErrors: true
        });
        const editorContext = await browser.newContext({
            ignoreHTTPSErrors: true
        });
        const ownerPage = await ownerContext.newPage();
        const editorPage = await editorContext.newPage();

        await ownerPage.goto('/?test=true');
        await waitForCanvasReady(ownerPage);
        await bootstrapCloudSession(ownerPage, ownerEmail);
        await loadCloudTestFont(ownerPage);
        await waitForCloudFontModelReady(ownerPage);

        const assetId = await ownerPage.evaluate(async () => {
            return await (window as any).cloudPlugin.saveAs(
                `Playwright Invite Editor ${Date.now()}`
            );
        });

        expect(assetId).toBeTruthy();
        await waitForCloudConnected(ownerPage);
        await waitForAuthenticatedCloudSession(ownerPage);
        await focusEditorGlyph(ownerPage, 'A');

        await editorPage.goto('/?test=true');
        await waitForCanvasReady(editorPage);
        await bootstrapCloudSession(editorPage, editorEmail);

        const inviteUrl = await createInvitationFromShareDialog(
            ownerPage,
            editorEmail,
            'editor'
        );

        await acceptInvitationAndOpenEditor(editorPage, inviteUrl);
        await focusEditorGlyph(editorPage, 'A');

        const beforeOwner = await getPrimaryNodePosition(ownerPage);
        const beforeEditor = await getPrimaryNodePosition(editorPage);
        expect(beforeEditor).toEqual(beforeOwner);

        const mutation = await movePrimaryNode(editorPage, 13, 6);
        await waitForPrimaryNodePosition(ownerPage, mutation.after);

        const afterOwner = await getPrimaryNodePosition(ownerPage);
        expect(afterOwner).toEqual(mutation.after);

        const ownerMutation = await movePrimaryNode(ownerPage, -9, -7);
        await waitForPrimaryNodePosition(editorPage, ownerMutation.after);

        const afterEditor = await getPrimaryNodePosition(editorPage);
        expect(afterEditor).toEqual(ownerMutation.after);

        await ownerContext.close();
        await editorContext.close();
    });

    test('remote cloud outline edits stay on the editing fast path', async ({
        browser
    }) => {
        test.setTimeout(240000);
        const sharedEmail = `fast-path-${Date.now()}@counterpunch.test`;
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
        await bootstrapCloudSession(sourcePage, sharedEmail);
        await loadCloudTestFont(sourcePage);
        await waitForCloudFontModelReady(sourcePage);

        const assetId = await sourcePage.evaluate(async () => {
            return await (window as any).cloudPlugin.saveAs(
                `Playwright Fast Path ${Date.now()}`
            );
        });

        expect(assetId).toBeTruthy();
        await waitForCloudConnected(sourcePage);
        await waitForAuthenticatedCloudSession(sourcePage);
        await focusEditorGlyph(sourcePage, 'A');

        await targetPage.goto('/?test=true');
        await waitForCanvasReady(targetPage);
        await bootstrapCloudSession(targetPage, sharedEmail);
        await targetPage.evaluate(async (nextAssetId) => {
            await (window as any).cloudPlugin.openAsset(nextAssetId);
        }, assetId);
        await waitForFontLoaded(targetPage);
        await waitForCloudConnected(targetPage);
        await waitForAuthenticatedCloudSession(targetPage);
        await focusEditorGlyph(targetPage, 'A');

        await installEditingFontCompileTracker(sourcePage);
        await installEditingFontCompileTracker(targetPage);
        await resetEditingFontCompileTracker(sourcePage);
        await resetEditingFontCompileTracker(targetPage);

        const mutation = await movePrimaryNode(targetPage, 11, 5);
        await waitForPrimaryNodePosition(sourcePage, mutation.after);
        await waitForEditingFontCompileEvent(sourcePage, 0);
        await waitForEditingFontCompileEvent(targetPage, 0);
        await sourcePage.waitForTimeout(1200);
        await targetPage.waitForTimeout(1200);

        const sourceCompileEvents =
            await getEditingFontCompileEvents(sourcePage);
        const targetCompileEvents =
            await getEditingFontCompileEvents(targetPage);

        expect(sourceCompileEvents.length).toBeGreaterThan(0);
        expect(targetCompileEvents.length).toBeGreaterThan(0);

        expect(
            sourceCompileEvents[0]?.compilationMode,
            `Source compile events: ${JSON.stringify(sourceCompileEvents)}`
        ).toBe('outline-only');
        expect(
            sourceCompileEvents[0]?.editType,
            `Source compile events: ${JSON.stringify(sourceCompileEvents)}`
        ).toBe('outline');
        expect(
            sourceCompileEvents[0]?.changeSource,
            `Source compile events: ${JSON.stringify(sourceCompileEvents)}`
        ).not.toBe('remote-change');
        expect(
            sourceCompileEvents.some(
                (event) => event.compilationMode === 'full'
            ),
            `Source compile events: ${JSON.stringify(sourceCompileEvents)}`
        ).toBe(false);

        expect(
            targetCompileEvents.some(
                (event) => event.compilationMode === 'outline-only'
            ),
            `Target compile events: ${JSON.stringify(targetCompileEvents)}`
        ).toBe(true);
        expect(
            targetCompileEvents[0]?.compilationMode,
            `Target compile events: ${JSON.stringify(targetCompileEvents)}`
        ).not.toBe('full');

        await sourceContext.close();
        await targetContext.close();
    });

    test('multi-user cloud outline edits stay on the editing fast path', async ({
        browser
    }) => {
        test.setTimeout(240000);
        const ownerEmail = `owner-fast-path-${Date.now()}@counterpunch.test`;
        const editorEmail = `editor-fast-path-${Date.now()}@counterpunch.test`;
        const ownerContext = await browser.newContext({
            ignoreHTTPSErrors: true
        });
        const editorContext = await browser.newContext({
            ignoreHTTPSErrors: true
        });
        const ownerPage = await ownerContext.newPage();
        const editorPage = await editorContext.newPage();

        await ownerPage.goto('/?test=true');
        await waitForCanvasReady(ownerPage);
        await bootstrapCloudSession(ownerPage, ownerEmail);
        await loadCloudTestFont(ownerPage);
        await waitForCloudFontModelReady(ownerPage);

        const assetId = await ownerPage.evaluate(async () => {
            return await (window as any).cloudPlugin.saveAs(
                `Playwright Multi User Fast Path ${Date.now()}`
            );
        });

        expect(assetId).toBeTruthy();
        await waitForCloudConnected(ownerPage);
        await waitForAuthenticatedCloudSession(ownerPage);
        await focusEditorGlyph(ownerPage, 'A');

        await editorPage.goto('/?test=true');
        await waitForCanvasReady(editorPage);
        await bootstrapCloudSession(editorPage, editorEmail);

        const inviteUrl = await createInvitationFromShareDialog(
            ownerPage,
            editorEmail,
            'editor'
        );

        await acceptInvitationAndOpenEditor(editorPage, inviteUrl);
        await focusEditorGlyph(editorPage, 'A');

        await installEditingFontCompileTracker(ownerPage);
        await installEditingFontCompileTracker(editorPage);
        await resetEditingFontCompileTracker(ownerPage);
        await resetEditingFontCompileTracker(editorPage);

        const mutation = await movePrimaryNode(editorPage, 11, 5);
        await waitForPrimaryNodePosition(ownerPage, mutation.after);
        await waitForEditingFontCompileEvent(ownerPage, 0);
        await waitForEditingFontCompileEvent(editorPage, 0);
        await ownerPage.waitForTimeout(1200);
        await editorPage.waitForTimeout(1200);

        const ownerCompileEvents = await getEditingFontCompileEvents(ownerPage);
        const editorCompileEvents =
            await getEditingFontCompileEvents(editorPage);

        expect(ownerCompileEvents.length).toBeGreaterThan(0);
        expect(editorCompileEvents.length).toBeGreaterThan(0);

        expect(
            ownerCompileEvents[0]?.compilationMode,
            `Owner compile events: ${JSON.stringify(ownerCompileEvents)}`
        ).toBe('outline-only');
        expect(
            ownerCompileEvents[0]?.editType,
            `Owner compile events: ${JSON.stringify(ownerCompileEvents)}`
        ).toBe('outline');
        expect(
            ownerCompileEvents[0]?.changeSource,
            `Owner compile events: ${JSON.stringify(ownerCompileEvents)}`
        ).not.toBe('remote-change');
        expect(
            ownerCompileEvents.some(
                (event) => event.compilationMode === 'full'
            ),
            `Owner compile events: ${JSON.stringify(ownerCompileEvents)}`
        ).toBe(false);

        expect(
            editorCompileEvents.some(
                (event) => event.compilationMode === 'outline-only'
            ),
            `Editor compile events: ${JSON.stringify(editorCompileEvents)}`
        ).toBe(true);
        expect(
            editorCompileEvents[0]?.compilationMode,
            `Editor compile events: ${JSON.stringify(editorCompileEvents)}`
        ).not.toBe('full');

        await ownerContext.close();
        await editorContext.close();
    });

    test('accepts a viewer invite and keeps the invited account read-only', async ({
        browser
    }) => {
        test.setTimeout(240000);
        const ownerEmail = `owner-viewer-${Date.now()}@counterpunch.test`;
        const viewerEmail = `viewer-${Date.now()}@counterpunch.test`;
        const ownerContext = await browser.newContext({
            ignoreHTTPSErrors: true
        });
        const viewerContext = await browser.newContext({
            ignoreHTTPSErrors: true
        });
        const ownerPage = await ownerContext.newPage();
        const viewerPage = await viewerContext.newPage();

        await ownerPage.goto('/?test=true');
        await waitForCanvasReady(ownerPage);
        await bootstrapCloudSession(ownerPage, ownerEmail);
        await loadCloudTestFont(ownerPage);
        await waitForCloudFontModelReady(ownerPage);

        const assetId = await ownerPage.evaluate(async () => {
            return await (window as any).cloudPlugin.saveAs(
                `Playwright Invite Viewer ${Date.now()}`
            );
        });

        expect(assetId).toBeTruthy();
        await waitForCloudConnected(ownerPage);
        await waitForAuthenticatedCloudSession(ownerPage);
        await focusEditorGlyph(ownerPage, 'A');

        await viewerPage.goto('/?test=true');
        await waitForCanvasReady(viewerPage);
        await bootstrapCloudSession(viewerPage, viewerEmail);

        const inviteUrl = await createInvitationFromShareDialog(
            ownerPage,
            viewerEmail,
            'viewer'
        );

        await acceptInvitationAndOpenEditor(viewerPage, inviteUrl, {
            requireConnected: false
        });
        await focusEditorGlyph(viewerPage, 'A');

        const ownerBefore = await getPrimaryNodePosition(ownerPage);

        await movePrimaryNode(viewerPage, 9, 4).catch(() => undefined);

        await expect
            .poll(async () => await getPrimaryNodePosition(ownerPage), {
                timeout: 5000
            })
            .toEqual(ownerBefore);

        await ownerContext.close();
        await viewerContext.close();
    });

    test('removed editors cannot keep editing in an already-open browser context', async ({
        browser
    }) => {
        test.setTimeout(240000);
        const ownerEmail = `owner-remove-${Date.now()}@counterpunch.test`;
        const editorEmail = `editor-remove-${Date.now()}@counterpunch.test`;
        const ownerContext = await browser.newContext({
            ignoreHTTPSErrors: true
        });
        const editorContext = await browser.newContext({
            ignoreHTTPSErrors: true
        });
        const ownerPage = await ownerContext.newPage();
        const editorPage = await editorContext.newPage();

        await ownerPage.goto('/?test=true');
        await waitForCanvasReady(ownerPage);
        await bootstrapCloudSession(ownerPage, ownerEmail);
        await loadCloudTestFont(ownerPage);
        await waitForCloudFontModelReady(ownerPage);

        const assetId = await ownerPage.evaluate(async () => {
            return await (window as any).cloudPlugin.saveAs(
                `Playwright Remove Live Editor ${Date.now()}`
            );
        });

        expect(assetId).toBeTruthy();
        await waitForCloudConnected(ownerPage);
        await waitForAuthenticatedCloudSession(ownerPage);
        await focusEditorGlyph(ownerPage, 'A');

        await editorPage.goto('/?test=true');
        await waitForCanvasReady(editorPage);
        await bootstrapCloudSession(editorPage, editorEmail);

        const inviteUrl = await createInvitationFromShareDialog(
            ownerPage,
            editorEmail,
            'editor'
        );

        await acceptInvitationAndOpenEditor(editorPage, inviteUrl);
        await focusEditorGlyph(editorPage, 'A');

        const shareStateBefore = await getCloudShareState(ownerPage, assetId);
        const editorMember = shareStateBefore.members.find(
            (member) => member.email === editorEmail
        );
        expect(editorMember?.userId).toBeTruthy();

        const ownerBefore = await getPrimaryNodePosition(ownerPage);

        await removeCloudMember(
            ownerPage,
            String(editorMember?.userId),
            assetId
        );

        const shareStateAfterRemoval = await getCloudShareState(
            ownerPage,
            assetId
        );
        expect(
            shareStateAfterRemoval.members.some(
                (member) => member.email === editorEmail
            )
        ).toBe(false);

        await expect
            .poll(async () => await getCloudConnectionStatus(editorPage), {
                timeout: 30000
            })
            .not.toBe('connected');

        await movePrimaryNode(editorPage, 13, 6).catch(() => undefined);

        await expect
            .poll(async () => await getPrimaryNodePosition(ownerPage), {
                timeout: 5000
            })
            .toEqual(ownerBefore);

        await ownerContext.close();
        await editorContext.close();
    });

    test('editors demoted to viewers lose write access without a manual reload', async ({
        browser
    }) => {
        test.setTimeout(240000);
        const ownerEmail = `owner-demote-${Date.now()}@counterpunch.test`;
        const editorEmail = `editor-demote-${Date.now()}@counterpunch.test`;
        const ownerContext = await browser.newContext({
            ignoreHTTPSErrors: true
        });
        const editorContext = await browser.newContext({
            ignoreHTTPSErrors: true
        });
        const ownerPage = await ownerContext.newPage();
        const editorPage = await editorContext.newPage();

        await ownerPage.goto('/?test=true');
        await waitForCanvasReady(ownerPage);
        await bootstrapCloudSession(ownerPage, ownerEmail);
        await loadCloudTestFont(ownerPage);
        await waitForCloudFontModelReady(ownerPage);

        const assetId = await ownerPage.evaluate(async () => {
            return await (window as any).cloudPlugin.saveAs(
                `Playwright Demote Live Editor ${Date.now()}`
            );
        });

        expect(assetId).toBeTruthy();
        await waitForCloudConnected(ownerPage);
        await waitForAuthenticatedCloudSession(ownerPage);
        await focusEditorGlyph(ownerPage, 'A');

        await editorPage.goto('/?test=true');
        await waitForCanvasReady(editorPage);
        await bootstrapCloudSession(editorPage, editorEmail);

        const inviteUrl = await createInvitationFromShareDialog(
            ownerPage,
            editorEmail,
            'editor'
        );

        await acceptInvitationAndOpenEditor(editorPage, inviteUrl);
        await focusEditorGlyph(editorPage, 'A');

        const shareStateBefore = await getCloudShareState(ownerPage, assetId);
        const editorMember = shareStateBefore.members.find(
            (member) => member.email === editorEmail
        );
        expect(editorMember?.userId).toBeTruthy();

        const ownerBefore = await getPrimaryNodePosition(ownerPage);

        await updateCloudMemberRole(
            ownerPage,
            String(editorMember?.userId),
            'viewer',
            assetId
        );

        const ownerShareStateAfterDemotion = await getCloudShareState(
            ownerPage,
            assetId
        );
        expect(
            ownerShareStateAfterDemotion.members.find(
                (member) => member.email === editorEmail
            )?.role
        ).toBe('viewer');

        await expect
            .poll(async () => await getCloudConnectionStatus(editorPage), {
                timeout: 30000
            })
            .not.toBe('connected');

        await movePrimaryNode(editorPage, 12, 4).catch(() => undefined);

        await expect
            .poll(async () => await getPrimaryNodePosition(ownerPage), {
                timeout: 5000
            })
            .toEqual(ownerBefore);

        await ownerContext.close();
        await editorContext.close();
    });

    test('transfers ownership end to end and removes the previous owner when requested', async ({
        browser
    }) => {
        test.setTimeout(240000);
        const ownerEmail = `owner-transfer-${Date.now()}@counterpunch.test`;
        const newOwnerEmail = `new-owner-${Date.now()}@counterpunch.test`;
        const ownerContext = await browser.newContext({
            ignoreHTTPSErrors: true
        });
        const newOwnerContext = await browser.newContext({
            ignoreHTTPSErrors: true
        });
        const formerOwnerContext = await browser.newContext({
            ignoreHTTPSErrors: true
        });
        const ownerPage = await ownerContext.newPage();
        const newOwnerPage = await newOwnerContext.newPage();
        const formerOwnerPage = await formerOwnerContext.newPage();

        await ownerPage.goto('/?test=true');
        await waitForCanvasReady(ownerPage);
        await bootstrapCloudSession(ownerPage, ownerEmail);
        await loadCloudTestFont(ownerPage);
        await waitForCloudFontModelReady(ownerPage);

        const assetId = await ownerPage.evaluate(async () => {
            return await (window as any).cloudPlugin.saveAs(
                `Playwright Ownership Transfer ${Date.now()}`
            );
        });

        expect(assetId).toBeTruthy();
        await waitForCloudConnected(ownerPage);
        await waitForAuthenticatedCloudSession(ownerPage);

        await newOwnerPage.goto('/?test=true');
        await waitForCanvasReady(newOwnerPage);
        await bootstrapCloudSession(newOwnerPage, newOwnerEmail);

        const transferUrl = await createOwnershipTransferFromShareDialog(
            ownerPage,
            newOwnerEmail,
            'remove'
        );

        await acceptOwnershipTransferAndOpenEditor(newOwnerPage, transferUrl);
        const newOwnerShareState = await getCloudShareState(newOwnerPage);
        expect(newOwnerShareState.asset.role).toBe('owner');
        expect(newOwnerShareState.permissions.canManage).toBe(true);
        expect(newOwnerShareState.members).toEqual([
            expect.objectContaining({
                email: newOwnerEmail,
                role: 'owner'
            })
        ]);

        await formerOwnerPage.goto('/?test=true');
        await waitForCanvasReady(formerOwnerPage);
        await bootstrapCloudSession(formerOwnerPage, ownerEmail);
        const formerOwnerOpen = await tryOpenCloudAsset(
            formerOwnerPage,
            assetId
        );
        expect(formerOwnerOpen.ok).toBe(false);

        await ownerContext.close();
        await newOwnerContext.close();
        await formerOwnerContext.close();
    });

    test('gives the new owner management controls after transfer and limits the former owner to viewer access', async ({
        browser
    }) => {
        test.setTimeout(240000);
        const ownerEmail = `owner-transfer-viewer-${Date.now()}@counterpunch.test`;
        const newOwnerEmail = `new-owner-viewer-${Date.now()}@counterpunch.test`;
        const invitedViewerEmail = `transfer-viewer-${Date.now()}@counterpunch.test`;
        const ownerContext = await browser.newContext({
            ignoreHTTPSErrors: true
        });
        const newOwnerContext = await browser.newContext({
            ignoreHTTPSErrors: true
        });
        const formerOwnerContext = await browser.newContext({
            ignoreHTTPSErrors: true
        });
        const ownerPage = await ownerContext.newPage();
        const newOwnerPage = await newOwnerContext.newPage();
        const formerOwnerPage = await formerOwnerContext.newPage();

        await ownerPage.goto('/?test=true');
        await waitForCanvasReady(ownerPage);
        await bootstrapCloudSession(ownerPage, ownerEmail);
        await loadCloudTestFont(ownerPage);
        await waitForCloudFontModelReady(ownerPage);

        const assetId = await ownerPage.evaluate(async () => {
            return await (window as any).cloudPlugin.saveAs(
                `Playwright Ownership Capabilities ${Date.now()}`
            );
        });

        expect(assetId).toBeTruthy();
        await waitForCloudConnected(ownerPage);
        await waitForAuthenticatedCloudSession(ownerPage);

        await newOwnerPage.goto('/?test=true');
        await waitForCanvasReady(newOwnerPage);
        await bootstrapCloudSession(newOwnerPage, newOwnerEmail);

        const transferUrl = await createOwnershipTransferFromShareDialog(
            ownerPage,
            newOwnerEmail,
            'viewer'
        );

        await acceptOwnershipTransferAndOpenEditor(newOwnerPage, transferUrl);
        const newOwnerShareState = await getCloudShareState(newOwnerPage);
        expect(newOwnerShareState.asset.role).toBe('owner');
        expect(newOwnerShareState.permissions.canManage).toBe(true);
        expect(
            newOwnerShareState.members.map((member) => ({
                email: member.email,
                role: member.role
            }))
        ).toEqual(
            expect.arrayContaining([
                { email: newOwnerEmail, role: 'owner' },
                { email: ownerEmail, role: 'viewer' }
            ])
        );

        const inviteUrl = await createInvitationFromShareDialog(
            newOwnerPage,
            invitedViewerEmail,
            'viewer'
        );
        expect(inviteUrl).toContain('/invite?token=');

        await formerOwnerPage.goto('/?test=true');
        await waitForCanvasReady(formerOwnerPage);
        await bootstrapCloudSession(formerOwnerPage, ownerEmail);

        const formerOwnerShareState = await getCloudShareState(
            formerOwnerPage,
            assetId
        );
        expect(formerOwnerShareState.asset.role).toBe('viewer');
        expect(formerOwnerShareState.permissions.canManage).toBe(false);
        expect(formerOwnerShareState.members).toHaveLength(0);
        expect(formerOwnerShareState.invitations).toHaveLength(0);
        expect(formerOwnerShareState.ownershipTransfer).toBeNull();

        await ownerContext.close();
        await newOwnerContext.close();
        await formerOwnerContext.close();
    });

    test('supports linked-window sync and cloud sync simultaneously', async ({
        browser
    }) => {
        test.setTimeout(240000);
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
        await waitForCloudPageReady(mainPage);
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
        await waitForAuthenticatedCloudSession(mainPage);

        await mainPage.evaluate(async (nextAssetId) => {
            await (window as any).cloudPlugin.openAsset(nextAssetId);
        }, assetId);
        await waitForFontLoaded(mainPage);
        await waitForCloudConnected(mainPage);
        await waitForAuthenticatedCloudSession(mainPage);

        const linkedPage = await openLinkedWindow(mainPage);
        await waitForCloudConnected(linkedPage);
        await waitForAuthenticatedCloudSession(linkedPage);
        await installEditingFontCompileTracker(linkedPage);

        await remotePage.goto('/?test=true');
        await waitForCloudPageReady(remotePage);
        await bootstrapCloudSession(remotePage, email);
        await remotePage.evaluate(async (nextAssetId) => {
            await (window as any).cloudPlugin.openAsset(nextAssetId);
        }, assetId);
        await waitForFontLoaded(remotePage);
        await waitForCloudConnected(remotePage);
        await waitForAuthenticatedCloudSession(remotePage);
        await installEditingFontCompileTracker(remotePage);

        await setupEditTextMode(mainPage, 'ö');
        await setupEditTextMode(linkedPage, 'ö');
        await setupEditTextMode(remotePage, 'ö');
        await waitForCompiledGlyphBounds(mainPage, 'odieresis');
        await waitForCompiledGlyphBounds(linkedPage, 'odieresis');
        await waitForCompiledGlyphBounds(remotePage, 'odieresis');

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
        const beforeTopAnchorMain = await getAnchorPosition(
            mainPage,
            'o',
            'L0',
            'top'
        );
        const beforeTopAnchorLinked = await getAnchorPosition(
            linkedPage,
            'o',
            'L0',
            'top'
        );
        const beforeTopAnchorRemote = await getAnchorPosition(
            remotePage,
            'o',
            'L0',
            'top'
        );

        expect(beforeBoundsMain).toMatchObject({
            x1: expect.any(Number),
            y1: expect.any(Number),
            x2: expect.any(Number),
            y2: expect.any(Number)
        });
        expect(beforeBoundsLinked).toMatchObject({
            x1: expect.any(Number),
            y1: expect.any(Number),
            x2: expect.any(Number),
            y2: expect.any(Number)
        });
        expect(beforeBoundsRemote).toMatchObject({
            x1: expect.any(Number),
            y1: expect.any(Number),
            x2: expect.any(Number),
            y2: expect.any(Number)
        });
        expect(beforeTopAnchorLinked).toEqual(beforeTopAnchorMain);
        expect(beforeTopAnchorRemote).toEqual(beforeTopAnchorMain);

        await mainPage.evaluate(() => {
            const font = (window as any).currentFontModel;
            const glyphO = font?.findGlyph?.('o');
            if (!glyphO) {
                throw new Error('Glyph o is not available');
            }

            const layer = glyphO.findLayerById?.('L0');
            if (!layer) {
                throw new Error('Layer L0 is not available on glyph o');
            }

            const topAnchor = layer.findAnchor?.('top');
            if (!topAnchor) {
                throw new Error('Top anchor is not available on glyph o');
            }

            topAnchor.y += 100;
        });

        await expect
            .poll(
                async () => await getAnchorPosition(mainPage, 'o', 'L0', 'top')
            )
            .toEqual({
                x: beforeTopAnchorMain.x,
                y: beforeTopAnchorMain.y + 100
            });
        await waitForCompiledGlyphBounds(mainPage, 'odieresis');

        const expectedBounds = await getCompiledGlyphBounds(
            mainPage,
            'odieresis'
        );
        await expect
            .poll(
                async () =>
                    await getCompiledGlyphBounds(linkedPage, 'odieresis')
            )
            .toEqual(expectedBounds);
        await expect
            .poll(
                async () =>
                    await getCompiledGlyphBounds(remotePage, 'odieresis')
            )
            .toEqual(expectedBounds);
        await expect
            .poll(
                async () =>
                    await getAnchorPosition(linkedPage, 'o', 'L0', 'top')
            )
            .toEqual({
                x: beforeTopAnchorMain.x,
                y: beforeTopAnchorMain.y + 100
            });
        await expect
            .poll(
                async () =>
                    await getAnchorPosition(remotePage, 'o', 'L0', 'top')
            )
            .toEqual({
                x: beforeTopAnchorMain.x,
                y: beforeTopAnchorMain.y + 100
            });

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
        const afterTopAnchorMain = await getAnchorPosition(
            mainPage,
            'o',
            'L0',
            'top'
        );
        const afterTopAnchorLinked = await getAnchorPosition(
            linkedPage,
            'o',
            'L0',
            'top'
        );
        const afterTopAnchorRemote = await getAnchorPosition(
            remotePage,
            'o',
            'L0',
            'top'
        );

        expect(afterTopAnchorMain).toEqual({
            x: beforeTopAnchorMain.x,
            y: beforeTopAnchorMain.y + 100
        });
        expect(afterTopAnchorLinked).toEqual(afterTopAnchorMain);
        expect(afterTopAnchorRemote).toEqual(afterTopAnchorMain);
        expect(afterBoundsLinked).toEqual(afterBoundsMain);
        expect(afterBoundsRemote).toEqual(afterBoundsMain);

        await remoteContext.close();
        await mainContext.close();
    });
});
