/**
 * Tour drawing-exercise geometry, gray target marks, and completion checks.
 * Guides for redrawing l.ss04 come from ExtraBold's existing background path.
 */

import { Logger } from './logger';

const console = new Logger('Tour');

/** Match the inactive red close-target rings: 5px inner, 2× outer. */
const GUIDE_INNER_PX = 5;
const GUIDE_OUTER_PX = 10;
/** Drop a handle within this many CSS pixels of the frozen mark. */
const HANDLE_DROP_CLIENT_PX = 28;
const ON_CURVE_MATCH_UNITS = 24;

export type TourDrawingGuides =
    | 'contour-stem'
    | 'lss04-oncurves'
    | 'lss04-segments'
    | 'lss04-smooth'
    | 'lss04-handles';

export type TourAdvanceWhen =
    | 'contour-selected'
    | 'path-deleted'
    | 'closed-path'
    | 'segments-converted'
    | 'nodes-smoothed'
    | 'handles-placed';

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

type CurveSegment = {
    start: OnCurveNode;
    end: OnCurveNode;
    off1: FontPoint;
    off2: FontPoint;
};

type DrawingSession = {
    drawArea: FontRect | null;
    template: TourPath | null;
};

let session: DrawingSession = {
    drawArea: null,
    template: null
};

let guidesRoot: SVGSVGElement | null = null;

export function resetTourDrawingSession(): void {
    session = {
        drawArea: null,
        template: null
    };
}

export function captureTourDrawArea(): void {
    const template = readExtraBoldBackgroundPath();
    session.template = template;
    if (template) {
        session.drawArea = padRect(boundsOfPoints(template.vertices), 0.18);
        return;
    }
    const outline = getSelectedGlyphOutlineFontRect();
    const origin = getGlyphWorldOrigin();
    session.drawArea = outline
        ? padRect(
              offsetRect(outline, {
                  x: -origin.x,
                  y: -origin.y
              }),
              0.18
          )
        : null;
}

export function clearTourDrawingGuides(): void {
    guidesRoot?.remove();
    guidesRoot = null;
}

