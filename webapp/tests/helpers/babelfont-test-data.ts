type TestNodeType = 'Move' | 'Line' | 'OffCurve' | 'Curve' | 'QCurve';

export type TestNode = {
    x: number;
    y: number;
    nodetype: TestNodeType;
    smooth?: boolean;
};

/**
 * Build a canonical babelfont node for test fixtures.
 */
export function makeNode(
    x: number,
    y: number,
    nodetype: TestNodeType,
    options: { smooth?: boolean } = {}
): TestNode {
    return {
        x,
        y,
        nodetype,
        ...(options.smooth !== undefined ? { smooth: options.smooth } : {})
    };
}

/**
 * Build a straight-line node for test fixtures.
 */
export function lineNode(x: number, y: number): TestNode {
    return makeNode(x, y, 'Line');
}

/**
 * Build the four line nodes of a rectangular closed contour.
 */
export function rectLineNodes(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
    x4: number,
    y4: number
): TestNode[] {
    return [
        lineNode(x1, y1),
        lineNode(x2, y2),
        lineNode(x3, y3),
        lineNode(x4, y4)
    ];
}
