jest.mock('tippy.js', () => {
    const tippy = jest.fn(() => ({
        destroy: jest.fn(),
        setProps: jest.fn(),
        show: jest.fn(),
        hide: jest.fn()
    }));

    return {
        __esModule: true,
        default: tippy
    };
});

jest.mock('tippy.js/dist/tippy.css', () => ({}), { virtual: true });

jest.mock('../js/glyph-filter-worker-client', () => ({
    GlyphFilterWorkerClient: jest.fn().mockImplementation(() => ({
        installPackages: jest.fn().mockResolvedValue(undefined),
        syncSharedContext: jest.fn().mockResolvedValue(undefined),
        runBuiltinFilter: jest.fn().mockResolvedValue({
            results: [],
            groups: {},
            status: 'ok'
        }),
        runUserFilter: jest.fn().mockResolvedValue({
            results: [],
            groups: {},
            status: 'ok'
        })
    }))
}));

const { GlyphOverviewFilterManager } = require('../js/glyph-overview-filters');
const { GlyphFilterWorkerClient } = require('../js/glyph-filter-worker-client');
const { pluginRegistry } = require('../js/filesystem-plugins');

describe('GlyphOverviewFilterManager auto-update events', () => {
    let manager;

    beforeEach(() => {
        localStorage.clear();
        manager = new GlyphOverviewFilterManager();
    });

    afterEach(() => {
        manager.plugins = [];
        manager.userFilters = [];
        manager.refreshAutoUpdateListeners();
        jest.restoreAllMocks();
        delete window.pyodide;
    });

    test('discovers plugin auto_update_events and registers listeners', async () => {
        const addEventListenerSpy = jest.spyOn(window, 'addEventListener');
        jest.spyOn(manager, 'discoverUserFilters').mockResolvedValue();

        window.pyodide = {
            runPythonAsync: jest.fn().mockResolvedValue({
                toJs: () => [
                    {
                        path: 'basic/debugging',
                        keyword: 'com.context.incompatible_outlines',
                        display_name: 'Incompatible Outlines',
                        auto_update_events: ['layerFingerprintChanged'],
                        instance: {
                            visible: () => true,
                            get_groups: () => ({})
                        }
                    }
                ]
            })
        };

        await manager.discoverPlugins();

        expect(manager.getPlugins()).toHaveLength(1);
        expect(manager.getPlugins()[0].autoUpdateEvents).toEqual([
            'layerFingerprintChanged'
        ]);
        expect(addEventListenerSpy).toHaveBeenCalledWith(
            'layerFingerprintChanged',
            expect.any(Function)
        );
    });

    test('re-runs only plugins subscribed to a dispatched auto-update event', async () => {
        const activePlugin = {
            path: 'basic/debugging',
            keyword: 'com.context.incompatible_outlines',
            display_name: 'Incompatible Outlines',
            instance: null,
            autoUpdateEvents: ['layerFingerprintChanged'],
            cachedDataVersion: 12,
            cachedContextVersion: 4,
            lastResults: [{ glyph_name: 'A' }]
        };
        const inactiveSubscribedPlugin = {
            path: 'basic/debugging',
            keyword: 'com.context.also_refreshes',
            display_name: 'Also Refreshes',
            instance: null,
            autoUpdateEvents: ['layerFingerprintChanged'],
            cachedDataVersion: 12,
            cachedContextVersion: 4,
            lastResults: [{ glyph_name: 'B' }]
        };
        const unrelatedPlugin = {
            path: 'basic',
            keyword: 'com.context.unrelated',
            display_name: 'Unrelated',
            instance: null,
            autoUpdateEvents: ['glyphSelected'],
            cachedDataVersion: 12,
            cachedContextVersion: 4,
            lastResults: [{ glyph_name: 'C' }]
        };

        manager.plugins = [
            activePlugin,
            inactiveSubscribedPlugin,
            unrelatedPlugin
        ];
        manager.activeFilter = activePlugin;

        const runFilterSpy = jest
            .spyOn(manager, 'runFilter')
            .mockResolvedValue(undefined);
        const runPluginForCountSpy = jest
            .spyOn(manager, 'runPluginForCount')
            .mockResolvedValue(undefined);

        manager.refreshAutoUpdateListeners();

        window.dispatchEvent(
            new CustomEvent('layerFingerprintChanged', {
                detail: {
                    glyphName: 'A',
                    layerId: 'layer-1'
                }
            })
        );

        await Promise.resolve();
        await Promise.resolve();

        expect(activePlugin.cachedDataVersion).toBeUndefined();
        expect(activePlugin.cachedContextVersion).toBeUndefined();
        expect(inactiveSubscribedPlugin.cachedDataVersion).toBeUndefined();
        expect(inactiveSubscribedPlugin.cachedContextVersion).toBeUndefined();
        expect(unrelatedPlugin.cachedDataVersion).toBe(12);
        expect(unrelatedPlugin.cachedContextVersion).toBe(4);
        expect(runFilterSpy).toHaveBeenCalledWith(activePlugin);
        expect(runPluginForCountSpy).toHaveBeenCalledWith(
            inactiveSubscribedPlugin
        );
        expect(runPluginForCountSpy).not.toHaveBeenCalledWith(unrelatedPlugin);
    });

    test('uses the live currentFontModel snapshot for active filter auto-updates after outline edits', async () => {
        jest.spyOn(manager, 'discoverUserFilters').mockResolvedValue();

        window.pyodide = {
            runPythonAsync: jest.fn().mockResolvedValue({
                toJs: () => [
                    {
                        path: 'basic/debugging',
                        keyword: 'com.context.incompatible_outlines',
                        display_name: 'Incompatible Outlines',
                        auto_update_events: ['layerFingerprintChanged'],
                        instance: {
                            visible: () => true,
                            get_groups: () => ({})
                        }
                    }
                ]
            })
        };

        const staleSnapshotJson = JSON.stringify({ glyphs: ['stale'] });
        const liveSnapshotJson = JSON.stringify({ glyphs: ['live'] });

        window.currentFontModel = {
            glyphs: [{ name: 'A' }],
            toJSONString: jest.fn(() => liveSnapshotJson)
        };
        window.fontManager = {
            currentFont: {
                babelfontJson: staleSnapshotJson,
                changeVersion: 42
            }
        };

        manager.glyphOverview = {
            setActiveFilter: jest.fn(),
            updateSelectedGlyphGroups: jest.fn(),
            showFilterNotice: jest.fn(),
            showFilterError: jest.fn()
        };

        await manager.discoverPlugins();
        manager.activeFilter = manager.getPlugins()[0];

        const workerClient = GlyphFilterWorkerClient.mock.results.at(-1).value;

        window.dispatchEvent(
            new CustomEvent('layerFingerprintChanged', {
                detail: {
                    glyphName: 'A',
                    layerId: 'layer-1'
                }
            })
        );

        await Promise.resolve();
        await Promise.resolve();

        expect(window.currentFontModel.toJSONString).toHaveBeenCalled();
        expect(workerClient.runBuiltinFilter).toHaveBeenCalledWith(
            'com.context.incompatible_outlines',
            liveSnapshotJson,
            5000
        );
        expect(workerClient.runBuiltinFilter).not.toHaveBeenCalledWith(
            'com.context.incompatible_outlines',
            staleSnapshotJson,
            5000
        );
    });
});

