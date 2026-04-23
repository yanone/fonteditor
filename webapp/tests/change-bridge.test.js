/**
 * Comprehensive tests for ChangeBridge, Y.Doc sync, and WindowSync.
 *
 * Verifies that every property setter in the babelfont model correctly
 * records a change via the ChangeBridge, that the Y.Doc reflects the
 * change at the right path, and that undo/redo, transactions, and
 * cross-window sync all work as expected.
 */

const Y = require('yjs');
const { ChangeBridge } = require('../js/change-bridge');
const { WindowSync } = require('../js/window-sync');
const {
    jsonToYDoc,
    yDocToJson,
    getYPath,
    setYPath,
    deleteYPath,
    setJsonPath,
    deleteJsonPath,
    getJsonPath,
    sanitizeBabelfontArrays
} = require('../js/change-bridge-ydoc');
const {
    buildHistoryStackItems,
    createLogEntry,
    resetLogCounter,
    deriveGlyphName,
    deriveGlyphNameFromPath,
    deriveLayerIdFromPath,
    deriveObjectInfo,
    deriveObjectInfoFromPath,
    normalizeChangeLogEntry,
    resolveHistoryTargetItemId
} = require('../js/change-log');
const { Font, withSuppressedModelRecording } = require('../js/babelfont-model');

// ── Helpers ──────────────────────────────────────────────────────────

/** Minimal babelfont JSON fixture for testing */
function makeMinimalFont() {
    return {
        upm: 1000,
        version: [1, 0],
        note: '',
        date: '2024-01-01',
        names: { familyName: 'TestFont' },
        custom_ot_values: [{ tag: 'head', value: 1 }],
        variation_sequences: { 65: { 65024: 'A.alt' } },
        features: {
            classes: {
                Uppercase: {
                    code: '@Uppercase = [A B];',
                    automatic: false,
                    format_specific: { seed: true }
                }
            },
            prefixes: {
                global: {
                    code: 'lookupflag 0;',
                    automatic: false,
                    format_specific: { seed: true }
                }
            },
            features: [
                [
                    'liga',
                    {
                        code: 'sub f i by fi;',
                        automatic: false,
                        format_specific: { seed: true }
                    }
                ]
            ],
            include_paths: ['features']
        },
        first_kern_groups: { A: ['A'] },
        second_kern_groups: { V: ['V'] },
        format_specific: { seed: true },
        source: '',
        axes: [
            {
                name: 'Weight',
                tag: 'wght',
                id: 'weight-axis',
                min: 100,
                max: 900,
                default: 400,
                map: [[100, 100]],
                hidden: false,
                values: [100, 400, 900],
                format_specific: { seed: true }
            }
        ],
        masters: [
            {
                name: 'Regular',
                id: 'master-regular',
                location: { wght: 400 },
                guides: [
                    {
                        pos: 500,
                        name: 'x-height',
                        color: '#00AA88',
                        format_specific: { seed: true }
                    }
                ],
                metrics: { xHeight: 500 },
                kerning: { A: { V: -80 } },
                custom_ot_values: [{ tag: 'OS/2', value: 1 }],
                format_specific: { seed: true }
            }
        ],
        instances: [
            {
                id: 'instance-regular',
                name: 'Regular',
                location: { wght: 400 },
                custom_names: { postscriptName: 'TestFont-Regular' },
                variable: false,
                linked_style: 'Regular',
                format_specific: { seed: true }
            }
        ],
        glyphs: [
            {
                name: 'A',
                production_name: 'A',
                category: 'Base',
                codepoints: [65],
                exported: true,
                direction: 'LTR',
                format_specific: { seed: true },
                layers: [
                    {
                        id: 'layer-1',
                        name: 'Regular',
                        width: 600,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-regular'
                        },
                        smart_component_location: { wght: 0 },
                        color: '#112233',
                        layer_index: 0,
                        is_background: false,
                        background_layer_id: 'layer-1-bg',
                        location: { wght: 400 },
                        format_specific: { seed: true },
                        shapes: [
                            {
                                nodes: [
                                    {
                                        x: 100,
                                        y: 0,
                                        nodetype: 'line',
                                        smooth: false
                                    },
                                    {
                                        x: 300,
                                        y: 700,
                                        nodetype: 'line',
                                        smooth: false
                                    },
                                    {
                                        x: 500,
                                        y: 0,
                                        nodetype: 'line',
                                        smooth: false
                                    }
                                ],
                                closed: true,
                                format_specific: { seed: true }
                            },
                            {
                                reference: 'B',
                                transform: {
                                    translation: [10, 20],
                                    scale: [1, 1],
                                    rotation: 0,
                                    skew: [0, 0],
                                    order: 'RestOfTheWorld'
                                },
                                location: { wght: 400 },
                                format_specific: { seed: true }
                            }
                        ],
                        anchors: [
                            {
                                x: 300,
                                y: 750,
                                name: 'top',
                                format_specific: {}
                            }
                        ],
                        guides: [
                            {
                                pos: 700,
                                name: 'cap-height',
                                color: '#AA5500',
                                format_specific: { seed: true }
                            }
                        ]
                    }
                ]
            },
            {
                name: 'B',
                production_name: 'B',
                category: 'Base',
                codepoints: [66],
                exported: true,
                direction: 'LTR',
                format_specific: { seed: true },
                layers: [
                    {
                        id: 'layer-2',
                        name: 'Regular',
                        width: 650,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-regular'
                        },
                        smart_component_location: { wght: 0 },
                        color: '#334455',
                        layer_index: 0,
                        is_background: false,
                        background_layer_id: 'layer-2-bg',
                        location: { wght: 400 },
                        format_specific: { seed: true },
                        shapes: [
                            {
                                nodes: [
                                    {
                                        x: 80,
                                        y: 0,
                                        nodetype: 'line',
                                        smooth: false
                                    },
                                    {
                                        x: 80,
                                        y: 700,
                                        nodetype: 'line',
                                        smooth: false
                                    }
                                ],
                                closed: true,
                                format_specific: { seed: true }
                            }
                        ],
                        anchors: [],
                        guides: []
                    }
                ]
            }
        ]
    };
}

function makeThreeMasterThreeLayerFont() {
    const font = makeMinimalFont();
    font.masters = [
        {
            ...font.masters[0],
            id: 'master-extrathin',
            name: 'ExtraThin',
            location: { wght: 100 }
        },
        {
            ...font.masters[0],
            id: 'master-regular',
            name: 'Regular',
            location: { wght: 400 }
        },
        {
            ...font.masters[0],
            id: 'master-bold',
            name: 'Bold',
            location: { wght: 700 }
        }
    ];

    font.glyphs[0].layers = [
        {
            ...cloneValue(font.glyphs[0].layers[0]),
            id: 'master-extrathin',
            name: 'ExtraThin',
            master: {
                type: 'DefaultForMaster',
                master: 'master-extrathin'
            },
            layer_index: 0,
            location: { wght: 100 }
        },
        {
            ...cloneValue(font.glyphs[0].layers[0]),
            id: 'master-regular',
            name: 'Regular',
            master: {
                type: 'DefaultForMaster',
                master: 'master-regular'
            },
            layer_index: 1,
            location: { wght: 400 }
        },
        {
            ...cloneValue(font.glyphs[0].layers[0]),
            id: 'master-bold',
            name: 'Bold',
            master: {
                type: 'DefaultForMaster',
                master: 'master-bold'
            },
            layer_index: 2,
            location: { wght: 700 }
        }
    ];

    return font;
}

/**
 * Create a ChangeBridge initialized with a minimal font,
 * plus a Font wrapper for model-level testing.
 */
function createTestBridge(windowId) {
    const fontJson = makeMinimalFont();
    const bridge = new ChangeBridge(windowId);
    bridge.initFromJson(fontJson);
    // Wrap in Font model
    const font = Font.fromData(fontJson);
    // Install bridge on window for model setters to find
    window.changeBridge = bridge;
    return { bridge, font, fontJson };
}

test('array-backed model wrappers serialize the current replaced layer data', () => {
    const fontJson = makeThreeMasterThreeLayerFont();
    const font = Font.fromData(fontJson);
    const layer = font.findGlyph('A').findLayerById('master-extrathin');

    fontJson.glyphs[0].layers[0] = {
        ...fontJson.glyphs[0].layers[0],
        anchors: [{ name: 'top', x: 123, y: 456 }]
    };

    expect(layer.toJSON().anchors[0].x).toBe(123);
    expect(layer.toJSON().anchors[0].y).toBe(456);
});

function flushTimers() {
    jest.runAllTimers();
}

const GENERIC_ACCESSOR_TEST_EXCLUSIONS = new Set([
    'data',
    'lsb',
    'rsb',
    'leftMetricsKey',
    'rightMetricsKey',
    'selected', // UI/editor selection state (Node, Anchor, Component, Guide)
    'linked', // UI/editor layer linkage state
    'selection' // UI/editor selection snapshot on Layer
]);
const GENERIC_MUTABLE_GETTER_EXCLUSIONS = new Set([
    'anchors',
    'axes',
    'components',
    'data',
    'glyphs',
    'guides',
    'instances',
    'layers',
    'lsb',
    'masters',
    'nodes',
    'paths',
    'rsb',
    'shapes',
    'selection' // UI/editor selection snapshot on Layer
]);

function cloneValue(value) {
    if (value === undefined) {
        return undefined;
    }
    return JSON.parse(JSON.stringify(value));
}

function isModelObject(value) {
    return (
        !!value &&
        typeof value === 'object' &&
        typeof value.getPath === 'function' &&
        typeof value.toJSON === 'function'
    );
}

function collectReachableModelObjects(root) {
    const seen = new Set();
    const objects = [];

    function visit(value) {
        if (!isModelObject(value) || seen.has(value)) {
            return;
        }

        seen.add(value);
        objects.push(value);

        let prototype = Object.getPrototypeOf(value);
        while (prototype && prototype !== Object.prototype) {
            const descriptors = Object.getOwnPropertyDescriptors(prototype);

            for (const [name, descriptor] of Object.entries(descriptors)) {
                if (name === 'constructor') {
                    continue;
                }

                try {
                    if (typeof descriptor.get === 'function') {
                        const result = value[name];
                        if (Array.isArray(result)) {
                            result.forEach(visit);
                        } else {
                            visit(result);
                        }
                    }

                    if (
                        typeof descriptor.value === 'function' &&
                        descriptor.value.length === 0 &&
                        (name.startsWith('as') || name.startsWith('get'))
                    ) {
                        const result = descriptor.value.call(value);
                        if (Array.isArray(result)) {
                            result.forEach(visit);
                        } else {
                            visit(result);
                        }
                    }
                } catch (_error) {
                    // Some zero-arg methods are computational helpers; they are
                    // not part of the traversal graph if they throw.
                }
            }

            prototype = Object.getPrototypeOf(prototype);
        }
    }

    visit(root);
    return objects;
}

function collectWritableAccessorSpecs() {
    const font = Font.fromData(makeMinimalFont());
    const specs = new Map();

    for (const object of collectReachableModelObjects(font)) {
        let prototype = Object.getPrototypeOf(object);
        while (prototype && prototype !== Object.prototype) {
            const descriptors = Object.getOwnPropertyDescriptors(prototype);

            for (const [name, descriptor] of Object.entries(descriptors)) {
                if (
                    !descriptor.get ||
                    !descriptor.set ||
                    GENERIC_ACCESSOR_TEST_EXCLUSIONS.has(name)
                ) {
                    continue;
                }

                const path = object.getPath();
                const className = object.constructor.name;
                const key = `${className}:${JSON.stringify(path)}:${name}`;

                if (!specs.has(key)) {
                    specs.set(key, {
                        className,
                        property: name,
                        path,
                        pathLabel: path.length ? path.join('.') : 'font'
                    });
                }
            }

            prototype = Object.getPrototypeOf(prototype);
        }
    }

    return Array.from(specs.values()).sort((left, right) => {
        return (
            left.className.localeCompare(right.className) ||
            left.pathLabel.localeCompare(right.pathLabel) ||
            left.property.localeCompare(right.property)
        );
    });
}

function mutateValue(value) {
    if (value === undefined) {
        return '__test__';
    }

    if (typeof value === 'number') {
        return value + 1;
    }

    if (typeof value === 'string') {
        return value ? `${value}__changed` : 'changed';
    }

    if (typeof value === 'boolean') {
        return !value;
    }

    if (Array.isArray(value)) {
        if (value.length === 0) {
            return [1];
        }

        const next = cloneValue(value);
        next[0] = mutateValue(next[0]);
        return next;
    }

    if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort((left, right) => {
            const leftReserved = left === 'type' || left === 'order';
            const rightReserved = right === 'type' || right === 'order';
            if (leftReserved !== rightReserved) {
                return leftReserved ? 1 : -1;
            }
            return left.localeCompare(right);
        });

        if (keys.length === 0) {
            return { __test: 1 };
        }

        const next = cloneValue(value);
        const key = keys[0];
        next[key] = mutateValue(next[key]);
        return next;
    }

    throw new Error(`Cannot derive mutation for value: ${String(value)}`);
}

function resolveModelObject(font, spec) {
    let current = font;

    for (let index = 0; index < spec.path.length; index += 2) {
        const segment = spec.path[index];
        const value = spec.path[index + 1];

        switch (segment) {
            case 'glyphs':
                current = current.glyphs.find((glyph) => glyph.name === value);
                break;
            case 'layers':
                current = current.layers.find((layer) => layer.id === value);
                break;
            case 'axes':
                current = current.axes[value];
                break;
            case 'masters':
                current = current.masters[value];
                break;
            case 'instances':
                current = current.instances[value];
                break;
            case 'shapes':
                current = current.shapes[value];
                break;
            case 'nodes':
                current = (current.asPath ? current.asPath() : current).nodes[
                    value
                ];
                break;
            case 'anchors':
                current = current.anchors[value];
                break;
            case 'guides':
                current = current.guides[value];
                break;
            default:
                throw new Error(`Unsupported path segment: ${segment}`);
        }
    }

    if (spec.className === 'Path' && current.asPath) {
        return current.asPath();
    }

    if (spec.className === 'Component' && current.asComponent) {
        return current.asComponent();
    }

    return current;
}

function isMutablePlainValue(value) {
    return !!value && typeof value === 'object' && !isModelObject(value);
}

function isArrayOfModelObjects(value) {
    return (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((item) => isModelObject(item))
    );
}

function collectMutableGetterSpecs() {
    const font = Font.fromData(makeMinimalFont());
    const specs = new Map();

    for (const object of collectReachableModelObjects(font)) {
        let prototype = Object.getPrototypeOf(object);
        while (prototype && prototype !== Object.prototype) {
            const descriptors = Object.getOwnPropertyDescriptors(prototype);

            for (const [name, descriptor] of Object.entries(descriptors)) {
                if (
                    !descriptor.get ||
                    GENERIC_MUTABLE_GETTER_EXCLUSIONS.has(name)
                ) {
                    continue;
                }

                const currentValue = object[name];
                if (
                    !isMutablePlainValue(currentValue) ||
                    isArrayOfModelObjects(currentValue)
                ) {
                    continue;
                }

                const path = object.getPath();
                const className = object.constructor.name;
                const key = `${className}:${JSON.stringify(path)}:${name}`;

                if (!specs.has(key)) {
                    specs.set(key, {
                        className,
                        property: name,
                        path,
                        pathLabel: path.length ? path.join('.') : 'font'
                    });
                }
            }

            prototype = Object.getPrototypeOf(prototype);
        }
    }

    return Array.from(specs.values()).sort((left, right) => {
        return (
            left.className.localeCompare(right.className) ||
            left.pathLabel.localeCompare(right.pathLabel) ||
            left.property.localeCompare(right.property)
        );
    });
}

