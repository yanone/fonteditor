const {
    handleCommittedChangeRefresh,
    handleRemoteChangeRefresh,
    refreshGlyphOverviewFromGlyphNames,
    syncRustCacheAndRefreshCanvas,
    buildCascadingRecompositionOperations
} = require('../js/change-bridge-init');
const {
    fontCompilation,
    fullFontCompilation
} = require('../js/font-compilation');
const { sidebarErrorDisplay } = require('../js/sidebar-error-display');
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

    test('waits for local worker sync before requesting compile without a second replay-target refresh', async () => {
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
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(refreshOrder).toEqual(['sync', 'compile']);
        expect(glyphChangedHandler).toHaveBeenCalledTimes(1);
        expect(glyphChangedHandler.mock.calls[0][0].detail).toEqual({
            glyphName: 'a',
            glyphNames: ['a', 'adieresis']
        });
    });

    test('reconciles a materialized background selection after a local committed edit', async () => {
        const backgroundLayerId = 'background-layer';
        const refreshOrder = [];
        const outlineEditor = {
            active: true,
            draggingSomething: false,
            selectedLayerId: backgroundLayerId,
            parseGlyphStack: jest.fn(() => [
                { glyphName: 'a', layerId: backgroundLayerId }
            ]),
            reconcileSelectionAfterModelSync: jest.fn(async () => {
                refreshOrder.push('reconcile');
                expect(outlineEditor.selectedLayerId).toBe(backgroundLayerId);
            }),
            runDeterministicRefresh: jest.fn(async (refresh) => {
                refreshOrder.push('refresh');
                await refresh();
            }),
            fetchLayerData: jest.fn(async (skipRender, glyphName) => {
                refreshOrder.push('fetch');
                expect(skipRender).toBe(true);
                expect(glyphName).toBe('a');
                expect(outlineEditor.selectedLayerId).toBe(backgroundLayerId);
            })
        };
        const requestCompile = jest.fn(async () => {
            refreshOrder.push('compile');
        });
        const awaitWorkerSync = jest.fn(async () => {
            refreshOrder.push('sync');
        });

        window.glyphCanvas = {
            outlineEditor,
            requestRepaintAfterCompile: jest.fn()
        };
        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set()),
                    findGlyph: jest.fn((glyphName) =>
                        glyphName === 'a'
                            ? {
                                  findLayerById: jest.fn((layerId) =>
                                      layerId === backgroundLayerId
                                          ? {
                                                toJSON: () => ({
                                                    id: backgroundLayerId,
                                                    is_background: true,
                                                    shapes: []
                                                })
                                            }
                                          : null
                                  )
                              }
                            : null
                    )
                }
            },
            lastChangeSource: 'keyboard-outline',
            lastEditType: 'outline'
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Edit path',
                        path: `glyphs.a.layers.${backgroundLayerId}.shapes.0.nodes.0.x`,
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: backgroundLayerId }
                        ]
                    }
                ],
                'local',
                { awaitWorkerSync, requestCompile }
            );
        } finally {
            delete window.glyphCanvas;
            delete window.fontManager;
        }

        expect(
            outlineEditor.reconcileSelectionAfterModelSync
        ).toHaveBeenCalledWith({
            skipRender: true
        });
        expect(outlineEditor.fetchLayerData).toHaveBeenCalledWith(true, 'a');
        expect(requestCompile).toHaveBeenCalledWith(
            'keyboard-outline',
            'outline'
        );
        expect(refreshOrder).toEqual([
            'sync',
            'reconcile',
            'refresh',
            'fetch',
            'compile'
        ]);
    });

    test('defers local background reconciliation while a drag is active', async () => {
        const backgroundLayerId = 'background-layer';
        const outlineEditor = {
            active: true,
            draggingSomething: true,
            pendingRemoteRefreshAfterDrag: false,
            selectedLayerId: backgroundLayerId,
            parseGlyphStack: jest.fn(() => [
                { glyphName: 'a', layerId: backgroundLayerId }
            ]),
            reconcileSelectionAfterModelSync: jest.fn(),
            fetchLayerData: jest.fn()
        };
        const requestCompile = jest.fn(async () => {});

        window.glyphCanvas = {
            outlineEditor,
            requestRepaintAfterCompile: jest.fn()
        };
        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set()),
                    findGlyph: jest.fn((glyphName) =>
                        glyphName === 'a'
                            ? {
                                  findLayerById: jest.fn((layerId) =>
                                      layerId === backgroundLayerId
                                          ? {
                                                toJSON: () => ({
                                                    id: backgroundLayerId,
                                                    is_background: true,
                                                    shapes: []
                                                })
                                            }
                                          : null
                                  )
                              }
                            : null
                    )
                }
            },
            lastChangeSource: 'keyboard-outline',
            lastEditType: 'outline'
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Edit path',
                        path: `glyphs.a.layers.${backgroundLayerId}.shapes.0.nodes.0.x`,
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: backgroundLayerId }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync: jest.fn(async () => {}),
                    requestCompile
                }
            );
        } finally {
            delete window.glyphCanvas;
            delete window.fontManager;
        }

        expect(outlineEditor.pendingRemoteRefreshAfterDrag).toBe(true);
        expect(
            outlineEditor.reconcileSelectionAfterModelSync
        ).not.toHaveBeenCalled();
        expect(outlineEditor.fetchLayerData).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'keyboard-outline',
            'outline'
        );
    });

    test.each(['undo', 'redo'])(
        'reconciles a materialized background selection after local %s',
        async (historyAction) => {
            const backgroundLayerId = 'd82d1a85-7bc6-4ece-9b01-d9f9afda2f5a';
            const outlineEditor = {
                active: true,
                draggingSomething: false,
                selectedLayerId: backgroundLayerId,
                parseGlyphStack: jest.fn(() => [
                    { glyphName: 'a', layerId: backgroundLayerId }
                ]),
                reconcileSelectionAfterModelSync: jest.fn(async () => {}),
                runDeterministicRefresh: jest.fn(async (refresh) => refresh()),
                fetchLayerData: jest.fn(async () => {})
            };
            const requestCompile = jest.fn(async () => {});

            const glyphCanvas = {
                outlineEditor,
                requestRepaintAfterCompile: jest.fn()
            };
            window.glyphCanvas = glyphCanvas;
            window.fontManager = {
                currentFont: {
                    fontModel: {
                        collectComponentDependentGlyphs: jest.fn(
                            () => new Set()
                        ),
                        findGlyph: jest.fn((glyphName) =>
                            glyphName === 'a'
                                ? {
                                      findLayerById: jest.fn((layerId) =>
                                          layerId === backgroundLayerId
                                              ? {
                                                    is_background: true,
                                                    toJSON: () => ({
                                                        id: backgroundLayerId,
                                                        is_background: true,
                                                        shapes: []
                                                    })
                                                }
                                              : null
                                      )
                                  }
                                : null
                        )
                    }
                },
                lastChangeSource: 'keyboard-outline',
                lastEditType: 'outline'
            };

            try {
                await handleCommittedChangeRefresh(
                    [
                        {
                            historyAction,
                            transactionLabel: 'Edit path',
                            path: `glyphs.a.layers.${backgroundLayerId}.shapes.0.nodes.0.x`,
                            workerReplayTargets: [
                                { glyphName: 'a', layerId: backgroundLayerId }
                            ]
                        }
                    ],
                    'local',
                    {
                        awaitWorkerSync: jest.fn(async () => {}),
                        requestCompile
                    }
                );
            } finally {
                delete window.glyphCanvas;
                delete window.fontManager;
            }

            expect(
                outlineEditor.reconcileSelectionAfterModelSync
            ).toHaveBeenCalledWith({
                skipRender: true
            });
            expect(outlineEditor.fetchLayerData).toHaveBeenCalledWith(
                true,
                'a'
            );
            expect(
                glyphCanvas.requestRepaintAfterCompile
            ).toHaveBeenCalledTimes(1);
            expect(requestCompile).toHaveBeenCalledWith(
                'keyboard-outline',
                'outline'
            );
        }
    );

    test('local undo compiles from the forwarded worker update without a replay-target refresh', async () => {
        const refreshOrder = [];
        const awaitWorkerSync = jest.fn(async () => {
            refreshOrder.push('sync');
            window.fontManager.lastChangeSource = 'keyboard-anchor';
            window.fontManager.lastEditType = 'anchor';
        });
        const queueCacheRefresh = jest.fn(async () => {
            refreshOrder.push('queue');
        });
        const requestCompile = jest.fn(async () => {
            refreshOrder.push('compile');
        });

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
            workerCacheUpdatePromise: null,
            awaitWorkerCacheUpdate: jest.fn(async () => {
                refreshOrder.push('post-cache');
            })
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        historyAction: 'undo',
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
        } finally {
            delete window.fontManager;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'keyboard-anchor',
            'anchor'
        );
        expect(refreshOrder).toEqual(['sync', 'compile']);
    });

    test('retries local undo compile readiness from worker-sync state before compiling', async () => {
        const refreshOrder = [];
        const previousInitialized = fontCompilation.isInitialized;
        const previousWorkerCacheReady =
            fontCompilation.hasWorkerCacheDocument();
        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);

        const awaitWorkerSync = jest.fn(async () => {
            refreshOrder.push('sync');
            if (awaitWorkerSync.mock.calls.length === 2) {
                fontCompilation.setWorkerCacheDocumentReady(true);
            }
        });
        const queueCacheRefresh = jest.fn(async () => {
            refreshOrder.push('queue');
        });
        const requestCompile = jest.fn(async () => {
            refreshOrder.push('compile');
        });

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
            workerCacheUpdatePromise: null,
            awaitWorkerCacheUpdate: jest.fn(async () => {
                refreshOrder.push('cache');
            })
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        historyAction: 'undo',
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
        } finally {
            fontCompilation.isInitialized = previousInitialized;
            fontCompilation.setWorkerCacheDocumentReady(
                previousWorkerCacheReady
            );
            delete window.fontManager;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(2);
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'keyboard-anchor',
            'anchor'
        );
        expect(refreshOrder).toEqual(['sync', 'sync', 'compile']);
    });

    test('skips local undo compile only when worker cache remains unready after readiness retry', async () => {
        const refreshOrder = [];
        const previousInitialized = fontCompilation.isInitialized;
        const previousWorkerCacheReady =
            fontCompilation.hasWorkerCacheDocument();
        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);

        const awaitWorkerSync = jest.fn(async () => {
            refreshOrder.push('sync');
        });
        const queueCacheRefresh = jest.fn(async () => {
            refreshOrder.push('queue');
        });
        const requestCompile = jest.fn(async () => {
            refreshOrder.push('compile');
        });

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
            workerCacheUpdatePromise: null,
            awaitWorkerCacheUpdate: jest.fn(async () => {
                refreshOrder.push('cache');
            })
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        historyAction: 'undo',
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
        } finally {
            fontCompilation.isInitialized = previousInitialized;
            fontCompilation.setWorkerCacheDocumentReady(
                previousWorkerCacheReady
            );
            delete window.fontManager;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(2);
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).not.toHaveBeenCalled();
        expect(refreshOrder).toEqual(['sync', 'sync']);
    });

    test('skips local committed compile when worker cache remains unready after readiness retry', async () => {
        const refreshOrder = [];
        const previousInitialized = fontCompilation.isInitialized;
        const previousWorkerCacheReady =
            fontCompilation.hasWorkerCacheDocument();
        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);

        const awaitWorkerSync = jest.fn(async () => {
            refreshOrder.push('sync');
        });
        const queueCacheRefresh = jest.fn(async () => {
            refreshOrder.push('queue');
        });
        const requestCompile = jest.fn(async () => {
            refreshOrder.push('compile');
        });

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
            workerCacheUpdatePromise: null,
            awaitWorkerCacheUpdate: jest.fn(async () => {
                refreshOrder.push('cache');
            })
        };

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
        } finally {
            fontCompilation.isInitialized = previousInitialized;
            fontCompilation.setWorkerCacheDocumentReady(
                previousWorkerCacheReady
            );
            delete window.fontManager;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(2);
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).not.toHaveBeenCalled();
        expect(refreshOrder).toEqual(['sync', 'sync']);
    });

    test('local committed keyboard outline clears stale drift flag and compiles after worker sync', async () => {
        const previousWorkerCacheReady =
            fontCompilation.hasWorkerCacheDocument();
        const awaitWorkerSync = jest.fn(async () => {
            fontCompilation.setWorkerCacheDocumentReady(true);
        });
        const requestCompile = jest.fn(async () => {});
        const originalShowError = sidebarErrorDisplay.showError;
        const showErrorMock = jest.fn();
        const originalSendMessage = fontCompilation.sendMessage;
        const originalIsInitialized = fontCompilation.isInitialized;
        const sendMessageMock = jest.fn(async () => ({ success: true }));

        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);
        fontCompilation.sendMessage = sendMessageMock;
        sidebarErrorDisplay.showError = showErrorMock;

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            pendingBabelfontJsonSyncAfterDrag: false,
            pendingCommittedKeyboardDriftCheckAfterDrag: true,
            lastChangeSource: 'keyboard-outline',
            lastEditType: 'outline'
        };
        const fontManagerState = window.fontManager;

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Arrow key',
                        path: 'glyphs.a.layers.layer-1.shapes.0.nodes.0.x',
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: 'layer-1' }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile
                }
            );
        } finally {
            delete window.fontManager;
            fontCompilation.sendMessage = originalSendMessage;
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.setWorkerCacheDocumentReady(
                previousWorkerCacheReady
            );
            sidebarErrorDisplay.showError = originalShowError;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'keyboard-outline',
            'outline'
        );
        expect(showErrorMock).not.toHaveBeenCalled();
        expect(
            fontManagerState.pendingCommittedKeyboardDriftCheckAfterDrag
        ).toBe(false);
    });

    test('local committed non-keyboard outline compiles without dump-layer inspection', async () => {
        const previousWorkerCacheReady =
            fontCompilation.hasWorkerCacheDocument();
        const awaitWorkerSync = jest.fn(async () => {
            fontCompilation.setWorkerCacheDocumentReady(true);
        });
        const requestCompile = jest.fn(async () => {});
        const originalShowError = sidebarErrorDisplay.showError;
        const showErrorMock = jest.fn();
        const originalSendMessage = fontCompilation.sendMessage;
        const originalIsInitialized = fontCompilation.isInitialized;
        const sendMessageMock = jest.fn(async () => ({ success: true }));

        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);
        fontCompilation.sendMessage = sendMessageMock;
        sidebarErrorDisplay.showError = showErrorMock;

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            lastChangeSource: 'keyboard-outline',
            lastEditType: 'outline'
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Drag point',
                        path: 'glyphs.a.layers.layer-1.shapes.0.nodes.0.x',
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: 'layer-1' }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile
                }
            );
        } finally {
            delete window.fontManager;
            fontCompilation.sendMessage = originalSendMessage;
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.setWorkerCacheDocumentReady(
                previousWorkerCacheReady
            );
            sidebarErrorDisplay.showError = originalShowError;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'keyboard-outline',
            'outline'
        );
        expect(showErrorMock).not.toHaveBeenCalled();
    });

    test('local committed outline with dependent replay targets compiles without dump-layer inspection', async () => {
        const previousWorkerCacheReady =
            fontCompilation.hasWorkerCacheDocument();
        const awaitWorkerSync = jest.fn(async () => {
            fontCompilation.setWorkerCacheDocumentReady(true);
        });
        const requestCompile = jest.fn(async () => {});
        const originalShowError = sidebarErrorDisplay.showError;
        const showErrorMock = jest.fn();
        const originalSendMessage = fontCompilation.sendMessage;
        const originalIsInitialized = fontCompilation.isInitialized;
        const expectedLayer = {
            width: 533,
            id: 'layer-1',
            master: { type: 'DefaultForMaster', master: 'master-1' },
            shapes: [
                {
                    id: 'shape-1',
                    nodes: [
                        { x: 322, y: -8, nodetype: 'OffCurve', id: 'node-1' }
                    ],
                    closed: true
                }
            ],
            anchors: [{ name: 'top', x: 145, y: 594 }],
            guides: [],
            format_specific: {}
        };
        const rustLayerDifferentKeyOrder = {
            master: { master: 'master-1', type: 'DefaultForMaster' },
            shapes: [
                {
                    nodes: [
                        { y: -8, id: 'node-1', x: 322, nodetype: 'OffCurve' }
                    ],
                    closed: true,
                    id: 'shape-1'
                }
            ],
            width: 533,
            guides: [],
            anchors: [{ y: 594, name: 'top', x: 145 }],
            format_specific: {},
            id: 'layer-1'
        };
        const dependentLayer = {
            width: 533,
            id: 'layer-1',
            master: { type: 'DefaultForMaster', master: 'master-1' },
            shapes: [{ id: 'component-1', reference: 'a' }],
            format_specific: {}
        };
        const dependentLayerDifferentKeyOrder = {
            shapes: [{ reference: 'a', id: 'component-1' }],
            width: 533,
            master: { master: 'master-1', type: 'DefaultForMaster' },
            format_specific: {},
            id: 'layer-1'
        };
        const sendMessageMock = jest.fn(async () => ({
            dumpJson: JSON.stringify({
                targets: [
                    {
                        glyphName: 'a',
                        layerId: 'layer-1',
                        canonicalLayer: rustLayerDifferentKeyOrder,
                        subsetLayer: rustLayerDifferentKeyOrder,
                        ydocLayer: rustLayerDifferentKeyOrder
                    },
                    {
                        glyphName: 'aacute',
                        layerId: 'layer-1',
                        canonicalLayer: dependentLayerDifferentKeyOrder,
                        subsetLayer: null,
                        ydocLayer: dependentLayerDifferentKeyOrder
                    }
                ]
            })
        }));

        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);
        fontCompilation.sendMessage = sendMessageMock;
        sidebarErrorDisplay.showError = showErrorMock;

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set()),
                    findGlyph: jest.fn((glyphName) => ({
                        findLayerById: jest.fn((layerId) => {
                            if (layerId !== 'layer-1') {
                                return null;
                            }
                            if (glyphName === 'a') {
                                return { toJSON: () => expectedLayer };
                            }
                            if (glyphName === 'aacute') {
                                return { toJSON: () => dependentLayer };
                            }
                            return null;
                        })
                    }))
                }
            },
            lastChangeSource: 'keyboard-outline',
            lastEditType: 'outline',
            normalizeLayerForRust: jest.fn((layer) => layer)
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Drag point',
                        path: 'glyphs.a.layers.layer-1.shapes.0.nodes.0.x',
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: 'layer-1' },
                            { glyphName: 'aacute', layerId: 'layer-1' }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile
                }
            );
        } finally {
            delete window.fontManager;
            fontCompilation.sendMessage = originalSendMessage;
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.setWorkerCacheDocumentReady(
                previousWorkerCacheReady
            );
            sidebarErrorDisplay.showError = originalShowError;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(showErrorMock).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'keyboard-outline',
            'outline'
        );
    });

    test('local committed outline ignores retired rust cache drift inspection for empty optional containers', async () => {
        const previousWorkerCacheReady =
            fontCompilation.hasWorkerCacheDocument();
        const awaitWorkerSync = jest.fn(async () => {
            fontCompilation.setWorkerCacheDocumentReady(true);
        });
        const requestCompile = jest.fn(async () => {});
        const originalShowError = sidebarErrorDisplay.showError;
        const showErrorMock = jest.fn();
        const originalSendMessage = fontCompilation.sendMessage;
        const originalIsInitialized = fontCompilation.isInitialized;
        const expectedLayer = {
            width: 533,
            id: 'layer-1',
            master: { type: 'DefaultForMaster', master: 'master-1' },
            shapes: [
                {
                    id: 'shape-1',
                    nodes: [
                        { x: 322, y: -8, nodetype: 'OffCurve', id: 'node-1' }
                    ],
                    closed: true
                }
            ],
            anchors: [{ name: 'top', x: 145, y: 594 }]
        };
        const rustCanonicalLayer = {
            ...expectedLayer,
            guides: [],
            format_specific: {}
        };
        const sendMessageMock = jest.fn(async () => ({
            dumpJson: JSON.stringify({
                targets: [
                    {
                        glyphName: 'a',
                        layerId: 'layer-1',
                        canonicalLayer: rustCanonicalLayer,
                        subsetLayer: rustCanonicalLayer,
                        ydocLayer: expectedLayer
                    }
                ]
            })
        }));

        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);
        fontCompilation.sendMessage = sendMessageMock;
        sidebarErrorDisplay.showError = showErrorMock;

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set()),
                    findGlyph: jest.fn((glyphName) => ({
                        findLayerById: jest.fn((layerId) =>
                            glyphName === 'a' && layerId === 'layer-1'
                                ? {
                                      toJSON: () => expectedLayer
                                  }
                                : null
                        )
                    }))
                }
            },
            lastChangeSource: 'keyboard-outline',
            lastEditType: 'outline',
            normalizeLayerForRust: jest.fn((layer) => layer)
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Drag point',
                        path: 'glyphs.a.layers.layer-1.shapes.0.nodes.0.x',
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: 'layer-1' }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile
                }
            );
        } finally {
            delete window.fontManager;
            fontCompilation.sendMessage = originalSendMessage;
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.setWorkerCacheDocumentReady(
                previousWorkerCacheReady
            );
            sidebarErrorDisplay.showError = originalShowError;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(showErrorMock).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'keyboard-outline',
            'outline'
        );
    });

    test('local committed outline ignores retired rust cache drift inspection for nested empty format_specific trees', async () => {
        const previousWorkerCacheReady =
            fontCompilation.hasWorkerCacheDocument();
        const awaitWorkerSync = jest.fn(async () => {
            fontCompilation.setWorkerCacheDocumentReady(true);
        });
        const requestCompile = jest.fn(async () => {});
        const originalShowError = sidebarErrorDisplay.showError;
        const showErrorMock = jest.fn();
        const originalSendMessage = fontCompilation.sendMessage;
        const originalIsInitialized = fontCompilation.isInitialized;
        const expectedLayer = {
            width: 533,
            id: 'layer-1',
            master: { type: 'DefaultForMaster', master: 'master-1' },
            shapes: [
                {
                    id: 'shape-1',
                    nodes: [
                        { x: 322, y: -8, nodetype: 'OffCurve', id: 'node-1' }
                    ],
                    closed: true
                }
            ],
            anchors: [{ name: 'top', x: 145, y: 594 }]
        };
        const rustCanonicalLayer = {
            ...expectedLayer,
            format_specific: {
                com: {
                    schriftgestalt: {
                        Glyphs: {
                            attr: {}
                        }
                    }
                }
            }
        };
        const sendMessageMock = jest.fn(async () => ({
            dumpJson: JSON.stringify({
                targets: [
                    {
                        glyphName: 'a',
                        layerId: 'layer-1',
                        canonicalLayer: rustCanonicalLayer,
                        subsetLayer: rustCanonicalLayer,
                        ydocLayer: expectedLayer
                    }
                ]
            })
        }));

        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);
        fontCompilation.sendMessage = sendMessageMock;
        sidebarErrorDisplay.showError = showErrorMock;

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set()),
                    findGlyph: jest.fn((glyphName) => ({
                        findLayerById: jest.fn((layerId) =>
                            glyphName === 'a' && layerId === 'layer-1'
                                ? {
                                      toJSON: () => expectedLayer
                                  }
                                : null
                        )
                    }))
                }
            },
            lastChangeSource: 'keyboard-outline',
            lastEditType: 'outline',
            normalizeLayerForRust: jest.fn((layer) => layer)
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Drag point',
                        path: 'glyphs.a.layers.layer-1.shapes.0.nodes.0.x',
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: 'layer-1' }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile
                }
            );
        } finally {
            delete window.fontManager;
            fontCompilation.sendMessage = originalSendMessage;
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.setWorkerCacheDocumentReady(
                previousWorkerCacheReady
            );
            sidebarErrorDisplay.showError = originalShowError;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(showErrorMock).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'keyboard-outline',
            'outline'
        );
    });

    test('local committed outline does not gate compile on retired semantic drift inspection', async () => {
        const previousWorkerCacheReady =
            fontCompilation.hasWorkerCacheDocument();
        const awaitWorkerSync = jest.fn(async () => {
            fontCompilation.setWorkerCacheDocumentReady(true);
        });
        const requestCompile = jest.fn(async () => {});
        const originalShowError = sidebarErrorDisplay.showError;
        const showErrorMock = jest.fn();
        const originalSendMessage = fontCompilation.sendMessage;
        const originalIsInitialized = fontCompilation.isInitialized;
        const expectedLayer = {
            width: 533,
            id: 'layer-1',
            master: { type: 'DefaultForMaster', master: 'master-1' },
            shapes: [
                {
                    id: 'shape-1',
                    nodes: [
                        { x: 322, y: -8, nodetype: 'OffCurve', id: 'node-1' }
                    ],
                    closed: true
                }
            ],
            anchors: [{ name: 'top', x: 145, y: 594 }]
        };
        const rustCanonicalLayer = {
            ...expectedLayer,
            format_specific: { legacy: true }
        };
        const sendMessageMock = jest.fn(async () => ({
            dumpJson: JSON.stringify({
                targets: [
                    {
                        glyphName: 'a',
                        layerId: 'layer-1',
                        canonicalLayer: rustCanonicalLayer,
                        subsetLayer: rustCanonicalLayer,
                        ydocLayer: expectedLayer
                    }
                ]
            })
        }));

        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);
        fontCompilation.sendMessage = sendMessageMock;
        sidebarErrorDisplay.showError = showErrorMock;

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set()),
                    findGlyph: jest.fn((glyphName) => ({
                        findLayerById: jest.fn((layerId) =>
                            glyphName === 'a' && layerId === 'layer-1'
                                ? {
                                      toJSON: () => expectedLayer
                                  }
                                : null
                        )
                    }))
                }
            },
            lastChangeSource: 'keyboard-outline',
            lastEditType: 'outline',
            normalizeLayerForRust: jest.fn((layer) => layer)
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Drag point',
                        path: 'glyphs.a.layers.layer-1.shapes.0.nodes.0.x',
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: 'layer-1' }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile
                }
            );
        } finally {
            delete window.fontManager;
            fontCompilation.sendMessage = originalSendMessage;
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.setWorkerCacheDocumentReady(
                previousWorkerCacheReady
            );
            sidebarErrorDisplay.showError = originalShowError;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(showErrorMock).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'keyboard-outline',
            'outline'
        );
    });

    test('local committed anchor refresh compiles without dump-layer inspection when subset cache is absent', async () => {
        const previousWorkerCacheReady =
            fontCompilation.hasWorkerCacheDocument();
        const awaitWorkerSync = jest.fn(async () => {
            fontCompilation.setWorkerCacheDocumentReady(true);
        });
        const requestCompile = jest.fn(async () => {});
        const originalShowError = sidebarErrorDisplay.showError;
        const showErrorMock = jest.fn();
        const originalSendMessage = fontCompilation.sendMessage;
        const originalIsInitialized = fontCompilation.isInitialized;
        const sourceLayer = {
            width: 533,
            id: '3114FB65-9464-41A5-B67E-A8F9F43C0EF1',
            master: {
                master: '3114FB65-9464-41A5-B67E-A8F9F43C0EF1',
                type: 'DefaultForMaster'
            },
            shapes: [
                {
                    id: 'source-component-1',
                    reference: 'a',
                    transform: {
                        order: 'RestOfTheWorld',
                        rotation: 0,
                        scale: [1, 1],
                        skew: [0, 0],
                        translation: [0, 0]
                    }
                }
            ],
            format_specific: {
                'com.schriftgestalt.Glyphs.attr': {}
            }
        };
        const dependentLayer = {
            width: 533,
            id: '3114FB65-9464-41A5-B67E-A8F9F43C0EF1',
            master: {
                master: '3114FB65-9464-41A5-B67E-A8F9F43C0EF1',
                type: 'DefaultForMaster'
            },
            shapes: [
                {
                    id: 'dependent-component-1',
                    reference: 'a',
                    transform: {
                        order: 'RestOfTheWorld',
                        rotation: 0,
                        scale: [1, 1],
                        skew: [0, 0],
                        translation: [0, 0]
                    }
                },
                {
                    id: 'dependent-component-2',
                    reference: 'acutecomb',
                    transform: {
                        order: 'Glyphs',
                        rotation: 0,
                        scale: [1, 1],
                        skew: [0, 0],
                        translation: [136, 77]
                    }
                }
            ],
            format_specific: {
                'com.schriftgestalt.Glyphs.attr': {}
            }
        };
        const sendMessageMock = jest.fn(async () => ({
            dumpJson: JSON.stringify({
                targets: [
                    {
                        glyphName: 'a',
                        layerId: '3114FB65-9464-41A5-B67E-A8F9F43C0EF1',
                        canonicalLayer: sourceLayer,
                        subsetLayer: null,
                        ydocLayer: sourceLayer
                    },
                    {
                        glyphName: 'aacute',
                        layerId: '3114FB65-9464-41A5-B67E-A8F9F43C0EF1',
                        canonicalLayer: dependentLayer,
                        subsetLayer: null,
                        ydocLayer: dependentLayer
                    }
                ]
            })
        }));

        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);
        fontCompilation.sendMessage = sendMessageMock;
        sidebarErrorDisplay.showError = showErrorMock;

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set()),
                    findGlyph: jest.fn((glyphName) => ({
                        findLayerById: jest.fn((layerId) =>
                            glyphName === 'a' &&
                            layerId === '3114FB65-9464-41A5-B67E-A8F9F43C0EF1'
                                ? { toJSON: () => sourceLayer }
                                : glyphName === 'aacute' &&
                                    layerId ===
                                        '3114FB65-9464-41A5-B67E-A8F9F43C0EF1'
                                  ? { toJSON: () => dependentLayer }
                                  : null
                        )
                    }))
                }
            },
            lastChangeSource: 'keyboard-outline',
            lastEditType: 'outline',
            normalizeLayerForRust: jest.fn((layer) => layer)
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Drag anchor',
                        path: 'glyphs.a.layers.3114FB65-9464-41A5-B67E-A8F9F43C0EF1.anchors.0.x',
                        workerReplayTargets: [
                            {
                                glyphName: 'a',
                                layerId: '3114FB65-9464-41A5-B67E-A8F9F43C0EF1'
                            },
                            {
                                glyphName: 'aacute',
                                layerId: '3114FB65-9464-41A5-B67E-A8F9F43C0EF1'
                            }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile
                }
            );
        } finally {
            delete window.fontManager;
            fontCompilation.sendMessage = originalSendMessage;
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.setWorkerCacheDocumentReady(
                previousWorkerCacheReady
            );
            sidebarErrorDisplay.showError = originalShowError;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(showErrorMock).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'keyboard-anchor',
            'anchor'
        );
    });

    test('continues the post-commit keyboard compile when post-drag worker state is already fresh', async () => {
        const previousWorkerCacheReady =
            fontCompilation.hasWorkerCacheDocument();
        const awaitWorkerSync = jest.fn(async () => {
            fontCompilation.setWorkerCacheDocumentReady(true);
        });
        const requestCompile = jest.fn(async () => {});
        const originalShowError = sidebarErrorDisplay.showError;
        const showErrorMock = jest.fn();
        const originalSendMessage = fontCompilation.sendMessage;
        const originalIsInitialized = fontCompilation.isInitialized;
        const expectedLayer = {
            width: 542,
            shapes: [],
            anchors: [{ name: 'top', x: 278, y: 500 }],
            guides: []
        };
        const sendMessageMock = jest.fn(async () => ({
            dumpJson: JSON.stringify({
                targets: [
                    {
                        glyphName: 'a',
                        layerId: 'layer-1',
                        canonicalLayer: expectedLayer,
                        subsetLayer: expectedLayer,
                        ydocLayer: expectedLayer
                    }
                ]
            })
        }));

        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);
        fontCompilation.sendMessage = sendMessageMock;
        sidebarErrorDisplay.showError = showErrorMock;

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set()),
                    findGlyph: jest.fn((glyphName) => ({
                        findLayerById: jest.fn((layerId) =>
                            glyphName === 'a' && layerId === 'layer-1'
                                ? {
                                      toJSON: () => expectedLayer
                                  }
                                : null
                        )
                    }))
                }
            },
            pendingBabelfontJsonSyncAfterDrag: false,
            pendingCommittedKeyboardDriftCheckAfterDrag: true,
            lastChangeSource: 'keyboard-outline',
            lastEditType: 'outline',
            normalizeLayerForRust: jest.fn((layer) => layer)
        };
        const fontManagerState = window.fontManager;

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Arrow key',
                        path: 'glyphs.a.layers.layer-1.shapes.0.nodes.0.x',
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: 'layer-1' }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile
                }
            );
        } finally {
            delete window.fontManager;
            fontCompilation.sendMessage = originalSendMessage;
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.setWorkerCacheDocumentReady(
                previousWorkerCacheReady
            );
            sidebarErrorDisplay.showError = originalShowError;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(showErrorMock).not.toHaveBeenCalled();
        expect(
            fontManagerState.pendingCommittedKeyboardDriftCheckAfterDrag
        ).toBe(false);
        expect(requestCompile).toHaveBeenCalledWith(
            'keyboard-outline',
            'outline'
        );
    });

    test('skips the post-commit keyboard drift check in fresh keyboard state', async () => {
        const previousWorkerCacheReady =
            fontCompilation.hasWorkerCacheDocument();
        const awaitWorkerSync = jest.fn(async () => {
            fontCompilation.setWorkerCacheDocumentReady(true);
        });
        const requestCompile = jest.fn(async () => {});
        const originalShowError = sidebarErrorDisplay.showError;
        const showErrorMock = jest.fn();
        const originalSendMessage = fontCompilation.sendMessage;
        const originalIsInitialized = fontCompilation.isInitialized;
        const sendMessageMock = jest.fn(async () => ({ success: true }));

        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);
        fontCompilation.sendMessage = sendMessageMock;
        sidebarErrorDisplay.showError = showErrorMock;

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            pendingBabelfontJsonSyncAfterDrag: false,
            pendingCommittedKeyboardDriftCheckAfterDrag: false,
            lastChangeSource: 'keyboard-outline',
            lastEditType: 'outline',
            normalizeLayerForRust: jest.fn((layer) => layer)
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Arrow key',
                        path: 'glyphs.a.layers.layer-1.shapes.0.nodes.0.x',
                        workerReplayTargets: [
                            { glyphName: 'a', layerId: 'layer-1' }
                        ]
                    }
                ],
                'local',
                {
                    awaitWorkerSync,
                    requestCompile
                }
            );
        } finally {
            delete window.fontManager;
            fontCompilation.sendMessage = originalSendMessage;
            fontCompilation.isInitialized = originalIsInitialized;
            fontCompilation.setWorkerCacheDocumentReady(
                previousWorkerCacheReady
            );
            sidebarErrorDisplay.showError = originalShowError;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(showErrorMock).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'keyboard-outline',
            'outline'
        );
    });

    test('prefers inferred keyboard-anchor context over a stale trailing full-compile source', async () => {
        const awaitWorkerSync = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});
        const queueCacheRefresh = jest.fn(async () => {});

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            lastChangeSource: 'debounced-post-interaction-full-compile',
            lastEditType: null
        };

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Move anchor',
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
            delete window.fontManager;
        }

        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'keyboard-anchor',
            'anchor'
        );
    });

    test('refreshes local replay targets for forwarded master reinterpolation glyph snapshots before compile', async () => {
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

    test('refreshes local replay targets for forwarded add-master batch packets before compile', async () => {
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
            lastEditType: null,
            setEditingCompileContext(changeSource, editType) {
                this.lastChangeSource = changeSource;
                this.lastEditType = editType;
            },
            clearEditingCompileContext() {
                this.lastChangeSource = null;
                this.lastEditType = null;
            }
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

    test('waits for chained local worker cache updates before compile and overview refresh', async () => {
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
                if (
                    window.fontManager.workerCacheUpdatePromise ===
                    pendingPromise
                ) {
                    window.fontManager.workerCacheUpdatePromise = null;
                }
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

            // requestCompile is still deferred until the forwarded worker sync
            // and any chained worker-cache updates have completed.
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

    test('requests remote compile only after worker cache update resolve', async () => {
        const refreshOrder = [];
        let resolveCacheUpdate;
        let resolveWorkerSync;
        const workerSyncPromise = new Promise((resolve) => {
            resolveWorkerSync = () => {
                refreshOrder.push('sync-resolved');
                resolve();
            };
        });
        const awaitWorkerSync = jest.fn(async () => {
            refreshOrder.push('sync');
            await workerSyncPromise;
        });
        const cacheUpdatePromise = new Promise((resolve) => {
            resolveCacheUpdate = () => {
                refreshOrder.push('cache-resolved');
                resolve();
            };
        });
        const awaitWorkerCacheUpdate = jest.fn(async () => {
            refreshOrder.push('cache');
            await window.fontManager.workerCacheUpdatePromise;
        });
        const requestCompile = jest.fn(async () => {
            refreshOrder.push('compile');
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

        try {
            window.fontManager = {
                workerCacheUpdatePromise: cacheUpdatePromise,
                awaitWorkerCacheUpdate
            };
            const refreshPromise = handleRemoteChangeRefresh(remoteEntries, {
                requestCompile,
                awaitWorkerSync
            });

            expect(requestCompile).not.toHaveBeenCalled();
            expect(refreshOrder).toEqual(['sync']);

            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
            expect(requestCompile).not.toHaveBeenCalled();
            expect(refreshOrder).toEqual(['sync']);

            resolveWorkerSync();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            expect(awaitWorkerCacheUpdate).toHaveBeenCalledTimes(1);
            expect(requestCompile).not.toHaveBeenCalled();
            expect(refreshOrder).toEqual(['sync', 'sync-resolved', 'cache']);

            resolveCacheUpdate();
            await refreshPromise;

            expect(requestCompile).toHaveBeenCalledTimes(1);
            expect(requestCompile).toHaveBeenNthCalledWith(
                1,
                'remote-anchor',
                'anchor'
            );
            expect(refreshOrder).toEqual([
                'sync',
                'sync-resolved',
                'cache',
                'cache-resolved',
                'sync',
                'compile'
            ]);
            expect(refreshOrder.indexOf('compile')).toBeGreaterThan(
                refreshOrder.indexOf('cache-resolved')
            );
        } finally {
            delete window.fontManager;
        }
    });

    test('refreshes the active receiver outline editor after worker sync without a second worker cache refresh', async () => {
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
        const requestRepaintAfterCompile = jest.fn(() => {
            refreshOrder.push('repaint');
        });
        const reconcileSelectionAfterModelSync = jest.fn(async () => {
            refreshOrder.push('reconcile');
        });
        const fetchLayerData = jest.fn(async (skipRender, glyphName) => {
            refreshOrder.push(
                `fetch:${skipRender ? 'skip' : 'render'}:${glyphName}`
            );
        });

        window.glyphCanvas = {
            requestRepaintAfterCompile,
            outlineEditor: {
                active: true,
                draggingSomething: false,
                pendingRemoteRefreshAfterDrag: false,
                selectedLayerId: 'master-regular',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'a' }]),
                reconcileSelectionAfterModelSync,
                fetchLayerData,
                runDeterministicRefresh: jest.fn(async (callback) => {
                    refreshOrder.push('deterministic');
                    await callback();
                })
            }
        };
        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            awaitWorkerCacheUpdate: jest.fn(async () => {
                refreshOrder.push('cache');
            })
        };

        try {
            await handleRemoteChangeRefresh(
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
                {
                    awaitWorkerSync,
                    requestCompile,
                    queueCacheRefresh
                }
            );
        } finally {
            delete window.glyphCanvas;
            delete window.fontManager;
        }

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(reconcileSelectionAfterModelSync).toHaveBeenCalledWith({
            skipRender: true
        });
        expect(fetchLayerData).toHaveBeenCalledWith(true, 'a');
        expect(requestRepaintAfterCompile).toHaveBeenCalledTimes(1);
        expect(requestCompile).toHaveBeenCalledWith('remote-anchor', 'anchor');
        expect(refreshOrder).toEqual([
            'sync',
            'reconcile',
            'deterministic',
            'fetch:skip:a',
            'repaint',
            'compile'
        ]);
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

        expect(queueCacheRefresh).not.toHaveBeenCalled();
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

        expect(queueCacheRefresh).not.toHaveBeenCalled();
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

        expect(queueCacheRefresh).not.toHaveBeenCalled();
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

        expect(queueCacheRefresh).not.toHaveBeenCalled();
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

        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'remote-outline',
            'outline'
        );
    });

    test('local GUI commit with downstream replay targets refreshes dependents before compile', async () => {
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

        expect(awaitWorkerSync).toHaveBeenCalledTimes(1);
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'keyboard-outline',
            'outline'
        );
    });

    test('local sidebearing-key commit with downstream replay targets refreshes dependents before compile', async () => {
        const awaitWorkerSync = jest.fn(async () => {});
        const requestCompile = jest.fn(async () => {});
        const queueCacheRefresh = jest.fn(async () => {});
        const glyphChangedHandler = jest.fn();
        const replayTargets = [
            { glyphName: 'A', layerId: 'layer-1' },
            { glyphName: 'B', layerId: 'layer-2' }
        ];

        window.fontManager = {
            currentFont: {
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            },
            lastChangeSource: 'keyboard-sidebearing',
            lastEditType: 'outline'
        };
        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            await handleCommittedChangeRefresh(
                [
                    {
                        transactionLabel: 'Set sidebearing',
                        path: 'glyphs.A.format_specific.metric_right'
                    },
                    {
                        transactionLabel: 'Set sidebearing',
                        path: 'glyphs.A.layers.layer-1.width',
                        visualAnchorSide: 'right',
                        workerReplayTargets: replayTargets
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
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestCompile).toHaveBeenCalledWith(
            'keyboard-outline',
            'outline'
        );
    });

    test('local feature-code commit still relies on the forwarded worker update', async () => {
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

        // Local committed packets rely on the forwarded worker update even
        // when the edit is not a layer-scoped GUI packet.
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

        test.each(['left', 'right'])(
            'remote sidebearing edit (%s) preserves the linked window pan',
            async (side) => {
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
                expect(afterPanX).toBeCloseTo(beforePanX, 5);
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
    const originalAutoCompileManager = window.autoCompileManager;
    const originalSaveButton = window.saveButton;
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
        window.autoCompileManager = originalAutoCompileManager;
        window.saveButton = originalSaveButton;
        fontCompilation.isInitialized = originalInitialized;
        jest.restoreAllMocks();
    });

    test('dirty callback marks unsaved state without creating an ambient editing compile request', () => {
        const markDirty = jest.fn();
        const requestRecompileWithoutDataChange = jest.fn();
        const updateDirtyIndicator = jest.fn();
        const updateButtonState = jest.fn();

        fontCompilation.isInitialized = false;
        window.windowRole = {
            isLinkedWindow: () => false,
            getRoleLabel: () => 'main'
        };
        window.autoCompileManager = { checkAndSchedule: jest.fn() };
        window.saveButton = { updateButtonState };
        window.fontManager = {
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
            replaceWorkerYjsMirrorFromState: jest.fn(),
            clearEditingCompileContext: jest.fn(),
            pendingBabelfontJsonSyncAfterDrag: false,
            updateDirtyIndicator,
            currentFont: {
                changeVersion: 1,
                compileRequestVersion: 1,
                markDirty,
                requestRecompileWithoutDataChange,
                fontModel: {
                    collectComponentDependentGlyphs: jest.fn(() => new Set())
                }
            }
        };

        const bridge = initializeBridgeHarness();
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            610
        );

        expect(markDirty).toHaveBeenCalledWith(undefined, {
            requestEditingCompile: false
        });
        expect(requestRecompileWithoutDataChange).not.toHaveBeenCalled();
        expect(updateDirtyIndicator).toHaveBeenCalledTimes(1);
        expect(updateButtonState).toHaveBeenCalledTimes(1);
    });

    test('seeds the worker from the authoritative bridge Y.Doc', async () => {
        const replaceWorkerYjsMirrorFromState = jest.fn();
        const workerSeedSpy = jest
            .spyOn(fontCompilation, 'seedWorkerYDocFromState')
            .mockResolvedValue();
        const trackWorkerDocumentSyncSpy = jest.spyOn(
            fontCompilation,
            'trackWorkerDocumentSync'
        );

        fontCompilation.isInitialized = false;
        window.windowRole = {
            isLinkedWindow: () => false
        };
        window.fontManager = { replaceWorkerYjsMirrorFromState };

        const bridge = initializeBridgeHarness();
        await Promise.resolve();

        const [seedState] = workerSeedSpy.mock.calls[0];
        expect(seedState).toEqual(expect.any(Uint8Array));
        expect(Array.from(seedState)).toEqual(
            Array.from(bridge.encodeBridgeState())
        );
        expect(replaceWorkerYjsMirrorFromState).toHaveBeenCalledWith(seedState);
        expect(trackWorkerDocumentSyncSpy).toHaveBeenCalledWith(
            expect.any(Promise)
        );
    });

    test('forwards feature-code Yjs updates to Rust with empty glyph metadata', async () => {
        const forwardWorkerYjsUpdate = jest.fn().mockResolvedValue(true);
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

        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            [],
            expect.objectContaining({
                invalidateLayoutClosure: false
            })
        );
    });

    test('worker callback forwards empty-metadata Yjs updates when invoked directly', async () => {
        const forwardWorkerYjsUpdate = jest.fn().mockResolvedValue(true);
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

        bridge._yjsWorkerCallback(new Uint8Array([4, 2]), []);
        await Promise.resolve();
        await Promise.resolve();

        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            [],
            expect.objectContaining({
                invalidateLayoutClosure: false,
                nonGlyphChangeHints: []
            })
        );
        expect(hasWorkerCacheDocumentSpy).toHaveBeenCalled();
        expect(fullWorkerUpdateSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                changedGlyphs: [],
                nonGlyphChangeHints: [],
                invalidateLayoutClosure: false
            })
        );
    });

    test('forwards kerning-pair Yjs updates with non-glyph kerning hints', async () => {
        const forwardWorkerYjsUpdate = jest.fn().mockResolvedValue(true);
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

        forwardWorkerYjsUpdate.mockClear();
        bridge._yjsWorkerCallback(new Uint8Array([4, 7]), [
            {
                path: 'format_specific.com.schriftgestalt.Glyphs.kerningRTL.master-regular.@MMK_R_A.@MMK_L_V'
            }
        ]);
        await Promise.resolve();
        await Promise.resolve();

        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            [],
            expect.objectContaining({
                invalidateLayoutClosure: false,
                nonGlyphChangeHints: ['kerning-value']
            })
        );
    });

    test('forwards canonical RTL kerning Yjs updates with non-glyph kerning hints', async () => {
        const forwardWorkerYjsUpdate = jest.fn().mockResolvedValue(true);
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

        bridge._yjsWorkerCallback(new Uint8Array([4, 6]), [
            {
                path: 'format_specific',
                transactionLabel: 'Edit kerning pair'
            },
            {
                path: 'masters.0.kerning_rtl.@AFirst:@VSecond',
                transactionLabel: 'Edit kerning pair'
            }
        ]);
        await Promise.resolve();
        await Promise.resolve();

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

        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            ['alef'],
            expect.objectContaining({
                invalidateLayoutClosure: true
            })
        );
    });

    test('source-only outline edit forwards without invalidating layout closure', async () => {
        const forwardWorkerYjsUpdate = jest.fn().mockResolvedValue(true);
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
                compileChangeSource: 'mouse-drag-outline',
                compileEditType: 'outline',
                workerReplayTargets: [{ glyphName: 'A', layerId: 'layer-1' }]
            }
        ]);
        await Promise.resolve();
        await Promise.resolve();

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

    test('outline edit with dependent replay targets preserves layout closure while forwarding targets', async () => {
        const forwardWorkerYjsUpdate = jest.fn().mockResolvedValue(true);
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

        bridge._yjsWorkerCallback(new Uint8Array([7, 9]), [
            {
                path: 'glyphs.a.layers.layer-1.shapes.0.nodes',
                compileChangeSource: 'mouse-drag-outline',
                compileEditType: 'outline',
                workerReplayTargets: [
                    { glyphName: 'a', layerId: 'layer-1' },
                    { glyphName: 'adieresis', layerId: 'layer-1' }
                ]
            }
        ]);
        await Promise.resolve();
        await Promise.resolve();

        expect(forwardWorkerYjsUpdate).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            ['a'],
            expect.objectContaining({
                invalidateLayoutClosure: false,
                layerTargets: [
                    { glyphName: 'a', layerId: 'layer-1' },
                    { glyphName: 'adieresis', layerId: 'layer-1' }
                ]
            })
        );
        expect(hasWorkerCacheDocumentSpy).toHaveBeenCalled();
        expect(fullWorkerUpdateSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                changedGlyphs: ['a'],
                layerTargets: [
                    { glyphName: 'a', layerId: 'layer-1' },
                    { glyphName: 'adieresis', layerId: 'layer-1' }
                ],
                invalidateLayoutClosure: false
            })
        );
    });

    test('anchor edit forwards with invalidateLayoutClosure false and non-empty changedGlyphs', async () => {
        const forwardWorkerYjsUpdate = jest.fn().mockResolvedValue(true);
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
                    anchors: [
                        expect.objectContaining({ name: 'top', x: 100, y: 700 })
                    ]
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
                    anchors: [
                        expect.objectContaining({
                            name: 'bottom',
                            x: 100,
                            y: 0
                        })
                    ]
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

    test('returns false for outline edits with dependent replay targets', () => {
        const result =
            changeBridgeInit.shouldInvalidateLayoutClosureForCommittedEntries([
                {
                    path: 'glyphs.a.layers.layer-1.shapes.0.nodes',
                    compileChangeSource: 'mouse-drag-outline',
                    compileEditType: 'outline',
                    workerReplayTargets: [
                        { glyphName: 'a', layerId: 'layer-1' },
                        { glyphName: 'adieresis', layerId: 'layer-1' }
                    ]
                }
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

    test('uses the active stack layer for worker-cache fallback', async () => {
        const awaitWorkerDocumentSync = jest
            .spyOn(fontCompilation, 'awaitWorkerDocumentSync')
            .mockResolvedValue();
        const submitLayerToWorkerCache = jest.fn().mockResolvedValue(true);

        fontCompilation.isInitialized = true;
        window.fontManager = {
            currentFont: {
                babelfontJson: '{}',
                fontModel: {
                    findGlyph: jest.fn(() => undefined)
                }
            },
            refreshWorkerCacheForReplayTargets: jest.fn(),
            submitLayerToWorkerCache,
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
                selectedLayerId: 'foreground-layer',
                draggingSomething: false,
                parseGlyphStack: jest.fn(() => [
                    { glyphName: 'A', layerId: 'background-layer' }
                ]),
                reconcileSelectionAfterModelSync: jest.fn(async () => {}),
                fetchLayerData: jest.fn(async () => {})
            }
        };

        await syncRustCacheAndRefreshCanvas(undefined, 'A', {
            skipDeferredCanvasRepaint: true
        });

        expect(submitLayerToWorkerCache).toHaveBeenCalledWith(
            'A',
            'background-layer'
        );
        expect(awaitWorkerDocumentSync).toHaveBeenCalledTimes(1);

        awaitWorkerDocumentSync.mockRestore();
    });
});

describe('committed undo/redo compile requests', () => {
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

    test('undo/redo packets tag the compile source and preserve the edit type', async () => {
        const checkAndSchedule = jest.fn();
        const forceTrigger = jest.fn(async () => {
            window.dispatchEvent(
                new CustomEvent('editingFontCompiled', {
                    detail: { fontRevisionKey: '11' }
                })
            );
        });
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
            setEditingCompileContext(changeSource, editType) {
                this.lastChangeSource = changeSource;
                this.lastEditType = editType;
            },
            clearEditingCompileContext() {
                this.lastChangeSource = null;
                this.lastEditType = null;
            },
            scheduleFullCompileDebounce: jest.fn(),
            currentFont: {
                compileRequestVersion: 10,
                requestRecompileWithoutDataChange
            }
        };

        await changeBridgeInit.handleCommittedChangeRefresh(
            [
                {
                    historyAction: 'undo',
                    transactionLabel: 'Move anchor',
                    path: 'glyphs.a.layers.layer-1.anchors.0.x',
                    workerReplayTargets: [
                        { glyphName: 'a', layerId: 'layer-1' }
                    ]
                }
            ],
            'local',
            {
                awaitWorkerSync: jest.fn(async () => {}),
                queueCacheRefresh: jest.fn(async () => {})
            }
        );

        expect(window.fontManager.lastChangeSource).toBeNull();
        expect(window.fontManager.lastEditType).toBeNull();
        expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
        expect(requestRecompileWithoutDataChange).toHaveBeenCalledWith({
            compileContext: expect.objectContaining({
                changeSource: 'keyboard-anchor',
                editType: 'anchor'
            })
        });
        expect(
            window.fontManager.scheduleFullCompileDebounce
        ).not.toHaveBeenCalled();
        expect(checkAndSchedule).toHaveBeenCalledTimes(1);
        expect(forceTrigger).toHaveBeenCalledTimes(1);
        expect(window.fontManager.currentFont.compileRequestVersion).toBe(11);
    });

    test.each(['undo', 'redo'])(
        '%s RTL kerning packets preserve kerning edit types',
        async (historyAction) => {
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
                setEditingCompileContext(changeSource, editType) {
                    this.lastChangeSource = changeSource;
                    this.lastEditType = editType;
                },
                clearEditingCompileContext() {
                    this.lastChangeSource = null;
                    this.lastEditType = null;
                },
                currentFont: {
                    compileRequestVersion: 2,
                    requestRecompileWithoutDataChange
                }
            };

            await changeBridgeInit.handleCommittedChangeRefresh(
                [
                    {
                        historyAction,
                        transactionLabel: 'Edit kerning pair',
                        path: 'masters.master-1.kerning_rtl.@AFirst:@VSecond',
                        oldValue: -50,
                        newValue: -80
                    }
                ],
                'local',
                {
                    awaitWorkerSync: jest.fn(async () => {}),
                    queueCacheRefresh: jest.fn(async () => {})
                }
            );

            expect(window.fontManager.lastChangeSource).toBeNull();
            expect(window.fontManager.lastEditType).toBeNull();
            expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
            expect(requestRecompileWithoutDataChange).toHaveBeenCalledWith({
                compileContext: expect.objectContaining({
                    changeSource: 'keyboard-kerning-value',
                    editType: 'kerning-value'
                })
            });
            expect(checkAndSchedule).toHaveBeenCalledTimes(1);
        }
    );

    test('undo sidebearing packets preserve the stamped sidebearing compile context', async () => {
        const checkAndSchedule = jest.fn();
        const requestRecompileWithoutDataChange = jest.fn(function () {
            this.compileRequestVersion += 1;
        });
        const queueCacheRefresh = jest.fn(async () => {});

        window.autoCompileManager = {
            checkAndSchedule
        };
        window.fontManager = {
            lastChangeSource: null,
            lastEditType: null,
            setEditingCompileContext(changeSource, editType) {
                this.lastChangeSource = changeSource;
                this.lastEditType = editType;
            },
            clearEditingCompileContext() {
                this.lastChangeSource = null;
                this.lastEditType = null;
            },
            currentFont: {
                compileRequestVersion: 4,
                requestRecompileWithoutDataChange
            }
        };

        await changeBridgeInit.handleCommittedChangeRefresh(
            [
                {
                    historyAction: 'undo',
                    transactionLabel: 'Set sidebearing',
                    path: 'glyphs.a.layers.layer-1',
                    compileChangeSource: 'keyboard-sidebearing',
                    compileEditType: null,
                    visualAnchorSide: 'left',
                    workerReplayTargets: [
                        { glyphName: 'a', layerId: 'layer-1' }
                    ]
                }
            ],
            'local',
            {
                awaitWorkerSync: jest.fn(async () => {}),
                queueCacheRefresh
            }
        );

        expect(window.fontManager.lastChangeSource).toBeNull();
        expect(window.fontManager.lastEditType).toBeNull();
        expect(queueCacheRefresh).not.toHaveBeenCalled();
        expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
        expect(requestRecompileWithoutDataChange).toHaveBeenCalledWith({
            compileContext: expect.objectContaining({
                changeSource: 'keyboard-sidebearing',
                editType: null
            })
        });
        expect(checkAndSchedule).toHaveBeenCalledTimes(1);
    });

    test('undo sidebearing fallback reuses stamped history metadata for full compile', async () => {
        originalWindow.fontManager = {
            lastChangeSource: null,
            lastEditType: null,
            setEditingCompileContext(changeSource, editType) {
                this.lastChangeSource = changeSource;
                this.lastEditType = editType;
            },
            clearEditingCompileContext() {
                this.lastChangeSource = null;
                this.lastEditType = null;
            },
            currentFont: {
                fontModel: {
                    findGlyph: jest.fn(() => ({
                        findLayerById: jest.fn(() => ({ width: 500 }))
                    }))
                },
                compileRequestVersion: 0,
                requestRecompileWithoutDataChange: jest.fn(function () {
                    this.compileRequestVersion += 1;
                })
            },
            awaitWorkerDocumentSync: jest.fn(async () => {}),
            workerCacheUpdatePromise: Promise.resolve(),
            awaitWorkerCacheUpdate: jest.fn(async () => {}),
            refreshWorkerCacheForReplayTargets: jest.fn(async () => true)
        };
        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn(),
            forceTrigger: jest.fn(async () => {
                originalWindow.dispatchEvent(
                    new CustomEvent('editingFontCompiled', {
                        detail: { fontRevisionKey: '1' }
                    })
                );
            })
        };
        originalWindow.glyphCanvas = {
            viewportManager: { panX: 100, scale: 2 },
            textRunEditor: { refreshGlyphAdvancesLive: jest.fn() },
            requestRepaintAfterCompile: jest.fn(),
            syncCurrentOutlineLayerDataFromModel: jest.fn(),
            updatePropertyPanel: jest.fn(),
            render: jest.fn(),
            outlineEditor: {
                active: true,
                currentGlyphName: 'a',
                selectedLayerId: 'layer-1',
                parseGlyphStack: () => [{ glyphName: 'a' }],
                fetchLayerData: jest.fn(),
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: () => 'a'
        };
        originalWindow.patchSyncEngine = {
            undo: jest.fn(() => ({
                glyphName: 'a',
                layerId: 'layer-1',
                historyItem: {
                    entries: [
                        {
                            oldValue: 480,
                            newValue: 500,
                            compileChangeSource: 'keyboard-sidebearing',
                            compileEditType: null
                        }
                    ],
                    touchedPaths: ['glyphs.a.layers.layer-1.width'],
                    transactionLabel: 'Set sidebearing',
                    workerReplayTargets: [
                        { glyphName: 'a', layerId: 'layer-1' }
                    ]
                }
            })),
            redo: jest.fn()
        };

        await changeBridgeInit.runBridgeUndoRedo(
            'undo',
            'a',
            'a',
            'layer-1',
            null
        );

        expect(originalWindow.fontManager.lastChangeSource).toBeNull();
        expect(originalWindow.fontManager.lastEditType).toBeNull();
        expect(
            originalWindow.fontManager.currentFont
                .requestRecompileWithoutDataChange
        ).toHaveBeenCalledTimes(1);
        expect(
            originalWindow.fontManager.currentFont
                .requestRecompileWithoutDataChange
        ).toHaveBeenCalledWith({
            compileContext: expect.objectContaining({
                changeSource: 'keyboard-sidebearing',
                editType: null
            })
        });
    });

    test('undo outline replay reuses forward layer-snapshot metadata instead of generic undo source', async () => {
        const refreshGlyphAdvancesLive = jest.fn();
        const fetchLayerData = jest.fn();
        const syncCurrentOutlineLayerDataFromModel = jest.fn();
        const render = jest.fn();
        const flushPendingKeyboardPreviewCommit = jest.fn(async () => {});

        const makeFontModel = () => ({
            findGlyph: jest.fn(() => ({
                findLayerById: jest.fn(() => ({ width: 520 }))
            }))
        });

        originalWindow.fontManager = {
            lastChangeSource: null,
            lastEditType: null,
            setEditingCompileContext(changeSource, editType) {
                this.lastChangeSource = changeSource;
                this.lastEditType = editType;
            },
            clearEditingCompileContext() {
                this.lastChangeSource = null;
                this.lastEditType = null;
            },
            currentFont: {
                fontModel: makeFontModel(),
                compileRequestVersion: 0,
                requestRecompileWithoutDataChange: jest.fn(function () {
                    this.compileRequestVersion += 1;
                })
            },
            awaitWorkerDocumentSync: jest.fn(async () => {}),
            workerCacheUpdatePromise: Promise.resolve(),
            awaitWorkerCacheUpdate: jest.fn(async () => {}),
            refreshWorkerCacheForReplayTargets: jest.fn(async () => true)
        };
        originalWindow.autoCompileManager = {
            checkAndSchedule: jest.fn(),
            forceTrigger: jest.fn(async () => {
                originalWindow.dispatchEvent(
                    new CustomEvent('editingFontCompiled', {
                        detail: { fontRevisionKey: '1' }
                    })
                );
            })
        };
        originalWindow.glyphCanvas = {
            viewportManager: { panX: 100, scale: 2 },
            textRunEditor: { refreshGlyphAdvancesLive },
            requestRepaintAfterCompile: jest.fn(),
            syncCurrentOutlineLayerDataFromModel,
            updatePropertyPanel: jest.fn(),
            render,
            outlineEditor: {
                active: true,
                currentGlyphName: 'a',
                selectedLayerId: 'layer-1',
                parseGlyphStack: () => [{ glyphName: 'a' }],
                flushPendingKeyboardPreviewCommit,
                canRefreshSelectedLayerFromModelExactly: jest.fn(() => true),
                refreshSelectedLayerFromModel: jest.fn(() => true),
                fetchLayerData,
                performHitDetection: jest.fn()
            },
            getCurrentGlyphName: () => 'a'
        };
        originalWindow.patchSyncEngine = {
            undo: jest.fn(() => ({
                glyphName: 'a',
                layerId: 'layer-1',
                historyItem: {
                    entries: [
                        {
                            transactionLabel: 'Arrow key',
                            path: 'glyphs.a:layers.layer-1:',
                            oldValue: 'node 0.17: (258, 472)',
                            newValue: '(258, 462)',
                            replayOldValue: {
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 10, y: 20, nodetype: 'Line' }
                                        ],
                                        closed: false
                                    }
                                ],
                                anchors: []
                            },
                            replayNewValue: {
                                id: 'layer-1',
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 10, y: 10, nodetype: 'Line' }
                                        ],
                                        closed: false
                                    }
                                ],
                                anchors: []
                            },
                            workerReplayTargets: [
                                { glyphName: 'a', layerId: 'layer-1' }
                            ]
                        }
                    ],
                    touchedPaths: ['glyphs.a:layers.layer-1:'],
                    transactionLabel: 'Arrow key',
                    workerReplayTargets: [
                        { glyphName: 'a', layerId: 'layer-1' }
                    ]
                }
            })),
            redo: jest.fn()
        };

        await changeBridgeInit.runBridgeUndoRedo(
            'undo',
            'a',
            'a',
            'layer-1',
            null
        );

        expect(originalWindow.fontManager.lastChangeSource).toBeNull();
        expect(originalWindow.fontManager.lastEditType).toBeNull();
        expect(
            originalWindow.fontManager.currentFont
                .requestRecompileWithoutDataChange
        ).toHaveBeenCalledWith({
            compileContext: expect.objectContaining({
                changeSource: 'keyboard-outline',
                editType: 'outline'
            })
        });
        expect(flushPendingKeyboardPreviewCommit).toHaveBeenCalledTimes(1);
        expect(fetchLayerData).toHaveBeenCalledWith(true, 'a');
    });
});
