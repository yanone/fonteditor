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
 *   { type: 'update-chunk',  update: string, clientId: string, seq: number,
 *                            clientTransactionId?: string,
 *                            chunkIndex, totalChunks }                       ← preceding chunk(s) for large live edits
 *   { type: 'update',        update: string, clientId: string, seq: number,
 *                            clientTransactionId?: string,
 *                            collaborationMessages?: CollaborationMessageEnvelope[]
 *                            [, chunkIndex, totalChunks] }                   ← last or only chunk
 *
 * Server → Client:
 *   { type: 'auth-ok',       clientId: string }
 *   { type: 'auth-error',    message: string }
 *   { type: 'sync-response', update?: string, serverStateVector: string,
 *                            collaborationMessageHistory?: CollaborationMessageEnvelope[] [, chunked: true, totalChunks] }
 *   { type: 'sync-chunk',    update: string, chunkIndex, totalChunks, direction: 'response' }
 *   { type: 'ack',           seq: -1, durable: boolean, phase: 'sync-complete' }
 *   { type: 'update-chunk',  update: string, clientId: string, seq: number,
 *                            clientTransactionId?: string,
 *                            chunkIndex, totalChunks }                       ← preceding chunk(s) for large live edits
 *   { type: 'update',        update: string, clientId: string, seq: number,
 *                            clientTransactionId?: string,
 *                            collaborationMessages?: CollaborationMessageEnvelope[]
 *                            [, chunkIndex, totalChunks] }                   ← last or only chunk
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
const CLOUD_ASSET_DELETED_MESSAGE = 'Cloud asset was deleted';

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

type CloudAssetRole = 'owner' | 'editor' | 'viewer';

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
const AUTHENTICATION_TIMEOUT_MS = 10000;
const OUTBOUND_ACK_TIMEOUT_MS = 10000;
const OUTBOUND_ACK_MAX_WAIT_MS = 30000;
const INITIAL_SYNC_TIMEOUT_MS = 10000;

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
    onPendingSyncCountChange?: (count: number) => void;
};

type CloudLiveUpdateMessage = {
    update: Uint8Array;
    collaborationMessages?: CollaborationMessageEnvelope[];
};

type CloudChunkAccumulator = {
    chunks: (Uint8Array | undefined)[];
    received: number;
    total: number;
};

type CloudOutboundUpdatePacket = {
    update: Uint8Array;
    collaborationMessage?: CollaborationMessageEnvelope;
    clientTransactionId?: string;
};

type CloudDurableOutboxRecord = {
    assetId: string;
    clientTransactionId: string;
    updateBase64: string;
    collaborationMessage: CollaborationMessageEnvelope;
    createdAt: number;
};

type CloudVisibleRebaselineTargets = {
    editingFontRecompiled: boolean;
    textPreviewReshaped: boolean;
    canvasRefreshed: boolean;
    overviewRefreshed: boolean;
    fontInfoRefreshed: boolean;
};

const CLOUD_OUTBOX_DB_NAME = 'counterpunch-cloud-outbox';
const CLOUD_OUTBOX_DB_VERSION = 1;
const CLOUD_OUTBOX_STORE_NAME = 'pending-transactions';
const CLOUD_OUTBOX_ASSET_ID_INDEX = 'by-asset-id';

function canUseIndexedDb(): boolean {
    return typeof indexedDB !== 'undefined';
}

