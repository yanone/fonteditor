import { expect, test, type Page } from '@playwright/test';
import { focusView, waitForCanvasReady } from './helpers/snapshot-helper';
import { rectLineNodes } from './helpers/babelfont-test-data';

const GLYPHS_COMPONENT_ALIGNMENT_KEY = 'com.schriftgestalt.Glyphs.alignment';

type Translation = [number, number] | null;

function makeAutomaticAdieresisFont(): string {
    const component = (
        reference: string,
        translation: [number, number],
        order = 'RestOfTheWorld'
    ) => ({
        reference,
        transform: {
            translation,
            rotation: 0,
            scale: [1, 1],
            skew: [0, 0],
            order
        },
        format_specific: {
            [GLYPHS_COMPONENT_ALIGNMENT_KEY]: 1
        }
    });

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
                        id: 'M0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            {
                                nodes: rectLineNodes(
                                    0,
                                    0,
                                    600,
                                    0,
                                    600,
                                    700,
                                    0,
                                    700
                                ),
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
                name: 'a',
                category: 'Base',
                codepoints: [97],
                layers: [
                    {
                        width: 600,
                        id: 'M0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            {
                                nodes: rectLineNodes(
                                    120,
                                    0,
                                    480,
                                    0,
                                    480,
                                    520,
                                    120,
                                    520
                                ),
                                closed: true
                            }
                        ],
                        anchors: [{ name: 'top', x: 300, y: 720 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                exported: true
            },
            {
                name: 'dieresiscomb',
                category: 'Mark',
                codepoints: [776],
                layers: [
                    {
                        width: 300,
                        id: 'M0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            {
                                nodes: rectLineNodes(
                                    80,
                                    0,
                                    220,
                                    0,
                                    220,
                                    80,
                                    80,
                                    80
                                ),
                                closed: true
                            }
                        ],
                        anchors: [{ name: '_top', x: 150, y: 0 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                exported: true
            },
            {
                name: 'adieresis',
                category: 'Base',
                codepoints: [228],
                layers: [
                    {
                        width: 600,
                        id: 'M0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            component('a', [0, 0]),
                            component('dieresiscomb', [150, 720], 'Glyphs')
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
        names: { family_name: { dflt: 'AutomaticAdieresisAnchorBrowser' } },
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
        { json: fontJson, fontPath: path, initialTextBuffer: textBuffer }
    );
}

async function waitForBridgeReady(page: Page): Promise<void> {
    await page.waitForFunction(
        () =>
            !!(window as any).patchSyncEngine &&
            !!(window as any).currentFontModel,
        { timeout: 15000 }
    );
}

async function waitForEditingFontCompiled(page: Page): Promise<void> {
    await page.waitForFunction(
        () => !!(window as any).fontManager?.editingFont,
        { timeout: 30000 }
    );
}

async function openAutomaticAdieresisEditScenario(page: Page): Promise<void> {
    await page.goto('/?test=true');
    await waitForCanvasReady(page);
    await focusView(page, 'Meta+Shift+E', 'view-editor');

    await loadTestFont(
        page,
        makeAutomaticAdieresisFont(),
        'AutomaticAdieresisAnchorBrowser.babelfont',
        'aä'
    );
    await waitForBridgeReady(page);
    await waitForEditingFontCompiled(page);

    await page.evaluate(async () => {
        const win = window as any;
        const glyphCanvas = win.glyphCanvas;
        const fontManager = win.fontManager;

        fontManager.currentText = 'aä';
        fontManager.updateEditingSubsetSnapshot?.([
            'a',
            'adieresis',
            'dieresiscomb'
        ]);
        glyphCanvas.textRunEditor.setTextBuffer('aä');
        await glyphCanvas.textRunEditor.selectGlyphByIndex(0, true);
        glyphCanvas.outlineEditor.active = true;
        glyphCanvas.outlineEditor.currentGlyphName = 'a';
        await glyphCanvas.enterGlyphEditModeAtCursor?.();
        const firstLayer = glyphCanvas.getSortedLayers?.()[0] || null;
        if (firstLayer) {
            await glyphCanvas.outlineEditor.selectLayer(firstLayer);
        }
        await glyphCanvas.doUIUpdateAsync?.();
        glyphCanvas.render();
    });

    await page.waitForFunction(
        () => {
            const glyphCanvas = (window as any).glyphCanvas;
            return (
                glyphCanvas?.outlineEditor?.active === true &&
                glyphCanvas?.outlineEditor?.currentGlyphName === 'a' &&
                glyphCanvas?.textRunEditor?.selectedGlyphIndex === 0
            );
        },
        { timeout: 15000 }
    );
}

async function getTopAnchorClientPoint(page: Page): Promise<{
    x: number;
    y: number;
    anchorY: number;
}> {
    return page.evaluate(() => {
        const glyphCanvas = (window as any).glyphCanvas;
        const outlineEditor = glyphCanvas?.outlineEditor;
        const viewportManager = glyphCanvas?.viewportManager;
        const canvas = glyphCanvas?.canvas as HTMLCanvasElement | null;
        const textRunEditor = glyphCanvas?.textRunEditor;

        const layerData = outlineEditor?.getCurrentLayerDataFromStack?.();
        const topAnchor = layerData?.anchors?.find(
            (anchor: any) => anchor?.name === 'top'
        );
        if (!topAnchor || !canvas || !viewportManager || !textRunEditor) {
            throw new Error('Missing top anchor test dependencies');
        }

        const glyphPosition = textRunEditor._getGlyphPosition(
            textRunEditor.selectedGlyphIndex
        );
        const screen = viewportManager.fontToScreenCoordinates(
            glyphPosition.xPosition + glyphPosition.xOffset + topAnchor.x,
            glyphPosition.yOffset + topAnchor.y
        );
        const rect = canvas.getBoundingClientRect();

        return {
            x: rect.left + screen.x,
            y: rect.top + screen.y,
            anchorY: Number(topAnchor.y)
        };
    });
}

async function commitTopAnchorMoveThroughEditor(
    page: Page,
    deltaY: number
): Promise<void> {
    await page.evaluate(async (anchorDeltaY) => {
        const win = window as any;
        const glyphCanvas = win.glyphCanvas;
        const outlineEditor = glyphCanvas?.outlineEditor;
        const fontManager = win.fontManager;
        if (!glyphCanvas || !outlineEditor || !fontManager?.currentFont) {
            throw new Error('Missing editor dependencies for anchor move');
        }

        const layerData = outlineEditor.getCurrentLayerDataFromStack?.();
        const topAnchorIndex = layerData?.anchors?.findIndex(
            (anchor: any) => anchor?.name === 'top'
        );
        if (typeof topAnchorIndex !== 'number' || topAnchorIndex < 0) {
            throw new Error('Missing top anchor on active glyph');
        }

        const layerId = outlineEditor.getCurrentLayerId?.() || 'M0';
        outlineEditor.selectedLayerId = layerId;
        outlineEditor.selectedAnchors = [topAnchorIndex];
        outlineEditor.parseGlyphStack = () => [{ glyphName: 'a' }];
        glyphCanvas.getCurrentGlyphName = () => 'a';

        if (!outlineEditor.moveSelectedAnchors(0, anchorDeltaY)) {
            throw new Error('moveSelectedAnchors returned false');
        }

        outlineEditor._anchorAffectedGlyphNames =
            outlineEditor.rebuildAutomaticCompositesForCurrentEditedGlyph();
        fontManager.currentFont.syncJsonFromModel?.();

        const sourceTargets = [{ glyphName: 'a', layerId }];
        const closure = outlineEditor.computeRecompositionClosure?.({
            sourceTargets,
            editKinds: new Set(['anchor']),
            scope: 'all'
        });
        const replayTargets =
            Array.isArray(closure?.allTargets) && closure.allTargets.length > 0
                ? closure.allTargets
                : sourceTargets;

        outlineEditor._syncCurrentGlyphToYDoc(
            'Drag anchor',
            undefined,
            undefined,
            null,
            {
                changedLayerTargets: replayTargets,
                workerReplayTargets: replayTargets
            },
            {
                editSource: 'mouse-drag-anchor',
                changeSource: 'mouse-drag-anchor',
                editType: 'anchor'
            }
        );

        await fontManager.clearLiveDragPreview?.();
        glyphCanvas.render?.();
    }, deltaY);
}

async function dragTopAnchorThroughUi(page: Page, screenDeltaY: number) {
    const anchorPoint = await getTopAnchorClientPoint(page);
    await page.mouse.move(anchorPoint.x, anchorPoint.y);
    await page.waitForTimeout(50);
    const readMouseState = async (point: { x: number; y: number }) =>
        page.evaluate((currentPoint) => {
            const glyphCanvas = (window as any).glyphCanvas;
            const outlineEditor = glyphCanvas?.outlineEditor;
            const element = document.elementFromPoint(
                currentPoint.x,
                currentPoint.y
            );
            const rect = glyphCanvas?.canvas?.getBoundingClientRect?.();
            return {
                hoveredAnchorIndex: outlineEditor?.hoveredAnchorIndex ?? null,
                selectedAnchors: outlineEditor?.selectedAnchors ?? [],
                isDraggingAnchor: outlineEditor?.isDraggingAnchor ?? false,
                currentGlyphName: outlineEditor?.currentGlyphName ?? null,
                active: outlineEditor?.active ?? false,
                selectedGlyphIndex:
                    glyphCanvas?.textRunEditor?.selectedGlyphIndex ?? null,
                lastMouseX: glyphCanvas?.lastMouseX ?? null,
                lastMouseY: glyphCanvas?.lastMouseY ?? null,
                canvasRect: rect
                    ? {
                          left: rect.left,
                          top: rect.top,
                          right: rect.right,
                          bottom: rect.bottom,
                          width: rect.width,
                          height: rect.height
                      }
                    : null,
                elementAtPoint: element
                    ? {
                          tagName: element.tagName,
                          id: element.id,
                          className: String(element.className || '')
                      }
                    : null
            };
        }, point);

    const offsets: Array<[number, number]> = [];
    for (const offsetY of [0, 20, -20, 40, -40, 80, -80, 120, -120, 160]) {
        for (const offsetX of [0, 20, -20, 40, -40, 80, -80, 120, -120]) {
            offsets.push([offsetX, offsetY]);
        }
    }
    const attempts: any[] = [];
    let dragPoint: { x: number; y: number } | null = null;

    for (const [offsetX, offsetY] of offsets) {
        const candidate = {
            x: anchorPoint.x + offsetX,
            y: anchorPoint.y + offsetY
        };
        await page.mouse.move(candidate.x, candidate.y);
        await page.waitForTimeout(25);
        const hoverState = await readMouseState(candidate);
        if (hoverState.hoveredAnchorIndex !== 0) {
            attempts.push({ candidate, hoverState, dragState: null });
            continue;
        }
        await page.mouse.down();
        await page.waitForTimeout(100);
        const dragState = await readMouseState(candidate);
        await page.mouse.up();
        attempts.push({ candidate, hoverState, dragState });
        if (dragState.isDraggingAnchor) {
            dragPoint = candidate;
            break;
        }
    }

    expect(dragPoint, JSON.stringify({ anchorPoint, attempts })).toBeTruthy();

    await page.mouse.move(dragPoint!.x, dragPoint!.y);
    await page.waitForTimeout(25);
    const hoverState = await readMouseState(dragPoint!);
    expect(
        hoverState.hoveredAnchorIndex,
        JSON.stringify({ anchorPoint, dragPoint, hoverState, attempts })
    ).toBe(0);
    await page.mouse.down();
    await page.waitForFunction(
        () =>
            (window as any).glyphCanvas?.outlineEditor?.isDraggingAnchor ===
            true,
        null,
        { timeout: 5000 }
    );
    const dragState = await readMouseState(dragPoint!);
    expect(
        dragState.isDraggingAnchor,
        JSON.stringify({ anchorPoint, dragPoint, hoverState, dragState })
    ).toBe(true);
    await page.mouse.move(dragPoint!.x, dragPoint!.y + screenDeltaY, {
        steps: 10
    });
    await page.mouse.up();

    await page.waitForFunction(
        ({ previousAnchorY }) => {
            const glyphCanvas = (window as any).glyphCanvas;
            const layerData =
                glyphCanvas?.outlineEditor?.getCurrentLayerDataFromStack?.();
            const topAnchor = layerData?.anchors?.find(
                (anchor: any) => anchor?.name === 'top'
            );
            return Number(topAnchor?.y || 0) !== previousAnchorY;
        },
        { previousAnchorY: anchorPoint.anchorY },
        { timeout: 15000 }
    );

    return getTopAnchorClientPoint(page);
}

async function commitExplicitAdieresisLayerSetThroughBridge(
    page: Page,
    nextMarkTranslation: [number, number]
): Promise<void> {
    await page.evaluate((translation) => {
        const clone = (value: any) => JSON.parse(JSON.stringify(value));
        const win = window as any;
        const bridge = win.patchSyncEngine;
        const fontJson = bridge?.getFontJsonSnapshot?.();
        const layerId = win.currentFontModel?.findGlyph?.('a')?.layers?.[0]?.id;
        if (!bridge?.syncLayerSnapshotsFromJson || !fontJson || !layerId) {
            throw new Error('Missing bridge state for explicit layer set');
        }

        const sourceGlyph = fontJson.glyphs?.find(
            (glyph: any) => glyph?.name === 'a'
        );
        const adieresisGlyph = fontJson.glyphs?.find(
            (glyph: any) => glyph?.name === 'adieresis'
        );
        const sourceLayer = clone(
            sourceGlyph?.layers?.find((layer: any) => layer?.id === layerId)
        );
        const adieresisLayer = clone(
            adieresisGlyph?.layers?.find((layer: any) => layer?.id === layerId)
        );
        if (!sourceLayer || !adieresisLayer) {
            throw new Error('Missing source or adieresis layer for layer set');
        }

        const topAnchor = sourceLayer.anchors?.find(
            (anchor: any) => anchor?.name === 'top'
        );
        if (topAnchor) {
            topAnchor.y = Number(topAnchor.y || 0) + 80;
        }

        const markComponent = adieresisLayer.shapes?.find(
            (shape: any) => shape?.reference === 'dieresiscomb'
        );
        if (!markComponent?.transform) {
            throw new Error('Missing adieresis mark component transform');
        }
        markComponent.transform.translation = translation;

        const replayTargets = [
            { glyphName: 'a', layerId },
            { glyphName: 'adieresis', layerId }
        ];
        bridge.syncLayerSnapshotsFromJson(
            [
                { glyphName: 'a', layerId, layerJson: sourceLayer },
                {
                    glyphName: 'adieresis',
                    layerId,
                    layerJson: adieresisLayer
                }
            ],
            'Drag anchor',
            undefined,
            undefined,
            null,
            replayTargets,
            'mouse-drag-anchor',
            'mouse-drag-anchor',
            'anchor'
        );
    }, nextMarkTranslation);
}

function getLayer(fontJson: any, glyphName: string, layerId: string): any {
    return fontJson?.glyphs
        ?.find((glyph: any) => glyph?.name === glyphName)
        ?.layers?.find((layer: any) => layer?.id === layerId);
}

function getComponentTranslationFromLayer(
    layer: any,
    reference: string
): Translation {
    const shape = layer?.shapes?.find(
        (candidate: any) => candidate?.reference === reference
    );
    const transform = shape?.transform;
    if (Array.isArray(transform)) {
        return [Number(transform[4]), Number(transform[5])];
    }
    if (Array.isArray(transform?.translation)) {
        return [
            Number(transform.translation[0]),
            Number(transform.translation[1])
        ];
    }
    return null;
}

async function getAdieresisCommitState(page: Page): Promise<{
    layerId: string;
    bridgeTranslation: Translation;
    storedTranslation: Translation;
    modelTranslation: Translation;
    entryNewTranslation: Translation;
    entryOldTranslation: Translation;
    workerYDocTranslation: Translation;
    workerCanonicalTranslation: Translation;
    workerSubsetTranslation: Translation;
    recentLayerEntry: any;
}> {
    return page.evaluate(async () => {
        const getLayer = (fontJson: any, glyphName: string, layerId: string) =>
            fontJson?.glyphs
                ?.find((glyph: any) => glyph?.name === glyphName)
                ?.layers?.find((layer: any) => layer?.id === layerId);
        const getTranslation = (layer: any, reference: string) => {
            const shape = layer?.shapes?.find(
                (candidate: any) => candidate?.reference === reference
            );
            const transform = shape?.transform;
            if (Array.isArray(transform)) {
                return [Number(transform[4]), Number(transform[5])];
            }
            if (Array.isArray(transform?.translation)) {
                return [
                    Number(transform.translation[0]),
                    Number(transform.translation[1])
                ];
            }
            return null;
        };

        const win = window as any;
        const fontModel = win.currentFontModel;
        const currentFont = win.fontManager?.currentFont;
        const layerId = fontModel?.findGlyph?.('a')?.layers?.[0]?.id;
        if (!layerId) {
            throw new Error('Could not resolve test layer id');
        }

        const bridgeJson = win.patchSyncEngine?.getFontJsonSnapshot?.();
        const bridgeLayer = getLayer(bridgeJson, 'adieresis', layerId);
        const storedLayer = getLayer(
            currentFont?.babelfontData,
            'adieresis',
            layerId
        );
        const modelLayer = fontModel
            ?.findGlyph?.('adieresis')
            ?.findLayerById?.(layerId)
            ?.toJSON?.();
        const workerResponse = await win.fontCompilation?.sendMessage?.({
            type: 'dumpLayerState',
            layerTargets: [{ glyphName: 'adieresis', layerId }]
        });
        if (workerResponse?.error) {
            throw new Error(workerResponse.error);
        }
        const workerDump = workerResponse?.dumpJson
            ? JSON.parse(workerResponse.dumpJson)
            : null;
        const workerTarget = Array.isArray(workerDump?.targets)
            ? workerDump.targets.find(
                  (target: any) => target?.glyphName === 'adieresis'
              )
            : null;
        const recentEntries = win.patchSyncEngine?.getChangeLog?.() || [];
        const recentLayerEntry = recentEntries
            .slice()
            .reverse()
            .find(
                (entry: any) =>
                    (entry?.path === `glyphs.adieresis:layers.${layerId}:` ||
                        entry?.path === `glyphs.adieresis:layers.${layerId}`) &&
                    entry?.newValue?.shapes
            );
        const recentTranslationXEntry = recentEntries
            .slice()
            .reverse()
            .find(
                (entry: any) =>
                    entry?.path ===
                    `glyphs.adieresis:layers.${layerId}:shapes.1.transform.translation.0`
            );
        const recentTranslationYEntry = recentEntries
            .slice()
            .reverse()
            .find(
                (entry: any) =>
                    entry?.path ===
                    `glyphs.adieresis:layers.${layerId}:shapes.1.transform.translation.1`
            );
        const entryNewTranslation = recentLayerEntry?.newValue?.shapes
            ? getTranslation(recentLayerEntry.newValue, 'dieresiscomb')
            : typeof recentTranslationXEntry?.newValue === 'number' &&
                typeof recentTranslationYEntry?.newValue === 'number'
              ? [
                    recentTranslationXEntry.newValue,
                    recentTranslationYEntry.newValue
                ]
              : null;
        const entryOldTranslation = recentLayerEntry?.oldValue?.shapes
            ? getTranslation(recentLayerEntry.oldValue, 'dieresiscomb')
            : typeof recentTranslationXEntry?.oldValue === 'number' &&
                typeof recentTranslationYEntry?.oldValue === 'number'
              ? [
                    recentTranslationXEntry.oldValue,
                    recentTranslationYEntry.oldValue
                ]
              : null;

        return {
            layerId,
            bridgeTranslation: getTranslation(bridgeLayer, 'dieresiscomb'),
            storedTranslation: getTranslation(storedLayer, 'dieresiscomb'),
            modelTranslation: getTranslation(modelLayer, 'dieresiscomb'),
            entryNewTranslation,
            entryOldTranslation,
            workerYDocTranslation: getTranslation(
                workerTarget?.ydocLayer,
                'dieresiscomb'
            ),
            workerCanonicalTranslation: getTranslation(
                workerTarget?.canonicalLayer,
                'dieresiscomb'
            ),
            workerSubsetTranslation: getTranslation(
                workerTarget?.subsetLayer,
                'dieresiscomb'
            ),
            recentLayerEntry:
                recentLayerEntry ||
                (recentTranslationXEntry || recentTranslationYEntry
                    ? {
                          path: 'granular-adieresis-translation',
                          oldValue: entryOldTranslation,
                          newValue: entryNewTranslation
                      }
                    : null)
        };
    });
}

test.describe('automatic adieresis anchor browser commit', () => {
    test('browser font/model state follows the committed adieresis layer after dragging a.top', async ({
        page
    }) => {
        test.slow();
        test.setTimeout(300000);

        await openAutomaticAdieresisEditScenario(page);

        const beforeState = await getAdieresisCommitState(page);
        expect(beforeState.bridgeTranslation).toEqual([150, 720]);
        expect(beforeState.workerYDocTranslation).toEqual(
            beforeState.bridgeTranslation
        );

        const afterAnchor = await dragTopAnchorThroughUi(page, -80);
        const expectedTranslation: [number, number] = [
            150,
            afterAnchor.anchorY
        ];

        const afterState = await getAdieresisCommitState(page);
        expect(afterState.entryNewTranslation).toEqual(expectedTranslation);
        expect(afterState.entryOldTranslation).toEqual(
            beforeState.bridgeTranslation
        );
        expect(afterState.recentLayerEntry?.newValue).toBeTruthy();
        expect(
            afterState.bridgeTranslation,
            JSON.stringify(afterState)
        ).toEqual(expectedTranslation);
        expect(
            afterState.workerYDocTranslation,
            JSON.stringify(afterState)
        ).toEqual(expectedTranslation);
        expect(
            afterState.workerCanonicalTranslation,
            JSON.stringify(afterState)
        ).toEqual(expectedTranslation);
        if (afterState.workerSubsetTranslation !== null) {
            expect(
                afterState.workerSubsetTranslation,
                JSON.stringify(afterState)
            ).toEqual(expectedTranslation);
        }
    });
});
