import { test, expect } from './fixtures';
import {
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady,
    waitForStableCanvasBox,
    waitForStableEditorMetrics,
    focusView,
    openFileFromFilesView
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
 * Visual checks use clipped Playwright screenshots. Round-trip correctness
 * also asserts outline metrics (bottom on-curve Y + LSB), which stay stable
 * when canvas backing-store size / antialias noise would flake a pixel diff.
 */

/** Force a render and wait for the GPU pipeline to settle. */
async function stabiliseCanvas(page: any): Promise<void> {
    await page.evaluate(() => {
        const gc = (window as any).glyphCanvas;
        if (gc?.render) gc.render();
    });
    for (let i = 0; i < 3; i++) {
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
    }
    await waitForStableCanvasBox(page);
    await page.waitForTimeout(50);
}

/** Wait until viewport pan/scale stop changing (Cmd+0 animates ~10 frames). */
async function waitForStableViewport(
    page: any,
    options?: { idleMs?: number; timeout?: number }
): Promise<void> {
    const idleMs = options?.idleMs ?? 200;
    const timeout = options?.timeout ?? 10000;
    await page.waitForFunction(
        (stableIdleMs: number) => {
            const vm = (window as any).glyphCanvas?.viewportManager;
            if (!vm) {
                return false;
            }
            const signature = [vm.scale, vm.panX, vm.panY]
                .map((value: number) => Number(value).toFixed(4))
                .join('|');
            const win = window as any;
            const previous = win.__pwStableViewport as
                { signature: string; since: number } | undefined;
            if (!previous || previous.signature !== signature) {
                win.__pwStableViewport = {
                    signature,
                    since: Date.now()
                };
                return false;
            }
            return Date.now() - previous.since >= stableIdleMs;
        },
        idleMs,
        { timeout, polling: 50 }
    );
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

/** Bottom-most on-curve node Y and left outline extent (LSB proxy via minX). */
async function getOutlineMetrics(page: any): Promise<{
    bottomNodeY: number;
    leftSidebearing: number;
    selectedGlyphIndex: number;
}> {
    return page.evaluate(() => {
        const gc = (window as any).glyphCanvas;
        const oe = gc?.outlineEditor;
        const tre = gc?.textRunEditor;
        const layerData = oe?.getCurrentLayerDataFromStack?.();
        let bottomNodeY = Number.POSITIVE_INFINITY;
        let minX = Number.POSITIVE_INFINITY;
        for (const shape of layerData?.shapes || []) {
            const nodes = shape.nodes || shape.Path?.nodes || [];
            for (const node of nodes) {
                if (!node || node.nodetype === 'OffCurve') continue;
                if (node.y < bottomNodeY) bottomNodeY = node.y;
                if (node.x < minX) minX = node.x;
            }
        }
        return {
            bottomNodeY: Number.isFinite(bottomNodeY) ? bottomNodeY : 0,
            // Use outline minX — matches left-sidebearing handle geometry and
            // avoids flaky Layer.lsb getter access on stack snapshots.
            leftSidebearing: Number.isFinite(minX) ? minX : 0,
            selectedGlyphIndex: tre?.selectedGlyphIndex ?? -1
        };
    });
}

/** Nudge with Shift+Arrow until bottom on-curve Y hits target (10u steps). */
async function nudgeBottomNodeToY(
    page: any,
    targetY: number,
    direction: 'up' | 'down'
): Promise<void> {
    const key = direction === 'down' ? 'Shift+ArrowDown' : 'Shift+ArrowUp';
    for (let attempt = 0; attempt < 12; attempt++) {
        const current = await getOutlineMetrics(page);
        if (Math.abs(current.bottomNodeY - targetY) < 0.5) {
            return;
        }
        await page.keyboard.press(key);
        await page.waitForTimeout(60);
    }
    const finalMetrics = await getOutlineMetrics(page);
    expect(finalMetrics.bottomNodeY).toBe(targetY);
}

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

        console.log('[Test] Loading Fustat.glyphs');
        await openFileFromFilesView(page, 'Fustat.glyphs');
        await page.waitForTimeout(200);

        await waitForFontLoaded(page);
        await waitForOpenSessionReady(page, 'Fustat.glyphs');

        console.log('[Test] Focusing editor view');
        await focusView(page, 'Meta+Shift+E', 'view-editor');
        await page.waitForTimeout(200);

        // Suite load can leave a non-default dock layout; Cmd+0 framing is
        // derived from the canvas CSS box, so normalize before any screenshots.
        await page.evaluate(() => {
            (window as any).resizableViews?.applyDefaultLayout?.();
        });
        await waitForStableCanvasBox(page, { idleMs: 400, timeout: 15000 });
        await page.waitForTimeout(100);

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

        // Cmd+0 frames from current outline bounds. If we frame before the
        // layer geometry is present (common after the model-only font wait),
        // the baseline pan/scale lands elsewhere and screenshots flake.
        await page.waitForFunction(
            () => {
                const oe = (window as any).glyphCanvas?.outlineEditor;
                const layer = oe?.getCurrentLayerDataFromStack?.();
                for (const shape of layer?.shapes || []) {
                    const nodes = shape.nodes || shape.Path?.nodes || [];
                    if (
                        nodes.some(
                            (node: { nodetype?: string } | null) =>
                                !!node && node.nodetype !== 'OffCurve'
                        )
                    ) {
                        return true;
                    }
                }
                return false;
            },
            undefined,
            { timeout: 20000 }
        );
        await waitForStableEditorMetrics(page, {
            idleMs: 300,
            timeout: 20000
        });

        // Avoid hover effects
        await page.mouse.move(-100, -100);
        await page.waitForTimeout(100);

        const canvasLocator = page.locator('#glyph-canvas-container canvas');

        let framedViewport: {
            panX: number;
            panY: number;
            scale: number;
        } | null = null;
        const revertToFramedViewport = async () => {
            if (!framedViewport) return;
            await page.evaluate((vp) => {
                const vm = (window as any).glyphCanvas?.viewportManager;
                if (vm) {
                    vm.panX = vp.panX;
                    vm.panY = vp.panY;
                    vm.scale = vp.scale;
                }
            }, framedViewport);
            await stabiliseCanvas(page);
        };

        const clearOutlineSelection = async () => {
            await page.evaluate(() => {
                const gc = (window as any).glyphCanvas;
                const oe = gc?.outlineEditor;
                if (oe) {
                    oe.selectedPoints = [];
                    oe.selectedAnchors = [];
                    oe.selectedComponents = [];
                }
                // Rebuild the property panel; assigning selection arrays
                // directly otherwise leaves an empty panel and resizes the canvas.
                gc?.updatePropertyPanel?.();
            });
            await waitForStableCanvasBox(page, {
                idleMs: 400,
                timeout: 10000
            });
        };

        // Settle the property panel / canvas box BEFORE framing. Framing against
        // a transient box (common under suite load) then rebuilding the panel
        // shifts pan/scale by ~20px and flakes kbd-01-baseline.
        await page.mouse.move(-100, -100);
        await clearOutlineSelection();
        await waitForStableCanvasBox(page, { idleMs: 500, timeout: 15000 });

        // Apply Cmd+0 target synchronously (no animation), then zoom out.
        // frameCurrentGlyph animates over ~10 frames and still depends on the
        // live canvas rect — both flake under suite load.
        console.log('[Test] Framing glyph (sync Cmd+0 target)');
        await page.evaluate(() => {
            const gc = (window as any).glyphCanvas;
            const vm = gc?.viewportManager;
            const target = gc?.getCmdZeroViewportTarget?.();
            if (!vm || !target) {
                throw new Error('Missing viewport target for framing');
            }
            vm.panX = target.panX;
            vm.panY = target.panY;
            vm.scale = target.scale * 0.7;
            gc.render();
        });
        await waitForStableViewport(page, { idleMs: 200, timeout: 5000 });
        await stabiliseCanvas(page);

        // Property-panel chrome can change the canvas box by a few pixels under
        // suite load. Clip every canvas screenshot to the baseline box so
        // Playwright size checks stay deterministic.
        let baselineClip: {
            x: number;
            y: number;
            width: number;
            height: number;
        } | null = null;

        const expectCanvasScreenshot = async (name: string) => {
            await stabiliseCanvas(page);
            const box = await canvasLocator.boundingBox();
            if (!box) {
                throw new Error('Canvas bounding box missing for screenshot');
            }
            if (!baselineClip) {
                baselineClip = {
                    x: box.x,
                    y: box.y,
                    width: Math.floor(box.width),
                    height: Math.floor(box.height)
                };
            }
            const clip = {
                x: baselineClip.x,
                y: baselineClip.y,
                width: Math.min(baselineClip.width, Math.floor(box.width)),
                height: Math.min(baselineClip.height, Math.floor(box.height))
            };
            await expect(page).toHaveScreenshot(name, {
                clip,
                maxDiffPixelRatio: 0.03
            });
        };

        framedViewport = await page.evaluate(() => {
            const vm = (window as any).glyphCanvas?.viewportManager;
            return vm
                ? { panX: vm.panX, panY: vm.panY, scale: vm.scale }
                : null;
        });

        // ── SCREENSHOT 1: Baseline ────────────────────────────────────────
        console.log('[Test] Screenshot 1: baseline');
        await expectCanvasScreenshot('kbd-01-baseline.png');
        const metrics1 = await getOutlineMetrics(page);

        // ── 3. Select a bottom-most node via mouse click ─────────────────
        const nodeScreen1 = await getNodeScreenCoords(page);
        console.log('[Test] Clicking bottom-most node at', nodeScreen1);
        await page.mouse.click(nodeScreen1.x, nodeScreen1.y);
        await page.waitForTimeout(200);

        // ── 4. Keyboard move: Shift+ArrowDown until −50u ────────────────
        await nudgeBottomNodeToY(page, metrics1.bottomNodeY - 50, 'down');
        await waitForCompileSettle(page, 'keyboard-move');
        await page.waitForTimeout(200);

        // ── SCREENSHOT 2: After keyboard move ────────────────────────────
        console.log('[Test] Screenshot 2: after keyboard node move');
        await expectCanvasScreenshot('kbd-02-after-keyboard-move.png');
        const metrics2 = await getOutlineMetrics(page);
        expect(metrics2.bottomNodeY).toBe(metrics1.bottomNodeY - 50);
        expect(metrics2.leftSidebearing).toBe(metrics1.leftSidebearing);

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
        await expectCanvasScreenshot('kbd-03-after-sidebearing-drag.png');
        const metrics3 = await getOutlineMetrics(page);
        expect(metrics3.leftSidebearing).not.toBe(metrics2.leftSidebearing);
        expect(metrics3.bottomNodeY).toBe(metrics2.bottomNodeY);

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
        await expectCanvasScreenshot('kbd-04-after-undo.png');
        const metrics4 = await getOutlineMetrics(page);

        // ASSERT: Undo reverts sidebearing drag → metrics match post-keyboard
        console.log(
            '[Test] Assert metrics after undo === metrics after keyboard move'
        );
        expect(metrics4.bottomNodeY).toBe(metrics2.bottomNodeY);
        expect(metrics4.leftSidebearing).toBe(metrics2.leftSidebearing);

        // ── 7. Move node back up 50u (undo the keyboard move)
        await nudgeBottomNodeToY(page, metrics1.bottomNodeY, 'up');
        await waitForCompileSettle(page, 'keyboard-up');
        await page.waitForTimeout(200);

        // ── SCREENSHOT 5: Back to baseline ────────────────────────────────
        console.log('[Test] Screenshot 5: back to baseline');

        // Match the original baseline capture: keep hover affordances off-canvas.
        await page.mouse.move(-100, -100);
        await page.waitForTimeout(100);

        await clearOutlineSelection();
        await revertToFramedViewport();
        await expectCanvasScreenshot('kbd-05-back-to-baseline.png');
        const metrics5 = await getOutlineMetrics(page);

        // ASSERT: Full round-trip restored → outline metrics match baseline.
        console.log('[Test] Assert final metrics === baseline metrics');
        expect(metrics5.selectedGlyphIndex).toBe(0);
        expect(metrics5.bottomNodeY).toBe(metrics1.bottomNodeY);
        expect(metrics5.leftSidebearing).toBe(metrics1.leftSidebearing);
    });
});
