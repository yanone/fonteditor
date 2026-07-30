/**
 * Serialize Counterpunch model objects to counterpunch-clipboard JSON.
 */

import {
    DecomposedAffineTransform,
    type Glyph,
    type Layer
} from '../babelfont-model';
import {
    COUNTERPUNCH_CLIPBOARD_FORMAT,
    type PasteGlyph,
    type PasteGlyphLayer
} from './json';
import type {
    PasteAnchor,
    PasteComponent,
    PasteGuide,
    PasteNode,
    PastePath
} from './types';

export const COUNTERPUNCH_CLIPBOARD_VERSION = 1;

export type CounterpunchSelectionClipboard = {
    format: typeof COUNTERPUNCH_CLIPBOARD_FORMAT;
    version: number;
    kind: 'selection';
    nodeOrder: 'start-first';
    keepAbsoluteCoords: true;
    glyph?: string | null;
    layerId?: string | null;
    paths: PastePath[];
    components: PasteComponent[];
    anchors: PasteAnchor[];
    guides: PasteGuide[];
};

export type CounterpunchGlyphsClipboard = {
    format: typeof COUNTERPUNCH_CLIPBOARD_FORMAT;
    version: number;
    kind: 'glyphs';
    nodeOrder: 'start-first';
    glyphs: PasteGlyph[];
};

export type CounterpunchClipboardDocument =
    CounterpunchSelectionClipboard | CounterpunchGlyphsClipboard;

export function buildSelectionClipboardDocument(options: {
    glyphName?: string | null;
    layerId?: string | null;
    paths: PastePath[];
    components: PasteComponent[];
    anchors: PasteAnchor[];
    guides: PasteGuide[];
}): CounterpunchSelectionClipboard | null {
    const { paths, components, anchors, guides } = options;
    if (
        paths.length === 0 &&
        components.length === 0 &&
        anchors.length === 0 &&
        guides.length === 0
    ) {
        return null;
    }
    return {
        format: COUNTERPUNCH_CLIPBOARD_FORMAT,
        version: COUNTERPUNCH_CLIPBOARD_VERSION,
        kind: 'selection',
        nodeOrder: 'start-first',
        keepAbsoluteCoords: true,
        glyph: options.glyphName ?? null,
        layerId: options.layerId ?? null,
        paths,
        components,
        anchors,
        guides
    };
}

export function buildGlyphsClipboardDocument(
    glyphs: PasteGlyph[]
): CounterpunchGlyphsClipboard | null {
    if (glyphs.length === 0) {
        return null;
    }
    return {
        format: COUNTERPUNCH_CLIPBOARD_FORMAT,
        version: COUNTERPUNCH_CLIPBOARD_VERSION,
        kind: 'glyphs',
        nodeOrder: 'start-first',
        glyphs
    };
}

export function serializeGlyphForClipboard(glyph: Glyph): PasteGlyph {
    const layers: PasteGlyphLayer[] = [];
    for (const layer of glyph.layers || []) {
        if (layer.is_background) {
            continue;
        }
        layers.push(serializeLayerForClipboard(layer));
    }
    return {
        name: glyph.name,
        leftMetricsKey: glyph.leftMetricsKey ?? null,
        rightMetricsKey: glyph.rightMetricsKey ?? null,
        layers
    };
}

export function serializeLayerForClipboard(layer: Layer): PasteGlyphLayer {
    const paths: PastePath[] = [];
    const components: PasteComponent[] = [];
    for (const shape of layer.shapes || []) {
        if (shape.isPath?.()) {
            paths.push(serializePathForClipboard(shape.asPath()));
        } else if (shape.isComponent?.()) {
            components.push(
                serializeComponentForClipboard(shape.asComponent())
            );
        }
    }
    return {
        layerId: layer.id,
        name: layer.name,
        width: Number(layer.width),
        leftMetricsKey: layer.leftMetricsKey ?? null,
        rightMetricsKey: layer.rightMetricsKey ?? null,
        paths,
        components,
        anchors: (layer.anchors || [])
            .filter((anchor) => !!anchor.name)
            .map(serializeAnchorForClipboard),
        guides: (layer.guides || []).map((guide) =>
            serializeGuideForClipboard(guide, false)
        )
    };
}

export function serializePathForClipboard(path: {
    closed?: boolean;
    nodes?: Array<{
        x: number;
        y: number;
        nodetype?: string;
        type?: string;
        smooth?: boolean;
    }>;
}): PastePath {
    const nodes: PasteNode[] = [];
    for (const node of path.nodes || []) {
        const serialized = serializeNodeForClipboard(node);
        if (serialized) {
            nodes.push(serialized);
        }
    }
    const closed = !!path.closed;
    return {
        closed,
        nodes: ensureStartFirstNodes(nodes, closed)
    };
}

