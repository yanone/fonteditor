#!/usr/bin/env node
// Compile test for .glyphs files
// Usage: node compile-test.mjs <path-to-font.glyphs> [--text <typed-text>]
//
// Options:
//   --text, -t <text>  Text to shape and use for layout closure subsetting
//
// Examples:
//   node compile-test.mjs ../examples/NestedComponents.glyphs
//   node compile-test.mjs ../examples/NestedComponents.glyphs --text "Hello World"
//   node compile-test.mjs /path/to/MyFont.glyphs -t "ABC"

import {
    readFileSync,
    writeFileSync,
    mkdirSync,
    readdirSync,
    unlinkSync
} from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { existsSync } from 'fs';
import init, {
    compile_babelfont,
    open_font_file,
    store_font,
    get_layout_closure
} from '../wasm-dist/babelfont_fontc_web.js';

// Compilation target options (match webapp/js/font-compilation.ts)

/**
 * Editing font compilation options
 * - skip_kerning: false (include kerning)
 * - skip_features: false (include GSUB via layout closure subsetting)
 * - produce_varc_table: true (for interpolation manager)
 * - drop_incompatible_paths: false (keep all paths)
 */
const EDITING_FONT_OPTIONS = {
    skip_kerning: false,
    skip_features: false,
    skip_metrics: false,
    skip_outlines: false,
    dont_use_production_names: true,
    drop_incompatible_paths: true,
    produce_varc_table: true
};

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Get base glyph names from input text by looking up Unicode codepoints in the font data.
 * This bypasses HarfBuzz shaping to avoid script-specific glyph selection (e.g., Arabic positional forms).
 * Returns the "encoded" base glyphs that will be used as the starting set for layout closure.
 *
 * @param {string} text - The input text to get glyphs for
 * @param {object} fontData - The parsed babelfont font data object
 * @returns {string[]} Array of glyph names for the input text
 */
function getBaseGlyphsFromUnicode(text, fontData) {
    console.log('[CompileTest]', `Getting base glyphs for text: "${text}"`);

    const glyphs = fontData.glyphs || [];
    const baseGlyphs = [];
    const seenGlyphs = new Set();

    // Iterate through each character in the text
    for (const char of text) {
        const codepoint = char.codePointAt(0);

        // Find glyph with this codepoint
        const glyph = glyphs.find(
            (g) => g.codepoints && g.codepoints.includes(codepoint)
        );

        if (glyph && glyph.name && !seenGlyphs.has(glyph.name)) {
            baseGlyphs.push(glyph.name);
            seenGlyphs.add(glyph.name);
        } else if (!glyph) {
            console.warn(
                '[CompileTest]',
                `No glyph found for codepoint U+${codepoint.toString(16).toUpperCase().padStart(4, '0')} ("${char}")`
            );
        }
    }

    console.log(
        '[CompileTest]',
        `Found ${baseGlyphs.length} unique base glyphs from Unicode:`,
        baseGlyphs
    );
    return baseGlyphs;
}

