# FontEditor

A web-based font editor with Python scripting and fontc WASM compilation.

## Features

- 🐍 **Python Console**: Full Python environment with Pyodide
- 🦀 **fontc Compiler**: Google's Rust-based font compiler running in browser via WASM
- 📁 **File Browser**: View and manage files in the virtual filesystem
- 🎨 **Cyberpunk UI**: Resizable 4-view layout with neon styling
- ⚡ **Multi-threaded**: Uses Web Workers for non-blocking compilation

## Quick Start

```bash
# 1. Build fontc WASM (first time: 5-10 minutes)
./build-fontc-wasm.sh

# 2. Start server with CORS headers (required for threading)
python3 serve-with-cors.py

# 3. Open http://localhost:8000
```

See [QUICKSTART.md](QUICKSTART.md) for detailed instructions.

## Usage

### Compile a Font

In the Python console:

```python
# Compile from .glyphs file
import js
result = await js.fontCompilation.compile('/path/to/font.glyphs', '/output.ttf')

# Or parse command-line style
result = await js.compileFontFromPython('fontc /input.glyphs -o /output.ttf')
```

### Work with defcon

```python
import defcon

# Create a font
font = defcon.Font()
font.info.familyName = "MyFont"

# Add a glyph
glyph = font.newGlyph('A')
glyph.width = 600

# Save (to virtual filesystem)
font.save('/myfont.ufo')
```

## Architecture

- **Frontend**: HTML/CSS/JS with cyberpunk styling
- **Python Runtime**: Pyodide 0.28.3
- **Font Libraries**: defcon, fontc (WASM)
- **Console**: jQuery Terminal 2.35.2
- **Compiler**: fontc via wasm-bindgen + rayon

## Documentation

- [Quick Start Guide](QUICKSTART.md) - Get started in 3 steps
- [fontc WASM Build](FONTC_WASM_BUILD.md) - Technical build details
- [Font Compilation Guide](FONT_COMPILATION_GUIDE.md) - API reference

## Requirements

- **Build**: Rust + wasm-pack
- **Runtime**: Modern browser with SharedArrayBuffer support
- **Server**: Python 3 (for CORS headers)

## Credits

- **fontc WASM approach**: Based on [Simon Cozens' fontc-web](https://github.com/simoncozens/fontc-web)
- **fontc**: [Google Fonts' fontc compiler](https://github.com/googlefonts/fontc)
- **Pyodide**: [Python for WebAssembly](https://pyodide.org/)

## License

See LICENSE file.
