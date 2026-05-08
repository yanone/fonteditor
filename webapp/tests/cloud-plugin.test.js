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

jest.mock('../js/change-bridge', () => ({
    ChangeBridge: jest.fn().mockImplementation(() => {
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
            getFullState: jest.fn(() => mockBridgeState)
        };
        return mockLatestTempBridge;
    })
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
                            Path: {
                                nodes: [
                                    { x: 0, y: 0, type: 'l' },
                                    { x: 100, y: 0, type: 'l' }
                                ]
                            }
                        },
                        {
                            Component: {
                                reference: 'acutecomb'
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
                const handler = eventListeners.get('fontModelReady');
                if (handler) {
                    handler();
                }
            }
            return true;
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
    });

    test('sanitizes wrapped cloud-exported shapes before dispatching fontLoaded', async () => {
        await plugin.openAsset('asset-1');

        const fontLoadedEvent = dispatchSpy.mock.calls
            .map(([event]) => event)
            .find((event) => event.type === 'fontLoaded');

        expect(fontLoadedEvent).toBeDefined();

        const parsed = JSON.parse(fontLoadedEvent.detail.babelfontJson);
        const layer = parsed.glyphs[0].layers[0];

        expect(layer.shapes[0]).toEqual({
            nodes: '0 0 l 100 0 l',
            closed: false
        });
        expect(layer.shapes[1]).toEqual({
            reference: 'acutecomb',
            transform: {
                translation: [0, 0],
                rotation: 0,
                scale: [1, 1],
                skew: [0, 0],
                order: 'RestOfTheWorld'
            }
        });
        expect(window.__pendingCloudBridgeBootstrapState).toBe(mockBridgeState);
        expect(window.addEventListener).toHaveBeenCalledWith(
            'fontModelReady',
            expect.any(Function)
        );
    });

    test('recovers cloud-exported layers missing width and dispatches fontLoaded', async () => {
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

        // The open should succeed with width recovered to 0 (fallback)
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

        expect(plugin._fetchRoomToken).toHaveBeenCalledTimes(1);
        expect(mockConnectDirect).toHaveBeenCalledTimes(1);
    });

    test('rejects saveAs before creating an asset when current bridge has a layer missing width', async () => {
        window.changeBridge = {
            fontMap: { __mock: true }
        };
        mockYDocToJson.mockReturnValue({
            glyphs: [
                {
                    name: 'o',
                    layers: [
                        {
                            id: '3114FB65-9464-41A5-B67E-A8F9F43C0EF1',
                            shapes: []
                        }
                    ]
                }
            ]
        });

        await expect(plugin.saveAs('Corrupt Save')).rejects.toThrow(
            'Cloud font layer o/3114FB65-9464-41A5-B67E-A8F9F43C0EF1 has invalid width; refusing to save cloud font data.'
        );

        expect(global.fetch).not.toHaveBeenCalled();
        expect(mockConnectDirect).not.toHaveBeenCalled();
    });
});
