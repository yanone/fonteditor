import { test, expect, type Page } from '@playwright/test';
import {
    focusView,
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';

async function openFustatOnce(page: Page) {
    await page.evaluate(async () => {
        await (window as any).showFontFileDialog?.({ mode: 'open' });
    });

    const dialog = page.locator('#font-file-dialog');
    await dialog.waitFor({ state: 'visible' });
    await dialog.locator('.file-item[data-name="Fustat.glyphs"]').dblclick();

    await waitForFontLoaded(page);
    await waitForOpenSessionReady(page, 'Fustat.glyphs');
}

async function closeFontDialogIfOpen(page: Page) {
    const dialog = page.locator('#font-file-dialog');
    if (await dialog.isVisible()) {
        const closeBtn = dialog.locator('#font-file-dialog-close-btn');
        if (await closeBtn.isEnabled()) {
            await closeBtn.click();
        } else {
            await page.keyboard.press('Escape');
        }
        await expect(dialog).toBeHidden();
    }
}

test.describe('Open Dialog UI', () => {
    test.describe.configure({ mode: 'serial' });

    test('open, save-as, and cloud dialog behaviors share one Fustat session', async ({
        page
    }) => {
        await page.goto('/?test=true');
        await waitForCanvasReady(page);
        await page.mouse.move(-100, -100);
        await focusView(page, 'Meta+Shift+E', 'view-editor');

        await openFustatOnce(page);

        const dialog = page.locator('#font-file-dialog');

        // Reopen shows the current file URI in the footer.
        await page.evaluate(async () => {
            await (window as any).showFontFileDialog?.({ mode: 'open' });
        });
        await expect(dialog).toBeVisible();
        await expect(dialog.locator('#file-dialog-selection')).toContainText(
            'memory:///user/Fustat.glyphs'
        );
        await closeFontDialogIfOpen(page);

        // Save as writes Glyphs source for a .glyphs filename.
        let saveError: string | null = null;
        const dismissAlert = async (browserDialog: {
            message: () => string;
            dismiss: () => Promise<void>;
        }) => {
            saveError = browserDialog.message();
            await browserDialog.dismiss();
        };
        page.on('dialog', dismissAlert);

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

        // Cloud save as closes the dialog even if the refresh fails.
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

        // Cloud save as failure keeps the dialog open and shows an inline error.
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
        await closeFontDialogIfOpen(page);

        // Cloud open failure keeps the dialog open and preserves the current font.
        // Note: prior cloud save-as success mutated path to cloud://mock-saved-asset;
        // restore a memory path for the preservation assertion by reopening Fustat.
        await page.evaluate(async () => {
            const fontManager = (window as any).fontManager;
            const memoryPlugin = (window as any).pluginRegistry?.get?.(
                'memory'
            );
            if (fontManager?.currentFont && memoryPlugin) {
                fontManager.currentFont.path = 'memory:///user/Fustat.glyphs';
                fontManager.currentFont.sourcePlugin = memoryPlugin;
            }
        });

        let sawDialog = false;
        page.off('dialog', dismissAlert);
        page.on('dialog', async (browserDialog) => {
            sawDialog = true;
            await browserDialog.dismiss();
        });

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
