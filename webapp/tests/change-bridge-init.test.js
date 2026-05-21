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
        // Local GUI-complete layer packet: the Yjs worker callback already
        // forwarded the update, so the post-commit skips the duplicate
        // replay-target cache refresh.
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(refreshOrder).toEqual(['sync', 'compile']);
        expect(glyphChangedHandler).toHaveBeenCalledTimes(1);
        expect(glyphChangedHandler.mock.calls[0][0].detail).toEqual({
            glyphName: 'a',
            glyphNames: ['a', 'adieresis']
        });
    });

    test('skips duplicate local cache refresh for forwarded master reinterpolation glyph snapshots', async () => {
        const refreshOrder = [];
        const awaitWorkerSync = jest.fn(async () => {
            refreshOrder.push('sync');
            window.fontManager.lastChangeSource = 'master-reinterpolate-batch';
            window.fontManager.lastEditType = 'outline';
        });
        const requestCompile = jest.fn(async () => {
            refreshOrder.push('compile');
        });
        const queueCacheRefresh = jest.fn(async () => {
            refreshOrder.push('queue');
        });

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            lastChangeSource: 'master-reinterpolate-batch',
            lastEditType: 'outline'
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Reinterpolate layer batch sync',
                        path: 'glyphs.A',
                        workerReplayTargets: [
                            {
                                glyphName: 'A',
                                layerId: 'master-bold'
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
            delete window.fontManager;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'master-reinterpolate-batch',
            'outline'
        );
        expect(refreshOrder).toEqual(['sync', 'compile']);
    });

    test('skips duplicate local replay-target cache refresh for forwarded add-master batch packets', async () => {
        const refreshOrder = [];
        const awaitWorkerSync = jest.fn(async () => {
            refreshOrder.push('sync');
        });
        const requestCompile = jest.fn(async () => {
            refreshOrder.push('compile');
        });
        const queueCacheRefresh = jest.fn(async () => {
            refreshOrder.push('queue');
        });

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
                        transactionLabel: 'Add master',
                        path: 'masters'
                    },
                    {
                        transactionLabel: 'Add master',
                        path: 'glyphs.A.layers.master-3',
                        workerReplayTargets: [
                            {
                                glyphName: 'A',
                                layerId: 'master-3'
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
            delete window.fontManager;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'keyboard-outline',
            'outline'
        );
        expect(refreshOrder).toEqual(['sync', 'compile']);
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
        const queueCacheRefresh = jest.fn(() => {
            refreshOrder.push('queue');
            return Promise.resolve();
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

            // Local GUI-complete layer packet: the Yjs worker callback already
            // forwarded the update, so the post-commit skips the duplicate
            // replay-target cache refresh and goes straight to compile.
            expect(queueCacheRefresh).not.toHaveBeenCalled();
            // requestCompile is called immediately after worker sync settles
            // because we skip the cache refresh for GUI-complete packets.
            expect(requestCompile).toHaveBeenCalledTimes(1);
            // glyphChanged is also dispatched after compile request
            // (overview refresh from committed entries)
            expect(glyphChangedHandler).toHaveBeenCalledTimes(1);

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
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(refreshOrder).toEqual([
            'sync',
            'cache-1',
            'sync',
            'cache-2',
            'sync',
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

        expect(queueCacheRefresh).toHaveBeenCalledWith(undefined, undefined, {
            allowSelectedLayerFallback: false,
            workerReplayTargets: [
                {
                    glyphName: 'a',
                    layerId: 'master-regular'
                }
            ]
        });
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

        expect(queueCacheRefresh).toHaveBeenCalledWith(undefined, undefined, {
            allowSelectedLayerFallback: false,
            workerReplayTargets: replayTargets
        });
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

        expect(queueCacheRefresh).toHaveBeenCalledWith(undefined, undefined, {
            allowSelectedLayerFallback: false
        });
        expect(requestCompile).toHaveBeenCalledWith('remote-change', null);
    });

    test('classifies forwarded master reinterpolation packets as remote outline edits', async () => {
        const replayTargets = [{ glyphName: 'A', layerId: 'master-bold' }];
        const queueCacheRefresh = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});

        await handleRemoteChangeRefresh(
            [
                {
                    transactionLabel: 'Reinterpolate layer batch sync',
                    path: 'glyphs.A',
                    workerReplayTargets: replayTargets
                }
            ],
            {
                requestCompile,
                queueCacheRefresh
            }
        );

        expect(queueCacheRefresh).toHaveBeenCalledWith(undefined, undefined, {
            allowSelectedLayerFallback: false,
            workerReplayTargets: replayTargets
        });
        expect(requestCompile).toHaveBeenCalledWith(
            'remote-outline',
            'outline'
        );
    });

    test('classifies forwarded single-layer reinterpolation packets as remote outline edits', async () => {
        const replayTargets = [{ glyphName: 'A', layerId: 'brace-layer' }];
        const queueCacheRefresh = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});

        await handleRemoteChangeRefresh(
            [
                {
                    transactionLabel: 'Reinterpolate layer sync',
                    path: 'glyphs.A.layers.brace-layer',
                    workerReplayTargets: replayTargets
                }
            ],
            {
                requestCompile,
                queueCacheRefresh
            }
        );

        expect(queueCacheRefresh).toHaveBeenCalledWith(undefined, undefined, {
            allowSelectedLayerFallback: false,
            workerReplayTargets: replayTargets
        });
        expect(requestCompile).toHaveBeenCalledWith(
            'remote-outline',
            'outline'
        );
    });

    test('classifies forwarded add-master batch packets as remote outline edits', async () => {
        const replayTargets = [{ glyphName: 'A', layerId: 'master-3' }];
        const queueCacheRefresh = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});

        await handleRemoteChangeRefresh(
            [
                {
                    transactionLabel: 'Add master',
                    path: 'masters'
                },
                {
                    transactionLabel: 'Add master',
                    path: 'glyphs.A.layers.master-3',
                    workerReplayTargets: replayTargets
                }
            ],
            {
                requestCompile,
                queueCacheRefresh
            }
        );

        expect(queueCacheRefresh).toHaveBeenCalledWith(undefined, undefined, {
            allowSelectedLayerFallback: false,
            workerReplayTargets: replayTargets
        });
        expect(requestCompile).toHaveBeenCalledWith(
            'remote-outline',
            'outline'
        );
    });

    test('local GUI commit with layer-scoped replay targets skips duplicate cache refresh after Yjs worker already forwarded', async () => {
        const awaitWorkerSync = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});
        const queueCacheRefresh = jest.fn(async () => {});
        const glyphChangedHandler = jest.fn();

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            lastChangeSource: 'keyboard-outline',
            lastEditType: 'outline'
        };
        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Set sidebearing',
                        path: 'glyphs.A.layers.layer-1',
                        visualAnchorSide: 'right',
                        workerReplayTargets: [
                            { glyphName: 'A', layerId: 'layer-1' },
                            { glyphName: 'B', layerId: 'layer-2' }
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

        // The Yjs worker callback already forwarded the update to Rust.
        // The local post-commit should NOT send a second refreshWorkerCacheForReplayTargets.
        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'keyboard-outline',
            'outline'
        );
    });

    test('local commit without layer-scoped paths still runs cache refresh', async () => {
        const awaitWorkerSync = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});
        const queueCacheRefresh = jest.fn(async () => {});
        const glyphChangedHandler = jest.fn();

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            lastChangeSource: 'feature-code',
            lastEditType: null
        };
        window.addEventListener('glyphChanged', glyphChangedHandler);

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
            window.removeEventListener('glyphChanged', glyphChangedHandler);
            delete window.fontManager;
        }

        // Feature-code commit without layer-scope paths still runs the
        // cache refresh (it's not a GUI-complete layer packet).
        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith('feature-code', null);
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
            expect.objectContaining({
                invalidateLayoutClosure: true,
                nonGlyphChangeHints: ['feature-code']
            })
        );
        expect(hasWorkerCacheDocumentSpy).toHaveBeenCalled();
        expect(fullWorkerUpdateSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                changedGlyphs: [],
                nonGlyphChangeHints: ['feature-code'],
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
            expect.objectContaining({
                invalidateLayoutClosure: false
            })
        );
    });

    test('forwards kerning-pair Yjs updates with non-glyph kerning hints', async () => {
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
        workerSeedSpy.mockClear();
        fullWorkerUpdateSpy.mockClear();

        bridge._yjsWorkerCallback(new Uint8Array([4, 4]), [
            {
                path: 'masters.0.kerning.A.V',
                transactionLabel: 'Edit kerning pair'
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
            expect.objectContaining({
                invalidateLayoutClosure: false,
                nonGlyphChangeHints: ['kerning-value']
            })
        );
        expect(hasWorkerCacheDocumentSpy).toHaveBeenCalled();
        expect(fullWorkerUpdateSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                changedGlyphs: [],
                nonGlyphChangeHints: ['kerning-value'],
                invalidateLayoutClosure: false
            })
        );
    });

    test('forwards kern-group Yjs updates with non-glyph kerning hints', async () => {
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
            buildWorkerYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
            replaceWorkerYjsMirrorFromState: jest.fn(),
            forwardWorkerYjsUpdate
        };

        const bridge = initializeBridgeHarness();
        workerSeedSpy.mockClear();

        bridge._yjsWorkerCallback(new Uint8Array([5, 5]), [
            {
                path: 'first_kern_groups.A.0',
                transactionLabel: 'Add kern group membership'
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
            expect.objectContaining({
                invalidateLayoutClosure: false,
                nonGlyphChangeHints: ['kerning-groups']
            })
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
            expect.objectContaining({
                invalidateLayoutClosure: false,
                layerTargets: [
                    { glyphName: 'beh', layerId: 'A.0' },
                    { glyphName: 'alef', layerId: 'A.0' }
                ]
            })
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
            expect.objectContaining({
                invalidateLayoutClosure: true
            })
        );
    });

    test('outline edit forwards with invalidateLayoutClosure false and non-empty changedGlyphs', async () => {
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
        workerSeedSpy.mockClear();
        fullWorkerUpdateSpy.mockClear();

        // Outline edit — layer-scoped node change
        bridge._yjsWorkerCallback(new Uint8Array([7, 7]), [
            {
                path: 'glyphs.A.layers.layer-1.shapes.0.nodes.0.x',
                workerReplayTargets: [{ glyphName: 'A', layerId: 'layer-1' }]
            }
        ]);
        await Promise.resolve();
        await Promise.resolve();

        expect(interpolationUpdateSpy).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            ['A']
        );
        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            ['A'],
            expect.objectContaining({
                invalidateLayoutClosure: false,
                layerTargets: [{ glyphName: 'A', layerId: 'layer-1' }]
            })
        );
        expect(hasWorkerCacheDocumentSpy).toHaveBeenCalled();
        expect(fullWorkerUpdateSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                changedGlyphs: ['A'],
                layerTargets: [{ glyphName: 'A', layerId: 'layer-1' }],
                invalidateLayoutClosure: false
            })
        );
    });

    test('anchor edit forwards with invalidateLayoutClosure false and non-empty changedGlyphs', async () => {
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

        // Anchor edit — layer-scoped anchor change
        bridge._yjsWorkerCallback(new Uint8Array([8, 8]), [
            {
                path: 'glyphs.A.layers.layer-1.anchors.0.x',
                workerReplayTargets: [{ glyphName: 'A', layerId: 'layer-1' }]
            }
        ]);
        await Promise.resolve();
        await Promise.resolve();

        expect(interpolationUpdateSpy).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            ['A']
        );
        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            ['A'],
            expect.objectContaining({
                invalidateLayoutClosure: false,
                layerTargets: [{ glyphName: 'A', layerId: 'layer-1' }]
            })
        );
    });

    test('sidebearing edit forwards with invalidateLayoutClosure false and non-empty changedGlyphs', async () => {
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

        // Sidebearing edit — layer-scoped width change
        bridge._yjsWorkerCallback(new Uint8Array([6, 6]), [
            {
                path: 'glyphs.A.layers.layer-1.width',
                visualAnchorSide: 'right',
                workerReplayTargets: [{ glyphName: 'A', layerId: 'layer-1' }]
            }
        ]);
        await Promise.resolve();
        await Promise.resolve();

        expect(interpolationUpdateSpy).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            ['A']
        );
        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            ['A'],
            expect.objectContaining({
                invalidateLayoutClosure: false,
                layerTargets: [{ glyphName: 'A', layerId: 'layer-1' }]
            })
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

    test('skips recomposition when GUI layer-snapshot operation carries complete replay targets', () => {
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

        // A layer-snapshot operation with explicit workerReplayTargets
        // that includes the source glyph/layer should bypass recomposition.
        const operations = buildCascadingRecompositionOperations(bridge, [
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1'],
                oldValue: {
                    id: 'layer-1',
                    width: 600,
                    anchors: [],
                    shapes: []
                },
                newValue: {
                    id: 'layer-1',
                    width: 700,
                    anchors: [],
                    shapes: []
                },
                applyPath: ['glyphs', 'A', 'layers', 'layer-1'],
                applyMode: 'layer-snapshot',
                applyNewValue: { id: 'layer-1', width: 700 },
                workerReplayTargets: [
                    { glyphName: 'A', layerId: 'layer-1' },
                    { glyphName: 'B', layerId: 'layer-2' }
                ]
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

    test('falls back to recomposition when width path lacks explicit replay targets', () => {
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

        // A width path without explicit workerReplayTargets should still
        // trigger recomposition (fallback for non-GUI or incomplete packets).
        const operations = buildCascadingRecompositionOperations(bridge, [
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'width'],
                oldValue: 600,
                newValue: 700
            }
        ]);

        expect(operations.length).toBeGreaterThan(0);
        expect(
            window.fontManager.currentFont.fontModel
                .rebuildAutomaticCompositesForGlyphs
        ).toHaveBeenCalled();
        expect(
            window.fontManager.currentFont.fontModel.recomputeMetricsKeys
        ).toHaveBeenCalled();
    });

    test('falls back to recomposition when anchor path lacks explicit replay targets', () => {
        const fontJson = makeBridgeFont();
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

        // An anchor removal path without explicit workerReplayTargets
        // should still trigger recomposition (the recomputeMetricsKeys
        // call proves the fallback path was taken).
        const operations = buildCascadingRecompositionOperations(bridge, [
            {
                op: 'remove',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'anchors', 0],
                oldValue: { name: 'top', x: 100, y: 700 },
                newValue: undefined
            }
        ]);

        expect(
            window.fontManager.currentFont.fontModel.recomputeMetricsKeys
        ).toHaveBeenCalled();
        // No cascade layer targets because getMatchingLayerOnGlyph returns
        // null, so no layer operations are emitted.
        expect(operations).toEqual([]);
    });
});

