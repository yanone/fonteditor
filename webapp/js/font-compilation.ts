// Copyright (C) 2025 Yanone
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

// Font Compilation Integration
// Direct .babelfont JSON → TTF compilation (zero file system)
// Based on: DIRECT_PYTHON_RUST_INTEGRATION.md

import { get_glyph_name } from '../wasm-dist/babelfont_fontc_web';
import { fontInterpolation } from './font-interpolation';
import { Logger } from './logger';
import {
    timelineMark,
    timelineSpanEnd,
    timelineSpanStart
} from './perf-timeline';

const console = new Logger('FontCompilation');

interface CompilationOptions {
    skip_kerning: boolean;
    skip_features: boolean;
    skip_metrics: boolean;
    skip_outlines: boolean;
    dont_use_production_names: boolean;
    subset_glyphs?: Array<string>;
    drop_incompatible_paths?: boolean;
    produce_varc_table?: boolean;
}

type IncrementalLayerUpdate = {
    glyphName: string;
    layerId: string;
    layerData: unknown;
};

type TimelineTraceContext = {
    process?: string;
    traceId?: string;
    parentSpanId?: string;
    requestId?: string;
    fontRevisionKey?: string;
};

// Compilation target definitions
// All targets use production glyph names by default
const COMPILATION_TARGETS: Record<string, CompilationOptions> = {
    // Default target for user-initiated compilations (Compile button)
    user: {
        skip_kerning: false,
        skip_features: false,
        skip_metrics: false,
        skip_outlines: false,
        dont_use_production_names: false
    },

    // // Only compile outlines (glyf/gvar tables), skip everything else
    // glyph_overview: {
    //     skip_kerning: true,
    //     skip_features: true,
    //     skip_metrics: false,
    //     skip_outlines: false,
    //     dont_use_production_names: true
    // },

    // Subset font for canvas display with layout closure.
    // GSUB features included (via layout closure), GPOS retained for mark positioning.
    editing: {
        skip_kerning: false,
        skip_features: false,
        skip_metrics: false,
        skip_outlines: false,
        dont_use_production_names: true,
        drop_incompatible_paths: true,
        produce_varc_table: true
    },

    // Subset font for canvas display with layout closure.
    // GSUB features included (via layout closure), GPOS retained for mark positioning.
    full: {
        skip_kerning: false,
        skip_features: false,
        skip_metrics: false,
        skip_outlines: false,
        dont_use_production_names: true,
        drop_incompatible_paths: true,
        produce_varc_table: true
    }
};

/**
 * Shape text with a compiled font buffer and return glyph names
 * This is a lower-level function that works with font bytes directly
 *
 * @param {Uint8Array} fontBytes - Compiled TTF font bytes
 * @param {string} inputString - Text to shape
 * @returns {Promise<Array<string>>} - Array of glyph names
 */
async function shapeTextWithFont(
    fontBytes: Uint8Array,
    inputString: string
): Promise<Array<string>> {
    // Initialize HarfBuzz
    let hbModule;
    if (typeof window.createHarfBuzz !== 'undefined') {
        // Browser environment - use createHarfBuzz
        hbModule = await window.createHarfBuzz();
    } else if (typeof window.hbInit !== 'undefined') {
        // Node.js environment - use hbInit Promise
        hbModule = await window.hbInit;
    } else {
        throw new Error(
            'HarfBuzz not available. Make sure harfbuzzjs is loaded.'
        );
    }

    // Create HarfBuzz blob and font
    const blob = hbModule.createBlob(fontBytes);
    const face = hbModule.createFace(blob, 0);
    const hbFont = hbModule.createFont(face);

    // Create buffer and shape text
    const buffer = hbModule.createBuffer();
    buffer.addText(inputString);
    buffer.guessSegmentProperties();

    // Shape the text
    hbModule.shape(hbFont, buffer);

    // Get shaped glyphs (contains glyph IDs)
    const shapedGlyphs = buffer.json();

    // Map glyph IDs to glyph names using WASM get_glyph_name
    const glyphNames: Set<string> = new Set();
    for (const shapedGlyph of shapedGlyphs) {
        const glyphId = shapedGlyph.g;
        try {
            const glyphName = get_glyph_name(fontBytes, glyphId);
            if (glyphName && glyphName !== '.notdef') {
                glyphNames.add(glyphName);
            }
        } catch (e) {
            console.warn(
                `[FontCompilation] Failed to get name for glyph ${glyphId}:`,
                e
            );
        }
    }

    // Clean up HarfBuzz resources
    buffer.destroy();
    hbFont.destroy();
    face.destroy();
    blob.destroy();

    return Array.from(glyphNames);
}

