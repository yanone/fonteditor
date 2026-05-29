const {
    CloudAdapter,
    normalizeCloudRoomWebSocketUrl
} = require('../js/cloud-adapter.ts');
const { createLogEntry } = require('../js/change-log');
const {
    createCollaborationMessageEnvelopesFromChangeLogEntries,
    createCollaborationMessageEnvelopeFromChangeLogEntries,
    createCollaborationMessageEnvelope
} = require('../js/collaboration-message.ts');

describe('CloudAdapter room worker defaults', () => {
    it('defaults to localhost in development', () => {
        const originalIsDevelopment = window.isDevelopment;
        window.isDevelopment = jest.fn(() => true);

        try {
            const adapter = new CloudAdapter({ assetId: 'asset-123' });
            expect(adapter._roomWorkerBaseUrl).toBe('ws://localhost:8787');
        } finally {
            window.isDevelopment = originalIsDevelopment;
        }
    });

    it('defaults to the production worker in production', () => {
        const originalIsDevelopment = window.isDevelopment;
        window.isDevelopment = jest.fn(() => false);

        try {
            const adapter = new CloudAdapter({ assetId: 'asset-123' });
            expect(adapter._roomWorkerBaseUrl).toBe(
                'https://fonts-room.fonteditor.workers.dev'
            );
        } finally {
            window.isDevelopment = originalIsDevelopment;
        }
    });

    it('exposes cloud roles in scanDirectory results', async () => {
        const originalFetch = global.fetch;
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space'
        });

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                assets: [
                    {
                        id: 'asset-editor',
                        name: 'Editor Font',
                        updatedAt: 1,
                        role: 'editor'
                    },
                    {
                        id: 'asset-owner',
                        name: 'Owner Font',
                        updatedAt: 2,
                        role: 'owner',
                        connectedPeers: 3
                    }
                ]
            })
        });

        try {
            const items = await adapter.scanDirectory('/');
            expect(items['Editor Font.babelfont']).toMatchObject({
                path: 'cloud://asset-editor',
                cloudRole: 'editor'
            });
            expect(items['Owner Font.babelfont']).toMatchObject({
                path: 'cloud://asset-owner',
                cloudRole: 'owner',
                cloudConnectedPeers: 3
            });
            expect(adapter.getCachedAssetRole('asset-owner')).toBe('owner');
        } finally {
            global.fetch = originalFetch;
        }
    });
});

describe('normalizeCloudRoomWebSocketUrl', () => {
    it('converts https room urls to wss', () => {
        expect(
            normalizeCloudRoomWebSocketUrl(
                'https://rooms.example.com/room/asset-123',
                'https://editor.counterpunch.space'
            )
        ).toBe('wss://rooms.example.com/room/asset-123');
    });

    it('resolves relative room urls against the website base url', () => {
        expect(
            normalizeCloudRoomWebSocketUrl(
                '/api/cloud/room/asset-123',
                'https://editor.counterpunch.space'
            )
        ).toBe('wss://editor.counterpunch.space/api/cloud/room/asset-123');
    });

    it('does not rewrite localhost room urls to a production hostname', () => {
        expect(
            normalizeCloudRoomWebSocketUrl(
                'ws://localhost:8787/room/asset-123',
                'https://editor.counterpunch.space'
            )
        ).toBe('ws://localhost:8787/room/asset-123');
    });
});

