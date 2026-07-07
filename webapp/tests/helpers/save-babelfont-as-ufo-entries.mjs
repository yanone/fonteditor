#!/usr/bin/env node

// Helper script for Jest tests to save a babelfont JSON as UFO entries via WASM.
// Usage:
//   node save-babelfont-as-ufo-entries.mjs <input-babelfont-json> <output-entries-json>

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import init, {
    save_font_as_ufo_entries
} from '../../wasm-dist/babelfont_fontc_web.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath || !outputPath) {
    process.stderr.write(
        'Usage: node save-babelfont-as-ufo-entries.mjs <input-babelfont-json> <output-entries-json>\n'
    );
    process.exit(1);
}

const babelfontJson = readFileSync(inputPath, 'utf-8');

const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
console.log = () => {};
console.warn = () => {};

try {
    const wasmPath = join(
        __dirname,
        '../../wasm-dist/babelfont_fontc_web_bg.wasm'
    );
    const wasmBytes = readFileSync(wasmPath);
    await init(wasmBytes);

    const entriesJson = save_font_as_ufo_entries(babelfontJson);

    writeFileSync(outputPath, entriesJson, 'utf-8');
} catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
} finally {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
}
