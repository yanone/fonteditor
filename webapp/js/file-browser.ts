// File Browser for in-browser memfs
// Shows the Pyodide file system in view 3

import tippy, { Instance as TippyInstance } from 'tippy.js';
import 'tippy.js/dist/tippy.css';
import {
    FileSystemAdapter,
    isFileSystemAccessSupported,
    FileInfo
} from './file-system-adapter';
import { showCriticalError } from './critical-error-handler';
import {
    pluginRegistry,
    FilesystemPlugin,
    DiskPlugin,
    TitleBarMenuItem
} from './filesystem-plugins';
import {
    getOrCreateBackdrop,
    addTippyBackdropSupport,
    getTheme,
    setupMenuKeyboardNav
} from './tippy-utils';
import { Logger } from './logger';

const console = new Logger('FileBrowser');

const LAST_CONTEXT_KEY = 'last-filesystem-context';

// Files/folders to hide from the file browser (applies to all plugins)
const HIDDEN_FILES: string[] = ['.DS_Store'];

function getPathStorageKey(pluginId: string): string {
    return `last-path-${pluginId}`;
}

interface FileSystemState {
    currentPath: string;
    currentPlugin: FilesystemPlugin;
    activeAdapter: FileSystemAdapter;
}

let fileSystemCache: FileSystemState = {
    currentPath: '/',
    currentPlugin: pluginRegistry.getDefault()!,
    activeAdapter: pluginRegistry.getDefault()!.getAdapter()
};

type OpenFontOptions = {
    sourcePluginOverride?: FilesystemPlugin;
};

let detachedLaunchFilename: string | null = null;
let detachedLaunchFileHandle: FileSystemFileHandle | null = null;

let diskFontReloadDebounceTimer: number | null = null;
const pendingDiskChangePaths = new Set<string>();

function normalizeObservedPath(path: string): string {
    const cleaned = path.replace(/\\/g, '/').replace(/^\/+/, '');
    return `/${cleaned}`.replace(/\/+/g, '/');
}

function extractChangedPathsFromRecords(records: any[]): string[] {
    const paths = new Set<string>();

    const addPath = (value: any) => {
        if (typeof value === 'string' && value.trim()) {
            paths.add(normalizeObservedPath(value));
        }
    };

    for (const record of records || []) {
        if (!record || typeof record !== 'object') {
            continue;
        }

        addPath((record as any).path);
        addPath((record as any).relativePath);
        addPath((record as any).changedPath);
        addPath((record as any).oldPath);
        addPath((record as any).newPath);

        const relComps = (record as any).relativePathComponents;
        if (Array.isArray(relComps) && relComps.length > 0) {
            addPath(relComps.join('/'));
        }

        const movedFrom = (record as any).movedFrom;
        if (movedFrom && typeof movedFrom === 'object') {
            addPath((movedFrom as any).path);
            const comps = (movedFrom as any).relativePathComponents;
            if (Array.isArray(comps) && comps.length > 0) {
                addPath(comps.join('/'));
            }
        }

        const movedTo = (record as any).movedTo;
        if (movedTo && typeof movedTo === 'object') {
            addPath((movedTo as any).path);
            const comps = (movedTo as any).relativePathComponents;
            if (Array.isArray(comps) && comps.length > 0) {
                addPath(comps.join('/'));
            }
        }
    }

    return Array.from(paths);
}

function getFontWatchRoots(fontPath: string): string[] {
    const extension = fontPath.split('.').pop()?.toLowerCase() || '';

    if (
        extension === 'ufo' ||
        extension === 'glyphspackage' ||
        extension === 'glyphpackage'
    ) {
        return [fontPath];
    }

    if (extension === 'designspace') {
        const parent = fontPath.substring(0, fontPath.lastIndexOf('/')) || '/';
        return [parent];
    }

    return [fontPath];
}

function isPathWithinRoot(path: string, root: string): boolean {
    const normalizedPath = normalizeObservedPath(path);
    const normalizedRoot = normalizeObservedPath(root);

    if (normalizedPath === normalizedRoot) {
        return true;
    }

    return normalizedPath.startsWith(`${normalizedRoot}/`);
}

function changedPathsAffectCurrentFont(
    changedPaths: string[],
    currentFontPath: string
): boolean {
    const watchRoots = getFontWatchRoots(currentFontPath);
    return changedPaths.some((changedPath) =>
        watchRoots.some((root) => isPathWithinRoot(changedPath, root))
    );
}

function hasUnsavedFontChanges(currentFont: any): boolean {
    if (!currentFont) {
        return false;
    }

    if (currentFont.hasUnsavedChanges === true) {
        return true;
    }

    const dirtyIndicator = document.getElementById('file-dirty-indicator');
    return !!dirtyIndicator?.classList.contains('visible');
}

function confirmExternalFontReload(): boolean {
    return window.confirm(
        'External font changes detected with unsaved local changes. OK = reload external (discard local unsaved); Cancel = keep local changes.'
    );
}

async function maybeReloadCurrentFontFromDisk(
    changedPaths: string[]
): Promise<void> {
    if (!changedPaths.length) {
        return;
    }

    const currentFont = window.fontManager?.currentFont;
    if (!currentFont) {
        return;
    }

    if (currentFont.sourcePlugin.getId() !== 'disk') {
        return;
    }

    if (!changedPathsAffectCurrentFont(changedPaths, currentFont.path)) {
        return;
    }

    if (window.fontManager.isExternalReloading) {
        return;
    }

    if (hasUnsavedFontChanges(currentFont)) {
        const shouldReloadExternal = confirmExternalFontReload();
        if (!shouldReloadExternal) {
            return;
        }
    }

    try {
        await window.fontManager.reloadCurrentFontFromSource({
            preserveUiState: true
        });
        console.log('[FileBrowser]', 'External font reload completed');
    } catch (error) {
        console.error('[FileBrowser]', 'External font reload failed:', error);
        const errorMessage =
            error instanceof Error ? error.message : String(error);
        alert(`Failed to reload externally changed font: ${errorMessage}`);
    }
}

function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function truncatePathMiddle(
    path: string,
    availableWidth: number,
    fontSize = 10
): string {
    // Estimate characters that fit (using average character width for Inter font)
    // Inter at 10px has roughly 5px average character width (narrower than 0.6 ratio)
    const avgCharWidth = fontSize * 0.52;
    const maxChars = Math.floor(availableWidth / avgCharWidth);

    if (path.length <= maxChars || maxChars < 10) return path;

    // Calculate how much to show on each side
    const ellipsis = '...';
    const charsToShow = maxChars - ellipsis.length;
    const charsStart = Math.ceil(charsToShow * 0.4); // 40% at start
    const charsEnd = Math.floor(charsToShow * 0.6); // 60% at end

    const start = path.substring(0, charsStart);
    const end = path.substring(path.length - charsEnd);

    return `${start}${ellipsis}${end}`;
}

/**
 * Create a file URI from plugin ID and path
 * Format: pluginId:///path/to/file
 */
function createFileUri(pluginId: string, path: string): string {
    return `${pluginId}:///${path.startsWith('/') ? path.slice(1) : path}`;
}

/**
 * Parse a file URI into plugin ID and path
 * Format: pluginId:///path/to/file
 */
function parseFileUri(uri: string): { pluginId: string; path: string } | null {
    const match = uri.match(/^([^:]+):\/\/\/(.*)$/);
    if (!match) return null;
    return {
        pluginId: match[1],
        path: '/' + match[2]
    };
}

function updatePathDisplay(path: string) {
    const pathTextElement = document.querySelector(
        '.file-path-text'
    ) as HTMLElement;
    if (!pathTextElement) return;

    const availableWidth = pathTextElement.offsetWidth;
    const displayPath = truncatePathMiddle(path, availableWidth, 10);
    pathTextElement.textContent = displayPath;
}

function fileTypeIcon(iconName: string): string {
    return `<span class="material-symbols-outlined file-type-icon">${iconName}</span>`;
}

function isFontPackageDirectory(filename: string, isDir: boolean): boolean {
    if (!isDir) return false;
    const lowerName = filename.toLowerCase();
    return lowerName.endsWith('.glyphspackage') || lowerName.endsWith('.ufo');
}

function getFileIcon(filename: string, isDir: boolean): string {
    const lowerName = filename.toLowerCase();

    if (isDir) {
        return isFontPackageDirectory(filename, isDir)
            ? fileTypeIcon('folder_zip')
            : fileTypeIcon('folder');
    }

    const ext = lowerName.split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'py':
            return fileTypeIcon('code');
        case 'txt':
            return fileTypeIcon('description');
        case 'json':
            return fileTypeIcon('data_object');
        case 'md':
            return fileTypeIcon('article');
        case 'html':
            return fileTypeIcon('language');
        case 'css':
            return fileTypeIcon('palette');
        case 'js':
            return fileTypeIcon('code');
        case 'png':
        case 'jpg':
        case 'jpeg':
        case 'gif':
            return fileTypeIcon('image');
        case 'pdf':
            return fileTypeIcon('picture_as_pdf');
        case 'zip':
            return fileTypeIcon('folder_zip');
        case 'ttf':
        case 'otf':
        case 'woff':
        case 'woff2':
            return fileTypeIcon('font_download');
        case 'babelfont':
        case 'glyphs':
        case 'glyphspackage':
        case 'vfj':
        case 'sfd':
        case 'ufo':
        case 'designspace':
            return fileTypeIcon('format_shapes');
        default:
            return fileTypeIcon('draft');
    }
}

function getFileClass(filename: string, isDir: boolean): string {
    if (isDir) return 'directory';

    const ext = filename.split('.').pop()?.toLowerCase();
    if (ext === 'py') return 'python-file';
    return 'file';
}

