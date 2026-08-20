import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
    focusView,
    openFileFromFilesView,
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';

async function openYanoneFont(page: Page) {
    await page.goto('/?test=true');
    await waitForCanvasReady(page);
    await openFileFromFilesView(page, 'YanoneKaffeesatz.designspace');
    await waitForFontLoaded(page);
    await waitForOpenSessionReady(page, 'YanoneKaffeesatz.designspace');
    await focusView(page, 'Meta+Shift+E', 'view-editor');
    await page.waitForFunction(
        () => Number(window.fontManager?.editingFont?.length || 0) > 0,
        undefined,
        { timeout: 60000 }
    );
}

async function prepareAnchorSelection(
    page: Page,
    textBuffer: string,
    glyphIndex: number,
    anchorName: string
) {
    await page.evaluate((nextText) => {
        const glyphCanvas = window.glyphCanvas;
        const textRunEditor = glyphCanvas?.textRunEditor;
        if (!glyphCanvas || !textRunEditor) {
            throw new Error('glyphCanvas missing');
        }

        textRunEditor.setTextBuffer(nextText);
        if (window.fontManager) {
            window.fontManager.currentText = nextText;
            window.fontManager.updateEditingSubsetSnapshot?.([
                'a',
                'adieresis',
                'dieresiscomb'
            ]);
        }
        textRunEditor.shapeText?.(true);
    }, textBuffer);

    await page.waitForFunction(
        ({ expectedText, expectedIndex }) => {
            const textRunEditor = window.glyphCanvas?.textRunEditor;
            return (
                Number(window.fontManager?.editingFont?.length || 0) > 0 &&
                textRunEditor?.textBuffer === expectedText &&
                Array.isArray(textRunEditor?.shapedGlyphs) &&
                textRunEditor.shapedGlyphs.length > expectedIndex
            );
        },
        { expectedText: textBuffer, expectedIndex: glyphIndex },
        { timeout: 30000 }
    );

    await page.evaluate(async (index) => {
        const glyphCanvas = window.glyphCanvas;
        if (!glyphCanvas) {
            throw new Error('glyphCanvas missing');
        }
        await glyphCanvas.textRunEditor.selectGlyphByIndex(index, true);
        await glyphCanvas.enterGlyphEditModeAtCursor?.();
        await glyphCanvas.doUIUpdateAsync?.();
    }, glyphIndex);

    await page.waitForFunction(
        ({ expectedIndex, expectedAnchor }) => {
            const glyphCanvas = window.glyphCanvas;
            const outlineEditor = glyphCanvas?.outlineEditor;
            const layer = outlineEditor?.getCurrentLayerDataFromStack?.();
            return (
                !!outlineEditor?.active &&
                glyphCanvas?.getCurrentGlyphName?.() === 'a' &&
                glyphCanvas?.textRunEditor?.selectedGlyphIndex ===
                    expectedIndex &&
                Array.isArray(layer?.anchors) &&
                layer.anchors.some(
                    (anchor: { name?: string }) =>
                        anchor?.name === expectedAnchor
                )
            );
        },
        { expectedIndex: glyphIndex, expectedAnchor: anchorName },
        { timeout: 20000 }
    );

    return await page.evaluate((expectedAnchor) => {
        const glyphCanvas = window.glyphCanvas;
        if (!glyphCanvas) {
            throw new Error('glyphCanvas missing');
        }

        const layerData =
            glyphCanvas.outlineEditor.getCurrentLayerDataFromStack();
        const anchorIndex = (layerData?.anchors || []).findIndex(
            (anchor: { name?: string }) => anchor?.name === expectedAnchor
        );
        if (anchorIndex < 0) {
            throw new Error(`Anchor ${expectedAnchor} not found`);
        }

        glyphCanvas.outlineEditor.selectedPoints = [];
        glyphCanvas.outlineEditor.selectedAnchors = [anchorIndex];
        glyphCanvas.outlineEditor.selectedComponents = [];
        glyphCanvas.updatePropertyPanel();
        glyphCanvas.render();

        return {
            glyphName: glyphCanvas.getCurrentGlyphName(),
            selectedAnchors: glyphCanvas.outlineEditor.selectedAnchors,
            selectedAnchorNames: [expectedAnchor]
        };
    }, anchorName);
}

async function getSelectionState(page: Page) {
    return await page.evaluate(() => {
        const glyphCanvas = window.glyphCanvas;
        const currentLayerData =
            glyphCanvas.outlineEditor.getCurrentLayerDataFromStack();
        const selectedAnchors = glyphCanvas.outlineEditor.selectedAnchors;

        return {
            glyphName: glyphCanvas.getCurrentGlyphName(),
            leafGlyphName:
                glyphCanvas.outlineEditor.parseGlyphStack().at(-1)?.glyphName ||
                glyphCanvas.outlineEditor.currentGlyphName ||
                glyphCanvas.getCurrentGlyphName(),
            glyphStack: glyphCanvas.outlineEditor.glyphStack,
            selectedGlyphIndex: glyphCanvas.textRunEditor.selectedGlyphIndex,
            selectedLayerId: glyphCanvas.outlineEditor.selectedLayerId,
            selectedPoints: glyphCanvas.outlineEditor.selectedPoints,
            selectedAnchors,
            selectedAnchorNames: selectedAnchors
                .map(
                    (index: number) =>
                        currentLayerData?.anchors?.[index]?.name || null
                )
                .filter((name: string | null): name is string => !!name),
            selectedComponents: glyphCanvas.outlineEditor.selectedComponents
        };
    });
}

