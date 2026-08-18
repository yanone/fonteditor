const {
    describeRestingLayerViolation,
    omitRestingLayerRuntimeKeys,
    toRestingLayerJson,
    toRestingShapeJson
} = require('../js/resting-layer-json');

describe('resting-layer-json', () => {
    test('strips interpolator keys and converts affine component transforms', () => {
        const layer = toRestingLayerJson(
            {
                id: 'layer-1',
                width: 600,
                master: { type: 'DefaultForMaster', master: 'master-1' },
                _interpolationRequestId: 9,
                isInterpolated: true,
                shapes: [
                    {
                        reference: 'a',
                        transform: [1, 0, 0, 1, 12, 34],
                        layerData: { nested: true }
                    }
                ]
            },
            { mode: 'delta' }
        );

        expect(layer._interpolationRequestId).toBeUndefined();
        expect(layer.isInterpolated).toBeUndefined();
        expect(layer.shapes[0].layerData).toBeUndefined();
        expect(layer.shapes[0].reference).toBe('a');
        expect(Array.isArray(layer.shapes[0].transform)).toBe(false);
        expect(layer.shapes[0].transform.translation).toEqual([12, 34]);
        expect(describeRestingLayerViolation(layer)).toBeNull();
    });

    test('stripInterpolatorRequestId leaves preview metrics', () => {
        const {
            stripInterpolatorRequestId
        } = require('../js/resting-layer-json');
        const layer = {
            width: 500,
            _interpolationRequestId: 4,
            _verticalMetrics: { ascender: 800 },
            isInterpolated: false
        };
        stripInterpolatorRequestId(layer);
        expect(layer._interpolationRequestId).toBeUndefined();
        expect(layer._verticalMetrics).toEqual({ ascender: 800 });
        expect(layer.isInterpolated).toBe(false);
    });

    test('replace keeps width, master, and shapes when incoming snapshot is interpolator-only', () => {
        const existing = {
            id: 'layer-1',
            width: 640,
            master: { type: 'DefaultForMaster', master: 'master-1' },
            shapes: [{ nodes: ['100 200 l'], closed: true }]
        };
        const replaced = toRestingLayerJson(
            {
                _interpolationRequestId: 3,
                shapes: [{ id: 'ghost', transform: [1, 0, 0, 1, 0, 0] }]
            },
            { existing, mode: 'replace' }
        );

        expect(replaced.width).toBe(640);
        expect(replaced.master).toEqual(existing.master);
        expect(replaced._interpolationRequestId).toBeUndefined();
        expect(replaced.shapes).toEqual(existing.shapes);
    });

    test('applyRestingShapeGeometryToEditorLayer keeps nested component layerData', () => {
        const {
            applyRestingShapeGeometryToEditorLayer
        } = require('../js/resting-layer-json');
        const nested = { shapes: [{ nodes: [{ x: 0, y: 0, type: 'Line' }] }] };
        const editorLayer = {
            width: 500,
            shapes: [
                {
                    reference: 'a',
                    transform: {
                        translation: [10, 20],
                        rotation: 0,
                        scale: [1, 1],
                        skew: [0, 0]
                    },
                    layerData: nested,
                    isInterpolated: false
                }
            ]
        };
        const restingLayer = {
            width: 540,
            shapes: [
                {
                    reference: 'a',
                    transform: {
                        translation: [40, 20],
                        rotation: 0,
                        scale: [1, 1],
                        skew: [0, 0]
                    }
                }
            ]
        };

        applyRestingShapeGeometryToEditorLayer(editorLayer, restingLayer);

        expect(editorLayer.shapes[0].layerData).toBe(nested);
        expect(editorLayer.shapes[0].isInterpolated).toBe(false);
        expect(editorLayer.shapes[0].transform.translation).toEqual([40, 20]);
        expect(editorLayer.shapes[0]).not.toBe(restingLayer.shapes[0]);
    });

    test('omitRestingLayerRuntimeKeys leaves identity fields', () => {
        const next = omitRestingLayerRuntimeKeys({
            width: 10,
            _verticalMetrics: { ascender: 800 },
            master: { type: 'DefaultForMaster', master: 'm' }
        });
        expect(next.width).toBe(10);
        expect(next._verticalMetrics).toBeUndefined();
        expect(next.master).toEqual({ type: 'DefaultForMaster', master: 'm' });
    });

    test('strict shape conversion rejects unrecognized objects', () => {
        expect(() =>
            toRestingShapeJson(
                { id: 'ghost', transform: [1, 0, 0, 1, 0, 0] },
                { strict: true, context: 'layer storage serialization' }
            )
        ).toThrow(/not a Path or Component before layer storage serialization/);
    });
});