describe('CloudAdapter outbound updates', () => {
    it('treats transient websocket transport errors as reconnecting', async () => {
        const statuses = [];
        const originalWebSocket = global.WebSocket;
        let socket;

        class FakeWebSocket {
            constructor(_url) {
                this.readyState = 1;
                socket = this;
            }

            close() {}
        }

        global.WebSocket = FakeWebSocket;

        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });

        try {
            await adapter.connectDirect(
                {
                    onLocalUpdate: jest.fn(),
                    offLocalUpdate: jest.fn()
                },
                'room-token',
                'wss://rooms.example.com/room/asset-123'
            );

            socket.onerror();

            expect(statuses).toContainEqual({
                status: 'connecting',
                detail: 'WebSocket error (wss://rooms.example.com/room/asset-123)'
            });
        } finally {
            global.WebSocket = originalWebSocket;
        }
    });

    it('connect uses the room-token response room url', async () => {
        const originalFetch = global.fetch;
        const openWebSocket = jest.fn().mockResolvedValue(undefined);
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space'
        });

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            headers: new Headers({
                'content-type': 'application/json'
            }),
            json: async () => ({
                token: 'room-token',
                roomUrl:
                    'https://fonts-room.fonteditor.workers.dev/room/asset-123'
            }),
            text: async () => ''
        });
        adapter._openWebSocket = openWebSocket;

        try {
            await adapter.connect({
                onLocalUpdate: jest.fn(),
                offLocalUpdate: jest.fn()
            });

            expect(openWebSocket).toHaveBeenCalledWith(
                'room-token',
                'wss://fonts-room.fonteditor.workers.dev/room/asset-123'
            );
            expect(global.fetch).toHaveBeenCalledWith(
                'https://counterpunch.space/api/cloud/assets/asset-123/room-token',
                expect.objectContaining({
                    method: 'POST',
                    cache: 'no-store'
                })
            );
        } finally {
            global.fetch = originalFetch;
        }
    });

    it('imports persisted mutation history from sync-response bootstrap', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const historyEntry = createLogEntry({
            timestamp: 1,
            windowId: 'client-1',
            windowRoleLabel: 'main',
            transactionLabel: 'Bootstrap',
            transactionId: 1,
            op: 'set',
            undoScope: 'glyph',
            path: 'glyphs.A:name',
            oldValue: 'A',
            newValue: 'A.alt',
            editSource: 'mouse-drag-sidebearing',
            workerReplayTargets: []
        });
        const collaborationMessageHistory = [
            createCollaborationMessageEnvelopeFromChangeLogEntries(
                [historyEntry],
                {
                    localSequence: 1,
                    source: 'cloud-adapter.test',
                    windowId: 'client-1'
                }
            )
        ];
        const pendingEntry = createLogEntry({
            timestamp: 2,
            windowId: 'client-1',
            windowRoleLabel: 'main',
            transactionLabel: 'Pending Local',
            transactionId: 2,
            op: 'set',
            undoScope: 'glyph',
            path: 'glyphs.B:name',
            oldValue: 'B',
            newValue: 'B.alt',
            workerReplayTargets: []
        });
        adapter._pendingDurabilityMessages = [
            createCollaborationMessageEnvelopeFromChangeLogEntries(
                [pendingEntry],
                {
                    localSequence: 2,
                    source: 'cloud-adapter.test',
                    windowId: 'client-1'
                }
            )
        ];
        const bridge = {
            mergeImportedChangeLog: jest.fn(),
            mergeImportedCollaborationMessages: jest.fn(),
            applyFullState: jest.fn(),
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };

        adapter._bridge = bridge;
        adapter._registerOutboundHook = jest.fn();
        adapter._sendSyncComplete = jest.fn();

        adapter._handleMessage(
            JSON.stringify({
                type: 'sync-response',
                update: Buffer.from([1, 2, 3]).toString('base64'),
                serverStateVector: Buffer.from([4, 5, 6]).toString('base64'),
                collaborationMessageHistory
            })
        );

        expect(bridge.mergeImportedChangeLog).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({
                    path: 'glyphs.A:name',
                    transactionLabel: 'Bootstrap'
                }),
                expect.objectContaining({
                    path: 'glyphs.B:name',
                    transactionLabel: 'Pending Local'
                })
            ])
        );
        expect(bridge.mergeImportedCollaborationMessages).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({
                    historyItemId:
                        collaborationMessageHistory[0].metadata.historyItemId,
                    editSource: 'mouse-drag-sidebearing'
                }),
                expect.objectContaining({
                    historyItemId:
                        adapter._pendingDurabilityMessages[0].metadata
                            .historyItemId,
                    editSource: null
                })
            ])
        );
        expect(bridge.applyFullState).toHaveBeenCalledWith(
            new Uint8Array([1, 2, 3])
        );
        expect(adapter._sendSyncComplete).toHaveBeenCalledWith(
            new Uint8Array([4, 5, 6])
        );
    });

    it('sends incremental updates without re-encoding full state', async () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const localUpdate = new Uint8Array([1, 2, 3, 4]);
        const sentFrames = [];
        let localUpdateHandler = null;
        const getFullState = jest.fn(() => new Uint8Array([9, 9, 9]));
        const changeLogEntries = [
            createLogEntry({
                timestamp: 1,
                windowId: 'client-1',
                windowRoleLabel: 'main',
                transactionLabel: 'Drag',
                transactionId: 1,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.A:layers.L0.width',
                oldValue: 600,
                newValue: 700,
                workerReplayTargets: []
            })
        ];
        const collaborationMessage =
            createCollaborationMessageEnvelopeFromChangeLogEntries(
                changeLogEntries,
                {
                    localSequence: 1,
                    source: 'cloud-adapter.test',
                    windowId: 'client-1'
                }
            );
        adapter._bridge = {
            onLocalUpdate: (handler) => {
                localUpdateHandler = handler;
            },
            offLocalUpdate: jest.fn(),
            advanceBroadcastLogCursor: jest.fn(),
            getFullState
        };
        adapter._ws = {
            readyState: 1,
            send: (payload) => sentFrames.push(JSON.parse(payload))
        };
        adapter._clientId = 'client-1';

        adapter._registerOutboundHook();
        localUpdateHandler(localUpdate, collaborationMessage);
        await Promise.resolve();

        expect(getFullState).not.toHaveBeenCalled();
        expect(sentFrames).toHaveLength(1);
        expect(sentFrames[0].type).toBe('update');
        expect(sentFrames[0].clientId).toBe('client-1');
        expect(sentFrames[0].seq).toBe(1);
        expect(sentFrames[0].collaborationMessages).toHaveLength(1);
        expect(sentFrames[0].collaborationMessages[0]).toEqual(
            expect.objectContaining({
                transactionId: collaborationMessage.transactionId,
                label: collaborationMessage.label,
                changes: collaborationMessage.changes
            })
        );
        expect(sentFrames[0].fullState).toBeUndefined();
        expect(sentFrames[0].layerRepairSnapshots).toBeUndefined();
        expect(sentFrames[0].update).toBe(
            Buffer.from(localUpdate).toString('base64')
        );
    });

    it('chunks oversized incremental updates into update-chunk frames', async () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const localUpdate = new Uint8Array(750_001).fill(7);
        const sentFrames = [];
        let localUpdateHandler = null;
        const collaborationMessage =
            createCollaborationMessageEnvelopeFromChangeLogEntries(
                [
                    createLogEntry({
                        timestamp: 1,
                        windowId: 'client-1',
                        windowRoleLabel: 'main',
                        transactionLabel: 'Chunked Drag',
                        transactionId: 1,
                        op: 'set',
                        undoScope: 'layer',
                        path: 'glyphs.A:layers.L0.width',
                        oldValue: 600,
                        newValue: 700,
                        workerReplayTargets: []
                    })
                ],
                {
                    localSequence: 1,
                    source: 'cloud-adapter.test',
                    windowId: 'client-1'
                }
            );

        adapter._bridge = {
            onLocalUpdate: (handler) => {
                localUpdateHandler = handler;
            },
            offLocalUpdate: jest.fn(),
            advanceBroadcastLogCursor: jest.fn()
        };
        adapter._ws = {
            readyState: 1,
            send: (payload) => sentFrames.push(JSON.parse(payload))
        };
        adapter._clientId = 'client-1';

        adapter._registerOutboundHook();
        localUpdateHandler(localUpdate, collaborationMessage);
        await Promise.resolve();

        expect(sentFrames).toHaveLength(2);
        expect(sentFrames[0]).toEqual(
            expect.objectContaining({
                type: 'update-chunk',
                clientId: 'client-1',
                seq: 1,
                chunkIndex: 0,
                totalChunks: 2
            })
        );
        expect(sentFrames[1]).toEqual(
            expect.objectContaining({
                type: 'update',
                clientId: 'client-1',
                seq: 1,
                chunkIndex: 1,
                totalChunks: 2,
                collaborationMessages: [
                    expect.objectContaining({
                        transactionId: collaborationMessage.transactionId,
                        label: collaborationMessage.label
                    })
                ]
            })
        );
    });

    it('reassembles chunked inbound live updates before queueing them', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const update = new Uint8Array([1, 2, 3, 4, 5]);
        const queued = [];

        adapter._queueInboundUpdate = jest.fn((message) =>
            queued.push(message)
        );
        adapter._clientId = 'client-1';

        adapter._handleMessage(
            JSON.stringify({
                type: 'update-chunk',
                update: Buffer.from(update.slice(0, 2)).toString('base64'),
                clientId: 'peer-1',
                seq: 4,
                chunkIndex: 0,
                totalChunks: 2
            })
        );
        adapter._handleMessage(
            JSON.stringify({
                type: 'update',
                update: Buffer.from(update.slice(2)).toString('base64'),
                clientId: 'peer-1',
                seq: 4,
                chunkIndex: 1,
                totalChunks: 2,
                collaborationMessages: [{ transactionId: 'tx-4' }]
            })
        );

        expect(queued).toHaveLength(1);
        expect(Array.from(queued[0].update)).toEqual(Array.from(update));
        expect(queued[0].collaborationMessages).toEqual([
            { transactionId: 'tx-4' }
        ]);
        expect(adapter._incomingLiveUpdateChunks.size).toBe(0);
    });

    it('retains pending outbound packets when the websocket is unavailable', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const packet = {
            update: new Uint8Array([1, 2, 3]),
            collaborationMessage: null
        };

        adapter._bridge = {
            advanceBroadcastLogCursor: jest.fn()
        };
        adapter._pendingOutboundPackets = [packet];
        adapter._outboundFlushScheduled = true;

        adapter._flushPendingOutboundUpdates();

        expect(adapter._pendingOutboundPackets).toEqual([packet]);
        expect(adapter._outboundFlushScheduled).toBe(false);
    });

    it('advances the broadcast cursor when an incremental update is durably acked', async () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const localUpdate = new Uint8Array([1, 2, 3, 4]);
        let localUpdateHandler = null;
        const advanceBroadcastLogCursor = jest.fn();
        const changeLogEntries = [
            createLogEntry({
                timestamp: 1,
                windowId: 'client-1',
                windowRoleLabel: 'main',
                transactionLabel: 'Drag',
                transactionId: 1,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.A:layers.L0:width',
                oldValue: 600,
                newValue: 700,
                workerReplayTargets: []
            })
        ];
        const collaborationMessage =
            createCollaborationMessageEnvelopeFromChangeLogEntries(
                changeLogEntries,
                {
                    localSequence: 1,
                    source: 'cloud-adapter.test',
                    windowId: 'client-1'
                }
            );

        adapter._bridge = {
            onLocalUpdate: (handler) => {
                localUpdateHandler = handler;
            },
            offLocalUpdate: jest.fn(),
            advanceBroadcastLogCursor,
            getFullState: jest.fn()
        };
        adapter._ws = {
            readyState: 1,
            send: jest.fn()
        };
        adapter._clientId = 'client-1';

        adapter._registerOutboundHook();
        localUpdateHandler(localUpdate, collaborationMessage);
        await Promise.resolve();

        adapter._handleMessage(JSON.stringify({ type: 'ack', seq: 1 }));

        expect(advanceBroadcastLogCursor).toHaveBeenCalledWith(1);
        expect(adapter._pendingDurabilityMessages).toEqual([]);
    });

    it('ignores echoed live updates from the same cloud client', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const applyRemoteUpdate = jest.fn();

        adapter._bridge = {
            applyRemoteUpdate,
            encodeBridgeState: jest.fn(() => new Uint8Array([1]))
        };
        adapter._clientId = 'client-1';

        adapter._handleMessage(
            JSON.stringify({
                type: 'update',
                clientId: 'client-1',
                seq: 1,
                update: Buffer.from([1, 2, 3]).toString('base64')
            })
        );

        expect(applyRemoteUpdate).not.toHaveBeenCalled();
    });

    it('preserves and retries an unacked live update across reconnect bootstrap', async () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const sentFrames = [];
        let localUpdateHandler = null;
        const localUpdate = new Uint8Array([1, 2, 3, 4]);
        const changeLogEntries = [
            createLogEntry({
                timestamp: 1,
                windowId: 'client-1',
                windowRoleLabel: 'main',
                transactionLabel: 'Live edit',
                transactionId: 3,
                op: 'set',
                undoScope: 'glyph',
                path: 'glyphs.C:name',
                oldValue: 'C',
                newValue: 'C.alt',
                workerReplayTargets: []
            })
        ];
        const collaborationMessage =
            createCollaborationMessageEnvelopeFromChangeLogEntries(
                changeLogEntries,
                {
                    localSequence: 3,
                    source: 'cloud-adapter.test',
                    windowId: 'client-1'
                }
            );
        const bridge = {
            mergeImportedChangeLog: jest.fn(),
            mergeImportedCollaborationMessages: jest.fn(),
            applyFullState: jest.fn(),
            onLocalUpdate: (handler) => {
                localUpdateHandler = handler;
            },
            offLocalUpdate: jest.fn(),
            encodeStateDiff: jest.fn(() => new Uint8Array([9, 9, 9])),
            getNewChangeLogEntries: jest.fn(() => []),
            advanceBroadcastLogCursor: jest.fn(),
            windowId: 'client-1'
        };

        adapter._bridge = bridge;
        adapter._ws = {
            readyState: 1,
            send: (payload) => sentFrames.push(JSON.parse(payload))
        };
        adapter._clientId = 'client-1';

        adapter._registerOutboundHook();
        localUpdateHandler(localUpdate, collaborationMessage);
        await Promise.resolve();

        adapter._handleMessage(
            JSON.stringify({
                type: 'sync-response',
                update: Buffer.from([5, 6, 7]).toString('base64'),
                serverStateVector: Buffer.from([8, 9, 10]).toString('base64'),
                collaborationMessageHistory: []
            })
        );

        expect(bridge.mergeImportedChangeLog).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({
                    path: 'glyphs.C:name',
                    transactionLabel: 'Live edit'
                })
            ])
        );
        expect(sentFrames[sentFrames.length - 1]).toEqual(
            expect.objectContaining({
                type: 'sync-complete',
                collaborationMessages: [
                    expect.objectContaining({
                        transactionId: collaborationMessage.transactionId,
                        label: 'Live edit'
                    })
                ]
            })
        );
    });

    it('retires only the matching pending envelope identity during bootstrap reconciliation', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const durableEnvelope = createCollaborationMessageEnvelope({
            transactionId: '1',
            localSequence: 1,
            roomSequence: null,
            baseRevision: null,
            changes: [
                {
                    op: 'set',
                    path: 'glyphs.A:name'
                }
            ],
            metadata: {
                editType: 'font',
                changedGlyphNames: ['A'],
                changedLayerIds: [],
                workerReplayTargets: [],
                historyItemId: 'history-1',
                historyAction: 'change',
                undoScope: 'font'
            },
            source: 'cloud-adapter.test',
            label: 'Older durable envelope',
            summary: 'Older durable envelope',
            windowId: 'client-1',
            timestamp: 100
        });
        const pendingEnvelope = createCollaborationMessageEnvelope({
            transactionId: '1',
            localSequence: 2,
            roomSequence: null,
            baseRevision: null,
            changes: [
                {
                    op: 'set',
                    path: 'glyphs.B:name'
                }
            ],
            metadata: {
                editType: 'font',
                changedGlyphNames: ['B'],
                changedLayerIds: [],
                workerReplayTargets: [],
                historyItemId: 'history-2',
                historyAction: 'change',
                undoScope: 'font'
            },
            source: 'cloud-adapter.test',
            label: 'Pending envelope',
            summary: 'Pending envelope',
            windowId: 'client-1',
            timestamp: 200
        });
        adapter._pendingDurabilityMessages = [pendingEnvelope];
        adapter._bridge = {
            mergeImportedChangeLog: jest.fn(),
            mergeImportedCollaborationMessages: jest.fn(),
            mergeImportedCollaborationMessages: jest.fn(),
            applyFullState: jest.fn(),
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };
        adapter._registerOutboundHook = jest.fn();
        adapter._sendSyncComplete = jest.fn();

        adapter._handleMessage(
            JSON.stringify({
                type: 'sync-response',
                update: Buffer.from([1, 2, 3]).toString('base64'),
                serverStateVector: Buffer.from([4, 5, 6]).toString('base64'),
                collaborationMessageHistory: [durableEnvelope]
            })
        );

        expect(adapter._pendingDurabilityMessages).toEqual([pendingEnvelope]);
    });

    it('sends sync-complete metadata without repair side-band state', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const diff = new Uint8Array([5, 6, 7]);
        const sentFrames = [];
        const changeLogEntries = [
            createLogEntry({
                timestamp: 1,
                windowId: 'client-1',
                windowRoleLabel: 'main',
                transactionLabel: 'Rename',
                transactionId: 1,
                op: 'set',
                undoScope: 'glyph',
                path: 'glyphs.A:name',
                oldValue: 'A',
                newValue: 'A.alt',
                workerReplayTargets: []
            })
        ];
        const fullState = new Uint8Array([8, 9, 10]);

        adapter._bridge = {
            encodeStateDiff: jest.fn(() => diff),
            getNewChangeLogEntries: jest.fn(() => changeLogEntries),
            getFullState: jest.fn(() => fullState)
        };
        adapter._ws = {
            readyState: 1,
            send: (payload) => sentFrames.push(JSON.parse(payload))
        };

        adapter._sendSyncComplete(new Uint8Array([1, 2, 3]));

        expect(adapter._bridge.getFullState).not.toHaveBeenCalled();
        expect(sentFrames).toHaveLength(1);
        const expectedMessages =
            createCollaborationMessageEnvelopesFromChangeLogEntries(
                changeLogEntries,
                {
                    startingLocalSequence: 1,
                    source: 'cloud-adapter.sync-complete',
                    windowId: undefined
                }
            );
        expect(sentFrames[0].type).toBe('sync-complete');
        expect(sentFrames[0].collaborationMessages).toHaveLength(1);
        expect(sentFrames[0].collaborationMessages[0]).toEqual(
            expect.objectContaining({
                transactionId: expectedMessages[0].transactionId,
                label: expectedMessages[0].label,
                changes: expectedMessages[0].changes
            })
        );
        expect(sentFrames[0].fullState).toBeUndefined();
        expect(sentFrames[0].layerRepairSnapshots).toBeUndefined();
        expect(sentFrames[0].update).toBe(Buffer.from(diff).toString('base64'));
    });

    it('splits sync-complete metadata by logical history item', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const sentFrames = [];
        const changeLogEntries = [
            createLogEntry({
                timestamp: 1,
                windowId: 'client-1',
                windowRoleLabel: 'main',
                historyItemId: 'history-1',
                transactionLabel: 'Resize',
                transactionId: 1,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.A:layers.layer-1.width',
                oldValue: 600,
                newValue: 700,
                workerReplayTargets: []
            }),
            createLogEntry({
                timestamp: 2,
                windowId: 'client-1',
                windowRoleLabel: 'main',
                historyItemId: 'history-2',
                historyAction: 'undo',
                targetHistoryItemId: 'history-1',
                transactionLabel: 'Undo',
                transactionId: 2,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.A:layers.layer-1.width',
                oldValue: 700,
                newValue: 600,
                workerReplayTargets: []
            })
        ];

        adapter._bridge = {
            encodeStateDiff: jest.fn(() => new Uint8Array([5, 6, 7])),
            getNewChangeLogEntries: jest.fn(() => changeLogEntries),
            windowId: 'client-1'
        };
        adapter._ws = {
            readyState: 1,
            send: (payload) => sentFrames.push(JSON.parse(payload))
        };

        adapter._sendSyncComplete(new Uint8Array([1, 2, 3]));

        expect(sentFrames).toHaveLength(1);
        expect(sentFrames[0].collaborationMessages).toHaveLength(2);
        expect(sentFrames[0].collaborationMessages[0]).toEqual(
            expect.objectContaining({
                label: 'Resize'
            })
        );
        expect(sentFrames[0].collaborationMessages[1]).toEqual(
            expect.objectContaining({
                label: 'Undo',
                metadata: expect.objectContaining({
                    historyAction: 'undo',
                    targetHistoryItemId: 'history-1'
                })
            })
        );
    });
});

