jest.mock('../wasm-dist/babelfont_fontc_web.js', () =>
    require('./__mocks__/babelfontWasmMock')
);

const { prepareOpenFontWasmInput } = require('../js/fontc-worker');
const { store_font } = require('../wasm-dist/babelfont_fontc_web');
const fs = require('fs');
const path = require('path');
const { open_font_file } = require('../wasm-dist/babelfont_fontc_web');

describe('fontc-worker openFont conversion', () => {
    test('passes .glyphs bytes through without a Latin-1 Array.from join', () => {
        const bytes = new Uint8Array([
            0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x00
        ]);
        const payload = prepareOpenFontWasmInput(bytes);

        expect(payload).toBe(bytes);
        expect(payload).toBeInstanceOf(Uint8Array);
    });

    test('openFont conversion helper does not store_font', () => {
        store_font.mockClear();
        prepareOpenFontWasmInput(
            new Uint8Array([123, 34, 97, 34, 58, 49, 125])
        );
        expect(store_font).not.toHaveBeenCalled();
    });

    test('.glyphs bytes and utf-8 string round-trip to the same babelfont JSON', () => {
        const glyphsPath = path.join(__dirname, '../examples/Fustat.glyphs');
        const fileBytes = fs.readFileSync(glyphsPath);
        const fromBytes = JSON.parse(
            open_font_file('Fustat.glyphs', new Uint8Array(fileBytes))
        );
        const fromString = JSON.parse(
            open_font_file('Fustat.glyphs', fileBytes.toString('utf8'))
        );

        expect(fromBytes.glyphs.map((glyph) => glyph.name)).toEqual(
            fromString.glyphs.map((glyph) => glyph.name)
        );
        expect(fromBytes.glyphs.length).toBeGreaterThan(0);
    });
});
