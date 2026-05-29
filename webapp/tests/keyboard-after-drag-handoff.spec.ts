import { test, expect } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady,
    focusView
} from './helpers/snapshot-helper';

/**
 * Keyboard-After-Drag Stale Editing Font Handoff
 *
 * Regression test for the bug described in
 * strategy/KEYBOARD_AFTER_DRAG_STALE_EDITING_FONT_HANDOFF_2026-05-23.md:
 * keyboard outline edits after a mouse-drag can compile against stale state.
 *
 * The test exercises the exact user scenario on glyph "a" while "adieresis"
 * sits next to it as an inactive glyph.  Edits to "a" must propagate through
 * to "adieresis" (which composites "a") — if the keyboard-after-drag compile
 * is stale, adieresis will show wrong outlines.
 *
 * Selects a single node via mouse click, nudges it, drags sidebearing, undoes,
 * re-selects the same node, nudges back.
 *
 *   1. Open Fustat with text "aä", cursor=0 so "a" is the active glyph
 *   2. Capture canvas screenshot 1 (baseline)
 *   3. Click a bottom-most on-curve node to select it
 *   4. Move down 50u via Shift+ArrowDown (keyboard path)
 *   5. Capture screenshot 2
 *   6. Drag left sidebearing handle left 50u via mouse (mouse-drag path)
 *   7. Capture screenshot 3
 *   8. Undo (Cmd+Z) — should revert sidebearing drag
 *   9. Capture screenshot 4 & assert canvas equals screenshot 2
 *      (EXPECTED TO FAIL — stale compile after drag → keyboard)
 *  10. Re-click the same node, move up 50u via Shift+ArrowUp
 *  11. Capture screenshot 5 & assert canvas equals screenshot 1
 *      (EXPECTED TO FAIL — stale compile after drag → keyboard)
 *
 * Canvas equality is checked via base64 data URL so we detect visual
 * regressions without relying on golden snapshot files.
 */
async function captureCanvas(page: any): Promise<string> {
    return page.evaluate(() => {
        const canvas = (window as any).glyphCanvas?.canvas as HTMLCanvasElement;
        if (!canvas) return '';
        return canvas.toDataURL('image/png');
    });
}

async function getCanvasDiffRatio(
    page: any,
    previousDataUrl: string,
    currentDataUrl: string
): Promise<number> {
    return page.evaluate(
        async ({ previousDataUrl, currentDataUrl }) => {
            const loadImage = (src: string) =>
                new Promise<HTMLImageElement>((resolve, reject) => {
                    const image = new Image();
                    image.onload = () => resolve(image);
                    image.onerror = () =>
                        reject(new Error('Failed to load canvas snapshot'));
                    image.src = src;
                });

            const [previousImage, currentImage] = await Promise.all([
                loadImage(previousDataUrl),
                loadImage(currentDataUrl)
            ]);

            const width = Math.max(previousImage.width, currentImage.width);
            const height = Math.max(previousImage.height, currentImage.height);
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) {
                throw new Error('Failed to create canvas diff context');
            }

            ctx.clearRect(0, 0, width, height);
            ctx.drawImage(previousImage, 0, 0);
            const previousPixels = ctx.getImageData(0, 0, width, height).data;

            ctx.clearRect(0, 0, width, height);
            ctx.drawImage(currentImage, 0, 0);
            const currentPixels = ctx.getImageData(0, 0, width, height).data;

            let diffPixels = 0;
            for (let index = 0; index < previousPixels.length; index += 4) {
                if (
                    previousPixels[index] !== currentPixels[index] ||
                    previousPixels[index + 1] !== currentPixels[index + 1] ||
                    previousPixels[index + 2] !== currentPixels[index + 2] ||
                    previousPixels[index + 3] !== currentPixels[index + 3]
                ) {
                    diffPixels += 1;
                }
            }

            return diffPixels / (width * height);
        },
        { previousDataUrl, currentDataUrl }
    );
}

/** Force a render and wait for the GPU pipeline to settle. */
async function stabiliseCanvas(page: any): Promise<void> {
    await page.evaluate(() => {
        const gc = (window as any).glyphCanvas;
        if (gc?.render) gc.render();
    });
    for (let i = 0; i < 3; i++) {
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
    }
    await page.waitForTimeout(50);
}

