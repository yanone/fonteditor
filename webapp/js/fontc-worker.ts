// Web Worker for fontc WASM compilation with babelfont-rs
// Direct .babelfont JSON → TTF compilation (no file system)
// Consolidated worker supporting multiple message protocols

import init, {
    compile_babelfont,
    store_font,
    interpolate_glyph,
    clear_font_cache,
    open_font_file,
    get_glyphs_outlines,
    version
} from '../wasm-dist/babelfont_fontc_web.js';

// Note: This is a Web Worker, cannot import Logger from main thread
// Using standard console.log with facility prefix

let initialized = false;
let cachedBabelfontJson: string | null = null; // Cache babelfont JSON for re-use

/**
 * Strip layerData fields from components in the font JSON,
 * ensure all layers have a shapes array,
 * convert old enum formats to new formats,
 * and filter out AssociatedWithMaster layers that aren't brace layers
 *
 * layerData is a runtime-only field used for rendering nested components
 * and must not be saved to files or passed to fontc compilation.
 *
 * Old enum formats (from typeshare):
 *   LayerType: {type: "DefaultForMaster", master: "id"}
 *   Shape: {type: "Path", path: {...}} or {type: "Component", component: {...}}
 *
 * New enum formats (actual babelfont-rs serde):
 *   LayerType: {DefaultForMaster: "id"}
 *   Shape: {Path: {...}} or {Component: {...}}
 *
 * AssociatedWithMaster layers without location data are old backup layers
 * that should not be compiled.
 */
function stripLayerData(fontData: any): any {
    if (!fontData || typeof fontData !== 'object') return fontData;

    // Deep clone to avoid mutating original
    const cleaned = JSON.parse(JSON.stringify(fontData));

    // Temporarily remove guides from masters to avoid serialization issues
    // TODO: Fix guide format conversion
    if (cleaned.masters && Array.isArray(cleaned.masters)) {
        cleaned.masters.forEach((master: any) => {
            if (master.guides) {
                delete master.guides;
            }
        });
    }

    // Process all glyphs (handle both array and object formats)
    if (cleaned.glyphs) {
        const isArray = Array.isArray(cleaned.glyphs);
        const glyphs = isArray ? cleaned.glyphs : Object.values(cleaned.glyphs);

        glyphs.forEach((glyph: any) => {
            if (!glyph || !glyph.layers) return;

            // Shapes are already in correct format from babelfont-rs (serde untagged)
            // No transformation needed

            // Validate dotaccentcomb before filtering
            if (glyph.name === 'dotaccentcomb') {
                console.log(
                    `[Fontc Worker] dotaccentcomb BEFORE filtering: ${glyph.layers.length} layers`
                );
                glyph.layers.forEach((layer: any, i: number) => {
                    const masterType =
                        layer.master && typeof layer.master === 'object'
                            ? 'type' in layer.master
                                ? layer.master.type
                                : Object.keys(layer.master)[0]
                            : 'none';
                    console.log(
                        `  Layer ${i}: master=${masterType}, shapes=${layer.shapes?.length || 0}, location=${JSON.stringify(layer.location || {})}`
                    );
                    if (layer.shapes && layer.shapes.length > 0) {
                        console.log(
                            `    First shape keys: ${Object.keys(layer.shapes[0]).join(',')}`
                        );
                    }
                });
            }

            // Filter out AssociatedWithMaster layers without location data
            // (these are old backup layers, not brace layers)
            glyph.layers = glyph.layers.filter((layer: any) => {
                if (!layer || !layer.master) return true;

                const master = layer.master;

                // Handle internally tagged format: {type: "DefaultForMaster", master: "id"}
                if ('type' in master) {
                    if (master.type === 'DefaultForMaster') return true;
                    if (master.type === 'FreeFloating') return true;
                    if (master.type === 'AssociatedWithMaster') {
                        // Only keep if it has location data (brace layer)
                        return (
                            layer.location &&
                            Object.keys(layer.location).length > 0
                        );
                    }
                }

                // Handle externally tagged format (from CLI): {"DefaultForMaster": "id"}
                // Convert to internally tagged for WASM compatibility
                if ('DefaultForMaster' in master) {
                    layer.master = {
                        type: 'DefaultForMaster',
                        master: master.DefaultForMaster
                    };
                    return true;
                }
                if (
                    'FreeFloating' in master ||
                    Object.keys(master).length === 0
                ) {
                    layer.master = { type: 'FreeFloating' };
                    return true;
                }
                if ('AssociatedWithMaster' in master) {
                    layer.master = {
                        type: 'AssociatedWithMaster',
                        master: master.AssociatedWithMaster
                    };
                    // Only keep if it has location data (brace layer)
                    return (
                        layer.location && Object.keys(layer.location).length > 0
                    );
                }

                return true;
            });

            // Validate dotaccentcomb AFTER filtering
            if (glyph.name === 'dotaccentcomb') {
                console.log(
                    `[Fontc Worker] dotaccentcomb AFTER filtering: ${glyph.layers.length} layers`
                );
                glyph.layers.forEach((layer: any, i: number) => {
                    const masterType =
                        layer.master && typeof layer.master === 'object'
                            ? 'type' in layer.master
                                ? `{type: ${layer.master.type}}`
                                : Object.keys(layer.master)[0]
                            : 'none';
                    console.log(
                        `  Layer ${i}: master=${masterType}, shapes=${layer.shapes?.length || 0}, has location: ${!!(layer.location && Object.keys(layer.location).length > 0)}`
                    );
                });
            }

            // Process remaining layers
            for (const layer of glyph.layers) {
                // Ensure layer has a shapes array (even if empty)
                if (!layer.shapes) {
                    layer.shapes = [];
                }

                // Clean component layerData (runtime-only field)
                if (Array.isArray(layer.shapes)) {
                    for (const shape of layer.shapes) {
                        if (!shape || typeof shape !== 'object') continue;

                        // Components have 'reference' field (unwrapped format from babelfont-rs)
                        if ('reference' in shape) {
                            if ('layerData' in shape) {
                                delete shape.layerData;
                            }

                            // Don't add transform if it doesn't exist
                            // The Rust compiler will handle missing transforms as identity
                            if (shape.transform) {
                                const t = shape.transform;
                                // Only add missing fields if transform exists, preserve order field
                                if (!t.scale) t.scale = [1, 1];
                                if (t.rotation === undefined) t.rotation = 0;
                                if (!t.skew) t.skew = [0, 0];
                                if (!t.translation) t.translation = [0, 0];
                                if (!t.order) t.order = 'RestOfTheWorld';
                            }
                        }
                    }
                }

                // Temporarily remove guides to avoid serialization issues
                // TODO: Fix guide format conversion
                if (layer.guides) {
                    delete layer.guides;
                }
            }
        });
    }

    return cleaned;
}

