const {
    CloudAdapter,
    normalizeCloudRoomWebSocketUrl
} = require('../js/cloud-adapter.ts');

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
    it('sends incremental updates without re-encoding full state', async () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const localUpdate = new Uint8Array([1, 2, 3, 4]);
        const sentFrames = [];
        let localUpdateHandler = null;
        const getFullState = jest.fn(() => new Uint8Array([9, 9, 9]));
        const changeLogEntries = [
            {
                undoScope: 'layer',
                path: 'glyphs.A.layers.L0'
            }
        ];
        const layerRepairSnapshots = [
            {
                glyphName: 'A',
                layers: [
                    {
                        layerId: 'L0',
                        layerSnapshot: { id: 'L0' }
                    }
                ]
            }
        ];

        adapter._bridge = {
            onLocalUpdate: (handler) => {
                localUpdateHandler = handler;
            },
            offLocalUpdate: jest.fn(),
            getFullState,
            getLayerRepairSnapshots: jest.fn(() => layerRepairSnapshots)
        };
        adapter._ws = {
            readyState: 1,
            send: (payload) => sentFrames.push(JSON.parse(payload))
        };
        adapter._clientId = 'client-1';

        adapter._registerOutboundHook();
        localUpdateHandler(localUpdate, changeLogEntries);
        await Promise.resolve();

        expect(getFullState).not.toHaveBeenCalled();
        expect(sentFrames).toHaveLength(1);
        expect(sentFrames[0]).toMatchObject({
            type: 'update',
            clientId: 'client-1',
            seq: 1,
            changeLogEntries,
            layerRepairSnapshots
        });
        expect(sentFrames[0].update).toBe(
            Buffer.from(localUpdate).toString('base64')
        );
    });

    it('carries metadata on sync-complete for structural repair state', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const diff = new Uint8Array([5, 6, 7]);
        const sentFrames = [];
        const changeLogEntries = [
            {
                undoScope: 'glyph',
                path: 'glyphs.A'
            }
        ];
        const fullState = new Uint8Array([8, 9, 10]);
        const layerRepairSnapshots = [
            {
                glyphName: 'A',
                layers: [
                    {
                        layerId: 'L0',
                        layerSnapshot: { id: 'L0', shapes: [] }
                    }
                ]
            }
        ];

        adapter._bridge = {
            encodeStateDiff: jest.fn(() => diff),
            getNewChangeLogEntries: jest.fn(() => changeLogEntries),
            getFullState: jest.fn(() => fullState),
            getLayerRepairSnapshots: jest.fn(() => layerRepairSnapshots)
        };
        adapter._ws = {
            readyState: 1,
            send: (payload) => sentFrames.push(JSON.parse(payload))
        };

        adapter._sendSyncComplete(new Uint8Array([1, 2, 3]));

        expect(sentFrames).toHaveLength(1);
        expect(sentFrames[0]).toMatchObject({
            type: 'sync-complete',
            changeLogEntries,
            fullState: Buffer.from(fullState).toString('base64'),
            layerRepairSnapshots
        });
        expect(sentFrames[0].update).toBe(Buffer.from(diff).toString('base64'));
    });
});
