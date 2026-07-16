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
        let agentExecutionContext;
        jest.isolateModules(() => {
            moduleExports = require('../js/python-post-execution');
            agentExecutionContext = require('../js/agent-execution-context.ts');
        });

        Object.defineProperty(document, 'readyState', {
            configurable: true,
            value: originalReadyState
        });

        return { ...moduleExports, agentExecutionContext };
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
            endTransaction: jest.fn()
        };

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

    test('closes an agent Python transaction so its committed funnel can run', () => {
        const {
            commitPythonExecutionSyntheticChanges,
            agentExecutionContext: { setActiveAgentPythonExecution }
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

        setActiveAgentPythonExecution({
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
            setActiveAgentPythonExecution(null);
        }

        expect(bridge.applySyntheticChangeSet).toHaveBeenCalledTimes(1);
        expect(bridge.endTransaction).toHaveBeenCalledTimes(1);
    });

    test('starts each agent Python execution with the prompt history identity', () => {
        jest.resetModules();
        const {
            setActiveAgentPythonExecution
        } = require('../js/agent-execution-context.ts');
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

        setActiveAgentPythonExecution({
            id: 'prompt-1',
            allowFontEdits: true,
            historySummary: 'Reorder features'
        });
        try {
            window.beforePythonExecution(
                'features[0], features[1] = features[1], features[0]'
            );
        } finally {
            setActiveAgentPythonExecution(null);
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
            agentExecutionContext: { setActiveAgentPythonExecution }
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
        setActiveAgentPythonExecution({
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
            setActiveAgentPythonExecution(null);
        }

        sender.beginTransaction('Update feature code', null, {
            historyItemId: 'prompt-feature-reorder',
            promptGroupId: 'prompt-feature-reorder',
            historySummary: 'Reorder features'
        });
        setActiveAgentPythonExecution({
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
            setActiveAgentPythonExecution(null);
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

        const historyLogUpdates = [];
        sender.onChangeLogUpdate((entries) => {
            historyLogUpdates.push(entries);
        });
        expect(
            sender.updatePromptHistorySummary(
                'prompt-feature-reorder',
                'Reorder features (interrupted)'
            )
        ).toBe(true);
        expect(emittedUpdates).toHaveLength(2);
        expect(historyLogUpdates).toHaveLength(2);
        expect(buildHistoryStackItems(sender.getChangeLog())).toEqual([
            expect.objectContaining({
                id: 'prompt-feature-reorder',
                historySummary: 'Reorder features (interrupted)'
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
