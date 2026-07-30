/**
 * Serialize Counterpunch model objects to counterpunch-clipboard JSON.
 */

import {
    DecomposedAffineTransform,
    Layer,
    type Font,
    type Glyph
} from '../babelfont-model';
import {
    COUNTERPUNCH_CLIPBOARD_FORMAT,
    COUNTERPUNCH_GLYPHS_CLIPBOARD_VERSION,
    type PasteClipboardMaster,
    type PasteFeatureVariation,
    type PasteGlyph,
    type PasteGlyphLayer,
    type PasteLayerMaster
} from './json';
import type {
    PasteAnchor,
    PasteComponent,
    PasteGuide,
    PasteNode,
    PastePath
} from './types';

export const COUNTERPUNCH_CLIPBOARD_VERSION = 1;

const GLYPHS_ATTR_KEY = 'com.schriftgestalt.Glyphs.attr';

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
    masters: PasteClipboardMaster[];
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
    glyphs: PasteGlyph[],
    masters: PasteClipboardMaster[]
): CounterpunchGlyphsClipboard | null {
    if (glyphs.length === 0 || masters.length === 0) {
        return null;
    }
    return {
        format: COUNTERPUNCH_CLIPBOARD_FORMAT,
        version: COUNTERPUNCH_GLYPHS_CLIPBOARD_VERSION,
        kind: 'glyphs',
        nodeOrder: 'start-first',
        masters,
        glyphs
    };
}

export function serializeFontMastersForClipboard(
    font: Font
): PasteClipboardMaster[] {
    return (font.masters || []).map((master) => {
        const location = plainLocation(master.location);
        return {
            id: master.id,
            name: masterDisplayName(master),
            ...(location ? { location } : {})
        };
    });
}

export function serializeGlyphForClipboard(glyph: Glyph): PasteGlyph {
    const font = glyph.parent() as Font | null;
    const masterIds = (font?.masters || []).map((master) => master.id);
    const masterIndexById = new Map(
        masterIds.map((id, index) => [id, index] as const)
    );

    const baseLayers: PasteGlyphLayer[] = [];
    const featureVariationMap = new Map<
        string,
        { axisRules: unknown[]; layers: PasteGlyphLayer[] }
    >();

    for (const layer of getRawForegroundLayers(glyph)) {
        const serialized = serializeLayerForClipboard(layer, masterIndexById);
        if (!serialized) {
            continue;
        }
        const axisRules = readFeatureVariationAxisRules(layer);
        if (axisRules) {
            const familyId = JSON.stringify(axisRules);
            let family = featureVariationMap.get(familyId);
            if (!family) {
                family = { axisRules, layers: [] };
                featureVariationMap.set(familyId, family);
            }
            family.layers.push(serialized);
            continue;
        }
        baseLayers.push(serialized);
    }

    const featureVariations: PasteFeatureVariation[] = [
        ...featureVariationMap.values()
    ];

    return {
        name: glyph.name,
        leftMetricsKey: glyph.leftMetricsKey ?? null,
        rightMetricsKey: glyph.rightMetricsKey ?? null,
        layers: baseLayers,
        ...(featureVariations.length > 0 ? { featureVariations } : {})
    };
}

export function serializeLayerForClipboard(
    layer: Layer,
    masterIndexById?: Map<string, number>
): PasteGlyphLayer | null {
    const master = serializeLayerMaster(layer, masterIndexById);
    if (!master) {
        return null;
    }

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

    const location = plainLocation(layer.location);
    return {
        layerId: layer.id,
        name: layer.name,
        master,
        ...(location ? { location } : {}),
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

function getRawForegroundLayers(glyph: Glyph): Layer[] {
    const layersData = (glyph as unknown as { data?: { layers?: unknown[] } })
        .data?.layers;
    if (!Array.isArray(layersData)) {
        return [];
    }
    const layers: Layer[] = [];
    for (let index = 0; index < layersData.length; index++) {
        const layer = new Layer(layersData as never, index, glyph);
        if (layer.is_background) {
            continue;
        }
        layers.push(layer);
    }
    return layers;
}

function serializeLayerMaster(
    layer: Layer,
    masterIndexById?: Map<string, number>
): PasteLayerMaster | null {
    const master = layer.master;
    if (!master || typeof master !== 'object' || !('type' in master)) {
        return null;
    }
    if (master.type === 'FreeFloating') {
        return { type: 'FreeFloating' };
    }
    if (
        master.type !== 'DefaultForMaster' &&
        master.type !== 'AssociatedWithMaster'
    ) {
        return null;
    }
    const masterId = master.master;
    if (typeof masterId !== 'string' || !masterId) {
        return null;
    }
    const masterIndex = masterIndexById?.get(masterId);
    if (masterIndex === undefined) {
        return null;
    }
    return { type: master.type, masterIndex };
}

function readFeatureVariationAxisRules(layer: Layer): unknown[] | null {
    const attributes = layer.format_specific?.[GLYPHS_ATTR_KEY];
    if (
        !attributes ||
        typeof attributes !== 'object' ||
        Array.isArray(attributes)
    ) {
        return null;
    }
    const axisRules = (attributes as { axisRules?: unknown }).axisRules;
    return Array.isArray(axisRules) ? axisRules : null;
}

function plainLocation(value: unknown): Record<string, number> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const location: Record<string, number> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        const num = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(num)) {
            continue;
        }
        location[key] = num;
    }
    return Object.keys(location).length > 0 ? location : null;
}

function masterDisplayName(master: {
    id: string;
    toJSON?: () => { name?: unknown };
}): string {
    const name = master.toJSON?.()?.name;
    if (typeof name === 'string' && name) {
        return name;
    }
    if (name && typeof name === 'object' && !Array.isArray(name)) {
        const record = name as Record<string, unknown>;
        for (const key of ['dflt', 'en']) {
            if (typeof record[key] === 'string' && record[key]) {
                return record[key] as string;
            }
        }
        for (const value of Object.values(record)) {
            if (typeof value === 'string' && value) {
                return value;
            }
        }
    }
    return master.id;
}

// Re-export helpers used by callers that also serialize master guides.
export type { PasteGlyph };
