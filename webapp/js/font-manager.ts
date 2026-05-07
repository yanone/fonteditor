// Font Manager
// Keeps track of all open fonts, and access to font data.
// Also maintains the opened font dropdown UI.
// Implements editing-font compilation architecture:
// "editing" font: Recompiled on demand with subset of glyphs for display in canvas

import APP_SETTINGS from './settings';
import { fontCompilation, requestOpenFontConversion } from './font-compilation';
import { get_glyph_order } from '../wasm-dist/babelfont_fontc_web';
import type { Babelfont } from './babelfont';
import { designspaceToUserspace, userspaceToDesignspace } from './locations';
import type { DesignspaceLocation, UserspaceLocation } from './locations';
import {
    Font,
    Path,
    DecomposedAffineTransform,
    withSuppressedModelRecording
} from './babelfont-model';
import { sanitizeBabelfontArrays } from './change-bridge-ydoc';
import { sidebarErrorDisplay } from './sidebar-error-display';
import type { FilesystemPlugin } from './filesystem-plugins';
import { Logger } from './logger';
import {
    timelineMark,
    timelineSpanEnd,
    timelineSpanStart
} from './perf-timeline';
import { beginLoadingCursor, endLoadingCursor } from './loading-cursor';
import { ensureStartupStateReady } from './state-restore';
import type { WorkerReplayTarget } from './change-log';
import {
    beginStartupInteractionLock,
    endStartupInteractionLock
} from './startup-interaction-lock';

const console = new Logger('FontManager');

let startupOpenSessionActive = false;
let startupOpenSessionEditingCompileCount = 0;

export type GlyphData = {
    glyphName: string;
    layers: {
        id: string;
        name: string;
        _master: string;
        location?: DesignspaceLocation;
    }[];
    masters: {
        id: string;
        name: string;
        location: UserspaceLocation;
    }[];
    axesOrder: string[];
};

export type FontQCSummary = {
    fails: number;
    warns: number;
    infos: number;
};

type LayerCacheUpdate = {
    glyphName: string;
    layerId: string;
    layerData: Babelfont.Layer;
};

type ExplicitLayerCacheInput = LayerCacheUpdate;

/**
 * Counters that record traffic across the JS ↔ Rust/worker boundary.
 *
 * These are the numbers the Counterpunch compilation policy locks down:
 * during interactive editing every commit MUST flow through the batched
 * layer-update path (`submitLayerUpdatesToWorkerCache` → `storeLayerUpdates`
 * worker message → `update_cached_layers_batch` Rust call). Full-font
 * crossings (`storeFontJson`) MUST stay at zero outside of font open,
 * external reload, and explicit force-full sync. Tests assert the
 * deltas of these counters per edit/cascade/undo/remote operation.
 */
export type BoundaryCrossingStats = {
    /** Number of `submitLayerUpdatesToWorkerCache` calls (1 per batch). */
    submitBatchCalls: number;
    /** Total number of layer entries crossed in batches. */
    layersTransmitted: number;
    /** Number of distinct glyphs crossed in batches (running count). */
    glyphsTransmitted: number;
    /**
     * Number of full-font `storeFontJson` crossings since the last
     * reset. Should stay 0 during normal interactive editing.
     */
    fullFontCrossings: number;
};

/**
 * Shared empty fingerprint baseline map. Returned by the (now no-op)
 * `getLayerFingerprintsFromStoredJson` to avoid re-parsing the
 * megabyte-scale `babelfontJson` on every commit batch.
 */
const EMPTY_FINGERPRINT_MAP: Map<string, string> = new Map();

type ReloadCurrentFontOptions = {
    preserveUiState?: boolean;
};

type CapturedGlyphCanvasState = {
    wasEditMode: boolean;
    selectedGlyphIndex: number;
    selectedLayerId: string | null;
    cursorPosition: number;
    textBuffer: string;
    variationSettings: UserspaceLocation | null;
    viewport: {
        scale: number;
        panX: number;
        panY: number;
    } | null;
};

class OpenedFont {
    babelfontJson: string;
    babelfontData: any;
    fontModel: Font; // Object model facade
    name: string;
    path: string;
    needsRecompile: boolean;
    hasUnsavedChanges: boolean;
    sourcePlugin: FilesystemPlugin;
    fileHandle?: FileSystemFileHandle;
    directoryHandle?: FileSystemDirectoryHandle;
    changeVersion: number; // Counter incremented on every change to track data freshness
    compileRequestVersion: number; // Counter incremented on every editing-font compile request

    constructor(
        babelfontJson: string,
        path: string,
        sourcePlugin: FilesystemPlugin,
        fileHandle?: FileSystemFileHandle,
        directoryHandle?: FileSystemDirectoryHandle
    ) {
        this.babelfontJson = babelfontJson;
        this.babelfontData = JSON.parse(babelfontJson);
        this.babelfontData.glyphs = this.babelfontData.glyphs || [];
        this.babelfontData.masters = this.babelfontData.masters || [];
        this.babelfontData.axes = this.babelfontData.axes || [];
        const knownMasterIds = new Set<string>(
            this.babelfontData.masters
                .map((m: any) => m?.id)
                .filter((id: any) => typeof id === 'string')
        );
        this.sourcePlugin = sourcePlugin;
        this.fileHandle = fileHandle;
        this.directoryHandle = directoryHandle;

        // Normalize layer master references to tagged LayerType objects
        for (const glyph of this.babelfontData.glyphs || []) {
            for (const layer of glyph.layers || []) {
                if (!layer.master) {
                    if (
                        !layer.is_background &&
                        typeof layer.id === 'string' &&
                        knownMasterIds.has(layer.id)
                    ) {
                        layer.master = {
                            type: 'DefaultForMaster',
                            master: layer.id
                        };
                    }
                    continue;
                }

                const masterData = layer.master;

                if (typeof masterData === 'string') {
                    layer.master = {
                        type: 'DefaultForMaster',
                        master: masterData
                    };
                    continue;
                }

                if (typeof masterData === 'object') {
                    if ('type' in masterData) {
                        continue;
                    }

                    if (
                        'master' in masterData &&
                        typeof (masterData as any).master === 'string'
                    ) {
                        layer.master = {
                            type: 'DefaultForMaster',
                            master: (masterData as any).master
                        };
                        continue;
                    }

                    if ('DefaultForMaster' in masterData) {
                        layer.master = {
                            type: 'DefaultForMaster',
                            master: masterData.DefaultForMaster
                        };
                        continue;
                    }

                    if ('default_for_master' in masterData) {
                        layer.master = {
                            type: 'DefaultForMaster',
                            master: (masterData as any).default_for_master
                        };
                        continue;
                    }

                    if ('associated_with_master' in masterData) {
                        layer.master = {
                            type: 'AssociatedWithMaster',
                            master: (masterData as any).associated_with_master
                        };
                        continue;
                    }

                    if ('AssociatedWithMaster' in masterData) {
                        layer.master = {
                            type: 'AssociatedWithMaster',
                            master: masterData.AssociatedWithMaster
                        };
                        continue;
                    }

                    if (
                        'FreeFloating' in masterData ||
                        Object.keys(masterData).length === 0
                    ) {
                        layer.master = { type: 'FreeFloating' };
                    }
                }
            }
        }

        this.fontModel = Font.fromData(this.babelfontData); // Create object model
        withSuppressedModelRecording(() => {
            this.fontModel.recomputeMetricsKeys();
        });
        this.babelfontJson = this.fontModel.toJSONString();
        this.path = path;
        this.name =
            this.babelfontData?.names?.family_name?.dflt || 'Untitled Font';
        this.needsRecompile = false;
        this.hasUnsavedChanges = false;
        this.changeVersion = 0;
        this.compileRequestVersion = 0;
    }

    private normalizeComponentTransformForRust(
        transform: unknown
    ): Babelfont.DecomposedAffine {
        if (Array.isArray(transform)) {
            return DecomposedAffineTransform.fromAffine(transform);
        }

        const identity = DecomposedAffineTransform.identity();
        if (!transform || typeof transform !== 'object') {
            return identity;
        }

        const record = transform as Record<string, unknown>;
        const translation = Array.isArray(record.translation)
            ? [
                  Number(record.translation[0]) || 0,
                  Number(record.translation[1]) || 0
              ]
            : [0, 0];
        const scale = Array.isArray(record.scale)
            ? [Number(record.scale[0]) || 1, Number(record.scale[1]) || 1]
            : [1, 1];
        const rawSkew = Array.isArray(record.skew)
            ? record.skew
            : [record.skew ?? 0, 0];
        const skew = [Number(rawSkew[0]) || 0, Number(rawSkew[1]) || 0] as [
            number,
            number
        ];
        const rotation = Number(record.rotation) || 0;
        const order =
            record.order === 'Glyphs' || record.order === 'RestOfTheWorld'
                ? (record.order as Babelfont.TransformOrder)
                : identity.order;

        return {
            translation: translation as [number, number],
            scale: scale as [number, number],
            rotation,
            skew,
            order
        };
    }

    /**
     * Mark font as changed:
     * - needsRecompile: auto-compile pipeline should rebuild editing font
     * - hasUnsavedChanges: save indicator and unload warnings
     * This allows tracking whether data changed during compilation
     */
    markDirty(changeSource?: string): void {
        this.needsRecompile = true;
        if (!this.isCloudBacked()) {
            this.hasUnsavedChanges = true;
        }
        this.changeVersion++;
        this.compileRequestVersion++;
        window.fullCompileManager?.checkAndSchedule?.();
    }

    /**
     * Request editing-font recompilation without marking font data as changed.
     * Use this when switching compilation mode (e.g. outline-only -> full)
     * without any new source data edits.
     */
    requestRecompileWithoutDataChange(): void {
        this.needsRecompile = true;
        this.compileRequestVersion++;
    }

    isCloudBacked(): boolean {
        return this.sourcePlugin?.getId?.() === 'cloud';
    }

    /**
     * Sync the JSON string from the object model data
     * Call this after making changes through the object model
     * Converts nodes arrays back to string format for Rust compiler
     */
    syncJsonFromModel(): void {
        let pathsFound = 0;
        let pathsConverted = 0;
        let pathsAlreadyString = 0;
        let wrappersFixed = 0;

        // Sanitize array fields that Y.Doc undo/redo roundtrips may have
        // corrupted into objects with numeric keys (e.g. shapes → {"0":…})
        sanitizeBabelfontArrays(this.babelfontData);

        // Process all layers to prepare for serialization
        for (const glyph of this.babelfontData.glyphs || []) {
            for (const layer of glyph.layers || []) {
                if (!layer?.shapes) continue;

                for (let i = 0; i < layer.shapes.length; i++) {
                    let shape = layer.shapes[i];

                    // Handle flat Path shapes - convert array nodes to strings.
                    if ('nodes' in shape && shape.nodes) {
                        pathsFound++;

                        if (Array.isArray(shape.nodes)) {
                            // Convert nodes array back to compact string format
                            const nodesString = Path.nodesToString(shape.nodes);
                            shape.nodes = nodesString;
                            pathsConverted++;
                        } else if (typeof shape.nodes === 'string') {
                            pathsAlreadyString++;
                        } else {
                            console.error(
                                `Unexpected nodes type for ${glyph.name}:`,
                                typeof shape.nodes,
                                shape.nodes
                            );
                        }

                        // Ensure `closed` field exists (Y.Doc roundtrip can lose it)
                        if (!('closed' in shape)) {
                            shape.closed = false;
                        }
                    }

                    // Handle wrapped Path shapes { Path: { nodes, closed } }.
                    // The Path.nodes getter in babelfont-model mutates the underlying
                    // data from string to array; syncJsonFromModel must convert it back
                    // so toJSONString() doesn't emit array-nodes that Rust can't parse.
                    if (
                        'Path' in shape &&
                        shape.Path &&
                        typeof shape.Path === 'object' &&
                        'nodes' in shape.Path &&
                        Array.isArray(shape.Path.nodes)
                    ) {
                        shape.Path.nodes = Path.nodesToString(shape.Path.nodes);
                        wrappersFixed++;
                    }

                    const componentCandidate =
                        'Component' in shape &&
                        shape.Component &&
                        typeof shape.Component === 'object'
                            ? shape.Component
                            : 'reference' in shape
                              ? shape
                              : null;

                    if (componentCandidate) {
                        componentCandidate.transform =
                            this.normalizeComponentTransformForRust(
                                componentCandidate.transform
                            );
                    }

                    // Note: normalizer wrapper properties (nodes, isInterpolated) are filtered
                    // out during JSON.stringify by the replacer function in toJSONString()
                }

                // Ensure layer has required `width` field
                // (Y.Doc roundtrip can lose it; Rust serde requires it)
                if (layer.width === undefined || layer.width === null) {
                    layer.width = 0;
                }
            }
        }

        this.babelfontJson = this.fontModel.toJSONString();

        if (pathsConverted > 0 || wrappersFixed > 0) {
            console.log(
                `[syncJsonFromModel] Converted ${pathsConverted} array-node paths, ` +
                    `${wrappersFixed} wrapped paths, ${pathsAlreadyString} already strings, ` +
                    `${pathsFound} total paths found. JSON length: ${this.babelfontJson.length}`
            );
        }
    }

    /**
     * Save font using the source plugin's adapter
     */
    async save(): Promise<void> {
        const pluginId = this.sourcePlugin.getId();

        // For disk plugin, need file handle and permission check
        if (pluginId === 'disk') {
            if (!this.fileHandle) {
                throw new Error('No file handle available for disk save');
            }

            // Check permission
            const permission = await (this.fileHandle as any).queryPermission({
                mode: 'readwrite'
            });
            if (permission !== 'granted') {
                const requestedPermission = await (
                    this.fileHandle as any
                ).requestPermission({ mode: 'readwrite' });
                if (requestedPermission !== 'granted') {
                    throw new Error('Write permission not granted');
                }
            }

            // Write to file
            try {
                const writable = await this.fileHandle.createWritable();
                await writable.write(this.babelfontJson);
                await writable.close();
            } catch (error) {
                if (error instanceof Error && error.name === 'SecurityError') {
                    throw new Error(
                        'Permission denied. Please re-enable disk access and try again.'
                    );
                }
                throw error;
            }
        } else {
            // For other plugins, use adapter's writeFile method
            const adapter = this.sourcePlugin.getAdapter();
            await adapter.writeFile(this.path, this.babelfontJson);
        }

        // Clear unsaved/sync flags after successful save
        this.needsRecompile = false;
        this.hasUnsavedChanges = false;
    }
}

class FontManager {
    fontDisplay: HTMLElement | null;
    fontIconElement: HTMLElement | null;
    fontNameElement: HTMLElement | null;
    fontRoleBadgeElement: HTMLElement | null;
    dirtyIndicator: HTMLElement | null;

    openedFonts: Map<string, OpenedFont>; // Record of fontId to OpenedFont
    currentFontId: string | null = null;
    editingFont: Uint8Array | null;
    fullFont: Uint8Array | null;
    fullFontQcSummary: FontQCSummary | null;
    currentText: string;
    selectedFeatures: string[];
    isCompiling: boolean;
    glyphOrderCache: string[] | null;
    lastChangeSource: string | null = null; // Track what triggered the last change (keyboard, mouse-drag, etc.)
    lastEditType: 'outline' | 'anchor' | null = null; // Track edit type for compilation optimization
    lastCompilationMode:
        | 'full'
        | 'outline-only'
        | 'anchor-only'
        | 'text-input' = 'full'; // Track last compilation mode
    fullCompileDebounceTimer: ReturnType<typeof setTimeout> | null = null; // Timer for debounced full compile after interactive editing
    closureCache: {
        subsetGlyphs: string[];
        activeFeatures: string;
        closureSet: string[];
    } | null = null;
    editingSubsetSnapshotGlyphs: string[];
    editingSubsetSnapshotKey: string;
    isExternalReloading: boolean = false;
    pendingDebugEditingFontSaveAfterDrag: boolean;
    pendingBabelfontJsonSyncAfterDrag: boolean;
    workerCacheUpdatePromise: Promise<void> | null;
    forceFullEditingCacheRefresh: boolean;
    workerLayerFingerprintCache: Map<string, string>;

