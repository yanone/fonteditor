// Script Editor for Python code execution
import tippy, { Instance as TippyInstance } from 'tippy.js';
import 'tippy.js/dist/tippy.css';
import { pluginRegistry, FilesystemPlugin } from './filesystem-plugins';
import {
    getOrCreateBackdrop,
    addTippyBackdropSupport,
    getTheme,
    setupMenuKeyboardNav
} from './tippy-utils';
import { Logger } from './logger';
import {
    getPythonDocumentKindInfo,
    type ScriptDocumentKind
} from './python-document-kind';
import { DISK_ROOT_PATHS } from './disk-root-paths';
import { dispatchManagedFileChanged } from './managed-file-events';

const console = new Logger('ScriptEditor');

(function () {
    type ScriptDocumentState = {
        content: string;
        kind: ScriptDocumentKind;
        path: string | null;
        revision: string;
        isModified: boolean;
    };

    const SCRIPT_CONTENT_STORAGE_KEY = 'python_script';
    const SCRIPT_URI_STORAGE_KEY = 'python_script_uri';
    const SCRIPT_SAVED_CONTENT_STORAGE_KEY = 'python_script_saved_content';
    const SCRIPT_TIMESTAMP_STORAGE_KEY = 'python_script_timestamp';
    const RUN_BUTTON_DEFAULT_HTML =
        'Run <span style="opacity: 0.5;"><span class="material-symbols-outlined">keyboard_command_key</span><span class="material-symbols-outlined">keyboard_option_key</span>R</span>';

    const GENERAL_SCRIPT_TEMPLATE = '# New Python script\n';
    const GLYPH_FILTER_TEMPLATE = `# "New Filter" Filter
# Define your filter function below

# Optional: Define groups with colors
# GROUPS = {
#     "uppercase": {"description": "Uppercase letters", "color": "#ff6b6b"},
#     "lowercase": {"description": "Lowercase letters", "color": "#4ecdc4"}
# }

def filter_glyphs(font):
    """Filter glyphs and return results.

    Yield or return dictionaries with 'glyph_name' keys. Optional 'group'
    or 'groups' keys place glyphs in groups declared by GROUPS.
    """
    for glyph in font.glyphs:
        yield {"glyph_name": glyph.name}
`;

    let editor: any = null;
    let runButton: HTMLButtonElement | null = null;
    let fileButton: HTMLButtonElement | null = null;
    let reloadButton: HTMLButtonElement | null = null;
    let isScriptViewFocused = false;
    let tippyInstance: TippyInstance | null = null;

    // File state
    let currentFilePath: string | null = null; // Full path to the file
    let currentPluginId: string | null = null; // Plugin ID (memory, disk)
    let isModified = false;
    let savedContent = ''; // Content when last saved/opened

    // File watcher state
    let fileWatcherInterval: number | null = null;
    let lastModifiedTime: number | null = null;
    let hasExternalChanges = false;
    let documentKind: ScriptDocumentKind = 'general-script';
    let documentRevision = 0;

    function getPathKind(path: string | null): ScriptDocumentKind | null {
        if (!path) return null;
        if (path.startsWith(`${DISK_ROOT_PATHS.filters}/`)) {
            return 'glyph-filter';
        }
        if (path.startsWith(`${DISK_ROOT_PATHS.scripts}/`)) {
            return 'general-script';
        }
        return null;
    }

    function getRevision(): string {
        return `script-${documentRevision}`;
    }

    function getDocumentState(): ScriptDocumentState {
        return {
            content: editor ? editor.getValue() : '',
            kind: documentKind,
            path: currentFilePath,
            revision: getRevision(),
            isModified: isModified
        };
    }

    function recordDocumentChange(): void {
        documentRevision += 1;
        window.dispatchEvent(
            new CustomEvent('scriptEditorDocumentChanged', {
                detail: getDocumentState()
            })
        );
    }

    function setDocumentKind(kind: ScriptDocumentKind): void {
        documentKind = kind;
        updateRunButtonState();
    }

    function persistSavedContent(): void {
        localStorage.setItem(SCRIPT_SAVED_CONTENT_STORAGE_KEY, savedContent);
    }

    function isGlyphFilterDocument(): boolean {
        return (
            getPythonDocumentKindInfo({
                kind: documentKind,
                path: currentFilePath,
                content: editor ? editor.getValue() : '',
                isModified
            }).kind === 'glyph-filter'
        );
    }

    function updateRunButtonState(): void {
        if (!runButton) {
            return;
        }

        const isGlyphFilter = isGlyphFilterDocument();
        runButton.disabled = false;
        runButton.setAttribute(
            'aria-disabled',
            isGlyphFilter ? 'true' : 'false'
        );
        runButton.style.opacity = isGlyphFilter ? '0.5' : '1';
        runButton.style.cursor = isGlyphFilter ? 'not-allowed' : '';
        runButton.title = isGlyphFilter
            ? 'This script is a glyph filter and must be invoked via the glyph filter UI in the Glyph Overview.'
            : 'Run script (Cmd+Alt+R)';
        runButton.innerHTML = RUN_BUTTON_DEFAULT_HTML;
    }

    /**
     * Update the modified indicator in UI
     */
    function updateModifiedIndicator() {
        const indicator = document.getElementById(
            'script-file-modified-indicator'
        );
        if (indicator) {
            indicator.style.display = isModified ? 'inline' : 'none';
        }
    }

    /**
     * Update the reload button visibility
     */
    function updateReloadButton() {
        if (reloadButton) {
            // Show reload button only if there are external changes AND unsaved changes
            const shouldShow = hasExternalChanges && isModified;
            reloadButton.style.display = shouldShow ? 'flex' : 'none';
        }
    }

    /**
     * Set the modified state
     */
    function setModified(modified: boolean): void {
        isModified = modified;
        updateModifiedIndicator();
        updateReloadButton();

        // If no longer modified and no external changes, hide reload button
        if (!modified && !hasExternalChanges) {
            hasExternalChanges = false;
            updateReloadButton();
        }
    }

    /**
     * Check if content has changed from saved version
     */
    function checkModified() {
        if (!editor) return false;
        const currentContent = editor.getValue();
        const modified = currentContent !== savedContent;
        setModified(modified);
        return modified;
    }

    /**
     * Update the file path (e.g., when file is renamed externally)
     * Also updates localStorage
     */
    function updateFilePath(newPath: string): void {
        if (!currentFilePath || !currentPluginId) return;

        currentFilePath = newPath;

        // Update localStorage
        localStorage.setItem(
            SCRIPT_URI_STORAGE_KEY,
            `${currentPluginId}://${newPath}`
        );

        console.log('[ScriptEditor]', 'File path updated to:', newPath);
    }

    /**
     * Get the current filesystem plugin from file-browser
     */
    function getCurrentPlugin(): FilesystemPlugin | null {
        if (
            (window as any).fileBrowser &&
            (window as any).fileBrowser.getCurrentPlugin
        ) {
            return (window as any).fileBrowser.getCurrentPlugin();
        }
        // Fallback: try to get from pluginRegistry
        return pluginRegistry.getDefault();
    }

    /**
     * Whether a Disk folder is selected (same gate as Glyph Overview user filters).
     */
    function hasDiskFolderAccess(): boolean {
        const diskPlugin = pluginRegistry.get('disk');
        const adapter = diskPlugin?.getAdapter() as
            { hasDirectory?: () => boolean } | undefined;
        return !!(
            diskPlugin &&
            adapter &&
            typeof adapter.hasDirectory === 'function' &&
            adapter.hasDirectory()
        );
    }

    /**
     * Get plugin by ID
     */
    function getPluginById(pluginId: string): FilesystemPlugin | null {
        return pluginRegistry.get(pluginId);
    }

    /**
     * Initialize the script editor
     */
    async function init() {
        // Wait for Ace to be loaded
        if (!window.ace) {
            console.error('[ScriptEditor]', 'Ace Editor not loaded');
            return;
        }

        const container = document.getElementById('script-editor');
        runButton = document.getElementById(
            'run-script-btn'
        ) as HTMLButtonElement | null;
        fileButton = document.getElementById(
            'script-file-btn'
        ) as HTMLButtonElement | null;
        reloadButton = document.getElementById(
            'script-file-reload-btn'
        ) as HTMLButtonElement | null;

        if (!container || !runButton) {
            console.error('[ScriptEditor]', 'Script editor elements not found');
            return;
        }

        // Load saved script from localStorage
        const savedScript =
            localStorage.getItem(SCRIPT_CONTENT_STORAGE_KEY) ||
            '# Write your Python script here...\n';
        const restoredSavedContent = localStorage.getItem(
            SCRIPT_SAVED_CONTENT_STORAGE_KEY
        );

        // Restore file association from localStorage
        const restoredUri = localStorage.getItem(SCRIPT_URI_STORAGE_KEY);
        if (restoredUri) {
            const match = restoredUri.match(/^([^:]+):\/\/(.*)$/);
            if (match) {
                currentPluginId = match[1];
                currentFilePath = match[2];
                setDocumentKind(getPathKind(currentFilePath) || documentKind);
                console.log(
                    '[ScriptEditor]',
                    'Restored file association:',
                    restoredUri
                );
            }
        }

        // Create Ace editor
        editor = (window as any).ace.edit('script-editor');

        // Set theme based on current theme preference
        const getInitialTheme = () => {
            const savedTheme =
                localStorage.getItem('preferred-theme') || 'auto';
            if (savedTheme === 'auto') {
                const isDark = window.matchMedia(
                    '(prefers-color-scheme: dark)'
                ).matches;
                return isDark
                    ? 'ace/theme/tomorrow_night'
                    : 'ace/theme/tomorrow';
            }
            return savedTheme === 'light'
                ? 'ace/theme/tomorrow'
                : 'ace/theme/tomorrow_night';
        };

        editor.setTheme(getInitialTheme());
        editor.session.setMode('ace/mode/python');
        editor.setValue(savedScript, -1); // -1 moves cursor to start
        savedContent = restoredSavedContent ?? savedScript;

        // Make editor globally accessible for theme updates
        window.scriptEditor = editor;

        // Set top margin on the container
        container.style.marginTop = '11px';

        // Configure editor options
        editor.setOptions({
            fontSize: '12px',
            fontFamily: "'IBM Plex Mono', monospace",
            showPrintMargin: false,
            highlightActiveLine: true,
            enableBasicAutocompletion: true,
            enableLiveAutocompletion: true,
            tabSize: 4,
            useSoftTabs: true, // Use spaces instead of tabs
            wrap: false
        });

        let cursorWidth = '7px';
        let opacityLevel = '0.5';

        // Force wider cursor by injecting custom style and directly manipulating the cursor
        setTimeout(() => {
            // Method 1: Add a style tag to override cursor width
            const styleId = 'ace-cursor-width-override';
            if (!document.getElementById(styleId)) {
                const style = document.createElement('style');
                style.id = styleId;
                style.textContent = `
                    .ace_cursor {
                        width: ${cursorWidth} !important;
                        // opacity: ${opacityLevel} !important;
                        top: 2px !important;
                        left: -0px !important;
                    }
                `;
                document.head.appendChild(style);
            }

            // Method 2: Direct DOM manipulation
            const cursorLayer = editor.renderer.$cursorLayer;
            if (cursorLayer && cursorLayer.element) {
                const cursor = cursorLayer.element.querySelector('.ace_cursor');
                if (cursor) {
                    cursor.style.width = cursorWidth;
                    cursor.style.borderLeftWidth = cursorWidth;
                    // cursor.style.opacity = opacityLevel;
                }
            }

            // Method 3: Update on every cursor move
            editor.renderer.on('afterRender', () => {
                const cursor = editor.container.querySelector('.ace_cursor');
                if (cursor && cursor.style.width !== cursorWidth) {
                    cursor.style.width = cursorWidth;
                    cursor.style.borderLeftWidth = cursorWidth;
                    // cursor.style.opacity = opacityLevel;
                }
            });
        }, 100);

        // Save to localStorage on change and track modifications
        editor.session.on('change', function () {
            localStorage.setItem(SCRIPT_CONTENT_STORAGE_KEY, editor.getValue());
            checkModified();
            recordDocumentChange();
            updateRunButtonState();
        });

        const hasPersistedSavedBaseline = restoredSavedContent !== null;
        const initialModified = currentFilePath
            ? savedScript !== savedContent
            : hasPersistedSavedBaseline
              ? savedScript !== savedContent
              : savedScript !== GENERAL_SCRIPT_TEMPLATE;

        setModified(initialModified);
        updateRunButtonState();

        // Initialize file menu
        initFileMenu();

        // Add custom keyboard shortcuts
        editor.commands.addCommand({
            name: 'runScript',
            bindKey: { win: 'Ctrl-Alt-R', mac: 'Command-Alt-R' },
            exec: function () {
                runScript();
            }
        });

        // Add file operation shortcuts
        editor.commands.addCommand({
            name: 'newFile',
            bindKey: { win: 'Ctrl-N', mac: 'Command-N' },
            exec: function () {
                handleNew();
            }
        });

        editor.commands.addCommand({
            name: 'fontSaveShortcutPassthrough',
            bindKey: { win: 'Ctrl-S', mac: 'Command-S' },
            exec: function () {
                return false;
            },
            readOnly: true,
            passEvent: true
        });

        // Remove default Cmd+K binding to prevent conflicts with global shortcut
        editor.commands.removeCommand('gotoline');

        // Add passthrough commands for global view shortcuts
        // Read shortcuts from VIEW_SETTINGS to avoid redundancy
        if (window.VIEW_SETTINGS && window.VIEW_SETTINGS.shortcuts) {
            Object.entries(window.VIEW_SETTINGS.shortcuts).forEach(
                ([viewId, config]: [string, any]) => {
                    const isMac =
                        navigator.platform.toUpperCase().indexOf('MAC') >= 0;
                    const modifierKey = isMac ? 'Command' : 'Ctrl';
                    const shiftKey = config.modifiers.shift ? 'Shift-' : '';
                    const key = config.key.toUpperCase();

                    editor.commands.addCommand({
                        name: `global_${viewId}`,
                        bindKey: {
                            win: `Ctrl-${shiftKey}${key}`,
                            mac: `${modifierKey}-${shiftKey}${key}`
                        },
                        exec: function () {
                            // Do nothing - let the global handler deal with it
                            // The global handler will intercept this in capture phase
                            return false;
                        },
                        readOnly: true,
                        passEvent: true // This tells Ace to pass the event through
                    });
                }
            );
        }

        // Run button click handler
        runButton.addEventListener('click', runScript);

        // Reload button click handler
        if (reloadButton) {
            reloadButton.addEventListener('click', async () => {
                await handleReloadExternalChanges();
            });
        }

        // Handle keyboard shortcuts when script view is focused
        document.addEventListener('keydown', (event) => {
            // Skip if event already handled
            if (event.defaultPrevented) return;

            const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
            const cmdKey = isMac ? event.metaKey : event.ctrlKey;
            const altKey = event.altKey;
            const shiftKey = event.shiftKey;
            const code = event.code;

            // Only handle shortcuts when script view is focused
            if (!isScriptViewFocused) return;

            // Cmd+Alt+R - Run script
            if (cmdKey && altKey && code === 'KeyR') {
                event.preventDefault();
                event.stopPropagation();
                runScript();
                return;
            }
        });

        // Track cursor position and focus state
        let savedCursorPosition: any = null;
        let isPreventingCursorJump = false;

        // Intercept ALL mouse events on the container when not focused
        container.addEventListener(
            'mousedown',
            (e: Event) => {
                if (!isScriptViewFocused) {
                    // Save cursor position before any click
                    savedCursorPosition = editor.getCursorPosition();
                    isPreventingCursorJump = true;

                    // Prevent the event from reaching the editor
                    e.stopPropagation();
                    e.preventDefault();

                    // Manually trigger focus on the view
                    const scriptView = document.getElementById('view-scripts');
                    if (scriptView) {
                        scriptView.click();
                    }

                    // Restore cursor after focus
                    setTimeout(() => {
                        if (savedCursorPosition) {
                            editor.moveCursorToPosition(savedCursorPosition);
                            editor.clearSelection();
                        }
                        isPreventingCursorJump = false;
                    }, 50);
                }
            },
            true
        ); // Use capture phase to intercept before Ace

        // Listen for view focus events
        window.addEventListener('viewFocused', (event) => {
            const customEvent = event as CustomEvent;
            isScriptViewFocused = customEvent.detail.viewId === 'view-scripts';

            if (isScriptViewFocused && editor) {
                // Focus the editor
                editor.focus();

                // If we saved a position, restore it
                if (isPreventingCursorJump && savedCursorPosition) {
                    setTimeout(() => {
                        editor.moveCursorToPosition(savedCursorPosition);
                        editor.clearSelection();
                    }, 0);
                }
            }
        });

        console.log(
            '[ScriptEditor]',
            'Script editor initialized with Ace Editor'
        );

        // Start file watcher if we have a restored file association
        // Only for disk files and only if the adapter is ready
        if (currentFilePath && currentPluginId) {
            console.log(
                '[ScriptEditor]',
                'Attempting to start file watcher on init for:',
                currentPluginId,
                currentFilePath
            );
            if (currentPluginId === 'disk') {
                // Disk adapter may not be ready yet (still restoring from IndexedDB)
                // Retry a few times with delays
                const tryStartWatcher = async (attempts: number = 0) => {
                    const plugin = getPluginById(currentPluginId!);
                    if (!plugin) {
                        console.warn(
                            '[ScriptEditor]',
                            'Plugin not found:',
                            currentPluginId
                        );
                        return;
                    }

                    const adapter = plugin.getAdapter();
                    const hasDir = (adapter as any).hasDirectory?.();
                    console.log(
                        '[ScriptEditor]',
                        'Disk adapter hasDirectory (attempt',
                        attempts + 1,
                        '):',
                        hasDir
                    );

                    if (hasDir !== false) {
                        // Adapter is ready - check if file changed while app was closed
                        try {
                            const fileInfo = await getFileInfo(
                                adapter,
                                currentFilePath!
                            );
                            if (fileInfo) {
                                // Compare file timestamp with localStorage timestamp
                                const localStorageTimestamp =
                                    localStorage.getItem(
                                        SCRIPT_TIMESTAMP_STORAGE_KEY
                                    );
                                const shouldReload =
                                    !localStorageTimestamp ||
                                    fileInfo.lastModified >
                                        parseInt(localStorageTimestamp);

                                if (shouldReload) {
                                    if (isModified) {
                                        console.log(
                                            '[ScriptEditor]',
                                            'File changed while app was closed - keeping unsaved buffer and showing reload'
                                        );
                                        hasExternalChanges = true;
                                        updateReloadButton();
                                        lastModifiedTime =
                                            fileInfo.lastModified;
                                    } else {
                                        console.log(
                                            '[ScriptEditor]',
                                            'File changed while app was closed - reloading from disk'
                                        );
                                        await reloadFileFromDisk();
                                    }
                                } else {
                                    console.log(
                                        '[ScriptEditor]',
                                        'File unchanged since last session'
                                    );
                                }
                            }
                        } catch (error) {
                            console.error(
                                '[ScriptEditor]',
                                'Error checking file on init:',
                                error
                            );
                        }

                        // Start file watcher
                        startFileWatcher(currentFilePath!, currentPluginId!);
                    } else if (attempts < 10) {
                        // Retry after a delay (up to 10 attempts = ~5 seconds)
                        setTimeout(() => tryStartWatcher(attempts + 1), 500);
                    } else {
                        console.log(
                            '[ScriptEditor]',
                            'Gave up waiting for disk adapter to be ready'
                        );
                    }
                };

                tryStartWatcher();
            }
        }
    }

    /**
     * Initialize the file menu dropdown
     */
    function initFileMenu() {
        if (!fileButton) return;

        // Create backdrop for menu
        const backdrop = getOrCreateBackdrop('script-file-menu-backdrop');

        // Create tippy instance
        tippyInstance = tippy(fileButton, {
            content: getFileMenuHtml(),
            allowHTML: true,
            interactive: true,
            trigger: 'click',
            theme: getTheme(),
            placement: 'bottom-end',
            arrow: false,
            offset: [0, 0],
            appendTo: document.body,
            hideOnClick: true,
            zIndex: 9999,
            onShow: (instance) => {
                // Update menu content before showing
                instance.setContent(getFileMenuHtml());
            },
            onShown: (instance) => {
                const menu = instance.popper.querySelector('.script-file-menu');
                if (menu) {
                    setupMenuKeyboardNav(
                        menu,
                        '.script-file-menu-item:not(.disabled)'
                    );
                }
                setupFileMenuHandlers(instance);
            }
        });

        // Add shared backdrop and keyboard support
        addTippyBackdropSupport(tippyInstance, backdrop, {
            targetElement: fileButton,
            activeClass: 'menu-active'
        });
    }

    /**
     * Generate file menu HTML based on current state and plugin capabilities
     */
    function getFileMenuHtml() {
        const plugin = getCurrentPlugin();
        const hasDisk = hasDiskFolderAccess();
        const supportsOpen =
            hasDisk &&
            !!plugin &&
            !!plugin.supportsOpenFilePicker &&
            plugin.supportsOpenFilePicker();
        const supportsSaveAs =
            hasDisk &&
            !!plugin &&
            !!plugin.supportsSaveAsFilePicker &&
            plugin.supportsSaveAsFilePicker();
        const canSave =
            hasDisk && currentFilePath !== null && currentPluginId !== null;
        const diskAccessTitle = 'Select a Disk folder to enable saving scripts';

        // File path display
        let pathDisplay = 'Untitled';
        if (currentFilePath) {
            pathDisplay = currentFilePath;
            if (currentPluginId) {
                pathDisplay = `${currentPluginId}://${currentFilePath}`;
            }
        }

        const modifiedIndicator = isModified
            ? '<span class="script-modified-indicator">●</span>'
            : '';

        let html = `<div class="script-file-menu">`;

        // File path header
        html += `<div class="script-file-menu-path">${modifiedIndicator}${escapeHtml(pathDisplay)}</div>`;

        if (!hasDisk) {
            html += `<div class="script-file-menu-notice">${escapeHtml(diskAccessTitle)}</div>`;
        }

        // New
        html += `
            <div class="script-file-menu-item" data-action="new">
                <span class="material-symbols-outlined">note_add</span>
                <span>New</span>
            </div>
        `;

        // Open (only if plugin supports it and a Disk folder is selected)
        if (supportsOpen) {
            html += `
                <div class="script-file-menu-item" data-action="open">
                    <span class="material-symbols-outlined">folder_open</span>
                    <span>Open...</span>
                </div>
            `;
        } else {
            html += `
                <div class="script-file-menu-item disabled" title="${hasDisk ? 'Open files requires plugin support' : diskAccessTitle}">
                    <span class="material-symbols-outlined">folder_open</span>
                    <span>Open...</span>
                </div>
            `;
        }

        // Save (requires Disk folder + existing path)
        if (canSave) {
            html += `
                <div class="script-file-menu-item" data-action="save">
                    <span class="material-symbols-outlined">save</span>
                    <span>Save</span>
                </div>
            `;
        } else {
            const saveTitle = !hasDisk
                ? diskAccessTitle
                : 'No file path - use Save As or open a file first';
            html += `
                <div class="script-file-menu-item disabled" title="${saveTitle}">
                    <span class="material-symbols-outlined">save</span>
                    <span>Save</span>
                </div>
            `;
        }

        // Save As (requires Disk folder + plugin picker support)
        if (supportsSaveAs) {
            html += `
                <div class="script-file-menu-item" data-action="save-as">
                    <span class="material-symbols-outlined">save_as</span>
                    <span>Save As...</span>
                </div>
            `;
        } else {
            html += `
                <div class="script-file-menu-item disabled" title="${diskAccessTitle}">
                    <span class="material-symbols-outlined">save_as</span>
                    <span>Save As...</span>
                </div>
            `;
        }

        if (canSave && isModified) {
            html += `
                <div class="script-file-menu-item" data-action="revert-saved">
                    <span class="material-symbols-outlined">undo</span>
                    <span>Revert to Saved</span>
                </div>
            `;
        }

        html += `</div>`;
        return html;
    }

    /**
     * Escape HTML special characters
     */
    function escapeHtml(text: string): string {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Setup click handlers for file menu items
     */
    function setupFileMenuHandlers(instance: TippyInstance): void {
        const menu = instance.popper.querySelector('.script-file-menu');
        if (!menu) return;

        menu.querySelectorAll('.script-file-menu-item:not(.disabled)').forEach(
            (item: Element) => {
                item.addEventListener('click', async () => {
                    const action = item.getAttribute('data-action');
                    instance.hide();

                    switch (action) {
                        case 'new':
                            await handleNew();
                            break;
                        case 'open':
                            await handleOpen();
                            break;
                        case 'save':
                            await handleSave();
                            break;
                        case 'save-as':
                            await handleSaveAs();
                            break;
                        case 'revert-saved':
                            revertToSaved();
                            break;
                    }
                });
            }
        );
    }

    /**
     * Handle New file
     */
    async function handleNew() {
        // Check for unsaved changes
        if (isModified) {
            const save = confirm(
                'You have unsaved changes. Do you want to save before creating a new file?'
            );
            if (save) {
                const saved = await handleSave();
                if (!saved) {
                    // Save was cancelled or failed
                    return;
                }
            }
        }

        // Stop file watcher
        stopFileWatcher();

        // Clear editor
        editor.setValue(GENERAL_SCRIPT_TEMPLATE, -1);
        savedContent = editor.getValue();
        persistSavedContent();
        currentFilePath = null;
        currentPluginId = null;
        setDocumentKind('general-script');
        hasExternalChanges = false;
        setModified(false);

        // Clear file association from localStorage
        localStorage.removeItem(SCRIPT_URI_STORAGE_KEY);
        localStorage.setItem(SCRIPT_CONTENT_STORAGE_KEY, editor.getValue());

        console.log('[ScriptEditor]', 'New file created');

        // Dispatch event for file change
        window.dispatchEvent(
            new CustomEvent('scriptEditorFileChanged', {
                detail: { pluginId: null, filePath: null }
            })
        );
    }

    async function confirmProceedWithOpen(): Promise<boolean> {
        if (!isModified) {
            return true;
        }

        const { showNamedUnsavedChangesDialog } = await import(
            /* webpackChunkName: "confirm-dialog" */ './ui/confirm-dialog'
        );
        const scriptName = currentFilePath?.split('/').pop() || 'Untitled';
        const choice = await showNamedUnsavedChangesDialog({
            subjectType: 'Script',
            subjectName: scriptName
        });

        if (choice === 'cancel') {
            return false;
        }

        if (choice === 'discard') {
            return true;
        }

        if (currentFilePath && currentPluginId) {
            return await handleSave();
        }

        return await handleSaveAs();
    }

    /**
     * Handle Open file
     */
    async function handleOpen() {
        if (!hasDiskFolderAccess()) {
            alert('Select a Disk folder to enable saving scripts');
            return;
        }

        const plugin = getCurrentPlugin();
        if (
            !plugin ||
            !plugin.supportsOpenFilePicker ||
            !plugin.supportsOpenFilePicker()
        ) {
            console.log(
                '[ScriptEditor]',
                'Open file picker not supported by current plugin'
            );
            return;
        }

        try {
            // Get current folder to start in
            const startFolder = currentFilePath
                ? currentFilePath.substring(0, currentFilePath.lastIndexOf('/'))
                : undefined;

            const path = await plugin.showOpenFilePicker({
                types: [
                    {
                        description: 'Python files',
                        accept: { 'text/x-python': ['.py'] }
                    },
                    {
                        description: 'Text files',
                        accept: { 'text/plain': ['.txt'] }
                    }
                ],
                startIn: startFolder || undefined
            });

            if (!path) {
                // User cancelled
                return;
            }

            await openFile(path, plugin.getId());
        } catch (error: any) {
            console.error('[ScriptEditor]', 'Error opening file:', error);
            alert('Failed to open file: ' + (error?.message || String(error)));
        }
    }

    /**
     * Handle Save file
     */
    async function handleSave() {
        if (!hasDiskFolderAccess()) {
            alert('Select a Disk folder to enable saving scripts');
            return false;
        }

        if (!currentFilePath || !currentPluginId) {
            // No path yet - need Save As
            console.log('[ScriptEditor]', 'No file path, cannot save');
            return false;
        }

        try {
            const plugin = getPluginById(currentPluginId);
            if (!plugin) {
                throw new Error('Plugin not found: ' + currentPluginId);
            }

            const adapter = plugin.getAdapter();
            const content = editor.getValue();

            // Convert string to Uint8Array for consistent handling
            const encoder = new TextEncoder();
            const data = encoder.encode(content);

            await adapter.writeFile(currentFilePath, data);

            savedContent = content;
            persistSavedContent();
            hasExternalChanges = false;
            setModified(false);

            // Update lastModifiedTime after save to prevent false external change detection
            const savedPath = currentFilePath;
            setTimeout(async () => {
                if (!savedPath) return;
                const fileInfo = await getFileInfo(adapter, savedPath);
                if (fileInfo) {
                    lastModifiedTime = fileInfo.lastModified;
                    // Save timestamp to localStorage
                    localStorage.setItem(
                        SCRIPT_TIMESTAMP_STORAGE_KEY,
                        fileInfo.lastModified.toString()
                    );
                    console.log(
                        '[ScriptEditor]',
                        'Updated mtime after save:',
                        new Date(fileInfo.lastModified).toISOString()
                    );
                }
            }, 500); // Wait a bit for filesystem to update

            console.log('[ScriptEditor]', 'File saved:', currentFilePath);

            // Dispatch event for file change (path may have changed via Save As)
            window.dispatchEvent(
                new CustomEvent('scriptEditorFileChanged', {
                    detail: {
                        pluginId: currentPluginId,
                        filePath: currentFilePath
                    }
                })
            );

            dispatchManagedFileChanged({
                pluginId: currentPluginId,
                source: 'script-editor-save',
                paths: [currentFilePath],
                internalWrite: true
            });

            return true;
        } catch (error: any) {
            console.error('[ScriptEditor]', 'Error saving file:', error);
            alert('Failed to save file: ' + (error?.message || String(error)));
            return false;
        }
    }

    function revertToSaved(): boolean {
        if (!currentFilePath || !isModified) return false;
        if (
            !confirm(
                'Discard unsaved script changes and restore the saved file?'
            )
        ) {
            return false;
        }

        const document = editor.session.getDocument();
        const currentContent = editor.getValue();
        document.replace(
            {
                start: { row: 0, column: 0 },
                end: document.indexToPosition(currentContent.length, 0)
            },
            savedContent
        );
        hasExternalChanges = false;
        setModified(false);
        return true;
    }

    /**
     * Handle Save As file
     */
    async function handleSaveAs() {
        if (!hasDiskFolderAccess()) {
            alert('Select a Disk folder to enable saving scripts');
            return false;
        }

        const plugin = getCurrentPlugin();
        if (
            !plugin ||
            !plugin.supportsSaveAsFilePicker ||
            !plugin.supportsSaveAsFilePicker()
        ) {
            console.log(
                '[ScriptEditor]',
                'Save As not supported by current plugin'
            );
            return false;
        }

        try {
            // Suggest a filename
            // Suggest a filename and folder
            let suggestedName =
                documentKind === 'glyph-filter' ? 'New Filter.py' : 'script.py';
            let startFolder: string | undefined;
            if (currentFilePath) {
                suggestedName = currentFilePath.split('/').pop() || 'script.py';
                startFolder = currentFilePath.substring(
                    0,
                    currentFilePath.lastIndexOf('/')
                );
            } else {
                startFolder =
                    documentKind === 'glyph-filter'
                        ? DISK_ROOT_PATHS.filters
                        : DISK_ROOT_PATHS.scripts;
            }

            const path = await plugin.showSaveFilePicker({
                suggestedName: suggestedName,
                types: [
                    {
                        description: 'Python files',
                        accept: { 'text/x-python': ['.py'] }
                    },
                    {
                        description: 'Text files',
                        accept: { 'text/plain': ['.txt'] }
                    }
                ],
                startIn: startFolder || undefined
            });

            if (!path) {
                // User cancelled
                return false;
            }

            const destinationKind = getPathKind(path);
            if (destinationKind && destinationKind !== documentKind) {
                const draftLabel =
                    documentKind === 'glyph-filter'
                        ? 'Glyph Overview filter'
                        : 'general-purpose script';
                const destinationLabel =
                    destinationKind === 'glyph-filter'
                        ? 'Glyph Overview filter'
                        : 'general-purpose script';
                if (
                    !confirm(
                        `This draft was created as a ${draftLabel}. Saving it here makes it a ${destinationLabel}. Continue?`
                    )
                ) {
                    return false;
                }
                setDocumentKind(destinationKind);
            } else if (!destinationKind) {
                if (
                    !confirm(
                        'This location is outside Counterpunch Scripts and Filters. The file will not appear in either managed collection. Save it as an external Python file?'
                    )
                ) {
                    return false;
                }
            }

            // Update current file info
            currentFilePath = path;
            currentPluginId = plugin.getId();

            // Save the file
            const success = await handleSave();

            // Start file watcher if save succeeded
            if (success) {
                await startFileWatcher(path, plugin.getId());
            }

            return success;
        } catch (error: any) {
            console.error('[ScriptEditor]', 'Error in Save As:', error);
            alert('Failed to save file: ' + (error?.message || String(error)));
            return false;
        }
    }

    /**
     * Open a file from a given path and plugin
     * Can be called externally (e.g., from Files view context menu)
     */
    async function openFile(path: string, pluginId: string): Promise<boolean> {
        try {
            if (!(await confirmProceedWithOpen())) {
                return false;
            }

            const plugin = getPluginById(pluginId);
            if (!plugin) {
                throw new Error('Plugin not found: ' + pluginId);
            }

            const adapter = plugin.getAdapter();
            const data = await adapter.readFile(path);

            // Convert Uint8Array to string
            let content: string;
            if (data instanceof Uint8Array) {
                const decoder = new TextDecoder();
                content = decoder.decode(data);
            } else {
                content = data as string;
            }

            // Update editor
            editor.setValue(content, -1);
            savedContent = content;
            persistSavedContent();
            currentFilePath = path;
            currentPluginId = pluginId;
            setDocumentKind(getPathKind(path) || 'general-script');

            // Reset external changes state
            hasExternalChanges = false;
            updateReloadButton();

            // Start file watcher if plugin is disk
            await startFileWatcher(path, pluginId);
            setModified(false);

            // Save to localStorage for persistence (content and file association)
            localStorage.setItem(SCRIPT_CONTENT_STORAGE_KEY, content);
            localStorage.setItem(
                SCRIPT_URI_STORAGE_KEY,
                `${pluginId}://${path}`
            );

            // Save file timestamp
            const fileInfo = await getFileInfo(adapter, path);
            if (fileInfo) {
                localStorage.setItem(
                    SCRIPT_TIMESTAMP_STORAGE_KEY,
                    fileInfo.lastModified.toString()
                );
            }

            console.log('[ScriptEditor]', 'File opened:', path);

            // Dispatch event for file change
            window.dispatchEvent(
                new CustomEvent('scriptEditorFileChanged', {
                    detail: { pluginId: pluginId, filePath: path }
                })
            );

            // Focus the scripts view
            const scriptView = document.getElementById('view-scripts');
            if (scriptView) {
                scriptView.click();
            }

            return true;
        } catch (error: any) {
            console.error('[ScriptEditor]', 'Error opening file:', error);
            alert('Failed to open file: ' + (error?.message || String(error)));
            return false;
        }
    }

    /**
     * Open a file from a file URI (e.g., memory:///user/script.py or disk:///path/to/file.py)
     */
    async function openFileFromUri(uri: string): Promise<boolean> {
        // Parse URI format: pluginId:///path
        const match = uri.match(/^([^:]+):\/\/\/(.*)$/);
        if (!match) {
            console.error('[ScriptEditor]', 'Invalid file URI:', uri);
            return false;
        }

        const pluginId = match[1];
        const path = '/' + match[2];

        return await openFile(path, pluginId);
    }

    /**
     * Run the Python script
     */
    async function runScript() {
        if (!editor) {
            console.error('[ScriptEditor]', 'Script editor not initialized');
            return;
        }

        if (isGlyphFilterDocument()) {
            console.log(
                '[ScriptEditor]',
                'Run blocked: Glyph Overview filters must run from the filter UI'
            );
            updateRunButtonState();
            return;
        }

        if (!window.pyodide) {
            alert('Python environment not ready yet');
            return;
        }

        const code = editor.getValue().trim();
        if (!code) {
            alert('Please write some Python code first');
            return;
        }

        // Disable the run button while executing
        runButton!.disabled = true;
        runButton!.style.opacity = '0.65';
        runButton!.textContent = '⏳ Running...';

        try {
            // Run the Python code in the console terminal
            if (window.term) {
                // Print a separator in the console
                window.term.echo('---');
                window.term.echo('🚀 Running script...');

                // Execute the code
                await window.pyodide.runPythonAsync(code);

                window.term.echo('✅ Script completed');
            } else {
                // Fallback: just execute the code
                await window.pyodide.runPythonAsync(code);
                console.log('[ScriptEditor]', 'Script executed successfully');
            }
        } catch (error: any) {
            console.error('[ScriptEditor]', 'Script execution error:', error);

            // Clean the traceback to remove Pyodide internal frames
            const fullTraceback =
                error?.constructor?.name === 'PythonError'
                    ? window.cleanPythonTraceback(error.message)
                    : error?.message || String(error);

            // Display error in the terminal console
            if (window.consoleError) {
                // Use the global console error function
                window.consoleError(fullTraceback);
            } else if (window.term) {
                // Fallback to direct term.error
                try {
                    if (window.term.paused) {
                        window.term.resume();
                    }
                    window.term.error(fullTraceback);
                } catch (e) {
                    console.error(
                        '[ScriptEditor]',
                        'Failed to display error in terminal:',
                        e
                    );
                }
            } else {
                console.error(
                    '[ScriptEditor]',
                    'Script error (terminal not available):',
                    fullTraceback
                );
            }
        } finally {
            // Re-enable the run button
            updateRunButtonState();
        }
    }

    /**
     * Start watching a file for external changes
     */
    async function startFileWatcher(
        path: string,
        pluginId: string
    ): Promise<void> {
        console.log(
            '[ScriptEditor]',
            'startFileWatcher called for:',
            pluginId,
            path
        );

        // Stop any existing watcher
        stopFileWatcher();

        // Only watch disk files (memory files can't change externally)
        if (pluginId !== 'disk') {
            console.log(
                '[ScriptEditor]',
                'Skipping file watcher - not a disk file'
            );
            return;
        }

        try {
            const plugin = getPluginById(pluginId);
            if (!plugin) {
                return;
            }

            const adapter = plugin.getAdapter();

            // Check if adapter is ready (for NativeAdapter, check if directory is selected)
            if (
                (adapter as any).hasDirectory &&
                !(adapter as any).hasDirectory()
            ) {
                console.log(
                    '[ScriptEditor]',
                    'Adapter not ready yet, will not start file watcher'
                );
                return;
            }

            // Get initial file modification time
            const fileInfo = await getFileInfo(adapter, path);
            if (fileInfo) {
                lastModifiedTime = fileInfo.lastModified;
                console.log(
                    '[ScriptEditor]',
                    'Initial file mtime:',
                    new Date(fileInfo.lastModified).toISOString()
                );
            } else {
                console.warn(
                    '[ScriptEditor]',
                    'Could not get initial file info for:',
                    path
                );
            }

            // Poll for changes every 2 seconds
            fileWatcherInterval = window.setInterval(async () => {
                await checkForExternalChanges();
            }, 2000);

            console.log('[ScriptEditor]', 'File watcher started for:', path);
        } catch (error) {
            console.error(
                '[ScriptEditor]',
                'Error starting file watcher:',
                error
            );
        }
    }

    /**
     * Stop watching the current file
     */
    function stopFileWatcher(): void {
        if (fileWatcherInterval !== null) {
            window.clearInterval(fileWatcherInterval);
            fileWatcherInterval = null;
            lastModifiedTime = null;
            console.log('[ScriptEditor]', 'File watcher stopped');
        }
    }

    /**
     * Get file information including modification time
     */
    async function getFileInfo(
        adapter: any,
        path: string
    ): Promise<{ lastModified: number } | null> {
        try {
            // Check if adapter is ready
            if (adapter.hasDirectory && !adapter.hasDirectory()) {
                return null;
            }

            // For NativeAdapter, we can get the file handle
            if (adapter.getHandleAtPath) {
                const handle = await adapter.getHandleAtPath(path);
                if (handle && handle.getFile) {
                    const file = await handle.getFile();
                    return { lastModified: file.lastModified };
                }
            }

            // Fallback: scan directory and get file info
            const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
            const fileName = path.substring(path.lastIndexOf('/') + 1);
            const dirContents = await adapter.scanDirectory(parentPath);

            if (dirContents[fileName] && dirContents[fileName].mtime) {
                const mtimeDate = new Date(dirContents[fileName].mtime);
                return { lastModified: mtimeDate.getTime() };
            }

            return null;
        } catch (error) {
            console.error('[ScriptEditor]', 'Error getting file info:', error);
            return null;
        }
    }

    /**
     * Check if the file has been modified externally
     */
    async function checkForExternalChanges(): Promise<void> {
        if (
            !currentFilePath ||
            !currentPluginId ||
            currentPluginId !== 'disk'
        ) {
            return;
        }

        try {
            const plugin = getPluginById(currentPluginId);
            if (!plugin) {
                return;
            }

            const adapter = plugin.getAdapter();
            const fileInfo = await getFileInfo(adapter, currentFilePath);

            if (!fileInfo) {
                console.warn(
                    '[ScriptEditor]',
                    'Could not get file info during check'
                );
                return;
            }

            if (!lastModifiedTime) {
                console.warn(
                    '[ScriptEditor]',
                    'No lastModifiedTime set, initializing'
                );
                lastModifiedTime = fileInfo.lastModified;
                return;
            }

            // Check if file was modified since we last checked
            if (fileInfo.lastModified > lastModifiedTime) {
                console.log(
                    '[ScriptEditor]',
                    'External changes detected - old:',
                    new Date(lastModifiedTime).toISOString(),
                    'new:',
                    new Date(fileInfo.lastModified).toISOString()
                );
                lastModifiedTime = fileInfo.lastModified;

                // If no unsaved changes, reload automatically
                if (!isModified) {
                    await reloadFileFromDisk();
                } else {
                    // Has unsaved changes - show reload button
                    hasExternalChanges = true;
                    updateReloadButton();
                }
            }
        } catch (error) {
            console.error(
                '[ScriptEditor]',
                'Error checking for external changes:',
                error
            );
        }
    }

    /**
     * Reload the file from disk
     */
    async function reloadFileFromDisk(): Promise<void> {
        if (!currentFilePath || !currentPluginId) {
            return;
        }

        try {
            const plugin = getPluginById(currentPluginId);
            if (!plugin) {
                return;
            }

            const adapter = plugin.getAdapter();
            const data = await adapter.readFile(currentFilePath);

            // Convert Uint8Array to string
            let content: string;
            if (data instanceof Uint8Array) {
                const decoder = new TextDecoder();
                content = decoder.decode(data);
            } else {
                content = data as string;
            }

            // Save cursor position
            const cursorPosition = editor.getCursorPosition();
            const scrollTop = editor.session.getScrollTop();

            // Update editor
            editor.setValue(content, -1);

            // Restore cursor position
            editor.moveCursorToPosition(cursorPosition);
            editor.clearSelection();
            editor.session.setScrollTop(scrollTop);

            savedContent = content;
            persistSavedContent();
            hasExternalChanges = false;
            setModified(false);

            console.log('[ScriptEditor]', 'File reloaded from disk');

            // Update localStorage
            localStorage.setItem(SCRIPT_CONTENT_STORAGE_KEY, content);

            // Save current file timestamp
            const fileInfo = await getFileInfo(adapter, currentFilePath);
            if (fileInfo) {
                lastModifiedTime = fileInfo.lastModified;
                localStorage.setItem(
                    SCRIPT_TIMESTAMP_STORAGE_KEY,
                    fileInfo.lastModified.toString()
                );
            }
        } catch (error: any) {
            console.error('[ScriptEditor]', 'Error reloading file:', error);
            alert(
                'Failed to reload file: ' + (error?.message || String(error))
            );
        }
    }

    /**
     * Handle reload button click
     */
    async function handleReloadExternalChanges(): Promise<void> {
        await reloadFileFromDisk();
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // API Documentation modal handlers
    function initAPIDocsModal() {
        const apiDocsBtn = document.getElementById('script-api-docs-btn');
        const apiDocsModal = document.getElementById('api-docs-modal');
        const apiDocsCloseBtn = document.getElementById(
            'api-docs-modal-close-btn'
        );

        if (apiDocsBtn && apiDocsModal && apiDocsCloseBtn) {
            // Open modal
            apiDocsBtn.addEventListener('click', (event: Event) => {
                event.stopPropagation();
                apiDocsModal.style.display = 'flex';
            });

            // Close modal
            const closeModal = () => {
                apiDocsModal.style.display = 'none';
                // Restore focus to canvas if editor view was active
                const editorView = document.getElementById('view-editor');
                if (
                    editorView &&
                    editorView.classList.contains('focused') &&
                    window.glyphCanvas &&
                    window.glyphCanvas.canvas
                ) {
                    setTimeout(() => window.glyphCanvas?.canvas?.focus(), 0);
                }
            };

            apiDocsCloseBtn.addEventListener('click', closeModal);

            // Close on backdrop click
            apiDocsModal.addEventListener('click', (e: Event) => {
                if (e.target === apiDocsModal) {
                    closeModal();
                }
            });

            // Close on Escape key
            document.addEventListener('keydown', (e) => {
                if (
                    e.key === 'Escape' &&
                    apiDocsModal.style.display === 'flex'
                ) {
                    e.preventDefault();
                    e.stopPropagation();
                    closeModal();
                }
            });
        }
    }

    // Initialize API docs modal
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initAPIDocsModal);
    } else {
        initAPIDocsModal();
    }

    // Expose scriptEditor API globally for other scripts
    window.scriptEditor = {
        get editor() {
            return editor;
        },
        runScript: runScript,
        openFile: openFile,
        openFileFromUri: openFileFromUri,
        newFile: handleNew,
        save: handleSave,
        saveAs: handleSaveAs,
        updateFilePath: updateFilePath,
        getDocumentState: getDocumentState,
        setDocumentKind: setDocumentKind,
        createDraft: (kind: ScriptDocumentKind, content?: string) => {
            stopFileWatcher();
            setDocumentKind(kind);
            currentFilePath = null;
            currentPluginId = null;
            hasExternalChanges = false;
            editor.setValue(
                content ||
                    (kind === 'glyph-filter'
                        ? GLYPH_FILTER_TEMPLATE
                        : GENERAL_SCRIPT_TEMPLATE),
                -1
            );
            savedContent = '';
            persistSavedContent();
            setModified(true);
            localStorage.removeItem(SCRIPT_URI_STORAGE_KEY);
        },
        revertToSaved: revertToSaved,
        replaceExactText: (
            oldText: string,
            newText: string,
            expectedRevision: string
        ) => {
            if (expectedRevision !== getRevision()) {
                throw new Error(
                    'The script changed since it was last read. Read it again before editing.'
                );
            }
            const content = editor.getValue();
            const firstIndex = content.indexOf(oldText);
            if (firstIndex < 0) {
                throw new Error(
                    'The requested text was not found in the script.'
                );
            }
            if (content.indexOf(oldText, firstIndex + oldText.length) >= 0) {
                throw new Error(
                    'The requested text appears more than once. Read a narrower section before editing.'
                );
            }
            const document = editor.session.getDocument();
            document.replace(
                {
                    start: document.indexToPosition(firstIndex, 0),
                    end: document.indexToPosition(
                        firstIndex + oldText.length,
                        0
                    )
                },
                newText
            );
            return getDocumentState();
        },
        get isModified() {
            return isModified;
        },
        get currentFilePath() {
            return currentFilePath;
        },
        get currentPluginId() {
            return currentPluginId;
        }
    };
})();
