/**
 * CloudAdapter — WebSocket-based adapter that syncs a local ChangeBridge
 * with a remote FontRoomDO Durable Object.
 *
 * Protocol (all frames are JSON):
 *
 * Client → Server:
 *   { type: 'auth',         token: string }
 *   { type: 'sync-request' }
 *   { type: 'update',       update: number[], clientId: string, seq: number }
 *
 * Server → Client:
 *   { type: 'auth-ok',      clientId: string }
 *   { type: 'auth-error',   message: string }
 *   { type: 'sync-response', state: number[], roomVersion: number }
 *   { type: 'update',       update: number[], clientId: string, seq: number }
 *   { type: 'ack',          seq: number, durable: boolean }
 *   { type: 'error',        message: string }
 */

import type { ChangeBridge } from './change-bridge';
import type { FileSystemAdapter, FileInfo } from './file-system-adapter';
import { Logger } from './logger';

const console = new Logger('CloudAdapter');

/** Websocket URL of the cloud worker, resolved from CLOUD_ROOM_WORKER_URL. */
const DEFAULT_ROOM_WORKER_URL = 'ws://localhost:8787';

/** Website base URL for the room-token endpoint. */
const DEFAULT_WEBSITE_BASE_URL = 'http://localhost:8788';

export type CloudConnectionStatus =
    | 'disconnected'
    | 'connecting'
    | 'authenticating'
    | 'syncing'
    | 'connected'
    | 'error';

export type CloudAdapterOptions = {
    assetId: string;
    websiteBaseUrl?: string;
    roomWorkerBaseUrl?: string;
    onConnectionStatus?: (status: CloudConnectionStatus, detail?: string) => void;
};

/**
 * CloudAdapter connects a local ChangeBridge to a remote FontRoomDO.
 *
 * It implements the FileSystemAdapter interface so it can be wrapped in a
 * FilesystemPlugin. File I/O methods (scanDirectory, readFile, etc.) are stubs
 * for Phase 0; they will be fleshed out in Phase 1 when cloud file persistence
 * is added.
 */
export class CloudAdapter implements FileSystemAdapter {
    private _assetId: string;
    private _websiteBaseUrl: string;
    private _roomWorkerBaseUrl: string;
    private _onConnectionStatus: ((status: CloudConnectionStatus, detail?: string) => void) | null;

    private _bridge: ChangeBridge | null = null;
    private _ws: WebSocket | null = null;
    private _clientId: string | null = null;
    private _seq = 0;
    private _status: CloudConnectionStatus = 'disconnected';
    private _localUpdateUnsubscribe: (() => void) | null = null;
    private _destroyed = false;
    private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private _hasSynced = false;

    constructor(options: CloudAdapterOptions) {
        this._assetId = options.assetId;
        this._websiteBaseUrl = options.websiteBaseUrl ?? DEFAULT_WEBSITE_BASE_URL;
        this._roomWorkerBaseUrl = options.roomWorkerBaseUrl ?? DEFAULT_ROOM_WORKER_URL;
        this._onConnectionStatus = options.onConnectionStatus ?? null;
    }

    get status(): CloudConnectionStatus {
        return this._status;
    }

    get assetId(): string {
        return this._assetId;
    }

    // ── Public API ───────────────────────────────────────────────

    /**
     * Connect this adapter to a ChangeBridge instance and start syncing.
     *
     * @param bridge The local ChangeBridge to sync with the room.
     */
    async connect(bridge: ChangeBridge): Promise<void> {
        if (this._destroyed) {
            console.warn('CloudAdapter: already destroyed');
            return;
        }
        this._bridge = bridge;
        this._setStatus('connecting');
        await this._connectWebSocket();
    }

