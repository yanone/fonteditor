jest.mock('tippy.js', () =>
    jest.fn((element, props) => {
        const popper = global.document.createElement('div');
        if (typeof props.content === 'string') {
            popper.innerHTML = props.content;
        }
        const instance = {
            props,
            popper,
            state: { isVisible: false },
            setContent: jest.fn((content) => {
                if (typeof content === 'string') {
                    popper.innerHTML = content;
                }
            }),
            setProps: jest.fn((nextProps) => {
                instance.props = {
                    ...instance.props,
                    ...nextProps
                };
            }),
            show: jest.fn(() => {
                instance.state.isVisible = true;
                instance.props.onShow?.(instance);
                instance.props.onShown?.(instance);
            }),
            hide: jest.fn(() => {
                instance.state.isVisible = false;
                instance.props.onHide?.(instance);
            })
        };

        props.onCreate?.(instance);
        return instance;
    })
);

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
        const checkAndSchedule = jest.fn();
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
        window.autoCompileManager = {
            checkAndSchedule
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
            checkAndSchedule,
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
        localStorage.clear();
        delete window.fontInfoManager;
        global.ResizeObserver =
            global.ResizeObserver ||
            class ResizeObserver {
                observe() {}
                disconnect() {}
            };
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        document.body.innerHTML = '';
        delete window.fontInfoManager;
        delete window.currentFontModel;
        delete window.patchSyncEngine;
        delete window.autoCompileManager;
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
        expect(context.checkAndSchedule).toHaveBeenCalledTimes(1);
        expect(context.beginTransaction).not.toHaveBeenCalled();
        expect(context.compileEditingFont).not.toHaveBeenCalled();
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
        expect(context.checkAndSchedule).toHaveBeenCalledTimes(1);
        expect(context.compileEditingFont).not.toHaveBeenCalled();

        jest.advanceTimersByTime(5000);
        await Promise.resolve();

        expect(context.checkAndSchedule).toHaveBeenCalledTimes(1);
        expect(context.compileEditingFont).not.toHaveBeenCalled();
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

    test('creates a section picker and toggles search visibility by section', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;
        const fontInfoManager = loadFontInfoManager();

        fontInfoManager.init();
        fontInfoManager.switchTab('names');

        expect(
            document.querySelector('.fontinfo-section-button-label').textContent
        ).toBe('Names');
        expect(
            document.getElementById('fontinfo-search-control').style.display
        ).toBe('none');

        fontInfoManager.switchTab('general');

        expect(
            document.querySelector('.fontinfo-section-button-label').textContent
        ).toBe('General');
        expect(
            document.getElementById('fontinfo-search-control').style.display
        ).toBe('none');

        fontInfoManager.switchTab('custom_ot_values');

        expect(
            document.querySelector('.fontinfo-section-button-label').textContent
        ).toBe('Custom OT Values');
        expect(
            document.getElementById('fontinfo-search-control').style.display
        ).toBe('none');

        fontInfoManager.switchTab('features');

        expect(
            document.querySelector('.fontinfo-section-button-label').textContent
        ).toBe('Features');
        expect(
            document.getElementById('fontinfo-search-control').style.display
        ).toBe('');
    });

    test('bridge-backed names commits use a precise names path', () => {
        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());
        const markDirty = jest.fn();
        const syncJsonFromModel = jest.fn();

        window.currentFontModel = {
            names: {
                family_name: { en: 'Old Family' }
            }
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };
        window.fontManager = {
            currentFont: {
                markDirty,
                syncJsonFromModel
            }
        };

        fontInfoManager.commitNameFieldValue('family_name', {
            en: 'New Family'
        });

        expect(beginTransaction).toHaveBeenCalledWith('Edit font name');
        expect(runWithoutRecording).toHaveBeenCalledTimes(1);
        expect(applySyntheticChangeSet).toHaveBeenCalledWith('Edit font name', [
            {
                op: 'set',
                path: ['names', 'family_name'],
                oldValue: { en: 'Old Family' },
                newValue: { en: 'New Family' }
            }
        ]);
        expect(endTransaction).toHaveBeenCalledTimes(1);
        expect(window.currentFontModel.names.family_name).toEqual({
            en: 'New Family'
        });
        expect(markDirty).not.toHaveBeenCalled();
        expect(syncJsonFromModel).not.toHaveBeenCalled();
    });

    test('empty names fields default to dflt on commit', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());

        window.currentFontModel = {
            names: {},
            features: {
                features: []
            }
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };

        fontInfoManager.init();
        fontInfoManager.switchTab('names');

        const familyField = document.querySelector(
            '[data-name-field="family_name"]'
        );
        const familyInput = familyField.querySelector(
            '.localized-string-input'
        );
        const familyHelper = familyField.querySelector(
            '.localized-string-helper'
        );

        expect(familyHelper.textContent).toBe(
            'Editing Default language system (dflt).'
        );

        familyInput.focus();
        familyInput.value = 'New Family';
        familyInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true
            })
        );

        expect(applySyntheticChangeSet).toHaveBeenCalledWith('Edit font name', [
            {
                op: 'set',
                path: ['names', 'family_name'],
                oldValue: undefined,
                newValue: { dflt: 'New Family' }
            }
        ]);
        expect(window.currentFontModel.names.family_name).toEqual({
            dflt: 'New Family'
        });
    });

    test('inline names fields commit on enter', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());

        window.currentFontModel = {
            names: {
                family_name: { en: 'Old Family' }
            },
            features: {
                features: []
            }
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };

        fontInfoManager.init();
        fontInfoManager.switchTab('names');

        const familyInput = document.querySelector(
            '[data-name-field="family_name"] .localized-string-input'
        );

        familyInput.focus();
        familyInput.value = 'New Family';
        familyInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true
            })
        );

        expect(beginTransaction).toHaveBeenCalledWith('Edit font name');
        expect(applySyntheticChangeSet).toHaveBeenCalledWith('Edit font name', [
            {
                op: 'set',
                path: ['names', 'family_name'],
                oldValue: { en: 'Old Family' },
                newValue: { en: 'New Family' }
            }
        ]);
        expect(window.currentFontModel.names.family_name).toEqual({
            en: 'New Family'
        });
    });

    test('bridge-backed root field commits use a precise root path', () => {
        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());
        const markDirty = jest.fn();
        const syncJsonFromModel = jest.fn();

        window.currentFontModel = {
            upm: 1000,
            version: [1, 0],
            date: new Date('2024-01-01T00:00:00Z'),
            note: 'Old note',
            names: {},
            features: {
                features: []
            }
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };
        window.fontManager = {
            currentFont: {
                markDirty,
                syncJsonFromModel
            }
        };

        fontInfoManager.commitRootFontFieldValue('upm', 2048);

        expect(beginTransaction).toHaveBeenCalledWith('Edit font property');
        expect(runWithoutRecording).toHaveBeenCalledTimes(1);
        expect(applySyntheticChangeSet).toHaveBeenCalledWith(
            'Edit font property',
            [
                {
                    op: 'set',
                    path: ['upm'],
                    oldValue: 1000,
                    newValue: 2048
                }
            ]
        );
        expect(endTransaction).toHaveBeenCalledTimes(1);
        expect(window.currentFontModel.upm).toBe(2048);
        expect(markDirty).not.toHaveBeenCalled();
        expect(syncJsonFromModel).not.toHaveBeenCalled();
    });

    test('created now button stamps the current date through the root patch path', () => {
        jest.setSystemTime(new Date('2026-05-20T12:34:56Z'));

        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());

        window.currentFontModel = {
            upm: 1000,
            version: [1, 0],
            date: new Date('2024-01-01T00:00:00Z'),
            names: {},
            features: {
                features: []
            }
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };

        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('general');

        const nowButton = Array.from(
            document.querySelectorAll('[data-font-field="date"] button')
        ).find((button) => button.textContent === 'Now');

        nowButton.click();

        expect(beginTransaction).toHaveBeenCalledWith('Edit font property');
        const operations = applySyntheticChangeSet.mock.calls[0][1];
        expect(operations[0].path).toEqual(['date']);
        expect(operations[0].newValue).toBeInstanceOf(Date);
        expect(operations[0].newValue.getTime()).toBeGreaterThanOrEqual(
            new Date('2026-05-20T12:34:56Z').getTime()
        );
        expect(operations[0].newValue.getTime()).toBeLessThan(
            new Date('2026-05-20T12:34:57Z').getTime()
        );
    });

    test('bridge-backed custom OT commits use a precise nested path', () => {
        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());

        window.currentFontModel = {
            upm: 1000,
            version: [1, 0],
            date: new Date('2024-01-01T00:00:00Z'),
            names: {},
            features: {
                features: []
            },
            custom_ot_values: {
                os2_vendor_id: 'ABCD'
            }
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };

        fontInfoManager.commitCustomOTValue('os2_vendor_id', 'WXYZ');

        expect(beginTransaction).toHaveBeenCalledWith(
            'Edit custom OpenType value'
        );
        expect(applySyntheticChangeSet).toHaveBeenCalledWith(
            'Edit custom OpenType value',
            [
                {
                    op: 'set',
                    path: ['custom_ot_values', 'os2_vendor_id'],
                    oldValue: 'ABCD',
                    newValue: 'WXYZ'
                }
            ]
        );
        expect(endTransaction).toHaveBeenCalledTimes(1);
        expect(window.currentFontModel.custom_ot_values.os2_vendor_id).toBe(
            'WXYZ'
        );
    });

    test('custom OT panel omits the empty-state line and shows richer hints', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        window.currentFontModel = {
            upm: 1000,
            version: [1, 0],
            date: new Date('2024-01-01T00:00:00Z'),
            names: {},
            features: {
                features: []
            }
        };

        const fontInfoManager = loadFontInfoManager();
        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('custom_ot_values');

        expect(document.body.textContent).not.toContain(
            'No custom OpenType overrides are set yet.'
        );

        const vendorField = document.querySelector(
            '[data-font-field="custom_ot_values.os2_vendor_id"] .localized-string-input'
        );
        const vendorHelper = document.querySelector(
            '[data-font-field="custom_ot_values.os2_vendor_id"] .localized-string-helper'
        );

        expect(vendorField.placeholder).toBe(
            'Four-character vendor code, e.g. ABCD'
        );
        expect(vendorHelper.textContent).toContain('four-character vendor');
    });

    test('names UI shows language names with OpenType tags', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        window.currentFontModel = {
            names: {
                family_name: { en: 'Legacy Family' }
            },
            features: {
                features: []
            }
        };

        const fontInfoManager = loadFontInfoManager();
        fontInfoManager.init();
        fontInfoManager.switchTab('names');

        const familyField = document.querySelector(
            '[data-name-field="family_name"]'
        );
        const familyHelper = familyField.querySelector(
            '.localized-string-helper'
        );
        const localesButton = familyField.querySelector(
            '.localized-string-locales-button'
        );

        expect(familyHelper.textContent).toBe(
            'Editing English (ENG) because Default language system (dflt) is not defined.'
        );

        localesButton.click();

        const localeRowLabel = document.querySelector(
            '.localized-string-modal-locale'
        );
        const localeSelect = document.querySelector(
            '.localized-string-locale-select'
        );
        const germanOption = Array.from(localeSelect.options).find(
            (option) => option.value === 'DEU'
        );

        expect(localeRowLabel.textContent).toBe('English (ENG)');
        expect(localeSelect.options[0].textContent).toBe(
            'Default language system (dflt)'
        );
        expect(germanOption?.textContent).toBe('German (DEU)');
    });

    test('fontModelSync rebuilds names when active and defers while inactive', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        window.currentFontModel = {
            names: {
                family_name: { en: 'First Family' }
            },
            features: {
                features: []
            }
        };

        const fontInfoManager = loadFontInfoManager();
        fontInfoManager.init();
        fontInfoManager.switchTab('names');

        let familyInput = document.querySelector(
            '[data-name-field="family_name"] .localized-string-input'
        );
        expect(familyInput.value).toBe('First Family');

        window.currentFontModel.names.family_name = { en: 'Second Family' };
        window.dispatchEvent(new CustomEvent('fontModelSync'));
        jest.runOnlyPendingTimers();

        familyInput = document.querySelector(
            '[data-name-field="family_name"] .localized-string-input'
        );
        expect(familyInput.value).toBe('Second Family');

        fontInfoManager.switchTab('features');
        window.currentFontModel.names.family_name = { en: 'Third Family' };
        window.dispatchEvent(new CustomEvent('fontModelSync'));
        jest.runOnlyPendingTimers();

        fontInfoManager.switchTab('names');

        familyInput = document.querySelector(
            '[data-name-field="family_name"] .localized-string-input'
        );
        expect(familyInput.value).toBe('Third Family');
    });

    test('fontModelSync rebuilds general and custom OT panels when active', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        window.currentFontModel = {
            upm: 1000,
            version: [1, 0],
            date: new Date('2024-01-01T00:00:00Z'),
            note: 'First note',
            names: {},
            features: {
                features: []
            },
            custom_ot_values: {
                os2_vendor_id: 'ABCD'
            }
        };

        const fontInfoManager = loadFontInfoManager();
        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('general');

        let noteField = document.querySelector(
            '[data-font-field="note"] .localized-string-input'
        );
        expect(noteField.value).toBe('First note');

        window.currentFontModel.note = 'Second note';
        window.dispatchEvent(new CustomEvent('fontModelSync'));
        jest.runOnlyPendingTimers();

        noteField = document.querySelector(
            '[data-font-field="note"] .localized-string-input'
        );
        expect(noteField.value).toBe('Second note');

        fontInfoManager.switchTab('custom_ot_values');

        let vendorField = document.querySelector(
            '[data-font-field="custom_ot_values.os2_vendor_id"] .localized-string-input'
        );
        expect(vendorField.value).toBe('ABCD');

        window.currentFontModel.custom_ot_values.os2_vendor_id = 'WXYZ';
        window.dispatchEvent(new CustomEvent('fontModelSync'));
        jest.runOnlyPendingTimers();

        vendorField = document.querySelector(
            '[data-font-field="custom_ot_values.os2_vendor_id"] .localized-string-input'
        );
        expect(vendorField.value).toBe('WXYZ');
    });
});