    /**
     * Memoizes the result of validateAndFixBabelfontJsonForRust.
     * The validator parses, walks, and re-serializes the entire ~6 MB
     * babelfontJson on every interactive editing compile because the
     * `pendingBabelfontJsonSyncAfterDrag` flag forces it. During a stream
     * of interactive edits, `currentFont.babelfontJson` is not re-synced
     * (sync is deferred to the debounced full compile), so the same
     * input string is validated repeatedly. Caching by input identity
     * eliminates ~50 ms of pure overhead per interactive compile.
     * Cache is invalidated implicitly: any new input string (a different
     * object reference or different content) misses and re-runs the
     * validator. Safe because validation is a pure function of input.
     */
    private _validatedBabelfontJsonCache: {
        input: string;
        output: string;
    } | null = null;

    /**
     * Running counters for traffic across the JS \u2194 Rust/worker boundary.
     * See {@link BoundaryCrossingStats} and {@link getBoundaryCrossingStats}.
     */
    private _boundaryCrossingStats: {
        submitBatchCalls: number;
        layersTransmitted: number;
        fullFontCrossings: number;
        transmittedGlyphs: Set<string>;
    } = {
        submitBatchCalls: 0,
        layersTransmitted: 0,
        fullFontCrossings: 0,
        transmittedGlyphs: new Set<string>()
    };

    constructor() {
        this.fontDisplay = null;
        this.fontIconElement = null;
        this.fontNameElement = null;
        this.fontRoleBadgeElement = null;
        this.dirtyIndicator = null;
        this.openedFonts = new Map<string, OpenedFont>();
        this.editingFont = null; // Uint8Array of compiled editing font
        this.fullFont = null; // Uint8Array of compiled full font
        this.fullFontQcSummary = null;
        this.currentText = '';
        this.selectedFeatures = [];
        this.isCompiling = false;
        this.glyphOrderCache = null; // Cache for glyph order to avoid re-parsing
        this.lastChangeSource = null;
        this.lastEditType = null;
        this.lastCompilationMode = 'full';
        this.fullCompileDebounceTimer = null;
        this.closureCache = null;
        this.editingSubsetSnapshotGlyphs = [];
        this.editingSubsetSnapshotKey = '';
        this.isExternalReloading = false;
        this.pendingDebugEditingFontSaveAfterDrag = false;
        this.pendingBabelfontJsonSyncAfterDrag = false;
        this.workerCacheUpdatePromise = null;
        this.forceFullEditingCacheRefresh = false;
        this.workerLayerFingerprintCache = new Map();

        window.addEventListener('cloudConnectionStatusChanged', () => {
            void this.updateDirtyIndicator();
        });
    }
    init() {
        this.fontDisplay = document.getElementById('current-font-display');
        this.fontIconElement =
            this.fontDisplay?.querySelector('.font-icon') || null;
        this.fontNameElement =
            this.fontDisplay?.querySelector('.font-name') || null;
        this.fontRoleBadgeElement =
            this.fontDisplay?.querySelector('.font-window-role-badge') || null;
        this.dirtyIndicator = document.getElementById('file-dirty-indicator');
    }

    private ensureWindowRoleBadge(): HTMLElement | null {
        if (!this.fontDisplay) {
            return null;
        }

        if (!this.fontRoleBadgeElement) {
            const badge = document.createElement('span');
            badge.className = 'font-window-role-badge';
            this.fontDisplay.appendChild(badge);
            this.fontRoleBadgeElement = badge;
        }

        return this.fontRoleBadgeElement;
    }

    private updateWindowTitle() {
        const baseTitle = 'Counterpunch Editor';
        const roleSuffix = window.windowRole?.getTitleSuffix() ?? '(Main)';
        const dirtyPrefix =
            window.windowRole?.isMainWindow() &&
            this.shouldShowDirtyState(this.currentFont)
                ? '● '
                : '';

        if (this.currentFont?.name) {
            document.title = `${dirtyPrefix}${this.currentFont.name} ${roleSuffix} - ${baseTitle}`;
            return;
        }

        document.title = `${baseTitle} ${roleSuffix}`;
    }

    get currentFont(): OpenedFont | null {
        if (this.currentFontId && this.openedFonts.has(this.currentFontId)) {
            const font = this.openedFonts.get(this.currentFontId) || null;
            // Update global reference for Python/script access
            if (font) {
                window.currentFontModel = font.fontModel;
            } else {
                window.currentFontModel = null;
            }
            return font;
        }
        window.currentFontModel = null;
        return null;
    }

    private normalizeCloudAssetId(font: OpenedFont | null): string | null {
        if (!font?.isCloudBacked()) {
            return null;
        }

        return font.path.replace(/^cloud:\/\//, '').replace(/^\/+/, '') || null;
    }

    shouldShowDirtyState(font: OpenedFont | null): boolean {
        if (!font) {
            return false;
        }

        if (!font.isCloudBacked()) {
            return font.hasUnsavedChanges;
        }

        const assetId = this.normalizeCloudAssetId(font);
        if (!assetId) {
            return false;
        }

        return !!window.cloudPlugin?.hasConnectionProblem?.(assetId);
    }

    hasAnyDirtyState(): boolean {
        for (const openedFont of this.openedFonts.values()) {
            if (this.shouldShowDirtyState(openedFont)) {
                return true;
            }
        }

        return false;
    }

    updateFontDisplay() {
        if (!this.fontIconElement || !this.fontNameElement) return;

        const shareButton = document.getElementById('share-btn');
        const roleLabel = window.windowRole?.getRoleLabel() ?? 'Main';
        const roleBadge = this.ensureWindowRoleBadge();

        if (roleBadge) {
            roleBadge.textContent = roleLabel;
            roleBadge.setAttribute('title', `Window role: ${roleLabel}`);
        }

        if (this.openedFonts.size === 0 || !this.currentFontId) {
            // No fonts open
            this.fontIconElement.innerHTML = '';
            this.fontNameElement.textContent = 'No fonts open';
            if (this.fontDisplay) {
                this.fontDisplay.title = roleLabel;
            }
            if (shareButton) {
                shareButton.classList.remove('visible');
            }
        } else {
            // Display current font
            const currentFont = this.openedFonts.get(this.currentFontId);
            if (currentFont) {
                const sourceIcon = currentFont.sourcePlugin.getIcon();
                const sourceName = currentFont.sourcePlugin.getName();
                this.fontIconElement.innerHTML = sourceIcon;
                this.fontNameElement.textContent = currentFont.name;
                if (this.fontDisplay) {
                    this.fontDisplay.title = `${currentFont.path} (${sourceName}) — ${roleLabel}`;
                }
                if (shareButton) {
                    shareButton.classList.add('visible');
                }
            }
        }

        this.updateWindowTitle();
    }

    async updateDirtyIndicator() {
        const shouldShowIndicator =
            window.windowRole?.isMainWindow() &&
            this.shouldShowDirtyState(this.currentFont);

        if (this.currentFont?.isCloudBacked()) {
            this.dirtyIndicator!.title = shouldShowIndicator
                ? 'Cloud connection dropped; local edits may not be persisted yet'
                : 'Cloud room is connected and persisted';
        } else {
            this.dirtyIndicator!.title = 'File has unsaved changes';
        }

        // Update visual indicator
        if (shouldShowIndicator) {
            this.dirtyIndicator!.classList.add('visible');
        } else {
            this.dirtyIndicator!.classList.remove('visible');
        }

        this.updateWindowTitle();
    }

    async onOpened() {
        await this.updateFontDisplay();
        // Update save button state
        if (window.saveButton) {
            window.saveButton.updateButtonState();
        }
    }

    async onClosed() {
        await this.onOpened();
    }

    private resetStateForNewFont(): void {
        this.openedFonts.clear();
        this.currentFontId = null;
        this.editingFont = null;
        this.fullFont = null;
        this.fullFontQcSummary = null;
        this.glyphOrderCache = null;
        this.closureCache = null;
        this.editingSubsetSnapshotGlyphs = [];
        this.editingSubsetSnapshotKey = '';
        this.lastChangeSource = null;
        this.lastEditType = null;
        this.lastCompilationMode = 'full';
        this.pendingDebugEditingFontSaveAfterDrag = false;
        this.pendingBabelfontJsonSyncAfterDrag = false;
        this.forceFullEditingCacheRefresh = false;
        this.workerLayerFingerprintCache.clear();
        window.currentFontModel = null;
        (window.fontInterpolation as any)?.resetRequestTracking?.();

        if (window.glyphCanvas) {
            window.glyphCanvas.resetForOpenedFontReplacement();
        }

        if (this.fullCompileDebounceTimer) {
            clearTimeout(this.fullCompileDebounceTimer);
            this.fullCompileDebounceTimer = null;
        }
    }

    private getParentPath(path: string): string {
        const idx = path.lastIndexOf('/');
        return idx >= 0 ? path.slice(0, idx) : '';
    }

    private async collectGlyphsPackageEntries(
        rootPath: string,
        sourcePlugin: FilesystemPlugin
    ): Promise<Record<string, Uint8Array>> {
        const entries: Record<string, Uint8Array> = {};
        const requiredTopLevelFiles = new Set([
            'fontinfo.plist',
            'order.plist',
            'UIState.plist'
        ]);
        const adapter = sourcePlugin.getAdapter();

        const walk = async (currentPath: string): Promise<void> => {
            const items = await adapter.scanDirectory(currentPath);

            for (const [, data] of Object.entries(items)) {
                const itemPath = data.path;
                if (data.is_dir) {
                    await walk(itemPath);
                    continue;
                }

                const content = await adapter.readFile(itemPath);
                const bytes =
                    typeof content === 'string'
                        ? new TextEncoder().encode(content)
                        : new Uint8Array(content as any);

                const relativePath = itemPath
                    .slice(rootPath.length)
                    .replace(/^\/+/, '');

                const isGlyphFile =
                    relativePath.startsWith('glyphs/') &&
                    relativePath.endsWith('.glyph');
                const isRequiredTopLevel =
                    requiredTopLevelFiles.has(relativePath);

                if (!isGlyphFile && !isRequiredTopLevel) {
                    continue;
                }

                entries[relativePath] = bytes;
            }
        };

        await walk(rootPath);
        return entries;
    }

    private async collectAllDirectoryEntries(
        rootPath: string,
        sourcePlugin: FilesystemPlugin
    ): Promise<Record<string, Uint8Array>> {
        const entries: Record<string, Uint8Array> = {};
        const adapter = sourcePlugin.getAdapter();

        const walk = async (currentPath: string): Promise<void> => {
            const items = await adapter.scanDirectory(currentPath);

            for (const [, data] of Object.entries(items)) {
                const itemPath = data.path;
                if (data.is_dir) {
                    await walk(itemPath);
                    continue;
                }

                const content = await adapter.readFile(itemPath);
                const bytes =
                    typeof content === 'string'
                        ? new TextEncoder().encode(content)
                        : new Uint8Array(content as any);

                const relativePath = itemPath
                    .slice(rootPath.length)
                    .replace(/^\/+/, '');
                entries[relativePath] = bytes;
            }
        };

        await walk(rootPath);
        return entries;
    }

    private async readFromFileHandle(
        fileHandle: FileSystemFileHandle,
        extension: string
    ): Promise<string | Uint8Array> {
        const file = await fileHandle.getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());

        if (extension === 'babelfont') {
            return new TextDecoder('utf-8').decode(bytes);
        }

        return bytes;
    }

    private async loadBabelfontJsonFromSource(
        font: OpenedFont
    ): Promise<string> {
        const extension = font.path.split('.').pop()?.toLowerCase() || '';
        const isGlyphsPackage =
            extension === 'glyphspackage' || extension === 'glyphpackage';
        const isUfoDirectory = extension === 'ufo';
        const isDesignspace = extension === 'designspace';
        const isDetachedDiskSource =
            font.sourcePlugin.getId() === 'disk' &&
            !font.directoryHandle &&
            !!font.fileHandle;

        let contents: string | Uint8Array | undefined;
        let packageEntries: Record<string, Uint8Array> | undefined;
        let projectEntries: Record<string, Uint8Array> | undefined;

        if (isDetachedDiskSource) {
            if (isGlyphsPackage || isUfoDirectory || isDesignspace) {
                throw new Error(
                    'This source format requires folder context. Attach the containing folder in Disk context and reopen the source from there.'
                );
            }

            contents = await this.readFromFileHandle(
                font.fileHandle!,
                extension
            );
        } else if (isGlyphsPackage) {
            packageEntries = await this.collectGlyphsPackageEntries(
                font.path,
                font.sourcePlugin
            );

            if (
                !packageEntries['fontinfo.plist'] ||
                !packageEntries['order.plist']
            ) {
                throw new Error(
                    'Invalid .glyphspackage: missing fontinfo.plist or order.plist'
                );
            }
        } else if (isUfoDirectory) {
            projectEntries = await this.collectAllDirectoryEntries(
                font.path,
                font.sourcePlugin
            );
        } else if (isDesignspace) {
            const projectRoot = this.getParentPath(font.path);
            projectEntries = await this.collectAllDirectoryEntries(
                projectRoot,
                font.sourcePlugin
            );
        } else {
            contents = await font.sourcePlugin.getAdapter().readFile(font.path);
            if (extension === 'babelfont' && contents instanceof Uint8Array) {
                contents = new TextDecoder('utf-8').decode(contents);
            }
        }

        if (extension === 'babelfont') {
            return contents as string;
        }

        return await requestOpenFontConversion({
            filename: font.path.split('/').pop() || font.path,
            contents,
            packageEntries,
            projectEntries
        });
    }

    private captureGlyphCanvasState(): CapturedGlyphCanvasState | null {
        const glyphCanvas = window.glyphCanvas as any;
        if (!glyphCanvas || !glyphCanvas.textRunEditor) {
            return null;
        }

        return {
            wasEditMode: !!glyphCanvas.outlineEditor?.active,
            selectedGlyphIndex:
                typeof glyphCanvas.textRunEditor.selectedGlyphIndex === 'number'
                    ? glyphCanvas.textRunEditor.selectedGlyphIndex
                    : -1,
            selectedLayerId: glyphCanvas.outlineEditor?.selectedLayerId || null,
            cursorPosition:
                typeof glyphCanvas.textRunEditor.cursorPosition === 'number'
                    ? glyphCanvas.textRunEditor.cursorPosition
                    : 0,
            textBuffer: glyphCanvas.textRunEditor.textBuffer || '',
            variationSettings: glyphCanvas.axesManager?.variationSettings
                ? { ...glyphCanvas.axesManager.variationSettings }
                : null,
            viewport: glyphCanvas.viewportManager
                ? {
                      scale: glyphCanvas.viewportManager.scale,
                      panX: glyphCanvas.viewportManager.panX,
                      panY: glyphCanvas.viewportManager.panY
                  }
                : null
        };
    }

    private async restoreGlyphCanvasState(
        state: CapturedGlyphCanvasState
    ): Promise<void> {
        const glyphCanvas = window.glyphCanvas as any;
        if (!glyphCanvas || !glyphCanvas.textRunEditor) {
            return;
        }

        if (state.variationSettings && glyphCanvas.axesManager) {
            glyphCanvas.axesManager.variationSettings = {
                ...state.variationSettings
            };
        }

        glyphCanvas.textRunEditor.textBuffer = state.textBuffer || '';
        glyphCanvas.textRunEditor.shapeText();

        const maxCursorPosition = glyphCanvas.textRunEditor.textBuffer.length;
        glyphCanvas.textRunEditor.cursorPosition = Math.max(
            0,
            Math.min(state.cursorPosition, maxCursorPosition)
        );
        glyphCanvas.textRunEditor.updateCursorVisualPosition();

        if (state.wasEditMode && state.selectedGlyphIndex >= 0) {
            await glyphCanvas.textRunEditor.selectGlyphByIndex(
                state.selectedGlyphIndex
            );

            if (state.selectedLayerId) {
                glyphCanvas.outlineEditor.selectedLayerId =
                    state.selectedLayerId;
            }
        } else if (glyphCanvas.outlineEditor?.active) {
            glyphCanvas.exitGlyphEditMode();
        }

        if (state.viewport && glyphCanvas.viewportManager) {
            glyphCanvas.viewportManager.scale = state.viewport.scale;
            glyphCanvas.viewportManager.panX = state.viewport.panX;
            glyphCanvas.viewportManager.panY = state.viewport.panY;
        }

        glyphCanvas.render();
    }