class FontCompilation {
    worker: Worker | null;
    isInitialized: boolean;
    initializationPromise: Promise<boolean> | null;
    connectInterpolation: boolean;
    pendingCompilations: Map<
        number,
        {
            resolve: (value: any) => void;
            reject: (reason?: any) => void;
            filename: string;
            spanId?: string;
            traceContext?: TimelineTraceContext;
        }
    >;
    compilationId: number;
    lastStoredFontJson: string | null;
    pendingStoreFontJsonPromise: Promise<any> | null;
    pendingStoreFontJsonPayload: string | null;
    lastEditingSubsetKey: string | null;

    constructor(options?: { connectInterpolation?: boolean }) {
        this.worker = null;
        this.isInitialized = false;
        this.initializationPromise = null;
        this.connectInterpolation = options?.connectInterpolation ?? true;
        this.pendingCompilations = new Map();
        this.compilationId = 0;
        this.lastStoredFontJson = null;
        this.pendingStoreFontJsonPromise = null;
        this.pendingStoreFontJsonPayload = null;
        this.lastEditingSubsetKey = null;
    }

    async initialize() {
        if (this.isInitialized) {
            timelineMark('fontCompilation.initialize.alreadyInitialized');
            return true;
        }

        if (this.initializationPromise) {
            timelineMark('fontCompilation.initialize.joinInFlight');
            return await this.initializationPromise;
        }

        this.initializationPromise = this.performInitialize();

        try {
            return await this.initializationPromise;
        } finally {
            this.initializationPromise = null;
        }
    }

    private async performInitialize(): Promise<boolean> {
        const initializeSpanId = timelineSpanStart(
            'fontCompilation.initialize'
        );

        console.log(
            '[FontCompilation]',
            '🔧 Initializing babelfont-fontc WASM worker...'
        );
        console.log(
            '[FontCompilation]',
            '🚀 Using direct .babelfont JSON → TTF pipeline (no file system)'
        );

        // Wait for service worker to be active (needed for SharedArrayBuffer on GitHub Pages)
        if ('serviceWorker' in navigator) {
            // Check if a service worker is actually registered
            const registrations =
                await navigator.serviceWorker.getRegistrations();
            if (
                registrations.length > 0 ||
                navigator.serviceWorker.controller
            ) {
                const registration = await navigator.serviceWorker.ready;
                if (
                    registration.active &&
                    !navigator.serviceWorker.controller
                ) {
                    console.log(
                        '[FontCompilation]',
                        '⏳ Service worker registered but not controlling page yet. Waiting...'
                    );
                    // Wait a bit for controller to be set
                    await new Promise((resolve) => setTimeout(resolve, 500));
                }
            }
        }

        // Check if SharedArrayBuffer is available
        if (typeof SharedArrayBuffer === 'undefined') {
            console.error(
                '[FontCompilation]',
                '❌ SharedArrayBuffer is not available. fontc WASM requires it.\n' +
                    'This should be enabled by the coi-serviceworker.js.\n' +
                    'If you see this error:\n' +
                    '  1. Try a hard refresh (Ctrl+Shift+R or Cmd+Shift+R)\n' +
                    '  2. Check browser console for service worker errors\n' +
                    '  3. Make sure coi-serviceworker.js is loaded in the HTML\n\n' +
                    'For local development, use: cd webapp && npm run dev'
            );
            if (window.term) {
                window.term.echo('');
                window.term.error(
                    '❌ SharedArrayBuffer not available - fontc WASM cannot initialize'
                );
                window.term.echo(
                    '[[;orange;]Try a hard refresh (Ctrl+Shift+R / Cmd+Shift+R) to activate the service worker.]'
                );
                window.term.echo('');
            }
            this.isInitialized = false;
            return false;
        }

        try {
            // Create a Web Worker for fontc
            timelineMark('fontCompilation.initialize.createWorker');
            this.worker = new Worker('js/fontc-worker.js', { type: 'module' });
            this.lastEditingSubsetKey = null;

            // Set up message handler
            this.worker.onmessage = (e) => this.handleWorkerMessage(e);
            this.worker.onerror = (e) => this.handleWorkerError(e);

            // Wait for worker to be ready
            timelineMark('fontCompilation.initialize.waitWorkerReady');
            const ready = await new Promise<boolean>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(
                        new Error(
                            'Worker initialization timeout after 30 seconds. Check console for worker errors.'
                        )
                    );
                }, 30000); // 30 second timeout