test.describe('Glyph selection restore in browser', () => {
    test('restores anchor selection by name after entering a nested component', async ({
        page
    }) => {
        await openYanoneFont(page);
        const initialSelection = await prepareAnchorSelection(
            page,
            'aä',
            0,
            'top'
        );

        await expect
            .poll(
                async () => {
                    return await page.evaluate(() => {
                        const glyphCanvas = window.glyphCanvas;
                        const textRunEditor = glyphCanvas?.textRunEditor;
                        if (!glyphCanvas || !textRunEditor) {
                            return false;
                        }
                        if (
                            (textRunEditor.glyphNameBuffer || []).includes(
                                'adieresis'
                            )
                        ) {
                            return true;
                        }
                        if (
                            !textRunEditor.shapedGlyphs ||
                            textRunEditor.shapedGlyphs.length < 2
                        ) {
                            return false;
                        }
                        const previousIndex = textRunEditor.selectedGlyphIndex;
                        textRunEditor.selectedGlyphIndex = 1;
                        const name = glyphCanvas.getCurrentGlyphName();
                        textRunEditor.selectedGlyphIndex = previousIndex;
                        return name === 'adieresis';
                    });
                },
                { timeout: 60000, intervals: [250, 500, 1000] }
            )
            .toBe(true);

        const switched = await page.evaluate(async () => {
            const glyphCanvas = window.glyphCanvas;
            const textRunEditor = glyphCanvas?.textRunEditor;
            if (!glyphCanvas || !textRunEditor) {
                throw new Error('glyphCanvas missing');
            }

            const previousIndex = textRunEditor.selectedGlyphIndex;
            const names = (textRunEditor.glyphNameBuffer || []).map(
                (name: string, index: number) => {
                    return (
                        textRunEditor.shapedGlyphs[index]?.explicitGlyphName ||
                        name ||
                        ''
                    );
                }
            );

            const adieresisIndex = names.indexOf('adieresis');
            if (adieresisIndex < 0 || adieresisIndex === previousIndex) {
                return {
                    ok: false as const,
                    names,
                    previousIndex,
                    adieresisIndex
                };
            }

            await textRunEditor.selectGlyphByIndex(adieresisIndex, true);
            glyphCanvas.outlineEditor.currentGlyphName = 'adieresis';
            glyphCanvas.outlineEditor.layerData = null;
            glyphCanvas.outlineEditor.glyphStack = '';
            await glyphCanvas.doUIUpdateAsync?.();
            await glyphCanvas.outlineEditor.autoSelectMatchingLayer?.();
            return {
                ok: true as const,
                names,
                previousIndex,
                adieresisIndex,
                currentName: glyphCanvas.getCurrentGlyphName(),
                outlineName: glyphCanvas.outlineEditor.currentGlyphName
            };
        });
        expect(switched, JSON.stringify(switched)).toMatchObject({ ok: true });

        await page.waitForFunction(
            () => {
                const glyphCanvas = window.glyphCanvas;
                const outlineEditor = glyphCanvas?.outlineEditor;
                const layer = outlineEditor?.getCurrentLayerDataFromStack?.();
                const refs = (layer?.shapes || []).map(
                    (shape: { reference?: string }) => shape?.reference || null
                );
                return (
                    glyphCanvas?.getCurrentGlyphName?.() === 'adieresis' &&
                    outlineEditor?.currentGlyphName === 'adieresis' &&
                    refs.includes('a')
                );
            },
            undefined,
            { timeout: 30000 }
        );

        const componentIndex = await page.evaluate(() => {
            const layerData =
                window.glyphCanvas.outlineEditor.getCurrentLayerDataFromStack();
            return (layerData?.shapes || []).findIndex(
                (shape: { reference?: string }) => shape?.reference === 'a'
            );
        });
        expect(componentIndex).toBeGreaterThanOrEqual(0);

        await page.evaluate(async (index) => {
            await window.glyphCanvas.outlineEditor.enterComponentEditing(index);
        }, componentIndex);

        await page.waitForFunction(
            () => {
                const glyphCanvas = window.glyphCanvas;
                const outlineEditor = glyphCanvas?.outlineEditor;
                const layer = outlineEditor?.getCurrentLayerDataFromStack?.();
                const leaf =
                    outlineEditor?.parseGlyphStack?.().at(-1)?.glyphName ||
                    outlineEditor?.currentGlyphName;
                const selectedNames = (
                    outlineEditor?.selectedAnchors || []
                ).map((index: number) => layer?.anchors?.[index]?.name || null);
                return (
                    glyphCanvas?.getCurrentGlyphName?.() === 'adieresis' &&
                    leaf === 'a' &&
                    selectedNames.includes('top')
                );
            },
            undefined,
            { timeout: 15000 }
        );

        const restoredState = await getSelectionState(page);

        expect(restoredState.glyphName).toBe('adieresis');
        expect(restoredState.leafGlyphName).toBe('a');
        expect(restoredState.selectedAnchorNames).toEqual(
            initialSelection.selectedAnchorNames
        );
    });
});
