jest.mock('../js/glyph-tile-renderer-fast', () => ({
    fastGlyphTileRenderer: {
        renderToCanvas: jest.fn()
    }
}));

describe('FindGlyphDialog', () => {
    beforeEach(() => {
        jest.resetModules();
        global.requestAnimationFrame = (callback) => setTimeout(callback, 0);

        document.body.innerHTML = `
            <button id="find-glyph-btn"></button>
            <div id="find-glyph-modal" style="display: none">
                <h3 id="find-glyph-modal-title">Find Glyph</h3>
                <button id="find-glyph-modal-close-btn"></button>
                <div id="find-glyph-modal-content"></div>
            </div>
        `;
        window.currentFontModel = {
            glyphs: [
                { name: 'A', codepoints: [0x41] },
                { name: 'acutecomb', codepoints: [0x301] },
                { name: 'acute' },
                { name: 'B', codepoints: [0x42] }
            ]
        };
        window.fontCompilation = {
            sendMessage: jest.fn().mockResolvedValue({
                outlinesJson: JSON.stringify([])
            })
        };

        require('../js/find-glyph-dialog');
    });

    afterEach(() => {
        delete window.currentFontModel;
        delete window.fontCompilation;
    });

    test('lists glyphs in font order with assigned Unicode values', () => {
        document.getElementById('find-glyph-btn').click();

        expect(document.getElementById('find-glyph-modal').style.display).toBe(
            'flex'
        );
        expect(
            Array.from(document.querySelectorAll('.find-glyph-name')).map(
                (element) => element.textContent
            )
        ).toEqual(['A', 'acutecomb', 'acute', 'B']);
        expect(document.querySelector('.find-glyph-unicode').textContent).toBe(
            'U+0041'
        );
    });

    test('filters using the overview search semantics', () => {
        document.getElementById('find-glyph-btn').click();
        const search = document.querySelector('.find-glyph-search-input');
        search.value = 'acute comb';
        search.dispatchEvent(new Event('input', { bubbles: true }));

        expect(
            Array.from(document.querySelectorAll('.find-glyph-name')).map(
                (element) => element.textContent
            )
        ).toEqual(['acutecomb']);
    });

    test('confirms one glyph when configured for single selection', () => {
        const onConfirm = jest.fn();
        window.findGlyphDialog.open({
            selectionMode: 'single',
            onConfirm
        });
        const rows = document.querySelectorAll('.find-glyph-row');
        rows[0].click();
        rows[3].click();
        document.querySelector('.find-glyph-actions button:last-child').click();

        expect(onConfirm).toHaveBeenCalledWith(['B']);
    });

    test('uses configured labels and reveals a preselected glyph', () => {
        window.currentFontModel.glyphs = Array.from(
            { length: 40 },
            (_, index) => ({ name: `glyph${index}` })
        );
        const modal = document.getElementById('find-glyph-modal');
        const list = document.querySelector('.find-glyph-list');
        let scrollTop = 0;
        Object.defineProperty(list, 'scrollTop', {
            configurable: true,
            get: () => scrollTop,
            set: (value) => {
                scrollTop = modal.style.display === 'flex' ? value : 0;
            }
        });

        window.findGlyphDialog.open({
            selectionMode: 'single',
            selectedGlyphNames: ['glyph32'],
            title: 'Replace Component',
            cancelLabel: 'Keep Current',
            confirmLabel: 'Replace'
        });

        expect(
            document.getElementById('find-glyph-modal-title').textContent
        ).toBe('Replace Component');
        expect(
            document.querySelector('.find-glyph-actions button:first-child')
                .textContent
        ).toBe('Keep Current');
        expect(
            document.querySelector('.find-glyph-actions button:last-child')
                .textContent
        ).toBe('Replace');
        expect(
            document
                .querySelector('[data-glyph-name="glyph32"]')
                .getAttribute('aria-selected')
        ).toBe('true');
        expect(
            document.querySelector('.find-glyph-list').scrollTop
        ).toBeGreaterThan(0);
    });

    test('confirms several glyphs in font order for multiple selection', () => {
        const onConfirm = jest.fn();
        window.findGlyphDialog.open({
            selectionMode: 'multiple',
            onConfirm
        });
        const rows = document.querySelectorAll('.find-glyph-row');
        rows[3].click();
        rows[0].click();
        document.querySelector('.find-glyph-actions button:last-child').click();

        expect(onConfirm).toHaveBeenCalledWith(['A', 'B']);
    });

    test('double-click confirms the glyph with the default action', () => {
        const onConfirm = jest.fn();
        window.findGlyphDialog.open({
            selectionMode: 'multiple',
            onConfirm
        });
        const rows = document.querySelectorAll('.find-glyph-row');
        rows[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

        expect(onConfirm).toHaveBeenCalledWith(['acutecomb']);
        expect(document.getElementById('find-glyph-modal').style.display).toBe(
            'none'
        );
    });

    test('cancels on Escape before lower-priority keyboard handlers', () => {
        const lowerPriorityHandler = jest.fn();
        document.addEventListener('keydown', lowerPriorityHandler);
        window.findGlyphDialog.open();

        const escape = new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true
        });
        document.dispatchEvent(escape);
        document.removeEventListener('keydown', lowerPriorityHandler);

        expect(escape.defaultPrevented).toBe(true);
        expect(lowerPriorityHandler).not.toHaveBeenCalled();
        expect(document.getElementById('find-glyph-modal').style.display).toBe(
            'none'
        );
    });

    test('uses the Agent Sign In button style for dialog actions', () => {
        document.getElementById('find-glyph-btn').click();

        expect(
            Array.from(
                document.querySelectorAll('.find-glyph-actions button')
            ).every((button) => button.classList.contains('ai-login-button'))
        ).toBe(true);
    });

    test('mounts only the visible window of a long glyph list', () => {
        window.currentFontModel.glyphs = Array.from(
            { length: 40 },
            (_, index) => ({
                name: `glyph${index}`
            })
        );
        document.getElementById('find-glyph-btn').click();

        expect(
            document.querySelectorAll('.find-glyph-row').length
        ).toBeLessThan(40);
    });
});
