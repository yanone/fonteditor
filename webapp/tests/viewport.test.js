const { ViewportManager } = require('../js/glyph-canvas/viewport');

describe('ViewportManager keyboard glyph framing', () => {
    test('centers the newly selected glyph instead of retaining prior glyph bounds', () => {
        const viewport = new ViewportManager(1, 0, 0);
        const canvasRect = { width: 1000, height: 800 };
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
