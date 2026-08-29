import {
    collectOverviewPunchFillContours,
    fastGlyphTileRenderer
} from '../js/glyph-tile-renderer-fast';

function rect(x0, y0, x1, y1, extra = {}) {
    return {
        closed: true,
        nodes: [
            { x: x0, y: y0, nodetype: 'Line' },
            { x: x1, y: y0, nodetype: 'Line' },
            { x: x1, y: y1, nodetype: 'Line' },
            { x: x0, y: y1, nodetype: 'Line' }
        ],
        ...extra
    };
}

describe('overview tile punch-out', () => {
    test('collects subtraction cutters in shape order including components', () => {
        const contours = collectOverviewPunchFillContours(
            [
                rect(0, 0, 400, 700),
                {
                    ...rect(80, 80, 200, 200),
                    format_specific: { 'fip001-boolean': 'subtraction' }
                },
                {
                    reference: 'dot',
                    transform: [1, 0, 0, 1, 10, 0],
                    layerData: {
                        shapes: [rect(0, 0, 50, 50)]
                    }
                }
            ],
            [1, 0, 0, 1, 0, 0],
            'path',
            () => 'component'
        );

        expect(contours.map((contour) => contour.subtract)).toEqual([
            false,
            true,
            false
        ]);
        expect(contours[0].fillStyle).toBe('path');
        expect(contours[1].fillStyle).toBe('path');
        expect(contours[2].fillStyle).toBe('component');
        expect(contours[2].nodes[0].x).toBe(10);
    });

    test('renderToCanvas punches cutters with destination-out', () => {
        const canvas = fastGlyphTileRenderer.renderToCanvas(
            {
                name: 'A',
                width: 400,
                shapes: [
                    rect(0, 0, 400, 700),
                    {
                        ...rect(80, 80, 200, 200),
                        format_specific: { 'fip001-boolean': 'subtraction' }
                    }
                ]
            },
            { upm: 1000, ascender: 800, descender: -200 },
            64,
            80
        );
        const events = canvas.getContext('2d').__getEvents();
        expect(
            events.some(
                (event) =>
                    event.type === 'globalCompositeOperation' &&
                    event.props?.value === 'destination-out'
            )
        ).toBe(true);
    });
});
