const {
    handleRemoteChangeRefresh,
    syncRustCacheAndRefreshCanvas
} = require('../js/change-bridge-init');
const { fontCompilation } = require('../js/font-compilation');

describe('handleRemoteChangeRefresh', () => {
    test('queues remote cache refresh before the first compile request', async () => {
        let resolveRefresh;
        const refreshOrder = [];
        const queueCacheRefresh = jest.fn(() => {
            refreshOrder.push('queue');
            window.fontManager = {
                workerCacheUpdatePromise: Promise.resolve()
            };
            return new Promise((resolve) => {
                resolveRefresh = () => {
                    refreshOrder.push('refresh-resolved');
                    resolve();
                };
            });
        });
        const requestCompile = jest.fn(async () => {
            refreshOrder.push('compile');
            expect(window.fontManager.workerCacheUpdatePromise).toBeTruthy();
        });
        const remoteEntries = [
            {
                transactionLabel: 'Drag anchor',
                path: 'glyphs.a.layers.master-regular.anchors.0.x',
                workerReplayTargets: [
                    {
                        glyphName: 'a',
                        layerId: 'master-regular'
                    }
                ]
            }
        ];

        const refreshPromise = handleRemoteChangeRefresh(remoteEntries, {
            requestCompile,
            queueCacheRefresh
        });

        expect(queueCacheRefresh).toHaveBeenCalledWith(
            undefined,
            undefined,
            false,
            {
                workerReplayTargets: [
                    {
                        glyphName: 'a',
                        layerId: 'master-regular'
                    }
                ]
            }
        );
        expect(requestCompile).toHaveBeenCalledTimes(1);
        expect(requestCompile).toHaveBeenNthCalledWith(
            1,
            'remote-anchor',
            'anchor'
        );
        expect(refreshOrder).toEqual(['queue', 'compile']);

        resolveRefresh();
        await refreshPromise;

        expect(requestCompile).toHaveBeenCalledTimes(2);
        expect(requestCompile).toHaveBeenNthCalledWith(
            2,
            'remote-anchor',
            'anchor'
        );
        expect(refreshOrder).toEqual([
            'queue',
            'compile',
            'refresh-resolved',
            'compile'
        ]);
    });

    test('classifies batched sidebearing arrow-key entries as remote outline edits', async () => {
        const queueCacheRefresh = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});
        const replayTargets = [
            {
                glyphName: 'l',
                layerId: 'master-regular'
            },
            {
                glyphName: 'n',
                layerId: 'master-regular'
            }
        ];

        await handleRemoteChangeRefresh(
            [
                {
                    transactionLabel: 'Arrow key',
                    path: 'glyphs.l.layers.master-regular',
                    visualAnchorSide: 'left',
                    workerReplayTargets: replayTargets
                }
            ],
            {
                requestCompile,
                queueCacheRefresh
            }
        );

        expect(queueCacheRefresh).toHaveBeenCalledWith(
            undefined,
            undefined,
            false,
            {
                workerReplayTargets: replayTargets
            }
        );
        expect(requestCompile).toHaveBeenNthCalledWith(
            1,
            'remote-outline',
            'outline'
        );
        expect(requestCompile).toHaveBeenNthCalledWith(
            2,
            'remote-outline',
            'outline'
        );
    });

    describe('linked-window visual pan', () => {
        const originalGlyphCanvas = window.glyphCanvas;
        const originalFontManager = window.fontManager;

        afterEach(() => {
            window.glyphCanvas = originalGlyphCanvas;
            window.fontManager = originalFontManager;
        });

        function installReceiverHarness({
            activeGlyphName,
            activeLayerId,
            currentLayerWidth,
            initialPanX,
            initialScale
        }) {
            const layer = { width: currentLayerWidth };
            const fontModel = {
                findGlyph: jest.fn(() => ({
                    findLayerById: jest.fn((id) =>
                        id === activeLayerId ? layer : null
                    )
                }))
            };
            const refreshGlyphAdvancesLive = jest.fn(() => true);
            const glyphCanvas = {
                viewportManager: { panX: initialPanX, scale: initialScale },
                textRunEditor: { refreshGlyphAdvancesLive },
                outlineEditor: {
                    active: true,
                    selectedLayerId: activeLayerId,
                    parseGlyphStack: () => [{ glyphName: activeGlyphName }],
                    performHitDetection: jest.fn()
                },
                getCurrentGlyphName: () => activeGlyphName,
                syncCurrentOutlineLayerDataFromModel: jest.fn(),
                updatePropertyPanel: jest.fn(),
                render: jest.fn()
            };
            window.glyphCanvas = glyphCanvas;
            window.fontManager = {
                currentFont: { fontModel },
                workerCacheUpdatePromise: Promise.resolve()
            };
            return { glyphCanvas, fontModel };
        }

        test.each([
            { side: 'left', edge: 'right' },
            { side: 'right', edge: 'left' }
        ])(
            'remote sidebearing edit ($side) keeps the active glyph $edge edge stationary in the linked window',
            async ({ side, edge }) => {
                const previousWidth = 500;
                const nextWidth = 560;
                const initialPanX = 200;
                const scale = 2;
                const { glyphCanvas } = installReceiverHarness({
                    activeGlyphName: 'a',
                    activeLayerId: 'master-regular',
                    currentLayerWidth: nextWidth,
                    initialPanX,
                    initialScale: scale
                });

                const beforePanX = glyphCanvas.viewportManager.panX;
                const beforeRight = beforePanX + previousWidth * scale;
                const beforeLeft = beforePanX;

                await handleRemoteChangeRefresh(
                    [
                        {
                            transactionLabel: 'Set sidebearing',
                            path: 'glyphs.a.layers.master-regular',
                            visualAnchorSide: side,
                            oldValue: { width: previousWidth },
                            newValue: { width: nextWidth }
                        }
                    ],
                    {
                        requestCompile: jest.fn(async () => {}),
                        queueCacheRefresh: jest.fn(async () => {})
                    }
                );

                const afterPanX = glyphCanvas.viewportManager.panX;
                const afterRight = afterPanX + nextWidth * scale;
                const afterLeft = afterPanX;
                if (edge === 'right') {
                    expect(afterRight).toBeCloseTo(beforeRight, 5);
                } else {
                    expect(afterLeft).toBeCloseTo(beforeLeft, 5);
                }
            }
        );

        test('remote sidebearing edit on a non-active glyph leaves the linked window pan untouched', async () => {
            const { glyphCanvas } = installReceiverHarness({
                activeGlyphName: 'a',
                activeLayerId: 'master-regular',
                currentLayerWidth: 560,
                initialPanX: 200,
                initialScale: 2
            });
            const beforePanX = glyphCanvas.viewportManager.panX;

            await handleRemoteChangeRefresh(
                [
                    {
                        transactionLabel: 'Set sidebearing',
                        path: 'glyphs.b.layers.master-regular',
                        visualAnchorSide: 'left',
                        oldValue: { width: 500 },
                        newValue: { width: 560 }
                    }
                ],
                {
                    requestCompile: jest.fn(async () => {}),
                    queueCacheRefresh: jest.fn(async () => {})
                }
            );

            expect(glyphCanvas.viewportManager.panX).toBe(beforePanX);
        });
    });
});

