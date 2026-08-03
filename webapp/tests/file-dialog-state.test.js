const {
    getDefaultDialogSelectionPath,
    getFileDialogHeaderActions,
    getFileDialogPrimaryAction,
    getFileDialogRefreshStatus,
    getFileDialogSaveWarningPresentation,
    isOpenDialogConfirmEnabled,
    shouldOpenFileOnDialogDoubleClick
} = require('../js/file-dialog-state');

describe('file dialog state', () => {
    test('clears a current-font selection when switching to another plugin', () => {
        const currentFont = {
            path: '/user/Fustat.glyphs',
            sourcePlugin: { getId: () => 'memory' }
        };

        expect(getDefaultDialogSelectionPath('memory', currentFont)).toBe(
            '/user/Fustat.glyphs'
        );
        expect(getDefaultDialogSelectionPath('cloud', currentFont)).toBeNull();
        expect(isOpenDialogConfirmEnabled(false)).toBe(false);
    });

    test('limits uploads to memory and respects plugin header capabilities', () => {
        expect(getFileDialogHeaderActions('memory', false, true)).toEqual({
            showsUploadButtons: true,
            showsNewFolderButton: false,
            showsRefreshButton: true
        });
        expect(getFileDialogHeaderActions('cloud', false, false)).toEqual({
            showsUploadButtons: false,
            showsNewFolderButton: false,
            showsRefreshButton: false
        });
    });

    test('renders Cloud size states without allowing an over-limit save', () => {
        expect(
            getFileDialogSaveWarningPresentation(
                {
                    visible: true,
                    title: 'Near limit warning',
                    label: 'Near limit',
                    icon: 'warning',
                    tone: 'warning',
                    canSave: true
                },
                true
            )
        ).toEqual({
            visible: true,
            blocksSave: false,
            title: 'Near limit warning',
            label: 'Near limit',
            icon: 'warning',
            tone: 'warning'
        });
        expect(
            getFileDialogSaveWarningPresentation(
                {
                    visible: true,
                    title: 'Too large error',
                    label: 'Too large',
                    icon: 'sync_problem',
                    tone: 'error',
                    canSave: false
                },
                true
            )
        ).toMatchObject({ visible: true, blocksSave: true, tone: 'error' });
    });

    test('shows refresh status only for plugins with a manual refresh action', () => {
        expect(getFileDialogRefreshStatus(false, Date.now())).toEqual({
            visible: false,
            text: ''
        });
        expect(getFileDialogRefreshStatus(true, null)).toEqual({
            visible: true,
            text: 'Last refreshed Not refreshed yet'
        });
    });

    test('does not open a font from a save-as double click', () => {
        expect(shouldOpenFileOnDialogDoubleClick('save-as', true)).toBe(false);
        expect(shouldOpenFileOnDialogDoubleClick('open', true)).toBe(true);
        expect(shouldOpenFileOnDialogDoubleClick('open', false)).toBe(false);
    });

    test('closes instead of reopening the current font', () => {
        const currentFont = {
            path: '/user/Fustat.glyphs',
            sourcePlugin: { getId: () => 'memory' }
        };

        expect(
            getFileDialogPrimaryAction(
                'open',
                '/user/Fustat.glyphs',
                true,
                'memory',
                currentFont
            )
        ).toBe('close');
        expect(
            getFileDialogPrimaryAction(
                'open',
                '/user/YanoneKaffeesatz.designspace',
                true,
                'memory',
                currentFont
            )
        ).toBe('open');
    });
});
