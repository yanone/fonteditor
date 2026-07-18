// Filesystem Plugin Architecture
// Defines extensible plugin system for different filesystem access methods

import type { FileSystemAdapter } from './file-system-adapter';
import { OPFSAdapter, NativeAdapter } from './file-system-adapter';
import { Logger } from './logger';
import { dispatchManagedFileChanged } from './managed-file-events';

const console = new Logger('FilesystemPlugins');

/**
 * Title bar menu item for plugin-specific actions
 */
export interface TitleBarMenuItem {
    label: string;
    action: () => Promise<void>;
    icon?: string; // Optional Material icon name
}

export type FileContextAction =
    | 'open'
    | 'open-new-tab'
    | 'open-in-script-editor'
    | 'download'
    | 'rename'
    | 'delete';

export interface FileContextTarget {
    path: string;
    name: string;
    isDir: boolean;
}

export interface PluginMessageOptions {
    icon: string;
    title: string;
    message: string;
    detail?: string;
    tone?: 'info' | 'warning' | 'error';
    actionLabel?: string;
    onAction?: () => void;
    spinning?: boolean;
}

/**
 * Abstract base class for filesystem plugins
 * Each plugin represents a different method of accessing files (OPFS, disk, cloud, etc.)
 */
export abstract class FilesystemPlugin {
    protected adapter: FileSystemAdapter;

    constructor(adapter: FileSystemAdapter) {
        this.adapter = adapter;
    }

    /** Unique identifier for this plugin (e.g., 'memory', 'disk', 'cloud') */
    abstract getId(): string;

    /** Display name shown in UI (e.g., 'Memory', 'Disk', 'Cloud Storage') */
    abstract getName(): string;

    /** Icon/emoji shown in UI (e.g., '🧠', '💾', '☁️') */
    abstract getIcon(): string;

    /** Get the underlying filesystem adapter */
    getAdapter(): FileSystemAdapter {
        return this.adapter;
    }

    /** Whether this plugin supports saving files */
    canSave(): boolean {
        return true; // Default: all plugins can save
    }

    /** Whether this plugin supports uploading files and folders */
    supportsUpload(): boolean {
        return true; // Default: all plugins support upload
    }

    /** Whether this plugin supports creating new folders */
    supportsNewFolder(): boolean {
        return true; // Default: plugins support folder creation
    }

    /** Whether this plugin supports creating new empty files */
    supportsNewFile(): boolean {
        return true; // Default: plugins support new file creation
    }

    /** Whether this plugin requires user permission/authentication */
    requiresPermission(): boolean {
        return false; // Default: no permission needed
    }

    /**
     * Called when plugin is activated (user switches to this context)
     * Override to perform setup, check permissions, etc.
     * @returns true if activation successful, false if failed
     */
    async onActivate(): Promise<boolean> {
        return true; // Default: always succeeds
    }

    /**
     * Called when plugin is deactivated (user switches away)
     * Override to perform cleanup
     */
    async onDeactivate(): Promise<void> {
        // Default: no cleanup needed
    }

    /**
     * Show plugin-specific setup UI (e.g., folder picker, login dialog)
     * @returns true if setup completed, false if cancelled
     */
    async showSetupUI(options?: {
        startIn?: FileSystemHandle;
    }): Promise<boolean> {
        return true; // Default: no setup needed
    }

    /**
     * Check if plugin is ready to use (has directory selected, authenticated, etc.)
     */
    async isReady(): Promise<boolean> {
        return true; // Default: always ready
    }

    /**
     * Get the current root path for this plugin's context
     */
    getDefaultPath(): string {
        return '/'; // Default: root
    }

    /**
     * Whether this plugin can be closed (e.g., disconnect folder access)
     */
    canClose(): boolean {
        return false; // Default: cannot be closed
    }

    /**
     * Close/disconnect this plugin's access (e.g., clear folder handle)
     * Only called if canClose() returns true
     */
    async close(): Promise<void> {
        // Default: no-op
    }

