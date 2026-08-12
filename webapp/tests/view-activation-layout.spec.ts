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

async function getActivationMinimumWidths(page: Page) {
    return await page.evaluate(() => {
        return window.VIEW_SETTINGS.activation.minimumWidths as {
            topRow: number;
            bottomRow: number;
        };
    });
}

async function getTopRowState(page: Page) {
    return await page.evaluate(() => {
        const visibleTopRow = Array.from(
            document.querySelectorAll('.top-row')
        ).find((row) => (row as HTMLElement).offsetWidth > 0) as
            HTMLElement | undefined;
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
                HTMLElement | undefined;

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

async function setTopRowViewWidths(page: Page, widths: Record<string, number>) {
    await page.evaluate((requestedWidths: Record<string, number>) => {
        for (const [viewId, width] of Object.entries(requestedWidths)) {
            const view = document.getElementById(viewId) as HTMLElement | null;
            if (!view) {
                continue;
            }

            view.style.flex = `0 0 ${width}px`;
            view.style.width = `${width}px`;
            view.style.minWidth = `${width}px`;
            view.style.maxWidth = `${width}px`;
        }

        window.dispatchEvent(new Event('resize'));
    }, widths);

    await page.waitForTimeout(350);
}

async function getResponsiveSidebarMetrics(page: Page) {
    return await page.evaluate(() => {
        const readPx = (value: string | null) =>
            Number.parseFloat(value || '0');
        const fontInfoView = document.getElementById('view-fontinfo');
        const overviewView = document.getElementById('view-overview');
        const editorView = document.getElementById('view-editor');
        const overviewSidebar = document.getElementById('overview-sidebar');
        const editorLeftSidebar = document.getElementById(
            'glyph-properties-sidebar'
        );
        const editorRightSidebar = document.getElementById(
            'glyph-editor-sidebar'
        );
        const overviewFilterItem = document.querySelector(
            '.glyph-filter-item'
        ) as HTMLElement | null;
        const overviewFilterNode = document.querySelector(
            '.glyph-filter-node'
        ) as HTMLElement | null;
        return {
            fontInfoSidebarWidthVar: readPx(
                fontInfoView
                    ? getComputedStyle(fontInfoView).getPropertyValue(
                          '--top-row-sidebar-width'
                      )
                    : '0'
            ),
            fontInfoSidebarPaddingVar: readPx(
                fontInfoView
                    ? getComputedStyle(fontInfoView).getPropertyValue(
                          '--top-row-sidebar-padding'
                      )
                    : '0'
            ),
            fontInfoSidebarGapVar: readPx(
                fontInfoView
                    ? getComputedStyle(fontInfoView).getPropertyValue(
                          '--top-row-sidebar-gap'
                      )
                    : '0'
            ),
            fontInfoFeatureItemPaddingVar: readPx(
                fontInfoView
                    ? getComputedStyle(fontInfoView).getPropertyValue(
                          '--top-row-sidebar-item-inline-padding'
                      )
                    : '0'
            ),
            fontInfoElementGapVar: readPx(
                fontInfoView
                    ? getComputedStyle(fontInfoView).getPropertyValue(
                          '--top-row-sidebar-element-gap'
                      )
                    : '0'
            ),
            overviewSidebarWidth: overviewSidebar
                ? readPx(getComputedStyle(overviewSidebar).width)
                : 0,
            overviewSidebarPaddingLeft: overviewSidebar
                ? readPx(getComputedStyle(overviewSidebar).paddingLeft)
                : 0,
            overviewFilterItemPaddingVar: readPx(
                overviewView
                    ? getComputedStyle(overviewView).getPropertyValue(
                          '--top-row-overview-filter-item-inline-padding'
                      )
                    : '0'
            ),
            editorSidebarWidthVar: readPx(
                editorView
                    ? getComputedStyle(editorView).getPropertyValue(
                          '--top-row-sidebar-width'
                      )
                    : '0'
            ),
            editorSidebarItemPaddingVar: readPx(
                editorView
                    ? getComputedStyle(editorView).getPropertyValue(
                          '--top-row-sidebar-item-inline-padding'
                      )
                    : '0'
            ),
            editorSidebarElementGapVar: readPx(
                editorView
                    ? getComputedStyle(editorView).getPropertyValue(
                          '--top-row-sidebar-element-gap'
                      )
                    : '0'
            ),
            editorLeftSidebarWidth: editorLeftSidebar
                ? readPx(getComputedStyle(editorLeftSidebar).width)
                : 0,
            editorRightSidebarWidth: editorRightSidebar
                ? readPx(getComputedStyle(editorRightSidebar).width)
                : 0,
            overviewFilterItemPaddingLeft: overviewFilterItem
                ? readPx(getComputedStyle(overviewFilterItem).paddingLeft)
                : 0,
            overviewFilterNodePaddingLeft: overviewFilterNode
                ? readPx(getComputedStyle(overviewFilterNode).paddingLeft)
                : 0
        };
    });
}

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
            HTMLElement | undefined;
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
            HTMLElement | undefined;
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
        window.glyphCanvas.freezeViewportForCollapse?.();
        window.glyphCanvas.render();
    });

    const beforeCollapseViewport = await getEditorViewportState(page);

    await dragVerticalDivider(page, 1, 2000);

    await page.waitForFunction(() => {
        const visibleTopRow = Array.from(
            document.querySelectorAll('.top-row')
        ).find((row) => (row as HTMLElement).offsetWidth > 0) as
            HTMLElement | undefined;
        const editorView = visibleTopRow?.querySelector('#view-editor');
        return !!editorView && editorView.classList.contains('collapsed-width');
    });

    await dragVerticalDivider(page, 1, -500);

    await page.waitForFunction(() => {
        const visibleTopRow = Array.from(
            document.querySelectorAll('.top-row')
        ).find((row) => (row as HTMLElement).offsetWidth > 0) as
            HTMLElement | undefined;
        const editorView = visibleTopRow?.querySelector('#view-editor');
        return (
            !!editorView && !editorView.classList.contains('collapsed-width')
        );
    });

    await page.waitForFunction(
        ({ scale, panX, panY }) => {
            const viewportManager = window.glyphCanvas?.viewportManager;
            if (!viewportManager) {
                return false;
            }

            const epsilon = 0.00001;
            return (
                Math.abs(viewportManager.scale - scale) <= epsilon &&
                Math.abs(viewportManager.panX - panX) <= epsilon &&
                Math.abs(viewportManager.panY - panY) <= epsilon
            );
        },
        beforeCollapseViewport,
        { timeout: 2000 }
    );

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

test('collapsed editor reopens to activation minimum by shortcut and title click', async ({
    page
}) => {
    await clearStoredViewLayout(page);

    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    const minimumWidths = await getActivationMinimumWidths(page);

    await page.evaluate(() => {
        window.collapseActiveView?.('view-editor');
    });
    await page.waitForTimeout(500);

    await activateView(page, 'E', 'view-editor');

    let topRowState = await getTopRowState(page);

    expect(topRowState.collapsed['view-editor']).toBe(false);
    expect(topRowState.widths['view-editor']).toBeGreaterThanOrEqual(
        minimumWidths.topRow - 4
    );
    expect(topRowState.widths['view-editor']).toBeLessThan(
        minimumWidths.topRow + 80
    );

    await page.evaluate(() => {
        window.collapseActiveView?.('view-editor');
    });
    await page.waitForTimeout(500);

    await page.click('#view-editor .view-title-name');
    await page.waitForTimeout(500);

    topRowState = await getTopRowState(page);

    expect(topRowState.collapsed['view-editor']).toBe(false);
    expect(topRowState.widths['view-editor']).toBeGreaterThanOrEqual(
        minimumWidths.topRow - 4
    );
    expect(topRowState.widths['view-editor']).toBeLessThan(
        minimumWidths.topRow + 80
    );
});

test('top-row views cycle small, larger, then max', async ({ page }) => {
    await clearStoredViewLayout(page);

    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    const minimumWidths = await getActivationMinimumWidths(page);
    const views = [
        { key: 'I', viewId: 'view-fontinfo' },
        { key: 'O', viewId: 'view-overview' },
        { key: 'E', viewId: 'view-editor' }
    ] as const;

    for (const { key, viewId } of views) {
        await page.evaluate((id) => {
            window.collapseActiveView?.(id);
        }, viewId);
        await page.waitForTimeout(500);

        await activateView(page, key, viewId);
        let topRowState = await getTopRowState(page);
        expect(topRowState.collapsed[viewId]).toBe(false);
        expect(topRowState.widths[viewId]).toBeGreaterThanOrEqual(
            minimumWidths.topRow - 4
        );
        expect(topRowState.widths[viewId]).toBeLessThan(
            minimumWidths.topRow + 80
        );

        await activateView(page, key, viewId);
        topRowState = await getTopRowState(page);
        expect(topRowState.widths[viewId]).toBeGreaterThanOrEqual(
            topRowState.topRowWidth * 0.45
        );

        await activateView(page, key, viewId);
        topRowState = await getTopRowState(page);
        const otherViewIds = views
            .map((view) => view.viewId)
            .filter((id) => id !== viewId);
        if (viewId === 'view-fontinfo') {
            expect(topRowState.widths[viewId]).toBeGreaterThanOrEqual(
                topRowState.topRowWidth * 0.45
            );
            expect(topRowState.widths[viewId]).toBeLessThanOrEqual(
                topRowState.topRowWidth * 0.55 + 4
            );
            for (const otherViewId of otherViewIds) {
                expect(topRowState.collapsed[otherViewId]).toBe(false);
                expect(topRowState.widths[otherViewId]).toBeGreaterThan(30);
            }
        } else {
            for (const otherViewId of otherViewIds) {
                expect(topRowState.widths[otherViewId]).toBeLessThanOrEqual(30);
            }
            expect(topRowState.widths[viewId]).toBeGreaterThan(
                topRowState.topRowWidth * 0.85
            );
        }
    }
});

test('collapsed fontinfo and overview reopen to activation minimum by shortcut and title click', async ({
    page
}) => {
    await clearStoredViewLayout(page);

    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    const minimumWidths = await getActivationMinimumWidths(page);

    await page.evaluate(() => {
        window.collapseActiveView?.('view-fontinfo');
    });
    await page.waitForTimeout(500);

    await activateView(page, 'I', 'view-fontinfo');

    let topRowState = await getTopRowState(page);
    expect(topRowState.collapsed['view-fontinfo']).toBe(false);
    expect(topRowState.widths['view-fontinfo']).toBeGreaterThanOrEqual(
        minimumWidths.topRow - 4
    );

    await page.evaluate(() => {
        window.collapseActiveView?.('view-fontinfo');
    });
    await page.waitForTimeout(500);

    await page.click('#view-fontinfo .view-title-name');
    await page.waitForTimeout(500);

    topRowState = await getTopRowState(page);
    expect(topRowState.collapsed['view-fontinfo']).toBe(false);
    expect(topRowState.widths['view-fontinfo']).toBeGreaterThanOrEqual(
        minimumWidths.topRow - 4
    );

    await page.evaluate(() => {
        window.collapseActiveView?.('view-overview');
    });
    await page.waitForTimeout(500);

    await activateView(page, 'O', 'view-overview');

    topRowState = await getTopRowState(page);
    expect(topRowState.collapsed['view-overview']).toBe(false);
    expect(topRowState.widths['view-overview']).toBeGreaterThanOrEqual(
        minimumWidths.topRow - 4
    );

    await page.evaluate(() => {
        window.collapseActiveView?.('view-overview');
    });
    await page.waitForTimeout(500);

    await page.click('#view-overview .view-title-name');
    await page.waitForTimeout(500);

    topRowState = await getTopRowState(page);
    expect(topRowState.collapsed['view-overview']).toBe(false);
    expect(topRowState.widths['view-overview']).toBeGreaterThanOrEqual(
        minimumWidths.topRow - 4
    );
});

test('activating collapsed fontinfo or overview keeps the other open', async ({
    page
}) => {
    await clearStoredViewLayout(page);

    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    await page.evaluate(() => {
        window.collapseActiveView?.('view-fontinfo');
    });
    await page.waitForTimeout(500);

    await activateView(page, 'O', 'view-overview');
    await page.click('#view-fontinfo .view-title-name');
    await page.waitForTimeout(500);

    let topRowState = await getTopRowState(page);
    expect(topRowState.collapsed['view-fontinfo']).toBe(false);
    expect(topRowState.collapsed['view-overview']).toBe(false);

    await page.evaluate(() => {
        window.collapseActiveView?.('view-overview');
    });
    await page.waitForTimeout(500);

    await activateView(page, 'I', 'view-fontinfo');
    await activateView(page, 'O', 'view-overview');

    topRowState = await getTopRowState(page);
    expect(topRowState.collapsed['view-fontinfo']).toBe(false);
    expect(topRowState.collapsed['view-overview']).toBe(false);
});

test('top-row sidebars interpolate width and padding per view width', async ({
    page
}) => {
    await clearStoredViewLayout(page);

    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    await setTopRowViewWidths(page, {
        'view-fontinfo': 600,
        'view-overview': 600,
        'view-editor': 600
    });

    const compactMetrics = await getResponsiveSidebarMetrics(page);
    expect(compactMetrics.fontInfoSidebarWidthVar).toBeCloseTo(100, 0);
    expect(compactMetrics.fontInfoSidebarPaddingVar).toBeCloseTo(6, 0);
    expect(compactMetrics.fontInfoSidebarGapVar).toBeCloseTo(4, 0);
    expect(compactMetrics.overviewSidebarWidth).toBeCloseTo(100, 0);
    expect(compactMetrics.overviewSidebarPaddingLeft).toBeCloseTo(6, 0);
    expect(compactMetrics.overviewFilterItemPaddingVar).toBeCloseTo(3, 0);
    expect(compactMetrics.overviewFilterNodePaddingLeft).toBeCloseTo(0, 0);
    expect(compactMetrics.overviewFilterItemPaddingLeft).toBeCloseTo(6, 0);
    expect(compactMetrics.editorSidebarWidthVar).toBeCloseTo(100, 0);
    expect(compactMetrics.editorSidebarItemPaddingVar).toBeCloseTo(6, 0);
    expect(compactMetrics.editorSidebarElementGapVar).toBeCloseTo(3, 0);
    expect(compactMetrics.editorLeftSidebarWidth).toBeCloseTo(100, 0);
    expect(compactMetrics.editorRightSidebarWidth).toBeCloseTo(100, 0);
    expect(compactMetrics.fontInfoFeatureItemPaddingVar).toBeCloseTo(6, 0);
    expect(compactMetrics.fontInfoElementGapVar).toBeCloseTo(3, 0);

    await setTopRowViewWidths(page, {
        'view-fontinfo': 1200,
        'view-overview': 1200,
        'view-editor': 1200
    });

    const expandedMetrics = await getResponsiveSidebarMetrics(page);
    expect(expandedMetrics.fontInfoSidebarWidthVar).toBeCloseTo(200, 0);
    expect(expandedMetrics.fontInfoSidebarPaddingVar).toBeCloseTo(12, 0);
    expect(expandedMetrics.fontInfoSidebarGapVar).toBeCloseTo(12, 0);
    expect(expandedMetrics.overviewSidebarWidth).toBeCloseTo(200, 0);
    expect(expandedMetrics.overviewSidebarPaddingLeft).toBeCloseTo(12, 0);
    expect(expandedMetrics.overviewFilterItemPaddingVar).toBeCloseTo(6, 0);
    expect(expandedMetrics.overviewFilterNodePaddingLeft).toBeCloseTo(0, 0);
    expect(expandedMetrics.overviewFilterItemPaddingLeft).toBeCloseTo(12, 0);
    expect(expandedMetrics.editorSidebarWidthVar).toBeCloseTo(200, 0);
    expect(expandedMetrics.editorSidebarItemPaddingVar).toBeCloseTo(12, 0);
    expect(expandedMetrics.editorSidebarElementGapVar).toBeCloseTo(8, 0);
    expect(expandedMetrics.editorLeftSidebarWidth).toBeCloseTo(200, 0);
    expect(expandedMetrics.editorRightSidebarWidth).toBeCloseTo(200, 0);
    expect(expandedMetrics.fontInfoFeatureItemPaddingVar).toBeCloseTo(12, 0);
    expect(expandedMetrics.fontInfoElementGapVar).toBeCloseTo(8, 0);
});

/**
 * Get the bounding rect of the root .container and the current window dimensions.
 */
async function getContainerBounds(page: Page) {
    return await page.evaluate(() => {
        const container = document.querySelector(
            '.container'
        ) as HTMLElement | null;
        if (!container) {
            return {
                containerWidth: 0,
                containerHeight: 0,
                windowWidth: 0,
                windowHeight: 0
            };
        }
        const rect = container.getBoundingClientRect();
        return {
            containerWidth: Math.round(rect.width),
            containerHeight: Math.round(rect.height),
            windowWidth: window.innerWidth,
            windowHeight: window.innerHeight
        };
    });
}

/**
 * Get the width of the editor view and its canvas container.
 */
async function getEditorContentBounds(page: Page) {
    return await page.evaluate(() => {
        const editorView = document.getElementById('view-editor');
        const canvasContainer = document.getElementById(
            'glyph-canvas-container'
        );
        return {
            editorWidth: editorView
                ? Math.round(editorView.getBoundingClientRect().width)
                : 0,
            canvasWidth: canvasContainer
                ? Math.round(canvasContainer.getBoundingClientRect().width)
                : 0,
            topRowWidth: (() => {
                const topRow = document.querySelector(
                    '.top-row'
                ) as HTMLElement | null;
                return topRow
                    ? Math.round(topRow.getBoundingClientRect().width)
                    : 0;
            })()
        };
    });
}

test('container and top-row match viewport width on startup with no saved layout', async ({
    page
}) => {
    await clearStoredViewLayout(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    // Let layout settle
    await page.waitForTimeout(350);

    const bounds = await getContainerBounds(page);
    const topRowState = await getTopRowState(page);
    const editorBounds = await getEditorContentBounds(page);

    // Container width must match viewport width (2px tolerance for rounding)
    expect(
        Math.abs(bounds.containerWidth - bounds.windowWidth)
    ).toBeLessThanOrEqual(2);
    // Container height must be viewport height minus 50px chrome
    expect(
        Math.abs(bounds.containerHeight - (bounds.windowHeight - 50))
    ).toBeLessThanOrEqual(2);
    // Top-row occupied width (views + dividers) must fill the top-row width
    expect(
        Math.abs(topRowState.occupiedWidth - topRowState.topRowWidth)
    ).toBeLessThanOrEqual(4);
    // Editor view and canvas must have positive widths
    expect(editorBounds.editorWidth).toBeGreaterThan(100);
    expect(editorBounds.canvasWidth).toBeGreaterThan(100);
});

test('container and views resize when viewport changes', async ({ page }) => {
    await clearStoredViewLayout(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/?test=true');
    await waitForCanvasReady(page);
    await page.waitForTimeout(350);

    const startBounds = await getContainerBounds(page);
    expect(Math.abs(startBounds.containerWidth - 1280)).toBeLessThanOrEqual(2);

    // Shrink the viewport
    await page.setViewportSize({ width: 960, height: 600 });
    await page.waitForTimeout(400);

    const shrunkBounds = await getContainerBounds(page);
    const shrunkTopRowState = await getTopRowState(page);
    expect(Math.abs(shrunkBounds.containerWidth - 960)).toBeLessThanOrEqual(2);
    expect(
        Math.abs(shrunkBounds.containerHeight - (600 - 50))
    ).toBeLessThanOrEqual(2);
    expect(
        Math.abs(
            shrunkTopRowState.occupiedWidth - shrunkTopRowState.topRowWidth
        )
    ).toBeLessThanOrEqual(4);

    // Expand the viewport
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(400);

    const expandedBounds = await getContainerBounds(page);
    const expandedTopRowState = await getTopRowState(page);
    expect(Math.abs(expandedBounds.containerWidth - 1920)).toBeLessThanOrEqual(
        2
    );
    expect(
        Math.abs(expandedBounds.containerHeight - (1080 - 50))
    ).toBeLessThanOrEqual(2);
    expect(
        Math.abs(
            expandedTopRowState.occupiedWidth - expandedTopRowState.topRowWidth
        )
    ).toBeLessThanOrEqual(4);
});
