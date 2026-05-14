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
        jest.isolateModules(() => {
            moduleExports = require('../js/python-post-execution');
        });

        Object.defineProperty(document, 'readyState', {
            configurable: true,
            value: originalReadyState
        });

        return moduleExports;
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
});
