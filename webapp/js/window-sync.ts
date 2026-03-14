/**
 * WindowSync — BroadcastChannel management for cross-window font syncing.
 *
 * Each editor window creates a WindowSync, which bridges the local
 * ChangeBridge ↔ BroadcastChannel. When a new window opens it requests
 * the full Y.Doc state; existing windows respond.
 */

import type { ChangeBridge } from './change-bridge';
import type { ChangeLogEntry } from './change-log';
import { Logger } from './logger';

const console = new Logger('WindowSync');

// ── Protocol message types ──────────────────────────────────────────

interface YjsUpdateMsg {
    type: 'yjs-update';
    update: number[]; // Uint8Array serialised as number[]
    windowId: string;
    changeLogEntries?: ChangeLogEntry[];
}

interface FullStateRequestMsg {
    type: 'full-state-request';
    windowId: string;
}

interface FullStateResponseMsg {
    type: 'full-state-response';
    state: number[];
    changeLog: ChangeLogEntry[];
    windowId: string;
}

interface WindowClosingMsg {
    type: 'window-closing';
    windowId: string;
}

type SyncMessage =
    | YjsUpdateMsg
    | FullStateRequestMsg
    | FullStateResponseMsg
    | WindowClosingMsg;

// ── WindowSync class ────────────────────────────────────────────────

export class WindowSync {
    private _channel: BroadcastChannel | null = null;
    private _bridge: ChangeBridge;
    private _peers = new Set<string>();
    private _awaitingFullState = false;
    private _hasAppliedFullState = false;

    constructor(bridge: ChangeBridge, channelName: string) {
        this._bridge = bridge;

        if (typeof BroadcastChannel !== 'undefined') {
            this._channel = new BroadcastChannel(channelName);
            this._channel.onmessage = (ev: MessageEvent<SyncMessage>) => {
                this._handleMessage(ev.data);
            };

            // Wire bridge's local updates to broadcast
            bridge.onLocalUpdate((update) => {
                this._send({
                    type: 'yjs-update',
                    update: Array.from(update),
                    windowId: bridge.windowId,
                    changeLogEntries: bridge.getNewChangeLogEntries()
                });
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

    /** Get the set of known peer window IDs. */
    get peers(): ReadonlySet<string> {
        return this._peers;
    }

    /** Clean up. */
    destroy(): void {
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

    private _handleMessage(msg: SyncMessage): void {
        switch (msg.type) {
            case 'yjs-update':
                if (msg.windowId === this._bridge.windowId) return;
                this._peers.add(msg.windowId);
                this._bridge.applyRemoteUpdate(
                    new Uint8Array(msg.update),
                    msg.changeLogEntries
                );
                break;

            case 'full-state-request':
                if (msg.windowId === this._bridge.windowId) return;
                this._peers.add(msg.windowId);
                // Respond with our full state
                const state = this._bridge.getFullState();
                this._send({
                    type: 'full-state-response',
                    state: Array.from(state),
                    changeLog: this._bridge.getChangeLog(),
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
                this._bridge.applyFullState(new Uint8Array(msg.state));
                break;

            case 'window-closing':
                this._peers.delete(msg.windowId);
                break;
        }
    }
}
