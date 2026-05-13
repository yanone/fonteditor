/**
 * WindowSync — BroadcastChannel management for cross-window font syncing.
 *
 * Each editor window creates a WindowSync, which bridges the local
 * PatchSyncEngine ↔ BroadcastChannel. When a new window opens it requests
 * the full Y.Doc state; existing windows respond.
 */

import type { PatchSyncEngine } from './patch-sync-engine';
import type { ChangeLogEntry } from './change-log';
import { seedInterpolationRustCacheFromState } from './babelfont-model';
import { Logger } from './logger';
import type { CollaborationLogItem } from './patch-sync-engine';
import type { CollaborationMessageEnvelope } from './collaboration-message';

const console = new Logger('WindowSync');

type BinaryPayload = number[] | Uint8Array | ArrayBuffer;

type YjsUpdatePacket = {
    update: BinaryPayload;
    collaborationMessage?: CollaborationMessageEnvelope;
};

type CloudConnectionRelayState = {
    assetId: string | null;
    status: string;
    detail?: string;
};

// ── Protocol message types ──────────────────────────────────────────

interface YjsUpdateMsg {
    type: 'yjs-update';
    updates: YjsUpdatePacket[];
    windowId: string;
    sessionId: string;
}

interface FullStateRequestMsg {
    type: 'full-state-request';
    windowId: string;
    sessionId: string;
}

interface FullStateResponseMsg {
    type: 'full-state-response';
    state: BinaryPayload;
    changeLog: ChangeLogEntry[];
    collaborationLog: CollaborationLogItem[];
    cloudRelayState?: CloudConnectionRelayState;
    windowId: string;
    sessionId: string;
}

interface WindowClosingMsg {
    type: 'window-closing';
    windowId: string;
    sessionId: string;
}

interface MainWindowClosingMsg {
    type: 'main-window-closing';
    windowId: string;
    sessionId: string;
}

interface CloudConnectionStatusMsg {
    type: 'cloud-connection-status';
    state: CloudConnectionRelayState;
    windowId: string;
    sessionId: string;
}

type SyncMessage =
    | YjsUpdateMsg
    | FullStateRequestMsg
    | FullStateResponseMsg
    | WindowClosingMsg
    | MainWindowClosingMsg
    | CloudConnectionStatusMsg;

// ── WindowSync class ────────────────────────────────────────────────

export class WindowSync {
    private static _timingLoggingEnabled = false;
    private _channel: BroadcastChannel | null = null;
    private _bridge: PatchSyncEngine;
    private _peers = new Set<string>();
    private _awaitingFullState = false;
    private _hasAppliedFullState = false;
    private _mainWindowClosingListeners = new Set<() => void>();
    private _pendingOutboundPackets: YjsUpdatePacket[] = [];
    private _outboundFlushScheduled = false;
    private _pendingYjsMessages: YjsUpdateMsg[] = [];
    private _inboundFlushScheduled = false;
    private _sessionId: string;

    static enableTimingLogging(): void {
        WindowSync._timingLoggingEnabled = true;
        console.log('Timing logging enabled');
    }

    static disableTimingLogging(): void {
        WindowSync._timingLoggingEnabled = false;
        console.log('Timing logging disabled');
    }

    constructor(bridge: PatchSyncEngine, channelName: string) {
        this._bridge = bridge;
        this._sessionId = window.windowRole?.sessionId ?? 'main';

        if (typeof BroadcastChannel !== 'undefined') {
            this._channel = new BroadcastChannel(channelName);
            this._channel.onmessage = (ev: MessageEvent<SyncMessage>) => {
                this._handleMessage(ev.data);
            };

            // Wire bridge's local updates to broadcast. The broadcast itself is
            // microtask-batched so a single user transaction that emits several
            // Yjs updates produces one channel message and one receiver refresh.
            bridge.onLocalUpdate((_update, collaborationMessage) => {
                this._queueOutboundBroadcast(_update, collaborationMessage);
            });
        }
    }

    /**
     * Request the full state from an existing peer window.
     * Call this when a new window opens with `sync=true`.
     */
    requestFullState(): void {
        this._awaitingFullState = true;
        this._hasAppliedFullState = false;
        this._send({
            type: 'full-state-request',
            windowId: this._bridge.windowId,
            sessionId: this._sessionId
        });
    }

    /** Announce that this window is closing. */
    announceClose(): void {
        this._send({
            type: 'window-closing',
            windowId: this._bridge.windowId,
            sessionId: this._sessionId
        });
    }

    announceMainWindowClosing(): void {
        this._send({
            type: 'main-window-closing',
            windowId: this._bridge.windowId,
            sessionId: this._sessionId
        });
    }