describe('CloudAdapter durability failures', () => {
    it('does not request a resync for noop remote updates', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const requestServerResyncAfterNoopUpdate = jest.spyOn(
            adapter,
            '_requestServerResyncAfterNoopUpdate'
        );

        adapter._bridge = {
            applyRemoteUpdate: jest.fn(),
            encodeBridgeState: jest
                .fn()
                .mockReturnValueOnce(new Uint8Array([1, 2, 3]))
                .mockReturnValueOnce(new Uint8Array([1, 2, 3]))
        };

        adapter._applyRemoteUpdate(new Uint8Array([9, 9, 9]));

        expect(requestServerResyncAfterNoopUpdate).not.toHaveBeenCalled();
    });

    it('resyncs noop remote updates with the current bridge state vector', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const sentFrames = [];
        const bridgeState = new Uint8Array([0]);

        adapter._bridge = {
            encodeBridgeStateVector: jest.fn(() => bridgeState)
        };
        adapter._ws = {
            readyState: 1,
            send: (payload) => sentFrames.push(JSON.parse(payload))
        };

        adapter._requestServerResyncAfterNoopUpdate();

        expect(sentFrames).toEqual([
            {
                type: 'sync-request',
                stateVector: Buffer.from(bridgeState).toString('base64')
            }
        ]);
    });

    it('marks the connection errored and closes on undurable ack', () => {
        const statuses = [];
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });
        const close = jest.fn();
        adapter._ws = {
            readyState: 1,
            close
        };

        adapter._handleMessage(
            JSON.stringify({ type: 'ack', seq: 4, durable: false })
        );

        expect(statuses).toContainEqual({
            status: 'error',
            detail: 'Cloud update seq 4 was not durable'
        });
        expect(close).toHaveBeenCalledWith(4000, 'undurable-update');
    });

    it('marks the connection errored and closes on undurable sync-complete error', () => {
        const statuses = [];
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });
        const close = jest.fn();
        adapter._ws = {
            readyState: 1,
            close
        };

        adapter._handleMessage(
            JSON.stringify({
                type: 'error',
                message: 'Sync update not durable'
            })
        );

        expect(statuses).toContainEqual({
            status: 'error',
            detail: 'Sync update not durable'
        });
        expect(close).toHaveBeenCalledWith(4000, 'server-error');
    });

    it('marks the connection errored and closes on generic room errors', () => {
        const statuses = [];
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });
        const close = jest.fn();
        adapter._ws = {
            readyState: 1,
            close
        };

        adapter._handleMessage(
            JSON.stringify({
                type: 'error',
                message: 'Sync upload exceeds byte limit'
            })
        );

        expect(statuses).toContainEqual({
            status: 'error',
            detail: 'Sync upload exceeds byte limit'
        });
        expect(close).toHaveBeenCalledWith(4000, 'server-error');
    });

    it('reconnects without surfacing an error when the room reports stale access', () => {
        const statuses = [];
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });
        const close = jest.fn();
        adapter._ws = {
            readyState: 1,
            close
        };

        adapter._handleMessage(
            JSON.stringify({
                type: 'error',
                message: 'Access epoch is stale'
            })
        );

        expect(statuses).toContainEqual({
            status: 'connecting',
            detail: 'Access epoch is stale'
        });
        expect(close).toHaveBeenCalledWith(4000, 'server-access-change');
    });

    it('reconnects when authentication stalls after the socket opens', async () => {
        jest.useFakeTimers();

        const statuses = [];
        const originalWebSocket = global.WebSocket;
        let socket;

        class FakeWebSocket {
            constructor(_url) {
                this.readyState = 1;
                this.send = jest.fn();
                this.close = jest.fn((code, reason) => {
                    this.readyState = 3;
                    this.onclose?.({ code, reason });
                });
                socket = this;
            }
        }

        global.WebSocket = FakeWebSocket;

        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });

        const scheduleReconnect = jest
            .spyOn(adapter, '_scheduleReconnect')
            .mockImplementation(() => {});

        try {
            await adapter.connectDirect(
                {
                    onLocalUpdate: jest.fn(),
                    offLocalUpdate: jest.fn()
                },
                'room-token',
                'wss://rooms.example.com/room/asset-123'
            );

            socket.onopen();
            jest.advanceTimersByTime(10000);

            expect(socket.send).toHaveBeenCalledWith(
                JSON.stringify({ type: 'auth', token: 'room-token' })
            );
            expect(statuses).toContainEqual({
                status: 'connecting',
                detail: 'Cloud room authentication timed out'
            });
            expect(socket.close).toHaveBeenCalledWith(4000, 'auth-timeout');
            expect(scheduleReconnect).toHaveBeenCalled();
        } finally {
            scheduleReconnect.mockRestore();
            adapter.disconnect();
            global.WebSocket = originalWebSocket;
            jest.useRealTimers();
        }
    });

    it('runs reconnect visible rebaseline before reporting connected', async () => {
        const statuses = [];
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });

        const originalFontManager = window.fontManager;
        const originalRefreshCanvas = window.syncRustCacheAndRefreshCanvas;
        const originalGlyphOverview = window.glyphOverviewInstance;
        const originalFontInfoManager = window.fontInfoManager;

        window.fontManager = {
            recompileEditingFont: jest.fn().mockResolvedValue(false)
        };
        window.syncRustCacheAndRefreshCanvas = jest.fn().mockResolvedValue();
        window.glyphOverviewInstance = {
            currentLocation: { wght: 400 },
            renderGlyphOutlines: jest.fn().mockResolvedValue(),
            syncActiveGlyphFocus: jest.fn()
        };
        window.fontInfoManager = {
            refreshVisibleContentForExternalSync: jest.fn()
        };

        adapter._hasSynced = true;
        adapter._initialServerStateApplied = true;
        adapter._initialSyncDurable = true;
        adapter._needsVisibleRebaseline = true;

        try {
            await adapter._maybeMarkInitialSyncConnected();

            expect(statuses).toEqual([
                {
                    status: 'syncing',
                    detail: 'Rebuilding visible state after reconnect'
                },
                {
                    status: 'connected',
                    detail: undefined
                }
            ]);
            expect(window.fontManager.recompileEditingFont).toHaveBeenCalled();
            expect(window.syncRustCacheAndRefreshCanvas).toHaveBeenCalledWith(
                undefined,
                undefined,
                {
                    allowSelectedLayerFallback: true
                }
            );
            expect(
                window.glyphOverviewInstance.renderGlyphOutlines
            ).toHaveBeenCalledWith({ wght: 400 });
            expect(
                window.glyphOverviewInstance.syncActiveGlyphFocus
            ).toHaveBeenCalled();
            expect(
                window.fontInfoManager.refreshVisibleContentForExternalSync
            ).toHaveBeenCalled();
            expect(adapter._needsVisibleRebaseline).toBe(false);
        } finally {
            window.fontManager = originalFontManager;
            window.syncRustCacheAndRefreshCanvas = originalRefreshCanvas;
            window.glyphOverviewInstance = originalGlyphOverview;
            window.fontInfoManager = originalFontInfoManager;
        }
    });

    it('forces a reconnect when the room revokes write access', () => {
        const statuses = [];
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });
        const close = jest.fn();
        adapter._ws = {
            readyState: 1,
            close
        };

        adapter._handleMessage(
            JSON.stringify({
                type: 'error',
                message: 'Write access requires owner or editor role'
            })
        );

        expect(statuses).toContainEqual({
            status: 'error',
            detail: 'Write access requires owner or editor role'
        });
        expect(close).toHaveBeenCalledWith(4000, 'server-access-change');
    });
});
