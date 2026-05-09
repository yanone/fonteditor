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

export type NamedPatchOperation = {
    op: 'add' | 'remove' | 'replace';
    path: string;
    value?: unknown;
};

export type MutationPatchPair = {
    forward: NamedPatchOperation;
    inverse: NamedPatchOperation;
    replayOldValue?: unknown;
    replayNewValue?: unknown;
    visualAnchorSide?: 'left' | 'right' | null;
    workerReplayTargets?: WorkerReplayTarget[];
};

export type SyntheticChangeOperation = {
    op: 'set' | 'add' | 'remove';
    path: (string | number)[];
    oldValue: unknown;
    newValue: unknown;
    replayOldValue?: unknown;
    replayNewValue?: unknown;
    visualAnchorSide?: 'left' | 'right' | null;
    workerReplayTargets?: WorkerReplayTarget[];
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
    schemaVersion: 1 | 2;
    transactionId: string;
    localSequence: number;
    roomSequence: number | null;
    baseRevision: string | null;
    patches: MutationPatchPair[];
    metadata: MutationBatchMetadata;
    source: string;
    label: string | null;
    windowId: string | null;
    timestamp: number;
    validationFingerprint: string | null;
    forwardPatches?: JsonPatchOperation[];
    inversePatches?: JsonPatchOperation[];
}

type Unsafe = ReturnType<typeof JSON.parse>;

type FontJsonSnapshot = Record<string, Unsafe> | null | undefined;

type CreateMutationBatchEnvelopeInput = Omit<
    MutationBatchEnvelope,
    | 'schemaVersion'
    | 'roomSequence'
    | 'validationFingerprint'
    | 'forwardPatches'
    | 'inversePatches'
> & {
    roomSequence?: number | null;
    validationFingerprint?: string | null;
};