    /**
     * Dev-only: Connect directly using a pre-built token and room URL, bypassing
     * the website auth endpoint. Useful for Phase 0 testing without a session.
     *
     * @param bridge The local ChangeBridge to sync with the room.
     * @param token  A pre-built room token (base64 JSON).
     * @param roomUrl The WebSocket URL of the room (e.g. ws://localhost:8787/room/xyz).
     */
    async connectDirect(bridge: ChangeBridge, token: string, roomUrl: string): Promise<void> {
        if (this._destroyed) {
            console.warn('CloudAdapter: already destroyed');
            return;
        }
        this._bridge = bridge;
        this._setStatus('connecting');
        await this._openWebSocket(token, roomUrl);
    }

    /** Disconnect and clean up. */
    disconnect(): void {
        const disconnectLog = (window as any).__cloudDisconnectLog ?? [];
        disconnectLog.push({ ts: Date.now(), hasUnsub: !!this._localUpdateUnsubscribe, destroyed: this._destroyed, stack: new Error().stack?.split('\n').slice(1, 5).join('|') });
        (window as any).__cloudDisconnectLog = disconnectLog;
        this._destroyed = true;
        this._clearReconnectTimer();
        this._localUpdateUnsubscribe?.();
        this._localUpdateUnsubscribe = null;
        this._ws?.close(1000, 'disconnect');
        this._ws = null;
        this._bridge = null;
        this._setStatus('disconnected');
    }

    // ── Internal — WebSocket lifecycle ───────────────────────────

    private async _connectWebSocket(): Promise<void> {
        if (this._destroyed) return;

        try {
            const { token, roomUrl } = await this._fetchRoomToken();
            const wsUrl = roomUrl.replace(/^http/, 'ws');
            await this._openWebSocket(token, wsUrl);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('CloudAdapter: connection failed:', msg);
            this._setStatus('error', msg);
            if (!this._destroyed) {
                this._scheduleReconnect();
            }
        }
    }

