describe('Python post-execution synthetic commit alignment', () => {
    let originalReadyState;

    function loadModule() {
        jest.resetModules();
        originalReadyState = document.readyState;
        Object.defineProperty(document, 'readyState', {
            configurable: true,
            value: 'loading'
        });

        let moduleExports;
        let assistantExecutionContext;
        jest.isolateModules(() => {
            moduleExports = require('../js/python-post-execution');
            assistantExecutionContext = require('../js/assistant-execution-context.ts');
        });

        Object.defineProperty(document, 'readyState', {
            configurable: true,
            value: originalReadyState
        });

        return { ...moduleExports, assistantExecutionContext };
    }

    function loadModuleImmediately() {
        jest.resetModules();
        originalReadyState = document.readyState;
        Object.defineProperty(document, 'readyState', {
            configurable: true,
            value: 'complete'
        });

        try {
            jest.isolateModules(() => {
                require('../js/python-post-execution');
            });
        } finally {
            Object.defineProperty(document, 'readyState', {
                configurable: true,
                value: originalReadyState
            });
        }
    }

    afterEach(() => {
        delete window.autoCompileManager;
        delete window.afterPythonExecution;
        delete window.fontManager;
        delete window.patchSyncEngine;
        delete window.pythonExecutionHistoryContext;
        delete window.__counterpunchPythonPostExecutionHookInstalled;
    });

    test('derives Python synthetic changes from the refreshed canonical serialized snapshot', () => {
        const { commitPythonExecutionSyntheticChanges } = loadModule();
        const currentFont = {
            babelfontData: {
                glyphs: [
                    {
                        name: 'a',
                        layers: [{ id: 'default', width: 600 }]
                    }
                ]
            },
            babelfontJson: JSON.stringify({
                glyphs: [
                    {
                        name: 'a',
                        layers: [{ id: 'default', width: 500 }]
                    }
                ]
            }),
            syncJsonFromModel: jest.fn(function () {
                this.babelfontJson = JSON.stringify({
                    glyphs: [
                        {
                            name: 'a',
                            layers: [{ id: 'default', width: 610 }]
                        }
                    ]
                });
            })
        };
        const bridge = {
            setRecordingSuppressed: jest.fn(),
            applySyntheticChangeSet: jest.fn(),
            endTransaction: jest.fn()
        };

        commitPythonExecutionSyntheticChanges(
            currentFont,
            {
                transactionStarted: true,
                beforeFontDataJson: JSON.stringify({
                    glyphs: [
                        {
                            name: 'a',
                            layers: [{ id: 'default', width: 500 }]
                        }
                    ]
                }),
                label: 'Python script'
            },
            bridge
        );

        expect(currentFont.syncJsonFromModel).toHaveBeenCalledTimes(1);
        expect(bridge.setRecordingSuppressed).toHaveBeenCalledWith(false);
        expect(bridge.applySyntheticChangeSet).toHaveBeenCalledWith(
            'Python script',
            expect.arrayContaining([
                expect.objectContaining({
                    op: 'set',
                    path: ['glyphs', 'a', 'layers', 'default', 'width'],
                    oldValue: 500,
                    newValue: 610
                })
            ])
        );
        expect(bridge.endTransaction).toHaveBeenCalledTimes(1);
    });

    test('still canonicalizes the current font when no history context is available', () => {
        const { commitPythonExecutionSyntheticChanges } = loadModule();
        const currentFont = {
            babelfontData: {
                glyphs: []
            },
            syncJsonFromModel: jest.fn()
        };
        const bridge = {
            setRecordingSuppressed: jest.fn(),
            applySyntheticChangeSet: jest.fn(),
            endTransaction: jest.fn()
        };

        commitPythonExecutionSyntheticChanges(currentFont, null, bridge);

        expect(currentFont.syncJsonFromModel).toHaveBeenCalledTimes(1);
        expect(bridge.setRecordingSuppressed).not.toHaveBeenCalled();
        expect(bridge.applySyntheticChangeSet).not.toHaveBeenCalled();
        expect(bridge.endTransaction).not.toHaveBeenCalled();
    });

    test('closes the Python transaction when canonicalization fails', () => {
        const { commitPythonExecutionSyntheticChanges } = loadModule();
        const currentFont = {
            syncJsonFromModel: jest.fn(() => {
                throw new Error('invalid Python model state');
            })
        };
        const bridge = {
            setRecordingSuppressed: jest.fn(),
            applySyntheticChangeSet: jest.fn(),
            endTransaction: jest.fn()
        };

        expect(() =>
            commitPythonExecutionSyntheticChanges(
                currentFont,
                { beforeFontDataJson: null, transactionStarted: true },
                bridge
            )
        ).toThrow('invalid Python model state');
        expect(bridge.setRecordingSuppressed).toHaveBeenCalledWith(false);
        expect(bridge.endTransaction).toHaveBeenCalledTimes(1);
    });

    test('replaces reordered OpenType features atomically', () => {
        const { commitPythonExecutionSyntheticChanges } = loadModule();
        const executionOrder = [];
        const onFontModelSync = () => executionOrder.push('fontModelSync');
        const zero = {
            code: 'sub zero by zero.zero;\n',
            automatic: true
        };
        const frac = {
            code: 'sub slash by fraction;\n',
            automatic: true
        };
        const currentFont = {
            babelfontJson: '',
            syncJsonFromModel: jest.fn(function () {
                this.babelfontJson = JSON.stringify({
                    features: {
                        features: [
                            ['frac', frac],
                            ['zero', zero]
                        ]
                    }
                });
            })
        };
        const bridge = {
            setRecordingSuppressed: jest.fn(),
            applySyntheticChangeSet: jest.fn(),
            endTransaction: jest.fn(() => {
                executionOrder.push('commit');
                return {};
            })
        };

        window.addEventListener('fontModelSync', onFontModelSync);
        try {
            commitPythonExecutionSyntheticChanges(
                currentFont,
                {
                    transactionStarted: true,
                    beforeFontDataJson: JSON.stringify({
                        features: {
                            features: [
                                ['zero', zero],
                                ['frac', frac]
                            ]
                        }
                    }),
                    label: 'Reorder features'
                },
                bridge
            );
        } finally {
            window.removeEventListener('fontModelSync', onFontModelSync);
        }

        expect(bridge.applySyntheticChangeSet).toHaveBeenCalledWith(
            'Reorder features',
            [
                expect.objectContaining({
                    op: 'set',
                    path: ['features', 'features'],
                    oldValue: [
                        ['zero', zero],
                        ['frac', frac]
                    ],
                    newValue: [
                        ['frac', frac],
                        ['zero', zero]
                    ]
                })
            ]
        );
        expect(executionOrder).toEqual(['commit', 'fontModelSync']);
    });

    test('records reordered glyph collections through the schema order path', () => {
        const { commitPythonExecutionSyntheticChanges } = loadModule();
        const firstGlyph = { name: 'a', layers: [] };
        const secondGlyph = { name: 'b', layers: [] };
        const currentFont = {
            babelfontJson: '',
            syncJsonFromModel: jest.fn(function () {
                this.babelfontJson = JSON.stringify({
                    glyphs: [secondGlyph, firstGlyph]
                });
            })
        };
        const bridge = {
            setRecordingSuppressed: jest.fn(),
            applySyntheticChangeSet: jest.fn(),
            endTransaction: jest.fn()
        };

        commitPythonExecutionSyntheticChanges(
            currentFont,
            {
                transactionStarted: true,
                beforeFontDataJson: JSON.stringify({
                    glyphs: [firstGlyph, secondGlyph]
                }),
                label: 'Reorder glyphs'
            },
            bridge
        );

        expect(bridge.applySyntheticChangeSet).toHaveBeenCalledWith(
            'Reorder glyphs',
            [
                expect.objectContaining({
                    op: 'set',
                    path: ['glyphOrder'],
                    oldValue: ['a', 'b'],
                    newValue: ['b', 'a']
                })
            ]
        );
    });

    test('closes an assistant Python transaction so its committed funnel can run', () => {
        const {
            commitPythonExecutionSyntheticChanges,
            assistantExecutionContext: { setActiveAssistantPythonExecution }
        } = loadModule();
        const currentFont = {
            babelfontJson: '',
            syncJsonFromModel: jest.fn(function () {
                this.babelfontJson = JSON.stringify({
                    features: {
                        features: [['liga', { code: 'sub f i by fi;' }]]
                    }
                });
            })
        };
        const bridge = {
            setRecordingSuppressed: jest.fn(),
            applySyntheticChangeSet: jest.fn(),
            endTransaction: jest.fn()
        };

        setActiveAssistantPythonExecution({
            id: 'prompt-1',
            allowFontEdits: true,
            historySummary: 'Adjust OpenType features'
        });
        try {
            commitPythonExecutionSyntheticChanges(
                currentFont,
                {
                    transactionStarted: true,
                    beforeFontDataJson: JSON.stringify({
                        features: {
                            features: [['liga', { code: 'sub f f by ff;' }]]
                        }
                    }),
                    label: 'Python script'
                },
                bridge
            );
        } finally {
            setActiveAssistantPythonExecution(null);
        }

        expect(bridge.applySyntheticChangeSet).toHaveBeenCalledTimes(1);
        expect(bridge.endTransaction).toHaveBeenCalledTimes(1);
    });

    test('commits the canonical Python diff after releasing scoped live recording suppression', () => {
        const { commitPythonExecutionSyntheticChanges } = loadModule();
        const { PatchSyncEngine } = require('../js/patch-sync-engine');
        const { yDocToJson } = require('../js/change-bridge-ydoc');
        const Y = require('yjs');
        const beforeSnapshot = { names: { familyName: 'Before' } };
        const afterSnapshot = { names: { familyName: 'After' } };
        const sender = new PatchSyncEngine('python-suppression-sender');
        const receiver = new PatchSyncEngine('python-suppression-receiver');
        const receiverFontJson = JSON.parse(JSON.stringify(beforeSnapshot));
        sender.initFromJson(beforeSnapshot);
        receiver._fontJson = receiverFontJson;
        Y.applyUpdate(receiver.yDoc, Y.encodeStateAsUpdate(sender.yDoc));

        const emittedUpdates = [];
        sender.onLocalUpdate((update, _message, entries) => {
            emittedUpdates.push({ update, entries });
        });
        sender.beginTransaction('Python script', null, {
            historyItemId: 'prompt-python-suppression',
            promptGroupId: 'prompt-python-suppression',
            historySummary: 'Rename family'
        });
        const releaseRecordingSuppression = sender.beginRecordingSuppression();

        commitPythonExecutionSyntheticChanges(
            {
                babelfontJson: '',
                syncJsonFromModel: jest.fn(function () {
                    this.babelfontJson = JSON.stringify(afterSnapshot);
                })
            },
            {
                transactionStarted: true,
                beforeFontDataJson: JSON.stringify(beforeSnapshot),
                label: 'Python script',
                releaseRecordingSuppression
            },
            sender
        );

        expect(emittedUpdates).toHaveLength(1);
        expect(emittedUpdates[0].entries).toEqual([
            expect.objectContaining({
                path: 'names.familyName',
                promptGroupId: 'prompt-python-suppression'
            })
        ]);
        expect(yDocToJson(sender.fontMap)).toEqual(afterSnapshot);

        receiver.applyRemoteUpdate(
            emittedUpdates[0].update,
            emittedUpdates[0].entries
        );
        expect(receiverFontJson).toEqual(afterSnapshot);

        sender.destroy();
        receiver.destroy();
    });

    test('starts each assistant Python execution with the prompt history identity', () => {
        jest.resetModules();
        const {
            setActiveAssistantPythonExecution
        } = require('../js/assistant-execution-context.ts');
        require('../js/python-ui-sync.ts');
        const bridge = {
            beginTransaction: jest.fn(),
            setRecordingSuppressed: jest.fn()
        };
        window.patchSyncEngine = bridge;
        window.fontManager = {
            currentFont: {
                babelfontData: { glyphs: [] }
            }
        };

        setActiveAssistantPythonExecution({
            id: 'prompt-1',
            allowFontEdits: true,
            historySummary: 'Reorder features'
        });
        try {
            window.beforePythonExecution(
                'features[0], features[1] = features[1], features[0]'
            );
        } finally {
            setActiveAssistantPythonExecution(null);
        }

        expect(bridge.beginTransaction).toHaveBeenCalledWith(
            'Reorder features',
            null,
            {
                historyItemId: 'prompt-1',
                promptGroupId: 'prompt-1',
                historySummary: 'Reorder features'
            }
        );
        expect(bridge.setRecordingSuppressed).toHaveBeenCalledWith(true);
    });

    test('does not stack the post-execution commit hook after module reinitialization', async () => {
        window.autoCompileManager = {};
        const existingHook = jest.fn();
        window.afterPythonExecution = existingHook;

        loadModuleImmediately();
        const installedHook = window.afterPythonExecution;

        loadModuleImmediately();

        expect(window.afterPythonExecution).toBe(installedHook);
        await installedHook();
        expect(existingHook).toHaveBeenCalledTimes(1);
    });

    test('commits one prompt-owned feature reorder update with one undo step', () => {
        const {
            commitPythonExecutionSyntheticChanges,
            assistantExecutionContext: { setActiveAssistantPythonExecution }
        } = loadModule();
        const { PatchSyncEngine } = require('../js/patch-sync-engine');
        const { yDocToJson } = require('../js/change-bridge-ydoc');
        const { buildHistoryStackItems } = require('../js/change-log');
        const Y = require('yjs');
        const zero = { code: 'sub zero by zero.zero;', automatic: true };
        const frac = { code: 'sub slash by fraction;', automatic: true };
        const beforeSnapshot = {
            features: {
                features: [
                    ['zero', zero],
                    ['frac', frac]
                ]
            }
        };
        const afterSnapshot = {
            features: {
                features: [
                    ['frac', frac],
                    ['zero', zero]
                ]
            }
        };
        const finalSnapshot = {
            features: {
                features: [
                    [
                        'frac',
                        {
                            ...frac,
                            code: 'sub slash by fraction;\nsub one by one.numr;'
                        }
                    ],
                    ['zero', zero]
                ]
            }
        };
        const sender = new PatchSyncEngine('prompt-feature-reorder-sender');
        const receiver = new PatchSyncEngine('prompt-feature-reorder-receiver');
        const receiverFontJson = JSON.parse(JSON.stringify(beforeSnapshot));
        sender.initFromJson(beforeSnapshot);
        receiver._fontJson = receiverFontJson;
        Y.applyUpdate(receiver.yDoc, Y.encodeStateAsUpdate(sender.yDoc));

        const emittedUpdates = [];
        sender.onLocalUpdate((update, _message, entries) => {
            emittedUpdates.push({ update, entries });
        });
        sender.beginTransaction('Reorder features', null, {
            historyItemId: 'prompt-feature-reorder',
            promptGroupId: 'prompt-feature-reorder',
            historySummary: 'Reorder features'
        });
        setActiveAssistantPythonExecution({
            id: 'prompt-feature-reorder',
            allowFontEdits: true,
            historySummary: 'Reorder features'
        });
        try {
            commitPythonExecutionSyntheticChanges(
                {
                    babelfontJson: '',
                    syncJsonFromModel: jest.fn(function () {
                        this.babelfontJson = JSON.stringify(afterSnapshot);
                    })
                },
                {
                    transactionStarted: true,
                    beforeFontDataJson: JSON.stringify(beforeSnapshot),
                    label: 'Reorder features'
                },
                sender
            );
        } finally {
            setActiveAssistantPythonExecution(null);
        }

        sender.beginTransaction('Update feature code', null, {
            historyItemId: 'prompt-feature-reorder',
            promptGroupId: 'prompt-feature-reorder',
            historySummary: 'Reorder features'
        });
        setActiveAssistantPythonExecution({
            id: 'prompt-feature-reorder',
            allowFontEdits: true,
            historySummary: 'Reorder features'
        });
        try {
            commitPythonExecutionSyntheticChanges(
                {
                    babelfontJson: '',
                    syncJsonFromModel: jest.fn(function () {
                        this.babelfontJson = JSON.stringify(finalSnapshot);
                    })
                },
                {
                    transactionStarted: true,
                    beforeFontDataJson: JSON.stringify(afterSnapshot),
                    label: 'Update feature code'
                },
                sender
            );
        } finally {
            setActiveAssistantPythonExecution(null);
        }

        expect(emittedUpdates).toHaveLength(2);
        expect(emittedUpdates[0].entries).toEqual([
            expect.objectContaining({
                path: 'features.features',
                replayOldValue: beforeSnapshot.features.features,
                replayNewValue: afterSnapshot.features.features,
                promptGroupId: 'prompt-feature-reorder'
            })
        ]);
        expect(buildHistoryStackItems(sender.getChangeLog())).toEqual([
            expect.objectContaining({
                id: 'prompt-feature-reorder',
                entries: expect.arrayContaining([
                    expect.objectContaining({ path: 'features.features' })
                ])
            })
        ]);
        expect(yDocToJson(sender.fontMap)).toEqual(finalSnapshot);

        expect(emittedUpdates).toHaveLength(2);
        expect(buildHistoryStackItems(sender.getChangeLog())).toEqual([
            expect.objectContaining({
                id: 'prompt-feature-reorder',
                historySummary: 'Reorder features'
            })
        ]);

        receiver.applyRemoteUpdate(
            emittedUpdates[0].update,
            emittedUpdates[0].entries
        );
        receiver.applyRemoteUpdate(
            emittedUpdates[1].update,
            emittedUpdates[1].entries
        );
        expect(receiverFontJson).toEqual(finalSnapshot);

        sender.undo();
        expect(emittedUpdates).toHaveLength(3);
        expect(yDocToJson(sender.fontMap)).toEqual(beforeSnapshot);
        receiver.applyRemoteUpdate(
            emittedUpdates[2].update,
            emittedUpdates[2].entries
        );
        expect(receiverFontJson).toEqual(beforeSnapshot);

        sender.redo();
        expect(emittedUpdates).toHaveLength(4);
        expect(yDocToJson(sender.fontMap)).toEqual(finalSnapshot);
        receiver.applyRemoteUpdate(
            emittedUpdates[3].update,
            emittedUpdates[3].entries
        );
        expect(receiverFontJson).toEqual(finalSnapshot);

        sender.destroy();
        receiver.destroy();
    });

    test('replays mixed font, glyph, and layer prompt edits as one logical undo item', () => {
        const { PatchSyncEngine } = require('../js/patch-sync-engine');
        const { yDocToJson } = require('../js/change-bridge-ydoc');
        const { buildHistoryStackItems } = require('../js/change-log');
        const Y = require('yjs');
        const beforeSnapshot = {
            names: { familyName: 'Before' },
            glyphs: {
                A: {
                    name: 'A',
                    note: 'before',
                    layers: {
                        master: { width: 500, shapes: [] }
                    }
                }
            }
        };
        const sender = new PatchSyncEngine('mixed-prompt-sender');
        const receiver = new PatchSyncEngine('mixed-prompt-receiver');
        sender.initFromJson(beforeSnapshot);
        const normalizedBeforeSnapshot = yDocToJson(sender.fontMap);
        const finalSnapshot = JSON.parse(
            JSON.stringify(normalizedBeforeSnapshot)
        );
        finalSnapshot.names.familyName = 'After';
        finalSnapshot.glyphs[0].note = 'after';
        finalSnapshot.glyphs[0].layers[0].width = 600;
        finalSnapshot.glyphs[0].layers[0].shapes = [
            { id: 'shape-1', nodes: [], closed: false }
        ];
        const receiverFontJson = JSON.parse(
            JSON.stringify(normalizedBeforeSnapshot)
        );
        receiver._fontJson = receiverFontJson;
        Y.applyUpdate(receiver.yDoc, Y.encodeStateAsUpdate(sender.yDoc));

        const emittedUpdates = [];
        sender.onLocalUpdate((update, _message, entries) => {
            emittedUpdates.push({ update, entries });
        });
        const promptHistoryMetadata = {
            historyItemId: 'prompt-mixed-scope',
            promptGroupId: 'prompt-mixed-scope',
            historySummary: 'Adjust family and A'
        };
        const commit = (label, change) => {
            sender.beginTransaction(label, null, promptHistoryMetadata);
            change();
            sender.endTransaction();
        };

        commit('Rename family', () =>
            sender.recordChange(['names'], 'familyName', 'Before', 'After')
        );
        commit('Update glyph note', () =>
            sender.recordChange(['glyphs', 'A'], 'note', 'before', 'after')
        );
        commit('Adjust layer', () => {
            sender.recordChange(
                ['glyphs', 'A', 'layers', 'master'],
                'width',
                500,
                600
            );
            sender.recordChange(
                ['glyphs', 'A', 'layers', 'master'],
                'shapes',
                [],
                [{ id: 'shape-1', type: 'path', nodes: [] }]
            );
        });

        expect(buildHistoryStackItems(sender.getChangeLog())).toEqual([
            expect.objectContaining({
                id: 'prompt-mixed-scope',
                entries: expect.arrayContaining([
                    expect.objectContaining({ path: 'names.familyName' }),
                    expect.objectContaining({ path: 'glyphs.A:note' }),
                    expect.objectContaining({
                        path: 'glyphs.A:layers.master:width'
                    })
                ])
            })
        ]);
        expect(yDocToJson(sender.fontMap)).toEqual(finalSnapshot);

        for (const packet of emittedUpdates) {
            receiver.applyRemoteUpdate(packet.update, packet.entries);
        }
        expect(receiverFontJson).toEqual(finalSnapshot);

        sender.undo();
        const undoPacket = emittedUpdates.at(-1);
        receiver.applyRemoteUpdate(undoPacket.update, undoPacket.entries);
        expect(yDocToJson(sender.fontMap)).toEqual(normalizedBeforeSnapshot);
        expect(receiverFontJson).toEqual(normalizedBeforeSnapshot);

        sender.redo();
        const redoPacket = emittedUpdates.at(-1);
        receiver.applyRemoteUpdate(redoPacket.update, redoPacket.entries);
        expect(yDocToJson(sender.fontMap)).toEqual(finalSnapshot);
        expect(receiverFontJson).toEqual(finalSnapshot);

        sender.destroy();
        receiver.destroy();
    });

    test('applies Python glyph and layer collection changes through keyed Yjs maps', () => {
        const { commitPythonExecutionSyntheticChanges } = loadModule();
        const { PatchSyncEngine } = require('../js/patch-sync-engine');
        const { yDocToJson } = require('../js/change-bridge-ydoc');
        const Y = require('yjs');
        const beforeSnapshot = {
            glyphs: [
                {
                    name: 'A',
                    layers: [
                        {
                            id: 'layer-a',
                            width: 500,
                            master: { type: 'DefaultForMaster', master: 'm1' },
                            shapes: [],
                            anchors: []
                        }
                    ]
                },
                {
                    name: 'B',
                    layers: [
                        {
                            id: 'layer-b',
                            width: 600,
                            master: { type: 'DefaultForMaster', master: 'm1' },
                            shapes: [],
                            anchors: []
                        }
                    ]
                },
                {
                    name: 'D',
                    layers: [
                        {
                            id: 'layer-d',
                            width: 800,
                            master: { type: 'DefaultForMaster', master: 'm1' },
                            shapes: [],
                            anchors: []
                        }
                    ]
                }
            ]
        };
        const afterSnapshot = {
            glyphs: [
                {
                    name: 'B',
                    layers: [
                        {
                            id: 'layer-b2',
                            width: 650,
                            master: { type: 'DefaultForMaster', master: 'm1' },
                            shapes: [],
                            anchors: []
                        },
                        {
                            id: 'layer-b',
                            width: 600,
                            master: { type: 'DefaultForMaster', master: 'm1' },
                            shapes: [],
                            anchors: []
                        }
                    ]
                },
                {
                    name: 'C',
                    layers: [
                        {
                            id: 'layer-c',
                            width: 700,
                            master: { type: 'DefaultForMaster', master: 'm1' },
                            shapes: [],
                            anchors: []
                        }
                    ]
                },
                {
                    name: 'D',
                    layers: [
                        {
                            id: 'layer-d',
                            width: 800,
                            master: { type: 'DefaultForMaster', master: 'm1' },
                            shapes: [],
                            anchors: []
                        }
                    ]
                }
            ]
        };
        const sender = new PatchSyncEngine('python-collection-sender');
        const receiver = new PatchSyncEngine('python-collection-receiver');
        const receiverFontJson = JSON.parse(JSON.stringify(beforeSnapshot));
        sender.initFromJson(beforeSnapshot);
        receiver._fontJson = receiverFontJson;
        Y.applyUpdate(receiver.yDoc, Y.encodeStateAsUpdate(sender.yDoc));

        let update;
        let entries;
        sender.onLocalUpdate((nextUpdate, _message, nextEntries) => {
            update = nextUpdate;
            entries = nextEntries;
        });
        const currentFont = {
            babelfontJson: '',
            syncJsonFromModel: jest.fn(function () {
                this.babelfontJson = JSON.stringify(afterSnapshot);
            })
        };

        commitPythonExecutionSyntheticChanges(
            currentFont,
            {
                transactionStarted: true,
                beforeFontDataJson: JSON.stringify(beforeSnapshot),
                label: 'Python collection change'
            },
            sender
        );

        expect(sender.fontMap.get('glyphs')).toBeInstanceOf(Y.Map);
        expect(yDocToJson(sender.fontMap)).toEqual(afterSnapshot);

        receiver.applyRemoteUpdate(update, entries);
        expect(receiverFontJson).toEqual(afterSnapshot);

        sender.undo();
        expect(yDocToJson(sender.fontMap)).toEqual(beforeSnapshot);

        sender.redo();
        expect(yDocToJson(sender.fontMap)).toEqual(afterSnapshot);

        sender.destroy();
        receiver.destroy();
    });
});
