/**
 * Counterpunch native JSON clipboard converter
 * (Glyphs "Copy to Counterpunch" script and future CP copy).
 */

import type {
    PasteAnchor,
    PasteComponent,
    PasteFragment,
    PasteGuide,
    PasteNode,
    PasteNodeType,
    PastePath
} from './types';

export const COUNTERPUNCH_CLIPBOARD_FORMAT = 'counterpunch-clipboard';
/** Custom MIME for Counterpunch JSON. Chrome keeps this for web paste; macOS apps do not see it. */
export const COUNTERPUNCH_CLIPBOARD_MIME =
    'application/x-counterpunch-clipboard';

export type PasteGlyphLayer = {
    layerId?: string;
    name?: string;
    width?: number;
    leftMetricsKey?: string | null;
    rightMetricsKey?: string | null;
    paths: PastePath[];
    components: PasteComponent[];
    anchors: PasteAnchor[];
    guides: PasteGuide[];
};

export type PasteGlyph = {
    name: string;
    leftMetricsKey?: string | null;
    rightMetricsKey?: string | null;
    layers: PasteGlyphLayer[];
};

export type PasteGlyphsDocument = {
    format: 'counterpunch-json';
    kind: 'glyphs';
    glyphs: PasteGlyph[];
    /**
     * `glyphs`: closed paths store the start node last (Glyphs native order).
     * `start-first`: closed paths store the start node at index 0 (Counterpunch).
     */
    nodeOrder?: 'glyphs' | 'start-first';
};

export type ParsedCounterpunchClipboard =
    | { kind: 'selection'; fragment: PasteFragment }
    | { kind: 'glyphs'; document: PasteGlyphsDocument };

export type CounterpunchNodeOrder = 'glyphs' | 'start-first';

export function canParseCounterpunchJson(payload: string): boolean {
    const trimmed = payload.trim();
    if (!trimmed.startsWith('{')) {
        return false;
    }
    return (
        trimmed.includes(`"format"`) &&
        trimmed.includes(COUNTERPUNCH_CLIPBOARD_FORMAT)
    );
}

export function parseCounterpunchJson(
    payload: string
): ParsedCounterpunchClipboard | null {
    let raw: unknown;
    try {
        raw = JSON.parse(payload);
    } catch {
        return null;
    }
    if (!isRecord(raw)) {
        return null;
    }
    if (raw.format !== COUNTERPUNCH_CLIPBOARD_FORMAT) {
        return null;
    }

    const nodeOrder = parseNodeOrder(raw.nodeOrder);
    const kind = raw.kind;
    if (kind === 'glyphs') {
        const glyphs = parseGlyphs(raw.glyphs, nodeOrder);
        if (!glyphs || glyphs.length === 0) {
            return null;
        }
        return {
            kind: 'glyphs',
            document: {
                format: 'counterpunch-json',
                kind: 'glyphs',
                glyphs,
                nodeOrder
            }
        };
    }

    // Default / "selection"
    const fragment = parseSelectionFragment(raw, nodeOrder);
    if (!fragment) {
        return null;
    }
    return { kind: 'selection', fragment };
}

function parseNodeOrder(value: unknown): CounterpunchNodeOrder {
    return value === 'start-first' ? 'start-first' : 'glyphs';
}

function parseSelectionFragment(
    raw: Record<string, unknown>,
    nodeOrder: CounterpunchNodeOrder
): PasteFragment | null {
    const paths = parsePaths(raw.paths, nodeOrder);
    const components = parseComponents(raw.components);
    const anchors = parseAnchors(raw.anchors);
    const guides = parseGuides(raw.guides);
    if (
        paths.length === 0 &&
        components.length === 0 &&
        anchors.length === 0 &&
        guides.length === 0
    ) {
        return null;
    }
    return {
        format: 'counterpunch-json',
        paths,
        components,
        anchors,
        guides,
        keepAbsoluteCoords: raw.keepAbsoluteCoords !== false
    };
}

function parseGlyphs(
    value: unknown,
    nodeOrder: CounterpunchNodeOrder
): PasteGlyph[] | null {
    if (!Array.isArray(value)) {
        return null;
    }
    const glyphs: PasteGlyph[] = [];
    for (const entry of value) {
        if (!isRecord(entry) || typeof entry.name !== 'string') {
            continue;
        }
        const layersRaw = entry.layers;
        if (!Array.isArray(layersRaw) || layersRaw.length === 0) {
            continue;
        }
        const layers: PasteGlyphLayer[] = [];
        for (const layerEntry of layersRaw) {
            const layer = parseGlyphLayer(layerEntry, nodeOrder);
            if (layer) {
                layers.push(layer);
            }
        }
        if (layers.length === 0) {
            continue;
        }
        glyphs.push({
            name: entry.name,
            leftMetricsKey: optionalString(entry.leftMetricsKey),
            rightMetricsKey: optionalString(entry.rightMetricsKey),
            layers
        });
    }
    return glyphs.length > 0 ? glyphs : null;
}

