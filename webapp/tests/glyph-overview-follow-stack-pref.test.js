describe('glyph overview follow-stack scroll preference', () => {
    let pref;

    beforeEach(() => {
        localStorage.clear();
        jest.resetModules();
        pref = require('../js/glyph-overview-follow-stack-pref');
    });

    test('defaults to disabled', () => {
        expect(pref.isOverviewFollowStackScrollEnabled()).toBe(false);
    });

    test('persists opt-in and toggle', () => {
        expect(pref.toggleOverviewFollowStackScrollEnabled()).toBe(true);
        const ui = require('../js/window-ui-state');
        ui.flushSaveWindowUi();
        expect(pref.isOverviewFollowStackScrollEnabled()).toBe(true);
        expect(localStorage.getItem('windowUi.main')).toContain('follow=1');
        expect(localStorage.getItem('glyphOverviewFollowStackScroll')).toBe(
            null
        );

        expect(pref.toggleOverviewFollowStackScrollEnabled()).toBe(false);
        expect(pref.isOverviewFollowStackScrollEnabled()).toBe(false);
    });
});
