/**
 * Clipboard paste/copy orchestration for outline editing.
 *
 * Paste priority: Counterpunch JSON (custom MIME, text/plain, or SVG
 * metadata) → SVG paths.
 * Copy writes JSON on text/plain and, via the Async Clipboard API,
 * image/svg+xml so macOS Chrome publishes public.svg-image for Glyphs
 * Cmd+V. Sync setData alone cannot expose SVG as a system UTI.
 * Selection pastes fan out to linked layers when linked.
 * Whole-glyph JSON pastes create new glyphs (Glyphs-style .001 names)
 * with layer content remapped onto this font's masters.
 * SVG pastes are centered in the target layer.
 */

import { Logger } from './logger';
import { getHighestVisibleVerticalMetricValue } from './glyph-canvas/vertical-metrics';
import type { Font, Layer, Master } from './babelfont-model';
import type { Babelfont } from './babelfont';
import {
    canParseCounterpunchJson,
    COUNTERPUNCH_CLIPBOARD_MIME,
    parseCounterpunchJson,
    type PasteGlyphsDocument
} from './clipboard/json';
import {
    SVG_MIME_TYPES,
    canParseSvg,
    extractCounterpunchJsonFromSvg,
    parseSvg,
    serializePathsToSvg
} from './clipboard/svg';
import type {
    ClipboardPayload,
    PasteFragment,
    PasteGuide,
    PastePath
} from './clipboard/types';
import type { CounterpunchClipboardDocument } from './clipboard/serialize';
import { stringifyClipboardDocument } from './clipboard/serialize';

export {
    buildGlyphsClipboardDocument,
    buildSelectionClipboardDocument,
    serializeAnchorForClipboard,
    serializeComponentForClipboard,
    serializeGlyphForClipboard,
    serializeGuideForClipboard,
    serializeLayerForClipboard,
    serializeMasterGuideForClipboard,
    serializePathForClipboard,
    stringifyClipboardDocument,
    summarizeClipboardDocument,
    COUNTERPUNCH_CLIPBOARD_VERSION
} from './clipboard/serialize';
export type {
    CounterpunchClipboardDocument,
    CounterpunchGlyphsClipboard,
    CounterpunchSelectionClipboard
} from './clipboard/serialize';
export {
    serializePathsToSvg,
    SVG_MIME_TYPES,
    extractCounterpunchJsonFromSvg
} from './clipboard/svg';
export type { SerializePathsToSvgOptions } from './clipboard/svg';
export { COUNTERPUNCH_CLIPBOARD_MIME } from './clipboard/json';

const console = new Logger('Clipboard');

export type {
    ClipboardPayload,
    PasteFragment,
    PastePath,
    PasteGuide
} from './clipboard/types';

export type { PasteGlyphsDocument, PasteGlyph } from './clipboard/json';

export type ParsedClipboard =
    | { kind: 'selection'; fragment: PasteFragment }
    | { kind: 'glyphs'; document: PasteGlyphsDocument };

export type ApplyPasteOptions = {
    activeLayer: Layer;
    linkedLayers: Layer[];
    master?: Master | null;
    layerWidth: number;
    verticalMetrics?: Record<string, number> | null;
    glyphExists: (name: string) => boolean;
};

export type ApplyPasteGlyphsOptions = {
    font: Font;
    glyphExists: (name: string) => boolean;
};

export type ApplyPasteResult = {
    fragment: PasteFragment;
    addedPathCount: number;
    addedComponentCount: number;
    addedAnchorCount: number;
    updatedAnchorCount: number;
    addedGuideCount: number;
    skippedComponents: string[];
    error?: string;
};

export type ApplyPasteGlyphsResult = ApplyPasteResult & {
    createdGlyphNames: string[];
};

