/**
 * Shared cascading layer recomposition closure.
 *
 * Distinguishes two dependent sets after a visual edit:
 *
 *   recomposeTargets — layers whose *stored model* must change (automatic
 *     composition rebuild and/or metrics-key inheritance). These may be
 *     written into the authoritative Yjs packet as layer snapshots.
 *
 *   invalidateTargets — layers that only need worker/canvas/overview refresh
 *     because they *draw* an edited source (e.g. manual composites). These
 *     must NOT receive model writes; they are stamped only as
 *     `workerReplayTargets` metadata on the Yjs packet.
 *
 *   allTargets — source ∪ recompose ∪ invalidate. Stamp this as
 *     `workerReplayTargets` so local and remote peers refresh the same
 *     compile/cache closure without re-deriving it.
 *
 * Two scopes are supported:
 *
 *   `visible` — Used during live drag for transient visible-only refreshes.
 *   `all`     — Used for every committed edit (keyboard, drag-end, undo,
 *               redo, remote).  This is the authoritative full closure.
 *
 * The module is stateless and pure — all dependencies are passed explicitly.
 */

import type { WorkerReplayTarget } from './change-log';
import { normalizeWorkerReplayTargets } from './change-log';

// ── Public types ───────────────────────────────────────────────────────────

export type RecompositionEditKind =
    'outline' | 'anchor' | 'sidebearing' | 'component';

export type RecompositionScope = 'visible' | 'all';

export type RecompositionSourceTarget = WorkerReplayTarget & {
    /** Optional human-readable hint for diagnostics. */
    hint?: string;
};

export type RecompositionClosure = {
    /**
     * Source + recompose + invalidate.
     * Stamp as `workerReplayTargets` on the committed Yjs packet metadata.
     */
    allTargets: WorkerReplayTarget[];

    /**
     * Layers whose stored model changed via automatic composition rebuild
     * and/or metrics-key recomputation (excludes pure invalidate dependents).
     * Use these (plus the source targets) as `changedLayerTargets`.
     */
    recomposeTargets: WorkerReplayTarget[];

    /**
     * Component-reference dependents that need cache/redraw only.
     * Never write these into Yjs as layer snapshots from cascade alone.
     */
    invalidateTargets: WorkerReplayTarget[];

    /**
     * Non-source dependents that belong in replay metadata
     * (`recomposeTargets ∪ invalidateTargets`).
     */
    dependentTargets: WorkerReplayTarget[];

    /** Every unique glyph name in the closure (source + dependents). */
    affectedGlyphNames: Set<string>;

    /** Glyphs whose stored model was mutated by rebuild/metrics. */
    recomposeGlyphNames: Set<string>;

    /** Glyphs that need invalidate-only refresh (may overlap recompose). */
    invalidateGlyphNames: Set<string>;
};

/**
 * Minimal font-model interface needed by the closure.
 * Injected explicitly so the closure is testable without the full DOM.
 */
export interface FontModelLike {
    findGlyph?: (name: string) => GlyphLike | null | undefined;
    collectComponentDependentGlyphs?: (
        glyphNames: Iterable<string>,
        options?: {
            includeSourceGlyphNames?: boolean;
            retainGlyphNames?: Set<string>;
        }
    ) => Set<string>;
    rebuildAutomaticCompositesForGlyphs?: (
        sourceGlyphNames: Iterable<string>,
        options?: {
            allowedGlyphNames?: Set<string>;
            preferredLayerId?: string;
            preferredSourceGlyphName?: string;
        }
    ) => Set<string>;
    recomputeMetricsKeys?: (sourceGlyphNames: Set<string>) => Set<string>;
    /**
     * Glyphs with metrics-key / automatic-offset edges that depend on the
     * source glyphs, whether or not their stored values need updating right
     * now. Used so commit can persist live-already-updated dependents.
     */
    collectMetricsKeyDependentGlyphs?: (
        sourceGlyphNames: Iterable<string>
    ) => Set<string>;
    invalidateLayoutCachesForGlyphs?: (glyphNames: Set<string>) => void;
}

