# Font Compilation in FontEditor

This guide explains how to compile fonts using fontc (the Rust-based Google Fonts compiler) in the FontEditor web app.

## Overview

FontEditor uses fontc compiled to WebAssembly for font compilation directly in the browser.

## Prerequisites

### Build fontc WASM

First, build fontc for WebAssembly:

```bash
# Run the build script
./build-fontc-wasm.sh
```

This will:
1. Clone the fontc repository
2. Set up the Rust WASM toolchain
3. Build fontc to WebAssembly
4. Generate JavaScript bindings

The built WASM files will be placed in `wasm-dist/`.

## Usage

```javascript
// In JavaScript console
const result = await fontCompilation.compile('/MyFont.designspace', '/output.ttf');
console.log(result);
```

```python
# In Python console (same API)
import js
result = await js.fontCompilation.compile('/MyFont.designspace', '/output.ttf')
print(result)
```

## Working with Files

### Creating Test Files

```python
# Create a simple test .glyphs file
test_glyphs = '''
{
.appVersion = "1234";
familyName = "TestFont";
fontMaster = (
{
id = "master01";
}
);
glyphs = ();
}
'''

with open('/test.glyphs', 'w') as f:
    f.write(test_glyphs)

# Verify it exists
import os
print(os.path.exists('/test.glyphs'))
```

### Viewing Generated Files

After compilation, refresh the file browser to see the output files:

```python
# Refresh file browser from Python
import js
js.refreshFileSystem()
```

## Troubleshooting

### "fontc WASM not available"

This means the WASM build hasn't been completed yet. Run:

```bash
./build-fontc-wasm.sh
```

If the build fails, check `FONTC_WASM_BUILD.md` for troubleshooting steps.

### "File not found" errors

Make sure files exist in the virtual filesystem:

```python
import os
print(os.listdir('/'))  # List root directory
print(os.path.exists('/your-file.glyphs'))  # Check specific file
```

### Compilation fails

Check that:
1. Input file exists in the virtual filesystem
2. Input file is a supported format (.glyphs, .designspace, .ufo)
3. File has valid syntax

### WASM module not loading

Check browser console for errors. You may need to:
1. Rebuild the WASM module
2. Clear browser cache
3. Check that files exist in `wasm-dist/`

## API Reference

### JavaScript API

```javascript
// Compile font
const result = await fontCompilation.compile(inputPath, outputPath);

// result structure:
// {
//   success: boolean,
//   output: string,
//   outputPath: string,
//   error?: string
// }
```

### Python API

```python
# Access JavaScript functions from Python
import js

# Compile with wrapper
result = await js.fontCompilation.compile('/input.designspace', '/output.ttf')
print(result)

# Or parse command-line style
result = await js.compileFontFromPython('fontc /input.designspace -o /output.ttf')
```

## Resources

- [fontc repository](https://github.com/googlefonts/fontc)
- [WebAssembly documentation](https://webassembly.org/)
- [wasm-bindgen guide](https://rustwasm.github.io/docs/wasm-bindgen/)

## Contributing

If you improve fontc WASM integration or fix build issues, please contribute back to both this project and the fontc repository!
