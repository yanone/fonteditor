// Fast Glyph Tile Renderer
// Renders glyph outlines directly to canvas elements without data URL conversion
// Uses a shared offscreen canvas for path building, then draws to target canvases

import {
    buildGlyphPathFromNodes,
    calculateGlyphShapeBounds,
    multiplyAffineTransforms,
    normalizeAffineTransform
} from './glyph-path-geometry';
import { Logger } from './logger';
import APP_SETTINGS from './settings';

const console = new Logger('GlyphTileRendererFast');

const GLYPHS_COMPONENT_ALIGNMENT_KEY = 'com.schriftgestalt.Glyphs.alignment';

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
    private autoComponentColor: string = '';
    private manualComponentColor: string = '';
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
        return normalizeAffineTransform(transformRaw);
    }

    /**
     * Update cached theme colors from settings
     */
    public updateThemeColors(): void {
        const isDarkTheme =
            document.documentElement.getAttribute('data-theme') !== 'light';
        const overviewColors = isDarkTheme
            ? APP_SETTINGS.OUTLINE_EDITOR.GLYPH_OVERVIEW_COLORS_DARK
            : APP_SETTINGS.OUTLINE_EDITOR.GLYPH_OVERVIEW_COLORS_LIGHT;
        const fills = APP_SETTINGS.OUTLINE_EDITOR.COMPONENT_FILLS;
        this.autoComponentColor = fills.AUTO_NORMAL;
        this.manualComponentColor = fills.MANUAL_NORMAL;
        this.pathColor = overviewColors.PATH;
        this.colorsInitialized = true;
    }

    /**
     * Ensure colors are initialized before rendering
     */
    private ensureColorsInitialized(): void {
        if (
            !this.colorsInitialized ||
            !this.autoComponentColor ||
            !this.manualComponentColor ||
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
        const bounds = calculateGlyphShapeBounds(shapes, parentTransform);
        if (!bounds) {
            return null;
        }

        return {
            xMin: bounds.minX,
            xMax: bounds.maxX,
            yMin: bounds.minY,
            yMax: bounds.maxY
        };
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
        this.drawShapes(ctx, shapes, this.pathColor, null);

        ctx.restore();

        return canvas;
    }

    /**
     * Recursively draw shapes (paths and components)
     */
    private drawShapes(
        ctx: CanvasRenderingContext2D,
        shapes: any[],
        pathColor: string,
        parentTransform: number[] | null
    ): void {
        if (!Array.isArray(shapes) || shapes.length === 0) {
            return;
        }

        ctx.beginPath();
        this.buildPathsOnly(ctx, shapes);
        ctx.fillStyle = pathColor;
        ctx.fill();

        this.fillComponents(
            ctx,
            shapes,
            parentTransform,
            true,
            this.autoComponentColor
        );
        this.fillComponents(
            ctx,
            shapes,
            parentTransform,
            false,
            this.manualComponentColor
        );
    }

    private isAutomaticallyAlignedComponent(component: any): boolean {
        if (!component || typeof component !== 'object') {
            return false;
        }
        if (component.automaticAlignment === true) {
            return true;
        }
        return (
            component.format_specific?.[GLYPHS_COMPONENT_ALIGNMENT_KEY] === 1
        );
    }

    private fillComponents(
        ctx: CanvasRenderingContext2D,
        shapes: any[],
        parentTransform: number[] | null,
        automatic: boolean,
        fillColor: string
    ): void {
        let drewAny = false;
        ctx.beginPath();
        for (const shape of shapes) {
            const normalized = this.normalizeShape(shape);
            if (normalized?.kind !== 'component') {
                continue;
            }

            const component = normalized.data;
            if (this.isAutomaticallyAlignedComponent(component) !== automatic) {
                continue;
            }

            const transform = this.parseTransform(component.transform);
            const finalTransform = parentTransform
                ? this.multiplyTransforms(parentTransform, transform)
                : transform;

            if (!component.layerData?.shapes) {
                continue;
            }

            ctx.save();
            ctx.transform(
                finalTransform[0],
                finalTransform[1],
                finalTransform[2],
                finalTransform[3],
                finalTransform[4],
                finalTransform[5]
            );
            this.buildComponentPaths(ctx, component.layerData.shapes);
            ctx.restore();
            drewAny = true;
        }

        if (!drewAny) {
            return;
        }

        ctx.fillStyle = fillColor;
        ctx.fill();
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
                const nodes = normalized.data.nodes;
                if (nodes && nodes.length > 0) {
                    buildGlyphPathFromNodes(nodes, ctx);
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
                const nodes = normalized.data.nodes;
                if (nodes && nodes.length > 0) {
                    buildGlyphPathFromNodes(nodes, ctx);
                    ctx.closePath();
                }
            }
        }
    }

    /**
     * Multiply two transformation matrices
     */
    private multiplyTransforms(t1: number[], t2: number[]): number[] {
        return multiplyAffineTransforms(t1, t2);
    }
}

// Export singleton instance
export const fastGlyphTileRenderer = new FastGlyphTileRenderer();
