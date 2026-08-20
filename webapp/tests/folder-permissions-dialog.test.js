describe('folder access classification', () => {
    let folderPermissions;

    beforeEach(() => {
        jest.resetModules();
        folderPermissions = require('../js/folder-permissions-dialog');
    });

    test('missing when no handle is stored', () => {
        expect(folderPermissions.classifyFolderAccess(false, null)).toBe(
            'missing'
        );
        expect(folderPermissions.classifyFolderAccess(false, 'granted')).toBe(
            'missing'
        );
    });

    test('needs renewal when a handle exists without granted permission', () => {
        expect(folderPermissions.classifyFolderAccess(true, 'prompt')).toBe(
            'needsRenewal'
        );
        expect(folderPermissions.classifyFolderAccess(true, 'denied')).toBe(
            'needsRenewal'
        );
        expect(folderPermissions.classifyFolderAccess(true, null)).toBe(
            'needsRenewal'
        );
    });

    test('ready only when the handle is granted', () => {
        expect(folderPermissions.classifyFolderAccess(true, 'granted')).toBe(
            'ready'
        );
    });

    test('setup is complete only when both folders are ready', () => {
        expect(
            folderPermissions.isFolderSetupComplete({
                project: { state: 'ready', name: 'Fonts' },
                settings: { state: 'ready', name: 'Counterpunch' }
            })
        ).toBe(true);
        expect(
            folderPermissions.isFolderSetupComplete({
                project: { state: 'ready', name: 'Fonts' },
                settings: { state: 'needsRenewal', name: 'Counterpunch' }
            })
        ).toBe(false);
        expect(
            folderPermissions.isFolderSetupComplete({
                project: { state: 'missing', name: null },
                settings: { state: 'ready', name: 'Counterpunch' }
            })
        ).toBe(false);
    });
});
