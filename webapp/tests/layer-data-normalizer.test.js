jest.mock('../js/logger', () => ({
    Logger: class {
        log() {}
        warn() {}
        error() {}
    }
}));

const { LayerDataNormalizer } = require('../js/layer-data-normalizer');

describe('LayerDataNormalizer', () => {
    test('preserves missing layer width instead of synthesizing zero', () => {
        const normalized = LayerDataNormalizer.normalize({ shapes: [] });

        expect(normalized).not.toHaveProperty('width');
    });

    test('preserves explicit zero layer width', () => {
        const normalized = LayerDataNormalizer.normalize({
            width: 0,
            shapes: []
        });

        expect(normalized.width).toBe(0);
    });
});
