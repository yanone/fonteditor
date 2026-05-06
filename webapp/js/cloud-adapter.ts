/**
 * CloudAdapter — WebSocket-based adapter that syncs a local ChangeBridge
 * with a remote FontRoomDO Durable Object.
 *
 * Sync protocol (all frames are JSON, binary data as base64 strings):
 *
 * Client → Server:
 *   { type: 'auth',          token: string }
 *   { type: 'sync-request',  stateVector: string }   ← base64(Y.encodeStateVector)
 *   { type: 'sync-complete', update: string [, chunkIndex, totalChunks] }   ← base64(diff for server, last or only chunk)
 *   { type: 'sync-chunk',    update: string, chunkIndex, totalChunks }       ← preceding chunk(s) for large diff
 *   { type: 'update',        update: string, clientId: string, seq: number }
 *
 * Server → Client:
 *   { type: 'auth-ok',       clientId: string }
 *   { type: 'auth-error',    message: string }
 *   { type: 'sync-response', update?: string, serverStateVector: string [, chunked: true, totalChunks] }
 *   { type: 'sync-chunk',    update: string, chunkIndex, totalChunks, direction: 'response' }
 *   { type: 'update',        update: string, fullState?: string, clientId: string, seq: number }
 *   { type: 'ack',           seq: number, durable: boolean }
 *   { type: 'error',         message: string }
 *
 * The state-vector exchange (sync-request / sync-response / sync-complete)
 * follows the standard y-websocket two-phase sync protocol so that each side
 * only transmits what the other is missing, keeping initial payloads minimal.
 * Live room updates currently send the bridge's authoritative full state to
 * guarantee convergence after cloud-open bridge replacement.
 */

import type { ChangeBridge } from './change-bridge';
import type { FileSystemAdapter, FileInfo } from './file-system-adapter';
import { Logger } from './logger';

const console = new Logger('CloudAdapter');

/** Default WebSocket URL for the room worker (local dev). */
const DEFAULT_ROOM_WORKER_URL = 'ws://localhost:8787';

/** Default website base URL for the room-token endpoint (local dev). */
const DEFAULT_WEBSITE_BASE_URL = 'http://localhost:8788';

type CloudDeleteResponse = {
    success?: boolean;
    error?: string;
};

function getCloudRequestHeaders(
    extraHeaders: Record<string, string> = {}
): Record<string, string> {
    const headers = { ...extraHeaders };
    const sessionToken = window.authManager?.getSessionToken?.();
    if (sessionToken) {
        headers.Authorization = `Bearer ${sessionToken}`;
    }
    return headers;
}

