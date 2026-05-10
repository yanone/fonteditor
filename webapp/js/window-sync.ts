/**
 * WindowSync — BroadcastChannel management for cross-window font syncing.
 *
 * Each editor window creates a WindowSync, which bridges the local
 * PatchSyncEngine ↔ BroadcastChannel. When a new window opens it requests
 * the full Y.Doc state; existing windows respond.
 */

import type { PatchSyncEngine } from './patch-sync-engine';
import type { ChangeLogEntry } from './change-log';
import { Logger } from './logger';
import type { CollaborationLogItem } from './patch-sync-engine';
import type { CollaborationMessageEnvelope } from './collaboration-message';

const console = new Logger('WindowSync');

type BinaryPayload = number[] | Uint8Array | ArrayBuffer;

type YjsUpdatePacket = {
    update: BinaryPayload;
    collaborationMessage?: CollaborationMessageEnvelope;
};

// ── Protocol message types ──────────────────────────────────────────

interface YjsUpdateMsg {
    type: 'yjs-update';
    updates: YjsUpdatePacket[];
    windowId: string;
}

interface FullStateRequestMsg {
    type: 'full-state-request';
    windowId: string;
}

interface FullStateResponseMsg {
    type: 'full-state-response';
    state: BinaryPayload;
    changeLog: ChangeLogEntry[];
    collaborationLog: CollaborationLogItem[];
    windowId: string;
}

interface WindowClosingMsg {
    type: 'window-closing';
    windowId: string;
}

interface MainWindowClosingMsg {
    type: 'main-window-closing';
    windowId: string;
}

type SyncMessage =
    | YjsUpdateMsg
    | FullStateRequestMsg
    | FullStateResponseMsg
    | WindowClosingMsg
    | MainWindowClosingMsg;

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
            windowId: this._bridge.windowId
        });
    }

    /** Announce that this window is closing. */
    announceClose(): void {
        this._send({
            type: 'window-closing',
            windowId: this._bridge.windowId
        });
    }

    announceMainWindowClosing(): void {
        this._send({
            type: 'main-window-closing',
            windowId: this._bridge.windowId
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
        this._send({
            type: 'yjs-update',
            updates: packets,
            windowId: this._bridge.windowId
        });
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
                    windowId: this._bridge.windowId
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
                // Import change log before applying state so the
                // onRemoteChange callback (fired by applyFullState)
                // sees the complete log.
                this._bridge.importChangeLog(msg.changeLog);
                this._bridge.importCollaborationMessages(
                    msg.collaborationLog ?? []
                );
                this._bridge.applyFullState(toUint8Array(msg.state));
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
