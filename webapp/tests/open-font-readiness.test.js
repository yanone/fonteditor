const {
    shouldHandleOpenPathBeforeEditorReady
} = require('../js/open-font-readiness.ts');

describe('open font readiness gating', () => {
    it('lets cloud opens bypass full editor readiness', () => {
        expect(
            shouldHandleOpenPathBeforeEditorReady('cloud', 'cloud://asset-123')
        ).toBe(true);
    });

    it('keeps normal file opens behind editor readiness', () => {
        expect(
            shouldHandleOpenPathBeforeEditorReady(
                'memory',
                '/user/Fustat.glyphs'
            )
        ).toBe(false);
    });
});
