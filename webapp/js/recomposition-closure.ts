/**
 * Shared cascading layer recomposition closure.
 *
 * The single entry point for determining which glyphs and layers need worker
 * cache refresh after a visual edit.  Every edit path (keyboard, mouse drag,
 * drag-end, undo, redo, remote, Python) MUST derive its replay targets
 * through this function so the Rust Y.Doc, canonical JSON, subset, font, and
 * filter caches are invalidated consistently.
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
    | 'outline'
    | 'anchor'
    | 'sidebearing'
    | 'component';

export type RecompositionScope = 'visible' | 'all';

export type RecompositionSourceTarget = WorkerReplayTarget & {
    /** Optional human-readable hint for diagnostics. */
    hint?: string;
};

export type RecompositionClosure = {
    /**
     * The authoritative superset: source targets + all derived dependents.
     * Every consumer MUST stamp this as `workerReplayTargets` on the committed
     * Yjs packet's metadata.
     */
    allTargets: WorkerReplayTarget[];

    /** Derived dependents only (not including source targets). */
    dependentTargets: WorkerReplayTarget[];

    /** Every unique glyph name in the closure (source + dependents). */
    affectedGlyphNames: Set<string>;
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
    invalidateLayoutCachesForGlyphs?: (
        glyphNames: Set<string>
    ) => void;
}

export interface GlyphLike {
    name?: string;
    findLayerById?: (layerId: string) => LayerLike | null | undefined;
    layers?: Array<{ id?: string }>;
}

export interface LayerLike {
    id?: string;
    getMatchingLayerOnGlyph?: (glyphName: string) => LayerLike | null;
}

/**
 * Optional bridge-like adapter for suppressing model recording during
 * recomputation.
 */