/** Rotate Glyphs-ordered closed contours so the start on-curve is index 0. */
function ensureStartFirstNodes(
    nodes: PasteNode[],
    closed: boolean
): PasteNode[] {
    if (!closed || nodes.length < 2) {
        return nodes;
    }
    if (nodes[0].nodetype !== 'OffCurve') {
        return nodes;
    }
    const last = nodes[nodes.length - 1];
    if (last.nodetype === 'OffCurve') {
        return nodes;
    }
    return [last, ...nodes.slice(0, -1)];
}

export function serializeComponentForClipboard(component: {
    reference: string;
    transform?: unknown;
    automaticAlignment?: boolean;
    anchor?: string;
}): PasteComponent {
    const transform = toAffineTuple(component.transform);
    return {
        reference: component.reference,
        x: transform[4],
        y: transform[5],
        transform,
        alignment: component.automaticAlignment ? 1 : 0,
        ...(component.anchor ? { anchor: component.anchor } : {})
    };
}

export function serializeAnchorForClipboard(anchor: {
    name?: string;
    x: number;
    y: number;
}): PasteAnchor {
    return {
        name: anchor.name || '',
        x: Number(anchor.x),
        y: Number(anchor.y)
    };
}

export function serializeGuideForClipboard(
    guide: {
        name?: string;
        pos?: { x?: number; y?: number; angle?: number };
        x?: number;
        y?: number;
        angle?: number;
    },
    globalGuide: boolean
): PasteGuide {
    const x = Number(guide.pos?.x ?? guide.x ?? 0);
    const y = Number(guide.pos?.y ?? guide.y ?? 0);
    const angle = Number(guide.pos?.angle ?? guide.angle ?? 0);
    return {
        ...(guide.name ? { name: guide.name } : {}),
        x,
        y,
        angle,
        global: globalGuide
    };
}

export function serializeMasterGuideForClipboard(guide: {
    name?: string;
    pos?: { x?: number; y?: number; angle?: number };
    x?: number;
    y?: number;
    angle?: number;
}): PasteGuide {
    return serializeGuideForClipboard(guide, true);
}

export function stringifyClipboardDocument(
    document: CounterpunchClipboardDocument
): string {
    return JSON.stringify(document, null, 4);
}

export function summarizeClipboardDocument(
    document: CounterpunchClipboardDocument
): string {
    if (document.kind === 'selection') {
        const counts: string[] = [];
        const entries: Array<[keyof CounterpunchSelectionClipboard, string]> = [
            ['paths', 'path'],
            ['components', 'component'],
            ['anchors', 'anchor'],
            ['guides', 'guide']
        ];
        for (const [key, label] of entries) {
            const value = document[key];
            const count = Array.isArray(value) ? value.length : 0;
            if (count > 0) {
                counts.push(`${count} ${label}${count === 1 ? '' : 's'}`);
            }
        }
        const detail = counts.length > 0 ? counts.join(', ') : 'nothing';
        return `Copied ${detail} from /${document.glyph || '?'}`;
    }
    const count = document.glyphs.length;
    return `Copied ${count} glyph${count === 1 ? '' : 's'}`;
}

function serializeNodeForClipboard(node: {
    x: number;
    y: number;
    nodetype?: string;
    type?: string;
    smooth?: boolean;
}): PasteNode | null {
    const rawType = String(node.nodetype || node.type || '');
    const nodetype = normalizeNodeType(rawType);
    if (!nodetype) {
        return null;
    }
    return {
        x: Number(node.x),
        y: Number(node.y),
        nodetype,
        ...(node.smooth && nodetype !== 'OffCurve' ? { smooth: true } : {})
    };
}

function normalizeNodeType(value: string): PasteNode['nodetype'] | null {
    switch (value) {
        case 'Line':
        case 'Curve':
        case 'OffCurve':
        case 'QCurve':
        case 'Move':
            return value;
        case 'line':
            return 'Line';
        case 'curve':
            return 'Curve';
        case 'offcurve':
        case 'o':
            return 'OffCurve';
        case 'qcurve':
            return 'QCurve';
        case 'move':
            return 'Move';
        default:
            return null;
    }
}

function toAffineTuple(
    transform: unknown
): [number, number, number, number, number, number] {
    if (Array.isArray(transform) && transform.length >= 6) {
        return [
            Number(transform[0]) || 0,
            Number(transform[1]) || 0,
            Number(transform[2]) || 0,
            Number(transform[3]) || 0,
            Number(transform[4]) || 0,
            Number(transform[5]) || 0
        ];
    }
    if (transform && typeof transform === 'object') {
        return DecomposedAffineTransform.toAffine(
            transform as Parameters<
                typeof DecomposedAffineTransform.toAffine
            >[0]
        );
    }
    return DecomposedAffineTransform.toAffine(
        DecomposedAffineTransform.identity()
    );
}

// Re-export helpers used by callers that also serialize master guides.
export type { PasteGlyph };
