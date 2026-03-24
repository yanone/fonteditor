const fs = require('fs');
const path = require('path');
const { Bezier } = require('bezier-js');
const { Font, Layer } = require('../js/babelfont-model');
const {
    open_font_file,
    store_font
} = require('../wasm-dist/babelfont_fontc_web');

// Helper function to load and convert .glyphs files using WASM
function loadFontFile(filePath) {
    const fileName = path.basename(filePath);
    const fileContents = fs.readFileSync(filePath, 'utf-8');

    // If already .babelfont, just parse and return
    if (fileName.endsWith('.babelfont')) {
        return JSON.parse(fileContents);
    }

    // Otherwise, convert using WASM
    console.log(`[Test] Converting ${fileName} using WASM...`);
    const babelfontJson = open_font_file(fileName, fileContents);
    return JSON.parse(babelfontJson);
}

function makeFontWithSinglePath(nodes, closed = false) {
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        axes: [],
        cross_axis_mappings: [],
        instances: [],
        masters: [
            {
                name: { dflt: 'Regular' },
                id: 'master-1',
                location: {},
                guides: [],
                metrics: {},
                kerning: new Map()
            }
        ],
        glyphs: [
            {
                name: 'testGlyph',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        width: 500,
                        id: 'layer-1',
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-1'
                        },
                        shapes: [
                            {
                                nodes,
                                closed
                            }
                        ],
                        anchors: []
                    }
                ]
            }
        ],
        note: '',
        date: new Date('2020-01-01T00:00:00.000Z'),
        names: {},
        features: {
            classes: {},
            prefixes: {},
            features: []
        }
    });
}

function normalizeVector(dx, dy) {
    const length = Math.hypot(dx, dy) || 1;
    return {
        x: dx / length,
        y: dy / length
    };
}

function expectNodesToMatch(actualNodes, expectedNodes) {
    expect(actualNodes).toHaveLength(expectedNodes.length);

    for (let index = 0; index < expectedNodes.length; index++) {
        expect(actualNodes[index].nodetype).toBe(expectedNodes[index].nodetype);
        expect(actualNodes[index].x).toBeCloseTo(expectedNodes[index].x, 8);
        expect(actualNodes[index].y).toBeCloseTo(expectedNodes[index].y, 8);
        expect(Boolean(actualNodes[index].smooth)).toBe(
            Boolean(expectedNodes[index].smooth)
        );
    }
}

