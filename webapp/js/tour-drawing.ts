/**
 * Tour drawing-exercise geometry, gray target marks, and completion checks.
 */

import { Logger } from './logger';
import {
    viewportFrameCenterX,
    viewportFrameCenterY
} from './glyph-canvas/viewport';

const console = new Logger('Tour');

/** Match the inactive red close-target rings: 5px inner, 2× outer. */
const GUIDE_INNER_PX = 5;
const GUIDE_OUTER_PX = 10;
/** Drop the peak node within this many CSS pixels of the frozen mark. */
const PEAK_DROP_CLIENT_PX = 28;

export type TourDrawingGuides =
    'rectangle' | 'insert-mid' | 'triangle-peak' | 'diagonals' | 'smooth-nodes';

export type TourAdvanceWhen =
    | 'closed-path'
    | 'node-inserted'
    | 'peak-moved'
    | 'diagonals-converted'
    | 'nodes-smoothed';

type FontPoint = { x: number; y: number };

type FontRect = {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
};

type OnCurveNode = FontPoint & { smooth: boolean };

type PathVertex = FontPoint & { offCurve: boolean; smooth: boolean };

type TourPath = {
    vertices: PathVertex[];
    onCurves: OnCurveNode[];
    offCurveCount: number;
    closed: boolean;
};

type DrawingSession = {
    drawArea: FontRect | null;
    rectangle: {
        bl: FontPoint;
        br: FontPoint;
        tr: FontPoint;
        tl: FontPoint;
    } | null;
    frozenInsertMid: FontPoint | null;
    frozenPeak: FontPoint | null;
    closedOnCurveCount: number | null;
    expandedForPeak: boolean;
};

let session: DrawingSession = {
    drawArea: null,
    rectangle: null,
    frozenInsertMid: null,
    frozenPeak: null,
    closedOnCurveCount: null,
    expandedForPeak: false
};

let guidesRoot: SVGSVGElement | null = null;

export function resetTourDrawingSession(): void {
    session = {
        drawArea: null,
        rectangle: null,
        frozenInsertMid: null,
        frozenPeak: null,
        closedOnCurveCount: null,
        expandedForPeak: false
    };
}

export function captureTourDrawArea(): void {
    const outline = getSelectedGlyphOutlineFontRect();
    if (!outline) {
        session.drawArea = null;
        session.rectangle = null;
        return;
    }
    const rectangle = buildCompactRectangle(outline);
    session.rectangle = rectangle;
    session.drawArea = padAroundRectangle(rectangle, 0.28);
    session.expandedForPeak = false;
}

export function clearTourDrawingGuides(): void {
    guidesRoot?.remove();
    guidesRoot = null;
}

function getGlyphWorldOrigin(): FontPoint {
    const textRun = window.glyphCanvas?.textRunEditor;
    const index = textRun?.selectedGlyphIndex ?? -1;
    const glyphs = textRun?.shapedGlyphs || [];
    if (index < 0 || index >= glyphs.length) {
        return { x: 0, y: 0 };
    }
    let xPosition = 0;
    for (let i = 0; i < index; i++) {
        xPosition += glyphs[i].ax || 0;
    }
    const glyph = glyphs[index];
    return {
        x: xPosition + (glyph.dx || 0),
        y: glyph.dy || 0
    };
}

function getSelectedGlyphOutlineFontRect(): FontRect | null {
    const canvas = window.glyphCanvas;
    if (!canvas?.outlineEditor?.active) {
        return null;
    }
    const index = canvas.textRunEditor?.selectedGlyphIndex;
    if (typeof index !== 'number' || index < 0) {
        return null;
    }
    const bounds = canvas.glyphBounds?.[index];
    if (
        !bounds ||
        !Number.isFinite(bounds.x1) ||
        !Number.isFinite(bounds.x2) ||
        !Number.isFinite(bounds.y1) ||
        !Number.isFinite(bounds.y2)
    ) {
        return null;
    }
    return {
        minX: bounds.x + bounds.x1,
        maxX: bounds.x + bounds.x2,
        minY: bounds.y + bounds.y1,
        maxY: bounds.y + bounds.y2
    };
}

