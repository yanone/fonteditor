describe('keyboard navigation browser-history guard', () => {
    beforeAll(() => {
        window.VIEW_SETTINGS = { shortcuts: {} };
        require('../js/keyboard-navigation');
    });

    const dispatchAltLeft = (target, shiftKey = false) => {
        const event = new KeyboardEvent('keydown', {
            key: 'ArrowLeft',
            altKey: true,
            shiftKey,
            bubbles: true,
            cancelable: true
        });
        target.dispatchEvent(event);
        return event;
    };

    it('preserves Alt/Option word selection in text inputs', () => {
        const input = document.createElement('input');
        input.type = 'text';
        document.body.appendChild(input);
        input.focus();

        expect(dispatchAltLeft(input, true).defaultPrevented).toBe(false);

        input.remove();
    });

    it('still blocks browser history navigation outside text inputs', () => {
        expect(dispatchAltLeft(document.body).defaultPrevented).toBe(true);
    });
});
