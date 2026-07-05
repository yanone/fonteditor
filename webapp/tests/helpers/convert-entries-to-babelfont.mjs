#!/usr/bin/env node

// Helper script for Jest tests to load UFO/designspace files via WASM.
// Usage:
//   node convert-entries-to-babelfont.mjs <input-entries-json> <output-babelfont-json> <filename>
//
// Where <input-entries-json> is a JSON file containing { "relative/path": "contents", ... }

import { readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import init, { open_font_file } from '../../wasm-dist/babelfont_fontc_web.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const inputPath = process.argv[2];
const outputPath = process.argv[3];
const filename = process.argv[4] || 'font.ufo';

if (!inputPath || !outputPath) {
    process.stderr.write(
        'Usage: node convert-entries-to-babelfont.mjs <input-entries-json> <output-babelfont-json> [filename]\n'
    );
    process.exit(1);
}

const entryJson = readFileSync(inputPath, 'utf-8');

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

    const babelfontJson = open_font_file(filename, entryJson);

    writeFileSync(outputPath, babelfontJson, 'utf-8');
} catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
} finally {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
}