export interface GlyphLike {
    name?: string;
    findLayerById?: (layerId: string) => LayerLike | null | undefined;
    layers?: Array<{ id?: string }>;
}

export interface LayerLike {
    id?: string;
    getMatchingLayerOnGlyph?: (glyphName: string) => LayerLike | null;
    isAutomaticAlignedLayer?: () => boolean;
}

/**
 * Optional bridge-like adapter for suppressing model recording during
 * recomputation.
 */
export interface RecordingSuppressor {
    runWithoutRecording?: <T>(fn: () => T) => T;
}

type OperationLike = {
    path?: Array<string | number>;
    applyPath?: Array<string | number>;
    applyMode?: string;
    applyOldValue?: unknown;
    applyNewValue?: unknown;
    oldValue?: unknown;
    newValue?: unknown;
};

function emptyClosure(
    sourceTargets: RecompositionSourceTarget[]
): RecompositionClosure {
    const allTargets = normalizeWorkerReplayTargets(sourceTargets);
    const affectedGlyphNames = new Set(
        sourceTargets.map((t) => t.glyphName).filter(Boolean)
    );
    return {
        allTargets,
        recomposeTargets: [],
        invalidateTargets: [],
        dependentTargets: [],
        affectedGlyphNames,
        recomposeGlyphNames: new Set(),
        invalidateGlyphNames: new Set()
    };
}

function layerSnapshotTouchesField(snapshot: unknown, field: string): boolean {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        return false;
    }
    return field in (snapshot as Record<string, unknown>);
}

/**
 * Infer edit kinds from buffered bridge operations so the finalizer does not
 * run a universal outline+anchor+sidebearing+component superset.
 */
export function deriveEditKindsFromOperations(
    operations: OperationLike[]
): Set<RecompositionEditKind> {
    const kinds = new Set<RecompositionEditKind>();

    for (const operation of operations) {
        const path = operation.applyPath ?? operation.path ?? [];
        if (
            path.length === 5 &&
            path[0] === 'glyphs' &&
            path[2] === 'layers' &&
            path[4] === 'width'
        ) {
            kinds.add('sidebearing');
            continue;
        }
        if (
            path.length >= 5 &&
            path[0] === 'glyphs' &&
            path[2] === 'layers' &&
            path[4] === 'anchors'
        ) {
            kinds.add('anchor');
            continue;
        }
        if (
            path.length >= 5 &&
            path[0] === 'glyphs' &&
            path[2] === 'layers' &&
            path[4] === 'nodes'
        ) {
            kinds.add('outline');
            continue;
        }
        if (
            path.length >= 5 &&
            path[0] === 'glyphs' &&
            path[2] === 'layers' &&
            path[4] === 'shapes'
        ) {
            // Shape ops may be path geometry or component transforms.
            kinds.add('outline');
            kinds.add('component');
            continue;
        }

        if (
            operation.applyMode === 'layer-snapshot' &&
            path.length === 4 &&
            path[0] === 'glyphs' &&
            path[2] === 'layers'
        ) {
            const oldValue = operation.applyOldValue ?? operation.oldValue;
            const newValue = operation.applyNewValue ?? operation.newValue;
            if (
                layerSnapshotTouchesField(oldValue, 'width') ||
                layerSnapshotTouchesField(newValue, 'width')
            ) {
                kinds.add('sidebearing');
            }
            if (
                layerSnapshotTouchesField(oldValue, 'anchors') ||
                layerSnapshotTouchesField(newValue, 'anchors')
            ) {
                kinds.add('anchor');
            }
            if (
                layerSnapshotTouchesField(oldValue, 'shapes') ||
                layerSnapshotTouchesField(newValue, 'shapes')
            ) {
                kinds.add('outline');
                kinds.add('component');
            }
        }
    }

    return kinds;
}

/**
 * Resolve the matching master layer on a dependent glyph.
 */
