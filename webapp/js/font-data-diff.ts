export type FontDataPatchOperation = {
    op: 'add' | 'remove' | 'replace';
    path: (string | number)[];
    value?: unknown;
};

export type FontDataPatchPair = {
    forward: FontDataPatchOperation;
    inverse: FontDataPatchOperation;
};

function cloneValue<T>(value: T): T {
    if (value === undefined) {
        return value;
    }
    return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function valuesDiffer(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) !== JSON.stringify(right);
}

/**
 * Derive forward and inverse structural operations between two font snapshots.
 * Glyphs and layers are keyed by their stable names and ids; other arrays stay
 * atomic so their ordering and storage representation remain schema-safe.
 */
export function diffFontDataToPatchPairs(
    beforeValue: unknown,
    afterValue: unknown,
    path: (string | number)[] = [],
    collectionKind: 'glyphs' | 'layers' | null = null,
    patchPairs: FontDataPatchPair[] = []
): FontDataPatchPair[] {
    if (beforeValue === undefined && afterValue === undefined) {
        return patchPairs;
    }

    if (beforeValue === undefined) {
        patchPairs.push({
            forward: { op: 'add', path, value: cloneValue(afterValue) },
            inverse: { op: 'remove', path }
        });
        return patchPairs;
    }

    if (afterValue === undefined) {
        patchPairs.push({
            forward: { op: 'remove', path },
            inverse: { op: 'add', path, value: cloneValue(beforeValue) }
        });
        return patchPairs;
    }

    if (Array.isArray(beforeValue) && Array.isArray(afterValue)) {
        if (collectionKind === 'glyphs' || collectionKind === 'layers') {
            const keyField = collectionKind === 'glyphs' ? 'name' : 'id';
            const beforeEntries = beforeValue.flatMap((item) => {
                if (!isPlainObject(item)) {
                    return [];
                }
                const key = String(item[keyField] ?? '');
                return key
                    ? ([[key, item]] as Array<
                          [string, Record<string, unknown>]
                      >)
                    : [];
            });
            const afterEntries = afterValue.flatMap((item) => {
                if (!isPlainObject(item)) {
                    return [];
                }
                const key = String(item[keyField] ?? '');
                return key
                    ? ([[key, item]] as Array<
                          [string, Record<string, unknown>]
                      >)
                    : [];
            });
            const beforeMap = new Map(beforeEntries);
            const afterMap = new Map(afterEntries);
            const keys = new Set([...beforeMap.keys(), ...afterMap.keys()]);
            for (const key of keys) {
                diffFontDataToPatchPairs(
                    beforeMap.get(key),
                    afterMap.get(key),
                    [...path, key],
                    null,
                    patchPairs
                );
            }

            const beforeOrder = beforeEntries.map(([key]) => key);
            const afterOrder = afterEntries.map(([key]) => key);
            if (valuesDiffer(beforeOrder, afterOrder)) {
                const orderPath =
                    collectionKind === 'glyphs'
                        ? ['glyphOrder']
                        : [...path.slice(0, -1), 'layerOrder'];
                patchPairs.push({
                    forward: {
                        op: 'replace',
                        path: orderPath,
                        value: afterOrder
                    },
                    inverse: {
                        op: 'replace',
                        path: orderPath,
                        value: beforeOrder
                    }
                });
            }
            return patchPairs;
        }

        if (valuesDiffer(beforeValue, afterValue)) {
            patchPairs.push({
                forward: { op: 'replace', path, value: cloneValue(afterValue) },
                inverse: {
                    op: 'replace',
                    path,
                    value: cloneValue(beforeValue)
                }
            });
        }
        return patchPairs;
    }

    if (isPlainObject(beforeValue) && isPlainObject(afterValue)) {
        const keys = new Set([
            ...Object.keys(beforeValue),
            ...Object.keys(afterValue)
        ]);
        for (const key of keys) {
            diffFontDataToPatchPairs(
                beforeValue[key],
                afterValue[key],
                [...path, key],
                key === 'glyphs'
                    ? 'glyphs'
                    : key === 'layers'
                      ? 'layers'
                      : null,
                patchPairs
            );
        }
        return patchPairs;
    }

    if (valuesDiffer(beforeValue, afterValue)) {
        patchPairs.push({
            forward: { op: 'replace', path, value: cloneValue(afterValue) },
            inverse: {
                op: 'replace',
                path,
                value: cloneValue(beforeValue)
            }
        });
    }

    return patchPairs;
}
