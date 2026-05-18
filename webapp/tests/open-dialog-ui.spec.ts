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
