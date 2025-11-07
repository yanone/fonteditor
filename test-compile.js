#!/usr/bin/env node
/**
 * Test font compilation offline using the babelfont-fontc WASM module
 * 
 * Usage:
 *   node test-compile.js input.babelfont [output.ttf]
 * 
 * The input file should be a .babelfont JSON file.
 */

const fs = require('fs');
const path = require('path');

async function testCompilation() {
    // Parse arguments
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.error('Usage: node test-compile.js input.babelfont [output.ttf]');
        process.exit(1);
    }

    const inputFile = args[0];
    const outputFile = args[1] || inputFile.replace(/\.babelfont$/, '.ttf');

    console.log('🔧 Testing babelfont-fontc WASM compilation');
    console.log(`📖 Input:  ${inputFile}`);
    console.log(`📝 Output: ${outputFile}`);
    console.log('');

    // Read the .babelfont JSON file
    console.log('📖 Reading .babelfont JSON...');
    let babelfontJson;
    try {
        babelfontJson = fs.readFileSync(inputFile, 'utf-8');
        const size = (babelfontJson.length / 1024).toFixed(2);
        console.log(`✅ Loaded ${size} KB of JSON`);
    } catch (error) {
        console.error(`❌ Failed to read ${inputFile}:`, error.message);
        process.exit(1);
    }

    // Validate JSON
    try {
        JSON.parse(babelfontJson);
        console.log('✅ JSON is valid');
    } catch (error) {
        console.error('❌ Invalid JSON:', error.message);
        process.exit(1);
    }

    console.log('');
    console.log('🦀 Loading WASM module...');

    try {
        // Import the WASM module (requires ES modules or dynamic import)
        const wasmModule = await import('./webapp/wasm-dist/babelfont_fontc_web.js');

        console.log('✅ WASM module loaded');
        console.log(`📦 Version: ${wasmModule.version()}`);
        console.log('');

        // Compile
        console.log('🔨 Compiling font...');
        const startTime = Date.now();

        const result = wasmModule.compile_babelfont(babelfontJson);

        const duration = Date.now() - startTime;
        console.log(`✅ Compiled in ${duration}ms`);
        console.log(`📊 Output size: ${(result.length / 1024).toFixed(2)} KB`);

        // Write output
        console.log('');
        console.log(`💾 Writing ${outputFile}...`);
        fs.writeFileSync(outputFile, result);
        console.log('✅ Done!');
        console.log('');
        console.log(`🎉 Success! Font compiled to: ${outputFile}`);

    } catch (error) {
        console.error('');
        console.error('❌ Compilation failed:', error.message);
        console.error('');
        console.error('Make sure you have:');
        console.error('  1. Built the WASM module: ./build-fontc-wasm.sh');
        console.error('  2. The WASM files in: webapp/wasm-dist/');
        console.error('');
        process.exit(1);
    }
}

testCompilation().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