    broadcastCloudRelayUpdate(
        update: Uint8Array,
        collaborationMessage?: CollaborationMessageEnvelope | null
    ): void {
        this._sendYjsUpdate([
            {
                update,
                ...(collaborationMessage ? { collaborationMessage } : undefined)
            }
        ]);
    }

    broadcastCloudConnectionStatus(state: CloudConnectionRelayState): void {
        this._send({
            type: 'cloud-connection-status',
            state,
            windowId: this._bridge.windowId,
            sessionId: this._sessionId
        });
    }

    onMainWindowClosing(callback: () => void): () => void {
        this._mainWindowClosingListeners.add(callback);
        return () => {
            this._mainWindowClosingListeners.delete(callback);
        };
    }

    /** Get the set of known peer window IDs. */
    get peers(): ReadonlySet<string> {
        return this._peers;
    }

    /** Clean up. */
    destroy(): void {
        this._flushOutboundBroadcast();
        this.announceClose();
        this._channel?.close();
        this._channel = null;
    }

    // ── Internal ─────────────────────────────────────────────────

    private _send(msg: SyncMessage): void {
        try {
            this._channel?.postMessage(msg);
        } catch {
            // Channel may be closed
        }
    }

    private _queueOutboundBroadcast(
        update: Uint8Array,
        collaborationMessage?: CollaborationMessageEnvelope | null
    ): void {
        this._pendingOutboundPackets.push({
            update,
            ...(collaborationMessage ? { collaborationMessage } : undefined)
        });
        if (this._outboundFlushScheduled) {
            return;
        }
        this._outboundFlushScheduled = true;
        queueMicrotask(() => this._flushOutboundBroadcast());
    }

    private _flushOutboundBroadcast(): void {
        if (!this._outboundFlushScheduled) {
            return;
        }
        this._outboundFlushScheduled = false;
        const packets = this._pendingOutboundPackets;
        this._pendingOutboundPackets = [];
        if (!packets.length) {
            return;
        }

        const startTime = performance.now?.() ?? Date.now();
        this._sendYjsUpdate(packets);
        this._logTiming('outbound-yjs-update', {
            updateCount: packets.length,
            collaborationMessageCount: packets.filter(
                (packet) => !!packet.collaborationMessage
            ).length,
            updateBytes: packets.reduce(
                (total, packet) =>
                    total + toUint8Array(packet.update).byteLength,
                0
            ),
            peerCount: this._peers.size,
            durationMs: this._elapsed(startTime)
        });
    }

    private _sendYjsUpdate(packets: YjsUpdatePacket[]): void {
        this._send({
            type: 'yjs-update',
            updates: packets,
            windowId: this._bridge.windowId,
            sessionId: this._sessionId
        });
    }

    private _queueYjsUpdate(msg: YjsUpdateMsg): void {
        this._pendingYjsMessages.push(msg);
        if (this._inboundFlushScheduled) {
            return;
        }
        this._inboundFlushScheduled = true;
        queueMicrotask(() => this._flushPendingYjsUpdates());
    }

    private _flushPendingYjsUpdates(): void {
        if (!this._inboundFlushScheduled) {
            return;
        }
        this._inboundFlushScheduled = false;
        const messages = this._pendingYjsMessages;
        this._pendingYjsMessages = [];
        if (!messages.length) {
            return;
        }

        const startTime = performance.now?.() ?? Date.now();
        let updateBytes = 0;
        let collaborationMessageCount = 0;
        for (const msg of messages) {
            for (const packet of msg.updates) {
                const update = toUint8Array(packet.update);
                updateBytes += update.byteLength;
                if (packet.collaborationMessage) {
                    collaborationMessageCount += 1;
                }
                this._bridge.applyRemoteUpdate(
                    update,
                    undefined,
                    packet.collaborationMessage
                        ? [packet.collaborationMessage]
                        : undefined
                );
                if (window.windowRole?.isMainWindow()) {
                    window.cloudPlugin?.relayPeerWindowUpdateToCloud?.(
                        update,
                        packet.collaborationMessage ?? null
                    );
                }
            }
        }
        this._logTiming('inbound-yjs-update', {
            messageCount: messages.length,
            collaborationMessageCount,
            updateBytes,
            durationMs: this._elapsed(startTime)
        });
    }

    private _elapsed(startTime: number): number {
        const now = performance.now?.() ?? Date.now();
        return Math.round((now - startTime) * 10) / 10;
    }

    private _logTiming(label: string, detail: Record<string, unknown>): void {
        if (!WindowSync._timingLoggingEnabled) {
            return;
        }
        console.log(label, detail);
    }

