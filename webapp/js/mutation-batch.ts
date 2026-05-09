import type {
    ChangeLogEntry,
    HistoryAction,
    HistoryTargetType,
    UndoScope,
    WorkerReplayTarget
} from './change-log';
import {
    createLogEntry,
    deriveGlyphNameFromPath,
    deriveLayerIdFromPath,
    getPathSegments,
    joinPathWithGlyphSeparator,
    normalizeWorkerReplayTargets
} from './change-log';

export type MutationEditType =
    | 'outline'
    | 'anchor'
    | 'metrics'
    | 'feature'
    | 'font'
    | 'python'
    | 'undo'
    | 'redo'
    | 'bootstrap';

export type JsonPatchOperation = {
    op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
    path: string;
    from?: string;
    value?: unknown;
};

export type MutationBatchMetadata = {
    editType: MutationEditType;
    changedGlyphNames: string[];
    changedLayerIds: string[];
    workerReplayTargets: WorkerReplayTarget[];
    historyItemId?: string | null;
    historyAction?: HistoryAction;
    targetHistoryItemId?: string | null;
    sourceWindowRoleLabel?: string | null;
    visualAnchorSide?: 'left' | 'right' | null;
    sidebearingAdjustedSide?: 'left' | 'right' | null;
    requiresTrailingFullCompile?: boolean;
    requiresFullCompile?: boolean;
    historyTargetType?: HistoryTargetType | null;
    historyTargetKey?: string | null;
    historyTargetLabel?: string | null;
    undoScope?: UndoScope;
    recomposeTargets?: WorkerReplayTarget[];
};

export interface MutationBatchEnvelope {
    schemaVersion: 1;
    transactionId: string;
    localSequence: number;
    roomSequence: number | null;
    baseRevision: string | null;
    forwardPatches: JsonPatchOperation[];
    inversePatches: JsonPatchOperation[];
    metadata: MutationBatchMetadata;
    source: string;
    label: string | null;
    windowId: string | null;
    timestamp: number;
    validationFingerprint: string | null;
}

type CreateMutationBatchEnvelopeInput = Omit<
    MutationBatchEnvelope,
    'schemaVersion' | 'roomSequence' | 'validationFingerprint'
> & {
    roomSequence?: number | null;
    validationFingerprint?: string | null;
};

export function createMutationBatchEnvelope(
    input: CreateMutationBatchEnvelopeInput
): MutationBatchEnvelope {
    return {
        schemaVersion: 1,
        transactionId: input.transactionId,
        localSequence: input.localSequence,
        roomSequence: input.roomSequence ?? null,
        baseRevision: input.baseRevision,
        forwardPatches: [...input.forwardPatches],
        inversePatches: [...input.inversePatches],
        metadata: {
            ...input.metadata,
            changedGlyphNames: [...input.metadata.changedGlyphNames],
            changedLayerIds: [...input.metadata.changedLayerIds],
            workerReplayTargets: [...input.metadata.workerReplayTargets],
            recomposeTargets: input.metadata.recomposeTargets
                ? [...input.metadata.recomposeTargets]
                : undefined
        },
        source: input.source,
        label: input.label,
        windowId: input.windowId,
        timestamp: input.timestamp,
        validationFingerprint: input.validationFingerprint ?? null
    };
}

export function isMutationBatchEnvelope(
    value: unknown
): value is MutationBatchEnvelope {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    const candidate = value as Partial<MutationBatchEnvelope>;
    if (candidate.schemaVersion !== 1) {
        return false;
    }

    if (typeof candidate.transactionId !== 'string') {
        return false;
    }

    if (typeof candidate.localSequence !== 'number') {
        return false;
    }

    if (!Array.isArray(candidate.forwardPatches)) {
        return false;
    }

    if (!Array.isArray(candidate.inversePatches)) {
        return false;
    }

    if (!candidate.metadata || typeof candidate.metadata !== 'object') {
        return false;
    }

    return typeof candidate.timestamp === 'number';
}