export function collectClipboardPayloads(
    clipboardData: DataTransfer | null | undefined
): ClipboardPayload[] {
    if (!clipboardData) {
        return [];
    }
    const payloads: ClipboardPayload[] = [];
    const seen = new Set<string>();

    const push = (type: string, data: string) => {
        if (!data || seen.has(`${type}\0${data}`)) {
            return;
        }
        seen.add(`${type}\0${data}`);
        payloads.push({ type, data });
    };

    const types = Array.from(clipboardData.types || []);
    for (const type of types) {
        try {
            const data = clipboardData.getData(type);
            if (data) {
                push(type, data);
            }
        } catch {
            // Some browsers throw for non-text types.
        }
    }

    for (const type of [
        COUNTERPUNCH_CLIPBOARD_MIME,
        ...SVG_MIME_TYPES,
        'text/plain',
        'text/html'
    ]) {
        if (types.includes(type)) {
            continue;
        }
        try {
            const data = clipboardData.getData(type);
            if (data) {
                push(type, data);
            }
        } catch {
            // Ignore unavailable types.
        }
    }

    return payloads;
}

/**
 * Write a Counterpunch clipboard document for Cmd+C.
 *
 * Sync DataTransfer path (copy-event fallback): JSON on text/plain. Setting
 * image/svg+xml via setData does not publish a real macOS UTI — Chrome keeps
 * it in org.chromium.web-custom-data, which Glyphs cannot see.
 *
 * Prefer {@link writeClipboardDocumentAsync} which uses ClipboardItem so
 * image/svg+xml maps to public.svg-image for Glyphs/Illustrator Cmd+V.
 */
export function writeClipboardDocumentToDataTransfer(
    clipboardData: DataTransfer,
    document: CounterpunchClipboardDocument,
    paths: PastePath[]
): void {
    const json = stringifyClipboardDocument(document);
    try {
        clipboardData.setData(COUNTERPUNCH_CLIPBOARD_MIME, json);
    } catch {
        // Some browsers reject non-standard MIME types.
    }
    clipboardData.setData('text/plain', json);

    // Best-effort: same-browser paste may still see these; native apps will not.
    const svg = serializePathsToSvg(paths);
    if (svg) {
        for (const type of SVG_MIME_TYPES) {
            try {
                clipboardData.setData(type, svg);
            } catch {
                // Some browsers reject non-standard MIME types.
            }
        }
    }
}

/**
 * Write JSON + SVG via the Async Clipboard API.
 * On macOS Chrome, image/svg+xml becomes public.svg-image (system-visible),
 * which Glyphs Cmd+V can paste. text/plain stays Counterpunch JSON for scripts.
 */
export async function writeClipboardDocumentAsync(
    document: CounterpunchClipboardDocument,
    paths: PastePath[]
): Promise<boolean> {
    if (
        typeof navigator === 'undefined' ||
        !navigator.clipboard?.write ||
        typeof ClipboardItem === 'undefined'
    ) {
        return false;
    }

    const json = stringifyClipboardDocument(document);
    const representations: Record<string, Blob> = {
        'text/plain': new Blob([json], { type: 'text/plain' })
    };

    const svg = serializePathsToSvg(paths);
    const supportsSvg =
        typeof ClipboardItem.supports !== 'function' ||
        ClipboardItem.supports('image/svg+xml');
    if (svg && supportsSvg) {
        representations['image/svg+xml'] = new Blob([svg], {
            type: 'image/svg+xml'
        });
    }

    const withCustom: Record<string, Blob> = {
        ...representations,
        [`web ${COUNTERPUNCH_CLIPBOARD_MIME}`]: new Blob([json], {
            type: COUNTERPUNCH_CLIPBOARD_MIME
        })
    };

    try {
        await navigator.clipboard.write([new ClipboardItem(withCustom)]);
        return true;
    } catch {
        // Custom web formats are optional; retry well-known types only.
    }

    try {
        await navigator.clipboard.write([new ClipboardItem(representations)]);
        return true;
    } catch (error) {
        console.warn('Async clipboard write failed', error);
        return false;
    }
}

