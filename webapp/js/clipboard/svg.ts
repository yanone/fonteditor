/**
 * SVG path clipboard converter (Illustrator / Glyphs fallback / other apps).
 */

import type { PasteFragment, PasteNode, PastePath } from './types';

export const SVG_MIME_TYPES = [
    'image/svg+xml',
    'public.svg-image',
    'com.adobe.svg',
    'com.adobe.illustrator.svg',
    'com.adobe.illustrator.svgm'
] as const;

export function canParseSvg(payload: string): boolean {
    const trimmed = payload.trim();
    return (
        trimmed.includes('<svg') ||
        trimmed.includes('<path') ||
        (trimmed.startsWith('<?xml') && trimmed.includes('svg'))
    );
}

export function parseSvg(payload: string): PasteFragment | null {
    const pathDataList = extractPathData(payload);
    const paths: PastePath[] = [];
    for (const pathData of pathDataList) {
        paths.push(...pathDataToPastePaths(pathData));
    }
    if (paths.length === 0) {
        return null;
    }
    return {
        format: 'svg',
        paths,
        components: [],
        anchors: [],
        guides: [],
        keepAbsoluteCoords: false
    };
}

function extractPathData(payload: string): string[] {
    const results: string[] = [];
    const re = /<path\b[^>]*\bd=["']([^"']+)["'][^>]*>/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(payload)) !== null) {
        results.push(match[1]);
    }
    return results;
}

function pathDataToPastePaths(pathData: string): PastePath[] {
    const commands = tokenizeSvgPath(pathData);
    const paths: PastePath[] = [];
    let current: PasteNode[] = [];
    let startX = 0;
    let startY = 0;
    let cx = 0;
    let cy = 0;
    let lastCubicCp: { x: number; y: number } | null = null;
    let closed = false;

    const flush = () => {
        if (current.length === 0) {
            return;
        }
        paths.push({ closed, nodes: current });
        current = [];
        closed = false;
        lastCubicCp = null;
    };

    for (const command of commands) {
        const { type, args } = command;
        const relative = type === type.toLowerCase();
        const op = type.toUpperCase();

        if (op === 'M') {
            if (current.length > 0) {
                flush();
            }
            for (let i = 0; i + 1 < args.length; i += 2) {
                const x = relative ? cx + args[i] : args[i];
                const y = relative ? cy + args[i + 1] : args[i + 1];
                if (i === 0) {
                    current.push({ x, y, nodetype: 'Line' });
                    startX = x;
                    startY = y;
                } else {
                    // Implicit lineto for extra moveto pairs.
                    current.push({ x, y, nodetype: 'Line' });
                }
                cx = x;
                cy = y;
                lastCubicCp = null;
            }
            continue;
        }

        if (op === 'L') {
            for (let i = 0; i + 1 < args.length; i += 2) {
                const x = relative ? cx + args[i] : args[i];
                const y = relative ? cy + args[i + 1] : args[i + 1];
                current.push({ x, y, nodetype: 'Line' });
                cx = x;
                cy = y;
                lastCubicCp = null;
            }
            continue;
        }

        if (op === 'H') {
            for (const raw of args) {
                const x = relative ? cx + raw : raw;
                current.push({ x, y: cy, nodetype: 'Line' });
                cx = x;
                lastCubicCp = null;
            }
            continue;
        }

        if (op === 'V') {
            for (const raw of args) {
                const y = relative ? cy + raw : raw;
                current.push({ x: cx, y, nodetype: 'Line' });
                cy = y;
                lastCubicCp = null;
            }
            continue;
        }

        if (op === 'C') {
            for (let i = 0; i + 5 < args.length; i += 6) {
                const x1 = relative ? cx + args[i] : args[i];
                const y1 = relative ? cy + args[i + 1] : args[i + 1];
                const x2 = relative ? cx + args[i + 2] : args[i + 2];
                const y2 = relative ? cy + args[i + 3] : args[i + 3];
                const x = relative ? cx + args[i + 4] : args[i + 4];
                const y = relative ? cy + args[i + 5] : args[i + 5];
                current.push({ x: x1, y: y1, nodetype: 'OffCurve' });
                current.push({ x: x2, y: y2, nodetype: 'OffCurve' });
                current.push({ x, y, nodetype: 'Curve' });
                lastCubicCp = { x: x2, y: y2 };
                cx = x;
                cy = y;
            }
            continue;
        }

        if (op === 'S') {
            for (let i = 0; i + 3 < args.length; i += 4) {
                const x1 = lastCubicCp ? 2 * cx - lastCubicCp.x : cx;
                const y1 = lastCubicCp ? 2 * cy - lastCubicCp.y : cy;
                const x2 = relative ? cx + args[i] : args[i];
                const y2 = relative ? cy + args[i + 1] : args[i + 1];
                const x = relative ? cx + args[i + 2] : args[i + 2];
                const y = relative ? cy + args[i + 3] : args[i + 3];
                current.push({ x: x1, y: y1, nodetype: 'OffCurve' });
                current.push({ x: x2, y: y2, nodetype: 'OffCurve' });
                current.push({ x, y, nodetype: 'Curve' });
                lastCubicCp = { x: x2, y: y2 };
                cx = x;
                cy = y;
            }
            continue;
        }

        if (op === 'Z') {
            closed = true;
            cx = startX;
            cy = startY;
            lastCubicCp = null;
            flush();
            continue;
        }

        // Skip quadratic/arc for v1; rare in Illustrator outline paste.
        lastCubicCp = null;
    }

    flush();

    return flipSvgPathsToFontSpace(
        paths.map((path) => ({
            ...path,
            nodes: finalizeContourNodes(path.nodes, path.closed)
        }))
    );
}

