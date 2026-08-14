import { Logger } from '../logger';
import {
    applyFontPointScreenLock,
    type ViewportPanLockTarget
} from './viewport';
import type { ShapedGlyph } from './textrun';

const console = new Logger('FeatureChangeAnimator');

export const FEATURE_CHANGE_FRAME_COUNT = 14;
export const FEATURE_CHANGE_HALF_FRAMES = 7;
export const FEATURE_CHANGE_DURATION_MS =
    (1000 / 60) * FEATURE_CHANGE_FRAME_COUNT;

const ADVANCE_EPSILON = 0.05;

export interface ShapedRunSnapshot {
    glyphs: ShapedGlyph[];
    names: string[];
}

export interface VisualCluster {
    cl: number;
    startIndex: number;
    glyphs: ShapedGlyph[];
    names: string[];
    x: number;
    width: number;
}

export interface FeatureChangeDrawState {
    from: ShapedRunSnapshot;
    to: ShapedRunSnapshot;
    u: number;
    frame: number;
    alphaOld: number;
    alphaNew: number;
    fadeActiveOutlines: boolean;
    fromSelectedIndex: number;
    toSelectedIndex: number;
}

export function snapshotShapedRun(
    glyphs: ShapedGlyph[] | null | undefined,
    names: string[] | null | undefined
): ShapedRunSnapshot {
    const sourceGlyphs = Array.isArray(glyphs) ? glyphs : [];
    const sourceNames = Array.isArray(names) ? names : [];
    return {
        glyphs: sourceGlyphs.map((glyph) => ({ ...glyph })),
        names: sourceGlyphs.map(
            (glyph, index) =>
                sourceNames[index] || glyph.explicitGlyphName || ''
        )
    };
}

export function lerp(a: number, b: number, u: number): number {
    return a + (b - a) * u;
}

export function shapedRunHorizontalExtents(
    glyphs: ShapedGlyph[],
    selectedIndex: number,
    selectedVisualWidth: number | null
): { minX: number; maxX: number } | null {
    if (!Array.isArray(glyphs) || glyphs.length === 0) {
        return null;
    }

    let xPosition = 0;
    let minX = Infinity;
    let maxX = -Infinity;

    for (let glyphIndex = 0; glyphIndex < glyphs.length; glyphIndex++) {
        const shapedGlyph = glyphs[glyphIndex];
        const xOffset = shapedGlyph.dx || 0;
        const xAdvance = shapedGlyph.ax || 0;
        const glyphStartX = xPosition + xOffset;
        const glyphVisualAdvance =
            glyphIndex === selectedIndex &&
            selectedVisualWidth !== null &&
            Number.isFinite(selectedVisualWidth)
                ? selectedVisualWidth
                : xAdvance;
        const glyphEndX = glyphStartX + glyphVisualAdvance;
        minX = Math.min(minX, glyphStartX, glyphEndX);
        maxX = Math.max(maxX, glyphStartX, glyphEndX);
        xPosition += xAdvance;
    }

    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || maxX <= minX) {
        return null;
    }

    return { minX, maxX };
}

export function getFeatureChangeFrame(elapsedMs: number): {
    frame: number;
    u: number;
    done: boolean;
} {
    if (elapsedMs >= FEATURE_CHANGE_DURATION_MS) {
        return { frame: FEATURE_CHANGE_FRAME_COUNT - 1, u: 1, done: true };
    }
    if (elapsedMs <= 0) {
        return { frame: 0, u: 0, done: false };
    }
    const frame = Math.min(
        FEATURE_CHANGE_FRAME_COUNT - 1,
        Math.floor(
            (elapsedMs / FEATURE_CHANGE_DURATION_MS) *
                FEATURE_CHANGE_FRAME_COUNT
        )
    );
    return {
        frame,
        u: frame / (FEATURE_CHANGE_FRAME_COUNT - 1),
        done: false
    };
}

