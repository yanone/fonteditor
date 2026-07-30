/**
 * @jest-environment jsdom
 */

const { parseSvg } = require('../js/clipboard/svg');
const {
    parseCounterpunchJson,
    glyphsClosedPathToStartFirst
} = require('../js/clipboard/json');
const {
    parseClipboardPayloads,
    applyPasteFragment,
    applyPasteGlyphsDocument
} = require('../js/clipboard');

describe('clipboard SVG converter', () => {
    test('parses SVG compound path into separate closed contours and flips Y', () => {
        const payload = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 470 508">
  <path d="M235,480c-119,0-205-91-205-226S116,28,235,28s205,91,205,226-86,226-205,226ZM235,508c137,0,235-103,235-254S372,0,235,0,0,103,0,254s98,254,235,254Z"/>
</svg>`;
        const fragment = parseSvg(payload);
        expect(fragment.format).toBe('svg');
        expect(fragment.paths.length).toBe(2);
        expect(fragment.paths[0].closed).toBe(true);
        expect(fragment.paths[1].closed).toBe(true);
        expect(fragment.keepAbsoluteCoords).toBe(false);

        // Closed contours must not keep a duplicate end oncurve on the start.
        for (const path of fragment.paths) {
            const onCurves = path.nodes.filter(
                (node) => node.nodetype !== 'OffCurve'
            );
            expect(onCurves.length).toBeGreaterThan(1);
            const first = onCurves[0];
            const last = onCurves[onCurves.length - 1];
            expect(first.x === last.x && first.y === last.y).toBe(false);
            // Leading oncurve after trailing offcurves should be Curve, not Line.
            expect(path.nodes[0].nodetype).toBe('Curve');
        }

        const allY = fragment.paths.flatMap((path) =>
            path.nodes.map((node) => node.y)
        );
        expect(Math.min(...allY)).toBeCloseTo(0, 5);
        expect(Math.max(...allY)).toBeCloseTo(508, 5);
    });

    test('leaves paths open when SVG has no Z closepath', () => {
        const payload = `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L10 0L10 10"/></svg>`;
        const fragment = parseSvg(payload);
        expect(fragment.paths).toHaveLength(1);
        expect(fragment.paths[0].closed).toBe(false);
    });

    test('detects SVG from text/plain payloads', () => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L10 0L10 10Z"/></svg>`;
        const parsed = parseClipboardPayloads([
            { type: 'text/plain', data: svg }
        ]);
        expect(parsed.kind).toBe('selection');
        expect(parsed.fragment.format).toBe('svg');
        expect(parsed.fragment.paths[0].closed).toBe(true);
    });
});

