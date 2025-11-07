# Testing Font Compilation Offline

You can test the font compilation pipeline offline from the command line using the provided test scripts in the `test-compiler/` directory.

## Quick Start

The easiest way to test is using the combined shell script:

```bash
cd context-font-editor/test-compiler
./compile-font.sh ../path/to/font.glyphs output.ttf
```

This runs the full pipeline: Font → .babelfont JSON → TTF

## Prerequisites

1. **Build the WASM module** (if not already done):
   ```bash
   cd context-font-editor
   ./build-fontc-wasm.sh
   ```

2. **Install the Context library**:
   ```bash
   cd context-py
   pip install -e .
   ```

3. **Install orjson** (for datetime serialization):
   ```bash
   pip install orjson
   ```

## Test Scripts

### Combined Script (`compile-font.sh`)

Runs the complete compilation pipeline in one command:

```bash
cd test-compiler
./compile-font.sh input.glyphs [output.ttf]
```

Arguments:
- `input.glyphs` - Input font file (supports .glyphs, .ufo, .designspace, .babelfont, .context)
- `output.ttf` - Optional output path (defaults to `{input}.ttf`)

This script automatically:
1. Exports the font to temporary .babelfont JSON
2. Compiles the JSON to TTF using WASM
3. Cleans up temporary files
4. Shows timing for both steps

### Individual Scripts

You can also run the steps separately for debugging:

#### Step 1: Export to JSON (`1-export-to-json.py`)

```bash
cd test-compiler
python 1-export-to-json.py input.glyphs output.babelfont
```

This will:
- Load the font using `context.load()`
- Export to .babelfont JSON using `orjson.dumps(font.to_dict())`
- Save the JSON file
- Print timing information

**Supported formats**: `.glyphs`, `.ufo`, `.designspace`, `.babelfont`, `.context`

#### Step 2: Compile to TTF (`2-compile-to-ttf.js`)

```bash
cd test-compiler
node 2-compile-to-ttf.js input.babelfont output.ttf
```

This will:
- Read the .babelfont JSON file
- Load the WASM module from `../webapp/wasm-dist/`
- Compile using `compile_babelfont()`
- Save the TTF file
- Print timing information

## Example Workflows

### Full Pipeline (Recommended)

```bash
cd test-compiler
./compile-font.sh ../path/to/MyFont.glyphs MyFont.ttf
```

### Step by Step

1. Export a font to JSON:
```bash
cd test-compiler
python 1-export-to-json.py ../path/to/MyFont.glyphs MyFont.babelfont
```

2. Compile the JSON to TTF:
```bash
node 2-compile-to-ttf.js MyFont.babelfont MyFont.ttf
```

### Testing Different Formats

```bash
# .glyphs file
./compile-font.sh ../examples/MyFont.glyphs

# .ufo directory
./compile-font.sh ../examples/MyFont.ufo

# .designspace file
./compile-font.sh ../examples/MyFont.designspace
```

The compiled TTF will be saved to the specified output path or `{input}.ttf` by default.
```

## Method 4: Direct Rust Test (No WASM)

If you want to test the Rust compilation directly (without WASM overhead):

```bash
cd context-font-editor/babelfont-fontc-build

# Build the native version
cargo build --release

# Run tests
cargo test
```

## Troubleshooting

### "WASM module not found"
Make sure you've built the WASM module:
```bash
./build-fontc-wasm.sh
```

### "Context library not found"
Install the Context library:
```bash
cd context-py
pip install -e .
```

### "Node.js ES modules error"
The Node.js test requires ES modules support. Make sure you're using Node.js 14+ and the WASM module was built correctly.

### "orjson not found"
Install orjson:
```bash
pip install orjson
```

## Performance Benchmarking

To benchmark the compilation performance:

```bash
# Python export timing
time python test-compile-python.py font.glyphs font.babelfont

# WASM compilation timing
time node test-compile.js font.babelfont font.ttf
```

## Files Created

- `test-compile-python.py` - Python script for testing font export
- `test-compile.js` - Node.js script for testing WASM compilation
- `*.babelfont` - Intermediate JSON files (can be inspected/debugged)
- `*.ttf` - Final compiled font files

## Continuous Integration

You can use these scripts in CI/CD pipelines to test font compilation:

```yaml
# Example GitHub Actions workflow
- name: Test font export
  run: python test-compile-python.py tests/fixtures/test.glyphs test.babelfont

- name: Build WASM
  run: ./build-fontc-wasm.sh

- name: Test WASM compilation
  run: node test-compile.js test.babelfont test.ttf
```
