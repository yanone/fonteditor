// Web Worker for fontc WASM compilation with babelfont-rs
// Direct .babelfont JSON → TTF compilation (no file system)
// Consolidated worker supporting multiple message protocols

import init, {
    compile_babelfont,
    compile_cached_font_from_last_layout_closure,
    store_font,
    init_ydoc_from_state,
    seed_ydoc,
    apply_yjs_update,
    prime_layout_closure_cache,
    interpolate_glyph,
    clear_font_cache,
    open_font_file,
    get_glyphs_outlines,
    run_fontspector,
    version
} from '../wasm-dist/babelfont_fontc_web.js';
import {
    timelineMark,
    timelineSpanEnd,
    timelineSpanStart
} from './perf-timeline';

// Note: This is a Web Worker, cannot import Logger from main thread
// Using standard console.log with facility prefix

let initialized = false;
let cachedBabelfontJson: string | null = null; // Cache babelfont JSON for re-use
let cachedFontRevisionKey: string | null = null;
let cachedBaseSubsetKey: string | null = null;
let cachedClosureGlyphCount: number | null = null;
let fontCacheEpoch = 0;
let lastStoreFontAtMs = 0;
let dragCompilesSinceStore = 0;
const PERF_TRACE_CONTEXT_GLOBAL_KEY = '__cpPerfTraceContext';

type TimelineTraceContext = {
    process?: string;
    traceId?: string;
    parentSpanId?: string;
    requestId?: string;
    fontRevisionKey?: string;
};

function payloadDebugPrefix(payload: string): string {
    const snippet = payload.slice(0, 32).replace(/\n/g, '\\n');
    const byteCodes = Array.from(payload.slice(0, 16), (ch) =>
        ch.charCodeAt(0).toString(16).padStart(2, '0')
    ).join(' ');
    return `len=${payload.length} prefix="${snippet}" codes=${byteCodes}`;
}

type FontspectorCheckLevel = 'fail' | 'warn' | 'info';