                const checkReady = (e: MessageEvent) => {
                    console.log('[FontCompilation]', 'Worker message:', e.data);
                    if (e.data.ready) {
                        clearTimeout(timeout);
                        this.worker!.removeEventListener('message', checkReady);
                        resolve(true);
                    } else if (e.data.error) {
                        clearTimeout(timeout);
                        this.worker!.removeEventListener('message', checkReady);
                        reject(new Error(e.data.error));
                    }
                };

                this.worker!!.addEventListener('message', checkReady);

                // Send an empty message to trigger worker auto-initialization
                console.log(
                    '[FontCompilation]',
                    'Sending initialization trigger to worker...'
                );
                this.worker!.postMessage({});
            });

            this.isInitialized = ready;
            timelineMark('fontCompilation.initialize.ready');
            console.log(
                '[FontCompilation]',
                '✅ babelfont-fontc WASM worker initialized'
            );
            console.log(
                '[FontCompilation]',
                '✅ Ready for direct Python → Rust compilation'
            );

            // Connect interpolation manager to this worker (main pipeline only)
            if (this.connectInterpolation && fontInterpolation) {
                fontInterpolation.setWorker(this.worker);
                console.log(
                    '[FontCompilation]',
                    '✅ Interpolation manager connected to worker'
                );
            }

            return true;
        } catch (error: any) {
            timelineMark('fontCompilation.initialize.failed');
            console.error(
                '[FontCompilation]',
                '❌ Failed to initialize babelfont-fontc WASM:',
                error.message
            );
            if (window.term) {
                window.term.error(
                    `Failed to load babelfont-fontc: ${error.message}`
                );
                window.term.error('');
                window.term.error('Troubleshooting:');
                window.term.error(
                    '1. Make sure you ran: ./build-fontc-wasm.sh'
                );
                window.term.error(
                    '2. Serving with: cd webapp && python3 serve-with-cors.py'
                );
                window.term.error(
                    '3. Open in a regular browser (Chrome/Firefox), not VS Code Simple Browser'
                );
                window.term.error('');
                if (
                    error.message.includes('DataCloneError') ||
                    error.message.includes('Memory')
                ) {
                    window.term.error(
                        "⚠️  This error suggests your browser context doesn't support WASM threading."
                    );
                    window.term.error(
                        '   Try opening http://localhost:8000 in Chrome or Firefox.'
                    );
                }
            }
            return false;
        } finally {
            timelineSpanEnd(initializeSpanId);
        }
    }

    handleWorkerMessage(e: MessageEvent) {
        // Forward interpolation messages to the interpolation manager
        if (e.data.type === 'interpolate' && window.fontInterpolation) {
            window.fontInterpolation.handleWorkerMessage(e);
            return;
        }

        // Handle debug messages
        if (e.data.type === 'debug') {
            console.log('[FontCompilation Worker Debug]', e.data.message);
            return;
        }

        // Handle compilation messages
        const { id, result, error, errorPayload, time_taken } = e.data;

        const normalizeCompiledResult = (
            value: unknown
        ): Uint8Array | undefined => {
            if (value === undefined || value === null) {
                return undefined;
            }
            if (value instanceof Uint8Array) {
                return value;
            }
            if (value instanceof ArrayBuffer) {
                return new Uint8Array(value);
            }
            if (Array.isArray(value)) {
                return new Uint8Array(value);
            }
            return undefined;
        };

        if (id !== undefined && this.pendingCompilations.has(id)) {
            const { resolve, reject, filename, spanId, traceContext } =
                this.pendingCompilations.get(id)!;
            this.pendingCompilations.delete(id);
            if (spanId) {
                timelineSpanEnd(spanId);
            }

            if (error !== undefined || errorPayload !== undefined) {
                timelineMark('fontCompilation.workerResponse.error', {
                    ...traceContext,
                    process: 'main'
                });
                const payloadText = (() => {
                    if (errorPayload === undefined) {
                        return '';
                    }
                    try {
                        return JSON.stringify(errorPayload);
                    } catch {
                        return String(errorPayload);
                    }
                })();
                const message =
                    typeof error === 'string' && error.trim().length > 0
                        ? error
                        : errorPayload !== undefined
                          ? payloadText
                          : 'Compilation failed';
                const compilationError = new Error(message) as Error & {
                    compilationErrorPayload?: unknown;
                };
                compilationError.compilationErrorPayload = errorPayload;
                reject(compilationError);
            } else {
                timelineMark('fontCompilation.workerResponse.success', {
                    ...traceContext,
                    process: 'main'
                });
                // For compilation messages, wrap in { result, time_taken, filename }
                // For other message types, return the full data
                if (result !== undefined) {
                    const normalizedResult = normalizeCompiledResult(result);
                    if (!normalizedResult) {
                        reject(
                            new Error(
                                'Worker returned unsupported compiled result type'
                            )
                        );
                        return;
                    }
                    resolve({
                        ...e.data,
                        result: normalizedResult,
                        time_taken,
                        filename
                    });
                } else {
                    resolve(e.data);
                }
            }
        }
    }

    handleWorkerError(e: ErrorEvent) {
        console.error('[FontCompilation]', 'Worker error:', e);
        if (window.term) {
            window.term.error(`Worker error: ${e.message}`);
        }
    }

    /**
     * Send a generic message to the worker and wait for response
     */
    async sendMessage(data: any): Promise<any> {
        if (!this.worker) {
            throw new Error('Worker not initialized');
        }

        const messageType = data.type || 'unknown';
        const requestId = this.compilationId++;
        const traceContext: TimelineTraceContext = {
            process: 'main',
            traceId: `${messageType}-${requestId}`,
            requestId: String(requestId),
            fontRevisionKey:
                data && typeof data.fontRevisionKey === 'string'
                    ? data.fontRevisionKey
                    : undefined
        };

        if (messageType === 'storeFontJson') {
            const forceStore = data?.forceStore === true;
            const payload =
                typeof data.babelfontJson === 'string'
                    ? data.babelfontJson
                    : '';

            if (!forceStore && payload && payload === this.lastStoredFontJson) {
                timelineMark(
                    'fontCompilation.workerMessage.storeFontJson.skippedCached'
                );
                return {
                    type: 'storeFontJson',
                    success: true,
                    skipped: 'cached',
                    cachedSize: payload.length
                };
            }

            if (
                !forceStore &&
                payload &&
                this.pendingStoreFontJsonPromise &&
                payload === this.pendingStoreFontJsonPayload
            ) {
                timelineMark(
                    'fontCompilation.workerMessage.storeFontJson.joinedInFlight'
                );
                return this.pendingStoreFontJsonPromise;
            }
        }

        const spanId = timelineSpanStart(
            `fontCompilation.workerMessage.${messageType}`,
            undefined,
            traceContext
        );

        const requestPromise = new Promise((resolve, reject) => {
            const id = requestId;

            const wrappedResolve = (value: any) => {
                if (messageType === 'storeFontJson') {
                    const payload =
                        typeof data.babelfontJson === 'string'
                            ? data.babelfontJson
                            : null;
                    if (payload) {
                        this.lastStoredFontJson = payload;
                    }
                    this.pendingStoreFontJsonPromise = null;
                    this.pendingStoreFontJsonPayload = null;
                }
                resolve(value);
            };

            const wrappedReject = (reason?: any) => {
                if (messageType === 'storeFontJson') {
                    this.pendingStoreFontJsonPromise = null;
                    this.pendingStoreFontJsonPayload = null;
                }
                reject(reason);
            };

            this.pendingCompilations.set(id, {
                resolve: wrappedResolve,
                reject: wrappedReject,
                filename: data.filename || 'unknown',
                spanId,
                traceContext
            });

            timelineMark(`fontCompilation.workerMessage.${messageType}.sent`, {
                ...traceContext,
                process: 'main',
                parentSpanId: spanId
            });
            try {
                this.worker!.postMessage({
                    ...data,
                    id,
                    traceContext: {
                        ...traceContext,
                        parentSpanId: spanId
                    }
                });
            } catch (error) {
                this.pendingCompilations.delete(id);
                timelineMark(
                    `fontCompilation.workerMessage.${messageType}.failed`,
                    {
                        ...traceContext,
                        process: 'main',
                        parentSpanId: spanId
                    }
                );
                timelineSpanEnd(spanId);
                reject(error);
            }
        });

        if (messageType === 'storeFontJson') {
            const payload =
                typeof data.babelfontJson === 'string'
                    ? data.babelfontJson
                    : '';
            this.pendingStoreFontJsonPromise = requestPromise;
            this.pendingStoreFontJsonPayload = payload;
        }

        return requestPromise;
    }

    /**
     * Compile font directly from .babelfont JSON string
     * This is the NEW direct path: Python → JSON → JavaScript → WASM
     * NO FILE SYSTEM OPERATIONS!
     *
     * @param {string} babelfontJson - Complete .babelfont JSON string
     * @param {string} filename - Optional filename for output (default: 'font.ttf')
     * @param {string|object} target - Compilation target name ('user', 'glyph_overview', 'editing') or custom options object
     * @param {Array<string>} subsetGlyphs - Optional array of glyph names to include (for 'editing' target)
     * @returns {Promise<Object>} - { result: Uint8Array, filename: string, timeTaken: number }
     */
    async compileFromJson(
        babelfontJson: string,
        filename: string = 'font.babelfont',
        target: string | CompilationOptions = 'user',
        subsetGlyphs?: Array<string>
    ): Promise<{ result: Uint8Array; filename: string; time_taken: number }> {
        const compileSpanId = timelineSpanStart(
            'fontCompilation.compileFromJson'
        );

        if (!this.isInitialized) {
            const initialized = await this.initialize();
            if (!initialized) {
                timelineMark('fontCompilation.compileFromJson.notInitialized');
                timelineSpanEnd(compileSpanId);
                throw new Error(
                    'babelfont-fontc WASM not available. Run ./build-fontc-wasm.sh and serve with CORS headers.'
                );
            }
        }

        // Resolve compilation options
        const resolveOptionsSpanId = timelineSpanStart(
            'fontCompilation.compileFromJson.resolveOptions'
        );
        let options: CompilationOptions;
        if (typeof target === 'string') {
            options = { ...COMPILATION_TARGETS[target] };
            if (!options) {
                timelineSpanEnd(resolveOptionsSpanId);
                throw new Error(
                    `Unknown compilation target: ${target}. Available: ${Object.keys(COMPILATION_TARGETS).join(', ')}`
                );
            }
        } else {
            options = target;
        }
        timelineSpanEnd(resolveOptionsSpanId);

        // Add subset glyphs if provided
        const subsetOptionsSpanId = timelineSpanStart(
            'fontCompilation.compileFromJson.applySubsetOptions'
        );
        if (subsetGlyphs && subsetGlyphs.length > 0) {
            options.subset_glyphs = subsetGlyphs;
            console.log(
                '[FontCompilation]',
                `Subsetting to ${subsetGlyphs.length} glyphs:`,
                subsetGlyphs
            );
        } else {
            console.log(
                '[FontCompilation]',
                'No subset_glyphs specified, compiling full font'
            );
        }
        timelineSpanEnd(subsetOptionsSpanId);

        console.log(
            '[FontCompilation]',
            `🔨 Compiling ${filename} from .babelfont JSON (target: ${typeof target === 'string' ? target : 'custom'})...`
        );
        console.log(
            '[FontCompilation]',
            `📊 JSON size: ${babelfontJson.length} bytes`
        );

        const id = this.compilationId++;

        return new Promise((resolve, reject) => {
            const wrappedResolve = (value: any) => {
                timelineSpanEnd(compileSpanId);
                resolve(value);
            };
            const wrappedReject = (reason?: any) => {
                timelineMark('fontCompilation.compileFromJson.failed');
                timelineSpanEnd(compileSpanId);
                reject(reason);
            };

            this.pendingCompilations.set(id, {
                resolve: wrappedResolve,
                reject: wrappedReject,
                filename
            });

            // Validate JSON before sending to worker
            try {
                const validateJsonSpanId = timelineSpanStart(
                    'fontCompilation.compileFromJson.validateJson'
                );
                JSON.parse(babelfontJson);
                timelineSpanEnd(validateJsonSpanId);
            } catch (error: any) {
                console.error(
                    '[FontCompilation]',
                    '❌ Invalid JSON before sending to worker:',
                    error
                );
                const errorPos = error.message?.match(/column (\d+)/)?.[1];
                if (errorPos) {
                    const pos = parseInt(errorPos);
                    console.error(
                        '[FontCompilation]',
                        'Context:',
                        babelfontJson.substring(pos - 100, pos + 100)
                    );
                }
                this.pendingCompilations.delete(id);
                wrappedReject(error);
                return;
            }

            // Send JSON string directly to worker
            timelineMark('fontCompilation.compileFromJson.posted');
            try {
                const postMessageSpanId = timelineSpanStart(
                    'fontCompilation.compileFromJson.postMessage'
                );
                this.worker!.postMessage({
                    type: 'compile',
                    id,
                    babelfontJson,
                    filename,
                    options
                });
                timelineSpanEnd(postMessageSpanId);
            } catch (error) {
                this.pendingCompilations.delete(id);
                wrappedReject(error);
            }
        });
    }

    async compileEditingFromJsonCached(
        babelfontJson: string,
        fontRevisionKey: string,
        subsetGlyphs: Array<string>,
        requestMeta?: {
            dragActive?: boolean;
            compileSource?: string;
            dirtyLayerUpdates?: IncrementalLayerUpdate[];
            forceStoreFontJson?: boolean;
            optionOverrides?: {
                skip_features?: boolean;
                skip_kerning?: boolean;
                produce_varc_table?: boolean;
            };
        }
    ): Promise<{
        result: Uint8Array;
        filename: string;
        time_taken: number;
        fontRevisionKey?: string;
        closureGlyphCount?: number;
        compileSource?: string;
    }> {
        const spanId = timelineSpanStart(
            'fontCompilation.compileEditingFromJsonCached'
        );

        try {
            if (!this.isInitialized) {
                const initialized = await this.initialize();
                if (!initialized) {
                    timelineMark(
                        'fontCompilation.compileEditingFromJsonCached.notInitialized'
                    );
                    throw new Error(
                        'babelfont-fontc WASM not available. Run ./build-fontc-wasm.sh and serve with CORS headers.'
                    );
                }
            }

            const options: CompilationOptions = {
                ...COMPILATION_TARGETS.editing
            };

            // Apply option overrides for incremental compilation
            // (e.g., skip_features/skip_kerning during interactive editing)
            if (requestMeta?.optionOverrides) {
                Object.assign(options, requestMeta.optionOverrides);
            }

            const normalizedSubsetGlyphs = Array.from(
                new Set((subsetGlyphs || []).filter((glyph) => !!glyph))
            ).sort();
            const subsetKey = normalizedSubsetGlyphs.join('\u001f');

            // During incremental layer updates (drag/keyboard) or text-input
            // recompilations, skip transferring the full font JSON to the worker.
            // - drag/keyboard: worker uses update_cached_layer() with dirty layer updates
            // - text-input: font data hasn't changed, only the subset changed;
            //   worker reuses its cached font with the new subset
            const normalizedDirtyLayerUpdates = Array.isArray(
                requestMeta?.dirtyLayerUpdates
            )
                ? requestMeta.dirtyLayerUpdates.filter(
                      (update): update is IncrementalLayerUpdate =>
                          !!update &&
                          typeof update.glyphName === 'string' &&
                          update.glyphName.length > 0 &&
                          typeof update.layerId === 'string' &&
                          update.layerId.length > 0 &&
                          update.layerData !== undefined
                  )
                : [];
            const isIncrementalLayer =
                requestMeta?.compileSource !== undefined &&
                normalizedDirtyLayerUpdates.length > 0 &&
                (requestMeta.compileSource.startsWith('mouse-drag') ||
                    requestMeta.compileSource.startsWith('keyboard'));
            const isTextInput = requestMeta?.compileSource === 'text-input';
            const jsonForWorker =
                isIncrementalLayer || isTextInput
                    ? '__incremental_layer__'
                    : babelfontJson;

            const compileResult = await this.sendMessage({
                type: 'compileEditingCached',
                babelfontJson: jsonForWorker,
                options,
                subsetKey,
                subsetGlyphs: normalizedSubsetGlyphs,
                fontRevisionKey,
                dragActive: !!requestMeta?.dragActive,
                compileSource: requestMeta?.compileSource,
                dirtyLayerUpdates: normalizedDirtyLayerUpdates,
                forceStoreFontJson: requestMeta?.forceStoreFontJson === true,
                filename: 'editing-font.ttf'
            });

            if (
                requestMeta?.forceStoreFontJson === true &&
                jsonForWorker !== '__incremental_layer__'
            ) {
                this.lastStoredFontJson = babelfontJson;
            }

            this.lastEditingSubsetKey = subsetKey;

            return {
                result: compileResult.result,
                filename: compileResult.filename || 'editing-font.ttf',
                time_taken: compileResult.time_taken || 0,
                fontRevisionKey: compileResult.fontRevisionKey,
                closureGlyphCount: compileResult.closureGlyphCount,
                compileSource: compileResult.compileSource
            };
        } finally {
            timelineSpanEnd(spanId);
        }
    }

    /**
     * Compile font from Python Font object
     * This calls Python's font.to_dict() and compiles the result
     *
     * @param {string} fontVariableName - Name of the Python font variable
     * @param {string} outputFilename - Optional output filename
     * @returns {Promise<Object>} - Compilation result with download
     */
    async compileFromPythonFont(
        fontVariableName = 'font',
        outputFilename = null
    ) {
        if (!window.pyodide) {
            throw new Error('Pyodide not available');
        }

        console.log(
            '[FontCompilation]',
            `🐍 Exporting ${fontVariableName} to .babelfont JSON...`
        );

        try {
            // Call Python to export JSON (in memory, no file writes!)
            const babelfontJson = await window.pyodide.runPythonAsync(`
import json

# Get the font object
try:
    font_obj = ${fontVariableName}
except NameError:
    raise ValueError("Font variable '${fontVariableName}' not found. Make sure it's defined.")

# Export to .babelfont JSON (in memory)
font_dict = font_obj.to_dict()
json.dumps(font_dict)
            `);

            console.log(
                '[FontCompilation]',
                `✅ Exported to JSON (${babelfontJson.length} bytes)`
            );
            console.log('[FontCompilation]', '🚀 Compiling with Rust/WASM...');

            // Compile from JSON
            const result = await this.compileFromJson(
                babelfontJson,
                outputFilename || `${fontVariableName}.babelfont`
            );

            console.log(
                '[FontCompilation]',
                `✅ Compiled in ${result.time_taken}ms`
            );

            // Trigger download
            this.downloadFont(result.result, result.filename);

            return {
                success: true,
                filename: result.filename,
                bytes: result.result.length,
                time_taken: result.time_taken
            };
        } catch (error) {
            console.error('[FontCompilation]', '❌ Compilation failed:', error);
            throw error;
        }
    }

    /**
     * Download compiled font
     *
     * @param {Uint8Array} fontData - Compiled font bytes
     * @param {string} filename - Output filename
     */
    downloadFont(fontData: Uint8Array, filename: string) {
        const blob = new Blob([fontData.buffer as ArrayBuffer], {
            type: 'font/ttf'
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);

        console.log(
            '[FontCompilation]',
            `📥 Downloaded: ${filename} (${fontData.length} bytes)`
        );
    }
}