export function parseClipboardPayloads(
    payloads: ClipboardPayload[]
): ParsedClipboard | null {
    // Prefer Counterpunch JSON on any text-like payload (including SVG metadata).
    for (const payload of payloads) {
        const candidates = [payload.data];
        if (canParseSvg(payload.data)) {
            const embedded = extractCounterpunchJsonFromSvg(payload.data);
            if (embedded) {
                candidates.unshift(embedded);
            }
        }
        for (const candidate of candidates) {
            if (!canParseCounterpunchJson(candidate)) {
                continue;
            }
            const parsed = parseCounterpunchJson(candidate);
            if (parsed) {
                return parsed;
            }
        }
    }

    const byType = new Map(
        payloads.map((payload) => [payload.type, payload.data])
    );

    for (const type of SVG_MIME_TYPES) {
        const data = byType.get(type);
        if (!data) {
            continue;
        }
        const parsed = parseSvg(data);
        if (parsed) {
            return { kind: 'selection', fragment: parsed };
        }
    }

    for (const payload of payloads) {
        if (canParseSvg(payload.data)) {
            const parsed = parseSvg(payload.data);
            if (parsed) {
                return { kind: 'selection', fragment: parsed };
            }
        }
    }

    return null;
}

export function applyPasteFragment(
    fragment: PasteFragment,
    options: ApplyPasteOptions
): ApplyPasteResult {
    const targetLayers = [options.activeLayer, ...options.linkedLayers];
    const isBackground = !!options.activeLayer.is_background;

    let working: PasteFragment = cloneFragment(fragment);

    if (!working.keepAbsoluteCoords) {
        working = centerFragmentInLayer(
            working,
            options.layerWidth,
            options.verticalMetrics
        );
        working = placeGuideOrigins(working, options.verticalMetrics);
    }

    const result = emptyResult(working);
    const foregroundTargets = targetLayers.filter(
        (layer) => !layer.is_background
    );

    for (const layer of targetLayers) {
        for (const path of working.paths) {
            appendPathToLayer(layer, path);
        }
    }
    result.addedPathCount = working.paths.length * targetLayers.length;

    if (!isBackground) {
        applyNonPathObjectsToLayers(
            working,
            foregroundTargets,
            options.activeLayer,
            options.master ?? null,
            options.glyphExists,
            result,
            { fanOutAnchors: true }
        );
    }

    return result;
}

/**
 * Paste a whole-glyph Counterpunch JSON document onto the current glyph.
 * Layers are matched by count (order). Metrics/width are applied per layer.
 */
/**
 * Paste whole-glyph clipboard data as always-new glyphs.
 * Names use Glyphs-style uniqueness (`a` → `a.001` when `a` exists).
 * New glyphs get layers for this font's masters; source layer content is
 * zipped by count/order onto those layers (master IDs come from the target).
 */
