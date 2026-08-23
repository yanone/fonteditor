describe('editor preview area preference', () => {
    let pref;

    beforeEach(() => {
        localStorage.clear();
        jest.resetModules();
        pref = require('../js/editor-preview-area-pref');
    });

    test('defaults to small', () => {
        expect(pref.getPreviewArea()).toBe('small');
        expect(pref.parsePreviewArea(null)).toBe('small');
        expect(pref.parsePreviewArea('nope')).toBe('small');
    });

    test('persists small, medium, and full', () => {
        pref.setPreviewArea('small');
        expect(pref.getPreviewArea()).toBe('small');
        const ui = require('../js/window-ui-state');
        ui.flushSaveWindowUi();
        expect(localStorage.getItem('windowUi.main')).not.toContain('preview=');
        expect(localStorage.getItem('editorPreviewArea')).toBe(null);

        pref.setPreviewArea('medium');
        expect(pref.getPreviewArea()).toBe('medium');

        pref.setPreviewArea('full');
        expect(pref.getPreviewArea()).toBe('full');
    });
});