function isSupportedFontFormat(name: string, isDir: boolean): boolean {
    const lowerName = name.toLowerCase();

    if (isFontPackageDirectory(name, isDir)) {
        return true;
    }

    if (isDir) {
        return false;
    }

    // Check for supported font formats
    const supportedExtensions = [
        '.babelfont', // Native format
        '.glyphs', // Glyphs 2/3
        '.vfj', // FontLab VFJ
        '.sfd', // FontForge SFD
        '.designspace' // DesignSpace
    ];

    return supportedExtensions.some((ext) => lowerName.endsWith(ext));
}

// Helper functions for plugin menu dropdowns
function createPluginMenuHtml(menuItems: TitleBarMenuItem[]): string {
    const items = menuItems
        .map(
            (item) => `
        <div class="plugin-menu-item" data-action="${item.label}">
            ${item.icon ? `<span class="material-symbols-outlined">${item.icon}</span>` : ''}
            <span>${item.label}</span>
        </div>
    `
        )
        .join('');
    return `<div class="plugin-menu">${items}</div>`;
}

function createFileContextMenuHtml(
    path: string,
    name: string,
    isDir: boolean
): string {
    const items: string[] = [];

    // Open (for supported font formats)
    if (isSupportedFontFormat(name, isDir)) {
        items.push(`
            <div class="plugin-menu-item" data-action="open">
                <span class="material-symbols-outlined">folder_open</span>
                <span>Open</span>
            </div>
        `);
        items.push(`
            <div class="plugin-menu-item" data-action="open-new-tab">
                <span class="material-symbols-outlined">open_in_new</span>
                <span>Open in New Tab</span>
            </div>
        `);
    }

    // Open in Script Editor (for Python files)
    if (!isDir && name.endsWith('.py')) {
        items.push(`
            <div class="plugin-menu-item" data-action="open-in-script-editor">
                <span class="material-symbols-outlined">code</span>
                <span>Open in Script Editor</span>
            </div>
        `);
    }

    // Download (for files only)
    if (!isDir) {
        items.push(`
            <div class="plugin-menu-item" data-action="download">
                <span class="material-symbols-outlined">download</span>
                <span>Download</span>
            </div>
        `);
    }

    // Rename (for both files and folders)
    items.push(`
        <div class="plugin-menu-item" data-action="rename">
            <span class="material-symbols-outlined">edit</span>
            <span>Rename</span>
        </div>
    `);

    // Delete (for both files and folders)
    items.push(`
        <div class="plugin-menu-item" data-action="delete">
            <span class="material-symbols-outlined">delete</span>
            <span>Delete</span>
        </div>
    `);

    return `<div class="plugin-menu">${items.join('')}</div>`;
}

function setupMenuItemHandlers(
    tippyInstance: TippyInstance,
    menuItems: TitleBarMenuItem[]
): void {
    const menu = tippyInstance.popper.querySelector('.plugin-menu');
    if (!menu) return;

    menu.querySelectorAll('.plugin-menu-item').forEach((item, index) => {
        item.addEventListener('click', async () => {
            tippyInstance.hide();
            await menuItems[index].action();
        });
    });

    // Use shared keyboard navigation utility
    setupMenuKeyboardNav(menu);
}

// Track file context menu tippy instances for cleanup
let fileContextMenuTippyInstances: any[] = [];

function setupFileContextMenus() {
    // Destroy old tippy instances to prevent orphaned poppers
    fileContextMenuTippyInstances.forEach((instance) => {
        try {
            instance.destroy();
        } catch (e) {
            // Ignore errors from already-destroyed instances
        }
    });
    fileContextMenuTippyInstances = [];

    const fileItems = document.querySelectorAll('.file-item');

    // Create shared backdrop for all file context menus
    const backdrop = getOrCreateBackdrop('file-context-menu-backdrop');

    fileItems.forEach((item) => {
        const element = item as HTMLElement;
        const path = element.getAttribute('data-path') || '';
        const name = element.getAttribute('data-name') || '';
        const isDir = element.getAttribute('data-is-dir') === 'true';

        // Create Tippy context menu
        const tippyInstance = tippy(element, {
            content: createFileContextMenuHtml(path, name, isDir),
            allowHTML: true,
            interactive: true,
            trigger: 'manual',
            theme: getTheme(),
            placement: 'right-start',
            arrow: false,
            offset: [0, 0],
            appendTo: document.body,
            hideOnClick: false,
            zIndex: 9999,
            getReferenceClientRect: null as any, // Will be set on show
            onShown: (instance) => {
                const menu = instance.popper.querySelector('.plugin-menu');
                if (!menu) return;

                // Skip if handlers already set up
                if ((menu as any)._handlersSetup) return;
                (menu as any)._handlersSetup = true;

                // Setup click handlers for menu items
                menu.querySelectorAll('.plugin-menu-item').forEach(
                    (menuItem) => {
                        menuItem.addEventListener('click', async () => {
                            const action = menuItem.getAttribute('data-action');

                            // Hide menu and backdrop immediately
                            instance.hide();
                            backdrop.classList.remove('visible');
                            element.classList.remove('file-item-active');

                            // Wait for menu to fully hide before executing action
                            // This ensures the DOM is clean before rename input is shown
                            await new Promise((resolve) =>
                                requestAnimationFrame(resolve)
                            );

                            switch (action) {
                                case 'open':
                                    await openFont(path);
                                    break;
                                case 'open-new-tab':
                                    openFontInNewTab(path);
                                    break;
                                case 'open-in-script-editor':
                                    await openInScriptEditor(path);
                                    break;
                                case 'download':
                                    await downloadFile(path, name);
                                    break;
                                case 'rename':
                                    await renameItem(path, name, isDir);
                                    break;
                                case 'delete':
                                    await deleteItem(path, name, isDir);
                                    break;
                            }
                        });
                    }
                );
            }
        });

        // Add to instances array for cleanup
        fileContextMenuTippyInstances.push(tippyInstance);

        // Add backdrop and keyboard support
        addTippyBackdropSupport(tippyInstance, backdrop, {
            targetElement: element,
            activeClass: 'file-item-active'
        });

        // Prevent default context menu and show Tippy menu at mouse position
        element.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Set position to mouse cursor
            tippyInstance.setProps({
                getReferenceClientRect: () => ({
                    width: 0,
                    height: 0,
                    top: e.clientY,
                    bottom: e.clientY,
                    left: e.clientX,
                    right: e.clientX,
                    x: e.clientX,
                    y: e.clientY,
                    toJSON: () => ({})
                })
            });

            tippyInstance.show();
        });

        // Store tippy instance on element (for debugging access)
        (element as any)._tippy = tippyInstance;
    });
}

function updatePluginMenuButtonVisibility(plugin: FilesystemPlugin): void {
    const pluginId = plugin.getId();
    const button = document.querySelector(
        `.context-tab[data-plugin-id="${pluginId}"]`
    ) as HTMLElement;

    if (!button || !(button as any)._hasMenu) return;

    const dropdownIcon = button.querySelector(
        '.plugin-dropdown-icon'
    ) as HTMLElement;
    if (!dropdownIcon) return;

    // Show dropdown icon only if plugin is active and ready
    const isActive = button.classList.contains('active');
    if (isActive) {
        plugin.isReady().then((isReady) => {
            dropdownIcon.style.display = isReady ? 'inline-flex' : 'none';
        });
    } else {
        dropdownIcon.style.display = 'none';
    }
}

function openFontInNewTab(path: string) {
    const pluginId = fileSystemCache.currentPlugin.getId();
    const fileUri = createFileUri(pluginId, path);
    const params = new URLSearchParams();
    params.set('file', fileUri);

    const url = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
    window.open(url, '_blank');
    console.log('[FileBrowser]', `Opening font in new tab: ${fileUri}`);
}

/**
 * Open a Python file in the Script Editor
 */
async function openInScriptEditor(path: string) {
    const pluginId = fileSystemCache.currentPlugin.getId();

    if (window.scriptEditor && window.scriptEditor.openFile) {
        // Check if this file is already open
        if (
            window.scriptEditor.currentFilePath === path &&
            window.scriptEditor.currentPluginId === pluginId
        ) {
            alert('This file is already open in the Script Editor.');
            // Switch to scripts view
            const scriptView = document.getElementById('view-scripts');
            if (scriptView) {
                scriptView.click();
            }
            return;
        }

        try {
            await window.scriptEditor.openFile(path, pluginId);
            console.log(
                '[FileBrowser]',
                `Opened ${path} in Script Editor (plugin: ${pluginId})`
            );
        } catch (error) {
            console.error(
                '[FileBrowser]',
                'Error opening in Script Editor:',
                error
            );
            alert(
                'Failed to open file in Script Editor: ' +
                    (error as Error).message
            );
        }
    } else {
        console.error('[FileBrowser]', 'Script Editor not available');
        alert('Script Editor not available');
    }
}

async function collectDirectoryEntries(
    rootPath: string
): Promise<Record<string, Uint8Array>> {
    const entries: Record<string, Uint8Array> = {};
    const requiredTopLevelFiles = new Set([
        'fontinfo.plist',
        'order.plist',
        'UIState.plist'
    ]);

    const walk = async (currentPath: string) => {
        const items =
            await fileSystemCache.activeAdapter.scanDirectory(currentPath);

        for (const [, data] of Object.entries(items)) {
            const itemPath = data.path;
            if (data.is_dir) {
                await walk(itemPath);
                continue;
            }

            const content =
                await fileSystemCache.activeAdapter.readFile(itemPath);
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
            const isRequiredTopLevel = requiredTopLevelFiles.has(relativePath);

            if (!isGlyphFile && !isRequiredTopLevel) {
                continue;
            }

            entries[relativePath] = bytes;
        }
    };

    await walk(rootPath);
    return entries;
}

