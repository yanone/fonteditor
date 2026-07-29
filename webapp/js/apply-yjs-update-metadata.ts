import { normalizeGlyphRenames } from './change-log';

export type ApplyYjsUpdateLayerTarget = {
    glyphName: string;
    layerId: string;
};

/**
 * Sanitize layer targets for worker → WASM applyYjsUpdate metadata.
 * Kept beside the metadata builder so Jest can cover rename forwarding
 * without loading the WASM worker module.
 */
export function sanitizeApplyYjsUpdateLayerTargets(
    layerTargets: unknown,
    maxTargets = 512
): ApplyYjsUpdateLayerTarget[] {
    if (!Array.isArray(layerTargets)) {
        throw new Error('applyYjsUpdate requires an array of layer targets');
    }

    if (layerTargets.length > maxTargets) {
        throw new Error(
            `applyYjsUpdate received ${layerTargets.length} targets; max ${maxTargets}`
        );
    }

    return layerTargets.map((target, index) => {
        const glyphName =
            typeof target?.glyphName === 'string'
                ? target.glyphName.trim()
                : '';
        const layerId =
            typeof target?.layerId === 'string' ? target.layerId.trim() : '';

        if (!glyphName) {
            throw new Error(
                `applyYjsUpdate target ${index} must include a non-empty glyphName`
            );
        }
        if (!layerId) {
            throw new Error(
                `applyYjsUpdate target ${index} must include a non-empty layerId`
            );
        }

        return { glyphName, layerId };
    });
}

/**
 * Build the JSON metadata payload for `apply_yjs_update`.
 * Pure helper so Jest can assert rename identity records are forwarded.
 */
export function buildApplyYjsUpdateMetadataJson(options: {
    changedGlyphs?: unknown;
    nonGlyphChangeHints?: unknown;
    layerTargets?: unknown;
    glyphRenames?: unknown;
    invalidateLayoutClosure?: unknown;
}): string {
    const sanitizedLayerTargets = sanitizeApplyYjsUpdateLayerTargets(
        Array.isArray(options.layerTargets) ? options.layerTargets : []
    );
    const glyphRenames = glyphRenamesForApplyYjsUpdateMetadata(
        options.glyphRenames
    );
    return JSON.stringify({
        changedGlyphs: Array.isArray(options.changedGlyphs)
            ? options.changedGlyphs
            : [],
        nonGlyphChangeHints: Array.isArray(options.nonGlyphChangeHints)
            ? options.nonGlyphChangeHints
            : [],
        layerTargets: sanitizedLayerTargets,
        ...(glyphRenames.length ? { glyphRenames } : {}),
        invalidateLayoutClosure: options.invalidateLayoutClosure === true
    });
}

/** Normalize glyphRenames for metadata once forwarding is enabled. */
export function glyphRenamesForApplyYjsUpdateMetadata(
    glyphRenames: unknown
): ReturnType<typeof normalizeGlyphRenames> {
    return normalizeGlyphRenames(
        Array.isArray(glyphRenames) ? glyphRenames : []
    );
}