const COLLECTION_MUTATOR_TESTS = {
    'Font.addGlyph': {
        isApplicable: () => true,
        invoke: (font) => font.addGlyph('C', 'Base'),
        expectedOp: 'add',
        expectedPathFragment: () => 'glyphs.C'
    },
    'Font.removeGlyph': {
        isApplicable: (font) => !!font.findGlyph('B'),
        invoke: (font) => font.removeGlyph('B'),
        expectedOp: 'remove',
        expectedPathFragment: () => 'glyphs.B'
    },
    'Font.duplicateGlyph': {
        isApplicable: (font) =>
            !!font.findGlyph('A') && !font.findGlyph('A.alt'),
        invoke: (font) => font.duplicateGlyph(font.findGlyph('A'), 'A.alt'),
        expectedOp: 'add',
        expectedPathFragment: () => 'glyphs.A.alt'
    },
    'Glyph.addLayer': {
        isApplicable: (glyph) => glyph.name === 'A',
        invoke: (glyph) =>
            glyph.addLayer(700, {
                type: 'AssociatedWithMaster',
                master: 'master-regular'
            }),
        expectedOp: 'add',
        expectedPathFragment: (glyph, logEntry) =>
            `${glyph.getPath().join('.')}.layers.${logEntry.newValue.id}`
    },
    'Glyph.removeLayer': {
        isApplicable: (glyph) => glyph.name === 'A' && glyph.layers?.length > 0,
        invoke: (glyph) => glyph.removeLayer(0),
        expectedOp: 'remove',
        expectedPathFragment: (glyph, logEntry) =>
            `${glyph.getPath().join('.')}.layers.${logEntry.oldValue.id}`
    },
    'Layer.addPath': {
        isApplicable: (layer) => layer.id === 'layer-1',
        invoke: (layer) => layer.addPath(false),
        expectedOp: 'add',
        expectedPathFragment: (layer, logEntry) =>
            `${layer.getPath().join('.')}.shapes.${findCollectionEntryIndex(layer.data.shapes, logEntry.newValue)}`
    },
    'Layer.addComponent': {
        isApplicable: (layer) => layer.id === 'layer-1',
        invoke: (layer) => layer.addComponent('B'),
        expectedOp: 'add',
        expectedPathFragment: (layer, logEntry) =>
            `${layer.getPath().join('.')}.shapes.${findCollectionEntryIndex(layer.data.shapes, logEntry.newValue)}`
    },
    'Layer.removeShape': {
        isApplicable: (layer) =>
            layer.id === 'layer-1' && layer.shapes?.length > 0,
        invoke: (layer) => layer.removeShape(0),
        expectedOp: 'remove',
        expectedPathFragment: (layer) => `${layer.getPath().join('.')}.shapes.0`
    },
    'Layer.addAnchor': {
        isApplicable: (layer) => layer.id === 'layer-1',
        invoke: (layer) => layer.addAnchor(250, 100, 'bottom'),
        expectedOp: 'add',
        expectedPathFragment: (layer, logEntry) =>
            `${layer.getPath().join('.')}.anchors.${findCollectionEntryIndex(layer.data.anchors, logEntry.newValue)}`
    },
    'Layer.addGuide': {
        isApplicable: (layer) => layer.id === 'layer-1',
        invoke: (layer) => layer.addGuide(450, 'waist', '#00AAFF'),
        expectedOp: 'add',
        expectedPathFragment: (layer, logEntry) =>
            `${layer.getPath().join('.')}.guides.${findCollectionEntryIndex(layer.data.guides, logEntry.newValue)}`
    },
    'Layer.removeAnchor': {
        isApplicable: (layer) =>
            layer.id === 'layer-1' && layer.anchors?.length > 0,
        invoke: (layer) => layer.removeAnchor(0),
        expectedOp: 'remove',
        expectedPathFragment: (layer) =>
            `${layer.getPath().join('.')}.anchors.0`
    },
    'Layer.removeGuide': {
        isApplicable: (layer) =>
            layer.id === 'layer-1' && layer.guides?.length > 0,
        invoke: (layer) => layer.removeGuide(0),
        expectedOp: 'remove',
        expectedPathFragment: (layer) => `${layer.getPath().join('.')}.guides.0`
    },
    'Master.addGuide': {
        isApplicable: (master) => master.id === 'master-regular',
        invoke: (master) => master.addGuide(425, 'mid', '#AA00FF'),
        expectedOp: 'add',
        expectedPathFragment: (master, logEntry) =>
            `${master.getPath().join('.')}.guides.${findCollectionEntryIndex(master.data.guides, logEntry.newValue)}`
    },
    'Master.removeGuide': {
        isApplicable: (master) => master.guides?.length > 0,
        invoke: (master) => master.removeGuide(0),
        expectedOp: 'remove',
        expectedPathFragment: (master) =>
            `${master.getPath().join('.')}.guides.0`
    },
    'Path.insertNode': {
        isApplicable: (path) => path.nodes?.length > 1,
        invoke: (path) => path.insertNode(1, 175, 225, 'Line'),
        expectedOp: 'add',
        expectedPathFragment: (path) => `${path.getPath().join('.')}.nodes.1`
    },
    'Path.removeNode': {
        isApplicable: (path) => path.nodes?.length > 0,
        invoke: (path) => path.removeNode(0),
        expectedOp: 'remove',
        expectedPathFragment: (path) => `${path.getPath().join('.')}.nodes.0`
    },
    'Path.appendNode': {
        isApplicable: (path) => Array.isArray(path.nodes),
        invoke: (path) => path.appendNode(610, 10, 'Line'),
        expectedOp: 'add',
        expectedPathFragment: (path, logEntry) =>
            `${path.getPath().join('.')}.nodes.${findCollectionEntryIndex(path.data.nodes, logEntry.newValue)}`
    }
};

function findCollectionEntryIndex(collection, entry) {
    return collection.findIndex(
        (item) => JSON.stringify(item) === JSON.stringify(entry)
    );
}

function collectCollectionMutatorSpecs() {
    const font = Font.fromData(makeMinimalFont());
    const specs = new Map();

    for (const object of collectReachableModelObjects(font)) {
        let prototype = Object.getPrototypeOf(object);
        while (prototype && prototype !== Object.prototype) {
            const descriptors = Object.getOwnPropertyDescriptors(prototype);

            for (const [name, descriptor] of Object.entries(descriptors)) {
                if (typeof descriptor.value !== 'function') {
                    continue;
                }

                const className = object.constructor.name;
                const mutator =
                    COLLECTION_MUTATOR_TESTS[`${className}.${name}`];
                if (!mutator || !mutator.isApplicable(object)) {
                    continue;
                }

                const path = object.getPath();
                const key = `${className}:${JSON.stringify(path)}:${name}`;

                if (!specs.has(key)) {
                    specs.set(key, {
                        className,
                        method: name,
                        path,
                        pathLabel: path.length ? path.join('.') : 'font'
                    });
                }
            }

            prototype = Object.getPrototypeOf(prototype);
        }
    }

    return Array.from(specs.values()).sort((left, right) => {
        return (
            left.className.localeCompare(right.className) ||
            left.pathLabel.localeCompare(right.pathLabel) ||
            left.method.localeCompare(right.method)
        );
    });
}

function mutateInPlace(value) {
    if (Array.isArray(value)) {
        if (value.length === 0) {
            value.push(1);
            return;
        }

        const nestedIndex = value.findIndex(
            (item) => Array.isArray(item) || isMutablePlainValue(item)
        );
        const targetIndex = nestedIndex >= 0 ? nestedIndex : 0;
        const target = value[targetIndex];

        if (Array.isArray(target) || isMutablePlainValue(target)) {
            mutateInPlace(target);
            return;
        }

        value[targetIndex] = mutateValue(cloneValue(target));
        return;
    }

    if (isMutablePlainValue(value)) {
        const keys = Object.keys(value).sort((left, right) => {
            const leftReserved = left === 'type' || left === 'order';
            const rightReserved = right === 'type' || right === 'order';
            if (leftReserved !== rightReserved) {
                return leftReserved ? 1 : -1;
            }
            return left.localeCompare(right);
        });

        if (keys.length === 0) {
            value.__test = 1;
            return;
        }

        const nestedKey = keys.find((key) => {
            const candidate = value[key];
            return Array.isArray(candidate) || isMutablePlainValue(candidate);
        });
        const targetKey = nestedKey || keys[0];
        const target = value[targetKey];

        if (Array.isArray(target) || isMutablePlainValue(target)) {
            mutateInPlace(target);
            return;
        }

        value[targetKey] = mutateValue(cloneValue(target));
        return;
    }

    throw new Error(
        `Cannot mutate in place for value: ${JSON.stringify(value)}`
    );
}

function normalizeYValue(value) {
    if (value && typeof value.toJSON === 'function') {
        return value.toJSON();
    }
    return value;
}

const GENERIC_ACCESSOR_SPECS = collectWritableAccessorSpecs();
const GENERIC_MUTABLE_GETTER_SPECS = collectMutableGetterSpecs();
const COLLECTION_MUTATOR_SPECS = collectCollectionMutatorSpecs();

// ── Test setup ───────────────────────────────────────────────────────

beforeEach(() => {
    jest.useFakeTimers();
    resetLogCounter();
    window.changeBridge = undefined;
    // Reset BroadcastChannel state
    if (globalThis.__broadcastChannels) {
        globalThis.__broadcastChannels.clear();
    }
});

