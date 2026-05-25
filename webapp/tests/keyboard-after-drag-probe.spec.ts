import { test } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady,
    focusView
} from './helpers/snapshot-helper';

async function waitForCompileSettle(page: any, label: string): Promise<void> {
    console.log(`[Probe] Waiting for compile settle: ${label}`);
    await page.evaluate(() => {
        return new Promise<void>((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                resolve();
            };
            window.addEventListener('editingFontCompiled', finish, {
                once: true
            });
            setTimeout(finish, 15000);
        });
    });
    await page.waitForTimeout(300);
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

function probeStepScript(label: string) {
    return `(() => {
        const gc = window.glyphCanvas;
        const oe = gc?.outlineEditor;
        const tre = gc?.textRunEditor;
        const bridge = window.patchSyncEngine;
        const parsed = oe?.parseGlyphStack?.() ?? [];
        const activeGlyphName = parsed.length ? parsed[parsed.length - 1].glyphName : gc?.getCurrentGlyphName?.();
        const layerId = oe?.getCurrentLayerId?.() ?? oe?.selectedLayerId ?? null;
        const modelLayer = activeGlyphName && layerId
            ? window.fontManager?.currentFont?.fontModel?.findGlyph?.(activeGlyphName)?.findLayerById?.(layerId)
            : null;
        const selectedGlyphIndex = tre?.selectedGlyphIndex ?? null;
        const glyphPositions = Array.isArray(tre?.shapedGlyphs)
            ? tre.shapedGlyphs.map((_, glyphIndex) => ({
                  glyphIndex,
                  position: (() => {
                      const position = tre?._getGlyphPosition?.(glyphIndex);
                      return position
                          ? {
                                xPosition: position.xPosition ?? null,
                                xOffset: position.xOffset ?? null,
                                yOffset: position.yOffset ?? null
                            }
                          : null;
                  })()
              }))
            : [];
        const summarizeLayer = (layer) => {
            if (!layer) return null;
            const data = typeof layer.toJSON === 'function' ? layer.toJSON() : layer;
            const shapes = data.shapes || [];
            return {
                width: data.width ?? null,
                firstOnCurve: (() => {
                    for (const shape of shapes) {
                        const nodes = shape.nodes || shape.Path?.nodes || [];
                        for (const node of nodes) {
                            if (node && node.nodetype !== 'OffCurve' && node.type !== 'OffCurve') {
                                return { x: node.x ?? null, y: node.y ?? null, type: node.type ?? node.nodetype ?? null };
                            }
                        }
                    }
                    return null;
                })()
            };
        };
        return {
            label: ${JSON.stringify(label)},
            selectedPoints: oe?.selectedPoints ?? null,
            selectedSidebearingHandle: oe?.selectedSidebearingHandle ?? null,
            hoveredSidebearingHandle: oe?.hoveredSidebearingHandle ?? null,
            currentLayer: summarizeLayer(oe?.getCurrentLayerDataFromStack?.()),
            modelLayer: summarizeLayer(modelLayer),
            shapedGlyphs: (tre?.shapedGlyphs ?? []).map((glyph) => ({
                g: glyph.g,
                ax: glyph.ax,
                dx: glyph.dx,
                explicitGlyphName: glyph.explicitGlyphName ?? null
            })),
            glyphNameBuffer: tre?.glyphNameBuffer ?? null,
            selectedGlyphIndex,
            glyphPositions,
            glyphBounds: Array.isArray(gc?.glyphBounds)
                ? gc.glyphBounds.map((bounds, glyphIndex) => ({
                      glyphIndex,
                      x: bounds?.x ?? null,
                      y: bounds?.y ?? null,
                      width: bounds?.width ?? null,
                      x1: bounds?.x1 ?? null,
                      y1: bounds?.y1 ?? null,
                      x2: bounds?.x2 ?? null,
                      y2: bounds?.y2 ?? null
                  }))
                : null,
            viewport: gc?.viewportManager
                ? {
                      panX: gc.viewportManager.panX ?? null,
                      panY: gc.viewportManager.panY ?? null,
                      scale: gc.viewportManager.scale ?? null
                  }
                : null,
            lastChangeSource: window.fontManager?.lastChangeSource ?? null,
            lastEditType: window.fontManager?.lastEditType ?? null,
            historyTail: (bridge?._changeLog ?? []).slice(-8).map((entry) => ({
                label: entry.label ?? entry.summary ?? null,
                historyAction: entry.metadata?.historyAction ?? null,
                transactionLabel: entry.metadata?.transactionLabel ?? null,
                undoScope: entry.metadata?.undoScope ?? null,
                changeSource: entry.metadata?.changeSource ?? null
            })),
            undoContext: window.getHistoryUndoContext?.() ?? null,
            compileEvents: window.__dragProbeCompileEvents ?? []
        };
    })()`;
}