/**
 * SVG `Z` closes without storing an extra point. Illustrator often also returns
 * the last cubic exactly onto the moveto, which would leave a duplicate oncurve.
 * Font contours must not duplicate that point when closed.
 */
function finalizeContourNodes(
    nodes: PasteNode[],
    closed: boolean
): PasteNode[] {
    if (!closed || nodes.length < 2) {
        return nodes;
    }

    const firstOnCurveIndex = nodes.findIndex(
        (node) => node.nodetype !== 'OffCurve'
    );
    if (firstOnCurveIndex < 0) {
        return nodes;
    }

    let lastOnCurveIndex = -1;
    for (let i = nodes.length - 1; i >= 0; i--) {
        if (nodes[i].nodetype !== 'OffCurve') {
            lastOnCurveIndex = i;
            break;
        }
    }
    if (
        lastOnCurveIndex <= firstOnCurveIndex ||
        !pointsNearlyEqual(nodes[firstOnCurveIndex], nodes[lastOnCurveIndex])
    ) {
        return coerceClosedOnCurveTypes(nodes);
    }

    const withoutDuplicate = nodes.slice(0, lastOnCurveIndex);
    return coerceClosedOnCurveTypes(withoutDuplicate);
}

function pointsNearlyEqual(
    a: { x: number; y: number },
    b: { x: number; y: number },
    epsilon = 0.05
): boolean {
    return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
}

/** Closed contours use Curve/QCurve for oncurves that follow offcurves. */
function coerceClosedOnCurveTypes(nodes: PasteNode[]): PasteNode[] {
    if (nodes.length === 0) {
        return nodes;
    }
    return nodes.map((node, index) => {
        if (node.nodetype === 'OffCurve') {
            return node;
        }
        let offCurveCount = 0;
        for (let step = 1; step < nodes.length; step++) {
            const previous =
                nodes[
                    (((index - step) % nodes.length) + nodes.length) %
                        nodes.length
                ];
            if (previous.nodetype !== 'OffCurve') {
                break;
            }
            offCurveCount += 1;
        }
        if (offCurveCount === 2 && node.nodetype !== 'Curve') {
            return { ...node, nodetype: 'Curve' };
        }
        if (offCurveCount === 1 && node.nodetype !== 'QCurve') {
            return { ...node, nodetype: 'QCurve' };
        }
        return node;
    });
}

function flipSvgPathsToFontSpace(paths: PastePath[]): PastePath[] {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const path of paths) {
        for (const node of path.nodes) {
            minY = Math.min(minY, node.y);
            maxY = Math.max(maxY, node.y);
        }
    }
    if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
        return paths;
    }
    const sum = minY + maxY;
    return paths.map((path) => ({
        ...path,
        nodes: path.nodes.map((node) => ({
            ...node,
            y: sum - node.y
        }))
    }));
}

function tokenizeSvgPath(
    pathData: string
): Array<{ type: string; args: number[] }> {
    const tokens: Array<{ type: string; args: number[] }> = [];
    const re =
        /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;
    let currentType: string | null = null;
    let currentArgs: number[] = [];
    let match: RegExpExecArray | null;

    const pushCurrent = () => {
        if (currentType) {
            tokens.push({ type: currentType, args: currentArgs });
        }
        currentType = null;
        currentArgs = [];
    };

    while ((match = re.exec(pathData)) !== null) {
        if (match[1]) {
            pushCurrent();
            currentType = match[1];
            if (currentType.toUpperCase() === 'Z') {
                pushCurrent();
            }
            continue;
        }
        if (match[2] && currentType) {
            currentArgs.push(Number(match[2]));
        }
    }
    pushCurrent();
    return tokens;
}