/** Frozen drawing hole in font space. Independent of later glyph bounds. */
export function getDrawAreaFontRect(): FontRect | null {
    if (session.drawArea) {
        return session.drawArea;
    }
    const outline = getSelectedGlyphOutlineFontRect();
    if (!outline) {
        return null;
    }
    return padAroundRectangle(buildCompactRectangle(outline), 0.28);
}

function buildCompactRectangle(outline: FontRect): {
    bl: FontPoint;
    br: FontPoint;
    tr: FontPoint;
    tl: FontPoint;
} {
    const glyphWidth = Math.max(8, outline.maxX - outline.minX);
    const glyphHeight = Math.max(8, outline.maxY - outline.minY);
    const width = Math.max(36, glyphWidth * 0.7);
    const height = width / 1.22;
    const cx = (outline.minX + outline.maxX) / 2;
    const gap = Math.max(20, glyphHeight * 0.1);
    const minX = cx - width / 2;
    const maxX = cx + width / 2;
    const minY = outline.maxY + gap;
    const maxY = minY + height;
    return {
        bl: { x: minX, y: minY },
        br: { x: maxX, y: minY },
        tr: { x: maxX, y: maxY },
        tl: { x: minX, y: maxY }
    };
}

function padAroundRectangle(
    rectangle: {
        bl: FontPoint;
        br: FontPoint;
        tr: FontPoint;
        tl: FontPoint;
    },
    padRatio: number
): FontRect {
    const width = rectangle.br.x - rectangle.bl.x;
    const height = rectangle.tl.y - rectangle.bl.y;
    const pad = Math.max(16, Math.max(width, height) * padRatio);
    return {
        minX: rectangle.bl.x - pad,
        maxX: rectangle.br.x + pad,
        minY: rectangle.bl.y - pad,
        maxY: rectangle.tl.y + pad
    };
}

function plannedPeakHeight(): number {
    const rectangle = getPlannedRectangle();
    return Math.max(28, (rectangle.tl.y - rectangle.bl.y) * 0.9);
}

export function expandTourDrawAreaForPeak(): void {
    const rectangle = getPlannedRectangle();
    const path = getTourDrawnPath();
    const corners =
        path && path.onCurves.length === 4 ? sortCorners(path.onCurves) : null;
    const tl = corners?.tl || rectangle.tl;
    const tr = corners?.tr || rectangle.tr;
    const peak = peakTarget(tl, tr, plannedPeakHeight());
    session.frozenInsertMid = midpoint(tl, tr);
    session.frozenPeak = peak;
    const pad = Math.max(24, (tr.x - tl.x) * 0.35);
    const current = getDrawAreaFontRect();
    if (!current) {
        return;
    }
    session.drawArea = {
        minX: Math.min(current.minX, peak.x - pad, tl.x - pad, tr.x - pad),
        maxX: Math.max(current.maxX, peak.x + pad, tl.x + pad, tr.x + pad),
        minY: current.minY,
        maxY: Math.max(current.maxY, peak.y + pad)
    };
    session.expandedForPeak = true;
}

export async function fitViewportToTourDrawArea(): Promise<void> {
    const area = getDrawAreaFontRect();
    const canvas = window.glyphCanvas;
    const viewport = canvas?.viewportManager;
    if (
        !area ||
        !canvas ||
        !viewport ||
        typeof canvas.getCanvasContentFrame !== 'function' ||
        typeof viewport.animateZoomAndPan !== 'function'
    ) {
        return;
    }
    const frame = canvas.getCanvasContentFrame();
    if (!frame || frame.width <= 0 || frame.height <= 0) {
        return;
    }
    const margin = Math.max(48, Math.min(frame.width, frame.height) * 0.2);
    const width = Math.max(8, area.maxX - area.minX);
    const height = Math.max(8, area.maxY - area.minY);
    const scale = Math.max(
        0.05,
        Math.min(
            80,
            Math.min(
                (frame.width - margin * 2) / width,
                (frame.height - margin * 2) / height
            )
        )
    );
    if (!Number.isFinite(scale)) {
        return;
    }
    const centerX = (area.minX + area.maxX) / 2;
    const centerY = (area.minY + area.maxY) / 2;
    const targetPanX = viewportFrameCenterX(frame) - centerX * scale;
    const targetPanY = viewportFrameCenterY(frame) + centerY * scale;
    await new Promise<void>((resolve) => {
        viewport.animateZoomAndPan(
            scale,
            targetPanX,
            targetPanY,
            () => {
                canvas.render?.();
            },
            resolve
        );
    });
}

