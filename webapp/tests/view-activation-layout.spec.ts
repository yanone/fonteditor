import { expect, test, type Page } from '@playwright/test';
import { waitForCanvasReady } from './helpers/snapshot-helper';

async function activateView(page: Page, shortcutKey: string) {
    await page.keyboard.press(`Meta+Shift+${shortcutKey}`);
    await page.waitForTimeout(450);
}

async function getViewWidths(page: Page, viewIds: string[]) {
    return await page.evaluate((ids: string[]) => {
        return ids.reduce<Record<string, number>>((widths, id) => {
            const view = document.getElementById(id);
            widths[id] = view
                ? Math.round(view.getBoundingClientRect().width)
                : 0;
            return widths;
        }, {});
    }, viewIds);
}

async function getActivationMinimumWidths(page: Page) {
    return await page.evaluate(() => {
        return window.VIEW_SETTINGS.activation.minimumWidths;
    });
}

test('activation width uses previous row focus order and persists it', async ({
    page
}) => {
    await page.addInitScript(() => {
        if (sessionStorage.getItem('layout-test-cleared') === 'true') {
            return;
        }

        localStorage.removeItem('viewLayout');
        localStorage.removeItem('last_active_view');
        sessionStorage.setItem('layout-test-cleared', 'true');
    });

    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    const minimumWidths = await getActivationMinimumWidths(page);

    await activateView(page, 'E');
    const topBeforeFontInfo = await getViewWidths(page, [
        'view-fontinfo',
        'view-overview',
        'view-editor'
    ]);

    await activateView(page, 'I');
    const topAfterFontInfo = await getViewWidths(page, [
        'view-fontinfo',
        'view-overview',
        'view-editor'
    ]);

    if (topBeforeFontInfo['view-fontinfo'] < minimumWidths.topRow) {
        expect(topAfterFontInfo['view-fontinfo']).toBeGreaterThan(
            topBeforeFontInfo['view-fontinfo']
        );
    } else {
        expect(topAfterFontInfo['view-fontinfo']).toBe(
            topBeforeFontInfo['view-fontinfo']
        );
    }
    expect(
        Math.abs(
            topAfterFontInfo['view-overview'] -
                topBeforeFontInfo['view-overview']
        )
    ).toBeLessThanOrEqual(4);
    expect(topAfterFontInfo['view-editor']).toBeLessThan(
        topBeforeFontInfo['view-editor']
    );

    await activateView(page, 'O');
    const topAfterOverview = await getViewWidths(page, [
        'view-fontinfo',
        'view-overview',
        'view-editor'
    ]);

    if (topAfterFontInfo['view-overview'] < minimumWidths.topRow) {
        expect(topAfterOverview['view-overview']).toBeGreaterThan(
            topAfterFontInfo['view-overview']
        );
    } else {
        expect(topAfterOverview['view-overview']).toBe(
            topAfterFontInfo['view-overview']
        );
    }
    expect(
        Math.abs(
            topAfterOverview['view-editor'] - topAfterFontInfo['view-editor']
        )
    ).toBeLessThanOrEqual(4);
    if (topAfterFontInfo['view-overview'] < minimumWidths.topRow) {
        expect(topAfterOverview['view-fontinfo']).toBeLessThan(
            topAfterFontInfo['view-fontinfo']
        );
    } else {
        expect(topAfterOverview['view-fontinfo']).toBe(
            topAfterFontInfo['view-fontinfo']
        );
    }

    await activateView(page, 'K');
    const bottomBeforeFiles = await getViewWidths(page, [
        'view-files',
        'view-assistant',
        'view-scripts',
        'view-console'
    ]);

    await activateView(page, 'F');
    const bottomAfterFiles = await getViewWidths(page, [
        'view-files',
        'view-assistant',
        'view-scripts',
        'view-console'
    ]);

    if (bottomBeforeFiles['view-files'] < minimumWidths.bottomRow) {
        expect(bottomAfterFiles['view-files']).toBeGreaterThan(
            bottomBeforeFiles['view-files']
        );
    } else {
        expect(bottomAfterFiles['view-files']).toBe(
            bottomBeforeFiles['view-files']
        );
    }
    expect(
        Math.abs(
            bottomAfterFiles['view-assistant'] -
                bottomBeforeFiles['view-assistant']
        )
    ).toBeLessThanOrEqual(4);
    expect(
        Math.abs(
            bottomAfterFiles['view-scripts'] - bottomBeforeFiles['view-scripts']
        )
    ).toBeLessThanOrEqual(4);
    if (bottomBeforeFiles['view-files'] < minimumWidths.bottomRow) {
        expect(bottomAfterFiles['view-console']).toBeLessThan(
            bottomBeforeFiles['view-console']
        );
    } else {
        expect(bottomAfterFiles['view-console']).toBe(
            bottomBeforeFiles['view-console']
        );
    }

    const persistedState = await page.evaluate(() => {
        const savedLayout = localStorage.getItem('viewLayout');
        return {
            visitOrder: window.getViewVisitOrder(),
            savedVisitOrder: savedLayout
                ? JSON.parse(savedLayout).visitOrder
                : null
        };
    });

    expect(persistedState.visitOrder.top.at(-1)).toBe('view-overview');
    expect(persistedState.visitOrder.bottom.at(-1)).toBe('view-files');
    expect(persistedState.savedVisitOrder).toEqual(persistedState.visitOrder);

    await page.reload();
    await waitForCanvasReady(page);

    const restoredVisitOrder = await page.evaluate(() => {
        return window.getViewVisitOrder();
    });

    expect(restoredVisitOrder).toEqual(persistedState.visitOrder);
});