function openCloudOutboxDatabase(): Promise<IDBDatabase | null> {
    if (!canUseIndexedDb()) {
        return Promise.resolve(null);
    }

    return new Promise((resolve, reject) => {
        const request = indexedDB.open(
            CLOUD_OUTBOX_DB_NAME,
            CLOUD_OUTBOX_DB_VERSION
        );

        request.onupgradeneeded = () => {
            const db = request.result;
            const store = db.objectStoreNames.contains(CLOUD_OUTBOX_STORE_NAME)
                ? request.transaction?.objectStore(CLOUD_OUTBOX_STORE_NAME)
                : db.createObjectStore(CLOUD_OUTBOX_STORE_NAME, {
                      keyPath: 'key'
                  });
            if (
                store &&
                !store.indexNames.contains(CLOUD_OUTBOX_ASSET_ID_INDEX)
            ) {
                store.createIndex(CLOUD_OUTBOX_ASSET_ID_INDEX, 'assetId', {
                    unique: false
                });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function loadCloudOutboxRecords(
    assetId: string
): Promise<CloudDurableOutboxRecord[]> {
    const db = await openCloudOutboxDatabase();
    if (!db) {
        return [];
    }

    return new Promise((resolve, reject) => {
        const transaction = db.transaction(CLOUD_OUTBOX_STORE_NAME, 'readonly');
        const store = transaction.objectStore(CLOUD_OUTBOX_STORE_NAME);
        const request = store
            .index(CLOUD_OUTBOX_ASSET_ID_INDEX)
            .getAll(assetId);

        request.onsuccess = () => {
            const records = Array.isArray(request.result)
                ? request.result.map((record) => ({
                      assetId: String(record.assetId ?? ''),
                      clientTransactionId: String(
                          record.clientTransactionId ?? ''
                      ),
                      updateBase64: String(record.updateBase64 ?? ''),
                      collaborationMessage:
                          record.collaborationMessage as CollaborationMessageEnvelope,
                      createdAt: Number(record.createdAt ?? 0)
                  }))
                : [];
            resolve(
                records.filter(
                    (record) =>
                        record.assetId === assetId &&
                        !!record.clientTransactionId &&
                        !!record.updateBase64 &&
                        !!record.collaborationMessage
                )
            );
        };
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
    });
}

async function putCloudOutboxRecord(
    record: CloudDurableOutboxRecord
): Promise<void> {
    const db = await openCloudOutboxDatabase();
    if (!db) {
        return;
    }

    await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(
            CLOUD_OUTBOX_STORE_NAME,
            'readwrite'
        );
        const store = transaction.objectStore(CLOUD_OUTBOX_STORE_NAME);
        store.put({
            key: `${record.assetId}:${record.clientTransactionId}`,
            ...record
        });
        transaction.oncomplete = () => {
            db.close();
            resolve();
        };
        transaction.onerror = () => {
            db.close();
            reject(transaction.error);
        };
        transaction.onabort = () => {
            db.close();
            reject(transaction.error);
        };
    });
}

async function deleteCloudOutboxRecords(
    assetId: string,
    clientTransactionIds: string[]
): Promise<void> {
    if (!clientTransactionIds.length) {
        return;
    }

    const db = await openCloudOutboxDatabase();
    if (!db) {
        return;
    }

    await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(
            CLOUD_OUTBOX_STORE_NAME,
            'readwrite'
        );
        const store = transaction.objectStore(CLOUD_OUTBOX_STORE_NAME);
        for (const clientTransactionId of clientTransactionIds) {
            store.delete(`${assetId}:${clientTransactionId}`);
        }
        transaction.oncomplete = () => {
            db.close();
            resolve();
        };
        transaction.onerror = () => {
            db.close();
            reject(transaction.error);
        };
        transaction.onabort = () => {
            db.close();
            reject(transaction.error);
        };
    });
}

function getCloudClientTransactionId(
    collaborationMessage?: CollaborationMessageEnvelope | null
): string | null {
    if (!collaborationMessage) {
        return null;
    }

    return collaborationMessageKey(collaborationMessage);
}

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

function getLiveUpdateChunkKey(
    clientId: string | null | undefined,
    seq: number | null | undefined
): string | null {
    if (!clientId || typeof seq !== 'number' || !Number.isFinite(seq)) {
        return null;
    }

    return `${clientId}:${seq}`;
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
    private _onPendingSyncCountChange: ((count: number) => void) | null;
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
    private _authenticationTimer: ReturnType<typeof setTimeout> | null = null;
    private _outboundAckTimer: ReturnType<typeof setTimeout> | null = null;
    private _initialSyncTimer: ReturnType<typeof setTimeout> | null = null;
    private _lastInboundMessageAt = 0;
    private _assetRoles = new Map<string, CloudAssetRole>();
    private _hasSynced = false;
    private _pendingOutboundPackets: CloudOutboundUpdatePacket[] = [];
    private _outboundFlushScheduled = false;
    private _outboundBroadcastEntryCounts = new Map<number, number>();
    private _outboundPendingTransactionIds = new Map<number, string[]>();
    private _outboundAckSentAtBySeq = new Map<number, number>();
    private _pendingDurabilityMessages: CollaborationMessageEnvelope[] = [];
    private _durableOutboxEntries = new Map<string, CloudDurableOutboxRecord>();
    private _pendingSyncCompleteTransactionIds: string[] = [];
    private _pendingSyncCompleteBroadcastEntryCount = 0;
    private _pendingInboundUpdates: CloudLiveUpdateMessage[] = [];
    private _inboundFlushScheduled = false;
    private _resyncRequestedAfterNoopUpdate = false;
    private _initialServerStateApplied = false;
    private _initialSyncDurable = false;
    private _needsVisibleRebaseline = false;
    private _visibleRebaselinePromise: Promise<void> | null = null;
    /** Accumulates incoming sync-response chunks from the server. */
    private _incomingResponseChunks: CloudChunkAccumulator | null = null;
    /** Accumulates incoming chunked live updates from the server. */
    private _incomingLiveUpdateChunks = new Map<
        string,
        CloudChunkAccumulator
    >();

    constructor(options: CloudAdapterOptions) {
        this._assetId = options.assetId;
        this._websiteBaseUrl =
            options.websiteBaseUrl ?? DEFAULT_WEBSITE_BASE_URL;
        this._roomWorkerBaseUrl =
            options.roomWorkerBaseUrl ?? getDefaultRoomWorkerUrl();
        this._suppressSyncComplete = options.suppressSyncComplete ?? false;
        this._onConnectionStatus = options.onConnectionStatus ?? null;
        this._onPendingSyncCountChange =
            options.onPendingSyncCountChange ?? null;
    }

    get status(): CloudConnectionStatus {
        return this._status;
    }

    get assetId(): string {
        return this._assetId;
    }

    get pendingSyncCount(): number {
        return this._durableOutboxEntries.size;
    }

    // ── Public API ───────────────────────────────────────────────

    async connect(bridge: PatchSyncEngine): Promise<void> {
        if (this._destroyed) {
            console.warn('CloudAdapter: already destroyed');
            return;
        }
        this._hasSynced = false;
        this._incomingResponseChunks = null;
        this._incomingLiveUpdateChunks.clear();
        this._initialServerStateApplied = false;
        this._initialSyncDurable = false;
        this._lastInboundMessageAt = 0;
        this._visibleRebaselinePromise = null;
        this._clearInitialSyncTimeout();
        this._bridge = bridge;
        await this._restorePersistentOutboxIntoBridge();
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
        this._incomingLiveUpdateChunks.clear();
        this._initialServerStateApplied = false;
        this._initialSyncDurable = false;
        this._lastInboundMessageAt = 0;
        this._visibleRebaselinePromise = null;
        this._clearInitialSyncTimeout();
        this._bridge = bridge;
        await this._restorePersistentOutboxIntoBridge();
        this._registerOutboundHook();
        this._subscribeFontModelReady();
        this._setStatus('connecting');
        await this._openWebSocket(token, roomUrl);
    }

    disconnect(): void {
        this._destroyed = true;
        this._clearReconnectTimer();
        this._clearAuthenticationTimeout();
        this._clearInitialSyncTimeout();
        this._resetLiveAckTracking();
        this._clearPendingSyncCompleteTracking();
        this._unsubscribeFontModelReady();
        this._localUpdateUnsubscribe?.();
        this._localUpdateUnsubscribe = null;
        this._ws?.close(1000, 'disconnect');
        this._ws = null;
        this._bridge = null;
        this._pendingOutboundPackets = [];
        this._outboundFlushScheduled = false;
        this._outboundPendingTransactionIds.clear();
        this._pendingInboundUpdates = [];
        this._inboundFlushScheduled = false;
        this._initialServerStateApplied = false;
        this._initialSyncDurable = false;
        this._lastInboundMessageAt = 0;
        this._needsVisibleRebaseline = false;
        this._visibleRebaselinePromise = null;
        this._incomingLiveUpdateChunks.clear();
        this._setStatus('disconnected');
    }

    sendForwardedUpdate(
        update: Uint8Array,
        collaborationMessage?: CollaborationMessageEnvelope | null
    ): void {
        this._enqueueOutboundPacket(update, collaborationMessage);
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

    private _enqueueOutboundPacket(
        update: Uint8Array,
        collaborationMessage?: CollaborationMessageEnvelope | null
    ): void {
        if (!update.length) {
            return;
        }

        const clientTransactionId =
            getCloudClientTransactionId(collaborationMessage);
        const packet: CloudOutboundUpdatePacket = {
            update,
            ...(collaborationMessage ? { collaborationMessage } : undefined),
            ...(clientTransactionId ? { clientTransactionId } : undefined)
        };

        this._pendingOutboundPackets.push(packet);
        if (collaborationMessage) {
            this._enqueuePendingDurabilityMessages([collaborationMessage]);
            void this._persistDurableOutboxPacket(packet);
        }
        if (this._outboundFlushScheduled) {
            return;
        }
        this._outboundFlushScheduled = true;
        queueMicrotask(() => this._flushPendingOutboundUpdates());
    }

    private async _persistDurableOutboxPacket(
        packet: CloudOutboundUpdatePacket
    ): Promise<void> {
        if (!packet.collaborationMessage || !packet.clientTransactionId) {
            return;
        }

        if (this._durableOutboxEntries.has(packet.clientTransactionId)) {
            return;
        }

        const record: CloudDurableOutboxRecord = {
            assetId: this._assetId,
            clientTransactionId: packet.clientTransactionId,
            updateBase64: u8ToBase64(packet.update),
            collaborationMessage: packet.collaborationMessage,
            createdAt: Date.now()
        };
        this._durableOutboxEntries.set(packet.clientTransactionId, record);
        this._emitPendingSyncCountChange();

        try {
            await putCloudOutboxRecord(record);
        } catch (error) {
            console.warn(
                'CloudAdapter: failed to persist cloud outbox entry:',
                error
            );
        }
    }

    private async _restorePersistentOutboxIntoBridge(): Promise<void> {
        const records = await loadCloudOutboxRecords(this._assetId).catch(
            (error) => {
                console.warn(
                    'CloudAdapter: failed to load persistent cloud outbox:',
                    error
                );
                return [] as CloudDurableOutboxRecord[];
            }
        );

        if (!records.length) {
            this._emitPendingSyncCountChange();
            return;
        }

        for (const record of records) {
            this._durableOutboxEntries.set(record.clientTransactionId, record);
        }

        this._enqueuePendingDurabilityMessages(
            records.map((record) => record.collaborationMessage)
        );

        const bridge = this._bridge as
            | (PatchSyncEngine & {
                  getCollaborationLog?: () => Array<{ id?: string }>;
              })
            | null;
        const existingCollaborationIds = new Set(
            bridge
                ?.getCollaborationLog?.()
                ?.map((item) => item.id)
                .filter((item): item is string => typeof item === 'string') ??
                []
        );

        for (const record of records) {
            if (existingCollaborationIds.has(record.clientTransactionId)) {
                continue;
            }

            try {
                bridge?.applyRemoteUpdate(
                    base64ToU8(record.updateBase64),
                    undefined,
                    [record.collaborationMessage]
                );
                existingCollaborationIds.add(record.clientTransactionId);
            } catch (error) {
                console.warn(
                    'CloudAdapter: failed to rehydrate persistent outbox entry:',
                    error,
                    record.clientTransactionId
                );
            }
        }

        this._emitPendingSyncCountChange();
    }

    private _emitPendingSyncCountChange(): void {
        this._onPendingSyncCountChange?.(this.pendingSyncCount);
    }

    private _dropDurableTransactions(clientTransactionIds: string[]): void {
        if (!clientTransactionIds.length) {
            return;
        }

        const durableTransactionIds = new Set(clientTransactionIds);
        this._pendingDurabilityMessages =
            this._pendingDurabilityMessages.filter(
                (message) =>
                    !durableTransactionIds.has(collaborationMessageKey(message))
            );
        for (const clientTransactionId of durableTransactionIds) {
            this._durableOutboxEntries.delete(clientTransactionId);
        }
        this._emitPendingSyncCountChange();
        void deleteCloudOutboxRecords(
            this._assetId,
            clientTransactionIds
        ).catch((error) => {
            console.warn(
                'CloudAdapter: failed to prune cloud outbox entries:',
                error
            );
        });
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
                this._armAuthenticationTimeout(ws);
            };

            ws.onmessage = (event: MessageEvent) => {
                if (this._ws !== ws) return;
                this._lastInboundMessageAt = Date.now();
                this._handleMessage(event.data as string);
            };

            ws.onerror = () => {
                if (this._ws !== ws) return;
                console.warn('CloudAdapter: WebSocket error');
                this._setStatus(
                    'connecting',
                    `WebSocket error (${normalizedWsUrl})`
                );
            };

            ws.onclose = (event: CloseEvent) => {
                if (this._ws !== ws) return;
                console.log(
                    `CloudAdapter: closed (${event.code}: ${event.reason})`
                );
                this._clearAuthenticationTimeout();
                this._clientId = null;
                this._markVisibleRebaselineNeeded();
                this._hasSynced = false;
                this._lastInboundMessageAt = 0;
                this._incomingResponseChunks = null;
                this._initialServerStateApplied = false;
                this._initialSyncDurable = false;
                this._outboundFlushScheduled = false;
                this._pendingInboundUpdates = [];
                this._inboundFlushScheduled = false;
                this._localUpdateUnsubscribe?.();
                this._localUpdateUnsubscribe = null;
                if (event.reason === 'asset-deleted') {
                    this._setStatus('error', CLOUD_ASSET_DELETED_MESSAGE);
                    return;
                }
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
                this._clearAuthenticationTimeout();
                this._clearInitialSyncTimeout();
                this._clientId = String(msg.clientId ?? '');
                console.log(`CloudAdapter: authenticated as ${this._clientId}`);
                this._setStatus('syncing');
                this._armInitialSyncTimeout();
                this._initialServerStateApplied = false;
                this._initialSyncDurable = false;
                if (this._pendingOutboundPackets.length > 0) {
                    // The upcoming sync-request/sync-complete diff will carry
                    // the authoritative missing state, so stale pre-reconnect
                    // live packets should not be replayed ad hoc afterwards.
                    this._pendingOutboundPackets = [];
                }
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
                this._clearAuthenticationTimeout();
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
                    this._armInitialSyncTimeout();
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
                    this._armInitialSyncTimeout();
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
                    void this._maybeMarkInitialSyncConnected().catch(() => {});
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
                    this._armInitialSyncTimeout();
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
                        void this._maybeMarkInitialSyncConnected().catch(
                            () => {}
                        );
                    }
                }
                break;
            }

            case 'update-chunk': {
                this._accumulateIncomingLiveUpdateChunk(msg);
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

                    const update = this._consumeIncomingLiveUpdate(msg);
                    if (!update) {
                        break;
                    }

                    this._queueInboundUpdate({
                        update,
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
                    if (this._pendingSyncCompleteTransactionIds.length > 0) {
                        this._dropDurableTransactions(
                            this._pendingSyncCompleteTransactionIds
                        );
                        if (this._pendingSyncCompleteBroadcastEntryCount > 0) {
                            this._bridge?.advanceBroadcastLogCursor(
                                this._pendingSyncCompleteBroadcastEntryCount
                            );
                        }
                        this._clearPendingSyncCompleteTracking();
                    }
                    void this._maybeMarkInitialSyncConnected().catch(() => {});
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
                if (detail === 'Access epoch is stale') {
                    // Access-epoch bumps are expected during membership changes.
                    // Reconnect with a fresh room token without surfacing a user
                    // error unless the subsequent token fetch actually fails.
                    this._setStatus('connecting', detail);
                    this._ws?.close(
                        CLIENT_RECONNECT_CLOSE_CODE,
                        'server-access-change'
                    );
                } else if (
                    detail === 'Write access requires owner or editor role'
                ) {
                    this._setStatus('error', detail);
                    this._ws?.close(
                        CLIENT_RECONNECT_CLOSE_CODE,
                        'server-access-change'
                    );
                } else if (detail === CLOUD_ASSET_DELETED_MESSAGE) {
                    this._setStatus('error', detail);
                } else {
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

    private async _maybeMarkInitialSyncConnected(): Promise<void> {
        if (
            this._hasSynced &&
            this._initialServerStateApplied &&
            this._initialSyncDurable
        ) {
            this._clearInitialSyncTimeout();
            if (this._needsVisibleRebaseline) {
                if (!this._visibleRebaselinePromise) {
                    this._setStatus(
                        'syncing',
                        'Rebuilding visible state after reconnect'
                    );
                    this._visibleRebaselinePromise =
                        this._runVisibleReconnectRebaseline().finally(() => {
                            this._visibleRebaselinePromise = null;
                        });
                }
                await this._visibleRebaselinePromise;
            }
            this._setStatus('connected');
        }
    }

    private _markVisibleRebaselineNeeded(): void {
        if (
            this._hasSynced ||
            this._status === 'connected' ||
            this._status === 'syncing'
        ) {
            this._needsVisibleRebaseline = true;
        }
    }

    private async _runVisibleReconnectRebaseline(): Promise<void> {
        if (!this._needsVisibleRebaseline) {
            return;
        }

        const refreshed: CloudVisibleRebaselineTargets = {
            editingFontRecompiled: false,
            textPreviewReshaped: false,
            canvasRefreshed: false,
            overviewRefreshed: false,
            fontInfoRefreshed: false
        };

        try {
            if (
                typeof window.fontManager?.recompileEditingFont === 'function'
            ) {
                await window.fontManager.recompileEditingFont();
                refreshed.editingFontRecompiled = true;
            }

            const textRunEditor = window.glyphCanvas?.textRunEditor as
                | {
                      shapeText?: (skipRender?: boolean) => void;
                  }
                | undefined;
            if (typeof textRunEditor?.shapeText === 'function') {
                textRunEditor.shapeText();
                refreshed.textPreviewReshaped = true;
            }

            if (typeof window.syncRustCacheAndRefreshCanvas === 'function') {
                await window.syncRustCacheAndRefreshCanvas(
                    undefined,
                    undefined,
                    {
                        allowSelectedLayerFallback: true
                    }
                );
                refreshed.canvasRefreshed = true;
            }

            const glyphOverview = window.glyphOverviewInstance as
                | {
                      renderGlyphOutlines?: (
                          location?: Record<string, number>
                      ) => Promise<void>;
                      syncActiveGlyphFocus?: () => void;
                      currentLocation?: Record<string, number>;
                  }
                | null
                | undefined;
            if (typeof glyphOverview?.renderGlyphOutlines === 'function') {
                await glyphOverview.renderGlyphOutlines(
                    glyphOverview.currentLocation ?? {}
                );
                glyphOverview.syncActiveGlyphFocus?.();
                refreshed.overviewRefreshed = true;
            }

            if (
                typeof window.fontInfoManager
                    ?.refreshVisibleContentForExternalSync === 'function'
            ) {
                window.fontInfoManager.refreshVisibleContentForExternalSync();
                refreshed.fontInfoRefreshed = true;
            }
        } catch (error) {
            const detail =
                error instanceof Error ? error.message : String(error);
            console.warn(
                'CloudAdapter: reconnect visible rebaseline failed:',
                error,
                refreshed
            );
            this._setStatus('error', `Reconnect refresh failed: ${detail}`);
            throw error;
        }

        this._needsVisibleRebaseline = false;
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
            this._pendingSyncCompleteTransactionIds =
                pendingCollaborationMessages
                    .map((message) => collaborationMessageKey(message))
                    .filter(
                        (value): value is string => typeof value === 'string'
                    );
            this._pendingSyncCompleteBroadcastEntryCount =
                pendingCollaborationMessages.reduce(
                    (count, message) => count + message.changes.length,
                    0
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

    private _accumulateIncomingLiveUpdateChunk(
        msg: Record<string, unknown>
    ): void {
        const chunkKey = getLiveUpdateChunkKey(
            typeof msg.clientId === 'string' ? msg.clientId : null,
            typeof msg.seq === 'number' ? msg.seq : null
        );
        if (
            !chunkKey ||
            typeof msg.update !== 'string' ||
            !Number.isInteger(msg.chunkIndex) ||
            !Number.isInteger(msg.totalChunks) ||
            (msg.totalChunks as number) <= 1 ||
            (msg.chunkIndex as number) < 0 ||
            (msg.chunkIndex as number) >= (msg.totalChunks as number)
        ) {
            return;
        }

        let state = this._incomingLiveUpdateChunks.get(chunkKey);
        if (!state) {
            state = {
                chunks: new Array(msg.totalChunks as number),
                received: 0,
                total: msg.totalChunks as number
            };
            this._incomingLiveUpdateChunks.set(chunkKey, state);
        }

        const chunkIndex = msg.chunkIndex as number;
        if (!state.chunks[chunkIndex]) {
            state.received++;
        }
        state.chunks[chunkIndex] = base64ToU8(msg.update);
    }

    private _consumeIncomingLiveUpdate(
        msg: Record<string, unknown>
    ): Uint8Array | null {
        if (typeof msg.update !== 'string') {
            return null;
        }

        if (
            !Number.isInteger(msg.chunkIndex) ||
            !Number.isInteger(msg.totalChunks) ||
            (msg.totalChunks as number) <= 1 ||
            (msg.chunkIndex as number) < 0 ||
            (msg.chunkIndex as number) >= (msg.totalChunks as number)
        ) {
            return base64ToU8(msg.update);
        }

        const chunkKey = getLiveUpdateChunkKey(
            typeof msg.clientId === 'string' ? msg.clientId : null,
            typeof msg.seq === 'number' ? msg.seq : null
        );
        if (!chunkKey) {
            return null;
        }

        let state = this._incomingLiveUpdateChunks.get(chunkKey);
        if (!state) {
            state = {
                chunks: new Array(msg.totalChunks as number),
                received: 0,
                total: msg.totalChunks as number
            };
        }

        const chunkIndex = msg.chunkIndex as number;
        if (!state.chunks[chunkIndex]) {
            state.received++;
        }
        state.chunks[chunkIndex] = base64ToU8(msg.update);

        if (
            state.received !== state.total ||
            state.chunks.some((chunk) => !chunk)
        ) {
            this._incomingLiveUpdateChunks.set(chunkKey, state);
            return null;
        }

        this._incomingLiveUpdateChunks.delete(chunkKey);
        return this._mergeChunks(state.chunks as Uint8Array[]);
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
            this._enqueueOutboundPacket(update, collaborationMessage);
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
            return;
        }

        const packets = this._pendingOutboundPackets;
        this._pendingOutboundPackets = [];
        if (!packets.length) {
            return;
        }

        for (const packet of packets) {
            const seq = ++this._seq;
            const collaborationMessages = packet.collaborationMessage
                ? [packet.collaborationMessage]
                : [];
            const broadcastEntryCount = collaborationMessages.reduce(
                (count, message) => count + message.changes.length,
                0
            );
            const pendingTransactionIds = packet.clientTransactionId
                ? [packet.clientTransactionId]
                : [];

            if (broadcastEntryCount > 0) {
                this._outboundBroadcastEntryCounts.set(
                    seq,
                    broadcastEntryCount
                );
            }
            if (pendingTransactionIds.length) {
                this._outboundPendingTransactionIds.set(
                    seq,
                    pendingTransactionIds
                );
                this._outboundAckSentAtBySeq.set(seq, Date.now());
                this._armOutboundAckTimeout();
            }

            (
                window as Window & {
                    __lastCloudOutboundUpdateBase64?: string;
                    __lastCloudOutboundUpdateSeq?: number;
                }
            ).__lastCloudOutboundUpdateBase64 = u8ToBase64(packet.update);
            (
                window as Window & {
                    __lastCloudOutboundUpdateBase64?: string;
                    __lastCloudOutboundUpdateSeq?: number;
                }
            ).__lastCloudOutboundUpdateSeq = seq;

            const totalChunks = Math.ceil(
                packet.update.length / SYNC_CHUNK_SIZE
            );
            for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
                const isLast = chunkIndex === totalChunks - 1;
                const chunk = packet.update.slice(
                    chunkIndex * SYNC_CHUNK_SIZE,
                    (chunkIndex + 1) * SYNC_CHUNK_SIZE
                );
                const frame: Record<string, unknown> = {
                    type: isLast ? 'update' : 'update-chunk',
                    update: u8ToBase64(chunk),
                    clientId: this._clientId ?? '',
                    seq
                };
                if (packet.clientTransactionId) {
                    frame.clientTransactionId = packet.clientTransactionId;
                }
                if (totalChunks > 1) {
                    frame.chunkIndex = chunkIndex;
                    frame.totalChunks = totalChunks;
                }
                if (isLast && collaborationMessages.length) {
                    frame.collaborationMessages = collaborationMessages;
                }
                this._ws.send(JSON.stringify(frame));
            }
        }
    }

    private _recordDurableAck(seq: number): void {
        const broadcastEntryCount =
            this._outboundBroadcastEntryCounts.get(seq) ?? 0;
        this._outboundBroadcastEntryCounts.delete(seq);
        const pendingTransactionIds =
            this._outboundPendingTransactionIds.get(seq) ?? [];
        this._outboundPendingTransactionIds.delete(seq);
        this._outboundAckSentAtBySeq.delete(seq);
        this._dropDurableTransactions(pendingTransactionIds);
        this._armOutboundAckTimeout();

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
        this._dropDurableTransactions(Array.from(durableTransactions));
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
            cache: 'no-store',
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

    private _resetLiveAckTracking(): void {
        this._clearOutboundAckTimeout();
        this._outboundBroadcastEntryCounts.clear();
        this._outboundPendingTransactionIds.clear();
        this._outboundAckSentAtBySeq.clear();
    }

    private _armInitialSyncTimeout(): void {
        this._clearInitialSyncTimeout();
        this._initialSyncTimer = setTimeout(() => {
            this._initialSyncTimer = null;
            this._handleInitialSyncTimeout();
        }, INITIAL_SYNC_TIMEOUT_MS);
    }

    private _clearInitialSyncTimeout(): void {
        if (this._initialSyncTimer !== null) {
            clearTimeout(this._initialSyncTimer);
            this._initialSyncTimer = null;
        }
    }

    private _clearPendingSyncCompleteTracking(): void {
        this._pendingSyncCompleteTransactionIds = [];
        this._pendingSyncCompleteBroadcastEntryCount = 0;
    }

    private _armOutboundAckTimeout(delayOverrideMs?: number): void {
        this._clearOutboundAckTimeout();
        const oldestPendingEntry = this._outboundAckSentAtBySeq
            .entries()
            .next().value;
        if (!oldestPendingEntry) {
            return;
        }

        const [seq, sentAt] = oldestPendingEntry as [number, number];
        const delayMs = Math.max(
            0,
            delayOverrideMs ?? OUTBOUND_ACK_TIMEOUT_MS - (Date.now() - sentAt)
        );
        this._outboundAckTimer = setTimeout(() => {
            this._outboundAckTimer = null;
            if (!this._outboundAckSentAtBySeq.has(seq)) {
                this._armOutboundAckTimeout();
                return;
            }
            this._handleOutboundAckTimeout(seq);
        }, delayMs);
    }

    private _clearOutboundAckTimeout(): void {
        if (this._outboundAckTimer !== null) {
            clearTimeout(this._outboundAckTimer);
            this._outboundAckTimer = null;
        }
    }

    private _handleInitialSyncTimeout(): void {
        if (
            this._destroyed ||
            this._status !== 'syncing' ||
            !this._ws ||
            this._ws.readyState !== WebSocket.OPEN
        ) {
            return;
        }

        if (
            this._hasSynced &&
            this._initialServerStateApplied &&
            this._initialSyncDurable
        ) {
            return;
        }

        const detail = 'Cloud initial sync timed out';
        console.warn(`CloudAdapter: ${detail}`);
        this._clearAuthenticationTimeout();
        this._clearInitialSyncTimeout();
        this._setStatus('connecting', detail);
        this._markVisibleRebaselineNeeded();
        this._incomingResponseChunks = null;
        this._initialServerStateApplied = false;
        this._initialSyncDurable = false;

        const ws = this._ws;
        if (ws) {
            this._ws = null;
            this._clientId = null;
            ws.close(CLIENT_RECONNECT_CLOSE_CODE, 'sync-timeout');
        }
        this._scheduleReconnect();
    }

    private _handleOutboundAckTimeout(seq: number): void {
        if (
            this._destroyed ||
            !this._outboundAckSentAtBySeq.has(seq) ||
            (this._status !== 'connected' && this._status !== 'syncing')
        ) {
            this._armOutboundAckTimeout();
            return;
        }

        const sentAt = this._outboundAckSentAtBySeq.get(seq);
        if (typeof sentAt !== 'number') {
            this._armOutboundAckTimeout();
            return;
        }

        const ackAgeMs = Date.now() - sentAt;
        const inboundActivitySeen = this._lastInboundMessageAt > sentAt;
        const inboundQuietMs = inboundActivitySeen
            ? Date.now() - this._lastInboundMessageAt
            : Number.POSITIVE_INFINITY;
        if (
            inboundActivitySeen &&
            inboundQuietMs < OUTBOUND_ACK_TIMEOUT_MS &&
            ackAgeMs < OUTBOUND_ACK_MAX_WAIT_MS
        ) {
            const nextCheckDelayMs = Math.min(
                OUTBOUND_ACK_TIMEOUT_MS - inboundQuietMs,
                OUTBOUND_ACK_MAX_WAIT_MS - ackAgeMs
            );
            this._armOutboundAckTimeout(nextCheckDelayMs);
            return;
        }

        const detail = 'Cloud update acknowledgement timed out';
        console.warn(`CloudAdapter: ${detail}`);
        this._clearAuthenticationTimeout();
        this._clearOutboundAckTimeout();
        this._resetLiveAckTracking();
        this._setStatus('connecting', detail);
        this._markVisibleRebaselineNeeded();
        this._incomingResponseChunks = null;
        this._initialServerStateApplied = false;
        this._initialSyncDurable = false;
        this._pendingInboundUpdates = [];
        this._inboundFlushScheduled = false;

        const ws = this._ws;
        if (ws) {
            this._ws = null;
            this._clientId = null;
            ws.close(CLIENT_RECONNECT_CLOSE_CODE, 'ack-timeout');
        }
        this._scheduleReconnect();
    }

    private _armAuthenticationTimeout(ws: WebSocket): void {
        this._clearAuthenticationTimeout();
        this._authenticationTimer = setTimeout(() => {
            if (
                this._destroyed ||
                this._ws !== ws ||
                this._status !== 'authenticating'
            ) {
                return;
            }

            const detail = 'Cloud room authentication timed out';
            console.warn(`CloudAdapter: ${detail}`);
            this._setStatus('connecting', detail);
            if (this._ws === ws) {
                // Do not wait for a possibly delayed close event before retrying.
                // Once auth has stalled, this socket is no longer the active path.
                this._ws = null;
                this._clientId = null;
            }
            ws.close(CLIENT_RECONNECT_CLOSE_CODE, 'auth-timeout');
            this._scheduleReconnect();
        }, AUTHENTICATION_TIMEOUT_MS);
    }

    private _clearAuthenticationTimeout(): void {
        if (this._authenticationTimer !== null) {
            clearTimeout(this._authenticationTimer);
            this._authenticationTimer = null;
        }
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
                    role?: CloudAssetRole;
                    connectedPeers?: number;
                }>;
            };
            const items: Record<string, FileInfo> = {};
            this._assetRoles.clear();
            for (const asset of data.assets ?? []) {
                if (asset.role) {
                    this._assetRoles.set(asset.id, asset.role);
                }
                const displayName = asset.name.endsWith('.babelfont')
                    ? asset.name
                    : `${asset.name}.babelfont`;
                items[displayName] = {
                    path: `cloud://${asset.id}`,
                    is_dir: false,
                    mtime: new Date(asset.updatedAt).toISOString(),
                    ...(asset.role ? { cloudRole: asset.role } : {}),
                    ...(typeof asset.connectedPeers === 'number'
                        ? { cloudConnectedPeers: asset.connectedPeers }
                        : {})
                };
            }
            return items;
        } catch {
            return {};
        }
    }

    getCachedAssetRole(assetId: string): CloudAssetRole | null {
        return this._assetRoles.get(assetId) ?? null;
    }

    cacheAssetRole(assetId: string, role: CloudAssetRole | null | undefined) {
        if (!assetId) {
            return;
        }
        if (!role) {
            this._assetRoles.delete(assetId);
            return;
        }
        this._assetRoles.set(assetId, role);
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
