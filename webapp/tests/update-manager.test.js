const {
    parseSwVersions,
    changelogUrlForUpdate,
    pendingUpdateFromSw
} = require('../js/update-manager.ts');

describe('update-manager version helpers', () => {
    test('parses cache-bust tag and display version', () => {
        const info = parseSwVersions(`
            const VERSION = 'v0.0.0-preview.20260816.1';
            const DISPLAY_VERSION = '20260816-build-1';
        `);
        expect(info).toEqual({
            tag: 'v0.0.0-preview.20260816.1',
            displayVersion: '20260816-build-1',
            isPreview: true
        });
        expect(pendingUpdateFromSw(info)).toEqual({
            version: '20260816-build-1',
            tag: 'v0.0.0-preview.20260816.1',
            isPreview: true
        });
        expect(changelogUrlForUpdate(pendingUpdateFromSw(info))).toBe(
            'https://github.com/counterpunchspace/editor/releases/tag/v0.0.0-preview.20260816.1'
        );
    });

    test('falls back to VERSION when DISPLAY_VERSION is missing', () => {
        const info = parseSwVersions(`const VERSION = 'v0.2.1';`);
        expect(info).toEqual({
            tag: 'v0.2.1',
            displayVersion: 'v0.2.1',
            isPreview: false
        });
    });
});