    async reloadCurrentFontFromSource(
        options: ReloadCurrentFontOptions = {}
    ): Promise<boolean> {
        if (!this.currentFont || !this.currentFontId) {
            return false;
        }

        if (this.isExternalReloading) {
            return false;
        }

        const preserveUiState = options.preserveUiState !== false;
        const capturedUiState = preserveUiState
            ? this.captureGlyphCanvasState()
            : null;

        const previousFontId = this.currentFontId;
        const previousOpenedFont = this.currentFont;
        const previousEditingFont = this.editingFont;
        const previousGlyphOrderCache = this.glyphOrderCache;
        const previousClosureCache = this.closureCache;

        this.isExternalReloading = true;
        beginLoadingCursor();

        try {
            const babelfontJson =
                await this.loadBabelfontJsonFromSource(previousOpenedFont);

            this.recordFullFontCrossing();
            const storeResult = await fontCompilation.sendMessage({
                type: 'storeFontJson',
                babelfontJson
            });
            if (storeResult?.error) {
                throw new Error(
                    `Failed to cache externally reloaded font: ${storeResult.error}`
                );
            }

            const reloadedFont = new OpenedFont(
                babelfontJson,
                previousOpenedFont.path,
                previousOpenedFont.sourcePlugin,
                previousOpenedFont.fileHandle,
                previousOpenedFont.directoryHandle
            );

            this.openedFonts.set(previousFontId, reloadedFont);
            this.currentFontId = previousFontId;

            this.editingFont = null;
            this.glyphOrderCache = null;
            this.closureCache = null;
            this.editingSubsetSnapshotGlyphs = [];
            this.editingSubsetSnapshotKey = '';
            this.lastChangeSource = 'external-reload';

            const subsetGlyphs =
                window.glyphCanvas?.textRunEditor?.glyphNameBuffer;
            const textBuffer =
                window.glyphCanvas?.textRunEditor?.textBuffer ||
                this.currentText ||
                '';

            await this.compileEditingFont(
                textBuffer,
                this.selectedFeatures,
                subsetGlyphs && subsetGlyphs.length > 0
                    ? subsetGlyphs
                    : undefined
            );

            if (capturedUiState) {
                await this.restoreGlyphCanvasState(capturedUiState);
            }

            await this.updateFontDisplay();
            await this.updateDirtyIndicator();
            if (window.saveButton) {
                window.saveButton.updateButtonState();
            }

            window.dispatchEvent(
                new CustomEvent('fontReady', {
                    detail: { path: reloadedFont.path, reloaded: true }
                })
            );

            return true;
        } catch (error) {
            this.openedFonts.set(previousFontId, previousOpenedFont);
            this.currentFontId = previousFontId;
            this.editingFont = previousEditingFont;
            this.glyphOrderCache = previousGlyphOrderCache;
            this.closureCache = previousClosureCache;
            throw error;
        } finally {
            this.isExternalReloading = false;
            endLoadingCursor();
        }
    }

    /**
     * Initialize the font manager when a font is loaded.
     *
     * @param {string} babelfontJson - The .babelfont JSON string
     * @param {string} path - File path
     * @param {FilesystemPlugin} sourcePlugin - The filesystem plugin used to load this font
     * @param {FileSystemFileHandle} fileHandle - Optional file handle (for disk plugin)
     * @param {FileSystemDirectoryHandle} directoryHandle - Optional directory handle (for disk plugin)
     */
    async loadFont(
        babelfontJson: string,
        path: string,
        sourcePlugin: FilesystemPlugin,
        fileHandle?: FileSystemFileHandle,
        directoryHandle?: FileSystemDirectoryHandle
    ) {
        this.resetStateForNewFont();

        let newFont = new OpenedFont(
            babelfontJson,
            path,
            sourcePlugin,
            fileHandle,
            directoryHandle
        );
        let newid = `font-${Date.now()}`;
        this.openedFonts.set(newid, newFont);
        this.currentFontId = newid;
        window.currentFontModel = newFont.fontModel;

        this.editingFont = null;
        this.fullFont = null;
        this.fullFontQcSummary = null;
        this.glyphOrderCache = null; // Clear cache for new font
        this.closureCache = null;
        this.editingSubsetSnapshotGlyphs = [];
        this.editingSubsetSnapshotKey = '';

        // Reset initialFontLoaded flag in glyphCanvas when new font is loaded
        if (window.glyphCanvas) {
            window.glyphCanvas.initialFontLoaded = false;
        }

        this.updateWindowTitle();

        // Notify ChangeBridge that the font model is ready
        window.dispatchEvent(
            new CustomEvent('fontModelReady', {
                detail: {
                    path,
                    babelfontData: newFont.babelfontData
                }
            })
        );
    }

    /**
     * Get glyph names for the given text using the editing font
     *
     * @param {string} text - Text to get glyph names for
     * @returns {Promise<Array<string>>} - Array of glyph names
     */
    async getGlyphNamesForText(text: string): Promise<string[]> {
        if (!this.editingFont) {
            throw new Error('Editing font not compiled yet');
        }

        // Use the shapeTextWithFont function from font-compilation.js
        return await window.shapeTextWithFont(this.editingFont, text);
    }

    private createSubsetKey(glyphNames: string[]): string {
        return [...new Set(glyphNames)].sort().join('\u0000');
    }

    private normalizeSubsetGlyphs(glyphNames: string[]): string[] {
        const normalized: string[] = [];
        const seen = new Set<string>();
        for (const glyphName of glyphNames) {
            if (
                typeof glyphName !== 'string' ||
                !glyphName.length ||
                seen.has(glyphName)
            ) {
                continue;
            }
            normalized.push(glyphName);
            seen.add(glyphName);
        }
        return normalized;
    }

    updateEditingSubsetSnapshot(subsetGlyphs: string[]): boolean {
        const normalized = this.normalizeSubsetGlyphs(subsetGlyphs || []);
        const subsetKey = this.createSubsetKey(normalized);
        if (subsetKey === this.editingSubsetSnapshotKey) {
            return false;
        }

        this.editingSubsetSnapshotGlyphs = normalized;
        this.editingSubsetSnapshotKey = subsetKey;
        return true;
    }

    getEditingSubsetSnapshot(): string[] {
        return [...this.editingSubsetSnapshotGlyphs];
    }

    getLiveVisibleGlyphNames(): string[] {
        const glyphNameBuffer =
            window.glyphCanvas?.textRunEditor?.glyphNameBuffer || [];
        const activeGlyphName =
            window.glyphCanvas?.outlineEditor?.currentGlyphName ||
            window.glyphCanvas?.getCurrentGlyphName?.() ||
            null;

        return this.normalizeSubsetGlyphs([
            ...this.getEditingSubsetSnapshot(),
            ...glyphNameBuffer,
            ...(activeGlyphName ? [activeGlyphName] : [])
        ]);
    }

    getAutomaticCompositionDragScopeGlyphNames(
        sourceGlyphName: string,
        fontModel:
            | Pick<Font, 'findGlyphsUsingComponent'>
            | null
            | undefined = this.currentFont?.fontModel
    ): Set<string> {
        const scopedGlyphNames = new Set<string>();
        if (!sourceGlyphName || !fontModel) {
            return scopedGlyphNames;
        }

        const visibleGlyphNames = new Set(this.getLiveVisibleGlyphNames());
        visibleGlyphNames.add(sourceGlyphName);
        scopedGlyphNames.add(sourceGlyphName);

        const visibilityMemo = new Map<string, boolean>();
        const visitingGlyphNames = new Set<string>();

        const reachesVisibleGlyph = (glyphName: string): boolean => {
            if (visibilityMemo.has(glyphName)) {
                return visibilityMemo.get(glyphName)!;
            }
            if (visitingGlyphNames.has(glyphName)) {
                return false;
            }

            visitingGlyphNames.add(glyphName);

            let hasVisibleDependent = false;
            for (const dependentGlyphName of fontModel.findGlyphsUsingComponent(
                glyphName
            )) {
                if (
                    typeof dependentGlyphName !== 'string' ||
                    !dependentGlyphName.length
                ) {
                    continue;
                }

                const dependentIsVisible =
                    visibleGlyphNames.has(dependentGlyphName);
                const dependentReachesVisible =
                    reachesVisibleGlyph(dependentGlyphName);

                if (dependentIsVisible || dependentReachesVisible) {
                    scopedGlyphNames.add(dependentGlyphName);
                    hasVisibleDependent = true;
                }
            }

            visitingGlyphNames.delete(glyphName);
            visibilityMemo.set(glyphName, hasVisibleDependent);
            return hasVisibleDependent;
        };

        reachesVisibleGlyph(sourceGlyphName);
        return scopedGlyphNames;
    }

    private syncSerializedLayerIntoObjectModel(
        glyphName: string,
        layerId: string,
        layerData: Babelfont.Layer
    ): Babelfont.Layer | null {
        const currentFont = this.currentFont;
        const modelLayer = currentFont?.fontModel
            ?.findGlyph(glyphName)
            ?.findLayerById(layerId);

        if (!modelLayer) {
            return null;
        }

        if (typeof modelLayer.syncFromEditorLayerData === 'function') {
            withSuppressedModelRecording(() => {
                modelLayer.syncFromEditorLayerData({
                    width: layerData.width,
                    ...(layerData.height !== undefined
                        ? { height: layerData.height }
                        : {}),
                    ...(layerData.vertWidth !== undefined
                        ? { vertWidth: layerData.vertWidth }
                        : {}),
                    ...(layerData.shapes !== undefined
                        ? { shapes: layerData.shapes }
                        : {}),
                    ...(layerData.anchors !== undefined
                        ? { anchors: layerData.anchors }
                        : {}),
                    ...(layerData.guides !== undefined
                        ? { guides: layerData.guides }
                        : {}),
                    ...(layerData.format_specific !== undefined
                        ? { format_specific: layerData.format_specific }
                        : {})
                });
            });

            const syncedLayerData = modelLayer.toJSON() as Babelfont.Layer &
                Record<string, unknown>;
            Object.assign(syncedLayerData, {
                ...(layerData.name !== undefined
                    ? { name: layerData.name }
                    : {}),
                ...(layerData.location !== undefined
                    ? { location: layerData.location }
                    : {}),
                ...(layerData.color !== undefined
                    ? { color: layerData.color }
                    : {}),
                ...(layerData.background_layer_id !== undefined
                    ? {
                          background_layer_id: layerData.background_layer_id
                      }
                    : {}),
                ...(layerData.layer_index !== undefined
                    ? { layer_index: layerData.layer_index }
                    : {}),
                ...(layerData.is_background !== undefined
                    ? { is_background: layerData.is_background }
                    : {}),
                ...(layerData.master !== undefined
                    ? { master: layerData.master }
                    : {}),
                id: layerId
            });

            modelLayer.invalidateContentCaches();
            return syncedLayerData;
        }

        const rawLayerData = modelLayer.toJSON() as Babelfont.Layer &
            Record<string, unknown>;
        Object.assign(rawLayerData, layerData);

        modelLayer.invalidateContentCaches();

        return rawLayerData;
    }

    private normalizeComponentTransformForRust(
        transform: unknown
    ): Babelfont.DecomposedAffine {
        if (Array.isArray(transform)) {
            return DecomposedAffineTransform.fromAffine(transform);
        }

        const identity = DecomposedAffineTransform.identity();
        if (!transform || typeof transform !== 'object') {
            return identity;
        }

        const record = transform as Record<string, unknown>;
        const translation = Array.isArray(record.translation)
            ? [
                  Number(record.translation[0]) || 0,
                  Number(record.translation[1]) || 0
              ]
            : [0, 0];
        const scale = Array.isArray(record.scale)
            ? [Number(record.scale[0]) || 1, Number(record.scale[1]) || 1]
            : [1, 1];
        const rawSkew = Array.isArray(record.skew)
            ? record.skew
            : [record.skew ?? 0, 0];
        const skew = [Number(rawSkew[0]) || 0, Number(rawSkew[1]) || 0] as [
            number,
            number
        ];
        const rotation = Number(record.rotation) || 0;
        const order =
            record.order === 'Glyphs' || record.order === 'RestOfTheWorld'
                ? (record.order as Babelfont.TransformOrder)
                : identity.order;

        return {
            translation: translation as [number, number],
            scale: scale as [number, number],
            rotation,
            skew,
            order
        };
    }

    private normalizeShapeForRust(shape: any): any {
        if (!shape || typeof shape !== 'object' || Array.isArray(shape)) {
            return shape;
        }

        const hasPathWrapper =
            'Path' in shape && shape.Path && typeof shape.Path === 'object';
        const hasComponentWrapper =
            'Component' in shape &&
            shape.Component &&
            typeof shape.Component === 'object';
        const hasFlatPathFields = 'nodes' in shape;
        const hasFlatComponentFields = 'reference' in shape;

        if ((hasPathWrapper || hasFlatPathFields) && hasFlatComponentFields) {
            console.warn(
                '[FontManager] Normalizing invalid hybrid shape to path payload during Rust normalization',
                shape
            );
        }

        const pathCandidate = hasPathWrapper ? shape.Path : shape;

        if ('nodes' in pathCandidate) {
            let nodesValue = pathCandidate.nodes;
            if (Array.isArray(nodesValue)) {
                nodesValue = Path.nodesToString(nodesValue);
            }

            return {
                nodes: nodesValue,
                closed: pathCandidate.closed,
                ...(pathCandidate.format_specific && {
                    format_specific: pathCandidate.format_specific
                })
            };
        }

        const componentCandidate = hasComponentWrapper
            ? shape.Component
            : shape;

        if ('reference' in componentCandidate && !hasFlatPathFields) {
            return {
                reference: componentCandidate.reference,
                transform: this.normalizeComponentTransformForRust(
                    componentCandidate.transform
                ),
                ...(componentCandidate.location && {
                    location: componentCandidate.location
                }),
                ...(componentCandidate.format_specific && {
                    format_specific: componentCandidate.format_specific
                })
            };
        }

        return { ...shape };
    }

    private normalizeLayerForRust(layerData: any): any {
        if (!layerData || typeof layerData !== 'object') {
            return layerData;
        }

        const shapes = Array.isArray(layerData.shapes)
            ? layerData.shapes.map((shape: any) =>
                  this.normalizeShapeForRust(shape)
              )
            : [];

        return {
            ...layerData,
            shapes,
            ...(Array.isArray(layerData.anchors)
                ? {
                      anchors: layerData.anchors.map((anchor: any) => ({
                          name: anchor?.name,
                          x: anchor?.x,
                          y: anchor?.y
                      }))
                  }
                : {}),
            ...(Array.isArray(layerData.guides)
                ? {
                      guides: layerData.guides.map((guide: any) => ({
                          pos: {
                              x: guide?.pos?.x,
                              y: guide?.pos?.y,
                              angle: guide?.pos?.angle
                          },
                          name: guide?.name,
                          ...(guide?.color && { color: guide.color })
                      }))
                  }
                : {})
        };
    }