describe('syncRustCacheAndRefreshCanvas', () => {
    const originalGlyphCanvas = window.glyphCanvas;
    const originalFontManager = window.fontManager;
    const originalFontCompilationInitialized = fontCompilation.isInitialized;

    afterEach(() => {
        window.glyphCanvas = originalGlyphCanvas;
        window.fontManager = originalFontManager;
        fontCompilation.isInitialized = originalFontCompilationInitialized;
    });

    test('refreshes visible advances from worker replay targets with matched layer ids', async () => {
        const activeLayer = {
            id: 'active-brace-layer',
            width: 510,
            getMatchingLayerOnGlyph: jest.fn((glyphName) =>
                glyphName === 'n'
                    ? {
                          id: 'dependent-brace-layer',
                          width: 640
                      }
                    : undefined
            )
        };
        const activeGlyph = {
            findLayerById: jest.fn((layerId) =>
                layerId === 'active-brace-layer' ? activeLayer : undefined
            )
        };
        const dependentGlyph = {
            findLayerById: jest.fn((layerId) =>
                layerId === 'dependent-brace-layer'
                    ? { id: 'dependent-brace-layer', width: 640 }
                    : undefined
            )
        };
        const fontModel = {
            findGlyph: jest.fn((glyphName) => {
                if (glyphName === 'l') {
                    return activeGlyph;
                }
                if (glyphName === 'n') {
                    return dependentGlyph;
                }
                return undefined;
            })
        };
        const refreshGlyphAdvancesLive = jest.fn();
        const fetchLayerData = jest.fn(async () => {});
        const reconcileSelectionAfterModelSync = jest.fn(async () => {});

        fontCompilation.isInitialized = false;
        window.fontManager = {
            currentFont: {
                fontModel
            }
        };
        window.glyphCanvas = {
            textRunEditor: {
                refreshGlyphAdvancesLive,
                computePrecedingAdvanceDelta: jest.fn(() => 0)
            },
            requestRepaintAfterCompile: jest.fn(),
            outlineEditor: {
                active: true,
                selectedLayerId: 'active-brace-layer',
                draggingSomething: false,
                parseGlyphStack: jest.fn(() => [{ glyphName: 'l' }]),
                reconcileSelectionAfterModelSync,
                fetchLayerData
            }
        };

        await syncRustCacheAndRefreshCanvas(undefined, 'l', false, {
            skipDeferredCanvasRepaint: true,
            workerReplayTargets: [
                { glyphName: 'l', layerId: 'active-brace-layer' },
                { glyphName: 'n', layerId: 'dependent-brace-layer' }
            ]
        });

        expect(reconcileSelectionAfterModelSync).toHaveBeenCalledWith({
            skipRender: true
        });
        expect(fetchLayerData).toHaveBeenCalledWith(true, 'l');
        expect(refreshGlyphAdvancesLive).toHaveBeenCalledWith(
            {
                l: 510,
                n: 640
            },
            { render: false }
        );
    });
});
