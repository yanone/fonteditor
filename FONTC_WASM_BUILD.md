# Building fontc for WebAssembly

This document explains how to build fontc as a WebAssembly module for use in the browser.

## Overview

This application uses fontc (the Rust-based font compiler from Google Fonts) compiled to WebAssembly using [Simon Cozens' fontc-web approach](https://github.com/simoncozens/fontc-web). This proven method uses:

- **wasm-pack** with Rust nightly
- **wasm-bindgen-rayon** for multi-threading support
- **Web Workers** for non-blocking compilation
- **SharedArrayBuffer** for threading (requires special CORS headers) 

## Why is this difficult?

1. **File System Access**: fontc expects native file system access, but WASM runs in a sandbox
2. **Threading**: fontc uses Rayon for parallelism, which doesn't work the same in WASM
3. **System Dependencies**: Some dependencies may make system calls not available in WASM
4. **Binary Size**: The compiled WASM module would be quite large

## Prerequisites

- **Rust** (install from https://rustup.rs/)
- **Rust nightly toolchain** (required for WASM threading)
- **wasm-pack**: `cargo install wasm-pack`
- **Python 3** (for the CORS server)

## Build Instructions

### 1. Build fontc WASM

Run the build script:

```bash
./build-fontc-wasm.sh
```

The script will:
1. Install Rust nightly toolchain
2. Install wasm-pack if needed
3. Clone Simon Cozens' fontc-web repository
4. Build with threading support (`+atomics,+bulk-memory`)
5. Copy WASM files to `webapp/wasm-dist/`

This may take 5-10 minutes the first time.

### 2. Serve with CORS Headers

**Important:** SharedArrayBuffer (required for threading) needs special HTTP headers.

Use the provided server:

```bash
cd webapp
python3 serve-with-cors.py
```

Or if using another server, add these headers:
```
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

## Expected Outcome

The build may encounter compatibility issues with some dependencies. If the build fails:

1. Check the error messages for specific incompatible dependencies
2. Try updating Rust toolchain: `rustup update`
3. Check fontc repository for WASM-related issues
4. Consider contributing fixes upstream

## Troubleshooting

### Common Issues

**"error: linking with `rust-lld` failed"**
- Some dependencies may not support WASM target
- Check if newer versions are available

**"error: cannot find function in this scope"**
- System-specific functions may need WASM alternatives
- May require patching dependencies

**Large WASM file size**
- Use release profile optimizations (already configured)
- Consider using `wasm-opt` for further size reduction

## Integration with This App

The WASM files are automatically placed in the correct location:

1. Build script outputs to `webapp/wasm-dist/`
2. WASM files are loaded by `js/fontc-worker.js`
3. Web Worker runs in separate thread

Usage in JavaScript:
```javascript
// Via the FontCompilation wrapper
await fontCompilation.compile('/input.glyphs', '/output.ttf');

await init();
const compiler = new FontCompiler();
const result = compiler.compile('/input.designspace', '/output.ttf');
```

## Contributing

If you successfully build fontc for WASM, please:
1. Document your changes
2. Share build instructions
3. Consider contributing back to fontc project
