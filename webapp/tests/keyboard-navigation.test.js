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

describe('keyboard navigation focusView DOM transfer', () => {
    beforeAll(() => {
        window.VIEW_SETTINGS = {
            shortcuts: {},
            animation: { enabled: false, duration: 0 },
            resize: {}
        };
        require('../js/keyboard-navigation');
    });

    beforeEach(() => {
        jest.useFakeTimers();
        document.body.innerHTML = `
            <div class="top-row">
                <div id="view-editor" class="view focused"></div>
                <div id="view-overview" class="view"></div>
                <div id="view-fontinfo" class="view"></div>
            </div>
            <canvas id="test-glyph-canvas" tabindex="0"></canvas>
        `;
        const canvas = document.getElementById('test-glyph-canvas');
        window.glyphCanvas = { canvas };
        canvas.focus();
        // Clear the focusing lock left by a previous focusView call.
        jest.advanceTimersByTime(250);
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        document.body.innerHTML = '';
        delete window.glyphCanvas;
    });

    it('blurs the editor canvas when activating overview via keyboard', () => {
        const canvas = window.glyphCanvas.canvas;
        expect(document.activeElement).toBe(canvas);

        window.focusView('view-overview', true);

        expect(
            document
                .getElementById('view-overview')
                .classList.contains('focused')
        ).toBe(true);
        expect(document.activeElement).not.toBe(canvas);
        expect(document.activeElement).toBe(
            document.getElementById('view-overview')
        );
    });

    it('blurs the editor canvas when activating font info', () => {
        const canvas = window.glyphCanvas.canvas;
        expect(document.activeElement).toBe(canvas);

        window.focusView('view-fontinfo', true);

        expect(document.activeElement).not.toBe(canvas);
        expect(document.activeElement).toBe(
            document.getElementById('view-fontinfo')
        );
    });
});
