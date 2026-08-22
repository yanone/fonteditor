const {
    parseSwVersions,
    changelogUrlForUpdate,
    pendingUpdateFromSw,
    hasAvailableUpdate,
    pickLatestGitHubRelease,
    shouldShowForceUpdate
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

    test('parses webpack-minified concatenated const declarations', () => {
        const info = parseSwVersions(
            'let coepCredentialless=!1;const VERSION="v0.0.0-preview.20260822.6",DISPLAY_VERSION="20260822-build-6",CACHE_NAME="counterpunch-pwa-"+VERSION;'
        );
        expect(info).toEqual({
            tag: 'v0.0.0-preview.20260822.6',
            displayVersion: '20260822-build-6',
            isPreview: true
        });
    });

    test('falls back to VERSION when DISPLAY_VERSION is missing', () => {
        const info = parseSwVersions(`const VERSION = 'v0.2.1';`);
        expect(info).toEqual({
            tag: 'v0.2.1',
            displayVersion: 'v0.2.1',
            isPreview: false
        });
    });

    test('does not treat DISPLAY_VERSION as VERSION', () => {
        const info = parseSwVersions(
            `const DISPLAY_VERSION = 'v0.2.1'; const VERSION = 'v0.2.1';`
        );
        expect(info.tag).toBe('v0.2.1');
        expect(info.displayVersion).toBe('v0.2.1');
    });

    test('detects a newer preview from the running display version', () => {
        const published = parseSwVersions(
            'const VERSION="v0.0.0-preview.20260822.6",DISPLAY_VERSION="20260822-build-6";'
        );
        expect(hasAvailableUpdate(published, '20260821-build-5', null)).toBe(
            true
        );
        expect(hasAvailableUpdate(published, '20260822-build-6', null)).toBe(
            false
        );
        expect(
            hasAvailableUpdate(
                published,
                '20260822-build-6',
                'v0.0.0-preview.20260822.6'
            )
        ).toBe(false);
    });

    test('offers force update only after a manual check with no pending build', () => {
        expect(shouldShowForceUpdate(null, false)).toBe(false);
        expect(shouldShowForceUpdate(null, true)).toBe(true);
        expect(
            shouldShowForceUpdate(
                {
                    version: '20260822-build-6',
                    tag: 'v0.0.0-preview.20260822.6',
                    isPreview: true
                },
                true
            )
        ).toBe(false);
    });

    test('picks the latest GitHub prerelease on the preview channel', () => {
        const picked = pickLatestGitHubRelease(
            [
                {
                    tag_name: 'v0.0.0-preview.20260822.6',
                    name: '20260822-build-6',
                    prerelease: true
                },
                {
                    tag_name: 'v0.0.0-preview.20260821.5',
                    name: '20260821-build-5',
                    prerelease: true
                },
                { tag_name: 'v0.2.1', name: 'v0.2.1', prerelease: false }
            ],
            true
        );
        expect(picked).toEqual({
            tag: 'v0.0.0-preview.20260822.6',
            displayVersion: '20260822-build-6',
            isPreview: true
        });
        expect(
            pickLatestGitHubRelease(
                [{ tag_name: 'v0.2.1', name: 'v0.2.1', prerelease: false }],
                false
            )
        ).toEqual({
            tag: 'v0.2.1',
            displayVersion: 'v0.2.1',
            isPreview: false
        });
    });
});
