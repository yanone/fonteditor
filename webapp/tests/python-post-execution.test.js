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

    afterEach(() => {
        delete window.autoCompileManager;
        delete window.afterPythonExecution;
        delete window.fontManager;
        delete window.patchSyncEngine;
        delete window.pythonExecutionHistoryContext;
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

    test('leaves an agent prompt transaction open for prompt finalization', () => {
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
        expect(bridge.endTransaction).not.toHaveBeenCalled();
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