function parseGlyphLayer(
    value: unknown,
    nodeOrder: CounterpunchNodeOrder
): PasteGlyphLayer | null {
    if (!isRecord(value)) {
        return null;
    }
    return {
        layerId: optionalString(value.layerId) ?? undefined,
        name: optionalString(value.name) ?? undefined,
        width: optionalNumber(value.width) ?? undefined,
        leftMetricsKey: optionalString(value.leftMetricsKey),
        rightMetricsKey: optionalString(value.rightMetricsKey),
        paths: parsePaths(value.paths, nodeOrder),
        components: parseComponents(value.components),
        anchors: parseAnchors(value.anchors),
        guides: parseGuides(value.guides)
    };
}

function parsePaths(
    value: unknown,
    nodeOrder: CounterpunchNodeOrder
): PastePath[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const paths: PastePath[] = [];
    for (const entry of value) {
        if (!isRecord(entry) || !Array.isArray(entry.nodes)) {
            continue;
        }
        const nodes: PasteNode[] = [];
        for (const nodeEntry of entry.nodes) {
            const node = parseNode(nodeEntry);
            if (node) {
                nodes.push(node);
            }
        }
        if (nodes.length === 0) {
            continue;
        }
        const closed = Boolean(entry.closed);
        paths.push({
            closed,
            nodes:
                closed && nodeOrder === 'glyphs'
                    ? glyphsClosedPathToStartFirst(nodes)
                    : nodes
        });
    }
    return paths;
}

/**
 * Glyphs stores the closed-path start node at the last index (the oncurve that
 * ends the segment wrapping to nodes[0]). Counterpunch uses index 0 as start.
 */
export function glyphsClosedPathToStartFirst(nodes: PasteNode[]): PasteNode[] {
    if (nodes.length < 2) {
        return nodes;
    }
    const last = nodes[nodes.length - 1];
    if (last.nodetype === 'OffCurve') {
        return nodes;
    }
    return [last, ...nodes.slice(0, -1)];
}

function parseNode(value: unknown): PasteNode | null {
    if (!isRecord(value)) {
        return null;
    }
    const x = optionalNumber(value.x);
    const y = optionalNumber(value.y);
    const nodetype = parseNodeType(value.nodetype);
    if (x === null || y === null || !nodetype) {
        return null;
    }
    return {
        x,
        y,
        nodetype,
        ...(value.smooth ? { smooth: true } : {})
    };
}

function parseNodeType(value: unknown): PasteNodeType | null {
    if (typeof value !== 'string') {
        return null;
    }
    switch (value) {
        case 'Line':
        case 'Curve':
        case 'OffCurve':
        case 'QCurve':
        case 'Move':
            return value;
        default:
            return null;
    }
}

function parseComponents(value: unknown): PasteComponent[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const components: PasteComponent[] = [];
    for (const entry of value) {
        if (!isRecord(entry) || typeof entry.reference !== 'string') {
            continue;
        }
        const transform = parseAffineTransform(entry.transform);
        const x = transform?.[4] ?? optionalNumber(entry.x) ?? 0;
        const y = transform?.[5] ?? optionalNumber(entry.y) ?? 0;
        const anchor =
            typeof entry.anchor === 'string' && entry.anchor.trim()
                ? entry.anchor.trim()
                : undefined;
        components.push({
            reference: entry.reference,
            x,
            y,
            ...(transform ? { transform } : {}),
            alignment: optionalNumber(entry.alignment) ?? undefined,
            ...(anchor ? { anchor } : {})
        });
    }
    return components;
}

function parseAffineTransform(
    value: unknown
): [number, number, number, number, number, number] | undefined {
    if (!Array.isArray(value) || value.length < 6) {
        return undefined;
    }
    const numbers: number[] = [];
    for (let index = 0; index < 6; index++) {
        const parsed = optionalNumber(value[index]);
        if (parsed === null) {
            return undefined;
        }
        numbers.push(parsed);
    }
    return numbers as [number, number, number, number, number, number];
}

function parseAnchors(value: unknown): PasteAnchor[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const anchors: PasteAnchor[] = [];
    for (const entry of value) {
        if (!isRecord(entry) || typeof entry.name !== 'string') {
            continue;
        }
        const x = optionalNumber(entry.x);
        const y = optionalNumber(entry.y);
        if (x === null || y === null) {
            continue;
        }
        anchors.push({ name: entry.name, x, y });
    }
    return anchors;
}

function parseGuides(value: unknown): PasteGuide[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const guides: PasteGuide[] = [];
    for (const entry of value) {
        if (!isRecord(entry)) {
            continue;
        }
        const x = optionalNumber(entry.x);
        const y = optionalNumber(entry.y);
        if (x === null || y === null) {
            continue;
        }
        guides.push({
            name: optionalString(entry.name) ?? undefined,
            x,
            y,
            angle: optionalNumber(entry.angle) ?? 0,
            global: Boolean(entry.global)
        });
    }
    return guides;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function optionalString(value: unknown): string | null {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}