    /**
     * Compile the editing font for display in canvas.
     * Subset to the provided glyph names for faster compilation.
     *
     * @param {string} text - Text being edited (stored for recompilation)
     * @param {Array<string>} features - Selected OpenType features (stored for recompilation)
     * @param {Array<string>} subsetGlyphs - Glyph names to include in the subset
     */
    async compileEditingFont(
        text: string = '',
        features: string[] = [],
        subsetGlyphs?: string[]
    ) {
        if (!this.currentFont) {
            throw new Error('No font loaded');
        }

        if (!fontCompilation || !fontCompilation.isInitialized) {
            throw new Error('Font compilation system not initialized');
        }

        // Store current text and features for future use
        this.currentText = text;
        this.selectedFeatures = features;

        const compileSource = this.lastChangeSource || 'unknown';
        const isIncrementalEditingCompile =
            compileSource.startsWith('mouse-drag') ||
            compileSource.startsWith('keyboard') ||
            compileSource.startsWith('remote-');
        const isMouseDragSource = compileSource.startsWith('mouse-drag');
        const isKeyboardSource = compileSource.startsWith('keyboard');
        const isRemoteSource = compileSource.startsWith('remote-');
        const forceFullWorkerCompileAtStart = this.forceFullEditingCacheRefresh;
        const shouldPrepareIncrementalLayerUpdate =
            (isMouseDragSource || isKeyboardSource) &&
            !forceFullWorkerCompileAtStart;
        const activeDirtyGlyphName = shouldPrepareIncrementalLayerUpdate
            ? window.glyphCanvas?.outlineEditor?.currentGlyphName ||
              window.glyphCanvas?.getCurrentGlyphName?.() ||
              null
            : null;
        const activeDirtyLayerId = shouldPrepareIncrementalLayerUpdate
            ? window.glyphCanvas?.outlineEditor?.selectedLayerId || null
            : null;
        const canUseIncrementalDirtyLayerPatch = (() => {
            if (!activeDirtyGlyphName || !activeDirtyLayerId) {
                return false;
            }

            const dirtyGlyph = this.currentFont.fontModel?.glyphs?.find(
                (glyph: any) => glyph?.name === activeDirtyGlyphName
            );
            if (!dirtyGlyph) {
                return false;
            }

            return dirtyGlyph.layers?.some(
                (layer: any) => layer?.id === activeDirtyLayerId
            );
        })();

        // Capture whether JSON was stale before sync clears the flag,
        // so validateAndFixBabelfontJsonForRust knows to run.
        const wasJsonStale = this.pendingBabelfontJsonSyncAfterDrag;

        // Always sync when the JSON is stale (e.g. after undo/redo/remote sync),
        // even during incremental editing compiles, so the Rust compiler never
        // receives array-format nodes or other stale format artifacts.
        if (
            !isIncrementalEditingCompile ||
            (wasJsonStale && !canUseIncrementalDirtyLayerPatch)
        ) {
            if (!this.syncBabelfontJsonFromCurrentModel()) {
                throw new Error(
                    'Failed to sync font model before editing compile'
                );
            }
            this.pendingBabelfontJsonSyncAfterDrag = false;
        }

        const startTime = performance.now();
        const compileEditingSpanId = timelineSpanStart('font.compileEditing', {
            textBuffer: text,
            features,
            subsetGlyphs: subsetGlyphs || []
        });

        let consumedStartupCompileSlot = false;

        try {
            // Compute layout closure subset
            let glyphsToInclude = subsetGlyphs;
            if (!glyphsToInclude || glyphsToInclude.length === 0) {
                const fallbackText =
                    text ||
                    window.glyphCanvas?.textRunEditor?.textBuffer ||
                    this.currentText ||
                    localStorage.getItem('glyphCanvasTextBuffer') ||
                    'Hamburgevons';
                glyphsToInclude = this.deriveSubsetGlyphsFromText(fallbackText);
                if (glyphsToInclude.length > 0) {
                    this.updateEditingSubsetSnapshot(glyphsToInclude);
                }

                if (!glyphsToInclude.length) {
                    const snapshotSubsetGlyphs =
                        this.getEditingSubsetSnapshot();
                    if (snapshotSubsetGlyphs.length > 0) {
                        glyphsToInclude = snapshotSubsetGlyphs;
                    } else {
                        const fallbackSubsetGlyphs =
                            window.glyphCanvas?.textRunEditor
                                ?.glyphNameBuffer || [];
                        if (fallbackSubsetGlyphs.length > 0) {
                            glyphsToInclude = fallbackSubsetGlyphs;
                        } else {
                            console.log(
                                '[FontManager] Skipping editing font compile without subset glyphs'
                            );
                            return this.editingFont;
                        }
                    }
                }
            } else {
                this.updateEditingSubsetSnapshot(glyphsToInclude);
            }

            const activeEditedGlyphName =
                window.glyphCanvas?.outlineEditor?.currentGlyphName ||
                window.glyphCanvas?.getCurrentGlyphName?.();
            if (
                activeEditedGlyphName &&
                !glyphsToInclude.includes(activeEditedGlyphName)
            ) {
                glyphsToInclude = [...glyphsToInclude, activeEditedGlyphName];
                this.updateEditingSubsetSnapshot(glyphsToInclude);
            }

            if (startupOpenSessionActive) {
                if (startupOpenSessionEditingCompileCount >= 1) {
                    console.log(
                        '[FontManager] Skipping extra editing compile during font.openSession'
                    );
                    return this.editingFont;
                }
                startupOpenSessionEditingCompileCount += 1;
                consumedStartupCompileSlot = true;
            }

            const baseSubsetGlyphs = glyphsToInclude;

            const closureToCompileBridgeSpanId = timelineSpanStart(
                'font.compileEditing.closureToCompileBridge',
                {
                    subsetGlyphCount: glyphsToInclude?.length || 0
                }
            );

            // Compile editing font with layout closure subset
            console.log(
                `🔨 Compiling editing font, subset_glyphs: ${glyphsToInclude ? glyphsToInclude.length + ' glyphs' : 'none (full font)'}`
            );
            let result;
            let responseRevisionKey = String(
                this.currentFont.compileRequestVersion
            );
            let incrementalChangeSource = this.lastChangeSource;
            let dragActiveAtRequest = false;
            let compilationMode:
                | 'full'
                | 'outline-only'
                | 'anchor-only'
                | 'text-input' = 'full';
            try {
                timelineMark(
                    'font.compileEditing.closureToCompileBridge.beforeCompileFromJson'
                );

                const normalizeSubsetSpanId = timelineSpanStart(
                    'font.compileEditing.normalizeSubsetForCompile',
                    {
                        subsetGlyphCount: baseSubsetGlyphs?.length || 0
                    }
                );
                const subsetForCompile = baseSubsetGlyphs
                    ? [...baseSubsetGlyphs]
                    : baseSubsetGlyphs;
                timelineSpanEnd(normalizeSubsetSpanId);

                const requestedRevisionKey = String(
                    this.currentFont.compileRequestVersion
                );
                incrementalChangeSource = this.lastChangeSource;
                const editTypeAtRequest = this.lastEditType;
                dragActiveAtRequest =
                    isMouseDragSource ||
                    !!window.glyphCanvas?.outlineEditor?.draggingSomething;
                const forceFullWorkerCompile = forceFullWorkerCompileAtStart;
                if (forceFullWorkerCompile) {
                    this.forceFullEditingCacheRefresh = false;
                }
                let dirtyLayerUpdates:
                    | Array<{
                          glyphName: string;
                          layerId: string;
                          layerData: unknown;
                      }>
                    | undefined;
                const isInteractiveSource =
                    isMouseDragSource || isKeyboardSource;
                const shouldSendIncrementalLayer =
                    isInteractiveSource && !forceFullWorkerCompile;
                if (
                    shouldSendIncrementalLayer &&
                    activeDirtyGlyphName &&
                    activeDirtyLayerId
                ) {
                    const dirtyGlyph = this.currentFont.fontModel?.glyphs?.find(
                        (glyph: any) => glyph?.name === activeDirtyGlyphName
                    );
                    if (dirtyGlyph) {
                        const dirtyLayer = dirtyGlyph.layers?.find(
                            (layer: any) => layer?.id === activeDirtyLayerId
                        );
                        if (dirtyLayer) {
                            const rawDirtyLayer =
                                typeof dirtyLayer.toJSON === 'function'
                                    ? dirtyLayer.toJSON()
                                    : dirtyLayer;
                            dirtyLayerUpdates = [
                                {
                                    glyphName: activeDirtyGlyphName,
                                    layerId: activeDirtyLayerId,
                                    layerData:
                                        this.normalizeLayerForRust(
                                            rawDirtyLayer
                                        )
                                }
                            ];
                        }
                    }
                }

                // Determine compilation mode based on edit type
                const isInteractiveEdit =
                    isInteractiveSource &&
                    (dragActiveAtRequest || isKeyboardSource);
                // Remote edits use the same fast-path mode as the
                // original edit (anchor-only / outline-only) so the
                // linked window's editing compile is efficient.
                const isRemoteFastPathEdit =
                    isRemoteSource && editTypeAtRequest !== null;
                const isTextInputEdit =
                    incrementalChangeSource === 'text-input';
                compilationMode = 'full';
                let optionOverrides:
                    | {
                          skip_features?: boolean;
                          skip_kerning?: boolean;
                          produce_varc_table?: boolean;
                      }
                    | undefined;
                const shouldForceStoreFontJson =
                    fontCompilation.lastStoredFontJson === null;
                if (
                    (isInteractiveEdit || isRemoteFastPathEdit) &&
                    editTypeAtRequest === 'outline'
                ) {
                    compilationMode = 'outline-only';
                    optionOverrides = {
                        skip_features: true,
                        skip_kerning: true,
                        produce_varc_table: false
                    };
                } else if (
                    (isInteractiveEdit || isRemoteFastPathEdit) &&
                    editTypeAtRequest === 'anchor'
                ) {
                    compilationMode = 'anchor-only';
                    optionOverrides = {
                        produce_varc_table: false
                    };
                } else if (isTextInputEdit) {
                    // Text typing: font data unchanged, only subset changed.
                    // Features and kerning must stay ON — Arabic and other
                    // connected scripts rely on them to keep letters joined.
                    // A deferred full compile fires after typing settles.
                    compilationMode = 'text-input';
                    optionOverrides = {
                        produce_varc_table: false
                    };
                }

                // Pre-compilation validation: scan for array-format nodes that
                // the Rust serde parser cannot handle (expects strings).
                // Also catches other "map where sequence expected" issues.
                const jsonToSend = this.currentFont.babelfontJson;
                // Always validate after undo/redo (wasJsonStale) to catch
                // Y.Doc roundtrip corruption that toJSONString's replacer
                // may miss (e.g. wrapped shapes from Y.Map with numeric keys)
                const validatedJson = this.validateAndFixBabelfontJsonForRust(
                    jsonToSend,
                    wasJsonStale || this.pendingBabelfontJsonSyncAfterDrag
                );

                result = await fontCompilation.compileEditingFromJsonCached(
                    validatedJson,
                    requestedRevisionKey,
                    subsetForCompile ?? [],
                    {
                        dragActive: dragActiveAtRequest,
                        compileSource: incrementalChangeSource || undefined,
                        dirtyLayerUpdates,
                        forceStoreFontJson: shouldForceStoreFontJson,
                        optionOverrides
                    }
                );

                timelineMark(
                    'font.compileEditing.closureToCompileBridge.compileResultReceived'
                );

                const currentRevisionKey = String(
                    this.currentFont.compileRequestVersion
                );
                responseRevisionKey = String(
                    result.fontRevisionKey || requestedRevisionKey
                );
                if (responseRevisionKey !== currentRevisionKey) {
                    timelineMark('font.compileEditing.staleResultObserved');
                }

                timelineMark(
                    'font.compileEditing.closureToCompileBridge.afterCompileFromJson'
                );
            } finally {
                timelineSpanEnd(closureToCompileBridgeSpanId);
            }

            const applyCompiledResultSpanId = timelineSpanStart(
                'font.compileEditing.applyCompiledResult',
                { byteLength: result.result.byteLength }
            );
            this.editingFont = new Uint8Array(result.result);
            timelineSpanEnd(applyCompiledResultSpanId);
            const duration = (performance.now() - startTime).toFixed(2);

            const sourceInfo = incrementalChangeSource
                ? ` [triggered by: ${incrementalChangeSource}]`
                : '';
            console.log(
                `✅ Editing font compiled in ${duration}ms (${this.editingFont.length} bytes)${sourceInfo}`
            );

            // Hide any error messages in sidebar
            sidebarErrorDisplay.hideError();

            // Save debug editing font unless we're actively dragging points/anchors/components
            const isOutlineDragActive = dragActiveAtRequest;

            const debugSaveSpanId = timelineSpanStart(
                'font.compileEditing.debugFontSaveCheck',
                {
                    saveDebugFonts:
                        APP_SETTINGS.FONT_MANAGER?.SAVE_DEBUG_FONTS === true,
                    isOutlineDragActive
                }
            );
            if (isOutlineDragActive) {
                this.pendingDebugEditingFontSaveAfterDrag = true;
            } else {
                this.saveEditingFontToFileSystem();
                this.pendingDebugEditingFontSaveAfterDrag = false;
            }
            timelineSpanEnd(debugSaveSpanId);

            // Track compilation mode for axis/layer switch gating
            this.lastCompilationMode = compilationMode;

            // Dispatch event to notify canvas that new font is ready
            timelineMark(
                'font.compileEditing.dispatchEvent.editingFontCompiled'
            );
            window.dispatchEvent(
                new CustomEvent('editingFontCompiled', {
                    detail: {
                        fontBytes: this.editingFont,
                        fontPath: this.currentFont.path,
                        duration: duration,
                        fontRevisionKey: responseRevisionKey,
                        dragActive: dragActiveAtRequest,
                        compilationMode
                    }
                })
            );
            timelineMark(
                'font.compileEditing.dispatchEvent.editingFontCompiled.done'
            );

            return this.editingFont;
        } catch (error) {
            if (
                consumedStartupCompileSlot &&
                startupOpenSessionEditingCompileCount > 0
            ) {
                startupOpenSessionEditingCompileCount -= 1;
            }
            console.error('❌ Failed to compile editing font:', error);
            // Log the problematic JSON area when Rust reports a line/column
            const errorMsg = (error as Error)?.message || String(error);
            if (
                errorMsg.includes('expected a sequence') ||
                errorMsg.includes('expected a map') ||
                errorMsg.includes('did not match any variant')
            ) {
                const lineMatch = errorMsg.match(/line (\d+)/);
                const colMatch = errorMsg.match(/column (\d+)/);
                if (lineMatch && colMatch) {
                    const lineNum = parseInt(lineMatch[1]);
                    const colNum = parseInt(colMatch[1]);
                    const jsonStr = this.currentFont?.babelfontJson || '';
                    const lines = jsonStr.split('\n');
                    if (lineNum > 0 && lineNum <= lines.length) {
                        const problemLine = lines[lineNum - 1];
                        const start = Math.max(0, colNum - 40);
                        const end = Math.min(problemLine.length, colNum + 40);
                        // Also scan backwards to find the enclosing shape object
                        let shapeStart = lineNum - 1;
                        while (
                            shapeStart > 0 &&
                            !lines[shapeStart - 1].match(/"shapes"/)
                        ) {
                            shapeStart--;
                            if (lineNum - shapeStart > 50) break;
                        }
                        console.error(
                            `[FontManager] Rust parse error context at line ${lineNum}, col ${colNum}:\n` +
                                `  ...${problemLine.substring(start, end)}...\n` +
                                `  Surrounding lines (${shapeStart + 1}-${Math.min(lineNum + 2, lines.length)}):\n` +
                                lines
                                    .slice(
                                        Math.max(shapeStart - 2, 0),
                                        Math.min(lineNum + 2, lines.length)
                                    )
                                    .map(
                                        (l: string, i: number) =>
                                            `  ${shapeStart - 1 + i}: ${l.substring(0, 300)}`
                                    )
                                    .join('\n')
                        );
                    }
                }
            }
            sidebarErrorDisplay.showError(error, 'editing');
            throw error;
        } finally {
            timelineSpanEnd(compileEditingSpanId);
        }
    }

    deriveSubsetGlyphsFromText(text: string): string[] {
        const fontModel = this.currentFont?.fontModel;
        if (!fontModel || !text) {
            return [];
        }

        const subset: string[] = [];
        const seen = new Set<string>();

        const pushGlyph = (name?: string) => {
            if (!name || seen.has(name)) {
                return;
            }
            subset.push(name);
            seen.add(name);
        };

        let index = 0;
        while (index < text.length) {
            const char = text[index];

            if (
                char === '/' &&
                index + 1 < text.length &&
                text[index + 1] === '/'
            ) {
                const slashGlyph = fontModel.findGlyphByCodepoint(
                    '/'.codePointAt(0)!
                );
                pushGlyph(slashGlyph?.name);
                index += 2;
                continue;
            }

            if (char === '/') {
                let cursor = index + 1;
                while (
                    cursor < text.length &&
                    text[cursor] !== '/' &&
                    !/\s/.test(text[cursor])
                ) {
                    cursor++;
                }

                const tokenName = text.slice(index + 1, cursor);
                const terminator = cursor < text.length ? text[cursor] : '';
                const validTerminator =
                    terminator === '/' ||
                    terminator === '' ||
                    /\s/.test(terminator);

                if (tokenName && validTerminator) {
                    const tokenGlyph = fontModel.findGlyph(tokenName);
                    if (tokenGlyph?.name) {
                        pushGlyph(tokenGlyph.name);
                        index = cursor;
                        if (terminator === '/') {
                            index += 1;
                        } else if (terminator && /\s/.test(terminator)) {
                            index += 1;
                        }
                        continue;
                    }
                }
            }

            const codepoint = text.codePointAt(index);
            if (codepoint !== undefined) {
                const glyph = fontModel.findGlyphByCodepoint(codepoint);
                pushGlyph(glyph?.name);
                index += codepoint > 0xffff ? 2 : 1;
            } else {
                index += 1;
            }
        }

        return subset;
    }

