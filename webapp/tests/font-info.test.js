describe('FontInfo feature code compilation scheduling', () => {
    let originalReadyState;
    let originalAce;

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

        return {
            codeData,
            markDirty,
            syncJsonFromModel,
            recompileEditingFont,
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
    });

    test('recompiles feature code after 5 seconds of typing idle', async () => {
        const fontInfoManager = loadFontInfoManager();
        const context = createFeatureEditContext('sub f f by ff;');

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

        expect(context.codeData.code).toBe('sub f f by ff;');
        expect(context.markDirty).toHaveBeenCalledTimes(1);
        expect(context.syncJsonFromModel).toHaveBeenCalledTimes(1);
        expect(context.recompileEditingFont).toHaveBeenCalledTimes(1);
        expect(fontInfoManager.featureCodeDirty).toBe(false);
    });

    test('blur commit cancels the pending idle compile', async () => {
        const fontInfoManager = loadFontInfoManager();
        const context = createFeatureEditContext('sub f l by fl;');

        fontInfoManager.featuresEditor = context.editor;
        fontInfoManager.selectedItem = { type: 'feature', key: 0 };

        fontInfoManager.onFeatureCodeChanged();
        jest.advanceTimersByTime(2000);

        fontInfoManager.commitFeatureCodeChanges();
        await Promise.resolve();
        await Promise.resolve();

        expect(context.codeData.code).toBe('sub f l by fl;');
        expect(context.recompileEditingFont).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(5000);
        await Promise.resolve();

        expect(context.recompileEditingFont).toHaveBeenCalledTimes(1);
    });
});
