describe('FontInfo feature code compilation scheduling', () => {
    let originalReadyState;
    let originalAce;
    let fontCompilation;

    function loadFontInfoManager() {
        jest.resetModules();
        originalReadyState = document.readyState;
        originalAce = window.ace;
        Object.defineProperty(document, 'readyState', {
            configurable: true,
            value: 'loading'
        });
        window.ace = {
            require: jest.fn((moduleName) => {
                if (moduleName === 'ace/lib/oop') {
                    return { inherits: jest.fn() };
                }
                if (moduleName === 'ace/mode/text') {
                    return { Mode: function Mode() {} };
                }
                if (moduleName === 'ace/mode/text_highlight_rules') {
                    return {
                        TextHighlightRules: function TextHighlightRules() {}
                    };
                }
                throw new Error(`Unexpected Ace module: ${moduleName}`);
            }),
            define: jest.fn()
        };

        let fontInfoManager;
        jest.isolateModules(() => {
            ({ fontInfoManager } = require('../js/font-info'));
            ({ fontCompilation } = require('../js/font-compilation'));
        });

        Object.defineProperty(document, 'readyState', {
            configurable: true,
            value: originalReadyState
        });
        window.ace = originalAce;

        return fontInfoManager;
    }

    function createFeatureEditContext(nextCode, options = {}) {
        const codeData = {
            code: 'sub f i by fi;',
            automatic: options.automatic ?? false
        };
        const markDirty = jest.fn();
        const syncJsonFromModel = jest.fn();
        const compileEditingFont = jest.fn().mockResolvedValue(false);
        const compileFromJson = jest.fn().mockResolvedValue({ result: [] });
        const awaitWorkerDocumentSync = jest.fn().mockResolvedValue(undefined);
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn((_label, operations) => {
            for (const operation of operations) {
                const path = operation.path || [];
                if (path.join('.') === 'features.features.0.1.code') {
                    codeData.code = operation.newValue;
                }
                if (path.join('.') === 'features.features.0.1.automatic') {
                    codeData.automatic = operation.newValue;
                }
            }
        });

        fontCompilation.awaitWorkerDocumentSync = awaitWorkerDocumentSync;
        fontCompilation.compileFromJson = compileFromJson;

        window.currentFontModel = {
            features: {
                features: [['liga', codeData]]
            }
        };
        window.fontManager = {
            currentFont: {
                babelfontJson: '',
                markDirty,
                syncJsonFromModel
            },
            isReady: jest.fn(() => true),
            currentText: 'office',
            compileEditingFont
        };
        window.glyphCanvas = {
            textRunEditor: {
                textBuffer: 'office'
            },
            featuresManager: {
                featureSettings: {
                    liga: true,
                    dlig: false
                }
            }
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet
        };

        if (options.disableBridge) {
            delete window.patchSyncEngine;
        }

        return {
            codeData,
            markDirty,
            syncJsonFromModel,
            compileEditingFont,
            compileFromJson,
            awaitWorkerDocumentSync,
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            editor: {
                getValue: jest.fn(() => nextCode)
            }
        };
    }

    beforeEach(() => {
        jest.useFakeTimers();
        document.body.innerHTML = '';
        delete window.fontInfoManager;
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        document.body.innerHTML = '';
        delete window.fontInfoManager;
        delete window.currentFontModel;
        delete window.patchSyncEngine;
    });

    test('recompiles feature code after 5 seconds of typing idle', async () => {
        const fontInfoManager = loadFontInfoManager();
        const context = createFeatureEditContext('sub f f by ff;', {
            disableBridge: true
        });

        fontInfoManager.featuresEditor = context.editor;
        fontInfoManager.selectedItem = { type: 'feature', key: 0 };

        fontInfoManager.onFeatureCodeChanged();

        expect(fontInfoManager.featureCodeDirty).toBe(true);
        expect(context.compileEditingFont).not.toHaveBeenCalled();

        jest.advanceTimersByTime(4999);
        await Promise.resolve();
        expect(context.compileEditingFont).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(context.codeData.code).toBe('sub f f by ff;');
        expect(context.markDirty).toHaveBeenCalledTimes(1);
        expect(context.syncJsonFromModel).toHaveBeenCalledTimes(1);
        expect(context.awaitWorkerDocumentSync).toHaveBeenCalledTimes(1);
        expect(context.beginTransaction).not.toHaveBeenCalled();
        expect(context.compileEditingFont).toHaveBeenCalledWith('office', [
            'liga'
        ]);
        expect(fontInfoManager.featureCodeDirty).toBe(false);
    });

    test('blur commit cancels the pending idle compile', async () => {
        const fontInfoManager = loadFontInfoManager();
        const context = createFeatureEditContext('sub f l by fl;', {
            disableBridge: true
        });

        fontInfoManager.featuresEditor = context.editor;
        fontInfoManager.selectedItem = { type: 'feature', key: 0 };

        fontInfoManager.onFeatureCodeChanged();
        jest.advanceTimersByTime(2000);

        fontInfoManager.commitFeatureCodeChanges();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(context.codeData.code).toBe('sub f l by fl;');
        expect(context.beginTransaction).not.toHaveBeenCalled();
        expect(context.endTransaction).not.toHaveBeenCalled();
        expect(context.awaitWorkerDocumentSync).toHaveBeenCalledTimes(1);
        expect(context.compileEditingFont).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(5000);
        await Promise.resolve();

        expect(context.compileEditingFont).toHaveBeenCalledTimes(1);
    });

    test('bridge-backed feature code commits go only through the patch funnel', () => {
        const fontInfoManager = loadFontInfoManager();
        const context = createFeatureEditContext('sub f l by fl;');

        fontInfoManager.featuresEditor = context.editor;
        fontInfoManager.selectedItem = { type: 'feature', key: 0 };

        fontInfoManager.commitFeatureCodeChanges();

        expect(context.beginTransaction).toHaveBeenCalledWith(
            'Edit feature code',
            {
                type: 'feature',
                key: 'feature:liga:1',
                label: 'liga'
            }
        );
        expect(context.applySyntheticChangeSet).toHaveBeenCalledWith(
            'Edit feature code',
            [
                {
                    op: 'set',
                    path: ['features', 'features', 0, 1, 'code'],
                    oldValue: 'sub f i by fi;',
                    newValue: 'sub f l by fl;'
                }
            ]
        );
        expect(context.endTransaction).toHaveBeenCalledTimes(1);
        expect(context.syncJsonFromModel).toHaveBeenCalledTimes(1);
        expect(context.markDirty).not.toHaveBeenCalled();
        expect(context.awaitWorkerDocumentSync).not.toHaveBeenCalled();
        expect(context.compileEditingFont).not.toHaveBeenCalled();
        expect(context.codeData.code).toBe('sub f l by fl;');
    });

    test('manual feature edits disable automatic generation through the patch funnel', () => {
        const fontInfoManager = loadFontInfoManager();
        const context = createFeatureEditContext('eature locl;', {
            automatic: true
        });

        document.body.innerHTML =
            '<input type="checkbox" id="feature-automatic-checkbox" checked />';
        fontInfoManager.featuresEditor = context.editor;
        fontInfoManager.selectedItem = { type: 'feature', key: 0 };

        fontInfoManager.commitFeatureCodeChanges();

        expect(context.applySyntheticChangeSet).toHaveBeenCalledWith(
            'Edit feature code',
            [
                {
                    op: 'set',
                    path: ['features', 'features', 0, 1, 'code'],
                    oldValue: 'sub f i by fi;',
                    newValue: 'eature locl;'
                },
                {
                    op: 'set',
                    path: ['features', 'features', 0, 1, 'automatic'],
                    oldValue: true,
                    newValue: false
                }
            ]
        );
        expect(context.codeData.automatic).toBe(false);
        expect(
            document.getElementById('feature-automatic-checkbox').checked
        ).toBe(false);
    });

    test('automatic checkbox changes go through the patch funnel', () => {
        const fontInfoManager = loadFontInfoManager();
        const codeData = { code: 'sub f i by fi;', automatic: false };
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn((_label, operations) => {
            codeData.automatic = operations[0].newValue;
        });

        window.currentFontModel = {
            features: {
                features: [['liga', codeData]]
            }
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet
        };

        document.body.innerHTML =
            '<input type="checkbox" id="feature-automatic-checkbox" checked />';
        fontInfoManager.loadAllLists = jest.fn();
        fontInfoManager.selectedItem = { type: 'feature', key: 0 };

        fontInfoManager.onAutomaticCheckboxChanged();

        expect(beginTransaction).toHaveBeenCalledWith(
            'Toggle automatic generation',
            {
                type: 'feature',
                key: 'feature:liga:1',
                label: 'liga'
            }
        );
        expect(applySyntheticChangeSet).toHaveBeenCalledWith(
            'Toggle automatic generation',
            [
                {
                    op: 'set',
                    path: ['features', 'features', 0, 1, 'automatic'],
                    oldValue: false,
                    newValue: true
                }
            ]
        );
        expect(endTransaction).toHaveBeenCalledTimes(1);
        expect(codeData.automatic).toBe(true);
        expect(fontInfoManager.loadAllLists).toHaveBeenCalledTimes(1);
    });
});