    private async _openWebSocket(token: string, wsUrl: string): Promise<void> {
        if (this._destroyed) return;

        try {

            console.log(`Connecting to room ${this._assetId} at ${wsUrl}`);
            const ws = new WebSocket(wsUrl);
            this._ws = ws;

            ws.binaryType = 'arraybuffer';

            ws.onopen = () => {
                if (this._ws !== ws) return;
                this._setStatus('authenticating');
                ws.send(JSON.stringify({ type: 'auth', token }));
            };

            ws.onmessage = (event: MessageEvent) => {
                if (this._ws !== ws) {
                    console.error(`[CloudAdapter] onmessage: ws mismatch, discarding`);
                    return;
                }
                this._handleMessage(event.data as string);
            };

            ws.onerror = () => {
                if (this._ws !== ws) return;
                console.warn('CloudAdapter: WebSocket error');
                this._setStatus('error', 'WebSocket error');
            };

            ws.onclose = (event: CloseEvent) => {
                if (this._ws !== ws) return;
                console.log(`CloudAdapter: closed (${event.code}: ${event.reason})`);
                if (event.code === 4001) {
                    this._setStatus('error', 'Authentication failed');
                    return; // Don't reconnect on auth failures
                }
                if (!this._destroyed) {
                    this._setStatus('connecting');
                    this._scheduleReconnect();
                } else {
                    this._setStatus('disconnected');
                }
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('CloudAdapter: _openWebSocket failed:', msg);
            this._setStatus('error', msg);
            if (!this._destroyed) {
                this._scheduleReconnect();
            }
        }
    }

    private _handleMessage(raw: string): void {
        (window as any).__cloudMsgCount = ((window as any).__cloudMsgCount ?? 0) + 1;
        window.console.error(`[_handleMessage] len=${raw.length} first10=${raw.slice(0, 10)}`);
        let msg: Record<string, unknown>;
        try {
            msg = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            console.warn('CloudAdapter: bad JSON from server');
            return;
        }
        (window as any).__cloudLastMsgType = String(msg.type);
        window.console.error(`[_handleMessage] type=${String(msg.type)}`);

        switch (msg.type) {
            case 'auth-ok':
                this._clientId = String(msg.clientId ?? '');
                console.log(`CloudAdapter: authenticated as ${this._clientId}`);
                this._setStatus('syncing');
                // Request full state if we haven't synced yet
                if (!this._hasSynced) {
                    this._ws?.send(JSON.stringify({ type: 'sync-request' }));
                }
                break;

            case 'auth-error':
                console.error(`CloudAdapter: auth error: ${msg.message}`);
                this._setStatus('error', String(msg.message ?? 'auth-error'));
                break;

            case 'sync-response':
                this._applyFullState(msg.state);
                this._hasSynced = true;
                this._setStatus('connected');
                // Register the outbound update hook for future incremental updates
                this._registerOutboundHook();
                // Send our full local state to the server so it can distribute
                // to other peers. Without this, peers would receive incremental
                // updates starting at a high clock offset and Yjs would defer
                // them due to missing prior state.
                this._sendFullStateToDO();
                break;

            case 'update':
                console.error(`[CloudAdapter] RECV update from ${String(msg.clientId)}, hasBridge: ${!!this._bridge}, wsMatch: ${this._ws === this._ws}`);
                this._applyRemoteUpdate(msg.update);
                break;

            case 'ack':
                // Nothing to do — we fire-and-forget for Phase 0
                break;

            case 'error':
                console.warn(`CloudAdapter: server error: ${msg.message}`);
                break;

            default:
                console.warn(`CloudAdapter: unknown message type: ${msg.type}`);
        }
    }

    // ── Internal — Yjs integration ───────────────────────────────

    private _applyFullState(state: unknown): void {
        if (!this._bridge) return;
        if (!Array.isArray(state)) {
            console.error('CloudAdapter: sync-response state is not an array');
            return;
        }
        try {
            const update = new Uint8Array(state as number[]);
            this._bridge.applyFullState(update);
            console.log('CloudAdapter: applied full state from room');
        } catch (err) {
            console.error('CloudAdapter: failed to apply full state:', err);
        }
    }

    private _applyRemoteUpdate(update: unknown): void {
        if (!this._bridge) {
            console.error('[CloudAdapter] _applyRemoteUpdate: _bridge is null, skipping');
            return;
        }
        if (!Array.isArray(update)) {
            console.warn('CloudAdapter: received non-array update');
            return;
        }
        try {
            const u8 = new Uint8Array(update as number[]);
            console.error(`[CloudAdapter] calling bridge.applyRemoteUpdate, bytes: ${u8.length}`);
            this._bridge.applyRemoteUpdate(u8);
            console.error(`[CloudAdapter] bridge.applyRemoteUpdate done`);
        } catch (err) {
            console.error('CloudAdapter: failed to apply remote update:', err);
        }
    }

    private _registerOutboundHook(): void {
        const debugLog = (window as any).__cloudRegisterLog ?? [];
        const sizeBefore = (this._bridge as any)?._localUpdateListeners?.size ?? -1;
        debugLog.push({ hasBridge: !!this._bridge, hasUnsub: !!this._localUpdateUnsubscribe, destroyed: this._destroyed, ts: Date.now(), sizeBefore });
        (window as any).__cloudRegisterLog = debugLog;
        if (!this._bridge || this._localUpdateUnsubscribe) return;

        const sendUpdate = (update: Uint8Array): void => {
            console.error(`[sendUpdate] called: destroyed=${this._destroyed} ws=${this._ws?.readyState} OPEN=${WebSocket.OPEN}`);
            if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
                console.error(`[sendUpdate] early return: ws=${this._ws ? 'exists' : 'null'} readyState=${this._ws?.readyState}`);
                return;
            }
            const seq = ++this._seq;
            this._ws.send(JSON.stringify({
                type: 'update',
                update: Array.from(update),
                clientId: this._clientId ?? '',
                seq
            }));
            console.error(`[sendUpdate] sent seq=${seq} bytes=${update.length}`);
        };

        // Expose sendUpdate for debugging
        (window as any).__cloudSendUpdate = sendUpdate;
        this._bridge.onLocalUpdate(sendUpdate);
        const sizeAfter = (this._bridge as any)?._localUpdateListeners?.size ?? -1;
        debugLog[debugLog.length - 1].sizeAfter = sizeAfter;
        (window as any).__cloudRegisterLog = debugLog;

        this._localUpdateUnsubscribe = () => {
            this._bridge?.offLocalUpdate(sendUpdate);
        };
    }

