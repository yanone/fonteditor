const {
    buildCompileAndShapeFontCacheKey,
    buildCompileAndShapeFontRevisionKey,
    resolveCompileAndShapeFontCompilation
} = require('../js/compile-and-shape-font-cache');

describe('compile_and_shape_font cache helpers', () => {
    it('reuses compile artifacts but still re-evaluates subset shaping per call', async () => {
        const cacheKey = buildCompileAndShapeFontCacheKey(
            {
                pluginId: 'memory',
                fontPath: 'memory:///font.glyphs',
                changeVersion: 12
            },
            'hello'
        );
        const fontRevisionKey = buildCompileAndShapeFontRevisionKey({
            pluginId: 'memory',
            fontPath: 'memory:///font.glyphs',
            changeVersion: 12
        });
        const fullFont = new Uint8Array([1, 2, 3]);
        const subsetFontAB = new Uint8Array([4, 5, 6]);
        const subsetFontAC = new Uint8Array([7, 8, 9]);
        const compileFullFont = jest.fn(async () => fullFont);
        const compileSubsetFont = jest
            .fn()
            .mockResolvedValueOnce(subsetFontAB)
            .mockResolvedValueOnce(subsetFontAC);
        const firstShapeSubsetWithFont = jest.fn(async () => ({
            glyphs: ['a', 'b', 'a']
        }));
        const secondShapeSubsetWithFont = jest.fn(async () => ({
            glyphs: ['a', 'c']
        }));

        const firstResult = await resolveCompileAndShapeFontCompilation({
            cacheEntry: null,
            fontRevisionKey,
            cacheKey,
            fullFontMode: false,
            text: 'hello',
            shapeOptions: {
                variationLocation: { wght: 400 }
            },
            compileFullFont,
            shapeSubsetWithFont: firstShapeSubsetWithFont,
            compileSubsetFont
        });

        const secondResult = await resolveCompileAndShapeFontCompilation({
            cacheEntry: firstResult.cacheEntry,
            fontRevisionKey,
            cacheKey,
            fullFontMode: false,
            text: 'hello',
            shapeOptions: {
                variationLocation: { wght: 700 }
            },
            compileFullFont,
            shapeSubsetWithFont: secondShapeSubsetWithFont,
            compileSubsetFont
        });

        expect(compileFullFont).toHaveBeenCalledTimes(1);
        expect(firstShapeSubsetWithFont).toHaveBeenCalledTimes(1);
        expect(secondShapeSubsetWithFont).toHaveBeenCalledTimes(1);
        expect(compileSubsetFont).toHaveBeenCalledTimes(2);
        expect(firstResult.compiledFont).toBe(subsetFontAB);
        expect(secondResult.compiledFont).toBe(subsetFontAC);
    });

    it('reuses the cached subset compilation when the shaped subset stays the same', async () => {
        const cacheKey = buildCompileAndShapeFontCacheKey(
            {
                pluginId: 'memory',
                fontPath: 'memory:///font.glyphs',
                changeVersion: 12
            },
            'helo'
        );
        const fontRevisionKey = buildCompileAndShapeFontRevisionKey({
            pluginId: 'memory',
            fontPath: 'memory:///font.glyphs',
            changeVersion: 12
        });
        const fullFont = new Uint8Array([1, 2, 3]);
        const subsetFont = new Uint8Array([4, 5, 6]);
        const compileFullFont = jest.fn(async () => fullFont);
        const compileSubsetFont = jest.fn(async () => subsetFont);
        const shapeSubsetWithFont = jest.fn(async () => ({
            glyphs: ['b', 'a', 'b']
        }));

        const firstResult = await resolveCompileAndShapeFontCompilation({
            cacheEntry: null,
            fontRevisionKey,
            cacheKey,
            fullFontMode: false,
            text: 'helo',
            shapeOptions: {
                variationLocation: { wght: 400 }
            },
            compileFullFont,
            shapeSubsetWithFont,
            compileSubsetFont
        });

        const secondResult = await resolveCompileAndShapeFontCompilation({
            cacheEntry: firstResult.cacheEntry,
            fontRevisionKey,
            cacheKey: buildCompileAndShapeFontCacheKey(
                {
                    pluginId: 'memory',
                    fontPath: 'memory:///font.glyphs',
                    changeVersion: 12
                },
                'abcdef'
            ),
            fullFontMode: false,
            text: 'abcdef',
            shapeOptions: {
                variationLocation: { wght: 700 }
            },
            compileFullFont,
            shapeSubsetWithFont,
            compileSubsetFont
        });

        expect(compileFullFont).toHaveBeenCalledTimes(1);
        expect(shapeSubsetWithFont).toHaveBeenCalledTimes(2);
        expect(compileSubsetFont).toHaveBeenCalledTimes(1);
        expect(secondResult.compiledFont).toBe(subsetFont);
    });
});
