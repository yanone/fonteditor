/**
 * Shared glyph-rename preflight used by the rename dialog and Font.renameGlyphs.
 */

export type GlyphRenamePreflightOptions = {
    /** When true, missing source names are reported as errors. */
    requireSourcesExist?: boolean;
};

/**
 * Per-source preflight errors for a simultaneous rename map.
 * Keys are current (old) glyph names.
 */
export function getGlyphRenamePreflightErrors(
    renames: ReadonlyMap<string, string>,
    existingNames: Iterable<string>,
    options: GlyphRenamePreflightOptions = {}
): Map<string, string> {
    const requireSourcesExist = options.requireSourcesExist === true;
    const allNames = new Set(existingNames);
    const errors = new Map<string, string>();
    const targetSources = new Map<string, string[]>();

    for (const [oldName, newName] of renames) {
        if (requireSourcesExist && (!oldName || !allNames.has(oldName))) {
            errors.set(
                oldName || '',
                oldName
                    ? `Cannot rename glyph "${oldName}".`
                    : 'Glyph names cannot be empty.'
            );
        }
        if (!newName) {
            errors.set(oldName, 'Glyph names cannot be empty.');
        }
        const sources = targetSources.get(newName) || [];
        sources.push(oldName);
        targetSources.set(newName, sources);
        allNames.delete(oldName);
    }

    for (const [newName, sources] of targetSources) {
        if (!newName) {
            continue;
        }
        if (sources.length > 1) {
            for (const source of sources) {
                errors.set(source, `Duplicates ${newName}.`);
            }
        }
        if (allNames.has(newName)) {
            for (const source of sources) {
                errors.set(source, 'already exists');
            }
        }
    }

    return errors;
}

/**
 * Throw if a rename map fails shared preflight.
 * Used by Font.renameGlyphs before any mutation.
 */
export function assertGlyphRenamePreflight(
    renames: ReadonlyMap<string, string>,
    existingNames: Iterable<string>
): void {
    const errors = getGlyphRenamePreflightErrors(renames, existingNames, {
        requireSourcesExist: true
    });
    if (errors.size === 0) {
        return;
    }
    const firstError = [...errors.values()][0];
    throw new Error(firstError || 'Glyph rename preflight failed.');
}