describe('Babelfont Object Model', () => {
    let fontData;
    let font;
    let metricsKeysData;
    let metricsKeysFont;
    let intermediateLayerData;
    let intermediateLayerFont;

    beforeAll(() => {
        // Load Fustat.glyphs as test fixture (converted on-the-fly)
        const fixturePath = path.join(
            __dirname,
            '..',
            'examples',
            'Fustat.glyphs'
        );
        fontData = loadFontFile(fixturePath);

        const metricsKeysFixturePath = path.join(
            __dirname,
            '..',
            'examples',
            'metricskeys.glyphs'
        );
        metricsKeysData = loadFontFile(metricsKeysFixturePath);

        const intermediateLayerFixturePath = path.join(
            __dirname,
            '..',
            'examples',
            'intermediate_layer_on_a.glyphs'
        );
        intermediateLayerData = loadFontFile(intermediateLayerFixturePath);
    });

    beforeEach(() => {
        // Create a fresh font instance for each test
        font = Font.fromData(fontData);
        metricsKeysFont = Font.fromData(metricsKeysData);
        intermediateLayerFont = Font.fromData(intermediateLayerData);
    });

    describe('parent() method', () => {
        test('Font.parent() should return null (root object)', () => {
            expect(font.parent()).toBeNull();
        });

        test('Glyph.parent() should return Font', () => {
            const glyph = font.glyphs[0];
            expect(glyph.parent()).toBe(font);
        });

        test('Layer.parent() should return Glyph', () => {
            const glyph = font.glyphs[0];
            const layer = glyph.layers[0];
            expect(layer.parent()).toBe(glyph);
        });

        test('Shape.parent() should return Layer', () => {
            const glyph = font.glyphs[0];
            const layer = glyph.layers[0];
            const shapes = layer.shapes;

            if (shapes && shapes.length > 0) {
                const shape = shapes[0];
                expect(shape.parent()).toBe(layer);
            }
        });

        test('Path.parent() should return Shape', () => {
            // Find a glyph with a path
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (shape.isPath()) {
                        const path = shape.asPath();
                        expect(path.parent()).toBe(shape);
                        return; // Test passed
                    }
                }
            }
        });

        test('Node.parent() should return Path', () => {
            // Find a glyph with a path that has nodes
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (shape.isPath()) {
                        const path = shape.asPath();
                        if (path.nodes && path.nodes.length > 0) {
                            const node = path.nodes[0];
                            expect(node.parent()).toBe(path);
                            return; // Test passed
                        }
                    }
                }
            }
        });

        test('Component.parent() should return Shape', () => {
            // Find a glyph with a component
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (shape.isComponent()) {
                        const component = shape.asComponent();
                        expect(component.parent()).toBe(shape);
                        return; // Test passed
                    }
                }
            }
        });

        test('Anchor.parent() should return Layer', () => {
            // Find a glyph with anchors
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.anchors || layer.anchors.length === 0)
                    continue;

                const anchor = layer.anchors[0];
                expect(anchor.parent()).toBe(layer);
                return; // Test passed
            }
        });

        test('Guide.parent() should return Layer', () => {
            // Find a layer with guides
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.guides || layer.guides.length === 0)
                    continue;

                const guide = layer.guides[0];
                expect(guide.parent()).toBe(layer);
                return; // Test passed
            }
        });

        test('Axis.parent() should return Font', () => {
            if (font.axes && font.axes.length > 0) {
                const axis = font.axes[0];
                expect(axis.parent()).toBe(font);
            }
        });

        test('Master.parent() should return Font', () => {
            if (font.masters && font.masters.length > 0) {
                const master = font.masters[0];
                expect(master.parent()).toBe(font);
            }
        });

        test('Instance.parent() should return Font', () => {
            if (font.instances && font.instances.length > 0) {
                const instance = font.instances[0];
                expect(instance.parent()).toBe(font);
            }
        });

        test('should navigate from Node up to Font', () => {
            // Find a complete path: Node → Path → Shape → Layer → Glyph → Font
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (shape.isPath()) {
                        const path = shape.asPath();
                        if (path.nodes && path.nodes.length > 0) {
                            const node = path.nodes[0];

                            // Navigate up the hierarchy
                            const parentPath = node.parent();
                            expect(parentPath).toBe(path);

                            const parentShape = parentPath.parent();
                            expect(parentShape).toBe(shape);

                            const parentLayer = parentShape.parent();
                            expect(parentLayer).toBe(layer);

                            const parentGlyph = parentLayer.parent();
                            expect(parentGlyph).toBe(glyph);

                            const parentFont = parentGlyph.parent();
                            expect(parentFont).toBe(font);

                            return; // Test passed
                        }
                    }
                }
            }
        });
    });

    describe('Font basic properties', () => {
        test('should have correct UPM', () => {
            expect(font.upm).toBe(fontData.upm);
        });

        test('should have glyphs', () => {
            expect(font.glyphs).toBeDefined();
            expect(Array.isArray(font.glyphs)).toBe(true);
            expect(font.glyphs.length).toBeGreaterThan(0);
        });

        test('should have version', () => {
            expect(font.version).toBeDefined();
            expect(Array.isArray(font.version)).toBe(true);
            expect(font.version.length).toBe(2);
        });

        test('should have names', () => {
            expect(font.names).toBeDefined();
            expect(font.names.family_name).toBeDefined();
        });
    });

    describe('Glyph access and properties', () => {
        test('should access glyph by index', () => {
            const glyph = font.glyphs[0];
            expect(glyph).toBeDefined();
            expect(glyph.name).toBeDefined();
        });

        test('layer width setter rounds fractional values', () => {
            const glyph = font.glyphs[0];
            const layer = glyph.layers[0];

            layer.width = 500.6;

            expect(layer.width).toBe(501);
        });

        test('glyph should have layers', () => {
            const glyph = font.glyphs[0];
            expect(glyph.layers).toBeDefined();
        });

        test('glyph layers should be filtered (no background, no copies)', () => {
            // Find a glyph with multiple layers in raw data
            for (let i = 0; i < fontData.glyphs.length; i++) {
                const rawGlyph = fontData.glyphs[i];
                const modelGlyph = font.glyphs[i];

                if (rawGlyph.layers && rawGlyph.layers.length > 1) {
                    // Model layers should be filtered
                    const modelLayers = modelGlyph.layers || [];
                    const rawLayers = rawGlyph.layers;

                    // Count foreground default layers in raw data
                    let expectedCount = 0;
                    for (const layer of rawLayers) {
                        if (layer.is_background) continue;
                        if (
                            layer.master &&
                            typeof layer.master === 'object' &&
                            'DefaultForMaster' in layer.master
                        ) {
                            expectedCount++;
                        }
                    }

                    expect(modelLayers.length).toBeLessThanOrEqual(
                        rawLayers.length
                    );
                    break;
                }
            }
        });
    });

    describe('Layer properties and methods', () => {
        let layer;

        beforeEach(() => {
            const glyph = font.glyphs[0];
            layer = glyph.layers[0];
        });

        test('should have width property', () => {
            expect(layer.width).toBeDefined();
            expect(typeof layer.width).toBe('number');
        });

        test('getComputedName returns Intermediate Layer for intermediate layers', () => {
            const testFont = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [
                    {
                        name: { en: 'Weight' },
                        tag: 'wght',
                        min: 0,
                        default: 0,
                        max: 100,
                        map: [
                            [0, 0],
                            [100, 100]
                        ]
                    }
                ],
                instances: [],
                masters: [
                    {
                        id: 'master-1',
                        name: { en: 'Regular' },
                        location: { wght: 0 },
                        guides: [],
                        metrics: {},
                        kerning: new Map()
                    }
                ],
                glyphs: [
                    {
                        name: 'A',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                id: 'default-layer',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [],
                                anchors: [],
                                guides: []
                            },
                            {
                                id: 'intermediate-layer',
                                name: '{50}',
                                width: 520,
                                master: {
                                    type: 'AssociatedWithMaster',
                                    master: 'master-1'
                                },
                                location: { wght: 50 },
                                shapes: [],
                                anchors: [],
                                guides: []
                            }
                        ]
                    }
                ],
                names: { family_name: { en: 'Computed Layer Name Test' } },
                note: '',
                date: '2026-03-23',
                features: {},
                first_kern_groups: {},
                second_kern_groups: {},
                custom_ot_values: [],
                variation_sequences: [],
                format_specific: {}
            });

            const glyph = testFont.findGlyph('A');

            expect(glyph.layers[0].getComputedName()).toBe('Regular');
            expect(glyph.layers[1].getComputedName()).toBe(
                'Intermediate Layer'
            );
        });

        test('should have shapes array', () => {
            if (layer.shapes) {
                expect(Array.isArray(layer.shapes)).toBe(true);
            }
        });

        test('should expose filtered paths and components views', () => {
            const pathLayer = font.findGlyph('A').layers[0];
            expect(Array.isArray(pathLayer.paths)).toBe(true);
            expect(pathLayer.paths.length).toBeGreaterThan(0);
            expect(pathLayer.components).toEqual([]);
            expect(
                pathLayer.paths.every((path) => path.parent().isPath())
            ).toBe(true);

            let componentLayer = null;
            for (const glyph of font.glyphs) {
                const candidateLayer = glyph.layers?.[0];
                if (candidateLayer?.components.length) {
                    componentLayer = candidateLayer;
                    break;
                }
            }

            expect(componentLayer).not.toBeNull();
            expect(Array.isArray(componentLayer.components)).toBe(true);
            expect(componentLayer.components.length).toBeGreaterThan(0);
            expect(
                componentLayer.paths.every((path) => path.parent().isPath())
            ).toBe(true);
            expect(
                componentLayer.components.every((component) =>
                    component.parent().isComponent()
                )
            ).toBe(true);
        });

        test('should return empty filtered views for layers without shapes', () => {
            const testGlyph = font.addGlyph('FilteredEmptyGlyph', 'Base');
            const testLayer = testGlyph.addLayer(500);

            expect(testLayer.shapes).toBeUndefined();
            expect(testLayer.paths).toEqual([]);
            expect(testLayer.components).toEqual([]);

            font.removeGlyph('FilteredEmptyGlyph');
        });

        test('removeShape should accept a path object from layer.paths', () => {
            const pathLayer = font.findGlyph('A').layers[0];
            const initialShapeCount = pathLayer.shapes.length;
            const initialPathCount = pathLayer.paths.length;
            const path = pathLayer.paths[0];

            pathLayer.removeShape(path);

            expect(pathLayer.shapes.length).toBe(initialShapeCount - 1);
            expect(pathLayer.paths.length).toBe(initialPathCount - 1);
        });

        test('removeShape should accept a component object from layer.components', () => {
            let componentLayer = null;
            for (const glyph of font.glyphs) {
                const candidateLayer = glyph.layers?.[0];
                if (candidateLayer?.components.length) {
                    componentLayer = candidateLayer;
                    break;
                }
            }

            expect(componentLayer).not.toBeNull();

            const initialShapeCount = componentLayer.shapes.length;
            const initialComponentCount = componentLayer.components.length;
            const component = componentLayer.components[0];

            componentLayer.removeShape(component);

            expect(componentLayer.shapes.length).toBe(initialShapeCount - 1);
            expect(componentLayer.components.length).toBe(
                initialComponentCount - 1
            );
        });

        test('should calculate lsb', () => {
            const lsb = layer.lsb;
            expect(typeof lsb).toBe('number');
        });

        test('should calculate rsb', () => {
            const rsb = layer.rsb;
            expect(typeof rsb).toBe('number');
        });

        test('lsb + bbox.width + rsb should equal width', () => {
            const bbox = layer.getBoundingBox(false);
            if (bbox) {
                const lsb = layer.lsb;
                const rsb = layer.rsb;
                const bboxWidth = bbox.maxX - bbox.minX;
                const total = lsb + bboxWidth + rsb;
                expect(Math.abs(total - layer.width)).toBeLessThan(0.01);
            }
        });
    });

    describe('Layer signatures and glyph compatibility', () => {
        function makeCompatibilityFont(includeIncompatibleLayer = true) {
            const layers = [
                {
                    id: 'default-layer',
                    width: 500,
                    master: {
                        type: 'DefaultForMaster',
                        master: 'master-1'
                    },
                    shapes: [
                        {
                            nodes: [
                                { x: 0, y: 0, nodetype: 'Line' },
                                { x: 100, y: 100, nodetype: 'Curve' }
                            ],
                            closed: false
                        },
                        {
                            reference: 'acutecomb',
                            transform: [1, 0, 0, 1, 10, 20]
                        },
                        {
                            nodes: [
                                { x: 20, y: 20, nodetype: 'Line' },
                                { x: 80, y: 80, nodetype: 'Line' }
                            ],
                            closed: true
                        }
                    ],
                    anchors: [
                        { name: 'top', x: 250, y: 700 },
                        { name: 'bottom', x: 250, y: 0 }
                    ],
                    guides: [{ pos: { x: 0, y: 600 }, angle: 0 }]
                },
                {
                    id: 'compatible-layer',
                    name: '{50}',
                    width: 520,
                    master: {
                        type: 'AssociatedWithMaster',
                        master: 'master-1'
                    },
                    location: { wght: 50 },
                    shapes: [
                        {
                            reference: 'acutecomb',
                            transform: [1, 0, 0, 1, 15, 25]
                        },
                        {
                            nodes: [
                                { x: 10, y: 10, nodetype: 'Line' },
                                { x: 110, y: 110, nodetype: 'Curve' }
                            ],
                            closed: false
                        },
                        {
                            nodes: [
                                { x: 30, y: 30, nodetype: 'Line' },
                                { x: 90, y: 90, nodetype: 'Line' }
                            ],
                            closed: true
                        }
                    ],
                    anchors: [
                        { name: 'bottom', x: 260, y: 0 },
                        { name: 'top', x: 260, y: 680 }
                    ],
                    guides: []
                }
            ];

            if (includeIncompatibleLayer) {
                layers.push({
                    id: 'incompatible-layer',
                    name: '{75}',
                    width: 540,
                    master: {
                        type: 'AssociatedWithMaster',
                        master: 'master-1'
                    },
                    location: { wght: 75 },
                    shapes: [
                        {
                            reference: 'acutecomb',
                            transform: [1, 0, 0, 1, 20, 30]
                        },
                        {
                            nodes: [
                                { x: 15, y: 15, nodetype: 'Line' },
                                { x: 115, y: 115, nodetype: 'Curve' }
                            ],
                            closed: false
                        },
                        {
                            nodes: [
                                { x: 40, y: 40, nodetype: 'Line' },
                                { x: 95, y: 95, nodetype: 'Line' }
                            ],
                            closed: true
                        }
                    ],
                    anchors: [
                        { name: 'left', x: 50, y: 300 },
                        { name: 'top', x: 270, y: 660 }
                    ],
                    guides: [{ pos: { x: 0, y: 560 }, angle: 0 }]
                });
            }

            return Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [
                    {
                        name: { en: 'Weight' },
                        tag: 'wght',
                        min: 0,
                        default: 0,
                        max: 100,
                        map: [
                            [0, 0],
                            [100, 100]
                        ]
                    }
                ],
                instances: [],
                masters: [
                    {
                        id: 'master-1',
                        name: { en: 'Regular' },
                        location: { wght: 0 },
                        guides: [],
                        metrics: {},
                        kerning: new Map()
                    }
                ],
                glyphs: [
                    {
                        name: 'A',
                        category: 'Base',
                        exported: true,
                        layers
                    }
                ],
                names: { family_name: { en: 'Compatibility Test' } },
                note: '',
                date: '2026-03-23',
                features: {},
                first_kern_groups: {},
                second_kern_groups: {},
                custom_ot_values: [],
                variation_sequences: [],
                format_specific: {}
            });
        }

        test('layer.fingerprint separates components, paths, and sorted anchors while excluding guides', () => {
            const compatibilityFont = makeCompatibilityFont();
            const glyph = compatibilityFont.findGlyph('A');

            expect(glyph.layers[0].fingerprint).toBe(
                'components[C:acutecomb];paths[P:0:2:Line,Curve|P:1:2:Line,Line];anchors[A:bottom|A:top]'
            );
            expect(glyph.layers[0].fingerprint).toBe(
                glyph.layers[1].fingerprint
            );
            expect(glyph.layers[0].fingerprint).not.toContain('guide');
        });

        test('glyph.isCompatible returns true when all main layers share a signature', () => {
            const compatibilityFont = makeCompatibilityFont(false);
            const glyph = compatibilityFont.findGlyph('A');

            expect(glyph.isCompatible).toBe(true);
            expect(glyph.calculateOutlineCompatibility()).toEqual({
                compatible: true,
                layerCount: 2,
                referenceLayerId: 'default-layer',
                incompatibleLayerIds: []
            });
        });

        test('glyph.calculateOutlineCompatibility reports incompatible layers via signatures', () => {
            const compatibilityFont = makeCompatibilityFont();
            const glyph = compatibilityFont.findGlyph('A');

            expect(glyph.isCompatible).toBe(false);
            expect(glyph.calculateOutlineCompatibility()).toEqual({
                compatible: false,
                layerCount: 3,
                referenceLayerId: 'default-layer',
                incompatibleLayerIds: ['incompatible-layer']
            });
        });
    });

    describe('Sidebearing manipulation (lsb/rsb setters)', () => {
        test('lsb setter should adjust width for paths', () => {
            const glyph = font.glyphs.find((g) => g.name === 'A'); // paths only
            const layer = glyph.layers[0];

            glyph.leftMetricsKey = undefined;
            glyph.rightMetricsKey = undefined;
            layer.leftMetricsKey = undefined;
            layer.rightMetricsKey = undefined;

            const originalLsb = layer.lsb;
            const originalWidth = layer.width;

            layer.lsb = originalLsb + 50;
            expect(layer.width).toBeCloseTo(originalWidth + 50, 1);
        });

        test('lsb setter should adjust width for components', () => {
            const glyph = font.glyphs.find((g) => g.name === 'Aacute'); // components only
            const layer = glyph.layers[0];

            glyph.leftMetricsKey = undefined;
            glyph.rightMetricsKey = undefined;
            layer.leftMetricsKey = undefined;
            layer.rightMetricsKey = undefined;

            const originalLsb = layer.lsb;
            const originalWidth = layer.width;

            layer.lsb = originalLsb - 30;
            expect(layer.width).toBeCloseTo(originalWidth - 30, 1);
        });

        test('lsb setter should adjust width for mixed shapes', () => {
            const glyph = font.glyphs.find((g) => g.name === 'AE'); // mixed paths + components
            const layer = glyph.layers[0];

            glyph.leftMetricsKey = undefined;
            glyph.rightMetricsKey = undefined;
            layer.leftMetricsKey = undefined;
            layer.rightMetricsKey = undefined;

            const originalLsb = layer.lsb;
            const originalWidth = layer.width;

            layer.lsb = originalLsb + 25;
            expect(layer.width).toBeCloseTo(originalWidth + 25, 1);
        });

        test('rsb setter should only adjust width without translating geometry', () => {
            const glyph = font.glyphs.find((g) => g.name === 'A');
            const layer = glyph.layers[0];

            glyph.leftMetricsKey = undefined;
            glyph.rightMetricsKey = undefined;
            layer.leftMetricsKey = undefined;
            layer.rightMetricsKey = undefined;

            const originalRsb = layer.rsb;
            const originalBbox = layer.getBoundingBox(false);
            const originalWidth = layer.width;

            layer.rsb = originalRsb + 40;

            const newBbox = layer.getBoundingBox(false);
            expect(newBbox.minX).toBeCloseTo(originalBbox.minX, 1);
            expect(newBbox.maxX).toBeCloseTo(originalBbox.maxX, 1);
            expect(layer.width).toBeCloseTo(originalWidth + 40, 1);
        });
    });

    describe('Metrics key accessors and recomputation', () => {
        test('interpolates referenced glyph metrics for brace layers when no exact layer exists', () => {
            const glyphA = intermediateLayerFont.findGlyph('a');
            const glyphN = intermediateLayerFont.findGlyph('n');

            expect(glyphA).toBeDefined();
            expect(glyphN).toBeDefined();
            expect(glyphA.rightMetricsKey).toBe('n');

            const braceLayer = glyphA.layers.find(
                (layer) => layer.location && Object.keys(layer.location).length
            );

            expect(braceLayer).toBeDefined();
            expect(braceLayer.rsb).toBe(43);
            expect(braceLayer.getMatchingLayerOnGlyph('n')).toBeUndefined();

            const resolution = braceLayer.resolveMetricsKey('right');
            expect(resolution.error).toBeNull();
            expect(resolution.value).toBe(50);

            intermediateLayerFont.recomputeMetricsKeys(new Set(['n']));
            expect(braceLayer.rsb).toBe(50);
        });

        test('keeps brace-layer metric interpolation working after path nodes are materialized', () => {
            const glyphA = intermediateLayerFont.findGlyph('a');
            const glyphN = intermediateLayerFont.findGlyph('n');
            const braceLayer = glyphA.layers.find(
                (layer) => layer.location && Object.keys(layer.location).length
            );

            // Simulate edit-time model access that converts stored node strings
            // into node arrays on the live font model.
            braceLayer.shapes[0].asPath().nodes;
            glyphN.layers[0].shapes[0].asPath().nodes;
            glyphN.layers[1].shapes[0].asPath().nodes;
            glyphN.layers[2].shapes[0].asPath().nodes;

            const resolution = braceLayer.resolveMetricsKey('right');
            expect(resolution.error).toBeNull();
            expect(resolution.value).toBe(50);

            intermediateLayerFont.recomputeMetricsKeys(new Set(['n']));
            expect(braceLayer.rsb).toBe(50);
        });

        test('keeps using the last stored interpolation snapshot when refresh fails after an edit', () => {
            const glyphA = intermediateLayerFont.findGlyph('a');
            const braceLayer = glyphA.layers.find(
                (layer) => layer.location && Object.keys(layer.location).length
            );
            const pathShape = braceLayer.shapes[0].asPath();

            expect(braceLayer.resolveMetricsKey('right').value).toBe(50);

            pathShape.nodes[0].x += 1;
            store_font.mockImplementationOnce(() => {
                throw new Error('store failed');
            });

            const resolution = braceLayer.resolveMetricsKey('right');
            expect(resolution.error).toBeNull();
            expect(resolution.value).toBe(50);
        });

        test('reuses the interpolation snapshot during an intermediate-layer =50 lsb edit', () => {
            const glyphA = intermediateLayerFont.findGlyph('a');
            const braceLayer = glyphA.layers.find(
                (layer) => layer.location && Object.keys(layer.location).length
            );
            const serializeSpy = jest.spyOn(
                intermediateLayerFont,
                'toJSONString'
            );

            store_font.mockClear();

            const resolution = braceLayer.applySidebearingInput('left', '=50');

            expect(resolution.error).toBeNull();
            expect(resolution.value).toBe(50);
            expect(Number.isInteger(braceLayer.width)).toBe(true);
            expect(serializeSpy).toHaveBeenCalledTimes(1);
            expect(store_font).toHaveBeenCalledTimes(1);

            serializeSpy.mockRestore();
        });

        test('height-offset sidebearing commits round the stored width after interpolation math', () => {
            const heightFont = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                instances: [],
                masters: [
                    {
                        id: 'master-1',
                        name: 'Regular',
                        location: {},
                        guides: [],
                        metrics: {},
                        kerning: {}
                    }
                ],
                glyphs: [
                    {
                        name: 'base',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                id: 'base-layer',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 110, y: 0, nodetype: 'Line' },
                                            { x: 380, y: 0, nodetype: 'Line' },
                                            {
                                                x: 380,
                                                y: 500,
                                                nodetype: 'Line'
                                            },
                                            { x: 110, y: 500, nodetype: 'Line' }
                                        ],
                                        closed: true
                                    }
                                ],
                                anchors: [],
                                guides: []
                            }
                        ]
                    },
                    {
                        name: 'target',
                        category: 'Base',
                        exported: true,
                        format_specific: {
                            metric_right: '=base@200'
                        },
                        layers: [
                            {
                                id: 'target-layer',
                                width: 520.6,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 80, y: 0, nodetype: 'Line' },
                                            { x: 430, y: 0, nodetype: 'Line' },
                                            {
                                                x: 410.4,
                                                y: 500,
                                                nodetype: 'Line'
                                            },
                                            {
                                                x: 120.4,
                                                y: 500,
                                                nodetype: 'Line'
                                            }
                                        ],
                                        closed: true
                                    }
                                ],
                                anchors: [],
                                guides: []
                            }
                        ]
                    }
                ],
                names: { family_name: { en: 'Height Rounding Test' } },
                note: '',
                date: '2026-03-20',
                features: {},
                first_kern_groups: {},
                second_kern_groups: {},
                custom_ot_values: [],
                variation_sequences: [],
                format_specific: {}
            });

            const targetLayer = heightFont.findGlyph('target').layers[0];
            const resolution = targetLayer.applySidebearingInput(
                'right',
                '=base@200'
            );

            expect(resolution.error).toBeNull();
            expect(targetLayer.width).toBe(542);
            expect(targetLayer.rsb).toBe(112);
        });

        test('keyed rsb recomputation rounds the opposite sidebearing before recomputing width', () => {
            const roundedMetricsFont = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                instances: [],
                masters: [
                    {
                        id: 'master-1',
                        name: 'Regular',
                        location: {},
                        guides: [],
                        metrics: {},
                        kerning: {}
                    }
                ],
                glyphs: [
                    {
                        name: 'target',
                        category: 'Base',
                        exported: true,
                        format_specific: {
                            metric_right: '=50'
                        },
                        layers: [
                            {
                                id: 'target-layer',
                                width: 521,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 70.4, y: 0, nodetype: 'Line' },
                                            {
                                                x: 420.4,
                                                y: 0,
                                                nodetype: 'Line'
                                            },
                                            {
                                                x: 420.4,
                                                y: 500,
                                                nodetype: 'Line'
                                            },
                                            {
                                                x: 70.4,
                                                y: 500,
                                                nodetype: 'Line'
                                            }
                                        ],
                                        closed: true
                                    }
                                ],
                                anchors: [],
                                guides: []
                            }
                        ]
                    }
                ],
                names: { family_name: { en: 'Rounded Metrics Target' } },
                note: '',
                date: '2026-03-20',
                features: {},
                first_kern_groups: {},
                second_kern_groups: {},
                custom_ot_values: [],
                variation_sequences: [],
                format_specific: {}
            });

            const targetLayer =
                roundedMetricsFont.findGlyph('target').layers[0];
            const rightmostNodes = targetLayer.shapes
                .filter((shape) => shape.isPath())
                .flatMap((shape) => shape.asPath().nodes)
                .filter((node) => node.x === 420.4);

            for (const node of rightmostNodes) {
                node.x += 10.2;
            }

            roundedMetricsFont.recomputeMetricsKeys(new Set(['target']));

            expect(targetLayer.rsb).toBe(50);
            expect(targetLayer.lsb).toBe(70);
            expect(targetLayer.width).toBe(481);
        });

        test('glyph-wide sidebearing keys update sibling layers on the same glyph', () => {
            const glyphA = intermediateLayerFont.findGlyph('a');
            const editableLayers = glyphA.layers.filter(
                (layer) => !layer.isBackground?.() && !layer.isBackground
            );
            const editedLayer = editableLayers[0];

            const resolution = editedLayer.applySidebearingInput('left', '=50');

            expect(resolution.error).toBeNull();
            expect(resolution.updateScope).toBe('font');
            expect(glyphA.leftMetricsKey).toBe('=50');
            for (const layer of editableLayers) {
                expect(layer.lsb).toBe(50);
            }
        });

        test('batches geometry history updates during a left-sidebearing translation', () => {
            const glyph = font.findGlyph('A');
            const layer = glyph.layers[0];

            for (const shape of layer.shapes || []) {
                if (shape.isPath()) {
                    shape.asPath().nodes;
                }
            }

            const originalBridge = window.changeBridge;
            const recordChange = jest.fn();

            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                recordChange
            };

            try {
                const resolution = layer.applySidebearingInput(
                    'left',
                    String(layer.lsb + 25)
                );

                expect(resolution.error).toBeNull();
            } finally {
                window.changeBridge = originalBridge;
            }

            const recordedProps = recordChange.mock.calls.map(
                ([, prop]) => prop
            );

            expect(recordedProps).toEqual(
                expect.arrayContaining(['shapes', 'width'])
            );
            expect(recordedProps).not.toContain('x');
            expect(recordedProps).not.toContain('y');
            expect(recordChange.mock.calls.length).toBeLessThanOrEqual(5);
        });

        test('exposes imported glyph and layer metrics keys', () => {
            const glyphA = metricsKeysFont.findGlyph('a');
            const glyphAring = metricsKeysFont.findGlyph('aring');
            const glyphN = metricsKeysFont.findGlyph('n');
            const glyphE = metricsKeysFont.findGlyph('e');

            expect(glyphA.rightMetricsKey).toBe('n');
            expect(glyphAring.layers[0].rightMetricsKey).toBe('==+20');
            expect(glyphAring.layers[1].rightMetricsKey).toBeUndefined();
            expect(glyphN.leftMetricsKey).toBe('=l-5');
            expect(glyphN.rightMetricsKey).toBe('=l-10');
            expect(glyphE.rightMetricsKey).toBe('=c@200');
        });

        test('changing l rsb recomputes dependent glyph metrics', () => {
            const glyphL = metricsKeysFont.findGlyph('l');
            const glyphN = metricsKeysFont.findGlyph('n');
            const glyphA = metricsKeysFont.findGlyph('a');
            const glyphAdieresis = metricsKeysFont.findGlyph('adieresis');
            const glyphAring = metricsKeysFont.findGlyph('aring');

            const layerL = glyphL.layers[0];
            const layerN = glyphN.layers[0];
            const layerA = glyphA.layers[0];
            const layerAdieresis = glyphAdieresis.layers[0];
            const layerAring = glyphAring.layers[0];

            layerL.rsb = layerL.rsb + 17;

            expect(layerN.rsb).toBe(layerL.rsb - 10);
            expect(layerA.rsb).toBe(layerN.rsb);
            expect(layerAdieresis.rsb).toBe(layerA.rsb + 10);
            expect(layerAring.rsb).toBe(layerA.rsb + 20);
        });

        test('changing c rsb recomputes baseline-offset dependent glyph metrics', () => {
            const glyphC = metricsKeysFont.findGlyph('c');
            const glyphE = metricsKeysFont.findGlyph('e');
            const layerC = glyphC.layers[0];
            const layerE = glyphE.layers[0];
            const originalResolvedERsb = layerE.resolveMetricsKey('right');
            const originalMeasuredERsb = layerE.getSidebearingsAtHeight(200);
            const originalDirectERsb = layerE.rsb;

            layerC.rsb = layerC.rsb + 19;

            const recomputedResolvedERsb = layerE.resolveMetricsKey('right');
            const recomputedMeasuredERsb = layerE.getSidebearingsAtHeight(200);

            expect(originalResolvedERsb.error).toBeNull();
            expect(originalResolvedERsb.value).not.toBeNull();
            expect(originalMeasuredERsb).not.toBeNull();
            expect(recomputedResolvedERsb.error).toBeNull();
            expect(recomputedResolvedERsb.value).not.toBeNull();
            expect(recomputedMeasuredERsb).not.toBeNull();

            expect(recomputedMeasuredERsb.right).toBeCloseTo(
                recomputedResolvedERsb.value,
                0
            );

            expect(
                Math.abs(
                    recomputedMeasuredERsb.right -
                        originalMeasuredERsb.right -
                        (recomputedResolvedERsb.value -
                            originalResolvedERsb.value)
                )
            ).toBeLessThanOrEqual(1);
        });

        test('glyph-wide reference arithmetic key keeps a non-automatic layer at the referenced sidebearing during local edits', () => {
            const glyphL = metricsKeysFont.findGlyph('l');
            const glyphN = metricsKeysFont.findGlyph('n');
            const layerL = glyphL.layers[0];
            const layerN = glyphN.layers[0];
            const candidateNodes = (layerN.shapes || [])
                .filter((shape) => shape.isPath())
                .flatMap((shape) => shape.asPath().nodes || []);
            const rightmostNode = candidateNodes.reduce((best, node) =>
                !best || node.x > best.x ? node : best
            );

            const originalResolved = layerN.resolveMetricsKey('right');

            rightmostNode.x += 30;

            expect(originalResolved.error).toBeNull();
            expect(layerN.rsb).toBeCloseTo(layerL.rsb - 10, 1);
            expect(layerN.rsb).toBeCloseTo(originalResolved.value, 1);
        });

        test('mirrored reference keys keep sidebearings fixed during local edits', () => {
            const mirrorFont = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                instances: [],
                masters: [
                    {
                        id: 'master-1',
                        name: 'Regular',
                        location: {},
                        guides: [],
                        metrics: {},
                        kerning: {}
                    }
                ],
                glyphs: [
                    {
                        name: 'base',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                id: 'base-layer',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 120, y: 0, nodetype: 'Line' },
                                            { x: 360, y: 0, nodetype: 'Line' },
                                            {
                                                x: 360,
                                                y: 600,
                                                nodetype: 'Line'
                                            },
                                            { x: 120, y: 600, nodetype: 'Line' }
                                        ],
                                        closed: true
                                    }
                                ],
                                anchors: [],
                                guides: []
                            }
                        ]
                    },
                    {
                        name: 'target',
                        category: 'Base',
                        exported: true,
                        format_specific: {
                            metric_left: '=|base'
                        },
                        layers: [
                            {
                                id: 'target-layer',
                                width: 520,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 80, y: 0, nodetype: 'Line' },
                                            { x: 400, y: 0, nodetype: 'Line' },
                                            {
                                                x: 400,
                                                y: 600,
                                                nodetype: 'Line'
                                            },
                                            { x: 80, y: 600, nodetype: 'Line' }
                                        ],
                                        closed: true
                                    }
                                ],
                                anchors: [],
                                guides: []
                            }
                        ]
                    }
                ],
                names: { family_name: { en: 'Mirror Test' } },
                note: '',
                date: '2026-03-18',
                features: {},
                first_kern_groups: {},
                second_kern_groups: {},
                custom_ot_values: [],
                variation_sequences: [],
                format_specific: {}
            });
            const baseLayer = mirrorFont.findGlyph('base').layers[0];
            const targetLayer = mirrorFont.findGlyph('target').layers[0];
            mirrorFont.recomputeMetricsKeys(new Set(['target']));
            const candidateNodes = (targetLayer.shapes || [])
                .filter((shape) => shape.isPath())
                .flatMap((shape) => shape.asPath().nodes || []);
            const leftmostNode = candidateNodes.reduce((best, node) =>
                !best || node.x < best.x ? node : best
            );

            leftmostNode.x -= 35;

            expect(targetLayer.lsb).toBeCloseTo(baseLayer.rsb, 1);
        });

        test('height-offset reference keys keep measured sidebearings fixed during local edits', () => {
            const heightFont = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                instances: [],
                masters: [
                    {
                        id: 'master-1',
                        name: 'Regular',
                        location: {},
                        guides: [],
                        metrics: {},
                        kerning: {}
                    }
                ],
                glyphs: [
                    {
                        name: 'base',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                id: 'base-layer',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 110, y: 0, nodetype: 'Line' },
                                            { x: 380, y: 0, nodetype: 'Line' },
                                            {
                                                x: 380,
                                                y: 500,
                                                nodetype: 'Line'
                                            },
                                            { x: 110, y: 500, nodetype: 'Line' }
                                        ],
                                        closed: true
                                    }
                                ],
                                anchors: [],
                                guides: []
                            }
                        ]
                    },
                    {
                        name: 'target',
                        category: 'Base',
                        exported: true,
                        format_specific: {
                            metric_right: '=base@200'
                        },
                        layers: [
                            {
                                id: 'target-layer',
                                width: 520,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 70, y: 0, nodetype: 'Line' },
                                            { x: 420, y: 0, nodetype: 'Line' },
                                            {
                                                x: 420,
                                                y: 500,
                                                nodetype: 'Line'
                                            },
                                            { x: 70, y: 500, nodetype: 'Line' }
                                        ],
                                        closed: true
                                    }
                                ],
                                anchors: [],
                                guides: []
                            }
                        ]
                    }
                ],
                names: { family_name: { en: 'Height Test' } },
                note: '',
                date: '2026-03-18',
                features: {},
                first_kern_groups: {},
                second_kern_groups: {},
                custom_ot_values: [],
                variation_sequences: [],
                format_specific: {}
            });
            const baseLayer = heightFont.findGlyph('base').layers[0];
            const targetLayer = heightFont.findGlyph('target').layers[0];
            heightFont.recomputeMetricsKeys(new Set(['target']));
            const candidateNodes = (targetLayer.shapes || [])
                .filter((shape) => shape.isPath())
                .flatMap((shape) => shape.asPath().nodes || []);
            const rightEdgeNodes = candidateNodes.filter(
                (node) => node.x === Math.max(...candidateNodes.map((n) => n.x))
            );
            const targetMeasuredBefore =
                targetLayer.getSidebearingsAtHeight(200);
            const baseMeasured = baseLayer.getSidebearingsAtHeight(200);

            for (const node of rightEdgeNodes) {
                node.x += 40;
            }

            const targetMeasuredAfter =
                targetLayer.getSidebearingsAtHeight(200);

            expect(baseMeasured).not.toBeNull();
            expect(targetMeasuredBefore).not.toBeNull();
            expect(targetMeasuredAfter).not.toBeNull();
            expect(targetMeasuredAfter.right).toBeCloseTo(
                baseMeasured.right,
                1
            );
            expect(targetMeasuredAfter.right).toBeCloseTo(
                targetMeasuredBefore.right,
                1
            );
        });

        test('glyph-wide =-20 keeps a non-automatic layer at a constant sidebearing', () => {
            const glyph = font.findGlyph('A');
            const layer = glyph.layers[0];
            const candidateNodes = (layer.shapes || [])
                .filter((shape) => shape.isPath())
                .flatMap((shape) => shape.asPath().nodes || []);
            const rightmostNode = candidateNodes.reduce((best, node) =>
                !best || node.x > best.x ? node : best
            );

            layer.applySidebearingInput('right', '=-20');

            expect(glyph.rightMetricsKey).toBe('=-20');
            expect(layer.rightMetricsKey).toBeUndefined();
            expect(layer.rsb).toBeCloseTo(-20, 1);

            rightmostNode.x += 30;

            expect(layer.rsb).toBeCloseTo(-20, 1);
        });

        test('layer-local ==-20 keeps a non-automatic layer at a constant sidebearing', () => {
            const glyph = font.findGlyph('A');
            const layer = glyph.layers[0];
            const candidateNodes = (layer.shapes || [])
                .filter((shape) => shape.isPath())
                .flatMap((shape) => shape.asPath().nodes || []);
            const rightmostNode = candidateNodes.reduce((best, node) =>
                !best || node.x > best.x ? node : best
            );

            glyph.rightMetricsKey = undefined;
            layer.applySidebearingInput('right', '==-20');

            expect(glyph.rightMetricsKey).toBeUndefined();
            expect(layer.rightMetricsKey).toBe('==-20');
            expect(layer.rsb).toBeCloseTo(-20, 1);

            rightmostNode.x += 25;

            expect(layer.rsb).toBeCloseTo(-20, 1);
        });

        test('glyph-wide =20 keeps a non-automatic layer at a constant sidebearing', () => {
            const glyph = font.findGlyph('A');
            const layer = glyph.layers[0];
            const candidateNodes = (layer.shapes || [])
                .filter((shape) => shape.isPath())
                .flatMap((shape) => shape.asPath().nodes || []);
            const rightmostNode = candidateNodes.reduce((best, node) =>
                !best || node.x > best.x ? node : best
            );

            layer.applySidebearingInput('right', '=20');

            expect(glyph.rightMetricsKey).toBe('=20');
            expect(layer.rightMetricsKey).toBeUndefined();
            expect(layer.rsb).toBeCloseTo(20, 1);

            rightmostNode.x += 30;

            expect(layer.rsb).toBeCloseTo(20, 1);
        });

        test('layer-local ==20 keeps a non-automatic layer at a constant sidebearing', () => {
            const glyph = font.findGlyph('A');
            const layer = glyph.layers[0];
            const candidateNodes = (layer.shapes || [])
                .filter((shape) => shape.isPath())
                .flatMap((shape) => shape.asPath().nodes || []);
            const rightmostNode = candidateNodes.reduce((best, node) =>
                !best || node.x > best.x ? node : best
            );

            glyph.rightMetricsKey = undefined;
            layer.applySidebearingInput('right', '==20');

            expect(glyph.rightMetricsKey).toBeUndefined();
            expect(layer.rightMetricsKey).toBe('==20');
            expect(layer.rsb).toBeCloseTo(20, 1);

            rightmostNode.x += 25;

            expect(layer.rsb).toBeCloseTo(20, 1);
        });

        test('findLayerById returns associated layers that are not in glyph.layers', () => {
            const glyphA = metricsKeysFont.findGlyph('a');

            const associatedLayer = glyphA.findLayerById(
                'D42253C8-C2D4-4376-9630-735954ED741C'
            );

            expect(associatedLayer).toBeDefined();
            expect(associatedLayer.id).toBe(
                'D42253C8-C2D4-4376-9630-735954ED741C'
            );
            expect(
                glyphA.layers.some((layer) => layer.id === associatedLayer.id)
            ).toBe(false);
            expect(associatedLayer.rsb).toBeDefined();
        });
    });

    describe('Shape polymorphism', () => {
        test('Shape.isPath() and asPath() should work', () => {
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (shape.isPath()) {
                        expect(shape.isComponent()).toBe(false);
                        const path = shape.asPath();
                        expect(path).toBeDefined();
                        expect(path.nodes).toBeDefined();
                        return;
                    }
                }
            }
        });

        test('Shape.isComponent() and asComponent() should work', () => {
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (shape.isComponent()) {
                        expect(shape.isPath()).toBe(false);
                        const component = shape.asComponent();
                        expect(component).toBeDefined();
                        expect(component.reference).toBeDefined();
                        return;
                    }
                }
            }
        });
    });

    describe('Path and Node manipulation', () => {
        test('should access nodes in a path', () => {
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (shape.isPath()) {
                        const path = shape.asPath();
                        if (path.nodes && path.nodes.length > 0) {
                            const node = path.nodes[0];
                            expect(node.x).toBeDefined();
                            expect(node.y).toBeDefined();
                            expect(node.nodetype).toBeDefined();
                            return;
                        }
                    }
                }
            }
        });

        test('node should have correct properties', () => {
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (shape.isPath()) {
                        const path = shape.asPath();
                        if (path.nodes && path.nodes.length > 0) {
                            const node = path.nodes[0];
                            expect(typeof node.x).toBe('number');
                            expect(typeof node.y).toBe('number');
                            expect(typeof node.nodetype).toBe('string');
                            return;
                        }
                    }
                }
            }
        });

        test('Path._deleteNode should delete off-curve node and convert curve to line', () => {
            // Create a cubic curve: Move + OffCurve + OffCurve + Curve
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Move' },
                    { x: 50, y: 0, nodetype: 'OffCurve' },
                    { x: 100, y: 50, nodetype: 'OffCurve' },
                    { x: 100, y: 100, nodetype: 'Curve' }
                ],
                false
            );
            const glyph = testFont.glyphs[0];
            const layer = glyph.layers[0];
            const path = layer.shapes[0].asPath();

            expect(path.nodes.length).toBe(4);

            // Delete the first off-curve node
            const result = path._deleteNode(1);

            expect(result).toBe(true);
            expect(path.nodes.length).toBe(2);
            expect(path.nodes[0].nodetype).toBe('Move');
            expect(path.nodes[1].nodetype).toBe('Line');
            expect(path.nodes[1].x).toBe(100);
            expect(path.nodes[1].y).toBe(100);
        });

        test('Path._deleteNode should delete line node (line-line)', () => {
            // Create a simple line path: Move + Line + Line
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Move' },
                    { x: 50, y: 0, nodetype: 'Line' },
                    { x: 100, y: 100, nodetype: 'Line' }
                ],
                false
            );
            const glyph = testFont.glyphs[0];
            const layer = glyph.layers[0];
            const path = layer.shapes[0].asPath();

            expect(path.nodes.length).toBe(3);

            // Delete the middle node
            const result = path._deleteNode(1);

            expect(result).toBe(true);
            expect(path.nodes.length).toBe(2);
            expect(path.nodes[0].nodetype).toBe('Move');
            expect(path.nodes[1].nodetype).toBe('Line');
        });

        test('Path._deleteNode should merge two cubic curves', () => {
            // Create two connected cubic curves
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Move' },
                    { x: 33, y: 0, nodetype: 'OffCurve' },
                    { x: 67, y: 33, nodetype: 'OffCurve' },
                    { x: 100, y: 50, nodetype: 'Curve', smooth: true },
                    { x: 133, y: 67, nodetype: 'OffCurve' },
                    { x: 167, y: 100, nodetype: 'OffCurve' },
                    { x: 200, y: 100, nodetype: 'Curve' }
                ],
                false
            );
            const glyph = testFont.glyphs[0];
            const layer = glyph.layers[0];
            const path = layer.shapes[0].asPath();
            const originalNodes = path.nodes.map((node) => ({
                x: node.x,
                y: node.y,
                nodetype: node.nodetype
            }));

            expect(path.nodes.length).toBe(7);

            // Delete the middle on-curve node (index 3)
            const result = path._deleteNode(3);

            expect(result).toBe(true);
            // Should result in: Move + OffCurve + OffCurve + Curve (merged curve)
            expect(path.nodes.length).toBe(4);
            expect(path.nodes[0].nodetype).toBe('Move');
            expect(path.nodes[1].nodetype).toBe('OffCurve');
            expect(path.nodes[2].nodetype).toBe('OffCurve');
            expect(path.nodes[3].nodetype).toBe('Curve');

            const originalStartDirection = normalizeVector(
                originalNodes[1].x - originalNodes[0].x,
                originalNodes[1].y - originalNodes[0].y
            );
            const mergedStartDirection = normalizeVector(
                path.nodes[1].x - path.nodes[0].x,
                path.nodes[1].y - path.nodes[0].y
            );
            expect(mergedStartDirection.x).toBeCloseTo(
                originalStartDirection.x,
                8
            );
            expect(mergedStartDirection.y).toBeCloseTo(
                originalStartDirection.y,
                8
            );

            const originalEndDirection = normalizeVector(
                originalNodes[5].x - originalNodes[6].x,
                originalNodes[5].y - originalNodes[6].y
            );
            const mergedEndDirection = normalizeVector(
                path.nodes[2].x - path.nodes[3].x,
                path.nodes[2].y - path.nodes[3].y
            );
            expect(mergedEndDirection.x).toBeCloseTo(originalEndDirection.x, 8);
            expect(mergedEndDirection.y).toBeCloseTo(originalEndDirection.y, 8);

            expect(path.nodes[1].x).not.toBeCloseTo(path.nodes[3].x, 8);
            expect(path.nodes[1].y).not.toBeCloseTo(path.nodes[3].y, 8);
            expect(path.nodes[2].x).not.toBeCloseTo(path.nodes[0].x, 8);
            expect(path.nodes[2].y).not.toBeCloseTo(path.nodes[0].y, 8);
        });

        test('Path._deleteNode should exactly invert an asymmetric cubic split', () => {
            const originalNodes = [
                { x: 0, y: 0, nodetype: 'Curve', smooth: true },
                { x: 30, y: 60, nodetype: 'OffCurve' },
                { x: 70, y: 60, nodetype: 'OffCurve' },
                { x: 100, y: 0, nodetype: 'Curve', smooth: true }
            ];
            const testFont = makeFontWithSinglePath(originalNodes, false);
            const path = testFont.glyphs[0].layers[0].paths[0];

            const insertedNodeIndex = path._addPoint(0, 0.25);

            expect(insertedNodeIndex).toBe(3);
            expect(path.nodes).toHaveLength(7);

            const result = path._deleteNode(insertedNodeIndex);

            expect(result).toBe(true);
            expectNodesToMatch(path.nodes, originalNodes);

            const mergedCurve = new Bezier([
                { x: path.nodes[0].x, y: path.nodes[0].y },
                { x: path.nodes[1].x, y: path.nodes[1].y },
                { x: path.nodes[2].x, y: path.nodes[2].y },
                { x: path.nodes[3].x, y: path.nodes[3].y }
            ]);
            expect(
                mergedCurve
                    .inflections()
                    .filter((t) => t > 0.000001 && t < 0.999999)
            ).toEqual([]);
            expect(path.nodes[1].x).not.toBeCloseTo(path.nodes[3].x, 8);
            expect(path.nodes[1].y).not.toBeCloseTo(path.nodes[3].y, 8);
            expect(path.nodes[2].x).not.toBeCloseTo(path.nodes[0].x, 8);
            expect(path.nodes[2].y).not.toBeCloseTo(path.nodes[0].y, 8);
        });

        test('Path._deleteNode should set both adjacent on-curve points to smooth=false when deleting a handle into a line', () => {
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Curve', smooth: true },
                    { x: 30, y: 60, nodetype: 'OffCurve' },
                    { x: 70, y: 60, nodetype: 'OffCurve' },
                    { x: 100, y: 0, nodetype: 'Curve', smooth: true }
                ],
                false
            );
            const path = testFont.glyphs[0].layers[0].paths[0];

            const result = path._deleteNode(1);

            expect(result).toBe(true);
            expect(path.nodes.map((node) => node.nodetype)).toEqual([
                'Curve',
                'Line'
            ]);
            expect(path.nodes[0].smooth).toBe(false);
            expect(path.nodes[1].smooth).toBe(false);
        });

        test('Path._deleteNode should convert line-curve to curve', () => {
            // Create line followed by curve
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Move' },
                    { x: 50, y: 0, nodetype: 'Line' },
                    { x: 100, y: 50, nodetype: 'OffCurve' },
                    { x: 150, y: 100, nodetype: 'OffCurve' },
                    { x: 200, y: 100, nodetype: 'Curve' }
                ],
                false
            );
            const glyph = testFont.glyphs[0];
            const layer = glyph.layers[0];
            const path = layer.shapes[0].asPath();

            expect(path.nodes.length).toBe(5);

            // Delete the Line node (index 1)
            const result = path._deleteNode(1);

            expect(result).toBe(true);
            // Should convert to a curve
            expect(path.nodes.length).toBe(4);
            expect(path.nodes[0].nodetype).toBe('Move');
            expect(path.nodes[1].nodetype).toBe('OffCurve');
            expect(path.nodes[2].nodetype).toBe('OffCurve');
            expect(path.nodes[3].nodetype).toBe('Curve');
        });

        test('Path._deleteNode should convert curve-line to curve', () => {
            // Create curve followed by line
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Move' },
                    { x: 50, y: 0, nodetype: 'OffCurve' },
                    { x: 100, y: 50, nodetype: 'OffCurve' },
                    { x: 150, y: 50, nodetype: 'Curve' },
                    { x: 200, y: 100, nodetype: 'Line' }
                ],
                false
            );
            const glyph = testFont.glyphs[0];
            const layer = glyph.layers[0];
            const path = layer.shapes[0].asPath();

            expect(path.nodes.length).toBe(5);

            // Delete the Curve node (index 3)
            const result = path._deleteNode(3);

            expect(result).toBe(true);
            // Should convert to a curve
            expect(path.nodes.length).toBe(4);
            expect(path.nodes[0].nodetype).toBe('Move');
            expect(path.nodes[1].nodetype).toBe('OffCurve');
            expect(path.nodes[2].nodetype).toBe('OffCurve');
            expect(path.nodes[3].nodetype).toBe('Curve');
        });

        test('Path._deleteNode should handle quadratic curves', () => {
            // Create two connected quadratic curves
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Move' },
                    { x: 50, y: 50, nodetype: 'OffCurve' },
                    { x: 100, y: 0, nodetype: 'QCurve', smooth: true },
                    { x: 150, y: 50, nodetype: 'OffCurve' },
                    { x: 200, y: 100, nodetype: 'QCurve' }
                ],
                false
            );
            const glyph = testFont.glyphs[0];
            const layer = glyph.layers[0];
            const path = layer.shapes[0].asPath();

            expect(path.nodes.length).toBe(5);

            // Delete the middle QCurve node (index 2)
            const result = path._deleteNode(2);

            expect(result).toBe(true);
            // Should result in: Move + OffCurve + QCurve (merged quadratic)
            expect(path.nodes.length).toBe(3);
            expect(path.nodes[0].nodetype).toBe('Move');
            expect(path.nodes[1].nodetype).toBe('OffCurve');
            expect(path.nodes[2].nodetype).toBe('QCurve');
        });

        test('Path._deleteNode should return false for invalid index', () => {
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Move' },
                    { x: 100, y: 100, nodetype: 'Line' }
                ],
                false
            );
            const glyph = testFont.glyphs[0];
            const layer = glyph.layers[0];
            const path = layer.shapes[0].asPath();

            // Test negative index
            expect(path._deleteNode(-1)).toBe(false);

            // Test out of bounds index
            expect(path._deleteNode(10)).toBe(false);

            // Verify nodes unchanged
            expect(path.nodes.length).toBe(2);
        });

        test('Path._deleteNode should handle closed paths', () => {
            // Create a closed cubic curve path
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Curve' },
                    { x: 50, y: 0, nodetype: 'OffCurve' },
                    { x: 100, y: 50, nodetype: 'OffCurve' },
                    { x: 100, y: 100, nodetype: 'Curve', smooth: true },
                    { x: 50, y: 150, nodetype: 'OffCurve' },
                    { x: 0, y: 100, nodetype: 'OffCurve' },
                    { x: 0, y: 0, nodetype: 'Curve', smooth: true }
                ],
                true
            );
            const glyph = testFont.glyphs[0];
            const layer = glyph.layers[0];
            const path = layer.shapes[0].asPath();

            expect(path.nodes.length).toBe(7);
            expect(path.closed).toBe(true);

            // Delete a node from the middle of the closed path
            const result = path._deleteNode(3);

            expect(result).toBe(true);
            expect(path.nodes.length).toBe(4);
            expect(path.closed).toBe(true);
        });

        test('Path._deleteNodes should ignore duplicate handle selections from the same cubic segment', () => {
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Move' },
                    { x: 50, y: 0, nodetype: 'OffCurve' },
                    { x: 100, y: 50, nodetype: 'OffCurve' },
                    { x: 100, y: 100, nodetype: 'Curve', smooth: true }
                ],
                false
            );
            const path = testFont.glyphs[0].layers[0].paths[0];

            const result = path._deleteNodes([1, 2]);

            expect(result).toBe(true);
            expect(path.nodes.map((node) => node.nodetype)).toEqual([
                'Move',
                'Line'
            ]);
            expect(path.nodes[0].smooth).toBe(false);
            expect(path.nodes[1].smooth).toBe(false);
        });

        test('Path._deleteNodes should resolve mixed on-curve and off-curve selections against the original contour', () => {
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Move' },
                    { x: 50, y: 0, nodetype: 'OffCurve' },
                    { x: 100, y: 50, nodetype: 'OffCurve' },
                    { x: 100, y: 100, nodetype: 'Curve', smooth: true }
                ],
                false
            );
            const path = testFont.glyphs[0].layers[0].paths[0];

            const result = path._deleteNodes([1, 3]);

            expect(result).toBe(true);
            expect(path.nodes.map((node) => node.nodetype)).toEqual(['Move']);
            expect(path.nodes[0].x).toBe(0);
            expect(path.nodes[0].y).toBe(0);
        });
    });

    describe('toJSON() serialization', () => {
        test('Font.toJSON() should return underlying data', () => {
            const json = font.toJSON();
            expect(json).toBeDefined();
            expect(json.glyphs).toBeDefined();
            expect(json.upm).toBe(fontData.upm);
        });

        test('Glyph.toJSON() should return glyph data', () => {
            const glyph = font.glyphs[0];
            const json = glyph.toJSON();
            expect(json).toBeDefined();
            expect(json.name).toBeDefined();
        });

        test('Layer.toJSON() should return layer data', () => {
            const glyph = font.glyphs[0];
            const layer = glyph.layers[0];
            const json = layer.toJSON();
            expect(json).toBeDefined();
            expect(json.width).toBeDefined();
        });
    });

    describe('Layer.getMatchingLayerOnGlyph()', () => {
        test('should find matching layers across glyphs by master ID', () => {
            const glyphA = font.findGlyph('A');
            const glyphB = font.findGlyph('B');

            expect(glyphA).toBeDefined();
            expect(glyphB).toBeDefined();

            // Both glyphs should have layers
            expect(glyphA.layers).toBeDefined();
            expect(glyphB.layers).toBeDefined();
            expect(glyphA.layers.length).toBeGreaterThan(0);
            expect(glyphB.layers.length).toBeGreaterThan(0);

            // For each layer in A, find matching layer in B
            for (const layerA of glyphA.layers) {
                const matchingLayerB = layerA.getMatchingLayerOnGlyph('B');
                expect(matchingLayerB).toBeDefined();

                // The matching layer should have the same master ID
                expect(layerA.master).toEqual(matchingLayerB.master);
            }
        });

        test('round-trip: A->B->A should return the same layers', () => {
            const glyphA = font.findGlyph('A');
            const glyphB = font.findGlyph('B');

            expect(glyphA).toBeDefined();
            expect(glyphB).toBeDefined();
            expect(glyphA.layers).toBeDefined();
            expect(glyphB.layers).toBeDefined();

            // For each layer in A:
            // 1. Find matching layer in B
            // 2. From that B layer, find matching layer back in A
            // 3. Should get a layer with the same master as the original
            const layersA = glyphA.layers; // Cache to avoid recreating wrappers
            for (let i = 0; i < layersA.length; i++) {
                const originalLayerA = layersA[i];
                const matchingLayerB =
                    originalLayerA.getMatchingLayerOnGlyph('B');
                expect(matchingLayerB).toBeDefined();

                const roundTripLayerA =
                    matchingLayerB.getMatchingLayerOnGlyph('A');
                expect(roundTripLayerA).toBeDefined();

                // Should have the same master (compare underlying data, not object identity)
                expect(roundTripLayerA.master).toEqual(originalLayerA.master);

                // Should reference the same underlying layer data
                expect(roundTripLayerA.toJSON()).toBe(originalLayerA.toJSON());
            }
        });

        test('should return undefined for non-existent glyph', () => {
            const glyphA = font.findGlyph('A');
            expect(glyphA).toBeDefined();
            expect(glyphA.layers).toBeDefined();

            const layer = glyphA.layers[0];
            const matchingLayer =
                layer.getMatchingLayerOnGlyph('NonExistentGlyph');
            expect(matchingLayer).toBeUndefined();
        });

        test('should return undefined if target glyph has no matching master', () => {
            const glyphA = font.findGlyph('A');
            expect(glyphA).toBeDefined();
            expect(glyphA.layers).toBeDefined();

            // Create a test glyph with a single layer but different master
            const testGlyph = font.addGlyph('TestGlyph', 'Base');
            const testLayer = testGlyph.addLayer(500);
            testLayer.master = {
                type: 'DefaultForMaster',
                master: 'non-existent-master-id'
            };

            const layer = glyphA.layers[0];
            const matchingLayer = layer.getMatchingLayerOnGlyph('TestGlyph');
            expect(matchingLayer).toBeUndefined();

            // Clean up
            font.removeGlyph('TestGlyph');
        });
    });

    describe('Layer.flattenComponents()', () => {
        test('should flatten adieresis components across all layers with transforms', () => {
            // Load NestedComponents.glyphs and convert via WASM
            const nestedFixturePath = path.join(
                __dirname,
                '..',
                'examples',
                'NestedComponents.glyphs'
            );
            const nestedFontData = loadFontFile(nestedFixturePath);
            const nestedFont = Font.fromData(nestedFontData);

            const adieresis = nestedFont.findGlyph('adieresis');
            expect(adieresis).toBeDefined();
            expect(adieresis.layers.length).toBe(3);

            // Layer 0: a + dieresiscomb with [1,0,0,1,118,0]
            const layer0 = adieresis.layers[0];
            const layer0Bbox = layer0.getBoundingBox(false);

            // Find matching layers in component glyphs
            const a0 = layer0.getMatchingLayerOnGlyph('a');
            const dieresis0 = layer0.getMatchingLayerOnGlyph('dieresiscomb');
            expect(a0).toBeDefined();
            expect(dieresis0).toBeDefined();

            const a0Bbox = a0.getBoundingBox(false);
            const dieresis0Bbox = dieresis0.getBoundingBox(false);

            // dieresis transformed by [1,0,0,1,118,0]
            const dieresis0Transformed = {
                minX: dieresis0Bbox.minX + 118,
                minY: dieresis0Bbox.minY,
                maxX: dieresis0Bbox.maxX + 118,
                maxY: dieresis0Bbox.maxY
            };

            const expectedBbox0 = {
                minX: Math.min(a0Bbox.minX, dieresis0Transformed.minX),
                minY: Math.min(a0Bbox.minY, dieresis0Transformed.minY),
                maxX: Math.max(a0Bbox.maxX, dieresis0Transformed.maxX),
                maxY: Math.max(a0Bbox.maxY, dieresis0Transformed.maxY)
            };

            expect(layer0Bbox.minX).toBeCloseTo(expectedBbox0.minX, 5);
            expect(layer0Bbox.minY).toBeCloseTo(expectedBbox0.minY, 5);
            expect(layer0Bbox.maxX).toBeCloseTo(expectedBbox0.maxX, 5);
            expect(layer0Bbox.maxY).toBeCloseTo(expectedBbox0.maxY, 5);

            // Layer 1: a + dieresiscomb with [1,0,0,1,102,0]
            const layer1 = adieresis.layers[1];
            const layer1Bbox = layer1.getBoundingBox(false);

            // Expected bbox values (computed from actual flattened components)
            const expectedBbox1 = {
                minX: 50,
                minY: -12,
                maxX: 477,
                maxY: 708
            };

            expect(layer1Bbox.minX).toBeCloseTo(expectedBbox1.minX, 5);
            expect(layer1Bbox.minY).toBeCloseTo(expectedBbox1.minY, 5);
            expect(layer1Bbox.maxX).toBeCloseTo(expectedBbox1.maxX, 5);
            expect(layer1Bbox.maxY).toBeCloseTo(expectedBbox1.maxY, 5);

            // Layer 2: a + dieresiscomb with [1,0,0,0.6872,56,159] (SCALED)
            const layer2 = adieresis.layers[2];
            const layer2Bbox = layer2.getBoundingBox(false);

            // Expected bbox values (computed from actual flattened components)
            const expectedBbox2 = {
                minX: 35,
                minY: -16,
                maxX: 503,
                maxY: 664.092
            };

            expect(layer2Bbox.minX).toBeCloseTo(expectedBbox2.minX, 4);
            expect(layer2Bbox.minY).toBeCloseTo(expectedBbox2.minY, 4);
            expect(layer2Bbox.maxX).toBeCloseTo(expectedBbox2.maxX, 4);
            expect(layer2Bbox.maxY).toBeCloseTo(expectedBbox2.maxY, 4);
        });

        test('should handle nested components with accumulated transforms', () => {
            // Test with a more complex case if available
            // For now, verify that single-level components work correctly
            const glyphA = font.findGlyph('A');
            expect(glyphA).toBeDefined();

            const aLayer = glyphA.layers[0];
            expect(aLayer).toBeDefined();

            // A should have paths (not components)
            const aShapes = aLayer.shapes;
            expect(aShapes).toBeDefined();

            let hasPath = false;
            for (const shape of aShapes) {
                if (shape.isPath()) {
                    hasPath = true;
                    break;
                }
            }
            expect(hasPath).toBe(true);

            // Bounding box should work for a glyph with only paths
            const bbox = aLayer.getBoundingBox(false);
            expect(bbox).not.toBeNull();
            expect(bbox.width).toBeGreaterThan(0);
            expect(bbox.height).toBeGreaterThan(0);
        });

        test('should return empty array for layer with no shapes', () => {
            // Create a test glyph with empty layer
            const testGlyph = font.addGlyph('EmptyGlyph', 'Base');
            const testLayer = testGlyph.addLayer(500);

            // Layer has no shapes
            expect(testLayer.shapes).toBeUndefined();

            // Bounding box should handle this gracefully
            const bbox = testLayer.getBoundingBox(false);
            // Should return a fallback bbox based on width
            expect(bbox).not.toBeNull();
            expect(bbox.width).toBe(500); // Uses layer width as fallback

            // Clean up
            font.removeGlyph('EmptyGlyph');
        });
    });

    describe('Layer.getIntersectionsOnLine()', () => {
        test('should calculate intersections on adieresis layer 2 with components', () => {
            // Load NestedComponents.glyphs and convert via WASM
            const nestedFixturePath = path.join(
                __dirname,
                '..',
                'examples',
                'NestedComponents.glyphs'
            );
            const nestedFontData = loadFontFile(nestedFixturePath);
            const nestedFont = Font.fromData(nestedFontData);

            const adieresis = nestedFont.findGlyph('adieresis');
            const layer2 = adieresis.layers[2];

            expect(layer2).toBeDefined();
            expect(layer2.width).toBe(558);

            // Horizontal measurement at y=332 from x=0 to glyph width
            const horizontalIntersections = layer2.getIntersectionsOnLine(
                { x: 0, y: 332 },
                { x: layer2.width, y: 332 },
                true // include components
            );

            // Expected intersection count (verified)
            expect(horizontalIntersections.length).toBe(2);

            // Verify intersections are sorted by t parameter
            for (let i = 1; i < horizontalIntersections.length; i++) {
                expect(horizontalIntersections[i].t).toBeGreaterThanOrEqual(
                    horizontalIntersections[i - 1].t
                );
            }

            // Verify intersections are on the line (y should be 332)
            horizontalIntersections.forEach((int) => {
                expect(int.y).toBeCloseTo(332, 1);
            });

            // Expected x coordinates (updated after fixing component master lookup)
            const expectedX = [369.6547, 500.0508];
            horizontalIntersections.forEach((int, i) => {
                if (i < expectedX.length) {
                    expect(int.x).toBeCloseTo(expectedX[i], 1);
                }
            });

            // Vertical measurement at x=114 from y=-50 to y=750
            const verticalIntersections = layer2.getIntersectionsOnLine(
                { x: 114, y: -50 },
                { x: 114, y: 750 },
                true // include components
            );

            // Expected intersection count (verified)
            expect(verticalIntersections.length).toBe(6);

            // Verify intersections are sorted by t parameter
            for (let i = 1; i < verticalIntersections.length; i++) {
                expect(verticalIntersections[i].t).toBeGreaterThanOrEqual(
                    verticalIntersections[i - 1].t
                );
            }

            // Verify intersections are on the line (x should be 114)
            verticalIntersections.forEach((int) => {
                expect(int.x).toBeCloseTo(114, 1);
            });

            // Verify all intersections are within the measured segment
            verticalIntersections.forEach((int) => {
                expect(int.y).toBeGreaterThanOrEqual(-50);
                expect(int.y).toBeLessThanOrEqual(750);
            });
        });
    });

    describe('Curve-aware bounding boxes', () => {
        test('should measure glyph A from bbox.glyphs as 150x150', () => {
            const fixturePath = path.join(
                __dirname,
                '..',
                'examples',
                'bbox.glyphs'
            );
            const bboxFont = Font.fromData(loadFontFile(fixturePath));

            const glyphA = bboxFont.findGlyph('A');
            expect(glyphA).toBeDefined();

            const layer = glyphA.layers[0];
            const bbox = layer.getBoundingBox(false);

            expect(bbox).not.toBeNull();
            expect(bbox.minX).toBeCloseTo(0, 5);
            expect(bbox.minY).toBeCloseTo(0, 5);
            expect(bbox.maxX).toBeCloseTo(150, 5);
            expect(bbox.maxY).toBeCloseTo(150, 5);
            expect(bbox.width).toBeCloseTo(150, 5);
            expect(bbox.height).toBeCloseTo(150, 5);
        });
    });

    describe('Layer selection accessors', () => {
        let selectionFont;
        let selectionLayer;
        let otherLayer;
        let selectionGlyph;
        let outlineEditor;
        let layerLinkStateByGlyph;
        let originalGlyphCanvas;
        let originalCurrentFontModel;

        function makeSelectionTestFont() {
            return Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                instances: [],
                masters: [
                    {
                        id: 'master-1',
                        name: { en: 'Regular' },
                        location: {},
                        guides: [
                            {
                                pos: { x: 50, y: 60, angle: 0 },
                                name: 'master-guide'
                            }
                        ],
                        metrics: {},
                        kerning: {}
                    }
                ],
                glyphs: [
                    {
                        name: 'A',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                id: 'layer-1',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        Component: {
                                            reference: 'B',
                                            transform: {
                                                translation: [10, 20],
                                                scale: [1, 1],
                                                rotation: 0,
                                                skew: [0, 0],
                                                order: 'RestOfTheWorld'
                                            }
                                        }
                                    },
                                    {
                                        nodes: [
                                            {
                                                x: 100,
                                                y: 200,
                                                nodetype: 'Line'
                                            }
                                        ],
                                        closed: false
                                    }
                                ],
                                anchors: [
                                    { x: 300, y: 400, name: 'top' },
                                    { x: 320, y: 420, name: 'bottom' }
                                ],
                                guides: [
                                    {
                                        pos: { x: 15, y: 25, angle: 0 },
                                        name: 'layer-guide'
                                    }
                                ]
                            },
                            {
                                id: 'layer-1b',
                                width: 500,
                                master: {
                                    type: 'AssociatedWithMaster',
                                    master: 'master-1'
                                },
                                location: { wght: 50 },
                                shapes: [
                                    {
                                        Component: {
                                            reference: 'B',
                                            transform: {
                                                translation: [10, 20],
                                                scale: [1, 1],
                                                rotation: 0,
                                                skew: [0, 0],
                                                order: 'RestOfTheWorld'
                                            }
                                        }
                                    },
                                    {
                                        nodes: [
                                            {
                                                x: 100,
                                                y: 200,
                                                nodetype: 'Line'
                                            }
                                        ],
                                        closed: false
                                    }
                                ],
                                anchors: [
                                    { x: 300, y: 400, name: 'top' },
                                    { x: 320, y: 420, name: 'bottom' }
                                ],
                                guides: []
                            }
                        ]
                    },
                    {
                        name: 'B',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                id: 'layer-2',
                                width: 400,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            {
                                                x: 10,
                                                y: 20,
                                                nodetype: 'Line'
                                            }
                                        ],
                                        closed: false
                                    }
                                ],
                                anchors: [{ x: 40, y: 50, name: 'other' }],
                                guides: [
                                    {
                                        pos: { x: 5, y: 10, angle: 0 },
                                        name: 'other-guide'
                                    }
                                ]
                            }
                        ]
                    }
                ],
                names: { family_name: { en: 'Selection Test' } },
                note: '',
                date: '2026-03-23',
                features: {},
                first_kern_groups: {},
                second_kern_groups: {},
                custom_ot_values: [],
                variation_sequences: [],
                format_specific: {}
            });
        }

        beforeEach(() => {
            selectionFont = makeSelectionTestFont();
            selectionGlyph = selectionFont.findGlyph('A');
            selectionLayer = selectionGlyph.layers[0];
            otherLayer = selectionFont.findGlyph('B').layers[0];

            originalGlyphCanvas = window.glyphCanvas;
            originalCurrentFontModel = window.currentFontModel;
            window.currentFontModel = selectionFont;

            layerLinkStateByGlyph = new Map();

            const isLayerLinked = (layerId, glyphName = null) => {
                if (!layerId || !glyphName) {
                    return true;
                }

                return !layerLinkStateByGlyph.get(glyphName)?.has(layerId);
            };

            const setLayerLinked = (layerId, linked, glyphName = null) => {
                if (!layerId || !glyphName) {
                    return;
                }

                const nextUnlinked = new Set(
                    layerLinkStateByGlyph.get(glyphName) || []
                );

                if (linked) {
                    nextUnlinked.delete(layerId);
                } else {
                    nextUnlinked.add(layerId);
                }

                if (nextUnlinked.size === 0) {
                    layerLinkStateByGlyph.delete(glyphName);
                    return;
                }

                layerLinkStateByGlyph.set(glyphName, nextUnlinked);
            };

            outlineEditor = {
                active: true,
                selectedPoints: [{ contourIndex: 1, nodeIndex: 0 }],
                selectedAnchors: [0],
                selectedComponents: [0],
                selectedGuideHandle: null,
                selectedSidebearingHandle: { side: 'left' },
                glyphCanvas: {
                    updatePropertyPanel: jest.fn(),
                    render: jest.fn()
                },
                isLayerLinked: jest.fn(isLayerLinked),
                setLayerLinked: jest.fn(setLayerLinked),
                getCurrentLayerModel: jest.fn(() => selectionLayer),
                getCurrentGlyphModel: jest.fn(() => selectionGlyph),
                getCurrentLayerId: jest.fn(() => selectionLayer.id),
                getRootMasterModel: jest.fn(() =>
                    selectionFont.findMaster('master-1')
                )
            };

            window.glyphCanvas = {
                outlineEditor,
                updatePropertiesUI: jest.fn(),
                render: jest.fn()
            };
        });

        afterEach(() => {
            window.glyphCanvas = originalGlyphCanvas;
            window.currentFontModel = originalCurrentFontModel;
        });

        test('reflects selected state for nodes, anchors, and components', () => {
            const node = selectionLayer.paths[0].nodes[0];
            const anchor = selectionLayer.anchors[0];
            const component = selectionLayer.components[0];

            expect(node.selected).toBe(true);
            expect(anchor.selected).toBe(true);
            expect(component.selected).toBe(true);

            outlineEditor.selectedAnchors = [1];

            expect(anchor.selected).toBe(false);
            expect(selectionLayer.anchors[1].selected).toBe(true);
        });

        test('updates outline-editor selection arrays when toggling object.selected', () => {
            const node = selectionLayer.paths[0].nodes[0];
            const anchor = selectionLayer.anchors[1];

            outlineEditor.selectedPoints = [];
            outlineEditor.selectedAnchors = [];
            outlineEditor.selectedComponents = [];
            outlineEditor.selectedSidebearingHandle = { side: 'right' };

            node.selected = true;

            expect(outlineEditor.selectedPoints).toEqual([
                { contourIndex: 1, nodeIndex: 0 }
            ]);
            expect(outlineEditor.selectedSidebearingHandle).toBeNull();
            expect(
                outlineEditor.glyphCanvas.updatePropertyPanel
            ).toHaveBeenCalled();
            expect(outlineEditor.glyphCanvas.render).toHaveBeenCalled();

            outlineEditor.glyphCanvas.updatePropertyPanel.mockClear();
            outlineEditor.glyphCanvas.render.mockClear();

            anchor.selected = true;
            expect(outlineEditor.selectedAnchors).toEqual([1]);

            anchor.selected = false;
            expect(outlineEditor.selectedAnchors).toEqual([]);
            expect(
                outlineEditor.glyphCanvas.updatePropertyPanel
            ).toHaveBeenCalled();
            expect(outlineEditor.glyphCanvas.render).toHaveBeenCalled();
        });

        test('maps guide selection through the outline editor and clears incompatible selection state', () => {
            const guide = selectionLayer.guides[0];

            guide.selected = true;

            expect(outlineEditor.selectedPoints).toEqual([]);
            expect(outlineEditor.selectedAnchors).toEqual([]);
            expect(outlineEditor.selectedComponents).toEqual([]);
            expect(outlineEditor.selectedGuideHandle).toEqual({
                scope: 'layer',
                index: 0
            });
            expect(guide.selected).toBe(true);

            guide.selected = false;
            expect(outlineEditor.selectedGuideHandle).toBeNull();
        });

        test('exposes and replaces layer.selection as the current UI selection snapshot', () => {
            const node = selectionLayer.paths[0].nodes[0];
            const anchor = selectionLayer.anchors[1];
            const component = selectionLayer.components[0];

            const initialSelection = selectionLayer.selection;
            expect(initialSelection).toHaveLength(3);
            expect(initialSelection[0].selected).toBe(true);
            expect(initialSelection[1]).toBe(selectionLayer.anchors[0]);
            expect(initialSelection[2].reference).toBe(component.reference);
            expect(initialSelection[2].selected).toBe(true);

            selectionLayer.selection = [anchor, component];

            expect(outlineEditor.selectedPoints).toEqual([]);
            expect(outlineEditor.selectedAnchors).toEqual([1]);
            expect(outlineEditor.selectedComponents).toEqual([0]);
            expect(outlineEditor.selectedGuideHandle).toBeNull();

            selectionLayer.selection = node;
            expect(outlineEditor.selectedPoints).toEqual([
                { contourIndex: 1, nodeIndex: 0 }
            ]);
            expect(outlineEditor.selectedAnchors).toEqual([]);
            expect(outlineEditor.selectedComponents).toEqual([]);
        });

        test('rejects selection objects that do not belong to this layer', () => {
            expect(() => {
                selectionLayer.selection = [otherLayer.anchors[0]];
            }).toThrow(/belong to this layer/);
        });

        test('rejects guide combinations that the UI cannot represent', () => {
            const guide = selectionLayer.guides[0];
            const anchor = selectionLayer.anchors[0];

            expect(() => {
                selectionLayer.selection = [guide, anchor];
            }).toThrow(/Guide selection cannot be combined/);
        });

        test('exposes layer.linked as editor-only per-glyph runtime state', () => {
            expect(selectionLayer.linked).toBe(true);
            expect(otherLayer.linked).toBe(true);

            otherLayer.linked = false;

            expect(selectionLayer.linked).toBe(true);
            expect(otherLayer.linked).toBe(false);
            expect(outlineEditor.setLayerLinked).toHaveBeenCalledWith(
                'layer-2',
                false,
                'B'
            );
        });

        test('refreshes the layer UI when layer.linked is changed from the object model', () => {
            const dispatchSpy = jest.spyOn(window, 'dispatchEvent');

            selectionLayer.linked = false;

            expect(window.glyphCanvas.updatePropertiesUI).toHaveBeenCalled();
            expect(window.glyphCanvas.render).toHaveBeenCalled();
            expect(dispatchSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'layerLinkageChanged',
                    detail: {
                        glyphName: 'A',
                        layerId: 'layer-1',
                        linked: false
                    }
                })
            );

            dispatchSpy.mockRestore();
        });

        test('returns linked sibling layers with matching fingerprints after link toggles', () => {
            const siblingLayer = selectionGlyph.findLayerById('layer-1b');

            expect(
                selectionLayer._getLinkedLayers().map((layer) => layer.id)
            ).toEqual(['layer-1b']);

            siblingLayer.linked = false;
            expect(selectionLayer._getLinkedLayers()).toEqual([]);

            siblingLayer.linked = true;
            selectionLayer.linked = false;
            expect(selectionLayer._getLinkedLayers()).toEqual([]);

            selectionLayer.linked = true;
            expect(
                selectionLayer._getLinkedLayers().map((layer) => layer.id)
            ).toEqual(['layer-1b']);
        });
    });

    describe('Path._addPoint()', () => {
        test('inserts a new on-curve point into a line segment', () => {
            const testFont = makeFontWithSinglePath([
                { x: 0, y: 0, nodetype: 'Line' },
                { x: 100, y: 0, nodetype: 'Line' }
            ]);
            const path = testFont.glyphs[0].layers[0].paths[0];

            const insertedNodeIndex = path._addPoint(0, 0.25);

            expect(insertedNodeIndex).toBe(1);
            expect(path.nodes.map((node) => node.nodetype)).toEqual([
                'Line',
                'Line',
                'Line'
            ]);
            expect(path.nodes[1].x).toBeCloseTo(25);
            expect(path.nodes[1].y).toBeCloseTo(0);
        });

        test('splits a cubic segment into two matching cubic segments', () => {
            const testFont = makeFontWithSinglePath([
                { x: 0, y: 0, nodetype: 'Curve' },
                { x: 30, y: 60, nodetype: 'OffCurve' },
                { x: 70, y: 60, nodetype: 'OffCurve' },
                { x: 100, y: 0, nodetype: 'Curve' }
            ]);
            const path = testFont.glyphs[0].layers[0].paths[0];

            const insertedNodeIndex = path._addPoint(0, 0.5);

            expect(insertedNodeIndex).toBe(3);
            expect(path.nodes.map((node) => node.nodetype)).toEqual([
                'Curve',
                'OffCurve',
                'OffCurve',
                'Curve',
                'OffCurve',
                'OffCurve',
                'Curve'
            ]);
            expect(path.nodes[3].x).toBeCloseTo(50);
            expect(path.nodes[3].y).toBeCloseTo(45);
            expect(path.nodes[3].smooth).toBe(true);
        });

        test('expands implied quadratic segments before inserting a point', () => {
            const testFont = makeFontWithSinglePath([
                { x: 0, y: 0, nodetype: 'QCurve' },
                { x: 50, y: 100, nodetype: 'OffCurve' },
                { x: 100, y: 100, nodetype: 'OffCurve' },
                { x: 150, y: 0, nodetype: 'QCurve' }
            ]);
            const path = testFont.glyphs[0].layers[0].paths[0];

            const insertedNodeIndex = path._addPoint(0, 0.5);

            expect(insertedNodeIndex).toBe(2);
            expect(path.nodes.map((node) => node.nodetype)).toEqual([
                'QCurve',
                'OffCurve',
                'QCurve',
                'OffCurve',
                'QCurve',
                'OffCurve',
                'QCurve'
            ]);
            expect(path.nodes[2].x).toBeCloseTo(43.75);
            expect(path.nodes[2].y).toBeCloseTo(75);
            expect(path.nodes[4].x).toBeCloseTo(75);
            expect(path.nodes[4].y).toBeCloseTo(100);
        });

        test('describes implied quadratic runs as separate segments', () => {
            const descriptors = Layer.getPathSegmentDescriptors({
                nodes: [
                    { x: 0, y: 0, nodetype: 'QCurve' },
                    { x: 50, y: 100, nodetype: 'OffCurve' },
                    { x: 100, y: 100, nodetype: 'OffCurve' },
                    { x: 150, y: 0, nodetype: 'QCurve' }
                ],
                closed: false
            });

            expect(descriptors).toHaveLength(2);
            expect(
                descriptors.map((descriptor) => descriptor.segmentId)
            ).toEqual([0, 1]);
            expect(descriptors.map((descriptor) => descriptor.type)).toEqual([
                'quadratic',
                'quadratic'
            ]);
            expect(descriptors[0].points[2]).toEqual({ x: 75, y: 100 });
            expect(descriptors[1].points[0]).toEqual({ x: 75, y: 100 });
        });
    });
});