export function applyPasteGlyphsDocument(
    document: PasteGlyphsDocument,
    options: ApplyPasteGlyphsOptions
): ApplyPasteGlyphsResult {
    const empty = (): ApplyPasteGlyphsResult => ({
        ...emptyResult({
            format: 'counterpunch-json',
            paths: [],
            components: [],
            anchors: [],
            guides: [],
            keepAbsoluteCoords: true
        }),
        createdGlyphNames: []
    });

    if (!document.glyphs.length) {
        return { ...empty(), error: 'Clipboard has no glyphs to paste.' };
    }

    const masterCount = options.font.masters?.length ?? 0;
    if (masterCount < 1) {
        return {
            ...empty(),
            error: 'Font has no masters to receive whole-glyph paste.'
        };
    }

    for (const sourceGlyph of document.glyphs) {
        if (sourceGlyph.layers.length !== masterCount) {
            return {
                ...empty(),
                error: `Glyph /${sourceGlyph.name}: clipboard has ${sourceGlyph.layers.length} layers, font has ${masterCount} masters.`
            };
        }
    }

    const aggregate = empty();

    for (const sourceGlyph of document.glyphs) {
        const newName = options.font.allocateUniqueGlyphName(sourceGlyph.name);
        const targetGlyph = options.font.addGlyph(newName);
        if (sourceGlyph.leftMetricsKey) {
            targetGlyph.leftMetricsKey = sourceGlyph.leftMetricsKey;
        }
        if (sourceGlyph.rightMetricsKey) {
            targetGlyph.rightMetricsKey = sourceGlyph.rightMetricsKey;
        }

        const targetLayers = (targetGlyph.layers || []).filter(
            (layer) => !layer.is_background
        );
        if (targetLayers.length !== sourceGlyph.layers.length) {
            return {
                ...aggregate,
                error: `Glyph /${newName}: created ${targetLayers.length} layers, clipboard has ${sourceGlyph.layers.length}.`
            };
        }

        for (let index = 0; index < sourceGlyph.layers.length; index++) {
            const sourceLayer = sourceGlyph.layers[index];
            const targetLayer = targetLayers[index];
            const fragment: PasteFragment = {
                format: 'counterpunch-json',
                paths: sourceLayer.paths,
                components: sourceLayer.components,
                anchors: sourceLayer.anchors,
                guides: sourceLayer.guides,
                keepAbsoluteCoords: true
            };

            for (const path of fragment.paths) {
                appendPathToLayer(targetLayer, path);
            }
            aggregate.addedPathCount += fragment.paths.length;
            aggregate.fragment.paths.push(...fragment.paths);
            aggregate.fragment.components.push(...fragment.components);
            aggregate.fragment.anchors.push(...fragment.anchors);
            aggregate.fragment.guides.push(...fragment.guides);

            applyNonPathObjectsToLayers(
                fragment,
                [targetLayer],
                targetLayer,
                targetLayer.getMaster?.() ?? null,
                options.glyphExists,
                aggregate,
                { fanOutAnchors: false }
            );

            if (
                typeof sourceLayer.width === 'number' &&
                Number.isFinite(sourceLayer.width)
            ) {
                targetLayer.width = sourceLayer.width;
            }
            if (sourceLayer.leftMetricsKey) {
                targetLayer.leftMetricsKey = sourceLayer.leftMetricsKey;
            }
            if (sourceLayer.rightMetricsKey) {
                targetLayer.rightMetricsKey = sourceLayer.rightMetricsKey;
            }
        }

        aggregate.createdGlyphNames.push(newName);
    }

    return aggregate;
}

function applyNonPathObjectsToLayers(
    working: PasteFragment,
    targetLayers: Layer[],
    activeLayer: Layer,
    master: Master | null,
    glyphExists: (name: string) => boolean,
    result: ApplyPasteResult,
    options: { fanOutAnchors: boolean }
): void {
    for (const component of working.components) {
        if (!glyphExists(component.reference)) {
            if (!result.skippedComponents.includes(component.reference)) {
                result.skippedComponents.push(component.reference);
            }
            continue;
        }
        const transform = component.transform ?? [
            1,
            0,
            0,
            1,
            component.x,
            component.y
        ];
        for (const layer of targetLayers) {
            const added = layer.addComponent(component.reference, [
                ...transform
            ]);
            added.automaticAlignment = component.alignment === 1;
            if (component.anchor) {
                added.anchor = component.anchor;
            }
        }
        result.addedComponentCount += targetLayers.length;
    }

    for (const anchor of working.anchors) {
        const existingOnActive = findAnchorByName(activeLayer, anchor.name);
        if (existingOnActive) {
            existingOnActive.x = anchor.x;
            existingOnActive.y = anchor.y;
            result.updatedAnchorCount += 1;
            continue;
        }

        if (options.fanOutAnchors) {
            let blocked = false;
            for (const layer of targetLayers) {
                if (findAnchorByName(layer, anchor.name)) {
                    blocked = true;
                    break;
                }
            }
            if (blocked) {
                console.warn(
                    `Skipped paste of anchor "${anchor.name}" because it exists on a linked layer.`
                );
                continue;
            }
            for (const layer of targetLayers) {
                layer.addAnchor(anchor.x, anchor.y, anchor.name);
            }
            result.addedAnchorCount += 1;
            continue;
        }

        if (findAnchorByName(activeLayer, anchor.name)) {
            continue;
        }
        activeLayer.addAnchor(anchor.x, anchor.y, anchor.name);
        result.addedAnchorCount += 1;
    }

    for (const guide of working.guides) {
        if (guide.global) {
            if (master) {
                master.addGuide(
                    { x: guide.x, y: guide.y, angle: guide.angle },
                    guide.name
                );
                result.addedGuideCount += 1;
            }
            continue;
        }
        for (const layer of targetLayers) {
            layer.addGuide(
                { x: guide.x, y: guide.y, angle: guide.angle },
                guide.name
            );
        }
        result.addedGuideCount += 1;
    }
}

