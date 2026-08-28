describe('tippy menu focus restore', () => {
    let addTippyBackdropSupport;
    let bindModalEscape;

    const createInstance = () => ({
        state: { isVisible: false },
        props: {},
        popper: document.createElement('div'),
        setProps(next) {
            this.props = { ...this.props, ...next };
        },
        hide() {
            this.state.isVisible = false;
            this.props.onHide?.(this);
        }
    });

    const show = (instance) => {
        instance.state.isVisible = true;
        instance.props.onShow?.(instance);
    };

    beforeEach(() => {
        jest.resetModules();
        document.body.innerHTML = '';
        ({ addTippyBackdropSupport } = require('../js/tippy-utils'));
        ({ bindModalEscape } = require('../js/ui/modal-escape'));
        window.restoreFocusedViewDomFocus = jest.fn();
    });

    afterEach(() => {
        delete window.restoreFocusedViewDomFocus;
        document.body.innerHTML = '';
    });

    it('restores the focused view after the last menu hides', async () => {
        const instance = createInstance();
        addTippyBackdropSupport(instance, document.createElement('div'));
        show(instance);
        instance.hide();
        await Promise.resolve();
        expect(window.restoreFocusedViewDomFocus).toHaveBeenCalledTimes(1);
    });

    it('does not restore while another registered menu remains open', async () => {
        const first = createInstance();
        const second = createInstance();
        addTippyBackdropSupport(first, document.createElement('div'));
        addTippyBackdropSupport(second, document.createElement('div'));
        show(first);
        show(second);
        first.hide();
        await Promise.resolve();
        expect(window.restoreFocusedViewDomFocus).not.toHaveBeenCalled();
        second.hide();
        await Promise.resolve();
        expect(window.restoreFocusedViewDomFocus).toHaveBeenCalledTimes(1);
    });

    it('does not restore while a modal escape binding is open', async () => {
        const instance = createInstance();
        addTippyBackdropSupport(instance, document.createElement('div'));
        const binding = bindModalEscape(() => {});
        show(instance);
        instance.hide();
        await Promise.resolve();
        expect(window.restoreFocusedViewDomFocus).not.toHaveBeenCalled();
        binding.release();
        await Promise.resolve();
        expect(window.restoreFocusedViewDomFocus).toHaveBeenCalled();
    });
});
