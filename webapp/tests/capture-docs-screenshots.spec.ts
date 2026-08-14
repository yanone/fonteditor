import { mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import { test, type Locator, type Page } from '@playwright/test';
import { focusView, waitForCanvasReady } from './helpers/snapshot-helper';

const capture = !!process.env.CAPTURE_DOCS_SCREENSHOTS;
const docsRoot = resolve(__dirname, '../../documentation');

async function writeShot(
    page: Page,
    relativePath: string,
    locator?: Locator
): Promise<void> {
    const outputPath = resolve(docsRoot, relativePath);
    await mkdir(dirname(outputPath), { recursive: true });
    if (locator) {
        await locator.screenshot({ path: outputPath });
        return;
    }
    await page.screenshot({ path: outputPath });
}

test('capture handbook screenshots', async ({ page }) => {
    test.skip(
        !capture,
        'Set CAPTURE_DOCS_SCREENSHOTS=1 to write handbook images'
    );

    await page.goto('/?test=true');
    await waitForCanvasReady(page);
    await page.mouse.move(-100, -100);
    await page.waitForTimeout(300);

    await writeShot(page, 'getting-started/images/workspace.png');

    await focusView(page, 'Meta+Shift+E', 'view-editor');
    await writeShot(
        page,
        'editor/images/glyph-canvas.png',
        page.locator('#view-editor')
    );
    await writeShot(
        page,
        'editor/images/axes.png',
        page.locator('#view-editor')
    );

    await page.evaluate(async () => {
        const glyphCanvas = window.glyphCanvas;
        const textRun = glyphCanvas?.textRunEditor;
        if (!String(textRun?.textBuffer ?? '').length) {
            textRun?.setTextBuffer?.(' ');
            if (window.fontManager) {
                window.fontManager.currentText = ' ';
            }
        }
        await glyphCanvas?.enterGlyphEditModeAtCursor?.();
    });
    await page.waitForFunction(() => {
        const glyphCanvas = window.glyphCanvas;
        const pen = document.getElementById(
            'editor-tool-pen'
        ) as HTMLButtonElement | null;
        return !!glyphCanvas?.outlineEditor?.active && !!pen && !pen.disabled;
    });
    await writeShot(
        page,
        'editor/images/edit-tools.png',
        page.locator('#editor-edit-tools')
    );
    await page.keyboard.press('Escape');

    await focusView(page, 'Meta+Shift+O', 'view-overview');
    await writeShot(
        page,
        'overview/images/overview.png',
        page.locator('#view-overview')
    );

    await focusView(page, 'Meta+Shift+A', 'view-assistant');
    await writeShot(
        page,
        'ai/images/assistant.png',
        page.locator('#view-assistant')
    );

    await focusView(page, 'Meta+Shift+Y', 'view-scripts');
    await focusView(page, 'Meta+Shift+K', 'view-console');
    await writeShot(
        page,
        'python/images/python-views.png',
        page.locator('.bottom-row')
    );

    const fontDisplay = page.locator('.font-display-container');
    await mkdir(resolve(docsRoot, 'files/images'), { recursive: true });
    await fontDisplay.screenshot({
        path: resolve(docsRoot, 'files/images/save.png')
    });

    await page.keyboard.press('Meta+O');
    const fileDialog = page.locator('#font-file-dialog');
    await fileDialog.waitFor({ state: 'visible' });
    await writeShot(page, 'files/images/files-view.png', fileDialog);
});
