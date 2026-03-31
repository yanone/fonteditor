import { expect, test, type Page } from '@playwright/test';
import { waitForCanvasReady } from './helpers/snapshot-helper';

type Side = 'left' | 'right';
type EditMode = 'handle' | 'point';

type EdgeSnapshot = {
    left: number;
    right: number;
    width: number;
    panX: number;
    scale: number;
};

function makeUnkeyedSidebearingTestFont(): string {
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

function makeKeyedSidebearingTestFont(): string {
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
                name: 'l',
                category: 'Base',
                codepoints: [108],
                layers: [
                    {
                        width: 260,
                        id: 'LBASE',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            {
                                nodes: '90 0 l 170 0 l 170 620 l 90 620 l',
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
                format_specific: {
                    metric_left: '=l-5',
                    metric_right: '=l-10'
                },
                layers: [
                    {
                        width: 340,
                        id: 'NKEY',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            {
                                nodes: '70 0 l 270 0 l 270 620 l 70 620 l',
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
        names: { family_name: { dflt: 'KeyedSidebearingAnchoringTest' } },
        features: { classes: {}, prefixes: {}, features: [] }
    });
}

async function loadTestFont(
    page: Page,
    fontJson: string,
    path: string,
    textBuffer: string
): Promise<void> {
    await page.evaluate(
        ({ json, fontPath, initialTextBuffer }) => {
            localStorage.setItem('glyphCanvasTextBuffer', initialTextBuffer);
            const plugin = (window as any).pluginRegistry.get('memory');
            window.dispatchEvent(
                new CustomEvent('fontLoaded', {
                    detail: {
                        path: fontPath,
                        babelfontJson: json,
                        sourcePlugin: plugin
                    }
                })
            );
        },
        {
            json: fontJson,
            fontPath: path,
            initialTextBuffer: textBuffer
        }
    );
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

async function openTestGlyphN(
    page: Page,
    options: {
        fontJson: string;
        path: string;
        textBuffer?: string;
        requireEditableHandles?: boolean;
    }
): Promise<void> {
    await page.goto('/?test=true');
    await waitForCanvasReady(page);
    await page.keyboard.press('Meta+Shift+E');

    await loadTestFont(
        page,
        options.fontJson,
        options.path,
        options.textBuffer || 'n'
    );
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

    if (options.requireEditableHandles !== false) {
        await page.waitForFunction(
            () => {
                const handles =
                    (
                        window as any
                    ).glyphCanvas?.outlineEditor?.getVisibleSidebearingHandles?.() ||
                    [];
                return (
                    handles.length === 2 &&
                    handles.every((handle: any) => handle?.editable)
                );
            },
            { timeout: 15000 }
        );
    }
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
        const width = Number(
            outlineEditor.getCurrentLayerDataFromStack().width
        );
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
            throw new Error(
                `No editable ${requestedSide} sidebearing handle visible`
            );
        }

        const glyphPosition = textRunEditor._getGlyphPosition(
            textRunEditor.selectedGlyphIndex
        );
        const worldX =
            glyphPosition.xPosition + glyphPosition.xOffset + handle.x;
        const worldY = glyphPosition.yOffset + handle.y;
        const screen = viewportManager.fontToScreenCoordinates(worldX, worldY);
        const rect = glyphCanvas.canvas.getBoundingClientRect();

        return {
            x: rect.left + screen.x,
            y: rect.top + screen.y
        };
    }, side);
}

async function getPointHandle(
    page: Page,
    side: Side
): Promise<{ x: number; y: number }> {
    return page.evaluate((requestedSide) => {
        const glyphCanvas = (window as any).glyphCanvas;
        const outlineEditor = glyphCanvas.outlineEditor;
        const textRunEditor = glyphCanvas.textRunEditor;
        const viewportManager = glyphCanvas.viewportManager;
        const layerData = outlineEditor.getCurrentLayerDataFromStack();
        const glyphPosition = textRunEditor._getGlyphPosition(
            textRunEditor.selectedGlyphIndex
        );

        let bestNode: any = null;
        for (const shape of layerData.shapes || []) {
            const nodes = shape.nodes || shape.Path?.nodes || [];
            for (const node of nodes) {
                if (!node || node.nodetype === 'OffCurve') {
                    continue;
                }
                if (!bestNode) {
                    bestNode = node;
                    continue;
                }
                if (requestedSide === 'left') {
                    if (
                        node.x < bestNode.x ||
                        (node.x === bestNode.x && node.y < bestNode.y)
                    ) {
                        bestNode = node;
                    }
                } else if (
                    node.x > bestNode.x ||
                    (node.x === bestNode.x && node.y < bestNode.y)
                ) {
                    bestNode = node;
                }
            }
        }

        if (!bestNode) {
            throw new Error(`No ${requestedSide} outline point found`);
        }

        const worldX =
            glyphPosition.xPosition + glyphPosition.xOffset + bestNode.x;
        const worldY = glyphPosition.yOffset + bestNode.y;
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
                Number(
                    glyphCanvas.outlineEditor.getCurrentLayerDataFromStack()
                        ?.width
                ) !== width
            );
        },
        { width: previousWidth },
        { timeout: 5000 }
    );

    await page.waitForTimeout(250);
}

async function dragKeyedOutlinePoint(
    page: Page,
    side: Side,
    deltaX: number,
    previousWidth: number
): Promise<void> {
    const point = await getPointHandle(page, side);

    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(50);
    await page.mouse.down();
    await page.mouse.move(point.x + deltaX, point.y, { steps: 8 });
    await page.mouse.up();

    await page.waitForFunction(
        ({ width }) => {
            const glyphCanvas = (window as any).glyphCanvas;
            return (
                !!glyphCanvas &&
                !glyphCanvas.outlineEditor.isDraggingPoint &&
                Number(
                    glyphCanvas.outlineEditor.getCurrentLayerDataFromStack()
                        ?.width
                ) !== width
            );
        },
        { width: previousWidth },
        { timeout: 5000 }
    );

    await page.waitForTimeout(250);
}

async function runAlternatingAnchoringSequence(
    page: Page,
    edits: Array<{ side: Side; deltaX: number }>,
    mode: EditMode
): Promise<void> {
    const snapshotsBeforeEdit: EdgeSnapshot[] = [];
    const snapshotsAfterEdit: EdgeSnapshot[] = [];

    for (const edit of edits) {
        const before = await getEdgeSnapshot(page);
        snapshotsBeforeEdit.push(before);

        if (mode === 'handle') {
            await dragSidebearingHandle(
                page,
                edit.side,
                edit.deltaX,
                before.width
            );
        } else {
            await dragKeyedOutlinePoint(
                page,
                edit.side,
                edit.deltaX,
                before.width
            );
        }

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
}

async function performUndoToWidth(
    page: Page,
    expectedWidth: number
): Promise<void> {
    await page.keyboard.press('Meta+z');
    await page.waitForFunction(
        ({ width }) => {
            const currentWidth = Number(
                (
                    window as any
                ).glyphCanvas?.outlineEditor?.getCurrentLayerDataFromStack?.()
                    ?.width
            );
            return (
                Number.isFinite(currentWidth) &&
                Math.abs(currentWidth - width) < 0.001
            );
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

    await openTestGlyphN(page, {
        fontJson: makeUnkeyedSidebearingTestFont(),
        path: '/test/SidebearingAnchoringTest.babelfont',
        requireEditableHandles: true
    });

    const edits: Array<{ side: Side; deltaX: number }> = [
        { side: 'left', deltaX: 24 },
        { side: 'right', deltaX: 20 },
        { side: 'left', deltaX: 18 },
        { side: 'right', deltaX: 26 }
    ];

    await runAlternatingAnchoringSequence(page, edits, 'handle');
});

test('alternating keyed outline drags keep the opposite edge anchored and undo cleanly restores each step', async ({
    page
}) => {
    test.setTimeout(180000);

    await openTestGlyphN(page, {
        fontJson: makeKeyedSidebearingTestFont(),
        path: '/test/KeyedSidebearingAnchoringTest.babelfont',
        requireEditableHandles: false
    });

    const edits: Array<{ side: Side; deltaX: number }> = [
        { side: 'left', deltaX: -24 },
        { side: 'right', deltaX: 20 },
        { side: 'left', deltaX: -18 },
        { side: 'right', deltaX: 26 }
    ];

    await runAlternatingAnchoringSequence(page, edits, 'point');
});