test('probe keyboard-after-drag runtime state', async ({ page }) => {
    test.setTimeout(300000);

    await page.goto('/?test=true');
    await waitForCanvasReady(page);
    await page.waitForTimeout(200);

    await page.evaluate(() => {
        (window as any).__dragProbeCompileEvents = [];
        window.addEventListener('editingFontCompiled', ((event: Event) => {
            const detail = (event as CustomEvent).detail || {};
            (window as any).__dragProbeCompileEvents.push({
                revision: detail.revision ?? null,
                compilationMode: detail.compilationMode ?? null,
                changeSource: detail.changeSource ?? null,
                editType: detail.editType ?? null,
                dragActive: detail.dragActive ?? null
            });
        }) as EventListener);
    });

    await page.evaluate(async () => {
        await (window as any).showFontFileDialog?.({ mode: 'open' });
    });
    await page.locator('#font-file-dialog').waitFor({ state: 'visible' });
    await page.getByText('Fustat.glyphs').dblclick();
    await waitForFontLoaded(page);
    await waitForOpenSessionReady(page, 'Fustat.glyphs');
    await focusView(page, 'Meta+Shift+E', 'view-editor');

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
    await page.evaluate(async () => {
        const tre = (window as any).glyphCanvas?.textRunEditor;
        if (tre) await tre.selectGlyphByIndex(0);
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
    await page.mouse.move(-100, -100);
    await page.keyboard.press('Meta+0');
    await page.waitForTimeout(600);
    await page.evaluate(() => {
        const gc = (window as any).glyphCanvas;
        if (gc?.viewportManager) gc.viewportManager.scale *= 0.7;
        if (gc) gc.render();
    });
    await page.waitForTimeout(500);

    console.log('[Probe]', await page.evaluate(probeStepScript('baseline')));

    const nodeScreen = await getNodeScreenCoords(page);
    await page.mouse.click(nodeScreen.x, nodeScreen.y);
    await page.waitForTimeout(200);
    console.log('[Probe]', await page.evaluate(probeStepScript('afterClick')));

    for (let i = 0; i < 5; i++) {
        await page.keyboard.press('Shift+ArrowDown');
        await page.waitForTimeout(60);
    }
    await waitForCompileSettle(page, 'keyboard-move');
    console.log(
        '[Probe]',
        await page.evaluate(probeStepScript('afterKeyboardMove'))
    );

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

    await page.mouse.move(handleInfo.x, handleInfo.y);
    await page.waitForTimeout(50);
    await page.mouse.down();
    await page.mouse.move(handleInfo.x + handleInfo.deltaX, handleInfo.y, {
        steps: 8
    });
    await page.mouse.up();
    await waitForCompileSettle(page, 'sidebearing-drag');
    console.log(
        '[Probe]',
        await page.evaluate(probeStepScript('afterSidebearingDrag'))
    );

    await page.keyboard.press('Meta+z');
    await waitForCompileSettle(page, 'undo');
    console.log('[Probe]', await page.evaluate(probeStepScript('afterUndo')));

    const nodeScreen4 = await getNodeScreenCoords(page);
    await page.mouse.click(nodeScreen4.x, nodeScreen4.y);
    await page.waitForTimeout(100);
    for (let i = 0; i < 5; i++) {
        await page.keyboard.press('Shift+ArrowUp');
        await page.waitForTimeout(60);
    }
    await waitForCompileSettle(page, 'keyboard-up');
    console.log(
        '[Probe]',
        await page.evaluate(probeStepScript('afterKeyboardUp'))
    );
});
