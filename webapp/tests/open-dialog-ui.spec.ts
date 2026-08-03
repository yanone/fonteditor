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
            const cloudPlugin = (window as any).cloudPlugin;
            const currentFont = (window as any).fontManager?.currentFont;
            const originalIsVisibleInUI =
                cloudPlugin.isVisibleInUI.bind(cloudPlugin);
            const originalHandleSaveAs =
                cloudPlugin.handleSaveAs.bind(cloudPlugin);
            const adapter = cloudPlugin.getAdapter();
            const originalScanDirectory = adapter.scanDirectory.bind(adapter);

            cloudPlugin.isVisibleInUI = () => true;
            cloudPlugin.handleSaveAs = async () => {
                (window as any).__cloudSaveAsHandlerCalls =
                    ((window as any).__cloudSaveAsHandlerCalls || 0) + 1;
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

            await (window as any).showFontFileDialog?.({
                mode: 'save-as',
                pluginId: 'cloud'
            });

            (window as any).__restoreCloudSaveAsDialogTest = () => {
                cloudPlugin.isVisibleInUI = originalIsVisibleInUI;
                cloudPlugin.handleSaveAs = originalHandleSaveAs;
                adapter.scanDirectory = originalScanDirectory;
            };
        });
        await dialog.waitFor({ state: 'visible' });
        await dialog.locator('#file-dialog-save-name').fill('Cloud Save Close');
        await dialog.locator('#file-dialog-confirm-btn').click();
        await expect
            .poll(() =>
                page.evaluate(() => (window as any).__cloudSaveAsHandlerCalls)
            )
            .toBe(1);
        await expect(dialog).toBeHidden();

        await page.evaluate(() => {
            (window as any).__restoreCloudSaveAsDialogTest?.();
            delete (window as any).__restoreCloudSaveAsDialogTest;
            delete (window as any).__cloudSaveAsHandlerCalls;
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
            const cloudPlugin = (window as any).cloudPlugin;
            const originalIsVisibleInUI =
                cloudPlugin.isVisibleInUI.bind(cloudPlugin);
            const originalHandleSaveAs =
                cloudPlugin.handleSaveAs.bind(cloudPlugin);

            cloudPlugin.isVisibleInUI = () => true;
            cloudPlugin.handleSaveAs = async () => {
                throw new Error('synthetic cloud save failure');
            };

            await (window as any).showFontFileDialog?.({
                mode: 'save-as',
                pluginId: 'cloud'
            });

            (window as any).__restoreCloudSaveAsDialogFailureTest = () => {
                cloudPlugin.isVisibleInUI = originalIsVisibleInUI;
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
            const cloudPlugin = (window as any).cloudPlugin;
            const originalIsVisibleInUI =
                cloudPlugin.isVisibleInUI.bind(cloudPlugin);
            const originalOnActivate = cloudPlugin.onActivate.bind(cloudPlugin);
            const originalUpdateUI = cloudPlugin.updateUI.bind(cloudPlugin);
            cloudPlugin.isVisibleInUI = () => true;
            cloudPlugin.onActivate = async () => true;
            cloudPlugin.updateUI = async () => {};

            await (window as any).switchContext?.('cloud');

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
                cloudPlugin.isVisibleInUI = originalIsVisibleInUI;
                cloudPlugin.onActivate = originalOnActivate;
                cloudPlugin.updateUI = originalUpdateUI;
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
});