describe('GlyphOverviewFilterManager All Glyphs behavior', () => {
    let manager;

    beforeEach(() => {
        localStorage.clear();
        manager = new GlyphOverviewFilterManager();
        manager.glyphOverview = {
            setActiveFilter: jest.fn(),
            updateSelectedGlyphGroups: jest.fn(),
            showFilterNotice: jest.fn(),
            showFilterError: jest.fn()
        };
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('clearing group selection keeps All Glyphs unfiltered', () => {
        manager.activeFilter = {
            path: 'basic',
            keyword: 'com.context.allglyphs',
            display_name: 'All Glyphs',
            instance: null,
            lastResults: [],
            groups: {}
        };

        manager.activeGroupFilters = new Set(['dummy-group']);

        manager.clearGroupSelection();

        expect(manager.glyphOverview.setActiveFilter).toHaveBeenCalledWith(
            null
        );
    });
});

describe('GlyphOverviewFilterManager Settings Folder changes', () => {
    let manager;

    beforeEach(() => {
        localStorage.clear();
        manager = new GlyphOverviewFilterManager();
        manager.sidebarContainer = document.createElement('div');
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('does not restore filters from an older folder scan after the new folder has no Filters directory', async () => {
        let resolveOldFolderFiles;
        const oldFolderFiles = new Promise((resolve) => {
            resolveOldFolderFiles = resolve;
        });
        const adapter = {
            hasDirectory: jest.fn(() => true),
            initialize: jest.fn().mockResolvedValue(true),
            fileExists: jest
                .fn()
                .mockResolvedValueOnce(true)
                .mockResolvedValueOnce(false),
            listFilesRecursive: jest.fn().mockReturnValueOnce(oldFolderFiles),
            readFile: jest.fn()
        };
        jest.spyOn(pluginRegistry, 'get').mockReturnValue({
            getAdapter: () => adapter
        });

        const oldFolderScan = manager.discoverUserFilters();
        await Promise.resolve();
        await Promise.resolve();

        await manager.discoverUserFilters();
        resolveOldFolderFiles([{ path: '/Filters/old-filter.py' }]);
        await oldFolderScan;

        expect(manager.userFilters).toEqual([]);
        expect(manager.userFiltersNode.plugins).toEqual([]);
    });
});