// Create global instance
const fontCompilation = new FontCompilation({
    connectInterpolation: true
});

const fullFontCompilation = new FontCompilation({
    connectInterpolation: false
});

// Initialize when DOM is ready
async function initFontCompilation() {
    await fontCompilation.initialize();
}

type OpenFontWorkerRequest = {
    filename: string;
    contents?: string | Uint8Array;
    packageEntries?: Record<string, Uint8Array>;
    projectEntries?: Record<string, Uint8Array>;
    timeoutMs?: number;
};

async function getReadyFontCompilationWorker(): Promise<Worker> {
    const initialized = await fontCompilation.initialize();

    if (!initialized || !fontCompilation.worker) {
        throw new Error('Font compilation worker not initialized');
    }

    return fontCompilation.worker;
}

async function requestOpenFontConversion({
    filename,
    contents,
    packageEntries,
    projectEntries,
    timeoutMs = 30000
}: OpenFontWorkerRequest): Promise<string> {
    const worker = await getReadyFontCompilationWorker();

    return await new Promise<string>((resolve, reject) => {
        const id = Math.random().toString(36);
        let settled = false;

        const cleanup = () => {
            clearTimeout(timeout);
            worker.removeEventListener('message', handleMessage);
        };

        const resolveOnce = (babelfontJson: string) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(babelfontJson);
        };

        const rejectOnce = (error: unknown) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
        };

        const handleMessage = (e: MessageEvent) => {
            if (e.data.id !== id || e.data.type !== 'openFont') {
                return;
            }

            if (e.data.error) {
                rejectOnce(new Error(e.data.error));
                return;
            }

            resolveOnce(e.data.babelfontJson);
        };

        const timeout = setTimeout(() => {
            rejectOnce(
                new Error(
                    `Font conversion timeout after ${Math.round(timeoutMs / 1000)} seconds`
                )
            );
        }, timeoutMs);

        worker.addEventListener('message', handleMessage);

        try {
            worker.postMessage({
                type: 'openFont',
                id,
                filename,
                contents,
                packageEntries,
                projectEntries
            });
        } catch (error) {
            rejectOnce(error);
        }
    });
}

