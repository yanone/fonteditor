import { test, expect } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';

async function openYanoneFont(page: any) {
    await page.goto('/?test=true');
    await waitForCanvasReady(page);
    await page.keyboard.press('Meta+Shift+F');
    await page.waitForTimeout(200);
    await page.getByText('YanoneKaffeesatz.designspace').dblclick();
    await waitForFontLoaded(page);
    await waitForOpenSessionReady(page, 'YanoneKaffeesatz.designspace');
    await page.keyboard.press('Meta+Shift+E');
    await page.waitForTimeout(300);
}

async function prepareSelection(page: any) {
    return await page.evaluate(async () => {
        const glyphCanvas = window.glyphCanvas;
        if (!glyphCanvas) {
            throw new Error('glyphCanvas missing');
        }

        await new Promise<void>((resolve) => {
            window.addEventListener('editingFontCompiled', () => resolve(), {
                once: true
            });
            glyphCanvas.textRunEditor.setTextBuffer('an');
        });

        await glyphCanvas.textRunEditor.selectGlyphByIndex(0);
        await new Promise((resolve) => setTimeout(resolve, 300));

        const layerData =
            glyphCanvas.outlineEditor.getCurrentLayerDataFromStack();
        const contourIndex = layerData.shapes.findIndex(
            (shape: any) =>
                Array.isArray(shape?.nodes) || Array.isArray(shape?.Path?.nodes)
        );
        if (contourIndex < 0) {
            throw new Error('No selectable contour found');
        }

        const nodes =
            layerData.shapes[contourIndex].nodes ||
            layerData.shapes[contourIndex].Path?.nodes ||
            [];
        if (nodes.length < 3) {
            throw new Error('Not enough nodes for selection regression');
        }

        glyphCanvas.outlineEditor.selectedPoints = [
            { contourIndex, nodeIndex: 1 },
            { contourIndex, nodeIndex: 2 }
        ];
        glyphCanvas.outlineEditor.selectedAnchors =
            layerData.anchors?.length > 0 ? [0] : [];
        glyphCanvas.outlineEditor.selectedComponents = [];
        glyphCanvas.updatePropertyPanel();
        glyphCanvas.render();

        return {
            glyphName: glyphCanvas.getCurrentGlyphName(),
            selectedPoints: glyphCanvas.outlineEditor.selectedPoints,
            selectedAnchors: glyphCanvas.outlineEditor.selectedAnchors
        };
    });
}

async function getSelectionState(page: any) {
    return await page.evaluate(() => ({
        glyphName: window.glyphCanvas.getCurrentGlyphName(),
        selectedGlyphIndex: window.glyphCanvas.textRunEditor.selectedGlyphIndex,
        selectedLayerId: window.glyphCanvas.outlineEditor.selectedLayerId,
        selectedPoints: window.glyphCanvas.outlineEditor.selectedPoints,
        selectedAnchors: window.glyphCanvas.outlineEditor.selectedAnchors,
        selectedComponents: window.glyphCanvas.outlineEditor.selectedComponents
    }));
}

async function getGlyphScreenPoint(page: any, glyphIndex: number) {
    return await page.evaluate((index) => {
        const glyphCanvas = window.glyphCanvas;
        const shapedGlyph = glyphCanvas.textRunEditor.shapedGlyphs[index];
        const glyphPosition =
            glyphCanvas.textRunEditor._getGlyphPosition(index);
        const fontX =
            glyphPosition.xPosition +
            glyphPosition.xOffset +
            shapedGlyph.ax / 2;
        const fontY = glyphPosition.yOffset;
        const screenPoint = glyphCanvas.viewportManager.fontToScreenCoordinates(
            fontX,
            fontY
        );
        const rect = glyphCanvas.canvas.getBoundingClientRect();
        return {
            x: rect.left + screenPoint.x,
            y: rect.top + screenPoint.y
        };
    }, glyphIndex);
}

test.describe('Glyph selection restore in browser', () => {
    test('restores selection after keyboard glyph switching away and back', async ({
        page
    }) => {
        await openYanoneFont(page);
        const initialSelection = await prepareSelection(page);

        await page.keyboard.press('Meta+ArrowRight');
        await page.waitForTimeout(400);
        const switchedState = await getSelectionState(page);

        expect(switchedState.selectedGlyphIndex).toBe(1);
        expect(switchedState.selectedPoints).toEqual([]);

        await page.keyboard.press('Meta+ArrowLeft');
        await page.waitForTimeout(400);
        const restoredState = await getSelectionState(page);

        expect(restoredState.selectedGlyphIndex).toBe(0);
        expect(restoredState.glyphName).toBe(initialSelection.glyphName);
        expect(restoredState.selectedPoints).toEqual(
            initialSelection.selectedPoints
        );
        expect(restoredState.selectedAnchors).toEqual(
            initialSelection.selectedAnchors
        );
    });

    test('restores selection after double-click glyph switching away and back', async ({
        page
    }) => {
        await openYanoneFont(page);
        const initialSelection = await prepareSelection(page);

        const secondGlyphPoint = await getGlyphScreenPoint(page, 1);
        await page.mouse.dblclick(secondGlyphPoint.x, secondGlyphPoint.y);
        await page.waitForTimeout(400);
        const switchedState = await getSelectionState(page);

        expect(switchedState.selectedGlyphIndex).toBe(1);
        expect(switchedState.selectedPoints).toEqual([]);

        const firstGlyphPoint = await getGlyphScreenPoint(page, 0);
        await page.mouse.dblclick(firstGlyphPoint.x, firstGlyphPoint.y);
        await page.waitForTimeout(400);
        const restoredState = await getSelectionState(page);

        expect(restoredState.selectedGlyphIndex).toBe(0);
        expect(restoredState.glyphName).toBe(initialSelection.glyphName);
        expect(restoredState.selectedPoints).toEqual(
            initialSelection.selectedPoints
        );
        expect(restoredState.selectedAnchors).toEqual(
            initialSelection.selectedAnchors
        );
    });
});
