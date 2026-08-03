import { expect, test, type Page } from '@playwright/test';
import {
    focusView,
    waitForCanvasReady,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';

async function openFustatNodeEditLayer(page: Page): Promise<void> {
    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    await page.evaluate(async () => {
        await (window as any).showFontFileDialog?.({ mode: 'open' });
    });

    const fileDialog = page.locator('#font-file-dialog');
    await fileDialog.waitFor({ state: 'visible' });
    const fustatItem = fileDialog.locator(
        '.file-item[data-name="Fustat.glyphs"]'
    );
    await fustatItem.waitFor({ state: 'visible' });
    await fustatItem.dblclick();
    await waitForOpenSessionReady(page, 'Fustat.glyphs');
    await focusView(page, 'Meta+Shift+E', 'view-editor');

    await page.evaluate(async () => {
        const win = window as any;
        const glyphCanvas = win.glyphCanvas;
        const textRunEditor = glyphCanvas?.textRunEditor;
        const outlineEditor = glyphCanvas?.outlineEditor;
        const axesManager = glyphCanvas?.axesManager;
        const stateManager = win.stateManager;
        const fontManager = win.fontManager;

        if (!glyphCanvas || !textRunEditor || !outlineEditor || !axesManager) {
            throw new Error('Missing Fustat node-edit layer dependencies');
        }

        if (stateManager) {
            stateManager.editor_text_buffer = 'oö';
            stateManager.editor_cursor_position = 0;
            stateManager.editor_mode = 'edit';
        }
        if (fontManager) {
            fontManager.currentText = 'oö';
            fontManager.updateEditingSubsetSnapshot?.(['o']);
        }

        textRunEditor.setTextBuffer('oö');
        await textRunEditor.selectGlyphByIndex(0, true);
        outlineEditor.active = true;
        outlineEditor.currentGlyphName = 'o';
        axesManager.variationSettings = { wght: 200 };
        await glyphCanvas.doUIUpdateAsync?.();
        await outlineEditor.autoSelectMatchingLayer?.();
        await glyphCanvas.enterGlyphEditModeAtCursor?.();
        await glyphCanvas.doUIUpdateAsync?.();
    });

    await page.waitForFunction(
        () => {
            const win = window as any;
            const outlineEditor = win.glyphCanvas?.outlineEditor;
            const layer = outlineEditor?.getCurrentLayerDataFromStack?.();
            return (
                typeof win.pyodide?.runPythonAsync === 'function' &&
                win.pyodide?.__counterpunchPythonExecutionWrapperInstalled ===
                    true &&
                outlineEditor?.active === true &&
                outlineEditor?.currentGlyphName === 'o' &&
                typeof outlineEditor?.selectedLayerId === 'string' &&
                Array.isArray(layer?.shapes) &&
                layer.shapes.some(
                    (shape: any) =>
                        Array.isArray(shape?.nodes) &&
                        typeof shape.nodes[0]?.y === 'number'
                )
            );
        },
        { timeout: 60000 }
    );
}

test.describe('Python Fustat node history', () => {
    test('records only the active layer shape change for one Python node move', async ({
        page
    }) => {
        await openFustatNodeEditLayer(page);

        const result = await page.evaluate(async () => {
            const win = window as any;
            const bridge = win.patchSyncEngine;
            const outlineEditor = win.glyphCanvas?.outlineEditor;
            const glyph = win.currentFontModel?.findGlyph?.('o');
            const layerId = outlineEditor?.selectedLayerId;
            const layer = glyph?.layers?.find(
                (candidate: any) => candidate.id === layerId
            );
            if (!bridge || !outlineEditor || !layer || !layerId) {
                throw new Error('Missing bridge or active Fustat layer');
            }

            const packets: Array<
                Array<{
                    op: string;
                    path: string;
                    workerReplayTargets: Array<{
                        glyphName: string;
                        layerId: string;
                    }>;
                }>
            > = [];
            const listener = (
                _update: Uint8Array,
                _message: unknown,
                entries: Array<{
                    op: string;
                    path: string;
                    workerReplayTargets?: Array<{
                        glyphName: string;
                        layerId: string;
                    }>;
                }>
            ) => {
                packets.push(
                    entries.map((entry) => ({
                        op: entry.op,
                        path: entry.path,
                        workerReplayTargets: entry.workerReplayTargets || []
                    }))
                );
            };
            bridge.onLocalUpdate(listener);

            try {
                const pathShape = layer.paths?.[0];
                if (!pathShape) {
                    throw new Error('Missing active Fustat path shape');
                }
                const beforeY = pathShape.nodes[0].y;
                await win.pyodide.runPythonAsync(
                    'Layer().paths[0].nodes[0].y += 100'
                );
                const updatedLayer = glyph.layers.find(
                    (candidate: any) => candidate.id === layerId
                );
                const updatedPathShape = updatedLayer?.paths?.[0];
                if (!updatedPathShape) {
                    throw new Error('Missing updated Fustat path shape');
                }
                const afterY = updatedPathShape.nodes[0].y;

                return { beforeY, afterY, layerId, packets };
            } finally {
                bridge.offLocalUpdate(listener);
            }
        });

        expect(result.afterY).toBe(result.beforeY + 100);
        expect(result.packets).toHaveLength(1);
        expect(result.packets[0]).toEqual([
            {
                op: 'set',
                path: `glyphs.o:layers.${result.layerId}:shapes`,
                workerReplayTargets: [
                    { glyphName: 'o', layerId: result.layerId }
                ]
            }
        ]);
    });
});