async function collectAllDirectoryEntries(
    rootPath: string
): Promise<Record<string, Uint8Array>> {
    const entries: Record<string, Uint8Array> = {};

    const walk = async (currentPath: string) => {
        const items =
            await fileSystemCache.activeAdapter.scanDirectory(currentPath);

        for (const [, data] of Object.entries(items)) {
            const itemPath = data.path;
            if (data.is_dir) {
                await walk(itemPath);
                continue;
            }

            const content =
                await fileSystemCache.activeAdapter.readFile(itemPath);
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

function getParentPath(path: string): string {
    const idx = path.lastIndexOf('/');
    return idx >= 0 ? path.slice(0, idx) : '';
}

async function openFont(
    path: string,
    fileHandle?: FileSystemFileHandle,
    options: OpenFontOptions = {}
) {
    if (!window.pyodide) {
        alert('Python not ready yet. Please wait a moment and try again.');
        return;
    }

    // Set loading cursor
    document.body.classList.add('loading');

    try {
        const startTime = performance.now();
        console.log('[FileBrowser]', `Opening font: ${path}`);

        const sourcePlugin =
            options.sourcePluginOverride || fileSystemCache.currentPlugin;
        const sourceAdapter = sourcePlugin.getAdapter() as any;

        const directoryHandleForSource: FileSystemDirectoryHandle | undefined =
            sourcePlugin.getId() === 'disk'
                ? sourceAdapter.directoryHandle
                : undefined;

        const isDetachedDiskLaunch =
            sourcePlugin.getId() === 'disk' &&
            !!fileHandle &&
            !directoryHandleForSource;

        // Determine file extension
        const extension = path.split('.').pop()?.toLowerCase() || '';
        const isGlyphsPackage = extension === 'glyphspackage';
        const isUfoDirectory = extension === 'ufo';
        const isDesignspace = extension === 'designspace';

        if (
            isDetachedDiskLaunch &&
            (isGlyphsPackage || isUfoDirectory || isDesignspace)
        ) {
            throw new Error(
                'This source format requires folder context. Please attach the containing folder in Disk context and open it from there.'
            );
        }

        let contents: string | Uint8Array | undefined;
        let packageEntries: Record<string, Uint8Array> | undefined;
        let projectEntries: Record<string, Uint8Array> | undefined;

        if (isDetachedDiskLaunch) {
            const launchedFile = await fileHandle!.getFile();
            const launchedBytes = new Uint8Array(
                await launchedFile.arrayBuffer()
            );
            contents =
                extension === 'babelfont'
                    ? new TextDecoder('utf-8').decode(launchedBytes)
                    : launchedBytes;
        } else if (isGlyphsPackage) {
            packageEntries = await collectDirectoryEntries(path);

            if (
                !packageEntries['fontinfo.plist'] ||
                !packageEntries['order.plist']
            ) {
                throw new Error(
                    'Invalid .glyphspackage: missing fontinfo.plist or order.plist'
                );
            }
        } else if (isUfoDirectory) {
            projectEntries = await collectAllDirectoryEntries(path);
        } else if (isDesignspace) {
            const projectRoot = getParentPath(path);
            projectEntries = await collectAllDirectoryEntries(projectRoot);
        } else {
            contents = await sourceAdapter.readFile(path);

            // For text-based formats (.babelfont is JSON), decode from UTF-8
            // For binary formats (.glyphs, .ufo, etc.), keep as Uint8Array - Python/Rust handles format detection
            if (extension === 'babelfont' && contents instanceof Uint8Array) {
                contents = new TextDecoder('utf-8').decode(contents);
            }
            // All other formats: keep as Uint8Array for worker to handle
        }

        let babelfontJson: string;

        // For non-.babelfont files, use Rust loader to convert
        if (extension !== 'babelfont') {
            console.log(
                '[FileBrowser]',
                `Detected ${extension} format, converting via Rust...`
            );

            if (!window.fontCompilation?.worker) {
                throw new Error('Font compilation worker not initialized');
            }

            // Send to worker for conversion
            babelfontJson = await new Promise<string>((resolve, reject) => {
                const id = Math.random().toString(36);
                const timeout = setTimeout(() => {
                    reject(
                        new Error('Font conversion timeout after 30 seconds')
                    );
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
                    filename: path.split('/').pop() || path,
                    contents,
                    packageEntries,
                    projectEntries
                });
            });

            console.log(
                '[FileBrowser]',
                `Successfully converted ${extension} to babelfont format`
            );
        } else {
            // For .babelfont files, use contents directly (already a string)
            babelfontJson = contents as string;
        }

        const endTime = performance.now();
        const duration = ((endTime - startTime) / 1000).toFixed(2);

        console.log(
            '[FileBrowser]',
            `Successfully opened font: ${path} (${duration}s)`
        );

        // Get file handle for disk plugin
        let actualFileHandle = fileHandle;
        if (
            !actualFileHandle &&
            sourcePlugin.getId() === 'disk' &&
            directoryHandleForSource
        ) {
            const diskPlugin = sourcePlugin as DiskPlugin;
            const adapter = diskPlugin.getAdapter() as any;
            if (adapter.getFileHandle) {
                actualFileHandle = await adapter.getFileHandle(path);
            }
        }

        const directoryHandle = directoryHandleForSource;

        // Dispatch fontLoaded event to font manager
        window.dispatchEvent(
            new CustomEvent('fontLoaded', {
                detail: {
                    path: path,
                    babelfontJson: babelfontJson,
                    sourcePlugin,
                    fileHandle: actualFileHandle,
                    directoryHandle: directoryHandle
                }
            })
        );

        // Update URL to reflect current file
        const pluginId = sourcePlugin.getId();
        const fileUri = createFileUri(pluginId, path);
        if (window.stateManager) {
            window.stateManager.editor_file = fileUri;
            window.stateManager.recordEvent('file_opened', 'FileBrowser', {
                fileUri
            });
        }

        // Restore focus to canvas if editor view is active
        const editorView = document.getElementById('view-editor');
        if (
            editorView &&
            editorView.classList.contains('focused') &&
            window.glyphCanvas &&
            window.glyphCanvas.canvas
        ) {
            setTimeout(() => window.glyphCanvas.canvas!.focus(), 0);
        }
    } catch (error: any) {
        console.error('[FileBrowser]', 'Error opening font:', error);
        alert(`Error opening font: ${error.message}`);
        // Reset cursor on error
        document.body.classList.remove('loading');
    }
}

async function switchContext(pluginId: string) {
    console.log('[FileBrowser]', `Switching to ${pluginId} context`);

    const plugin = pluginRegistry.get(pluginId);
    if (!plugin) {
        console.error('[FileBrowser]', `Plugin '${pluginId}' not found`);
        return;
    }

    // Deactivate old plugin
    await fileSystemCache.currentPlugin.onDeactivate();

    // Activate new plugin
    fileSystemCache.currentPlugin = plugin;
    fileSystemCache.activeAdapter = plugin.getAdapter();

    // Save to localStorage
    try {
        localStorage.setItem(LAST_CONTEXT_KEY, pluginId);
    } catch (e) {
        console.warn(
            '[FileBrowser]',
            'Failed to save context to localStorage:',
            e
        );
    }

    // Update tab UI
    document.querySelectorAll('.context-tab').forEach((tab) => {
        tab.classList.remove('active');
        if (tab.getAttribute('data-plugin-id') === pluginId) {
            tab.classList.add('active');
        }
    });

    // Update dropdown icon visibility for all plugins
    pluginRegistry.getAll().forEach((p) => {
        updatePluginMenuButtonVisibility(p);
    });

    // Try to activate plugin (may fail if setup needed)
    const activated = await plugin.onActivate();
    if (!activated) {
        // Plugin needs setup - let plugin update its own UI
        await plugin.updateUI({
            showOpenFolderUI,
            hideOpenFolderUI,
            showPermissionBanner,
            showUnsupportedBrowserUI,
            hideUnsupportedBrowserUI
        });
        return;
    }

    // Plugin activated successfully - let plugin update UI
    await plugin.updateUI({
        showOpenFolderUI,
        hideOpenFolderUI,
        showPermissionBanner,
        showUnsupportedBrowserUI,
        hideUnsupportedBrowserUI
    });

    // Update dropdown menu button visibility based on plugin capabilities
    updatePluginMenuButtonVisibility(plugin);

    // Restore last visited path for this plugin, or use default path
    let targetPath = plugin.getDefaultPath();
    try {
        const savedPath = localStorage.getItem(getPathStorageKey(pluginId));
        if (savedPath) {
            targetPath = savedPath;
            console.log(
                '[FileBrowser]',
                `Restored last path for ${pluginId}: ${savedPath}`
            );
        }
    } catch (e) {
        console.warn(
            '[FileBrowser]',
            'Failed to restore path from localStorage:',
            e
        );
    }

    fileSystemCache.currentPath = targetPath;
    await navigateToPath(targetPath);
}

function updateOpenFolderPromptForDetachedLaunch() {
    const openFolderContainer = document.getElementById(
        'open-folder-container'
    );
    if (!openFolderContainer) {
        return;
    }

    const titleElement = openFolderContainer.querySelector('h2');
    const bodyElement = openFolderContainer.querySelector('p');
    const buttonLabelElement = openFolderContainer.querySelector(
        '.open-folder-button .open-folder-button-label'
    );

    if (!titleElement || !bodyElement || !buttonLabelElement) {
        return;
    }

    if (detachedLaunchFilename) {
        titleElement.textContent = 'Attach Containing Folder';
        bodyElement.textContent = `Opened ${detachedLaunchFilename}. Attach its folder to enable full disk browsing and external reload.`;
        buttonLabelElement.textContent = 'Attach Folder';
        return;
    }

    titleElement.textContent = 'Open Folder';
    bodyElement.textContent =
        'Select a folder from your computer to browse and edit fonts directly.';
    buttonLabelElement.textContent = 'Select Folder';
}

async function selectDiskFolder() {
    try {
        const plugin = fileSystemCache.currentPlugin;
        if (!(plugin instanceof DiskPlugin)) {
            console.error('[FileBrowser]', 'Current plugin is not DiskPlugin');
            return;
        }

        const success = await plugin.showSetupUI({
            startIn: detachedLaunchFileHandle || undefined
        });
        if (success) {
            let targetPath = '/';
            const currentFont = window.fontManager?.currentFont;
            const currentFontHandle = currentFont?.fileHandle;

            if (
                currentFont &&
                currentFont.sourcePlugin.getId() === 'disk' &&
                currentFontHandle
            ) {
                const resolvedPath =
                    await resolveDiskPathForLaunchedFileHandle(
                        currentFontHandle
                    );

                if (resolvedPath) {
                    currentFont.path = resolvedPath;
                    const adapter = plugin.getAdapter() as any;
                    currentFont.directoryHandle = adapter.directoryHandle;

                    targetPath =
                        resolvedPath.substring(
                            0,
                            resolvedPath.lastIndexOf('/')
                        ) || '/';

                    const fileUri = createFileUri('disk', resolvedPath);
                    if (window.stateManager) {
                        window.stateManager.editor_file = fileUri;
                        window.stateManager.recordEvent(
                            'file_opened',
                            'FileBrowser',
                            {
                                fileUri
                            }
                        );
                    }
                }
            }

            detachedLaunchFilename = null;
            detachedLaunchFileHandle = null;
            updateOpenFolderPromptForDetachedLaunch();
            hideOpenFolderUI();
            fileSystemCache.currentPath = targetPath;
            await navigateToPath(targetPath);

            setTimeout(() => {
                const fileTree = document.getElementById('file-tree');
                const currentFontItem = fileTree?.querySelector(
                    '.file-item.current-font'
                );
                if (currentFontItem) {
                    (currentFontItem as HTMLElement).scrollIntoView({
                        block: 'center',
                        behavior: 'auto'
                    });
                }
            }, 100);
        }
    } catch (error: any) {
        console.error('[FileBrowser]', 'Error selecting folder:', error);
        alert(`Error selecting folder: ${error.message}`);
    }
}

function showFileTree() {
    const fileTree = document.getElementById('file-tree');
    if (fileTree) {
        fileTree.style.display = 'block';
        console.log('[FileBrowser]', 'File tree shown');
    }
}

function hideFileTree() {
    const fileTree = document.getElementById('file-tree');
    if (fileTree) {
        fileTree.style.display = 'none';
        console.log('[FileBrowser]', 'File tree hidden');
    }
}

function showUnsupportedBrowserUI() {
    const container = document.getElementById('plugin-message-container');
    if (container) {
        container.innerHTML = `
            <div class="plugin-message-content">
                <span class="material-symbols-outlined plugin-message-icon warning">info</span>
                <h3>Browser Not Supported</h3>
                <p>Your browser doesn't support native file system access for the Disk context.</p>
                <p class="browser-suggestion">Please use Chrome/Chromium 86+, Edge 86+, or Safari 15.2+ for full functionality.<br>You can use the Memory context for browser storage.</p>
            </div>
        `;
        container.classList.add('visible');
    }
    hideFileTree();
}

function hideUnsupportedBrowserUI() {
    const container = document.getElementById('plugin-message-container');
    if (container) {
        container.innerHTML = '';
        container.classList.remove('visible');
    }
    showFileTree();
}

async function reEnableAccess() {
    try {
        const plugin = fileSystemCache.currentPlugin;
        if (!(plugin instanceof DiskPlugin)) {
            console.error('[FileBrowser]', 'Current plugin is not DiskPlugin');
            return;
        }

        const permission = await plugin.requestPermission();
        if (permission) {
            showPermissionBanner(false);
            await refreshFileSystem();
        } else {
            alert('Permission not granted. Please try again.');
        }
    } catch (error: any) {
        console.error('[FileBrowser]', 'Error requesting permission:', error);
        alert(`Error requesting permission: ${error.message}`);
    }
}

function showPermissionBanner(show: boolean) {
    const banner = document.getElementById('permission-banner');
    if (banner) {
        banner.style.display = show ? 'flex' : 'none';
    }
}

function showOpenFolderUI() {
    const openFolderContainer = document.getElementById(
        'open-folder-container'
    );

    updateOpenFolderPromptForDetachedLaunch();

    if (openFolderContainer) {
        openFolderContainer.classList.add('visible');
    }
    hideFileTree();
}

function hideOpenFolderUI() {
    const openFolderContainer = document.getElementById(
        'open-folder-container'
    );

    if (openFolderContainer) {
        openFolderContainer.classList.remove('visible');
    }
    showFileTree();
}

async function scanDirectory(
    path: string = '/'
): Promise<Record<string, FileInfo>> {
    return await fileSystemCache.activeAdapter.scanDirectory(path);
}

async function createFolder() {
    const currentPath = fileSystemCache.currentPath || '/';
    const folderName = prompt('Enter folder name:');

    if (!folderName) return;

    // Validate folder name
    if (folderName.includes('/') || folderName.includes('\\')) {
        alert('Folder name cannot contain / or \\');
        return;
    }

    try {
        const newPath = `${currentPath}/${folderName}`;
        await fileSystemCache.activeAdapter.createFolder(newPath);
        console.log('[FileBrowser]', `Created folder: ${newPath}`);
        await refreshFileSystem();
    } catch (error: any) {
        console.error('[FileBrowser]', 'Error creating folder:', error);
        alert(`Error creating folder: ${error.message}`);
    }
}

async function createFile() {
    const currentPath = fileSystemCache.currentPath || '/';
    const fileName = prompt('Enter file name:');

    if (!fileName) return;

    // Validate file name
    if (fileName.includes('/') || fileName.includes('\\')) {
        alert('File name cannot contain / or \\');
        return;
    }

    try {
        const newPath = `${currentPath}/${fileName}`;
        // Create empty file
        await fileSystemCache.activeAdapter.writeFile(
            newPath,
            new Uint8Array(0)
        );
        console.log('[FileBrowser]', `Created file: ${newPath}`);
        await refreshFileSystem();
    } catch (error: any) {
        console.error('[FileBrowser]', 'Error creating file:', error);
        alert(`Error creating file: ${error.message}`);
    }
}

async function downloadFile(filePath: string, fileName: string) {
    try {
        // Get the file content
        const fileContent =
            await fileSystemCache.activeAdapter.readFile(filePath);

        // Ensure we have Uint8Array for blob creation
        let fileData: Uint8Array;
        if (typeof fileContent === 'string') {
            fileData = new TextEncoder().encode(fileContent);
        } else {
            fileData = new Uint8Array(fileContent as any);
        }

        // Create blob and download
        const fileBlob = new Blob([fileData as any], {
            type: 'application/octet-stream'
        });
        const url = URL.createObjectURL(fileBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);

        console.log('[FileBrowser]', `Downloaded: ${fileName}`);

        if (window.term) {
            window.term.echo(`[[;lime;]📥 Downloaded: ${fileName}]`);
        }
    } catch (error: any) {
        console.error('[FileBrowser]', 'Error downloading file:', error);
        alert(`Error downloading file: ${error.message}`);
    }
}

async function deleteItem(itemPath: string, itemName: string, isDir: boolean) {
    const confirmMsg = isDir
        ? `Delete folder "${itemName}" and all its contents?`
        : `Delete file "${itemName}"?`;

    if (!confirm(confirmMsg)) return;

    try {
        await fileSystemCache.activeAdapter.deleteItem(itemPath, isDir);
        console.log('[FileBrowser]', `Deleted: ${itemPath}`);
        await refreshFileSystem();
    } catch (error: any) {
        console.error('[FileBrowser]', 'Error deleting item:', error);
        alert(`Error deleting item: ${error.message}`);
    }
}

async function renameItem(itemPath: string, itemName: string, isDir: boolean) {
    // Find the file item element
    const fileItem = document.querySelector(
        `.file-item[data-path="${itemPath}"]`
    ) as HTMLElement;
    if (!fileItem) {
        console.error('[FileBrowser]', 'File item not found for rename');
        return;
    }

    // Find the name element
    const nameElement = fileItem.querySelector('.file-name') as HTMLElement;
    if (!nameElement) {
        console.error('[FileBrowser]', 'File name element not found');
        return;
    }

    // Store original name for cancel
    const originalName = itemName;

    // Create inline input
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'file-rename-input';
    input.value = itemName;

    // For files with extension, select only the name part
    const lastDotIndex = itemName.lastIndexOf('.');
    const hasExtension = !isDir && lastDotIndex > 0;

    // Replace name element with input
    nameElement.style.display = 'none';
    nameElement.parentNode!.insertBefore(input, nameElement.nextSibling);
    input.focus();

    // Select filename without extension
    if (hasExtension) {
        input.setSelectionRange(0, lastDotIndex);
    } else {
        input.select();
    }

    // Prevent click from propagating to parent
    input.addEventListener('click', (e) => e.stopPropagation());

    // Handle rename completion
    const completeRename = async () => {
        const newName = input.value.trim();

        // Remove input, restore name element
        input.remove();
        nameElement.style.display = '';

        if (!newName || newName === originalName) {
            return;
        }

        // Validate new name
        if (newName.includes('/') || newName.includes('\\')) {
            alert('Name cannot contain / or \\ characters');
            return;
        }

        try {
            await fileSystemCache.activeAdapter.renameItem(
                itemPath,
                newName,
                isDir
            );
            console.log('[FileBrowser]', `Renamed: ${itemPath} -> ${newName}`);

            // If this file is open in the script editor, update the path there
            if (!isDir && window.scriptEditor) {
                const pluginId = fileSystemCache.currentPlugin.getId();
                if (
                    window.scriptEditor.currentFilePath === itemPath &&
                    window.scriptEditor.currentPluginId === pluginId
                ) {
                    // Compute new path
                    const parentPath = itemPath.substring(
                        0,
                        itemPath.lastIndexOf('/')
                    );
                    const newPath = parentPath + '/' + newName;
                    window.scriptEditor.updateFilePath(newPath);
                    console.log(
                        '[FileBrowser]',
                        'Updated script editor file path to:',
                        newPath
                    );
                }
            }

            await refreshFileSystem();
        } catch (error: any) {
            console.error('[FileBrowser]', 'Error renaming item:', error);
            alert(`Error renaming item: ${error.message}`);
        }
    };

    // Handle cancel
    const cancelRename = () => {
        input.remove();
        nameElement.style.display = '';
    };

    // Enter to confirm, Escape to cancel
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            completeRename();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelRename();
        }
    });

    // Blur to confirm (like most file browsers)
    input.addEventListener('blur', () => {
        // Small delay to allow for click on other elements
        setTimeout(() => {
            if (document.body.contains(input)) {
                completeRename();
            }
        }, 100);
    });
}

