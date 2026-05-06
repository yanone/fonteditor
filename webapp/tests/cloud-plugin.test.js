jest.mock('../js/logger', () => ({
    Logger: class {
        log() {}
        warn() {}
        error() {}
    }
}));

const mockConnectDirect = jest.fn().mockResolvedValue();
const mockRebindToCurrentBridge = jest.fn();

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
        mockLatestTempBridge = {
            fontMap: { __mock: true },
            getFullState: jest.fn(() => mockBridgeState)
        };
        return mockLatestTempBridge;
    })
}));

jest.mock('../js/change-bridge-ydoc', () => ({
    ...jest.requireActual('../js/change-bridge-ydoc'),
    yDocToJson: jest.fn(() => ({
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
    }))
}));

const { CloudPlugin } = require('../js/cloud-plugin');

describe('CloudPlugin.openAsset', () => {
    let plugin;
    let originalAuthManager;
    let originalDispatchEvent;
    let originalSetTimeout;
    let originalClearTimeout;
    let originalAddEventListener;
    let originalRemoveEventListener;
    let dispatchSpy;
    let eventListeners;

    beforeEach(() => {
        mockConnectDirect.mockClear();
        mockRebindToCurrentBridge.mockClear();
        mockLatestTempBridge = null;

        originalAuthManager = window.authManager;
        originalDispatchEvent = window.dispatchEvent;
        originalSetTimeout = window.setTimeout;
        originalClearTimeout = window.clearTimeout;
        originalAddEventListener = window.addEventListener;
        originalRemoveEventListener = window.removeEventListener;

        window.authManager = {
            websiteURL: 'http://localhost:8788',
            ensureCloudSession: jest.fn().mockResolvedValue({ id: 'user-1' }),
            checkAuthStatus: jest.fn().mockResolvedValue({ id: 'user-1' }),
            getSessionToken: jest.fn().mockReturnValue('token')
        };

        window.changeBridge = undefined;
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
});
