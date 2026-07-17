import { chromium } from '@playwright/test';
import worktreeConfig from '../worktree-config.cjs';

import {
    copyFile,
    ensureOutputDirs,
    manifestPath,
    rawVideoPath,
    readJson,
    videoDir,
    wait,
    writeJson
} from './tutorial-utils.mjs';

const VIEWPORT = { width: 1920, height: 1080 };
const { getWorktreeAppUrl } = worktreeConfig;
const TUTORIAL_URL = getWorktreeAppUrl('/?test=true');

const cursorState = {
    x: 0,
    y: 0,
    mode: 'pointer',
    labels: [],
    visible: false
};

async function waitForCanvasReady(page) {
    await page.waitForFunction(
        () => {
            const loadingOverlay = document.getElementById('loading-overlay');
            return (
                loadingOverlay && loadingOverlay.classList.contains('hidden')
            );
        },
        { timeout: 20000 }
    );

    await page.waitForFunction(
        () =>
            Boolean(
                window.glyphCanvas &&
                window.glyphCanvas.canvas &&
                window.glyphCanvas.renderer
            ),
        { timeout: 10000 }
    );
}

async function waitForFontLoaded(page) {
    await page.waitForFunction(
        () => {
            const currentFont = window.fontManager?.currentFont;
            return Boolean(
                currentFont &&
                (window.currentFontModel || currentFont.fontModel)
            );
        },
        { timeout: 20000 }
    );

    await page.waitForTimeout(250);
}

async function waitForOpenSessionReady(page, expectedFilename) {
    if (expectedFilename) {
        await page.waitForFunction(
            (filename) => {
                const editorFile =
                    window.stateManager?.getStateSnapshot?.()?.state
                        ?.editor_file || '';
                return editorFile.includes(filename);
            },
            expectedFilename,
            { timeout: 20000 }
        );
    }

    await page.waitForFunction(
        () => {
            const startupReleasedMarkCount = performance.getEntriesByName(
                'cp:font.lifecycle.startupReleased'
            ).length;
            const startupBlocked =
                window.autoCompileManager?.getStatus?.()?.isStartupBlocked;

            return startupReleasedMarkCount > 0 && startupBlocked === false;
        },
        { timeout: 30000 }
    );

    await page.waitForTimeout(250);
}

async function loadFustat(page) {
    await page.keyboard.press('Meta+Shift+F');
    await page.waitForTimeout(250);
    await page.getByText('Fustat.glyphs').first().dblclick();
    await waitForFontLoaded(page);
    await waitForOpenSessionReady(page, 'Fustat.glyphs');
}

async function selectGlyphNAndRegular(page) {
    await page.evaluate(async () => {
        const glyphCanvas = window.glyphCanvas;
        glyphCanvas.textRunEditor.setTextBuffer('n');
        await glyphCanvas.textRunEditor.selectGlyphByIndex(0, true);

        const sortedLayers = glyphCanvas.getSortedLayers();
        const regularLayer = sortedLayers[1] || sortedLayers[0] || null;

        const weightAxis = window.currentFontModel?.axes?.find((axis) => {
            const tag = axis?.tag || '';
            const name = axis?.name?.en || axis?.name || '';
            return tag === 'wght' || /^weight$/i.test(String(name).trim());
        });

        if (glyphCanvas.axesManager && weightAxis?.tag) {
            glyphCanvas.axesManager.setAxisValue(weightAxis.tag, 400);
            glyphCanvas.axesManager.updateAxisSliders?.();
        }

        if (window.stateManager && weightAxis?.tag) {
            window.stateManager.editor_variation_location = {
                ...(window.stateManager.editor_variation_location || {}),
                [weightAxis.tag]: 400
            };
        }

        const regularMasterId =
            regularLayer?.master?.id || regularLayer?.master || null;
        if (regularMasterId) {
            glyphCanvas.textRunEditor.selectedMasterId = regularMasterId;
        }

        if (regularLayer) {
            await glyphCanvas.outlineEditor.selectLayer(regularLayer);
        }

        await glyphCanvas.textRunEditor.shapeText?.();
        glyphCanvas.render();
    });

    await page.waitForTimeout(500);
}

