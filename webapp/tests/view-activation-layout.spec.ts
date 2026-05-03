import { expect, test, type Page } from '@playwright/test';
import { focusView, waitForCanvasReady } from './helpers/snapshot-helper';

async function clearStoredViewLayout(page: Page) {
    const layoutClearToken = `layout-test-clear-${Date.now()}-${Math.random()}`;

    await page.addInitScript((token: string) => {
        if (sessionStorage.getItem('layout-test-clear-token') === token) {
            return;
        }

        localStorage.removeItem('viewLayout');
        localStorage.removeItem('last_active_view');
        sessionStorage.setItem('layout-test-clear-token', token);
    }, layoutClearToken);
}

async function activateView(page: Page, shortcutKey: string, viewId: string) {
    await focusView(page, `Meta+Shift+${shortcutKey}`, viewId);
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

async function getTopRowState(page: Page) {
    return await page.evaluate(() => {
        const visibleTopRow = Array.from(
            document.querySelectorAll('.top-row')
        ).find((row) => (row as HTMLElement).offsetWidth > 0) as
            | HTMLElement
            | undefined;
        const viewIds = ['view-fontinfo', 'view-overview', 'view-editor'];
        const widths = viewIds.reduce<Record<string, number>>(
            (result, viewId) => {
                const view = visibleTopRow?.querySelector(
                    `#${viewId}`
                ) as HTMLElement | null;
                result[viewId] = view
                    ? Math.round(view.getBoundingClientRect().width)
                    : 0;
                return result;
            },
            {}
        );
        const collapsed = viewIds.reduce<Record<string, boolean>>(
            (result, viewId) => {
                const view = visibleTopRow?.querySelector(
                    `#${viewId}`
                ) as HTMLElement | null;
                result[viewId] = !!view?.classList.contains('collapsed-width');
                return result;
            },
            {}
        );
        const collapseButtonVisible = viewIds.reduce<Record<string, boolean>>(
            (result, viewId) => {
                const button = visibleTopRow?.querySelector(
                    `#${viewId} .view-title-collapse-btn`
                ) as HTMLElement | null;
                result[viewId] =
                    !!button && getComputedStyle(button).display !== 'none';
                return result;
            },
            {}
        );
        const dividerWidth = Array.from(
            visibleTopRow?.querySelectorAll('.vertical-divider') || []
        ).reduce((sum, divider) => {
            return (
                sum +
                Math.round(
                    (divider as HTMLElement).getBoundingClientRect().width
                )
            );
        }, 0);

        return {
            widths,
            collapsed,
            collapseButtonVisible,
            expandedCount: viewIds.filter((viewId) => !collapsed[viewId])
                .length,
            topRowWidth: visibleTopRow
                ? Math.round(visibleTopRow.getBoundingClientRect().width)
                : 0,
            occupiedWidth:
                dividerWidth +
                viewIds.reduce((sum, viewId) => sum + widths[viewId], 0)
        };
    });
}

async function getEditorViewportState(page: Page) {
    return await page.evaluate(() => {
        const viewportManager = window.glyphCanvas?.viewportManager;
        return viewportManager
            ? {
                  scale: viewportManager.scale,
                  panX: viewportManager.panX,
                  panY: viewportManager.panY
              }
            : null;
    });
}

async function dragVerticalDivider(
    page: Page,
    dividerIndex: number,
    deltaX: number
) {
    await page.evaluate(
        ({ targetDividerIndex, targetDeltaX }) => {
            const visibleTopRow = Array.from(
                document.querySelectorAll('.top-row')
            ).find((row) => (row as HTMLElement).offsetWidth > 0) as
                | HTMLElement
                | undefined;

            if (!visibleTopRow) {
                throw new Error('Visible top row not found');
            }

            const divider = visibleTopRow.querySelectorAll('.vertical-divider')[
                targetDividerIndex
            ] as HTMLElement | undefined;

            if (!divider) {
                throw new Error(
                    `Top-row divider ${targetDividerIndex} not found`
                );
            }

            const rect = divider.getBoundingClientRect();
            const startX = rect.left + rect.width / 2;
            const startY = rect.top + rect.height / 2;

            divider.dispatchEvent(
                new MouseEvent('mousedown', {
                    bubbles: true,
                    cancelable: true,
                    clientX: startX,
                    clientY: startY
                })
            );

            document.dispatchEvent(
                new MouseEvent('mousemove', {
                    bubbles: true,
                    cancelable: true,
                    clientX: startX + targetDeltaX,
                    clientY: startY
                })
            );

            document.dispatchEvent(
                new MouseEvent('mouseup', {
                    bubbles: true,
                    cancelable: true,
                    clientX: startX + targetDeltaX,
                    clientY: startY
                })
            );
        },
        { targetDividerIndex: dividerIndex, targetDeltaX: deltaX }
    );
}

test('activation width uses previous row focus order and persists it', async ({
    page
}) => {
    await clearStoredViewLayout(page);

    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    const minimumWidths = await getActivationMinimumWidths(page);

    await activateView(page, 'E', 'view-editor');
    const topBeforeFontInfo = await getViewWidths(page, [
        'view-fontinfo',
        'view-overview',
        'view-editor'
    ]);

    await activateView(page, 'I', 'view-fontinfo');
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

    await activateView(page, 'O', 'view-overview');
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

    await activateView(page, 'K', 'view-console');
    const bottomBeforeFiles = await getViewWidths(page, [
        'view-files',
        'view-assistant',
        'view-scripts',
        'view-console'
    ]);

    await activateView(page, 'F', 'view-files');
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

test('editor collapses to the top-row width minimum when dragged closed', async ({
    page
}) => {
    await clearStoredViewLayout(page);

    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    await dragVerticalDivider(page, 1, 2000);

    await page.waitForFunction(() => {
        const visibleTopRow = Array.from(
            document.querySelectorAll('.top-row')
        ).find((row) => (row as HTMLElement).offsetWidth > 0) as
            | HTMLElement
            | undefined;
        const editorView = visibleTopRow?.querySelector('#view-editor');
        return !!editorView && editorView.getBoundingClientRect().width <= 30;
    });

    const topRowState = await getTopRowState(page);

    expect(topRowState.collapsed['view-editor']).toBe(true);
    expect(topRowState.widths['view-editor']).toBeLessThanOrEqual(30);
    expect(
        Math.abs(topRowState.occupiedWidth - topRowState.topRowWidth)
    ).toBeLessThanOrEqual(4);

    await dragVerticalDivider(page, 1, -500);

    await page.waitForFunction(() => {
        const visibleTopRow = Array.from(
            document.querySelectorAll('.top-row')
        ).find((row) => (row as HTMLElement).offsetWidth > 0) as
            | HTMLElement
            | undefined;
        const editorView = visibleTopRow?.querySelector('#view-editor');
        return !!editorView && editorView.getBoundingClientRect().width > 60;
    });

    const expandedTopRowState = await getTopRowState(page);

    expect(expandedTopRowState.collapsed['view-editor']).toBe(false);
    expect(expandedTopRowState.widths['view-editor']).toBeGreaterThan(60);
    expect(
        Math.abs(
            expandedTopRowState.occupiedWidth - expandedTopRowState.topRowWidth
        )
    ).toBeLessThanOrEqual(4);
});

test('editor title-bar X collapses the editor and hides the last remaining top-row X', async ({
    page
}) => {
    await clearStoredViewLayout(page);

    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    const editorCollapseButton = page.locator(
        '#view-editor .view-title-collapse-btn'
    );
    await expect(editorCollapseButton).toBeVisible();

    await editorCollapseButton.evaluate((button: HTMLButtonElement) => {
        button.click();
    });

    await page.waitForFunction(() => {
        const editorView = document.getElementById('view-editor');
        const overviewButton = document.querySelector(
            '#view-overview .view-title-collapse-btn'
        ) as HTMLElement | null;
        return (
            !!editorView &&
            editorView.classList.contains('collapsed-width') &&
            !!overviewButton &&
            getComputedStyle(overviewButton).display === 'none'
        );
    });

    const topRowState = await getTopRowState(page);

    expect(topRowState.collapsed['view-editor']).toBe(true);
    expect(topRowState.expandedCount).toBe(1);
    expect(topRowState.collapseButtonVisible['view-editor']).toBe(false);
    expect(topRowState.collapseButtonVisible['view-overview']).toBe(false);
    expect(
        Math.abs(topRowState.occupiedWidth - topRowState.topRowWidth)
    ).toBeLessThanOrEqual(4);
});

test('cmd+escape collapses the focused editor view', async ({ page }) => {
    await clearStoredViewLayout(page);

    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    await activateView(page, 'E', 'view-editor');
    await page.keyboard.press('Meta+Escape');

    await page.waitForFunction(() => {
        const visibleTopRow = Array.from(
            document.querySelectorAll('.top-row')
        ).find((row) => (row as HTMLElement).offsetWidth > 0) as
            | HTMLElement
            | undefined;
        const editorView = visibleTopRow?.querySelector('#view-editor');
        return !!editorView && editorView.classList.contains('collapsed-width');
    });

    const topRowState = await getTopRowState(page);

    expect(topRowState.collapsed['view-editor']).toBe(true);
    expect(topRowState.widths['view-editor']).toBeLessThanOrEqual(30);
});

test('editor collapse and reopen restores the previous canvas viewport', async ({
    page
}) => {
    await clearStoredViewLayout(page);

    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    await page.evaluate(() => {
        if (!window.glyphCanvas?.viewportManager) {
            return;
        }

        window.glyphCanvas.viewportManager.scale = 1.75;
        window.glyphCanvas.viewportManager.panX = 321;
        window.glyphCanvas.viewportManager.panY = 654;
        window.glyphCanvas.render();
    });

    const beforeCollapseViewport = await getEditorViewportState(page);

    await dragVerticalDivider(page, 1, 2000);

    await page.waitForFunction(() => {
        const visibleTopRow = Array.from(
            document.querySelectorAll('.top-row')
        ).find((row) => (row as HTMLElement).offsetWidth > 0) as
            | HTMLElement
            | undefined;
        const editorView = visibleTopRow?.querySelector('#view-editor');
        return !!editorView && editorView.classList.contains('collapsed-width');
    });

    await dragVerticalDivider(page, 1, -500);

    await page.waitForFunction(() => {
        const visibleTopRow = Array.from(
            document.querySelectorAll('.top-row')
        ).find((row) => (row as HTMLElement).offsetWidth > 0) as
            | HTMLElement
            | undefined;
        const editorView = visibleTopRow?.querySelector('#view-editor');
        return !!editorView && !editorView.classList.contains('collapsed-width');
    });

    const afterExpandViewport = await getEditorViewportState(page);

    expect(afterExpandViewport).not.toBeNull();
    expect(afterExpandViewport!.scale).toBeCloseTo(
        beforeCollapseViewport!.scale,
        5
    );
    expect(afterExpandViewport!.panX).toBeCloseTo(
        beforeCollapseViewport!.panX,
        5
    );
    expect(afterExpandViewport!.panY).toBeCloseTo(
        beforeCollapseViewport!.panY,
        5
    );
});

test('collapsed editor reopens to peer width by shortcut and title click', async ({
    page
}) => {
    await clearStoredViewLayout(page);

    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    await page.evaluate(() => {
        window.collapseActiveView?.('view-editor');
    });
    await page.waitForTimeout(500);

    await activateView(page, 'E', 'view-editor');

    let topRowState = await getTopRowState(page);

    expect(topRowState.collapsed['view-editor']).toBe(false);
    expect(topRowState.widths['view-editor']).toBeGreaterThan(100);
    expect(
        Math.abs(
            topRowState.widths['view-editor'] - topRowState.widths['view-overview']
        )
    ).toBeLessThanOrEqual(4);

    await page.evaluate(() => {
        window.collapseActiveView?.('view-editor');
    });
    await page.waitForTimeout(500);

    await page.click('#view-editor .view-title-name');
    await page.waitForTimeout(500);

    topRowState = await getTopRowState(page);

    expect(topRowState.collapsed['view-editor']).toBe(false);
    expect(topRowState.widths['view-editor']).toBeGreaterThan(100);
    expect(
        Math.abs(
            topRowState.widths['view-editor'] - topRowState.widths['view-overview']
        )
    ).toBeLessThanOrEqual(4);
});