    /**
     * Update UI elements specific to this plugin's state
     * Called during initialization and context switching
     * @param uiCallbacks Object containing UI update functions
     */
    async updateUI(uiCallbacks: {
        showOpenFolderUI: () => void;
        hideOpenFolderUI: () => void;
        showPermissionBanner: (show: boolean) => void;
        showUnsupportedBrowserUI: () => void;
        hideUnsupportedBrowserUI: () => void;
        showPluginMessage: (options: PluginMessageOptions) => void;
        hidePluginMessage: () => void;
    }): Promise<void> {
        // Default: hide all special UI elements
        uiCallbacks.hideOpenFolderUI();
        uiCallbacks.showPermissionBanner(false);
        uiCallbacks.hideUnsupportedBrowserUI();
        uiCallbacks.hidePluginMessage();
    }

    /**
     * Get title bar menu items for this plugin
     * @returns Array of menu items to display in dropdown, or empty array if no menu
     */
    getTitleBarMenuItems(): TitleBarMenuItem[] {
        return []; // Default: no menu items
    }

    supportsFileContextAction(
        action: FileContextAction,
        target: FileContextTarget
    ): boolean {
        switch (action) {
            case 'open':
            case 'open-new-tab':
                return !target.isDir;
            case 'open-in-script-editor':
                return !target.isDir && target.name.endsWith('.py');
            case 'download':
                return !target.isDir;
            case 'rename':
            case 'delete':
                return true;
            default:
                return false;
        }
    }

    /**
     * Trigger a redraw of the title bar buttons for this plugin
     * Call this when plugin state changes and UI needs to update
     */
    redrawTitleBarButtons(): void {
        // Dispatch custom event that file-browser will listen for
        window.dispatchEvent(
            new CustomEvent('pluginTitleBarRedraw', {
                detail: { pluginId: this.getId() }
            })
        );
    }

    /** Whether the file dialog should show a manual refresh button. */
    showsManualRefreshButton(): boolean {
        return true;
    }

    /** Whether this plugin should be visible in editor UI surfaces. */
    isVisibleInUI(): boolean {
        return true;
    }

    // ==========================================
    // Script Editor File Capabilities
    // ==========================================

    /**
     * Whether this plugin supports opening files via a file picker dialog
     * If false, files can only be opened via the Files view context menu
     */
    supportsOpenFilePicker(): boolean {
        return false; // Default: no file picker support
    }

    /**
     * Whether this plugin supports Save As via a file picker dialog
     * If false, only Save (to existing path) is supported
     */
    supportsSaveAsFilePicker(): boolean {
        return false; // Default: no save-as picker support
    }

    /**
     * Whether this plugin handles Save As internally (bypassing writeFile).
     * When true, the file dialog calls handleSaveAs(name) instead of
     * adapter.writeFile(path, content). The plugin is responsible for the
     * full save flow — creating the asset, updating currentFont, etc.
     * Returns false if the plugin does not intercept Save As.
     */
    get interceptsSaveAs(): boolean {
        return false;
    }

    /**
     * Plugin-specific Save As handler, called instead of adapter.writeFile
     * when interceptsSaveAs is true. The name is the value the user typed in
     * the save-name field. Should return true on success.
     */
    async handleSaveAs(_name: string): Promise<boolean> {
        return false;
    }

    /**
     * Plugin-specific open handler for paths that cannot be read through the
     * generic adapter.readFile pipeline.
     * Return true when the plugin fully handled the open.
     */
    async handleOpenPath(_path: string): Promise<boolean> {
        return false;
    }

    /**
     * Open a file picker dialog and return the selected file path
     * Only called if supportsOpenFilePicker() returns true
     * @param options Options for the file picker
     * @returns The selected file path, or null if cancelled
     */
    async showOpenFilePicker(options?: {
        types?: { description: string; accept: Record<string, string[]> }[];
        startIn?: string;
    }): Promise<string | null> {
        return null; // Default: not implemented
    }

    /**
     * Show a save file picker dialog and return the selected file path
     * Only called if supportsSaveAsFilePicker() returns true
     * @param options Options for the file picker
     * @returns The selected file path, or null if cancelled
     */
    async showSaveFilePicker(options?: {
        suggestedName?: string;
        types?: { description: string; accept: Record<string, string[]> }[];
        startIn?: string;
    }): Promise<string | null> {
        return null; // Default: not implemented
    }
}

