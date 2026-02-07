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

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { existsSync } from 'fs';
import harfbuzzjs from 'harfbuzzjs';
import init, {
    compile_babelfont,
    open_font_file,
    store_font,
    get_layout_closure,
    get_glyph_name
} from '../wasm-dist/babelfont_fontc_web.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Shape text with HarfBuzz to get base glyphs (without features).
 * This mimics the webapp's Stage 1 shaping for subsetting.
 */
function getBaseGlyphsFromText(text, fontBytes, hbInstance) {
    console.log('[CompileTest]', `Shaping text: "${text}"`);

    // Create HarfBuzz font from bytes
    const blob = hbInstance.createBlob(fontBytes);
    const face = hbInstance.createFace(blob, 0);
    const hbFont = hbInstance.createFont(face);

    // Create buffer and add text
    const buffer = hbInstance.createBuffer();
    buffer.addText(text);
    buffer.guessSegmentProperties();

    // Shape WITHOUT features to get base glyphs (like webapp Stage 1)
    hbInstance.shape(hbFont, buffer);
    const result = buffer.json();

    // Extract unique glyph IDs
    const uniqueGids = new Set();
    for (const glyph of result) {
        uniqueGids.add(glyph.g);
    }

    // Map GIDs to glyph names
    const glyphNames = [];
    for (const gid of uniqueGids) {
        try {
            const name = get_glyph_name(fontBytes, gid);
            if (name && name !== '.notdef') {
                glyphNames.push(name);
            }
        } catch (e) {
            console.warn(
                '[CompileTest]',
                `Failed to get name for GID ${gid}:`,
                e.message
            );
        }
    }

    // Cleanup
    buffer.destroy();
    hbFont.destroy();
    face.destroy();
    blob.destroy();

    console.log(
        '[CompileTest]',
        `Found ${glyphNames.length} unique base glyphs:`,
        glyphNames
    );
    return glyphNames;
}

async function testCompilation(fontPath, typedText) {
    console.log('[CompileTest]', 'Initializing WASM...');

    // Create output directory for compiled fonts
    const outputDir = join(__dirname, 'output');
    mkdirSync(outputDir, { recursive: true });

    // Load WASM module with explicit path
    const wasmPath = join(
        __dirname,
        '../wasm-dist/babelfont_fontc_web_bg.wasm'
    );
    const wasmBytes = readFileSync(wasmPath);
    await init(wasmBytes);

    // Initialize HarfBuzz
    console.log('[CompileTest]', 'Initializing HarfBuzz...');
    const hbInstance = await harfbuzzjs;

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
    const debugDataFile = join(outputDir, 'fontdata-debug.json');
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
        const featureFile = join(outputDir, 'features.fea');
        writeFileSync(featureFile, featureCode);
        console.log(`📝 Feature code saved to: ${featureFile}\n`);
    }

    // Compute subset glyphs from typed text using layout closure
    let glyphsToInclude = undefined;

    if (typedText) {
        console.log('[CompileTest]', '\n=== LAYOUT CLOSURE SUBSETTING ===\n');

        // First, compile a full font to use for shaping
        console.log(
            '[CompileTest]',
            'Compiling full typing font for shaping...'
        );
        const typingFontBytes = compile_babelfont(cleanedBabelfontJson, {
            skip_kerning: false,
            skip_features: false,
            skip_metrics: false,
            skip_outlines: false,
            dont_use_production_names: true
        });
        console.log(
            '[CompileTest]',
            `Typing font compiled (${typingFontBytes.length} bytes)`
        );

        // Shape text to get base glyphs (Stage 1)
        const baseGlyphs = getBaseGlyphsFromText(
            typedText,
            typingFontBytes,
            hbInstance
        );

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
                'layout-closure-debug.json'
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

    // Editing target options (from font-compilation.ts)
    const options = {
        skip_kerning: false,
        skip_features: false, // Include features with layout closure subsetting
        skip_metrics: false,
        skip_outlines: false,
        dont_use_production_names: true
    };

    // Add subset glyphs if computed from text
    if (glyphsToInclude && glyphsToInclude.length > 0) {
        options.subset_glyphs = glyphsToInclude;
        console.log(
            '[CompileTest]',
            `Subsetting to ${glyphsToInclude.length} glyphs (via layout closure)`
        );
    }

    console.log('[CompileTest]', `Testing ${targetName} target...\n`);

    const startTime = performance.now();
    try {
        console.log('[CompileTest]', 'Calling compile_babelfont...');
        const ttfBytes = compile_babelfont(cleanedBabelfontJson, options);
        const endTime = performance.now();
        const duration = (endTime - startTime).toFixed(2);

        results.push({
            target: targetName,
            success: true,
            duration: duration,
            size: ttfBytes.length
        });

        // Save compiled font to output directory
        const fontBaseName = basename(fontPath, '.glyphs').replace(
            '.babelfont',
            ''
        );
        const outputPath = join(outputDir, `${fontBaseName}.ttf`);
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
