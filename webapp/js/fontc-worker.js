// Web Worker for fontc WASM compilation with babelfont-rs
// Direct .babelfont JSON → TTF compilation (no file system)

import * as babelfontFontc from '../wasm-dist/babelfont_fontc_web.js';

async function init() {
    try {
        // Check if SharedArrayBuffer is available
        if (typeof SharedArrayBuffer === 'undefined') {
            throw new Error('SharedArrayBuffer is not available. Make sure the page is served with proper CORS headers:\n' +
                'Cross-Origin-Embedder-Policy: require-corp\n' +
                'Cross-Origin-Opener-Policy: same-origin');
        }

        console.log('Worker: Loading babelfont-fontc WASM...');
        await babelfontFontc.default();

        console.log('Worker: Skipping thread pool due to browser limitations...');
        // NOTE: initThreadPool causes Memory cloning errors in some browsers (Brave, etc.)
        // Skip it - fontc will run single-threaded but still works
        // await babelfontFontc.initThreadPool(1);

        console.log('Worker: Ready (single-threaded mode)!');
        console.log('Worker: Using direct .babelfont → TTF pipeline');
        self.postMessage({ ready: true });

        // Handle compilation requests
        self.onmessage = async (event) => {
            const start = Date.now();
            const { id, babelfontJson, filename } = event.data;

            try {
                console.log(`Worker: Compiling ${filename} from .babelfont JSON...`);
                console.log(`Worker: JSON size: ${babelfontJson.length} bytes`);

                // THE MAGIC: Direct JSON → compiled font (no file system!)
                const result = babelfontFontc.compile_babelfont(babelfontJson);

                const time_taken = Date.now() - start;
                console.log(`Worker: Compiled ${filename} in ${time_taken}ms`);

                self.postMessage({
                    id,
                    result: Array.from(result),
                    time_taken,
                    filename: filename.replace(/\.babelfont$/, '.ttf')
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
            error: `Failed to initialize babelfont-fontc WASM: ${error.message}`
        });
    }
}

init();