    /**
     * Send the client's full Y.Doc state to the DO as an update.
     *
     * This is needed because incremental updates from this client start at a
     * high Yjs clock offset (after all the local initFromJson operations). Other
     * peers joining later would see those high-clock updates and Yjs would defer
     * them, waiting for the missing history. By sending the full state once on
     * connect, we ensure the DO accumulates a complete picture that it can relay
     * to any peer that requests it via sync-request.
     */
    private _sendFullStateToDO(): void {
        if (!this._bridge || !this._ws || this._ws.readyState !== WebSocket.OPEN) return;
        try {
            const fullState = this._bridge.encodeBridgeState();
            const seq = ++this._seq;
            this._ws.send(JSON.stringify({
                type: 'update',
                update: Array.from(fullState),
                clientId: this._clientId ?? '',
                seq
            }));
            console.log(`CloudAdapter: sent full state to DO (${fullState.length} bytes)`);
        } catch (err) {
            console.warn('CloudAdapter: failed to send full state to DO:', err);
        }
    }

    // ── Internal — Room token fetch ──────────────────────────────

    private async _fetchRoomToken(): Promise<{ token: string; roomUrl: string }> {
        const url = `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(this._assetId)}/room-token`;
        const resp = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            throw new Error(`room-token request failed: ${resp.status} ${body}`);
        }

        const data = (await resp.json()) as { token: string; roomUrl: string };
        if (!data.token || !data.roomUrl) {
            throw new Error('room-token response missing token or roomUrl');
        }
        return data;
    }

    // ── Internal — helpers ───────────────────────────────────────

    private _setStatus(status: CloudConnectionStatus, detail?: string): void {
        this._status = status;
        this._onConnectionStatus?.(status, detail);
    }

    private _scheduleReconnect(): void {
        this._clearReconnectTimer();
        this._reconnectTimer = setTimeout(() => {
            if (!this._destroyed) {
                console.log('CloudAdapter: reconnecting...');
                this._connectWebSocket().catch(() => {});
            }
        }, 3000);
    }

    private _clearReconnectTimer(): void {
        if (this._reconnectTimer !== null) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    // ── FileSystemAdapter stubs ──────────────────────────────────
    // These are required by the interface but not used in Phase 0.

    async scanDirectory(_path: string): Promise<Record<string, FileInfo>> {
        throw new Error('CloudAdapter.scanDirectory not implemented in Phase 0');
    }

    async readFile(_path: string): Promise<string | Uint8Array> {
        throw new Error('CloudAdapter.readFile not implemented in Phase 0');
    }

    async writeFile(_path: string, _content: string | Uint8Array): Promise<void> {
        throw new Error('CloudAdapter.writeFile not implemented in Phase 0');
    }

    async createFolder(_path: string): Promise<void> {
        throw new Error('CloudAdapter.createFolder not implemented in Phase 0');
    }

    async deleteItem(_path: string, _isDir: boolean): Promise<void> {
        throw new Error('CloudAdapter.deleteItem not implemented in Phase 0');
    }

    async renameItem(_oldPath: string, _newName: string, _isDir: boolean): Promise<void> {
        throw new Error('CloudAdapter.renameItem not implemented in Phase 0');
    }

    async fileExists(_path: string): Promise<boolean> {
        return false;
    }
}