function getGlyphWorldOrigin(): FontPoint {
    const textRun = window.glyphCanvas?.textRunEditor;
    const index = textRun?.selectedGlyphIndex ?? -1;
    if (
        textRun &&
        typeof textRun._getGlyphPosition === 'function' &&
        index >= 0
    ) {
        const position = textRun._getGlyphPosition(index);
        return {
            x: (position.xPosition || 0) + (position.xOffset || 0),
            y: position.yOffset || 0
        };
    }
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

function offsetRect(rect: FontRect, origin: FontPoint): FontRect {
    return {
        minX: rect.minX + origin.x,
        maxX: rect.maxX + origin.x,
        minY: rect.minY + origin.y,
        maxY: rect.maxY + origin.y
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

/** Frozen drawing hole in glyph-local space, placed with the live origin. */
export function getDrawAreaFontRect(): FontRect | null {
    const origin = getGlyphWorldOrigin();
    if (session.drawArea) {
        return offsetRect(session.drawArea, origin);
    }
    const outline = getSelectedGlyphOutlineFontRect();
    if (!outline) {
        return null;
    }
    return padRect(outline, 0.18);
}

function padRect(rect: FontRect, padRatio: number): FontRect {
    const width = Math.max(8, rect.maxX - rect.minX);
    const height = Math.max(8, rect.maxY - rect.minY);
    const pad = Math.max(16, Math.max(width, height) * padRatio);
    return {
        minX: rect.minX - pad,
        maxX: rect.maxX + pad,
        minY: rect.minY - pad,
        maxY: rect.maxY + pad
    };
}

function boundsOfPoints(points: FontPoint[]): FontRect {
    return {
        minX: Math.min(...points.map((point) => point.x)),
        maxX: Math.max(...points.map((point) => point.x)),
        minY: Math.min(...points.map((point) => point.y)),
        maxY: Math.max(...points.map((point) => point.y))
    };
}

function getMasterDisplayName(master: {
    name?: string | { dflt?: string; en?: string };
}): string {
    const name = master.name;
    if (typeof name === 'string') {
        return name;
    }
    if (name?.dflt) {
        return name.dflt;
    }
    if (name?.en) {
        return name.en;
    }
    return '';
}

type PathNodeRecord = {
    x?: number;
    y?: number;
    nodetype?: string;
    type?: string;
    smooth?: boolean;
};

function asList<T>(value: unknown): T[] | null {
    if (Array.isArray(value)) {
        return value as T[];
    }
    if (
        value &&
        typeof value === 'object' &&
        typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function'
    ) {
        return Array.from(value as Iterable<T>);
    }
    return null;
}

function asPath(shape: unknown): {
    nodes: PathNodeRecord[];
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
    const nodes = asList<PathNodeRecord>(nested.nodes);
    if (nodes) {
        return {
            nodes,
            closed: Boolean(nested.closed)
        };
    }
    if (typeof record.toJSON === 'function') {
        try {
            const json = record.toJSON() as Record<string, unknown>;
            const jsonNodes = asList<PathNodeRecord>(json?.nodes);
            if (jsonNodes) {
                return {
                    nodes: jsonNodes,
                    closed: Boolean(json.closed)
                };
            }
        } catch {
            return null;
        }
    }
    return null;
}

function isOffCurve(node: { nodetype?: string; type?: string }): boolean {
    const nodetype = (node.nodetype || '').toLowerCase();
    const type = (node.type || '').toLowerCase();
    return nodetype === 'offcurve' || type === 'o' || type === 'offcurve';
}

function pathFromRaw(raw: {
    nodes: PathNodeRecord[];
    closed: boolean;
}): TourPath {
    const vertices: PathVertex[] = [];
    const onCurves: OnCurveNode[] = [];
    let offCurveCount = 0;
    for (const node of raw.nodes) {
        const offCurve = isOffCurve(node);
        const x = Number(node.x);
        const y = Number(node.y);
        const point = {
            x: Number.isFinite(x) ? x : 0,
            y: Number.isFinite(y) ? y : 0,
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
    return { vertices, onCurves, offCurveCount, closed: raw.closed };
}

type TourLayer = {
    id?: string;
    is_background?: boolean;
    master?: unknown;
    background_layer_id?: string;
    backgroundLayer?: TourLayer;
    paths?: unknown[];
    shapes?: unknown[];
};

function getLayerPathList(layer: TourLayer | null | undefined): unknown[] {
    if (!layer) {
        return [];
    }
    const paths = asList<unknown>(layer.paths);
    if (paths && paths.length > 0) {
        return paths;
    }
    return asList<unknown>(layer.shapes) || [];
}

function getLayerMasterId(master: unknown): string | null {
    if (!master || typeof master !== 'object') {
        return null;
    }
    const record = master as Record<string, unknown>;
    if (typeof record.master === 'string' && record.master) {
        return record.master;
    }
    if (
        typeof record.DefaultForMaster === 'string' &&
        record.DefaultForMaster
    ) {
        return record.DefaultForMaster;
    }
    if (
        typeof record.AssociatedWithMaster === 'string' &&
        record.AssociatedWithMaster
    ) {
        return record.AssociatedWithMaster;
    }
    return null;
}

function getFontMasters(): Array<{
    id?: string;
    name?: string | { dflt?: string; en?: string };
}> {
    const font =
        window.currentFontModel || window.fontManager?.currentFont?.fontModel;
    return font?.masters || [];
}

function isExtraBoldLayer(layer: {
    is_background?: boolean;
    master?: unknown;
    id?: string;
}): boolean {
    if (layer?.is_background) {
        return false;
    }
    if (
        getMasterDisplayName((layer.master || {}) as { name?: string }) ===
        'ExtraBold'
    ) {
        return true;
    }
    const masterId = getLayerMasterId(layer.master) || layer.id || null;
    if (!masterId) {
        return false;
    }
    const master = getFontMasters().find((entry) => entry.id === masterId);
    return getMasterDisplayName(master || {}) === 'ExtraBold';
}

function pathFromLayer(layer: TourLayer | null | undefined): TourPath | null {
    for (const shape of getLayerPathList(layer)) {
        const raw = asPath(shape);
        if (!raw || raw.nodes.length < 4) {
            continue;
        }
        return pathFromRaw(raw);
    }
    return null;
}

function readExtraBoldBackgroundPath(): TourPath | null {
    const font =
        window.currentFontModel || window.fontManager?.currentFont?.fontModel;
    const glyphName =
        window.glyphCanvas?.outlineEditor?.currentGlyphName || 'l.ss04';
    const glyph = font?.findGlyph?.(glyphName) || font?.findGlyph?.('l.ss04');
    const layerList = asList<TourLayer>(glyph?.layers) || [];
    if (layerList.length === 0) {
        return null;
    }
    const extraBold = layerList.find((layer) => isExtraBoldLayer(layer));
    const fromPaired = pathFromLayer(extraBold?.backgroundLayer);
    if (fromPaired) {
        return fromPaired;
    }
    const backgroundId = extraBold?.background_layer_id;
    const sibling =
        (backgroundId &&
            layerList.find(
                (layer) =>
                    layer?.is_background &&
                    (layer.id === backgroundId ||
                        layer.background_layer_id === extraBold?.id)
            )) ||
        layerList.find(
            (layer) =>
                layer?.is_background &&
                getLayerMasterId(layer.master) ===
                    getLayerMasterId(extraBold?.master)
        );
    return pathFromLayer(sibling);
}

function localToWorld(point: FontPoint): FontPoint {
    const origin = getGlyphWorldOrigin();
    return {
        x: origin.x + point.x,
        y: origin.y + point.y
    };
}

function readDrawnPath(minOnCurves: number): TourPath | null {
    const area = getDrawAreaFontRect();
    const shapes = window.glyphCanvas?.outlineEditor?.layerData?.shapes;
    if (!Array.isArray(shapes)) {
        return null;
    }
    let best: TourPath | null = null;
    let bestScore = -1;
    for (const shape of shapes) {
        const raw = asPath(shape);
        if (!raw) {
            continue;
        }
        const path = pathFromRaw(raw);
        if (path.onCurves.length < minOnCurves) {
            continue;
        }
        const cx =
            path.onCurves.reduce((sum, node) => sum + node.x, 0) /
            path.onCurves.length;
        const cy =
            path.onCurves.reduce((sum, node) => sum + node.y, 0) /
            path.onCurves.length;
        const world = localToWorld({ x: cx, y: cy });
        if (area) {
            const inArea =
                world.x >= area.minX &&
                world.x <= area.maxX &&
                world.y >= area.minY &&
                world.y <= area.maxY;
            if (!inArea) {
                continue;
            }
        }
        const score = (path.closed ? 100 : 0) + path.onCurves.length;
        if (score > bestScore) {
            bestScore = score;
            best = path;
        }
    }
    return best;
}

function getTourDrawnPath(): TourPath | null {
    return readDrawnPath(3);
}

function getForegroundPath(): TourPath | null {
    const drawn = getTourDrawnPath();
    if (drawn) {
        return drawn;
    }
    const shapes = window.glyphCanvas?.outlineEditor?.layerData?.shapes;
    if (!Array.isArray(shapes) || shapes.length === 0) {
        return null;
    }
    for (const shape of shapes) {
        const raw = asPath(shape);
        if (!raw || raw.nodes.length < 2) {
            continue;
        }
        return pathFromRaw(raw);
    }
    return null;
}

function midpoint(a: FontPoint, b: FontPoint): FontPoint {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function samePoint(a: FontPoint, b: FontPoint, slop = 0.5): boolean {
    return Math.abs(a.x - b.x) < slop && Math.abs(a.y - b.y) < slop;
}

function nearestOnCurve(path: TourPath, target: FontPoint): OnCurveNode | null {
    if (path.onCurves.length === 0) {
        return null;
    }
    return [...path.onCurves].sort(
        (a, b) =>
            Math.hypot(a.x - target.x, a.y - target.y) -
            Math.hypot(b.x - target.x, b.y - target.y)
    )[0];
}

function getCurveSegments(path: TourPath): CurveSegment[] {
    const verts = path.vertices;
    const count = verts.length;
    const onIdx: number[] = [];
    for (let i = 0; i < count; i++) {
        if (!verts[i].offCurve) {
            onIdx.push(i);
        }
    }
    const pairCount = path.closed
        ? onIdx.length
        : Math.max(0, onIdx.length - 1);
    const segments: CurveSegment[] = [];
    for (let pair = 0; pair < pairCount; pair++) {
        const startIndex = onIdx[pair];
        const endIndex = onIdx[(pair + 1) % onIdx.length];
        const offs: FontPoint[] = [];
        let cursor = (startIndex + 1) % count;
        while (cursor !== endIndex) {
            if (verts[cursor].offCurve) {
                offs.push(verts[cursor]);
            }
            cursor = (cursor + 1) % count;
            if (cursor === startIndex) {
                break;
            }
        }
        if (offs.length < 2) {
            continue;
        }
        segments.push({
            start: verts[startIndex],
            end: verts[endIndex],
            off1: offs[0],
            off2: offs[offs.length - 1]
        });
    }
    return segments;
}

function segmentHasOffCurves(
    path: TourPath,
    a: FontPoint,
    b: FontPoint
): boolean {
    const drawn = getCurveSegments(path);
    return drawn.some(
        (segment) =>
            (samePoint(segment.start, a, ON_CURVE_MATCH_UNITS) &&
                samePoint(segment.end, b, ON_CURVE_MATCH_UNITS)) ||
            (samePoint(segment.start, b, ON_CURVE_MATCH_UNITS) &&
                samePoint(segment.end, a, ON_CURVE_MATCH_UNITS))
    );
}

function templateCurveSegments(): CurveSegment[] {
    return session.template ? getCurveSegments(session.template) : [];
}

function unsmoothedHandleTargets(): FontPoint[] {
    const segments = templateCurveSegments();
    const targets: FontPoint[] = [];
    for (const segment of segments) {
        if (!segment.start.smooth) {
            targets.push(segment.off1);
        }
        if (!segment.end.smooth) {
            targets.push(segment.off2);
        }
    }
    return targets;
}

function getStemMidpoint(): FontPoint | null {
    const path = getForegroundPath() || session.template;
    if (!path || path.onCurves.length < 2) {
        return null;
    }
    const verts = path.vertices;
    const onIdx: number[] = [];
    for (let i = 0; i < verts.length; i++) {
        if (!verts[i].offCurve) {
            onIdx.push(i);
        }
    }
    const pairCount = path.closed
        ? onIdx.length
        : Math.max(0, onIdx.length - 1);
    let best: { a: FontPoint; b: FontPoint; length: number } | null = null;
    for (let pair = 0; pair < pairCount; pair++) {
        const a = verts[onIdx[pair]];
        const b = verts[onIdx[(pair + 1) % onIdx.length]];
        const dx = Math.abs(a.x - b.x);
        const dy = Math.abs(a.y - b.y);
        if (dy < 80 || dx > dy * 0.35) {
            continue;
        }
        if (!best || dy > best.length) {
            best = { a, b, length: dy };
        }
    }
    return best ? midpoint(best.a, best.b) : null;
}

function fontPointToClient(point: FontPoint): FontPoint | null {
    const canvas = window.glyphCanvas;
    const viewport = canvas?.viewportManager;
    const canvasEl = canvas?.canvas;
    if (!canvas || !viewport || !canvasEl) {
        return null;
    }
    const world = localToWorld(point);
    const screen = viewport.fontToScreenCoordinates(world.x, world.y);
    const rect = canvasEl.getBoundingClientRect();
    return {
        x: rect.left + screen.x,
        y: rect.top + screen.y
    };
}

function clientToSvg(svg: SVGSVGElement, client: FontPoint): FontPoint {
    const rect = svg.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;
    if (
        rect.width > 0 &&
        rect.height > 0 &&
        viewBox.width > 0 &&
        viewBox.height > 0
    ) {
        return {
            x: ((client.x - rect.left) / rect.width) * viewBox.width,
            y: ((client.y - rect.top) / rect.height) * viewBox.height
        };
    }
    return {
        x: client.x - (rect.left || 0),
        y: client.y - (rect.top || 0)
    };
}

function getGuidePoints(kind: TourDrawingGuides): FontPoint[] {
    const template = session.template || readExtraBoldBackgroundPath();
    const path = getTourDrawnPath();

    if (kind === 'contour-stem') {
        const stem = getStemMidpoint();
        return stem ? [stem] : [];
    }
    if (!template) {
        return [];
    }
    if (kind === 'lss04-oncurves') {
        const drawn = readDrawnPath(1);
        if (drawn?.closed) {
            return [];
        }
        const placed = drawn?.onCurves.length ?? 0;
        if (placed >= template.onCurves.length) {
            return [template.onCurves[0]];
        }
        return [template.onCurves[placed]];
    }
    if (kind === 'lss04-segments') {
        return templateCurveSegments()
            .filter(
                (segment) =>
                    !path ||
                    !segmentHasOffCurves(path, segment.start, segment.end)
            )
            .map((segment) => midpoint(segment.start, segment.end));
    }
    if (kind === 'lss04-smooth') {
        return template.onCurves.filter((node) => {
            if (!node.smooth) {
                return false;
            }
            if (!path) {
                return true;
            }
            const nearest = nearestOnCurve(path, node);
            return !nearest?.smooth;
        });
    }
    const targets = unsmoothedHandleTargets();
    if (!path) {
        return targets;
    }
    return targets.filter((target) => {
        const targetClient = fontPointToClient(target);
        if (!targetClient) {
            return true;
        }
        return !path.vertices.some((vertex) => {
            if (!vertex.offCurve) {
                return false;
            }
            const client = fontPointToClient(vertex);
            if (!client) {
                return false;
            }
            return (
                Math.hypot(
                    client.x - targetClient.x,
                    client.y - targetClient.y
                ) <= HANDLE_DROP_CLIENT_PX
            );
        });
    });
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
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.replaceChildren();
    const ns = 'http://www.w3.org/2000/svg';
    for (const point of getGuidePoints(kind)) {
        const client = fontPointToClient(point);
        if (!client) {
            continue;
        }
        const svgPoint = clientToSvg(svg, client);
        const group = document.createElementNS(ns, 'g');
        const outer = document.createElementNS(ns, 'circle');
        outer.classList.add('tour-guide-ring');
        outer.setAttribute('cx', String(svgPoint.x));
        outer.setAttribute('cy', String(svgPoint.y));
        outer.setAttribute('r', String(GUIDE_OUTER_PX));
        const inner = document.createElementNS(ns, 'circle');
        inner.classList.add('tour-guide-ring');
        inner.setAttribute('cx', String(svgPoint.x));
        inner.setAttribute('cy', String(svgPoint.y));
        inner.setAttribute('r', String(GUIDE_INNER_PX));
        group.append(outer, inner);
        svg.append(group);
    }
}

function isContourSelected(): boolean {
    const editor = window.glyphCanvas?.outlineEditor;
    const selected = editor?.selectedPoints;
    if (!Array.isArray(selected) || selected.length === 0) {
        return false;
    }
    const contourIndex = selected[0]?.contourIndex;
    if (typeof contourIndex !== 'number') {
        return false;
    }
    const shape = editor?.layerData?.shapes?.[contourIndex];
    const raw = asPath(shape);
    if (!raw?.nodes.length) {
        return false;
    }
    return (
        selected.length === raw.nodes.length &&
        selected.every((point) => point.contourIndex === contourIndex)
    );
}

function isForegroundPathDeleted(): boolean {
    const shapes = window.glyphCanvas?.outlineEditor?.layerData?.shapes;
    if (!Array.isArray(shapes) || shapes.length === 0) {
        return true;
    }
    return !shapes.some((shape) => {
        const raw = asPath(shape);
        return !!raw && raw.nodes.length > 0;
    });
}

function handlesArePlaced(path: TourPath): boolean {
    const targets = unsmoothedHandleTargets();
    if (targets.length === 0) {
        return false;
    }
    return targets.every((target) => {
        const targetClient = fontPointToClient(target);
        if (!targetClient) {
            return false;
        }
        return path.vertices.some((vertex) => {
            if (!vertex.offCurve) {
                return false;
            }
            const client = fontPointToClient(vertex);
            if (!client) {
                return false;
            }
            return (
                Math.hypot(
                    client.x - targetClient.x,
                    client.y - targetClient.y
                ) <= HANDLE_DROP_CLIENT_PX
            );
        });
    });
}

export function isTourDrawingGoalMet(kind: TourAdvanceWhen): boolean {
    if (kind === 'contour-selected') {
        return isContourSelected();
    }
    if (kind === 'path-deleted') {
        return isForegroundPathDeleted();
    }
    const path = getTourDrawnPath();
    if (!path) {
        return false;
    }
    if (kind === 'closed-path') {
        const needed = session.template?.onCurves.length ?? 4;
        return path.closed && path.onCurves.length >= needed;
    }
    if (kind === 'segments-converted') {
        const segments = templateCurveSegments();
        if (segments.length === 0) {
            return path.closed && path.offCurveCount >= 4;
        }
        return segments.every((segment) =>
            segmentHasOffCurves(path, segment.start, segment.end)
        );
    }
    if (kind === 'nodes-smoothed') {
        const smoothTargets = (session.template?.onCurves || []).filter(
            (node) => node.smooth
        );
        if (smoothTargets.length === 0) {
            return false;
        }
        return smoothTargets.every((target) => {
            const nearest = nearestOnCurve(path, target);
            return (
                !!nearest?.smooth &&
                Math.hypot(nearest.x - target.x, nearest.y - target.y) <=
                    ON_CURVE_MATCH_UNITS
            );
        });
    }
    if (kind === 'handles-placed') {
        return handlesArePlaced(path);
    }
    console.log('Unknown drawing goal', kind);
    return false;
}
