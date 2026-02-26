// Font Manager
// Keeps track of all open fonts, and access to font data.
// Also maintains the opened font dropdown UI.
// Implements editing-font compilation architecture:
// "editing" font: Recompiled on demand with subset of glyphs for display in canvas

import APP_SETTINGS from './settings';
import { fontCompilation } from './font-compilation';
import { get_glyph_order } from '../wasm-dist/babelfont_fontc_web';
import type { Babelfont } from './babelfont';
import { designspaceToUserspace, userspaceToDesignspace } from './locations';
import type { DesignspaceLocation } from './locations';
import { Font, Path } from './babelfont-model';
import { sidebarErrorDisplay } from './sidebar-error-display';
import type { FilesystemPlugin } from './filesystem-plugins';
import { Logger } from './logger';
import {
    timelineMark,
    timelineSpanEnd,
    timelineSpanStart
} from './perf-timeline';
import { beginLoadingCursor, endLoadingCursor } from './loading-cursor';

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
        location: DesignspaceLocation;
    }[];
    axesOrder: string[];
};

export type FontQCSummary = {
    fails: number;
    warns: number;
    infos: number;
};

type ReloadCurrentFontOptions = {
    preserveUiState?: boolean;
};

type CapturedGlyphCanvasState = {
    wasEditMode: boolean;
    selectedGlyphIndex: number;
    selectedLayerId: string | null;
    cursorPosition: number;
    textBuffer: string;
    variationSettings: Record<string, number> | null;
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
        this.path = path;
        this.name =
            this.babelfontData?.names?.family_name?.dflt || 'Untitled Font';
        this.needsRecompile = false;
        this.hasUnsavedChanges = false;
        this.changeVersion = 0;
    }

    /**
     * Mark font as changed:
     * - needsRecompile: auto-compile pipeline should rebuild editing font
     * - hasUnsavedChanges: save indicator and unload warnings
     * This allows tracking whether data changed during compilation
     */
    markDirty(changeSource?: string): void {
        this.needsRecompile = true;
        this.hasUnsavedChanges = true;
        this.changeVersion++;
        window.fullCompileManager?.checkAndSchedule?.();
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

        // Process all layers to prepare for serialization
        for (const glyph of this.babelfontData.glyphs || []) {
            for (const layer of glyph.layers || []) {
                if (!layer?.shapes) continue;

                for (let i = 0; i < layer.shapes.length; i++) {
                    let shape = layer.shapes[i];

                    // Handle Path shapes - convert array nodes to strings
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
                    }

                    // Note: normalizer wrapper properties (nodes, isInterpolated) are filtered
                    // out during JSON.stringify by the replacer function in toJSONString()
                }
            }
        }

        this.babelfontJson = this.fontModel.toJSONString();
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

    constructor() {
        this.fontDisplay = null;
        this.fontIconElement = null;
        this.fontNameElement = null;
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
    }
    init() {
        this.fontDisplay = document.getElementById('current-font-display');
        this.fontIconElement =
            this.fontDisplay?.querySelector('.font-icon') || null;
        this.fontNameElement =
            this.fontDisplay?.querySelector('.font-name') || null;
        this.dirtyIndicator = document.getElementById('file-dirty-indicator');
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

    updateFontDisplay() {
        if (!this.fontIconElement || !this.fontNameElement) return;

        const shareButton = document.getElementById('share-btn');

        if (this.openedFonts.size === 0 || !this.currentFontId) {
            // No fonts open
            this.fontIconElement.innerHTML = '';
            this.fontNameElement.textContent = 'No fonts open';
            if (this.fontDisplay) {
                this.fontDisplay.title = '';
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
                    this.fontDisplay.title = `${currentFont.path} (${sourceName})`;
                }
                if (shareButton) {
                    shareButton.classList.add('visible');
                }
            }
        }
    }

    async updateDirtyIndicator() {
        // Update visual indicator
        if (this.currentFont?.hasUnsavedChanges) {
            this.dirtyIndicator!.classList.add('visible');
        } else {
            this.dirtyIndicator!.classList.remove('visible');
        }

        // Update document title
        const baseTitle = 'Counterpunch Editor';
        if (this.currentFont?.hasUnsavedChanges && this.currentFont?.name) {
            document.title = `● ${this.currentFont.name} - ${baseTitle}`;
        } else if (this.currentFont?.name) {
            document.title = `${this.currentFont.name} - ${baseTitle}`;
        } else {
            document.title = baseTitle;
        }
    }

    async onOpened() {
        await this.updateFontDisplay();
        // Update save button state
        if (window.saveButton) {
            window.saveButton.updateButtonState();
        }
    }
    async onClosed() {
        await this.onOpened(); // same thing
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

        if (!window.fontCompilation?.worker) {
            throw new Error('Font compilation worker not initialized');
        }

        return await new Promise<string>((resolve, reject) => {
            const id = Math.random().toString(36);
            const timeout = setTimeout(() => {
                reject(new Error('Font conversion timeout after 30 seconds'));
            }, 30000);

            const handleMessage = (e: MessageEvent) => {
                if (e.data.id === id && e.data.type === 'openFont') {
                    clearTimeout(timeout);
                    window.fontCompilation!.worker!.removeEventListener(
                        'message',
                        handleMessage
                    );

                    if (e.data.error) {
                        reject(new Error(e.data.error));
                    } else {
                        resolve(e.data.babelfontJson);
                    }
                }
            };

            window.fontCompilation!.worker!.addEventListener(
                'message',
                handleMessage
            );

            window.fontCompilation!.worker!.postMessage({
                type: 'openFont',
                id,
                filename: font.path.split('/').pop() || font.path,
                contents,
                packageEntries,
                projectEntries
            });
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

        // Update window title with font file name
        const fileName = path.split('/').pop() || 'Untitled';
        document.title = fileName;
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

    private normalizeShapeForRust(shape: any): any {
        if (!shape || typeof shape !== 'object' || Array.isArray(shape)) {
            return shape;
        }

        const pathCandidate =
            'Path' in shape && shape.Path && typeof shape.Path === 'object'
                ? shape.Path
                : shape;

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

        const componentCandidate =
            'Component' in shape &&
            shape.Component &&
            typeof shape.Component === 'object'
                ? shape.Component
                : shape;

        if ('reference' in componentCandidate) {
            return {
                reference: componentCandidate.reference,
                transform: componentCandidate.transform,
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
            let responseRevisionKey = String(this.currentFont.changeVersion);
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
                    this.currentFont.changeVersion
                );
                const dragActiveAtRequest =
                    !!window.glyphCanvas?.outlineEditor?.draggingSomething;
                let dirtyGlyphName: string | undefined;
                let dirtyLayerId: string | undefined;
                let dirtyLayerData: unknown;
                const incrementalChangeSource = this.lastChangeSource;
                const shouldSendIncrementalLayer =
                    incrementalChangeSource !== null &&
                    (incrementalChangeSource.startsWith('mouse-drag') ||
                        incrementalChangeSource.startsWith('keyboard'));
                const dragGlyphNames = shouldSendIncrementalLayer
                    ? [
                          window.glyphCanvas?.outlineEditor?.currentGlyphName ||
                              window.glyphCanvas?.getCurrentGlyphName?.()
                      ].filter(
                          (glyphName): glyphName is string =>
                              typeof glyphName === 'string' &&
                              glyphName.length > 0
                      )
                    : [];

                if (dragGlyphNames.length === 1) {
                    dirtyGlyphName = dragGlyphNames[0];
                    dirtyLayerId =
                        window.glyphCanvas?.outlineEditor?.selectedLayerId ||
                        undefined;
                    const dirtyGlyph = this.currentFont.fontModel?.glyphs?.find(
                        (glyph: any) => glyph?.name === dirtyGlyphName
                    );
                    if (dirtyGlyph && dirtyLayerId) {
                        const dirtyLayer = dirtyGlyph.layers?.find(
                            (layer: any) => layer?.id === dirtyLayerId
                        );
                        if (dirtyLayer) {
                            const rawDirtyLayer =
                                typeof dirtyLayer.toJSON === 'function'
                                    ? dirtyLayer.toJSON()
                                    : dirtyLayer;
                            dirtyLayerData =
                                this.normalizeLayerForRust(rawDirtyLayer);
                        }
                    }
                }

                // Determine compilation mode based on edit type
                const isInteractiveEdit =
                    shouldSendIncrementalLayer &&
                    (dragActiveAtRequest ||
                        (incrementalChangeSource !== null &&
                            incrementalChangeSource.startsWith('keyboard')));
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
                if (isInteractiveEdit && this.lastEditType === 'outline') {
                    compilationMode = 'outline-only';
                    optionOverrides = {
                        skip_features: true,
                        skip_kerning: true,
                        produce_varc_table: false
                    };
                } else if (
                    isInteractiveEdit &&
                    this.lastEditType === 'anchor'
                ) {
                    compilationMode = 'anchor-only';
                    optionOverrides = {
                        skip_kerning: true,
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

                result = await fontCompilation.compileEditingFromJsonCached(
                    this.currentFont.babelfontJson,
                    requestedRevisionKey,
                    subsetForCompile ?? [],
                    {
                        dragActive: dragActiveAtRequest,
                        compileSource: this.lastChangeSource || undefined,
                        dirtyGlyphName,
                        dirtyLayerId,
                        dirtyLayerData,
                        optionOverrides
                    }
                );

                const currentRevisionKey = String(
                    this.currentFont.changeVersion
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

            this.editingFont = new Uint8Array(result.result);
            const duration = (performance.now() - startTime).toFixed(2);

            const sourceInfo = this.lastChangeSource
                ? ` [triggered by: ${this.lastChangeSource}]`
                : '';
            console.log(
                `✅ Editing font compiled in ${duration}ms (${this.editingFont.length} bytes)${sourceInfo}`
            );

            // Hide any error messages in sidebar
            sidebarErrorDisplay.hideError();

            // Save debug editing font unless we're actively dragging points/anchors/components
            const isOutlineDragActive =
                this.lastChangeSource !== null &&
                this.lastChangeSource.startsWith('mouse-drag') &&
                !!window.glyphCanvas?.outlineEditor?.draggingSomething;

            if (isOutlineDragActive) {
                this.pendingDebugEditingFontSaveAfterDrag = true;
            } else {
                this.saveEditingFontToFileSystem();
                this.pendingDebugEditingFontSaveAfterDrag = false;
            }

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
                        duration: duration,
                        fontRevisionKey: responseRevisionKey,
                        dragActive:
                            this.lastChangeSource !== null &&
                            this.lastChangeSource.startsWith('mouse-drag') &&
                            !!window.glyphCanvas?.outlineEditor
                                ?.draggingSomething,
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

        // Capture change version at start of compilation
        const startVersion = this.currentFont.changeVersion;

        const changeSource = this.lastChangeSource || 'unknown';
        const isOutlineIncrementalChange =
            changeSource === 'mouse-drag' || changeSource === 'keyboard';

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
        if (this.currentFont.changeVersion !== startVersion) {
            // Data changed during compilation! Keep compile flag enabled so auto-compile
            // loop will trigger a fresh compilation with latest data.
            // Don't clear compile flag - keep it true to trigger another compile.
            console.log(
                `[FontManager] Data changed during compilation (v${startVersion} → v${this.currentFont.changeVersion}), marking for recompile...`
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
            if (this.lastCompilationMode !== 'full' && this.currentFont) {
                console.log(
                    '[FontManager] Debounced full compile triggered after interactive editing'
                );
                // Reset lastEditType so the upcoming compile uses compilationMode = 'full'
                // (with kern/features). Do this regardless of needsRecompile — if a compile
                // is still in progress, the auto-compile loop's data-changed retry will pick
                // up lastEditType = null and produce a full compile instead of outline-only.
                this.lastEditType = null;
                this.currentFont.markDirty('full-compile-debounce');
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
        this.currentFont?.markDirty('full-compile-required');
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

    private getLayer(
        glyphName: string,
        layerId: string
    ): Babelfont.Layer | null {
        // Get layer data for a specific glyph and layer ID
        let glyph = this.getGlyph(glyphName);
        if (!glyph || !glyph.layers) {
            console.warn(
                `[FontManager] getLayer: glyph "${glyphName}" not found or has no layers`
            );
            return null;
        }
        let layer = glyph.layers.find((l) => l.id === layerId);
        if (!layer) {
            console.warn(
                `[FontManager] getLayer: layer ID "${layerId}" not found in glyph "${glyphName}"`,
                {
                    availableLayerIds: glyph.layers.map((l) => l.id),
                    requestedLayerId: layerId
                }
            );
            return null;
        }
        return layer;
    }

    /**
     *  Fetch layer data for a specific glyph, including nested components
     */
    fetchLayerData(
        componentGlyphName: string,
        selectedLayerId: string
    ): Babelfont.Layer | null {
        // Fetch layer data for a specific glyph, recursively fetching nested component layer data
        let layer = this.getLayer(componentGlyphName, selectedLayerId);
        if (!layer) {
            return null;
        }
        // Recursively fetch component layer data for nested components
        for (const shape of layer.shapes || []) {
            if ('reference' in shape && shape.reference) {
                let nestedData = this.fetchLayerData(
                    shape.reference,
                    selectedLayerId
                );
                if (nestedData) {
                    shape.layerData = nestedData;
                }
            }
        }
        return layer;
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
            // Only include non-background layers that are DEFAULT layers for their master
            // (not AssociatedWithMaster layers, which are intermediate/alternate designs)
            if (!layer.is_background) {
                // Check if this is a default layer
                const layerAny = layer as any;
                const hasTaggedMaster =
                    layerAny.master &&
                    typeof layerAny.master === 'object' &&
                    'type' in layerAny.master;
                const isDefaultLayer =
                    hasTaggedMaster &&
                    layerAny.master.type === 'DefaultForMaster';

                if (isDefaultLayer) {
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

        // Helper function to recursively clean shapes for saving
        const cleanShapeForSaving = (shape: Babelfont.Shape): any => {
            const pathCandidate = extractPathShape(shape as any);
            if (
                pathCandidate &&
                typeof pathCandidate === 'object' &&
                'nodes' in pathCandidate
            ) {
                // For Path shapes, convert nodes to string format and strip runtime properties
                let nodesValue: string | Babelfont.Node[] = pathCandidate.nodes;

                // Convert array to string if needed
                if (Array.isArray(nodesValue)) {
                    nodesValue = Path.nodesToString(nodesValue);
                }

                return {
                    nodes: nodesValue as string,
                    closed: pathCandidate.closed,
                    ...(pathCandidate.format_specific && {
                        format_specific: pathCandidate.format_specific
                    })
                    // Omit isInterpolated and other runtime properties
                };
            }

            const componentCandidate = extractComponentShape(shape as any);
            if (
                componentCandidate &&
                typeof componentCandidate === 'object' &&
                'reference' in componentCandidate
            ) {
                // Strip the layerData property from components before saving
                // layerData is only for internal rendering, not part of the font format
                return {
                    reference: componentCandidate.reference,
                    transform: componentCandidate.transform,
                    ...(componentCandidate.location && {
                        location: componentCandidate.location
                    }),
                    ...(componentCandidate.format_specific && {
                        format_specific: componentCandidate.format_specific
                    })
                    // Note: layerData and isInterpolated are intentionally omitted
                };
            }

            // For other shape types (Anchor, etc.), create a clean copy
            // Avoid JSON.parse(JSON.stringify()) which can fail on circular refs
            const isObject =
                shape && typeof shape === 'object' && !Array.isArray(shape);
            if (isObject) {
                return { ...(shape as object) } as Babelfont.Shape;
            }
            return shape;
        };

        // Convert nodes array back to string format and strip internal properties
        let newShapes = layerData.shapes?.map(cleanShapeForSaving);

        // Deep copy anchors and guides to avoid circular references
        const cleanAnchors = layerData.anchors?.map((anchor) => ({
            name: anchor.name,
            x: anchor.x,
            y: anchor.y
        }));

        const cleanGuides = layerData.guides?.map((guide) => ({
            pos: {
                x: guide.pos.x,
                y: guide.pos.y,
                angle: guide.pos.angle
            },
            name: guide.name,
            ...(guide.color && { color: guide.color })
        }));

        // Create a clean copy of the layer data with only serializable properties
        // Don't save isInterpolated flag - it's runtime state only
        let layerDataCopy: Babelfont.Layer = {
            width: layerData.width,
            height: layerData.height,
            vertWidth: layerData.vertWidth,
            name: layerData.name,
            id: layerData.id,
            master: layerData.master,
            shapes: newShapes || [],
            isInterpolated: false, // Always false for saved data
            // Copy other optional properties if they exist
            ...(cleanAnchors && { anchors: cleanAnchors }),
            ...(cleanGuides && { guides: cleanGuides }),
            ...(layerData.color && { color: layerData.color }),
            ...(layerData.layer_index !== undefined && {
                layer_index: layerData.layer_index
            }),
            ...(layerData.is_background !== undefined && {
                is_background: layerData.is_background
            }),
            ...(layerData.background_layer_id && {
                background_layer_id: layerData.background_layer_id
            }),
            ...(layerData.location && { location: { ...layerData.location } }),
            ...(layerData.format_specific && {
                format_specific: layerData.format_specific
            }),
            // Preserve the tagged master property
            ...((layerData as any).master && {
                master: (layerData as any).master
            })
        };

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
        let layerIndex = glyph.layers.findIndex((l) => l.id === layerId);
        if (layerIndex === -1) {
            console.error(
                `[FontManager]`,
                `Layer ${layerId} not found in glyph ${glyphName} - cannot save layer data`
            );
            return;
        }
        // Directly assign the cleaned layer data (no need for JSON.parse/stringify)
        glyph.layers[layerIndex] = layerDataCopy;

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

        // Schedule debounced full compile after interactive editing stops
        if (isInteractiveEdit && this.lastEditType) {
            this.scheduleFullCompileDebounce();
        }

        this.currentFont!.markDirty(changeSource);
        window.autoCompileManager.checkAndSchedule();
        await this.updateDirtyIndicator();

        // Update worker's font cache so glyph overview renders correctly
        // Skip during dragging to prevent clearing caches repeatedly - will update on drag end
        if (!isInteractiveEdit) {
            try {
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
                        type: 'storeLayerData',
                        glyphName: currentGlyphName,
                        layerId: currentLayerId,
                        layerData: layerDataCopy
                    });
                    updatedViaIncrementalLayer = true;
                    this.pendingBabelfontJsonSyncAfterDrag = false;
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

                await fontCompilation.sendMessage({
                    type: 'storeFontJson',
                    babelfontJson: this.currentFont.babelfontJson
                });
                console.log(
                    '[FontManager] Worker font cache updated after drag'
                );
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
                console.log(
                    '[FontManager] Dispatching glyphChanged event for',
                    glyphName
                );
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
async function fontCompilationReady() {
    if (!fontCompilation || !fontCompilation.isInitialized) {
        // Wait up to 30 seconds for initialization
        let attempts = 0;
        while (
            attempts < 300 &&
            (!fontCompilation || !fontCompilation.isInitialized)
        ) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            attempts++;
        }
        if (!fontCompilation || !fontCompilation.isInitialized) {
            console.error(
                '[FontManager]',
                '❌ Font compilation system not ready after 30 seconds'
            );
            return;
        }
    }
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
    await fontCompilationReady();

    const openSessionSpanId = timelineSpanStart('font.openSession');

    let fullCompileDeferredTimer: number | null = null;
    let canvasReadyListener: ((event: Event) => void) | null = null;
    let overviewReadyListener: ((event: Event) => void) | null = null;
    let startupReleased = false;
    let canvasReady = false;
    let overviewReady = false;

    const tryReleaseStartupGates = (openSessionId: string) => {
        if (!canvasReady || !overviewReady) {
            return;
        }

        releaseStartupGates(openSessionId, 'canvas+overview-ready', true);
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

        if (overviewReadyListener) {
            window.removeEventListener(
                'overviewInitialRenderComplete',
                overviewReadyListener
            );
            overviewReadyListener = null;
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

        endLoadingCursor();

        timelineSpanEnd(openSessionSpanId);
    };

    try {
        // Get the babelfont JSON from the event
        const detail = (event as CustomEvent).detail;
        const openSessionId = createOpenSessionId();
        const openedAt = performance.now();

        startupOpenSessionActive = true;
        startupOpenSessionEditingCompileCount = 0;

        emitOpenLifecycle(openSessionId, 'fontLoaded', {
            path: detail.path,
            sourcePluginId: detail.sourcePlugin?.id || null
        });

        // Prioritize first-open UX over continuous background recompiles/QC.
        window.autoCompileManager?.setStartupBlocked?.(true);
        window.fullCompileManager?.setEnabled?.(false);

        // Store font in worker's Rust instance for glyph operations
        // This ensures the font is cached BEFORE fontReady fires
        try {
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

        emitOpenLifecycle(openSessionId, 'loadFontComplete');

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
            tryReleaseStartupGates(openSessionId);
        };

        window.addEventListener('canvasInitialReady', canvasReadyListener);

        overviewReadyListener = (overviewEvent: Event) => {
            const overviewDetail = (overviewEvent as CustomEvent).detail;
            if (
                overviewDetail?.openSessionId &&
                overviewDetail.openSessionId !== openSessionId
            ) {
                return;
            }

            overviewReady = true;
            emitOpenLifecycle(openSessionId, 'overviewInitialRenderComplete', {
                reason: overviewDetail?.reason,
                glyphCount: overviewDetail?.glyphCount,
                renderDurationMs: overviewDetail?.renderDurationMs,
                totalElapsedMs: overviewDetail?.totalElapsedMs
            });
            tryReleaseStartupGates(openSessionId);
        };

        window.addEventListener(
            'overviewInitialRenderComplete',
            overviewReadyListener
        );

        // Dispatch fontReady event (font is loaded, currentFont is set)
        window.dispatchEvent(
            new CustomEvent('fontReady', {
                detail: { path: detail.path, openSessionId, openedAt }
            })
        );

        emitOpenLifecycle(openSessionId, 'fontReadyDispatched');

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
                window.dispatchEvent(
                    new CustomEvent('fontOpenEditingCompiled', {
                        detail: {
                            path: detail.path,
                            openSessionId,
                            openedAt,
                            elapsedMs: editingCompileElapsedMs
                        }
                    })
                );
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
                overviewReady
            });
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
