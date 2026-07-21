import { test, expect } from '@playwright/test';
import {
    focusView,
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';

test.describe('Open Dialog UI', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/?test=true');
        await waitForCanvasReady(page);
        await page.mouse.move(-100, -100);
        await page.waitForTimeout(200);
        await focusView(page, 'Meta+Shift+E', 'view-editor');
        await page.waitForTimeout(300);
    });

    test('reopen shows the current file URI in the footer', async ({
        page
    }) => {
        await page.evaluate(async () => {
            await (window as any).showFontFileDialog?.({ mode: 'open' });
        });

        const dialog = page.locator('#font-file-dialog');
        await dialog.waitFor({ state: 'visible' });
        await dialog
            .locator('.file-item[data-name="Fustat.glyphs"]')
            .dblclick();

        await waitForFontLoaded(page);
        await waitForOpenSessionReady(page, 'Fustat.glyphs');

        await page.evaluate(async () => {
            await (window as any).showFontFileDialog?.({ mode: 'open' });
        });

        await expect(dialog).toBeVisible();
        await expect(dialog.locator('#file-dialog-selection')).toContainText(
            'memory:///user/Fustat.glyphs'
        );
    });

    test('save as does not open files on double click', async ({ page }) => {
        await page.evaluate(async () => {
            await (window as any).showFontFileDialog?.({ mode: 'open' });
        });

        const dialog = page.locator('#font-file-dialog');
        await dialog.waitFor({ state: 'visible' });
        await dialog
            .locator('.file-item[data-name="Fustat.glyphs"]')
            .dblclick();

        await waitForFontLoaded(page);
        await waitForOpenSessionReady(page, 'Fustat.glyphs');

        await page.evaluate(async () => {
            await (window as any).showFontFileDialog?.({ mode: 'save-as' });
        });

        await expect(dialog).toBeVisible();

        const currentFontPathBefore = await page.evaluate(() => {
            return (window as any).fontManager?.currentFont?.path || null;
        });

        await dialog
            .locator('.file-item[data-name="YanoneKaffeesatz.designspace"]')
            .dblclick();

        await page.waitForTimeout(300);
        await expect(dialog).toBeVisible();

        const currentFontPathAfter = await page.evaluate(() => {
            return (window as any).fontManager?.currentFont?.path || null;
        });

        expect(currentFontPathAfter).toBe(currentFontPathBefore);
    });

    test('save as writes Glyphs source for a .glyphs filename', async ({
        page
    }) => {
        let saveError: string | null = null;
        page.on('dialog', async (dialog) => {
            saveError = dialog.message();
            await dialog.dismiss();
        });

        await page.evaluate(async () => {
            await (window as any).showFontFileDialog?.({ mode: 'open' });
        });

        const dialog = page.locator('#font-file-dialog');
        await dialog.waitFor({ state: 'visible' });
        await dialog
            .locator('.file-item[data-name="Fustat.glyphs"]')
            .dblclick();

        await waitForFontLoaded(page);
        await waitForOpenSessionReady(page, 'Fustat.glyphs');

        const savedFileName = `save-as-glyphs-${Date.now()}.glyphs`;
        await page.evaluate(async () => {
            await (window as any).showFontFileDialog?.({ mode: 'save-as' });
        });

        await dialog.locator('#file-dialog-save-name').fill(savedFileName);
        await dialog.locator('#file-dialog-confirm-btn').click();
        await expect
            .poll(async () => (await dialog.isHidden()) || saveError !== null, {
                timeout: 10000
            })
            .toBe(true);
        expect(saveError).toBeNull();
        await expect(dialog).toBeHidden();

        const savedContent = await page.evaluate(async (fileName) => {
            const plugin = (window as any).pluginRegistry.get('memory');
            const content = await plugin
                .getAdapter()
                .readFile(`/user/${fileName}`);
            return typeof content === 'string'
                ? content
                : new TextDecoder().decode(content);
        }, savedFileName);

        expect(savedContent).toContain('.formatVersion = 3;');
        expect(savedContent).not.toContain('"glyphs":');
    });

    test('cloud save as closes the dialog even if the refresh fails', async ({
        page
    }) => {
        await page.evaluate(async () => {
            await (window as any).showFontFileDialog?.({ mode: 'open' });
        });

        const dialog = page.locator('#font-file-dialog');
        await dialog.waitFor({ state: 'visible' });
        await dialog
            .locator('.file-item[data-name="Fustat.glyphs"]')
            .dblclick();

        await waitForFontLoaded(page);
        await waitForOpenSessionReady(page, 'Fustat.glyphs');

        await page.evaluate(async () => {
            await (window as any).switchContext?.('cloud');

            const cloudPlugin = (window as any).cloudPlugin;
            const currentFont = (window as any).fontManager?.currentFont;
            const originalHandleSaveAs =
                cloudPlugin.handleSaveAs.bind(cloudPlugin);
            const adapter = cloudPlugin.getAdapter();
            const originalScanDirectory = adapter.scanDirectory.bind(adapter);

            cloudPlugin.handleSaveAs = async () => {
                if (currentFont) {
                    currentFont.path = 'cloud://mock-saved-asset';
                    currentFont.sourcePlugin = cloudPlugin;
                    currentFont.hasUnsavedChanges = false;
                }
                return true;
            };

            adapter.scanDirectory = async () => {
                throw new Error('synthetic refresh failure');
            };

            await (window as any).showFontFileDialog?.({ mode: 'save-as' });

            (window as any).__restoreCloudSaveAsDialogTest = () => {
                cloudPlugin.handleSaveAs = originalHandleSaveAs;
                adapter.scanDirectory = originalScanDirectory;
            };
        });
        await dialog.waitFor({ state: 'visible' });
        await dialog.locator('#file-dialog-save-name').fill('Cloud Save Close');
        await dialog.locator('#file-dialog-confirm-btn').click();
        await expect(dialog).toBeHidden();

        await page.evaluate(() => {
            (window as any).__restoreCloudSaveAsDialogTest?.();
            delete (window as any).__restoreCloudSaveAsDialogTest;
        });
    });

    test('cloud save as failure keeps the dialog open and shows an inline error', async ({
        page
    }) => {
        page.on('dialog', async (dialog) => {
            await dialog.dismiss();
        });

        await page.evaluate(async () => {
            await (window as any).showFontFileDialog?.({ mode: 'open' });
        });

        const dialog = page.locator('#font-file-dialog');
        await dialog.waitFor({ state: 'visible' });
        await dialog
            .locator('.file-item[data-name="Fustat.glyphs"]')
            .dblclick();

        await waitForFontLoaded(page);
        await waitForOpenSessionReady(page, 'Fustat.glyphs');

        await page.evaluate(async () => {
            await (window as any).switchContext?.('cloud');

            const cloudPlugin = (window as any).cloudPlugin;
            const originalHandleSaveAs =
                cloudPlugin.handleSaveAs.bind(cloudPlugin);

            cloudPlugin.handleSaveAs = async () => {
                throw new Error('synthetic cloud save failure');
            };

            await (window as any).showFontFileDialog?.({ mode: 'save-as' });

            (window as any).__restoreCloudSaveAsDialogFailureTest = () => {
                cloudPlugin.handleSaveAs = originalHandleSaveAs;
            };
        });

        await dialog.waitFor({ state: 'visible' });
        await dialog.locator('#file-dialog-save-name').fill('Cloud Save Fail');
        await dialog.locator('#file-dialog-confirm-btn').click();

        await expect(dialog).toBeVisible();
        await expect(
            dialog.locator('#font-file-dialog-close-btn')
        ).toBeEnabled();
        await expect(page.locator('#plugin-message-container')).toContainText(
            'synthetic cloud save failure'
        );

        await page.evaluate(() => {
            (window as any).__restoreCloudSaveAsDialogFailureTest?.();
            delete (window as any).__restoreCloudSaveAsDialogFailureTest;
        });
    });

    test('cloud save as shows a visible near-limit warning before saving', async ({
        page
    }) => {
        await page.evaluate(async () => {
            await (window as any).showFontFileDialog?.({ mode: 'open' });
        });

        const dialog = page.locator('#font-file-dialog');
        await dialog.waitFor({ state: 'visible' });
        await dialog
            .locator('.file-item[data-name="Fustat.glyphs"]')
            .dblclick();

        await waitForFontLoaded(page);
        await waitForOpenSessionReady(page, 'Fustat.glyphs');

        await page.evaluate(async () => {
            await (window as any).switchContext?.('cloud');
            const cloudPlugin = (window as any).cloudPlugin;
            const originalGetCurrentSaveAsWarningState =
                cloudPlugin.getCurrentSaveAsWarningState.bind(cloudPlugin);

            cloudPlugin.getCurrentSaveAsWarningState = async () => ({
                visible: true,
                title: 'Near limit warning',
                label: 'Near limit',
                icon: 'warning',
                tone: 'warning',
                canSave: true
            });

            await (window as any).showFontFileDialog?.({
                mode: 'save-as',
                pluginId: 'cloud'
            });

            (window as any).__restoreCloudSaveWarningTest = () => {
                cloudPlugin.getCurrentSaveAsWarningState =
                    originalGetCurrentSaveAsWarningState;
            };
        });

        await dialog.waitFor({ state: 'visible' });
        await expect(dialog.locator('#file-dialog-save-warning')).toContainText(
            'Near limit'
        );
        await expect(dialog.locator('#file-dialog-confirm-btn')).toBeEnabled();

        await page.evaluate(() => {
            (window as any).__restoreCloudSaveWarningTest?.();
            delete (window as any).__restoreCloudSaveWarningTest;
        });
    });

    test('cloud save as shows a visible size error and disables saving before submit', async ({
        page
    }) => {
        await page.evaluate(async () => {
            await (window as any).showFontFileDialog?.({ mode: 'open' });
        });

        const dialog = page.locator('#font-file-dialog');
        await dialog.waitFor({ state: 'visible' });
        await dialog
            .locator('.file-item[data-name="Fustat.glyphs"]')
            .dblclick();

        await waitForFontLoaded(page);
        await waitForOpenSessionReady(page, 'Fustat.glyphs');

        await page.evaluate(async () => {
            await (window as any).switchContext?.('cloud');
            const cloudPlugin = (window as any).cloudPlugin;
            const originalGetCurrentSaveAsWarningState =
                cloudPlugin.getCurrentSaveAsWarningState.bind(cloudPlugin);

            cloudPlugin.getCurrentSaveAsWarningState = async () => ({
                visible: true,
                title: 'Too large error',
                label: 'Too large',
                icon: 'sync_problem',
                tone: 'error',
                canSave: false
            });

            await (window as any).showFontFileDialog?.({
                mode: 'save-as',
                pluginId: 'cloud'
            });

            (window as any).__restoreCloudSaveWarningTest = () => {
                cloudPlugin.getCurrentSaveAsWarningState =
                    originalGetCurrentSaveAsWarningState;
            };
        });

        await dialog.waitFor({ state: 'visible' });
        await expect(dialog.locator('#file-dialog-save-warning')).toContainText(
            'Too large'
        );
        await expect(dialog.locator('#file-dialog-confirm-btn')).toBeDisabled();

        await page.evaluate(() => {
            (window as any).__restoreCloudSaveWarningTest?.();
            delete (window as any).__restoreCloudSaveWarningTest;
        });
    });

    test('cloud open failure keeps the dialog open, shows an inline error, and preserves the current font', async ({
        page
    }) => {
        let sawDialog = false;
        page.on('dialog', async (dialog) => {
            sawDialog = true;
            await dialog.dismiss();
        });

        await page.evaluate(async () => {
            await (window as any).showFontFileDialog?.({ mode: 'open' });
        });

        const dialog = page.locator('#font-file-dialog');
        await dialog.waitFor({ state: 'visible' });
        await dialog
            .locator('.file-item[data-name="Fustat.glyphs"]')
            .dblclick();

        await waitForFontLoaded(page);
        await waitForOpenSessionReady(page, 'Fustat.glyphs');

        const currentFontPathBefore = await page.evaluate(() => {
            return (window as any).fontManager?.currentFont?.path || null;
        });

        await page.evaluate(async () => {
            await (window as any).switchContext?.('cloud');

            const cloudPlugin = (window as any).cloudPlugin;
            const adapter = cloudPlugin.getAdapter();
            const originalHandleOpenPath =
                cloudPlugin.handleOpenPath.bind(cloudPlugin);
            const originalScanDirectory = adapter.scanDirectory.bind(adapter);

            cloudPlugin.handleOpenPath = async () => {
                throw new Error('synthetic cloud open failure');
            };

            adapter.scanDirectory = async () => ({
                'Cloud Open Fail.babelfont': {
                    path: 'cloud://asset-open-fail',
                    is_dir: false,
                    size: 128,
                    modified: Date.now()
                }
            });

            await (window as any).navigateToPath?.(
                cloudPlugin.getDefaultPath?.() || '/'
            );
            await (window as any).showFontFileDialog?.({ mode: 'open' });

            (window as any).__restoreCloudOpenFailureTest = () => {
                cloudPlugin.handleOpenPath = originalHandleOpenPath;
                adapter.scanDirectory = originalScanDirectory;
            };
        });

        await dialog.waitFor({ state: 'visible' });
        await dialog
            .locator('.file-item[data-name="Cloud Open Fail.babelfont"]')
            .click();
        await expect(dialog.locator('#file-dialog-confirm-btn')).toBeEnabled();
        await dialog.locator('#file-dialog-confirm-btn').click();

        await expect(dialog).toBeVisible();
        await expect(
            dialog.locator('#font-file-dialog-close-btn')
        ).toBeEnabled();
        await expect(page.locator('#plugin-message-container')).toContainText(
            'synthetic cloud open failure'
        );
        expect(sawDialog).toBe(false);

        const currentFontPathAfter = await page.evaluate(() => {
            return (window as any).fontManager?.currentFont?.path || null;
        });
        expect(currentFontPathAfter).toBe(currentFontPathBefore);

        await page.evaluate(() => {
            (window as any).__restoreCloudOpenFailureTest?.();
            delete (window as any).__restoreCloudOpenFailureTest;
        });
    });

    test('plugin switch clears stale selection and disables open', async ({
        page
    }) => {
        await page.evaluate(async () => {
            await (window as any).showFontFileDialog?.({ mode: 'open' });
        });

        const dialog = page.locator('#font-file-dialog');
        await dialog.waitFor({ state: 'visible' });

        await dialog.locator('.file-item[data-name="Fustat.glyphs"]').click();
        await expect(dialog.locator('#file-dialog-selection')).toContainText(
            'memory:///user/Fustat.glyphs'
        );
        await expect(dialog.locator('#file-dialog-confirm-btn')).toBeEnabled();

        await page.evaluate(async () => {
            await (window as any).switchContext?.('cloud');
        });

        await expect(
            dialog.locator('#file-dialog-selection')
        ).not.toContainText('memory:///user/Fustat.glyphs');
        await expect(dialog.locator('#file-dialog-confirm-btn')).toBeDisabled();
    });

    test('shows last refreshed status in the header', async ({ page }) => {
        await page.evaluate(async () => {
            await (window as any).showFontFileDialog?.({ mode: 'open' });
        });

        const dialog = page.locator('#font-file-dialog');
        await dialog.waitFor({ state: 'visible' });

        await expect(dialog.locator('#file-last-refreshed')).toContainText(
            'Last refreshed'
        );
    });

    test('opening the already open file just closes the dialog', async ({
        page
    }) => {
        await page.evaluate(async () => {
            await (window as any).showFontFileDialog?.({ mode: 'open' });
        });

        const dialog = page.locator('#font-file-dialog');
        await dialog.waitFor({ state: 'visible' });
        await dialog
            .locator('.file-item[data-name="Fustat.glyphs"]')
            .dblclick();

        await waitForFontLoaded(page);
        await waitForOpenSessionReady(page, 'Fustat.glyphs');

        const fontPathBefore = await page.evaluate(() => {
            return (window as any).fontManager?.currentFont?.path || null;
        });

        await page.evaluate(async () => {
            await (window as any).showFontFileDialog?.({ mode: 'open' });
        });
        await dialog.waitFor({ state: 'visible' });

        await dialog.locator('#file-dialog-confirm-btn').click();
        await expect(dialog).toBeHidden();

        const fontPathAfter = await page.evaluate(() => {
            return (window as any).fontManager?.currentFont?.path || null;
        });

        expect(fontPathAfter).toBe(fontPathBefore);
    });

    test('memory plugin shows refresh button and no auto-refresh label', async ({
        page
    }) => {
        await page.evaluate(async () => {
            await (window as any).showFontFileDialog?.({ mode: 'open' });
        });

        const dialog = page.locator('#font-file-dialog');
        await dialog.waitFor({ state: 'visible' });

        await expect(
            dialog.locator('.file-header-btn', { hasText: 'Refresh' })
        ).toBeVisible();
        await expect(dialog.locator('#file-last-refreshed')).toContainText(
            'Last refreshed'
        );
        await expect(dialog.locator('#file-last-refreshed')).not.toContainText(
            'Auto refresh'
        );
    });

    test('header actions are limited to memory for uploads and hide new file everywhere', async ({
        page
    }) => {
        await page.evaluate(async () => {
            await (window as any).showFontFileDialog?.({ mode: 'open' });
        });

        const dialog = page.locator('#font-file-dialog');
        await dialog.waitFor({ state: 'visible' });

        await expect(
            dialog.locator('.file-header-btn', { hasText: 'New File' })
        ).toHaveCount(0);
        await expect(
            dialog.locator('.file-header-btn', { hasText: 'Upload Files' })
        ).toBeVisible();
        await expect(
            dialog.locator('.file-header-btn', { hasText: 'Upload Folder' })
        ).toBeVisible();

        await page.evaluate(async () => {
            await (window as any).switchContext?.('cloud');
        });

        await expect(
            dialog.locator('.file-header-btn', { hasText: 'New File' })
        ).toHaveCount(0);
        await expect(
            dialog.locator('.file-header-btn', { hasText: 'Upload Files' })
        ).toHaveCount(0);
        await expect(
            dialog.locator('.file-header-btn', { hasText: 'Upload Folder' })
        ).toHaveCount(0);
        await expect(
            dialog.locator('.file-header-btn', { hasText: 'New Folder' })
        ).toHaveCount(0);
    });
});
