const {
    beginStartupInteractionLock,
    endStartupInteractionLock
} = require('../js/startup-interaction-lock');

describe('startup interaction lock', () => {
    afterEach(() => {
        endStartupInteractionLock();
        document.body.classList.remove('startup-interaction-locked');
        document.body.innerHTML = '';
    });

    test('shows an overlay and body lock class while active', () => {
        beginStartupInteractionLock();

        const overlay = document.getElementById(
            'startup-interaction-lock-overlay'
        );

        expect(
            document.body.classList.contains('startup-interaction-locked')
        ).toBe(true);
        expect(overlay).toBeTruthy();
        expect(overlay.style.display).toBe('block');

        endStartupInteractionLock();

        expect(
            document.body.classList.contains('startup-interaction-locked')
        ).toBe(false);
        expect(overlay.style.display).toBe('none');
    });

    test('blocks normal typing while active', () => {
        beginStartupInteractionLock();

        const event = new KeyboardEvent('keydown', {
            key: 'a',
            bubbles: true,
            cancelable: true
        });
        const dispatchResult = document.dispatchEvent(event);

        expect(dispatchResult).toBe(false);
        expect(event.defaultPrevented).toBe(true);
    });

    test('allows modified shortcut keys through', () => {
        beginStartupInteractionLock();

        const event = new KeyboardEvent('keydown', {
            key: 'r',
            metaKey: true,
            bubbles: true,
            cancelable: true
        });
        const dispatchResult = document.dispatchEvent(event);

        expect(dispatchResult).toBe(true);
        expect(event.defaultPrevented).toBe(false);
    });
});