async function uploadFiles(
    files: File[] | FileList,
    directoryOrOptions:
        | string
        | null
        | {
              directory?: string | null;
              pluginId?: string;
              skipRefresh?: boolean;
          } = null
) {
    const startTime = performance.now();
    const options =
        typeof directoryOrOptions === 'string' || directoryOrOptions === null
            ? { directory: directoryOrOptions, pluginId: undefined }
            : directoryOrOptions;

    const targetPlugin = options.pluginId
        ? pluginRegistry.get(options.pluginId)
        : null;

    if (options.pluginId && !targetPlugin) {
        throw new Error(`Upload target plugin '${options.pluginId}' not found`);
    }

    const targetAdapter = targetPlugin
        ? targetPlugin.getAdapter()
        : fileSystemCache.activeAdapter;

    const basePath =
        options.directory ||
        (targetPlugin
            ? targetPlugin.getDefaultPath() || '/'
            : fileSystemCache.currentPath || '/');

    const normalizedBasePath =
        basePath === '/' ? '/' : basePath.replace(/\/+$/, '') || '/';

    let uploadedCount = 0;

    for (const file of files) {
        try {
            // Handle files with relative paths (from folder upload)
            // file.webkitRelativePath contains the full path including folder structure
            const relativePath = file.webkitRelativePath || file.name;
            const normalizedRelativePath = relativePath.replace(/^\/+/, '');
            const fullpath =
                normalizedBasePath === '/'
                    ? `/${normalizedRelativePath}`
                    : `${normalizedBasePath}/${normalizedRelativePath}`;

            // Write file using adapter
            const contents = await file.arrayBuffer();
            await targetAdapter.writeFile(fullpath, new Uint8Array(contents));
            console.log('[FileBrowser]', `Uploading file: ${fullpath}`);
            uploadedCount++;
        } catch (error: any) {
            console.error(
                '[FileBrowser]',
                `Error uploading ${file.name}:`,
                error
            );
        }
    }

    if (uploadedCount > 0) {
        const endTime = performance.now();
        const duration = ((endTime - startTime) / 1000).toFixed(2);
        const uploadedToCurrentPlugin =
            !targetPlugin ||
            targetPlugin.getId() === fileSystemCache.currentPlugin.getId();

        const msg = `Uploaded ${uploadedCount} file(s) in ${duration} seconds`;

        console.log('[FileBrowser]', msg);
        if (window.term) {
            window.term.echo(`[[;lime;]${msg}]`);
        }

        if (uploadedToCurrentPlugin && !options.skipRefresh) {
            await refreshFileSystem();
        }
    }
}
async function buildFileTree(rootPath = '/') {
    const items = await scanDirectory(rootPath);
    let html = '';

    // Hidden file inputs for upload functionality
    html += `<input type="file" id="file-upload-input" multiple style="display: none;" 
           onchange="handleFileUpload(event)">
    <input type="file" id="folder-upload-input" webkitdirectory directory multiple style="display: none;" 
           onchange="handleFileUpload(event)">`;

    // Filter out hidden files, then sort: directories first, then files
    const sortedItems = Object.entries(items)
        .filter(([name]) => !HIDDEN_FILES.includes(name))
        .sort(([a, aData], [b, bData]) => {
            const aIsFontPackageDirectory = isFontPackageDirectory(
                a,
                aData.is_dir
            );
            const bIsFontPackageDirectory = isFontPackageDirectory(
                b,
                bData.is_dir
            );
            const aIsDirectory = aData.is_dir && !aIsFontPackageDirectory;
            const bIsDirectory = bData.is_dir && !bIsFontPackageDirectory;

            if (aIsDirectory && !bIsDirectory) return -1;
            if (!aIsDirectory && bIsDirectory) return 1;
            return a.localeCompare(b);
        });

    // Get current font path for highlighting
    const currentFontPath = window.fontManager?.currentFont?.path || null;

    for (const [name, data] of sortedItems) {
        const isPackageDirectory = isFontPackageDirectory(name, data.is_dir);
        const displayIsDir = data.is_dir && !isPackageDirectory;

        const icon = getFileIcon(name, displayIsDir);
        const fileClass = getFileClass(name, displayIsDir);
        const sizeText = displayIsDir
            ? ''
            : `<span class="file-size">${formatFileSize(data.size)}</span>`;

        // Check if this is a supported font file
        const isFontFile = isSupportedFontFormat(name, data.is_dir);
        const fontSourceClass = isFontFile ? 'font-source' : '';

        // Add 'current-font' class if this is the opened font
        const isCurrentFont = isFontFile && currentFontPath === data.path;
        const currentFontClass = isCurrentFont ? 'current-font' : '';

        // Add 'in-font-path' class if this is a directory in the path to the current font
        const isInFontPath =
            displayIsDir &&
            currentFontPath &&
            currentFontPath.startsWith(data.path + '/');
        const fontPathClass = isInFontPath ? 'in-font-path' : '';

        html += `<div class="file-item ${fileClass} ${fontSourceClass} ${currentFontClass} ${fontPathClass}" data-path="${data.path}" data-name="${name}" data-is-dir="${data.is_dir}" data-is-font="${isFontFile}">
            <span class="file-name">${icon} ${name}</span>${sizeText}
        </div>`;
    }

    return html;
}

