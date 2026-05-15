jest.mock('../js/logger', () => ({
    Logger: class {
        log() {}
        warn() {}
        error() {}
    }
}));

const mockConnectDirect = jest.fn().mockResolvedValue();
const mockRebindToCurrentBridge = jest.fn();
const mockYDocToJson = jest.fn();

jest.mock('../js/cloud-adapter', () => ({
    CloudAdapter: jest.fn().mockImplementation((options = {}) => ({
        connectDirect: jest.fn(async (...args) => {
            mockConnectDirect(...args);
            if (typeof options.onConnectionStatus === 'function') {
                options.onConnectionStatus('connected');
            }
        }),
        rebindToCurrentBridge: mockRebindToCurrentBridge,
        disconnect: jest.fn(),
        status: 'disconnected'
    })),
    normalizeCloudRoomWebSocketUrl: jest.fn((roomUrl) => roomUrl)
}));

const mockBridgeState = new Uint8Array([1, 2, 3]);
let mockLatestTempBridge = null;

jest.mock('../js/patch-sync-engine', () => ({
    PatchSyncEngine: jest.fn().mockImplementation(() => {
        let updateHandler = null;
        mockLatestTempBridge = {
            fontMap: { __mock: true },
            yDoc: {
                on: jest.fn((eventName, handler) => {
                    if (eventName === 'update') {
                        updateHandler = handler;
                    }
                }),
                off: jest.fn((eventName, handler) => {
                    if (eventName === 'update' && updateHandler === handler) {
                        updateHandler = null;
                    }
                }),
                __emitUpdate: () => {
                    if (updateHandler) {
                        updateHandler();
                    }
                }
            },
            getFullState: jest.fn(() => mockBridgeState),
            getChangeLog: jest.fn(() => [
                {
                    id: 1,
                    timestamp: 1,
                    windowId: 'bootstrap',
                    windowRoleLabel: 'main',
                    historyItemId: 'history-1',
                    historyAction: 'change',
                    targetHistoryItemId: null,
                    transactionLabel: 'Bootstrap',
                    transactionId: 1,
                    op: 'set',
                    undoScope: 'font',
                    path: 'font',
                    oldValue: null,
                    newValue: 'bootstrap',
                    historyTargetType: null,
                    historyTargetKey: null,
                    historyTargetLabel: null,
                    workerReplayTargets: []
                }
            ])
        };
        return mockLatestTempBridge;
    }),
    ChangeBridge: jest.fn().mockImplementation(() => mockLatestTempBridge)
}));

jest.mock('../js/change-bridge-ydoc', () => ({
    ...jest.requireActual('../js/change-bridge-ydoc'),
    yDocToJson: (...args) => mockYDocToJson(...args)
}));

const defaultCloudFontJson = {
    glyphs: [
        {
            name: 'A',
            layers: [
                {
                    id: 'L0',
                    width: 600,
                    shapes: [
                        {
                            nodes: [
                                { x: 0, y: 0, type: 'l' },
                                { x: 100, y: 0, type: 'l' }
                            ],
                            closed: false
                        },
                        {
                            reference: 'acutecomb',
                            transform: {
                                translation: [12, 34],
                                rotation: 15,
                                scale: [1.2, 0.8],
                                skew: [3, 4],
                                order: 'Glyphs'
                            }
                        }
                    ]
                }
            ]
        }
    ]
};

const wrappedCloudFontJson = {
    glyphs: [
        {
            name: 'A',
            layers: [
                {
                    id: 'L0',
                    width: 600,
                    shapes: [
                        {
                            Path: {
                                nodes: [
                                    { x: 0, y: 0, type: 'l' },
                                    { x: 100, y: 0, type: 'l' }
                                ]
                            }
                        }
                    ]
                }
            ]
        }
    ]
};

const { CloudPlugin } = require('../js/cloud-plugin');