export type SerializePathsToSvgOptions = {
    embeddedJson?: string;
};

/**
 * Serialize font-space paths to an SVG document for clipboard export.
 *
 * Emits Glyphs/Illustrator-style SVG: paths Y-flipped into SVG space, translated
 * into the positive quadrant, with width/height/viewBox matching the path bbox
 * in font units (1 unit = 1 em unit). Nested contours (e.g. o counter) become
 * one compound `<path>` with multiple subpaths so Illustrator treats them as a
 * single shape with a hole; non-nested shapes stay separate path elements.
 *
 * Note: Glyphs' SVG paste path may still rescale content (unlike AICB/PDF from
 * Illustrator). Correct 1:1 size into Glyphs is via Counterpunch JSON + the
 * Paste from Counterpunch script — browsers cannot publish AICB.
 */
export function serializePathsToSvg(
    paths: PastePath[],
    options?: SerializePathsToSvgOptions
): string | null {
    if (paths.length === 0) {
        return null;
    }

    const bounds = computePathsBounds(paths);
    if (!bounds) {
        return null;
    }

    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);
    const svgPaths = fontPathsToSvgClipboardSpace(paths, bounds);
    const pathElements = compoundPathElementsFromPaths(svgPaths);

    if (pathElements.length === 0) {
        return null;
    }

    const metadata = options?.embeddedJson
        ? [
              '  <metadata id="counterpunch-clipboard">',
              `  <![CDATA[${options.embeddedJson}]]>`,
              '  </metadata>'
          ]
        : [];

    const w = fmtSvgNumber(width);
    const h = fmtSvgNumber(height);
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
        ...metadata,
        ...pathElements,
        '</svg>'
    ].join('\n');
}

/**
 * Group nested closed contours into compound path elements (Illustrator holes).
 * Non-nested shapes each get their own `<path>`.
 */
function compoundPathElementsFromPaths(paths: PastePath[]): string[] {
    const groups = groupPathsIntoCompoundShapes(paths);
    const elements: string[] = [];
    for (const group of groups) {
        const dParts: string[] = [];
        for (const path of group) {
            const d = pathToSvgD(path);
            if (d) {
                dParts.push(d);
            }
        }
        if (dParts.length === 0) {
            continue;
        }
        elements.push(`  <path d="${dParts.join('')}"/>`);
    }
    return elements;
}

/**
 * Nest closed paths by bbox containment (smallest enclosing parent).
 * Each root plus its nested children becomes one compound shape.
 */
function groupPathsIntoCompoundShapes(paths: PastePath[]): PastePath[][] {
    const pathBounds = paths.map((path) => computePathsBounds([path]));
    const parentOf = paths.map(() => -1);

    for (let i = 0; i < paths.length; i++) {
        if (!paths[i].closed || !pathBounds[i]) {
            continue;
        }
        let bestParent = -1;
        let bestArea = Infinity;
        for (let j = 0; j < paths.length; j++) {
            if (i === j || !paths[j].closed || !pathBounds[j]) {
                continue;
            }
            if (
                !bboxStrictlyContains(pathBounds[j]!, pathBounds[i]!) ||
                bboxStrictlyContains(pathBounds[i]!, pathBounds[j]!)
            ) {
                continue;
            }
            const area = bboxArea(pathBounds[j]!);
            if (area < bestArea) {
                bestArea = area;
                bestParent = j;
            }
        }
        parentOf[i] = bestParent;
    }

    const groups: PastePath[][] = [];
    const assigned = new Set<number>();

    const collectDescendants = (parent: number, group: PastePath[]) => {
        for (let k = 0; k < paths.length; k++) {
            if (parentOf[k] !== parent) {
                continue;
            }
            group.push(paths[k]);
            assigned.add(k);
            collectDescendants(k, group);
        }
    };

    for (let i = 0; i < paths.length; i++) {
        if (!paths[i].closed) {
            groups.push([paths[i]]);
            assigned.add(i);
            continue;
        }
        if (parentOf[i] !== -1) {
            continue;
        }
        const group = [paths[i]];
        assigned.add(i);
        collectDescendants(i, group);
        // Largest contour first (outer), then holes — matches Glyphs SVG order.
        group.sort((a, b) => {
            const areaA = bboxArea(computePathsBounds([a])!);
            const areaB = bboxArea(computePathsBounds([b])!);
            return areaB - areaA;
        });
        groups.push(group);
    }

    for (let i = 0; i < paths.length; i++) {
        if (!assigned.has(i)) {
            groups.push([paths[i]]);
        }
    }

    return groups;
}