function cloneFragment(fragment: PasteFragment): PasteFragment {
    return {
        ...fragment,
        paths: fragment.paths.map((path) => ({
            ...path,
            nodes: path.nodes.map((node) => ({ ...node }))
        })),
        components: fragment.components.map((component) => ({
            ...component,
            ...(component.transform
                ? {
                      transform: [
                          ...component.transform
                      ] as typeof component.transform
                  }
                : {})
        })),
        anchors: fragment.anchors.map((anchor) => ({ ...anchor })),
        guides: fragment.guides.map((guide) => ({ ...guide }))
    };
}

function emptyResult(fragment: PasteFragment): ApplyPasteResult {
    return {
        fragment,
        addedPathCount: 0,
        addedComponentCount: 0,
        addedAnchorCount: 0,
        updatedAnchorCount: 0,
        addedGuideCount: 0,
        skippedComponents: []
    };
}

function appendPathToLayer(layer: Layer, path: PastePath): void {
    const added = layer.addPath(path.closed);
    added.nodes = path.nodes.map((node) => ({
        x: node.x,
        y: node.y,
        nodetype: node.nodetype as Babelfont.NodeType,
        ...(node.smooth ? { smooth: true } : {})
    }));
    if (path.closed && !added.closed) {
        added.closed = true;
    }
}

function findAnchorByName(layer: Layer, name: string) {
    const anchors = layer.anchors || [];
    for (const anchor of anchors) {
        if (anchor.name === name) {
            return anchor;
        }
    }
    return null;
}

function centerFragmentInLayer(
    fragment: PasteFragment,
    layerWidth: number,
    verticalMetrics?: Record<string, number> | null
): PasteFragment {
    const bounds = computeFragmentBounds(fragment);
    if (!bounds) {
        return fragment;
    }

    const highest =
        getHighestVisibleVerticalMetricValue(verticalMetrics) ?? bounds.maxY;
    const lowest = getLowestMetricFallback(verticalMetrics, bounds.minY);
    const targetMidX = (Number.isFinite(layerWidth) ? layerWidth : 0) / 2;
    const targetMidY = (highest + lowest) / 2;
    const tx = targetMidX - (bounds.minX + bounds.maxX) / 2;
    const ty = targetMidY - (bounds.minY + bounds.maxY) / 2;

    return translateFragment(fragment, tx, ty);
}

function getLowestMetricFallback(
    verticalMetrics: Record<string, number> | null | undefined,
    fallback: number
): number {
    if (!verticalMetrics) {
        return Math.min(0, fallback);
    }
    const values = Object.entries(verticalMetrics)
        .filter(([key]) => /descender|descent/i.test(key))
        .map(([, value]) => value)
        .filter((value) => Number.isFinite(value));
    if (values.length > 0) {
        return Math.min(...values);
    }
    return Math.min(0, fallback);
}