export function getFeatureChangeAlphas(frame: number): {
    alphaOld: number;
    alphaNew: number;
} {
    if (frame < FEATURE_CHANGE_HALF_FRAMES) {
        const denom = FEATURE_CHANGE_HALF_FRAMES - 1;
        return { alphaOld: 1 - frame / denom, alphaNew: 0 };
    }
    const fadeIn = frame - FEATURE_CHANGE_HALF_FRAMES;
    const denom = FEATURE_CHANGE_HALF_FRAMES - 1;
    return { alphaOld: 0, alphaNew: fadeIn / denom };
}

export function namesEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

function advancesDiffer(from: ShapedGlyph, to: ShapedGlyph): boolean {
    return (
        Math.abs((from.ax || 0) - (to.ax || 0)) > ADVANCE_EPSILON ||
        Math.abs((from.dx || 0) - (to.dx || 0)) > ADVANCE_EPSILON ||
        Math.abs((from.dy || 0) - (to.dy || 0)) > ADVANCE_EPSILON
    );
}

export function shapedRunNeedsAnimation(
    from: ShapedRunSnapshot,
    to: ShapedRunSnapshot
): boolean {
    if (from.glyphs.length === 0 && to.glyphs.length === 0) {
        return false;
    }
    if (from.glyphs.length !== to.glyphs.length) {
        return true;
    }
    if (!namesEqual(from.names, to.names)) {
        return true;
    }
    for (let i = 0; i < from.glyphs.length; i++) {
        const fromGlyph = from.glyphs[i];
        const toGlyph = to.glyphs[i];
        if (fromGlyph.g !== toGlyph.g || advancesDiffer(fromGlyph, toGlyph)) {
            return true;
        }
    }
    return false;
}

export function buildVisualClusters(
    snapshot: ShapedRunSnapshot
): VisualCluster[] {
    const clusters: VisualCluster[] = [];
    let x = 0;
    let i = 0;
    const { glyphs, names } = snapshot;

    while (i < glyphs.length) {
        const cl = glyphs[i].cl || 0;
        const startIndex = i;
        const clusterGlyphs: ShapedGlyph[] = [];
        const clusterNames: string[] = [];
        let width = 0;
        while (i < glyphs.length && (glyphs[i].cl || 0) === cl) {
            clusterGlyphs.push(glyphs[i]);
            clusterNames.push(names[i] || '');
            width += glyphs[i].ax || 0;
            i += 1;
        }
        clusters.push({
            cl,
            startIndex,
            glyphs: clusterGlyphs,
            names: clusterNames,
            x,
            width
        });
        x += width;
    }

    return clusters;
}

function clusterAtIndex(
    clusters: VisualCluster[],
    glyphIndex: number
): VisualCluster | null {
    if (glyphIndex < 0) {
        return null;
    }
    for (const cluster of clusters) {
        if (
            glyphIndex >= cluster.startIndex &&
            glyphIndex < cluster.startIndex + cluster.glyphs.length
        ) {
            return cluster;
        }
    }
    return null;
}

function findCoveringCluster(
    clusters: VisualCluster[],
    cl: number
): VisualCluster | undefined {
    let covering: VisualCluster | undefined;
    for (const cluster of clusters) {
        if (cluster.cl <= cl && (!covering || cluster.cl > covering.cl)) {
            covering = cluster;
        }
    }
    return covering;
}

export function selectedClusterIsSubstituted(
    from: ShapedRunSnapshot,
    to: ShapedRunSnapshot,
    fromSelectedIndex: number,
    toSelectedIndex: number
): boolean {
    const fromCluster = clusterAtIndex(
        buildVisualClusters(from),
        fromSelectedIndex
    );
    const toCluster = clusterAtIndex(buildVisualClusters(to), toSelectedIndex);
    if (!fromCluster && !toCluster) {
        return false;
    }
    if (!fromCluster || !toCluster) {
        return true;
    }
    return !namesEqual(fromCluster.names, toCluster.names);
}

function glyphAbsX(cluster: VisualCluster, localIndex: number): number {
    let x = cluster.x;
    for (let i = 0; i < localIndex; i++) {
        x += cluster.glyphs[i].ax || 0;
    }
    return x + (cluster.glyphs[localIndex]?.dx || 0);
}