    private _handleMessage(msg: SyncMessage): void {
        if (msg.sessionId !== this._sessionId) {
            return;
        }

        switch (msg.type) {
            case 'yjs-update':
                if (msg.windowId === this._bridge.windowId) return;
                this._peers.add(msg.windowId);
                this._queueYjsUpdate(msg);
                break;

            case 'full-state-request':
                if (msg.windowId === this._bridge.windowId) return;
                this._peers.add(msg.windowId);
                // Respond with our full state
                const state = this._bridge.getFullState();
                this._send({
                    type: 'full-state-response',
                    state,
                    changeLog: this._bridge.getChangeLog(),
                    collaborationLog: this._bridge.getCollaborationLog(),
                    cloudRelayState:
                        window.windowRole?.isMainWindow() &&
                        window.cloudPlugin?.getRelayConnectionState
                            ? window.cloudPlugin.getRelayConnectionState()
                            : undefined,
                    windowId: this._bridge.windowId,
                    sessionId: this._sessionId
                });
                break;

            case 'full-state-response':
                if (msg.windowId === this._bridge.windowId) return;
                this._peers.add(msg.windowId);
                if (!this._awaitingFullState || this._hasAppliedFullState) {
                    return;
                }
                this._hasAppliedFullState = true;
                this._awaitingFullState = false;
                const fullState = toUint8Array(msg.state);
                // Import change log before applying state so the
                // onRemoteChange callback (fired by applyFullState)
                // sees the complete log.
                this._bridge.importChangeLog(msg.changeLog);
                this._bridge.importCollaborationMessages(
                    msg.collaborationLog ?? []
                );
                this._bridge.applyFullState(fullState);
                const fontCompilation = window.fontCompilation;
                if (fontCompilation) {
                    const fontManager = window.fontManager as
                        | (typeof window.fontManager & {
                              syncBabelfontJsonFromCurrentModel?: () => boolean;
                              buildNormalizedWorkerYjsState?: () => Uint8Array | null;
                          })
                        | undefined;

                    void (async () => {
                        const initialized = fontCompilation.isInitialized
                            ? true
                            : await fontCompilation.initialize();
                        if (!initialized) {
                            throw new Error(
                                'Font compilation worker not initialized for linked-window bootstrap'
                            );
                        }

                        if (!fontManager?.currentFont) {
                            throw new Error(
                                'No font loaded for linked-window worker bootstrap'
                            );
                        }

                        const synced =
                            fontManager.syncBabelfontJsonFromCurrentModel?.();
                        if (synced === false) {
                            throw new Error(
                                'Failed to sync linked-window font JSON from full-state response'
                            );
                        }

                        // Build a Rust-compatible seed state (string-format nodes).
                        // The raw bridge fullState uses array-format nodes that Rust
                        // cannot parse when rebuilding CANONICAL_JSON_CACHE via
                        // ydoc_get_glyph_json after apply_yjs_update.
                        const normalizedState =
                            fontManager.buildNormalizedWorkerYjsState?.();
                        if (!normalizedState?.length) {
                            throw new Error(
                                'Failed to build normalized worker Yjs state for linked-window bootstrap'
                            );
                        }

                        fontManager.recordFullFontCrossing?.();
                        fontManager.replaceWorkerYjsMirrorFromState?.(
                            normalizedState
                        );
                        await seedInterpolationRustCacheFromState(
                            normalizedState
                        );
                        await fontCompilation.sendMessage({
                            type: 'storeFontJson',
                            babelfontJson: fontManager.currentFont.babelfontJson
                        });
                        await fontCompilation.sendMessage({
                            type: 'seedYdoc',
                            state: normalizedState
                        });
                    })().catch((error: unknown) => {
                        console.warn(
                            'Failed to bootstrap worker state from full-state response',
                            error
                        );
                        window.fontCompilation?.setWorkerCacheDocumentReady?.(
                            false
                        );
                    });
                }
                if (msg.cloudRelayState) {
                    window.cloudPlugin?.applyRelayedConnectionState?.(
                        msg.cloudRelayState
                    );
                }
                break;

            case 'window-closing':
                this._peers.delete(msg.windowId);
                break;

            case 'main-window-closing':
                if (msg.windowId === this._bridge.windowId) return;
                for (const callback of this._mainWindowClosingListeners) {
                    callback();
                }
                break;

            case 'cloud-connection-status':
                if (msg.windowId === this._bridge.windowId) return;
                window.cloudPlugin?.applyRelayedConnectionState?.(msg.state);
                break;
        }
    }
}

function toUint8Array(payload: BinaryPayload): Uint8Array {
    if (payload instanceof Uint8Array) {
        return payload;
    }
    if (Array.isArray(payload)) {
        return new Uint8Array(payload);
    }
    return new Uint8Array(payload);
}