function handleFileUpload(event: Event) {
    const files: FileList = (event.target as HTMLInputElement).files!;
    if (files.length > 0) {
        uploadFiles(files);
    }
    // Reset input so same file can be uploaded again
    (event.target as HTMLInputElement).value = '';
}

async function navigateToParent() {
    const currentPath = fileSystemCache.currentPath || '/';
    const parentPath =
        currentPath.substring(0, currentPath.lastIndexOf('/')) || '/';
    const previousFolderName = currentPath.substring(
        currentPath.lastIndexOf('/') + 1
    );
    await navigateToPath(parentPath, previousFolderName);
}

async function navigateToPath(path: string, highlightFolder?: string) {
    try {
        const fileTree = document.getElementById('file-tree');

        // Build content first (off-screen)
        const html = await buildFileTree(path);

        // Update path header with toolbar buttons
        let pathHeader = document.getElementById('file-path-header');
        if (!pathHeader) {
            pathHeader = document.createElement('div');
            pathHeader.id = 'file-path-header';
            const fileBrowser = document.getElementById('file-browser');
            fileBrowser!.insertBefore(pathHeader, fileBrowser!.firstChild);
        }

        // Generate toolbar buttons
        const parentBtn =
            path !== '/'
                ? `<button onclick="navigateToParent()" class="file-header-btn" title="Go to parent directory">
                <span class="material-symbols-outlined">arrow_upward</span>
            </button>`
                : '';

        const supportsUpload = fileSystemCache.currentPlugin.supportsUpload();
        const uploadButtons = supportsUpload
            ? `
                <button onclick="document.getElementById('file-upload-input').click()" class="file-header-btn" title="Upload files">
                    <span class="material-symbols-outlined">upload_file</span>
                </button>
                <button onclick="document.getElementById('folder-upload-input').click()" class="file-header-btn" title="Upload folder">
                    <span class="material-symbols-outlined">drive_folder_upload</span>
                </button>
            `
            : '';

        pathHeader.innerHTML = `
            <span class="file-path-text" title="${path}" data-full-path="${path}">${path}</span>
            <div class="file-header-actions">
                ${parentBtn}
                <button onclick="createFile()" class="file-header-btn" title="Create new file">
                    <span class="material-symbols-outlined">note_add</span>
                </button>
                <button onclick="createFolder()" class="file-header-btn" title="Create new folder">
                    <span class="material-symbols-outlined">create_new_folder</span>
                </button>
                ${uploadButtons}
                <button onclick="refreshFileSystem()" class="file-header-btn" title="Refresh">
                    <span class="material-symbols-outlined">refresh</span>
                </button>
            </div>
        `;

        // Update path display after DOM is ready
        setTimeout(() => updatePathDisplay(path), 0);

        // Set up ResizeObserver to update path on container resize
        const pathTextElement = pathHeader.querySelector(
            '.file-path-text'
        ) as HTMLElement;
        if (pathTextElement && !(pathTextElement as any)._resizeObserver) {
            const resizeObserver = new ResizeObserver(() => {
                const fullPath =
                    pathTextElement.getAttribute('data-full-path') || path;
                updatePathDisplay(fullPath);
            });
            resizeObserver.observe(pathTextElement);
            (pathTextElement as any)._resizeObserver = resizeObserver;
        }

        // Update file tree content in a single frame to prevent flickering
        requestAnimationFrame(() => {
            fileTree!.innerHTML = html;

            // Reset scroll to top immediately when no font is open (before any other scroll logic)
            const currentFont = window.fontManager?.currentFont;
            if (!currentFont && !highlightFolder) {
                fileTree!.scrollTop = 0;
            }

            // Setup context menus for file items (defer to next frame to ensure DOM is ready)
            requestAnimationFrame(() => {
                setupFileContextMenus();
                setupFileItemClickHandlers();

                // Highlight and scroll to specific folder if provided
                if (highlightFolder) {
                    const folderItem = Array.from(
                        fileTree!.querySelectorAll('.file-item')
                    ).find(
                        (item) =>
                            item.getAttribute('data-name') ===
                                highlightFolder &&
                            item.getAttribute('data-is-dir') === 'true'
                    ) as HTMLElement;

                    if (folderItem) {
                        folderItem.scrollIntoView({
                            block: 'center',
                            behavior: 'auto'
                        });
                        folderItem.classList.add('folder-highlight');
                        setTimeout(() => {
                            folderItem.classList.remove('folder-highlight');
                        }, 600);
                    }
                } else if (currentFont) {
                    // Only scroll to in-path folder if there's a current font open
                    const inPathItem = fileTree!.querySelector(
                        '.file-item.in-font-path'
                    );
                    if (inPathItem) {
                        inPathItem.scrollIntoView({
                            block: 'center',
                            behavior: 'auto'
                        });
                    }
                }
            });
        });

        // Cache the current path
        fileSystemCache.currentPath = path;

        // Save path to localStorage for current plugin
        try {
            const pluginId = fileSystemCache.currentPlugin.getId();
            localStorage.setItem(getPathStorageKey(pluginId), path);
        } catch (e) {
            console.warn(
                '[FileBrowser]',
                'Failed to save path to localStorage:',
                e
            );
        }

        // Setup drag & drop on the file tree (only if plugin supports upload)
        if (fileSystemCache.currentPlugin.supportsUpload()) {
            setupDragAndDrop();
        } else {
            teardownDragAndDrop();
        }
    } catch (error: any) {
        console.error('[FileBrowser]', 'Error navigating to path:', error);
        document.getElementById('file-tree')!.innerHTML = `
            <div style="color: #ff3300;">Error loading directory: ${error.message}</div>
        `;
    }
}