function resolveMatchingLayerTarget(
    fontModel: FontModelLike,
    glyphName: string,
    activeLayerId: string | null | undefined,
    sourceLayer: LayerLike | null
): WorkerReplayTarget | null {
    const glyph = fontModel.findGlyph?.(glyphName);
    if (!glyph) {
        return null;
    }

    const matchedLayer =
        (activeLayerId ? glyph.findLayerById?.(activeLayerId) : null) ??
        sourceLayer?.getMatchingLayerOnGlyph?.(glyphName) ??
        null;

    if (!matchedLayer?.id) {
        return null;
    }

    return { glyphName, layerId: matchedLayer.id };
}

function buildTargetsForGlyphNames(
    fontModel: FontModelLike,
    glyphNames: Iterable<string>,
    sourceGlyphNames: Set<string>,
    activeLayerId: string | null | undefined,
    sourceLayer: LayerLike | null
): WorkerReplayTarget[] {
    const targets: WorkerReplayTarget[] = [];
    for (const glyphName of glyphNames) {
        if (sourceGlyphNames.has(glyphName)) {
            continue;
        }
        const target = resolveMatchingLayerTarget(
            fontModel,
            glyphName,
            activeLayerId,
            sourceLayer
        );
        if (target) {
            targets.push(target);
        }
    }
    return normalizeWorkerReplayTargets(targets);
}

/**
 * Among component-reference candidates, keep only glyphs whose matching
 * layer is fully automatic-aligned (eligible for model recomposition /
 * Yjs persistence).
 */
