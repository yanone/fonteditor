import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import init, {
    store_font,
    interpolate_glyph
} from '../../wasm-dist/babelfont_fontc_web.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const [, , fontPath, glyphName, locationJson] = process.argv;

if (!fontPath || !glyphName || locationJson === undefined) {
    process.stderr.write(
        'Usage: interpolate-glyph.mjs <fontPath> <glyphName> <locationJson>\n'
    );
    process.exit(1);
}

const fontJson = fs.readFileSync(fontPath, 'utf-8');
const wasmPath = path.join(
    __dirname,
    '../../wasm-dist/babelfont_fontc_web_bg.wasm'
);
const wasmBytes = fs.readFileSync(wasmPath);
await init(wasmBytes);

store_font(fontJson);
process.stdout.write(interpolate_glyph(glyphName, locationJson, false, '[]'));