/**
 * Memory Plugin - uses OPFS (Origin Private File System) for browser storage
 */
export class MemoryPlugin extends FilesystemPlugin {
    constructor() {
        super(new OPFSAdapter());
    }

    getId(): string {
        return 'memory';
    }

    getName(): string {
        return 'Memory';
    }

    getIcon(): string {
        return '<span class="material-symbols-outlined">memory</span>';
    }

    getDefaultPath(): string {
        return '/user'; // Memory context starts in /user folder
    }
}

/**
 * Disk Plugin - uses File System Access API for direct disk access
 */
export class DiskPlugin extends FilesystemPlugin {
    private nativeAdapter: NativeAdapter;
    private fileSystemObserver: any = null;
    private observerSupported: boolean = 'FileSystemObserver' in window;

    constructor() {
        const adapter = new NativeAdapter();
        super(adapter);
        this.nativeAdapter = adapter;
    }

    getId(): string {
        return 'disk';
    }

    getName(): string {
        return 'Disk';
    }

    getIcon(): string {
        return '<span class="material-symbols-outlined">hard_drive</span>';
    }

    requiresPermission(): boolean {
        return true;
    }

    showsManualRefreshButton(): boolean {
        return !this.observerSupported;
    }

    async onActivate(): Promise<boolean> {
        // Check if directory is already selected
        const isReady = await this.isReady();
        if (!isReady) {
            // Will show setup UI via file-browser
            return false;
        }

        // Check permissions
        const hasPermission = await this.nativeAdapter.checkPermission();
        if (!hasPermission) {
            // Will show permission banner via file-browser
            return false;
        }

        // Set up file system observer
        await this.setupFileSystemObserver();

        return true;
    }

    async onDeactivate(): Promise<void> {
        this.disconnectObserver();
    }

    /**
     * Set up FileSystemObserver to watch for changes in the selected directory
     */
    private async setupFileSystemObserver(): Promise<void> {
        this.disconnectObserver();

        if (!this.observerSupported) {
            console.log(
                '[DiskPlugin] FileSystemObserver not supported, changes require manual refresh'
            );
            return;
        }

        try {
            const rootHandle = await this.nativeAdapter.getHandleAtPath('/');
            if (!rootHandle || rootHandle.kind !== 'directory') {
                console.log(
                    '[DiskPlugin] Cannot get root directory handle for observer'
                );
                return;
            }

            const FileSystemObserver = (window as any).FileSystemObserver;
            this.fileSystemObserver = new FileSystemObserver(
                async (records: any[]) => {
                    console.log(
                        '[DiskPlugin] FileSystemObserver detected changes:',
                        records.length
                    );
                    // Dispatch event that file-browser listens for
                    window.dispatchEvent(
                        new CustomEvent('diskFilesChanged', {
                            detail: { records }
                        })
                    );
                    dispatchManagedFileChanged({
                        pluginId: this.getId(),
                        source: 'file-system-observer',
                        records,
                        internalWrite: false
                    });
                }
            );

            await this.fileSystemObserver.observe(rootHandle, {
                recursive: true
            });
            console.log(
                '[DiskPlugin] FileSystemObserver watching root directory'
            );
        } catch (error) {
            console.error(
                '[DiskPlugin] Failed to set up FileSystemObserver:',
                error
            );
        }
    }

    /**
     * Disconnect the FileSystemObserver
     */
    private disconnectObserver(): void {
        if (this.fileSystemObserver) {
            try {
                this.fileSystemObserver.disconnect();
            } catch (e) {
                // Ignore disconnect errors
            }
            this.fileSystemObserver = null;
        }
    }

    async showSetupUI(options?: {
        startIn?: FileSystemHandle;
    }): Promise<boolean> {
        // Show directory picker
        try {
            const selected = await this.nativeAdapter.selectDirectory(options);
            if (!selected) {
                return false;
            }
            // Trigger title bar redraw to show dropdown button
            this.redrawTitleBarButtons();
            // Set up file system observer for new directory
            await this.setupFileSystemObserver();
            return true;
        } catch (error) {
            console.error('[DiskPlugin] Setup cancelled or failed:', error);
            return false;
        }
    }

