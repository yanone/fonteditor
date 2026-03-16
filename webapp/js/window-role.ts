import { Logger } from './logger';

const console = new Logger('WindowRole');

const LINKED_QUERY_PARAM = 'linked';
const SESSION_QUERY_PARAM = 'windowSession';
const SESSION_STORAGE_KEY = 'counterpunch-window-role-session-id';

function createId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseLinkedOrdinal(value: string | null): number | null {
    if (!value) {
        return null;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export class WindowRoleManager {
    readonly instanceId: string;
    readonly sessionId: string;
    readonly linkedOrdinal: number | null;
    private _fallbackCounter = 0;

    constructor() {
        const params = new URLSearchParams(window.location.search);
        this.instanceId = createId();
        this.sessionId = this._resolveSessionId(
            params.get(SESSION_QUERY_PARAM)
        );
        this.linkedOrdinal = parseLinkedOrdinal(params.get(LINKED_QUERY_PARAM));

        console.log('Window role initialized', {
            instanceId: this.instanceId,
            sessionId: this.sessionId,
            linkedOrdinal: this.linkedOrdinal,
            role: this.getRoleLabel()
        });
    }

    isMainWindow(): boolean {
        return this.linkedOrdinal === null;
    }

    isLinkedWindow(): boolean {
        return this.linkedOrdinal !== null;
    }

    getRoleLabel(): string {
        return this.isMainWindow() ? 'Main' : `Linked ${this.linkedOrdinal}`;
    }

    getTitleSuffix(): string {
        return `(${this.getRoleLabel()})`;
    }

    allocateLinkedOrdinal(fontPath?: string): number {
        const storageKey = this._getCounterStorageKey(fontPath || 'unsaved');
        try {
            const currentValue = Number.parseInt(
                localStorage.getItem(storageKey) || '0',
                10
            );
            const nextValue =
                Number.isFinite(currentValue) && currentValue > 0
                    ? currentValue + 1
                    : 1;
            localStorage.setItem(storageKey, String(nextValue));
            return nextValue;
        } catch {
            this._fallbackCounter += 1;
            return this._fallbackCounter;
        }
    }

    configureLinkedWindowUrl(url: URL, fontPath?: string): URL {
        url.searchParams.set('sync', 'true');
        url.searchParams.set(
            LINKED_QUERY_PARAM,
            String(this.allocateLinkedOrdinal(fontPath))
        );
        url.searchParams.set(SESSION_QUERY_PARAM, this.sessionId);
        return url;
    }

    private _resolveSessionId(paramSessionId: string | null): string {
        if (paramSessionId) {
            return paramSessionId;
        }

        try {
            const stored = sessionStorage.getItem(SESSION_STORAGE_KEY);
            if (stored) {
                return stored;
            }
            const created = createId();
            sessionStorage.setItem(SESSION_STORAGE_KEY, created);
            return created;
        } catch {
            return createId();
        }
    }

    private _getCounterStorageKey(fontPath: string): string {
        return `counterpunch-linked-window-counter:${this.sessionId}:${encodeURIComponent(fontPath)}`;
    }
}

export const windowRole = window.windowRole ?? new WindowRoleManager();
window.windowRole = windowRole;
