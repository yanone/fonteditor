// Font Compilation Integration
// Direct .babelfont JSON → TTF compilation (zero file system)
// Based on: DIRECT_PYTHON_RUST_INTEGRATION.md

class FontCompilation {
    constructor() {
        this.worker = null;
        this.isInitialized = false;
        this.pendingCompilations = new Map();
        this.compilationId = 0;
    }

    async initialize() {
        if (this.isInitialized) return true;

        console.log('🔧 Initializing babelfont-fontc WASM worker...');
        console.log('🚀 Using direct .babelfont JSON → TTF pipeline (no file system)');

        // Wait for service worker to be active (needed for SharedArrayBuffer on GitHub Pages)
        if ('serviceWorker' in navigator) {
            const registration = await navigator.serviceWorker.ready;
            if (registration.active && !navigator.serviceWorker.controller) {
                console.log('⏳ Service worker registered but not controlling page yet. Waiting...');
                // Wait a bit for controller to be set
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        // Check if SharedArrayBuffer is available
        if (typeof SharedArrayBuffer === 'undefined') {
            console.error(
                '❌ SharedArrayBuffer is not available. fontc WASM requires it.\n' +
                'This should be enabled by the coi-serviceworker.js.\n' +
                'If you see this error:\n' +
                '  1. Try a hard refresh (Ctrl+Shift+R or Cmd+Shift+R)\n' +
                '  2. Check browser console for service worker errors\n' +
                '  3. Make sure coi-serviceworker.js is loaded in the HTML\n\n' +
                'For local development, use: cd webapp && python3 serve-with-cors.py'
            );
            if (window.term) {
                window.term.echo('');
                window.term.error('❌ SharedArrayBuffer not available - fontc WASM cannot initialize');
                window.term.echo('[[;orange;]Try a hard refresh (Ctrl+Shift+R / Cmd+Shift+R) to activate the service worker.]');
                window.term.echo('');
            }
            this.isInitialized = false;
            return false;
        }

        try {
            // Create a Web Worker for fontc
            this.worker = new Worker('js/fontc-worker.js', { type: 'module' });

            // Set up message handler
            this.worker.onmessage = (e) => this.handleWorkerMessage(e);
            this.worker.onerror = (e) => this.handleWorkerError(e);

            // Wait for worker to be ready
            const ready = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Worker initialization timeout after 30 seconds. Check console for worker errors.'));
                }, 30000); // 30 second timeout

                const checkReady = (e) => {
                    console.log('Worker message:', e.data);
                    if (e.data.ready) {
                        clearTimeout(timeout);
                        this.worker.removeEventListener('message', checkReady);
                        resolve(true);
                    } else if (e.data.error) {
                        clearTimeout(timeout);
                        this.worker.removeEventListener('message', checkReady);
                        reject(new Error(e.data.error));
                    }
                };

                this.worker.addEventListener('message', checkReady);
            });