function toJsonPointerPath(changeLogPath: string): string {
    const segments = getPathSegments(changeLogPath);
    if (!segments.length) {
        return '';
    }

    return `/${segments
        .map((segment) => segment.replaceAll('~', '~0').replaceAll('/', '~1'))
        .join('/')}`;
}

function createPatchPairFromEntry(entry: ChangeLogEntry): {
    forwardPatch: JsonPatchOperation;
    inversePatch: JsonPatchOperation;
} {
    const path = toJsonPointerPath(entry.path);

    if (entry.op === 'add') {
        return {
            forwardPatch: {
                op: 'add',
                path,
                value: entry.newValue
            },
            inversePatch: {
                op: 'remove',
                path
            }
        };
    }

    if (entry.op === 'remove') {
        return {
            forwardPatch: {
                op: 'remove',
                path
            },
            inversePatch: {
                op: 'add',
                path,
                value: entry.oldValue
            }
        };
    }

    const op = entry.oldValue === undefined ? 'add' : 'replace';
    const inverseOp = entry.newValue === undefined ? 'remove' : 'replace';

    return {
        forwardPatch: {
            op,
            path,
            value: entry.newValue
        },
        inversePatch: {
            op: inverseOp,
            path,
            value: inverseOp === 'remove' ? undefined : entry.oldValue
        }
    };
}

export function createMutationBatchEnvelopeFromChangeLogEntries(
    entries: ChangeLogEntry[],
    options: {
        localSequence: number;
        source: string;
        baseRevision?: string | null;
        label?: string | null;
        windowId?: string | null;
        editType?: MutationEditType;
        validationFingerprint?: string | null;
    }
): MutationBatchEnvelope | null {
    if (!entries.length) {
        return null;
    }

    const patchPairs = entries.map(createPatchPairFromEntry);
    const changedGlyphNames = [
        ...new Set(
            entries
                .map((entry) => deriveGlyphNameFromPath(entry.path))
                .filter((glyphName): glyphName is string => !!glyphName)
        )
    ];
    const changedLayerIds = [
        ...new Set(
            entries
                .map((entry) => deriveLayerIdFromPath(entry.path))
                .filter((layerId): layerId is string => !!layerId)
        )
    ];
    const workerReplayTargets = normalizeWorkerReplayTargets(
        entries.flatMap((entry) => entry.workerReplayTargets)
    );

    return createMutationBatchEnvelope({
        transactionId:
            entries[0].transactionId !== null &&
            entries[0].transactionId !== undefined
                ? String(entries[0].transactionId)
                : `legacy-${entries[0].historyItemId}`,
        localSequence: options.localSequence,
        roomSequence: null,
        baseRevision: options.baseRevision ?? null,
        forwardPatches: patchPairs.map((pair) => pair.forwardPatch),
        inversePatches: patchPairs.map((pair) => pair.inversePatch).reverse(),
        metadata: {
            editType:
                options.editType ??
                (workerReplayTargets.length ? 'outline' : 'font'),
            changedGlyphNames,
            changedLayerIds,
            workerReplayTargets,
            historyItemId: entries[0].historyItemId,
            historyAction: entries[0].historyAction,
            targetHistoryItemId: entries[0].targetHistoryItemId,
            sourceWindowRoleLabel: entries[0].windowRoleLabel,
            visualAnchorSide:
                entries.find((entry) => entry.visualAnchorSide)
                    ?.visualAnchorSide ?? null,
            historyTargetType: entries[0].historyTargetType,
            historyTargetKey: entries[0].historyTargetKey,
            historyTargetLabel: entries[0].historyTargetLabel,
            undoScope: entries[0].undoScope
        },
        source: options.source,
        label: options.label ?? entries[0].transactionLabel ?? null,
        windowId: options.windowId ?? entries[0].windowId ?? null,
        timestamp: entries[0].timestamp,
        validationFingerprint: options.validationFingerprint ?? null
    });
}

