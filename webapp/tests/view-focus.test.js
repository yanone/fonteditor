const { getClosestExpandedTopRowViewId } = require('../js/view-focus');

describe('getClosestExpandedTopRowViewId', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div class="top-row">
                <div id="view-fontinfo" class="view"></div>
                <div id="view-overview" class="view"></div>
                <div id="view-editor" class="view"></div>
            </div>
        `;
        const boxes = {
            'view-fontinfo': { left: 0, width: 400 },
            'view-overview': { left: 400, width: 24 },
            'view-editor': { left: 424, width: 600 }
        };
        for (const [viewId, box] of Object.entries(boxes)) {
            const view = document.getElementById(viewId);
            Object.defineProperty(view, 'getBoundingClientRect', {
                configurable: true,
                value: () => ({
                    left: box.left,
                    width: box.width,
                    right: box.left + box.width,
                    top: 0,
                    bottom: 100,
                    height: 100,
                    x: box.left,
                    y: 0,
                    toJSON: () => ({})
                })
            });
        }
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('picks the nearest expanded top-row neighbor', () => {
        expect(getClosestExpandedTopRowViewId('view-overview')).toBe(
            'view-fontinfo'
        );
        expect(getClosestExpandedTopRowViewId('view-fontinfo')).toBe(
            'view-editor'
        );
    });
});

describe('modal escape focus restore', () => {
    it('restores the focused view after the last modal releases', async () => {
        window.restoreFocusedViewDomFocus = jest.fn();
        const { bindModalEscape } = require('../js/ui/modal-escape');
        const binding = bindModalEscape(() => {});
        binding.release();
        await Promise.resolve();
        expect(window.restoreFocusedViewDomFocus).toHaveBeenCalled();
        delete window.restoreFocusedViewDomFocus;
    });

    it('does not restore while another modal remains bound', async () => {
        window.restoreFocusedViewDomFocus = jest.fn();
        const { bindModalEscape } = require('../js/ui/modal-escape');
        const outer = bindModalEscape(() => {});
        const inner = bindModalEscape(() => {});
        inner.release();
        await Promise.resolve();
        expect(window.restoreFocusedViewDomFocus).not.toHaveBeenCalled();
        outer.release();
        await Promise.resolve();
        expect(window.restoreFocusedViewDomFocus).toHaveBeenCalled();
        delete window.restoreFocusedViewDomFocus;
    });
});
