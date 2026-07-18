export const MANAGED_FILE_CHANGED_EVENT = 'managedFileChanged';

export type ManagedFileChangeSource =
    'script-editor-save' | 'file-system-observer';

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