async function prepareRecordingState(page) {
    await page.evaluate(() => {
        if (window.themeSwitcher?.setTheme) {
            window.themeSwitcher.setTheme('light');
        } else {
            document.documentElement.setAttribute('data-theme', 'light');
        }

        window.glyphCanvas?.outlineEditor?.setGuidelinesVisible?.(false);

        if (window.glyphCanvas?.outlineEditor) {
            window.glyphCanvas.outlineEditor.renderVerticalMetrics = null;
        }

        if (window.glyphCanvas?.renderer?.drawEditingMetricsUnderlay) {
            window.glyphCanvas.renderer.drawEditingMetricsUnderlay = () => {};
        }

        window.glyphCanvas?.render?.();
    });

    await page.waitForTimeout(250);
}

async function injectRecordingLayout(page) {
    await page.evaluate(() => {
        if (document.getElementById('tutorial-recording-style')) {
            return;
        }

        const style = document.createElement('style');
        style.id = 'tutorial-recording-style';
        style.textContent = `
            html,
            body {
                width: 100%;
                height: 100%;
                overflow: hidden !important;
                background:
                    radial-gradient(circle at 18% 18%, rgba(122, 169, 212, 0.16), transparent 28%),
                    radial-gradient(circle at 84% 78%, rgba(222, 168, 97, 0.14), transparent 24%),
                    #f5f0e8;
            }

            * {
                cursor: none !important;
            }

            .toolbar,
            #view-fontinfo,
            #view-overview,
            #view-files,
            #view-assistant,
            #view-scripts,
            #view-console,
            #view-history,
            .divider,
            .bottom-row,
            #settings-panel,
            #diff-review-modal,
            #editor-stack-preview-menu-btn,
            #editor-plugins-dropdown-btn,
            .editor-plugins-toggle,
            #view-editor .view-title-bar,
            #view-editor .view-sidebar-left,
            #view-editor .view-sidebar-right,
            #view-editor .editor-left-sidebar,
            #view-editor .editor-right-sidebar {
                display: none !important;
            }

            .container,
            .top-row {
                position: fixed !important;
                inset: 0 !important;
                width: 100vw !important;
                height: 100vh !important;
                padding: 0 !important;
                margin: 0 !important;
                display: block !important;
                background: transparent !important;
            }

            #view-editor {
                position: absolute !important;
                inset: 0 !important;
                width: 100vw !important;
                height: 100vh !important;
                margin: 0 !important;
                border: 0 !important;
                border-radius: 0 !important;
                box-shadow: none !important;
                background: transparent !important;
            }

            #view-editor .view-content {
                width: 100% !important;
                height: 100% !important;
                padding: 0 !important;
            }

            #tutorial-overlay {
                position: fixed;
                inset: 0;
                pointer-events: none;
                z-index: 2147483647;
                color: #1e1a15;
            }

            .tutorial-scene-cue {
                position: absolute;
                left: 50%;
                bottom: 72px;
                width: min(700px, calc(100vw - 120px));
                padding: 18px 24px 20px;
                border-radius: 20px;
                background: rgba(255, 250, 244, 0.92);
                border: 1px solid rgba(71, 58, 43, 0.12);
                backdrop-filter: blur(16px);
                opacity: 0;
                transform: translate(-50%, 12px);
                transition: opacity 180ms ease, transform 180ms ease;
                text-align: center;
            }

            .tutorial-scene-cue.visible {
                opacity: 1;
                transform: translate(-50%, 0);
            }

            .tutorial-scene-title {
                margin: 0;
                font: 400 34px/1.12 'Inter', sans-serif;
                letter-spacing: 0;
            }

            .tutorial-scene-subtitle {
                margin: 10px 0 0;
                font: 400 17px/1.35 'Inter', sans-serif;
                letter-spacing: 0;
                color: rgba(47, 35, 25, 0.72);
            }

            .tutorial-cursor-layer {
                position: absolute;
                inset: 0;
            }

            .tutorial-cursor {
                position: absolute;
                left: 0;
                top: 0;
                width: 28px;
                height: 36px;
                transform: translate(-2px, -2px);
                opacity: 0;
                transition: opacity 100ms linear;
            }

            .tutorial-cursor.visible {
                opacity: 1;
            }

            .tutorial-cursor-shape {
                width: 100%;
                height: 100%;
                display: block;
                object-fit: contain;
                filter: drop-shadow(0 1px 0 rgba(0, 0, 0, 0.28));
            }

            .tutorial-cursor.crosshair {
                width: 38px;
                height: 38px;
                transform: translate(-19px, -19px);
            }

            .tutorial-cursor.crosshair .tutorial-cursor-shape {
                filter: none;
            }

            .tutorial-cursor-labels {
                position: absolute;
                left: 42px;
                top: 0;
                display: flex;
                gap: 8px;
            }

            .tutorial-click-flash {
                position: absolute;
                left: 0;
                top: 0;
                width: auto;
                height: 38px;
                display: block;
                opacity: 0;
            }

            .tutorial-click-flash.visible {
                opacity: 1;
            }

            .tutorial-cursor.crosshair .tutorial-cursor-labels {
                left: 46px;
                top: 6px;
            }

            .tutorial-cursor-label {
                padding: 8px 10px;
                border-radius: 10px;
                background: rgba(255, 250, 244, 0.98);
                border: 1px solid rgba(71, 58, 43, 0.14);
                color: #1c1814;
                font: 600 16px/1 'Inter', sans-serif;
                letter-spacing: 0;
            }
        `;
        document.head.appendChild(style);

        const overlay = document.createElement('div');
        overlay.id = 'tutorial-overlay';
        overlay.innerHTML = `
            <div class="tutorial-scene-cue" id="tutorial-scene-cue">
                <h2 class="tutorial-scene-title" id="tutorial-scene-title"></h2>
                <p class="tutorial-scene-subtitle" id="tutorial-scene-subtitle"></p>
            </div>
            <div class="tutorial-cursor-layer">
                <div class="tutorial-cursor" id="tutorial-cursor">
                    <img
                        class="tutorial-cursor-shape"
                        id="tutorial-cursor-shape"
                        src="/assets/tutorial-cursors/pointer.svg"
                        alt=""
                    />
                    <img
                        class="tutorial-click-flash"
                        id="tutorial-click-flash"
                        src="/assets/tutorial-cursors/click.svg"
                        alt=""
                    />
                    <div class="tutorial-cursor-labels" id="tutorial-cursor-labels"></div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        window.__tutorialOverlay = {
            setScene(title, subtitle) {
                document.getElementById('tutorial-scene-title').textContent =
                    title || '';
                document.getElementById('tutorial-scene-subtitle').textContent =
                    subtitle || '';
                document
                    .getElementById('tutorial-scene-cue')
                    .classList.add('visible');
            },
            clearScene() {
                document
                    .getElementById('tutorial-scene-cue')
                    .classList.remove('visible');
            },
            setCursor(cursor) {
                const root = document.getElementById('tutorial-cursor');
                const shape = document.getElementById('tutorial-cursor-shape');
                const labelsRoot = document.getElementById(
                    'tutorial-cursor-labels'
                );

                root.style.left = `${cursor?.x || 0}px`;
                root.style.top = `${cursor?.y || 0}px`;
                root.classList.toggle('visible', Boolean(cursor?.visible));
                root.classList.toggle(
                    'crosshair',
                    cursor?.mode === 'crosshair'
                );
                shape.setAttribute(
                    'src',
                    cursor?.mode === 'crosshair'
                        ? '/assets/tutorial-cursors/crosshair.svg'
                        : '/assets/tutorial-cursors/pointer.svg'
                );

                labelsRoot.innerHTML = '';
                for (const label of cursor?.labels || []) {
                    const el = document.createElement('div');
                    el.className = 'tutorial-cursor-label';
                    el.textContent = label;
                    labelsRoot.appendChild(el);
                }
            },
            setClickFlash(variant, visible) {
                const flash = document.getElementById('tutorial-click-flash');
                if (variant) {
                    flash.setAttribute(
                        'src',
                        variant === 'doubleclick'
                            ? '/assets/tutorial-cursors/doubleclick.svg'
                            : '/assets/tutorial-cursors/click.svg'
                    );
                }

                const rect = flash.getBoundingClientRect();
                const width = Math.ceil(rect.width || flash.naturalWidth || 0);
                const height = Math.ceil(
                    rect.height || flash.naturalHeight || 0
                );
                const offsetX = 10;
                const offsetY = 10;
                flash.style.left = `${-(width + offsetX)}px`;
                flash.style.top = `${-(height + offsetY)}px`;
                flash.classList.toggle('visible', Boolean(visible));
            }
        };
    });

    await page.evaluate(() => {
        window.focusView?.('view-editor');
        window.dispatchEvent(new Event('resize'));
        window.glyphCanvas?.onResize?.();
        window.glyphCanvas?.render?.();
    });

    await page.waitForTimeout(400);
}

async function updateCursor(page, partial = {}) {
    Object.assign(cursorState, partial);
    await page.evaluate((payload) => {
        window.__tutorialOverlay?.setCursor(payload);
    }, cursorState);
}

async function hideCursor(page) {
    await updateCursor(page, {
        visible: false,
        labels: [],
        mode: 'pointer'
    });
}

async function moveCursor(page, x, y, options = {}) {
    const steps = Math.max(1, options.steps || 14);
    const startX = Number(cursorState.x || x);
    const startY = Number(cursorState.y || y);
    const mode = options.mode || cursorState.mode;

    for (let index = 1; index <= steps; index += 1) {
        const progress = index / steps;
        const nextX = startX + (x - startX) * progress;
        const nextY = startY + (y - startY) * progress;
        await page.mouse.move(nextX, nextY);
        await updateCursor(page, {
            x: nextX,
            y: nextY,
            visible: true,
            mode
        });
    }

    if (options.pauseMs) {
        await page.waitForTimeout(options.pauseMs);
    }
}

async function clickAt(page, x, y, options = {}) {
    await moveCursor(page, x, y, options);
    const variant = options.clickCount === 2 ? 'doubleclick' : 'click';
    await page.mouse.click(x, y, {
        delay: options.delayMs || 80,
        clickCount: options.clickCount || 1
    });
    await flashClick(page, variant, options.clickCount === 2 ? 2 : 1);

    if (options.afterMs) {
        await page.waitForTimeout(options.afterMs);
    }
}

async function flashClick(page, variant, times = 1) {
    for (let index = 0; index < times; index += 1) {
        await page.evaluate(
            (payload) => {
                window.__tutorialOverlay?.setClickFlash(payload.variant, true);
            },
            { variant }
        );
        await page.waitForTimeout(120);
        await page.evaluate(() => {
            window.__tutorialOverlay?.setClickFlash(null, false);
        });
        if (index < times - 1) {
            await page.waitForTimeout(55);
        }
    }
}

async function setModifier(page, key, label, active, mode = 'crosshair') {
    if (active) {
        await page.keyboard.down(key);
        const labels = [...cursorState.labels];
        if (!labels.includes(label)) {
            labels.push(label);
        }
        await updateCursor(page, { labels, mode });
        return;
    }

    await page.keyboard.up(key);
    const labels = cursorState.labels.filter((item) => item !== label);
    await updateCursor(page, {
        labels,
        mode: labels.length ? mode : 'pointer'
    });
}

async function showSceneOverlay(page, scene) {
    await page.evaluate((payload) => {
        window.__tutorialOverlay?.setScene(
            payload.cueTitle,
            payload.cueSubtitle
        );
    }, scene);
}

async function glyphToPage(page, glyphX, glyphY) {
    return page.evaluate(
        ({ x, y }) => {
            const glyphCanvas = window.glyphCanvas;
            const viewport = glyphCanvas.viewportManager;
            const canvas = glyphCanvas.canvas;
            const rect = canvas.getBoundingClientRect();
            const shapedGlyphs = glyphCanvas.textRunEditor.shapedGlyphs || [];
            const selectedGlyphIndex =
                glyphCanvas.textRunEditor.selectedGlyphIndex;

            let xAdvance = 0;
            for (let index = 0; index < selectedGlyphIndex; index += 1) {
                xAdvance += shapedGlyphs[index]?.ax || 0;
            }

            const selectedGlyph = shapedGlyphs[selectedGlyphIndex] || {
                dx: 0,
                dy: 0
            };
            const fontX = x + xAdvance + (selectedGlyph.dx || 0);
            const fontY = y + (selectedGlyph.dy || 0);
            const screen = viewport.fontToScreenCoordinates(fontX, fontY);

            return {
                x: rect.left + screen.x,
                y: rect.top + screen.y
            };
        },
        { x: glyphX, y: glyphY }
    );
}

function getSegmentPlan(nodes, closed) {
    const onCurves = [];
    for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (node.nodetype === 'OffCurve') {
            continue;
        }
        onCurves.push({
            ...node,
            originalNodeIndex: index,
            ordinal: onCurves.length
        });
    }

    const segments = [];
    const limit = closed ? onCurves.length : onCurves.length - 1;

    for (let ordinal = 0; ordinal < limit; ordinal += 1) {
        const start = onCurves[ordinal];
        const end = onCurves[(ordinal + 1) % onCurves.length];
        const between = [];
        let cursor = (start.originalNodeIndex + 1) % nodes.length;

        while (cursor !== end.originalNodeIndex) {
            between.push(nodes[cursor]);
            cursor = (cursor + 1) % nodes.length;
        }

        const controls = between.filter((node) => node.nodetype === 'OffCurve');
        segments.push({
            ordinal,
            start,
            end,
            controls,
            isCurve:
                controls.length > 0 ||
                end.nodetype === 'Curve' ||
                end.nodetype === 'QCurve'
        });
    }

    return {
        onCurves,
        segments,
        offCurves: nodes.filter((node) => node.nodetype === 'OffCurve')
    };
}

async function getTutorialGeometry(page) {
    return page.evaluate(() => {
        const layer = window.glyphCanvas.outlineEditor.getCurrentLayerModel();
        const paths = layer?.paths || [];
        if (!paths.length) {
            throw new Error('No paths found in the selected layer');
        }

        const normalizedPaths = paths
            .map((path) => ({
                nodes: (path.nodes || []).map((node) => ({
                    x: Number(node.x),
                    y: Number(node.y),
                    nodetype: node.nodetype,
                    smooth: Boolean(node.smooth)
                }))
            }))
            .filter((path) => path.nodes.length > 0);

        const bestPath = normalizedPaths.reduce((best, current) => {
            const xs = current.nodes.map((node) => node.x);
            const ys = current.nodes.map((node) => node.y);
            const width = Math.max(...xs) - Math.min(...xs);
            const height = Math.max(...ys) - Math.min(...ys);
            const score = width * height + current.nodes.length;
            if (!best || score > best.score) {
                return { nodes: current.nodes, score };
            }
            return best;
        }, null);

        if (!bestPath?.nodes?.length) {
            throw new Error(
                'Could not determine a reference path from the selected layer'
            );
        }

        const xs = bestPath.nodes.map((node) => node.x);
        const ys = bestPath.nodes.map((node) => node.y);
        const bounds = {
            minX: Math.min(...xs),
            maxX: Math.max(...xs),
            minY: Math.min(...ys),
            maxY: Math.max(...ys)
        };
        const duplicateOffsetX = bounds.maxX - bounds.minX + 220;

        return {
            bounds,
            closed: true,
            nodes: bestPath.nodes,
            duplicateOffsetX,
            compositeBounds: {
                minX: bounds.minX - 80,
                maxX: bounds.maxX + duplicateOffsetX + 80,
                minY: bounds.minY - 120,
                maxY: bounds.maxY + 120
            }
        };
    });
}

async function frameGlyphBounds(page, bounds) {
    await page.evaluate((targetBounds) => {
        const glyphCanvas = window.glyphCanvas;
        const viewport = glyphCanvas.viewportManager;
        const canvas = glyphCanvas.canvas;
        const rect = canvas.getBoundingClientRect();
        const margin = 90;
        const width = Math.max(1, targetBounds.maxX - targetBounds.minX);
        const height = Math.max(1, targetBounds.maxY - targetBounds.minY);
        const centerX = (targetBounds.minX + targetBounds.maxX) / 2;
        const centerY = (targetBounds.minY + targetBounds.maxY) / 2;
        const scaleX = (rect.width - margin * 2) / width;
        const scaleY = (rect.height - margin * 2) / height;
        const scale = Math.min(scaleX, scaleY);

        viewport.scale = scale;
        viewport.panX = rect.width / 2 - centerX * scale;
        viewport.panY = rect.height / 2 + centerY * scale;
        glyphCanvas.render();
    }, bounds);

    await page.waitForTimeout(250);
}

async function drawDuplicatePath(page, geometry) {
    const plan = getSegmentPlan(geometry.nodes, geometry.closed);
    const duplicatePoints = plan.onCurves.map((node) => ({
        x: node.x + geometry.duplicateOffsetX,
        y: node.y
    }));

    await setModifier(page, 'Meta', 'cmd', true);
    const firstScreen = await glyphToPage(
        page,
        duplicatePoints[0].x,
        duplicatePoints[0].y
    );
    await moveCursor(page, firstScreen.x, firstScreen.y, {
        steps: 18,
        pauseMs: 160,
        mode: 'crosshair'
    });

    for (const point of duplicatePoints) {
        const screen = await glyphToPage(page, point.x, point.y);
        await clickAt(page, screen.x, screen.y, {
            steps: 14,
            delayMs: 90,
            afterMs: 220,
            mode: 'crosshair'
        });
    }

    await clickAt(page, firstScreen.x, firstScreen.y, {
        steps: 14,
        delayMs: 90,
        afterMs: 300,
        mode: 'crosshair'
    });
    await setModifier(page, 'Meta', 'cmd', false);
    await page.waitForTimeout(220);
}

async function getDuplicatePathIndex(page) {
    return page.evaluate(() => {
        const layer = window.glyphCanvas.outlineEditor.getCurrentLayerModel();
        return (layer.paths?.length || 1) - 1;
    });
}

async function convertDuplicateSegments(page, geometry) {
    const plan = getSegmentPlan(geometry.nodes, geometry.closed);
    const curveSegments = plan.segments.filter((segment) => segment.isCurve);

    await setModifier(page, 'Alt', 'option', true);
    for (const segment of curveSegments) {
        const midpoint = {
            x:
                geometry.duplicateOffsetX +
                (segment.start.x + segment.end.x) / 2,
            y: (segment.start.y + segment.end.y) / 2
        };
        const screen = await glyphToPage(page, midpoint.x, midpoint.y);
        await clickAt(page, screen.x, screen.y, {
            steps: 14,
            delayMs: 90,
            afterMs: 320,
            mode: 'crosshair'
        });
    }
    await setModifier(page, 'Alt', 'option', false);
}

async function smoothDuplicatePoints(page, geometry) {
    const plan = getSegmentPlan(geometry.nodes, geometry.closed);
    const smoothPoints = plan.onCurves.filter((node) => node.smooth);

    for (const node of smoothPoints) {
        const screen = await glyphToPage(
            page,
            node.x + geometry.duplicateOffsetX,
            node.y
        );
        await clickAt(page, screen.x, screen.y, {
            steps: 14,
            delayMs: 80,
            clickCount: 2,
            afterMs: 260,
            mode: 'pointer'
        });
    }
}

async function dragGlyphPoint(page, fromPoint, toPoint) {
    const start = await glyphToPage(page, fromPoint.x, fromPoint.y);
    const end = await glyphToPage(page, toPoint.x, toPoint.y);
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const dragSteps = Math.max(4, Math.min(7, Math.round(distance / 28)));

    await moveCursor(page, start.x, start.y, {
        steps: 6,
        pauseMs: 10,
        mode: 'pointer'
    });
    await page.mouse.down();
    const flashPromise = flashClick(page, 'click', 1);
    await page.waitForTimeout(45);
    await moveCursor(page, end.x, end.y, {
        steps: dragSteps,
        mode: 'pointer'
    });
    await flashPromise;
    await page.mouse.up();
    await page.waitForTimeout(15);
}

async function readDuplicateOffcurvePairs(page, duplicatePathIndex, geometry) {
    return page.evaluate(
        ({ pathIndex, originalOffCurves, duplicateOffsetX }) => {
            const layer =
                window.glyphCanvas.outlineEditor.getCurrentLayerModel();
            const path = layer.paths?.[pathIndex];
            const currentOffCurves = (path?.nodes || [])
                .filter((node) => node.nodetype === 'OffCurve')
                .map((node) => ({ x: Number(node.x), y: Number(node.y) }));

            return currentOffCurves.map((current, index) => ({
                current,
                target: {
                    x: Number(originalOffCurves[index].x) + duplicateOffsetX,
                    y: Number(originalOffCurves[index].y)
                }
            }));
        },
        {
            pathIndex: duplicatePathIndex,
            originalOffCurves: geometry.nodes.filter(
                (node) => node.nodetype === 'OffCurve'
            ),
            duplicateOffsetX: geometry.duplicateOffsetX
        }
    );
}

async function snapDuplicateHandlesToTargets(
    page,
    duplicatePathIndex,
    geometry
) {
    await page.evaluate(
        ({ pathIndex, originalOffCurves, duplicateOffsetX }) => {
            const layer =
                window.glyphCanvas.outlineEditor.getCurrentLayerModel();
            const path = layer.paths?.[pathIndex];
            if (!path) {
                return;
            }

            let offCurveIndex = 0;
            for (const node of path.nodes || []) {
                if (node.nodetype !== 'OffCurve') {
                    continue;
                }

                const source = originalOffCurves[offCurveIndex];
                if (!source) {
                    break;
                }

                node.x = Number(source.x) + duplicateOffsetX;
                node.y = Number(source.y);
                offCurveIndex += 1;
            }

            window.glyphCanvas.render?.();
        },
        {
            pathIndex: duplicatePathIndex,
            originalOffCurves: geometry.nodes.filter(
                (node) => node.nodetype === 'OffCurve'
            ),
            duplicateOffsetX: geometry.duplicateOffsetX
        }
    );
}

async function adjustDuplicateHandles(page, duplicatePathIndex, geometry) {
    for (let pass = 0; pass < 2; pass += 1) {
        const minimumDistance = pass === 0 ? 12 : 2;
        const pairs = (
            await readDuplicateOffcurvePairs(page, duplicatePathIndex, geometry)
        ).filter((pair) => {
            const deltaX = pair.target.x - pair.current.x;
            const deltaY = pair.target.y - pair.current.y;
            return Math.hypot(deltaX, deltaY) >= minimumDistance;
        });

        for (const pair of pairs) {
            await dragGlyphPoint(page, pair.current, pair.target);
        }
    }

    await snapDuplicateHandlesToTargets(page, duplicatePathIndex, geometry);
}

async function runScene(page, scene, action) {
    const startedAt = Date.now();
    await showSceneOverlay(page, scene);
    if (action) {
        await action();
    }

    const elapsedMs = Date.now() - startedAt;
    const targetMs = Math.max(scene.durationMs || 0, scene.minimumHoldMs || 0);
    if (elapsedMs < targetMs) {
        await wait(targetMs - elapsedMs);
    }
}

async function main() {
    ensureOutputDirs();

    const manifest = readJson(manifestPath);
    const sceneMap = new Map(manifest.scenes.map((scene) => [scene.id, scene]));
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: VIEWPORT,
        recordVideo: {
            dir: videoDir,
            size: VIEWPORT
        }
    });
    const page = await context.newPage();
    const video = page.video();

    const recordingStartedAt = Date.now();
    await page.goto(TUTORIAL_URL, { waitUntil: 'domcontentloaded' });
    await waitForCanvasReady(page);
    await loadFustat(page);
    await selectGlyphNAndRegular(page);
    await prepareRecordingState(page);
    await injectRecordingLayout(page);
    await page.keyboard.press('Meta+Shift+E');
    await page.keyboard.press('Meta+Shift+E');

    const geometry = await getTutorialGeometry(page);
    await frameGlyphBounds(page, geometry.compositeBounds);
    await hideCursor(page);

    const tutorialStartedAt = Date.now();
    let duplicatePathIndex = null;

    await runScene(page, sceneMap.get('01-intro'), async () => {
        await wait(1200);
    });

    await runScene(page, sceneMap.get('02-draw-lines'), async () => {
        await drawDuplicatePath(page, geometry);
        duplicatePathIndex = await getDuplicatePathIndex(page);
    });

    await runScene(page, sceneMap.get('03-convert-curves'), async () => {
        await convertDuplicateSegments(page, geometry);
    });

    await runScene(page, sceneMap.get('04-smooth-points'), async () => {
        await smoothDuplicatePoints(page, geometry);
    });

    await runScene(page, sceneMap.get('05-adjust-handles'), async () => {
        await adjustDuplicateHandles(page, duplicatePathIndex, geometry);
    });

    await runScene(page, sceneMap.get('06-wrap'), async () => {
        await hideCursor(page);
    });

    await page.evaluate(() => {
        window.__tutorialOverlay?.clearScene();
    });
    await page.waitForTimeout(600);
    const tutorialFinishedAt = Date.now();

    await context.close();
    const recordedPath = await video.path();
    copyFile(recordedPath, rawVideoPath);

    manifest.recordedVideoFile = rawVideoPath;
    manifest.recordedAt = new Date().toISOString();
    manifest.recordingTrimStartSeconds = Number(
        Math.max(
            0,
            (tutorialStartedAt - recordingStartedAt) / 1000 - 0.15
        ).toFixed(3)
    );
    manifest.recordedTutorialDurationSeconds = Number(
        ((tutorialFinishedAt - tutorialStartedAt) / 1000 + 0.6).toFixed(3)
    );
    writeJson(manifestPath, manifest);
    await browser.close();
    console.log(`Raw tutorial video written to ${rawVideoPath}`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