    /**
     * Recompile editing font after font data changes
     * Implements continuous fresh-start compilation: if data changes during
     * compilation, marks dirty again so the auto-compile loop will trigger
     * a fresh compilation with the latest data.
     * Returns true if data changed during compilation and needs another compile.
     */
    async recompileEditingFont(): Promise<boolean> {
        if (!this.currentFont) return false;

        // Multi-layer structural edits can enqueue an explicit worker cache
        // refresh before requesting recompilation. Wait for that refresh so the
        // editing-font compile never races against stale Rust cache contents.
        await this.awaitWorkerCacheUpdate();

        // Capture change version at start of compilation
        const startChangeVersion = this.currentFont.changeVersion;
        const startCompileRequestVersion =
            this.currentFont.compileRequestVersion;

        const changeSource = this.lastChangeSource || 'unknown';
        const isOutlineIncrementalChange =
            changeSource.startsWith('mouse-drag') ||
            changeSource.startsWith('keyboard');

        let subsetGlyphs = this.getEditingSubsetSnapshot();

        if (subsetGlyphs.length === 0) {
            const fallbackText =
                this.currentText ||
                window.glyphCanvas?.textRunEditor?.textBuffer ||
                localStorage.getItem('glyphCanvasTextBuffer') ||
                'Hamburgevons';
            subsetGlyphs = this.deriveSubsetGlyphsFromText(fallbackText);
            if (subsetGlyphs.length > 0) {
                this.updateEditingSubsetSnapshot(subsetGlyphs);
            }
        }

        if (subsetGlyphs.length === 0 && !isOutlineIncrementalChange) {
            subsetGlyphs =
                window.glyphCanvas?.textRunEditor?.glyphNameBuffer || [];
        }

        // Compile with current data
        await this.compileEditingFont(
            this.currentText,
            this.selectedFeatures,
            subsetGlyphs.length > 0 ? subsetGlyphs : undefined
        );

        // After compilation, check if data changed during the compilation
        if (
            this.currentFont.compileRequestVersion !==
            startCompileRequestVersion
        ) {
            // Another compile request arrived while this compile was in flight.
            // Keep the compile flag enabled so the auto-compile loop produces
            // a fresh result, even when the new request did not mutate font data.
            console.log(
                `[FontManager] Compile request changed during compilation (data v${startChangeVersion} → v${this.currentFont.changeVersion}, compile v${startCompileRequestVersion} → v${this.currentFont.compileRequestVersion}), marking for recompile...`
            );
            return true; // Indicates recompilation needed
        } else {
            // No changes occurred during compilation, safe to clear compile flag
            this.currentFont.needsRecompile = false;
            return false; // No recompilation needed
        }
    }

    /**
     * Save compiled fonts to file system for review
     */
    saveFontsToFileSystem() {
        this.saveEditingFontToFileSystem();
        this.saveFullFontToFileSystem();
    }

    /**
     * Save editing font to file system
     */
    saveEditingFontToFileSystem() {
        if (!APP_SETTINGS.FONT_MANAGER?.SAVE_DEBUG_FONTS) {
            return; // Feature disabled in settings
        }

        if (!this.editingFont) {
            return;
        }

        window.uploadFiles(
            [
                new File(
                    [this.editingFont as Uint8Array<ArrayBuffer>],
                    '_debug_editing_font.ttf',
                    { type: 'font/ttf' }
                )
            ],
            {
                directory: '/user',
                pluginId: 'memory'
            }
        );
    }

    /**
     * Save full font to file system
     */
    saveFullFontToFileSystem() {
        if (!APP_SETTINGS.FONT_MANAGER?.SAVE_DEBUG_FONTS) {
            return; // Feature disabled in settings
        }

        if (!this.fullFont) {
            return;
        }

        window.uploadFiles(
            [
                new File(
                    [this.fullFont as Uint8Array<ArrayBuffer>],
                    '_debug_full_font.ttf',
                    { type: 'font/ttf' }
                )
            ],
            {
                directory: '/user',
                pluginId: 'memory'
            }
        );
    }

    flushPendingDebugEditingFontSaveAfterDrag() {
        if (!this.pendingDebugEditingFontSaveAfterDrag) {
            return;
        }

        if (window.glyphCanvas?.outlineEditor?.draggingSomething) {
            return;
        }

        if (this.currentFont?.needsRecompile) {
            return;
        }

        if (!this.editingFont) {
            return;
        }

        this.saveEditingFontToFileSystem();
        this.pendingDebugEditingFontSaveAfterDrag = false;
    }

    /**
     * Schedule a debounced full compile after interactive editing stops.
     * Resets on each call, so rapid edits (keyboard/drag) only trigger one
     * full compile after the last edit + delay.
     */
    scheduleFullCompileDebounce(): void {
        if (this.fullCompileDebounceTimer) {
            clearTimeout(this.fullCompileDebounceTimer);
        }
        this.fullCompileDebounceTimer = setTimeout(() => {
            this.fullCompileDebounceTimer = null;
            if (window.glyphCanvas?.outlineEditor?.draggingSomething) {
                console.log(
                    '[FontManager] Debounced full compile postponed until drag ends'
                );
                this.scheduleFullCompileDebounce();
                return;
            }
            if (this.lastCompilationMode !== 'full' && this.currentFont) {
                console.log(
                    '[FontManager] Debounced full compile triggered after interactive editing'
                );

                if (this.pendingBabelfontJsonSyncAfterDrag) {
                    if (!this.syncBabelfontJsonFromCurrentModel()) {
                        return;
                    }
                    this.pendingBabelfontJsonSyncAfterDrag = false;
                }

                // Reset lastEditType so the upcoming compile uses compilationMode = 'full'
                // (with kern/features). Do this regardless of needsRecompile — if a compile
                // is still in progress, the auto-compile loop's data-changed retry will pick
                // up lastEditType = null and produce a full compile instead of outline-only.
                this.lastChangeSource =
                    'debounced-post-interaction-full-compile';
                this.lastEditType = null;
                this.currentFont.requestRecompileWithoutDataChange();
                window.autoCompileManager.checkAndSchedule();
            }
        }, 500);
    }

    /**
     * Ensure a full editing font (with features/kerning) has been compiled.
     * Call this before axis slider changes or layer switches that depend
     * on correct HarfBuzz positioning.
     * Returns a promise that resolves when the full compile is ready.
     */
    async ensureFullEditingCompile(): Promise<void> {
        if (this.lastCompilationMode === 'full') {
            return; // Already have a full compile
        }
        // Cancel pending debounce — we need it now
        if (this.fullCompileDebounceTimer) {
            clearTimeout(this.fullCompileDebounceTimer);
            this.fullCompileDebounceTimer = null;
        }
        console.log(
            '[FontManager] Forcing full compile before axis/layer change'
        );
        this.lastEditType = null;
        this.currentFont?.requestRecompileWithoutDataChange();
        window.autoCompileManager.checkAndSchedule();
        // Wait for the compile to finish
        await new Promise<void>((resolve) => {
            const handler = () => {
                window.removeEventListener('editingFontCompiled', handler);
                resolve();
            };
            window.addEventListener('editingFontCompiled', handler);
        });
    }