function getPlannedRectangle(): {
    bl: FontPoint;
    br: FontPoint;
    tr: FontPoint;
    tl: FontPoint;
} {
    if (session.rectangle) {
        return session.rectangle;
    }
    const outline = getSelectedGlyphOutlineFontRect();
    if (outline) {
        return buildCompactRectangle(outline);
    }
    return {
        bl: { x: 0, y: 0 },
        br: { x: 40, y: 0 },
        tr: { x: 40, y: 32 },
        tl: { x: 0, y: 32 }
    };
}

function asPath(shape: unknown): {
    nodes: Array<{
        x?: number;
        y?: number;
        nodetype?: string;
        type?: string;
        smooth?: boolean;
    }>;
    closed: boolean;
} | null {
    if (!shape || typeof shape !== 'object') {
        return null;
    }
    const record = shape as Record<string, unknown>;
    if (typeof record.reference === 'string') {
        return null;
    }
    const nested =
        record.Path && typeof record.Path === 'object'
            ? (record.Path as Record<string, unknown>)
            : record;
    if (!Array.isArray(nested.nodes)) {
        return null;
    }
    return {
        nodes: nested.nodes as Array<{
            x?: number;
            y?: number;
            nodetype?: string;
            type?: string;
            smooth?: boolean;
        }>,
        closed: Boolean(nested.closed)
    };
}

function isOffCurve(node: { nodetype?: string; type?: string }): boolean {
    return node.nodetype === 'OffCurve' || node.type === 'o';
}

function getTourDrawnPath(): TourPath | null {
    const area = getDrawAreaFontRect();
    const shapes = window.glyphCanvas?.outlineEditor?.layerData?.shapes;
    if (!area || !Array.isArray(shapes)) {
        return null;
    }
    const origin = getGlyphWorldOrigin();
    let best: TourPath | null = null;
    let bestScore = -1;
    for (const shape of shapes) {
        const path = asPath(shape);
        if (!path) {
            continue;
        }
        const vertices: PathVertex[] = [];
        const onCurves: OnCurveNode[] = [];
        let offCurveCount = 0;
        for (const node of path.nodes) {
            const offCurve = isOffCurve(node);
            const point = {
                x: origin.x + (node.x || 0),
                y: origin.y + (node.y || 0),
                smooth: node.smooth === true,
                offCurve
            };
            vertices.push(point);
            if (offCurve) {
                offCurveCount += 1;
            } else {
                onCurves.push(point);
            }
        }
        if (onCurves.length < 3) {
            continue;
        }
        const cx =
            onCurves.reduce((sum, node) => sum + node.x, 0) / onCurves.length;
        const cy =
            onCurves.reduce((sum, node) => sum + node.y, 0) / onCurves.length;
        const inArea =
            cx >= area.minX &&
            cx <= area.maxX &&
            cy >= area.minY &&
            cy <= area.maxY;
        if (!inArea) {
            continue;
        }
        const score = (path.closed ? 100 : 0) + onCurves.length;
        if (score > bestScore) {
            bestScore = score;
            best = { vertices, onCurves, offCurveCount, closed: path.closed };
        }
    }
    return best;
}

function sortCorners(onCurves: OnCurveNode[]): {
    bl: OnCurveNode;
    br: OnCurveNode;
    tr: OnCurveNode;
    tl: OnCurveNode;
} | null {
    if (onCurves.length < 4) {
        return null;
    }
    const byY = [...onCurves].sort((a, b) => a.y - b.y);
    const bottom = byY.slice(0, 2).sort((a, b) => a.x - b.x);
    const top = byY.slice(-2).sort((a, b) => a.x - b.x);
    return {
        bl: bottom[0],
        br: bottom[1],
        tl: top[0],
        tr: top[1]
    };
}

