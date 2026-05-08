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
        adapter._bridge = {
            onLocalUpdate: (handler) => {
                localUpdateHandler = handler;
            },
            offLocalUpdate: jest.fn(),
            getFullState
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
            changeLogEntries
        });
        expect(sentFrames[0].fullState).toBeUndefined();
        expect(sentFrames[0].layerRepairSnapshots).toBeUndefined();
        expect(sentFrames[0].update).toBe(
            Buffer.from(localUpdate).toString('base64')
        );
    });

    it('sends sync-complete metadata without repair side-band state', () => {
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
        expect(sentFrames[0]).toMatchObject({
            type: 'sync-complete',
            changeLogEntries
        });
        expect(sentFrames[0].fullState).toBeUndefined();
        expect(sentFrames[0].layerRepairSnapshots).toBeUndefined();
        expect(sentFrames[0].update).toBe(Buffer.from(diff).toString('base64'));
    });
});

describe('CloudAdapter durability failures', () => {
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
});