export function getInterpolatedGlyphOriginX(
    from: ShapedRunSnapshot,
    to: ShapedRunSnapshot,
    toGlyphIndex: number,
    u: number
): number {
    const toClusters = buildVisualClusters(to);
    const fromClusters = buildVisualClusters(from);
    const toCluster = clusterAtIndex(toClusters, toGlyphIndex);
    if (!toCluster) {
        let x = 0;
        const limit = Math.min(Math.max(toGlyphIndex, 0), to.glyphs.length);
        for (let i = 0; i < limit; i++) {
            x += to.glyphs[i].ax || 0;
        }
        return x + (to.glyphs[toGlyphIndex]?.dx || 0);
    }

    const fromByCl = new Map(
        fromClusters.map((cluster) => [cluster.cl, cluster])
    );
    const fromCluster =
        fromByCl.get(toCluster.cl) ||
        findCoveringCluster(fromClusters, toCluster.cl);
    const clusterX = lerp(fromCluster?.x ?? toCluster.x, toCluster.x, u);
    const localIndex = toGlyphIndex - toCluster.startIndex;
    const toGlyph = toCluster.glyphs[localIndex];
    const toDx = toGlyph?.dx || 0;

    if (
        fromCluster &&
        namesEqual(fromCluster.names, toCluster.names) &&
        fromCluster.glyphs.length === toCluster.glyphs.length
    ) {
        const fromGlyph = fromCluster.glyphs[localIndex];
        let fromLocal = 0;
        let toLocal = 0;
        for (let i = 0; i < localIndex; i++) {
            fromLocal += fromCluster.glyphs[i].ax || 0;
            toLocal += toCluster.glyphs[i].ax || 0;
        }
        return (
            clusterX +
            lerp(fromLocal, toLocal, u) +
            lerp(fromGlyph?.dx || 0, toDx, u)
        );
    }

    let toLocal = 0;
    for (let i = 0; i < localIndex; i++) {
        toLocal += toCluster.glyphs[i].ax || 0;
    }
    const fromWidth = fromCluster?.width ?? toCluster.width;
    const interpolatedWidth = lerp(fromWidth, toCluster.width, u);
    const ratio = toCluster.width === 0 ? 0 : toLocal / toCluster.width;
    return clusterX + ratio * interpolatedWidth + toDx;
}

export interface AnimatedGlyphDrawOp {
    glyph: ShapedGlyph;
    name: string;
    x: number;
    y: number;
    alpha: number;
    toGlyphIndex: number | null;
    fromGlyphIndex: number | null;
    isSubstitute: boolean;
}