/**
 * Validate font data and report any issues
 * Also filters out glyphs with empty shapes to prevent compilation errors
 */
function validateFontData(fontData: any): void {
    if (!fontData.glyphs) {
        console.warn('[Fontc Worker] ⚠️ No glyphs in font data');
        return;
    }

    const issues: string[] = [];
    const glyphIndicesToRemove: number[] = [];

    // Handle both array and object formats
    const isArray = Array.isArray(fontData.glyphs);
    const glyphs = isArray ? fontData.glyphs : Object.values(fontData.glyphs);

    glyphs.forEach((glyph: any, index: number) => {
        if (!glyph) return; // Skip null/undefined entries

        const glyphName = glyph.name || `index ${index}`;

        if (!glyph.layers || glyph.layers.length === 0) {
            issues.push(`Glyph "${glyphName}" has no layers`);
            if (isArray) glyphIndicesToRemove.push(index);
            return;
        }

        // Check if ALL layers are empty
        let allLayersEmpty = true;
        for (let i = 0; i < glyph.layers.length; i++) {
            const layer = glyph.layers[i];

            if (!layer.shapes) {
                const presentFields = Object.keys(layer).join(', ');
                issues.push(
                    `Glyph "${glyphName}" layer ${i} has no shapes array (has: ${presentFields})`
                );
            } else if (layer.shapes.length === 0) {
                issues.push(
                    `Glyph "${glyphName}" layer ${i} has empty shapes array`
                );
            } else {
                allLayersEmpty = false;
            }
        }

        // If all layers are empty, mark glyph for removal
        if (allLayersEmpty && isArray) {
            glyphIndicesToRemove.push(index);
        }
    });

    if (issues.length > 0) {
        console.warn('[Fontc Worker] ⚠️ Font data validation issues:');
        issues.slice(0, 5).forEach((issue) => console.warn(`  - ${issue}`));
        if (issues.length > 5) {
            console.warn(`  ... and ${issues.length - 5} more issues`);
        }
    }

    // Remove glyphs with all empty layers to prevent compilation errors
    if (isArray && glyphIndicesToRemove.length > 0) {
        console.warn(
            `[Fontc Worker] 🗑️ Removing ${glyphIndicesToRemove.length} glyphs with all empty layers from compilation`
        );
        // Filter out the glyphs by creating a new array without them
        fontData.glyphs = fontData.glyphs.filter(
            (_: any, idx: number) => !glyphIndicesToRemove.includes(idx)
        );
    }
}

