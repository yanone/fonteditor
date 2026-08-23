describe('window UI compact state', () => {
    function loadUi() {
        jest.resetModules();
        return require('../js/window-ui-state');
    }

    beforeEach(() => {
        localStorage.clear();
        delete window.windowRole;
        delete window.__windowUiRuntime;
        jest.resetModules();
    });

    test('writes the fresh default string for main', () => {
        const ui = loadUi();
        expect(localStorage.getItem('windowUi.main')).toBe(
            ui.DEFAULT_WINDOW_UI_STRING
        );
        expect(ui.encodeWindowUi(ui.decodeWindowUi(null))).toBe(
            ui.DEFAULT_WINDOW_UI_STRING
        );
    });

    test('keeps closed docs and bottom-row sentinels', () => {
        const ui = loadUi();
        const decoded = ui.decodeWindowUi('v1;docs=-;rows=100,-;top=0,33,67');
        expect(decoded.docs).toBeNull();
        expect(decoded.rows).toEqual({ top: 100, bottom: null });
        expect(ui.encodeWindowUi(decoded)).toBe(ui.DEFAULT_WINDOW_UI_STRING);
    });

    test('renormalizes open top-row percents', () => {
        const ui = loadUi();
        const decoded = ui.decodeWindowUi('v1;docs=-;rows=100,-;top=0,20,20');
        expect(decoded.top).toEqual([0, 20, 80]);
    });

    test('falls back to defaults for corrupt strings', () => {
        const ui = loadUi();
        expect(ui.decodeWindowUi('not-v1')).toMatchObject({
            docs: null,
            overviewMode: 'normal',
            overviewSize: 5,
            follow: false
        });
        expect(ui.decodeWindowUi('v1;docs=40')).toMatchObject({
            top: [0, 33, 67]
        });
    });

    test('does not migrate leftover per-key prefs', () => {
        localStorage.setItem(
            'viewLayout',
            '{"vertical":{"top":["1","0","0"]}}'
        );
        localStorage.setItem('glyphFilterActive', 'basic/all');
        localStorage.setItem('fontInfoSelectedTab', 'axes');
        localStorage.setItem('glyphOverviewFollowStackScroll', 'true');
        const ui = loadUi();
        expect(ui.getWindowUiState()).toMatchObject({
            top: [0, 33, 67],
            filters: [],
            fontinfo: null,
            follow: false
        });
    });

    test('uses the linked ordinal slot', () => {
        window.windowRole = { linkedOrdinal: 1 };
        const ui = loadUi();
        expect(localStorage.getItem('windowUi.1')).toBe(
            ui.DEFAULT_WINDOW_UI_STRING
        );
        expect(localStorage.getItem('windowUi.main')).toBeNull();
    });

    test('keeps disabled plugin params in plugins=', () => {
        const ui = loadUi();
        const encoded = ui.encodeWindowUi({
            ...ui.decodeWindowUi(ui.DEFAULT_WINDOW_UI_STRING),
            plugins: [{ id: 'CurvatureComb', params: { exponent: '2' } }],
            disabledPlugins: [{ id: 'Example', params: { opacity: '0.8' } }]
        });
        expect(encoded).toContain(
            'plugins=CurvatureComb+exponent:2,-Example+opacity:0.8'
        );
        const decoded = ui.decodeWindowUi(encoded);
        expect(decoded.plugins).toEqual([
            { id: 'CurvatureComb', params: { exponent: '2' } }
        ]);
        expect(decoded.disabledPlugins).toEqual([
            { id: 'Example', params: { opacity: '0.8' } }
        ]);
    });

    test('stores multiple filters and matrix tile size', () => {
        const ui = loadUi();
        ui.setGlyphFilterIds(['basic/all', 'user/mine']);
        ui.setOverviewDisplayMode('matrix');
        ui.setOverviewSize(7);
        ui.flushSaveWindowUi();
        const stored = localStorage.getItem('windowUi.main');
        expect(stored).toContain('filter=basic%2Fall,user%2Fmine');
        expect(stored).toContain('overview=matrix,7');
        expect(ui.getGlyphFilterIds()).toEqual(['basic/all', 'user/mine']);
        expect(ui.getOverviewDisplayMode()).toBe('matrix');
        expect(ui.getOverviewSize()).toBe(7);
    });

    test('stores follow and a non-default font info section', () => {
        const ui = loadUi();
        ui.setOverviewFollowEnabled(true);
        ui.setFontInfoSection('axes');
        ui.flushSaveWindowUi();
        const stored = localStorage.getItem('windowUi.main');
        expect(stored).toContain('follow=1');
        expect(stored).toContain('fontinfo=axes');
        ui.setFontInfoSection('names');
        ui.flushSaveWindowUi();
        expect(localStorage.getItem('windowUi.main')).not.toContain(
            'fontinfo='
        );
    });

    test('keeps overview mode and tile size when a second module copy saves layout', () => {
        const layoutCopy = loadUi();
        jest.resetModules();
        const overviewCopy = require('../js/window-ui-state');
        overviewCopy.setOverviewDisplayMode('matrix');
        overviewCopy.setOverviewSize(7);
        overviewCopy.setOverviewFollowEnabled(true);
        overviewCopy.setGlyphFilterIds(['basic/all']);
        overviewCopy.flushSaveWindowUi();

        layoutCopy.saveWindowUiFromDom();
        const stored = localStorage.getItem('windowUi.main');
        expect(stored).toContain('overview=matrix,7');
        expect(stored).toContain('follow=1');
        expect(stored).toContain('filter=basic%2Fall');
        expect(layoutCopy.getOverviewDisplayMode()).toBe('matrix');
        expect(layoutCopy.getOverviewSize()).toBe(7);
    });

    test('reloads the linked slot after window role is assigned', () => {
        const ui = loadUi();
        expect(localStorage.getItem('windowUi.main')).toBe(
            ui.DEFAULT_WINDOW_UI_STRING
        );

        window.windowRole = { linkedOrdinal: 1 };
        localStorage.setItem(
            'windowUi.1',
            'v1;docs=-;rows=100,-;top=0,33,67;overview=matrix,8'
        );
        expect(ui.getOverviewDisplayMode()).toBe('matrix');
        expect(ui.getOverviewSize()).toBe(8);
        expect(localStorage.getItem('windowUi.main')).toBe(
            ui.DEFAULT_WINDOW_UI_STRING
        );
    });
});