function midpoint(a: FontPoint, b: FontPoint): FontPoint {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function samePoint(a: FontPoint, b: FontPoint): boolean {
    return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
}

function segmentHasOffCurves(
    path: TourPath,
    a: FontPoint,
    b: FontPoint
): boolean {
    const verts = path.vertices;
    const count = verts.length;
    if (count < 2) {
        return false;
    }
    const onIdx: number[] = [];
    for (let i = 0; i < count; i++) {
        if (!verts[i].offCurve) {
            onIdx.push(i);
        }
    }
    const pairCount = path.closed
        ? onIdx.length
        : Math.max(0, onIdx.length - 1);
    for (let pair = 0; pair < pairCount; pair++) {
        const startIndex = onIdx[pair];
        const endIndex = onIdx[(pair + 1) % onIdx.length];
        const start = verts[startIndex];
        const end = verts[endIndex];
        const matches =
            (samePoint(start, a) && samePoint(end, b)) ||
            (samePoint(start, b) && samePoint(end, a));
        if (!matches) {
            continue;
        }
        let cursor = (startIndex + 1) % count;
        while (cursor !== endIndex) {
            if (verts[cursor].offCurve) {
                return true;
            }
            cursor = (cursor + 1) % count;
            if (cursor === startIndex) {
                break;
            }
        }
        return false;
    }
    return false;
}

function trianglePeakAndTops(path: TourPath): {
    peak: OnCurveNode;
    tl: OnCurveNode;
    tr: OnCurveNode;
} | null {
    if (path.onCurves.length < 5) {
        return null;
    }
    const ranked = [...path.onCurves].sort((a, b) => b.y - a.y);
    const peak = ranked[0];
    const rest = path.onCurves.filter((node) => node !== peak);
    if (rest.length < 4) {
        return null;
    }
    const tops = [...rest]
        .sort((a, b) => a.y - b.y)
        .slice(-2)
        .sort((a, b) => a.x - b.x);
    return { peak, tl: tops[0], tr: tops[1] };
}

function diagonalGuidePoints(
    path: TourPath | null,
    fallbackPeak: FontPoint,
    fallbackTl: FontPoint,
    fallbackTr: FontPoint
): FontPoint[] {
    const anchors = path ? trianglePeakAndTops(path) : null;
    const peakNode = anchors?.peak || fallbackPeak;
    const leftCorner = anchors?.tl || fallbackTl;
    const rightCorner = anchors?.tr || fallbackTr;
    const left = midpoint(peakNode, leftCorner);
    const right = midpoint(peakNode, rightCorner);
    const firstIsLeft = leftCorner.y >= rightCorner.y;
    if (!path || !anchors) {
        return firstIsLeft ? [left] : [right];
    }
    const leftDone = segmentHasOffCurves(path, peakNode, leftCorner);
    const rightDone = segmentHasOffCurves(path, peakNode, rightCorner);
    if (!leftDone && !rightDone) {
        return firstIsLeft ? [left] : [right];
    }
    if (!leftDone) {
        return [left];
    }
    if (!rightDone) {
        return [right];
    }
    return [];
}

function peakTarget(tl: FontPoint, tr: FontPoint, height: number): FontPoint {
    return {
        x: (tl.x + tr.x) / 2,
        y: Math.max(tl.y, tr.y) + height
    };
}

function fontPointToClient(point: FontPoint): FontPoint | null {
    const canvas = window.glyphCanvas;
    const viewport = canvas?.viewportManager;
    const canvasEl = canvas?.canvas;
    if (!canvas || !viewport || !canvasEl) {
        return null;
    }
    const screen = viewport.fontToScreenCoordinates(point.x, point.y);
    const rect = canvasEl.getBoundingClientRect();
    return {
        x: rect.left + screen.x,
        y: rect.top + screen.y
    };
}

function getGuidePoints(kind: TourDrawingGuides): FontPoint[] {
    const area = getDrawAreaFontRect();
    if (!area) {
        return [];
    }
    const planned = getPlannedRectangle();
    const path = getTourDrawnPath();
    const corners = path ? sortCorners(path.onCurves) : null;
    const tl = corners?.tl || planned.tl;
    const tr = corners?.tr || planned.tr;
    const peak = session.frozenPeak || peakTarget(tl, tr, plannedPeakHeight());

    if (kind === 'rectangle') {
        return [planned.bl, planned.br, planned.tr, planned.tl];
    }
    if (kind === 'insert-mid') {
        return [session.frozenInsertMid || midpoint(planned.tl, planned.tr)];
    }
    if (kind === 'triangle-peak') {
        return [peak];
    }
    if (kind === 'diagonals') {
        return diagonalGuidePoints(path, peak, tl, tr);
    }
    const topThree = path
        ? [...path.onCurves].sort((a, b) => b.y - a.y).slice(0, 3)
        : [peak, tl, tr];
    return topThree;
}

function ensureGuidesRoot(parent: HTMLElement): SVGSVGElement {
    if (guidesRoot && guidesRoot.parentElement === parent) {
        return guidesRoot;
    }
    guidesRoot?.remove();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('tour-drawing-guides');
    svg.setAttribute('aria-hidden', 'true');
    parent.append(svg);
    guidesRoot = svg;
    return svg;
}

export function syncTourDrawingGuides(
    kind: TourDrawingGuides | undefined,
    parent: HTMLElement | null
): void {
    if (!kind || !parent) {
        clearTourDrawingGuides();
        return;
    }
    const svg = ensureGuidesRoot(parent);
    const width = window.innerWidth;
    const height = window.innerHeight;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.replaceChildren();
    const ns = 'http://www.w3.org/2000/svg';
    for (const point of getGuidePoints(kind)) {
        const client = fontPointToClient(point);
        if (!client) {
            continue;
        }
        const group = document.createElementNS(ns, 'g');
        const outer = document.createElementNS(ns, 'circle');
        outer.classList.add('tour-guide-ring');
        outer.setAttribute('cx', String(client.x));
        outer.setAttribute('cy', String(client.y));
        outer.setAttribute('r', String(GUIDE_OUTER_PX));
        const inner = document.createElementNS(ns, 'circle');
        inner.classList.add('tour-guide-ring');
        inner.setAttribute('cx', String(client.x));
        inner.setAttribute('cy', String(client.y));
        inner.setAttribute('r', String(GUIDE_INNER_PX));
        group.append(outer, inner);
        svg.append(group);
    }
}

export function isTourDrawingGoalMet(kind: TourAdvanceWhen): boolean {
    const path = getTourDrawnPath();
    if (!path) {
        return false;
    }
    if (kind === 'closed-path') {
        const closed = path.closed && path.onCurves.length >= 4;
        if (closed) {
            session.closedOnCurveCount = path.onCurves.length;
        }
        return closed;
    }
    if (kind === 'node-inserted') {
        if (!path.closed || session.closedOnCurveCount === null) {
            return false;
        }
        return path.onCurves.length > session.closedOnCurveCount;
    }
    if (kind === 'peak-moved') {
        const target = session.frozenPeak;
        if (!target || path.onCurves.length === 0) {
            return false;
        }
        const peakNode = [...path.onCurves].sort((a, b) => b.y - a.y)[0];
        const targetClient = fontPointToClient(target);
        const peakClient = fontPointToClient(peakNode);
        if (!targetClient || !peakClient) {
            return false;
        }
        return (
            Math.hypot(
                peakClient.x - targetClient.x,
                peakClient.y - targetClient.y
            ) <= PEAK_DROP_CLIENT_PX
        );
    }
    if (kind === 'diagonals-converted') {
        return path.closed && path.offCurveCount >= 4;
    }
    if (kind === 'nodes-smoothed') {
        const topThree = [...path.onCurves]
            .sort((a, b) => b.y - a.y)
            .slice(0, 3);
        return topThree.length === 3 && topThree.every((node) => node.smooth);
    }
    console.log('Unknown drawing goal', kind);
    return false;
}