console.log('[Fontc Worker] Starting...');

async function initializeWasm() {
    try {
        // Check if SharedArrayBuffer is available
        if (typeof SharedArrayBuffer === 'undefined') {
            throw new Error(
                'SharedArrayBuffer is not available. Make sure the page is served with proper CORS headers:\n' +
                    'Cross-Origin-Embedder-Policy: require-corp\n' +
                    'Cross-Origin-Opener-Policy: same-origin'
            );
        }

        console.log('[Fontc Worker] Loading babelfont-fontc WASM...');
        await init();

        console.log(
            '[Fontc Worker] Skipping thread pool due to browser limitations...'
        );
        // NOTE: initThreadPool causes Memory cloning errors in some browsers (Brave, etc.)
        // Skip it - fontc will run single-threaded but still works
        // await initThreadPool(1);

        initialized = true;
        const ver = version();
        console.log('[Fontc Worker] Ready (single-threaded mode)!');
        console.log('[Fontc Worker] Using direct .babelfont → TTF pipeline');
        console.log('[Fontc Worker] Version:', ver);

        return ver;
    } catch (error: any) {
        console.error('[Fontc Worker] Initialization error:', error);
        throw error;
    }
}

// Handle compilation requests - supports both message protocols
self.onmessage = async (event) => {
    const data = event.data;

    // Debug: log all incoming messages with full details
    console.log(
        '[Fontc Worker] Received message:',
        JSON.stringify({
            type: data.type,
            hasJson: !!data.babelfontJson,
            hasGlyphName: !!data.glyphName,
            hasLocation: !!data.location,
            id: data.id,
            filename: data.filename
        })
    );

    // Protocol 1: Type-based messages
    if (data.type === 'init') {
        try {
            const ver: string = await initializeWasm();
            self.postMessage({ type: 'ready', version: ver });
        } catch (error: any) {
            self.postMessage({
                type: 'error',
                error: error.message,
                stack: error.stack
            });
        }
        return;
    }

    if (data.type === 'compile') {
        self.postMessage({
            type: 'debug',
            message: `[Worker] Entered type=compile handler, initialized=${initialized}`
        });

        if (!initialized) {
            self.postMessage({
                type: 'error',
                id: data.id,
                error: 'Worker not initialized'
            });
            return;
        }

        try {
            const startTime = performance.now();

            // Clean font data before compilation
            const fontData = JSON.parse(data.babelfontJson);
            // TEMPORARY: Bypass stripLayerData to isolate issue
            const cleanedFontData = fontData;
            // const cleanedFontData = stripLayerData(fontData);

            // Validate font data
            validateFontData(cleanedFontData);

            const cleanedJson = JSON.stringify(cleanedFontData);

            // Send debug info to main thread
            self.postMessage({
                type: 'debug',
                message: `Before compile: ${cleanedFontData.glyphs.length} glyphs, JSON ${cleanedJson.length} bytes, options: ${JSON.stringify(data.options)}`
            });

            const ttfBytes = compile_babelfont(cleanedJson, data.options || {});
            const endTime = performance.now();

            self.postMessage({
                type: 'debug',
                message: `After compile: ttfBytes type=${typeof ttfBytes}, length=${ttfBytes?.length || 0}, constructor=${ttfBytes?.constructor?.name || 'unknown'}`
            });

            console.log(
                `[Fontc Worker] Compiled in ${(endTime - startTime).toFixed(0)}ms`
            );

            self.postMessage({
                type: 'compiled',
                id: data.id,
                result: ttfBytes,
                time_taken: endTime - startTime
            });
        } catch (error: any) {
            console.error('[Fontc Worker] Error:', error);
            self.postMessage({
                type: 'error',
                id: data.id,
                error: error.message,
                stack: error.stack
            });
        }
        return;
    }

    // Handle store font JSON request (before auto-init to ensure it's cached early)
    if (data.type === 'storeFontJson') {
        const { id, babelfontJson } = data;

        console.log(
            `[Fontc Worker] ⭐ storeFontJson handler called, id: ${id}, hasJson: ${!!babelfontJson}`
        );

        if (!babelfontJson) {
            self.postMessage({
                id,
                type: 'storeFontJson',
                error: 'Missing babelfontJson'
            });
            return;
        }

        try {
            // Ensure WASM is initialized before calling store_font
            if (!initialized) {
                console.log(
                    '[Fontc Worker] Initializing WASM before storing font...'
                );
                await initializeWasm();
            }

            console.log(
                `[Fontc Worker] Storing font JSON (${babelfontJson.length} bytes)`
            );

            // Store in cache (both in WASM and in worker)
            store_font(babelfontJson);
            cachedBabelfontJson = babelfontJson;
            console.log(
                '[Fontc Worker] ✅ Font JSON cached in worker memory, cachedBabelfontJson is now:',
                cachedBabelfontJson
                    ? `${cachedBabelfontJson.length} bytes`
                    : 'NULL'
            );

            self.postMessage({
                id,
                type: 'storeFontJson',
                success: true,
                cachedSize: cachedBabelfontJson?.length || 0,
                message: `Font cached: ${cachedBabelfontJson?.length || 0} bytes`
            });
        } catch (e: any) {
            console.error(`[Fontc Worker] Error storing font JSON:`, e);
            self.postMessage({
                id,
                type: 'storeFontJson',
                error: e.toString()
            });
        }
        return;
    }

    // Protocol 2: Direct messages (from font-compilation.js)
    // Auto-initialize if not already done
    if (!initialized) {
        try {
            await initializeWasm();
            self.postMessage({ ready: true });
        } catch (error: any) {
            self.postMessage({
                error: `Failed to initialize babelfont-fontc WASM: ${error.message}`
            });
        }
        return; // Don't process as compilation request
    }

    // Handle interpolation request (check BEFORE compilation)
    if (data.type === 'interpolate') {
        const { id, glyphName, location } = data;

        try {
            console.log(
                `[Fontc Worker] Interpolating glyph '${glyphName}' at location:`,
                location
            );

            const locationJson = JSON.stringify(location);
            const layerJson = interpolate_glyph(glyphName, locationJson);

            console.log(
                `[Fontc Worker] ✅ Interpolation successful for '${glyphName}', layer JSON length:`,
                layerJson.length
            );

            self.postMessage({
                id,
                type: 'interpolate',
                result: layerJson,
                glyphName
            });
        } catch (e: any) {
            console.error('[Fontc Worker] Interpolation error:', e);
            self.postMessage({
                id,
                type: 'interpolate',
                error: e.toString(),
                glyphName
            });
        }
        return;
    }

    // Handle cache clear request (check BEFORE compilation)
    if (data.type === 'clearCache') {
        try {
            clear_font_cache();
            console.log('[Fontc Worker] 🗑️ Font cache cleared');
            self.postMessage({
                type: 'clearCache',
                success: true
            });
        } catch (e: any) {
            console.error('[Fontc Worker] Error clearing cache:', e);
            self.postMessage({
                type: 'clearCache',
                error: e.toString()
            });
        }
        return;
    }

    // Handle open font file request
    if (data.type === 'openFont') {
        const { id, filename, contents } = data;

        if (!filename || !contents) {
            self.postMessage({
                id,
                type: 'openFont',
                error: 'Missing filename or contents'
            });
            return;
        }

        try {
            console.log(`[Fontc Worker] Opening font file: ${filename}`);
            console.log(
                `[Fontc Worker] Contents type: ${typeof contents}, isUint8Array: ${contents instanceof Uint8Array}, length: ${contents.length || contents.byteLength || 'unknown'}`
            );

            // Convert Uint8Array to string for WASM
            // Both OPFS and disk now return Uint8Array consistently
            // Use Latin-1 encoding (1:1 byte mapping) to preserve exact bytes
            // Rust will detect format and decode properly (handles both UTF-8 text and binary plist)
            if (!(contents instanceof Uint8Array)) {
                console.error(
                    `[Fontc Worker] Expected Uint8Array, got:`,
                    typeof contents
                );
                throw new Error(`Expected Uint8Array, got ${typeof contents}`);
            }

            const contentsStr = Array.from(contents, (byte) =>
                String.fromCharCode(byte)
            ).join('');
            console.log(
                `[Fontc Worker] Converted ${contents.length} bytes to Latin-1 string`
            );
            console.log(
                `[Fontc Worker] First 100 bytes:`,
                Array.from(contents.slice(0, 100))
                    .map((b) => b.toString(16).padStart(2, '0'))
                    .join(' ')
            );
            console.log(
                `[Fontc Worker] First 100 chars of string:`,
                contentsStr.substring(0, 100)
            );

            const babelfontJson = open_font_file(filename, contentsStr);
            console.log(
                `[Fontc Worker] Successfully converted to babelfont JSON (${babelfontJson.length} bytes)`
            );

            // Store in cache (both in WASM and in worker)
            store_font(babelfontJson);
            cachedBabelfontJson = babelfontJson;
            console.log('[Fontc Worker] Font cached in worker memory');

            self.postMessage({
                id,
                type: 'openFont',
                babelfontJson,
                filename
            });
        } catch (e: any) {
            console.error(`[Fontc Worker] Error opening font:`, e);
            self.postMessage({
                id,
                type: 'openFont',
                error: e.toString()
            });
        }
        return;
    }

    // Handle get glyph outlines request
    if (data.type === 'getGlyphOutlines') {
        const { id, glyphNames, location, flattenComponents } = data;

        try {
            console.log(
                `[Fontc Worker] Getting outlines for ${glyphNames.length} glyphs`
            );
            console.log(
                `[Fontc Worker] cachedBabelfontJson state: ${cachedBabelfontJson ? `${cachedBabelfontJson.length} bytes` : 'NULL'}`
            );
            console.log(`[Fontc Worker] initialized: ${initialized}`);

            // Ensure font is cached before getting outlines
            if (!cachedBabelfontJson) {
                const errorMsg = 'No font loaded in worker. Open a font first.';
                console.error(`[Fontc Worker] ERROR: ${errorMsg}`);
                self.postMessage({
                    id,
                    type: 'getGlyphOutlines',
                    error: errorMsg,
                    debugInfo: {
                        cacheState: 'null',
                        initialized: initialized,
                        timestamp: Date.now()
                    }
                });
                return;
            }

            // Note: Don't call store_font here - it clears the outline cache!
            // The font is already stored when opened.

            const locationJson =
                Object.keys(location).length > 0
                    ? JSON.stringify(location)
                    : '{}';
            const glyphNamesJson = JSON.stringify(glyphNames);
            const outlinesJson = get_glyphs_outlines(
                glyphNamesJson,
                locationJson,
                flattenComponents
            );

            console.log(
                `[Fontc Worker] Successfully got outlines, JSON length: ${outlinesJson.length}`
            );

            self.postMessage({
                id,
                type: 'getGlyphOutlines',
                outlinesJson
            });
        } catch (e: any) {
            console.error(`[Fontc Worker] Error getting glyph outlines:`, e);
            self.postMessage({
                id,
                type: 'getGlyphOutlines',
                error: e.toString()
            });
        }
        return;
    }

    // Handle compilation request (LEGACY PATH - fallback for messages without explicit type)
    if (
        data.type !== 'compile' &&
        data.type !== 'interpolate' &&
        data.type !== 'clearCache' &&
        !data.type &&
        data.babelfontJson
    ) {
        const start = Date.now();
        const { id, babelfontJson, filename, options } = data;

        // Validate babelfontJson exists
        if (!babelfontJson) {
            console.error(
                '[Fontc Worker] No babelfontJson provided in compilation request, data.type:',
                data.type
            );
            self.postMessage({
                id,
                error: 'No babelfontJson provided in compilation request'
            });
            return;
        }

        try {
            console.log(
                `[Fontc Worker] Compiling ${filename} from .babelfont JSON...`
            );
            console.log(
                `[Fontc Worker] JSON size: ${babelfontJson.length} bytes`
            );
            if (options) {
                console.log(`[Fontc Worker] Options:`, options);
            }

            // STEP 1: Store font in WASM cache for interpolation
            try {
                store_font(babelfontJson);
                cachedBabelfontJson = babelfontJson; // Also cache in worker memory
                console.log('[Fontc Worker] ✅ Font cached in WASM memory');
            } catch (cacheError) {
                console.warn(
                    '[Fontc Worker] ⚠️ Failed to cache font:',
                    cacheError
                );
                // Continue with compilation anyway
            }

            // STEP 2: Clean font data (remove runtime-only layerData fields)
            const fontData = JSON.parse(babelfontJson);
            const cleanedFontData = stripLayerData(fontData);

            // Debug: Check dotaccentcomb layers after filtering
            const isArray = Array.isArray(cleanedFontData.glyphs);
            const glyphs = isArray
                ? cleanedFontData.glyphs
                : Object.values(cleanedFontData.glyphs);
            const dotaccentcomb = glyphs.find(
                (g: any) => g && g.name === 'dotaccentcomb'
            );
            if (dotaccentcomb) {
                console.log(
                    `[Fontc Worker] 🔍 dotaccentcomb has ${dotaccentcomb.layers?.length || 0} layers after filtering:`
                );
                dotaccentcomb.layers?.forEach((layer: any, i: number) => {
                    const masterType = layer.master
                        ? Object.keys(layer.master)[0]
                        : 'none';
                    const shapeCount = layer.shapes?.length || 0;
                    console.log(
                        `  Layer ${i}: master=${masterType}, shapes=${shapeCount}, location=${JSON.stringify(layer.location || {})}`
                    );

                    // Debug: Show first shape structure AFTER wrapping
                    if (layer.shapes && layer.shapes.length > 0) {
                        const firstShape = layer.shapes[0];
                        console.log(
                            `    First shape AFTER wrapping - keys: ${Object.keys(firstShape).join(', ')}`
                        );
                        console.log(
                            `    First shape AFTER wrapping: ${JSON.stringify(firstShape).substring(0, 300)}`
                        );
                    }
                });
            }

            // Also check a component-based glyph
            const abreve = glyphs.find((g: any) => g && g.name === 'Abreve');
            if (
                abreve &&
                abreve.layers &&
                abreve.layers[0] &&
                abreve.layers[0].shapes
            ) {
                console.log(
                    `[Fontc Worker] 🔍 Abreve first layer shapes AFTER wrapping:`
                );
                abreve.layers[0].shapes.forEach((shape: any, i: number) => {
                    console.log(
                        `  Shape ${i}: ${JSON.stringify(shape).substring(0, 200)}`
                    );
                });
            }

            // Validate font data before compilation
            validateFontData(cleanedFontData);

            const cleanedJson = JSON.stringify(cleanedFontData);

            // Debug: Show dotaccentcomb JSON structure
            const dotaccentcombMatch = cleanedJson.match(
                /"name":"dotaccentcomb"[^}]*"layers":\[([^\]]+\][^\]]*\][^\]]*\])/
            );
            if (dotaccentcombMatch) {
                console.log(
                    '[Fontc Worker] dotaccentcomb JSON layers:',
                    dotaccentcombMatch[1].slice(0, 500)
                );
            }

            console.log('[Fontc Worker] ✅ Stripped layerData from components');

            // STEP 3: Compile to TTF
            const result = compile_babelfont(cleanedJson, {
                drop_incompatible_paths: true // Tolerate incompatible masters
            });

            const time_taken = Date.now() - start;
            console.log(
                `[Fontc Worker] Compiled ${filename} in ${time_taken}ms`
            );

            self.postMessage({
                id,
                result: Array.from(result),
                time_taken,
                filename: filename.replace(/\.babelfont$/, '.ttf')
            });
        } catch (e: any) {
            console.error('[Fontc Worker] Compilation error:', e);
            const errorMessage = e.toString();

            self.postMessage({
                id,
                error: errorMessage,
                userMessage: `Font compilation failed: ${errorMessage}`
            });
        }
        return;
    }

    console.error('[Fontc Worker] Unknown message type:', data);
};
