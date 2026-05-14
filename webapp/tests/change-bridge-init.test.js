const {
    handleCommittedChangeRefresh,
    handleRemoteChangeRefresh,
    refreshGlyphOverviewFromGlyphNames,
    syncRustCacheAndRefreshCanvas,
    buildCascadingRecompositionOperations
} = require('../js/change-bridge-init');
const babelfontModel = require('../js/babelfont-model');
const {
    fontCompilation,
    fullFontCompilation
} = require('../js/font-compilation');
const { PatchSyncEngine: ChangeBridge } = require('../js/patch-sync-engine');

describe('handleRemoteChangeRefresh', () => {
    test('shared glyph overview refresh helper adds dependent composites and preserves immediate sender refresh detail', async () => {
        const glyphChangedHandler = jest.fn();

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(
                        () => new Set(['adieresis'])
                    )
                }
            }
        };
        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            await refreshGlyphOverviewFromGlyphNames(['a'], {
                layerId: 'master-regular',
                forceImmediateRefresh: true,
                fallbackToFullRender: false
            });
        } finally {
            window.removeEventListener('glyphChanged', glyphChangedHandler);
            delete window.fontManager;
        }

        expect(glyphChangedHandler).toHaveBeenCalledTimes(1);
        expect(glyphChangedHandler.mock.calls[0][0].detail).toEqual({
            glyphName: 'a',
            glyphNames: ['a', 'adieresis'],
            layerId: 'master-regular',
            forceImmediateRefresh: true
        });
    });

    test('waits for local worker sync before requesting compile and refreshes overview from the same committed packet', async () => {
        const refreshOrder = [];
        const awaitWorkerSync = jest.fn(async () => {
            refreshOrder.push('sync');
            window.fontManager.lastChangeSource = 'keyboard-outline';
            window.fontManager.lastEditType = 'outline';
        });
        const requestCompile = jest.fn(async () => {
            refreshOrder.push('compile');
        });
        const queueCacheRefresh = jest.fn(async () => {
            refreshOrder.push('queue');
        });
        const glyphChangedHandler = jest.fn();

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(
                        () => new Set(['adieresis'])
                    )
                }
            },
            lastChangeSource: 'keyboard-anchor',
            lastEditType: 'anchor'
        };
        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            await handleCommittedChangeRefresh(
                [
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
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile,
                    queueCacheRefresh
                }
            );
        } finally {
            window.removeEventListener('glyphChanged', glyphChangedHandler);
            delete window.fontManager;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(requestCompile).toHaveBeenCalledTimes(1);
        expect(requestCompile).toHaveBeenCalledWith(
            'keyboard-anchor',
            'anchor'
        );
        expect(queueCacheRefresh).toHaveBeenCalledWith(
            undefined,
            undefined,
            false,
            {
                allowSelectedLayerFallback: false,
                workerReplayTargets: [
                    {
                        glyphName: 'a',
                        layerId: 'master-regular'
                    }
                ]
            }
        );
        expect(refreshOrder).toEqual(['sync', 'queue', 'compile']);
        expect(glyphChangedHandler).toHaveBeenCalledTimes(1);
        expect(glyphChangedHandler.mock.calls[0][0].detail).toEqual({
            glyphName: 'a',
            glyphNames: ['a', 'adieresis']
        });
    });

    test('skips bootstrap-style local compile wake-up before the first editing font exists', async () => {
        const awaitWorkerSync = jest.fn(async () => {});
        const requestRecompileWithoutDataChange = jest.fn();
        const checkAndSchedule = jest.fn();

        window.fontManager = {
            currentFont: {
                changeVersion: 0,
                requestRecompileWithoutDataChange,
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            editingFont: null,
            lastChangeSource: null,
            lastEditType: null
        };
        window.autoCompileManager = {
            checkAndSchedule
        };

        try {
            await handleCommittedChangeRefresh([], 'local', {
                awaitWorkerSync
            });
        } finally {
            delete window.fontManager;
            delete window.autoCompileManager;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(requestRecompileWithoutDataChange).not.toHaveBeenCalled();
        expect(checkAndSchedule).not.toHaveBeenCalled();
    });

    test('allows the same local committed compile wake-up after startup readiness exists', async () => {
        const awaitWorkerSync = jest.fn(async () => {});
        const requestRecompileWithoutDataChange = jest.fn();
        const checkAndSchedule = jest.fn();

        window.fontManager = {
            currentFont: {
                changeVersion: 0,
                requestRecompileWithoutDataChange,
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            editingFont: new Uint8Array([1, 2, 3]),
            lastChangeSource: null,
            lastEditType: null
        };
        window.autoCompileManager = {
            checkAndSchedule
        };

        try {
            await handleCommittedChangeRefresh([], 'local', {
                awaitWorkerSync
            });
        } finally {
            delete window.fontManager;
            delete window.autoCompileManager;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
        expect(checkAndSchedule).toHaveBeenCalledTimes(1);
    });

    test('waits for chained local replay-target cache updates before compile and overview refresh', async () => {
        let resolveFirstCacheUpdate;
        let resolveSecondCacheUpdate;
        const firstCacheUpdate = new Promise((resolve) => {
            resolveFirstCacheUpdate = resolve;
        });
        const secondCacheUpdate = new Promise((resolve) => {
            resolveSecondCacheUpdate = resolve;
        });
        const refreshOrder = [];
        const awaitWorkerSync = jest.fn(async () => {
            refreshOrder.push('sync');
        });
        const requestCompile = jest.fn(async () => {
            refreshOrder.push('compile');
        });
        let resolveReplayTargetRefresh;
        const replayTargetRefresh = new Promise((resolve) => {
            resolveReplayTargetRefresh = resolve;
        });
        const queueCacheRefresh = jest.fn(() => {
            refreshOrder.push('queue');
            return replayTargetRefresh;
        });
        const glyphChangedHandler = jest.fn();

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(
                        () => new Set(['adieresis'])
                    )
                }
            },
            lastChangeSource: 'keyboard-anchor',
            lastEditType: 'anchor',
            workerCacheUpdatePromise: firstCacheUpdate,
            awaitWorkerCacheUpdate: jest.fn(async () => {
                const pendingPromise =
                    window.fontManager.workerCacheUpdatePromise;
                refreshOrder.push(
                    pendingPromise === firstCacheUpdate ? 'cache-1' : 'cache-2'
                );
                await pendingPromise;
            })
        };
        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            const refreshPromise = handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Drag anchor',
                        path: 'glyphs.a.layers.master-regular.anchors.0.x',
                        workerReplayTargets: [
                            {
                                glyphName: 'a',
                                layerId: 'master-regular'
                            },
                            {
                                glyphName: 'adieresis',
                                layerId: 'master-regular'
                            }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile,
                    queueCacheRefresh
                }
            );

            await Promise.resolve();
            expect(requestCompile).not.toHaveBeenCalled();
            expect(glyphChangedHandler).not.toHaveBeenCalled();

            window.fontManager.workerCacheUpdatePromise = secondCacheUpdate;
            resolveFirstCacheUpdate();
            await Promise.resolve();
            await Promise.resolve();

            expect(requestCompile).not.toHaveBeenCalled();
            expect(glyphChangedHandler).not.toHaveBeenCalled();

            resolveSecondCacheUpdate();
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(queueCacheRefresh).toHaveBeenCalledTimes(1);
            expect(requestCompile).not.toHaveBeenCalled();
            expect(glyphChangedHandler).not.toHaveBeenCalled();

            resolveReplayTargetRefresh();
            await refreshPromise;
        } finally {
            window.removeEventListener('glyphChanged', glyphChangedHandler);
            delete window.fontManager;
        }

        expect(requestCompile).toHaveBeenCalledTimes(1);
        expect(requestCompile).toHaveBeenCalledWith(
            'keyboard-anchor',
            'anchor'
        );
        expect(glyphChangedHandler).toHaveBeenCalledTimes(1);
        expect(glyphChangedHandler.mock.calls[0][0].detail).toEqual({
            glyphName: 'a',
            glyphNames: ['a', 'adieresis']
        });
        expect(queueCacheRefresh).toHaveBeenCalledWith(
            undefined,
            undefined,
            false,
            {
                allowSelectedLayerFallback: false,
                workerReplayTargets: [
                    {
                        glyphName: 'a',
                        layerId: 'master-regular'
                    },
                    {
                        glyphName: 'adieresis',
                        layerId: 'master-regular'
                    }
                ]
            }
        );
        expect(refreshOrder).toEqual([
            'sync',
            'cache-1',
            'sync',
            'cache-2',
            'sync',
            'queue',
            'compile'
        ]);
    });

    test('requests remote compile only after cache refresh resolves', async () => {
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
                allowSelectedLayerFallback: false,
                workerReplayTargets: [
                    {
                        glyphName: 'a',
                        layerId: 'master-regular'
                    }
                ]
            }
        );
        expect(requestCompile).not.toHaveBeenCalled();
        expect(refreshOrder).toEqual(['queue']);

        resolveRefresh();
        await refreshPromise;

        expect(requestCompile).toHaveBeenCalledTimes(1);
        expect(requestCompile).toHaveBeenNthCalledWith(
            1,
            'remote-anchor',
            'anchor'
        );
        expect(refreshOrder).toEqual(['queue', 'refresh-resolved', 'compile']);
    });

    test('skips bootstrap-style remote refresh when there are no committed entries', async () => {
        const queueCacheRefresh = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});

        await handleCommittedChangeRefresh([], 'remote', {
            requestCompile,
            queueCacheRefresh
        });

        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).not.toHaveBeenCalled();
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
                allowSelectedLayerFallback: false,
                workerReplayTargets: replayTargets
            }
        );
        expect(requestCompile).toHaveBeenNthCalledWith(
            1,
            'remote-outline',
            'outline'
        );
        expect(requestCompile).toHaveBeenCalledTimes(1);
    });

    test('disables selected-layer fallback for remote changes without replay targets', async () => {
        const queueCacheRefresh = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});

        await handleRemoteChangeRefresh(
            [
                {
                    transactionLabel: 'Remote metadata sync',
                    path: 'features.classes.Uppercase.code',
                    workerReplayTargets: []
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
                allowSelectedLayerFallback: false
            }
        );
        expect(requestCompile).toHaveBeenCalledWith('remote-change', null);
    });

    test('classifies local feature-code commits as feature-code recompiles', async () => {
        const awaitWorkerSync = jest.fn(async () => {});
        const queueCacheRefresh = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            lastChangeSource: null,
            lastEditType: null
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Edit feature code',
                        path: 'features.features.0.1.code',
                        workerReplayTargets: []
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile,
                    queueCacheRefresh
                }
            );
        } finally {
            delete window.fontManager;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith('feature-code', null);
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

describe('bridge Yjs worker callback', () => {
    const originalPatchSyncEngine = window.patchSyncEngine;
    const originalWindowSync = window.windowSync;
    const originalWindowRole = window.windowRole;
    const originalFontManager = window.fontManager;
    const originalInitialized = fontCompilation.isInitialized;

    function makeBridgeInitFont() {
        return {
            upm: 1000,
            version: [1, 0],
            note: '',
            date: '2024-01-01',
            names: { familyName: 'TestFont' },
            axes: [],
            masters: [],
            instances: [],
            glyphs: [
                {
                    name: 'A',
                    layers: [
                        {
                            id: 'layer-1',
                            width: 600,
                            anchors: [],
                            shapes: []
                        }
                    ]
                }
            ],
            features: {
                classes: {},
                prefixes: {},
                features: []
            }
        };
    }

    function initializeBridgeHarness() {
        const bridgeReadyEvent = new CustomEvent('fontModelReady', {
            detail: {
                path: '/tmp/TestFont.glyphs',
                babelfontData: makeBridgeInitFont()
            }
        });

        window.dispatchEvent(bridgeReadyEvent);

        return window.patchSyncEngine;
    }

    afterEach(() => {
        window.patchSyncEngine?.destroy?.();
        window.windowSync?.destroy?.();
        window.patchSyncEngine = originalPatchSyncEngine;
        window.windowSync = originalWindowSync;
        window.windowRole = originalWindowRole;
        window.fontManager = originalFontManager;
        fontCompilation.isInitialized = originalInitialized;
        jest.restoreAllMocks();
    });

    test('forwards feature-code Yjs updates to Rust with empty glyph metadata', async () => {
        const forwardWorkerYjsUpdate = jest.fn().mockResolvedValue(true);
        const interpolationUpdateSpy = jest
            .spyOn(babelfontModel, 'applyInterpolationRustYjsUpdate')
            .mockResolvedValue(true);
        const workerSeedSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });
        const hasWorkerCacheDocumentSpy = jest
            .spyOn(fullFontCompilation, 'hasWorkerCacheDocument')
            .mockReturnValue(true);
        const fullWorkerUpdateSpy = jest
            .spyOn(fullFontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });

        fontCompilation.isInitialized = true;
        window.windowRole = {
            isLinkedWindow: () => false
        };
        window.fontManager = {
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
            replaceWorkerYjsMirrorFromState: jest.fn(),
            forwardWorkerYjsUpdate
        };

        const bridge = initializeBridgeHarness();
        expect(typeof bridge._yjsWorkerCallback).toBe('function');

        workerSeedSpy.mockClear();
        fullWorkerUpdateSpy.mockClear();

        bridge._yjsWorkerCallback(new Uint8Array([9, 9]), [
            {
                path: 'features.features.0.1.code'
            }
        ]);
        await Promise.resolve();
        await Promise.resolve();

        expect(interpolationUpdateSpy).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            []
        );
        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            [],
            {
                invalidateLayoutClosure: true
            }
        );
        expect(hasWorkerCacheDocumentSpy).toHaveBeenCalled();
        expect(fullWorkerUpdateSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                changedGlyphs: [],
                invalidateLayoutClosure: true
            })
        );
    });

    test('forwards font-wide metadata Yjs updates to Rust before recompilation', async () => {
        const forwardWorkerYjsUpdate = jest.fn().mockResolvedValue(true);
        const interpolationUpdateSpy = jest
            .spyOn(babelfontModel, 'applyInterpolationRustYjsUpdate')
            .mockResolvedValue(true);
        const workerSeedSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });

        fontCompilation.isInitialized = true;
        window.windowRole = {
            isLinkedWindow: () => false
        };
        window.fontManager = {
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
            replaceWorkerYjsMirrorFromState: jest.fn(),
            forwardWorkerYjsUpdate
        };

        const bridge = initializeBridgeHarness();
        workerSeedSpy.mockClear();

        bridge._yjsWorkerCallback(new Uint8Array([7, 7]), [
            {
                path: 'names.familyName'
            }
        ]);
        await Promise.resolve();
        await Promise.resolve();

        expect(interpolationUpdateSpy).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            []
        );
        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            [],
            {
                invalidateLayoutClosure: false
            }
        );
    });

    test('forwards layer-scoped Yjs updates with derived layer targets', async () => {
        const forwardWorkerYjsUpdate = jest.fn().mockResolvedValue(true);
        const interpolationUpdateSpy = jest
            .spyOn(babelfontModel, 'applyInterpolationRustYjsUpdate')
            .mockResolvedValue(true);
        const workerSeedSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });

        fontCompilation.isInitialized = true;
        window.windowRole = {
            isLinkedWindow: () => false
        };
        window.fontManager = {
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
            replaceWorkerYjsMirrorFromState: jest.fn(),
            forwardWorkerYjsUpdate
        };

        const bridge = initializeBridgeHarness();
        workerSeedSpy.mockClear();

        bridge._yjsWorkerCallback(new Uint8Array([7, 7]), [
            {
                path: 'glyphs.alef:layers.A.0:anchors.0.x',
                workerReplayTargets: [
                    { glyphName: 'beh', layerId: 'A.0' },
                    { glyphName: 'alef', layerId: 'A.0' }
                ]
            }
        ]);
        await Promise.resolve();
        await Promise.resolve();

        expect(interpolationUpdateSpy).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            ['alef']
        );
        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            ['alef'],
            {
                invalidateLayoutClosure: false,
                layerTargets: [
                    { glyphName: 'beh', layerId: 'A.0' },
                    { glyphName: 'alef', layerId: 'A.0' }
                ]
            }
        );
    });

    test('forwards glyph-removal Yjs updates without layer targets', async () => {
        const forwardWorkerYjsUpdate = jest.fn().mockResolvedValue(true);
        const interpolationUpdateSpy = jest
            .spyOn(babelfontModel, 'applyInterpolationRustYjsUpdate')
            .mockResolvedValue(true);
        const workerSeedSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({ success: true });

        fontCompilation.isInitialized = true;
        window.windowRole = {
            isLinkedWindow: () => false
        };
        window.fontManager = {
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
            replaceWorkerYjsMirrorFromState: jest.fn(),
            forwardWorkerYjsUpdate
        };

        const bridge = initializeBridgeHarness();
        workerSeedSpy.mockClear();

        bridge._yjsWorkerCallback(new Uint8Array([5, 5]), [
            {
                path: 'glyphs.alef'
            }
        ]);
        await Promise.resolve();
        await Promise.resolve();

        expect(interpolationUpdateSpy).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            ['alef']
        );
        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            ['alef'],
            {
                invalidateLayoutClosure: true
            }
        );
    });
});