export function buildAnimatedGlyphDrawOps(
    from: ShapedRunSnapshot,
    to: ShapedRunSnapshot,
    u: number,
    alphaOld: number,
    alphaNew: number
): AnimatedGlyphDrawOp[] {
    const fromClusters = buildVisualClusters(from);
    const toClusters = buildVisualClusters(to);
    const fromByCl = new Map(
        fromClusters.map((cluster) => [cluster.cl, cluster])
    );
    const toByCl = new Map(toClusters.map((cluster) => [cluster.cl, cluster]));
    const clusterKeys = new Set<number>();
    for (const cluster of fromClusters) {
        clusterKeys.add(cluster.cl);
    }
    for (const cluster of toClusters) {
        clusterKeys.add(cluster.cl);
    }

    const ops: AnimatedGlyphDrawOp[] = [];

    for (const cl of clusterKeys) {
        const fromCluster = fromByCl.get(cl);
        const toCluster = toByCl.get(cl);
        const pairedFrom =
            fromCluster ||
            (toCluster
                ? findCoveringCluster(fromClusters, toCluster.cl)
                : undefined);
        const pairedTo =
            toCluster ||
            (fromCluster
                ? findCoveringCluster(toClusters, fromCluster.cl)
                : undefined);

        const isSubstitute = !(
            fromCluster &&
            toCluster &&
            namesEqual(fromCluster.names, toCluster.names)
        );

        if (
            fromCluster &&
            toCluster &&
            !isSubstitute &&
            fromCluster.glyphs.length === toCluster.glyphs.length
        ) {
            for (let i = 0; i < toCluster.glyphs.length; i++) {
                const fromGlyph = fromCluster.glyphs[i];
                const toGlyph = toCluster.glyphs[i];
                ops.push({
                    glyph: toGlyph,
                    name: toCluster.names[i],
                    x: lerp(
                        glyphAbsX(fromCluster, i),
                        glyphAbsX(toCluster, i),
                        u
                    ),
                    y: lerp(fromGlyph.dy || 0, toGlyph.dy || 0, u),
                    alpha: 1,
                    toGlyphIndex: toCluster.startIndex + i,
                    fromGlyphIndex: fromCluster.startIndex + i,
                    isSubstitute: false
                });
            }
            continue;
        }

        if (fromCluster && alphaOld > 0) {
            const targetCluster = pairedTo || fromCluster;
            for (let i = 0; i < fromCluster.glyphs.length; i++) {
                const fromGlyph = fromCluster.glyphs[i];
                const fromX = glyphAbsX(fromCluster, i);
                const fromWidth = fromCluster.width || 1;
                const inner = fromX - fromCluster.x;
                const targetX =
                    lerp(fromCluster.x, targetCluster.x, u) +
                    (inner / fromWidth) *
                        lerp(fromCluster.width, targetCluster.width, u) +
                    lerp(fromGlyph.dx || 0, 0, u);
                ops.push({
                    glyph: fromGlyph,
                    name: fromCluster.names[i],
                    x: targetX,
                    y: fromGlyph.dy || 0,
                    alpha: alphaOld,
                    toGlyphIndex: toCluster ? toCluster.startIndex : null,
                    fromGlyphIndex: fromCluster.startIndex + i,
                    isSubstitute: true
                });
            }
        }

        if (toCluster && alphaNew > 0) {
            const sourceCluster = pairedFrom || toCluster;
            for (let i = 0; i < toCluster.glyphs.length; i++) {
                const toGlyph = toCluster.glyphs[i];
                const toX = glyphAbsX(toCluster, i);
                const toWidth = toCluster.width || 1;
                const inner = toX - toCluster.x;
                const sourceX =
                    lerp(sourceCluster.x, toCluster.x, u) +
                    (inner / toWidth) *
                        lerp(sourceCluster.width, toCluster.width, u);
                ops.push({
                    glyph: toGlyph,
                    name: toCluster.names[i],
                    x: sourceX + (toGlyph.dx || 0) * u,
                    y: (toGlyph.dy || 0) * u,
                    alpha: alphaNew,
                    toGlyphIndex: toCluster.startIndex + i,
                    fromGlyphIndex: fromCluster ? fromCluster.startIndex : null,
                    isSubstitute: true
                });
            }
        }
    }

    return ops;
}

/**
 * HarfBuzz fill ops that belong to the glyph currently in the outline editor.
 * Those stay invisible; the outline editor fades instead.
 */
export function isActiveEditGlyphDrawOp(
    op: AnimatedGlyphDrawOp,
    fromSelectedIndex: number,
    toSelectedIndex: number
): boolean {
    if (op.fromGlyphIndex === fromSelectedIndex) {
        return true;
    }
    return op.fromGlyphIndex === null && op.toGlyphIndex === toSelectedIndex;
}

export interface FeatureChangeViewportAnchor {
    screenX: number;
    screenY: number;
    fromFontX: number;
    fromFontY: number;
    toFontX: number;
    toFontY: number;
    lockY: boolean;
}

export class FeatureChangeAnimator {
    private animation: {
        from: ShapedRunSnapshot;
        to: ShapedRunSnapshot;
        startTime: number;
        fadeActiveOutlines: boolean;
        fromSelectedIndex: number;
        toSelectedIndex: number;
        viewportAnchor: FeatureChangeViewportAnchor | null;
    } | null = null;
    private rafId: number | null = null;
    private readonly onFrame: () => void;

    constructor(onFrame: () => void) {
        this.onFrame = onFrame;
    }

    isActive(): boolean {
        return this.animation !== null;
    }

    getOutlineEditorFadeAlpha(): number {
        const state = this.getDrawState();
        if (!state?.fadeActiveOutlines) {
            return 1;
        }
        return state.alphaOld + state.alphaNew;
    }

