/**
 * CloudAdapter — WebSocket-based adapter that syncs a local PatchSyncEngine
 * with a remote FontRoomDO Durable Object.
 *
 * Sync protocol (all frames are JSON, binary data as base64 strings):
 *
 * Client → Server:
 *   { type: 'auth',          token: string }
 *   { type: 'sync-request',  stateVector: string }   ← base64(Y.encodeStateVector)
 *   { type: 'sync-complete', update: string [, chunkIndex, totalChunks] }   ← base64(diff for server, last or only chunk)
 *   { type: 'sync-chunk',    update: string, chunkIndex, totalChunks }       ← preceding chunk(s) for large diff
 *   { type: 'update',        update: string, clientId: string, seq: number,
 *                            collaborationMessages?: CollaborationMessageEnvelope[] }
 *
 * Server → Client:
 *   { type: 'auth-ok',       clientId: string }
 *   { type: 'auth-error',    message: string }
 *   { type: 'sync-response', update?: string, serverStateVector: string,
 *                            collaborationMessageHistory?: CollaborationMessageEnvelope[] [, chunked: true, totalChunks] }
 *   { type: 'sync-chunk',    update: string, chunkIndex, totalChunks, direction: 'response' }
 *   { type: 'ack',           seq: -1, durable: boolean, phase: 'sync-complete' }
 *   { type: 'update',        update: string, clientId: string, seq: number,
 *                            collaborationMessages?: CollaborationMessageEnvelope[] }
 *   { type: 'ack',           seq: number, durable: boolean }
 *   { type: 'error',         message: string }
 *
 * The state-vector exchange (sync-request / sync-response / sync-complete)
 * follows the standard y-websocket two-phase sync protocol so that each side
 * only transmits what the other is missing, keeping initial payloads minimal.
 * Ordinary live room updates stay incremental; full-state transfer is reserved
 * for bootstrap and explicit re-sync after reconnect.
 */

import * as Y from 'yjs';
import type { PatchSyncEngine } from './patch-sync-engine';
import type { FileSystemAdapter, FileInfo } from './file-system-adapter';
import { Logger } from './logger';
import {
    collaborationMessageKey,
    createChangeLogEntriesFromCollaborationMessageEnvelope,
    createCollaborationMessageEnvelopesFromChangeLogEntries,
    type CollaborationMessageEnvelope
} from './collaboration-message';
import { isProduction } from './settings';
import { resolveWebsiteURL } from './website-url';

const console = new Logger('CloudAdapter');

/** Default room-worker URLs for production and local development. */
const DEFAULT_PRODUCTION_ROOM_WORKER_URL =
    'https://fonts-room.fonteditor.workers.dev';
const DEFAULT_LOCAL_ROOM_WORKER_URL = 'ws://localhost:8787';

function getDefaultRoomWorkerUrl(): string {
    return isProduction()
        ? DEFAULT_PRODUCTION_ROOM_WORKER_URL
        : DEFAULT_LOCAL_ROOM_WORKER_URL;
}

/** Default website base URL for the room-token endpoint. */
const DEFAULT_WEBSITE_BASE_URL = resolveWebsiteURL();

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
const CLIENT_RECONNECT_CLOSE_CODE = 4000;

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
    suppressSyncComplete?: boolean;
    onConnectionStatus?: (
        status: CloudConnectionStatus,
        detail?: string
    ) => void;
};

type CloudLiveUpdateMessage = {
    update: Uint8Array;
    collaborationMessages?: CollaborationMessageEnvelope[];
};

type CloudOutboundUpdatePacket = {
    update: Uint8Array;
    collaborationMessage?: CollaborationMessageEnvelope;
};

function dedupeCollaborationMessages(
    envelopes: CollaborationMessageEnvelope[]
): CollaborationMessageEnvelope[] {
    const seenEnvelopeKeys = new Set<string>();
    const deduped: CollaborationMessageEnvelope[] = [];

    for (const envelope of envelopes) {
        const envelopeKey = collaborationMessageKey(envelope);
        if (seenEnvelopeKeys.has(envelopeKey)) {
            continue;
        }
        seenEnvelopeKeys.add(envelopeKey);
        deduped.push(envelope);
    }

    return deduped;
}

