import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForCanvasReady } from './helpers/snapshot-helper';

async function resetDocsUi(page: Page) {
    await page.evaluate(() => {
        window.closeDocs();
        window.themeSwitcher.setTheme('dark');
    });
    await expect(page.locator('#app-shell')).not.toHaveClass(/docs-open/);
}

test.describe('Docs viewer', () => {
    test.describe.configure({ mode: 'serial' });

    // One cold boot for the eight UI checks; resetDocsUi between cases.
    test('docs UI interactions share one session', async ({ page }) => {
        await page.goto('/?test=true');
        await waitForCanvasReady(page);

        await test.step('Help documentation opens the docs column', async () => {
            await page.evaluate(async () => {
                await window.openDocs('getting-started/before-you-begin');
            });

            await expect(page.locator('#app-shell')).toHaveClass(/docs-open/);
            await expect(page.locator('#view-docs')).toBeVisible();
            await expect(page.locator('#docs-article h1')).toHaveText(
                'Before you begin'
            );

            await page.locator('#docs-close-btn').click();
            await expect(page.locator('#app-shell')).not.toHaveClass(
                /docs-open/
            );
            await expect(page.locator('#view-docs')).toBeHidden();
        });
        await resetDocsUi(page);

        await test.step('Editor question mark opens the glyph editor docs', async () => {
            await page.locator('#editor-info-btn').click();
            await expect(page.locator('#app-shell')).toHaveClass(/docs-open/);
            await expect(page.locator('#docs-article h1')).toHaveText(
                'Glyph editor'
            );

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
        await resetDocsUi(page);

        await test.step('Cmd+Shift+D opens docs and Cmd+Escape closes them', async () => {
            await page.keyboard.press('Meta+Shift+D');
            await expect(page.locator('#app-shell')).toHaveClass(/docs-open/);
            await expect(page.locator('#view-docs')).toBeVisible();
            // openDocs is async from the shortcut; Cmd+Escape only closes the
            // focused panel, so wait until Docs owns focus before escaping.
            await expect(page.locator('#view-docs')).toHaveClass(/focused/);

            await page.keyboard.press('Meta+Escape');
            await expect(page.locator('#app-shell')).not.toHaveClass(
                /docs-open/
            );
            await expect(page.locator('#view-docs')).toBeHidden();
        });
        await resetDocsUi(page);

        await test.step('Cmd+Escape closes docs only when the docs panel is focused', async () => {
            await page.evaluate(async () => {
                await window.openDocs('getting-started/workspace-tour');
            });
            await expect(page.locator('#app-shell')).toHaveClass(/docs-open/);
            await expect(page.locator('#view-docs')).toHaveClass(/focused/);

            await expect(async () => {
                await page.locator('#view-editor .view-title-name').click();
                await expect(page.locator('#view-editor')).toHaveClass(
                    /focused/,
                    {
                        timeout: 500
                    }
                );
            }).toPass();

            await page.keyboard.press('Meta+Escape');
            await expect(page.locator('#app-shell')).toHaveClass(/docs-open/);

            await expect(async () => {
                await page.locator('#view-docs .view-title-name').click();
                await expect(page.locator('#view-docs')).toHaveClass(
                    /focused/,
                    {
                        timeout: 500
                    }
                );
            }).toPass();
            await page.keyboard.press('Meta+Escape');
            await expect(page.locator('#app-shell')).not.toHaveClass(
                /docs-open/
            );
        });
        await resetDocsUi(page);

        await test.step('Python API pages highlight code with Ace', async () => {
            await page.evaluate(async () => {
                await window.openDocs('python/python-api');
            });

            await expect(page.locator('#docs-article h1')).toHaveText(
                'Python API'
            );
            await expect(
                page
                    .locator(
                        '#docs-article pre.docs-code-block .ace_static_highlight'
                    )
                    .first()
            ).toBeVisible();
        });
        await resetDocsUi(page);

        await test.step('Script editor docs heading does not steal the Ace editor id', async () => {
            await page.evaluate(async () => {
                await window.openDocs('python/script-editor-workflow');
            });

            await expect(page.locator('#docs-article h1')).toHaveText(
                'Script editor'
            );
            await expect(page.locator('#docs-article h1')).toHaveAttribute(
                'id',
                'docs-script-editor'
            );

            const aceHost = page.locator('#view-scripts #script-editor');
            await expect(aceHost).toHaveCount(1);
            await expect(
                page.locator('#docs-article h1 .ace_gutter')
            ).toHaveCount(0);
        });
        await resetDocsUi(page);

        await test.step('Docs screenshots follow the app theme', async () => {
            await page.evaluate(async () => {
                window.themeSwitcher.setTheme('light');
                await window.openDocs('getting-started/workspace-tour');
            });

            const img = page.locator('#docs-article img').first();
            await expect(img).toHaveAttribute('src', /\/workspace\.png$/);

            await page.evaluate(() => {
                window.themeSwitcher.setTheme('dark');
            });
            await expect(img).toHaveAttribute('src', /\/workspace-dark\.png$/);

            await page.evaluate(() => {
                window.themeSwitcher.setTheme('light');
            });
            await expect(img).toHaveAttribute('src', /\/workspace\.png$/);
        });
        await resetDocsUi(page);

        await test.step('Docs show OS-specific modifiers, not Cmd/Ctrl or Alt/Option', async () => {
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
    });
});

test('Docs panel open state and width persist like other views', async ({
    page
}) => {
    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    await page.evaluate(async () => {
        await window.openDocs('getting-started/workspace-tour');
        const docsView = document.getElementById('view-docs');
        if (docsView) {
            docsView.style.flex = '0 0 420px';
        }
        window.resizableViews.saveLayout();
    });

    const saved = await page.evaluate(() => {
        const layout = JSON.parse(localStorage.getItem('viewLayout') || '{}');
        return {
            docsOpen: layout.docsOpen,
            docsWidth: layout.docsWidth,
            docsViewWidth: localStorage.getItem('docsViewWidth')
        };
    });
    expect(saved.docsOpen).toBe(true);
    expect(saved.docsWidth).toBe('0 0 420px');
    expect(saved.docsViewWidth).toBe('420');

    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    await expect(page.locator('#app-shell')).toHaveClass(/docs-open/);
    await expect(page.locator('#view-docs')).toBeVisible();
    const restoredFlex = await page.evaluate(
        () => document.getElementById('view-docs')?.style.flex
    );
    expect(restoredFlex).toBe('0 0 420px');

    await page.locator('#docs-close-btn').click();
    await expect(page.locator('#app-shell')).not.toHaveClass(/docs-open/);

    const closed = await page.evaluate(() => {
        const layout = JSON.parse(localStorage.getItem('viewLayout') || '{}');
        return {
            docsOpen: layout.docsOpen,
            docsWidth: layout.docsWidth
        };
    });
    expect(closed.docsOpen).toBe(false);
    expect(closed.docsWidth).toBe('0 0 420px');

    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    await expect(page.locator('#app-shell')).not.toHaveClass(/docs-open/);
    await page.evaluate(async () => {
        await window.openDocs();
    });
    const reopenedFlex = await page.evaluate(
        () => document.getElementById('view-docs')?.style.flex
    );
    expect(reopenedFlex).toBe('0 0 420px');
});