afterEach(() => {
    if (window.changeBridge) {
        window.changeBridge.destroy();
        window.changeBridge = undefined;
    }
    jest.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────
// 1. change-bridge-ydoc.ts — Y.Doc ↔ JSON round-trip
// ─────────────────────────────────────────────────────────────────────

describe('change-bridge-ydoc', () => {
    test('jsonToYDoc + yDocToJson round-trips a simple font', () => {
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');
        const json = makeMinimalFont();
        doc.transact(() => jsonToYDoc(json, fontMap));

        const result = yDocToJson(fontMap);
        // Glyphs: the Y.Doc stores them by name in a Map, so the order
        // in the output array may differ. Compare as sets.
        expect(result.upm).toBe(1000);
        expect(result.version).toEqual([1, 0]);
        expect(result.axes).toHaveLength(1);
        expect(result.masters).toHaveLength(1);
        expect(result.instances).toHaveLength(1);
        const glyphs = result.glyphs;
        expect(glyphs).toHaveLength(2);
        const glyphNames = glyphs.map((g) => g.name).sort();
        expect(glyphNames).toEqual(['A', 'B']);
    });

    test('glyphs stored as Y.Map keyed by name', () => {
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');
        const json = makeMinimalFont();
        doc.transact(() => jsonToYDoc(json, fontMap));

        const glyphsMap = fontMap.get('glyphs');
        expect(glyphsMap).toBeInstanceOf(Y.Map);
        expect(glyphsMap.get('A')).toBeInstanceOf(Y.Map);
        expect(glyphsMap.get('B')).toBeInstanceOf(Y.Map);
    });

    test('layers stored as Y.Map keyed by id', () => {
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');
        const json = makeMinimalFont();
        doc.transact(() => jsonToYDoc(json, fontMap));

        const glyphA = fontMap.get('glyphs').get('A');
        const layersMap = glyphA.get('layers');
        expect(layersMap).toBeInstanceOf(Y.Map);
        expect(layersMap.get('layer-1')).toBeInstanceOf(Y.Map);
    });

    test('deep format_specific fields round-trip', () => {
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');
        const json = makeMinimalFont();

        json.format_specific = {
            fontMeta: {
                provenance: {
                    source: 'glyphs',
                    flags: [1, 2, 3]
                }
            }
        };
        json.masters[0].format_specific = {
            masterMeta: {
                stems: { h: 80, v: 90 }
            }
        };
        json.glyphs[0].layers[0].format_specific = {
            layerMeta: {
                nested: {
                    foo: 'bar',
                    arr: [{ k: 1 }, { k: 2 }]
                }
            }
        };
        json.glyphs[0].layers[0].shapes[0].format_specific = {
            shapeMeta: {
                isSpecial: true
            }
        };

        doc.transact(() => jsonToYDoc(json, fontMap));
        const result = yDocToJson(fontMap);

        expect(result.format_specific).toEqual(json.format_specific);
        expect(result.masters[0].format_specific).toEqual(
            json.masters[0].format_specific
        );
        expect(result.glyphs[0].layers[0].format_specific).toEqual(
            json.glyphs[0].layers[0].format_specific
        );
        expect(result.glyphs[0].layers[0].shapes[0].format_specific).toEqual(
            json.glyphs[0].layers[0].shapes[0].format_specific
        );
    });

    test('jsonToYDoc + yDocToJson round-trips an associated intermediate layer with canonicalized shapes', () => {
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');
        const json = makeThreeMasterThreeLayerFont();

        json.glyphs[0].layers.splice(2, 0, {
            ...cloneValue(json.glyphs[0].layers[1]),
            id: 'layer-brace-550',
            name: 'Intermediate Layer',
            master: {
                type: 'AssociatedWithMaster',
                master: 'master-regular'
            },
            location: { wght: 550 },
            guides: [
                {
                    pos: 640,
                    name: 'overshoot',
                    color: '#225588',
                    format_specific: { seed: true, source: 'test' }
                }
            ],
            format_specific: {
                seed: true,
                nested: { source: 'brace-layer' }
            },
            shapes: [
                {
                    nodes: [
                        {
                            x: 120,
                            y: 0,
                            nodetype: 'line',
                            smooth: false
                        },
                        {
                            x: 310,
                            y: 690,
                            nodetype: 'line',
                            smooth: false
                        },
                        {
                            x: 500,
                            y: 0,
                            nodetype: 'line',
                            smooth: false
                        }
                    ],
                    closed: true,
                    format_specific: { seed: true, source: 'brace-layer' }
                },
                {
                    reference: 'B',
                    transform: {
                        translation: [15, 25],
                        rotation: 0,
                        scale: [1, 1],
                        skew: 0,
                        tcenter: [0, 0]
                    },
                    location: { wght: 550 },
                    format_specific: { seed: true, source: 'brace-component' }
                }
            ],
            anchors: [
                {
                    x: 305,
                    y: 760,
                    name: 'top',
                    format_specific: { source: 'brace-anchor' }
                }
            ]
        });

        doc.transact(() => jsonToYDoc(json, fontMap));

        const result = yDocToJson(fontMap);
        sanitizeBabelfontArrays(result);
        const braceLayer = result.glyphs[0].layers.find(
            (layer) => layer.id === 'layer-brace-550'
        );

        expect(result.glyphs[0].layers.map((layer) => layer.id)).toEqual(
            expect.arrayContaining([
                'master-extrathin',
                'master-regular',
                'layer-brace-550',
                'master-bold'
            ])
        );
        expect(braceLayer).toMatchObject({
            id: 'layer-brace-550',
            name: 'Intermediate Layer',
            master: {
                type: 'AssociatedWithMaster',
                master: 'master-regular'
            },
            location: { wght: 550 },
            anchors: [
                {
                    x: 305,
                    y: 760,
                    name: 'top',
                    format_specific: { source: 'brace-anchor' }
                }
            ],
            guides: [
                {
                    pos: 640,
                    name: 'overshoot',
                    color: '#225588',
                    format_specific: { seed: true, source: 'test' }
                }
            ],
            format_specific: {
                seed: true,
                nested: { source: 'brace-layer' }
            }
        });
        expect(braceLayer.shapes[0]).toMatchObject({
            closed: true,
            format_specific: { seed: true, source: 'brace-layer' }
        });
        expect(braceLayer.shapes[1]).toMatchObject({
            reference: 'B',
            transform: {
                translation: [15, 25],
                rotation: 0,
                scale: [1, 1],
                skew: [0, 0],
                order: 'RestOfTheWorld'
            },
            location: { wght: 550 },
            format_specific: { seed: true, source: 'brace-component' }
        });
    });

    test('getYPath reads nested values', () => {
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');
        const json = makeMinimalFont();
        doc.transact(() => jsonToYDoc(json, fontMap));

        expect(getYPath(fontMap, ['upm'])).toBe(1000);
        const glyphA = getYPath(fontMap, ['glyphs', 'A']);
        expect(glyphA).toBeInstanceOf(Y.Map);
        expect(getYPath(fontMap, ['glyphs', 'A', 'name'])).toBe('A');
    });

    test('setYPath writes nested values', () => {
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');
        const json = makeMinimalFont();
        doc.transact(() => jsonToYDoc(json, fontMap));

        doc.transact(() => {
            setYPath(fontMap, ['upm'], 2000);
        });
        expect(getYPath(fontMap, ['upm'])).toBe(2000);

        doc.transact(() => {
            setYPath(fontMap, ['glyphs', 'A', 'production_name'], 'uni0041');
        });
        expect(getYPath(fontMap, ['glyphs', 'A', 'production_name'])).toBe(
            'uni0041'
        );
    });

    test('sanitizeBabelfontArrays canonicalizes malformed component transforms', () => {
        const json = makeMinimalFont();
        json.glyphs[0].layers[0].shapes = [
            {
                reference: 'A',
                transform: {
                    translation: [0, 0],
                    rotation: 0,
                    scale: [1, 1],
                    skew: 0,
                    tcenter: [0, 0]
                }
            }
        ];

        const fixCount = sanitizeBabelfontArrays(json);

        expect(fixCount).toBeGreaterThan(0);
        expect(json.glyphs[0].layers[0].shapes[0].transform).toEqual({
            translation: [0, 0],
            rotation: 0,
            scale: [1, 1],
            skew: [0, 0],
            order: 'RestOfTheWorld'
        });
    });

    test('deleteYPath removes keyed entries', () => {
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');
        const json = makeMinimalFont();
        doc.transact(() => jsonToYDoc(json, fontMap));

        doc.transact(() => {
            deleteYPath(fontMap, ['glyphs', 'B']);
        });
        expect(getYPath(fontMap, ['glyphs', 'B'])).toBeUndefined();
        expect(getYPath(fontMap, ['glyphs', 'A'])).toBeInstanceOf(Y.Map);
    });

    test('setJsonPath / getJsonPath / deleteJsonPath work on plain objects', () => {
        const obj = { a: { b: [1, 2, 3] } };
        expect(getJsonPath(obj, ['a', 'b', 1])).toBe(2);

        setJsonPath(obj, ['a', 'b', 1], 99);
        expect(obj.a.b[1]).toBe(99);

        deleteJsonPath(obj, ['a', 'b', 1]);
        expect(obj.a.b).toEqual([1, 3]);
    });
});

// ─────────────────────────────────────────────────────────────────────
// 2. change-log.ts — deriveObjectInfo
// ─────────────────────────────────────────────────────────────────────

describe('change-log', () => {
    test('deriveObjectInfo: font-level property', () => {
        const info = deriveObjectInfo(['upm']);
        expect(info.objectType).toBe('font');
    });

    test('deriveObjectInfo: glyph-level property', () => {
        const info = deriveObjectInfo(['glyphs', 'A', 'name']);
        expect(info.objectType).toBe('glyph');
        expect(info.objectId).toBe('A');
    });

    test('deriveGlyphName: glyph child path', () => {
        expect(
            deriveGlyphName([
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes',
                0,
                'nodes',
                2,
                'x'
            ])
        ).toBe('A');
    });

    test('deriveGlyphName: font path returns null', () => {
        expect(deriveGlyphName(['upm'])).toBeNull();
    });

    test('deriveObjectInfo: layer-level property', () => {
        const info = deriveObjectInfo([
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'width'
        ]);
        expect(info.objectType).toBe('layer');
        expect(info.objectId).toBe('layer-1');
    });

    test('deriveObjectInfo: node-level property', () => {
        const info = deriveObjectInfo([
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'shapes',
            0,
            'nodes',
            2,
            'x'
        ]);
        expect(info.objectType).toBe('node');
    });

    test('deriveObjectInfo: axis-level property', () => {
        const info = deriveObjectInfo(['axes', 0, 'tag']);
        expect(info.objectType).toBe('axis');
        expect(info.objectId).toBe('0');
    });

    test('deriveObjectInfo: master-level property', () => {
        const info = deriveObjectInfo(['masters', 0, 'name']);
        expect(info.objectType).toBe('master');
    });

    test('deriveObjectInfo: instance-level property', () => {
        const info = deriveObjectInfo(['instances', 0, 'name']);
        expect(info.objectType).toBe('instance');
    });

    test('deriveObjectInfo: anchor', () => {
        const info = deriveObjectInfo([
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'anchors',
            0,
            'x'
        ]);
        expect(info.objectType).toBe('anchor');
    });

    test('deriveObjectInfo: guide', () => {
        const info = deriveObjectInfo([
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'guides',
            0,
            'pos'
        ]);
        expect(info.objectType).toBe('guide');
    });

    test('createLogEntry auto-increments id', () => {
        resetLogCounter();
        const e1 = createLogEntry({
            timestamp: 1,
            windowId: 'w',
            windowRoleLabel: 'Main',
            transactionLabel: null,
            transactionId: null,
            op: 'set',
            objectType: 'font',
            objectId: '',
            glyphName: null,
            property: 'upm',
            path: 'upm',
            oldValue: 1000,
            newValue: 2000
        });
        const e2 = createLogEntry({
            timestamp: 2,
            windowId: 'w',
            windowRoleLabel: 'Main',
            transactionLabel: null,
            transactionId: null,
            op: 'set',
            objectType: 'font',
            objectId: '',
            glyphName: null,
            property: 'note',
            path: 'note',
            oldValue: '',
            newValue: 'hi'
        });
        expect(e1.id).toBe(1);
        expect(e2.id).toBe(2);
    });

    test('normalizeChangeLogEntry derives missing glyphName from path', () => {
        const entry = normalizeChangeLogEntry({
            id: 1,
            timestamp: 1,
            windowId: 'w',
            transactionLabel: null,
            transactionId: null,
            op: 'set',
            objectType: 'layer',
            objectId: 'layer-1',
            property: 'width',
            path: 'glyphs.A.layers.layer-1.width',
            oldValue: 600,
            newValue: 700
        });

        expect(entry.glyphName).toBe('A');
        expect(entry.windowRoleLabel).toBe('Window');
        expect(entry.historyAction).toBe('change');
        expect(entry.historyItemId).toBe('history-item-1');
    });

    test('normalizeChangeLogEntry preserves worker replay targets', () => {
        const entry = normalizeChangeLogEntry({
            id: 1,
            timestamp: 1,
            windowId: 'w',
            transactionLabel: null,
            transactionId: null,
            op: 'set',
            path: 'glyphs.A.layers.layer-1.width',
            oldValue: 600,
            newValue: 700,
            workerReplayTargets: [
                { glyphName: 'A', layerId: 'layer-1' },
                { glyphName: 'A', layerId: 'layer-1' }
            ]
        });

        expect(entry.workerReplayTargets).toEqual([
            { glyphName: 'A', layerId: 'layer-1' }
        ]);
    });

    test('buildHistoryStackItems hides undone item and restores it on redo', () => {
        resetLogCounter();
        const changeEntry = createLogEntry({
            timestamp: 1,
            windowId: 'w',
            windowRoleLabel: 'Main',
            historyItemId: 'history-item-1',
            historyAction: 'change',
            transactionLabel: 'Drag',
            transactionId: 1,
            op: 'set',
            objectType: 'glyph',
            objectId: 'A',
            glyphName: 'A',
            property: 'width',
            path: 'glyphs.A.layers.layer-1.width',
            oldValue: 600,
            newValue: 700
        });
        const undoEntry = createLogEntry({
            timestamp: 2,
            windowId: 'w',
            windowRoleLabel: 'Main',
            historyAction: 'undo',
            targetHistoryItemId: 'history-item-1',
            transactionLabel: 'Undo',
            transactionId: null,
            op: 'set',
            objectType: 'glyph',
            objectId: 'A',
            glyphName: 'A',
            property: '',
            path: 'glyphs.A',
            oldValue: undefined,
            newValue: 'undo'
        });

        expect(buildHistoryStackItems([changeEntry])).toHaveLength(1);
        expect(buildHistoryStackItems([changeEntry, undoEntry])).toHaveLength(
            0
        );

        const redoEntry = createLogEntry({
            timestamp: 3,
            windowId: 'w',
            windowRoleLabel: 'Main',
            historyAction: 'redo',
            targetHistoryItemId: 'history-item-1',
            transactionLabel: 'Redo',
            transactionId: null,
            op: 'set',
            objectType: 'glyph',
            objectId: 'A',
            glyphName: 'A',
            property: '',
            path: 'glyphs.A',
            oldValue: undefined,
            newValue: 'redo'
        });

        const items = buildHistoryStackItems([
            changeEntry,
            undoEntry,
            redoEntry
        ]);
        expect(items).toHaveLength(1);
        expect(items[0].lastAction).toBe('redo');
    });

    test('resolveHistoryTargetItemId returns latest active or undone item for scope', () => {
        resetLogCounter();
        const changeEntry = createLogEntry({
            timestamp: 1,
            windowId: 'w',
            windowRoleLabel: 'Main',
            historyItemId: 'history-item-1',
            historyAction: 'change',
            transactionLabel: 'Drag',
            transactionId: 1,
            op: 'set',
            objectType: 'glyph',
            objectId: 'A',
            glyphName: 'A',
            property: 'width',
            path: 'glyphs.A.layers.layer-1.width',
            oldValue: 600,
            newValue: 700
        });
        const undoEntry = createLogEntry({
            timestamp: 2,
            windowId: 'w',
            windowRoleLabel: 'Main',
            historyAction: 'undo',
            targetHistoryItemId: 'history-item-1',
            transactionLabel: 'Undo',
            transactionId: null,
            op: 'set',
            objectType: 'glyph',
            objectId: 'A',
            glyphName: 'A',
            property: '',
            path: 'glyphs.A',
            oldValue: undefined,
            newValue: 'undo'
        });

        expect(resolveHistoryTargetItemId([changeEntry], 'A', 'undo')).toBe(
            'history-item-1'
        );
        expect(
            resolveHistoryTargetItemId([changeEntry, undoEntry], 'A', 'redo')
        ).toBe('history-item-1');
    });

    test('buildHistoryStackItems uses touched layers for layer filtering', () => {
        resetLogCounter();
        const changeEntry = createLogEntry({
            timestamp: 1,
            windowId: 'w',
            windowRoleLabel: 'Main',
            historyItemId: 'history-item-1',
            historyAction: 'change',
            transactionLabel: 'Python script',
            transactionId: 1,
            op: 'set',
            undoScope: 'glyph',
            path: 'glyphs.A.layers.layer-1.note',
            oldValue: '',
            newValue: 'changed'
        });

        expect(
            buildHistoryStackItems([changeEntry], {
                glyphName: 'A',
                layerId: 'layer-1'
            })
        ).toHaveLength(1);
        // Glyph-scoped items appear for all layers of that glyph
        expect(
            buildHistoryStackItems([changeEntry], {
                glyphName: 'A',
                layerId: 'layer-miss'
            })
        ).toHaveLength(1);
    });

    test('buildHistoryStackItems shows font-scoped glyph-touching items in layer history', () => {
        resetLogCounter();
        const fontScopedEntry = createLogEntry({
            timestamp: 1,
            windowId: 'w',
            windowRoleLabel: 'Main',
            historyItemId: 'history-item-1',
            historyAction: 'change',
            transactionLabel: 'Set sidebearing',
            transactionId: 1,
            op: 'set',
            undoScope: 'font',
            path: 'glyphs.A.layers.layer-1.width',
            oldValue: 600,
            newValue: 610
        });

        const layerItems = buildHistoryStackItems([fontScopedEntry], {
            glyphName: 'A',
            layerId: 'layer-1'
        });
        expect(layerItems).toHaveLength(1);
        expect(layerItems[0].undoScope).toBe('font');
    });

    test('path-derived history metadata resolves dotted glyph and layer names', () => {
        resetLogCounter();
        const previousFontModel = window.currentFontModel;
        window.currentFontModel = {
            glyphs: [
                {
                    name: 'behDotless-ar.medi',
                    layers: [{ id: 'layer.regular.v1' }]
                }
            ]
        };

        try {
            const path =
                'glyphs.behDotless-ar.medi.layers.layer.regular.v1.anchors.0.y';
            const entry = createLogEntry({
                timestamp: 1,
                windowId: 'w',
                windowRoleLabel: 'Main',
                historyItemId: 'history-item-1',
                historyAction: 'change',
                transactionLabel: 'Arrow key',
                transactionId: 1,
                op: 'set',
                undoScope: 'layer',
                path,
                oldValue: -96,
                newValue: -95
            });

            expect(deriveGlyphNameFromPath(path)).toBe('behDotless-ar.medi');
            expect(deriveLayerIdFromPath(path)).toBe('layer.regular.v1');
            expect(deriveObjectInfoFromPath(path)).toEqual({
                objectType: 'anchor',
                objectId: 'behDotless-ar.medi/layer.regular.v1/anchor0'
            });
            expect(entry.glyphName).toBe('behDotless-ar.medi');
            expect(entry.layerId).toBe('layer.regular.v1');
            expect(
                buildHistoryStackItems([entry], {
                    glyphName: 'behDotless-ar.medi',
                    layerId: 'layer.regular.v1'
                })
            ).toHaveLength(1);
        } finally {
            window.currentFontModel = previousFontModel;
        }
    });

    test('path-derived glyph metadata resolves dotted glyph names for glyph-scoped paths', () => {
        resetLogCounter();
        const previousFontModel = window.currentFontModel;
        window.currentFontModel = {
            glyphs: [{ name: 'a.ss04', layers: [{ id: 'master-regular' }] }]
        };

        try {
            const path = 'glyphs.a.ss04.note';
            const entry = createLogEntry({
                timestamp: 1,
                windowId: 'w',
                windowRoleLabel: 'Main',
                historyItemId: 'history-item-1',
                historyAction: 'change',
                transactionLabel: 'Rename note',
                transactionId: 1,
                op: 'set',
                undoScope: 'glyph',
                path,
                oldValue: '',
                newValue: 'changed'
            });

            expect(deriveGlyphNameFromPath(path)).toBe('a.ss04');
            expect(entry.glyphName).toBe('a.ss04');
            expect(
                buildHistoryStackItems([entry], {
                    glyphName: 'a.ss04'
                })
            ).toHaveLength(1);
        } finally {
            window.currentFontModel = previousFontModel;
        }
    });
});

// ─────────────────────────────────────────────────────────────────────
// 3. ChangeBridge — basic recording
// ─────────────────────────────────────────────────────────────────────

describe('ChangeBridge', () => {
    test('initFromJson populates Y.Doc', () => {
        const { bridge } = createTestBridge('test-1');
        expect(getYPath(bridge.fontMap, ['upm'])).toBe(1000);
        expect(getYPath(bridge.fontMap, ['glyphs', 'A', 'name'])).toBe('A');
    });

    test('recordChange updates Y.Doc and adds log entry', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            700
        );
        // Y.Doc updated
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(700);
        // Log entry recorded
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].op).toBe('set');
        expect(log[0].property).toBe('width');
        expect(log[0].oldValue).toBe(600);
        expect(log[0].newValue).toBe(700);
        expect(log[0].path).toBe('glyphs.A.layers.layer-1.width');
        expect(log[0].glyphName).toBe('A');
    });

    test('getChangeLogForGlyph returns only entries for that glyph', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            700
        );
        bridge.recordChange(
            ['glyphs', 'B', 'layers', 'layer-2'],
            'width',
            650,
            750
        );
        bridge.recordChange([], 'upm', 1000, 1100);

        const glyphAEntries = bridge.getChangeLogForGlyph('A');
        expect(glyphAEntries).toHaveLength(1);
        expect(glyphAEntries[0].glyphName).toBe('A');
        expect(bridge.getChangeLogForGlyph(null)).toHaveLength(3);
    });

    test('recordAdd stores new value in Y.Doc', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.recordAdd(['glyphs', 'C'], {
            name: 'C',
            layers: []
        });
        const glyphC = getYPath(bridge.fontMap, ['glyphs', 'C']);
        expect(glyphC).toBeDefined();
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].op).toBe('add');
    });

    test('recordRemove deletes from Y.Doc', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.recordRemove(['glyphs', 'B'], { name: 'B' });
        expect(getYPath(bridge.fontMap, ['glyphs', 'B'])).toBeUndefined();
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].op).toBe('remove');
    });

    test('applySyntheticChangeSet creates one glyph-scoped undo step across layers', () => {
        const fontJson = makeMinimalFont();
        fontJson.glyphs[0].layers.push({
            id: 'layer-1b',
            name: 'Regular Alt',
            width: 620,
            master: {
                type: 'DefaultForMaster',
                master: 'master-regular'
            },
            smart_component_location: {},
            color: null,
            layer_index: 1,
            is_background: false,
            background_layer_id: null,
            location: {},
            format_specific: {},
            shapes: [],
            anchors: [],
            guides: []
        });

        const bridge = new ChangeBridge('test-1');
        bridge.initFromJson(fontJson);

        bridge.beginTransaction('Python script');
        bridge.applySyntheticChangeSet('Python script', [
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'width'],
                oldValue: 600,
                newValue: 700
            },
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1b', 'width'],
                oldValue: 620,
                newValue: 730
            }
        ]);
        bridge.endTransaction();

        const layer1Items = buildHistoryStackItems(bridge.getChangeLog(), {
            glyphName: 'A',
            layerId: 'layer-1'
        });
        const layer1bItems = buildHistoryStackItems(bridge.getChangeLog(), {
            glyphName: 'A',
            layerId: 'layer-1b'
        });

        expect(layer1Items).toHaveLength(1);
        expect(layer1bItems).toHaveLength(1);
        expect(layer1Items[0].undoScope).toBe('glyph');

        expect(bridge.undo('A', 'layer-1')).toEqual(
            expect.objectContaining({
                scope: 'glyph',
                glyphName: 'A',
                layerId: null
            })
        );
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(600);
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1b',
                'width'
            ])
        ).toBe(620);

        expect(bridge.redo('A', 'layer-1')).toEqual(
            expect.objectContaining({
                scope: 'glyph',
                glyphName: 'A',
                layerId: null
            })
        );
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(700);
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1b',
                'width'
            ])
        ).toBe(730);

        bridge.destroy();
        window.changeBridge = undefined;
    });

    test('change log is suppressed during initFromJson', () => {
        const { bridge } = createTestBridge('test-1');
        // initFromJson should not produce log entries
        expect(bridge.getChangeLog()).toHaveLength(0);
    });

    test('getFullState / applyFullState round-trips', () => {
        const { bridge: b1 } = createTestBridge('test-1');
        b1.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            800
        );

        const state = b1.getFullState();

        // Create a second bridge WITHOUT initFromJson (avoids conflicting CRDT state)
        const b2 = new ChangeBridge('test-2');
        b2.applyFullState(state);

        expect(
            getYPath(b2.fontMap, ['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(800);
        b2.destroy();
    });

    test('reset clears state', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.recordChange([], 'upm', 1000, 2000);
        expect(bridge.getChangeLog().length).toBeGreaterThan(0);
        bridge.reset();
        expect(bridge.getChangeLog()).toHaveLength(0);
    });
});

