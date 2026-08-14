import { test, expect } from '@playwright/test';
import { waitForCanvasReady } from './helpers/snapshot-helper';

test('Help documentation opens the docs column', async ({ page }) => {
    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    await page.evaluate(async () => {
        await window.openDocs('getting-started/before-you-begin');
    });

    await expect(page.locator('#app-shell')).toHaveClass(/docs-open/);
    await expect(page.locator('#view-docs')).toBeVisible();
    await expect(page.locator('#docs-article h1')).toHaveText(
        'Before you begin'
    );

    await page.locator('#docs-close-btn').click();
    await expect(page.locator('#app-shell')).not.toHaveClass(/docs-open/);
    await expect(page.locator('#view-docs')).toBeHidden();
});

test('Editor question mark opens the glyph editor docs', async ({ page }) => {
    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    await page.locator('#editor-info-btn').click();
    await expect(page.locator('#app-shell')).toHaveClass(/docs-open/);
    await expect(page.locator('#docs-article h1')).toHaveText('Glyph editor');

    const editorToc = page.locator('.docs-toc-link.is-current');
    await expect(editorToc).toHaveText('Glyph editor');
    const tocItemVisible = await editorToc.evaluate((el) => {
        const toc = document.getElementById('docs-toc');
        if (!toc) {
            return false;
        }
        const item = el.getBoundingClientRect();
        const nav = toc.getBoundingClientRect();
        return item.top >= nav.top - 1 && item.bottom <= nav.bottom + 1;
    });
    expect(tocItemVisible).toBe(true);
});

test('Cmd+Shift+D opens docs and Cmd+Escape closes them', async ({ page }) => {
    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    await page.keyboard.press('Meta+Shift+D');
    await expect(page.locator('#app-shell')).toHaveClass(/docs-open/);
    await expect(page.locator('#view-docs')).toBeVisible();

    await page.keyboard.press('Meta+Escape');
    await expect(page.locator('#app-shell')).not.toHaveClass(/docs-open/);
    await expect(page.locator('#view-docs')).toBeHidden();
});

test('Cmd+Escape closes docs only when the docs panel is focused', async ({
    page
}) => {
    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    await page.evaluate(async () => {
        await window.openDocs('getting-started/workspace-tour');
    });
    await expect(page.locator('#app-shell')).toHaveClass(/docs-open/);
    await expect(page.locator('#view-docs')).toHaveClass(/focused/);

    await page.locator('#view-editor .view-title-bar').click();
    await expect(page.locator('#view-editor')).toHaveClass(/focused/);

    await page.keyboard.press('Meta+Escape');
    await expect(page.locator('#app-shell')).toHaveClass(/docs-open/);

    await expect(async () => {
        await page.locator('#view-docs .view-title-name').click();
        await expect(page.locator('#view-docs')).toHaveClass(/focused/, {
            timeout: 500
        });
    }).toPass();
    await page.keyboard.press('Meta+Escape');
    await expect(page.locator('#app-shell')).not.toHaveClass(/docs-open/);
});

test('Python API pages highlight code with Ace', async ({ page }) => {
    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    await page.evaluate(async () => {
        await window.openDocs('python/python-api');
    });

    await expect(page.locator('#docs-article h1')).toHaveText('Python API');
    await expect(
        page
            .locator('#docs-article pre.docs-code-block .ace_static_highlight')
            .first()
    ).toBeVisible();
});

test('Script editor docs heading does not steal the Ace editor id', async ({
    page
}) => {
    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    await page.evaluate(async () => {
        await window.openDocs('python/script-editor-workflow');
    });

    await expect(page.locator('#docs-article h1')).toHaveText('Script editor');
    await expect(page.locator('#docs-article h1')).toHaveAttribute(
        'id',
        'docs-script-editor'
    );

    const aceHost = page.locator('#view-scripts #script-editor');
    await expect(aceHost).toHaveCount(1);
    await expect(page.locator('#docs-article h1 .ace_gutter')).toHaveCount(0);
});

test('Docs show OS-specific modifiers, not Cmd/Ctrl or Alt/Option', async ({
    page
}) => {
    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    await page.evaluate(async () => {
        await window.openDocs('reference/keyboard-shortcuts');
    });

    const article = page.locator('#docs-article');
    await expect(article).toHaveText(/Keyboard shortcuts/);
    await expect(article).not.toContainText('Cmd/Ctrl');
    await expect(article).not.toContainText('Alt/Option');

    const usesCommand = await page.evaluate(() =>
        navigator.platform.toUpperCase().includes('MAC')
    );
    if (usesCommand) {
        await expect(article).toContainText('Cmd+Shift+E');
        await expect(article).not.toContainText('Ctrl+Shift+E');
        await expect(article).toContainText('Option+Click');
        await expect(article).toContainText('Cmd+Option+R');
        await expect(article).not.toContainText('Alt+Click');
        await expect(article).not.toContainText('Ctrl+Alt+R');
    } else {
        await expect(article).toContainText('Ctrl+Shift+E');
        await expect(article).not.toContainText('Cmd+Shift+E');
        await expect(article).toContainText('Alt+Click');
        await expect(article).toContainText('Ctrl+Alt+R');
        await expect(article).not.toContainText('Option+Click');
        await expect(article).not.toContainText('Cmd+Option+R');
    }
});
