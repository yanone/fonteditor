// Mock for babelfont_fontc_web WASM module in Jest tests
// This loads the real WASM module for open_font_file, mocks the rest

const fs = require('fs');
const path = require('path');

// The init function that's called to initialize WASM (default export)
const initBabelfontWasm = jest.fn(() => {
    // Load and initialize the real WASM module
    const wasmPath = path.join(
        __dirname,
        '../../wasm-dist/babelfont_fontc_web_bg.wasm'
    );
    const wasmBytes = fs.readFileSync(wasmPath);

    // Note: We can't actually init the WASM here in CommonJS Jest, but we'll
    // make open_font_file work by spawning the CLI process instead
    return Promise.resolve();
});

// Use real conversion via Node child_process for .glyphs files
const { execSync } = require('child_process');
const os = require('os');

// Named export functions that are available after init
initBabelfontWasm.get_glyph_name = jest.fn(
    (fontBytes, glyphId) => `glyph${String(glyphId).padStart(5, '0')}`
);
initBabelfontWasm.get_glyph_order = jest.fn((fontBytes) => [
    '.notdef',
    'A',
    'B',
    'C'
]);
initBabelfontWasm.get_font_features = jest.fn((fontBytes) =>
    JSON.stringify(['liga', 'kern', 'calt'])
);
initBabelfontWasm.get_stylistic_set_names = jest.fn((fontBytes) =>
    JSON.stringify({ ss01: 'Stylistic Set 1' })
);
initBabelfontWasm.get_font_axes = jest.fn((fontBytes) =>
    JSON.stringify([
        {
            tag: 'wght',
            name: 'Weight',
            min: 100,
            max: 900,
            default: 400
        }
    ])
);
initBabelfontWasm.compile_babelfont = jest.fn(
    (json, options) => new Uint8Array(100)
);
initBabelfontWasm.compile_cached_font = jest.fn(
    (options) => new Uint8Array(100)
);
initBabelfontWasm.store_font = jest.fn((json) => {});
initBabelfontWasm.clear_font_cache = jest.fn(() => {});
initBabelfontWasm.interpolate_glyph = jest.fn((glyphName, locationJson) =>
    JSON.stringify({})
);
initBabelfontWasm.version = jest.fn(() => '0.1.0');

// Real implementation using babelfont CLI to convert .glyphs files
initBabelfontWasm.open_font_file = jest.fn((filename, contents) => {
    // Write to temp file, convert with CLI, read result, delete temp files
    const tmpDir = os.tmpdir();
    const inputPath = path.join(tmpDir, filename);
    const outputPath = path.join(
        tmpDir,
        filename.replace(/\.glyphs$/, '.babelfont')
    );

    try {
        fs.writeFileSync(inputPath, contents, 'utf-8');
        execSync(`babelfont "${inputPath}" "${outputPath}"`, {
            encoding: 'utf-8'
        });
        const result = fs.readFileSync(outputPath, 'utf-8');
        return result;
    } finally {
        // Clean up temp files
        try {
            fs.unlinkSync(inputPath);
        } catch (e) {}
        try {
            fs.unlinkSync(outputPath);
        } catch (e) {}
    }
});

module.exports = initBabelfontWasm;