// ─────────────────────────────────────────────────────────────────────
// 4. Transactions
// ─────────────────────────────────────────────────────────────────────

describe('Transactions', () => {
    test('batch changes share transactionId and label', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.beginTransaction('Drag node');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0, 'nodes', 0],
            'x',
            100,
            110
        );
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0, 'nodes', 0],
            'y',
            0,
            10
        );
        bridge.endTransaction();

        const log = bridge.getChangeLog();
        expect(log).toHaveLength(2);
        expect(log[0].transactionLabel).toBe('Drag node');
        expect(log[1].transactionLabel).toBe('Drag node');
        expect(log[0].transactionId).toBe(log[1].transactionId);
        expect(log[0].transactionId).not.toBeNull();
    });

    test('net no-op point drag transaction does not emit history or Yjs changes', () => {
        const { bridge } = createTestBridge('test-noop-drag');

        bridge.beginTransaction('Drag point');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0, 'nodes', 0],
            'x',
            100,
            120
        );
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0, 'nodes', 0],
            'y',
            0,
            15
        );
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0, 'nodes', 0],
            'x',
            120,
            100
        );
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0, 'nodes', 0],
            'y',
            15,
            0
        );
        bridge.endTransaction();

        expect(bridge.getChangeLog()).toHaveLength(0);
        expect(bridge.canUndo('A', 'layer-1')).toBe(false);
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes',
                0,
                'nodes',
                0,
                'x'
            ])
        ).toBe(100);
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes',
                0,
                'nodes',
                0,
                'y'
            ])
        ).toBe(0);
    });

    test('buffered layer transaction undoes as one layer history item', () => {
        const { bridge } = createTestBridge('test-1');

        bridge.beginTransaction('Drag node');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0, 'nodes', 0],
            'x',
            100,
            110
        );
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0, 'nodes', 0],
            'y',
            0,
            10
        );
        bridge.endTransaction();

        const layerItems = buildHistoryStackItems(bridge.getChangeLog(), {
            glyphName: 'A',
            layerId: 'layer-1'
        });

        expect(layerItems).toHaveLength(1);
        expect(layerItems[0].undoScope).toBe('layer');
        expect(layerItems[0].entries).toHaveLength(2);

        expect(bridge.undo('A', 'layer-1')).toEqual(
            expect.objectContaining({
                scope: 'layer',
                glyphName: 'A',
                layerId: 'layer-1'
            })
        );
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes',
                0,
                'nodes',
                0,
                'x'
            ])
        ).toBe(100);
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes',
                0,
                'nodes',
                0,
                'y'
            ])
        ).toBe(0);
    });

    test('runWithoutRecording skips transient operations inside a transaction', () => {
        const { bridge } = createTestBridge('test-1');

        bridge.beginTransaction('Drag node');
        bridge.runWithoutRecording(() => {
            bridge.recordChange(
                ['glyphs', 'A', 'layers', 'layer-1'],
                'width',
                600,
                620
            );
        });
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            620,
            630
        );
        bridge.endTransaction();

        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].newValue).toBe(630);
    });

    test('buffered multi-layer glyph transaction stays glyph-scoped in history panels', () => {
        const fontJson = makeMinimalFont();
        fontJson.glyphs[0].layers.push({
            id: 'layer-1b',
            name: 'Regular Alt',
            width: 620,
            master: {
                type: 'DefaultForMaster',
                master: 'master-regular'
            },
            smart_component_location: {},
            color: null,
            layer_index: 1,
            is_background: false,
            background_layer_id: null,
            location: {},
            format_specific: {},
            shapes: [],
            anchors: [],
            guides: []
        });

        const bridge = new ChangeBridge('test-1');
        bridge.initFromJson(fontJson);

        bridge.beginTransaction('Set sidebearings');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            700
        );
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1b'],
            'width',
            620,
            730
        );
        bridge.endTransaction();

        const layer1Items = buildHistoryStackItems(bridge.getChangeLog(), {
            glyphName: 'A',
            layerId: 'layer-1'
        });
        const layer1bItems = buildHistoryStackItems(bridge.getChangeLog(), {
            glyphName: 'A',
            layerId: 'layer-1b'
        });

        expect(layer1Items).toHaveLength(1);
        expect(layer1bItems).toHaveLength(1);
        expect(layer1Items[0].undoScope).toBe('glyph');
        expect(layer1bItems[0].undoScope).toBe('glyph');

        expect(bridge.undo('A', 'layer-1')).toEqual(
            expect.objectContaining({
                scope: 'glyph',
                glyphName: 'A',
                layerId: null
            })
        );
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(600);
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1b',
                'width'
            ])
        ).toBe(620);
    });

    test('layer-scoped undo resolves font-scoped items that touch the active glyph', () => {
        const { bridge } = createTestBridge('test-1');

        bridge.beginTransaction('Set sidebearing with dependents');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            620
        );
        bridge.recordChange(
            ['glyphs', 'B', 'layers', 'layer-2'],
            'width',
            650,
            680
        );
        bridge.endTransaction();

        const layerItems = buildHistoryStackItems(bridge.getChangeLog(), {
            glyphName: 'A',
            layerId: 'layer-1'
        });
        expect(layerItems).toHaveLength(1);
        expect(layerItems[0].undoScope).toBe('font');

        expect(bridge.undo('A', 'layer-1')).toEqual(
            expect.objectContaining({
                scope: 'font',
                glyphName: null,
                layerId: null
            })
        );
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(600);
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'B',
                'layers',
                'layer-2',
                'width'
            ])
        ).toBe(650);
    });

    test('nested transactions share outermost label', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.beginTransaction('Outer');
        bridge.beginTransaction('Inner');
        bridge.recordChange([], 'upm', 1000, 2000);
        bridge.endTransaction();
        bridge.endTransaction();

        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].transactionLabel).toBe('Outer');
    });

    test('transaction dirty callback fires once after batch commit', () => {
        const { bridge } = createTestBridge('test-1');
        const onDirty = jest.fn();

        bridge.onDirty(onDirty);
        bridge.beginTransaction('Set sidebearings');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            620
        );
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'format_specific',
            {},
            { metric_right: '=l' }
        );

        expect(onDirty).toHaveBeenCalledTimes(0);

        bridge.endTransaction();

        expect(onDirty).toHaveBeenCalledTimes(1);
    });

    test('inTransaction flag tracks depth', () => {
        const { bridge } = createTestBridge('test-1');
        expect(bridge.inTransaction).toBe(false);
        bridge.beginTransaction('tx');
        expect(bridge.inTransaction).toBe(true);
        bridge.beginTransaction('nested');
        expect(bridge.inTransaction).toBe(true);
        bridge.endTransaction();
        expect(bridge.inTransaction).toBe(true);
        bridge.endTransaction();
        expect(bridge.inTransaction).toBe(false);
    });

    test('changes outside transaction have null transactionId', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.recordChange([], 'upm', 1000, 2000);
        expect(bridge.getChangeLog()[0].transactionId).toBeNull();
        expect(bridge.getChangeLog()[0].transactionLabel).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────
// 5. Model setter → ChangeBridge integration
// ─────────────────────────────────────────────────────────────────────

describe('Model setter change recording', () => {
    test('introspection discovers method-returned wrappers', () => {
        expect(
            GENERIC_ACCESSOR_SPECS.some((spec) => spec.className === 'Path')
        ).toBe(true);
        expect(
            GENERIC_ACCESSOR_SPECS.some(
                (spec) => spec.className === 'Component'
            )
        ).toBe(true);
    });

    test.each(GENERIC_ACCESSOR_SPECS)(
        '$className.$property at $pathLabel records a bridge change and updates Y.Doc',
        (spec) => {
            const { bridge, font } = createTestBridge(
                `introspection-${spec.className}-${spec.property}`
            );
            const target = resolveModelObject(font, spec);
            const oldValue = cloneValue(target[spec.property]);
            const candidateValue = mutateValue(oldValue);
            const isComponentAnchorAlias =
                spec.className === 'Component' && spec.property === 'anchor';
            const expectedProperty = isComponentAnchorAlias
                ? 'componentAnchor'
                : spec.property;

            target[spec.property] = cloneValue(candidateValue);

            const expectedValue = cloneValue(target[spec.property]);
            const expectedYPath = isComponentAnchorAlias
                ? target
                      .getPath()
                      .concat([
                          'format_specific',
                          'com.schriftgestalt.Glyphs.componentAnchor'
                      ])
                : target.getPath().concat(spec.property);
            const log = bridge.getChangeLog();

            expect(log).toHaveLength(1);
            expect(log[0].property).toBe(expectedProperty);
            expect(log[0].oldValue).toEqual(oldValue);
            expect(log[0].newValue).toEqual(expectedValue);
            expect(
                normalizeYValue(getYPath(bridge.fontMap, expectedYPath))
            ).toEqual(expectedValue);
        }
    );
});

describe('Model mutable getter change recording', () => {
    test('introspection discovers feature model mutable getters', () => {
        expect(
            GENERIC_MUTABLE_GETTER_SPECS.some(
                (spec) =>
                    spec.className === 'Font' && spec.property === 'features'
            )
        ).toBe(true);
    });

    test.each(GENERIC_MUTABLE_GETTER_SPECS)(
        '$className.$property at $pathLabel records a bridge change for in-place mutations',
        (spec) => {
            const { bridge, font } = createTestBridge(
                `mutable-${spec.className}-${spec.property}`
            );
            const target = resolveModelObject(font, spec);
            const liveValue = target[spec.property];
            const oldValue = cloneValue(normalizeYValue(liveValue));

            mutateInPlace(liveValue);

            const expectedValue = cloneValue(
                normalizeYValue(target[spec.property])
            );
            const log = bridge.getChangeLog();

            expect(log).toHaveLength(1);
            if (spec.className === 'Font' && spec.property === 'features') {
                expect(log[0].path.startsWith('features.')).toBe(true);
            } else {
                expect(log[0].property).toBe(spec.property);
                expect(log[0].oldValue).toEqual(oldValue);
                expect(log[0].newValue).toEqual(expectedValue);
            }
            expect(
                normalizeYValue(
                    getYPath(
                        bridge.fontMap,
                        target.getPath().concat(spec.property)
                    )
                )
            ).toEqual(expectedValue);
        }
    );

    test('python-style Reflect and splice mutations on live proxies record bridge changes', () => {
        const { bridge, font } = createTestBridge('mutable-python-style');

        Reflect.set(font.features.classes, 'Lowercase', {
            code: '@Lowercase = [a b];',
            automatic: false
        });
        Reflect.deleteProperty(font.features.classes, 'Uppercase');
        Reflect.set(font.features.include_paths, 0, 'features-updated');
        font.features.include_paths.splice(1, 0, 'features-extra');

        const log = bridge.getChangeLog();

        expect(log).toHaveLength(4);
        expect(log.map((entry) => entry.path)).toEqual([
            'features.classes.Lowercase',
            'features.classes.Uppercase',
            'features.include_paths.0',
            'features.include_paths'
        ]);
        expect(normalizeYValue(getYPath(bridge.fontMap, ['features']))).toEqual(
            cloneValue(font.features)
        );
    });

    test('feature history target filtering scopes stack items and undo', () => {
        const { bridge, font } = createTestBridge('feature-history-scope');

        font.note = 'note-changed';
        font.features.prefixes.global.code = 'lookupflag 7;';

        const scopedItems = buildHistoryStackItems(bridge.getChangeLog(), {
            historyTargetKey: 'prefix:global'
        });

        expect(scopedItems).toHaveLength(1);
        expect(scopedItems[0].entries[0].path).toBe(
            'features.prefixes.global.code'
        );

        expect(bridge.undo(undefined, null, 'prefix:global')).toEqual(
            expect.objectContaining({
                scope: 'font',
                glyphName: null,
                layerId: null
            })
        );
        expect(normalizeYValue(getYPath(bridge.fontMap, ['note']))).toBe(
            'note-changed'
        );
        expect(
            normalizeYValue(
                getYPath(bridge.fontMap, [
                    'features',
                    'prefixes',
                    'global',
                    'code'
                ])
            )
        ).toBe('lookupflag 0;');
    });

    test('no-op OpenType prefix code edit does not emit history', () => {
        const { bridge, font } = createTestBridge('feature-prefix-noop');

        font.features.prefixes.global.code = 'lookupflag 0;';

        expect(bridge.getChangeLog()).toHaveLength(0);
        expect(
            normalizeYValue(
                getYPath(bridge.fontMap, [
                    'features',
                    'prefixes',
                    'global',
                    'code'
                ])
            )
        ).toBe('lookupflag 0;');
    });

    test('no-op OpenType feature code edit does not emit history', () => {
        const { bridge, font } = createTestBridge('feature-code-noop');

        font.features.features[0][1].code = 'sub f i by fi;';

        expect(bridge.getChangeLog()).toHaveLength(0);
        expect(
            normalizeYValue(
                getYPath(bridge.fontMap, ['features', 'features', 0, 1, 'code'])
            )
        ).toBe('sub f i by fi;');
    });

    test('mixed non-outline transaction keeps only net-changing edits', () => {
        const { bridge, font } = createTestBridge('mixed-noop-transaction');

        bridge.beginTransaction('Mixed non-outline edit');
        try {
            font.note = '';
            font.features.prefixes.global.code = 'lookupflag 0;';
            font.features.features[0][1].code = 'sub f i by fi;';
            font.glyphs[0].layers[0].width = 610;
        } finally {
            bridge.endTransaction();
        }

        const log = bridge.getChangeLog();

        expect(log).toHaveLength(1);
        expect(log[0].transactionLabel).toBe('Mixed non-outline edit');
        expect(log[0].path).toBe('glyphs.A.layers.layer-1.width');
        expect(log[0].oldValue).toBe(600);
        expect(log[0].newValue).toBe(610);
    });

    test('feature list structural mutations sync Y.Doc for add remove and reorder', () => {
        const { bridge, font } = createTestBridge('feature-list-structural');

        font.features.features.push([
            'salt',
            {
                code: 'sub a by a.alt;',
                automatic: false,
                format_specific: { seed: true }
            }
        ]);

        const movedFeature = font.features.features.splice(0, 1)[0];
        font.features.features.push(movedFeature);
        font.features.features.splice(0, 1);

        const log = bridge.getChangeLog();

        expect(log).toHaveLength(4);
        expect(log.map((entry) => entry.path)).toEqual([
            'features.features',
            'features.features',
            'features.features',
            'features.features'
        ]);
        expect(normalizeYValue(getYPath(bridge.fontMap, ['features']))).toEqual(
            cloneValue(font.features)
        );
        expect(font.features.features).toEqual([
            [
                'liga',
                expect.objectContaining({
                    code: 'sub f i by fi;',
                    automatic: false
                })
            ]
        ]);
    });

    test('feature history items persist across feature reordering', () => {
        const { bridge, font } = createTestBridge('feature-history-reorder');

        font.features.features[0][1].code = 'sub f l by fl;';

        let scopedItems = buildHistoryStackItems(bridge.getChangeLog(), {
            historyTargetKey: 'feature:liga:1'
        });
        expect(scopedItems).toHaveLength(1);
        const originalHistoryItemId = scopedItems[0].id;

        font.features.features.push([
            'salt',
            {
                code: 'sub a by a.alt;',
                automatic: false,
                format_specific: { seed: true }
            }
        ]);

        const movedFeature = font.features.features.splice(0, 1)[0];
        font.features.features.push(movedFeature);

        scopedItems = buildHistoryStackItems(bridge.getChangeLog(), {
            historyTargetKey: 'feature:liga:1'
        });
        expect(scopedItems).toHaveLength(1);
        expect(scopedItems[0].id).toBe(originalHistoryItemId);

        font.features.features[1][1].code = 'sub f f by ff;';

        scopedItems = buildHistoryStackItems(bridge.getChangeLog(), {
            historyTargetKey: 'feature:liga:1'
        });
        expect(scopedItems).toHaveLength(2);
        expect(scopedItems.map((item) => item.id)).toContain(
            originalHistoryItemId
        );
        expect(
            scopedItems.flatMap((item) =>
                item.entries.map((entry) => entry.historyTargetKey)
            )
        ).toEqual(['feature:liga:1', 'feature:liga:1']);
    });

    test('feature reorder can be grouped into one history item', () => {
        const { bridge, font } = createTestBridge(
            'feature-reorder-transaction'
        );

        font.features.features.push([
            'salt',
            {
                code: 'sub a by a.alt;',
                automatic: false,
                format_specific: { seed: true }
            }
        ]);

        bridge.beginTransaction('Reorder features', {
            type: 'feature',
            key: 'feature:liga:1',
            label: 'liga'
        });
        try {
            const movedFeature = font.features.features.splice(0, 1)[0];
            font.features.features.splice(1, 0, movedFeature);
        } finally {
            bridge.endTransaction();
        }

        const log = bridge.getChangeLog();
        const reorderEntries = log.filter(
            (entry) => entry.transactionLabel === 'Reorder features'
        );
        const historyItems = buildHistoryStackItems(log, {
            includeUndone: true
        }).filter((item) => item.transactionLabel === 'Reorder features');

        expect(reorderEntries).toHaveLength(2);
        expect(historyItems).toHaveLength(1);
        expect(historyItems[0].entries).toHaveLength(2);
        expect(
            new Set(reorderEntries.map((entry) => entry.historyItemId))
        ).toEqual(new Set([historyItems[0].id]));
        expect(reorderEntries.map((entry) => entry.historyTargetKey)).toEqual([
            'feature:liga:1',
            'feature:liga:1'
        ]);

        const scopedItems = buildHistoryStackItems(log, {
            includeUndone: true,
            historyTargetKey: 'feature:liga:1'
        });

        expect(scopedItems.some((item) => item.id === historyItems[0].id)).toBe(
            true
        );
    });

    test('python-style item assignment uses owner-aware wrapping rules', () => {
        const { bridge, font } = createTestBridge('mutable-python-item-style');

        Reflect.set(font, 'names', { familyName: 'Renamed' });

        expect(bridge.getChangeLog()).toHaveLength(1);
        expect(bridge.getChangeLog()[0].property).toBe('names');
        expect(normalizeYValue(getYPath(bridge.fontMap, ['names']))).toEqual({
            familyName: 'Renamed'
        });
    });
});

describe('Model collection mutator change recording', () => {
    test('introspection discovers structural model mutators', () => {
        expect(
            COLLECTION_MUTATOR_SPECS.some(
                (spec) =>
                    spec.className === 'Font' && spec.method === 'addGlyph'
            )
        ).toBe(true);
        expect(
            COLLECTION_MUTATOR_SPECS.some(
                (spec) =>
                    spec.className === 'Layer' && spec.method === 'addPath'
            )
        ).toBe(true);
    });

    test.each(COLLECTION_MUTATOR_SPECS)(
        '$className.$method at $pathLabel records a structural bridge change and updates Y.Doc',
        (spec) => {
            const { bridge, font } = createTestBridge(
                `mutator-${spec.className}-${spec.method}`
            );
            const target = resolveModelObject(font, spec);
            const mutator =
                COLLECTION_MUTATOR_TESTS[`${spec.className}.${spec.method}`];
            const beforeJson = yDocToJson(bridge.fontMap);

            mutator.invoke(target);

            const log = bridge.getChangeLog();
            const afterJson = yDocToJson(bridge.fontMap);

            expect(log).toHaveLength(1);
            expect(log[0].op).toBe(mutator.expectedOp);
            expect(log[0].path).toContain(
                mutator.expectedPathFragment(target, log[0])
            );
            expect(afterJson).not.toEqual(beforeJson);
        }
    );

    test('wrapper collections reject direct structural mutation and keep users on bridge-backed methods', () => {
        const { font } = createTestBridge('collection-guards');
        const glyph = font.findGlyph('A');
        const layer = glyph.layers[0];
        const path = layer.shapes[0].asPath();

        expect(() => {
            font.glyphs.push(glyph);
        }).toThrow(/addGlyph\(\)|removeGlyph\(\)|duplicateGlyph\(\)/);

        expect(() => {
            Reflect.set(glyph.layers, 0, layer);
        }).toThrow(/addLayer\(\)|removeLayer\(\)/);

        expect(() => {
            layer.guides.splice(0, 1);
        }).toThrow(/addGuide\(\)|removeGuide\(\)/);

        expect(() => {
            path.nodes.splice(0, 1);
        }).toThrow(/appendNode\(\)|insertNode\(\)|removeNode\(\)/);
    });

    test('lsb setter records bridge-visible geometry updates in one transaction', () => {
        const { bridge, font } = createTestBridge('layer-lsb');
        const layer = font.findGlyph('A').layers[0];

        layer.lsb = 50;

        const log = bridge.getChangeLog();

        expect(log).toHaveLength(3);
        expect(new Set(log.map((entry) => entry.transactionLabel))).toEqual(
            new Set(['Set LSB'])
        );
        expect(log.map((entry) => entry.path)).toEqual([
            'glyphs.A.layers.layer-1.shapes',
            'glyphs.A.layers.layer-1.anchors',
            'glyphs.A.layers.layer-1.width'
        ]);
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes',
                0,
                'nodes',
                0,
                'x'
            ])
        ).toBe(60);
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'anchors',
                0,
                'x'
            ])
        ).toBe(260);
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(560);
    });

    test('string node normalization syncs Y.Doc before subsequent point edits', () => {
        const fontJson = makeMinimalFont();
        fontJson.glyphs[0].layers[0].shapes[0].nodes =
            '100 0 l 300 700 l 500 0 l';

        const bridge = new ChangeBridge('string-node-normalization');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;
        const font = Font.fromData(fontJson);
        const path = font.findGlyph('A').layers[0].shapes[0].asPath();

        expect(
            typeof normalizeYValue(
                getYPath(bridge.fontMap, [
                    'glyphs',
                    'A',
                    'layers',
                    'layer-1',
                    'shapes',
                    0,
                    'nodes'
                ])
            )
        ).toBe('string');

        const nodes = path.nodes;

        expect(bridge.getChangeLog()).toHaveLength(0);
        expect(
            normalizeYValue(
                getYPath(bridge.fontMap, [
                    'glyphs',
                    'A',
                    'layers',
                    'layer-1',
                    'shapes',
                    0,
                    'nodes'
                ])
            )
        ).toEqual([
            { x: 100, y: 0, nodetype: 'Line' },
            { x: 300, y: 700, nodetype: 'Line' },
            { x: 500, y: 0, nodetype: 'Line' }
        ]);

        nodes[0].x = 120;

        expect(bridge.getChangeLog()).toHaveLength(1);
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes',
                0,
                'nodes',
                0,
                'x'
            ])
        ).toBe(120);
    });
});

