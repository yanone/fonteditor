#!/usr/bin/env node
// Compile test for .glyphs files
// Usage: node compile-test.mjs <path-to-font.glyphs>

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { existsSync } from 'fs';
import init, {
    compile_babelfont,
    open_font_file
} from '../wasm-dist/babelfont_fontc_web.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function testCompilation(fontPath) {
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

    // Normalize externally tagged LayerType to internally tagged format
    // CLI outputs: {"DefaultForMaster": "id"}
    // WASM expects: {"type": "DefaultForMaster", "master": "id"}
    if (fontData.glyphs && Array.isArray(fontData.glyphs)) {
        fontData.glyphs.forEach((glyph) => {
            if (!glyph || !glyph.layers) return;

            // First, filter out AssociatedWithMaster layers without location data
            glyph.layers = glyph.layers.filter((layer) => {
                if (!layer || !layer.master) return true;
                const master = layer.master;

                // Check externally tagged format
                if ('AssociatedWithMaster' in master) {
                    return (
                        layer.location && Object.keys(layer.location).length > 0
                    );
                }
                // Check internally tagged format
                if (
                    'type' in master &&
                    master.type === 'AssociatedWithMaster'
                ) {
                    return (
                        layer.location && Object.keys(layer.location).length > 0
                    );
                }
                return true;
            });

            // Then normalize format
            glyph.layers.forEach((layer) => {
                if (!layer || !layer.master) return;
                const master = layer.master;

                // Convert externally tagged to internally tagged
                if ('DefaultForMaster' in master) {
                    layer.master = {
                        type: 'DefaultForMaster',
                        master: master.DefaultForMaster
                    };
                } else if ('AssociatedWithMaster' in master) {
                    layer.master = {
                        type: 'AssociatedWithMaster',
                        master: master.AssociatedWithMaster
                    };
                } else if (
                    'FreeFloating' in master ||
                    Object.keys(master).length === 0
                ) {
                    layer.master = { type: 'FreeFloating' };
                }
            });
        });
    }

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

    // Test just the 'editing' target for debugging
    const results = [];
    const targetName = 'editing';

    // Editing target options (from font-compilation.ts)
    const options = {
        skip_kerning: false,
        skip_features: false, // Try with features to see full error
        skip_metrics: false,
        skip_outlines: false,
        dont_use_production_names: true
    };

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
    console.error('Usage: node compile-test.mjs <path-to-font.glyphs>');
    console.error('\nExample:');
    console.error(
        '  node compile-test.mjs ../examples/NestedComponents.glyphs'
    );
    console.error('  node compile-test.mjs /path/to/MyFont.glyphs');
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

testCompilation(fontPath).catch((err) => {
    console.error('[CompileTest]', 'Test failed:', err);
    process.exit(1);
});