    begin(
        from: ShapedRunSnapshot,
        to: ShapedRunSnapshot,
        options: {
            fromSelectedIndex: number;
            toSelectedIndex: number;
            editMode: boolean;
            viewportAnchor?: FeatureChangeViewportAnchor | null;
        }
    ): boolean {
        this.stopRaf();
        if (!shapedRunNeedsAnimation(from, to)) {
            this.animation = null;
            return false;
        }

        const fadeActiveOutlines =
            options.editMode &&
            selectedClusterIsSubstituted(
                from,
                to,
                options.fromSelectedIndex,
                options.toSelectedIndex
            );

        this.animation = {
            from,
            to,
            startTime: performance.now(),
            fadeActiveOutlines,
            fromSelectedIndex: options.fromSelectedIndex,
            toSelectedIndex: options.toSelectedIndex,
            viewportAnchor: options.viewportAnchor ?? null
        };
        console.log(
            '[FeatureChangeAnimator]',
            `begin fadeActiveOutlines=${fadeActiveOutlines}`
        );
        this.rafId = requestAnimationFrame(() => this.tick());
        return true;
    }

    cancel(): void {
        const wasActive = this.animation !== null;
        this.stopRaf();
        this.animation = null;
        if (wasActive) {
            console.log('[FeatureChangeAnimator]', 'cancel');
        }
    }

    getDrawState(): FeatureChangeDrawState | null {
        if (!this.animation) {
            return null;
        }
        const elapsed = performance.now() - this.animation.startTime;
        const { frame, u, done } = getFeatureChangeFrame(elapsed);
        if (done) {
            return null;
        }
        const alphas = getFeatureChangeAlphas(frame);
        return {
            from: this.animation.from,
            to: this.animation.to,
            u,
            frame,
            alphaOld: alphas.alphaOld,
            alphaNew: alphas.alphaNew,
            fadeActiveOutlines: this.animation.fadeActiveOutlines,
            fromSelectedIndex: this.animation.fromSelectedIndex,
            toSelectedIndex: this.animation.toSelectedIndex
        };
    }

    getSelectedGlyphOriginX(): number | null {
        const state = this.getDrawState();
        if (!state) {
            return null;
        }
        return getInterpolatedGlyphOriginX(
            state.from,
            state.to,
            state.toSelectedIndex,
            state.u
        );
    }

    getPlaybackU(): number | null {
        if (!this.animation) {
            return null;
        }
        const elapsed = performance.now() - this.animation.startTime;
        const { u, done } = getFeatureChangeFrame(elapsed);
        return done ? 1 : u;
    }

    getInterpolatedAnchorFontX(): number | null {
        const position = this.getInterpolatedAnchorFontPosition();
        return position?.x ?? null;
    }

    getInterpolatedAnchorFontPosition(): { x: number; y: number } | null {
        if (!this.animation?.viewportAnchor) {
            return null;
        }
        const u = this.getPlaybackU();
        if (u === null) {
            return null;
        }
        const anchor = this.animation.viewportAnchor;
        return {
            x: lerp(anchor.fromFontX, anchor.toFontX, u),
            y: lerp(anchor.fromFontY, anchor.toFontY, u)
        };
    }

    applyViewportAnchor(
        viewport: ViewportPanLockTarget | null | undefined,
        uOverride?: number
    ): void {
        if (!this.animation?.viewportAnchor || !viewport) {
            return;
        }
        const u = uOverride ?? this.getPlaybackU();
        if (u === null) {
            return;
        }
        const anchor = this.animation.viewportAnchor;
        applyFontPointScreenLock(
            viewport,
            { x: anchor.screenX, y: anchor.screenY },
            lerp(anchor.fromFontX, anchor.toFontX, u),
            lerp(anchor.fromFontY, anchor.toFontY, u),
            { lockY: anchor.lockY }
        );
    }

    private tick(): void {
        if (!this.animation) {
            this.rafId = null;
            return;
        }
        const elapsed = performance.now() - this.animation.startTime;
        const { done } = getFeatureChangeFrame(elapsed);
        this.onFrame();
        if (done) {
            this.animation = null;
            this.rafId = null;
            this.onFrame();
            return;
        }
        this.rafId = requestAnimationFrame(() => this.tick());
    }

    private stopRaf(): void {
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }
}
