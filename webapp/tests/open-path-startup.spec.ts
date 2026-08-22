import { test, expect } from './fixtures';
import {
    waitForCanvasReady,
    waitForOpenSessionReady,
    waitForOverviewTilesRendered
} from './helpers/snapshot-helper';

test('opening Fustat compiles once and paints overview tiles', async ({
    page
}) => {
    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    await page.evaluate(async () => {
        await (window as any).showFontFileDialog?.({ mode: 'open' });
    });

    const fileDialog = page.locator('#font-file-dialog');
    await fileDialog.waitFor({ state: 'visible' });
    await fileDialog
        .locator('.file-item[data-name="Fustat.glyphs"]')
        .dblclick();

    await waitForOpenSessionReady(page, 'Fustat.glyphs');
    await waitForOverviewTilesRendered(page);

    const snapshot = await page.evaluate(() => {
        const textRun = (window as any).glyphCanvas?.textRunEditor;
        return {
            editingFontBytes: Number(
                (window as any).fontManager?.editingFont?.length || 0
            ),
            shapedCount: Array.isArray(textRun?.shapedGlyphs)
                ? textRun.shapedGlyphs.length
                : Array.isArray(textRun?.glyphNameBuffer)
                  ? textRun.glyphNameBuffer.length
                  : 0,
            tileCount: document.querySelectorAll(
                '#glyph-overview-container .glyph-tile'
            ).length
        };
    });

    expect(snapshot.editingFontBytes).toBeGreaterThan(0);
    expect(snapshot.shapedCount).toBeGreaterThan(0);
    expect(snapshot.tileCount).toBeGreaterThan(0);
});
