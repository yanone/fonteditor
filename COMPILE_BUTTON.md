# Compile Button

The **Compile** button in the main toolbar compiles the currently open font to TTF format using the babelfont-fontc WASM module.

## Features

- **Direct compilation**: Takes the Python Font object's `to_dict()` output and compiles it through the Rust/WASM pipeline
- **Zero file system**: Compilation happens entirely in memory (Python → JSON → WASM → TTF)
- **Automatic download**: The compiled TTF file is automatically downloaded to your computer
- **Virtual filesystem**: The TTF is also saved to Pyodide's virtual filesystem for inspection
- **Real-time feedback**: Shows compilation progress and timing in the terminal

## Usage

1. **Open a font** using the File Browser or font dropdown
2. **Click "Compile"** in the toolbar (or press `Cmd+B` / `Ctrl+B`)
3. **Wait for compilation** - you'll see progress messages in the terminal
4. **Download starts automatically** - the TTF file will be saved to your Downloads folder
5. **File browser updates** - the compiled font appears in the virtual filesystem

## Technical Details

### Compilation Pipeline

```
Python Font Object
    ↓ font.to_dict()
.babelfont JSON (in memory)
    ↓ babelfont-fontc WASM
TTF bytes (Uint8Array)
    ↓ download + save to virtual FS
Compiled font.ttf
```

### Performance

- **Export to JSON**: ~10-50ms (depends on font complexity)
- **WASM Compilation**: ~100-500ms (depends on font size and glyphs)
- **Total time**: Typically under 1 second for most fonts

### Requirements

1. **WASM module built**: Run `./build-fontc-wasm.sh` to build the compilation module
2. **Proper CORS headers**: Serve with `python3 serve-with-cors.py` for SharedArrayBuffer support
3. **Modern browser**: Chrome, Firefox, or Safari with WASM threading support

## Implementation

### Files

- **`js/compile-button.js`**: Main button logic and event handlers
- **`js/font-compilation.js`**: WASM module integration and compilation orchestration
- **`js/fontc-worker.js`**: Web Worker that runs the WASM module
- **`wasm-dist/babelfont_fontc_web_bg.wasm`**: The compiled Rust/fontc module

### Integration

The compile button integrates with:
- **Font Dropdown**: Updates button state when fonts are loaded/closed
- **Python Environment**: Uses `CurrentFont()` to get the active font
- **File Browser**: Refreshes to show the compiled TTF in the virtual filesystem
- **Terminal**: Shows compilation progress and results

### Keyboard Shortcut

- **macOS**: `Cmd+B`
- **Windows/Linux**: `Ctrl+B`

## Troubleshooting

### Button is Disabled

- **No font open**: Load a font first
- **Python not ready**: Wait for Pyodide to initialize
- **WASM not initialized**: Check browser console for initialization errors

### Compilation Fails

- **Check WASM module**: Ensure `./build-fontc-wasm.sh` completed successfully
- **Check CORS headers**: Run `python3 serve-with-cors.py` instead of a simple HTTP server
- **Check browser**: Open in Chrome/Firefox, not VS Code Simple Browser
- **Check terminal**: Error messages appear in the Python terminal view

### SharedArrayBuffer Not Available

This usually means the service worker isn't active:
1. Hard refresh the page (`Cmd+Shift+R` or `Ctrl+Shift+R`)
2. Check that `coi-serviceworker.js` is loaded
3. Make sure you're using `serve-with-cors.py`

## Future Enhancements

Potential improvements:
- [ ] Progress bar during compilation
- [ ] Option to compile without downloading
- [ ] Support for variable fonts
- [ ] Compilation settings/options
- [ ] Batch compilation of multiple fonts
- [ ] Font validation before compilation