export function createMutationBatchEnvelope(
    input: CreateMutationBatchEnvelopeInput
): MutationBatchEnvelope {
    return {
        schemaVersion: 2,
        transactionId: input.transactionId,
        localSequence: input.localSequence,
        roomSequence: input.roomSequence ?? null,
        baseRevision: input.baseRevision,
        patches: input.patches.map((patch) => ({
            ...patch,
            forward: { ...patch.forward },
            inverse: { ...patch.inverse },
            workerReplayTargets: patch.workerReplayTargets
                ? [...patch.workerReplayTargets]
                : undefined
        })),
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
    if (candidate.schemaVersion !== 1 && candidate.schemaVersion !== 2) {
        return false;
    }

    if (typeof candidate.transactionId !== 'string') {
        return false;
    }

    if (typeof candidate.localSequence !== 'number') {
        return false;
    }

    if (
        !Array.isArray(candidate.patches) &&
        !(
            candidate.schemaVersion === 1 &&
            Array.isArray(candidate.forwardPatches) &&
            Array.isArray(candidate.inversePatches)
        )
    ) {
        return false;
    }

    if (!candidate.metadata || typeof candidate.metadata !== 'object') {
        return false;
    }

    return typeof candidate.timestamp === 'number';
}

function pathToArray(path: string): (string | number)[] {
    return getPathSegments(path).map((segment) => {
        const numeric = Number.parseInt(segment, 10);
        return String(numeric) === segment ? numeric : segment;
    });
}

function getNamedPatchOpForSet(oldValue: unknown): 'add' | 'replace' {
    return oldValue === undefined ? 'add' : 'replace';
}

function createNamedPatchPairFromEntry(
    entry: ChangeLogEntry
): MutationPatchPair {
    if (entry.op === 'add') {
        return {
            forward: {
                op: 'add',
                path: entry.path,
                value: entry.newValue
            },
            inverse: {
                op: 'remove',
                path: entry.path
            },
            replayOldValue: entry.replayOldValue,
            replayNewValue: entry.replayNewValue,
            visualAnchorSide: entry.visualAnchorSide ?? null,
            workerReplayTargets: normalizeWorkerReplayTargets(
                entry.workerReplayTargets
            )
        };
    }

    if (entry.op === 'remove') {
        return {
            forward: {
                op: 'remove',
                path: entry.path
            },
            inverse: {
                op: 'add',
                path: entry.path,
                value: entry.oldValue
            },
            replayOldValue: entry.replayOldValue,
            replayNewValue: entry.replayNewValue,
            visualAnchorSide: entry.visualAnchorSide ?? null,
            workerReplayTargets: normalizeWorkerReplayTargets(
                entry.workerReplayTargets
            )
        };
    }

    return {
        forward: {
            op: getNamedPatchOpForSet(entry.oldValue),
            path: entry.path,
            value: entry.newValue
        },
        inverse: {
            op: entry.oldValue === undefined ? 'remove' : 'replace',
            path: entry.path,
            value: entry.oldValue
        },
        replayOldValue: entry.replayOldValue,
        replayNewValue: entry.replayNewValue,
        visualAnchorSide: entry.visualAnchorSide ?? null,
        workerReplayTargets: normalizeWorkerReplayTargets(
            entry.workerReplayTargets
        )
    };
}

export function createSyntheticChangeOperationsFromPatchPairs(
    patches: MutationPatchPair[],
    fallbackWorkerReplayTargets?: WorkerReplayTarget[]
): SyntheticChangeOperation[] {
    return patches.map((patch) => ({
        op:
            patch.forward.op === 'replace'
                ? 'set'
                : patch.forward.op === 'add'
                  ? 'add'
                  : 'remove',
        path: pathToArray(patch.forward.path),
        oldValue:
            patch.inverse.op === 'remove' ? undefined : patch.inverse.value,
        newValue:
            patch.forward.op === 'remove' ? undefined : patch.forward.value,
        replayOldValue:
            patch.replayOldValue === undefined
                ? patch.inverse.op === 'remove'
                    ? undefined
                    : patch.inverse.value
                : patch.replayOldValue,
        replayNewValue:
            patch.replayNewValue === undefined
                ? patch.forward.op === 'remove'
                    ? undefined
                    : patch.forward.value
                : patch.replayNewValue,
        visualAnchorSide: patch.visualAnchorSide ?? null,
        workerReplayTargets: normalizeWorkerReplayTargets(
            patch.workerReplayTargets?.length
                ? patch.workerReplayTargets
                : fallbackWorkerReplayTargets
        )
    }));
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
        patches: entries.map((entry) => createNamedPatchPairFromEntry(entry)),
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

function fromJsonPointerPath(
    pointerPath: string,
    fontJson?: FontJsonSnapshot,
    fallbackValue?: unknown
): string {
    if (!pointerPath || pointerPath === '/') {
        return '';
    }

    const segments = pointerPath
        .split('/')
        .slice(1)
        .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));

    if (segments[0] === 'glyphs' && segments.length >= 2) {
        const glyphIndex = Number.parseInt(String(segments[1]), 10);
        const glyphs = Array.isArray(fontJson?.glyphs)
            ? (fontJson.glyphs as Unsafe[])
            : null;
        const glyph = Number.isFinite(glyphIndex) ? glyphs?.[glyphIndex] : null;
        if (
            glyph &&
            typeof glyph === 'object' &&
            typeof glyph.name === 'string'
        ) {
            segments[1] = glyph.name;

            if (segments[2] === 'layers' && segments.length >= 4) {
                const layerIndex = Number.parseInt(String(segments[3]), 10);
                const layers = Array.isArray(glyph.layers)
                    ? (glyph.layers as Unsafe[])
                    : null;
                const layer = Number.isFinite(layerIndex)
                    ? layers?.[layerIndex]
                    : null;
                if (
                    layer &&
                    typeof layer === 'object' &&
                    typeof layer.id === 'string'
                ) {
                    segments[3] = layer.id;
                } else if (
                    Number.isFinite(layerIndex) &&
                    fallbackValue &&
                    typeof fallbackValue === 'object' &&
                    typeof (fallbackValue as Record<string, unknown>).id ===
                        'string'
                ) {
                    segments[3] = String(
                        (fallbackValue as Record<string, unknown>).id
                    );
                }
            }
        } else if (
            Number.isFinite(glyphIndex) &&
            fallbackValue &&
            typeof fallbackValue === 'object' &&
            typeof (fallbackValue as Record<string, unknown>).name === 'string'
        ) {
            segments[1] = String(
                (fallbackValue as Record<string, unknown>).name
            );
        }
    }

    return joinPathWithGlyphSeparator(segments);
}

function hasUnresolvedLegacyIdentity(path: string): boolean {
    const segments = getPathSegments(path);
    if (segments[0] !== 'glyphs') {
        return false;
    }

    if (/^\d+$/.test(String(segments[1] ?? ''))) {
        return true;
    }

    return segments[2] === 'layers' && /^\d+$/.test(String(segments[3] ?? ''));
}

function createNamedPatchPairFromLegacyJsonPatchPair(
    forwardPatch: JsonPatchOperation,
    inversePatch: JsonPatchOperation | undefined,
    fontJson?: FontJsonSnapshot
): MutationPatchPair | null {
    const forwardIdentityValue =
        forwardPatch.value === undefined
            ? inversePatch?.value
            : forwardPatch.value;
    const forwardPath = fromJsonPointerPath(
        forwardPatch.path,
        fontJson,
        forwardIdentityValue
    );
    if (!forwardPath || hasUnresolvedLegacyIdentity(forwardPath)) {
        return null;
    }

    const inversePath = fromJsonPointerPath(
        inversePatch?.path ?? forwardPatch.path,
        fontJson,
        inversePatch?.value
    );

    return {
        forward: {
            op: forwardPatch.op as NamedPatchOperation['op'],
            path: forwardPath,
            value: forwardPatch.value
        },
        inverse: {
            op: (inversePatch?.op ?? 'remove') as NamedPatchOperation['op'],
            path:
                inversePath && !hasUnresolvedLegacyIdentity(inversePath)
                    ? inversePath
                    : forwardPath,
            value: inversePatch?.value
        }
    };
}

