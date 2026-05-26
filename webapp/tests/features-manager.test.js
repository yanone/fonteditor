describe('FeaturesManager setEnabledFeatures', () => {
    let FeaturesManager;
    let originalRequestAnimationFrame;

    const flushUi = async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    };

    beforeEach(() => {
        jest.resetModules();
        document.body.innerHTML = '';
        originalRequestAnimationFrame = window.requestAnimationFrame;
        window.requestAnimationFrame = (callback) => {
            callback(0);
            return 1;
        };
        window.currentFontModel = {
            features: {
                features: [
                    ['dlig', 'feature dlig { sub a by a.alt; } dlig;'],
                    ['liga', 'feature liga { sub f i by fi; } liga;']
                ]
            },
            analyzeFeatureTables: jest.fn((tag) => ({
                hasGSUB: tag === 'dlig' || tag === 'liga',
                hasGPOS: false
            }))
        };

        ({ FeaturesManager } = require('../js/glyph-canvas/features'));
    });

    afterEach(() => {
        window.requestAnimationFrame = originalRequestAnimationFrame;
        delete window.currentFontModel;
    });

    test('reuses feature button clicks for agent-style bulk updates', async () => {
        const manager = new FeaturesManager();
        const changeSpy = jest.fn();
        manager.on('change', changeSpy);

        document.body.appendChild(manager.createFeaturesSection());

        await manager.updateFeaturesUI();
        await flushUi();

        const ligaButton = manager.featuresSection.querySelector(
            'button[data-feature-tag="liga"]'
        );
        const dligButton = manager.featuresSection.querySelector(
            'button[data-feature-tag="dlig"]'
        );

        expect(ligaButton.classList.contains('enabled')).toBe(true);
        expect(dligButton.classList.contains('enabled')).toBe(false);

        await manager.setEnabledFeatures(['dlig']);

        expect(manager.featureSettings.liga).toBe(false);
        expect(manager.featureSettings.dlig).toBe(true);
        expect(ligaButton.classList.contains('enabled')).toBe(false);
        expect(dligButton.classList.contains('enabled')).toBe(true);
        expect(changeSpy).toHaveBeenCalledTimes(2);
    });
});
