// Fast Glyph Tile Renderer
// Renders glyph outlines directly to canvas elements without data URL conversion
// Uses a shared offscreen canvas for path building, then draws to target canvases

import { LayerDataNormalizer } from './layer-data-normalizer';
import { DecomposedAffineTransform } from './babelfont-model';
import { Logger } from './logger';
import APP_SETTINGS from './settings';

const console = new Logger('GlyphTileRendererFast');

interface RenderMetrics {
    ascender: number;
    descender: number;
    upm: number;
}

interface GlyphOutlineData {
    name: string;
    width: number;
    shapes?: any[];
    bounds?: {
        xMin: number;
        yMin: number;
        xMax: number;
        yMax: number;
    };
}

class FastGlyphTileRenderer {
    private componentColor: string = '';
    private pathColor: string = '';
    private colorsInitialized: boolean = false;

    constructor() {
        // Colors will be initialized lazily on first render
    }

    private normalizeShape(
        shape: any
    ): { kind: 'path'; data: any } | { kind: 'component'; data: any } | null {
        if (!shape || typeof shape !== 'object') {
            return null;
        }

        if ('nodes' in shape) {
            return { kind: 'path', data: shape };
        }

        if ('reference' in shape) {
            return { kind: 'component', data: shape };
        }

        if ('Path' in shape && shape.Path && typeof shape.Path === 'object') {
            return { kind: 'path', data: shape.Path };
        }

        if (
            'Contour' in shape &&
            shape.Contour &&
            typeof shape.Contour === 'object'
        ) {
            return { kind: 'path', data: shape.Contour };
        }

        if (
            'Component' in shape &&
            shape.Component &&
            typeof shape.Component === 'object'
        ) {
            return { kind: 'component', data: shape.Component };
        }

        return null;
    }

    private parseTransform(transformRaw: any): number[] {
        if (!transformRaw) {
            return [1, 0, 0, 1, 0, 0];
        }

        if (Array.isArray(transformRaw) && transformRaw.length >= 6) {
            return [
                Number(transformRaw[0]) || 1,
                Number(transformRaw[1]) || 0,
                Number(transformRaw[2]) || 0,
                Number(transformRaw[3]) || 1,
                Number(transformRaw[4]) || 0,
                Number(transformRaw[5]) || 0
            ];
        }

        if (
            typeof transformRaw === 'object' &&
            ('translation' in transformRaw ||
                'scale' in transformRaw ||
                'rotation' in transformRaw ||
                'skew' in transformRaw)
        ) {
            return DecomposedAffineTransform.toAffine(transformRaw);
        }

        if (
            typeof transformRaw === 'object' &&
            ['a', 'b', 'c', 'd', 'e', 'f'].every((key) => key in transformRaw)
        ) {
            return [
                Number(transformRaw.a) || 1,
                Number(transformRaw.b) || 0,
                Number(transformRaw.c) || 0,
                Number(transformRaw.d) || 1,
                Number(transformRaw.e) || 0,
                Number(transformRaw.f) || 0
            ];
        }

        if (
            typeof transformRaw === 'object' &&
            ['xx', 'yx', 'xy', 'yy', 'x0', 'y0'].every(
                (key) => key in transformRaw
            )
        ) {
            return [
                Number(transformRaw.xx) || 1,
                Number(transformRaw.yx) || 0,
                Number(transformRaw.xy) || 0,
                Number(transformRaw.yy) || 1,
                Number(transformRaw.x0) || 0,
                Number(transformRaw.y0) || 0
            ];
        }

        if (
            typeof transformRaw === 'object' &&
            Array.isArray(transformRaw.coeffs) &&
            transformRaw.coeffs.length >= 6
        ) {
            return [
                Number(transformRaw.coeffs[0]) || 1,
                Number(transformRaw.coeffs[1]) || 0,
                Number(transformRaw.coeffs[2]) || 0,
                Number(transformRaw.coeffs[3]) || 1,
                Number(transformRaw.coeffs[4]) || 0,
                Number(transformRaw.coeffs[5]) || 0
            ];
        }

        return [1, 0, 0, 1, 0, 0];
    }

    /**
     * Update cached theme colors from settings
     */
    public updateThemeColors(): void {
        const isDarkTheme =
            document.documentElement.getAttribute('data-theme') !== 'light';
        const colors = isDarkTheme
            ? APP_SETTINGS.OUTLINE_EDITOR.GLYPH_OVERVIEW_COLORS_DARK
            : APP_SETTINGS.OUTLINE_EDITOR.GLYPH_OVERVIEW_COLORS_LIGHT;
        this.componentColor = colors.COMPONENT;
        this.pathColor = colors.PATH;
        this.colorsInitialized = true;
    }

    /**
     * Ensure colors are initialized before rendering
     */
    private ensureColorsInitialized(): void {
        if (
            !this.colorsInitialized ||
            !this.componentColor ||
            !this.pathColor
        ) {
            this.updateThemeColors();
        }
    }

