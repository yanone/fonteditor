describe('view title buttons', () => {
    beforeEach(() => {
        jest.resetModules();
        window.VIEW_SETTINGS = {
            shortcuts: {},
            activation: {},
            resize: {}
        };
        document.body.innerHTML = `
            <div class="container">
                <div class="top-row">
                    <div id="view-fontinfo" class="view collapsed-width">
                        <div class="view-title-bar"><div class="view-title-left"><span class="view-title-heading">Font Info</span></div></div>
                    </div>
                    <div id="view-overview" class="view">
                        <div class="view-title-bar"><div class="view-title-left"><span class="view-title-heading">Overview</span></div></div>
                    </div>
                    <div id="view-editor" class="view">
                        <div class="view-title-bar"><div class="view-title-left"><span class="view-title-heading">Editor</span></div></div>
                    </div>
                </div>
                <div class="bottom-row">
                    <div id="view-history" class="view">
                        <div class="view-title-bar"><div class="view-title-left"><span class="view-title-heading">History</span></div></div>
                    </div>
                    <div id="view-scripts" class="view">
                        <div class="view-title-bar"><div class="view-title-left"><span class="view-title-heading">Scripts</span></div></div>
                    </div>
                    <div id="view-console" class="view">
                        <div class="view-title-bar"><div class="view-title-left"><span class="view-title-heading">Console</span></div></div>
                    </div>
                </div>
            </div>
        `;
        window.collapseActiveView = jest.fn((viewId) => {
            document.getElementById(viewId).classList.add('collapsed-width');
        });
    });

    afterEach(() => {
        document.body.innerHTML = '';
        delete window.collapseActiveView;
        delete window.VIEW_SETTINGS;
    });

    test('collapses a top-row view and hides the final remaining collapse control', async () => {
        const { initViewTitleButtons } = require('../js/view-title-buttons');
        initViewTitleButtons();

        const editorCollapseButton = document.querySelector(
            '#view-editor .view-title-collapse-btn'
        );
        const overviewCollapseButton = document.querySelector(
            '#view-overview .view-title-collapse-btn'
        );
        expect(editorCollapseButton.style.display).toBe('flex');
        expect(overviewCollapseButton.style.display).toBe('flex');

        editorCollapseButton.click();
        await Promise.resolve();

        expect(window.collapseActiveView).toHaveBeenCalledWith('view-editor');
        expect(
            document
                .getElementById('view-editor')
                .classList.contains('collapsed-width')
        ).toBe(true);
        expect(editorCollapseButton.style.display).toBe('none');
        expect(overviewCollapseButton.style.display).toBe('none');
    });
});