    async isReady(): Promise<boolean> {
        return await this.nativeAdapter.hasDirectory();
    }

    getDefaultPath(): string {
        return '/'; // Disk context starts at root of selected folder
    }

    supportsUpload(): boolean {
        return false; // Disk plugin does not support file/folder uploads
    }

    /** Get the name of the selected directory */
    getDirectoryName(): string | null {
        return this.nativeAdapter.getDirectoryName();
    }

    /** Request write permission for disk access */
    async requestPermission(): Promise<boolean> {
        const permission = await this.nativeAdapter.requestPermission();
        return permission === 'granted';
    }

    canClose(): boolean {
        return true; // Disk plugin can be closed to select different folder
    }

    /** Close access to current disk folder */
    async close(): Promise<void> {
        this.disconnectObserver();
        await this.nativeAdapter.clearDirectory();
        console.log('[DiskPlugin]', 'Folder access closed');
    }

    getTitleBarMenuItems(): TitleBarMenuItem[] {
        return [
            {
                label: 'Close Folder Access',
                icon: 'close',
                action: async () => {
                    await this.close();
                    // Trigger UI update via event
                    window.dispatchEvent(new CustomEvent('pluginFolderClosed'));
                }
            }
        ];
    }

    async updateUI(uiCallbacks: {
        showOpenFolderUI: () => void;
        hideOpenFolderUI: () => void;
        showPermissionBanner: (show: boolean) => void;
        showUnsupportedBrowserUI: () => void;
        hideUnsupportedBrowserUI: () => void;
    }): Promise<void> {
        // Check if browser is unsupported
        if ((this as any)._unsupported) {
            uiCallbacks.showUnsupportedBrowserUI();
            uiCallbacks.showPermissionBanner(false);
            return;
        }

        uiCallbacks.hideUnsupportedBrowserUI();

        const isReady = await this.isReady();

        if (!isReady) {
            uiCallbacks.showOpenFolderUI();
            uiCallbacks.showPermissionBanner(false);
        } else {
            uiCallbacks.hideOpenFolderUI();

            // Check permissions
            const permission = await this.nativeAdapter.checkPermission();
            if (permission !== 'granted') {
                uiCallbacks.showPermissionBanner(true);
            } else {
                uiCallbacks.showPermissionBanner(false);
            }
        }
    }

    /** Clear the selected directory */
    async clearDirectory(): Promise<void> {
        await this.nativeAdapter.clearDirectory();
    }

    // ==========================================
    // Script Editor File Capabilities
    // ==========================================

    supportsOpenFilePicker(): boolean {
        // Only support file picker when a folder is selected
        return this.nativeAdapter.hasDirectory();
    }

    supportsSaveAsFilePicker(): boolean {
        // Only support save-as picker when a folder is selected
        return this.nativeAdapter.hasDirectory();
    }

    async showOpenFilePicker(options?: {
        types?: { description: string; accept: Record<string, string[]> }[];
        startIn?: string;
    }): Promise<string | null> {
        if (!this.nativeAdapter.hasDirectory()) {
            return null;
        }

        try {
            const pickerOptions: any = {
                multiple: false
            };

            if (options?.types) {
                pickerOptions.types = options.types;
            }

            // Try to start in the specified directory, or root
            const startPath = options?.startIn || '/';
            const startHandle =
                await this.nativeAdapter.getHandleAtPath(startPath);
            if (startHandle) {
                pickerOptions.startIn = startHandle;
            }

            const [fileHandle] = await (window as any).showOpenFilePicker(
                pickerOptions
            );

            // Get the path relative to our root
            const relativePath = await this.getRelativePath(fileHandle);
            return relativePath;
        } catch (error: any) {
            if (error.name === 'AbortError') {
                console.log('[DiskPlugin] Open file picker cancelled');
                return null;
            }
            console.error('[DiskPlugin] Error opening file picker:', error);
            return null;
        }
    }