    private toFiniteNumber(value: unknown, fallback: number): number {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return fallback;
        }
        return value;
    }

    private getSafeBounds(glyphData: GlyphOutlineData): {
        xMin: number;
        xMax: number;
    } {
        const computedBounds = this.getVisualBoundsFromShapes(
            Array.isArray(glyphData?.shapes) ? glyphData.shapes : []
        );
        if (computedBounds) {
            return {
                xMin: computedBounds.xMin,
                xMax: computedBounds.xMax
            };
        }

        const bounds = glyphData?.bounds;
        if (!bounds || typeof bounds !== 'object') {
            return { xMin: 0, xMax: 0 };
        }

        const xMin = this.toFiniteNumber((bounds as any).xMin, 0);
        const xMax = this.toFiniteNumber((bounds as any).xMax, xMin);
        if (xMax < xMin) {
            return { xMin: xMax, xMax: xMin };
        }

        return { xMin, xMax };
    }

    private getVisualBoundsFromShapes(
        shapes: any[],
        parentTransform: number[] = [1, 0, 0, 1, 0, 0]
    ): {
        xMin: number;
        xMax: number;
        yMin: number;
        yMax: number;
    } | null {
        if (!Array.isArray(shapes) || shapes.length === 0) {
            return null;
        }

        let xMin = Infinity;
        let xMax = -Infinity;
        let yMin = Infinity;
        let yMax = -Infinity;

        const includePoint = (x: number, y: number) => {
            xMin = Math.min(xMin, x);
            xMax = Math.max(xMax, x);
            yMin = Math.min(yMin, y);
            yMax = Math.max(yMax, y);
        };

        for (const shape of shapes) {
            const normalized = this.normalizeShape(shape);
            if (!normalized) {
                continue;
            }

            if (normalized.kind === 'path') {
                let nodes = normalized.data.nodes;
                if (typeof nodes === 'string') {
                    nodes = LayerDataNormalizer.parseNodes(nodes);
                }
                if (!Array.isArray(nodes)) {
                    continue;
                }
                for (const node of nodes) {
                    if (
                        !node ||
                        typeof node.x !== 'number' ||
                        typeof node.y !== 'number'
                    ) {
                        continue;
                    }
                    const [a, b, c, d, tx, ty] = parentTransform;
                    includePoint(
                        a * node.x + c * node.y + tx,
                        b * node.x + d * node.y + ty
                    );
                }
                continue;
            }

            const component = normalized.data;
            const transform = this.parseTransform(component.transform);
            const finalTransform = this.multiplyTransforms(
                parentTransform,
                transform
            );
            const componentBounds = this.getVisualBoundsFromShapes(
                component.layerData?.shapes || [],
                finalTransform
            );
            if (componentBounds) {
                includePoint(componentBounds.xMin, componentBounds.yMin);
                includePoint(componentBounds.xMax, componentBounds.yMax);
            }
        }

        if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) {
            return null;
        }

        return { xMin, xMax, yMin, yMax };
    }

    /**
     * Render a glyph directly to a canvas element
     * Reuses existing canvas if provided, creates new one otherwise
     */
    public renderToCanvas(
        glyphData: GlyphOutlineData,
        metrics: RenderMetrics | undefined,
        width: number,
        height: number,
        existingCanvas?: HTMLCanvasElement
    ): HTMLCanvasElement {
        this.ensureColorsInitialized();

        const dpr = window.devicePixelRatio || 1;
        const canvasWidth = Math.round(width * dpr);
        const canvasHeight = Math.round(height * dpr);

        // Reuse existing canvas or create new one
        const canvas = existingCanvas || document.createElement('canvas');

        // Only resize if dimensions changed
        if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
            canvas.width = canvasWidth;
            canvas.height = canvasHeight;
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
        }

        const ctx = canvas.getContext('2d', { alpha: true });
        if (!ctx) {
            return canvas;
        }

        // Clear and reset transform
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);

        // Scale for hi-dpi
        ctx.scale(dpr, dpr);

        // Calculate drawing area (reserve space at bottom for label)
        const labelHeight = Math.max(8, height * 0.16);
        const drawHeight = height - labelHeight;
        const drawWidth = width;
        const padding = 2;

        // Use provided metrics or calculate defaults
        const upm = metrics?.upm || 1000;
        const ascender = metrics?.ascender ?? upm * 0.75;
        const descender = metrics?.descender ?? -(upm * 0.25);
        const metricsHeight = ascender - descender;

        if (metricsHeight === 0) {
            return canvas;
        }

        // Scale to fit metrics height in drawing area (0.7 factor to draw 30% smaller)
        const scale = ((drawHeight - padding * 2) / metricsHeight) * 0.7;
        if (!Number.isFinite(scale) || scale <= 0) {
            return canvas;
        }

        // Center horizontally based on glyph visual bounds
        const bounds = this.getSafeBounds(glyphData);
        const glyphVisualCenterX = (bounds.xMin + bounds.xMax) / 2;
        const tileCenterX = drawWidth / 2;
        const offsetX = tileCenterX - glyphVisualCenterX * scale;

        // Y offset: position so ascender is at top of drawing area, shifted down 20% of tile height
        const offsetY = padding + ascender * scale + height * 0.2;

        ctx.save();
        ctx.translate(offsetX, offsetY);
        ctx.scale(scale, -scale); // Flip Y axis

        // Draw shapes
        const shapes = Array.isArray(glyphData?.shapes) ? glyphData.shapes : [];
        this.drawShapes(
            ctx,
            shapes,
            this.componentColor,
            this.pathColor,
            null,
            false
        );

        ctx.restore();

        return canvas;
    }

    /**
     * Recursively draw shapes (paths and components)
     */
    private drawShapes(
        ctx: CanvasRenderingContext2D,
        shapes: any[],
        componentColor: string,
        pathColor: string,
        parentTransform: number[] | null,
        insideComponent: boolean
    ): void {
        if (!Array.isArray(shapes) || shapes.length === 0) {
            return;
        }

        // First pass: draw all regular paths
        ctx.beginPath();
        this.buildPathsOnly(ctx, shapes);
        ctx.fillStyle = insideComponent ? componentColor : pathColor;
        ctx.fill();

        // Second pass: combine ALL component paths, then fill once
        const hasComponents = shapes.some(
            (shape) => this.normalizeShape(shape)?.kind === 'component'
        );
        if (hasComponents) {
            ctx.beginPath();
            for (const shape of shapes) {
                const normalized = this.normalizeShape(shape);
                if (normalized?.kind === 'component') {
                    const component = normalized.data;
                    const transform = this.parseTransform(component.transform);

                    const finalTransform = parentTransform
                        ? this.multiplyTransforms(parentTransform, transform)
                        : transform;

                    if (component.layerData && component.layerData.shapes) {
                        ctx.save();
                        ctx.transform(
                            finalTransform[0],
                            finalTransform[1],
                            finalTransform[2],
                            finalTransform[3],
                            finalTransform[4],
                            finalTransform[5]
                        );
                        this.buildComponentPaths(
                            ctx,
                            component.layerData.shapes
                        );
                        ctx.restore();
                    }
                }
            }
            ctx.fillStyle = componentColor;
            ctx.fill();
        }
    }

    /**
     * Build all paths from component shapes recursively
     */
    private buildComponentPaths(
        ctx: CanvasRenderingContext2D,
        shapes: any[]
    ): void {
        for (const shape of shapes) {
            const normalized = this.normalizeShape(shape);
            if (normalized?.kind === 'path') {
                let nodes = normalized.data.nodes;
                if (typeof nodes === 'string') {
                    nodes = LayerDataNormalizer.parseNodes(nodes);
                }
                if (nodes && nodes.length > 0) {
                    LayerDataNormalizer.buildPathFromNodes(nodes, ctx);
                    ctx.closePath();
                }
            } else if (normalized?.kind === 'component') {
                const component = normalized.data;
                const transform = this.parseTransform(component.transform);
                if (component.layerData && component.layerData.shapes) {
                    ctx.save();
                    ctx.transform(
                        transform[0],
                        transform[1],
                        transform[2],
                        transform[3],
                        transform[4],
                        transform[5]
                    );
                    this.buildComponentPaths(ctx, component.layerData.shapes);
                    ctx.restore();
                }
            }
        }
    }

    /**
     * Build combined path from regular paths only
     */
    private buildPathsOnly(ctx: CanvasRenderingContext2D, shapes: any[]): void {
        for (const shape of shapes) {
            const normalized = this.normalizeShape(shape);
            if (normalized?.kind === 'path') {
                let nodes = normalized.data.nodes;
                if (typeof nodes === 'string') {
                    nodes = LayerDataNormalizer.parseNodes(nodes);
                }
                if (nodes && nodes.length > 0) {
                    LayerDataNormalizer.buildPathFromNodes(nodes, ctx);
                    ctx.closePath();
                }
            }
        }
    }

    /**
     * Multiply two transformation matrices
     */
    private multiplyTransforms(t1: number[], t2: number[]): number[] {
        const [a1, b1, c1, d1, tx1, ty1] = t1;
        const [a2, b2, c2, d2, tx2, ty2] = t2;
        return [
            a1 * a2 + c1 * b2,
            b1 * a2 + d1 * b2,
            a1 * c2 + c1 * d2,
            b1 * c2 + d1 * d2,
            a1 * tx2 + c1 * ty2 + tx1,
            b1 * tx2 + d1 * ty2 + ty1
        ];
    }
}

// Export singleton instance
export const fastGlyphTileRenderer = new FastGlyphTileRenderer();
