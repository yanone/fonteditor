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
const { TextEncoder } = require('util');
let mockConnectDirectStatusQueue = [];

jest.mock('../js/cloud-adapter', () => ({
    CloudAdapter: jest.fn().mockImplementation((options = {}) => ({
        cacheAssetRole: jest.fn(),
        getCachedAssetRole: jest.fn().mockReturnValue(null),
        connectDirect: jest.fn(async (...args) => {
            mockConnectDirect(...args);
            const queuedStatuses = mockConnectDirectStatusQueue.length
                ? mockConnectDirectStatusQueue.shift()
                : [{ status: 'connected' }];
            if (typeof options.onConnectionStatus === 'function') {
                for (const statusEntry of queuedStatuses) {
                    options.onConnectionStatus(
                        statusEntry.status,
                        statusEntry.detail
                    );
                }
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
            initFromJson: jest.fn(),
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
    let originalAlert;
    let originalDispatchEvent;
    let originalSetTimeout;
    let originalClearTimeout;
    let originalAddEventListener;
    let originalRemoveEventListener;
    let originalFetch;
    let originalTextEncoder;
    let dispatchSpy;
    let eventListeners;

    beforeEach(() => {
        mockConnectDirect.mockClear();
        mockConnectDirectStatusQueue = [];
        mockRebindToCurrentBridge.mockClear();
        mockYDocToJson.mockReset();
        mockYDocToJson.mockReturnValue(defaultCloudFontJson);
        mockLatestTempBridge = null;

        originalAuthManager = window.authManager;
        originalAlert = window.alert;
        originalDispatchEvent = window.dispatchEvent;
        originalSetTimeout = window.setTimeout;
        originalClearTimeout = window.clearTimeout;
        originalAddEventListener = window.addEventListener;
        originalRemoveEventListener = window.removeEventListener;
        originalFetch = global.fetch;
        originalTextEncoder = global.TextEncoder;

        window.authManager = {
            websiteURL: 'http://localhost:8788',
            ensureCloudSession: jest.fn().mockResolvedValue({ id: 'user-1' }),
            checkAuthStatus: jest.fn().mockResolvedValue({ id: 'user-1' }),
            getSessionToken: jest.fn().mockReturnValue('token')
        };
        window.alert = jest.fn();

        window.changeBridge = undefined;
        global.fetch = jest.fn();
        global.TextEncoder = TextEncoder;
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
        window.alert = originalAlert;
        window.dispatchEvent = originalDispatchEvent;
        window.setTimeout = originalSetTimeout;
        window.clearTimeout = originalClearTimeout;
        window.addEventListener = originalAddEventListener;
        window.removeEventListener = originalRemoveEventListener;
        global.fetch = originalFetch;
        global.TextEncoder = originalTextEncoder;
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

    test('saveAs resolves after fontReady without waiting for live bridge bootstrap', async () => {
        window.glyphCanvas = {
            initialFontLoaded: true
        };
        window.currentFontModel = {
            glyphs: [
                {
                    name: 'A',
                    layers: [
                        {
                            id: 'L0',
                            shapes: [{}, {}],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ]
        };
        window.fontManager = {
            currentFont: {
                name: 'Save Source',
                path: '/user/Save Source.babelfont',
                babelfontJson: JSON.stringify(defaultCloudFontJson),
                babelfontData: defaultCloudFontJson,
                fontModel: window.currentFontModel,
                syncJsonFromModel: jest.fn()
            },
            editingFont: new Uint8Array([1])
        };
        window.patchSyncEngine = {
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({
                asset: {
                    id: 'asset-save',
                    name: 'Save Source',
                    role: 'owner',
                    ownerUserId: 'user-1',
                    createdAt: 1,
                    updatedAt: 1
                }
            }),
            text: jest.fn().mockResolvedValue('')
        });

        window.dispatchEvent = jest.fn((event) => {
            if (event.type === 'fontLoaded') {
                window.fontManager.currentFont.path = event.detail?.path;
                window.fontManager.currentFont.sourcePlugin = plugin;
            }
            return true;
        });

        await expect(plugin.saveAs('Save Source')).resolves.toBe('asset-save');
    });

    test('background live bridge timeouts retry silently after the font is already open', async () => {
        window.fontManager = {
            currentFont: {
                path: 'cloud://asset-save'
            }
        };
        const connectToRoomSpy = jest
            .spyOn(plugin, 'connectToRoom')
            .mockResolvedValue();

        plugin._handleBackgroundBridgeBootstrapFailure(
            'asset-save',
            new Error('cloud sync timed out')
        );

        expect(window.alert).not.toHaveBeenCalled();
        expect(connectToRoomSpy).toHaveBeenCalledWith('asset-save');

        connectToRoomSpy.mockRestore();
    });

    test('alerts once for active cloud runtime errors and re-alerts after recovery', () => {
        plugin._activeAssetId = 'asset-1';

        plugin._updateConnectionStatus(
            'asset-1',
            'error',
            'Sync upload exceeds byte limit'
        );
        plugin._updateConnectionStatus(
            'asset-1',
            'error',
            'Sync upload exceeds byte limit'
        );

        expect(window.alert).toHaveBeenCalledTimes(1);
        expect(window.alert).toHaveBeenCalledWith(
            'Cloud connection error: Sync upload exceeds byte limit'
        );

        plugin._updateConnectionStatus('asset-1', 'connected');
        plugin._updateConnectionStatus(
            'asset-1',
            'error',
            'Sync upload exceeds byte limit'
        );

        expect(window.alert).toHaveBeenCalledTimes(2);
    });

    test('does not alert for transient stale access epoch reconnects', () => {
        plugin._activeAssetId = 'asset-1';

        plugin._updateConnectionStatus(
            'asset-1',
            'connecting',
            'Access epoch is stale'
        );

        expect(window.alert).not.toHaveBeenCalled();
    });

    test('does not alert for transient websocket reconnects', () => {
        plugin._activeAssetId = 'asset-1';

        plugin._updateConnectionStatus(
            'asset-1',
            'connecting',
            'WebSocket error (wss://rooms.example.com/room/asset-1)'
        );

        expect(window.alert).not.toHaveBeenCalled();
    });

    test('moves a deleted active cloud asset into local memory with unsaved changes', () => {
        const disconnect = jest.fn();
        plugin._cloudAdapter = {
            disconnect,
            status: 'connected'
        };
        plugin._activeAssetId = 'asset-1';

        const updateFontDisplay = jest.fn();
        const updateDirtyIndicator = jest.fn();
        const currentFont = {
            path: 'cloud://asset-1',
            name: 'Deleted Shared Font',
            sourcePlugin: {
                getId: jest.fn(() => 'cloud')
            },
            fileHandle: 'handle',
            directoryHandle: 'dir',
            hasUnsavedChanges: false
        };
        window.fontManager = {
            currentFont,
            updateFontDisplay,
            updateDirtyIndicator
        };
        window.saveButton = {
            updateButtonState: jest.fn()
        };

        plugin._updateConnectionStatus(
            'asset-1',
            'error',
            'Cloud asset was deleted'
        );

        expect(disconnect).toHaveBeenCalledTimes(1);
        expect(currentFont.sourcePlugin?.getId?.()).toBe('memory');
        expect(currentFont.path).toBe('/user/Deleted Shared Font.babelfont');
        expect(currentFont.fileHandle).toBeUndefined();
        expect(currentFont.directoryHandle).toBeUndefined();
        expect(currentFont.hasUnsavedChanges).toBe(true);
        expect(updateFontDisplay).toHaveBeenCalled();
        expect(updateDirtyIndicator).toHaveBeenCalled();
        expect(window.saveButton.updateButtonState).toHaveBeenCalled();
        expect(window.alert).toHaveBeenCalledWith(
            'Cloud asset was deleted. The open font was kept locally in Memory with unsaved changes.'
        );
    });

    test('suppresses the local delete alert when requested explicitly', () => {
        const disconnect = jest.fn();
        plugin._cloudAdapter = {
            disconnect,
            status: 'connected'
        };
        plugin._activeAssetId = 'asset-1';

        window.fontManager = {
            currentFont: {
                path: 'cloud://asset-1',
                name: 'Deleted Shared Font',
                sourcePlugin: {
                    getId: jest.fn(() => 'cloud')
                },
                hasUnsavedChanges: false
            },
            updateFontDisplay: jest.fn(),
            updateDirtyIndicator: jest.fn()
        };
        window.saveButton = {
            updateButtonState: jest.fn()
        };

        plugin.handleDeletedAsset('asset-1', undefined, {
            suppressAlert: true
        });

        expect(window.alert).not.toHaveBeenCalled();
    });

    test('maps deleted room-token reconnect failures back to deleted asset handling', async () => {
        window.fontManager = {
            currentFont: {
                path: 'cloud://asset-1',
                sourcePlugin: {
                    getId: jest.fn(() => 'cloud')
                }
            }
        };

        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 404,
            text: jest.fn().mockResolvedValue('{"error":"Not found"}')
        });

        await expect(
            CloudPlugin.prototype._fetchRoomToken.call(plugin, 'asset-1')
        ).rejects.toThrow('Cloud asset was deleted');
    });
});

describe('CloudPlugin sharing APIs', () => {
    let plugin;
    let originalAuthManager;
    let originalFontManager;
    let originalFetch;

    beforeEach(() => {
        originalAuthManager = window.authManager;
        originalFontManager = window.fontManager;
        originalFetch = global.fetch;

        window.authManager = {
            websiteURL: 'http://localhost:8788',
            ensureCloudSession: jest.fn().mockResolvedValue({ id: 'user-1' }),
            getSessionToken: jest.fn().mockReturnValue('token')
        };
        window.fontManager = {
            currentFont: {
                path: 'cloud://asset-1',
                sourcePlugin: {
                    getId: jest.fn(() => 'cloud')
                }
            }
        };
        global.fetch = jest.fn();
        plugin = new CloudPlugin();
    });

    afterEach(() => {
        window.authManager = originalAuthManager;
        window.fontManager = originalFontManager;
        global.fetch = originalFetch;
    });

    test('resolves the current cloud asset id from the open font path', () => {
        expect(plugin.getCurrentAssetIdForSharing()).toBe('asset-1');
    });

    test('loads share state for the current cloud asset', async () => {
        global.fetch.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({
                asset: {
                    id: 'asset-1',
                    name: 'Shared Font',
                    role: 'owner',
                    ownerUserId: 'user-1',
                    createdAt: 1,
                    updatedAt: 2,
                    accessEpoch: 0
                },
                permissions: { canManage: true },
                members: [],
                invitations: [],
                ownershipTransfer: null
            })
        });

        const shareState = await plugin.getShareState();

        expect(shareState.asset.id).toBe('asset-1');
        expect(global.fetch).toHaveBeenCalledWith(
            'http://localhost:8788/api/cloud/assets/asset-1/members',
            expect.objectContaining({
                credentials: 'include',
                headers: expect.objectContaining({
                    Authorization: 'Bearer token'
                })
            })
        );
    });

    test('creates invitations for the current cloud asset', async () => {
        global.fetch.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({
                invitation: {
                    id: 'invite-1',
                    email: 'viewer@example.com',
                    role: 'viewer',
                    targetUserId: 'user-2',
                    targetUserEmail: 'viewer@example.com',
                    createdAt: 1,
                    expiresAt: 2,
                    lastSentAt: 1,
                    resendCount: 0
                },
                inviteUrl: 'http://localhost:8788/invite?token=secret'
            })
        });

        const result = await plugin.inviteUser('viewer@example.com', 'viewer');

        expect(result.invitation.id).toBe('invite-1');
        expect(result.inviteUrl).toBe(
            'http://localhost:8788/invite?token=secret'
        );
        expect(global.fetch).toHaveBeenCalledWith(
            'http://localhost:8788/api/cloud/assets/asset-1/invitations',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    email: 'viewer@example.com',
                    role: 'viewer'
                })
            })
        );
    });

    test('creates and cancels ownership transfers for the current cloud asset', async () => {
        global.fetch
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue({
                    ownershipTransfer: {
                        id: 'transfer-1',
                        email: 'new-owner@example.com',
                        targetUserId: 'user-3',
                        targetUserEmail: 'new-owner@example.com',
                        previousOwnerRole: 'remove',
                        sourceOwnerUserId: 'user-1',
                        sourceOwnerEmail: 'owner@example.com',
                        createdAt: 1,
                        expiresAt: 2
                    },
                    transferUrl: 'http://localhost:8788/transfer?token=secret'
                })
            })
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue({ success: true })
            });

        const result = await plugin.createOwnershipTransfer(
            'new-owner@example.com',
            'remove'
        );
        await plugin.cancelOwnershipTransfer();

        expect(result.ownershipTransfer.id).toBe('transfer-1');
        expect(result.transferUrl).toBe(
            'http://localhost:8788/transfer?token=secret'
        );
        expect(global.fetch).toHaveBeenNthCalledWith(
            1,
            'http://localhost:8788/api/cloud/assets/asset-1/ownership-transfer',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    email: 'new-owner@example.com',
                    previousOwnerRole: 'remove'
                })
            })
        );
        expect(global.fetch).toHaveBeenNthCalledWith(
            2,
            'http://localhost:8788/api/cloud/assets/asset-1/ownership-transfer',
            expect.objectContaining({ method: 'DELETE' })
        );
    });

    test('updates member role and removes members for the current cloud asset', async () => {
        global.fetch
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue({ success: true })
            })
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue({ success: true })
            });

        await plugin.updateMemberRole('user-2', 'editor');
        await plugin.removeMember('user-2');

        expect(global.fetch).toHaveBeenNthCalledWith(
            1,
            'http://localhost:8788/api/cloud/assets/asset-1/members/user-2',
            expect.objectContaining({
                method: 'PATCH',
                body: JSON.stringify({ role: 'editor' })
            })
        );
        expect(global.fetch).toHaveBeenNthCalledWith(
            2,
            'http://localhost:8788/api/cloud/assets/asset-1/members/user-2',
            expect.objectContaining({ method: 'DELETE' })
        );
    });
});

