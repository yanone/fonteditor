import TabLifecycleManager from './tab-lifecycle.js';
import ThemeSwitcher from './theme-switcher.js';
import AIAssistant from './ai-assistant.js';
import CacheManager from './cache-manager.js';
import type { FontCompilation } from './font-compilation.js';
import FontManager from './font-manager.js';
import { GlyphCanvas } from './glyph-canvas.js';
import MemoryMonitor from './memory-monitor.js';
import ResizableViews from './resizer.js';
import SaveButton from './save-button.js';
import { Font } from './babelfont-model.js';
import type MCPLogTransport from './mcp-transport.js';
import type { StateManager, EditorState } from './state-manager.js';
declare global {
    // Any property augmentation we make to the Window interface
    // should be declared here.
    interface Window {
        // From our dependencies
        opentype: any; // OpenType.js
        pyodide: any; // Pyodide
        createHarfBuzz: any; // HarfBuzz.js
        hbjs: any; // HarfBuzz.js
        hbInit: () => Promise<void>; // HarfBuzz.js

        // From index.html helper functions
        isDevelopment: () => boolean;
        isProduction: () => boolean;
        isTestMode: () => boolean;
        isTest: () => boolean;

        // Build metadata
        EDITOR_VERSION: string | null;
        BUILD_HASH_FULL: string | null;
        BUILD_HASH_SHORT: string | null;

        // From mcp-transport.js
        mcpTransport: MCPLogTransport;

        // From ai-assistant.js
        aiAssistant: AIAssistant;

        // From auto-compile-manager.js
        autoCompileManager: {
            checkAndSchedule: () => void;
            setEnabled: (enabled: boolean) => void;
            scheduleCompilation: () => void;
            testDirtyCheck: () => void;
            forceTrigger: () => void;
            getStatus: () => {
                isEnabled: boolean;
                isCompiling: boolean;
                loopRunning: boolean;
            };
        };

        // From cache-manager.js
        cacheManager: CacheManager;
        cacheStats: () => { size: number; itemCount: number };

        // From python-utils.js
        cleanPythonTraceback: (
            errorMessage: string,
            options?: number | { lineOffset?: number; skipExecFrames?: boolean }
        ) => string;
        adjustTracebackLineNumbers: (
            errorMessage: string,
            lineOffset: number,
            framePatterns?: string[]
        ) => string;
        countCodeLines: (code: string) => number;

        // From critical-error-handler.ts
        showCriticalError: (
            title: string,
            message: string,
            instructions: string
        ) => void;
        isWebAssemblyMemoryError: (error: Error) => boolean;

        // From canvas-plugin-manager.ts
        canvasPluginManager: {
            discoverPlugins: () => Promise<void>;
            drawPluginsAbove: (
                layerData: any,
                glyphName: string,
                ctx: CanvasRenderingContext2D,
                viewportManager: any
            ) => Promise<void>;
            drawPluginsBelow: (
                layerData: any,
                glyphName: string,
                ctx: CanvasRenderingContext2D,
                viewportManager: any
            ) => Promise<void>;
            getPluginInstance: (entryPoint: string) => any;
            getPlugins: () => any[];
            isLoaded: () => boolean;
            isPluginEnabled: (entryPoint: string) => boolean;
            enablePlugin: (entryPoint: string) => void;
            disablePlugin: (entryPoint: string) => void;
            togglePlugin: (entryPoint: string) => boolean;
        };

        // From editor-plugins-ui.js
        editorPluginsUI: {
            updatePluginList: () => void;
        };

        // From glyph-overview-filters.ts
        glyphOverviewFilterManager: {
            initialize: (
                sidebarContainer: HTMLElement,
                glyphOverview: any
            ) => void;
            discoverPlugins: () => Promise<void>;
            refreshPlugins: () => Promise<void>;
            getPlugins: () => any[];
            isLoaded: () => boolean;
            getActiveFilter: () => any | null;
            clearActiveFilter: () => void;
            updateSelectedGlyphGroups: (groups: Set<string>) => void;
            clearGroupSelection: () => void;
        };

        // From file-browser.js
        navigateToPath: (
            path: string,
            highlightFolder?: string
        ) => Promise<void>;
        navigateToParent: () => Promise<void>;
        navigateToCurrentFont: () => Promise<void>;
        updateHomeButtonVisibility: () => void;
        selectFile: (filePath: string) => void;
        initFileBrowser: () => Promise<void>;
        uploadFiles: (
            files: File[] | FileList,
            targetPathOrOptions?:
                | string
                | null
                | {
                      directory?: string | null;
                      pluginId?: string;
                  }
        ) => Promise<void>;
        createFolder: () => Promise<void>;
        createFile: () => Promise<void>;
        deleteItem: (
            itemPath: string,
            itemName: string,
            isDir: boolean
        ) => Promise<void>;
        handleFileUpload: (e: Event) => void;
        openFont: (path: string) => Promise<void>;
        downloadFile: (filePath: string, fileName: string) => Promise<void>;
        selectDiskFolder: () => Promise<void>;
        reEnableAccess: () => Promise<void>;
        parseFileUri: (
            uri: string
        ) => { pluginId: string; path: string } | null;

        // From font-compilation.js
        fontCompilation: FontCompilation;
        compileFontFromPython: (command: string) => Promise<any>;
        compileFontDirect: (
            fontVarName: string,
            outputFile: string
        ) => Promise<Uint8Array>;
        compileFontFromJson: (
            json: any,
            outputFile: string
        ) => Promise<Uint8Array>;
        shapeTextWithFont: (
            fontBytes: Uint8Array,
            text: string
        ) => Promise<string[]>;

        // From file-browser.js
        refreshFileSystem: () => Promise<void>;

        // From font-manager.js
        fontManager: FontManager;

        // From state-manager.ts
        stateManager: StateManager & {
            focused_view: string;
            editor_file: string;
            editor_text_buffer: string;
            editor_cursor_position: number;
            editor_mode: 'text' | 'edit';
            editor_glyph_stack: string;
            editor_isInterpolating: boolean;
            editor_isAnimating: boolean;
            editor_opentype_features_in_subset: Record<string, boolean>;
            editor_opentype_features_not_in_subset: Record<string, boolean>;
            editor_variation_location: Record<string, number>;
            editor_active_canvas_plugins: string[];
            [key: string]: any;
        };

        // From babelfont-model.js
        currentFontModel: Font | null;

        // From font-interpolation.js
        fontInterpolation: FontInterpolationManager;

        // From font-info.ts
        fontInfoManager: {
            updateEditorTheme: (theme: 'light' | 'dark') => void;
        };

        // From glyph-canvas.js
        glyphCanvas: GlyphCanvas;

        // From keyboard-navigation.js
        focusView: (viewId: string) => void;

        // From bootstrap.ts (loading status)
        updateLoadingStatus: (message: string, isReady?: boolean) => void;

        // From matplotlib-handler.js
        showMatplotlibPlot: (element: HTMLElement) => void;
        closePlotModal: () => void;

        // From memory-monitor.js
        memoryMonitor: MemoryMonitor;
        MemoryMonitor: any; // MemoryMonitor class

        // From python-ui-sync.js
        setFontLoadingState: (loading: boolean) => void;

        // From pyodide-official-console.js
        consoleEcho: (msg: string, ...opts: any[]) => void;
        consoleError: (msg: string, ...opts: any[]) => void;
        term: any; // Terminal
        clearConsole: () => void;

        // From python-execution-wrapper.js
        beforePythonExecution?: () => void;
        afterPythonExecution?: () => void;

        // From resizer.js
        resizableViews: ResizableViews;

        // From save-button.js
        _fontSaveCallbacks: {
            beforeSave: (fontId: string, filename: string) => void;
            afterSave: (
                fontId: string,
                filename: string,
                duration: number
            ) => void;
            onError: (fontId: string, filename: string, error: string) => void;
        };
        saveButton: SaveButton;

        // From script-editor.js
        ace: any; // Ace
        scriptEditor: {
            runScript: () => void;
            openFile: (path: string, pluginId: string) => Promise<boolean>;
            openFileFromUri: (uri: string) => Promise<boolean>;
            newFile: () => Promise<void>;
            save: () => Promise<boolean>;
            saveAs: () => Promise<boolean>;
            updateFilePath: (newPath: string) => void;
            get editor(): any; // Ace Editor instance
            get isModified(): boolean;
            get currentFilePath(): string | null;
            get currentPluginId(): string | null;
        };

        // From file-browser.ts
        pluginRegistry: {
            get: (id: string) => any;
            getDefault: () => any;
            getAll: () => any[];
            getIds: () => string[];
        };
        fileBrowser: {
            getCurrentPlugin: () => any;
            getCurrentPath: () => string;
        };

        // From index.html (inline script)
        isDevelopment: () => boolean;
        isProduction: () => boolean;
        isTestMode: () => boolean;

        // From settings.js
        APP_SETTINGS: Record<string, any>;

        // From tab-lifecycle.js
        tabLifecycleManager: TabLifecycleManager;

        // From theme-switcher.js
        themeSwitcher: ThemeSwitcher;

        // From view-settings.js
        VIEW_SETTINGS: Record<string, any>;

        // From keyboard-navigation.js
        resizeView: (viewId: string) => void;
        collapseActiveView: (viewId: string) => void;
        getCurrentFocusedView: () => string | null;

        // From view-title-buttons.ts
        updateViewTitleButtonVisibility: (viewId: string) => void;
    }
}

/**
 * Font Interpolation Manager
 */
interface FontInterpolationManager {
    setWorker(worker: Worker): void;
    interpolateGlyph(
        glyphName: string,
        location: Record<string, number>
    ): Promise<any>;
    interpolateGlyphs(
        glyphNames: string[],
        location: Record<string, number>
    ): Promise<Map<string, any>>;
    clearCache(): Promise<void>;
    handleWorkerMessage(e: MessageEvent): void;
}

export {};