export interface RecordingSuppressor {
    runWithoutRecording?: <T>(fn: () => T) => T;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Compute the full recomposition closure for a visual edit.
 *
 * @param options.sourceTargets   The directly edited glyph/layer pairs.
 * @param options.editKinds       Active edit kinds (outline, anchor, etc.).
 *                                Mixed selections produce a superset.
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
export function computeLayerRecompositionClosure(
    options: {
        sourceTargets: RecompositionSourceTarget[];
        editKinds: Set<RecompositionEditKind>;
        scope: RecompositionScope;
        fontModel: FontModelLike;
        activeLayerId?: string | null;
        sourceGlyphName?: string | null;
        suppressor?: RecordingSuppressor | null;
        visibleGlyphNames?: Iterable<string>;
    }
): RecompositionClosure {
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

    // Guard: no font model → return source targets as-is.
    if (!fontModel) {
        const allTargets = normalizeWorkerReplayTargets(sourceTargets);
        return {
            allTargets,
            dependentTargets: [],
            affectedGlyphNames: new Set(
                sourceTargets.map((t) => t.glyphName).filter(Boolean)
            )
        };
    }

    // ── 1. Seed glyph set ──────────────────────────────────────────────
    const sourceGlyphNames = new Set(
        sourceTargets
            .map((t) => t.glyphName)
            .filter((n): n is string => !!n)
    );
    const allGlyphNames = new Set(sourceGlyphNames);

    // Build visible glyph set for `visible` scope.
    const visibleSet =
        scope === 'visible' && visibleGlyphNames
            ? new Set(visibleGlyphNames)
            : null;

    // ── 2. Define the recompute wrapper ─────────────────────────────────
    const wrap = <T>(fn: () => T): T => {
        if (suppressor?.runWithoutRecording) {
            return suppressor.runWithoutRecording(fn);
        }
        return fn();
    };

    // ── 3. Component-reference dependents ───────────────────────────────
    //    Glyphs whose components reference the edited source glyph
    //    (e.g. adieresis references a).  Needed for every edit kind because
    //    any change to the source glyph (outline, anchor, sidebearing, or
    //    component transform) means composite-dependent glyphs must have
    //    their subset/font/filter cache entries refreshed — even when the
    //    edit only touched sidebearings, the composite glyph is in the
    //    compile subset and its cached data must be current.
    if (
        editKinds.has('outline') ||
        editKinds.has('anchor') ||
        editKinds.has('sidebearing') ||
        editKinds.has('component')
    ) {
        if (typeof fontModel.collectComponentDependentGlyphs === 'function') {
            const collected = wrap(() =>
                fontModel.collectComponentDependentGlyphs!(sourceGlyphNames, {
                    ...(scope === 'visible' && visibleSet
                        ? { retainGlyphNames: visibleSet }
                        : {})
                })
            );
            for (const depGlyphName of collected) {
                allGlyphNames.add(depGlyphName);
            }
        }
    }

    // ── 4. Automatic composites ─────────────────────────────────────────
    //    Glyphs whose layers are auto-composed from anchors / components.
    if (
        editKinds.has('anchor') ||
        editKinds.has('sidebearing') ||
        editKinds.has('outline') ||
        editKinds.has('component')
    ) {
        if (
            typeof fontModel.rebuildAutomaticCompositesForGlyphs === 'function'
        ) {
            const preferredTarget = sourceTargets[0] ?? null;
            const affectedComposites: Set<string> = wrap(() => {
                // Invalidate layout caches within the visible scope when applicable.
                if (
                    scope === 'visible' &&
                    visibleSet &&
                    typeof fontModel.invalidateLayoutCachesForGlyphs === 'function'
                ) {
                    fontModel.invalidateLayoutCachesForGlyphs(visibleSet);
                }

                const composites =
                    fontModel.rebuildAutomaticCompositesForGlyphs!(
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
                return composites;
            });

            for (const glyphName of affectedComposites) {
                allGlyphNames.add(glyphName);
            }
        }
    }

    // ── 5. Metrics-key dependents ───────────────────────────────────────
    //    Glyphs whose sidebearings inherit from the edited glyph.
    if (
        editKinds.has('sidebearing') ||
        editKinds.has('outline') ||
        editKinds.has('component')
    ) {
        if (typeof fontModel.recomputeMetricsKeys === 'function') {
            const metricsDeps = wrap(() =>
                fontModel.recomputeMetricsKeys!(sourceGlyphNames)
            );
            for (const depGlyphName of metricsDeps) {
                allGlyphNames.add(depGlyphName);
            }
        }
    }

    // ── 6. Build replay targets for dependent glyphs ────────────────────
    //    Find the matching layer (same master) on each dependent glyph.
    const sourceLayer =
        sourceGlyphName && activeLayerId
            ? fontModel.findGlyph?.(sourceGlyphName)?.findLayerById?.(activeLayerId)
            : null;

    const dependentTargets: WorkerReplayTarget[] = [];

    for (const glyphName of allGlyphNames) {
        if (sourceGlyphNames.has(glyphName)) continue;

        const glyph = fontModel.findGlyph?.(glyphName);
        if (!glyph) continue;

        // Try to find the matching layer: same layer ID first, then by master.
        const matchedLayer =
            (activeLayerId ? glyph.findLayerById?.(activeLayerId) : null) ??
            sourceLayer?.getMatchingLayerOnGlyph?.(glyphName) ??
            null;

        if (matchedLayer?.id) {
            dependentTargets.push({
                glyphName,
                layerId: matchedLayer.id
            });
        }
    }

    const allTargets = normalizeWorkerReplayTargets([
        ...sourceTargets,
        ...dependentTargets
    ]);

    return {
        allTargets,
        dependentTargets,
        affectedGlyphNames: allGlyphNames
    };
}

/**
 * Convenience shortcut: derive the set of edit kinds from a drag type and
 * optional selection-state flags.  This ensures every drag-end path produces
 * the same superset closure as a keyboard edit with the same selection.
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