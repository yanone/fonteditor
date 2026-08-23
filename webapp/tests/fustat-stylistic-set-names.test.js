const { execFileSync } = require('child_process');
const path = require('path');

describe('Fustat stylistic set names from compiled WASM output', () => {
    test('compiles Fustat with the WASM pack and reads ss03 from get_stylistic_set_names', () => {
        const helper = path.join(
            __dirname,
            'helpers/compile-glyphs-stylistic-set-names.mjs'
        );
        const glyphsPath = path.join(__dirname, '../examples/Fustat.glyphs');
        const namesJson = execFileSync(process.execPath, [helper, glyphsPath], {
            encoding: 'utf8',
            maxBuffer: 50 * 1024 * 1024,
            timeout: 120000
        });
        const names = JSON.parse(namesJson);

        expect(names.ss03).toBe('Geometric a g');
    }, 120000);
});
