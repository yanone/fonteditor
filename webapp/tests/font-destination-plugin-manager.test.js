describe('Font Destination plugins', () => {
    let originalFetch;
    let originalOpen;

    beforeEach(() => {
        jest.resetModules();
        originalFetch = global.fetch;
        originalOpen = window.open;
    });

    afterEach(() => {
        global.fetch = originalFetch;
        window.open = originalOpen;
    });

    test('accepts manifests carrying the exact Font Destination marker', () => {
        const {
            FONT_DESTINATION_PLUGIN_MARKER,
            parseFontDestinationManifest
        } = require('../js/font-destination-plugin-manager.ts');

        const manifest = parseFontDestinationManifest({
            schema: 'counterpunch-plugin-manifest:v1',
            package: 'example-package',
            provides: [FONT_DESTINATION_PLUGIN_MARKER],
            fontDestination: {
                entryPoint: 'example',
                pluginId: 'example',
                name: 'Example',
                description: 'Example destination',
                destinationUrl: 'https://example.com/receiver',
                targetOrigin: 'https://example.com',
                repositoryUrl: 'https://github.com/example/repository'
            },
            release: {
                repository: 'example/repository',
                wheelAssetPrefix: 'example-',
                checksumAssetSuffix: '.sha256'
            }
        });

        expect(manifest.pluginId).toBe('example');
        expect(manifest.targetOrigin).toBe('https://example.com');
    });

    test('rejects manifests whose destination origin does not match its URL', () => {
        const {
            FONT_DESTINATION_PLUGIN_MARKER,
            parseFontDestinationManifest
        } = require('../js/font-destination-plugin-manager.ts');

        expect(() =>
            parseFontDestinationManifest({
                schema: 'counterpunch-plugin-manifest:v1',
                package: 'example-package',
                provides: [FONT_DESTINATION_PLUGIN_MARKER],
                fontDestination: {
                    entryPoint: 'example',
                    pluginId: 'example',
                    name: 'Example',
                    description: 'Example destination',
                    destinationUrl: 'https://example.com/receiver',
                    targetOrigin: 'https://elsewhere.example',
                    repositoryUrl: 'https://github.com/example/repository'
                },
                release: {
                    repository: 'example/repository',
                    wheelAssetPrefix: 'example-',
                    checksumAssetSuffix: '.sha256'
                }
            })
        ).toThrow('targetOrigin');
    });

    test('discovers GitHub-wide marker-validated manifests via the code-search API', async () => {
        global.fetch = jest
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    items: [
                        {
                            path: 'counterpunch-plugin.json',
                            repository: {
                                fullName:
                                    'counterpunchspace/fontdestination-example-plugin',
                                defaultBranch: 'main'
                            }
                        },
                        {
                            path: 'counterpunch-plugin.json',
                            repository: {
                                fullName: 'another-author/another-plugin',
                                defaultBranch: 'trunk'
                            }
                        }
                    ]
                })
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    schema: 'counterpunch-plugin-manifest:v1',
                    package: 'fontdestination-example-plugin',
                    provides: ['counterpunch-plugin:font-destination:v1'],
                    fontDestination: {
                        entryPoint: 'example_fontdestination',
                        pluginId: 'example-font-destination',
                        name: 'Example Font Destination',
                        description: 'Example destination',
                        destinationUrl:
                            'https://counterpunchspace.github.io/fontdestination-example-plugin/',
                        targetOrigin: 'https://counterpunchspace.github.io',
                        repositoryUrl:
                            'https://github.com/counterpunchspace/fontdestination-example-plugin'
                    },
                    release: {
                        repository:
                            'counterpunchspace/fontdestination-example-plugin',
                        wheelAssetPrefix: 'fontdestination_example_plugin-',
                        checksumAssetSuffix: '.sha256'
                    }
                })
            })
            .mockResolvedValueOnce({ ok: false, status: 404 });
        const {
            FontDestinationPluginManager
        } = require('../js/font-destination-plugin-manager.ts');

        const catalogue =
            await new FontDestinationPluginManager().discoverCatalogue();

        expect(catalogue).toHaveLength(1);
        expect(catalogue[0].pluginId).toBe('example-font-destination');
        expect(global.fetch.mock.calls[0][0]).toBe(
            'https://localhost:8788/api/github/code-search?q=%22counterpunch-plugin%3Afont-destination%3Av1%22+filename%3Acounterpunch-plugin.json&per_page=100'
        );
        expect(global.fetch.mock.calls[0][1].cache).toBe('no-store');
    });

    test('downloads release assets through the website proxy into the Disk Plugins folder', async () => {
        const { pluginRegistry } = require('../js/filesystem-plugins.ts');
        const originalGetPlugin = pluginRegistry.get;
        const originalCrypto = Object.getOwnPropertyDescriptor(
            global,
            'crypto'
        );
        const originalPyodide = window.pyodide;
        const adapter = {
            fileExists: jest.fn().mockResolvedValue(true),
            requestPermission: jest.fn().mockResolvedValue('granted'),
            scanDirectory: jest.fn().mockResolvedValue({
                '/Plugins/example-1.0.0.whl': {
                    is_dir: false,
                    path: '/Plugins/example-1.0.0.whl'
                }
            }),
            writeFile: jest.fn().mockResolvedValue(undefined)
        };
        pluginRegistry.get = jest.fn((id) =>
            id === 'disk'
                ? {
                      getAdapter: () => adapter,
                      isReady: jest.fn().mockResolvedValue(true)
                  }
                : null
        );
        window.pyodide = {
            FS: { mkdirTree: jest.fn(), writeFile: jest.fn() },
            runPythonAsync: jest
                .fn()
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce([
                    {
                        pluginId: 'example',
                        name: 'Example',
                        description: 'Example destination',
                        destinationUrl: 'https://example.com/receiver',
                        targetOrigin: 'https://example.com',
                        repositoryUrl: 'https://github.com/example/repository',
                        iconUrl: null
                    }
                ])
        };
        const checksum =
            '039058c6f2c0cb492c533b0a4d14ef77a9c0cba4c3973c0c1e9945b39d6f5a3f';
        Object.defineProperty(global, 'crypto', {
            configurable: true,
            value: {
                subtle: {
                    digest: jest
                        .fn()
                        .mockResolvedValue(
                            new Uint8Array(
                                checksum
                                    .match(/.{2}/g)
                                    .map((value) => Number.parseInt(value, 16))
                            ).buffer
                        )
                }
            }
        });
        global.fetch = jest
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    assets: [
                        {
                            name: 'example-1.0.0.whl',
                            browser_download_url: 'https://example.com/wheel'
                        },
                        {
                            name: 'example-1.0.0.whl.sha256',
                            browser_download_url: 'https://example.com/checksum'
                        }
                    ]
                })
            })
            .mockResolvedValueOnce({
                ok: true,
                arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
            })
            .mockResolvedValueOnce({ ok: true, text: async () => checksum });
        const {
            FontDestinationPluginManager
        } = require('../js/font-destination-plugin-manager.ts');

        try {
            const manager = new FontDestinationPluginManager();
            await manager.install({
                packageName: 'example-package',
                entryPoint: 'example',
                pluginId: 'example',
                name: 'Example',
                description: 'Example destination',
                destinationUrl: 'https://example.com/receiver',
                targetOrigin: 'https://example.com',
                repositoryUrl: 'https://github.com/example/repository',
                iconUrl: null,
                releaseRepository: 'example/repository',
                wheelAssetPrefix: 'example-',
                checksumAssetSuffix: '.sha256'
            });

            expect(global.fetch.mock.calls[1]).toEqual([
                'https://localhost:8788/api/github/release-asset?asset=example-1.0.0.whl&repository=example%2Frepository',
                { cache: 'no-store' }
            ]);
            expect(adapter.writeFile).toHaveBeenCalledWith(
                '/Plugins/example-1.0.0.whl',
                new Uint8Array([1, 2, 3])
            );
            expect(window.pyodide.runPythonAsync.mock.calls[0][0]).toContain(
                'await micropip.install("emfs:/tmp/counterpunch-plugins/example-1.0.0.whl", reinstall=True)'
            );
            expect(window.pyodide.runPythonAsync.mock.calls[1][0]).toContain(
                'importlib.invalidate_caches()'
            );
            expect(manager.getInstalledDestinations()).toEqual([
                expect.objectContaining({
                    pluginId: 'example',
                    name: 'Example'
                })
            ]);
        } finally {
            pluginRegistry.get = originalGetPlugin;
            window.pyodide = originalPyodide;
            if (originalCrypto) {
                Object.defineProperty(global, 'crypto', originalCrypto);
            } else {
                delete global.crypto;
            }
        }
    });

    test('reports missing Plugins storage and creates it inside the Disk root', async () => {
        const { pluginRegistry } = require('../js/filesystem-plugins.ts');
        const originalGetPlugin = pluginRegistry.get;
        const adapter = {
            createFolder: jest.fn().mockResolvedValue(undefined),
            fileExists: jest.fn().mockResolvedValue(false),
            requestPermission: jest.fn().mockResolvedValue('granted')
        };
        pluginRegistry.get = jest.fn((id) =>
            id === 'disk'
                ? {
                      getAdapter: () => adapter,
                      isReady: jest.fn().mockResolvedValue(true)
                  }
                : null
        );
        const {
            FontDestinationPluginManager
        } = require('../js/font-destination-plugin-manager.ts');

        try {
            const manager = new FontDestinationPluginManager();
            await expect(manager.getPluginStorageStatus()).resolves.toBe(
                'plugins-folder-missing'
            );
            await manager.createPluginsDirectory();
            expect(adapter.createFolder).toHaveBeenCalledWith('/Plugins');
        } finally {
            pluginRegistry.get = originalGetPlugin;
        }
    });

    test('reports when no Disk folder is connected', async () => {
        const { pluginRegistry } = require('../js/filesystem-plugins.ts');
        const originalGetPlugin = pluginRegistry.get;
        pluginRegistry.get = jest.fn((id) =>
            id === 'disk'
                ? {
                      getAdapter: () => null,
                      isReady: jest.fn().mockResolvedValue(false)
                  }
                : null
        );
        const {
            FontDestinationPluginManager
        } = require('../js/font-destination-plugin-manager.ts');

        try {
            await expect(
                new FontDestinationPluginManager().getPluginStorageStatus()
            ).resolves.toBe('disk-folder-not-connected');
        } finally {
            pluginRegistry.get = originalGetPlugin;
        }
    });

    test('uninstalls the Pyodide distribution before removing its wheel from disk', async () => {
        const { pluginRegistry } = require('../js/filesystem-plugins.ts');
        const originalGetPlugin = pluginRegistry.get;
        const originalPyodide = window.pyodide;
        const adapter = {
            deleteItem: jest.fn().mockResolvedValue(undefined),
            scanDirectory: jest.fn().mockResolvedValue({})
        };
        pluginRegistry.get = jest.fn((id) =>
            id === 'disk' ? { getAdapter: () => adapter } : null
        );
        window.pyodide = {
            runPythonAsync: jest.fn().mockResolvedValue([])
        };
        const {
            FontDestinationPluginManager
        } = require('../js/font-destination-plugin-manager.ts');

        try {
            await new FontDestinationPluginManager().uninstall(
                '/Plugins/example_plugin-1.0.0-py3-none-any.whl'
            );

            expect(window.pyodide.runPythonAsync.mock.calls[0][0]).toContain(
                'micropip.uninstall(installed_name)'
            );
            expect(
                window.pyodide.runPythonAsync.mock.calls[0][0]
            ).not.toContain('await micropip.uninstall');
            expect(window.pyodide.runPythonAsync.mock.calls[0][0]).toContain(
                'target_distribution = "example-plugin"'
            );
            expect(adapter.deleteItem).toHaveBeenCalledWith(
                '/Plugins/example_plugin-1.0.0-py3-none-any.whl',
                false
            );
        } finally {
            pluginRegistry.get = originalGetPlugin;
            window.pyodide = originalPyodide;
        }
    });

    test('delivers through ready destination bridges and skips closed windows', () => {
        const {
            FontDestinationPluginManager
        } = require('../js/font-destination-plugin-manager.ts');
        const createBridge = (closed = false) => {
            const bridge = new EventTarget();
            bridge.closed = closed;
            bridge.postMessage = jest.fn();
            return bridge;
        };
        const bridge = createBridge();
        const secondBridge = createBridge();
        const closedBridge = createBridge(true);
        window.open = jest
            .fn()
            .mockReturnValueOnce(bridge)
            .mockReturnValueOnce(secondBridge)
            .mockReturnValueOnce(closedBridge);
        const manager = new FontDestinationPluginManager();
        const destination = {
            pluginId: 'example',
            name: 'Example',
            description: 'Example destination',
            destinationUrl: 'https://example.com/receiver',
            targetOrigin: 'https://example.com',
            repositoryUrl: 'https://github.com/example/repository',
            iconUrl: null
        };

        manager.openDestination(destination);
        manager.openDestination({
            ...destination,
            pluginId: 'second',
            destinationUrl: 'https://second.example/receiver',
            targetOrigin: 'https://second.example'
        });
        manager.openDestination({
            ...destination,
            pluginId: 'closed',
            destinationUrl: 'https://closed.example/receiver',
            targetOrigin: 'https://closed.example'
        });
        manager.deliverExportedFont(new Uint8Array([1, 2, 3]), {
            byteLength: 3,
            changeVersion: 1,
            filename: 'Example.ttf',
            format: 'ttf',
            mimeType: 'font/ttf',
            timeTakenMs: 1
        });

        const openedBridgeUrl = new URL(window.open.mock.calls[0][0]);
        expect(window.open).toHaveBeenCalledWith(
            openedBridgeUrl.href,
            'counterpunch-font-destination-example'
        );
        expect(openedBridgeUrl.origin).toBe(window.location.origin);
        expect(openedBridgeUrl.pathname).toBe('/font-destination-bridge.html');
        expect(openedBridgeUrl.searchParams.get('destinationUrl')).toBe(
            destination.destinationUrl
        );
        expect(bridge.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'counterpunch:binary-font-exported',
                bytes: expect.any(ArrayBuffer)
            }),
            window.location.origin,
            [expect.any(ArrayBuffer)]
        );
        expect(secondBridge.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ bytes: expect.any(ArrayBuffer) }),
            window.location.origin,
            [expect.any(ArrayBuffer)]
        );
        expect(closedBridge.postMessage).not.toHaveBeenCalled();
    });
});
