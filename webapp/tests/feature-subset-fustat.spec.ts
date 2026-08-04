import { expect, test, type Page } from '@playwright/test';
import {
    focusView,
    waitForCanvasReady,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';

async function openFustatWithReportedSubset(page: Page): Promise<void> {
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

    await page.goto(
        '/?test=true&file=memory%3A%2F%2F%2Fuser%2FFustat.glyphs&text=A%252FqafDotless-ar%2520%25C3%2584&cursor=1&mode=edit&location=wght%3A400'
    );
    await waitForCanvasReady(page);
    await waitForOpenSessionReady(page, 'Fustat.glyphs');

    await page.waitForFunction(
        () => {
            const win = window as any;
            return (
                win.stateManager?.editor_text_buffer === 'A/qafDotless-ar Ä' &&
                win.stateManager?.editor_cursor_position === 1 &&
                win.stateManager?.editor_mode === 'edit' &&
                win.fontCompilation?.lastEditingSubsetKey?.includes(
                    'qafDotless-ar'
                ) === true
            );
        },
        { timeout: 30000 }
    );

    const cacheState = await page.evaluate(async () => {
        const dumpJson = await (
            window as any
        ).fontCompilation.dumpWorkerCacheState();
        return JSON.parse(dumpJson);
    });
    expect(cacheState.subset?.present).toBe(true);
    expect(cacheState.layoutClosure?.lastGlyphNames).toContain('qafDotless-ar');
}

test('Fustat ss03 line-six edit compiles in the cached subset compiler', async ({
    page
}) => {
    await openFustatWithReportedSubset(page);
    await focusView(page, 'Meta+Shift+I', 'view-fontinfo');

    await page.evaluate(() => {
        (window as any).fontInfoManager?.switchTab?.('features');
    });
    await page.waitForFunction(
        () => {
            const manager = (window as any).fontInfoManager;
            const featuresContent = document.getElementById(
                'fontinfo-features-content'
            );
            return (
                manager?.currentTab === 'features' &&
                featuresContent?.style.display !== 'none' &&
                !!featuresContent?.querySelector('.feature-list-item')
            );
        },
        { timeout: 10000 }
    );

    const ss03Index = await page.evaluate(() => {
        const manager = (window as any).fontInfoManager;
        const features = window.currentFontModel?.features?.features ?? [];
        const index = features.findIndex(
            ([tag]: [string, unknown]) => tag === 'ss03'
        );
        if (index < 0) {
            throw new Error('Fustat ss03 feature is missing');
        }

        manager?.selectItem?.('feature', index, true);
        return index;
    });

    await page.waitForFunction(
        (index) => {
            const manager = (window as any).fontInfoManager;
            return (
                manager?.selectedItem?.type === 'feature' &&
                manager.selectedItem.key === index &&
                typeof manager.featuresEditor?.getValue?.() === 'string' &&
                manager.featuresEditor.getValue().includes('sub a by a.ss03;')
            );
        },
        ss03Index,
        { timeout: 10000 }
    );

    await page.evaluate(() => {
        const manager = (window as any).fontInfoManager;
        const editor = manager?.featuresEditor;
        const originalCode = editor?.getValue?.();
        if (typeof originalCode !== 'string') {
            throw new Error('Fustat ss03 editor did not load');
        }

        const lines = originalCode.split('\n');
        const lineIndex = 5;
        if (!lines[lineIndex]?.trim()) {
            throw new Error('Fustat ss03 source line 6 is empty');
        }
        lines[lineIndex] = `#${lines[lineIndex]}`;
        const editedCode = lines.join('\n');

        editor.setValue(editedCode, -1);
        manager.commitFeatureCodeChanges();
    });

    await page.waitForFunction(
        () => {
            const feature = window.currentFontModel?.features?.features?.find(
                ([tag]: [string, unknown]) => tag === 'ss03'
            );
            return feature?.[1]?.code?.split('\n')[5]?.startsWith('#') === true;
        },
        { timeout: 10000 }
    );
    await page.waitForTimeout(1500);
    await expect(page.locator('#sidebar-error-display')).toBeHidden({
        timeout: 1000
    });
});
