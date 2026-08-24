describe('glyph overview follow-stack scroll preference', () => {
    let pref;

    beforeEach(() => {
        localStorage.clear();
        jest.resetModules();
        pref = require('../js/glyph-overview-follow-stack-pref');
    });

    test('defaults to enabled', () => {
        expect(pref.isOverviewFollowStackScrollEnabled()).toBe(true);
    });

    test('persists opt-out and toggle', () => {
        expect(pref.toggleOverviewFollowStackScrollEnabled()).toBe(false);
        const ui = require('../js/window-ui-state');
        ui.flushSaveWindowUi();
        expect(pref.isOverviewFollowStackScrollEnabled()).toBe(false);
        expect(localStorage.getItem('windowUi.main')).toContain('follow=0');
        expect(localStorage.getItem('glyphOverviewFollowStackScroll')).toBe(
            null
        );

        expect(pref.toggleOverviewFollowStackScrollEnabled()).toBe(true);
        expect(pref.isOverviewFollowStackScrollEnabled()).toBe(true);
    });
});