            this.isInitialized = ready;
            console.log('✅ babelfont-fontc WASM worker initialized');
            console.log('✅ Ready for direct Python → Rust compilation');
            return true;

        } catch (error) {
            console.error('❌ Failed to initialize babelfont-fontc WASM:', error.message);
            if (window.term) {
                window.term.error(`Failed to load babelfont-fontc: ${error.message}`);
                window.term.error('');
                window.term.error('Troubleshooting:');
                window.term.error('1. Make sure you ran: ./build-fontc-wasm.sh');
                window.term.error('2. Serving with: cd webapp && python3 serve-with-cors.py');
                window.term.error('3. Open in a regular browser (Chrome/Firefox), not VS Code Simple Browser');
                window.term.error('');
                if (error.message.includes('DataCloneError') || error.message.includes('Memory')) {
                    window.term.error('⚠️  This error suggests your browser context doesn\'t support WASM threading.');
                    window.term.error('   Try opening http://localhost:8000 in Chrome or Firefox.');
                }
            }
            return false;
        }
    }

    handleWorkerMessage(e) {
        const { id, result, error, time_taken } = e.data;

        if (id !== undefined && this.pendingCompilations.has(id)) {
            const { resolve, reject, filename } = this.pendingCompilations.get(id);
            this.pendingCompilations.delete(id);

            if (error) {
                reject(new Error(error));
            } else {
                resolve({ result, time_taken, filename });
            }
        }
    }

    handleWorkerError(e) {
        console.error('Worker error:', e);
        if (window.term) {
            window.term.error(`Worker error: ${e.message}`);
        }
    }

    /**
     * Compile font directly from .babelfont JSON string
     * This is the NEW direct path: Python → JSON → JavaScript → WASM
     * NO FILE SYSTEM OPERATIONS!
     * 
     * @param {string} babelfontJson - Complete .babelfont JSON string
     * @param {string} filename - Optional filename for output (default: 'font.ttf')
     * @returns {Promise<Object>} - { font: Uint8Array, filename: string, timeTaken: number }
     */
    async compileFromJson(babelfontJson, filename = 'font.babelfont') {
        if (!this.isInitialized) {
            const initialized = await this.initialize();
            if (!initialized) {
                throw new Error('babelfont-fontc WASM not available. Run ./build-fontc-wasm.sh and serve with CORS headers.');
            }
        }

        console.log(`🔨 Compiling ${filename} from .babelfont JSON...`);
        console.log(`📊 JSON size: ${babelfontJson.length} bytes`);

        const id = this.compilationId++;

        return new Promise((resolve, reject) => {
            this.pendingCompilations.set(id, { resolve, reject, filename });

            // Send JSON string directly to worker
            // No file system involved!
            this.worker.postMessage({
                id,
                babelfontJson,  // Just a string - fast transfer!
                filename
            });
        });
    }

    /**
     * Compile font from Python Font object
     * This calls Python's font.to_dict() and compiles the result
     * 
     * @param {string} fontVariableName - Name of the Python font variable
     * @param {string} outputFilename - Optional output filename
     * @returns {Promise<Object>} - Compilation result with download
     */
    async compileFromPythonFont(fontVariableName = 'font', outputFilename = null) {
        if (!window.pyodide) {
            throw new Error('Pyodide not available');
        }

        console.log(`🐍 Exporting ${fontVariableName} to .babelfont JSON...`);

        try {
            // Call Python to export JSON (in memory, no file writes!)
            const babelfontJson = await window.pyodide.runPythonAsync(`
import json

# Get the font object
try:
    font_obj = ${fontVariableName}
except NameError:
    raise ValueError("Font variable '${fontVariableName}' not found. Make sure it's defined.")

# Export to .babelfont JSON (in memory)
font_dict = font_obj.to_dict()
json.dumps(font_dict)
            `);

            console.log(`✅ Exported to JSON (${babelfontJson.length} bytes)`);
            console.log('🚀 Compiling with Rust/WASM...');

            // Compile from JSON
            const result = await this.compileFromJson(
                babelfontJson,
                outputFilename || `${fontVariableName}.babelfont`
            );

            console.log(`✅ Compiled in ${result.time_taken}ms`);

            // Trigger download
            this.downloadFont(result.font, result.filename);

            return {
                success: true,
                filename: result.filename,
                bytes: result.font.length,
                time_taken: result.time_taken
            };

        } catch (error) {
            console.error('❌ Compilation failed:', error);
            throw error;
        }
    }

    /**
     * Download compiled font
     * 
     * @param {Uint8Array} fontData - Compiled font bytes
     * @param {string} filename - Output filename
     */
    downloadFont(fontData, filename) {
        const blob = new Blob([fontData], { type: 'font/ttf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);

        console.log(`📥 Downloaded: ${filename} (${fontData.length} bytes)`);
    }

    // LEGACY METHOD - kept for backwards compatibility
    // This now uses the new direct JSON path internally
    async compile(inputPath, outputPath = null) {
        if (!window.pyodide) {
            throw new Error('Pyodide not available - cannot read file from virtual filesystem');
        }

        try {
            // Read font from file and convert to JSON
            console.log(`📖 Loading ${inputPath}...`);

            const babelfontJson = await window.pyodide.runPythonAsync(`
import json
from contextfonteditor import Font

# Load font from file
font = Font('${inputPath}')

# Export to .babelfont JSON
font_dict = font.to_dict()
json.dumps(font_dict)
            `);

            console.log(`✅ Loaded and exported to JSON`);

            // Compile using new direct method
            const filename = inputPath.split('/').pop();
            const result = await this.compileFromJson(babelfontJson, filename);

            // Save the compiled TTF to the virtual filesystem
            const outputFilename = outputPath || filename.replace(/\.(glyphs|designspace|ufo|babelfont)$/, '.ttf');

            await window.pyodide.runPython(`
import os
output_path = '${outputFilename}'
output_data = bytes(${JSON.stringify(Array.from(result.font))})

with open(output_path, 'wb') as f:
    f.write(output_data)

print(f"Compiled font saved to: {output_path}")
            `);

            console.log(`✅ Compiled in ${result.time_taken}ms: ${outputFilename}`);

            // Refresh file browser
            if (window.refreshFileSystem) {
                window.refreshFileSystem();
            }

            return {
                success: true,
                outputPath: outputFilename,
                time_taken: result.time_taken
            };

        } catch (error) {
            console.error('fontc compilation error:', error);

            return {
                success: false,
                error: error.message
            };
        }
    }

    // Expose a simple compile function for Python os.system() compatibility
    async compileFromPython(command) {
        // Parse fontc-style command
        // e.g., "fontc input.designspace -o output.ttf"
        const parts = command.trim().split(/\s+/);

        if (parts[0] !== 'fontc' && parts[0] !== 'fontmake') {
            throw new Error(`Unknown compiler: ${parts[0]}`);
        }

        let inputPath = null;
        let outputPath = null;

        for (let i = 1; i < parts.length; i++) {
            if (parts[i] === '-o' || parts[i] === '--output') {
                outputPath = parts[++i];
            } else if (!parts[i].startsWith('-')) {
                inputPath = parts[i];
            }
        }

        if (!inputPath) {
            throw new Error('No input file specified');
        }

        return await this.compile(inputPath, outputPath);
    }
}

// Create global instance
const fontCompilation = new FontCompilation();

// Initialize when DOM is ready
async function initFontCompilation() {
    await fontCompilation.initialize();
}

// Auto-initialize - wait longer to ensure service worker is active
document.addEventListener('DOMContentLoaded', () => {
    // Wait for service worker to be ready before initializing
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.ready.then(() => {
            // Give it a bit more time to ensure controller is set
            setTimeout(initFontCompilation, 2000);
        });
    } else {
        setTimeout(initFontCompilation, 2000);
    }
});

// Export for global access
window.fontCompilation = fontCompilation;
window.compileFontFromPython = (cmd) => fontCompilation.compileFromPython(cmd);

// NEW: Direct compilation methods exposed globally
window.compileFontDirect = (fontVarName, outputFile) => fontCompilation.compileFromPythonFont(fontVarName, outputFile);
window.compileFontFromJson = (json, filename) => fontCompilation.compileFromJson(json, filename);
