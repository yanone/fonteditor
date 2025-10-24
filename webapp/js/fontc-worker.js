// Web Worker for fontc WASM compilation
// Based on Simon Cozens' fontc-web approach

import * as fontc from '../wasm-dist/fontc_web.js';

async function init() {
    try {
        // Check if SharedArrayBuffer is available
        if (typeof SharedArrayBuffer === 'undefined') {
            throw new Error('SharedArrayBuffer is not available. Make sure the page is served with proper CORS headers:\n' +
                'Cross-Origin-Embedder-Policy: require-corp\n' +
                'Cross-Origin-Opener-Policy: same-origin');
        }

        console.log('Worker: Loading WASM...');
        await fontc.default();

        console.log('Worker: Skipping thread pool due to browser limitations...');
        // NOTE: initThreadPool causes Memory cloning errors in some browsers (Brave, etc.)
        // Skip it - fontc will run single-threaded but still works
        // await fontc.initThreadPool(1);

        console.log('Worker: Ready (single-threaded mode)!');
        self.postMessage({ ready: true });

        // Handle compilation requests
        self.onmessage = async (event) => {
            const start = Date.now();
            const { id, glyphs, filename } = event.data;

            try {
                console.log(`Worker: Compiling ${filename}...`);
                const result = fontc.compile_glyphs(glyphs);
                const time_taken = Date.now() - start;

                console.log(`Worker: Compiled ${filename} in ${time_taken}ms`);

                self.postMessage({
                    id,
                    result: Array.from(result),
                    time_taken,
                    filename: filename.replace(/\.(glyphs|designspace|ufo)$/, '.ttf')
                });
            } catch (e) {
                console.error('Worker: Compilation error:', e);
                self.postMessage({
                    id,
                    error: e.toString()
                });
            }
        };

    } catch (error) {
        console.error('Worker: Initialization error:', error);
        self.postMessage({
            error: `Failed to initialize fontc WASM: ${error.message}`
        });
    }
}

init();
