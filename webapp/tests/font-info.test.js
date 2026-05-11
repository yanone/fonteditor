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

    function createFeatureEditContext(nextCode) {
        const codeData = { code: 'sub f i by fi;' };
        const markDirty = jest.fn();
        const syncJsonFromModel = jest.fn();
        const recompileEditingFont = jest.fn().mockResolvedValue(false);
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn((_label, operations) => {
            codeData.code = operations[0].newValue;
        });

        window.currentFontModel = {
            features: {
                features: [['liga', codeData]]
            }
        };
        window.fontManager = {
            currentFont: {
                markDirty,
                syncJsonFromModel
            },
            isReady: jest.fn(() => true),
            recompileEditingFont
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet
        };

        return {
            codeData,
            markDirty,
            syncJsonFromModel,
            recompileEditingFont,
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
        const context = createFeatureEditContext('sub f f by ff;');
        const awaitWorkerDocumentSync = jest
            .spyOn(fontCompilation, 'awaitWorkerDocumentSync')
            .mockResolvedValue();

        fontInfoManager.featuresEditor = context.editor;
        fontInfoManager.selectedItem = { type: 'feature', key: 0 };

        fontInfoManager.onFeatureCodeChanged();

        expect(fontInfoManager.featureCodeDirty).toBe(true);
        expect(context.recompileEditingFont).not.toHaveBeenCalled();

        jest.advanceTimersByTime(4999);
        await Promise.resolve();
        expect(context.recompileEditingFont).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(context.codeData.code).toBe('sub f f by ff;');
        expect(context.markDirty).toHaveBeenCalledTimes(1);
        expect(context.syncJsonFromModel).not.toHaveBeenCalled();
        expect(context.beginTransaction).toHaveBeenCalledWith(
            'Edit feature code',
            {
                type: 'feature',
                key: 'feature:liga:1',
                label: 'liga'
            }
        );
        expect(context.applySyntheticChangeSet).toHaveBeenCalledTimes(1);
        expect(awaitWorkerDocumentSync).toHaveBeenCalledTimes(1);
        expect(context.recompileEditingFont).toHaveBeenCalledTimes(1);
        expect(fontInfoManager.featureCodeDirty).toBe(false);

        awaitWorkerDocumentSync.mockRestore();
    });

    test('blur commit cancels the pending idle compile', async () => {
        const fontInfoManager = loadFontInfoManager();
        const context = createFeatureEditContext('sub f l by fl;');
        const awaitWorkerDocumentSync = jest
            .spyOn(fontCompilation, 'awaitWorkerDocumentSync')
            .mockResolvedValue();

        fontInfoManager.featuresEditor = context.editor;
        fontInfoManager.selectedItem = { type: 'feature', key: 0 };

        fontInfoManager.onFeatureCodeChanged();
        jest.advanceTimersByTime(2000);

        fontInfoManager.commitFeatureCodeChanges();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(context.codeData.code).toBe('sub f l by fl;');
        expect(context.applySyntheticChangeSet).toHaveBeenCalledTimes(1);
        expect(awaitWorkerDocumentSync).toHaveBeenCalledTimes(1);
        expect(context.recompileEditingFont).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(5000);
        await Promise.resolve();

        expect(context.recompileEditingFont).toHaveBeenCalledTimes(1);

        awaitWorkerDocumentSync.mockRestore();
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