describe('buildCascadingRecompositionOperations', () => {
    const originalFontManager = window.fontManager;
    const originalCurrentFontModel = window.currentFontModel;

    afterEach(() => {
        window.fontManager = originalFontManager;
        window.currentFontModel = originalCurrentFontModel;
    });

    function makeBridgeFont() {
        return {
            glyphs: [
                {
                    name: 'A',
                    layers: [
                        {
                            id: 'layer-1',
                            width: 600,
                            anchors: [{ name: 'top', x: 100, y: 700 }],
                            shapes: []
                        }
                    ]
                },
                {
                    name: 'B',
                    layers: [
                        {
                            id: 'layer-2',
                            width: 650,
                            anchors: [],
                            shapes: []
                        }
                    ]
                }
            ]
        };
    }

    test('creates derived layer operations for width-triggered cascade changes', () => {
        const fontJson = makeBridgeFont();
        const bridge = new ChangeBridge('cascade-test');
        bridge.initFromJson(fontJson);

        fontJson.glyphs[0].layers[0].width = 700;

        const sourceLayer = {
            id: 'layer-1',
            getMatchingLayerOnGlyph: jest.fn((glyphName) =>
                glyphName === 'B' ? { id: 'layer-2' } : null
            )
        };
        window.fontManager = {
            currentFont: {
                fontModel: {
                    findGlyph: jest.fn((glyphName) => {
                        if (glyphName === 'A') {
                            return {
                                findLayerById: jest.fn((layerId) =>
                                    layerId === 'layer-1' ? sourceLayer : null
                                )
                            };
                        }

                        if (glyphName === 'B') {
                            return {
                                findLayerById: jest.fn((layerId) =>
                                    layerId === 'layer-2'
                                        ? { id: 'layer-2' }
                                        : null
                                )
                            };
                        }

                        return null;
                    }),
                    rebuildAutomaticCompositesForGlyphs: jest.fn(() => {
                        fontJson.glyphs[1].layers[0].width = 710;
                        return new Set(['B']);
                    }),
                    recomputeMetricsKeys: jest.fn(() => new Set())
                }
            }
        };

        const operations = buildCascadingRecompositionOperations(bridge, [
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'width'],
                oldValue: 600,
                newValue: 700
            }
        ]);

        expect(operations).toEqual([
            expect.objectContaining({
                op: 'set',
                path: ['glyphs', 'B', 'layers', 'layer-2'],
                oldValue: expect.objectContaining({ width: 650 }),
                newValue: expect.objectContaining({
                    id: 'layer-2',
                    width: 710
                }),
                applyMode: 'layer-snapshot',
                workerReplayTargets: [
                    {
                        glyphName: 'B',
                        layerId: 'layer-2'
                    }
                ]
            })
        ]);
    });

    test('emits null tombstones when cascade recomposition removes layer fields', () => {
        const fontJson = makeBridgeFont();
        fontJson.glyphs[1].layers[0].format_specific = { legacy: true };
        const bridge = new ChangeBridge('cascade-test');
        bridge.initFromJson(fontJson);

        fontJson.glyphs[0].layers[0].width = 700;

        const sourceLayer = {
            id: 'layer-1',
            getMatchingLayerOnGlyph: jest.fn((glyphName) =>
                glyphName === 'B' ? { id: 'layer-2' } : null
            )
        };
        window.fontManager = {
            currentFont: {
                fontModel: {
                    findGlyph: jest.fn((glyphName) => {
                        if (glyphName === 'A') {
                            return {
                                findLayerById: jest.fn((layerId) =>
                                    layerId === 'layer-1' ? sourceLayer : null
                                )
                            };
                        }

                        if (glyphName === 'B') {
                            return {
                                findLayerById: jest.fn((layerId) =>
                                    layerId === 'layer-2'
                                        ? { id: 'layer-2' }
                                        : null
                                )
                            };
                        }

                        return null;
                    }),
                    rebuildAutomaticCompositesForGlyphs: jest.fn(() => {
                        delete fontJson.glyphs[1].layers[0].format_specific;
                        return new Set(['B']);
                    }),
                    recomputeMetricsKeys: jest.fn(() => new Set())
                }
            }
        };

        const operations = buildCascadingRecompositionOperations(bridge, [
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'width'],
                oldValue: 600,
                newValue: 700
            }
        ]);

        expect(operations[0].newValue).toEqual(
            expect.objectContaining({
                id: 'layer-2',
                format_specific: null
            })
        );
        expect(operations[0].oldValue).toEqual(
            expect.objectContaining({
                format_specific: { legacy: true }
            })
        );
    });

    test('captures additional source-layer recomposition beyond the direct edit', () => {
        const fontJson = makeBridgeFont();
        const bridge = new ChangeBridge('cascade-test');
        bridge.initFromJson(fontJson);

        fontJson.glyphs[0].layers[0].width = 700;

        const sourceLayer = {
            id: 'layer-1',
            getMatchingLayerOnGlyph: jest.fn(() => null)
        };
        window.fontManager = {
            currentFont: {
                fontModel: {
                    findGlyph: jest.fn((glyphName) => {
                        if (glyphName === 'A') {
                            return {
                                findLayerById: jest.fn((layerId) =>
                                    layerId === 'layer-1' ? sourceLayer : null
                                )
                            };
                        }

                        return null;
                    }),
                    rebuildAutomaticCompositesForGlyphs: jest.fn(
                        () => new Set()
                    ),
                    recomputeMetricsKeys: jest.fn(() => {
                        fontJson.glyphs[0].layers[0].anchors = [];
                        return new Set(['A']);
                    })
                }
            }
        };

        const operations = buildCascadingRecompositionOperations(bridge, [
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'width'],
                oldValue: 600,
                newValue: 700
            }
        ]);

        expect(operations).toEqual([
            expect.objectContaining({
                path: ['glyphs', 'A', 'layers', 'layer-1'],
                oldValue: expect.objectContaining({
                    width: 700,
                    anchors: [{ name: 'top', x: 100, y: 700 }]
                }),
                newValue: expect.objectContaining({
                    id: 'layer-1',
                    anchors: []
                })
            })
        ]);
    });

    test('uses array semantics for direct anchor removals when computing source-layer cascade deltas', () => {
        const fontJson = makeBridgeFont();
        fontJson.glyphs[0].layers[0].anchors.push({
            name: 'bottom',
            x: 100,
            y: 0
        });
        const bridge = new ChangeBridge('cascade-test');
        bridge.initFromJson(fontJson);

        fontJson.glyphs[0].layers[0].anchors = [];

        const sourceLayer = {
            id: 'layer-1',
            getMatchingLayerOnGlyph: jest.fn(() => null)
        };
        window.fontManager = {
            currentFont: {
                fontModel: {
                    findGlyph: jest.fn((glyphName) => {
                        if (glyphName === 'A') {
                            return {
                                findLayerById: jest.fn((layerId) =>
                                    layerId === 'layer-1' ? sourceLayer : null
                                )
                            };
                        }

                        return null;
                    }),
                    rebuildAutomaticCompositesForGlyphs: jest.fn(
                        () => new Set()
                    ),
                    recomputeMetricsKeys: jest.fn(() => new Set(['A']))
                }
            }
        };

        const operations = buildCascadingRecompositionOperations(bridge, [
            {
                op: 'remove',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'anchors', 0],
                oldValue: { name: 'top', x: 100, y: 700 },
                newValue: undefined
            }
        ]);

        expect(operations).toEqual([
            expect.objectContaining({
                path: ['glyphs', 'A', 'layers', 'layer-1'],
                oldValue: expect.objectContaining({
                    anchors: [{ name: 'bottom', x: 100, y: 0 }]
                }),
                newValue: expect.objectContaining({
                    id: 'layer-1',
                    anchors: []
                })
            })
        ]);
    });

    test('ignores node-only edits that do not touch width or anchors', () => {
        const fontJson = makeBridgeFont();
        const bridge = new ChangeBridge('cascade-test');
        bridge.initFromJson(fontJson);

        window.fontManager = {
            currentFont: {
                fontModel: {
                    rebuildAutomaticCompositesForGlyphs: jest.fn(),
                    recomputeMetricsKeys: jest.fn()
                }
            }
        };

        const operations = buildCascadingRecompositionOperations(bridge, [
            {
                op: 'set',
                path: [
                    'glyphs',
                    'A',
                    'layers',
                    'layer-1',
                    'shapes',
                    0,
                    'nodes'
                ],
                oldValue: [{ x: 0, y: 0 }],
                newValue: [{ x: 10, y: 0 }]
            }
        ]);

        expect(operations).toEqual([]);
        expect(
            window.fontManager.currentFont.fontModel
                .rebuildAutomaticCompositesForGlyphs
        ).not.toHaveBeenCalled();
        expect(
            window.fontManager.currentFont.fontModel.recomputeMetricsKeys
        ).not.toHaveBeenCalled();
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

    test('waits for worker Yjs sync even when replay-target refresh succeeds', async () => {
        const awaitWorkerDocumentSync = jest
            .spyOn(fontCompilation, 'awaitWorkerDocumentSync')
            .mockResolvedValue();
        const refreshWorkerCacheForReplayTargets = jest
            .fn()
            .mockResolvedValue(true);

        fontCompilation.isInitialized = true;
        window.fontManager = {
            currentFont: {
                babelfontJson: '{}',
                fontModel: {
                    findGlyph: jest.fn(() => undefined)
                }
            },
            refreshWorkerCacheForReplayTargets,
            submitLayerToWorkerCache: jest.fn(),
            awaitWorkerCacheUpdate: jest.fn(async () => {})
        };
        window.glyphCanvas = {
            textRunEditor: {
                refreshGlyphAdvancesLive: jest.fn(),
                computePrecedingAdvanceDelta: jest.fn(() => 0)
            },
            requestRepaintAfterCompile: jest.fn(),
            outlineEditor: {
                active: true,
                selectedLayerId: 'master-regular',
                draggingSomething: false,
                parseGlyphStack: jest.fn(() => [{ glyphName: 'l' }]),
                reconcileSelectionAfterModelSync: jest.fn(async () => {}),
                fetchLayerData: jest.fn(async () => {})
            }
        };

        await syncRustCacheAndRefreshCanvas(undefined, 'l', false, {
            skipDeferredCanvasRepaint: true,
            workerReplayTargets: [{ glyphName: 'l', layerId: 'master-regular' }]
        });

        expect(refreshWorkerCacheForReplayTargets).toHaveBeenCalledWith([
            { glyphName: 'l', layerId: 'master-regular' }
        ]);
        expect(awaitWorkerDocumentSync).toHaveBeenCalledTimes(1);

        awaitWorkerDocumentSync.mockRestore();
    });

    test('skips selected-layer fallback when explicitly disabled', async () => {
        const awaitWorkerDocumentSync = jest
            .spyOn(fontCompilation, 'awaitWorkerDocumentSync')
            .mockResolvedValue();

        fontCompilation.isInitialized = true;
        window.fontManager = {
            currentFont: {
                babelfontJson: '{}',
                fontModel: {
                    findGlyph: jest.fn(() => undefined)
                }
            },
            refreshWorkerCacheForReplayTargets: jest.fn(),
            submitLayerToWorkerCache: jest.fn(),
            awaitWorkerCacheUpdate: jest.fn(async () => {})
        };
        window.glyphCanvas = {
            textRunEditor: {
                refreshGlyphAdvancesLive: jest.fn(),
                computePrecedingAdvanceDelta: jest.fn(() => 0)
            },
            requestRepaintAfterCompile: jest.fn(),
            outlineEditor: {
                active: true,
                selectedLayerId: 'master-regular',
                draggingSomething: false,
                parseGlyphStack: jest.fn(() => [{ glyphName: 'l' }]),
                reconcileSelectionAfterModelSync: jest.fn(async () => {}),
                fetchLayerData: jest.fn(async () => {})
            }
        };

        await syncRustCacheAndRefreshCanvas(undefined, undefined, false, {
            skipDeferredCanvasRepaint: true,
            allowSelectedLayerFallback: false
        });

        expect(
            window.fontManager.submitLayerToWorkerCache
        ).not.toHaveBeenCalled();
        expect(awaitWorkerDocumentSync).toHaveBeenCalledTimes(1);

        awaitWorkerDocumentSync.mockRestore();
    });
});
