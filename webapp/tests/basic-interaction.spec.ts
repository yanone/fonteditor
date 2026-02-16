import { test, expect } from '@playwright/test';
import {
    captureSnapshot,
    snapshotForComparison,
    takeSnapshot,
    waitForCanvasReady,
    waitForFontLoaded
} from './helpers/snapshot-helper';

/**
 * Basic Interaction Test
 *
 * This test demonstrates how to:
 * 1. Record user interactions (run with: npm run test:record)
 * 2. Capture snapshots at key points
 * 3. Replay interactions and verify state
 *
 * To record this test:
 *   npm run test:record
 *   - Perform your interactions in the browser
 *   - Code will be generated in the Playwright Inspector
 *   - Copy the generated code into this file
 *   - Add snapshot.take() calls at key points
 */

// Run tests: npm test
// Update snapshots: npm test -- -u
// Record clicks: npm run test:record
// View interactive: npm run test:ui

test.describe('Font Editor Basic Workflow', () => {
    test.beforeEach(async ({ page }) => {
        console.log('[Test] Starting beforeEach');

        // Track unexpected navigations
        page.on('framenavigated', (frame) => {
            if (frame === page.mainFrame()) {
                console.error('[Test] ⚠️ PAGE NAVIGATION:', frame.url());
            }
        });

        // Track console errors that might trigger reload
        page.on('pageerror', (error) => {
            console.error('[Test] ⚠️ PAGE ERROR:', error.message);
        });

        // Navigate to your local dev server
        // Adjust URL if your dev server runs on a different port
        // Add ?test=true to enable test mode (hides FPS, etc.)
        console.log('[Test] Navigating to page');
        await page.goto('/?test=true');

        // Wait for app to be ready
        console.log('[Test] Waiting for canvas ready');
        await waitForCanvasReady(page);

        // Move mouse far outside the viewport to avoid triggering any hover effects
        await page.mouse.move(-100, -100);
        await page.waitForTimeout(200);

        // Click on editor view to activate it (prevents popups in screenshots)
        console.log('[Test] Clicking canvas');
        await page.keyboard.press('Meta+Shift+E');

        // Wait for rendering to complete
        await page.waitForTimeout(500);
        console.log('[Test] beforeEach complete');
    });

    const takeWindowSnapshot = async (
        page: any,
        snapshotNumber: string,
        label: string
    ) => {
        await page.waitForTimeout(100);
        const snapshot = await captureSnapshot(page, label);
        expect(snapshotForComparison(snapshot)).toMatchSnapshot(
            `${snapshotNumber}-${label}.json`
        );
        await expect(page).toHaveScreenshot(
            `${snapshotNumber}-${label}-window.png`
        );
        return snapshot;
    };

    const waitForSubsetEditingFontState = async (
        page: any,
        expectedFilename: string
    ) => {
        await page.waitForFunction(
            (filename) => {
                const state =
                    window.stateManager?.getStateSnapshot?.()?.state || null;
                if (!state) return false;

                const editorFile = state.editor_file || '';
                if (!editorFile.includes(filename)) return false;

                const featuresInSubset =
                    state.editor_opentype_features_in_subset || {};
                const featuresNotInSubset =
                    state.editor_opentype_features_not_in_subset || {};
                const glyphCount =
                    window.glyphCanvas?.textRunEditor?.glyphNameBuffer
                        ?.length || 0;

                return (
                    Object.keys(featuresInSubset).length > 0 &&
                    Object.keys(featuresNotInSubset).length > 0 &&
                    glyphCount > 0
                );
            },
            expectedFilename,
            { timeout: 15000 }
        );
    };

    test('open YanoneKaffeesatz.glyphspackage and snapshot full window', async ({
        page
    }) => {
        console.log('[Test] Opening YanoneKaffeesatz.glyphspackage');

        await page.keyboard.press('Meta+Shift+F');
        await page.waitForTimeout(200);

        await page.getByText('YanoneKaffeesatz.glyphspackage').dblclick();
        await page.waitForTimeout(200);

        await waitForFontLoaded(page);
        await waitForSubsetEditingFontState(
            page,
            'YanoneKaffeesatz.glyphspackage'
        );
        await page.waitForTimeout(300);

        await takeWindowSnapshot(
            page,
            'yanone-01',
            'yanone-glyphspackage-opened'
        );
    });

    test('open YanoneKaffeesatz.designspace and snapshot full window', async ({
        page
    }) => {
        console.log('[Test] Opening YanoneKaffeesatz.designspace');

        await page.keyboard.press('Meta+Shift+F');
        await page.waitForTimeout(200);

        await page.getByText('YanoneKaffeesatz.designspace').dblclick();
        await page.waitForTimeout(200);

        await waitForFontLoaded(page);
        await waitForSubsetEditingFontState(
            page,
            'YanoneKaffeesatz.designspace'
        );
        await page.waitForTimeout(300);

        await takeWindowSnapshot(
            page,
            'yanone-02',
            'yanone-designspace-opened'
        );
    });

    test('load font and navigate with keyboard', async ({ page }) => {
        console.log('[Test] Starting main test');
        await page.waitForTimeout(1000);

        // SNAPSHOT POINT 1: Initial state
        console.log('[Test] Taking snapshot 1: initial state');
        const snapshot1 = await takeSnapshot(
            page,
            '01',
            'initial-state',
            expect,
            0.02
        );

        // Activate files view with Cmd+Shift+F
        console.log('[Test] Activating files view');
        await page.keyboard.press('Meta+Shift+F');
        await page.waitForTimeout(200);

        // Load font by right-clicking on a file and selecting "Open" from context menu
        console.log('[Test] Double-clicking on first .glyphs file');
        await page.getByText('Fustat.glyphs').dblclick();
        await page.waitForTimeout(200);

        console.log('[Test] Waiting for font to load');
        await waitForFontLoaded(page);

        // Re-activate editor view by clicking canvas
        console.log('[Test] Re-activating editor view');
        await page.keyboard.press('Meta+Shift+E');
        await page.waitForTimeout(200);

        // Cmd+0
        console.log('[Test] Pressing Cmd+0');
        await page.keyboard.press('Meta+0');
        await page.waitForTimeout(300);

        // SNAPSHOT POINT 2: Font loaded
        console.log('[Test] Taking snapshot 2: font loaded');
        const snapshot2 = await takeSnapshot(page, '02', 'font-loaded', expect);

        // Type some text - click canvas to focus, then type
        // This triggers the subsetted font compilation via onTextChange debounce
        console.log('[Test] Typing text on canvas');
        await page.click('#glyph-canvas-container canvas');
        await page.waitForTimeout(100);
        // Move mouse far outside the viewport to avoid triggering any hover effects
        await page.mouse.move(-100, -100);
        await page.waitForTimeout(200);
        // Set text directly and wait for compilation to complete
        await page.evaluate(() => {
            return new Promise((resolve) => {
                window.addEventListener('editingFontCompiled', resolve, {
                    once: true
                });
                if (window.glyphCanvas && window.glyphCanvas.textRunEditor) {
                    window.glyphCanvas.textRunEditor.setTextBuffer(
                        'hello مَرحَباً'
                    );
                    // Move cursor to end of text so ArrowLeft can move it
                    window.glyphCanvas.textRunEditor.cursorPosition =
                        'hello مَرحَباً'.length;
                }
            });
        });

        // Cmd+0
        console.log('[Test] Pressing Cmd+0 after text');
        await page.keyboard.press('Meta+0');
        await page.waitForTimeout(300);

        // Wait for rendering to complete
        await page.waitForTimeout(500);

        // SNAPSHOT POINT 3: Text typed
        console.log('[Test] Taking snapshot 3: text typed');
        const snapshot3 = await takeSnapshot(page, '03', 'text-typed', expect);
        expect(snapshot3.state.editor_text_buffer).toContain('hello مَرحَباً');

        // Use keyboard navigation (arrows, etc)
        console.log('[Test] Moving cursor with arrow keys');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowLeft');
        await page.waitForTimeout(300);

        // SNAPSHOT POINT 4: Cursor moved
        console.log('[Test] Taking snapshot 4: cursor moved');
        const snapshot4 = await takeSnapshot(
            page,
            '04',
            'cursor-moved',
            expect
        );
        expect(snapshot4.state.editor_cursor_position).not.toBe(
            snapshot3.state.editor_cursor_position
        );

        // Enter edit mode directly via JavaScript (keyboard shortcuts don't work reliably in tests)
        console.log('[Test] Entering edit mode');
        await page.evaluate(() => {
            if (window.glyphCanvas) {
                window.glyphCanvas.enterGlyphEditModeAtCursor();
            }
        });

        // Wait for edit mode to activate
        await page.waitForTimeout(300);

        // SNAPSHOT POINT 5: Edit mode entered
        console.log('[Test] Taking snapshot 5: edit mode');
        const snapshot5 = await takeSnapshot(page, '05', 'edit-mode', expect);
        expect(snapshot5.state.editor_mode).toBe('edit');
        expect(snapshot5.state.editor_glyph_stack).toBeTruthy();

        // Move to fatha-tanween
        console.log('[Test] Moving to fatha-tanween');
        await page.keyboard.press('Meta+ArrowRight');

        // SNAPSHOT POINT 6: Moved to fatha-tanween
        console.log('[Test] Taking snapshot 6: moved to fatha-tanween');
        const snapshot6 = await takeSnapshot(
            page,
            '06',
            'moved-to-fatha-tanween',
            expect
        );

        // Cmd+0
        console.log('[Test] Pressing Cmd+0 on fatha-tanween');
        await page.keyboard.press('Meta+0');
        await page.waitForTimeout(300);

        // SNAPSHOT POINT 7: Cmd+0 on fatha-tanween
        console.log('[Test] Taking snapshot 7: cmd-0 on fatha-tanween');
        const snapshot7 = await takeSnapshot(
            page,
            '07',
            'cmd-0-on-fatha-tanween',
            expect
        );

        // Move to meem.init
        console.log('[Test] Moving to meem.init');
        await page.keyboard.press('Meta+ArrowLeft');
        await page.keyboard.press('Meta+ArrowLeft');
        await page.keyboard.press('Meta+ArrowLeft');
        await page.keyboard.press('Meta+ArrowLeft');
        await page.keyboard.press('Meta+ArrowLeft');
        await page.keyboard.press('Meta+ArrowLeft');
        await page.keyboard.press('Meta+ArrowLeft');
        await page.keyboard.press('Meta+ArrowLeft');
        await page.waitForTimeout(300);

        // SNAPSHOT POINT 8: Moved to meem.init
        console.log('[Test] Taking snapshot 8: moved to meem.init');
        const snapshot8 = await takeSnapshot(
            page,
            '08',
            'moved-to-meem-init',
            expect
        );

        // Cmd+0 on meem.init
        console.log('[Test] Pressing Cmd+0 on meem.init');
        await page.keyboard.press('Meta+0');
        await page.waitForTimeout(300);

        // SNAPSHOT POINT 9: Cmd+0 on meem.init
        console.log('[Test] Taking snapshot 9: cmd-0 on meem.init');
        const snapshot9 = await takeSnapshot(
            page,
            '09',
            'cmd-0-on-meem-init',
            expect
        );

        // Open plugins dropdown in editor title bar
        console.log('[Test] Opening plugins dropdown');
        await page.locator('#editor-plugins-dropdown-btn').click();
        await expect(page.locator('#editor-plugins-dropdown')).toBeVisible();

        // Activate curvature plugin
        console.log('[Test] Activating curvature plugin');
        await page
            .locator('.editor-plugins-dropdown-item')
            .filter({ hasText: 'Curvature Comb' })
            .first()
            .click();
        await page.waitForTimeout(300);

        // Close panel before snapshot
        console.log('[Test] Closing plugins dropdown with Escape');
        await page.keyboard.press('Escape');
        await expect(page.locator('#editor-plugins-dropdown')).toBeHidden();
        await page.waitForTimeout(200);

        // SNAPSHOT POINT 10: Curvature plugin active
        console.log('[Test] Taking snapshot 10: curvature plugin active');
        await takeSnapshot(page, '10', 'curvature-plugin-active', expect);

        // Re-open plugins dropdown for deactivation/activation
        console.log('[Test] Re-opening plugins dropdown');
        await page.locator('#editor-plugins-dropdown-btn').click();
        await expect(page.locator('#editor-plugins-dropdown')).toBeVisible();

        // Deactivate curvature plugin
        console.log('[Test] Deactivating curvature plugin');
        await page
            .locator('.editor-plugins-dropdown-item')
            .filter({ hasText: 'Curvature Comb' })
            .first()
            .click();
        await page.waitForTimeout(200);

        // Activate example plugin
        console.log('[Test] Activating example plugin');
        await page
            .locator('.editor-plugins-dropdown-item')
            .filter({ hasText: 'Example Canvas Plugin' })
            .first()
            .click();
        await page.waitForTimeout(300);

        // Close panel before snapshot
        console.log('[Test] Closing plugins dropdown with Escape');
        await page.keyboard.press('Escape');
        await expect(page.locator('#editor-plugins-dropdown')).toBeHidden();
        await page.waitForTimeout(200);

        // SNAPSHOT POINT 13: Example plugin active
        console.log('[Test] Taking snapshot 13: example plugin active');
        await takeSnapshot(page, '13', 'example-plugin-active', expect);

        // Re-open plugins dropdown for final deactivation
        console.log('[Test] Re-opening plugins dropdown');
        await page.locator('#editor-plugins-dropdown-btn').click();
        await expect(page.locator('#editor-plugins-dropdown')).toBeVisible();

        // Deactivate example plugin
        console.log('[Test] Deactivating example plugin');
        await page
            .locator('.editor-plugins-dropdown-item')
            .filter({ hasText: 'Example Canvas Plugin' })
            .first()
            .click();
        await page.waitForTimeout(200);

        // Close plugins dropdown
        await page.keyboard.press('Escape');

        // Click through layers list dynamically: 2nd -> 3rd -> 1st
        console.log('[Test] Cycling layers via layers list');
        const layerItems = page.locator(
            '.editor-layers-list .editor-layer-item[data-layer-id]'
        );
        const layerCount = await layerItems.count();
        expect(layerCount).toBeGreaterThanOrEqual(3);

        const clickLayerAndWait = async (
            index: number,
            snapshotNumber: string,
            snapshotLabel: string
        ) => {
            const target = layerItems.nth(index);
            const targetLayerId = await target.getAttribute('data-layer-id');
            expect(targetLayerId).toBeTruthy();

            await target.click();

            // Wait until layer switch animation is complete and selection settled
            await page.waitForFunction((expectedLayerId) => {
                const selected = document.querySelector(
                    '.editor-layers-list .editor-layer-item.selected[data-layer-id]'
                );
                const selectedLayerId = selected?.getAttribute('data-layer-id');
                const glyphCanvas = (window as any).glyphCanvas;
                const isAnimating =
                    !!glyphCanvas?.outlineEditor?.isLayerSwitchAnimating;
                return !isAnimating && selectedLayerId === expectedLayerId;
            }, targetLayerId);

            await page.waitForTimeout(300);

            console.log(
                `[Test] Taking snapshot ${snapshotNumber}: ${snapshotLabel}`
            );
            await takeSnapshot(page, snapshotNumber, snapshotLabel, expect);
        };

        // second layer
        await clickLayerAndWait(1, '14', 'layer-second-selected');
        // third layer
        await clickLayerAndWait(2, '15', 'layer-third-selected');
        // back to first layer
        await clickLayerAndWait(0, '16', 'layer-first-reselected');

        // Adjust variation setting via editor sidebar axis value input
        console.log('[Test] Setting variation axis value to 300');
        const axisValueInputs = page.locator(
            '.editor-axis-value[data-axis-tag]'
        );
        const axisInputCount = await axisValueInputs.count();
        expect(axisInputCount).toBeGreaterThan(0);

        const firstAxisValueInput = axisValueInputs.first();
        const firstAxisTag =
            await firstAxisValueInput.getAttribute('data-axis-tag');
        expect(firstAxisTag).toBeTruthy();

        await firstAxisValueInput.fill('300');
        await firstAxisValueInput.press('Enter');

        await page.waitForFunction((axisTag) => {
            const glyphCanvas = (window as any).glyphCanvas;
            const axisInput = document.querySelector(
                `.editor-axis-value[data-axis-tag="${axisTag}"]`
            ) as HTMLInputElement | null;
            const inputValue = axisInput?.value;
            const isAnimating = !!glyphCanvas?.axesManager?.isAnimating;
            return !isAnimating && inputValue === '300';
        }, firstAxisTag);
        await page.waitForTimeout(200);

        // SNAPSHOT POINT 17: Variation set to 300
        console.log('[Test] Taking snapshot 17: variation 300');
        await takeSnapshot(page, '17', 'variation-300', expect);

        console.log('[Test] Setting variation axis value to 400');
        await firstAxisValueInput.fill('400');
        await firstAxisValueInput.press('Enter');

        await page.waitForFunction((axisTag) => {
            const glyphCanvas = (window as any).glyphCanvas;
            const axisInput = document.querySelector(
                `.editor-axis-value[data-axis-tag="${axisTag}"]`
            ) as HTMLInputElement | null;
            const inputValue = axisInput?.value;
            const isAnimating = !!glyphCanvas?.axesManager?.isAnimating;
            return !isAnimating && inputValue === '400';
        }, firstAxisTag);
        await page.waitForTimeout(200);

        // SNAPSHOT POINT 18: Variation set to 400
        console.log('[Test] Taking snapshot 18: variation 400');
        await takeSnapshot(page, '18', 'variation-400', expect);

        console.log('[Test] Test complete');
    });

    // test('adjust variation axes', async ({ page }) => {
    //     // Load font
    //     await page
    //         .getByRole('button', { name: 'folder_open Open' })
    //         .first()
    //         .click();
    //     await waitForFontLoaded(page);

    //     // SNAPSHOT: Before axis change
    //     const snapshot1 = await captureSnapshot(page, 'before-axis-change');
    //     expect(snapshot1).toMatchSnapshot('axis-01-before.json');

    //     // Find and adjust an axis slider (adjust selector based on your UI)
    //     const slider = page.locator('.axis-slider').first();
    //     if ((await slider.count()) > 0) {
    //         await slider.fill('500'); // Adjust to middle value

    //         // Wait for interpolation to complete
    //         await page.waitForTimeout(500);

    //         // SNAPSHOT: After axis change
    //         const snapshot2 = await captureSnapshot(page, 'after-axis-change');
    //         expect(snapshot2).toMatchSnapshot('axis-02-after.json');
    //         expect(snapshot2.axisLocations).not.toEqual(
    //             snapshot1.axisLocations
    //         );
    //         expect(snapshot2.canvasSVG).toMatchSnapshot('axis-02-canvas.svg');
    //     }
    // });

    // test('toggle OpenType features', async ({ page }) => {
    //     // Load font
    //     await page
    //         .getByRole('button', { name: 'folder_open Open' })
    //         .first()
    //         .click();
    //     await waitForFontLoaded(page);

    //     const snapshot1 = await captureSnapshot(page, 'before-feature-toggle');
    //     expect(snapshot1).toMatchSnapshot('feature-01-before.json');

    //     // Toggle a feature (adjust selector based on your UI)
    //     await page.getByRole('button', { name: 'ss04' }).click();

    //     const snapshot2 = await captureSnapshot(page, 'after-feature-toggle');
    //     expect(snapshot2).toMatchSnapshot('feature-02-after.json');
    // });
});