let dragCounter = 0;
let dragHandlers: {
    dragenter: (e: DragEvent) => void;
    dragover: (e: DragEvent) => void;
    dragleave: (e: DragEvent) => void;
    drop: (e: DragEvent) => void;
} | null = null;

function setupDragAndDrop() {
    const fileBrowser = document.getElementById('file-browser')!;

    // Remove existing handlers if any
    teardownDragAndDrop();

    dragCounter = 0;

    const handlers = {
        dragenter: (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            dragCounter++;
            fileBrowser.classList.add('drag-over');
        },
        dragover: (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
        },
        dragleave: (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            dragCounter--;
            if (dragCounter === 0) {
                fileBrowser.classList.remove('drag-over');
            }
        },
        drop: async (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            dragCounter = 0;
            fileBrowser.classList.remove('drag-over');

            const files = Array.from(e.dataTransfer!.files);
            if (files.length > 0) {
                await uploadFiles(files);
            }
        }
    };

    fileBrowser.addEventListener('dragenter', handlers.dragenter);
    fileBrowser.addEventListener('dragover', handlers.dragover);
    fileBrowser.addEventListener('dragleave', handlers.dragleave);
    fileBrowser.addEventListener('drop', handlers.drop);

    dragHandlers = handlers;
}

function teardownDragAndDrop() {
    const fileBrowser = document.getElementById('file-browser');
    if (!fileBrowser || !dragHandlers) return;

    fileBrowser.removeEventListener('dragenter', dragHandlers.dragenter);
    fileBrowser.removeEventListener('dragover', dragHandlers.dragover);
    fileBrowser.removeEventListener('dragleave', dragHandlers.dragleave);
    fileBrowser.removeEventListener('drop', dragHandlers.drop);

    fileBrowser.classList.remove('drag-over');
    dragCounter = 0;
    dragHandlers = null;
}

function selectFile(filePath: string) {
    console.log('[FileBrowser]', 'Selected file:', filePath);
    // TODO: Add file selection handling (e.g., show content, download, etc.)
}

// Click tracking for single vs double-click distinction
let clickTimer: number | null = null;
let clickPrevent = false;
const CLICK_DELAY = 250; // ms to wait for double-click

function setupFileItemClickHandlers() {
    const fileTree = document.getElementById('file-tree');
    if (!fileTree) return;

    const fileItems = fileTree.querySelectorAll('.file-item');
    fileItems.forEach((item) => {
        const element = item as HTMLElement;
        const path = element.dataset.path!;
        const isDir = element.dataset.isDir === 'true';
        const isFont = element.dataset.isFont === 'true';

        element.addEventListener('click', (e: Event) => {
            e.preventDefault();
            e.stopPropagation();

            if (clickPrevent) {
                return;
            }

            if (clickTimer) {
                // Double-click detected
                clearTimeout(clickTimer);
                clickTimer = null;
                clickPrevent = true;

                // Handle double-click
                if (isFont) {
                    console.log(
                        '[FileBrowser]',
                        'Double-click opening font:',
                        path
                    );
                    openFont(path);
                } else if (isDir) {
                    navigateToPath(path);
                }

                setTimeout(() => {
                    clickPrevent = false;
                }, CLICK_DELAY);
            } else {
                // First click - wait for potential double-click
                clickTimer = window.setTimeout(() => {
                    clickTimer = null;

                    // Handle single-click
                    if (isDir && !isFont) {
                        navigateToPath(path);
                    } else {
                        selectFile(path);
                    }
                }, CLICK_DELAY);
            }
        });
    });
}

async function refreshFileSystem() {
    const currentPath = fileSystemCache.currentPath || '/';
    console.log('[FileBrowser]', 'Refreshing file system...');

    // Preserve current plugin and adapter references
    const currentPlugin = fileSystemCache.currentPlugin;
    const activeAdapter = fileSystemCache.activeAdapter;

    fileSystemCache = {
        currentPath,
        currentPlugin,
        activeAdapter
    };

    // Reload current directory
    await navigateToPath(currentPath);

    console.log('[FileBrowser]', 'File system refreshed');
}

async function navigateToCurrentFont() {
    const currentFont = window.fontManager?.currentFont;
    if (!currentFont) {
        console.warn('[FileBrowser]', 'No font currently open');
        return;
    }

    const fontPath = currentFont.path;
    const fontPlugin = currentFont.sourcePlugin;

    // Switch to the plugin if needed
    if (fileSystemCache.currentPlugin.getId() !== fontPlugin.getId()) {
        await switchContext(fontPlugin.getId());
    }

    // Navigate to the directory containing the font
    const dirPath = fontPath.substring(0, fontPath.lastIndexOf('/')) || '/';
    await navigateToPath(dirPath);

    // Scroll the current font into view with smooth scrolling
    setTimeout(() => {
        const fileTree = document.getElementById('file-tree');
        const currentFontItem = fileTree?.querySelector(
            '.file-item.current-font'
        );
        if (currentFontItem) {
            (currentFontItem as HTMLElement).scrollIntoView({
                block: 'center',
                behavior: 'smooth'
            });
        }
    }, 100); // Small delay to ensure DOM is updated
}

function updateHomeButtonVisibility() {
    const homeBtn = document.getElementById('file-browser-home-btn');
    if (!homeBtn) return;

    const currentFont = window.fontManager?.currentFont;
    homeBtn.style.display = currentFont ? 'flex' : 'none';
}

function consumePendingLaunchFileHandles(): FileSystemFileHandle[] {
    const pending = (window as any).__pendingLaunchFileHandles;
    if (!Array.isArray(pending) || pending.length === 0) {
        return [];
    }

    (window as any).__pendingLaunchFileHandles = [];
    return pending.filter((handle) => handle?.kind === 'file');
}

async function resolveDiskPathForLaunchedFileHandle(
    fileHandle: FileSystemFileHandle
): Promise<string | null> {
    const diskPlugin = pluginRegistry.get('disk') as DiskPlugin | undefined;
    if (!diskPlugin) {
        return null;
    }

    const isReady = await diskPlugin.isReady();
    if (!isReady) {
        return null;
    }

    const adapter = diskPlugin.getAdapter() as any;
    if (!adapter.listFilesRecursive || !adapter.checkPermission) {
        return null;
    }

    const permission = await adapter.checkPermission();
    if (permission !== 'granted') {
        return null;
    }

    const files = await adapter.listFilesRecursive('/', 20);
    for (const file of files) {
        const candidateHandle = file.handle;
        if (
            !candidateHandle ||
            typeof candidateHandle.isSameEntry !== 'function'
        ) {
            continue;
        }

        try {
            const isSame = await candidateHandle.isSameEntry(fileHandle);
            if (isSame) {
                return file.path;
            }
        } catch (error) {
            console.warn('[FileBrowser]', 'Failed handle comparison:', error);
        }
    }

    return null;
}

function createDetachedLaunchPath(fileHandle: FileSystemFileHandle): string {
    const sanitizedName = fileHandle.name.replace(/[\\/]/g, '_');
    return `/__launched__/${sanitizedName}`;
}

