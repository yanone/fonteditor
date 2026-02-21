#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import init, { open_font_file } from '../../wasm-dist/babelfont_fontc_web.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const inputPath = process.argv[2];
const outputPath = process.argv[3];
if (!inputPath || !outputPath) {
    process.stderr.write(
        'Usage: node convert-glyphs-to-babelfont.mjs <input-font-file> <output-babelfont-file>\n'
    );
    process.exit(1);
}

const fileName = basename(inputPath);
const fileContents = readFileSync(inputPath, 'utf-8');

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

    if (fileName.endsWith('.babelfont')) {
        writeFileSync(outputPath, fileContents, 'utf-8');
        process.exit(0);
    }

    const babelfontJson = open_font_file(fileName, fileContents);
    writeFileSync(outputPath, babelfontJson, 'utf-8');
} finally {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
}
