const { ViewportManager } = require('../js/glyph-canvas/viewport');

describe('ViewportManager keyboard glyph framing', () => {
    test('centers the newly selected glyph instead of retaining prior glyph bounds', () => {
        const viewport = new ViewportManager(1, 0, 0);
        const canvasRect = { left: 0, top: 0, width: 1000, height: 800 };
        const render = jest.fn();
        viewport.animatePan = jest.fn((panX, panY) => {
            viewport.panX = panX;
            viewport.panY = panY;
        });

        viewport.panToGlyph(
            {
                minX: 0,
                maxX: 100,
                minY: -100,
                maxY: 100,
                width: 100,
                height: 200
            },
            { xPosition: 0, xOffset: 0, yOffset: 0 },
            canvasRect,
            render,
            50
        );
        viewport.panToGlyph(
            {
                minX: 0,
                maxX: 100,
                minY: 600,
                maxY: 800,
                width: 100,
                height: 200
            },
            { xPosition: 0, xOffset: 0, yOffset: 0 },
            canvasRect,
            render,
            50
        );

        expect(viewport.animatePan).toHaveBeenLastCalledWith(50, 1100, render);
    });
});

describe('ViewportManager zoom to fit', () => {
    test('zoomToFitText uses supplied vertical metrics instead of the UPM-1000 box', () => {
        const viewport = new ViewportManager(1, 0, 0);
        const render = jest.fn();
        viewport.animateZoomAndPan = jest.fn();

        viewport.zoomToFitText(
            [{ ax: 1000, dx: 0, dy: 0 }],
            { width: 1000, height: 800 },
            render,
            50,
            undefined,
            { minY: -400, maxY: 1600 }
        );

        expect(viewport.animateZoomAndPan).toHaveBeenCalledTimes(1);
        const [scale, panX, panY] = viewport.animateZoomAndPan.mock.calls[0];
        expect(scale).toBeCloseTo(0.35);
        expect(panX).toBeCloseTo(325);
        expect(panY).toBeCloseTo(610);
    });

    test('zoomToFitCursor centers a zero-width caret using vertical metrics', () => {
        const viewport = new ViewportManager(1, 0, 0);
        const render = jest.fn();
        viewport.animateZoomAndPan = jest.fn();

        viewport.zoomToFitCursor(
            0,
            { width: 1000, height: 800 },
            render,
            { minY: -200, maxY: 800 },
            50
        );

        expect(viewport.animateZoomAndPan).toHaveBeenCalledTimes(1);
        const [scale, panX, panY] = viewport.animateZoomAndPan.mock.calls[0];
        expect(scale).toBeCloseTo(0.7);
        expect(panX).toBeCloseTo(500);
        expect(panY).toBeCloseTo(610);
    });

    test('zoomToFitText clamps to Cmd+0 whole-run limits', () => {
        const viewport = new ViewportManager(1, 0, 0);
        const render = jest.fn();
        viewport.animateZoomAndPan = jest.fn();

        viewport.zoomToFitText(
            [{ ax: 1000, dx: 0, dy: 0 }],
            { left: 0, top: 0, width: 1000, height: 800 },
            render,
            50,
            undefined,
            { minY: -400, maxY: 1600 },
            { min: 0.025, max: 0.15 }
        );

        expect(viewport.animateZoomAndPan).toHaveBeenCalledTimes(1);
        const [scale] = viewport.animateZoomAndPan.mock.calls[0];
        expect(scale).toBeCloseTo(0.15);
    });
});

describe('applyFontPointScreenLock', () => {
    const { applyFontPointScreenLock } = require('../js/glyph-canvas/viewport');

    test('pans so the font point stays on the captured screen X', () => {
        const viewport = {
            panX: 10,
            panY: 20,
            fontToScreenCoordinates(fontX, fontY) {
                return { x: this.panX + fontX, y: this.panY - fontY };
            }
        };

        applyFontPointScreenLock(viewport, { x: 300, y: 20 }, 200, 0);
        expect(viewport.fontToScreenCoordinates(200, 0).x).toBe(300);
        expect(viewport.panY).toBe(20);
    });

    test('optionally locks Y as well', () => {
        const viewport = {
            panX: 0,
            panY: 0,
            fontToScreenCoordinates(fontX, fontY) {
                return { x: this.panX + fontX, y: this.panY - fontY };
            }
        };

        applyFontPointScreenLock(viewport, { x: 50, y: 80 }, 10, 20, {
            lockY: true
        });
        expect(viewport.fontToScreenCoordinates(10, 20)).toEqual({
            x: 50,
            y: 80
        });
    });
});