    async showSaveFilePicker(options?: {
        suggestedName?: string;
        types?: { description: string; accept: Record<string, string[]> }[];
        startIn?: string;
    }): Promise<string | null> {
        if (!this.nativeAdapter.hasDirectory()) {
            return null;
        }

        try {
            const pickerOptions: any = {};

            if (options?.suggestedName) {
                pickerOptions.suggestedName = options.suggestedName;
            }

            if (options?.types) {
                pickerOptions.types = options.types;
            }

            // Try to start in the specified directory, or root
            const startPath = options?.startIn || '/';
            const startHandle =
                await this.nativeAdapter.getHandleAtPath(startPath);
            if (startHandle) {
                pickerOptions.startIn = startHandle;
            }

            const fileHandle = await (window as any).showSaveFilePicker(
                pickerOptions
            );

            // Get the path relative to our root
            const relativePath = await this.getRelativePath(fileHandle);
            return relativePath;
        } catch (error: any) {
            if (error.name === 'AbortError') {
                console.log('[DiskPlugin] Save file picker cancelled');
                return null;
            }
            console.error('[DiskPlugin] Error saving file picker:', error);
            return null;
        }
    }

    /**
     * Get the path of a file handle relative to our root directory
     * Returns null if the file is outside our root
     */
    private async getRelativePath(
        fileHandle: FileSystemFileHandle
    ): Promise<string | null> {
        try {
            const rootHandle = await this.nativeAdapter.getHandleAtPath('/');
            if (!rootHandle || rootHandle.kind !== 'directory') {
                return null;
            }

            const pathParts = await (rootHandle as any).resolve(fileHandle);
            if (pathParts === null) {
                // File is outside our root directory
                console.warn(
                    '[DiskPlugin] Selected file is outside the root directory'
                );
                return null;
            }

            return '/' + pathParts.join('/');
        } catch (error) {
            console.error('[DiskPlugin] Error resolving path:', error);
            return null;
        }
    }
}

/**
 * Singleton registry for filesystem plugins
 */
class FilesystemPluginRegistry {
    private plugins: Map<string, FilesystemPlugin> = new Map();
    private defaultPluginId: string | null = null;

    /**
     * Register a filesystem plugin
     */
    register(plugin: FilesystemPlugin): void {
        const id = plugin.getId();
        if (this.plugins.has(id)) {
            console.warn(
                `[PluginRegistry] Plugin '${id}' already registered, replacing`
            );
        }
        this.plugins.set(id, plugin);
        console.log(
            `[PluginRegistry] Registered plugin: ${id} (${plugin.getName()})`
        );

        // First plugin registered becomes default
        if (this.defaultPluginId === null) {
            this.defaultPluginId = id;
        }
    }

    /**
     * Get a plugin by ID
     */
    get(id: string): FilesystemPlugin | null {
        return this.plugins.get(id) || null;
    }

    /**
     * Get all registered plugins
     */
    getAll(): FilesystemPlugin[] {
        return Array.from(this.plugins.values());
    }

    /**
     * Get all plugin IDs
     */
    getIds(): string[] {
        return Array.from(this.plugins.keys());
    }

    /**
     * Check if a plugin is registered
     */
    has(id: string): boolean {
        return this.plugins.has(id);
    }

    /**
     * Set the default plugin ID
     */
    setDefault(id: string): void {
        if (!this.plugins.has(id)) {
            throw new Error(
                `Cannot set default plugin '${id}': not registered`
            );
        }
        this.defaultPluginId = id;
    }

    /**
     * Get the default plugin
     */
    getDefault(): FilesystemPlugin | null {
        if (this.defaultPluginId === null) {
            return null;
        }
        return this.plugins.get(this.defaultPluginId) || null;
    }

    /**
     * Get the default plugin ID
     */
    getDefaultId(): string | null {
        return this.defaultPluginId;
    }
}

// Export singleton instance
export const pluginRegistry = new FilesystemPluginRegistry();

// Auto-register built-in plugins
pluginRegistry.register(new MemoryPlugin());
pluginRegistry.register(new DiskPlugin());
pluginRegistry.setDefault('memory');

console.log(
    '[FilesystemPlugins] ✅ Plugin system initialized with',
    pluginRegistry.getIds().join(', ')
);
