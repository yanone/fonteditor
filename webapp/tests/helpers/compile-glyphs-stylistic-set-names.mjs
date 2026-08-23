#!/usr/bin/env node

import { readFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import init, {
    compile_babelfont,
    get_stylistic_set_names,
    open_font_file
} from '../../wasm-dist/babelfont_fontc_web.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const inputPath = process.argv[2];
if (!inputPath) {
    process.stderr.write(
        'Usage: node compile-glyphs-stylistic-set-names.mjs <input-font-file>\n'
    );
    process.exit(1);
}

const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
console.log = () => {};
console.warn = () => {};

try {
    const wasmPath = join(
        __dirname,
        '../../wasm-dist/babelfont_fontc_web_bg.wasm'
    );
    await init(readFileSync(wasmPath));

    const fileName = basename(inputPath);
    const fileContents = readFileSync(inputPath);
    const babelfontJson = open_font_file(
        fileName,
        fileName.endsWith('.glyphs')
            ? fileContents.toString('utf-8')
            : fileContents
    );
    const ttfBytes = compile_babelfont(babelfontJson, {
        skip_kerning: true,
        skip_features: false,
        skip_metrics: false,
        skip_outlines: false,
        dont_use_production_names: true,
        drop_incompatible_paths: true,
        produce_varc_table: false
    });
    process.stdout.write(get_stylistic_set_names(ttfBytes));
} finally {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
}
