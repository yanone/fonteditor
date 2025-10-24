// Font Compilation Integration
// Uses fontc WASM with Web Workers (Simon Cozens' approach)
// Based on: https://github.com/simoncozens/fontc-web

class FontCompilation {
    constructor() {
        this.worker = null;
        this.isInitialized = false;
        this.pendingCompilations = new Map();
        this.compilationId = 0;
    }

    async initialize() {
        if (this.isInitialized) return true;

        console.log('🔧 Initializing fontc WASM worker...');

        // Check if SharedArrayBuffer is available
        if (typeof SharedArrayBuffer === 'undefined') {
            throw new Error(
                'SharedArrayBuffer is not available. This is required for fontc threading.\n' +
                'Make sure you are serving the page with proper CORS headers:\n' +
                '  Cross-Origin-Embedder-Policy: require-corp\n' +
                '  Cross-Origin-Opener-Policy: same-origin\n\n' +
                'Use: cd webapp && python3 serve-with-cors.py'
            );
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
                    reject(new Error('Worker initialization timeout'));
                }, 30000); // 30 second timeout

                const checkReady = (e) => {
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
            console.log('✅ fontc WASM worker initialized');
            return true;

        } catch (error) {
            console.error('❌ Failed to initialize fontc WASM:', error.message);
            if (window.term) {
                window.term.error(`Failed to load fontc: ${error.message}`);
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

    async compile(inputPath, outputPath = null) {
        if (!this.isInitialized) {
            const initialized = await this.initialize();
            if (!initialized) {
                throw new Error('fontc WASM not available. Run ./build-fontc-wasm.sh and serve with CORS headers.');
            }
        }

        try {
            // Read the input file from the virtual filesystem
            if (!window.pyodide) {
                throw new Error('Pyodide not available - cannot read file from virtual filesystem');
            }

            const glyphsContent = await window.pyodide.runPython(`
import os
input_path = '${inputPath}'
if not os.path.exists(input_path):
    raise FileNotFoundError(f"File not found: {input_path}")

with open(input_path, 'r') as f:
    f.read()
            `);

            console.log(`🔨 Compiling ${inputPath} with fontc...`);

            // Send to worker
            const id = this.compilationId++;
            const filename = inputPath.split('/').pop();

            const result = await new Promise((resolve, reject) => {
                this.pendingCompilations.set(id, { resolve, reject, filename });

                this.worker.postMessage({
                    id,
                    glyphs: glyphsContent,
                    filename
                });
            });

            // Save the compiled TTF to the virtual filesystem
            const outputFilename = outputPath || filename.replace(/\.(glyphs|designspace|ufo)$/, '.ttf');

            await window.pyodide.runPython(`
import os
output_path = '${outputFilename}'
output_data = bytes(${JSON.stringify(Array.from(result.result))})

with open(output_path, 'wb') as f:
    f.write(output_data)

print(f"Compiled font saved to: {output_path}")
            `);

            if (window.term) {
                window.term.echo(`✅ Compiled in ${result.time_taken}ms: ${outputFilename}`);
            }

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

            if (window.term) {
                window.term.error(`❌ Compilation failed: ${error.message}`);
            }

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

// Auto-initialize
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(initFontCompilation, 1000);
});

// Export for global access
window.fontCompilation = fontCompilation;
window.compileFontFromPython = (cmd) => fontCompilation.compileFromPython(cmd);