describe('CloudPlugin eligibility gating', () => {
    let plugin;
    let originalAuthManager;
    let originalFetch;
    let originalRefreshFileSystem;

    beforeEach(() => {
        originalAuthManager = window.authManager;
        originalFetch = global.fetch;
        originalRefreshFileSystem = window.refreshFileSystem;

        document.body.innerHTML = `
            <div id="cloud-panel"></div>
            <div id="cloud-panel-title"></div>
            <div id="cloud-panel-message"></div>
            <button id="cloud-panel-login-btn"></button>
        `;

        window.authManager = {
            websiteURL: 'http://localhost:8788',
            ensureCloudSession: jest.fn().mockResolvedValue({ id: 'user-1' }),
            checkAuthStatus: jest.fn().mockResolvedValue({ id: 'user-1' }),
            getSessionToken: jest.fn().mockReturnValue('token')
        };
        window.refreshFileSystem = jest.fn();
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({
                cloudHostingEnabled: false,
                maxFontsOwned: null,
                snapshotRetentionDays: null,
                fontsOwnedCount: 0
            })
        });

        plugin = new CloudPlugin();
    });

    afterEach(() => {
        window.authManager = originalAuthManager;
        window.refreshFileSystem = originalRefreshFileSystem;
        global.fetch = originalFetch;
        document.body.innerHTML = '';
    });

    test('activates for authenticated invited users even without hosting eligibility', async () => {
        await expect(plugin.onActivate()).resolves.toBe(true);
    });

    test('does not show the hosting-disabled panel to authenticated users without hosting eligibility', async () => {
        await plugin.updateUI({
            showOpenFolderUI: jest.fn(),
            hideOpenFolderUI: jest.fn(),
            showPermissionBanner: jest.fn(),
            showUnsupportedBrowserUI: jest.fn(),
            hideUnsupportedBrowserUI: jest.fn(),
            showPluginMessage: jest.fn(),
            hidePluginMessage: jest.fn()
        });

        expect(
            document.getElementById('cloud-panel').classList.contains('visible')
        ).toBe(false);
        expect(window.refreshFileSystem).toHaveBeenCalled();
    });
});
