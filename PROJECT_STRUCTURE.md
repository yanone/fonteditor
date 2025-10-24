# Project Structure

```
fonteditor/
│
├── webapp/                          # Main web application
│   ├── index.html                   # Entry point
│   ├── css/
│   │   └── style.css               # Cyberpunk theme styling
│   ├── js/
│   │   ├── resizer.js              # View resizing logic
│   │   ├── pyodide-official-console.js  # Python console
│   │   ├── fonteditor.js           # Main initialization
│   │   ├── file-browser.js         # Virtual filesystem browser
│   │   ├── font-compilation.js     # fontc wrapper
│   │   └── fontc-worker.js         # Web Worker for WASM
│   ├── wasm-dist/                  # Compiled WASM files (generated)
│   │   ├── fontc_web.js
│   │   ├── fontc_web_bg.wasm
│   │   └── ...
│   └── serve-with-cors.py          # Development server
│
├── build-fontc-wasm.sh             # Build script for fontc WASM
├── fontc-web-build/                # Build directory (git ignored)
│   └── fontc-web/                  # Cloned fontc-web repo
│
├── .gitignore                      # Git ignore rules
├── README.md                       # Main documentation
├── QUICKSTART.md                   # Quick start guide
├── FONTC_WASM_BUILD.md            # Build documentation
├── FONT_COMPILATION_GUIDE.md       # API reference
└── LICENSE                         # License file
```

## Key Directories

### `webapp/`
Contains the complete web application that runs in the browser. This is the user-facing part of the project.

**Why separate?**
- Clean separation between app and build tools
- Easier deployment (just copy `webapp/` folder)
- Clear development vs. production distinction
- Can be served directly from any static host

### `fontc-web-build/`
Temporary build directory created by `build-fontc-wasm.sh`. Contains the cloned fontc-web repository and build artifacts.

**Note:** This directory is in `.gitignore` and should not be committed.

### `wasm-dist/`
Generated WASM files from the build process. Located inside `webapp/` for easy access by the web app.

## Development Workflow

1. **First Time Setup:**
   ```bash
   ./build-fontc-wasm.sh
   ```

2. **Start Development Server:**
   ```bash
   cd webapp
   python3 serve-with-cors.py
   ```

3. **Make Changes:**
   - Edit files in `webapp/` directory
   - Refresh browser to see changes
   - No rebuild needed unless you modify WASM code

4. **Rebuild WASM (if needed):**
   ```bash
   ./build-fontc-wasm.sh  # From project root
   ```

## Deployment

To deploy the app:

1. Build WASM module:
   ```bash
   ./build-fontc-wasm.sh
   ```

2. Copy `webapp/` directory to your web server

3. Ensure server sends proper CORS headers:
   ```
   Cross-Origin-Embedder-Policy: require-corp
   Cross-Origin-Opener-Policy: same-origin
   ```

## File Organization Rationale

- **All web files in `webapp/`**: Keeps the application self-contained
- **Build scripts at root**: Build tools are separate from the app
- **Documentation at root**: Easy to find for contributors
- **Git ignores build artifacts**: Clean repository