type FontspectorCheck = {
    level: FontspectorCheckLevel;
    code: string;
    codes?: string[];
    message: string;
    severity?: string;
    checkId?: string;
    metadata?: unknown[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function normalizeFontspectorLevel(candidate: unknown): FontspectorCheckLevel {
    if (typeof candidate !== 'string') {
        return 'info';
    }

    const normalized = candidate.trim().toLowerCase();
    if (
        normalized === 'fail' ||
        normalized === 'warn' ||
        normalized === 'info'
    ) {
        return normalized;
    }

    if (normalized === 'fatal' || normalized === 'error') {
        return 'fail';
    }

    return 'info';
}

function normalizeFontspectorCodes(candidate: unknown): string[] {
    if (typeof candidate === 'string') {
        const code = candidate.trim();
        return code ? [code] : [];
    }

    if (!Array.isArray(candidate)) {
        return [];
    }

    const uniqueCodes = new Set<string>();
    for (const entry of candidate) {
        if (typeof entry !== 'string') {
            continue;
        }

        const code = entry.trim();
        if (code) {
            uniqueCodes.add(code);
        }
    }

    return Array.from(uniqueCodes);
}

function normalizeFontspectorChecks(rawChecks: unknown): FontspectorCheck[] {
    if (!Array.isArray(rawChecks)) {
        return [];
    }

    const normalized: FontspectorCheck[] = [];

    for (const entry of rawChecks) {
        if (!isRecord(entry)) {
            continue;
        }

        const severity =
            typeof entry.severity === 'string' && entry.severity
                ? entry.severity
                : undefined;

        const rawLevel =
            entry.level !== undefined && entry.level !== null
                ? entry.level
                : severity;

        const level = normalizeFontspectorLevel(rawLevel);
        const codes = normalizeFontspectorCodes(entry.codes);
        const fallbackCodes = codes.length
            ? codes
            : normalizeFontspectorCodes(entry.code);
        const code = fallbackCodes[0] || 'uncoded';
        const message =
            typeof entry.message === 'string' && entry.message
                ? entry.message
                : '';

        const normalizedCheck: FontspectorCheck = {
            level,
            code,
            message
        };

        if (fallbackCodes.length) {
            normalizedCheck.codes = fallbackCodes;
        }

        if (severity) {
            normalizedCheck.severity = severity;
        }

        if (typeof entry.checkId === 'string' && entry.checkId) {
            normalizedCheck.checkId = entry.checkId;
        }

        if (Array.isArray(entry.metadata)) {
            normalizedCheck.metadata = entry.metadata;
        }

        normalized.push(normalizedCheck);
    }

    return normalized;
}

function normalizeFontspectorChecksFromResults(
    rawResults: unknown
): FontspectorCheck[] {
    if (!Array.isArray(rawResults)) {
        return [];
    }

    const normalized: FontspectorCheck[] = [];

    for (const result of rawResults) {
        if (!isRecord(result) || !Array.isArray(result.subresults)) {
            continue;
        }

        const checkId =
            typeof result.check_id === 'string' && result.check_id
                ? result.check_id
                : undefined;

        for (const sub of result.subresults) {
            if (!isRecord(sub)) {
                continue;
            }

            const severity =
                typeof sub.severity === 'string' && sub.severity
                    ? sub.severity
                    : undefined;
            const level = normalizeFontspectorLevel(severity);
            const fallbackCodes = normalizeFontspectorCodes(sub.code);
            const code = fallbackCodes[0] || 'uncoded';
            const message =
                typeof sub.message === 'string' && sub.message
                    ? sub.message
                    : '';

            const normalizedCheck: FontspectorCheck = {
                level,
                code,
                message
            };

            if (fallbackCodes.length) {
                normalizedCheck.codes = fallbackCodes;
            }

            if (severity) {
                normalizedCheck.severity = severity;
            }
            if (checkId) {
                normalizedCheck.checkId = checkId;
            }
            if (Array.isArray(sub.metadata)) {
                normalizedCheck.metadata = sub.metadata;
            }

            normalized.push(normalizedCheck);
        }
    }

    return normalized;
}

function hasStructuredMetadata(check: FontspectorCheck): boolean {
    return Array.isArray(check.metadata) && check.metadata.length > 0;
}

function buildFontspectorChecks(parsed: unknown): FontspectorCheck[] {
    if (!isRecord(parsed)) {
        return [];
    }

    const checksFromChecks = normalizeFontspectorChecks(parsed.checks);
    const checksFromResults = normalizeFontspectorChecksFromResults(
        parsed.results
    );

    if (!checksFromResults.length) {
        return checksFromChecks;
    }

    const hasAnyStructuredInChecks = checksFromChecks.some(
        hasStructuredMetadata
    );
    if (!hasAnyStructuredInChecks) {
        return checksFromResults;
    }

    const metadataByKey = new Map<string, unknown[]>();
    for (const item of checksFromResults) {
        if (!Array.isArray(item.metadata) || !item.metadata.length) {
            continue;
        }
        const key = `${item.level}\u0000${item.code}\u0000${item.message}`;
        metadataByKey.set(key, item.metadata);
    }

    return checksFromChecks.map((item) => {
        if (hasStructuredMetadata(item)) {
            return item;
        }
        const key = `${item.level}\u0000${item.code}\u0000${item.message}`;
        const metadata = metadataByKey.get(key);
        return metadata ? { ...item, metadata } : item;
    });
}

function normalizeTraceContext(
    rawContext: unknown,
    messageType: string,
    requestId: unknown
): TimelineTraceContext {
    const candidate =
        rawContext && typeof rawContext === 'object'
            ? (rawContext as Record<string, unknown>)
            : {};
    const fallbackRequestId =
        requestId === undefined || requestId === null
            ? 'no-id'
            : String(requestId);

    return {
        process:
            typeof candidate.process === 'string'
                ? candidate.process
                : undefined,
        traceId:
            typeof candidate.traceId === 'string' && candidate.traceId.length
                ? candidate.traceId
                : `${messageType}-${fallbackRequestId}`,
        parentSpanId:
            typeof candidate.parentSpanId === 'string'
                ? candidate.parentSpanId
                : undefined,
        requestId:
            typeof candidate.requestId === 'string'
                ? candidate.requestId
                : fallbackRequestId,
        fontRevisionKey:
            typeof candidate.fontRevisionKey === 'string'
                ? candidate.fontRevisionKey
                : undefined
    };
}

function withProcess(
    context: TimelineTraceContext,
    processName: string,
    parentSpanId?: string
): TimelineTraceContext {
    return {
        ...context,
        process: processName,
        parentSpanId: parentSpanId ?? context.parentSpanId
    };
}

function setWasmPerfTraceContext(context: TimelineTraceContext | null): void {
    try {
        if (context) {
            (globalThis as Record<string, unknown>)[
                PERF_TRACE_CONTEXT_GLOBAL_KEY
            ] = context;
            return;
        }
        delete (globalThis as Record<string, unknown>)[
            PERF_TRACE_CONTEXT_GLOBAL_KEY
        ];
    } catch {
        // Best-effort tracing only
    }
}

function parseErrorLineColumn(message: string): {
    line?: number;
    column?: number;
} {
    const match = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
    if (!match) return {};
    return {
        line: parseInt(match[1], 10),
        column: parseInt(match[2], 10)
    };
}

function getJsonSnippetAtLineColumn(
    jsonText: string,
    line: number,
    column: number,
    contextRadius: number = 120
): string {
    if (line < 1 || column < 1) return '';

    let offset = 0;
    let currentLine = 1;
    while (currentLine < line && offset < jsonText.length) {
        const nextNewline = jsonText.indexOf('\n', offset);
        if (nextNewline === -1) {
            return '';
        }
        offset = nextNewline + 1;
        currentLine++;
    }

    const targetOffset = Math.min(offset + column - 1, jsonText.length - 1);
    const start = Math.max(0, targetOffset - contextRadius);
    const end = Math.min(jsonText.length, targetOffset + contextRadius);
    const snippet = jsonText.slice(start, end);
    const pointerPad = Math.max(0, targetOffset - start);
    return `${snippet}\n${' '.repeat(pointerPad)}^`;
}

function inspectInvalidShapes(fontData: any, maxIssues: number = 8): string[] {
    const issues: string[] = [];

    const glyphEntries: Array<{ glyph: any; glyphIndex: number }> = [];
    if (Array.isArray(fontData?.glyphs)) {
        fontData.glyphs.forEach((g: any, i: number) =>
            glyphEntries.push({ glyph: g, glyphIndex: i })
        );
    } else if (fontData?.glyphs && typeof fontData.glyphs === 'object') {
        Object.values(fontData.glyphs).forEach((g: any, i: number) =>
            glyphEntries.push({ glyph: g, glyphIndex: i })
        );
    }

    const isValidShapeForUntaggedEnum = (shape: any): boolean => {
        if (!shape || typeof shape !== 'object') return false;

        const hasPathLike =
            'nodes' in shape &&
            (Array.isArray(shape.nodes) || typeof shape.nodes === 'string');
        const hasComponentLike =
            'reference' in shape && typeof shape.reference === 'string';

        return hasPathLike || hasComponentLike;
    };

    for (const { glyph, glyphIndex } of glyphEntries) {
        if (!glyph || !Array.isArray(glyph.layers)) continue;
        const glyphName = glyph.name || `[glyph-${glyphIndex}]`;

        for (
            let layerIndex = 0;
            layerIndex < glyph.layers.length;
            layerIndex++
        ) {
            const layer = glyph.layers[layerIndex];
            if (!layer || !Array.isArray(layer.shapes)) continue;
            const layerId = layer.id || `[layer-${layerIndex}]`;

            for (
                let shapeIndex = 0;
                shapeIndex < layer.shapes.length;
                shapeIndex++
            ) {
                const shape = layer.shapes[shapeIndex];
                if (isValidShapeForUntaggedEnum(shape)) {
                    continue;
                }

                const keys =
                    shape && typeof shape === 'object'
                        ? Object.keys(shape).join(',')
                        : typeof shape;
                issues.push(
                    `glyph=${glyphName} layer=${layerId} layerIndex=${layerIndex} shapeIndex=${shapeIndex} keys=${keys}`
                );

                if (shape && typeof shape === 'object') {
                    const hint =
                        'Path' in shape || 'Component' in shape
                            ? ' (looks like wrapped shape: Path/Component key present)'
                            : '';
                    issues.push(`  shape=${JSON.stringify(shape)}${hint}`);
                }

                if (issues.length >= maxIssues * 2) {
                    return issues;
                }
            }
        }
    }

    return issues;
}

function normalizeWorkerError(error: unknown): {
    message: string;
    payload?: unknown;
    stack?: string;
} {
    if (error instanceof Error) {
        return {
            message: error.message || error.toString(),
            stack: error.stack
        };
    }

    if (typeof error === 'string') {
        return { message: error };
    }

    if (error && typeof error === 'object') {
        const errObject = error as Record<string, unknown>;
        const objectMessage =
            typeof errObject.message === 'string' ? errObject.message : null;

        return {
            message:
                objectMessage ||
                (() => {
                    try {
                        return JSON.stringify(errObject);
                    } catch {
                        return String(error);
                    }
                })(),
            payload: error
        };
    }

    return {
        message: String(error)
    };
}

function toTransferableBuffer(bytes: Uint8Array): ArrayBuffer {
    if (
        bytes.buffer instanceof ArrayBuffer &&
        bytes.byteOffset === 0 &&
        bytes.byteLength === bytes.buffer.byteLength
    ) {
        return bytes.buffer;
    }
    return bytes.slice().buffer;
}

function postCompiledResult(
    payload: {
        id: number;
        time_taken: number;
        filename?: string;
        fontRevisionKey?: string;
        closureGlyphCount?: number;
        compileSource?: string;
        workerPostedAtMs?: number;
    },
    bytes: Uint8Array
) {
    const transferSpanId = timelineSpanStart(
        'font.worker.compiledResult.transfer',
        { byteLength: bytes.byteLength }
    );
    const prepareSpanId = timelineSpanStart(
        'font.worker.compiledResult.prepareTransferBuffer'
    );
    const resultBuffer = toTransferableBuffer(bytes);
    timelineSpanEnd(prepareSpanId);

    const postMessageSpanId = timelineSpanStart(
        'font.worker.compiledResult.postMessage'
    );
    self.postMessage(
        {
            type: 'compiled',
            ...payload,
            workerPostedAtMs:
                payload.workerPostedAtMs ??
                performance.timeOrigin + performance.now(),
            result: resultBuffer
        },
        [resultBuffer]
    );
    timelineSpanEnd(postMessageSpanId);
    timelineSpanEnd(transferSpanId);
}

/**
 * Strip layerData fields from components in the font JSON,
 * ensure all layers have a shapes array,
 * and filter out AssociatedWithMaster layers that aren't brace layers
 *
 * layerData is a runtime-only field used for rendering nested components
 * and must not be saved to files or passed to fontc compilation.
 *
 * LayerType uses tagged format:
 *   {type: "DefaultForMaster", master: "id"}
 *   {type: "AssociatedWithMaster", master: "id"}
 *   {type: "FreeFloating"}
 *
 * AssociatedWithMaster layers without location data are old backup layers
 * that should not be compiled.
 */

function stripLayerData(fontData: any): any {
    if (!fontData || typeof fontData !== 'object') return fontData;

    // Deep clone to avoid mutating original
    const cleaned = JSON.parse(JSON.stringify(fontData));

    // Temporarily remove guides from masters to avoid serialization issues
    // TODO: Fix guide format conversion
    if (cleaned.masters && Array.isArray(cleaned.masters)) {
        cleaned.masters.forEach((master: any) => {
            if (master.guides) {
                delete master.guides;
            }
        });
    }

    // Process all glyphs (handle both array and object formats)
    if (cleaned.glyphs) {
        const isArray = Array.isArray(cleaned.glyphs);
        const glyphs = isArray ? cleaned.glyphs : Object.values(cleaned.glyphs);

        glyphs.forEach((glyph: any) => {
            if (!glyph || !glyph.layers) return;

            // Shapes are already in correct format from babelfont-rs (serde untagged)
            // No transformation needed

            // Validate dotaccentcomb before filtering
            if (glyph.name === 'dotaccentcomb') {
                glyph.layers.forEach((layer: any, i: number) => {
                    const masterType =
                        layer.master && typeof layer.master === 'object'
                            ? 'type' in layer.master
                                ? layer.master.type
                                : Object.keys(layer.master)[0]
                            : 'none';
                });
            }

            // Filter out AssociatedWithMaster layers without location data
            // (these are old backup layers, not brace layers)
            glyph.layers = glyph.layers.filter((layer: any) => {
                if (!layer || !layer.master) return true;

                const master = layer.master;

                if (master.type === 'DefaultForMaster') return true;
                if (master.type === 'FreeFloating') return true;
                if (master.type === 'AssociatedWithMaster') {
                    // Only keep if it has location data (brace layer)
                    return (
                        layer.location && Object.keys(layer.location).length > 0
                    );
                }

                return false;
            });

            // Validate dotaccentcomb AFTER filtering
            if (glyph.name === 'dotaccentcomb') {
                glyph.layers.forEach((layer: any, i: number) => {
                    const masterType =
                        layer.master && typeof layer.master === 'object'
                            ? 'type' in layer.master
                                ? `{type: ${layer.master.type}}`
                                : Object.keys(layer.master)[0]
                            : 'none';
                });
            }

            // Process remaining layers
            for (const layer of glyph.layers) {
                // Ensure layer has a shapes array (even if empty)
                if (!layer.shapes) {
                    layer.shapes = [];
                }

                // Clean component layerData (runtime-only field)
                if (Array.isArray(layer.shapes)) {
                    for (const shape of layer.shapes) {
                        if (!shape || typeof shape !== 'object') continue;

                        // Components have 'reference' field (unwrapped format from babelfont-rs)
                        if ('reference' in shape) {
                            if ('layerData' in shape) {
                                delete shape.layerData;
                            }

                            // Don't add transform if it doesn't exist
                            // The Rust compiler will handle missing transforms as identity
                            if (shape.transform) {
                                const t = shape.transform;
                                // Only add missing fields if transform exists, preserve order field
                                if (!t.scale) t.scale = [1, 1];
                                if (t.rotation === undefined) t.rotation = 0;
                                if (!t.skew) t.skew = [0, 0];
                                if (!t.translation) t.translation = [0, 0];
                                if (!t.order) t.order = 'RestOfTheWorld';
                            }
                        }
                    }
                }

                // Temporarily remove guides to avoid serialization issues
                // TODO: Fix guide format conversion
                if (layer.guides) {
                    delete layer.guides;
                }
            }
        });
    }

    return cleaned;
}

/**
 * Validate font data and report any issues
 * Also filters out glyphs with empty shapes to prevent compilation errors
 */
function validateFontData(fontData: any): void {
    if (!fontData.glyphs) {
        return;
    }

    const issues: string[] = [];
    const glyphIndicesToRemove: number[] = [];

    // Handle both array and object formats
    const isArray = Array.isArray(fontData.glyphs);
    const glyphs = isArray ? fontData.glyphs : Object.values(fontData.glyphs);

    glyphs.forEach((glyph: any, index: number) => {
        if (!glyph) return; // Skip null/undefined entries

        const glyphName = glyph.name || `index ${index}`;

        if (!glyph.layers || glyph.layers.length === 0) {
            issues.push(`Glyph "${glyphName}" has no layers`);
            if (isArray) glyphIndicesToRemove.push(index);
            return;
        }

        // Check if ALL layers are empty
        let allLayersEmpty = true;
        for (let i = 0; i < glyph.layers.length; i++) {
            const layer = glyph.layers[i];

            if (!layer.shapes) {
                const presentFields = Object.keys(layer).join(', ');
                issues.push(
                    `Glyph "${glyphName}" layer ${i} has no shapes array (has: ${presentFields})`
                );
            } else if (layer.shapes.length === 0) {
                issues.push(
                    `Glyph "${glyphName}" layer ${i} has empty shapes array`
                );
            } else {
                allLayersEmpty = false;
            }
        }

        // If all layers are empty, mark glyph for removal
        if (allLayersEmpty && isArray) {
            glyphIndicesToRemove.push(index);
        }
    });

    if (issues.length > 0) {
        issues.slice(0, 5).forEach((issue) => console.warn(`  - ${issue}`));
        if (issues.length > 5) {
            console.warn(`  ... and ${issues.length - 5} more issues`);
        }
    }

    // Remove glyphs with all empty layers to prevent compilation errors
    if (isArray && glyphIndicesToRemove.length > 0) {
        // Filter out the glyphs by creating a new array without them
        fontData.glyphs = fontData.glyphs.filter(
            (_: any, idx: number) => !glyphIndicesToRemove.includes(idx)
        );
    }
}

async function initializeWasm(traceContext?: TimelineTraceContext) {
    const initSpanId = timelineSpanStart(
        'font.worker.initializeWasm',
        undefined,
        traceContext
    );
    try {
        timelineMark(
            'font.worker.initializeWasm.started',
            withProcess(traceContext || {}, 'worker', initSpanId)
        );
        // Check if SharedArrayBuffer is available
        if (typeof SharedArrayBuffer === 'undefined') {
            throw new Error(
                'SharedArrayBuffer is not available. Make sure the page is served with proper CORS headers:\n' +
                    'Cross-Origin-Embedder-Policy: require-corp\n' +
                    'Cross-Origin-Opener-Policy: same-origin'
            );
        }

        await init();

        // NOTE: initThreadPool causes Memory cloning errors in some browsers (Brave, etc.)
        // Skip it - fontc will run single-threaded but still works
        // await initThreadPool(1);

        initialized = true;
        const ver = version();
        timelineMark(
            'font.worker.initializeWasm.ready',
            withProcess(traceContext || {}, 'worker', initSpanId)
        );

        return ver;
    } catch (error: any) {
        timelineMark(
            'font.worker.initializeWasm.failed',
            withProcess(traceContext || {}, 'worker', initSpanId)
        );
        console.error('[Fontc Worker] Initialization error:', error);
        throw error;
    } finally {
        timelineSpanEnd(initSpanId);
    }
}

// Handle compilation requests - supports both message protocols
self.onmessage = async (event) => {
    const data = event.data;
    const messageType = data?.type || 'legacy';
    const rawTraceContext = normalizeTraceContext(
        data?.traceContext,
        messageType,
        data?.id
    );
    const messageTraceContext = withProcess(rawTraceContext, 'worker');
    const messageSpanId = timelineSpanStart(
        `font.worker.message.${messageType}`,
        undefined,
        messageTraceContext
    );
    setWasmPerfTraceContext(
        withProcess(messageTraceContext, 'worker', messageSpanId)
    );
    timelineMark(`font.worker.message.${messageType}.received`, {
        ...messageTraceContext,
        process: 'worker',
        parentSpanId: messageSpanId
    });

    try {
        // Protocol 1: Type-based messages
        if (data.type === 'init') {
            try {
                const ver: string = await initializeWasm(
                    withProcess(messageTraceContext, 'worker', messageSpanId)
                );
                timelineMark('font.worker.init.success', {
                    ...messageTraceContext,
                    process: 'worker',
                    parentSpanId: messageSpanId
                });
                self.postMessage({ type: 'ready', version: ver });
            } catch (error: unknown) {
                timelineMark('font.worker.init.failed', {
                    ...messageTraceContext,
                    process: 'worker',
                    parentSpanId: messageSpanId
                });
                const normalizedError = normalizeWorkerError(error);
                self.postMessage({
                    type: 'error',
                    error: normalizedError.message,
                    errorPayload: normalizedError.payload,
                    stack: normalizedError.stack
                });
            }
            return;
        }

        if (data.type === 'compile') {
            const compileSpanId = timelineSpanStart(
                'font.worker.compile',
                undefined,
                withProcess(messageTraceContext, 'worker', messageSpanId)
            );
            self.postMessage({
                type: 'debug',
                message: `[Worker] Entered type=compile handler, initialized=${initialized}`
            });

            if (!initialized) {
                self.postMessage({
                    type: 'error',
                    id: data.id,
                    error: 'Worker not initialized'
                });
                return;
            }

            let cleanedJson = '';
            try {
                timelineMark(
                    'font.worker.compile.started',
                    withProcess(messageTraceContext, 'worker', compileSpanId)
                );
                const startTime = performance.now();

                // Clean font data before compilation
                const parseJsonSpanId = timelineSpanStart(
                    'font.worker.compile.parseInputJson'
                );
                const fontData = JSON.parse(data.babelfontJson);
                timelineSpanEnd(parseJsonSpanId);

                const stringifyJsonSpanId = timelineSpanStart(
                    'font.worker.compile.stringifyInputJson'
                );
                cleanedJson = JSON.stringify(fontData);
                timelineSpanEnd(stringifyJsonSpanId);

                // Send debug info to main thread
                self.postMessage({
                    type: 'debug',
                    message: `Before compile: ${fontData.glyphs.length} glyphs, JSON ${cleanedJson.length} bytes, options: ${JSON.stringify(data.options)}`
                });

                const wasmCompileBridgeSpanId = timelineSpanStart(
                    'font.worker.compile.invokeWasm'
                );
                const ttfBytes = compile_babelfont(
                    cleanedJson,
                    data.options || {}
                );
                timelineSpanEnd(wasmCompileBridgeSpanId);
                const endTime = performance.now();

                self.postMessage({
                    type: 'debug',
                    message: `After compile: ttfBytes type=${typeof ttfBytes}, length=${ttfBytes?.length || 0}, constructor=${ttfBytes?.constructor?.name || 'unknown'}`
                });

                console.log(
                    `[Fontc Worker] Compiled in ${(endTime - startTime).toFixed(0)}ms`
                );

                postCompiledResult(
                    {
                        id: data.id,
                        time_taken: endTime - startTime
                    },
                    ttfBytes
                );
                timelineMark(
                    'font.worker.compile.success',
                    withProcess(messageTraceContext, 'worker', compileSpanId)
                );
            } catch (error: unknown) {
                timelineMark(
                    'font.worker.compile.failed',
                    withProcess(messageTraceContext, 'worker', compileSpanId)
                );
                console.error('[Fontc Worker] Error:', error);
                const normalizedError = normalizeWorkerError(error);
                const errorText = normalizedError.message;
                const { line, column } = parseErrorLineColumn(errorText);
                if (line && column) {
                    try {
                        const snippet = getJsonSnippetAtLineColumn(
                            cleanedJson || data.babelfontJson || '',
                            line,
                            column
                        );
                        if (snippet) {
                            self.postMessage({
                                type: 'debug',
                                message: `[Worker] JSON parse context (line ${line}, col ${column}):\n${snippet}`
                            });
                        }
                    } catch (_snippetError) {
                        // Best-effort diagnostics only
                    }
                }

                try {
                    const parsed = JSON.parse(data.babelfontJson || '{}');
                    const shapeIssues = inspectInvalidShapes(parsed);
                    if (shapeIssues.length > 0) {
                        self.postMessage({
                            type: 'debug',
                            message: `[Worker] Potential invalid shapes for untagged enum Shape:\n${shapeIssues.join('\n')}`
                        });
                    }
                } catch (_inspectError) {
                    // Best-effort diagnostics only
                }

                self.postMessage({
                    type: 'error',
                    id: data.id,
                    error: normalizedError.message,
                    errorPayload: normalizedError.payload,
                    stack: normalizedError.stack
                });
            } finally {
                timelineSpanEnd(compileSpanId);
            }
            return;
        }

        if (data.type === 'compileEditingCached') {
            const compileEditingSpanId = timelineSpanStart(
                'font.worker.compileEditingCached',
                undefined,
                withProcess(messageTraceContext, 'worker', messageSpanId)
            );

            if (!initialized) {
                self.postMessage({
                    type: 'error',
                    id: data.id,
                    error: 'Worker not initialized'
                });
                return;
            }

            try {
                timelineMark(
                    'font.worker.compileEditingCached.started',
                    withProcess(
                        messageTraceContext,
                        'worker',
                        compileEditingSpanId
                    )
                );
                const startTime = performance.now();
                const {
                    id,
                    babelfontJson,
                    options,
                    subsetGlyphs,
                    subsetKey,
                    fontRevisionKey,
                    _dragActive,
                    _compileSource,
                    _forceStoreFontJson
                } = data;

                const isIncrementalSentinel =
                    babelfontJson === '__incremental_layer__';
                if (
                    !isIncrementalSentinel &&
                    (!babelfontJson || typeof babelfontJson !== 'string')
                ) {
                    throw new Error('Missing babelfontJson');
                }

                const revisionKey = String(fontRevisionKey ?? 'unknown');
                const incomingSubsetKey =
                    typeof subsetKey === 'string' ? subsetKey : '';
                const effectiveSubsetKey = `${fontCacheEpoch}:${incomingSubsetKey}`;
                const baseSubsetGlyphs = Array.isArray(subsetGlyphs)
                    ? subsetGlyphs
                    : null;

                const ensureFontCachedSpanId = timelineSpanStart(
                    'font.worker.compileEditingCached.ensureFontCached'
                );
                // Font cache is primed by storeFontJson (bootstrap) and
                // kept current by Yjs document updates during editing.
                if (!isIncrementalSentinel) {
                    if (cachedBabelfontJson !== babelfontJson) {
                        store_font(babelfontJson);
                        cachedBabelfontJson = babelfontJson;
                        fontCacheEpoch += 1;
                    }
                }
                timelineSpanEnd(ensureFontCachedSpanId);

                const primeClosureSpanId = timelineSpanStart(
                    'font.worker.compileEditingCached.primeLayoutClosure'
                );
                const needsPrimeClosure =
                    cachedBaseSubsetKey !== effectiveSubsetKey;
                const isOutlineIncrementalCompile =
                    String(_compileSource || '').startsWith('mouse-drag') ||
                    String(_compileSource || '').startsWith('keyboard');

                if (needsPrimeClosure && isOutlineIncrementalCompile) {
                    timelineMark(
                        'font.worker.compileEditingCached.primeLayoutClosure.outlineSubsetChanged'
                    );
                    console.warn(
                        '[FontWorker] Subset key changed during outline incremental compile',
                        {
                            _compileSource,
                            previousSubsetKey: cachedBaseSubsetKey,
                            incomingSubsetKey: effectiveSubsetKey,
                            hasSubsetGlyphs: !!baseSubsetGlyphs?.length
                        }
                    );
                }

                if (needsPrimeClosure) {
                    if (!baseSubsetGlyphs) {
                        throw new Error(
                            'Missing subsetGlyphs for changed subsetKey.'
                        );
                    }

                    cachedClosureGlyphCount = prime_layout_closure_cache(
                        effectiveSubsetKey,
                        JSON.stringify(baseSubsetGlyphs)
                    );
                    cachedBaseSubsetKey = effectiveSubsetKey;
                    timelineMark(
                        'font.worker.compileEditingCached.primeLayoutClosure.primed'
                    );
                    // Phase A1+A2+A3 benchmark point: layout closure (FEA parse,
                    // glyph-class expansion, multi-round loop) just ran inside WASM.
                    // Phase A5 benchmark point: component-deps expansion also ran.
                    timelineMark(
                        'font.worker.compileEditingCached.primeLayoutClosure.phaseA.computed',
                        { parentSpanId: primeClosureSpanId }
                    );
                } else {
                    timelineMark(
                        'font.worker.compileEditingCached.primeLayoutClosure.reused'
                    );
                    // Phase A1+A2+A3+A5 were served from cache — useful for
                    // verifying caching effectiveness before/after optimizations.
                    timelineMark(
                        'font.worker.compileEditingCached.primeLayoutClosure.phaseA.cache_hit',
                        { parentSpanId: primeClosureSpanId }
                    );
                }
                timelineSpanEnd(primeClosureSpanId);

                const compileCachedSpanId = timelineSpanStart(
                    'font.worker.compileEditingCached.compileCachedFont'
                );
                const compiledBytes =
                    compile_cached_font_from_last_layout_closure(options || {});
                timelineMark(
                    'font.worker.compileEditingCached.compileCachedFont.resultReady',
                    {
                        parentSpanId: compileCachedSpanId
                    }
                );
                // Phase A4 benchmark point: filter-pipeline FEA parses (SubsetLayout +
                // GlyphsNumberValue) ran on a cache miss inside WASM.
                timelineMark(
                    'font.worker.compileEditingCached.compileCachedFont.phaseA.compile_done',
                    { parentSpanId: compileCachedSpanId }
                );
                timelineSpanEnd(compileCachedSpanId);
                const endTime = performance.now();

                postCompiledResult(
                    {
                        id,
                        time_taken: endTime - startTime,
                        fontRevisionKey: revisionKey,
                        closureGlyphCount: cachedClosureGlyphCount || 0,
                        compileSource: _compileSource
                    },
                    compiledBytes
                );
                timelineMark(
                    'font.worker.compileEditingCached.success',
                    withProcess(
                        messageTraceContext,
                        'worker',
                        compileEditingSpanId
                    )
                );
            } catch (error: unknown) {
                timelineMark(
                    'font.worker.compileEditingCached.failed',
                    withProcess(
                        messageTraceContext,
                        'worker',
                        compileEditingSpanId
                    )
                );
                const normalizedError = normalizeWorkerError(error);
                self.postMessage({
                    type: 'error',
                    id: data.id,
                    error: normalizedError.message,
                    errorPayload: normalizedError.payload,
                    stack: normalizedError.stack
                });
            } finally {
                timelineSpanEnd(compileEditingSpanId);
            }
            return;
        }

        if (data.type === 'runFontspector') {
            const fontspectorSpanId = timelineSpanStart(
                'font.worker.runFontspector'
            );
            const { id, fontBytes, profile } = data;

            if (!initialized) {
                self.postMessage({
                    type: 'error',
                    id,
                    error: 'Worker not initialized'
                });
                return;
            }

            try {
                timelineMark('font.worker.runFontspector.started');
                const bytes =
                    fontBytes instanceof Uint8Array
                        ? fontBytes
                        : new Uint8Array(fontBytes);
                const resultJson = run_fontspector(
                    bytes,
                    profile || 'opentype'
                );
                const parsed = JSON.parse(resultJson);
                const checks = buildFontspectorChecks(parsed);

                console.log(
                    '[FontcWorker]',
                    'Fontspector parsed payload:',
                    parsed
                );
                console.log(
                    '[FontcWorker]',
                    'Fontspector normalized checks:',
                    checks
                );

                self.postMessage({
                    id,
                    type: 'runFontspector',
                    summary: parsed.summary || null,
                    checks,
                    profile: parsed.profile || profile || 'opentype',
                    availableProfiles: parsed.availableProfiles || []
                });
                timelineMark('font.worker.runFontspector.success');
            } catch (e: any) {
                timelineMark('font.worker.runFontspector.failed');
                self.postMessage({
                    id,
                    type: 'runFontspector',
                    error: e?.toString?.() || 'Fontspector failed'
                });
            } finally {
                timelineSpanEnd(fontspectorSpanId);
            }

            return;
        }

        // Handle store font JSON request (before auto-init to ensure it's cached early)
        if (data.type === 'storeFontJson') {
            const storeSpanId = timelineSpanStart('font.worker.storeFontJson');
            const { id, babelfontJson } = data;

            if (!babelfontJson) {
                self.postMessage({
                    id,
                    type: 'storeFontJson',
                    error: 'Missing babelfontJson'
                });
                return;
            }

            try {
                timelineMark('font.worker.storeFontJson.started');
                // Ensure WASM is initialized before calling store_font
                if (!initialized) {
                    await initializeWasm();
                }

                if (cachedBabelfontJson === babelfontJson) {
                    self.postMessage({
                        id,
                        type: 'storeFontJson',
                        success: true,
                        skipped: 'cached',
                        cachedSize: cachedBabelfontJson?.length || 0,
                        message: `Font already cached: ${cachedBabelfontJson?.length || 0} bytes`
                    });
                    timelineMark('font.worker.storeFontJson.skippedCached');
                    return;
                }

                // Store in cache (both in WASM and in worker)
                store_font(babelfontJson);
                cachedBabelfontJson = babelfontJson;
                cachedBaseSubsetKey = null;
                cachedClosureGlyphCount = null;

                self.postMessage({
                    id,
                    type: 'storeFontJson',
                    success: true,
                    cachedSize: cachedBabelfontJson?.length || 0,
                    message: `Font cached: ${cachedBabelfontJson?.length || 0} bytes`
                });
                timelineMark('font.worker.storeFontJson.success');
            } catch (e: any) {
                timelineMark('font.worker.storeFontJson.failed');
                console.error(`[Fontc Worker] Error storing font JSON:`, e);
                const errorText = e?.message || e?.toString?.() || '';
                const { line, column } = parseErrorLineColumn(errorText);

                if (line && column) {
                    try {
                        const snippet = getJsonSnippetAtLineColumn(
                            babelfontJson,
                            line,
                            column
                        );
                        if (snippet) {
                            self.postMessage({
                                type: 'debug',
                                message: `[Worker] storeFontJson parse context (line ${line}, col ${column}):\n${snippet}`
                            });
                        }
                    } catch (_snippetError) {
                        // Best-effort diagnostics only
                    }
                }

                try {
                    const parsed = JSON.parse(babelfontJson);
                    const shapeIssues = inspectInvalidShapes(parsed);
                    if (shapeIssues.length > 0) {
                        self.postMessage({
                            type: 'debug',
                            message: `[Worker] storeFontJson potential invalid shapes:\n${shapeIssues.join('\n')}`
                        });
                    }
                } catch (_inspectError) {
                    // Best-effort diagnostics only
                }

                self.postMessage({
                    id,
                    type: 'storeFontJson',
                    error: e.toString()
                });
            } finally {
                timelineSpanEnd(storeSpanId);
            }
            return;
        }

        // ── Yjs-based cache initialisation ──────────────────────────────────
        // seedYdoc: initialise the Rust Y.Doc from a full binary Yjs state
        // without rebuilding all caches (called immediately after openFont).
        if (data.type === 'seedYdoc') {
            const { id, state } = data;
            try {
                if (!initialized) {
                    await initializeWasm();
                }
                seed_ydoc(
                    state instanceof Uint8Array ? state : new Uint8Array(state)
                );
                self.postMessage({ id, type: 'seedYdoc', success: true });
            } catch (e: any) {
                console.error('[Fontc Worker] seedYdoc error:', e);
                self.postMessage({
                    id,
                    type: 'seedYdoc',
                    success: false,
                    error: e.toString()
                });
            }
            return;
        }

        // initYdoc: reinitialise the Rust Y.Doc from a full binary Yjs state
        // AND rebuild all caches (used after undo/redo/remote full-state sync
        // instead of the heavy storeFontJson path).
        if (data.type === 'initYdoc') {
            const spanId = timelineSpanStart('font.worker.initYdoc');
            const { id, state } = data;
            try {
                timelineMark('font.worker.initYdoc.started');
                if (!initialized) {
                    await initializeWasm();
                }
                init_ydoc_from_state(
                    state instanceof Uint8Array ? state : new Uint8Array(state)
                );
                cachedBabelfontJson = null; // CANONICAL_JSON_CACHE rebuilt from Y.Doc
                cachedBaseSubsetKey = null;
                cachedClosureGlyphCount = null;
                fontCacheEpoch += 1;
                self.postMessage({ id, type: 'initYdoc', success: true });
                timelineMark('font.worker.initYdoc.success');
            } catch (e: any) {
                timelineMark('font.worker.initYdoc.failed');
                console.error('[Fontc Worker] initYdoc error:', e);
                self.postMessage({
                    id,
                    type: 'initYdoc',
                    success: false,
                    error: e.toString()
                });
            } finally {
                timelineSpanEnd(spanId);
            }
            return;
        }

        // applyYjsUpdate: apply an incremental binary Yjs update to the Rust Y.Doc
        // and update CANONICAL_JSON_CACHE (partial or full rebuild depending on
        // whether changedGlyphs were supplied).
        if (data.type === 'applyYjsUpdate') {
            const { id, update, changedGlyphs, invalidateLayoutClosure } = data;
            try {
                if (!initialized) {
                    await initializeWasm();
                }
                const changedGlyphsJson = JSON.stringify(
                    Array.isArray(changedGlyphs) ? changedGlyphs : []
                );
                const resultJson = apply_yjs_update(
                    update instanceof Uint8Array
                        ? update
                        : new Uint8Array(update),
                    changedGlyphsJson
                );
                cachedBabelfontJson = null;
                if (invalidateLayoutClosure !== false) {
                    cachedBaseSubsetKey = null;
                    cachedClosureGlyphCount = null;
                    fontCacheEpoch += 1;
                }
                self.postMessage({
                    id,
                    type: 'applyYjsUpdate',
                    success: true,
                    result: resultJson
                });
            } catch (e: any) {
                console.error('[Fontc Worker] applyYjsUpdate error:', e);
                self.postMessage({
                    id,
                    type: 'applyYjsUpdate',
                    success: false,
                    error: e.toString()
                });
            }
            return;
        }

        // Protocol 2: Direct messages (from font-compilation.js)
        // Auto-initialize if not already done
        if (!initialized) {
            try {
                await initializeWasm();
                self.postMessage({ ready: true });
            } catch (error: any) {
                self.postMessage({
                    error: `Failed to initialize babelfont-fontc WASM: ${error.message}`
                });
            }
            return; // Don't process as compilation request
        }

        // Handle interpolation request (check BEFORE compilation)
        if (data.type === 'interpolate') {
            const interpolateSpanId = timelineSpanStart(
                'font.worker.interpolate'
            );
            const { id, glyphName, location, extrapolate } = data;

            try {
                timelineMark('font.worker.interpolate.started');
                const locationJson = JSON.stringify(location);
                const layerJson = interpolate_glyph(
                    glyphName,
                    locationJson,
                    extrapolate === true
                );

                self.postMessage({
                    id,
                    type: 'interpolate',
                    result: layerJson,
                    glyphName
                });
                timelineMark('font.worker.interpolate.success');
            } catch (e: any) {
                timelineMark('font.worker.interpolate.failed');
                console.error('[Fontc Worker] Interpolation error:', e);
                self.postMessage({
                    id,
                    type: 'interpolate',
                    error: e.toString(),
                    glyphName
                });
            } finally {
                timelineSpanEnd(interpolateSpanId);
            }
            return;
        }

        // Handle cache clear request (check BEFORE compilation)
        if (data.type === 'clearCache') {
            const clearCacheSpanId = timelineSpanStart(
                'font.worker.clearCache'
            );
            try {
                timelineMark('font.worker.clearCache.started');
                clear_font_cache();
                cachedBabelfontJson = null;
                cachedFontRevisionKey = null;
                cachedBaseSubsetKey = null;
                cachedClosureGlyphCount = null;
                fontCacheEpoch = 0;
                dragCompilesSinceStore = 0;
                self.postMessage({
                    type: 'clearCache',
                    success: true
                });
                timelineMark('font.worker.clearCache.success');
            } catch (e: any) {
                timelineMark('font.worker.clearCache.failed');
                console.error('[Fontc Worker] Error clearing cache:', e);
                self.postMessage({
                    type: 'clearCache',
                    error: e.toString()
                });
            } finally {
                timelineSpanEnd(clearCacheSpanId);
            }
            return;
        }

        // Handle open font file request
        if (data.type === 'openFont') {
            const openFontSpanId = timelineSpanStart('font.worker.openFont');
            const { id, filename, contents, packageEntries, projectEntries } =
                data;
            const entryMap = packageEntries || projectEntries;
            let payloadForDebug: string | null = null;

            if (!filename || (!contents && !entryMap)) {
                self.postMessage({
                    id,
                    type: 'openFont',
                    error: 'Missing filename or input contents'
                });
                return;
            }

            try {
                timelineMark('font.worker.openFont.started');
                let payload: string;

                if (entryMap && typeof entryMap === 'object') {
                    const utf8Decoder = new TextDecoder('utf-8');
                    const stringEntries: Record<string, string> = {};

                    for (const [relativePath, fileContents] of Object.entries(
                        entryMap
                    )) {
                        if (fileContents instanceof Uint8Array) {
                            stringEntries[relativePath] =
                                utf8Decoder.decode(fileContents);
                        } else if (typeof fileContents === 'string') {
                            stringEntries[relativePath] = fileContents;
                        } else {
                            throw new Error(
                                `Invalid project entry type at ${relativePath}`
                            );
                        }
                        clear_font_cache();
                    }

                    fontCacheEpoch += 1;
                    payload = JSON.stringify(stringEntries);
                } else {
                    // Convert Uint8Array to string for WASM
                    // Both OPFS and disk now return Uint8Array consistently
                    // Use Latin-1 encoding (1:1 byte mapping) to preserve exact bytes
                    // Rust will detect format and decode properly (handles both UTF-8 text and binary plist)
                    if (typeof contents === 'string') {
                        payload = contents;
                    } else if (contents instanceof Uint8Array) {
                        payload = Array.from(contents, (byte) =>
                            String.fromCharCode(byte)
                        ).join('');
                    } else {
                        console.error(
                            `[Fontc Worker] Expected Uint8Array|string, got:`,
                            typeof contents
                        );
                        throw new Error(
                            `Expected Uint8Array|string, got ${typeof contents}`
                        );
                    }
                }

                payloadForDebug = payload;

                const babelfontJson = open_font_file(filename, payload);

                // Store in cache (both in WASM and in worker)
                store_font(babelfontJson);
                cachedBabelfontJson = babelfontJson;

                self.postMessage({
                    id,
                    type: 'openFont',
                    babelfontJson,
                    filename
                });
                timelineMark('font.worker.openFont.success');
            } catch (e: any) {
                timelineMark('font.worker.openFont.failed');
                console.error(`[Fontc Worker] Error opening font:`, e, {
                    filename,
                    hasContents: contents !== undefined,
                    hasEntryMap: !!entryMap,
                    payloadDebug: payloadForDebug
                        ? payloadDebugPrefix(payloadForDebug)
                        : 'payload-unavailable'
                });
                self.postMessage({
                    id,
                    type: 'openFont',
                    error: e.toString()
                });
            } finally {
                timelineSpanEnd(openFontSpanId);
            }
            return;
        }

        // Handle get glyph outlines request
        if (data.type === 'getGlyphOutlines') {
            const outlinesSpanId = timelineSpanStart(
                'font.worker.getGlyphOutlines'
            );
            const { id, glyphNames, location, flattenComponents } = data;

            try {
                timelineMark('font.worker.getGlyphOutlines.started');
                // Ensure font is cached before getting outlines
                if (!cachedBabelfontJson) {
                    const errorMsg =
                        'No font loaded in worker. Open a font first.';
                    console.error(`[Fontc Worker] ERROR: ${errorMsg}`);
                    self.postMessage({
                        id,
                        type: 'getGlyphOutlines',
                        error: errorMsg,
                        debugInfo: {
                            cacheState: 'null',
                            initialized: initialized,
                            timestamp: Date.now()
                        }
                    });
                    return;
                }

                // Note: Don't call store_font here - it clears the outline cache!
                // The font is already stored when opened.

                const locationJson =
                    Object.keys(location).length > 0
                        ? JSON.stringify(location)
                        : '{}';
                const glyphNamesJson = JSON.stringify(glyphNames);
                const outlinesJson = get_glyphs_outlines(
                    glyphNamesJson,
                    locationJson,
                    flattenComponents
                );

                self.postMessage({
                    id,
                    type: 'getGlyphOutlines',
                    outlinesJson
                });
                timelineMark('font.worker.getGlyphOutlines.success');
            } catch (e: any) {
                timelineMark('font.worker.getGlyphOutlines.failed');
                console.error(
                    `[Fontc Worker] Error getting glyph outlines:`,
                    e
                );
                self.postMessage({
                    id,
                    type: 'getGlyphOutlines',
                    error: e.toString()
                });
            } finally {
                timelineSpanEnd(outlinesSpanId);
            }
            return;
        }

        // Handle compilation request (LEGACY PATH - fallback for messages without explicit type)
        if (
            data.type !== 'compile' &&
            data.type !== 'interpolate' &&
            data.type !== 'clearCache' &&
            !data.type &&
            data.babelfontJson
        ) {
            const legacyCompileSpanId = timelineSpanStart(
                'font.worker.legacyCompile'
            );
            const start = Date.now();
            const { id, babelfontJson, filename, options } = data;

            // Validate babelfontJson exists
            if (!babelfontJson) {
                console.error(
                    '[Fontc Worker] No babelfontJson provided in compilation request, data.type:',
                    data.type
                );
                self.postMessage({
                    id,
                    error: 'No babelfontJson provided in compilation request'
                });
                return;
            }

            try {
                timelineMark('font.worker.legacyCompile.started');
                // STEP 1: Store font in WASM cache for interpolation
                try {
                    store_font(babelfontJson);
                    cachedBabelfontJson = babelfontJson; // Also cache in worker memory
                } catch (cacheError) {
                    console.warn(
                        '[Fontc Worker] ⚠️ Failed to cache font:',
                        cacheError
                    );
                    // Continue with compilation anyway
                }

                // STEP 2: Clean font data (remove runtime-only layerData fields)
                const fontData = JSON.parse(babelfontJson);
                const cleanedFontData = stripLayerData(fontData);

                // Validate font data before compilation
                validateFontData(cleanedFontData);

                const cleanedJson = JSON.stringify(cleanedFontData);

                // STEP 3: Compile to TTF
                const result = compile_babelfont(cleanedJson, {
                    drop_incompatible_paths: true // Tolerate incompatible masters
                });

                const time_taken = Date.now() - start;
                console.log(
                    `[Fontc Worker] Compiled ${filename} in ${time_taken}ms`
                );

                postCompiledResult(
                    {
                        id,
                        time_taken,
                        filename: filename.replace(/\.babelfont$/, '.ttf')
                    },
                    result
                );
                timelineMark('font.worker.legacyCompile.success');
            } catch (e: any) {
                timelineMark('font.worker.legacyCompile.failed');
                console.error('[Fontc Worker] Compilation error:', e);
                const errorMessage = e.toString();

                self.postMessage({
                    id,
                    error: errorMessage,
                    userMessage: `Font compilation failed: ${errorMessage}`
                });
            } finally {
                timelineSpanEnd(legacyCompileSpanId);
            }
            return;
        }

        console.error('[Fontc Worker] Unknown message type:', data);
    } finally {
        timelineSpanEnd(messageSpanId);
    }
};