// ─────────────────────────────────────────────────────────────────────
// 6. Undo / Redo
// ─────────────────────────────────────────────────────────────────────

describe('Undo / Redo', () => {
    test('font-level undo reverts property change', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.recordChange([], 'upm', 1000, 2000);
        expect(getYPath(bridge.fontMap, ['upm'])).toBe(2000);

        bridge.undo();
        expect(getYPath(bridge.fontMap, ['upm'])).toBe(1000);
    });

    test('font-level redo restores change', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.recordChange([], 'upm', 1000, 2000);
        bridge.undo();
        expect(getYPath(bridge.fontMap, ['upm'])).toBe(1000);

        bridge.redo();
        expect(getYPath(bridge.fontMap, ['upm'])).toBe(2000);
    });

    test('canUndo / canRedo report correctly', () => {
        const { bridge } = createTestBridge('test-1');
        expect(bridge.canUndo()).toBe(false);
        expect(bridge.canRedo()).toBe(false);

        bridge.recordChange([], 'upm', 1000, 2000);
        expect(bridge.canUndo()).toBe(true);
        expect(bridge.canRedo()).toBe(false);

        bridge.undo();
        expect(bridge.canUndo()).toBe(false);
        expect(bridge.canRedo()).toBe(true);
    });

    test('per-glyph undo only affects that glyph', () => {
        const { bridge } = createTestBridge('test-1');
        // Set up per-glyph undo manager for glyph A
        bridge.getGlyphUndoManager('A');

        // Make changes to glyph A and glyph B
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            700
        );

        // Undo glyph A
        bridge.undo('A');
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(600);
    });

    test('undo returns false when nothing to undo', () => {
        const { bridge } = createTestBridge('test-1');
        expect(bridge.undo()).toBeNull();
        expect(bridge.undo('nonexistent')).toBeNull();
    });

    test('redo returns false when nothing to redo', () => {
        const { bridge } = createTestBridge('test-1');
        expect(bridge.redo()).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────
// 7. Cross-window sync via WindowSync
// ─────────────────────────────────────────────────────────────────────

describe('WindowSync', () => {
    test('BroadcastChannel mock delivers messages between instances', () => {
        const ch1 = new BroadcastChannel('test-channel');
        const ch2 = new BroadcastChannel('test-channel');

        const received = [];
        ch2.onmessage = (ev) => {
            received.push(ev.data);
        };

        ch1.postMessage({ hello: 'world' });
        flushTimers();

        expect(received).toEqual([{ hello: 'world' }]);
        ch1.close();
        ch2.close();
    });

    test('local change broadcasts to remote bridge', () => {
        const fontJson1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('win-1');
        bridge1.initFromJson(fontJson1);

        // Bridge2 gets its state from bridge1 (no independent initFromJson)
        const bridge2 = new ChangeBridge('win-2');
        bridge2.applyFullState(bridge1.getFullState());

        const sync1 = new WindowSync(bridge1, 'font-channel');
        const sync2 = new WindowSync(bridge2, 'font-channel');

        // Make a local change on bridge1
        bridge1.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            800
        );

        // Verify bridge1's Y.Doc was updated
        expect(
            getYPath(bridge1.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(800);

        // Flush to deliver BroadcastChannel messages
        flushTimers();

        const width = getYPath(bridge2.fontMap, [
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'width'
        ]);
        expect(width).toBe(800);

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('linked window can undo a main-window edit', () => {
        const fontJson1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('win-1');
        bridge1.initFromJson(fontJson1);

        const bridge2 = new ChangeBridge('win-2');
        bridge2.applyFullState(bridge1.getFullState());

        const sync1 = new WindowSync(bridge1, 'font-channel');
        const sync2 = new WindowSync(bridge2, 'font-channel');

        bridge1.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            820
        );
        flushTimers();

        expect(bridge2.canUndo('A')).toBe(true);

        bridge2.undo('A');
        flushTimers();

        expect(
            getYPath(bridge2.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(600);
        expect(
            getYPath(bridge1.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(600);

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('full state request/response bootstraps new window', () => {
        const fontJson1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('win-1');
        bridge1.initFromJson(fontJson1);
        bridge1.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            999
        );

        // Bridge2 starts empty — will be bootstrapped via full-state-response
        const bridge2 = new ChangeBridge('win-2');

        const sync1 = new WindowSync(bridge1, 'font-channel');
        const sync2 = new WindowSync(bridge2, 'font-channel');

        // Window 2 requests full state
        sync2.requestFullState();
        // First flush delivers the request to sync1
        flushTimers();
        // Second flush delivers the response from sync1 to sync2
        flushTimers();

        const width = getYPath(bridge2.fontMap, [
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'width'
        ]);
        expect(width).toBe(999);
        expect(bridge2.getChangeLog().length).toBeGreaterThan(0);

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('only first full-state response is applied', () => {
        const fontA = makeMinimalFont();
        fontA.glyphs[0].layers[0].width = 710;
        const bridgeA = new ChangeBridge('win-a');
        bridgeA.initFromJson(fontA);

        const fontB = makeMinimalFont();
        fontB.glyphs[0].layers[0].width = 930;
        const bridgeB = new ChangeBridge('win-b');
        bridgeB.initFromJson(fontB);

        const receiver = new ChangeBridge('win-rx');

        const syncA = new WindowSync(bridgeA, 'font-channel-first-response');
        const syncB = new WindowSync(bridgeB, 'font-channel-first-response');
        const syncRx = new WindowSync(receiver, 'font-channel-first-response');

        syncRx.requestFullState();
        flushTimers();
        flushTimers();

        const width = getYPath(receiver.fontMap, [
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'width'
        ]);

        // Response ordering is deterministic in this test setup:
        // syncA is registered before syncB, so receiver should keep A's snapshot.
        expect(width).toBe(710);

        syncA.destroy();
        syncB.destroy();
        syncRx.destroy();
        bridgeA.destroy();
        bridgeB.destroy();
        receiver.destroy();
    });

    test('window-closing removes peer', () => {
        const fontJson1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('win-1');
        bridge1.initFromJson(fontJson1);

        // Bridge2 gets state from bridge1
        const bridge2 = new ChangeBridge('win-2');
        bridge2.applyFullState(bridge1.getFullState());

        const sync1 = new WindowSync(bridge1, 'font-channel');
        const sync2 = new WindowSync(bridge2, 'font-channel');

        // Exchange a message so they know about each other
        bridge1.recordChange([], 'upm', 1000, 1001);
        flushTimers();

        // Now window 1 closes
        sync1.destroy();
        flushTimers();

        // sync2 should have removed win-1 from peers
        expect(sync2.peers.has('win-1')).toBe(false);

        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });
});

// ─────────────────────────────────────────────────────────────────────
// 8. Path resolution (getPath / getPathSegment on model objects)
// ─────────────────────────────────────────────────────────────────────

describe('Model path resolution', () => {
    test('Font.getPath returns empty array', () => {
        const { font } = createTestBridge('test-1');
        expect(font.getPath()).toEqual([]);
    });

    test('Glyph.getPath returns ["glyphs", "<name>"]', () => {
        const { font } = createTestBridge('test-1');
        expect(font.glyphs[0].getPath()).toEqual(['glyphs', 'A']);
    });

    test('Layer.getPath includes glyph and layer id', () => {
        const { font } = createTestBridge('test-1');
        const layer = font.glyphs[0].layers[0];
        expect(layer.getPath()).toEqual(['glyphs', 'A', 'layers', 'layer-1']);
    });

    test('Node.getPath includes full path from font root', () => {
        const { font } = createTestBridge('test-1');
        const node = font.glyphs[0].layers[0].shapes[0].asPath().nodes[0];
        const path = node.getPath();
        // Should be: glyphs, A, layers, layer-1, shapes, 0, nodes, 0
        expect(path[0]).toBe('glyphs');
        expect(path[1]).toBe('A');
        expect(path[2]).toBe('layers');
        expect(path[3]).toBe('layer-1');
        expect(path[4]).toBe('shapes');
        expect(path[5]).toBe(0);
        expect(path[6]).toBe('nodes');
        expect(path[7]).toBe(0);
    });

    test('Axis.getPath returns ["axes", index]', () => {
        const { font } = createTestBridge('test-1');
        expect(font.axes[0].getPath()).toEqual(['axes', 0]);
    });

    test('Master.getPath returns ["masters", index]', () => {
        const { font } = createTestBridge('test-1');
        expect(font.masters[0].getPath()).toEqual(['masters', 0]);
    });

    test('Instance.getPath returns ["instances", index]', () => {
        const { font } = createTestBridge('test-1');
        expect(font.instances[0].getPath()).toEqual(['instances', 0]);
    });

    test('Anchor.getPath includes layer and anchor index', () => {
        const { font } = createTestBridge('test-1');
        const anchor = font.glyphs[0].layers[0].anchors[0];
        const path = anchor.getPath();
        expect(path).toEqual([
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'anchors',
            0
        ]);
    });

    test('Guide.getPath includes layer and guide index', () => {
        const { font } = createTestBridge('test-1');
        const guide = font.glyphs[0].layers[0].guides[0];
        const path = guide.getPath();
        expect(path).toEqual(['glyphs', 'A', 'layers', 'layer-1', 'guides', 0]);
    });
});

// ─────────────────────────────────────────────────────────────────────
// 9. Multiple sequential changes
// ─────────────────────────────────────────────────────────────────────

describe('Sequential changes', () => {
    test('multiple node moves produce independent log entries', () => {
        const { bridge, font } = createTestBridge('test-1');
        const node = font.glyphs[0].layers[0].shapes[0].asPath().nodes[0];
        node.x = 110;
        node.x = 120;
        node.x = 130;
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(3);
        expect(log[0].oldValue).toBe(100);
        expect(log[0].newValue).toBe(110);
        expect(log[1].oldValue).toBe(110);
        expect(log[1].newValue).toBe(120);
        expect(log[2].oldValue).toBe(120);
        expect(log[2].newValue).toBe(130);
    });

    test('changes across different glyphs produce correct paths', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.glyphs[0].layers[0].width = 700; // glyph A
        font.glyphs[1].layers[0].width = 800; // glyph B
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(2);
        expect(log[0].path).toContain('A');
        expect(log[1].path).toContain('B');
    });
});

// ─────────────────────────────────────────────────────────────────────
// 10. syncGlyphFromJson — bulk glyph sync
// ─────────────────────────────────────────────────────────────────────

describe('syncGlyphFromJson', () => {
    test('syncGlyphsFromJson reverts a multi-glyph transaction as one history item', () => {
        const { bridge, fontJson } = createTestBridge('test-sync-multi-glyph');

        fontJson.glyphs[0].layers[0].width = 700;
        fontJson.glyphs[1].layers[0].width = 750;

        bridge.syncGlyphsFromJson(['A', 'B'], 'Drag pair');

        const historyItems = buildHistoryStackItems(bridge.getChangeLog(), {
            includeUndone: true
        });

        expect(historyItems).toHaveLength(1);
        expect(historyItems[0].entries).toHaveLength(2);
        expect(historyItems[0].undoScope).toBe('font');

        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(700);
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'B',
                'layers',
                'layer-2',
                'width'
            ])
        ).toBe(750);

        expect(bridge.undo()).toEqual(
            expect.objectContaining({
                scope: 'font',
                glyphName: null,
                layerId: null
            })
        );
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(600);
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'B',
                'layers',
                'layer-2',
                'width'
            ])
        ).toBe(650);

        expect(bridge.redo()).toEqual(
            expect.objectContaining({
                scope: 'font',
                glyphName: null,
                layerId: null
            })
        );
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(700);
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'B',
                'layers',
                'layer-2',
                'width'
            ])
        ).toBe(750);
    });

    test('first sync fires Y.Doc local update', () => {
        const { bridge, fontJson } = createTestBridge('test-1');
        const updates = [];
        bridge.onLocalUpdate((u) => updates.push(u));

        // Mutate babelfontData directly (simulating outline-editor drag)
        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson('A', 'Drag');

        expect(updates.length).toBe(1);
        // Y.Doc should reflect the new width
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(700);
    });

    test('consecutive syncs both fire Y.Doc local updates', () => {
        const { bridge, fontJson } = createTestBridge('test-1');
        const updates = [];
        bridge.onLocalUpdate((u) => updates.push(u));

        // First drag
        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson('A', 'Drag');
        expect(updates.length).toBe(1);

        // Second drag
        fontJson.glyphs[0].layers[0].width = 800;
        bridge.syncGlyphFromJson('A', 'Drag');
        expect(updates.length).toBe(2);

        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(800);
    });

    test('undo works after syncGlyphFromJson', () => {
        const { bridge, fontJson } = createTestBridge('test-1');

        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson('A', 'Drag');

        expect(bridge.canUndo('A')).toBe(true);
        bridge.undo('A');
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(600);
    });

    test('layer-scoped undo and redo work after syncGlyphFromJson', () => {
        const { bridge, fontJson } = createTestBridge('test-1');

        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson('A', 'Drag', undefined, undefined, 'layer-1');

        expect(bridge.canUndo('A', 'layer-1')).toBe(true);
        expect(bridge.undo('A', 'layer-1')).toEqual(
            expect.objectContaining({
                scope: 'layer',
                glyphName: 'A',
                layerId: 'layer-1'
            })
        );
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(600);

        expect(bridge.canRedo('A', 'layer-1')).toBe(true);
        expect(bridge.redo('A', 'layer-1')).toEqual(
            expect.objectContaining({
                scope: 'layer',
                glyphName: 'A',
                layerId: 'layer-1'
            })
        );
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(700);
    });

    test('layer-scoped undo replays correctly for dotted glyph and layer names', () => {
        const fontJson = makeMinimalFont();
        fontJson.glyphs[0].name = 'behDotless-ar.medi';
        fontJson.glyphs[0].layers[0].id = 'layer.regular.v1';

        const bridge = new ChangeBridge('dotted-layer-undo');
        bridge.initFromJson(fontJson);

        const originalBottomX = fontJson.glyphs[0].layers[0].anchors[0].x;
        fontJson.glyphs[0].layers[0].anchors[0].x = originalBottomX - 37;
        bridge.syncGlyphFromJson(
            'behDotless-ar.medi',
            'Drag anchor',
            `anchor 'top': (${originalBottomX}, 750)`,
            `(${originalBottomX - 37}, 750)`,
            'layer.regular.v1'
        );

        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'behDotless-ar.medi',
                'layers',
                'layer.regular.v1',
                'anchors',
                0,
                'x'
            ])
        ).toBe(originalBottomX - 37);

        expect(bridge.undo('behDotless-ar.medi', 'layer.regular.v1')).toEqual(
            expect.objectContaining({
                scope: 'layer',
                glyphName: 'behDotless-ar.medi',
                layerId: 'layer.regular.v1'
            })
        );

        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'behDotless-ar.medi',
                'layers',
                'layer.regular.v1',
                'anchors',
                0,
                'x'
            ])
        ).toBe(originalBottomX);

        bridge.destroy();
    });

    test('layer-scoped sync merges a partial outline layer fragment with the existing layer snapshot', () => {
        const { bridge, fontJson } = createTestBridge('test-partial-outline');

        fontJson.glyphs[0].layers[0] = {
            id: 'layer-1',
            shapes: [
                {
                    nodes: [
                        {
                            x: 150,
                            y: 0,
                            nodetype: 'line',
                            smooth: false
                        },
                        {
                            x: 300,
                            y: 700,
                            nodetype: 'line',
                            smooth: false
                        },
                        {
                            x: 500,
                            y: 0,
                            nodetype: 'line',
                            smooth: false
                        }
                    ],
                    closed: true
                }
            ]
        };

        bridge.syncGlyphFromJson('A', 'Drag', undefined, undefined, 'layer-1');

        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(600);
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'anchors',
                0,
                'name'
            ])
        ).toBe('top');
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes',
                0,
                'nodes',
                0,
                'x'
            ])
        ).toBe(150);
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'master',
                'type'
            ])
        ).toBe('DefaultForMaster');
    });

    test('glyph-scoped sync merges partial layer fragments with the existing glyph snapshot', () => {
        const { bridge, fontJson } = createTestBridge('test-partial-glyph');

        fontJson.glyphs[0] = {
            name: 'A',
            layers: [
                {
                    id: 'layer-1',
                    shapes: [
                        {
                            nodes: [
                                {
                                    x: 175,
                                    y: 0,
                                    nodetype: 'line',
                                    smooth: false
                                },
                                {
                                    x: 300,
                                    y: 700,
                                    nodetype: 'line',
                                    smooth: false
                                },
                                {
                                    x: 500,
                                    y: 0,
                                    nodetype: 'line',
                                    smooth: false
                                }
                            ],
                            closed: true
                        }
                    ]
                }
            ]
        };

        bridge.syncGlyphFromJson('A', 'Add point');

        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(600);
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'anchors',
                0,
                'name'
            ])
        ).toBe('top');
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes',
                0,
                'nodes',
                0,
                'x'
            ])
        ).toBe(175);
    });

    test('layer-scoped undo restores original outlines after remove and recreate with the same layer id', () => {
        const { bridge, font } = createTestBridge('reinterpolate-undo');
        const glyph = font.findGlyph('A');
        const originalLayer = glyph.findLayerById('layer-1');
        const originalSnapshot = cloneValue(originalLayer.toJSON());

        bridge.beginTransaction('Reinterpolate layer');
        glyph.removeLayerById('layer-1');

        const recreatedLayer = glyph.addLayer(
            910,
            originalSnapshot.master,
            'layer-1'
        );
        withSuppressedModelRecording(() => {
            recreatedLayer.syncFromEditorLayerData({
                width: 910,
                shapes: [
                    {
                        nodes: [
                            {
                                x: 20,
                                y: 20,
                                nodetype: 'line',
                                smooth: false
                            },
                            {
                                x: 80,
                                y: 20,
                                nodetype: 'line',
                                smooth: false
                            },
                            {
                                x: 80,
                                y: 120,
                                nodetype: 'line',
                                smooth: false
                            }
                        ],
                        closed: true
                    }
                ],
                anchors: [{ name: 'top', x: 200, y: 700 }],
                guides: []
            });
        });
        bridge.syncGlyphFromJson(
            'A',
            'Reinterpolate layer sync',
            undefined,
            undefined,
            'layer-1'
        );
        bridge.endTransaction();

        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(910);
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes'
            ])
        ).toHaveLength(1);

        expect(bridge.undo('A', 'layer-1')).toEqual(
            expect.objectContaining({
                scope: 'layer',
                glyphName: 'A',
                layerId: 'layer-1'
            })
        );

        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(originalSnapshot.width);
        expect(
            cloneValue(
                getYPath(bridge.fontMap, [
                    'glyphs',
                    'A',
                    'layers',
                    'layer-1',
                    'anchors'
                ])
            )
        ).toEqual(originalSnapshot.anchors);
        expect(
            cloneValue(
                getYPath(bridge.fontMap, [
                    'glyphs',
                    'A',
                    'layers',
                    'layer-1',
                    'shapes'
                ])
            )
        ).toEqual(originalSnapshot.shapes);
    });

    test('glyph snapshot sync stores replay targets for every layer in the committed history item', () => {
        const { bridge, fontJson } = createTestBridge('test-1');

        fontJson.glyphs[0].layers.push({
            ...JSON.parse(JSON.stringify(fontJson.glyphs[0].layers[0])),
            id: 'layer-2',
            name: 'Bold',
            width: 710
        });

        bridge.syncGlyphFromJson('A', 'Drag');

        const historyItems = buildHistoryStackItems(bridge.getChangeLog(), {
            glyphName: 'A'
        });

        expect(historyItems).toHaveLength(1);
        expect(historyItems[0].entries[0].workerReplayTargets).toEqual(
            expect.arrayContaining([
                { glyphName: 'A', layerId: 'layer-1' },
                { glyphName: 'A', layerId: 'layer-2' }
            ])
        );
        expect(historyItems[0].workerReplayTargets).toEqual(
            expect.arrayContaining([
                { glyphName: 'A', layerId: 'layer-1' },
                { glyphName: 'A', layerId: 'layer-2' }
            ])
        );
    });

    test('glyph-scoped undo restores linked-layer curve point insertion cleanly', () => {
        const font = Font.fromData(makeMinimalFont());
        const fontJson = font.toJSON();
        const baseLayer = cloneValue(fontJson.glyphs[0].layers[0]);
        fontJson.glyphs[0].layers = [
            {
                ...cloneValue(baseLayer),
                id: 'layer-1',
                shapes: [
                    {
                        nodes: [
                            { x: 0, y: 0, nodetype: 'Curve' },
                            { x: 30, y: 60, nodetype: 'OffCurve' },
                            { x: 70, y: 60, nodetype: 'OffCurve' },
                            { x: 100, y: 0, nodetype: 'Curve' }
                        ],
                        closed: false
                    }
                ],
                anchors: [],
                guides: []
            },
            {
                ...cloneValue(baseLayer),
                id: 'layer-1b',
                shapes: [
                    {
                        nodes: [
                            { x: 0, y: 10, nodetype: 'Curve' },
                            { x: 30, y: 70, nodetype: 'OffCurve' },
                            { x: 70, y: 70, nodetype: 'OffCurve' },
                            { x: 100, y: 10, nodetype: 'Curve' }
                        ],
                        closed: false
                    }
                ],
                anchors: [],
                guides: []
            }
        ];

        const bridge = new ChangeBridge('test-linked-add-point');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;

        const glyph = font.findGlyph('A');
        const layer1 = glyph.findLayerById('layer-1');
        const layer2 = glyph.findLayerById('layer-1b');

        withSuppressedModelRecording(() => {
            layer1.paths[0]._addPoint(0, 0.5);
            layer2.paths[0]._addPoint(0, 0.5);
        });
        bridge.syncGlyphFromJson('A', 'Add point');

        const historyItems = buildHistoryStackItems(bridge.getChangeLog(), {
            glyphName: 'A',
            layerId: 'layer-1',
            includeUndone: true
        });
        expect(historyItems).toHaveLength(1);
        expect(historyItems[0].undoScope).toBe('glyph');
        expect(
            fontJson.glyphs[0].layers.map(
                (layer) => layer.shapes[0].nodes.length
            )
        ).toEqual([7, 7]);

        expect(bridge.undo('A', 'layer-1')).toEqual(
            expect.objectContaining({
                scope: 'glyph',
                glyphName: 'A',
                layerId: null
            })
        );

        expect(
            fontJson.glyphs[0].layers.map(
                (layer) => layer.shapes[0].nodes.length
            )
        ).toEqual([4, 4]);
        expect(fontJson.glyphs[0].layers[0].shapes[0].nodes[0].nodetype).toBe(
            'Curve'
        );
        expect(fontJson.glyphs[0].layers[1].shapes[0].nodes[3].nodetype).toBe(
            'Curve'
        );
    });

    test('glyph-scoped undo restores linked-layer smooth point slide cleanly', () => {
        const font = Font.fromData(makeMinimalFont());
        const fontJson = font.toJSON();
        const baseLayer = cloneValue(fontJson.glyphs[0].layers[0]);
        fontJson.glyphs[0].layers = [
            {
                ...cloneValue(baseLayer),
                id: 'layer-1',
                shapes: [
                    {
                        nodes: [
                            { x: 0, y: 0, nodetype: 'Curve', smooth: true },
                            { x: 25, y: 80, nodetype: 'OffCurve' },
                            { x: 75, y: 80, nodetype: 'OffCurve' },
                            { x: 100, y: 0, nodetype: 'Curve', smooth: true },
                            { x: 125, y: -80, nodetype: 'OffCurve' },
                            { x: 175, y: -80, nodetype: 'OffCurve' },
                            { x: 200, y: 0, nodetype: 'Curve', smooth: true }
                        ],
                        closed: false
                    }
                ],
                anchors: [],
                guides: []
            },
            {
                ...cloneValue(baseLayer),
                id: 'layer-1b',
                shapes: [
                    {
                        nodes: [
                            { x: 0, y: 20, nodetype: 'Curve', smooth: true },
                            { x: 25, y: 100, nodetype: 'OffCurve' },
                            { x: 75, y: 100, nodetype: 'OffCurve' },
                            { x: 100, y: 20, nodetype: 'Curve', smooth: true },
                            { x: 125, y: -60, nodetype: 'OffCurve' },
                            { x: 175, y: -60, nodetype: 'OffCurve' },
                            { x: 200, y: 20, nodetype: 'Curve', smooth: true }
                        ],
                        closed: false
                    }
                ],
                anchors: [],
                guides: []
            }
        ];

        const originalNodesByLayer = fontJson.glyphs[0].layers.map((layer) =>
            cloneValue(layer.shapes[0].nodes)
        );

        const bridge = new ChangeBridge('test-linked-slide-point');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;

        const glyph = font.findGlyph('A');
        const layer1 = glyph.findLayerById('layer-1');
        const layer2 = glyph.findLayerById('layer-1b');

        withSuppressedModelRecording(() => {
            const result = layer1.paths[0]._slideSmoothOnCurve(3, {
                x: 120,
                y: 10
            });
            expect(result).not.toBeNull();
            layer2.paths[0]._slideSmoothOnCurveAtT(3, result.t);
        });
        bridge.syncGlyphFromJson('A', 'Move point along curve');

        const historyItems = buildHistoryStackItems(bridge.getChangeLog(), {
            glyphName: 'A',
            layerId: 'layer-1',
            includeUndone: true
        });
        expect(historyItems).toHaveLength(1);
        expect(historyItems[0].undoScope).toBe('glyph');
        expect(fontJson.glyphs[0].layers[0].shapes[0].nodes[3].x).not.toBe(
            originalNodesByLayer[0][3].x
        );
        expect(fontJson.glyphs[0].layers[1].shapes[0].nodes[3].x).not.toBe(
            originalNodesByLayer[1][3].x
        );

        expect(bridge.undo('A', 'layer-1')).toEqual(
            expect.objectContaining({
                scope: 'glyph',
                glyphName: 'A',
                layerId: null
            })
        );

        expect(fontJson.glyphs[0].layers[0].shapes[0].nodes).toEqual(
            originalNodesByLayer[0]
        );
        expect(fontJson.glyphs[0].layers[1].shapes[0].nodes).toEqual(
            originalNodesByLayer[1]
        );
    });

    test('undo works after two consecutive syncs - each sync is a separate undo step', () => {
        const { bridge, fontJson } = createTestBridge('test-1');

        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson('A', 'Drag 1');

        fontJson.glyphs[0].layers[0].width = 800;
        bridge.syncGlyphFromJson('A', 'Drag 2');

        // stopCapturing() is called after each syncGlyphFromJson, so each sync
        // becomes its own undo step regardless of the 500ms captureTimeout.
        expect(bridge.canUndo('A')).toBe(true);
        bridge.undo('A');
        // First undo reverts Drag 2: width goes back to 700
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(700);

        // Second undo reverts Drag 1: width goes back to original 600
        expect(bridge.canUndo('A')).toBe(true);
        bridge.undo('A');
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(600);
    });

    test('synthetic layer edit and later outline sync remain separate undo steps', () => {
        const { bridge, fontJson } = createTestBridge('test-1');

        bridge.beginTransaction('Python script');
        bridge.applySyntheticChangeSet('Python script', [
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'width'],
                oldValue: 600,
                newValue: 650
            }
        ]);
        bridge.endTransaction();

        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson(
            'A',
            'Drag 1',
            undefined,
            undefined,
            'layer-1'
        );

        expect(bridge.canUndo('A', 'layer-1')).toBe(true);
        expect(bridge.undo('A', 'layer-1')).toEqual(
            expect.objectContaining({
                scope: 'layer',
                glyphName: 'A',
                layerId: 'layer-1'
            })
        );
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(650);

        expect(bridge.canUndo('A', 'layer-1')).toBe(true);
        expect(bridge.undo('A', 'layer-1')).toEqual(
            expect.objectContaining({
                scope: 'layer',
                glyphName: 'A',
                layerId: 'layer-1'
            })
        );
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(600);
    });

    test('font-scoped synthetic edit does not undo prior layer outline edit', () => {
        const { bridge, fontJson } = createTestBridge('test-1');

        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson(
            'A',
            'Drag 1',
            undefined,
            undefined,
            'layer-1'
        );

        bridge.beginTransaction('Python script');
        bridge.applySyntheticChangeSet('Python script', [
            {
                op: 'set',
                path: ['format_specific', 'a'],
                oldValue: undefined,
                newValue: 'b'
            }
        ]);
        bridge.endTransaction();

        expect(bridge.canUndo()).toBe(true);
        expect(bridge.undo()).toEqual(
            expect.objectContaining({
                scope: 'font',
                glyphName: null,
                layerId: null
            })
        );

        expect(
            getYPath(bridge.fontMap, ['format_specific', 'a'])
        ).toBeUndefined();
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(700);

        expect(bridge.canRedo()).toBe(true);
        expect(bridge.redo()).toEqual(
            expect.objectContaining({
                scope: 'font',
                glyphName: null,
                layerId: null
            })
        );
        expect(getYPath(bridge.fontMap, ['format_specific', 'a'])).toBe('b');
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(700);
    });

    test('syncGlyphFromJson prunes removed layers from Y.Doc', () => {
        const { bridge, fontJson } = createTestBridge('test-1');

        // Add an extra layer and sync it first
        fontJson.glyphs[0].layers.push({
            id: 'layer-temp',
            name: 'Temp',
            width: 500,
            master: {
                type: 'DefaultForMaster',
                master: 'master-regular'
            },
            smart_component_location: {},
            color: null,
            layer_index: 1,
            is_background: false,
            background_layer_id: null,
            location: {},
            format_specific: {},
            shapes: []
        });
        bridge.syncGlyphFromJson('A', 'Add temp layer');

        expect(
            getYPath(bridge.fontMap, ['glyphs', 'A', 'layers', 'layer-temp'])
        ).toBeDefined();

        // Remove from source JSON and sync again; Y.Doc should prune it
        fontJson.glyphs[0].layers = fontJson.glyphs[0].layers.filter(
            (layer) => layer.id !== 'layer-temp'
        );
        bridge.syncGlyphFromJson('A', 'Remove temp layer');

        expect(
            getYPath(bridge.fontMap, ['glyphs', 'A', 'layers', 'layer-temp'])
        ).toBeUndefined();
    });

    test('second window receives both consecutive syncs', () => {
        // Primary
        const font1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('primary');
        bridge1.initFromJson(font1);
        // Secondary bootstraps from primary's state (matching real setup)
        const bridge2 = new ChangeBridge('secondary');
        bridge2.applyFullState(bridge1.getFullState());

        const sync1 = new WindowSync(bridge1, 'test-sync-consecutive');
        const sync2 = new WindowSync(bridge2, 'test-sync-consecutive');

        const remoteEntries = [];
        bridge2.onRemoteChange((entries) => remoteEntries.push('update'));

        // First drag
        font1.glyphs[0].layers[0].width = 700;
        bridge1.syncGlyphFromJson('A', 'Drag');
        flushTimers();

        expect(remoteEntries.length).toBe(1);
        expect(
            getYPath(bridge2.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(700);

        // Second drag
        font1.glyphs[0].layers[0].width = 800;
        bridge1.syncGlyphFromJson('A', 'Drag');
        flushTimers();

        expect(remoteEntries.length).toBe(2);
        expect(
            getYPath(bridge2.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(800);

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('change log entry has meaningful values', () => {
        const { bridge, fontJson } = createTestBridge('test-1');

        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson('A', 'Drag');

        const log = bridge.getChangeLog();
        const entry = log[log.length - 1];
        expect(entry.objectType).toBe('glyph');
        expect(entry.objectId).toBe('A');
        expect(entry.transactionLabel).toBe('Drag');
        // oldValue = glyph name, newValue = label
        expect(entry.oldValue).toBe('A');
        expect(entry.newValue).toBe('Drag');
    });

    test('change log entries are broadcast to remote window', () => {
        const font1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('primary');
        bridge1.initFromJson(font1);
        const bridge2 = new ChangeBridge('secondary');
        bridge2.applyFullState(bridge1.getFullState());

        const sync1 = new WindowSync(bridge1, 'test-log-sync');
        const sync2 = new WindowSync(bridge2, 'test-log-sync');

        bridge2.onRemoteChange(() => {});

        // Make an edit
        font1.glyphs[0].layers[0].width = 700;
        bridge1.syncGlyphFromJson('A', 'Drag');
        flushTimers();

        // Remote bridge should have the change log entry
        const remoteLog = bridge2.getChangeLog();
        expect(remoteLog.length).toBe(1);
        expect(remoteLog[0].objectId).toBe('A');
        expect(remoteLog[0].transactionLabel).toBe('Drag');

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('undo changes broadcast to remote window', () => {
        const font1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('primary');
        bridge1.initFromJson(font1);
        const bridge2 = new ChangeBridge('secondary');
        bridge2.applyFullState(bridge1.getFullState());

        const sync1 = new WindowSync(bridge1, 'test-undo-sync');
        const sync2 = new WindowSync(bridge2, 'test-undo-sync');

        const remoteUpdates = [];
        bridge2.onRemoteChange(() => remoteUpdates.push('update'));

        // Make an edit then undo
        font1.glyphs[0].layers[0].width = 700;
        bridge1.syncGlyphFromJson('A', 'Drag');
        flushTimers();

        expect(
            getYPath(bridge2.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(700);

        bridge1.undo('A');
        flushTimers();

        // Undo should propagate
        expect(
            getYPath(bridge2.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(600);

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('undo/redo add change log entries for history view', () => {
        const { bridge, fontJson } = createTestBridge('test-1');

        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson('A', 'Drag');

        const logBefore = bridge.getChangeLog().length;
        bridge.undo('A');
        const logAfter = bridge.getChangeLog().length;

        // Undo should add a log entry
        expect(logAfter).toBe(logBefore + 1);
        const undoEntry = bridge.getChangeLog()[logAfter - 1];
        expect(undoEntry.transactionLabel).toBe('Undo');
        expect(undoEntry.objectType).toBe('glyph');
        expect(undoEntry.objectId).toBe('A');

        bridge.redo('A');
        const logAfterRedo = bridge.getChangeLog().length;
        expect(logAfterRedo).toBe(logAfter + 1);
        const redoEntry = bridge.getChangeLog()[logAfterRedo - 1];
        expect(redoEntry.transactionLabel).toBe('Redo');
    });

    test('undo emits layerFingerprintChanged when replay changes a layer fingerprint', () => {
        const { bridge, fontJson } = createTestBridge('fingerprint-undo');
        const dispatchSpy = jest.spyOn(window, 'dispatchEvent');

        fontJson.glyphs[0].layers[0].shapes.push({
            nodes: [
                { x: 10, y: 10, nodetype: 'line', smooth: false },
                { x: 20, y: 20, nodetype: 'line', smooth: false },
                { x: 30, y: 10, nodetype: 'line', smooth: false }
            ],
            closed: true,
            format_specific: { seed: true }
        });
        bridge.syncGlyphFromJson(
            'A',
            'Add path',
            undefined,
            undefined,
            'layer-1'
        );
        dispatchSpy.mockClear();

        bridge.undo('A', 'layer-1');

        expect(dispatchSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'layerFingerprintChanged',
                detail: {
                    glyphName: 'A',
                    layerId: 'layer-1'
                }
            })
        );

        dispatchSpy.mockRestore();
    });

    test('sync window receives edits without calling initFromJson', () => {
        // Primary: initialized normally
        const font1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('primary');
        bridge1.initFromJson(font1);

        // Secondary: only setFontJson (no initFromJson — no divergent CRDT state)
        const font2 = makeMinimalFont();
        const bridge2 = new ChangeBridge('secondary');
        bridge2.setFontJson(font2);

        const sync1 = new WindowSync(bridge1, 'test-sync-noinit');
        const sync2 = new WindowSync(bridge2, 'test-sync-noinit');

        // Bootstrap via full state request/response
        sync2.requestFullState();
        flushTimers();

        // Secondary should now have the font data from primary's Y.Doc
        expect(
            getYPath(bridge2.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(600);

        const remoteUpdates = [];
        bridge2.onRemoteChange(() => remoteUpdates.push('update'));

        // Primary makes edits
        font1.glyphs[0].layers[0].width = 700;
        bridge1.syncGlyphFromJson('A', 'Drag 1');
        flushTimers();

        expect(remoteUpdates.length).toBe(1);
        expect(
            getYPath(bridge2.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(700);

        // Second edit
        font1.glyphs[0].layers[0].width = 800;
        bridge1.syncGlyphFromJson('A', 'Drag 2');
        flushTimers();

        expect(remoteUpdates.length).toBe(2);
        expect(
            getYPath(bridge2.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(800);

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('linked window emits layerFingerprintChanged when receiving a remote fingerprint-changing update', () => {
        const font1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('primary');
        bridge1.initFromJson(font1);
        const bridge2 = new ChangeBridge('secondary');
        bridge2.applyFullState(bridge1.getFullState());

        const sync1 = new WindowSync(bridge1, 'test-fingerprint-remote-sync');
        const sync2 = new WindowSync(bridge2, 'test-fingerprint-remote-sync');
        const dispatchSpy = jest.spyOn(window, 'dispatchEvent');
        dispatchSpy.mockClear();

        font1.glyphs[0].layers[0].shapes.push({
            nodes: [
                { x: 10, y: 10, nodetype: 'line', smooth: false },
                { x: 20, y: 20, nodetype: 'line', smooth: false },
                { x: 30, y: 10, nodetype: 'line', smooth: false }
            ],
            closed: true,
            format_specific: { seed: true }
        });
        bridge1.syncGlyphFromJson(
            'A',
            'Add path',
            undefined,
            undefined,
            'layer-1'
        );
        flushTimers();

        expect(dispatchSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'layerFingerprintChanged',
                detail: {
                    glyphName: 'A',
                    layerId: 'layer-1'
                }
            })
        );

        dispatchSpy.mockRestore();
        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('linked window preserves full layer data when remote anchor sync sends a partial layer fragment', () => {
        const font1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('primary');
        bridge1.initFromJson(font1);
        const bridge2 = new ChangeBridge('secondary');
        bridge2.applyFullState(bridge1.getFullState());

        const sync1 = new WindowSync(
            bridge1,
            'test-partial-anchor-remote-sync'
        );
        const sync2 = new WindowSync(
            bridge2,
            'test-partial-anchor-remote-sync'
        );

        font1.glyphs[0].layers[0] = {
            id: 'layer-1',
            anchors: [{ name: 'top', x: 320, y: 720 }]
        };

        bridge1.syncGlyphFromJson(
            'A',
            'Drag anchor',
            undefined,
            undefined,
            'layer-1'
        );
        flushTimers();

        expect(
            getYPath(bridge2.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(600);
        expect(
            getYPath(bridge2.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'anchors',
                0,
                'x'
            ])
        ).toBe(320);
        expect(
            getYPath(bridge2.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes',
                0,
                'nodes',
                0,
                'x'
            ])
        ).toBe(100);

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('linked window keeps sibling default layers when a remote single-layer edit arrives', () => {
        const senderFontJson = makeThreeMasterThreeLayerFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-three-layer');
        const receiverBridge = new ChangeBridge('receiver-three-layer');
        let lastUpdate = null;

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyFullState(senderBridge.getFullState());
        senderBridge.onLocalUpdate((update) => {
            lastUpdate = update;
        });

        senderFontJson.glyphs[0].layers[0].anchors[0].x = 123;
        senderBridge.syncGlyphFromJson(
            'A',
            'Drag anchor',
            undefined,
            undefined,
            'master-extrathin'
        );

        receiverBridge.applyRemoteUpdate(
            lastUpdate,
            senderBridge.getNewChangeLogEntries()
        );

        expect(receiverFontJson.glyphs[0].layers).toHaveLength(3);
        expect(
            receiverFontJson.glyphs[0].layers.map((layer) => layer.id)
        ).toEqual(['master-extrathin', 'master-regular', 'master-bold']);
        expect(receiverFontJson.glyphs[0].layers[1].master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-regular'
        });
        expect(receiverFontJson.glyphs[0].layers[0].master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-extrathin'
        });
        expect('name' in receiverFontJson.glyphs[0].layers[1]).toBe(false);
        expect(receiverFontJson.glyphs[0].layers[0].anchors[0].x).toBe(123);
    });

    test('linked window preserves full layer data when remote glyph sync sends a partial layer fragment', () => {
        const font1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('primary');
        bridge1.initFromJson(font1);
        const bridge2 = new ChangeBridge('secondary');
        bridge2.applyFullState(bridge1.getFullState());

        const sync1 = new WindowSync(bridge1, 'test-partial-glyph-remote-sync');
        const sync2 = new WindowSync(bridge2, 'test-partial-glyph-remote-sync');

        font1.glyphs[0] = {
            name: 'A',
            layers: [
                {
                    id: 'layer-1',
                    anchors: [{ name: 'top', x: 340, y: 740 }]
                }
            ]
        };

        bridge1.syncGlyphFromJson('A', 'Add point');
        flushTimers();

        expect(
            getYPath(bridge2.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(600);
        expect(
            getYPath(bridge2.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'anchors',
                0,
                'x'
            ])
        ).toBe(340);
        expect(
            getYPath(bridge2.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes',
                0,
                'nodes',
                0,
                'x'
            ])
        ).toBe(100);

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('linked window preserves all layer masters after remote undo of single-layer edit', () => {
        const senderFontJson = makeThreeMasterThreeLayerFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-undo-master');
        const receiverBridge = new ChangeBridge('receiver-undo-master');

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyFullState(senderBridge.getFullState());

        const sync1 = new WindowSync(senderBridge, 'test-undo-master-sync');
        const sync2 = new WindowSync(receiverBridge, 'test-undo-master-sync');

        // Simulate a mouse drag transaction with multiple buffered operations
        senderBridge.beginTransaction('Drag anchor');
        senderFontJson.glyphs[0].layers[0].anchors[0].x = 100;
        senderBridge.syncGlyphFromJson(
            'A',
            'Drag anchor',
            undefined,
            undefined,
            'master-extrathin'
        );
        senderFontJson.glyphs[0].layers[0].anchors[0].x = 110;
        senderBridge.syncGlyphFromJson(
            'A',
            'Drag anchor',
            undefined,
            undefined,
            'master-extrathin'
        );
        senderFontJson.glyphs[0].layers[0].anchors[0].x = 123;
        senderBridge.syncGlyphFromJson(
            'A',
            'Drag anchor',
            undefined,
            undefined,
            'master-extrathin'
        );
        senderBridge.endTransaction();
        flushTimers();

        // Verify receiver has the final edit
        expect(receiverFontJson.glyphs[0].layers[0].anchors[0].x).toBe(123);

        // Sender undoes
        senderBridge.undo('A', 'master-extrathin');
        flushTimers();

        // Verify all layers still have valid master after undo
        expect(receiverFontJson.glyphs[0].layers).toHaveLength(3);
        expect(receiverFontJson.glyphs[0].layers[0].master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-extrathin'
        });
        expect(receiverFontJson.glyphs[0].layers[1].master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-regular'
        });
        expect(receiverFontJson.glyphs[0].layers[2].master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-bold'
        });

        sync1.destroy();
        sync2.destroy();
        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('linked window applies explicit layer-property removals truthfully', () => {
        const senderFontJson = makeMinimalFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-remove-layer-prop');
        const receiverBridge = new ChangeBridge('receiver-remove-layer-prop');
        let lastUpdate = null;

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyFullState(senderBridge.getFullState());
        senderBridge.onLocalUpdate((update) => {
            lastUpdate = update;
        });

        const oldGuides = cloneValue(senderFontJson.glyphs[0].layers[0].guides);
        delete senderFontJson.glyphs[0].layers[0].guides;

        senderBridge.beginTransaction('Delete layer guides');
        senderBridge.recordRemove(
            ['glyphs', 'A', 'layers', 'layer-1', 'guides'],
            oldGuides
        );
        senderBridge.endTransaction();

        receiverBridge.applyRemoteUpdate(
            lastUpdate,
            senderBridge.getNewChangeLogEntries()
        );

        expect(
            getYPath(receiverBridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'guides'
            ])
        ).toBeUndefined();
        expect('guides' in receiverFontJson.glyphs[0].layers[0]).toBe(false);
        expect(receiverFontJson.glyphs[0].layers[0].anchors).toEqual(
            senderFontJson.glyphs[0].layers[0].anchors
        );

        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('syncLayersFromJson preserves multi-target worker replay metadata across remote apply', () => {
        const senderFontJson = makeMinimalFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-multi-target');
        const receiverBridge = new ChangeBridge('receiver-multi-target');
        let lastUpdate = null;

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyFullState(senderBridge.getFullState());
        senderBridge.onLocalUpdate((update) => {
            lastUpdate = update;
        });

        senderFontJson.glyphs[0].layers[0].anchors[0].x = 321;
        senderFontJson.glyphs[1].layers[0].width = 777;
        const changedTargets = [
            { glyphName: 'A', layerId: 'layer-1' },
            { glyphName: 'B', layerId: 'layer-2' }
        ];

        senderBridge.syncLayersFromJson(
            changedTargets,
            'Batch dependent layer refresh',
            undefined,
            undefined,
            undefined,
            changedTargets
        );

        const remoteEntries = senderBridge.getNewChangeLogEntries();
        const changeEntries = remoteEntries.filter(
            (entry) => entry.historyAction === 'change'
        );

        expect(changeEntries).toHaveLength(2);
        changeEntries.forEach((entry) => {
            expect(entry.workerReplayTargets).toEqual(changedTargets);
        });

        receiverBridge.applyRemoteUpdate(lastUpdate, remoteEntries);

        expect(receiverFontJson.glyphs[0].layers[0].anchors[0].x).toBe(321);
        expect(receiverFontJson.glyphs[1].layers[0].width).toBe(777);
        expect(receiverFontJson.glyphs[0].layers[0].master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-regular'
        });
        expect(receiverFontJson.glyphs[1].layers[0].master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-regular'
        });

        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('applyRemoteUpdate repairs a malformed remote layer root from the full-state payload', () => {
        const senderFontJson = makeThreeMasterThreeLayerFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-repair');
        const receiverBridge = new ChangeBridge('receiver-repair');

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyFullState(senderBridge.getFullState());

        senderFontJson.glyphs[0].layers[0].anchors[0].x = 123;
        senderBridge.syncGlyphFromJson(
            'A',
            'Drag anchor',
            undefined,
            undefined,
            'master-extrathin'
        );
        const remoteEntries = senderBridge.getNewChangeLogEntries();

        const corruptDoc = new Y.Doc();
        const corruptFontMap = corruptDoc.getMap('font');
        jsonToYDoc(senderFontJson, corruptFontMap);
        setYPath(
            corruptFontMap,
            ['glyphs', 'A', 'layers', 'master-extrathin'],
            'Drag anchor'
        );

        receiverBridge.applyRemoteUpdate(
            Y.encodeStateAsUpdate(corruptDoc),
            remoteEntries,
            senderBridge.getFullState()
        );

        expect(
            getYPath(receiverBridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'master-extrathin',
                'id'
            ])
        ).toBe('master-extrathin');
        expect(
            getYPath(receiverBridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'master-extrathin',
                'anchors',
                0,
                'x'
            ])
        ).toBe(123);
        expect(receiverFontJson.glyphs[0].layers).toHaveLength(3);
        expect(receiverFontJson.glyphs[0].layers[0].id).toBe(
            'master-extrathin'
        );
        expect(receiverFontJson.glyphs[0].layers[0].anchors[0].x).toBe(123);

        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('full-state sync canonicalizes linked raw layer snapshots by dropping undefined and transient fields', () => {
        const senderFontJson = makeThreeMasterThreeLayerFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-canonical');
        const receiverBridge = new ChangeBridge('receiver-canonical');

        receiverFontJson.glyphs[0].layers[0].name = undefined;
        receiverFontJson.glyphs[0].layers[0].height = undefined;
        receiverFontJson.glyphs[0].layers[0].vertWidth = undefined;
        receiverFontJson.glyphs[0].layers[0].isInterpolated = false;

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyFullState(senderBridge.getFullState());

        expect('name' in receiverFontJson.glyphs[0].layers[0]).toBe(false);
        expect('height' in receiverFontJson.glyphs[0].layers[0]).toBe(false);
        expect('vertWidth' in receiverFontJson.glyphs[0].layers[0]).toBe(false);
        expect('isInterpolated' in receiverFontJson.glyphs[0].layers[0]).toBe(
            false
        );

        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('sender-side undo restores the edited anchor after batched dependent layer refresh', () => {
        const fontJson = makeMinimalFont();
        const bridge = new ChangeBridge('sender-anchor-undo');
        bridge.initFromJson(fontJson);

        const originalAnchorX = fontJson.glyphs[0].layers[0].anchors[0].x;
        const originalWidthB = fontJson.glyphs[1].layers[0].width;

        fontJson.glyphs[0].layers[0].anchors[0].x = 321;
        fontJson.glyphs[1].layers[0].width = 777;
        const changedTargets = [
            { glyphName: 'A', layerId: 'layer-1' },
            { glyphName: 'B', layerId: 'layer-2' }
        ];

        bridge.syncLayersFromJson(
            changedTargets,
            'Batch dependent layer refresh',
            undefined,
            undefined,
            undefined,
            changedTargets
        );

        expect(fontJson.glyphs[0].layers[0].anchors[0].x).toBe(321);
        expect(fontJson.glyphs[1].layers[0].width).toBe(777);

        const undoResult = bridge.undo('A', 'layer-1');

        expect(undoResult).not.toBeNull();
        expect(fontJson.glyphs[0].layers[0].anchors[0].x).toBe(originalAnchorX);
        expect(fontJson.glyphs[1].layers[0].width).toBe(originalWidthB);

        bridge.destroy();
    });

    test('layer snapshot history stays undoable after newer layer and font-scope undos exhaust the layer undo stack', () => {
        const fontJson = makeMinimalFont();
        const bridge = new ChangeBridge('layer-replay-fallback');
        bridge.initFromJson(fontJson);

        const originalFirstPointX =
            fontJson.glyphs[0].layers[0].shapes[0].nodes[0].x;
        const originalSecondPointX =
            fontJson.glyphs[0].layers[0].shapes[0].nodes[1].x;
        const originalAnchorX = fontJson.glyphs[0].layers[0].anchors[0].x;
        const originalWidthB = fontJson.glyphs[1].layers[0].width;

        fontJson.glyphs[0].layers[0].shapes[0].nodes[0].x =
            originalFirstPointX + 40;
        bridge.syncGlyphFromJson(
            'A',
            'Drag point 1',
            undefined,
            undefined,
            'layer-1'
        );

        fontJson.glyphs[0].layers[0].shapes[0].nodes[1].x =
            originalSecondPointX - 30;
        bridge.syncGlyphFromJson(
            'A',
            'Drag point 2',
            undefined,
            undefined,
            'layer-1'
        );

        fontJson.glyphs[0].layers[0].anchors[0].x = originalAnchorX + 25;
        fontJson.glyphs[1].layers[0].width = originalWidthB + 60;
        bridge.syncLayersFromJson(
            [
                { glyphName: 'A', layerId: 'layer-1' },
                { glyphName: 'B', layerId: 'layer-2' }
            ],
            'Drag anchor',
            undefined,
            undefined,
            undefined,
            [
                { glyphName: 'A', layerId: 'layer-1' },
                { glyphName: 'B', layerId: 'layer-2' }
            ]
        );

        fontJson.glyphs[0].layers[0].shapes[0].nodes[0].x =
            originalFirstPointX + 90;
        bridge.syncGlyphFromJson(
            'A',
            'Drag point 3',
            undefined,
            undefined,
            'layer-1'
        );

        expect(bridge.undo('A', 'layer-1')).not.toBeNull();
        expect(bridge.undo('A', 'layer-1')).not.toBeNull();
        expect(fontJson.glyphs[0].layers[0].anchors[0].x).toBe(originalAnchorX);
        expect(fontJson.glyphs[1].layers[0].width).toBe(originalWidthB);

        expect(bridge.undo('A', 'layer-1')).not.toBeNull();
        expect(fontJson.glyphs[0].layers[0].shapes[0].nodes[1].x).toBe(
            originalSecondPointX
        );

        expect(bridge.canUndo('A', 'layer-1')).toBe(true);

        const replayUndoResult = bridge.undo('A', 'layer-1');

        expect(replayUndoResult).not.toBeNull();
        expect(replayUndoResult?.historyItem?.transactionLabel).toBe(
            'Drag point 1'
        );
        expect(fontJson.glyphs[0].layers[0].shapes[0].nodes[0].x).toBe(
            originalFirstPointX
        );

        bridge.destroy();
    });

    test('linked window emits layerFingerprintChanged when receiving a remote undo that changes a layer fingerprint', () => {
        const font1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('primary');
        bridge1.initFromJson(font1);
        const bridge2 = new ChangeBridge('secondary');
        bridge2.applyFullState(bridge1.getFullState());

        const sync1 = new WindowSync(bridge1, 'test-fingerprint-remote-undo');
        const sync2 = new WindowSync(bridge2, 'test-fingerprint-remote-undo');
        const dispatchSpy = jest.spyOn(window, 'dispatchEvent');
        dispatchSpy.mockClear();

        font1.glyphs[0].layers[0].shapes.push({
            nodes: [
                { x: 10, y: 10, nodetype: 'line', smooth: false },
                { x: 20, y: 20, nodetype: 'line', smooth: false },
                { x: 30, y: 10, nodetype: 'line', smooth: false }
            ],
            closed: true,
            format_specific: { seed: true }
        });
        bridge1.syncGlyphFromJson(
            'A',
            'Add path',
            undefined,
            undefined,
            'layer-1'
        );
        flushTimers();
        dispatchSpy.mockClear();

        bridge1.undo('A', 'layer-1');
        flushTimers();

        expect(dispatchSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'layerFingerprintChanged',
                detail: {
                    glyphName: 'A',
                    layerId: 'layer-1'
                }
            })
        );

        dispatchSpy.mockRestore();
        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });
});

// ── Performance regression guards ─────────────────────────────────────────
// These tests verify that layer-scoped undo uses the scope-aware fast path
// in _syncJsonFromYDoc(), which patches only the changed layer instead of
// reconstructing the entire font from Y.Doc. They do NOT use timing
// measurements; instead they assert observable structural invariants:
//
//   • After layer-scoped undo, the changed layer is correctly reverted.
//   • After layer-scoped undo, unrelated glyphs' layer objects are the
//     SAME reference as before undo (proving they were not rebuilt).
//   • After glyph/font-scoped undo, the full sync path is used (object
//     identity of unrelated glyphs IS allowed to change, but correctness
//     is still verified).

describe('ChangeBridge _syncJsonFromYDoc scope-aware undo regression', () => {
    afterEach(() => {
        delete window.changeBridge;
    });

    test('layer-scoped _syncJsonFromYDoc merges partial Y.Doc layer data with the existing layer snapshot', () => {
        const fontJson = makeMinimalFont();
        const bridge = new ChangeBridge('test-sync-ydoc-layer-partial');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;

        bridge.yDoc.transact(() => {
            deleteYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ]);
            deleteYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes'
            ]);
            setYPath(
                bridge.fontMap,
                ['glyphs', 'A', 'layers', 'layer-1', 'anchors'],
                [{ name: 'top', x: 333, y: 722 }]
            );
        }, 'test');

        bridge._syncJsonFromYDoc({ glyphName: 'A', layerId: 'layer-1' });

        expect(fontJson.glyphs[0].layers[0].width).toBe(600);
        expect(fontJson.glyphs[0].layers[0].anchors[0].x).toBe(333);
        expect(fontJson.glyphs[0].layers[0].shapes[0].nodes[0].x).toBe(100);
        expect(fontJson.glyphs[0].layers[0].master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-regular'
        });
    });

    test('full _syncJsonFromYDoc merges partial Y.Doc layer data with the existing glyph snapshot', () => {
        const fontJson = makeMinimalFont();
        const bridge = new ChangeBridge('test-sync-ydoc-glyph-partial');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;

        bridge.yDoc.transact(() => {
            deleteYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ]);
            deleteYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes'
            ]);
            setYPath(
                bridge.fontMap,
                ['glyphs', 'A', 'layers', 'layer-1', 'anchors'],
                [{ name: 'top', x: 345, y: 733 }]
            );
        }, 'test');

        bridge._syncJsonFromYDoc();

        expect(fontJson.glyphs[0].layers[0].width).toBe(600);
        expect(fontJson.glyphs[0].layers[0].anchors[0].x).toBe(345);
        expect(fontJson.glyphs[0].layers[0].shapes[0].nodes[0].x).toBe(100);
        expect(fontJson.glyphs[0].layers[0].master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-regular'
        });
    });

    test('full _syncJsonFromYDoc restores a missing default master tag when layer id matches a known master id', () => {
        const fontJson = makeMinimalFont();
        fontJson.glyphs[0].layers[0].id = 'master-regular';
        delete fontJson.glyphs[0].layers[0].master;

        const bridge = new ChangeBridge('test-sync-ydoc-default-master-id');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;

        bridge._syncJsonFromYDoc();

        expect(fontJson.glyphs[0].layers[0].master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-regular'
        });
    });

    test('full _syncJsonFromYDoc does not treat an empty master object as FreeFloating when layer id matches a known master id', () => {
        const fontJson = makeMinimalFont();
        fontJson.glyphs[0].layers[0].id = 'master-regular';
        fontJson.glyphs[0].layers[0].master = {};

        const bridge = new ChangeBridge('test-sync-ydoc-empty-master-object');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;

        bridge._syncJsonFromYDoc();

        expect(fontJson.glyphs[0].layers[0].master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-regular'
        });
    });

    test('layer-scoped undo patches only the changed layer — other glyph data is not rebuilt', () => {
        const fontJson = makeMinimalFont();
        const bridge = new ChangeBridge('test-scope-1');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;

        // Capture reference to glyph B's layer object BEFORE the edit.
        // If scope-aware sync is working, this exact object must survive undo.
        const glyphBLayerBefore = fontJson.glyphs[1].layers[0];
        expect(glyphBLayerBefore).toBeDefined();

        // Record a node-position change on glyph A, layer-1
        bridge.beginTransaction('Move node');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0, 'nodes', 0],
            'x',
            100,
            150
        );
        bridge.endTransaction();

        // Confirm the Y.Doc now holds the new value
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes',
                0,
                'nodes',
                0,
                'x'
            ])
        ).toBe(150);

        // Perform the undo — scope must be 'layer'
        const result = bridge.undo('A', 'layer-1');
        expect(result).toEqual(
            expect.objectContaining({
                scope: 'layer',
                glyphName: 'A',
                layerId: 'layer-1'
            })
        );

        // Y.Doc should be reverted
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes',
                0,
                'nodes',
                0,
                'x'
            ])
        ).toBe(100);

        // Glyph B's layer object MUST be the same reference as before.
        // A regression to full-font reconstruction would create a new object.
        expect(fontJson.glyphs[1].layers[0]).toBe(glyphBLayerBefore);
    });

    test('layer-scoped undo correctly patches _fontJson for the changed layer', () => {
        const fontJson = makeMinimalFont();
        const bridge = new ChangeBridge('test-scope-2');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;

        // Record a width change on glyph A, layer-1
        bridge.beginTransaction('Width change');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            700
        );
        bridge.endTransaction();

        // Override fontJson to reflect the edit (simulating what saveLayerData does)
        fontJson.glyphs[0].layers[0].width = 700;

        bridge.undo('A', 'layer-1');

        // After undo, _syncJsonFromYDoc (scope-aware) must patch the layer
        // so the width in fontJson reflects the undone value from Y.Doc.
        expect(fontJson.glyphs[0].layers[0].width).toBe(600);
    });

    test('glyph-scoped undo falls back to full sync (correctness preserved)', () => {
        const fontJson = makeMinimalFont();
        const bridge = new ChangeBridge('test-scope-3');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;

        // Record a glyph-level change (unicode, not layer-scoped)
        bridge.recordChange(['glyphs', 'A'], 'production_name', 'A', 'Aalt');

        // Perform undo at glyph scope (no layerId)
        const result = bridge.undo('A', null);
        expect(result).not.toBeNull();

        // After full sync, the Y.Doc value must be reflected in fontJson
        expect(
            getYPath(bridge.fontMap, ['glyphs', 'A', 'production_name'])
        ).toBe('A');
        expect(fontJson.glyphs[0].production_name).toBe('A');
    });
});