async function testCompilation(fontPath, typedText) {
    console.log('[CompileTest]', 'Initializing WASM...');

    // Create output directory for compiled fonts
    const outputDir = join(__dirname, 'output');
    mkdirSync(outputDir, { recursive: true });

    // Clean output directory - delete all existing files
    console.log('[CompileTest]', 'Cleaning output directory...');
    for (const file of readdirSync(outputDir)) {
        const filePath = join(outputDir, file);
        unlinkSync(filePath);
    }

    // Load WASM module with explicit path
    const wasmPath = join(
        __dirname,
        '../wasm-dist/babelfont_fontc_web_bg.wasm'
    );
    const wasmBytes = readFileSync(wasmPath);
    await init(wasmBytes);

    const fileName = basename(fontPath);
    const glyphsContents = readFileSync(fontPath, 'utf-8');

    console.log(
        '[CompileTest]',
        `Loaded ${fileName} (${glyphsContents.length} bytes)`
    );

    let babelfontJson;
    if (fileName.endsWith('.babelfont')) {
        console.log(
            '[CompileTest]',
            'Skipping conversion - already babelfont JSON\n'
        );
        babelfontJson = glyphsContents;
    } else {
        console.log('[CompileTest]', 'Converting .glyphs to babelfont JSON...');
        babelfontJson = open_font_file(fileName, glyphsContents);
        console.log(
            '[CompileTest]',
            `Converted to babelfont JSON (${babelfontJson.length} bytes)\n`
        );
    }

    // Parse and normalize LayerType format + filter backup layers
    console.log(
        '[CompileTest]',
        'Normalizing data and filtering backup layers...\n'
    );
    const fontData = JSON.parse(babelfontJson);

    // // Normalize externally tagged LayerType to internally tagged format
    // // CLI outputs: {"DefaultForMaster": "id"}
    // // WASM expects: {"type": "DefaultForMaster", "master": "id"}
    // if (fontData.glyphs && Array.isArray(fontData.glyphs)) {
    //     fontData.glyphs.forEach((glyph) => {
    //         if (!glyph || !glyph.layers) return;

    //         // First, filter out AssociatedWithMaster layers without location data
    //         glyph.layers = glyph.layers.filter((layer) => {
    //             if (!layer || !layer.master) return true;
    //             const master = layer.master;

    //             // Check externally tagged format
    //             if ('AssociatedWithMaster' in master) {
    //                 return (
    //                     layer.location && Object.keys(layer.location).length > 0
    //                 );
    //             }
    //             // Check internally tagged format
    //             if (
    //                 'type' in master &&
    //                 master.type === 'AssociatedWithMaster'
    //             ) {
    //                 return (
    //                     layer.location && Object.keys(layer.location).length > 0
    //                 );
    //             }
    //             return true;
    //         });

    //         // Then normalize format
    //         glyph.layers.forEach((layer) => {
    //             if (!layer || !layer.master) return;
    //             const master = layer.master;

    //             // Convert externally tagged to internally tagged
    //             if ('DefaultForMaster' in master) {
    //                 layer.master = {
    //                     type: 'DefaultForMaster',
    //                     master: master.DefaultForMaster
    //                 };
    //             } else if ('AssociatedWithMaster' in master) {
    //                 layer.master = {
    //                     type: 'AssociatedWithMaster',
    //                     master: master.AssociatedWithMaster
    //                 };
    //             } else if (
    //                 'FreeFloating' in master ||
    //                 Object.keys(master).length === 0
    //             ) {
    //                 layer.master = { type: 'FreeFloating' };
    //             }
    //         });
    //     });
    // }

    const cleanedBabelfontJson = JSON.stringify(fontData);

    // Dump font data structure for debugging
    const debugDataFile = join(outputDir, '0-source-fontdata.json');
    writeFileSync(debugDataFile, JSON.stringify(fontData, null, 2));
    console.log(
        '[CompileTest]',
        `Font data saved to: ${debugDataFile} (${fontData.glyphs?.length} glyphs)\n`
    );

    // Dump feature code for debugging
    if (fontData.features) {
        let featureCode = '';

        // If features is a string, use it directly
        if (typeof fontData.features === 'string') {
            featureCode = fontData.features;
        } else {
            // Otherwise it's the new structured format - reconstruct FEA code
            const features = fontData.features;

            // Add prefixes
            if (features.prefixes) {
                for (const [name, obj] of Object.entries(features.prefixes)) {
                    featureCode += `# ${name}\n${obj.code}\n\n`;
                }
            }

            // Add classes
            if (features.classes) {
                for (const [name, obj] of Object.entries(features.classes)) {
                    featureCode += `@${name} = [${obj.code}];\n\n`;
                }
            }

            // Add features
            if (features.features) {
                for (const [tag, obj] of features.features) {
                    featureCode += `feature ${tag} {\n${obj.code}} ${tag};\n\n`;
                }
            }
        }

        console.log(
            '[CompileTest]',
            `Feature code (${featureCode.length} chars):\n`
        );
        const featureFile = join(outputDir, '0-source-features.fea');
        writeFileSync(featureFile, featureCode);
        console.log(`📝 Feature code saved to: ${featureFile}\n`);
    }

    // Compute subset glyphs from typed text using layout closure
    let glyphsToInclude = undefined;

    if (typedText) {
        console.log('[CompileTest]', '\n=== LAYOUT CLOSURE SUBSETTING ===\n');

        // Get base glyphs directly from Unicode codepoints (no shaping)
        // This avoids HarfBuzz's script-specific glyph selection (e.g., Arabic positional forms)
        const baseGlyphs = getBaseGlyphsFromUnicode(typedText, fontData);
        console.log('[CompileTest]', 'baseGlyphs: ' + baseGlyphs);

        if (baseGlyphs.length === 0) {
            console.warn(
                '[CompileTest]',
                'No glyphs found from text - using full font'
            );
        } else {
            // Store font for layout closure computation
            console.log(
                '[CompileTest]',
                'Storing font in WASM for layout closure...'
            );
            store_font(cleanedBabelfontJson);

            // Compute layout closure (Stage 2)
            console.log(
                '[CompileTest]',
                `Computing layout closure from ${baseGlyphs.length} base glyphs...`
            );
            const closureJson = get_layout_closure(JSON.stringify(baseGlyphs));
            const closureSet = JSON.parse(closureJson);

            const addedCount = closureSet.length - baseGlyphs.length;
            console.log(
                '[CompileTest]',
                `✨ Layout closure expanded to ${closureSet.length} glyphs (${addedCount} added via features)`
            );

            glyphsToInclude = closureSet;

            // Save closure details for debugging
            const closureDebugFile = join(
                outputDir,
                '2-editing-layout-closure-debug.json'
            );
            writeFileSync(
                closureDebugFile,
                JSON.stringify(
                    {
                        typedText,
                        baseGlyphs,
                        closureSet,
                        addedGlyphs: closureSet.filter(
                            (g) => !baseGlyphs.includes(g)
                        )
                    },
                    null,
                    2
                )
            );
            console.log(
                '[CompileTest]',
                `Layout closure details saved to: ${closureDebugFile}\n`
            );
        }
    }

    // Test just the 'editing' target for debugging
    const results = [];
    const targetName = 'editing';

    // Build editing font options (copy constant to avoid mutation)
    const editingOptions = { ...EDITING_FONT_OPTIONS };

    // Add subset glyphs if computed from text
    if (glyphsToInclude && glyphsToInclude.length > 0) {
        editingOptions.subset_glyphs = glyphsToInclude;
        console.log(
            '[CompileTest]',
            `Subsetting to ${glyphsToInclude.length} glyphs (via layout closure)`
        );
    }

    console.log('[CompileTest]', `Testing ${targetName} target...\n`);

    const startTime = performance.now();
    try {
        console.log('[CompileTest]', 'Calling compile_babelfont...');
        const ttfBytes = compile_babelfont(
            cleanedBabelfontJson,
            editingOptions
        );
        const endTime = performance.now();
        const duration = (endTime - startTime).toFixed(2);

        results.push({
            target: targetName,
            success: true,
            duration: duration,
            size: ttfBytes.length
        });

        // Save editing font as 2-editing.ttf
        const outputPath = join(outputDir, '2-editing.ttf');
        writeFileSync(outputPath, ttfBytes);

        console.log(
            `✓ ${targetName.padEnd(15)} ${duration.padStart(8)}ms  ${ttfBytes.length.toLocaleString().padStart(10)} bytes`
        );
        console.log(`\n📦 Output: ${outputPath}`);
    } catch (error) {
        const endTime = performance.now();
        const duration = (endTime - startTime).toFixed(2);

        results.push({
            target: targetName,
            success: false,
            duration: duration,
            error: error.message
        });

        console.log(
            `✗ ${targetName.padEnd(15)} ${duration.padStart(8)}ms  ERROR: ${error.message}`
        );
        console.error('[CompileTest]', 'Full error:', error);
        console.error('[CompileTest]', 'Stack trace:', error.stack);
        process.exit(1);
    }

    // Summary
    const successful = results.filter((r) => r.success).length;
    const total = results.length;
    console.log(
        '[CompileTest]',
        `${successful}/${total} targets compiled successfully`
    );

    if (successful < total) {
        process.exit(1);
    }
}

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length === 0) {
    console.error(
        'Usage: node compile-test.mjs <path-to-font.glyphs> [--text <typed-text>]'
    );
    console.error('\nOptions:');
    console.error(
        '  --text, -t <text>  Text to shape and use for layout closure subsetting'
    );
    console.error('\nExamples:');
    console.error(
        '  node compile-test.mjs ../examples/NestedComponents.glyphs'
    );
    console.error(
        '  node compile-test.mjs ../examples/NestedComponents.glyphs --text "Hello World"'
    );
    console.error('  node compile-test.mjs /path/to/MyFont.glyphs -t "ABC"');
    process.exit(1);
}

const fontPath = args[0];
if (!existsSync(fontPath)) {
    console.error(`Error: File not found: ${fontPath}`);
    process.exit(1);
}

if (!fontPath.endsWith('.glyphs') && !fontPath.endsWith('.babelfont')) {
    console.error(`Error: File must be .glyphs or .babelfont format`);
    process.exit(1);
}

// Parse --text or -t option
let typedText = null;
const textIndex = args.findIndex((arg) => arg === '--text' || arg === '-t');
if (textIndex !== -1 && textIndex + 1 < args.length) {
    typedText = args[textIndex + 1];
    if (!typedText || typedText.length === 0) {
        console.error('Error: --text requires a non-empty string');
        process.exit(1);
    }
}

testCompilation(fontPath, typedText).catch((err) => {
    console.error('[CompileTest]', 'Test failed:', err);
    process.exit(1);
});
