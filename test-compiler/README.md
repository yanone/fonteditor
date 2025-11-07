# Font Compilation Test Scripts

This directory contains scripts for testing the font compilation pipeline offline from the command line.

## Quick Start

```bash
./compile-font.sh ../path/to/font.glyphs output.ttf
```

## Scripts

### `compile-font.sh` - Combined Pipeline

Runs the complete Font → JSON → TTF pipeline:

```bash
./compile-font.sh input.glyphs [output.ttf]
```

**Features:**
- Accepts any font format (.glyphs, .ufo, .designspace, .babelfont, .context)
- Automatically generates temp .babelfont JSON
- Compiles using WASM
- Cleans up temp files
- Shows timing for each step
- Default output: `{input}.ttf`

### `1-export-to-json.py` - Python Export

Exports a font to .babelfont JSON:

```bash
python 1-export-to-json.py input.glyphs output.babelfont
```

**What it does:**
- Loads font with `context.load()`
- Exports using `orjson.dumps(font.to_dict())`
- Handles datetime serialization correctly
- Shows export timing and file size

### `2-compile-to-ttf.js` - WASM Compilation

Compiles .babelfont JSON to TTF using WASM:

```bash
node 2-compile-to-ttf.js input.babelfont output.ttf
```

**What it does:**
- Validates JSON
- Loads WASM module from `../webapp/wasm-dist/`
- Compiles using `compile_babelfont()`
- Shows compilation timing and output size

## Prerequisites

1. **Build WASM module:**
   ```bash
   cd ..
   ./build-fontc-wasm.sh
   ```

2. **Install Context library:**
   ```bash
   cd ../../context-py
   pip install -e .
   ```

3. **Install orjson:**
   ```bash
   pip install orjson
   ```

## Examples

### Compile a Glyphs file
```bash
./compile-font.sh ~/Fonts/MyFont.glyphs MyFont.ttf
```

### Compile a UFO
```bash
./compile-font.sh ~/Fonts/MyFont.ufo MyFont.ttf
```

### Step-by-step debugging
```bash
# Export to JSON first
python 1-export-to-json.py ../examples/Test.glyphs test.babelfont

# Inspect the JSON if needed
cat test.babelfont | jq '.masters[0].name'

# Compile to TTF
node 2-compile-to-ttf.js test.babelfont test.ttf

# Check the output
otfinfo -i test.ttf
```

## Troubleshooting

**WASM module not found:**
```bash
cd ..
./build-fontc-wasm.sh
```

**Context library not found:**
```bash
cd ../../context-py
pip install -e .
```

**orjson not found:**
```bash
pip install orjson
```

## See Also

- [TESTING_COMPILATION.md](../TESTING_COMPILATION.md) - Full testing guide
- [COMPILE_BUTTON.md](../COMPILE_BUTTON.md) - Web UI compile button docs
- [FONT_COMPILATION_GUIDE.md](../FONT_COMPILATION_GUIDE.md) - Architecture overview
