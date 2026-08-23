import { Logger } from './logger';

const console = new Logger('WindowRole');

const LINKED_QUERY_PARAM = 'linked';
const SESSION_QUERY_PARAM = 'windowSession';
const SESSION_STORAGE_KEY = 'windowRoleSessionId';
const OCCUPANCY_STALE_MS = 10_000;
const OCCUPANCY_HEARTBEAT_MS = 2_000;

type LinkedOrdinalOccupancy = {
    instanceId: string;
    updatedAt: number;
};

type OccupancyMap = Record<string, LinkedOrdinalOccupancy>;

const fallbackOccupancyByKey = new Map<string, OccupancyMap>();

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

function isOccupancyEntry(value: unknown): value is LinkedOrdinalOccupancy {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const entry = value as Partial<LinkedOrdinalOccupancy>;
    return (
        typeof entry.instanceId === 'string' &&
        entry.instanceId.length > 0 &&
        typeof entry.updatedAt === 'number' &&
        Number.isFinite(entry.updatedAt)
    );
}

function parseOccupancyMap(raw: string | null): OccupancyMap {
    if (!raw) {
        return {};
    }
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }
        const occupancy: OccupancyMap = {};
        for (const [ordinal, entry] of Object.entries(
            parsed as Record<string, unknown>
        )) {
            if (parseLinkedOrdinal(ordinal) && isOccupancyEntry(entry)) {
                occupancy[ordinal] = entry;
            }
        }
        return occupancy;
    } catch {
        return {};
    }
}

function lowestFreeOrdinal(used: Iterable<number>): number {
    const occupied = new Set(used);
    let next = 1;
    while (occupied.has(next)) {
        next += 1;
    }
    return next;
}

export class WindowRoleManager {
    readonly instanceId: string;
    readonly sessionId: string;
    readonly linkedOrdinal: number | null;
    private _heartbeatTimer: number | null = null;
    private _lifecycleBound = false;

    constructor() {
        const params = new URLSearchParams(window.location.search);
        this.instanceId = createId();
        this.sessionId = this._resolveSessionId(
            params.get(SESSION_QUERY_PARAM)
        );
        this.linkedOrdinal = parseLinkedOrdinal(params.get(LINKED_QUERY_PARAM));

        if (this.linkedOrdinal !== null) {
            this.claimLinkedOrdinal(this.linkedOrdinal);
            this._bindOccupancyLifecycle();
        }

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

    /**
     * Reserve the lowest live linked ordinal for a new window.
     * Closed or stale slots are reused so the first extra window is
     * always Linked 1 when none are open.
     */
    allocateLinkedOrdinal(_fontPath?: string): number {
        const live = this._readLiveOccupancy();
        const nextValue = lowestFreeOrdinal(
            Object.keys(live).map((ordinal) => Number.parseInt(ordinal, 10))
        );
        this._writeOccupancyEntry(nextValue, Date.now());
        return nextValue;
    }

    claimLinkedOrdinal(ordinal: number): void {
        if (!Number.isFinite(ordinal) || ordinal <= 0) {
            return;
        }
        this._writeOccupancyEntry(ordinal, Date.now());
    }

    /**
     * Drop a claim on an ordinal. Own claims are always dropped.
     * `force` is for the opener when it can see `Window.closed`.
     */
    releaseLinkedOrdinal(ordinal: number, force = false): void {
        if (!Number.isFinite(ordinal) || ordinal <= 0) {
            return;
        }
        const occupancy = this._readOccupancy();
        const key = String(ordinal);
        const entry = occupancy[key];
        if (!entry) {
            return;
        }
        if (!force && entry.instanceId !== this.instanceId) {
            return;
        }
        delete occupancy[key];
        this._persistOccupancy(occupancy);
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

    /**
     * Live linked-window ordinal claims for this editing session.
     * Key is `linkedWindowOccupancy.${sessionId}`.
     */
    private _getOccupancyStorageKey(): string {
        return `linkedWindowOccupancy.${this.sessionId}`;
    }

    private _readOccupancy(): OccupancyMap {
        const storageKey = this._getOccupancyStorageKey();
        try {
            return parseOccupancyMap(
                localStorage.getItem(`linkedWindowOccupancy.${this.sessionId}`)
            );
        } catch {
            return { ...(fallbackOccupancyByKey.get(storageKey) || {}) };
        }
    }

    private _readLiveOccupancy(now = Date.now()): OccupancyMap {
        const occupancy = this._readOccupancy();
        const live: OccupancyMap = {};
        for (const [ordinal, entry] of Object.entries(occupancy)) {
            if (now - entry.updatedAt <= OCCUPANCY_STALE_MS) {
                live[ordinal] = entry;
            }
        }
        return live;
    }

    private _writeOccupancyEntry(ordinal: number, updatedAt: number): void {
        const occupancy = this._readLiveOccupancy(updatedAt);
        occupancy[String(ordinal)] = {
            instanceId: this.instanceId,
            updatedAt
        };
        this._persistOccupancy(occupancy);
    }

    private _persistOccupancy(occupancy: OccupancyMap): void {
        const storageKey = this._getOccupancyStorageKey();
        const serialized = JSON.stringify(occupancy);
        try {
            if (Object.keys(occupancy).length === 0) {
                localStorage.removeItem(
                    `linkedWindowOccupancy.${this.sessionId}`
                );
            } else {
                localStorage.setItem(
                    `linkedWindowOccupancy.${this.sessionId}`,
                    serialized
                );
            }
        } catch {
            if (Object.keys(occupancy).length === 0) {
                fallbackOccupancyByKey.delete(storageKey);
            } else {
                fallbackOccupancyByKey.set(storageKey, { ...occupancy });
            }
        }
    }

    private _bindOccupancyLifecycle(): void {
        if (this._lifecycleBound || this.linkedOrdinal === null) {
            return;
        }
        this._lifecycleBound = true;

        const beat = () => {
            if (this.linkedOrdinal !== null) {
                this.claimLinkedOrdinal(this.linkedOrdinal);
            }
        };
        this._heartbeatTimer = window.setInterval(beat, OCCUPANCY_HEARTBEAT_MS);

        window.addEventListener('pagehide', (event) => {
            if (event.persisted) {
                return;
            }
            if (this._heartbeatTimer !== null) {
                window.clearInterval(this._heartbeatTimer);
                this._heartbeatTimer = null;
            }
            if (this.linkedOrdinal !== null) {
                this.releaseLinkedOrdinal(this.linkedOrdinal);
            }
        });

        window.addEventListener('pageshow', (event) => {
            if (!event.persisted || this.linkedOrdinal === null) {
                return;
            }
            this.claimLinkedOrdinal(this.linkedOrdinal);
            if (this._heartbeatTimer === null) {
                this._heartbeatTimer = window.setInterval(
                    beat,
                    OCCUPANCY_HEARTBEAT_MS
                );
            }
        });
    }
}

export const windowRole = window.windowRole ?? new WindowRoleManager();
window.windowRole = windowRole;
