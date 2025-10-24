# FontEditor Quick Start

Get up and running with fontc WASM compilation in the browser.

## Quick Start

### 1. Build fontc WASM

```bash
./build-fontc-wasm.sh
```

This clones and builds Simon Cozens' fontc-web (first time takes 5-10 minutes).

### 2. Start the server with CORS headers

```bash
cd webapp
python3 serve-with-cors.py
```

### 3. Open in browser

Navigate to: http://localhost:8000

### 4. Test compilation

In the Python console:

```python
# Create a test .glyphs file
test_glyphs = '''{
.appVersion = "1360";
.formatVersion = 3;
familyName = "TestFont";
fontMaster = (
{
id = "master01";
name = "Regular";
}
);
glyphs = (
{
glyphname = "A";
layers = (
{
layerId = "master01";
width = 600;
}
);
unicode = 0041;
}
);
}'''

# Save to filesystem
with open('/test.glyphs', 'w') as f:
    f.write(test_glyphs)

# Compile with fontc
import js
result = await js.fontCompilation.compile('/test.glyphs', '/test.ttf')
print(result)

# Check the file browser - you should see test.ttf!
```

## How It Works

1. **Web Worker**: fontc WASM runs in a separate thread (non-blocking)
2. **Multi-threading**: Uses wasm-bindgen-rayon for parallel compilation
3. **Virtual FS**: Reads/writes files from Pyodide's in-memory filesystem
4. **Python Integration**: Accessible from both JavaScript and Python console

## Troubleshooting

### "Worker initialization timeout"

- Make sure WASM files were built: check `webapp/wasm-dist/` directory
- Make sure you're using the CORS server: `cd webapp && python3 serve-with-cors.py`
- Check browser console for specific errors

### "SharedArrayBuffer is not defined"

You're not serving with the correct CORS headers. Must use:
```bash
cd webapp
python3 serve-with-cors.py
```

### Build fails

Common fixes:
```bash
# Update Rust
rustup update

# Update wasm-pack
cargo install wasm-pack --force

# Make sure nightly is installed
rustup toolchain install nightly
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Main Thread                     │
│  ┌─────────────┐        ┌──────────────────┐   │
│  │   Python    │◄──────►│  font-compilation │   │
│  │   Console   │        │        .js        │   │
│  └─────────────┘        └──────────────────┘   │
│                                  │               │
│                                  │ postMessage   │
│                                  ▼               │
│                         ┌──────────────────┐    │
│                         │   Web Worker     │    │
│                         │ (fontc-worker.js)│    │
│                         └──────────────────┘    │
│                                  │               │
│                                  │               │
│                                  ▼               │
│                         ┌──────────────────┐    │
│                         │   fontc WASM     │    │
│                         │  (with rayon)    │    │
│                         └──────────────────┘    │
└─────────────────────────────────────────────────┘
```

## Credits

This implementation is based on [Simon Cozens' fontc-web](https://github.com/simoncozens/fontc-web) which demonstrated that fontc can successfully run in the browser with proper WASM threading support.
