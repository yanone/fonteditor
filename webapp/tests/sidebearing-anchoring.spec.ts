import { expect, test, type Page } from '@playwright/test';
import { waitForCanvasReady } from './helpers/snapshot-helper';

type Side = 'left' | 'right';

type EdgeSnapshot = {
    left: number;
    right: number;
    width: number;
    panX: number;
    scale: number;
};

function makeSidebearingTestFont(): string {
    return JSON.stringify({
        upm: 1000,
        version: [1, 0],
        axes: [],
        masters: [
            {
                name: { dflt: 'Regular' },
                id: 'M0',
                location: {},
                guides: [],
                metrics: {},
                kerning: {},
                custom_ot_values: {},
                format_specific: {}
            }
        ],
        instances: [],
        glyphs: [
            {
                name: '.notdef',
                category: 'Base',
                layers: [
                    {
                        width: 600,
                        id: 'N0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            {
                                nodes: '0 0 l 600 0 l 600 700 l 0 700 l',
                                closed: true
                            }
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                exported: true
            },
            {
                name: 'n',
                category: 'Base',
                codepoints: [110],
                layers: [
                    {
                        width: 600,
                        id: 'L0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            {
                                nodes: '120 0 l 420 0 l 420 620 l 120 620 l',
                                closed: true
                            }
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                exported: true
            }
        ],
        date: new Date().toISOString(),
        names: { family_name: { dflt: 'SidebearingAnchoringTest' } },
        features: { classes: {}, prefixes: {}, features: [] }
    });
}

async function loadTestFont(page: Page): Promise<void> {
    const fontJson = makeSidebearingTestFont();
    await page.evaluate((json) => {
        localStorage.setItem('glyphCanvasTextBuffer', 'n');
        const plugin = (window as any).pluginRegistry.get('memory');
        window.dispatchEvent(
            new CustomEvent('fontLoaded', {
                detail: {
                    path: '/test/SidebearingAnchoringTest.babelfont',
                    babelfontJson: json,
                    sourcePlugin: plugin
                }
            })
        );
    }, fontJson);
}

async function waitForBridgeReady(page: Page): Promise<void> {
    await page.waitForFunction(
        () =>
            !!(window as any).changeBridge &&
            !!(window as any).currentFontModel,
        { timeout: 15000 }
    );
    await page.waitForTimeout(300);
}

async function waitForSyntheticFontReady(page: Page): Promise<void> {
    await page.waitForFunction(
        () => {
            const currentFont = (window as any).fontManager?.currentFont;
            const currentFontModel = (window as any).currentFontModel;
            const textRunEditor = (window as any).glyphCanvas?.textRunEditor;

            return (
                !!currentFont &&
                !!currentFontModel &&
                textRunEditor?.glyphNameBuffer?.length === 1
            );
        },
        { timeout: 15000 }
    );
    await page.waitForTimeout(300);
}

async function waitForEditingFontCompiled(page: Page): Promise<void> {
    await page.waitForFunction(
        () => !!(window as any).fontManager?.editingFont,
        { timeout: 30000 }
    );
    await page.waitForTimeout(300);
}

async function openTestGlyphN(page: Page): Promise<void> {
    await page.goto('/?test=true');
    await waitForCanvasReady(page);
    await page.keyboard.press('Meta+Shift+E');

    await loadTestFont(page);
    await waitForSyntheticFontReady(page);
    await waitForBridgeReady(page);
    await waitForEditingFontCompiled(page);

    await page.evaluate(async () => {
        const glyphCanvas = (window as any).glyphCanvas;
        glyphCanvas.textRunEditor.setTextBuffer('n');
        await glyphCanvas.textRunEditor.selectGlyphByIndex(0, true);

        const outlineEditor = glyphCanvas.outlineEditor;
        if (
            !outlineEditor.selectedLayerId ||
            !outlineEditor.getCurrentLayerModel?.()
        ) {
            const firstLayer = glyphCanvas.getSortedLayers?.()?.[0] || null;
            if (firstLayer) {
                await outlineEditor.selectLayer(firstLayer);
            }
        }

        glyphCanvas.render();
    });

    await page.waitForTimeout(400);
    await page.keyboard.press('Meta+0');
    await page.waitForTimeout(500);

    await page.waitForFunction(
        () => {
            const handles =
                (window as any).glyphCanvas?.outlineEditor?.getVisibleSidebearingHandles?.() ||
                [];
            return (
                handles.length === 2 &&
                handles.every((handle: any) => handle?.editable)
            );
        },
        { timeout: 15000 }
    );
}

async function getEdgeSnapshot(page: Page): Promise<EdgeSnapshot> {
    return page.evaluate(() => {
        const glyphCanvas = (window as any).glyphCanvas;
        const viewportManager = glyphCanvas.viewportManager;
        const textRunEditor = glyphCanvas.textRunEditor;
        const outlineEditor = glyphCanvas.outlineEditor;
        const glyphPosition = textRunEditor._getGlyphPosition(
            textRunEditor.selectedGlyphIndex
        );
        const width = Number(outlineEditor.getCurrentLayerDataFromStack().width);
        const leftWorldX = glyphPosition.xPosition + glyphPosition.xOffset;
        const rightWorldX = leftWorldX + width;
        const rect = glyphCanvas.canvas.getBoundingClientRect();

        return {
            left:
                rect.left +
                viewportManager.fontToScreenCoordinates(
                    leftWorldX,
                    glyphPosition.yOffset
                ).x,
            right:
                rect.left +
                viewportManager.fontToScreenCoordinates(
                    rightWorldX,
                    glyphPosition.yOffset
                ).x,
            width,
            panX: viewportManager.panX,
            scale: viewportManager.scale
        };
    });
}

async function getHandlePoint(
    page: Page,
    side: Side
): Promise<{ x: number; y: number }> {
    return page.evaluate((requestedSide) => {
        const glyphCanvas = (window as any).glyphCanvas;
        const outlineEditor = glyphCanvas.outlineEditor;
        const textRunEditor = glyphCanvas.textRunEditor;
        const viewportManager = glyphCanvas.viewportManager;
        const handle = outlineEditor
            .getVisibleSidebearingHandles()
            .find(
                (candidate: any) =>
                    candidate?.side === requestedSide && candidate?.editable
            );

        if (!handle) {
            throw new Error(`No editable ${requestedSide} sidebearing handle visible`);
        }

        const glyphPosition = textRunEditor._getGlyphPosition(
            textRunEditor.selectedGlyphIndex
        );
        const worldX = glyphPosition.xPosition + glyphPosition.xOffset + handle.x;
        const worldY = glyphPosition.yOffset + handle.y;
        const screen = viewportManager.fontToScreenCoordinates(worldX, worldY);
        const rect = glyphCanvas.canvas.getBoundingClientRect();

        return {
            x: rect.left + screen.x,
            y: rect.top + screen.y
        };
    }, side);
}

async function dragSidebearingHandle(
    page: Page,
    side: Side,
    deltaX: number,
    previousWidth: number
): Promise<void> {
    const handlePoint = await getHandlePoint(page, side);

    await page.mouse.move(handlePoint.x, handlePoint.y);
    await page.waitForTimeout(50);
    await page.mouse.down();
    await page.mouse.move(handlePoint.x + deltaX, handlePoint.y, {
        steps: 8
    });
    await page.mouse.up();

    await page.waitForFunction(
        ({ width }) => {
            const glyphCanvas = (window as any).glyphCanvas;
            return (
                !!glyphCanvas &&
                !glyphCanvas.outlineEditor.isDraggingSidebearing &&
                Number(glyphCanvas.outlineEditor.getCurrentLayerDataFromStack()?.width) !==
                    width
            );
        },
        { width: previousWidth },
        { timeout: 5000 }
    );

    await page.waitForTimeout(250);
}

async function performUndoToWidth(
    page: Page,
    expectedWidth: number
): Promise<void> {
    await page.keyboard.press('Meta+z');
    await page.waitForFunction(
        ({ width }) => {
            const currentWidth = Number(
                (window as any).glyphCanvas?.outlineEditor
                    ?.getCurrentLayerDataFromStack?.()?.width
            );
            return Number.isFinite(currentWidth) && Math.abs(currentWidth - width) < 0.001;
        },
        { width: expectedWidth },
        { timeout: 5000 }
    );
    await page.waitForTimeout(300);
}

function expectAnchoredOppositeEdge(
    before: EdgeSnapshot,
    after: EdgeSnapshot,
    editedSide: Side
): void {
    const anchoredDelta =
        editedSide === 'left'
            ? Math.abs(after.right - before.right)
            : Math.abs(after.left - before.left);

    expect(anchoredDelta).toBeLessThan(1.5);
}

function expectSnapshotRestored(
    expected: EdgeSnapshot,
    actual: EdgeSnapshot
): void {
    expect(Math.abs(actual.left - expected.left)).toBeLessThan(1.5);
    expect(Math.abs(actual.right - expected.right)).toBeLessThan(1.5);
    expect(actual.width).toBeCloseTo(expected.width, 4);
}

test('alternating sidebearing drags keep the opposite edge anchored and undo cleanly restores each step', async ({
    page
}) => {
    test.setTimeout(180000);

    await openTestGlyphN(page);

    const edits: Array<{ side: Side; deltaX: number }> = [
        { side: 'left', deltaX: 24 },
        { side: 'right', deltaX: 20 },
        { side: 'left', deltaX: 18 },
        { side: 'right', deltaX: 26 }
    ];
    const snapshotsBeforeEdit: EdgeSnapshot[] = [];
    const snapshotsAfterEdit: EdgeSnapshot[] = [];

    for (const edit of edits) {
        const before = await getEdgeSnapshot(page);
        snapshotsBeforeEdit.push(before);

        await dragSidebearingHandle(page, edit.side, edit.deltaX, before.width);

        const after = await getEdgeSnapshot(page);
        snapshotsAfterEdit.push(after);

        expectAnchoredOppositeEdge(before, after, edit.side);
        expect(Math.abs(after.width - before.width)).toBeGreaterThan(0.001);
    }

    for (let index = edits.length - 1; index >= 0; index -= 1) {
        const edit = edits[index];
        const beforeUndo = await getEdgeSnapshot(page);
        const expectedRestored = snapshotsBeforeEdit[index];

        expectSnapshotRestored(snapshotsAfterEdit[index], beforeUndo);

        await performUndoToWidth(page, expectedRestored.width);

        const afterUndo = await getEdgeSnapshot(page);
        expectAnchoredOppositeEdge(beforeUndo, afterUndo, edit.side);
        expectSnapshotRestored(expectedRestored, afterUndo);
    }

    const finalSnapshot = await getEdgeSnapshot(page);
    expectSnapshotRestored(snapshotsBeforeEdit[0], finalSnapshot);
});