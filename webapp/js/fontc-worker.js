// Web Worker for fontc WASM compilation
// Based on Simon Cozens' fontc-web approach

import * as fontc from '../wasm-dist/fontc_web.js';

async function init() {
    try {
        console.log('Worker: Loading WASM...');
        await fontc.default();

        console.log('Worker: Setting up thread pool...');
        await fontc.initThreadPool(navigator.hardwareConcurrency || 4);

        console.log('Worker: Ready!');
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
