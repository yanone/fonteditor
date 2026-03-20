const fs = require('fs');
const path = require('path');
const { Font } = require('../js/babelfont-model');
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

        test('should have shapes array', () => {
            if (layer.shapes) {
                expect(Array.isArray(layer.shapes)).toBe(true);
            }
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
});