export function createNamedPatchPairFromJsonPatchPair(
    forwardPatch: JsonPatchOperation,
    inversePatch: JsonPatchOperation | undefined,
    options: {
        forwardSnapshot?: FontJsonSnapshot;
        inverseSnapshot?: FontJsonSnapshot;
        replayOldValue?: unknown;
        replayNewValue?: unknown;
        visualAnchorSide?: 'left' | 'right' | null;
        workerReplayTargets?: WorkerReplayTarget[];
    }
): MutationPatchPair {
    return {
        forward: {
            op: forwardPatch.op as NamedPatchOperation['op'],
            path: fromJsonPointerPath(
                forwardPatch.path,
                options.forwardSnapshot
            ),
            value: forwardPatch.value
        },
        inverse: {
            op: (inversePatch?.op ?? 'remove') as NamedPatchOperation['op'],
            path: fromJsonPointerPath(
                inversePatch?.path ?? forwardPatch.path,
                options.inverseSnapshot
            ),
            value: inversePatch?.value
        },
        replayOldValue: options.replayOldValue,
        replayNewValue: options.replayNewValue,
        visualAnchorSide: options.visualAnchorSide ?? null,
        workerReplayTargets: normalizeWorkerReplayTargets(
            options.workerReplayTargets
        )
    };
}

export function createChangeLogEntriesFromMutationBatchEnvelope(
    envelope: MutationBatchEnvelope,
    options: {
        windowRoleLabel: string;
        fontJson?: FontJsonSnapshot;
    }
): ChangeLogEntry[] {
    const patches =
        envelope.schemaVersion === 2 && Array.isArray(envelope.patches)
            ? envelope.patches
            : Array.isArray(envelope.forwardPatches)
              ? envelope.forwardPatches
                    .filter(
                        (patch) =>
                            patch.op === 'add' ||
                            patch.op === 'remove' ||
                            patch.op === 'replace'
                    )
                    .map((forwardPatch, index, forwardPatchList) => {
                        const inversePatches = Array.isArray(
                            envelope.inversePatches
                        )
                            ? envelope.inversePatches
                            : [];
                        const inversePatch =
                            inversePatches[forwardPatchList.length - 1 - index];
                        return createNamedPatchPairFromLegacyJsonPatchPair(
                            forwardPatch,
                            inversePatch,
                            options.fontJson
                        );
                    })
                    .filter((patch): patch is MutationPatchPair => !!patch)
              : [];

    return createSyntheticChangeOperationsFromPatchPairs(
        patches,
        envelope.metadata.workerReplayTargets
    ).map((operation) =>
        createLogEntry({
            timestamp: envelope.timestamp,
            windowId: envelope.windowId ?? 'remote',
            windowRoleLabel:
                envelope.metadata.sourceWindowRoleLabel ??
                options.windowRoleLabel,
            historyItemId:
                envelope.metadata.historyItemId ??
                `mutation-${envelope.transactionId}`,
            historyAction: envelope.metadata.historyAction ?? 'change',
            targetHistoryItemId: envelope.metadata.targetHistoryItemId ?? null,
            transactionLabel: envelope.label,
            transactionId: Number.isFinite(Number(envelope.transactionId))
                ? Number(envelope.transactionId)
                : null,
            op: operation.op,
            undoScope: envelope.metadata.undoScope,
            path: joinPathWithGlyphSeparator(operation.path),
            oldValue: operation.oldValue,
            newValue: operation.newValue,
            replayOldValue:
                operation.replayOldValue === undefined
                    ? operation.oldValue
                    : operation.replayOldValue,
            replayNewValue:
                operation.replayNewValue === undefined
                    ? operation.newValue
                    : operation.replayNewValue,
            visualAnchorSide:
                operation.visualAnchorSide ??
                envelope.metadata.visualAnchorSide ??
                null,
            workerReplayTargets: normalizeWorkerReplayTargets(
                operation.workerReplayTargets?.length
                    ? operation.workerReplayTargets
                    : envelope.metadata.workerReplayTargets
            ),
            historyTargetType: envelope.metadata.historyTargetType ?? null,
            historyTargetKey: envelope.metadata.historyTargetKey ?? null,
            historyTargetLabel: envelope.metadata.historyTargetLabel ?? null
        })
    );
}
