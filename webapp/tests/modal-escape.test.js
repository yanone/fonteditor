describe('bindModalEscape', () => {
    afterEach(() => {
        const runtime = window.__modalEscapeRuntime;
        if (runtime) {
            runtime.stack.length = 0;
        }
        delete window.restoreFocusedViewDomFocus;
    });

    it('closes nested modals from the top', () => {
        const { bindModalEscape } = require('../js/ui/modal-escape');
        const closed = [];
        bindModalEscape(() => closed.push('outer'));
        bindModalEscape(() => closed.push('inner'));

        document.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true
            })
        );
        expect(closed).toEqual(['inner']);

        document.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true
            })
        );
        expect(closed).toEqual(['inner', 'outer']);
    });

    it('shares one stack across module copies', () => {
        jest.resetModules();
        const closed = [];
        const first = require('../js/ui/modal-escape');
        first.bindModalEscape(() => closed.push('file-dialog'));

        jest.resetModules();
        const second = require('../js/ui/modal-escape');
        second.bindModalEscape(() => closed.push('link-folders'));

        document.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true
            })
        );
        expect(closed).toEqual(['link-folders']);

        document.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true
            })
        );
        expect(closed).toEqual(['link-folders', 'file-dialog']);
    });
});
