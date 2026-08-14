const {
    FEATURE_CHANGE_DURATION_MS,
    FEATURE_CHANGE_FRAME_COUNT,
    buildAnimatedGlyphDrawOps,
    buildVisualClusters,
    getFeatureChangeAlphas,
    getFeatureChangeFrame,
    getInterpolatedGlyphOriginX,
    selectedClusterIsSubstituted,
    shapedRunNeedsAnimation,
    snapshotShapedRun,
    FeatureChangeAnimator
} = require('../js/glyph-canvas/feature-change-animator');

function glyph(name, overrides = {}) {
    return {
        g: overrides.g ?? 1,
        ax: overrides.ax ?? 500,
        dx: overrides.dx ?? 0,
        dy: overrides.dy ?? 0,
        cl: overrides.cl ?? 0,
        ay: 0,
        explicitGlyphName: name
    };
}

function snapshot(entries) {
    return snapshotShapedRun(
        entries.map(([name, overrides]) => glyph(name, overrides)),
        entries.map(([name]) => name)
    );
}

describe('feature-change animator', () => {
    test('quantizes elapsed time into 14 frames at 60fps', () => {
        expect(getFeatureChangeFrame(0)).toEqual({
            frame: 0,
            u: 0,
            done: false
        });
        expect(
            getFeatureChangeFrame(FEATURE_CHANGE_DURATION_MS / 14).frame
        ).toBe(1);
        expect(getFeatureChangeFrame(FEATURE_CHANGE_DURATION_MS).done).toBe(
            true
        );
        expect(FEATURE_CHANGE_FRAME_COUNT).toBe(14);
    });

    test('fades out over the first 7 frames and in over the last 7', () => {
        expect(getFeatureChangeAlphas(0)).toEqual({
            alphaOld: 1,
            alphaNew: 0
        });
        expect(getFeatureChangeAlphas(6)).toEqual({
            alphaOld: 0,
            alphaNew: 0
        });
        expect(getFeatureChangeAlphas(7)).toEqual({
            alphaOld: 0,
            alphaNew: 0
        });
        expect(getFeatureChangeAlphas(13)).toEqual({
            alphaOld: 0,
            alphaNew: 1
        });
    });

    test('does not animate identical shaping', () => {
        const run = snapshot([
            ['a', { ax: 500, cl: 0 }],
            ['b', { ax: 400, cl: 1 }]
        ]);
        expect(shapedRunNeedsAnimation(run, run)).toBe(false);
    });

    test('animates kerning-only advance changes without a substitute fade', () => {
        const from = snapshot([
            ['a', { ax: 500, cl: 0 }],
            ['v', { ax: 400, cl: 1 }]
        ]);
        const to = snapshot([
            ['a', { ax: 460, cl: 0 }],
            ['v', { ax: 400, cl: 1 }]
        ]);
        expect(shapedRunNeedsAnimation(from, to)).toBe(true);
        expect(selectedClusterIsSubstituted(from, to, 0, 0)).toBe(false);

        const ops = buildAnimatedGlyphDrawOps(from, to, 0.5, 1, 0);
        expect(ops.every((op) => op.alpha === 1 && !op.isSubstitute)).toBe(
            true
        );
        expect(getInterpolatedGlyphOriginX(from, to, 1, 0.5)).toBe(480);
    });

    test('treats a renamed cluster as a substitution', () => {
        const from = snapshot([['a', { ax: 500, cl: 0, g: 1 }]]);
        const to = snapshot([['a.ss01', { ax: 520, cl: 0, g: 2 }]]);
        expect(selectedClusterIsSubstituted(from, to, 0, 0)).toBe(true);

        const outOps = buildAnimatedGlyphDrawOps(from, to, 0, 1, 0);
        expect(outOps).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: 'a',
                    alpha: 1,
                    isSubstitute: true
                })
            ])
        );
        const inOps = buildAnimatedGlyphDrawOps(from, to, 1, 0, 1);
        expect(inOps).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: 'a.ss01',
                    alpha: 1,
                    isSubstitute: true
                })
            ])
        );
    });

    test('builds one visual cluster per HarfBuzz cluster value', () => {
        const run = snapshot([
            ['f', { ax: 300, cl: 0 }],
            ['i', { ax: 200, cl: 1 }]
        ]);
        const clusters = buildVisualClusters(run);
        expect(clusters.map((cluster) => cluster.names)).toEqual([
            ['f'],
            ['i']
        ]);
        expect(clusters[1].x).toBe(300);
    });

    test('begin/cancel and hides the outline editor for substitutions', () => {
        const frames = [];
        const originalNow = performance.now.bind(performance);
        const originalRaf = global.requestAnimationFrame;
        const originalCancel = global.cancelAnimationFrame;
        let now = 0;
        performance.now = () => now;
        global.requestAnimationFrame = (cb) => {
            frames.push(cb);
            return frames.length;
        };
        global.cancelAnimationFrame = () => {};

        const animator = new FeatureChangeAnimator(() => {});
        const from = snapshot([['f', { ax: 300, cl: 0 }]]);
        const to = snapshot([['fi', { ax: 500, cl: 0 }]]);

        try {
            expect(
                animator.begin(from, to, {
                    fromSelectedIndex: 0,
                    toSelectedIndex: 0,
                    editMode: true
                })
            ).toBe(true);
            expect(animator.shouldHideOutlineEditor()).toBe(true);
            expect(animator.getDrawState()?.alphaOld).toBe(1);

            now = FEATURE_CHANGE_DURATION_MS;
            frames[0]();
            expect(animator.isActive()).toBe(false);
            expect(animator.shouldHideOutlineEditor()).toBe(false);
        } finally {
            animator.cancel();
            performance.now = originalNow;
            global.requestAnimationFrame = originalRaf;
            global.cancelAnimationFrame = originalCancel;
        }
    });
});
