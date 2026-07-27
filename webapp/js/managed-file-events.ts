export const MANAGED_FILE_CHANGED_EVENT = 'managedFileChanged';

export type ManagedFileChangeSource =
    'script-editor-save' | 'file-system-observer';

const INTERNAL_WRITE_TTL_MS = 5000;
const pendingInternalWrites = new Map<string, number>();

export interface ManagedFileChangedDetail {
    pluginId: string;
    source: ManagedFileChangeSource;
    paths?: string[];
    records?: unknown[];
    internalWrite?: boolean;
}

type ChangedPathRecord = {
    path?: unknown;
    relativePath?: unknown;
    changedPath?: unknown;
    oldPath?: unknown;
    newPath?: unknown;
    relativePathComponents?: unknown;
    movedFrom?: {
        path?: unknown;
        relativePathComponents?: unknown;
    };
    movedTo?: {
        path?: unknown;
        relativePathComponents?: unknown;
    };
};

export function normalizeManagedPath(path: string): string {
    const cleaned = path.replace(/\\/g, '/').replace(/^\/+/, '');
    return `/${cleaned}`.replace(/\/+/g, '/');
}

function internalWriteKey(pluginId: string, path: string): string {
    return `${pluginId}:${normalizeManagedPath(path)}`;
}

export function markManagedFileInternalWrite(
    pluginId: string,
    path: string
): void {
    pendingInternalWrites.set(
        internalWriteKey(pluginId, path),
        Date.now() + INTERNAL_WRITE_TTL_MS
    );
}

export function cancelManagedFileInternalWrite(
    pluginId: string,
    path: string
): void {
    pendingInternalWrites.delete(internalWriteKey(pluginId, path));
}

export function consumeManagedFileInternalWritePaths(
    pluginId: string,
    paths: string[]
): string[] {
    const now = Date.now();
    const internallyWrittenPaths: string[] = [];

    for (const path of paths) {
        const key = internalWriteKey(pluginId, path);
        const expiresAt = pendingInternalWrites.get(key);

        if (expiresAt === undefined) {
            continue;
        }

        pendingInternalWrites.delete(key);
        if (expiresAt >= now) {
            internallyWrittenPaths.push(normalizeManagedPath(path));
        }
    }

    return internallyWrittenPaths;
}

/**
 * True when every observed path was a pending self-write for `pluginId`.
 * Only consumes markers when the whole batch is suppressed, so a mixed
 * internal+external batch still leaves markers available for a later echo.
 */
export function wereAllManagedPathsInternalWrites(
    pluginId: string,
    paths: string[]
): boolean {
    if (paths.length === 0) {
        return false;
    }

    const normalizedPaths = paths.map((path) => normalizeManagedPath(path));
    const now = Date.now();
    const allInternal = normalizedPaths.every((path) => {
        const expiresAt = pendingInternalWrites.get(
            internalWriteKey(pluginId, path)
        );
        return expiresAt !== undefined && expiresAt >= now;
    });

    if (!allInternal) {
        return false;
    }

    for (const path of normalizedPaths) {
        pendingInternalWrites.delete(internalWriteKey(pluginId, path));
    }
    return true;
}

export function extractManagedChangedPaths(
    detail: ManagedFileChangedDetail
): string[] {
    const paths = new Set<string>();

    const addPath = (value: unknown) => {
        if (typeof value === 'string' && value.trim()) {
            paths.add(normalizeManagedPath(value));
        }
    };

    for (const path of detail.paths || []) {
        addPath(path);
    }

    for (const record of detail.records || []) {
        if (!record || typeof record !== 'object') {
            continue;
        }

        const changedRecord = record as ChangedPathRecord;
        addPath(changedRecord.path);
        addPath(changedRecord.relativePath);
        addPath(changedRecord.changedPath);
        addPath(changedRecord.oldPath);
        addPath(changedRecord.newPath);

        const relComps = changedRecord.relativePathComponents;
        if (Array.isArray(relComps) && relComps.length > 0) {
            addPath(relComps.join('/'));
        }

        const movedFrom = changedRecord.movedFrom;
        if (movedFrom && typeof movedFrom === 'object') {
            addPath(movedFrom.path);
            const comps = movedFrom.relativePathComponents;
            if (Array.isArray(comps) && comps.length > 0) {
                addPath(comps.join('/'));
            }
        }

        const movedTo = changedRecord.movedTo;
        if (movedTo && typeof movedTo === 'object') {
            addPath(movedTo.path);
            const comps = movedTo.relativePathComponents;
            if (Array.isArray(comps) && comps.length > 0) {
                addPath(comps.join('/'));
            }
        }
    }

    return Array.from(paths);
}

export function dispatchManagedFileChanged(
    detail: ManagedFileChangedDetail
): void {
    window.dispatchEvent(
        new CustomEvent<ManagedFileChangedDetail>(MANAGED_FILE_CHANGED_EVENT, {
            detail
        })
    );
}
