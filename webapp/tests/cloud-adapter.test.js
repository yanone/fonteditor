const { normalizeCloudRoomWebSocketUrl } = require('../js/cloud-adapter.ts');

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