describe('CloudPlugin.openAsset', () => {
    let plugin;
    let originalAuthManager;
    let originalDispatchEvent;
    let originalSetTimeout;
    let originalClearTimeout;
    let originalAddEventListener;
    let originalRemoveEventListener;
    let originalFetch;
    let dispatchSpy;
    let eventListeners;

    beforeEach(() => {
        mockConnectDirect.mockClear();
        mockRebindToCurrentBridge.mockClear();
        mockYDocToJson.mockReset();
        mockYDocToJson.mockReturnValue(defaultCloudFontJson);
        mockLatestTempBridge = null;

        originalAuthManager = window.authManager;
        originalDispatchEvent = window.dispatchEvent;
        originalSetTimeout = window.setTimeout;
        originalClearTimeout = window.clearTimeout;
        originalAddEventListener = window.addEventListener;
        originalRemoveEventListener = window.removeEventListener;
        originalFetch = global.fetch;

        window.authManager = {
            websiteURL: 'http://localhost:8788',
            ensureCloudSession: jest.fn().mockResolvedValue({ id: 'user-1' }),
            checkAuthStatus: jest.fn().mockResolvedValue({ id: 'user-1' }),
            getSessionToken: jest.fn().mockReturnValue('token')
        };

        window.changeBridge = undefined;
        global.fetch = jest.fn();
        eventListeners = new Map();

        window.setTimeout = jest.fn(() => 1);
        window.clearTimeout = jest.fn();
        window.addEventListener = jest.fn((type, handler) => {
            eventListeners.set(type, handler);
        });
        window.removeEventListener = jest.fn((type, handler) => {
            if (eventListeners.get(type) === handler) {
                eventListeners.delete(type);
            }
        });

        dispatchSpy = jest.fn((event) => {
            if (event.type === 'fontLoaded') {
                // Simulate the app setting window.patchSyncEngine before fontModelReady fires
                if (!window.patchSyncEngine) {
                    window.patchSyncEngine = {
                        onLocalUpdate: jest.fn(),
                        offLocalUpdate: jest.fn()
                    };
                }
                const handler = eventListeners.get('fontModelReady');
                if (handler) {
                    handler();
                }
            }
        });

        window.dispatchEvent = dispatchSpy;

        plugin = new CloudPlugin();
        plugin._fetchRoomToken = jest.fn().mockResolvedValue({
            token: 'room-token',
            roomUrl: 'ws://localhost:8787/room/asset-1'
        });
    });

    afterEach(() => {
        window.authManager = originalAuthManager;
        window.dispatchEvent = originalDispatchEvent;
        window.setTimeout = originalSetTimeout;
        window.clearTimeout = originalClearTimeout;
        window.addEventListener = originalAddEventListener;
        window.removeEventListener = originalRemoveEventListener;
        global.fetch = originalFetch;
        delete window.__pendingCloudBridgeBootstrapState;
        delete window.patchSyncEngine;
    });

    test('rejects wrapped cloud-exported shapes before dispatching fontLoaded', async () => {
        mockYDocToJson.mockReturnValueOnce(wrappedCloudFontJson);

        await expect(plugin.openAsset('asset-1')).rejects.toThrow(
            'Wrapped Path shapes are not allowed in cloud-exported font data.'
        );

        const fontLoadedEvent = dispatchSpy.mock.calls
            .map(([event]) => event)
            .find((event) => event.type === 'fontLoaded');

        expect(fontLoadedEvent).toBeUndefined();
    });

    test('allows cloud-exported layers missing width on open (sparse delta pipeline self-heals)', async () => {
        mockYDocToJson.mockReturnValue({
            glyphs: [
                {
                    name: 'space',
                    layers: [
                        {
                            id: 'space-layer',
                            shapes: []
                        }
                    ]
                }
            ]
        });

        // Missing width no longer rejects — the sparse delta pipeline
        // propagates correct width on next edit.
        await expect(plugin.openAsset('asset-1')).resolves.toBeUndefined();

        expect(dispatchSpy).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'fontLoaded' })
        );
    });

    test('waits for initial cloud font data before throwing no-font-data', async () => {
        mockYDocToJson
            .mockReturnValueOnce({})
            .mockReturnValue(defaultCloudFontJson);

        const openPromise = plugin.openAsset('asset-1');
        for (let attempt = 0; attempt < 5 && !mockLatestTempBridge; attempt++) {
            await Promise.resolve();
        }

        expect(mockLatestTempBridge).toBeTruthy();

        for (
            let attempt = 0;
            attempt < 50 &&
            mockLatestTempBridge.yDoc.on.mock.calls.length === 0;
            attempt++
        ) {
            await Promise.resolve();
        }

        expect(mockLatestTempBridge.yDoc.on.mock.calls.length).toBeGreaterThan(
            0
        );

        mockLatestTempBridge.yDoc.__emitUpdate();

        await expect(openPromise).resolves.toBeUndefined();
        expect(dispatchSpy).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'fontLoaded' })
        );
    });

    test('coalesces concurrent opens for the same asset', async () => {
        mockYDocToJson
            .mockReturnValueOnce({})
            .mockReturnValue(defaultCloudFontJson);

        const firstOpenPromise = plugin.openAsset('asset-1');
        const secondOpenPromise = plugin.openAsset('asset-1');

        for (let attempt = 0; attempt < 5 && !mockLatestTempBridge; attempt++) {
            await Promise.resolve();
        }

        expect(mockLatestTempBridge).toBeTruthy();

        for (
            let attempt = 0;
            attempt < 50 &&
            mockLatestTempBridge.yDoc.on.mock.calls.length === 0;
            attempt++
        ) {
            await Promise.resolve();
        }

        mockLatestTempBridge.yDoc.__emitUpdate();

        await expect(
            Promise.all([firstOpenPromise, secondOpenPromise])
        ).resolves.toEqual([undefined, undefined]);

        expect(plugin._fetchRoomToken).toHaveBeenCalledTimes(2);
        expect(mockConnectDirect).toHaveBeenCalledTimes(2);
    });
});