function placeGuideOrigins(
    fragment: PasteFragment,
    verticalMetrics?: Record<string, number> | null
): PasteFragment {
    const highest = getHighestVisibleVerticalMetricValue(verticalMetrics) ?? 0;
    return {
        ...fragment,
        guides: fragment.guides.map((guide) => placeGuideOrigin(guide, highest))
    };
}

function placeGuideOrigin(
    guide: PasteGuide,
    highestMetricY: number
): PasteGuide {
    const angle = ((guide.angle % 180) + 180) % 180;
    const isHorizontal = Math.abs(angle) < 0.5 || Math.abs(angle - 180) < 0.5;
    const isVertical = Math.abs(angle - 90) < 0.5;
    if (isHorizontal) {
        return { ...guide, x: 0, y: guide.y, angle: 0 };
    }
    if (isVertical) {
        return { ...guide, x: guide.x, y: highestMetricY, angle: 90 };
    }
    return guide;
}

function translateFragment(
    fragment: PasteFragment,
    tx: number,
    ty: number
): PasteFragment {
    return {
        ...fragment,
        paths: fragment.paths.map((path) => ({
            ...path,
            nodes: path.nodes.map((node) => ({
                ...node,
                x: node.x + tx,
                y: node.y + ty
            }))
        })),
        components: fragment.components.map((component) => ({
            ...component,
            x: component.x + tx,
            y: component.y + ty,
            ...(component.transform
                ? {
                      transform: [
                          component.transform[0],
                          component.transform[1],
                          component.transform[2],
                          component.transform[3],
                          component.transform[4] + tx,
                          component.transform[5] + ty
                      ] as [number, number, number, number, number, number]
                  }
                : {})
        })),
        anchors: fragment.anchors.map((anchor) => ({
            ...anchor,
            x: anchor.x + tx,
            y: anchor.y + ty
        })),
        guides: fragment.guides.map((guide) => ({
            ...guide,
            x: guide.x + tx,
            y: guide.y + ty
        }))
    };
}

function computeFragmentBounds(fragment: PasteFragment): {
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

    const consider = (x: number, y: number) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return;
        }
        found = true;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    };

    for (const path of fragment.paths) {
        for (const node of path.nodes) {
            consider(node.x, node.y);
        }
    }
    for (const component of fragment.components) {
        consider(component.x, component.y);
    }
    for (const anchor of fragment.anchors) {
        consider(anchor.x, anchor.y);
    }

    if (!found) {
        return null;
    }
    return { minX, minY, maxX, maxY };
}

export function describePasteResult(result: ApplyPasteResult): string {
    if (result.error) {
        return result.error;
    }
    const createdNames = (result as ApplyPasteGlyphsResult).createdGlyphNames;
    if (createdNames?.length) {
        return `Pasted ${createdNames.length} glyph${
            createdNames.length === 1 ? '' : 's'
        }: ${createdNames.map((name) => `/${name}`).join(', ')}`;
    }
    const parts: string[] = [];
    if (result.fragment.paths.length > 0) {
        parts.push(
            `${result.fragment.paths.length} path${result.fragment.paths.length === 1 ? '' : 's'}`
        );
    }
    if (result.fragment.components.length > 0) {
        const kept =
            result.fragment.components.length - result.skippedComponents.length;
        parts.push(`${kept} component${kept === 1 ? '' : 's'}`);
    }
    if (result.addedAnchorCount > 0 || result.updatedAnchorCount > 0) {
        const count = result.addedAnchorCount + result.updatedAnchorCount;
        parts.push(`${count} anchor${count === 1 ? '' : 's'}`);
    }
    if (result.addedGuideCount > 0) {
        parts.push(
            `${result.addedGuideCount} guide${result.addedGuideCount === 1 ? '' : 's'}`
        );
    }
    const summary = parts.length > 0 ? parts.join(', ') : 'nothing';
    return `Pasted ${summary} from ${result.fragment.format}`;
}