// Auto-initialize - wait for service worker to be active
// Only run in browser environment
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', async () => {
        timelineMark('fontCompilation.domContentLoaded');
        console.log(
            '[FontCompilation] DOMContentLoaded - starting initialization'
        );
        // Wait for service worker to be ready before initializing (only if one is registering)
        if ('serviceWorker' in navigator) {
            // Check if a service worker is actually being registered
            const registrations =
                await navigator.serviceWorker.getRegistrations();
            if (
                registrations.length > 0 ||
                navigator.serviceWorker.controller
            ) {
                console.log('[FontCompilation] Waiting for service worker...');
                await navigator.serviceWorker.ready;
                console.log('[FontCompilation] Service worker ready');
                // Give it a brief moment to ensure controller is set
                await new Promise((resolve) => setTimeout(resolve, 500));
            } else {
                console.log(
                    '[FontCompilation] No service worker registered (development mode)'
                );
            }
        }
        console.log('[FontCompilation] Calling initFontCompilation...');
        await initFontCompilation();
        timelineMark('fontCompilation.domInitComplete');
        console.log('[FontCompilation] Initialization complete');
    });
}

// Expose for manual initialization if needed
(window as any).initFontCompilation = initFontCompilation;
(window as any).fontCompilation = fontCompilation;
(window as any).fullFontCompilation = fullFontCompilation;

export type { CompilationOptions, FontCompilation };
export {
    fontCompilation,
    fullFontCompilation,
    COMPILATION_TARGETS,
    shapeTextWithFont,
    requestOpenFontConversion
};
