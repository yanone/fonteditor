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

    test('reuses feature button clicks for assistant-style bulk updates', async () => {
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

    test('shows compiled stylistic set names instead of the generic label', async () => {
        window.currentFontModel.features.features.push([
            'ss03',
            'feature ss03 { sub a by a.ss03; } ss03;'
        ]);
        window.currentFontModel.analyzeFeatureTables.mockImplementation(
            (tag) => ({
                hasGSUB: tag === 'dlig' || tag === 'liga' || tag === 'ss03',
                hasGPOS: false
            })
        );

        const {
            get_stylistic_set_names,
            get_font_features_with_tables
        } = require('../wasm-dist/babelfont_fontc_web');
        get_stylistic_set_names.mockReturnValue(
            JSON.stringify({ ss03: 'Geometric a g' })
        );
        get_font_features_with_tables.mockReturnValue(
            JSON.stringify({
                liga: ['GSUB'],
                dlig: ['GSUB'],
                ss03: ['GSUB']
            })
        );

        const manager = new FeaturesManager();
        manager.editingFontBytes = new Uint8Array([1, 2, 3]);
        document.body.appendChild(manager.createFeaturesSection());

        await manager.updateFeaturesUI();
        await flushUi();

        const ss03Row = manager.featuresSection.querySelector(
            'button[data-feature-tag="ss03"]'
        )?.parentElement;
        const ss03Name = ss03Row?.querySelector('.tag-description');

        expect(ss03Name?.textContent).toBe('Geometric a g');
        expect(ss03Name?.classList.contains('custom-name')).toBe(true);
    });
});