async function openLaunchedFileHandle(
    fileHandle: FileSystemFileHandle
): Promise<void> {
    const diskPlugin = pluginRegistry.get('disk') as DiskPlugin | undefined;
    if (!diskPlugin) {
        throw new Error('Disk plugin is not available');
    }

    const resolvedPath = await resolveDiskPathForLaunchedFileHandle(fileHandle);
    if (resolvedPath) {
        detachedLaunchFilename = null;
        detachedLaunchFileHandle = null;
        await switchContext('disk');
        const dirPath =
            resolvedPath.substring(0, resolvedPath.lastIndexOf('/')) || '/';
        await navigateToPath(dirPath);
        await openFont(resolvedPath, fileHandle, {
            sourcePluginOverride: diskPlugin
        });
        return;
    }

    detachedLaunchFilename = fileHandle.name;
    detachedLaunchFileHandle = fileHandle;
    await switchContext('disk');
    await openFont(createDetachedLaunchPath(fileHandle), fileHandle, {
        sourcePluginOverride: diskPlugin
    });
}

async function processPendingPwaLaunchFiles() {
    const launchHandles = consumePendingLaunchFileHandles();
    if (!launchHandles.length) {
        return;
    }

    for (const fileHandle of launchHandles) {
        try {
            await openLaunchedFileHandle(fileHandle);
            updateHomeButtonVisibility();
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            alert(`Error opening launched file ${fileHandle.name}: ${message}`);
            console.error(
                '[FileBrowser]',
                `Failed opening launched file ${fileHandle.name}:`,
                error
            );
        }
    }
}

// Initialize file browser when Pyodide is ready
async function initFileBrowser() {
    try {
        console.log('[FileBrowser]', 'Initializing file browser...');

        // Check if OPFS is supported
        if (!navigator.storage?.getDirectory) {
            console.error(
                '[FileBrowser]',
                'OPFS not supported in this browser'
            );
            alert(
                'File system not supported in this browser. Please use a modern browser like Chrome or Edge.'
            );
            return;
        }

        // Check if File System Access API is supported for disk context
        const diskApiSupported = isFileSystemAccessSupported();
        if (!diskApiSupported) {
            console.warn(
                '[FileBrowser]',
                'File System Access API not supported - disk context will show info message'
            );
        }

        // Initialize disk plugin (restore directory handle)
        const diskPlugin = pluginRegistry.get('disk') as DiskPlugin;
        if (diskPlugin) {
            // Mark disk plugin as unsupported if needed
            if (!diskApiSupported) {
                (diskPlugin as any)._unsupported = true;
            }

            const adapter = diskPlugin.getAdapter() as any;
            if (adapter.initialize) {
                await adapter.initialize();
            }
        }

        // Create /user folder in memory context if it doesn't exist
        const memoryPlugin = pluginRegistry.get('memory');
        if (memoryPlugin) {
            await memoryPlugin.getAdapter().createFolder('/user');
        }

        // Generate context tabs dynamically from plugin registry
        const titleBarRight = document.querySelector(
            '.view-files .view-title-right'
        );
        if (titleBarRight) {
            // Clear existing content
            titleBarRight.innerHTML = '';

            // Add home button (navigate to current font)
            const homeBtn = document.createElement('button');
            homeBtn.id = 'file-browser-home-btn';
            homeBtn.className = 'view-title-button';
            homeBtn.title = 'Locate opened font';
            homeBtn.innerHTML = `<span class="material-symbols-outlined">my_location</span>`;
            homeBtn.style.display = 'none'; // Initially hidden
            homeBtn.addEventListener('click', navigateToCurrentFont);
            titleBarRight.appendChild(homeBtn);

            const plugins = pluginRegistry.getAll();
            plugins.forEach((plugin) => {
                const button = document.createElement('button');
                button.className = 'view-title-button context-tab';
                button.setAttribute('data-plugin-id', plugin.getId());
                button.innerHTML = `${plugin.getIcon()} ${plugin.getName()}`;

                // Mark default plugin as active
                if (plugin.getId() === pluginRegistry.getDefaultId()) {
                    button.classList.add('active');
                }

                // Add dropdown menu button if plugin has menu items
                const menuItems = plugin.getTitleBarMenuItems();
                if (menuItems.length > 0) {
                    // Add dropdown icon to button
                    const dropdownIcon = document.createElement('span');
                    dropdownIcon.className =
                        'material-symbols-outlined plugin-dropdown-icon';
                    dropdownIcon.textContent = 'expand_more';
                    dropdownIcon.style.display = 'none'; // Initially hidden
                    button.appendChild(dropdownIcon);

                    // Create backdrop for modal-like behavior
                    const backdrop = getOrCreateBackdrop(
                        `plugin-menu-backdrop-${plugin.getId()}`
                    );

                    // Create tippy menu on the button itself
                    const menuHtml = createPluginMenuHtml(menuItems);
                    const tippyInstance = tippy(button, {
                        content: menuHtml,
                        allowHTML: true,
                        trigger: 'manual',
                        interactive: true,
                        placement: 'bottom-end',
                        theme: getTheme(),
                        arrow: false,
                        offset: [0, 0],
                        hideOnClick: false,
                        zIndex: 9999,
                        onShown: (instance) => {
                            setupMenuItemHandlers(instance, menuItems);
                        }
                    });

                    // Add backdrop and keyboard support
                    addTippyBackdropSupport(tippyInstance, backdrop);

                    // Store tippy instance and menu items
                    (button as any)._tippy = tippyInstance;
                    (button as any)._hasMenu = true;

                    // Handle clicks: show menu on dropdown icon, switch context on button area
                    button.addEventListener('click', async (e) => {
                        const target = e.target as HTMLElement;
                        const isDropdownIcon =
                            target.classList.contains('plugin-dropdown-icon') ||
                            target.closest('.plugin-dropdown-icon');

                        if (
                            isDropdownIcon &&
                            button.classList.contains('active')
                        ) {
                            // Click on dropdown icon when active - toggle menu
                            e.preventDefault();
                            e.stopImmediatePropagation();

                            // Capture state immediately
                            const wasVisible = tippyInstance.state.isVisible;

                            if (wasVisible) {
                                tippyInstance.hide();
                            } else {
                                tippyInstance.show();
                            }
                            return;
                        } else if (!isDropdownIcon) {
                            // Click on button area - switch context
                            await switchContext(plugin.getId());
                        }
                    });
                } else {
                    // No menu items - simple click to switch context
                    button.addEventListener('click', async () => {
                        await switchContext(plugin.getId());
                    });
                }

                titleBarRight.appendChild(button);
            });

            console.log(
                '[FileBrowser]',
                `Generated ${plugins.length} context tabs`
            );
        }

        // Restore last used context from localStorage
        let startPlugin: FilesystemPlugin | null = null;
        try {
            const lastContextId = localStorage.getItem(LAST_CONTEXT_KEY);
            if (lastContextId) {
                const restoredPlugin = pluginRegistry.get(lastContextId);
                if (restoredPlugin) {
                    // Check if plugin is ready (important for disk plugin)
                    const isReady = await restoredPlugin.isReady();
                    if (isReady) {
                        // Activate the plugin to check permissions and setup
                        const activated = await restoredPlugin.onActivate();
                        if (activated) {
                            startPlugin = restoredPlugin;
                            console.log(
                                '[FileBrowser]',
                                `Restored last context: ${lastContextId}`
                            );
                        } else {
                            console.log(
                                '[FileBrowser]',
                                `Last context ${lastContextId} failed to activate, using default`
                            );
                        }
                    } else {
                        console.log(
                            '[FileBrowser]',
                            `Last context ${lastContextId} not ready, using default`
                        );
                    }
                }
            }
        } catch (e) {
            console.warn(
                '[FileBrowser]',
                'Failed to restore context from localStorage:',
                e
            );
        }

        // Navigate to restored or default plugin's default path
        const defaultPlugin = startPlugin || pluginRegistry.getDefault();
        if (defaultPlugin) {
            // Update file system cache to use the restored/default plugin
            fileSystemCache.currentPlugin = defaultPlugin;
            fileSystemCache.activeAdapter = defaultPlugin.getAdapter();

            // Update tab UI to reflect the active plugin
            document.querySelectorAll('.context-tab').forEach((tab) => {
                tab.classList.remove('active');
                if (
                    tab.getAttribute('data-plugin-id') === defaultPlugin.getId()
                ) {
                    tab.classList.add('active');
                }
            });

            // Let plugin update its UI state
            await defaultPlugin.updateUI({
                showOpenFolderUI,
                hideOpenFolderUI,
                showPermissionBanner,
                showUnsupportedBrowserUI,
                hideUnsupportedBrowserUI
            });

            // Restore last visited path for this plugin
            let startPath = defaultPlugin.getDefaultPath();
            try {
                const pluginId = defaultPlugin.getId();
                const savedPath = localStorage.getItem(
                    getPathStorageKey(pluginId)
                );
                if (savedPath) {
                    startPath = savedPath;
                    console.log(
                        '[FileBrowser]',
                        `Restored last path for ${pluginId}: ${savedPath}`
                    );
                }
            } catch (e) {
                console.warn(
                    '[FileBrowser]',
                    'Failed to restore path from localStorage:',
                    e
                );
            }

            await navigateToPath(startPath);

            // Update plugin menu button visibility
            updatePluginMenuButtonVisibility(defaultPlugin);

            // Update home button visibility
            updateHomeButtonVisibility();
        }

        console.log('[FileBrowser]', 'File browser initialized');
    } catch (error: any) {
        console.error(
            '[FileBrowser]',
            'Error initializing file browser:',
            error
        );
    }
}