describe('shouldInvalidateLayoutClosureForCommittedEntries', () => {
    // Import the function directly from the module
    const changeBridgeInit = require('../js/change-bridge-init');

    test('returns false for visual layer-scoped paths (outline, anchor, sidebearing)', () => {
        const result =
            changeBridgeInit.shouldInvalidateLayoutClosureForCommittedEntries([
                { path: 'glyphs.A.layers.layer-1.shapes.0.nodes.0.x' }
            ]);
        expect(result).toBe(false);
    });

    test('returns false for layer-snapshot paths with colon separator', () => {
        const result =
            changeBridgeInit.shouldInvalidateLayoutClosureForCommittedEntries([
                { path: 'glyphs.alef:layers.A.0:anchors.0.x' }
            ]);
        expect(result).toBe(false);
    });

    test('returns false for sidebearing layer path', () => {
        const result =
            changeBridgeInit.shouldInvalidateLayoutClosureForCommittedEntries([
                { path: 'glyphs.A.layers.layer-1.width' }
            ]);
        expect(result).toBe(false);
    });

    test('returns true for feature-code paths', () => {
        const result =
            changeBridgeInit.shouldInvalidateLayoutClosureForCommittedEntries([
                { path: 'features.features.0.1.code' }
            ]);
        expect(result).toBe(true);
    });

    test('returns true for top-level glyph paths (structural changes)', () => {
        const result =
            changeBridgeInit.shouldInvalidateLayoutClosureForCommittedEntries([
                { path: 'glyphs.A' }
            ]);
        expect(result).toBe(true);
    });

    test('returns false for forwarded master reinterpolation glyph snapshots', () => {
        const result =
            changeBridgeInit.shouldInvalidateLayoutClosureForCommittedEntries([
                {
                    path: 'glyphs.A',
                    transactionLabel: 'Reinterpolate layer batch sync',
                    workerReplayTargets: [
                        { glyphName: 'A', layerId: 'master-bold' }
                    ]
                }
            ]);
        expect(result).toBe(false);
    });

    test('returns true for glyph-removal paths', () => {
        const result =
            changeBridgeInit.shouldInvalidateLayoutClosureForCommittedEntries([
                { path: 'glyphs.alef' }
            ]);
        expect(result).toBe(true);
    });

    test('returns false for mixed visual layer paths', () => {
        const result =
            changeBridgeInit.shouldInvalidateLayoutClosureForCommittedEntries([
                { path: 'glyphs.A.layers.layer-1.anchors.0.x' },
                { path: 'glyphs.B.layers.layer-2.width' }
            ]);
        expect(result).toBe(false);
    });

    test('returns true when any entry is a non-layer glyph path', () => {
        const result =
            changeBridgeInit.shouldInvalidateLayoutClosureForCommittedEntries([
                { path: 'glyphs.A.layers.layer-1.anchors.0.x' },
                { path: 'glyphs.B' }
            ]);
        expect(result).toBe(true);
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

        await syncRustCacheAndRefreshCanvas(undefined, 'l', {
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

        await syncRustCacheAndRefreshCanvas(undefined, 'l', {
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

        await syncRustCacheAndRefreshCanvas(undefined, undefined, {
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

describe('requestUndoRedoEditingFontCompile', () => {
    let changeBridgeInit;
    let originalWindow;

    beforeEach(() => {
        jest.resetModules();
        originalWindow = global.window;
        global.window = originalWindow;
        changeBridgeInit = require('../js/change-bridge-init');
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    test('undo/redo compile requests tag the compile source and preserve the edit type', async () => {
        const checkAndSchedule = jest.fn();
        const forceTrigger = jest.fn().mockResolvedValue(undefined);
        const requestRecompileWithoutDataChange = jest.fn(function () {
            this.compileRequestVersion += 1;
        });

        window.autoCompileManager = {
            checkAndSchedule,
            forceTrigger
        };
        window.fontManager = {
            lastChangeSource: null,
            lastEditType: null,
            currentFont: {
                compileRequestVersion: 10,
                requestRecompileWithoutDataChange
            }
        };

        await changeBridgeInit.requestUndoRedoEditingFontCompile(
            true,
            'anchor'
        );

        expect(window.fontManager.lastChangeSource).toBe('keyboard-undo-redo');
        expect(window.fontManager.lastEditType).toBe('anchor');
        expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
        expect(checkAndSchedule).toHaveBeenCalledTimes(1);
        expect(forceTrigger).toHaveBeenCalledTimes(1);
        expect(window.fontManager.currentFont.compileRequestVersion).toBe(11);
    });

    test('undo/redo compile requests preserve kerning edit types', async () => {
        const checkAndSchedule = jest.fn();
        const requestRecompileWithoutDataChange = jest.fn(function () {
            this.compileRequestVersion += 1;
        });

        window.autoCompileManager = {
            checkAndSchedule
        };
        window.fontManager = {
            lastChangeSource: null,
            lastEditType: null,
            currentFont: {
                compileRequestVersion: 2,
                requestRecompileWithoutDataChange
            }
        };

        await changeBridgeInit.requestUndoRedoEditingFontCompile(
            false,
            'kerning-value'
        );

        expect(window.fontManager.lastChangeSource).toBe('keyboard-undo-redo');
        expect(window.fontManager.lastEditType).toBe('kerning-value');
        expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
        expect(checkAndSchedule).toHaveBeenCalledTimes(1);
    });
});