function importCollaborationMessageHistory(
    bridge: PatchSyncEngine,
    collaborationMessageHistory?: CollaborationMessageEnvelope[],
    pendingCollaborationMessages: CollaborationMessageEnvelope[] = []
): void {
    const envelopes = dedupeCollaborationMessages([
        ...(collaborationMessageHistory ?? []),
        ...pendingCollaborationMessages
    ]);

    if (!envelopes.length) {
        return;
    }

    bridge.mergeImportedChangeLog(
        envelopes.flatMap((message) =>
            createChangeLogEntriesFromCollaborationMessageEnvelope(message, {
                windowRoleLabel: window.windowRole?.getRoleLabel?.() ?? 'main'
            })
        )
    );
    bridge.mergeImportedCollaborationMessages(
        envelopes.map((message) => ({
            id: collaborationMessageKey(message),
            direction: 'remote',
            timestamp: message.timestamp,
            transactionDurationMs:
                message.metadata.transactionDurationMs ?? null,
            summary: message.summary,
            label: message.label,
            source: message.source,
            editSource: message.metadata.editSource ?? null,
            windowId: message.windowId,
            windowRoleLabel:
                message.metadata.sourceWindowRoleLabel ??
                window.windowRole?.getRoleLabel?.() ??
                'main',
            historyItemId: message.metadata.historyItemId,
            historyAction: message.metadata.historyAction,
            targetHistoryItemId: message.metadata.targetHistoryItemId ?? null,
            undoScope: message.metadata.undoScope,
            updateByteLength: 0,
            updateBase64Preview: '',
            changedGlyphNames: [...message.metadata.changedGlyphNames],
            changedLayerIds: [...message.metadata.changedLayerIds],
            workerReplayTargets: [...message.metadata.workerReplayTargets],
            changes: message.changes,
            derivedForwardChanges: []
        }))
    );
}

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
 * CloudAdapter connects a local PatchSyncEngine to a remote FontRoomDO.
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
    private _suppressSyncComplete: boolean;

    private _bridge: PatchSyncEngine | null = null;
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
    private _pendingOutboundPackets: CloudOutboundUpdatePacket[] = [];
    private _outboundFlushScheduled = false;
    private _outboundBroadcastEntryCounts = new Map<number, number>();
    private _outboundPendingMessageKeys = new Map<number, string[]>();
    private _pendingDurabilityMessages: CollaborationMessageEnvelope[] = [];
    private _pendingInboundUpdates: CloudLiveUpdateMessage[] = [];
    private _inboundFlushScheduled = false;
    private _resyncRequestedAfterNoopUpdate = false;
    private _initialServerStateApplied = false;
    private _initialSyncDurable = false;
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
            options.roomWorkerBaseUrl ?? getDefaultRoomWorkerUrl();
        this._suppressSyncComplete = options.suppressSyncComplete ?? false;
        this._onConnectionStatus = options.onConnectionStatus ?? null;
    }

    get status(): CloudConnectionStatus {
        return this._status;
    }

    get assetId(): string {
        return this._assetId;
    }

    // ── Public API ───────────────────────────────────────────────

    async connect(bridge: PatchSyncEngine): Promise<void> {
        if (this._destroyed) {
            console.warn('CloudAdapter: already destroyed');
            return;
        }
        this._hasSynced = false;
        this._incomingResponseChunks = null;
        this._initialServerStateApplied = false;
        this._initialSyncDurable = false;
        this._bridge = bridge;
        this._registerOutboundHook();
        this._subscribeFontModelReady();
        this._setStatus('connecting');
        await this._connectWebSocket();
    }

    /**
     * Dev-only: Connect using a pre-built token and room URL, bypassing the
     * website auth endpoint. Used for Phase 0 testing via `window.cloudDebug`.
     */
    async connectDirect(
        bridge: PatchSyncEngine,
        token: string,
        roomUrl: string
    ): Promise<void> {
        if (this._destroyed) {
            console.warn('CloudAdapter: already destroyed');
            return;
        }
        this._hasSynced = false;
        this._incomingResponseChunks = null;
        this._initialServerStateApplied = false;
        this._initialSyncDurable = false;
        this._bridge = bridge;
        this._registerOutboundHook();
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
        this._pendingOutboundPackets = [];
        this._outboundFlushScheduled = false;
        this._pendingInboundUpdates = [];
        this._inboundFlushScheduled = false;
        this._initialServerStateApplied = false;
        this._initialSyncDurable = false;
        this._setStatus('disconnected');
    }

    sendForwardedUpdate(
        update: Uint8Array,
        collaborationMessage?: CollaborationMessageEnvelope | null
    ): void {
        if (!update.length) {
            return;
        }

        this._pendingOutboundPackets.push({
            update,
            ...(collaborationMessage ? { collaborationMessage } : undefined)
        });
        if (collaborationMessage) {
            this._enqueuePendingDurabilityMessages([collaborationMessage]);
        }
        if (this._outboundFlushScheduled) {
            return;
        }
        this._outboundFlushScheduled = true;
        queueMicrotask(() => this._flushPendingOutboundUpdates());
    }

    // ── Bridge tracking ──────────────────────────────────────────

    /**
     * Subscribe to `fontModelReady` so the adapter stays bound to the current
     * bridge even if `initializeBridge()` replaces `window.patchSyncEngine` (e.g.
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
     * Rebind the adapter to the current global PatchSyncEngine after font load.
     * Returns true when a new bridge was adopted.
     */
    rebindToCurrentBridge(): boolean {
        const newBridge = window.patchSyncEngine ?? null;
        if (!newBridge || newBridge === this._bridge) {
            return false;
        }

        const currentFontJson = window.fontManager?.currentFont
            ?.babelfontData as
            | Record<string, ReturnType<typeof JSON.parse>>
            | undefined;

        const skipMerge = Boolean(
            (
                window as Window & {
                    __skipCloudBridgeRebindMerge?: boolean;
                }
            ).__skipCloudBridgeRebindMerge
        );
        if (skipMerge) {
            delete (
                window as Window & {
                    __skipCloudBridgeRebindMerge?: boolean;
                }
            ).__skipCloudBridgeRebindMerge;
        }

        // Bridge was replaced by initializeBridge() — re-seed the new bridge's
        // Y.Doc with the accumulated CRDT state from the old bridge so future
        // incremental updates from remote peers can resolve correctly.
        const oldState = this._bridge?.encodeBridgeState();
        if (!skipMerge && oldState && oldState.length > 0) {
            newBridge.applyYDocUpdateSilent(oldState);
        }

        this._localUpdateUnsubscribe?.();
        this._localUpdateUnsubscribe = null;
        this._bridge = newBridge;
        if (currentFontJson && typeof newBridge.setFontJson === 'function') {
            newBridge.setFontJson(currentFontJson);
        }
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
                this._clientId = null;
                this._hasSynced = false;
                this._incomingResponseChunks = null;
                this._initialServerStateApplied = false;
                this._initialSyncDurable = false;
                this._pendingOutboundPackets = [];
                this._outboundFlushScheduled = false;
                this._pendingInboundUpdates = [];
                this._inboundFlushScheduled = false;
                this._localUpdateUnsubscribe?.();
                this._localUpdateUnsubscribe = null;
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
                this._initialServerStateApplied = false;
                this._initialSyncDurable = false;
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
                this._resyncRequestedAfterNoopUpdate = false;
                const serverSV =
                    typeof msg.serverStateVector === 'string'
                        ? base64ToU8(msg.serverStateVector as string)
                        : new Uint8Array(0);
                const collaborationMessageHistory = Array.isArray(
                    msg.collaborationMessageHistory
                )
                    ? (msg.collaborationMessageHistory as CollaborationMessageEnvelope[])
                    : undefined;
                this._reconcileDurableCollaborationMessageHistory(
                    collaborationMessageHistory ?? []
                );
                if (this._bridge) {
                    importCollaborationMessageHistory(
                        this._bridge,
                        collaborationMessageHistory,
                        this._pendingDurabilityMessages
                    );
                }

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
                    this._initialSyncDurable =
                        !this._sendSyncComplete(serverSV);
                } else {
                    // Small response — apply inline.
                    if (
                        typeof msg.update === 'string' &&
                        (msg.update as string).length > 0
                    ) {
                        this._applyServerState(
                            base64ToU8(msg.update as string)
                        );
                    } else {
                        this._initialServerStateApplied = true;
                    }
                    this._hasSynced = true;
                    this._registerOutboundHook();
                    this._initialSyncDurable =
                        !this._sendSyncComplete(serverSV);
                    this._maybeMarkInitialSyncConnected();
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
                        this._maybeMarkInitialSyncConnected();
                    }
                }
                break;
            }

            case 'update':
                if (typeof msg.update === 'string') {
                    if (
                        typeof msg.clientId === 'string' &&
                        this._clientId &&
                        msg.clientId === this._clientId
                    ) {
                        break;
                    }

                    this._queueInboundUpdate({
                        update: base64ToU8(msg.update),
                        collaborationMessages: Array.isArray(
                            msg.collaborationMessages
                        )
                            ? (msg.collaborationMessages as CollaborationMessageEnvelope[])
                            : undefined
                    });
                }
                break;

            case 'ack':
                if (msg.seq === -1 && msg.phase === 'sync-complete') {
                    if (msg.durable === false) {
                        const detail = 'Initial cloud sync was not durable';
                        console.warn(`CloudAdapter: ${detail}`);
                        this._setStatus('error', detail);
                        this._ws?.close(
                            CLIENT_RECONNECT_CLOSE_CODE,
                            'undurable-sync-complete'
                        );
                        return;
                    }

                    this._initialSyncDurable = true;
                    this._maybeMarkInitialSyncConnected();
                    return;
                }

                if (msg.durable === false) {
                    const detail = `Cloud update seq ${String(msg.seq ?? '?')} was not durable`;
                    console.warn(`CloudAdapter: ${detail}`);
                    this._setStatus('error', detail);
                    this._ws?.close(
                        CLIENT_RECONNECT_CLOSE_CODE,
                        'undurable-update'
                    );
                } else if (typeof msg.seq === 'number') {
                    this._recordDurableAck(msg.seq);
                }
                break;

            case 'error': {
                const detail = String(msg.message ?? 'server error');
                console.warn(`CloudAdapter: server error: ${detail}`);
                if (
                    detail === 'Sync update not durable' ||
                    detail === 'Invalid Yjs update' ||
                    detail === 'Room state failed to load' ||
                    detail === 'Room id unavailable'
                ) {
                    this._setStatus('error', detail);
                    this._ws?.close(
                        CLIENT_RECONNECT_CLOSE_CODE,
                        'server-error'
                    );
                }
                break;
            }

            default:
                console.warn(
                    `CloudAdapter: unknown message type: ${String(msg.type ?? '')}`
                );
        }
    }

    // ── Yjs integration ───────────────────────────────────────────

    /** Apply a full-state snapshot received from the server. */
    private _applyServerState(update: Uint8Array): void {
        if (update.length === 0) {
            this._resyncRequestedAfterNoopUpdate = false;
            this._initialServerStateApplied = true;
            return;
        }
        if (!this._bridge) return;
        try {
            this._bridge.applyFullState(update);
            this._resyncRequestedAfterNoopUpdate = false;
            this._initialServerStateApplied = true;
            console.log(
                `CloudAdapter: applied server state (${update.length} bytes)`
            );
        } catch (err) {
            console.error('CloudAdapter: failed to apply server state:', err);
        }
    }

    private _maybeMarkInitialSyncConnected(): void {
        if (
            this._hasSynced &&
            this._initialServerStateApplied &&
            this._initialSyncDurable
        ) {
            this._setStatus('connected');
        }
    }

    /** Apply an incremental update broadcast from a peer. */
    private _applyRemoteUpdate(
        update: Uint8Array,
        remoteCollaborationMessages?: CollaborationMessageEnvelope[]
    ): void {
        if (!this._bridge || update.length === 0) return;
        try {
            const beforeState = this._bridge.encodeBridgeState();
            this._bridge.applyRemoteUpdate(
                update,
                undefined,
                remoteCollaborationMessages
            );
            const afterState = this._bridge.encodeBridgeState();
            // Duplicate or bootstrap reconciliation packets can be semantically
            // no-ops. Treating those as divergence and immediately requesting a
            // server resync causes sync-request ping-pong between peers.
            const isNoopRemoteUpdate =
                beforeState.length === afterState.length &&
                beforeState.every(
                    (value, index) => value === afterState[index]
                );
            if (isNoopRemoteUpdate) {
                return;
            }
            if (window.windowRole?.isMainWindow()) {
                window.windowSync?.broadcastCloudRelayUpdate?.(
                    update,
                    remoteCollaborationMessages?.[0] ?? null
                );
            }
        } catch (err) {
            console.error('CloudAdapter: failed to apply remote update:', err);
        }
    }

    private _requestServerResyncAfterNoopUpdate(): void {
        if (
            this._resyncRequestedAfterNoopUpdate ||
            !this._ws ||
            this._ws.readyState !== WebSocket.OPEN
        ) {
            return;
        }

        const stateVector = this._bridge?.encodeBridgeStateVector();
        if (!stateVector) {
            return;
        }

        this._resyncRequestedAfterNoopUpdate = true;
        this._ws.send(
            JSON.stringify({
                type: 'sync-request',
                stateVector: u8ToBase64(stateVector)
            })
        );
    }

    /**
     * Phase 2 of Yjs sync: send our local state diff to the server so other
     * peers can receive the full history.
     *
     * If the diff exceeds SYNC_CHUNK_SIZE it is split into multiple messages:
     * N-1 `sync-chunk` messages followed by a final `sync-complete` message
     * that carries the last chunk and signals the server to commit.
     */
    private _sendSyncComplete(serverStateVector: Uint8Array): boolean {
        if (
            !this._bridge ||
            !this._ws ||
            this._ws.readyState !== WebSocket.OPEN
        )
            return false;
        if (this._suppressSyncComplete) {
            return false;
        }
        try {
            const diff = this._bridge.encodeStateDiff(serverStateVector);
            if (diff.length === 0) return false;
            const collaborationMessages =
                createCollaborationMessageEnvelopesFromChangeLogEntries(
                    this._bridge.getNewChangeLogEntries(),
                    {
                        startingLocalSequence: this._seq + 1,
                        source: 'cloud-adapter.sync-complete',
                        windowId: this._bridge.windowId
                    }
                );
            this._enqueuePendingDurabilityMessages(collaborationMessages);
            const pendingCollaborationMessages = dedupeCollaborationMessages(
                this._pendingDurabilityMessages
            );

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
                if (isLast) {
                    frame.collaborationMessages =
                        pendingCollaborationMessages.length
                            ? pendingCollaborationMessages
                            : undefined;
                }
                this._ws.send(JSON.stringify(frame));
            }
            return true;
        } catch (err) {
            console.warn('CloudAdapter: failed to send sync-complete:', err);
            return false;
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

        const sendUpdate = (
            update: Uint8Array,
            collaborationMessage?: CollaborationMessageEnvelope | null
        ): void => {
            this._pendingOutboundPackets.push({
                update,
                ...(collaborationMessage ? { collaborationMessage } : undefined)
            });
            if (collaborationMessage) {
                this._enqueuePendingDurabilityMessages([collaborationMessage]);
            }
            if (this._outboundFlushScheduled) {
                return;
            }
            this._outboundFlushScheduled = true;
            queueMicrotask(() => this._flushPendingOutboundUpdates());
        };

        this._bridge.onLocalUpdate(sendUpdate);
        this._localUpdateUnsubscribe = () => {
            this._bridge?.offLocalUpdate(sendUpdate);
        };
    }

    private _flushPendingOutboundUpdates(): void {
        if (!this._outboundFlushScheduled) {
            return;
        }
        this._outboundFlushScheduled = false;

        if (
            !this._ws ||
            this._ws.readyState !== WebSocket.OPEN ||
            !this._bridge
        ) {
            this._pendingOutboundPackets = [];
            return;
        }

        const packets = this._pendingOutboundPackets;
        this._pendingOutboundPackets = [];
        if (!packets.length) {
            return;
        }

        for (const packet of packets) {
            const seq = ++this._seq;
            const updateBase64 = u8ToBase64(packet.update);
            const collaborationMessages = packet.collaborationMessage
                ? [packet.collaborationMessage]
                : [];
            const broadcastEntryCount = collaborationMessages.reduce(
                (count, message) => count + message.changes.length,
                0
            );
            const pendingMessageKeys = collaborationMessages.map((message) =>
                collaborationMessageKey(message)
            );

            if (broadcastEntryCount > 0) {
                this._outboundBroadcastEntryCounts.set(
                    seq,
                    broadcastEntryCount
                );
            }
            if (pendingMessageKeys.length) {
                this._outboundPendingMessageKeys.set(seq, pendingMessageKeys);
            }

            (
                window as Window & {
                    __lastCloudOutboundUpdateBase64?: string;
                    __lastCloudOutboundUpdateSeq?: number;
                }
            ).__lastCloudOutboundUpdateBase64 = updateBase64;
            (
                window as Window & {
                    __lastCloudOutboundUpdateBase64?: string;
                    __lastCloudOutboundUpdateSeq?: number;
                }
            ).__lastCloudOutboundUpdateSeq = seq;

            this._ws.send(
                JSON.stringify({
                    type: 'update',
                    update: updateBase64,
                    clientId: this._clientId ?? '',
                    seq,
                    collaborationMessages: collaborationMessages.length
                        ? collaborationMessages
                        : undefined
                })
            );
        }
    }

    private _recordDurableAck(seq: number): void {
        const broadcastEntryCount =
            this._outboundBroadcastEntryCounts.get(seq) ?? 0;
        this._outboundBroadcastEntryCounts.delete(seq);
        const pendingMessageKeys =
            this._outboundPendingMessageKeys.get(seq) ?? [];
        this._outboundPendingMessageKeys.delete(seq);

        if (pendingMessageKeys.length) {
            const durableMessageKeys = new Set(pendingMessageKeys);
            this._pendingDurabilityMessages =
                this._pendingDurabilityMessages.filter(
                    (message) =>
                        !durableMessageKeys.has(
                            collaborationMessageKey(message)
                        )
                );
        }

        this._bridge?.advanceBroadcastLogCursor(broadcastEntryCount);
    }

    private _enqueuePendingDurabilityMessages(
        envelopes: CollaborationMessageEnvelope[]
    ): void {
        if (!envelopes.length) {
            return;
        }

        this._pendingDurabilityMessages = dedupeCollaborationMessages([
            ...this._pendingDurabilityMessages,
            ...envelopes
        ]);
    }

    private _reconcileDurableCollaborationMessageHistory(
        collaborationMessageHistory: CollaborationMessageEnvelope[]
    ): void {
        if (
            !collaborationMessageHistory.length ||
            !this._pendingDurabilityMessages.length
        ) {
            return;
        }

        const durableTransactions = new Set(
            collaborationMessageHistory.map((message) =>
                collaborationMessageKey(message)
            )
        );
        this._pendingDurabilityMessages =
            this._pendingDurabilityMessages.filter(
                (message) =>
                    !durableTransactions.has(collaborationMessageKey(message))
            );
    }

    private _queueInboundUpdate(msg: CloudLiveUpdateMessage): void {
        this._pendingInboundUpdates.push(msg);
        if (this._inboundFlushScheduled) {
            return;
        }
        this._inboundFlushScheduled = true;
        queueMicrotask(() => this._flushPendingInboundUpdates());
    }

    private _flushPendingInboundUpdates(): void {
        if (!this._inboundFlushScheduled) {
            return;
        }
        this._inboundFlushScheduled = false;
        const messages = this._pendingInboundUpdates;
        this._pendingInboundUpdates = [];
        if (!messages.length) {
            return;
        }

        for (const message of messages) {
            (
                window as Window & {
                    __lastCloudInboundUpdateBase64?: string;
                    __lastCloudInboundUpdateCount?: number;
                }
            ).__lastCloudInboundUpdateBase64 = u8ToBase64(message.update);
            (
                window as Window & {
                    __lastCloudInboundUpdateBase64?: string;
                    __lastCloudInboundUpdateCount?: number;
                }
            ).__lastCloudInboundUpdateCount =
                ((
                    window as Window & {
                        __lastCloudInboundUpdateCount?: number;
                    }
                ).__lastCloudInboundUpdateCount ?? 0) + 1;
            this._applyRemoteUpdate(
                message.update,
                message.collaborationMessages?.length
                    ? message.collaborationMessages
                    : undefined
            );
        }
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