export function normalizeCloudRoomWebSocketUrl(
    roomUrl: string,
    websiteBaseUrl: string
): string {
    const trimmedRoomUrl = roomUrl.trim();
    if (!trimmedRoomUrl) {
        throw new Error('room-token response returned an empty roomUrl');
    }

    let normalizedUrl: URL;

    try {
        if (/^wss?:\/\//i.test(trimmedRoomUrl)) {
            normalizedUrl = new URL(trimmedRoomUrl);
        } else if (/^https?:\/\//i.test(trimmedRoomUrl)) {
            normalizedUrl = new URL(trimmedRoomUrl);
        } else if (trimmedRoomUrl.startsWith('/')) {
            normalizedUrl = new URL(trimmedRoomUrl, websiteBaseUrl);
        } else {
            normalizedUrl = new URL(`https://${trimmedRoomUrl}`);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid room URL "${roomUrl}": ${message}`);
    }

    if (normalizedUrl.protocol === 'http:') {
        normalizedUrl.protocol = 'ws:';
    } else if (normalizedUrl.protocol === 'https:') {
        normalizedUrl.protocol = 'wss:';
    }

    if (!/^wss?:$/i.test(normalizedUrl.protocol)) {
        throw new Error(
            `Invalid room URL protocol for "${roomUrl}": ${normalizedUrl.protocol}`
        );
    }

    return normalizedUrl.toString();
}

async function parseRequiredJsonResponse<T>(
    response: Response,
    errorPrefix: string
): Promise<T> {
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('application/json')) {
        const body = await response.text().catch(() => '');
        const bodyPreview = body.trim().slice(0, 160);
        throw new Error(
            `${errorPrefix}: expected JSON response but received ${contentType || 'unknown content type'}${bodyPreview ? ` (${bodyPreview})` : ''}`
        );
    }

    return (await response.json()) as T;
}

/**
 * Maximum bytes per WebSocket message (Cloudflare Workers limit: 1 MB).
 * We target 750 KB per chunk to leave headroom for JSON framing.
 */
const SYNC_CHUNK_SIZE = 750_000;

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
    onConnectionStatus?: (
        status: CloudConnectionStatus,
        detail?: string
    ) => void;
};

// ── Binary ↔ base64 helpers ──────────────────────────────────────────────────

function u8ToBase64(u8: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < u8.length; i++) {
        binary += String.fromCharCode(u8[i]);
    }
    return btoa(binary);
}

function base64ToU8(b64: string): Uint8Array {
    const binary = atob(b64);
    const u8 = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        u8[i] = binary.charCodeAt(i);
    }
    return u8;
}

// ── CloudAdapter ─────────────────────────────────────────────────────────────

/**
 * CloudAdapter connects a local ChangeBridge to a remote FontRoomDO.
 *
 * Implements the FileSystemAdapter interface so it can be wrapped in a
 * FilesystemPlugin. File I/O methods are stubs for Phase 0.
 */
export class CloudAdapter implements FileSystemAdapter {
    private _assetId: string;
    private _websiteBaseUrl: string;
    private _roomWorkerBaseUrl: string;
    private _onConnectionStatus:
        | ((status: CloudConnectionStatus, detail?: string) => void)
        | null;

    private _bridge: ChangeBridge | null = null;
    private _ws: WebSocket | null = null;
    private _clientId: string | null = null;
    private _seq = 0;
    private _status: CloudConnectionStatus = 'disconnected';
    private _localUpdateUnsubscribe: (() => void) | null = null;
    /** Bound `fontModelReady` listener — kept so we can remove it on disconnect. */
    private _fontModelReadyHandler: ((e: Event) => void) | null = null;
    private _destroyed = false;
    private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private _hasSynced = false;
    /** Accumulates incoming sync-response chunks from the server. */
    private _incomingResponseChunks: {
        chunks: (Uint8Array | undefined)[];
        received: number;
        total: number;
    } | null = null;

    constructor(options: CloudAdapterOptions) {
        this._assetId = options.assetId;
        this._websiteBaseUrl =
            options.websiteBaseUrl ?? DEFAULT_WEBSITE_BASE_URL;
        this._roomWorkerBaseUrl =
            options.roomWorkerBaseUrl ?? DEFAULT_ROOM_WORKER_URL;
        this._onConnectionStatus = options.onConnectionStatus ?? null;
    }

    get status(): CloudConnectionStatus {
        return this._status;
    }

    get assetId(): string {
        return this._assetId;
    }

    // ── Public API ───────────────────────────────────────────────

    async connect(bridge: ChangeBridge): Promise<void> {
        if (this._destroyed) {
            console.warn('CloudAdapter: already destroyed');
            return;
        }
        this._bridge = bridge;
        this._subscribeFontModelReady();
        this._setStatus('connecting');
        await this._connectWebSocket();
    }

    /**
     * Dev-only: Connect using a pre-built token and room URL, bypassing the
     * website auth endpoint. Used for Phase 0 testing via `window.cloudDebug`.
     */
    async connectDirect(
        bridge: ChangeBridge,
        token: string,
        roomUrl: string
    ): Promise<void> {
        if (this._destroyed) {
            console.warn('CloudAdapter: already destroyed');
            return;
        }
        this._bridge = bridge;
        this._subscribeFontModelReady();
        this._setStatus('connecting');
        await this._openWebSocket(token, roomUrl);
    }

    disconnect(): void {
        this._destroyed = true;
        this._clearReconnectTimer();
        this._unsubscribeFontModelReady();
        this._localUpdateUnsubscribe?.();
        this._localUpdateUnsubscribe = null;
        this._ws?.close(1000, 'disconnect');
        this._ws = null;
        this._bridge = null;
        this._setStatus('disconnected');
    }

    // ── Bridge tracking ──────────────────────────────────────────

    /**
     * Subscribe to `fontModelReady` so the adapter stays bound to the current
     * bridge even if `initializeBridge()` replaces `window.changeBridge` (e.g.
     * after a compilation-triggered model rebuild).
     */
    private _subscribeFontModelReady(): void {
        if (this._fontModelReadyHandler) return;
        this._fontModelReadyHandler = () => {
            this.rebindToCurrentBridge();
        };
        window.addEventListener('fontModelReady', this._fontModelReadyHandler);
    }

    /**
     * Rebind the adapter to the current global ChangeBridge after font load.
     * Returns true when a new bridge was adopted.
     */
    rebindToCurrentBridge(): boolean {
        const newBridge = window.changeBridge ?? null;
        if (!newBridge || newBridge === this._bridge) {
            return false;
        }

        // Bridge was replaced by initializeBridge() — re-seed the new bridge's
        // Y.Doc with the accumulated CRDT state from the old bridge so future
        // incremental updates from remote peers can resolve correctly.
        const oldState = this._bridge?.encodeBridgeState();
        if (oldState && oldState.length > 0) {
            newBridge.applyYDocUpdateSilent(oldState);
        }

        this._localUpdateUnsubscribe?.();
        this._localUpdateUnsubscribe = null;
        this._bridge = newBridge;
        if (this._hasSynced) {
            this._registerOutboundHook();
        }
        return true;
    }

    private _unsubscribeFontModelReady(): void {
        if (this._fontModelReadyHandler) {
            window.removeEventListener(
                'fontModelReady',
                this._fontModelReadyHandler
            );
            this._fontModelReadyHandler = null;
        }
    }

    // ── WebSocket lifecycle ───────────────────────────────────────

    private async _connectWebSocket(): Promise<void> {
        if (this._destroyed) return;
        try {
            const { token, roomUrl } = await this._fetchRoomToken();
            await this._openWebSocket(
                token,
                normalizeCloudRoomWebSocketUrl(roomUrl, this._websiteBaseUrl)
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('CloudAdapter: connection failed:', msg);
            this._setStatus('error', msg);
            if (!this._destroyed) this._scheduleReconnect();
        }
    }

    private async _openWebSocket(token: string, wsUrl: string): Promise<void> {
        if (this._destroyed) return;
        try {
            const normalizedWsUrl = normalizeCloudRoomWebSocketUrl(
                wsUrl,
                this._websiteBaseUrl
            );
            console.log(
                `Connecting to room ${this._assetId} at ${normalizedWsUrl}`
            );
            const ws = new WebSocket(normalizedWsUrl);
            this._ws = ws;
            ws.binaryType = 'arraybuffer';

            ws.onopen = () => {
                if (this._ws !== ws) return;
                this._setStatus('authenticating');
                ws.send(JSON.stringify({ type: 'auth', token }));
            };

            ws.onmessage = (event: MessageEvent) => {
                if (this._ws !== ws) return;
                this._handleMessage(event.data as string);
            };

            ws.onerror = () => {
                if (this._ws !== ws) return;
                console.warn('CloudAdapter: WebSocket error');
                this._setStatus(
                    'error',
                    `WebSocket error (${normalizedWsUrl})`
                );
            };

            ws.onclose = (event: CloseEvent) => {
                if (this._ws !== ws) return;
                console.log(
                    `CloudAdapter: closed (${event.code}: ${event.reason})`
                );
                if (event.code === 4001) {
                    this._setStatus('error', 'Authentication failed');
                    return;
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
            if (!this._destroyed) this._scheduleReconnect();
        }
    }

    private _handleMessage(raw: string): void {
        let msg: Record<string, unknown>;
        try {
            msg = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            console.warn('CloudAdapter: bad JSON from server');
            return;
        }

        switch (msg.type) {
            case 'auth-ok':
                this._clientId = String(msg.clientId ?? '');
                console.log(`CloudAdapter: authenticated as ${this._clientId}`);
                this._setStatus('syncing');
                if (!this._hasSynced) {
                    // Phase 1 of Yjs two-phase sync: send our state vector so
                    // the server can compute exactly what we're missing.
                    const sv =
                        this._bridge?.encodeBridgeStateVector() ??
                        new Uint8Array(0);
                    this._ws?.send(
                        JSON.stringify({
                            type: 'sync-request',
                            stateVector: u8ToBase64(sv)
                        })
                    );
                }
                break;

            case 'auth-error':
                console.error(
                    `CloudAdapter: auth error: ${String(msg.message ?? '')}`
                );
                this._setStatus('error', String(msg.message ?? 'auth-error'));
                break;

            case 'sync-response': {
                const serverSV =
                    typeof msg.serverStateVector === 'string'
                        ? base64ToU8(msg.serverStateVector as string)
                        : new Uint8Array(0);

                if (msg.chunked) {
                    // Server state is large — arriving in subsequent sync-chunk
                    // messages. Register outbound hook and start sync-complete
                    // immediately (we already have the serverStateVector).
                    // NOTE: do NOT set 'connected' here — wait until all
                    // response chunks are received and applied (below).
                    this._incomingResponseChunks = {
                        chunks: new Array(msg.totalChunks as number),
                        received: 0,
                        total: msg.totalChunks as number
                    };
                    this._hasSynced = true;
                    this._registerOutboundHook();
                    this._sendSyncComplete(serverSV);
                } else {
                    // Small response — apply inline.
                    if (
                        typeof msg.update === 'string' &&
                        (msg.update as string).length > 0
                    ) {
                        this._applyServerState(
                            base64ToU8(msg.update as string)
                        );
                    }
                    this._hasSynced = true;
                    this._setStatus('connected');
                    this._registerOutboundHook();
                    this._sendSyncComplete(serverSV);
                }
                break;
            }

            case 'sync-chunk': {
                // Chunk of a large server→client sync-response.
                if (
                    msg.direction === 'response' &&
                    this._incomingResponseChunks &&
                    typeof msg.update === 'string'
                ) {
                    const state = this._incomingResponseChunks;
                    state.chunks[msg.chunkIndex as number] = base64ToU8(
                        msg.update as string
                    );
                    state.received++;
                    if (state.received === state.total) {
                        const combined = this._mergeChunks(
                            state.chunks as Uint8Array[]
                        );
                        this._incomingResponseChunks = null;
                        this._applyServerState(combined);
                        // All server response chunks received and applied:
                        // now it is safe to signal 'connected'.
                        this._setStatus('connected');
                    }
                }
                break;
            }

            case 'update':
                if (typeof msg.fullState === 'string' && msg.fullState.length) {
                    this._applyServerState(base64ToU8(msg.fullState));
                } else if (typeof msg.update === 'string') {
                    this._applyRemoteUpdate(base64ToU8(msg.update));
                }
                break;

            case 'ack':
                break;

            case 'error':
                console.warn(
                    `CloudAdapter: server error: ${String(msg.message ?? '')}`
                );
                break;

            default:
                console.warn(
                    `CloudAdapter: unknown message type: ${String(msg.type ?? '')}`
                );
        }
    }

    // ── Yjs integration ───────────────────────────────────────────

    /** Apply a full-state snapshot received from the server. */
    private _applyServerState(update: Uint8Array): void {
        if (!this._bridge || update.length === 0) return;
        try {
            this._bridge.applyFullState(update);
            console.log(
                `CloudAdapter: applied server state (${update.length} bytes)`
            );
        } catch (err) {
            console.error('CloudAdapter: failed to apply server state:', err);
        }
    }

    /** Apply an incremental update broadcast from a peer. */
    private _applyRemoteUpdate(update: Uint8Array): void {
        if (!this._bridge || update.length === 0) return;
        try {
            this._bridge.applyRemoteUpdate(update);
        } catch (err) {
            console.error('CloudAdapter: failed to apply remote update:', err);
        }
    }

    /**
     * Phase 2 of Yjs sync: send our local state diff to the server so other
     * peers can receive the full history.
     *
     * If the diff exceeds SYNC_CHUNK_SIZE it is split into multiple messages:
     * N-1 `sync-chunk` messages followed by a final `sync-complete` message
     * that carries the last chunk and signals the server to commit.
     */
    private _sendSyncComplete(serverStateVector: Uint8Array): void {
        if (
            !this._bridge ||
            !this._ws ||
            this._ws.readyState !== WebSocket.OPEN
        )
            return;
        try {
            const diff = this._bridge.encodeStateDiff(serverStateVector);
            if (diff.length === 0) return;

            const totalChunks = Math.ceil(diff.length / SYNC_CHUNK_SIZE);
            console.log(
                `CloudAdapter: sending sync-complete ` +
                    `(${diff.length} bytes, ${totalChunks} chunk(s))`
            );

            for (let i = 0; i < totalChunks; i++) {
                const isLast = i === totalChunks - 1;
                const chunk = diff.slice(
                    i * SYNC_CHUNK_SIZE,
                    (i + 1) * SYNC_CHUNK_SIZE
                );
                const frame: Record<string, unknown> = {
                    type: isLast ? 'sync-complete' : 'sync-chunk',
                    update: u8ToBase64(chunk)
                };
                if (totalChunks > 1) {
                    frame.chunkIndex = i;
                    frame.totalChunks = totalChunks;
                }
                this._ws.send(JSON.stringify(frame));
            }
        } catch (err) {
            console.warn('CloudAdapter: failed to send sync-complete:', err);
        }
    }

    /** Concatenate an ordered array of Uint8Array chunks into one buffer. */
    private _mergeChunks(chunks: Uint8Array[]): Uint8Array {
        const totalLen = chunks.reduce((a, c) => a + c.length, 0);
        const result = new Uint8Array(totalLen);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return result;
    }

    /**
     * Register a listener that forwards each local Yjs update to the room
     * server. Safe to call multiple times — the guard on
     * `_localUpdateUnsubscribe` prevents duplicate registrations.
     */
    private _registerOutboundHook(): void {
        if (!this._bridge || this._localUpdateUnsubscribe) return;

        const sendUpdate = (update: Uint8Array): void => {
            if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
            const seq = ++this._seq;
            const fullState = this._bridge?.getFullState() ?? update;
            this._ws.send(
                JSON.stringify({
                    type: 'update',
                    update: u8ToBase64(fullState),
                    clientId: this._clientId ?? '',
                    seq
                })
            );
        };

        this._bridge.onLocalUpdate(sendUpdate);
        this._localUpdateUnsubscribe = () => {
            this._bridge?.offLocalUpdate(sendUpdate);
        };
    }

    // ── Room token fetch ──────────────────────────────────────────

    private async _fetchRoomToken(): Promise<{
        token: string;
        roomUrl: string;
    }> {
        const url = `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(this._assetId)}/room-token`;
        const resp = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: getCloudRequestHeaders({
                'Content-Type': 'application/json'
            })
        });

        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            throw new Error(
                `room-token request failed: ${resp.status} ${body}`
            );
        }

        const data = await parseRequiredJsonResponse<{
            token: string;
            roomUrl: string;
        }>(resp, 'room-token request failed');
        if (!data.token || !data.roomUrl) {
            throw new Error('room-token response missing token or roomUrl');
        }
        return data;
    }

    // ── Helpers ───────────────────────────────────────────────────

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

    // ── FileSystemAdapter stubs ───────────────────────────────────

    async scanDirectory(_path: string): Promise<Record<string, FileInfo>> {
        try {
            const resp = await fetch(
                `${this._websiteBaseUrl}/api/cloud/assets`,
                {
                    credentials: 'include',
                    headers: getCloudRequestHeaders()
                }
            );
            if (!resp.ok) {
                return {};
            }
            const data = (await resp.json()) as {
                assets: Array<{
                    id: string;
                    name: string;
                    updatedAt: number;
                }>;
            };
            const items: Record<string, FileInfo> = {};
            for (const asset of data.assets ?? []) {
                const displayName = asset.name.endsWith('.babelfont')
                    ? asset.name
                    : `${asset.name}.babelfont`;
                items[displayName] = {
                    path: `cloud://${asset.id}`,
                    is_dir: false,
                    mtime: new Date(asset.updatedAt).toISOString()
                };
            }
            return items;
        } catch {
            return {};
        }
    }

    async readFile(_path: string): Promise<string | Uint8Array> {
        throw new Error('CloudAdapter.readFile not implemented in Phase 0');
    }

    async writeFile(
        _path: string,
        _content: string | Uint8Array
    ): Promise<void> {
        throw new Error('CloudAdapter.writeFile not implemented in Phase 0');
    }

    async createFolder(_path: string): Promise<void> {
        throw new Error('CloudAdapter.createFolder not implemented in Phase 0');
    }

    async deleteItem(path: string, isDir: boolean): Promise<void> {
        if (isDir) {
            throw new Error('Cloud folders are not supported');
        }

        const assetId = path.replace(/^cloud:\/\//, '').trim();
        if (!assetId) {
            throw new Error('Missing cloud asset id');
        }

        const resp = await fetch(
            `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(assetId)}`,
            {
                method: 'DELETE',
                credentials: 'include',
                headers: getCloudRequestHeaders()
            }
        );

        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            throw new Error(
                `Failed to delete cloud asset: ${resp.status} ${body}`
            );
        }

        if (resp.status !== 204) {
            const data = await parseRequiredJsonResponse<CloudDeleteResponse>(
                resp,
                'Failed to delete cloud asset'
            );
            if (data.success !== true) {
                throw new Error(
                    data.error ||
                        'Cloud delete response did not confirm success'
                );
            }
        }

        if (this._assetId === assetId) {
            this.disconnect();
        }
    }

    async renameItem(
        _oldPath: string,
        _newName: string,
        _isDir: boolean
    ): Promise<void> {
        throw new Error('CloudAdapter.renameItem not implemented in Phase 0');
    }

    async fileExists(_path: string): Promise<boolean> {
        return false;
    }
}