describe('clipboard Counterpunch JSON converter', () => {
    const selectionPayload = {
        format: 'counterpunch-clipboard',
        version: 1,
        kind: 'selection',
        nodeOrder: 'start-first',
        keepAbsoluteCoords: true,
        paths: [
            {
                closed: true,
                nodes: [
                    { x: 10, y: 20, nodetype: 'Line' },
                    { x: 110, y: 20, nodetype: 'Line' },
                    { x: 110, y: 120, nodetype: 'Curve', smooth: true },
                    { x: 60, y: 140, nodetype: 'OffCurve' },
                    { x: 10, y: 120, nodetype: 'OffCurve' }
                ]
            }
        ],
        components: [
            {
                reference: 'a',
                x: 5,
                y: 6,
                alignment: 1,
                transform: [0.5, 0.1, -0.2, 0.8, 5, 6]
            }
        ],
        anchors: [{ name: 'top', x: 50, y: 200 }],
        guides: [{ name: 'g1', x: 0, y: 100, angle: 0, global: false }]
    };

    test('parses selection JSON', () => {
        const parsed = parseCounterpunchJson(JSON.stringify(selectionPayload));
        expect(parsed.kind).toBe('selection');
        expect(parsed.fragment.format).toBe('counterpunch-json');
        expect(parsed.fragment.keepAbsoluteCoords).toBe(true);
        expect(parsed.fragment.paths).toHaveLength(1);
        expect(parsed.fragment.paths[0].nodes).toHaveLength(5);
        expect(parsed.fragment.components[0].reference).toBe('a');
        expect(parsed.fragment.components[0].transform).toEqual([
            0.5, 0.1, -0.2, 0.8, 5, 6
        ]);
        expect(parsed.fragment.anchors[0].name).toBe('top');
        expect(parsed.fragment.guides[0].y).toBe(100);
    });

    test('rotates Glyphs closed-path start node to index 0', () => {
        // Original Glyphs pasteboard order for outer /o (start = last oncurve).
        const glyphsOrder = [
            { x: 422, y: -8, nodetype: 'OffCurve' },
            { x: 520, y: 95, nodetype: 'OffCurve' },
            { x: 520, y: 246, nodetype: 'Curve', smooth: true },
            { x: 520, y: 397, nodetype: 'OffCurve' },
            { x: 422, y: 500, nodetype: 'OffCurve' },
            { x: 285, y: 500, nodetype: 'Curve', smooth: true },
            { x: 148, y: 500, nodetype: 'OffCurve' },
            { x: 50, y: 397, nodetype: 'OffCurve' },
            { x: 50, y: 246, nodetype: 'Curve', smooth: true },
            { x: 50, y: 95, nodetype: 'OffCurve' },
            { x: 148, y: -8, nodetype: 'OffCurve' },
            { x: 285, y: -8, nodetype: 'Curve', smooth: true }
        ];

        expect(glyphsClosedPathToStartFirst(glyphsOrder)[0]).toMatchObject({
            x: 285,
            y: -8,
            nodetype: 'Curve'
        });

        const parsed = parseCounterpunchJson(
            JSON.stringify({
                format: 'counterpunch-clipboard',
                version: 1,
                kind: 'selection',
                keepAbsoluteCoords: true,
                paths: [{ closed: true, nodes: glyphsOrder }]
            })
        );
        expect(parsed.kind).toBe('selection');
        expect(parsed.fragment.paths[0].nodes[0]).toMatchObject({
            x: 285,
            y: -8,
            nodetype: 'Curve'
        });
        expect(parsed.fragment.paths[0].nodes[1]).toMatchObject({
            x: 422,
            y: -8,
            nodetype: 'OffCurve'
        });
    });

    test('prefers Counterpunch JSON over SVG on text/plain', () => {
        const parsed = parseClipboardPayloads([
            {
                type: 'text/plain',
                data: JSON.stringify(selectionPayload)
            },
            {
                type: 'image/svg+xml',
                data: `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L10 0L10 10Z"/></svg>`
            }
        ]);
        expect(parsed.kind).toBe('selection');
        expect(parsed.fragment.format).toBe('counterpunch-json');
        expect(parsed.fragment.paths[0].nodes[0].x).toBe(10);
    });

    test('recovers Counterpunch JSON embedded in SVG metadata', () => {
        const { serializePathsToSvg } = require('../js/clipboard/svg');
        const json = JSON.stringify(selectionPayload);
        const svg = serializePathsToSvg(selectionPayload.paths, {
            embeddedJson: json
        });
        expect(svg).toContain('counterpunch-clipboard');
        const parsed = parseClipboardPayloads([
            { type: 'text/plain', data: svg }
        ]);
        expect(parsed.kind).toBe('selection');
        expect(parsed.fragment.format).toBe('counterpunch-json');
        expect(parsed.fragment.paths[0].nodes[0].x).toBe(10);
    });

    test('parses whole-glyph JSON', () => {
        const payload = {
            format: 'counterpunch-clipboard',
            version: 2,
            kind: 'glyphs',
            nodeOrder: 'start-first',
            masters: [
                { id: 'm0', name: 'Regular' },
                { id: 'm1', name: 'Bold' }
            ],
            glyphs: [
                {
                    name: 'o',
                    leftMetricsKey: '=o',
                    rightMetricsKey: null,
                    layers: [
                        {
                            name: 'Regular',
                            master: {
                                type: 'DefaultForMaster',
                                masterIndex: 0
                            },
                            width: 500,
                            paths: [
                                {
                                    closed: true,
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Line' },
                                        { x: 100, y: 0, nodetype: 'Line' }
                                    ]
                                }
                            ],
                            components: [],
                            anchors: [],
                            guides: []
                        },
                        {
                            name: 'Bold',
                            master: {
                                type: 'DefaultForMaster',
                                masterIndex: 1
                            },
                            width: 560,
                            paths: [
                                {
                                    closed: true,
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Line' },
                                        { x: 120, y: 0, nodetype: 'Line' }
                                    ]
                                }
                            ],
                            components: [],
                            anchors: [{ name: 'top', x: 60, y: 700 }],
                            guides: []
                        }
                    ]
                }
            ]
        };
        const parsed = parseCounterpunchJson(JSON.stringify(payload));
        expect(parsed.kind).toBe('glyphs');
        expect(parsed.document.masters).toHaveLength(2);
        expect(parsed.document.glyphs[0].layers).toHaveLength(2);
        expect(parsed.document.glyphs[0].layers[1].width).toBe(560);
        expect(parsed.document.glyphs[0].layers[0].master).toEqual({
            type: 'DefaultForMaster',
            masterIndex: 0
        });
        expect(
            parsed.document.glyphs[0].layers[0].paths[0].nodes[0]
        ).toMatchObject({ x: 0, y: 0 });
    });

    test('rejects whole-glyph JSON without masters metadata', () => {
        const payload = {
            format: 'counterpunch-clipboard',
            version: 1,
            kind: 'glyphs',
            glyphs: [
                {
                    name: 'o',
                    layers: [
                        {
                            paths: [],
                            components: [],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ]
        };
        expect(parseCounterpunchJson(JSON.stringify(payload))).toBeNull();
    });
});

describe('applyPasteFragment', () => {
    function makeLayer({ linked = true, background = false } = {}) {
        const anchors = [];
        const guides = [];
        const shapes = [];
        const layer = {
            is_background: background,
            linked,
            width: 600,
            anchors,
            guides,
            shapes,
            paths: [],
            addPath(closed) {
                const path = {
                    closed,
                    nodes: [],
                    set nodes(value) {
                        this._nodes = value;
                    },
                    get nodes() {
                        return this._nodes || [];
                    }
                };
                shapes.push({
                    isPath: () => true,
                    asPath: () => path
                });
                this.paths.push(path);
                return path;
            },
            addComponent(reference, transform) {
                const component = {
                    reference,
                    transform: transform || [1, 0, 0, 1, 0, 0],
                    automaticAlignment: false,
                    anchor: undefined
                };
                shapes.push({
                    isPath: () => false,
                    isComponent: () => true,
                    asComponent: () => component
                });
                this.components = this.components || [];
                this.components.push(component);
                return component;
            },
            addAnchor(x, y, name) {
                const anchor = { name, x, y };
                anchors.push(anchor);
                return anchor;
            },
            addGuide(pos, name) {
                const guide = { pos, name };
                guides.push(guide);
                return guide;
            },
            _getLinkedLayers() {
                return linked ? this._linked || [] : [];
            }
        };
        return layer;
    }

    test('fans out paths to linked layers', () => {
        const active = makeLayer({ linked: true });
        const linked = makeLayer({ linked: true });
        active._linked = [linked];

        applyPasteFragment(
            {
                format: 'svg',
                keepAbsoluteCoords: true,
                paths: [
                    {
                        closed: true,
                        nodes: [
                            { x: 0, y: 0, nodetype: 'Line' },
                            { x: 100, y: 0, nodetype: 'Line' }
                        ]
                    }
                ],
                components: [],
                anchors: [],
                guides: []
            },
            {
                activeLayer: active,
                linkedLayers: [linked],
                master: null,
                layerWidth: 600,
                verticalMetrics: { Ascender: 800, Descender: -200 },
                glyphExists: () => true
            }
        );

        expect(active.paths).toHaveLength(1);
        expect(linked.paths).toHaveLength(1);
        expect(active.paths[0].closed).toBe(true);
    });

    test('centers SVG paste in the layer', () => {
        const active = makeLayer({ linked: false });
        applyPasteFragment(
            {
                format: 'svg',
                keepAbsoluteCoords: false,
                paths: [
                    {
                        closed: true,
                        nodes: [
                            { x: 0, y: 0, nodetype: 'Line' },
                            { x: 100, y: 0, nodetype: 'Line' },
                            { x: 100, y: 100, nodetype: 'Line' },
                            { x: 0, y: 100, nodetype: 'Line' }
                        ]
                    }
                ],
                components: [],
                anchors: [],
                guides: []
            },
            {
                activeLayer: active,
                linkedLayers: [],
                master: null,
                layerWidth: 600,
                verticalMetrics: { Ascender: 800, Descender: -200 },
                glyphExists: () => true
            }
        );

        const xs = active.paths[0].nodes.map((node) => node.x);
        const ys = active.paths[0].nodes.map((node) => node.y);
        const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
        const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
        expect(midX).toBeCloseTo(300, 5);
        expect(midY).toBeCloseTo(300, 5);
    });

    test('keeps absolute coords for Counterpunch JSON selection', () => {
        const active = makeLayer({ linked: false });
        applyPasteFragment(
            {
                format: 'counterpunch-json',
                keepAbsoluteCoords: true,
                paths: [
                    {
                        closed: true,
                        nodes: [
                            { x: 10, y: 20, nodetype: 'Line' },
                            { x: 110, y: 20, nodetype: 'Line' }
                        ]
                    }
                ],
                components: [],
                anchors: [{ name: 'top', x: 50, y: 200 }],
                guides: []
            },
            {
                activeLayer: active,
                linkedLayers: [],
                master: null,
                layerWidth: 600,
                verticalMetrics: { Ascender: 800, Descender: -200 },
                glyphExists: () => true
            }
        );

        expect(active.paths[0].nodes[0]).toMatchObject({ x: 10, y: 20 });
        expect(active.anchors[0]).toMatchObject({
            name: 'top',
            x: 50,
            y: 200
        });
    });

    test('updates existing anchor on active layer only', () => {
        const active = makeLayer({ linked: true });
        const linked = makeLayer({ linked: true });
        active.addAnchor(1, 2, 'top');
        linked.addAnchor(3, 4, 'top');

        applyPasteFragment(
            {
                format: 'counterpunch-json',
                keepAbsoluteCoords: true,
                paths: [],
                components: [],
                anchors: [{ name: 'top', x: 99, y: 88 }],
                guides: []
            },
            {
                activeLayer: active,
                linkedLayers: [linked],
                master: null,
                layerWidth: 600,
                verticalMetrics: null,
                glyphExists: () => true
            }
        );

        expect(active.anchors[0]).toMatchObject({ x: 99, y: 88 });
        expect(linked.anchors[0]).toMatchObject({ x: 3, y: 4 });
    });

    test('preserves component affine transform on paste', () => {
        const active = makeLayer({ linked: false });
        applyPasteFragment(
            {
                format: 'counterpunch-json',
                keepAbsoluteCoords: true,
                paths: [],
                components: [
                    {
                        reference: 'dieresiscomb',
                        x: 100,
                        y: 200,
                        alignment: 0,
                        transform: [0.5, 0.1, -0.2, 0.75, 100, 200],
                        anchor: 'top'
                    }
                ],
                anchors: [],
                guides: []
            },
            {
                activeLayer: active,
                linkedLayers: [],
                master: null,
                layerWidth: 600,
                verticalMetrics: null,
                glyphExists: () => true
            }
        );

        expect(active.components).toHaveLength(1);
        expect(active.components[0].transform).toEqual([
            0.5, 0.1, -0.2, 0.75, 100, 200
        ]);
        expect(active.components[0].automaticAlignment).toBe(false);
        expect(active.components[0].anchor).toBe('top');
    });
});

describe('clipboard Counterpunch JSON serializer', () => {
    const {
        buildSelectionClipboardDocument,
        buildGlyphsClipboardDocument,
        serializeComponentForClipboard,
        serializePathForClipboard,
        stringifyClipboardDocument
    } = require('../js/clipboard/serialize');

    test('serializes selection with start-first node order', () => {
        const document = buildSelectionClipboardDocument({
            glyphName: 'o',
            layerId: 'layer-1',
            paths: [
                serializePathForClipboard({
                    closed: true,
                    nodes: [
                        { x: 285, y: -8, nodetype: 'Curve', smooth: true },
                        { x: 422, y: -8, nodetype: 'OffCurve' }
                    ]
                })
            ],
            components: [
                serializeComponentForClipboard({
                    reference: 'dieresiscomb',
                    transform: { translation: [10, 20], scale: [0.5, 0.5] },
                    automaticAlignment: false
                })
            ],
            anchors: [{ name: 'top', x: 1, y: 2 }],
            guides: []
        });

        expect(document.nodeOrder).toBe('start-first');
        expect(document.kind).toBe('selection');
        expect(document.paths[0].nodes[0]).toMatchObject({
            x: 285,
            y: -8,
            nodetype: 'Curve'
        });
        expect(document.components[0].transform[4]).toBeCloseTo(10, 5);
        expect(document.components[0].transform[5]).toBeCloseTo(20, 5);
        expect(document.components[0].transform[0]).toBeCloseTo(0.5, 5);

        const roundTrip = parseCounterpunchJson(
            stringifyClipboardDocument(document)
        );
        expect(roundTrip.kind).toBe('selection');
        expect(roundTrip.fragment.paths[0].nodes[0].x).toBe(285);
    });

    test('serializes whole-glyph documents', () => {
        const document = buildGlyphsClipboardDocument(
            [
                {
                    name: 'a',
                    layers: [
                        {
                            master: {
                                type: 'DefaultForMaster',
                                masterIndex: 0
                            },
                            width: 500,
                            paths: [],
                            components: [],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            [{ id: 'm0', name: 'Regular' }]
        );
        expect(document.kind).toBe('glyphs');
        expect(document.version).toBe(2);
        expect(document.nodeOrder).toBe('start-first');
        expect(document.masters).toEqual([{ id: 'm0', name: 'Regular' }]);
        expect(document.glyphs[0].name).toBe('a');
    });
});

describe('clipboard write helpers', () => {
    const {
        writeClipboardDocumentAsync,
        writeClipboardDocumentToDataTransfer
    } = require('../js/clipboard');

    test('sync DataTransfer write puts JSON on text/plain', () => {
        const stored = {};
        const clipboardData = {
            setData(type, data) {
                stored[type] = data;
            }
        };
        const document = {
            format: 'counterpunch-clipboard',
            version: 1,
            kind: 'selection',
            nodeOrder: 'start-first',
            keepAbsoluteCoords: true,
            paths: [
                {
                    closed: true,
                    nodes: [
                        { x: 0, y: 0, nodetype: 'Line' },
                        { x: 10, y: 0, nodetype: 'Line' },
                        { x: 10, y: 10, nodetype: 'Line' }
                    ]
                }
            ],
            components: [],
            anchors: [],
            guides: []
        };
        writeClipboardDocumentToDataTransfer(
            clipboardData,
            document,
            document.paths
        );
        expect(stored['text/plain']).toContain(
            '"format": "counterpunch-clipboard"'
        );
        expect(stored['image/svg+xml']).toContain('<svg');
    });

    test('async write publishes image/svg+xml ClipboardItem', async () => {
        const writes = [];
        const OriginalClipboardItem = global.ClipboardItem;
        global.ClipboardItem = class {
            constructor(items) {
                this.items = items;
            }
            static supports() {
                return true;
            }
        };
        Object.defineProperty(global.navigator, 'clipboard', {
            configurable: true,
            value: {
                write: async (items) => {
                    writes.push(items);
                }
            }
        });

        const document = {
            format: 'counterpunch-clipboard',
            version: 1,
            kind: 'selection',
            nodeOrder: 'start-first',
            keepAbsoluteCoords: true,
            paths: [
                {
                    closed: true,
                    nodes: [
                        { x: 0, y: 0, nodetype: 'Line' },
                        { x: 10, y: 0, nodetype: 'Line' },
                        { x: 10, y: 10, nodetype: 'Line' }
                    ]
                }
            ],
            components: [],
            anchors: [],
            guides: []
        };

        const ok = await writeClipboardDocumentAsync(document, document.paths);
        expect(ok).toBe(true);
        expect(writes).toHaveLength(1);
        expect(writes[0][0].items['image/svg+xml']).toBeInstanceOf(Blob);
        expect(writes[0][0].items['text/plain']).toBeInstanceOf(Blob);

        global.ClipboardItem = OriginalClipboardItem;
    });
});

describe('clipboard SVG serializer', () => {
    const {
        serializePathsToSvg,
        parseSvg,
        extractCounterpunchJsonFromSvg
    } = require('../js/clipboard/svg');

    test('round-trips a closed cubic path through SVG export', () => {
        const paths = [
            {
                closed: true,
                nodes: [
                    { x: 0, y: 0, nodetype: 'Line' },
                    { x: 100, y: 0, nodetype: 'Line' },
                    { x: 100, y: 100, nodetype: 'Line' },
                    { x: 0, y: 100, nodetype: 'Line' }
                ]
            }
        ];
        const svg = serializePathsToSvg(paths);
        expect(svg).toContain('<svg');
        expect(svg).toContain('width="100"');
        expect(svg).toContain('height="100"');
        expect(svg).toContain('viewBox="0 0 100 100"');
        expect(svg).not.toContain('<rect');
        expect(svg).toContain('<path d="');
        expect(svg).toContain('Z');

        const parsed = parseSvg(svg);
        expect(parsed.paths).toHaveLength(1);
        expect(parsed.paths[0].closed).toBe(true);
        // Y flip on export + ingest returns equivalent bounds height.
        const ys = parsed.paths[0].nodes.map((node) => node.y);
        expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(100, 5);
    });

    test('exports nested o contours as one compound path', () => {
        const paths = [
            {
                closed: true,
                nodes: [
                    { x: 285, y: -8, nodetype: 'Curve', smooth: true },
                    { x: 422, y: -8, nodetype: 'OffCurve' },
                    { x: 520, y: 95, nodetype: 'OffCurve' },
                    { x: 520, y: 246, nodetype: 'Curve', smooth: true },
                    { x: 520, y: 397, nodetype: 'OffCurve' },
                    { x: 422, y: 500, nodetype: 'OffCurve' },
                    { x: 285, y: 500, nodetype: 'Curve', smooth: true },
                    { x: 148, y: 500, nodetype: 'OffCurve' },
                    { x: 50, y: 397, nodetype: 'OffCurve' },
                    { x: 50, y: 246, nodetype: 'Curve', smooth: true },
                    { x: 50, y: 95, nodetype: 'OffCurve' },
                    { x: 148, y: -8, nodetype: 'OffCurve' }
                ]
            },
            {
                closed: true,
                nodes: [
                    { x: 285, y: 20, nodetype: 'Curve', smooth: true },
                    { x: 404, y: 20, nodetype: 'OffCurve' },
                    { x: 490, y: 111, nodetype: 'OffCurve' },
                    { x: 490, y: 246, nodetype: 'Curve', smooth: true },
                    { x: 490, y: 381, nodetype: 'OffCurve' },
                    { x: 404, y: 472, nodetype: 'OffCurve' },
                    { x: 285, y: 472, nodetype: 'Curve', smooth: true },
                    { x: 166, y: 472, nodetype: 'OffCurve' },
                    { x: 80, y: 381, nodetype: 'OffCurve' },
                    { x: 80, y: 246, nodetype: 'Curve', smooth: true },
                    { x: 80, y: 111, nodetype: 'OffCurve' },
                    { x: 166, y: 20, nodetype: 'OffCurve' }
                ]
            }
        ];
        const svg = serializePathsToSvg(paths);
        expect(svg).toContain('width="470"');
        expect(svg).toContain('height="508"');
        expect(svg).toContain('viewBox="0 0 470 508"');
        expect(svg).not.toContain('<rect');
        const pathTags = svg.match(/<path\b/g) || [];
        expect(pathTags).toHaveLength(1);
        // Outer then inner subpaths in one d attribute.
        expect((svg.match(/M/g) || []).length).toBe(2);
        expect(svg).toContain('Z');
        // Round-trip still splits compound SVG into separate contours.
        expect(parseSvg(svg).paths).toHaveLength(2);
    });

    test('keeps non-nested shapes as separate path elements', () => {
        const paths = [
            {
                closed: true,
                nodes: [
                    { x: 0, y: 0, nodetype: 'Line' },
                    { x: 10, y: 0, nodetype: 'Line' },
                    { x: 10, y: 10, nodetype: 'Line' },
                    { x: 0, y: 10, nodetype: 'Line' }
                ]
            },
            {
                closed: true,
                nodes: [
                    { x: 100, y: 0, nodetype: 'Line' },
                    { x: 110, y: 0, nodetype: 'Line' },
                    { x: 110, y: 10, nodetype: 'Line' },
                    { x: 100, y: 10, nodetype: 'Line' }
                ]
            }
        ];
        const svg = serializePathsToSvg(paths);
        expect((svg.match(/<path\b/g) || []).length).toBe(2);
    });

    test('embeds and extracts Counterpunch JSON in SVG metadata', () => {
        const paths = [
            {
                closed: true,
                nodes: [
                    { x: 0, y: 0, nodetype: 'Line' },
                    { x: 10, y: 0, nodetype: 'Line' },
                    { x: 10, y: 10, nodetype: 'Line' }
                ]
            }
        ];
        const json = JSON.stringify({
            format: 'counterpunch-clipboard',
            kind: 'selection'
        });
        const svg = serializePathsToSvg(paths, { embeddedJson: json });
        expect(extractCounterpunchJsonFromSvg(svg)).toBe(json);
        expect(parseSvg(svg).paths).toHaveLength(1);
    });
});

describe('applyPasteGlyphsDocument', () => {
    function makeLayer(masterId) {
        const anchors = [];
        const guides = [];
        const shapes = [];
        return {
            is_background: false,
            width: 400,
            leftMetricsKey: null,
            rightMetricsKey: null,
            master: masterId
                ? { type: 'DefaultForMaster', master: masterId }
                : undefined,
            location: undefined,
            format_specific: undefined,
            anchors,
            guides,
            shapes,
            paths: [],
            getMaster() {
                return null;
            },
            addPath(closed) {
                const path = {
                    closed,
                    nodes: [],
                    set nodes(value) {
                        this._nodes = value;
                    },
                    get nodes() {
                        return this._nodes || [];
                    }
                };
                shapes.push({
                    isPath: () => true,
                    asPath: () => path
                });
                this.paths.push(path);
                return path;
            },
            addComponent(reference, transform) {
                const component = {
                    reference,
                    transform: transform || [1, 0, 0, 1, 0, 0],
                    automaticAlignment: false,
                    anchor: undefined
                };
                shapes.push({
                    isPath: () => false,
                    isComponent: () => true,
                    asComponent: () => component
                });
                this.components = this.components || [];
                this.components.push(component);
                return component;
            },
            addAnchor(x, y, name) {
                const anchor = { name, x, y };
                anchors.push(anchor);
                return anchor;
            },
            addGuide(pos, name) {
                const guide = { pos, name };
                guides.push(guide);
                return guide;
            }
        };
    }

    function makeFont(masterCount, existingNames = [], axisKeys = []) {
        const glyphOrder = [...existingNames];
        const glyphStore = new Map();
        for (const name of existingNames) {
            glyphStore.set(name, { name, layers: [] });
        }
        const masters = Array.from({ length: masterCount }, (_, index) => ({
            id: `master-${index}`
        }));
        const axes = axisKeys.map((key) =>
            key.length === 4 ? { id: key, tag: key } : { id: key, tag: 'wght' }
        );
        return {
            masters,
            axes,
            glyphOrder,
            findGlyph(name) {
                return glyphStore.get(name);
            },
            allocateUniqueGlyphName(baseName) {
                if (!glyphStore.has(baseName)) {
                    return baseName;
                }
                let index = 1;
                while (index < 10000) {
                    const candidate = `${baseName}.${String(index).padStart(3, '0')}`;
                    if (!glyphStore.has(candidate)) {
                        return candidate;
                    }
                    index += 1;
                }
                throw new Error(
                    `Could not allocate a unique name for "${baseName}"`
                );
            },
            findInsertIndexAfterName(baseName) {
                const escaped = String(baseName).replace(
                    /[.*+?^${}()|[\]\\]/g,
                    '\\$&'
                );
                const numbered = new RegExp(`^${escaped}\\.\\d{3,}$`);
                let lastIndex = -1;
                for (let index = 0; index < glyphOrder.length; index++) {
                    const glyphName = glyphOrder[index];
                    if (glyphName === baseName || numbered.test(glyphName)) {
                        lastIndex = index;
                    }
                }
                return lastIndex >= 0 ? lastIndex + 1 : glyphOrder.length;
            },
            addGlyph(name, _category = 'Base', options = {}) {
                const layers = masters.map((master) => makeLayer(master.id));
                const glyph = {
                    name,
                    leftMetricsKey: null,
                    rightMetricsKey: null,
                    layers,
                    addLayer(width, master) {
                        const layer = makeLayer();
                        layer.width = width;
                        layer.master = master;
                        layers.push(layer);
                        return layer;
                    }
                };
                const insertIndex =
                    typeof options.insertIndex === 'number'
                        ? options.insertIndex
                        : glyphOrder.length;
                glyphOrder.splice(insertIndex, 0, name);
                glyphStore.set(name, glyph);
                return glyph;
            }
        };
    }

    function mastersMeta(count) {
        return Array.from({ length: count }, (_, index) => ({
            id: `source-master-${index}`,
            name: `Master ${index}`
        }));
    }

    test('creates new glyphs matched by masterIndex', () => {
        const font = makeFont(2);

        const result = applyPasteGlyphsDocument(
            {
                format: 'counterpunch-json',
                kind: 'glyphs',
                version: 2,
                masters: mastersMeta(2),
                glyphs: [
                    {
                        name: 'o',
                        leftMetricsKey: '=H',
                        layers: [
                            {
                                master: {
                                    type: 'DefaultForMaster',
                                    masterIndex: 0
                                },
                                width: 500,
                                paths: [
                                    {
                                        closed: true,
                                        nodes: [
                                            { x: 0, y: 0, nodetype: 'Line' },
                                            { x: 10, y: 0, nodetype: 'Line' }
                                        ]
                                    }
                                ],
                                components: [],
                                anchors: [],
                                guides: []
                            },
                            {
                                master: {
                                    type: 'DefaultForMaster',
                                    masterIndex: 1
                                },
                                width: 560,
                                paths: [
                                    {
                                        closed: true,
                                        nodes: [
                                            { x: 0, y: 0, nodetype: 'Line' },
                                            { x: 20, y: 0, nodetype: 'Line' }
                                        ]
                                    }
                                ],
                                components: [],
                                anchors: [{ name: 'top', x: 30, y: 700 }],
                                guides: []
                            }
                        ]
                    }
                ]
            },
            {
                font,
                glyphExists: () => true
            }
        );

        expect(result.error).toBeUndefined();
        expect(result.createdGlyphNames).toEqual(['o']);
        const glyph = font.findGlyph('o');
        expect(glyph.leftMetricsKey).toBe('=H');
        expect(glyph.layers[0].width).toBe(500);
        expect(glyph.layers[1].width).toBe(560);
        expect(glyph.layers[0].paths).toHaveLength(1);
        expect(glyph.layers[1].paths).toHaveLength(1);
        expect(glyph.layers[1].anchors[0]).toMatchObject({
            name: 'top',
            x: 30,
            y: 700
        });
    });

    test('inserts after existing namesake / .NNN siblings', () => {
        const font = makeFont(1, ['a', 'o', 'o.001', 'p']);
        const result = applyPasteGlyphsDocument(
            {
                format: 'counterpunch-json',
                kind: 'glyphs',
                version: 2,
                masters: mastersMeta(1),
                glyphs: [
                    {
                        name: 'o',
                        layers: [
                            {
                                master: {
                                    type: 'DefaultForMaster',
                                    masterIndex: 0
                                },
                                width: 500,
                                paths: [
                                    {
                                        closed: true,
                                        nodes: [
                                            { x: 0, y: 0, nodetype: 'Line' },
                                            { x: 10, y: 0, nodetype: 'Line' }
                                        ]
                                    }
                                ],
                                components: [],
                                anchors: [],
                                guides: []
                            }
                        ]
                    }
                ]
            },
            { font, glyphExists: () => true }
        );

        expect(result.error).toBeUndefined();
        expect(result.createdGlyphNames).toEqual(['o.002']);
        expect(font.glyphOrder).toEqual(['a', 'o', 'o.001', 'o.002', 'p']);
        expect(font.findGlyph('o.002').layers[0].paths).toHaveLength(1);
    });

    test('pastes layer copies as AssociatedWithMaster without location', () => {
        const font = makeFont(1);
        const result = applyPasteGlyphsDocument(
            {
                format: 'counterpunch-json',
                kind: 'glyphs',
                version: 2,
                masters: mastersMeta(1),
                glyphs: [
                    {
                        name: 'o',
                        layers: [
                            {
                                master: {
                                    type: 'DefaultForMaster',
                                    masterIndex: 0
                                },
                                width: 500,
                                paths: [],
                                components: [],
                                anchors: [],
                                guides: []
                            },
                            {
                                master: {
                                    type: 'AssociatedWithMaster',
                                    masterIndex: 0
                                },
                                width: 510,
                                paths: [
                                    {
                                        closed: true,
                                        nodes: [
                                            { x: 1, y: 1, nodetype: 'Line' },
                                            { x: 2, y: 2, nodetype: 'Line' }
                                        ]
                                    }
                                ],
                                components: [],
                                anchors: [],
                                guides: []
                            }
                        ]
                    }
                ]
            },
            { font, glyphExists: () => true }
        );

        expect(result.error).toBeUndefined();
        const glyph = font.findGlyph('o');
        expect(glyph.layers).toHaveLength(2);
        expect(glyph.layers[1].master).toEqual({
            type: 'AssociatedWithMaster',
            master: 'master-0'
        });
        expect(glyph.layers[1].location).toBeUndefined();
        expect(glyph.layers[1].paths).toHaveLength(1);
    });

    test('skips braces when axis keys are missing and warns', () => {
        const font = makeFont(1, [], ['wght']);
        const result = applyPasteGlyphsDocument(
            {
                format: 'counterpunch-json',
                kind: 'glyphs',
                version: 2,
                masters: mastersMeta(1),
                glyphs: [
                    {
                        name: 'o',
                        layers: [
                            {
                                master: {
                                    type: 'DefaultForMaster',
                                    masterIndex: 0
                                },
                                width: 500,
                                paths: [],
                                components: [],
                                anchors: [],
                                guides: []
                            },
                            {
                                master: {
                                    type: 'AssociatedWithMaster',
                                    masterIndex: 0
                                },
                                location: { missingAxis: 500 },
                                width: 500,
                                paths: [
                                    {
                                        closed: true,
                                        nodes: [
                                            { x: 0, y: 0, nodetype: 'Line' },
                                            { x: 1, y: 0, nodetype: 'Line' }
                                        ]
                                    }
                                ],
                                components: [],
                                anchors: [],
                                guides: []
                            }
                        ]
                    }
                ]
            },
            { font, glyphExists: () => true }
        );

        expect(result.error).toBeUndefined();
        expect(result.warnings[0]).toMatch(/Skipped 1 intermediate/);
        expect(font.findGlyph('o').layers).toHaveLength(1);
    });

    test('allocates .001 when the glyph name already exists', () => {
        const font = makeFont(1, ['a']);
        const result = applyPasteGlyphsDocument(
            {
                format: 'counterpunch-json',
                kind: 'glyphs',
                version: 2,
                masters: mastersMeta(1),
                glyphs: [
                    {
                        name: 'a',
                        layers: [
                            {
                                master: {
                                    type: 'DefaultForMaster',
                                    masterIndex: 0
                                },
                                width: 480,
                                paths: [],
                                components: [],
                                anchors: [],
                                guides: []
                            }
                        ]
                    }
                ]
            },
            {
                font,
                glyphExists: () => true
            }
        );

        expect(result.error).toBeUndefined();
        expect(result.createdGlyphNames).toEqual(['a.001']);
        expect(font.findGlyph('a.001').layers[0].width).toBe(480);
    });

    test('refuses paste when master counts differ', () => {
        const font = makeFont(1);
        const result = applyPasteGlyphsDocument(
            {
                format: 'counterpunch-json',
                kind: 'glyphs',
                version: 2,
                masters: mastersMeta(2),
                glyphs: [
                    {
                        name: 'o',
                        layers: [
                            {
                                master: {
                                    type: 'DefaultForMaster',
                                    masterIndex: 0
                                },
                                paths: [],
                                components: [],
                                anchors: [],
                                guides: []
                            }
                        ]
                    }
                ]
            },
            {
                font,
                glyphExists: () => true
            }
        );

        expect(result.error).toMatch(/Clipboard has 2 masters, font has 1/);
        expect(font.findGlyph('o')).toBeUndefined();
    });
});
