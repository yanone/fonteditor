#!/usr/bin/env node
/**
 * Step 2: Compile .babelfont JSON to TTF using WASM
 * 
 * Usage:
 *   node 2-compile-to-ttf.js input.babelfont output.ttf
 */

const fs = require('fs');
const path = require('path');

async function compileToTTF(inputFile, outputFile) {
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

    console.log('🦀 Loading WASM module...');

    try {
        // Import the WASM module from parent directory
        const wasmPath = path.join(__dirname, '..', 'webapp', 'wasm-dist', 'babelfont_fontc_web.js');
        const wasmBinaryPath = path.join(__dirname, '..', 'webapp', 'wasm-dist', 'babelfont_fontc_web_bg.wasm');

        const wasmModule = await import(wasmPath);

        // Read the WASM binary and initialize synchronously
        const wasmBinary = fs.readFileSync(wasmBinaryPath);
        wasmModule.initSync({ module: wasmBinary });

        console.log('✅ WASM module loaded');
        console.log(`📦 Version: ${wasmModule.version()}`);

        // Compile
        console.log('🔨 Compiling font...');
        const startTime = Date.now();

        let result;
        try {
            result = wasmModule.compile_babelfont(babelfontJson);
        } catch (compileError) {
            console.error('Compilation threw error:', compileError);
            throw compileError;
        }

        if (!result) {
            throw new Error('Compilation returned no result');
        }

        const duration = Date.now() - startTime;
        console.log(`✅ Compiled in ${duration}ms`);
        console.log(`📊 Output size: ${(result.length / 1024).toFixed(2)} KB`);

        // Write output
        console.log(`💾 Writing ${outputFile}...`);
        fs.writeFileSync(outputFile, result);
        console.log('✅ Done!');

    } catch (error) {
        console.error('❌ Compilation failed:', error.message);
        if (error.stack) {
            console.error('\nStack trace:');
            console.error(error.stack);
        }
        console.error('');
        console.error('Make sure you have:');
        console.error('  1. Built the WASM module: ./build-fontc-wasm.sh');
        console.error('  2. The WASM files in: webapp/wasm-dist/');
        process.exit(1);
    }
}

if (process.argv.length < 4) {
    console.error('Usage: node 2-compile-to-ttf.js input.babelfont output.ttf');
    process.exit(1);
}

const inputFile = process.argv[2];
const outputFile = process.argv[3];

compileToTTF(inputFile, outputFile).catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