/** Wait for the next editingFontCompiled event, with safety timeout. */
async function waitForCompileSettle(page: any, label: string): Promise<void> {
    console.log(`[Test] Waiting for compile settle: ${label}`);
    await page.evaluate(() => {
        return new Promise<void>((resolve) => {
            let finished = false;
            let sawCompile = false;
            let idleTimer: number | null = null;
            let fallbackTimer: number | null = null;

            const cleanup = () => {
                window.removeEventListener('editingFontCompiled', onCompile);
                if (idleTimer !== null) {
                    window.clearTimeout(idleTimer);
                    idleTimer = null;
                }
                if (fallbackTimer !== null) {
                    window.clearTimeout(fallbackTimer);
                    fallbackTimer = null;
                }
            };

            const finish = () => {
                if (finished) return;
                finished = true;
                cleanup();
                resolve();
            };

            const armIdleTimer = () => {
                if (idleTimer !== null) {
                    window.clearTimeout(idleTimer);
                }
                idleTimer = window.setTimeout(() => {
                    if (sawCompile) {
                        finish();
                    }
                }, 700);
            };

            const onCompile = () => {
                sawCompile = true;
                armIdleTimer();
            };

            window.addEventListener('editingFontCompiled', onCompile);
            fallbackTimer = window.setTimeout(finish, 15000);
        });
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
}

/** Find screen coordinates of the bottom-most on-curve node. */
async function getNodeScreenCoords(
    page: any
): Promise<{ x: number; y: number }> {
    return page.evaluate(() => {
        const gc = (window as any).glyphCanvas;
        const oe = gc.outlineEditor;
        const tre = gc.textRunEditor;
        const vm = gc.viewportManager;

        const layerData = oe.getCurrentLayerDataFromStack();
        const gp = tre._getGlyphPosition(tre.selectedGlyphIndex);

        // Pick the bottom-most on-curve node (lowest y) — avoids
        // the top area which may have anchors nearby.
        let bestNode: any = null;
        for (const shape of layerData.shapes || []) {
            const nodes = shape.nodes || shape.Path?.nodes || [];
            for (const node of nodes) {
                if (!node || node.nodetype === 'OffCurve') continue;
                if (!bestNode || node.y < bestNode.y) bestNode = node;
            }
        }
        if (!bestNode) throw new Error('No on-curve node found');

        const wx = gp.xPosition + gp.xOffset + bestNode.x;
        const wy = gp.yOffset + bestNode.y;
        const sc = vm.fontToScreenCoordinates(wx, wy);
        const rect = gc.canvas.getBoundingClientRect();
        return { x: rect.left + sc.x, y: rect.top + sc.y };
    });
}

test.describe('Keyboard-after-drag stale editing handoff', () => {
    test('keyboard node move after mouse sidebearing drag on glyph a with adieresis', async ({
        page
    }) => {
        test.setTimeout(300000);

        // ── 1. Navigate to base page ──────────────────────────────────────
        console.log('[Test] Navigating to app');
        await page.goto('/?test=true');

        await waitForCanvasReady(page);
        await page.waitForTimeout(200);

        console.log('[Test] Opening font file dialog');
        await page.evaluate(async () => {
            await (window as any).showFontFileDialog?.({ mode: 'open' });
        });
        await page.locator('#font-file-dialog').waitFor({ state: 'visible' });

        console.log('[Test] Loading Fustat.glyphs');
        await page.getByText('Fustat.glyphs').dblclick();
        await page.waitForTimeout(200);

        await waitForFontLoaded(page);
        await waitForOpenSessionReady(page, 'Fustat.glyphs');

        console.log('[Test] Focusing editor view');
        await focusView(page, 'Meta+Shift+E', 'view-editor');
        await page.waitForTimeout(200);

        // ── 2. Set text buffer to "aä" with cursor at 0 ───────────────────
        console.log('[Test] Setting text buffer to aä');
        await page.evaluate(() => {
            return new Promise<void>((resolve) => {
                const gc = (window as any).glyphCanvas;
                const tre = gc?.textRunEditor;
                if (!gc || !tre) {
                    resolve();
                    return;
                }

                if (gc.outlineEditor?.active) gc.exitGlyphEditMode();

                let done = false;
                const finish = () => {
                    if (done) return;
                    done = true;
                    resolve();
                };
                window.addEventListener('editingFontCompiled', finish, {
                    once: true
                });

                tre.setTextBuffer('aä');
                tre.cursorPosition = 0;
                setTimeout(finish, 5000);
            });
        });
        await page.waitForTimeout(300);

        console.log('[Test] Selecting glyph at index 0 (a)');
        await page.evaluate(async () => {
            const tre = (window as any).glyphCanvas?.textRunEditor;
            if (!tre) return;
            await tre.selectGlyphByIndex(0);
        });

        await page.waitForFunction(
            () => {
                const gc = (window as any).glyphCanvas;
                return (
                    !!gc?.outlineEditor?.active &&
                    (gc?.textRunEditor?.selectedGlyphIndex ?? -1) === 0
                );
            },
            { timeout: 10000 }
        );
        await page.waitForTimeout(200);

        // Avoid hover effects
        await page.mouse.move(-100, -100);
        await page.waitForTimeout(100);

        // Frame the glyph
        console.log('[Test] Framing glyph with Cmd+0');
        await page.keyboard.press('Meta+0');
        await page.waitForTimeout(600);

        // Zoom out
        console.log('[Test] Zooming out');
        await page.evaluate(() => {
            const gc = (window as any).glyphCanvas;
            if (gc?.viewportManager) gc.viewportManager.scale *= 0.7;
            if (gc) gc.render();
        });
        await page.waitForTimeout(500);

        const canvasLocator = page.locator('#glyph-canvas-container canvas');

        // Record framed viewport for later restoration (sidebearing anchoring shifts it).
        const framedViewport = await page.evaluate(() => {
            const vm = (window as any).glyphCanvas?.viewportManager;
            return vm
                ? { panX: vm.panX, panY: vm.panY, scale: vm.scale }
                : null;
        });
        const revertToFramedViewport = async () => {
            if (!framedViewport) return;
            await page.evaluate((vp: any) => {
                const vm = (window as any).glyphCanvas?.viewportManager;
                if (vm) {
                    vm.panX = vp.panX;
                    vm.panY = vp.panY;
                    vm.scale = vp.scale;
                }
            }, framedViewport);
            await stabiliseCanvas(page);
        };

        // ── SCREENSHOT 1: Baseline ────────────────────────────────────────
        console.log('[Test] Screenshot 1: baseline');
        await expect(canvasLocator).toHaveScreenshot('kbd-01-baseline.png', {
            maxDiffPixelRatio: 0.03
        });
        await stabiliseCanvas(page);
        const canvas1 = await captureCanvas(page);

        // ── 3. Select a bottom-most node via mouse click ─────────────────
        const nodeScreen1 = await getNodeScreenCoords(page);
        console.log('[Test] Clicking bottom-most node at', nodeScreen1);
        await page.mouse.click(nodeScreen1.x, nodeScreen1.y);
        await page.waitForTimeout(200);

        // ── 4. Keyboard move: Shift+ArrowDown × 5 (= 50u) ────────────────
        for (let i = 0; i < 5; i++) {
            await page.keyboard.press('Shift+ArrowDown');
            await page.waitForTimeout(60);
        }
        await waitForCompileSettle(page, 'keyboard-move');
        await page.waitForTimeout(200);

        // ── SCREENSHOT 2: After keyboard move ────────────────────────────
        console.log('[Test] Screenshot 2: after keyboard node move');
        await expect(canvasLocator).toHaveScreenshot(
            'kbd-02-after-keyboard-move.png',
            { maxDiffPixelRatio: 0.03 }
        );
        await stabiliseCanvas(page);
        const canvas2 = await captureCanvas(page);
        expect(canvas2).not.toBe(canvas1);

        // ── 5. Drag left sidebearing handle left by 50u via mouse ────────
        const handleInfo = await page.evaluate(() => {
            const gc = (window as any).glyphCanvas;
            const oe = gc.outlineEditor;
            const tre = gc.textRunEditor;
            const vm = gc.viewportManager;

            const handle = oe
                .getVisibleSidebearingHandles()
                .find((h: any) => h?.side === 'left' && h?.editable);
            if (!handle) throw new Error('No left sidebearing handle');

            const gp = tre._getGlyphPosition(tre.selectedGlyphIndex);
            const wx = gp.xPosition + gp.xOffset + handle.x;
            const wy = gp.yOffset + handle.y;

            const sc = vm.fontToScreenCoordinates(wx, wy);
            const scLeft = vm.fontToScreenCoordinates(wx - 50, wy);

            const rect = gc.canvas.getBoundingClientRect();
            return {
                x: rect.left + sc.x,
                y: rect.top + sc.y,
                deltaX: scLeft.x - sc.x
            };
        });

        console.log('[Test] Dragging sidebearing handle at', handleInfo);
        await page.mouse.move(handleInfo.x, handleInfo.y);
        await page.waitForTimeout(50);
        await page.mouse.down();
        await page.mouse.move(handleInfo.x + handleInfo.deltaX, handleInfo.y, {
            steps: 8
        });
        await page.mouse.up();
        await waitForCompileSettle(page, 'sidebearing-drag');
        await page.waitForTimeout(200);

        // ── SCREENSHOT 3: After sidebearing drag ─────────────────────────
        console.log('[Test] Screenshot 3: after sidebearing drag');
        await expect(canvasLocator).toHaveScreenshot(
            'kbd-03-after-sidebearing-drag.png',
            { maxDiffPixelRatio: 0.03 }
        );
        await stabiliseCanvas(page);
        const canvas3 = await captureCanvas(page);
        expect(canvas3).not.toBe(canvas2);

        // ── 6. Undo (Cmd+Z) — should revert sidebearing drag ─────────────
        console.log('[Test] Pressing Cmd+Z for undo');
        await page.keyboard.press('Meta+z');
        await waitForCompileSettle(page, 'undo');
        await page.waitForTimeout(200);

        // ── SCREENSHOT 4: After undo — should equal screenshot 2 ─────────
        console.log('[Test] Screenshot 4: after undo');
        await revertToFramedViewport();

        // Re-select the node so selection state matches canvas2
        const nodeScreen4 = await getNodeScreenCoords(page);
        await page.mouse.click(nodeScreen4.x, nodeScreen4.y);
        await page.waitForTimeout(100);

        await stabiliseCanvas(page);
        await expect(canvasLocator).toHaveScreenshot('kbd-04-after-undo.png', {
            maxDiffPixelRatio: 0.03
        });
        const canvas4 = await captureCanvas(page);

        // ASSERT: Undo reverts sidebearing drag → canvas must match canvas2
        console.log(
            '[Test] Assert canvas after undo === canvas after keyboard move'
        );
        expect
            .soft(await getCanvasDiffRatio(page, canvas2, canvas4))
            .toBeLessThan(0.001);

        // ── 7. (Node re-selected above) Move node back up 50u (undo the keyboard move)
        for (let i = 0; i < 5; i++) {
            await page.keyboard.press('Shift+ArrowUp');
            await page.waitForTimeout(60);
        }
        await waitForCompileSettle(page, 'keyboard-up');
        await page.waitForTimeout(200);

        // ── SCREENSHOT 5: Back to baseline ────────────────────────────────
        console.log('[Test] Screenshot 5: back to baseline');

        // Match the original baseline capture: keep hover affordances off-canvas.
        await page.mouse.move(-100, -100);
        await page.waitForTimeout(100);

        // Deselect so selection state matches baseline (canvas1)
        await page.evaluate(() => {
            const oe = (window as any).glyphCanvas?.outlineEditor;
            if (oe) {
                oe.selectedPoints = [];
                oe.selectedAnchors = [];
                oe.selectedComponents = [];
            }
        });
        await revertToFramedViewport();
        await expect(canvasLocator).toHaveScreenshot(
            'kbd-05-back-to-baseline.png',
            { maxDiffPixelRatio: 0.03 }
        );
        await stabiliseCanvas(page);
        const canvas5 = await captureCanvas(page);

        // ASSERT: Full round-trip restored → canvas must match baseline
        console.log('[Test] Assert final canvas === baseline canvas');
        expect
            .soft(await getCanvasDiffRatio(page, canvas1, canvas5))
            .toBeLessThan(0.001);
    });
});