// Auto-initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(initFileBrowser, 1500); // Wait a bit longer for Pyodide to be ready
    setTimeout(() => {
        processPendingPwaLaunchFiles();
    }, 3200);

    // Handle URL parameters for opening fonts in new tabs
    const urlParams = new URLSearchParams(window.location.search);
    const fileParam = urlParams.get('file');

    // Also support legacy format for backwards compatibility
    const legacyPluginId = urlParams.get('plugin');
    const legacyPath = urlParams.get('path');

    let pluginId: string | null = null;
    let fontPath: string | null = null;

    // Try new format first
    if (fileParam) {
        const parsed = parseFileUri(fileParam);
        if (parsed) {
            pluginId = parsed.pluginId;
            fontPath = parsed.path;
            console.log(
                '[FileBrowser]',
                `URL file param detected: ${fileParam}`
            );
        }
    } else if (legacyPluginId && legacyPath) {
        // Fall back to legacy format
        pluginId = legacyPluginId;
        fontPath = legacyPath;
        console.log(
            '[FileBrowser]',
            `Legacy URL params detected: plugin=${pluginId}, path=${fontPath}`
        );
    }

    if (pluginId && fontPath) {
        // Wait for everything to initialize before switching and opening
        setTimeout(async () => {
            try {
                // Check if plugin exists
                const plugin = pluginRegistry.get(pluginId);
                if (!plugin) {
                    alert(
                        `Error: File system plugin "${pluginId}" not found.\n\nThe requested file cannot be loaded because the plugin is not available.`
                    );
                    console.error(
                        '[FileBrowser]',
                        `Plugin '${pluginId}' not found for URL param`
                    );
                    return;
                }

                // Switch to the specified plugin
                await switchContext(pluginId);

                // Navigate to the directory containing the font
                const dirPath =
                    fontPath.substring(0, fontPath.lastIndexOf('/')) || '/';

                try {
                    await navigateToPath(dirPath);
                } catch (navError) {
                    alert(
                        `Error: Cannot access directory "${dirPath}" in "${plugin.getName()}" plugin.\n\nThe requested directory does not exist or is not accessible.`
                    );
                    console.error(
                        '[FileBrowser]',
                        `Cannot navigate to directory: ${dirPath}`,
                        navError
                    );
                    return;
                }

                // Check if file exists
                const exists =
                    await fileSystemCache.activeAdapter.fileExists(fontPath);
                if (!exists) {
                    alert(
                        `Error: File not found at "${fontPath}" in "${plugin.getName()}" plugin.\n\nThe requested file does not exist or is not accessible.`
                    );
                    console.error(
                        '[FileBrowser]',
                        `File not found: ${fontPath}`
                    );
                    return;
                }

                // Open the font
                await openFont(fontPath);

                // Show home button since we opened from URL
                updateHomeButtonVisibility();

                // Wait a bit for the fontLoaded event handler to refresh the file list,
                // then scroll the opened file into view
                await new Promise((resolve) => setTimeout(resolve, 200));

                const fileTree = document.getElementById('file-tree');
                const currentFontItem = fileTree?.querySelector(
                    '.file-item.current-font'
                );
                if (currentFontItem) {
                    (currentFontItem as HTMLElement).scrollIntoView({
                        block: 'center',
                        behavior: 'auto'
                    });
                }
            } catch (error: any) {
                const errorMessage = error?.message || String(error);
                alert(`Error opening file from URL:\n\n${errorMessage}`);
                console.error(
                    '[FileBrowser]',
                    'Failed to open font from URL params:',
                    error
                );
            }
        }, 3000); // Wait for plugins and Pyodide to be ready
    }
});

window.addEventListener('pwaLaunchFilesPending', () => {
    setTimeout(() => {
        processPendingPwaLaunchFiles();
    }, 250);
});

// Close any open Tippy menu on Escape key
document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
        const allButtons = document.querySelectorAll('.context-tab');
        allButtons.forEach((button) => {
            const tippyInstance = (button as any)._tippy;
            if (tippyInstance && tippyInstance.state.isVisible) {
                tippyInstance.hide();
            }
        });
    }
});

// Listen for plugin folder closed event
window.addEventListener('pluginFolderClosed', async () => {
    console.log('[FileBrowser]', 'Plugin folder closed, updating UI...');
    const { currentPlugin } = fileSystemCache;
    if (currentPlugin) {
        await currentPlugin.updateUI({
            showOpenFolderUI,
            hideOpenFolderUI,
            showPermissionBanner,
            showUnsupportedBrowserUI,
            hideUnsupportedBrowserUI
        });
        updatePluginMenuButtonVisibility(currentPlugin);
    }
});

// Listen for disk file system changes (FileSystemObserver)
window.addEventListener('diskFilesChanged', async (event: Event) => {
    const { currentPlugin, currentPath, activeAdapter } = fileSystemCache;

    const detail = (event as CustomEvent).detail || {};
    const changedPaths = extractChangedPathsFromRecords(detail.records || []);

    // Only respond if we're currently in disk context
    if (currentPlugin.getId() !== 'disk') {
        return;
    }

    console.log('[FileBrowser]', 'Disk files changed, refreshing...');

    // Check if current path still exists, walk up if not
    let targetPath = currentPath;
    while (targetPath !== '/') {
        try {
            const exists = await activeAdapter.fileExists(targetPath);
            if (exists) {
                break;
            }
        } catch {
            // Path doesn't exist or error checking
        }
        // Walk up to parent
        targetPath =
            targetPath.substring(0, targetPath.lastIndexOf('/')) || '/';
        console.log(
            '[FileBrowser]',
            `Current folder gone, trying parent: ${targetPath}`
        );
    }

    // Update cached path if we had to walk up
    if (targetPath !== currentPath) {
        fileSystemCache.currentPath = targetPath;
        try {
            localStorage.setItem(
                getPathStorageKey(currentPlugin.getId()),
                targetPath
            );
        } catch (e) {
            // Ignore localStorage errors
        }
    }

    // Refresh the view
    await navigateToPath(targetPath);

    // Debounced external font hot reload (targeted by changed paths)
    for (const changedPath of changedPaths) {
        pendingDiskChangePaths.add(changedPath);
    }

    if (diskFontReloadDebounceTimer !== null) {
        window.clearTimeout(diskFontReloadDebounceTimer);
    }

    diskFontReloadDebounceTimer = window.setTimeout(async () => {
        const pathsToProcess = Array.from(pendingDiskChangePaths);
        pendingDiskChangePaths.clear();
        await maybeReloadCurrentFontFromDisk(pathsToProcess);
    }, 400);
});

// Listen for font ready event to refresh file browser highlighting
// (fontReady fires after fontManager.loadFont completes and currentFont is set)
window.addEventListener('fontReady', async () => {
    // Refresh current directory to update highlighting
    const currentPath = fileSystemCache.currentPath || '/';
    await navigateToPath(currentPath);
});

// Listen for fontReady event (fires after FontManager.loadFont completes)
window.addEventListener('fontReady', async () => {
    updateHomeButtonVisibility();

    // Initialize state synchronization and restore state from URL
    if (
        window.glyphCanvas &&
        !(window.glyphCanvas as any).hasInitializedStateSync
    ) {
        // Mark as initialized to avoid duplicate initialization
        (window.glyphCanvas as any).hasInitializedStateSync = true;

        // Initialize state sync (must come first)
        if ((window as any).initStateSync) {
            (window as any).initStateSync(window.glyphCanvas);
        }

        // Restore state from URL after initial editing font compile completes.
        // This avoids late initialization/compile steps resetting restored mode/location.
        const restoreOnce = async () => {
            if ((window as any).restoreStateFromUrl && window.glyphCanvas) {
                await (window as any).restoreStateFromUrl(window.glyphCanvas);
            }
            // Enable sync after restoration is complete
            if ((window as any).enableSync) {
                (window as any).enableSync();
            }
        };

        let restored = false;
        const runRestoreOnce = async () => {
            if (restored) {
                return;
            }
            restored = true;
            await restoreOnce();
        };

        // Preferred: wait for first editing font compilation to finish.
        window.addEventListener(
            'editingFontCompiled',
            async () => {
                await runRestoreOnce();
            },
            { once: true }
        );

        // Fallback: if event doesn't arrive, restore after a safety timeout.
        setTimeout(async () => {
            await runRestoreOnce();
        }, 2000);
    }
});

// Listen for plugin title bar redraw event
window.addEventListener('pluginTitleBarRedraw', ((e: CustomEvent) => {
    const { pluginId } = e.detail;
    const plugin = pluginRegistry.get(pluginId);
    if (plugin) {
        console.log(
            '[FileBrowser]',
            `Redrawing title bar for plugin: ${pluginId}`
        );
        updatePluginMenuButtonVisibility(plugin);
    }
}) as EventListener);

// Wrapper function to get file handle from global map
async function openFontWithHandle(path: string) {
    const fileHandle = (window as any)._fileHandles?.[path];
    await openFont(path, fileHandle);
}

// Export functions for global access
window.refreshFileSystem = refreshFileSystem;
window.navigateToPath = navigateToPath;
window.navigateToParent = navigateToParent;
window.selectFile = selectFile;
window.initFileBrowser = initFileBrowser;
window.createFolder = createFolder;
window.createFile = createFile;
window.navigateToCurrentFont = navigateToCurrentFont;
window.updateHomeButtonVisibility = updateHomeButtonVisibility;
window.deleteItem = deleteItem;
window.uploadFiles = uploadFiles;
window.handleFileUpload = handleFileUpload;
window.openFont = openFont;
(window as any).openFontWithHandle = openFontWithHandle;
(window as any).switchContext = switchContext;
(window as any).selectDiskFolder = selectDiskFolder;
(window as any).reEnableAccess = reEnableAccess;
(window as any).parseFileUri = parseFileUri;
window.downloadFile = downloadFile;

// Export plugin registry and current plugin getter for script editor
(window as any).pluginRegistry = pluginRegistry;
(window as any).fileBrowser = {
    getCurrentPlugin: () => fileSystemCache.currentPlugin,
    getCurrentPath: () => fileSystemCache.currentPath
};