function collectAutomaticAlignedDependentGlyphNames(
    fontModel: FontModelLike,
    candidateGlyphNames: Iterable<string>,
    activeLayerId: string | null | undefined,
    sourceLayer: LayerLike | null
): Set<string> {
    const automaticGlyphNames = new Set<string>();
    for (const glyphName of candidateGlyphNames) {
        const target = resolveMatchingLayerTarget(
            fontModel,
            glyphName,
            activeLayerId,
            sourceLayer
        );
        if (!target) {
            continue;
        }
        const layer = fontModel
            .findGlyph?.(glyphName)
            ?.findLayerById?.(target.layerId);
        if (layer?.isAutomaticAlignedLayer?.()) {
            automaticGlyphNames.add(glyphName);
        }
    }
    return automaticGlyphNames;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Compute the full recomposition closure for a visual edit.
 *
 * @param options.sourceTargets   The directly edited glyph/layer pairs.
 * @param options.editKinds       Active edit kinds (outline, anchor, etc.).
 *                                Mixed selections produce a union.
 * @param options.scope           `'visible'` for live drag;
 *                                `'all'` for committed edits.
 * @param options.fontModel       Font model with the required methods.
 * @param options.activeLayerId   The active editing layer (master).
 * @param options.sourceGlyphName Optional source glyph for matching-layer
 *                                lookups on dependents.
 * @param options.suppressor      Optional bridge-like object whose
 *                                `runWithoutRecording` wraps model mutations.
 * @param options.visibleGlyphNames Glyph names considered visible.  Used only
 *                                when scope is `'visible'` to limit dependents.
 */
export function computeLayerRecompositionClosure(options: {
    sourceTargets: RecompositionSourceTarget[];
    editKinds: Set<RecompositionEditKind>;
    scope: RecompositionScope;
    fontModel: FontModelLike;
    activeLayerId?: string | null;
    sourceGlyphName?: string | null;
    suppressor?: RecordingSuppressor | null;
    visibleGlyphNames?: Iterable<string>;
}): RecompositionClosure {
    const {
        sourceTargets,
        editKinds,
        scope,
        fontModel,
        activeLayerId,
        sourceGlyphName,
        suppressor,
        visibleGlyphNames
    } = options;

    if (!fontModel) {
        return emptyClosure(sourceTargets);
    }

    const sourceGlyphNames = new Set(
        sourceTargets.map((t) => t.glyphName).filter((n): n is string => !!n)
    );
    const recomposeGlyphNames = new Set<string>();
    const invalidateGlyphNames = new Set<string>();

    const visibleSet =
        scope === 'visible' && visibleGlyphNames
            ? new Set(visibleGlyphNames)
            : null;

    const wrap = <T>(fn: () => T): T => {
        if (suppressor?.runWithoutRecording) {
            return suppressor.runWithoutRecording(fn);
        }
        return fn();
    };

    const touchesGeometry =
        editKinds.has('outline') ||
        editKinds.has('anchor') ||
        editKinds.has('sidebearing') ||
        editKinds.has('component');

    // ── Invalidate-only: all component-reference dependents ─────────────
    // Manual and automatic composites that *draw* the edited source need
    // cache/redraw refresh, but only automatic/metrics edges may mutate
    // stored layer data (handled below).
    if (
        touchesGeometry &&
        typeof fontModel.collectComponentDependentGlyphs === 'function'
    ) {
        const collected = wrap(() =>
            fontModel.collectComponentDependentGlyphs!(sourceGlyphNames, {
                ...(scope === 'visible' && visibleSet
                    ? { retainGlyphNames: visibleSet }
                    : {})
            })
        );
        for (const depGlyphName of collected) {
            if (!sourceGlyphNames.has(depGlyphName)) {
                invalidateGlyphNames.add(depGlyphName);
            }
        }
    }

    // ── Model recomposition: automatic composites ───────────────────────
    // rebuildAutomaticCompositesForGlyphs already gates on
    // isAutomaticAlignedLayer() and returns only glyphs whose stored
    // placement/width actually changed.
    if (
        touchesGeometry &&
        typeof fontModel.rebuildAutomaticCompositesForGlyphs === 'function'
    ) {
        const preferredTarget = sourceTargets[0] ?? null;
        const affectedComposites: Set<string> = wrap(() => {
            if (
                scope === 'visible' &&
                visibleSet &&
                typeof fontModel.invalidateLayoutCachesForGlyphs === 'function'
            ) {
                fontModel.invalidateLayoutCachesForGlyphs(visibleSet);
            }

            return fontModel.rebuildAutomaticCompositesForGlyphs!(
                sourceGlyphNames,
                {
                    ...(scope === 'visible' && visibleSet
                        ? { allowedGlyphNames: visibleSet }
                        : {}),
                    ...(preferredTarget?.layerId
                        ? {
                              preferredLayerId: preferredTarget.layerId,
                              preferredSourceGlyphName:
                                  preferredTarget.glyphName
                          }
                        : {})
                }
            );
        });

        for (const glyphName of affectedComposites) {
            recomposeGlyphNames.add(glyphName);
        }
    }

    // ── Model recomposition: metrics-key + automatic-offset dependents ──
    // Outline edits are included because moving the visual edge of a keyed
    // source glyph must refresh inherited sidebearings. Anchor-only edits
    // do not drive metrics-key inheritance.
    if (
        (editKinds.has('sidebearing') ||
            editKinds.has('outline') ||
            editKinds.has('component')) &&
        typeof fontModel.recomputeMetricsKeys === 'function'
    ) {
        const metricsDeps = wrap(() =>
            fontModel.recomputeMetricsKeys!(sourceGlyphNames)
        );
        for (const depGlyphName of metricsDeps) {
            recomposeGlyphNames.add(depGlyphName);
        }
    }

    const sourceLayer =
        sourceGlyphName && activeLayerId
            ? (fontModel
                  .findGlyph?.(sourceGlyphName)
                  ?.findLayerById?.(activeLayerId) ?? null)
            : null;

    // Persist automatic composites / metrics-key dependents even when the
    // rebuild/metrics pass is a no-op. Live drag may already have applied the
    // derived state; omitting those layers from changedLayerTargets leaves
    // stale Yjs data that post-commit model reload can clobber back in.
    // Anchor-only edits only expand when rebuild already reported a mutation,
    // so unused/orphan anchors do not re-snapshot every automatic dependent.
    const shouldPersistAutomaticDependents =
        editKinds.has('sidebearing') ||
        editKinds.has('outline') ||
        editKinds.has('component') ||
        [...recomposeGlyphNames].some(
            (glyphName) => !sourceGlyphNames.has(glyphName)
        );
    if (shouldPersistAutomaticDependents) {
        for (const glyphName of collectAutomaticAlignedDependentGlyphNames(
            fontModel,
            invalidateGlyphNames,
            activeLayerId,
            sourceLayer
        )) {
            recomposeGlyphNames.add(glyphName);
        }
    }
    if (
        (editKinds.has('sidebearing') ||
            editKinds.has('outline') ||
            editKinds.has('component')) &&
        typeof fontModel.collectMetricsKeyDependentGlyphs === 'function'
    ) {
        for (const glyphName of fontModel.collectMetricsKeyDependentGlyphs(
            sourceGlyphNames
        )) {
            recomposeGlyphNames.add(glyphName);
        }
    }

    const recomposeTargets = buildTargetsForGlyphNames(
        fontModel,
        recomposeGlyphNames,
        sourceGlyphNames,
        activeLayerId,
        sourceLayer
    );
    const invalidateOnlyGlyphNames = new Set(
        [...invalidateGlyphNames].filter(
            (glyphName) => !recomposeGlyphNames.has(glyphName)
        )
    );
    const invalidateTargets = buildTargetsForGlyphNames(
        fontModel,
        invalidateOnlyGlyphNames,
        sourceGlyphNames,
        activeLayerId,
        sourceLayer
    );
    const dependentTargets = normalizeWorkerReplayTargets([
        ...recomposeTargets,
        ...invalidateTargets
    ]);
    const allTargets = normalizeWorkerReplayTargets([
        ...sourceTargets,
        ...dependentTargets
    ]);

    const affectedGlyphNames = new Set<string>([
        ...sourceGlyphNames,
        ...recomposeGlyphNames,
        ...invalidateGlyphNames
    ]);

    return {
        allTargets,
        recomposeTargets,
        invalidateTargets,
        dependentTargets,
        affectedGlyphNames,
        recomposeGlyphNames,
        invalidateGlyphNames
    };
}

/**
 * Convenience shortcut: derive the set of edit kinds from a drag type and
 * optional selection-state flags.  This ensures every drag-end path produces
 * the same union closure as a keyboard edit with the same selection.
 */
export function deriveEditKindsFromDrag(
    dragType: string | null,
    hasGeometryInSelection: boolean,
    hasAnchorsInSelection: boolean,
    hasComponentsInSelection: boolean
): Set<RecompositionEditKind> {
    const kinds = new Set<RecompositionEditKind>();

    switch (dragType) {
        case 'point':
            kinds.add('outline');
            break;
        case 'anchor':
            kinds.add('anchor');
            break;
        case 'component':
            kinds.add('component');
            break;
        case 'sidebearing':
            kinds.add('sidebearing');
            break;
        case 'transform':
            if (hasGeometryInSelection) kinds.add('outline');
            if (hasAnchorsInSelection) kinds.add('anchor');
            if (hasComponentsInSelection) kinds.add('component');
            break;
        default:
            // Fallback: add only outline as a safe default.
            kinds.add('outline');
            break;
    }

    if (kinds.size === 0) {
        kinds.add('outline');
    }

    return kinds;
}

/**
 * Resolve Yjs layer-sync targets from a closure result.
 * Replay stays wide; changed-layer snapshots stay lean (source + recompose).
 */
export function resolveLayerSyncTargetsFromClosure(
    closure: RecompositionClosure,
    sourceTargets: WorkerReplayTarget[]
): {
    changedLayerTargets: WorkerReplayTarget[];
    workerReplayTargets: WorkerReplayTarget[];
} {
    const normalizedSource = normalizeWorkerReplayTargets(sourceTargets);
    return {
        changedLayerTargets: normalizeWorkerReplayTargets([
            ...normalizedSource,
            ...closure.recomposeTargets
        ]),
        workerReplayTargets:
            closure.allTargets.length > 0
                ? closure.allTargets
                : normalizedSource
    };
}