function bboxArea(bounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}): number {
    return (
        Math.max(0, bounds.maxX - bounds.minX) *
        Math.max(0, bounds.maxY - bounds.minY)
    );
}

function bboxStrictlyContains(
    outer: { minX: number; minY: number; maxX: number; maxY: number },
    inner: { minX: number; minY: number; maxX: number; maxY: number }
): boolean {
    return (
        outer.minX <= inner.minX &&
        outer.minY <= inner.minY &&
        outer.maxX >= inner.maxX &&
        outer.maxY >= inner.maxY &&
        bboxArea(outer) > bboxArea(inner)
    );
}

/**
 * Translate + Y-flip font-space paths into Glyphs-style SVG clipboard space:
 * origin at the path bbox top-left, Y growing downward.
 */
function fontPathsToSvgClipboardSpace(
    paths: PastePath[],
    bounds: { minX: number; minY: number; maxX: number; maxY: number }
): PastePath[] {
    return paths.map((path) => ({
        ...path,
        nodes: path.nodes.map((node) => ({
            ...node,
            x: node.x - bounds.minX,
            y: bounds.maxY - node.y
        }))
    }));
}

export const COUNTERPUNCH_SVG_METADATA_ID = 'counterpunch-clipboard';

/** Extract embedded Counterpunch JSON from an SVG clipboard payload, if present. */
export function extractCounterpunchJsonFromSvg(payload: string): string | null {
    const match = payload.match(
        /<metadata\b[^>]*\bid=["']counterpunch-clipboard["'][^>]*>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/metadata>/i
    );
    if (!match?.[1]) {
        return null;
    }
    const json = match[1].trim();
    return json.startsWith('{') ? json : null;
}

function pathToSvgD(path: PastePath): string | null {
    const nodes = path.nodes;
    if (nodes.length === 0) {
        return null;
    }

    const onIndexes: number[] = [];
    for (let index = 0; index < nodes.length; index++) {
        if (nodes[index].nodetype !== 'OffCurve') {
            onIndexes.push(index);
        }
    }
    if (onIndexes.length === 0) {
        return null;
    }

    const parts: string[] = [];
    const start = nodes[onIndexes[0]];
    parts.push(`M${fmtSvgNumber(start.x)},${fmtSvgNumber(start.y)}`);

    const segmentCount = path.closed
        ? onIndexes.length
        : Math.max(0, onIndexes.length - 1);

    for (let segment = 0; segment < segmentCount; segment++) {
        const fromIndex = onIndexes[segment];
        const toIndex = onIndexes[(segment + 1) % onIndexes.length];
        const offs: PasteNode[] = [];
        let cursor = (fromIndex + 1) % nodes.length;
        let guard = 0;
        while (cursor !== toIndex && guard < nodes.length) {
            if (nodes[cursor].nodetype === 'OffCurve') {
                offs.push(nodes[cursor]);
            }
            cursor = (cursor + 1) % nodes.length;
            guard += 1;
        }
        const end = nodes[toIndex];
        if (offs.length >= 2) {
            parts.push(
                `C${fmtSvgNumber(offs[0].x)},${fmtSvgNumber(offs[0].y)} ${fmtSvgNumber(offs[1].x)},${fmtSvgNumber(offs[1].y)} ${fmtSvgNumber(end.x)},${fmtSvgNumber(end.y)}`
            );
        } else if (offs.length === 1) {
            parts.push(
                `Q${fmtSvgNumber(offs[0].x)},${fmtSvgNumber(offs[0].y)} ${fmtSvgNumber(end.x)},${fmtSvgNumber(end.y)}`
            );
        } else {
            parts.push(`L${fmtSvgNumber(end.x)},${fmtSvgNumber(end.y)}`);
        }
    }

    if (path.closed) {
        parts.push('Z');
    }
    return parts.join('');
}

function computePathsBounds(paths: PastePath[]): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
} | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let found = false;
    for (const path of paths) {
        for (const node of path.nodes) {
            if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
                continue;
            }
            found = true;
            minX = Math.min(minX, node.x);
            minY = Math.min(minY, node.y);
            maxX = Math.max(maxX, node.x);
            maxY = Math.max(maxY, node.y);
        }
    }
    if (!found) {
        return null;
    }
    return { minX, minY, maxX, maxY };
}

function fmtSvgNumber(value: number): string {
    const rounded = Math.round(value * 1000) / 1000;
    return String(rounded);
}
