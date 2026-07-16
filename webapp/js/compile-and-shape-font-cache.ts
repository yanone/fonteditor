export type CompileAndShapeFontRevision = {
    pluginId: string;
    fontPath: string;
    changeVersion: number | null;
};

export type CompileAndShapeFontCacheEntry = {
    fontRevisionKey: string;
    requestKey: string;
    fullCommittedFont: Uint8Array;
    subsetGlyphKey: string | null;
    subsetCompiledFont: Uint8Array | null;
};

type ShapeSubsetOptions = {
    features?: string;
    variationLocation?: Record<string, number>;
};

type ShapeSubsetResult = {
    glyphs: string[];
};

type ResolveCompileAndShapeFontCompilationParams = {
    cacheEntry: CompileAndShapeFontCacheEntry | null;
    fontRevisionKey: string;
    cacheKey: string;
    fullFontMode: boolean;
    text: string;
    shapeOptions: ShapeSubsetOptions;
    compileFullFont: () => Promise<Uint8Array>;
    shapeSubsetWithFont: (
        fontBytes: Uint8Array,
        text: string,
        options: ShapeSubsetOptions
    ) => Promise<ShapeSubsetResult>;
    compileSubsetFont: (subsetGlyphs: string[]) => Promise<Uint8Array>;
};

export function getOrderedUniqueTextKey(text: string): string {
    return Array.from(new Set(Array.from(text))).join('');
}

export function buildCompileAndShapeFontCacheKey(
    fontRevision: CompileAndShapeFontRevision,
    text: string
): string {
    return JSON.stringify({
        fontRevisionKey: buildCompileAndShapeFontRevisionKey(fontRevision),
        orderedUniqueTextKey: getOrderedUniqueTextKey(text)
    });
}

export function buildCompileAndShapeFontRevisionKey(
    fontRevision: CompileAndShapeFontRevision
): string {
    return JSON.stringify(fontRevision);
}

export function buildSubsetGlyphKey(subsetGlyphs: string[]): string {
    const normalizedSubsetGlyphs = Array.from(
        new Set((subsetGlyphs || []).filter((glyph) => !!glyph))
    ).sort();

    return JSON.stringify(normalizedSubsetGlyphs);
}

export async function resolveCompileAndShapeFontCompilation({
    cacheEntry,
    fontRevisionKey,
    cacheKey,
    fullFontMode,
    text,
    shapeOptions,
    compileFullFont,
    shapeSubsetWithFont,
    compileSubsetFont
}: ResolveCompileAndShapeFontCompilationParams): Promise<{
    cacheEntry: CompileAndShapeFontCacheEntry;
    compiledFont: Uint8Array;
    subsetGlyphs: string[];
}> {
    const matchingFontRevisionCache =
        cacheEntry?.fontRevisionKey === fontRevisionKey ? cacheEntry : null;
    const fullCommittedFont =
        matchingFontRevisionCache?.fullCommittedFont ||
        (await compileFullFont());

    if (fullFontMode) {
        return {
            compiledFont: fullCommittedFont,
            subsetGlyphs: [],
            cacheEntry: {
                fontRevisionKey,
                requestKey: cacheKey,
                fullCommittedFont,
                subsetGlyphKey: null,
                subsetCompiledFont: null
            }
        };
    }

    const subsetSeedShape = await shapeSubsetWithFont(
        fullCommittedFont,
        text,
        shapeOptions
    );
    const cmapSeedShape = shapeOptions.features
        ? await shapeSubsetWithFont(fullCommittedFont, text, {
              variationLocation: shapeOptions.variationLocation
          })
        : null;
    const subsetGlyphs = Array.from(
        new Set(
            [
                ...subsetSeedShape.glyphs,
                ...(cmapSeedShape?.glyphs || [])
            ].filter((glyphName) => glyphName && glyphName !== '.notdef')
        )
    );
    const subsetGlyphKey = buildSubsetGlyphKey(subsetGlyphs);
    const subsetCompiledFont =
        matchingFontRevisionCache?.subsetGlyphKey === subsetGlyphKey &&
        matchingFontRevisionCache.subsetCompiledFont
            ? matchingFontRevisionCache.subsetCompiledFont
            : await compileSubsetFont(subsetGlyphs);

    return {
        compiledFont: subsetCompiledFont,
        subsetGlyphs,
        cacheEntry: {
            fontRevisionKey,
            requestKey: cacheKey,
            fullCommittedFont,
            subsetGlyphKey,
            subsetCompiledFont
        }
    };
}