    /**
     * Validate and fix babelfont JSON for Rust serde compatibility.
     * Scans for array-format nodes and objects-that-should-be-arrays
     * (from Y.Doc roundtrips where Y.Map is used instead of Y.Array).
     * Returns the fixed JSON string.
     */
    private validateAndFixBabelfontJsonForRust(
        babelfontJson: string,
        forceValidation: boolean = false
    ): string {
        // Only run full validation when needed
        const needsValidation =
            babelfontJson.includes('"nodes":[') ||
            babelfontJson.includes('"nodes": [') ||
            forceValidation ||
            this.pendingBabelfontJsonSyncAfterDrag;

        if (!needsValidation) {
            return babelfontJson;
        }

        // Memoize: validation is a pure function of the input string.
        // During a stream of interactive edits, `currentFont.babelfontJson`
        // is not re-synced from the model (sync is deferred to the
        // debounced full compile), so the same string is otherwise
        // re-validated on every keystroke at ~50 ms a pop. Reference
        // equality is sufficient: a new string means new content; an
        // identical string means identical (already-validated) content.
        const cached = this._validatedBabelfontJsonCache;
        if (cached && cached.input === babelfontJson) {
            return cached.output;
        }

        const cacheAndReturn = (output: string): string => {
            this._validatedBabelfontJsonCache = {
                input: babelfontJson,
                output
            };
            return output;
        };

        // Parse, fix, re-serialize
        try {
            const data = JSON.parse(babelfontJson);
            let fixCount = 0;
            const knownMasterIds = new Set(
                Array.isArray(data?.masters)
                    ? data.masters
                          .map((master: any) =>
                              master && typeof master === 'object'
                                  ? String(master.id || '')
                                  : ''
                          )
                          .filter(Boolean)
                    : []
            );

            // Fields that must always be arrays in babelfont format
            const arrayFields = new Set([
                'shapes',
                'anchors',
                'guides',
                'layers',
                'glyphs',
                'masters',
                'instances',
                'axes',
                'map',
                'codepoints',
                'kerning'
            ]);

            /** Convert a plain object with numeric keys like {"0":..., "1":...} back to an array */
            const numericKeyObjectToArray = (obj: any): any[] => {
                const keys = Object.keys(obj);
                if (keys.length === 0) return [];
                const indices = keys.map((k) => parseInt(k, 10));
                if (
                    !indices.every((i) => !isNaN(i) && i >= 0) ||
                    !keys.every((k) => String(parseInt(k, 10)) === k)
                ) {
                    // Not purely numeric keys — shouldn't convert
                    return [];
                }
                const maxIdx = Math.max(...indices);
                const arr: any[] = new Array(maxIdx + 1);
                for (let i = 0; i < keys.length; i++) {
                    arr[indices[i]] = obj[keys[i]];
                }
                return arr;
            };

            const normalizeLayerMasterValue = (
                masterValue: any,
                isBackground: boolean,
                layerId: string
            ): Record<string, unknown> | null => {
                if (typeof masterValue === 'string' && masterValue.length) {
                    return {
                        type: 'DefaultForMaster',
                        master: masterValue
                    };
                }

                if (
                    !masterValue ||
                    typeof masterValue !== 'object' ||
                    Array.isArray(masterValue)
                ) {
                    if (!isBackground && knownMasterIds.has(layerId)) {
                        return {
                            type: 'DefaultForMaster',
                            master: layerId
                        };
                    }
                    return null;
                }

                if (masterValue.type === 'FreeFloating') {
                    return { type: 'FreeFloating' };
                }

                if (
                    (masterValue.type === 'DefaultForMaster' ||
                        masterValue.type === 'AssociatedWithMaster') &&
                    typeof masterValue.master === 'string' &&
                    masterValue.master.length
                ) {
                    return {
                        type: masterValue.type,
                        master: masterValue.master
                    };
                }

                if (
                    typeof masterValue.master === 'string' &&
                    masterValue.master.length
                ) {
                    return {
                        type: 'DefaultForMaster',
                        master: masterValue.master
                    };
                }

                if (
                    typeof masterValue.DefaultForMaster === 'string' &&
                    masterValue.DefaultForMaster.length
                ) {
                    return {
                        type: 'DefaultForMaster',
                        master: masterValue.DefaultForMaster
                    };
                }

                if (
                    typeof masterValue.default_for_master === 'string' &&
                    masterValue.default_for_master.length
                ) {
                    return {
                        type: 'DefaultForMaster',
                        master: masterValue.default_for_master
                    };
                }

                if (
                    typeof masterValue.AssociatedWithMaster === 'string' &&
                    masterValue.AssociatedWithMaster.length
                ) {
                    return {
                        type: 'AssociatedWithMaster',
                        master: masterValue.AssociatedWithMaster
                    };
                }

                if (
                    typeof masterValue.associated_with_master === 'string' &&
                    masterValue.associated_with_master.length
                ) {
                    return {
                        type: 'AssociatedWithMaster',
                        master: masterValue.associated_with_master
                    };
                }

                if ('FreeFloating' in masterValue) {
                    return { type: 'FreeFloating' };
                }

                if (!isBackground && knownMasterIds.has(layerId)) {
                    return {
                        type: 'DefaultForMaster',
                        master: layerId
                    };
                }

                return null;
            };

            const canonicalizeGlyphLayerIdentities = (
                glyph: any,
                glyphPath: string
            ): void => {
                if (!glyph || !Array.isArray(glyph.layers)) {
                    return;
                }

                for (const layer of glyph.layers) {
                    if (!layer || typeof layer !== 'object') {
                        continue;
                    }

                    const layerId =
                        typeof layer.id === 'string' ? layer.id : '';
                    const normalizedMaster = normalizeLayerMasterValue(
                        layer.master,
                        layer.is_background === true,
                        layerId
                    );

                    if (normalizedMaster) {
                        const masterChanged =
                            JSON.stringify(layer.master ?? null) !==
                            JSON.stringify(normalizedMaster);
                        if (masterChanged) {
                            layer.master = normalizedMaster;
                            fixCount++;
                        }

                        if (
                            normalizedMaster.type === 'DefaultForMaster' &&
                            typeof normalizedMaster.master === 'string' &&
                            normalizedMaster.master.length
                        ) {
                            const canonicalLayerId = normalizedMaster.master;
                            const conflictingLayer = glyph.layers.find(
                                (candidate: any) =>
                                    candidate !== layer &&
                                    candidate &&
                                    typeof candidate.id === 'string' &&
                                    candidate.id === canonicalLayerId
                            );

                            if (
                                !conflictingLayer &&
                                layer.id !== canonicalLayerId
                            ) {
                                layer.id = canonicalLayerId;
                                fixCount++;
                                console.warn(
                                    `[FontManager] Canonicalized default layer id at ${glyphPath} from ${layerId || '[missing]'} to ${canonicalLayerId}`
                                );
                            }
                        }
                    }
                }
            };

            if (Array.isArray(data?.glyphs)) {
                data.glyphs.forEach((glyph: any, index: number) => {
                    canonicalizeGlyphLayerIdentities(glyph, `glyphs[${index}]`);
                });
            }

            const fixValue = (val: any, path: string = ''): void => {
                if (!val || typeof val !== 'object') return;

                if (Array.isArray(val)) {
                    // Recurse into array items (e.g. shapes inside a glyphs array)
                    for (let i = 0; i < val.length; i++) {
                        fixValue(val[i], `${path}[${i}]`);
                    }
                    return;
                }

                // Fix array-format nodes → string format
                if ('nodes' in val && Array.isArray(val.nodes)) {
                    val.nodes = Path.nodesToString(val.nodes);
                    fixCount++;
                }

                // Ensure Path shapes have required `closed` field
                // (Y.Doc roundtrip can lose it; Rust serde requires it)
                if ('nodes' in val && !('closed' in val)) {
                    val.closed = false;
                    fixCount++;
                }

                // Fix wrapped Path shapes {Path: {nodes, closed}} → flat {nodes, closed}
                // Rust serde expects untagged enum, not the wrapped form
                if (
                    'Path' in val &&
                    val.Path &&
                    typeof val.Path === 'object' &&
                    !Array.isArray(val.Path)
                ) {
                    const pathPayload = val.Path;
                    if (pathPayload && typeof pathPayload === 'object') {
                        const result: any = { ...pathPayload };
                        if (Array.isArray(result.nodes)) {
                            result.nodes = Path.nodesToString(result.nodes);
                        }
                        // Ensure closed field after unwrapping
                        if (!('closed' in result)) {
                            result.closed = false;
                        }
                        // Replace the wrapper with the flat shape
                        for (const key of Object.keys(val)) {
                            delete val[key];
                        }
                        Object.assign(val, result);
                        fixCount++;
                        console.warn(
                            `[FontManager] Unwrapped Path shape at ${path}`
                        );
                    }
                }

                // Fix wrapped Component shapes {Component: {reference, transform}} → flat
                if (
                    'Component' in val &&
                    val.Component &&
                    typeof val.Component === 'object' &&
                    !Array.isArray(val.Component) &&
                    !('Path' in val)
                ) {
                    const compPayload = val.Component;
                    if (compPayload && typeof compPayload === 'object') {
                        const result: any = { ...compPayload };
                        if (Array.isArray(result.transform)) {
                            result.transform =
                                DecomposedAffineTransform.fromAffine(
                                    result.transform
                                );
                        }
                        for (const key of Object.keys(val)) {
                            delete val[key];
                        }
                        Object.assign(val, result);
                        fixCount++;
                        console.warn(
                            `[FontManager] Unwrapped Component shape at ${path}`
                        );
                    }
                }

                // Fix flat Component shapes with array transforms
                if (
                    'reference' in val &&
                    'transform' in val &&
                    Array.isArray(val.transform)
                ) {
                    val.transform = DecomposedAffineTransform.fromAffine(
                        val.transform
                    );
                    fixCount++;
                }

                // Ensure Component shapes have required `transform` field
                if ('reference' in val && !('transform' in val)) {
                    val.transform = {
                        translation: [0, 0],
                        rotation: 0,
                        scale: [1, 1],
                        skew: 0,
                        tcenter: [0, 0]
                    };
                    fixCount++;
                }

                // Fix layers missing required `width` field
                // (Y.Doc roundtrip can lose it; Rust serde requires it)
                if (
                    'shapes' in val &&
                    !('reference' in val) &&
                    !('nodes' in val) &&
                    (val.width === undefined || val.width === null)
                ) {
                    val.width = 0;
                    fixCount++;
                }

                // Fix known array fields that became objects (Y.Doc roundtrip)
                for (const field of arrayFields) {
                    if (
                        field in val &&
                        val[field] !== null &&
                        typeof val[field] === 'object' &&
                        !Array.isArray(val[field])
                    ) {
                        const fixed = numericKeyObjectToArray(val[field]);
                        if (fixed.length > 0) {
                            val[field] = fixed;
                            fixCount++;
                            console.warn(
                                `[FontManager] Fixed "${field}" field from object to array (${fixed.length} elements) at ${path}`
                            );
                        }
                    }
                }
                // Recurse into all object values
                for (const key of Object.keys(val)) {
                    fixValue(val[key], `${path}.${key}`);
                }
            };

            if (data && typeof data === 'object') {
                fixValue(data);

                // Post-fix scan: detect shapes that still don't match
                // Rust's untagged enum (Path or Component)
                const scanShapes = (val: any, path: string = ''): void => {
                    if (!val || typeof val !== 'object') return;
                    if (Array.isArray(val)) {
                        for (let i = 0; i < val.length; i++) {
                            scanShapes(val[i], `${path}[${i}]`);
                        }
                        return;
                    }
                    // If this object is inside a "shapes" array and looks like a shape
                    if (
                        path.includes('.shapes[') ||
                        path.includes('[shapes][')
                    ) {
                        const hasNodes = 'nodes' in val;
                        const hasClosed = 'closed' in val;
                        const hasReference = 'reference' in val;
                        const hasTransform = 'transform' in val;
                        const isPath =
                            hasNodes &&
                            typeof val.nodes === 'string' &&
                            hasClosed;
                        const isComponent = hasReference;
                        if (!isPath && !isComponent) {
                            console.error(
                                `[FontManager] Malformed shape at ${path}: keys=[${Object.keys(val).join(',')}], ` +
                                    `nodes=${hasNodes ? typeof val.nodes : 'missing'}, ` +
                                    `closed=${hasClosed}, reference=${hasReference}, transform=${hasTransform}`
                            );
                        }
                    }
                    for (const key of Object.keys(val)) {
                        scanShapes(val[key], `${path}.${key}`);
                    }
                };
                // Scan glyphs[].layers[].shapes[] for malformed shapes
                if (Array.isArray(data.glyphs)) {
                    for (let gi = 0; gi < data.glyphs.length; gi++) {
                        const glyph = data.glyphs[gi];
                        if (glyph?.layers && Array.isArray(glyph.layers)) {
                            for (let li = 0; li < glyph.layers.length; li++) {
                                const layer = glyph.layers[li];
                                if (
                                    layer?.shapes &&
                                    Array.isArray(layer.shapes)
                                ) {
                                    for (
                                        let si = 0;
                                        si < layer.shapes.length;
                                        si++
                                    ) {
                                        const shape = layer.shapes[si];
                                        const hasNodes =
                                            shape && 'nodes' in shape;
                                        const hasClosed =
                                            shape && 'closed' in shape;
                                        const hasReference =
                                            shape && 'reference' in shape;
                                        const hasTransform =
                                            shape && 'transform' in shape;
                                        const isPath =
                                            hasNodes &&
                                            typeof shape.nodes === 'string' &&
                                            hasClosed;
                                        const isComponent = hasReference;
                                        if (!isPath && !isComponent) {
                                            console.error(
                                                `[FontManager] Malformed shape: glyph=${glyph.name}, layer=${layer.id}, shape[${si}]: ` +
                                                    `keys=[${Object.keys(shape).join(',')}], ` +
                                                    `nodes=${hasNodes ? typeof shape.nodes + (Array.isArray(shape.nodes) ? '(array)' : '') : 'missing'}, ` +
                                                    `closed=${hasClosed}, reference=${hasReference}, transform=${hasTransform}`
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if (fixCount > 0) {
                console.warn(
                    `[FontManager] Fixed ${fixCount} issues in babelfontJson before compile`
                );
                return cacheAndReturn(JSON.stringify(data, null, 2));
            } else if (forceValidation) {
                console.log(
                    `[FontManager] Validation ran (forceValidation=${forceValidation}), no issues found`
                );
            }
        } catch (e) {
            console.warn(
                '[FontManager] Failed to validate/fix babelfontJson:',
                e
            );
        }

        return cacheAndReturn(babelfontJson);
    }

    private syncBabelfontJsonFromCurrentModel(): boolean {
        const currentFont = this.currentFont;
        if (!currentFont) {
            return false;
        }

        try {
            currentFont.syncJsonFromModel();
            window.currentFontModel = currentFont.fontModel;
            return true;
        } catch (error) {
            console.error(
                '[FontManager] Error syncing babelfont JSON from model:',
                error
            );
            return false;
        }
    }

    /**
     * Get the current editing font bytes
     */
    getEditingFont() {
        return this.editingFont;
    }

    /**
     * Get the glyph order (array of glyph names) from the source font
     */
    getGlyphOrder() {
        // Return cached glyph order if available
        if (this.glyphOrderCache) {
            return this.glyphOrderCache;
        }

        // Extract from compiled editing font using WASM
        if (this.editingFont) {
            try {
                const glyphOrder = get_glyph_order(this.editingFont);
                // Cache the result
                this.glyphOrderCache = glyphOrder;
                return glyphOrder;
            } catch (error) {
                console.error(
                    '[FontManager]',
                    'Failed to extract glyph order from editing font:',
                    error
                );
            }
        }

        const modelGlyphOrder =
            this.currentFont?.fontModel?.glyphs
                ?.map((glyph) => glyph?.name)
                .filter((name): name is string => !!name) || [];
        if (modelGlyphOrder.length > 0) {
            this.glyphOrderCache = modelGlyphOrder;
            return modelGlyphOrder;
        }

        return [];
    }

    /**
     * Get glyph name by GID from source font
     */
    getGlyphName(gid: number): string {
        const glyphOrder = this.getGlyphOrder();
        if (gid >= 0 && gid < glyphOrder.length) {
            return glyphOrder[gid];
        }
        return `GID${gid}`;
    }

    /**
     * Check if fonts are ready
     */
    isReady() {
        return this.editingFont !== null;
    }

    private getGlyph(glyphName: string): Babelfont.Glyph | null {
        // Get glyph data for a specific glyph name
        if (!this.currentFont) {
            return null;
        }
        let glyphs: Babelfont.Glyph[] = this.currentFont.babelfontData.glyphs;
        if (!glyphs) {
            return null;
        }
        let glyph = glyphs.find((g) => g.name === glyphName);
        if (!glyph) {
            return null;
        }
        return glyph;
    }

    private serializeLayerForStorage(
        glyphName: string,
        layerId: string,
        layerData: Babelfont.Layer,
        options?: { preserveExistingShapes?: boolean }
    ): Babelfont.Layer | null {
        const extractPathShape = (shape: any): any => {
            if (shape && typeof shape === 'object' && 'Path' in shape) {
                return (shape as any).Path;
            }
            return shape;
        };

        const extractComponentShape = (shape: any): any => {
            if (shape && typeof shape === 'object' && 'Component' in shape) {
                return (shape as any).Component;
            }
            return shape;
        };

        const cleanShapeForSaving = (shape: Babelfont.Shape): any => {
            const pathCandidate = extractPathShape(shape as any);
            if (
                pathCandidate &&
                typeof pathCandidate === 'object' &&
                'nodes' in pathCandidate
            ) {
                let nodesValue: string | Babelfont.Node[] = pathCandidate.nodes;

                if (Array.isArray(nodesValue)) {
                    nodesValue = Path.nodesToString(nodesValue);
                }

                return {
                    nodes: nodesValue as string,
                    closed: pathCandidate.closed,
                    ...(pathCandidate.format_specific && {
                        format_specific: pathCandidate.format_specific
                    })
                };
            }

            const componentCandidate = extractComponentShape(shape as any);
            if (
                componentCandidate &&
                typeof componentCandidate === 'object' &&
                'reference' in componentCandidate
            ) {
                return {
                    reference: componentCandidate.reference,
                    transform: this.normalizeComponentTransformForRust(
                        componentCandidate.transform
                    ),
                    ...(componentCandidate.location && {
                        location: componentCandidate.location
                    }),
                    ...(componentCandidate.format_specific && {
                        format_specific: componentCandidate.format_specific
                    })
                };
            }

            const isObject =
                shape && typeof shape === 'object' && !Array.isArray(shape);
            if (isObject) {
                return { ...(shape as object) } as Babelfont.Shape;
            }
            return shape;
        };

        const originalLayer = this.getGlyph(glyphName)?.layers?.find(
            (entry: any) => entry.id === layerId
        );
        const existingLayer = originalLayer;
        if (!originalLayer && !layerData) {
            return null;
        }

        const cleanShapes = Array.isArray(layerData.shapes)
            ? layerData.shapes.map(cleanShapeForSaving)
            : originalLayer?.shapes;
        const storedShapes =
            options?.preserveExistingShapes && originalLayer?.shapes
                ? originalLayer.shapes
                : cleanShapes;

        const cleanAnchors = Array.isArray(layerData.anchors)
            ? layerData.anchors.map((anchor) => ({
                  name: anchor.name,
                  x: anchor.x,
                  y: anchor.y,
                  ...(anchor.format_specific && {
                      format_specific: anchor.format_specific
                  })
              }))
            : originalLayer?.anchors;

        const cleanGuides = Array.isArray(layerData.guides)
            ? layerData.guides.map((guide) => ({
                  pos: {
                      x: guide.pos.x,
                      y: guide.pos.y,
                      angle: guide.pos.angle
                  },
                  name: guide.name,
                  ...(guide.color && { color: guide.color })
              }))
            : originalLayer?.guides;

        const layerName = layerData.name ?? originalLayer?.name;

        return {
            width: layerData.width,
            ...(layerData.height !== undefined && {
                height: layerData.height
            }),
            ...(layerData.vertWidth !== undefined && {
                vertWidth: layerData.vertWidth
            }),
            ...(layerName !== undefined && { name: layerName }),
            id: layerId,
            master: originalLayer?.master ?? layerData.master,
            ...(Array.isArray(storedShapes) && { shapes: storedShapes }),
            ...(cleanAnchors && { anchors: cleanAnchors }),
            ...(cleanGuides && { guides: cleanGuides }),
            ...((layerData.color ?? originalLayer?.color) && {
                color: layerData.color ?? originalLayer?.color
            }),
            ...(layerData.layer_index !== undefined && {
                layer_index: layerData.layer_index
            }),
            ...(layerData.is_background !== undefined && {
                is_background: layerData.is_background
            }),
            ...((layerData.background_layer_id ??
                originalLayer?.background_layer_id) && {
                background_layer_id:
                    layerData.background_layer_id ??
                    originalLayer?.background_layer_id
            }),
            ...((layerData.location ?? originalLayer?.location) && {
                location: {
                    ...(layerData.location ?? originalLayer?.location)
                }
            }),
            ...((layerData.format_specific ??
                originalLayer?.format_specific) && {
                format_specific:
                    layerData.format_specific ?? originalLayer?.format_specific
            }),
            ...((layerData as any).master && {
                master: (layerData as any).master
            })
        };
    }

    private updateStoredLayerData(
        glyphName: string,
        layerId: string,
        layerData: Babelfont.Layer
    ): boolean {
        const glyph = this.getGlyph(glyphName);
        if (!glyph?.layers) {
            return false;
        }

        const layerIndex = glyph.layers.findIndex(
            (layer) => layer.id === layerId
        );
        if (layerIndex === -1) {
            return false;
        }

        glyph.layers[layerIndex] = layerData;
        return true;
    }

    private getWorkerLayerFingerprintKey(
        glyphName: string,
        layerId: string
    ): string {
        return `${glyphName}::${layerId}`;
    }

    private getLayerWorkerFingerprint(layerData: Babelfont.Layer): string {
        return JSON.stringify(this.normalizeLayerForRust(layerData));
    }

    /**
     * Baseline fingerprints for changed-layer detection.
     *
     * Historically this parsed the entire `currentFont.babelfontJson`
     * (multi-megabyte JSON) on every commit batch — a steady ~50-100ms
     * cost per edit even though the only baseline that matters is
     * "what is currently in the Rust worker cache". That state is
     * already tracked incrementally in `workerLayerFingerprintCache`:
     * it is cleared whenever the worker cache is fully reseeded
     * (`storeFontJson`/`forceFullWorkerCacheUpdate` via
     * {@link recordFullFontCrossing}) and updated on every successful
     * `submitLayerUpdatesToWorkerCache`. Returning an empty Map here
     * keeps the logic correct (a missing fingerprint forces the layer
     * to be included in the next batch — the safe fallback) while
     * removing the per-commit JSON.parse from the hot path entirely.
     * See COMPILATION_EDIT_POLICY.md.
     */
    private getLayerFingerprintsFromStoredJson(
        _glyphNames: Iterable<string>
    ): Map<string, string> {
        return EMPTY_FINGERPRINT_MAP;
    }

    private collectChangedLayerUpdatesFromModel(
        glyphNames: Iterable<string>,
        preferredLayerId?: string | null,
        options?: {
            skipFingerprintBaseline?: boolean;
            explicitLayerData?: Iterable<ExplicitLayerCacheInput>;
        }
    ): LayerCacheUpdate[] | null {
        const currentFont = this.currentFont;
        if (!currentFont) {
            return null;
        }

        const updates: LayerCacheUpdate[] = [];
        const explicitLayerData = new Map<string, Babelfont.Layer>();
        for (const input of options?.explicitLayerData || []) {
            if (input?.glyphName && input?.layerId && input?.layerData) {
                explicitLayerData.set(
                    this.getWorkerLayerFingerprintKey(
                        input.glyphName,
                        input.layerId
                    ),
                    input.layerData
                );
            }
        }
        const glyphNameList = Array.from(glyphNames);
        const storedJsonFingerprints = options?.skipFingerprintBaseline
            ? new Map<string, string>()
            : this.getLayerFingerprintsFromStoredJson(glyphNameList);
        const sourceGlyphName =
            window.glyphCanvas?.outlineEditor?.currentGlyphName ||
            window.glyphCanvas?.getCurrentGlyphName?.() ||
            glyphNameList[0] ||
            null;
        const sourceLayer =
            preferredLayerId && sourceGlyphName
                ? currentFont.fontModel
                      ?.findGlyph(sourceGlyphName)
                      ?.layers?.find(
                          (layer: any) => layer?.id === preferredLayerId
                      )
                : null;

        for (const glyphName of glyphNameList) {
            const modelGlyph = currentFont.fontModel?.glyphs?.find(
                (entry: any) => entry?.name === glyphName
            );
            const storedGlyph = this.getGlyph(glyphName);
            if (!modelGlyph || !storedGlyph?.layers) {
                return null;
            }

            const modelLayers = preferredLayerId
                ? [
                      glyphName === sourceGlyphName
                          ? sourceLayer
                          : sourceLayer?.getMatchingLayerOnGlyph?.(glyphName) ||
                            modelGlyph.layers?.find(
                                (layer: any) => layer?.id === preferredLayerId
                            )
                  ].filter(Boolean)
                : modelGlyph.layers || [];

            for (const modelLayer of modelLayers) {
                const layerId = modelLayer?.id;
                if (typeof layerId !== 'string' || !layerId) {
                    return null;
                }

                const fingerprintKey = this.getWorkerLayerFingerprintKey(
                    glyphName,
                    layerId
                );
                const explicitLayer = explicitLayerData.get(fingerprintKey);
                const rawLayerData =
                    explicitLayer ??
                    (typeof modelLayer.toJSON === 'function'
                        ? modelLayer.toJSON()
                        : modelLayer);
                const serializedLayer = this.serializeLayerForStorage(
                    glyphName,
                    layerId,
                    rawLayerData
                );
                if (!serializedLayer) {
                    return null;
                }

                // When skipFingerprintBaseline is set (live drag), skip the
                // expensive fingerprint comparison and always include the update
                if (!options?.skipFingerprintBaseline) {
                    const modelFingerprint =
                        this.getLayerWorkerFingerprint(serializedLayer);
                    const baselineFingerprint =
                        this.workerLayerFingerprintCache.get(fingerprintKey) ??
                        storedJsonFingerprints.get(fingerprintKey) ??
                        null;

                    if (
                        !(preferredLayerId && glyphName === sourceGlyphName) &&
                        baselineFingerprint === modelFingerprint
                    ) {
                        continue;
                    }
                }

                if (
                    !this.updateStoredLayerData(
                        glyphName,
                        layerId,
                        serializedLayer
                    )
                ) {
                    return null;
                }

                updates.push({
                    glyphName,
                    layerId,
                    layerData: serializedLayer
                });
            }
        }

        return updates;
    }

    private async submitLayerUpdatesToWorkerCache(
        updates: LayerCacheUpdate[]
    ): Promise<boolean> {
        if (!this.currentFont || !fontCompilation?.isInitialized) {
            return false;
        }

        if (!updates.length) {
            // Nothing to cross the boundary for.
            return true;
        }

        try {
            // Normalize once per layer and reuse for both postMessage and fingerprint
            const normalizedUpdates = updates.map((update) => {
                const normalized = this.normalizeLayerForRust(update.layerData);
                return {
                    glyphName: update.glyphName,
                    layerId: update.layerId,
                    normalized
                };
            });

            await fontCompilation.sendMessage({
                type: 'storeLayerUpdates',
                updates: normalizedUpdates.map((u) => ({
                    glyphName: u.glyphName,
                    layerId: u.layerId,
                    layerData: u.normalized
                }))
            });

            // Update fingerprint baseline cache + boundary-crossing stats.
            this._boundaryCrossingStats.submitBatchCalls++;
            this._boundaryCrossingStats.layersTransmitted +=
                normalizedUpdates.length;
            for (const u of normalizedUpdates) {
                this.workerLayerFingerprintCache.set(
                    this.getWorkerLayerFingerprintKey(u.glyphName, u.layerId),
                    JSON.stringify(u.normalized)
                );
                this._boundaryCrossingStats.transmittedGlyphs.add(u.glyphName);
            }
            return true;
        } catch (error) {
            console.warn(
                '[FontManager] Failed to submit layer batch to worker cache:',
                updates.map(({ glyphName, layerId }) => ({
                    glyphName,
                    layerId
                })),
                error
            );
            return false;
        }
    }

    /**
     * Snapshot the running JS ↔ Rust/worker boundary-crossing counters.
     * Call {@link resetBoundaryCrossingStats} at the start of an edit
     * and read the snapshot at the end to assert that exactly the
     * expected number of batched layer updates / full-font crossings
     * occurred.
     */
    getBoundaryCrossingStats(): BoundaryCrossingStats {
        return {
            submitBatchCalls: this._boundaryCrossingStats.submitBatchCalls,
            layersTransmitted: this._boundaryCrossingStats.layersTransmitted,
            glyphsTransmitted:
                this._boundaryCrossingStats.transmittedGlyphs.size,
            fullFontCrossings: this._boundaryCrossingStats.fullFontCrossings
        };
    }

    /**
     * Reset the running boundary-crossing counters. Tests and the AI
     * profiling harness call this between edits to measure per-edit
     * costs in isolation.
     */
    resetBoundaryCrossingStats(): void {
        this._boundaryCrossingStats.submitBatchCalls = 0;
        this._boundaryCrossingStats.layersTransmitted = 0;
        this._boundaryCrossingStats.fullFontCrossings = 0;
        this._boundaryCrossingStats.transmittedGlyphs.clear();
    }

    /**
     * Record a full-font crossing (`storeFontJson`). Centralised so the
     * boundary-crossing counters cover every full-font path.
     *
     * After a full crossing the worker has received a fresh
     * `babelfontJson` and the previous incremental fingerprints become
     * a stale baseline (they refer to a state that may not match what
     * Rust now has). Clearing the cache forces the next batch to
     * include every touched layer \u2014 the safe direction \u2014 and the
     * cache is then incrementally rebuilt by subsequent successful
     * `submitLayerUpdatesToWorkerCache` calls. This keeps the
     * fingerprint cache as the documented single source of truth (see
     * COMPILATION_EDIT_POLICY.md \u00a711).
     */
    recordFullFontCrossing(): void {
        this._boundaryCrossingStats.fullFontCrossings++;
        this.workerLayerFingerprintCache.clear();
    }

    async refreshWorkerCacheForReplayTargets(
        targets: Iterable<WorkerReplayTarget>
    ): Promise<boolean> {
        const refreshPromise = (async () => {
            const currentFont = this.currentFont;
            if (!currentFont) {
                return false;
            }

            const updates: LayerCacheUpdate[] = [];
            const seenTargets = new Set<string>();

            for (const target of targets) {
                const glyphName = target?.glyphName;
                const layerId = target?.layerId;
                if (!glyphName || !layerId) {
                    continue;
                }

                const seenKey = `${glyphName}@@${layerId}`;
                if (seenTargets.has(seenKey)) {
                    continue;
                }
                seenTargets.add(seenKey);

                const modelGlyph = currentFont.fontModel?.glyphs?.find(
                    (entry: any) => entry?.name === glyphName
                );
                const modelLayer = modelGlyph?.layers?.find(
                    (entry: any) => entry?.id === layerId
                );
                if (!modelLayer) {
                    return false;
                }

                const rawLayerData =
                    typeof modelLayer.toJSON === 'function'
                        ? modelLayer.toJSON()
                        : modelLayer;
                const serializedLayer = this.serializeLayerForStorage(
                    glyphName,
                    layerId,
                    rawLayerData
                );
                if (!serializedLayer) {
                    return false;
                }

                if (
                    !this.updateStoredLayerData(
                        glyphName,
                        layerId,
                        serializedLayer
                    )
                ) {
                    return false;
                }

                updates.push({
                    glyphName,
                    layerId,
                    layerData: serializedLayer
                });
            }

            if (!updates.length) {
                return false;
            }

            const updatedIncrementally =
                await this.submitLayerUpdatesToWorkerCache(updates);
            if (updatedIncrementally) {
                fontCompilation.lastStoredFontJson = null;
            }
            return updatedIncrementally;
        })();

        const cacheUpdatePromise = refreshPromise.then(() => undefined);
        this.workerCacheUpdatePromise = cacheUpdatePromise;
        try {
            return await refreshPromise;
        } finally {
            if (this.workerCacheUpdatePromise === cacheUpdatePromise) {
                this.workerCacheUpdatePromise = null;
            }
        }
    }

    /**
     * Looks for a font-level format_specific key in the current font
     *
     * @param {string} key
     * @returns {any}
     */
    getFormatSpecific(key: string): any {
        return this.currentFont?.babelfontData?.format_specific?.[key];
    }

    /**
     * Sets a font-level format_specific key in the current font
     *
     * @param {string} key
     * @param {any} value
     */
    setFormatSpecific(key: string, value: any) {
        if (this.currentFont?.babelfontData) {
            if (!this.currentFont.babelfontData.format_specific) {
                this.currentFont.babelfontData.format_specific = {};
            }
            this.currentFont.babelfontData.format_specific[key] = value;
        }
    }

    fetchGlyphData(glyphName: string): GlyphData | null {
        let glyph = this.getGlyph(glyphName);
        if (!glyph) {
            return null;
        }
        let master_ids = new Set<string>();
        for (let master of this.currentFont!.babelfontData.masters) {
            master_ids.add(master.id);
        }
        let layersData: any[] = [];
        for (let layer of glyph.layers || []) {
            // Include non-background layers that are either:
            // - default layers for their master, or
            // - brace layers (AssociatedWithMaster + non-empty location)
            if (!layer.is_background) {
                const layerAny = layer as any;
                const hasTaggedMaster =
                    layerAny.master &&
                    typeof layerAny.master === 'object' &&
                    'type' in layerAny.master;
                const isDefaultLayer =
                    hasTaggedMaster &&
                    layerAny.master.type === 'DefaultForMaster';
                const isAssociatedLayer =
                    hasTaggedMaster &&
                    layerAny.master.type === 'AssociatedWithMaster';
                const hasBraceLocation =
                    !!layer.location && Object.keys(layer.location).length > 0;

                if (isDefaultLayer || (isAssociatedLayer && hasBraceLocation)) {
                    const masterIdStr = layerAny.master?.master || layer.id;
                    if (master_ids.has(masterIdStr)) {
                        layersData.push({
                            id: layer.id as string,
                            name: layer.name || 'Default',
                            _master: masterIdStr,
                            location: layer.location
                        });
                    }
                }
            }
        }
        const axes = this.currentFont!.babelfontData.axes || [];
        let axes_order = axes.map((axis: Babelfont.Axis) => axis.tag);

        let mastersData: any[] = [];
        for (let master of this.currentFont!.babelfontData
            .masters as Babelfont.Master[]) {
            let userspaceLocation = designspaceToUserspace(
                master.location || {},
                axes
            );
            // Extract master name from I18NDictionary (use 'en' or first available)
            let masterName =
                typeof master.name === 'string'
                    ? master.name
                    : master.name?.en ||
                      Object.values(master.name || {})[0] ||
                      'Unknown';
            mastersData.push({
                id: master.id,
                name: masterName,
                location: userspaceLocation
            });
        }
        return {
            glyphName: glyph.name,
            layers: layersData,
            masters: mastersData,
            axesOrder: axes_order
        };
    }

    async saveLayerData(
        glyphName: string,
        layerId: string,
        layerData: Babelfont.Layer,
        changeSource: string = 'unknown'
    ) {
        const layerDataCopy = this.serializeLayerForStorage(
            glyphName,
            layerId,
            layerData,
            {
                preserveExistingShapes: changeSource.endsWith('-anchor')
            }
        );
        if (!layerDataCopy) {
            console.error(
                '[FontManager]',
                `Failed to serialize layer ${layerId} in glyph ${glyphName}`
            );
            return;
        }

        let glyph = this.getGlyph(glyphName);
        if (!glyph) {
            console.error(
                `[FontManager]`,
                `Glyph ${glyphName} not found - cannot save layer data`
            );
            return;
        }

        if (!glyph.layers) {
            console.error(
                `[FontManager]`,
                `Glyph ${glyphName} has no layers - cannot save layer data`
            );
            return;
        }

        // Update the layer in the current font's babelfontData
        const layerIndex = glyph.layers.findIndex((l) => l.id === layerId);
        if (layerIndex === -1) {
            console.error(
                `[FontManager]`,
                `Layer ${layerId} not found in glyph ${glyphName} - cannot save layer data`
            );
            return;
        }

        const syncedModelLayer = this.syncSerializedLayerIntoObjectModel(
            glyphName,
            layerId,
            layerDataCopy
        );
        glyph.layers[layerIndex] = syncedModelLayer || layerDataCopy;

        const isInteractiveEdit =
            changeSource.startsWith('mouse-drag') ||
            changeSource.startsWith('keyboard');

        if (isInteractiveEdit) {
            this.pendingBabelfontJsonSyncAfterDrag = true;
        } else {
            if (!this.syncBabelfontJsonFromCurrentModel()) {
                return;
            }
            this.pendingBabelfontJsonSyncAfterDrag = false;
        }

        // Mark font as dirty and track the change source
        this.lastChangeSource = changeSource;

        // Derive edit type from enriched changeSource
        if (changeSource.endsWith('-anchor')) {
            this.lastEditType = 'anchor';
        } else if (changeSource.endsWith('-outline')) {
            this.lastEditType = 'outline';
        } else {
            this.lastEditType = null;
        }

        const deferInteractiveCompile =
            isInteractiveEdit && this.lastEditType !== null;

        // Schedule debounced full compile after interactive editing stops
        if (deferInteractiveCompile) {
            this.scheduleFullCompileDebounce();
        }

        this.currentFont!.markDirty(changeSource);
        window.autoCompileManager.checkAndSchedule();
        await this.updateDirtyIndicator();

        // Update worker's font cache so glyph overview renders correctly
        // Skip during dragging to prevent clearing caches repeatedly - will update on drag end
        if (!isInteractiveEdit) {
            try {
                this.recordFullFontCrossing();
                await fontCompilation.sendMessage({
                    type: 'storeFontJson',
                    babelfontJson: this.currentFont!.babelfontJson
                });
            } catch (error) {
                console.error(
                    '[FontManager] Error updating worker font cache:',
                    error
                );
            }
        }

        // Dispatch event for glyph overview to update tile
        window.dispatchEvent(
            new CustomEvent('glyphChanged', {
                detail: { glyphName, layerId }
            })
        );
    }

    /**
     * Update the worker's font cache with current font data.
     * Call this after dragging ends to ensure caches are updated.
     * Also dispatches glyphChanged event to refresh the glyph overview.
     */
    async updateWorkerFontCache(): Promise<void> {
        const run = async (): Promise<void> => {
            if (!this.currentFont) {
                console.warn('[FontManager] No current font to update cache');
                return;
            }

            const currentGlyphName =
                window.glyphCanvas?.outlineEditor?.currentGlyphName;
            const currentLayerId =
                window.glyphCanvas?.outlineEditor?.selectedLayerId;

            let updatedViaIncrementalLayer = false;
            if (
                this.pendingBabelfontJsonSyncAfterDrag &&
                currentGlyphName &&
                currentLayerId
            ) {
                const currentGlyph = this.currentFont.fontModel?.glyphs?.find(
                    (glyph: any) => glyph?.name === currentGlyphName
                );
                const currentLayer = currentGlyph?.layers?.find(
                    (layer: any) => layer?.id === currentLayerId
                );

                if (currentLayer) {
                    try {
                        const rawLayerData =
                            typeof currentLayer.toJSON === 'function'
                                ? currentLayer.toJSON()
                                : currentLayer;
                        const layerDataCopy =
                            this.normalizeLayerForRust(rawLayerData);
                        await fontCompilation.sendMessage({
                            type: 'storeLayerUpdates',
                            updates: [
                                {
                                    glyphName: currentGlyphName,
                                    layerId: currentLayerId,
                                    layerData: layerDataCopy
                                }
                            ]
                        });
                        updatedViaIncrementalLayer = true;

                        if (this.pendingBabelfontJsonSyncAfterDrag) {
                            if (!this.syncBabelfontJsonFromCurrentModel()) {
                                return;
                            }
                            this.pendingBabelfontJsonSyncAfterDrag = false;
                        }
                    } catch (error) {
                        console.warn(
                            '[FontManager] Incremental post-drag worker layer update failed, falling back to full store:',
                            error
                        );
                    }
                }
            }

            try {
                if (!updatedViaIncrementalLayer) {
                    if (this.pendingBabelfontJsonSyncAfterDrag) {
                        if (!this.syncBabelfontJsonFromCurrentModel()) {
                            return;
                        }
                        this.pendingBabelfontJsonSyncAfterDrag = false;
                    }

                    this.recordFullFontCrossing();
                    await fontCompilation.sendMessage({
                        type: 'storeFontJson',
                        babelfontJson: this.currentFont.babelfontJson
                    });
                }

                // After updating the cache, dispatch glyphChanged event for all affected glyphs
                // This ensures the glyph overview refreshes with the updated outline data
                const rootGlyphName = window.glyphCanvas?.getCurrentGlyphName();

                // Collect all glyphs that need to be refreshed
                const glyphsToRefresh = new Set<string>();

                if (currentGlyphName) {
                    // Add the currently edited glyph
                    glyphsToRefresh.add(currentGlyphName);

                    // Find all glyphs that use the current glyph as a component
                    // This handles nested components like "o" inside "ö", "õ", "ø", etc.
                    const glyphsUsingComponent =
                        window.currentFontModel?.findGlyphsUsingComponent(
                            currentGlyphName
                        );
                    if (glyphsUsingComponent) {
                        for (const glyphName of glyphsUsingComponent) {
                            glyphsToRefresh.add(glyphName);
                        }
                    }
                }

                // Also add the root glyph if different (for nested component editing)
                if (rootGlyphName && rootGlyphName !== currentGlyphName) {
                    glyphsToRefresh.add(rootGlyphName);
                }

                // Dispatch glyphChanged events for all affected glyphs
                for (const glyphName of glyphsToRefresh) {
                    window.dispatchEvent(
                        new CustomEvent('glyphChanged', {
                            detail: {
                                glyphName: glyphName,
                                layerId: currentLayerId
                            }
                        })
                    );
                }
            } catch (error) {
                console.error(
                    '[FontManager] Error updating worker font cache:',
                    error
                );
            }
        };

        const cacheUpdatePromise = run();
        this.workerCacheUpdatePromise = cacheUpdatePromise;
        try {
            await cacheUpdatePromise;
        } finally {
            if (this.workerCacheUpdatePromise === cacheUpdatePromise) {
                this.workerCacheUpdatePromise = null;
            }
        }
    }

    /**
     * Force a full font JSON store to the Rust worker cache, bypassing all
     * incremental-layer optimisations. Call this after multi-layer mutations
     * (e.g. close-path that patches all linked masters at once) so that
     * interpolate_glyph sees up-to-date data in every master layer.
     *
     * Must be called AFTER syncJsonFromModel() has been invoked so that
     * this.currentFont.babelfontJson reflects the latest model state.
     */
    async forceFullWorkerCacheUpdate(): Promise<void> {
        if (!this.currentFont || !fontCompilation?.isInitialized) {
            return;
        }

        const cacheUpdatePromise = (async () => {
            // Clear incremental-drag flag so updateWorkerFontCache takes the full path.
            this.pendingBabelfontJsonSyncAfterDrag = false;
            // Invalidate the "already stored" sentinel so fontCompilation doesn't skip the send.
            fontCompilation.lastStoredFontJson = null;
            try {
                this.recordFullFontCrossing();
                await fontCompilation.sendMessage({
                    type: 'storeFontJson',
                    babelfontJson: this.currentFont!.babelfontJson,
                    forceStore: true
                });
            } catch (error) {
                console.error(
                    '[FontManager] forceFullWorkerCacheUpdate: error sending storeFontJson:',
                    error
                );
            }
        })();

        this.workerCacheUpdatePromise = cacheUpdatePromise;
        try {
            await cacheUpdatePromise;
        } finally {
            if (this.workerCacheUpdatePromise === cacheUpdatePromise) {
                this.workerCacheUpdatePromise = null;
            }
        }
    }

    async awaitWorkerCacheUpdate(): Promise<void> {
        if (!this.workerCacheUpdatePromise) {
            return;
        }
        try {
            await this.workerCacheUpdatePromise;
        } catch {
            // Ignore update failures here — undo/redo refresh has its own forced sync path.
        }
    }

    async refreshGlyphsAfterModelBatch(
        glyphNames: Iterable<string>,
        layerId?: string | null,
        options?: {
            dispatchGlyphChanged?: boolean;
            skipFingerprintBaseline?: boolean;
            explicitLayerData?: Iterable<ExplicitLayerCacheInput>;
        }
    ): Promise<void> {
        const refreshPromise = (async () => {
            const currentFont = this.currentFont;
            const uniqueGlyphNames = Array.from(
                new Set(
                    Array.from(glyphNames || []).filter(
                        (glyphName): glyphName is string =>
                            typeof glyphName === 'string' &&
                            glyphName.length > 0
                    )
                )
            );

            if (!currentFont || !uniqueGlyphNames.length) {
                return;
            }

            const pendingLayerUpdates =
                this.collectChangedLayerUpdatesFromModel(
                    uniqueGlyphNames,
                    layerId,
                    options?.skipFingerprintBaseline ||
                        options?.explicitLayerData
                        ? {
                              ...(options?.skipFingerprintBaseline
                                  ? { skipFingerprintBaseline: true }
                                  : undefined),
                              ...(options?.explicitLayerData
                                  ? {
                                        explicitLayerData:
                                            options.explicitLayerData
                                    }
                                  : undefined)
                          }
                        : undefined
                );

            let updatedIncrementally = false;
            if (pendingLayerUpdates && pendingLayerUpdates.length > 0) {
                updatedIncrementally =
                    await this.submitLayerUpdatesToWorkerCache(
                        pendingLayerUpdates
                    );

                if (updatedIncrementally) {
                    fontCompilation.lastStoredFontJson = null;
                }
            } else if (pendingLayerUpdates) {
                updatedIncrementally = true;
            }

            if (!updatedIncrementally) {
                if (!this.syncBabelfontJsonFromCurrentModel()) {
                    return;
                }

                this.recordFullFontCrossing();
                await fontCompilation.sendMessage({
                    type: 'storeFontJson',
                    babelfontJson: currentFont.babelfontJson
                });
            }

            if (options?.dispatchGlyphChanged === false) {
                return;
            }

            window.dispatchEvent(
                new CustomEvent('glyphChanged', {
                    detail:
                        uniqueGlyphNames.length === 1
                            ? {
                                  glyphName: uniqueGlyphNames[0],
                                  layerId: layerId ?? undefined
                              }
                            : {
                                  glyphName: uniqueGlyphNames[0],
                                  glyphNames: uniqueGlyphNames,
                                  layerId: layerId ?? undefined
                              }
                })
            );
        })();

        this.workerCacheUpdatePromise = refreshPromise;
        try {
            await refreshPromise;
        } finally {
            if (this.workerCacheUpdatePromise === refreshPromise) {
                this.workerCacheUpdatePromise = null;
            }
        }
    }

    async submitLayerToWorkerCache(
        glyphName: string,
        layerId: string
    ): Promise<boolean> {
        if (!this.currentFont || !fontCompilation?.isInitialized) {
            return false;
        }

        const glyph = this.currentFont.fontModel?.glyphs?.find(
            (entry: any) => entry?.name === glyphName
        );
        const layer = glyph?.layers?.find(
            (entry: any) => entry?.id === layerId
        );
        if (!layer) {
            return false;
        }

        const rawLayerData =
            typeof layer.toJSON === 'function' ? layer.toJSON() : layer;
        const serializedLayer = this.serializeLayerForStorage(
            glyphName,
            layerId,
            rawLayerData
        );
        if (!serializedLayer) {
            return false;
        }

        // Route through the batched single-call path so the boundary-crossing
        // counters and `workerLayerFingerprintCache` are updated uniformly.
        // See COMPILATION_EDIT_POLICY.md \u00a711.
        return this.submitLayerUpdatesToWorkerCache([
            { glyphName, layerId, layerData: serializedLayer }
        ]);
    }
}

// Create singleton instance when page loads
let fontManager: FontManager = new FontManager();

// Expose to window for global access (needed by object model dirty flag tracking)
(window as any).fontManager = fontManager;

// Initialize global font model reference
window.currentFontModel = null;

document.addEventListener('DOMContentLoaded', () => {
    fontManager.init();
});
export default fontManager;

// Wait for font compilation system to be ready
async function fontCompilationReady(): Promise<boolean> {
    if (fontCompilation?.isInitialized) {
        return true;
    }

    const initialized = await fontCompilation.initialize();
    if (!initialized) {
        console.error(
            '[FontManager]',
            '❌ Font compilation system not ready after initialization'
        );
        return false;
    }

    return true;
}

function createOpenSessionId(): string {
    return `open-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function emitOpenLifecycle(
    openSessionId: string,
    phase: string,
    extra: Record<string, unknown> = {}
): void {
    timelineMark(`font.lifecycle.${phase}`);
    window.dispatchEvent(
        new CustomEvent('fontOpenLifecycle', {
            detail: {
                openSessionId,
                phase,
                timestamp: performance.now(),
                ...extra
            }
        })
    );
}

// Listen for font loaded events from file browser
window.addEventListener('fontLoaded', async (event: Event) => {
    if (!(await fontCompilationReady())) {
        return;
    }

    const openSessionSpanId = timelineSpanStart('font.openSession');

    let fullCompileDeferredTimer: number | null = null;
    let canvasReadyListener: ((event: Event) => void) | null = null;
    let startupReleased = false;
    let startupFinalizeStarted = false;
    let canvasReady = false;
    let fontReadyDispatched = false;
    let activeOpenSessionDetail: {
        path: string;
        openSessionId: string;
        openedAt: number;
    } | null = null;

    const dispatchFontReadyIfNeeded = (openSessionId: string) => {
        if (fontReadyDispatched || !activeOpenSessionDetail) {
            return;
        }

        if (activeOpenSessionDetail.openSessionId !== openSessionId) {
            return;
        }

        window.dispatchEvent(
            new CustomEvent('fontReady', {
                detail: {
                    path: activeOpenSessionDetail.path,
                    openSessionId: activeOpenSessionDetail.openSessionId,
                    openedAt: activeOpenSessionDetail.openedAt
                }
            })
        );

        fontReadyDispatched = true;
        emitOpenLifecycle(openSessionId, 'fontReadyDispatched');
    };

    const finalizeStartupReadiness = async (openSessionId: string) => {
        if (startupFinalizeStarted || !canvasReady) {
            return;
        }

        startupFinalizeStarted = true;

        try {
            if (window.glyphCanvas) {
                await ensureStartupStateReady(window.glyphCanvas);
            }

            emitOpenLifecycle(openSessionId, 'startupStateReady');
            releaseStartupGates(openSessionId, 'canvas+state-ready', true);
        } catch (error) {
            console.warn(
                '[FontManager]',
                'Startup state restore failed before fontReady; continuing:',
                error
            );
            releaseStartupGates(openSessionId, 'canvas+state-error', true);
        }
    };

    const releaseStartupGates = (
        openSessionId: string,
        reason: string,
        scheduleFullCompile: boolean
    ) => {
        if (startupReleased) {
            return;
        }

        startupReleased = true;

        startupOpenSessionActive = false;
        startupOpenSessionEditingCompileCount = 0;

        if (canvasReadyListener) {
            window.removeEventListener(
                'canvasInitialReady',
                canvasReadyListener
            );
            canvasReadyListener = null;
        }

        if (fullCompileDeferredTimer !== null) {
            clearTimeout(fullCompileDeferredTimer);
            fullCompileDeferredTimer = null;
        }

        window.autoCompileManager?.setStartupBlocked?.(false);
        window.fullCompileManager?.setEnabled?.(true);

        if (scheduleFullCompile) {
            window.fullCompileManager?.scheduleCompilation?.(0);
        }

        emitOpenLifecycle(openSessionId, 'startupReleased', {
            reason,
            scheduleFullCompile
        });

        endStartupInteractionLock();
        endLoadingCursor();

        timelineSpanEnd(openSessionSpanId);
        dispatchFontReadyIfNeeded(openSessionId);
    };

    try {
        // Get the babelfont JSON from the event
        const detail = (event as CustomEvent).detail;
        const openSessionId = createOpenSessionId();
        const openedAt = performance.now();

        activeOpenSessionDetail = {
            path: detail.path,
            openSessionId,
            openedAt
        };

        startupOpenSessionActive = true;
        startupOpenSessionEditingCompileCount = 0;
        beginStartupInteractionLock();

        emitOpenLifecycle(openSessionId, 'fontLoaded', {
            path: detail.path,
            sourcePluginId: detail.sourcePlugin?.id || null
        });

        fontCompilation.lastStoredFontJson = null;
        fontCompilation.pendingStoreFontJsonPayload = null;
        fontCompilation.pendingStoreFontJsonPromise = null;
        fontCompilation.lastEditingSubsetKey = null;

        // Prioritize first-open UX over continuous background recompiles/QC.
        window.autoCompileManager?.setStartupBlocked?.(true);
        window.fullCompileManager?.setEnabled?.(false);

        // Store font in worker's Rust instance for glyph operations
        // This ensures the font is cached BEFORE fontReady fires
        try {
            fontManager?.recordFullFontCrossing?.();
            const storeResult = await fontCompilation.sendMessage({
                type: 'storeFontJson',
                babelfontJson: detail.babelfontJson
            });
            if (storeResult.error) {
                throw new Error(
                    `Failed to cache font in worker: ${storeResult.error}`
                );
            }

            emitOpenLifecycle(openSessionId, 'storeFontJsonComplete');
        } catch (error) {
            console.error(
                '[FontManager]',
                '❌ Failed to cache font in worker:',
                error
            );
            throw error;
        }

        // Load font into font manager
        await fontManager!.loadFont(
            detail.babelfontJson,
            detail.path,
            detail.sourcePlugin,
            detail.fileHandle,
            detail.directoryHandle
        );

        emitOpenLifecycle(openSessionId, 'loadFontComplete', {
            openedAt
        });

        canvasReadyListener = (canvasEvent: Event) => {
            const canvasDetail = (canvasEvent as CustomEvent).detail;
            if (
                canvasDetail?.openSessionId &&
                canvasDetail.openSessionId !== openSessionId
            ) {
                return;
            }

            canvasReady = true;
            emitOpenLifecycle(openSessionId, 'canvasInitialReady');
            void finalizeStartupReadiness(openSessionId);
        };

        window.addEventListener('canvasInitialReady', canvasReadyListener);

        // Update display
        await fontManager!.onOpened();

        emitOpenLifecycle(openSessionId, 'onOpenedComplete');

        // Trigger initial editing compile and capture the first result.
        emitOpenLifecycle(openSessionId, 'editingCompileStart');
        window.addEventListener(
            'editingFontCompiled',
            () => {
                const editingCompileElapsedMs = performance.now() - openedAt;
                emitOpenLifecycle(openSessionId, 'editingCompileComplete', {
                    elapsedMs: editingCompileElapsedMs
                });
            },
            { once: true }
        );

        fontManager!.compileEditingFont().catch((error) => {
            console.error(
                '[FontManager]',
                'Initial editing compile failed:',
                error
            );
        });

        fullCompileDeferredTimer = window.setTimeout(() => {
            emitOpenLifecycle(openSessionId, 'startup-ready-timeout-waiting', {
                canvasReady,
                startupFinalizeStarted
            });

            if (window.glyphCanvas && !startupFinalizeStarted) {
                void ensureStartupStateReady(window.glyphCanvas)
                    .catch((error) => {
                        console.warn(
                            '[FontManager]',
                            'Startup state restore timed out waiting for canvas; enabling sync anyway:',
                            error
                        );
                    })
                    .finally(() => {
                        releaseStartupGates(
                            openSessionId,
                            'startup-ready-timeout',
                            true
                        );
                    });
                return;
            }

            releaseStartupGates(openSessionId, 'startup-ready-timeout', true);
        }, 8000);

        // Full compile + QC is intentionally deferred until canvas reports
        // initial text + zoom readiness.
    } catch (error) {
        releaseStartupGates('open-unknown', 'error', false);
        timelineMark('font.openSession.error');

        console.error('[FontManager]', 'Failed to initialize font manager:');
        console.error(
            '[FontManager]',
            'Error message:',
            error instanceof Error ? error.message : String(error)
        );
        console.error(
            '[FontManager]',
            'Error stack:',
            error instanceof Error ? error.stack : 'No stack'
        );
        console.error('[FontManager]', 'Raw error object:', error);

        // Error will be shown in sidebar by the error handlers above
    }
});
