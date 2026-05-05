/**
 * CloudPlugin — FilesystemPlugin wrapper for CloudAdapter.
 *
 * Phase 0: exposes `connectToRoom(assetId)` for dev testing.
 * No file browser UI — testing is done via window.cloudDebug.
 */

import { FilesystemPlugin } from './filesystem-plugins';
import { CloudAdapter, CloudAdapterOptions, CloudConnectionStatus } from './cloud-adapter';
import { Logger } from './logger';

const console = new Logger('CloudPlugin');

export class CloudPlugin extends FilesystemPlugin {
    private _cloudAdapter: CloudAdapter;

    constructor(options: Omit<CloudAdapterOptions, 'assetId'> & { assetId?: string } = {}) {
        const assetId = options.assetId ?? '__none__';
        const adapter = new CloudAdapter({
            ...options,
            assetId,
            onConnectionStatus: (status: CloudConnectionStatus, detail?: string) => {
                console.log(`Connection status: ${status}${detail ? ` (${detail})` : ''}`);
            }
        });
        super(adapter);
        this._cloudAdapter = adapter;
    }

    getId(): string {
        return 'cloud';
    }

    getName(): string {
        return 'Cloud';
    }

    getIcon(): string {
        return 'cloud';
    }

    canSave(): boolean {
        return false; // Phase 0: saving not supported
    }

    supportsUpload(): boolean {
        return false;
    }

    requiresPermission(): boolean {
        return true; // Requires authentication
    }

    async isReady(): Promise<boolean> {
        return (
            this._cloudAdapter.status === 'connected' ||
            this._cloudAdapter.status === 'syncing'
        );
    }

    /**
     * Connect to a room for the given asset.
     *
     * @param assetId The asset/room identifier.
     */
    async connectToRoom(assetId: string): Promise<void> {
        const bridge = window.changeBridge;
        if (!bridge) {
            console.error('No changeBridge available — load a font first');
            return;
        }

        // Disconnect any existing adapter
        this._cloudAdapter.disconnect();

        // Create a new adapter for the new assetId
        this._cloudAdapter = new CloudAdapter({
            assetId,
            onConnectionStatus: (status: CloudConnectionStatus, detail?: string) => {
                console.log(`[${assetId}] Status: ${status}${detail ? ` (${detail})` : ''}`);
                window.dispatchEvent(
                    new CustomEvent('cloudConnectionStatusChanged', {
                        detail: { assetId, status, detail }
                    })
                );
            }
        });

        console.log(`Connecting to room: ${assetId}`);
        await this._cloudAdapter.connect(bridge);
    }

    /**
     * Dev-only: Connect directly using a pre-built token and room WebSocket URL,
     * bypassing the website auth endpoint. Useful for Phase 0 testing.
     *
     * @param assetId  The room / asset identifier.
     * @param token    Pre-built base64-JSON room token.
     * @param roomUrl  WebSocket URL, e.g. `ws://localhost:8787/room/test-001`.
     */
    async connectToRoomWithToken(
        assetId: string,
        token: string,
        roomUrl: string
    ): Promise<void> {
        const bridge = window.changeBridge;
        if (!bridge) {
            console.error('No changeBridge available — load a font first');
            return;
        }

        this._cloudAdapter.disconnect();

        this._cloudAdapter = new CloudAdapter({
            assetId,
            onConnectionStatus: (status: CloudConnectionStatus, detail?: string) => {
                console.log(`[${assetId}] Status: ${status}${detail ? ` (${detail})` : ''}`);
                window.dispatchEvent(
                    new CustomEvent('cloudConnectionStatusChanged', {
                        detail: { assetId, status, detail }
                    })
                );
            }
        });

        console.log(`Connecting directly to room: ${assetId} at ${roomUrl}`);
        await this._cloudAdapter.connectDirect(bridge, token, roomUrl);
    }

    /** Disconnect from the current room. */
    disconnectFromRoom(): void {
        this._cloudAdapter.disconnect();
    }

    get connectionStatus(): CloudConnectionStatus {
        return this._cloudAdapter.status;
    }
}
