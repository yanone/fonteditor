import { test, expect } from '@playwright/test';

test.describe('Toolbar menu hover switching', () => {
    test('hovering a sibling title switches the open menu', async ({
        page
    }) => {
        await page.goto('/');
        await expect(page.locator('#toolbar-file-menu-btn')).toBeVisible();

        await page.locator('#toolbar-file-menu-btn').click();
        await expect(
            page.locator('.tippy-box .toolbar-menu-item', { hasText: 'Open…' })
        ).toBeVisible();

        await page.locator('#toolbar-edit-menu-btn').hover();
        await expect(
            page.locator('.tippy-box .toolbar-menu-item', { hasText: 'Undo' })
        ).toBeVisible();
        await expect(
            page.locator('.tippy-box .toolbar-menu-item', { hasText: 'Open…' })
        ).toHaveCount(0);
    });
});