export function createMutationBatchEnvelopesFromChangeLogEntries(
    entries: ChangeLogEntry[],
    options: {
        startingLocalSequence: number;
        source: string;
        baseRevision?: string | null;
        windowId?: string | null;
        editType?: MutationEditType;
        validationFingerprint?: string | null;
    }
): MutationBatchEnvelope[] {
    if (!entries.length) {
        return [];
    }

    const groups: ChangeLogEntry[][] = [];
    for (const entry of entries) {
        const lastGroup = groups[groups.length - 1];
        if (!lastGroup) {
            groups.push([entry]);
            continue;
        }

        const lastEntry = lastGroup[lastGroup.length - 1];
        const sameHistoryItem =
            lastEntry.historyItemId === entry.historyItemId &&
            lastEntry.historyAction === entry.historyAction &&
            lastEntry.targetHistoryItemId === entry.targetHistoryItemId;
        if (sameHistoryItem) {
            lastGroup.push(entry);
        } else {
            groups.push([entry]);
        }
    }

    return groups
        .map((group, index) =>
            createMutationBatchEnvelopeFromChangeLogEntries(group, {
                localSequence: options.startingLocalSequence + index,
                source: options.source,
                baseRevision: options.baseRevision,
                windowId: options.windowId,
                editType: options.editType,
                validationFingerprint: options.validationFingerprint
            })
        )
        .filter((envelope): envelope is MutationBatchEnvelope => !!envelope);
}

function fromJsonPointerPath(pointerPath: string): string {
    if (!pointerPath || pointerPath === '/') {
        return '';
    }

    const segments = pointerPath
        .split('/')
        .slice(1)
        .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
    return joinPathWithGlyphSeparator(segments);
}

export function createChangeLogEntriesFromMutationBatchEnvelope(
    envelope: MutationBatchEnvelope,
    options: {
        windowRoleLabel: string;
    }
): ChangeLogEntry[] {
    return envelope.forwardPatches
        .filter(
            (patch) =>
                patch.op === 'add' ||
                patch.op === 'remove' ||
                patch.op === 'replace'
        )
        .map((patch, index) => {
            const inversePatch =
                envelope.inversePatches[
                    envelope.inversePatches.length - 1 - index
                ];
            const path = fromJsonPointerPath(patch.path);

            return createLogEntry({
                timestamp: envelope.timestamp,
                windowId: envelope.windowId ?? 'remote',
                windowRoleLabel:
                    envelope.metadata.sourceWindowRoleLabel ??
                    options.windowRoleLabel,
                historyItemId:
                    envelope.metadata.historyItemId ??
                    `mutation-${envelope.transactionId}`,
                historyAction: envelope.metadata.historyAction ?? 'change',
                targetHistoryItemId:
                    envelope.metadata.targetHistoryItemId ?? null,
                transactionLabel: envelope.label,
                transactionId: Number.isFinite(Number(envelope.transactionId))
                    ? Number(envelope.transactionId)
                    : null,
                op:
                    patch.op === 'replace'
                        ? 'set'
                        : patch.op === 'add'
                          ? 'add'
                          : 'remove',
                undoScope: envelope.metadata.undoScope,
                path,
                oldValue:
                    inversePatch?.op === 'remove'
                        ? undefined
                        : inversePatch?.value,
                newValue: patch.op === 'remove' ? undefined : patch.value,
                replayOldValue:
                    inversePatch?.op === 'remove'
                        ? undefined
                        : inversePatch?.value,
                replayNewValue: patch.op === 'remove' ? undefined : patch.value,
                visualAnchorSide: envelope.metadata.visualAnchorSide ?? null,
                workerReplayTargets: envelope.metadata.workerReplayTargets,
                historyTargetType: envelope.metadata.historyTargetType ?? null,
                historyTargetKey: envelope.metadata.historyTargetKey ?? null,
                historyTargetLabel: envelope.metadata.historyTargetLabel ?? null
            });
        });
}
