import { test as base, expect, type Page } from '@playwright/test';

/**
 * Instrument common Page APIs as named test.steps so the suite-wide
 * step-timing reporter can attribute sleeps, navigation, and waits.
 */
function instrumentPage(page: Page): Page {
    const originalGoto = page.goto.bind(page);
    page.goto = async (url, options) =>
        test.step(`goto ${String(url)}`, () => originalGoto(url, options));

    const originalReload = page.reload.bind(page);
    page.reload = async (options) =>
        test.step('reload', () => originalReload(options));

    const originalWaitForTimeout = page.waitForTimeout.bind(page);
    page.waitForTimeout = async (ms) =>
        test.step(`waitForTimeout ${ms}ms`, () => originalWaitForTimeout(ms));

    const originalWaitForFunction = page.waitForFunction.bind(page);
    page.waitForFunction = async (pageFunction, arg, options) =>
        test.step('waitForFunction', () =>
            originalWaitForFunction(pageFunction, arg, options));

    const originalWaitForLoadState = page.waitForLoadState.bind(page);
    page.waitForLoadState = async (state, options) =>
        test.step(`waitForLoadState ${state || 'load'}`, () =>
            originalWaitForLoadState(state, options));

    return page;
}

export const test = base.extend({
    page: async ({ page }, use) => {
        await use(instrumentPage(page));
    }
});

export { expect };
