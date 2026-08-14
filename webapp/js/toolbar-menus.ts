import tippy, { Instance as TippyInstance } from 'tippy.js';
import 'tippy.js/dist/tippy.css';
import {
    addTippyBackdropSupport,
    getOrCreateBackdrop,
    getTheme,
    setupMenuKeyboardNav
} from './tippy-utils';
import { Logger } from './logger';
import {
    openLinkedEditorWindow,
    triggerRedo,
    triggerUndo
} from './window-buttons';
import { getPendingUpdate } from './update-manager';
import { exportBinaryFont, exportBinaryFontAs } from './binary-font-export';
import { fontDestinationPluginManager } from './font-destination-plugin-manager';
import { showFontDestinationPluginManager } from './font-destination-plugin-ui';
import {
    openRunPythonScriptDialog,
    reRunLastPythonScript,
    getLastRunPythonScript
} from './run-python-script-dialog';
import './add-glyphs-dialog';
import './rename-glyphs-dialog';
import './delete-glyphs-dialog';
import './kerning-editor-dialog';
import { canDeleteSelectedGlyphs } from './delete-glyphs-dialog';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';

const console = new Logger('ToolbarMenus');

type ToolbarMenuItem = {
    label: string;
    icon: string;
    shortcut?: string;
    disabled?: boolean;
    separator?: boolean;
    children?: ToolbarMenuItem[];
    action?: () => Promise<void>;
};

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function createMenuHtml(items: ToolbarMenuItem[], prefix = ''): string {
    const renderedItems = items
        .map((item, index) => {
            if (item.separator) {
                return '<div class="plugin-menu-separator"></div>';
            }

            const menuId = `${prefix}${index}`;

            const disabledClass = item.disabled ? ' disabled' : '';
            const submenuClass = item.children ? ' has-submenu' : '';
            const renderedShortcut = item.shortcut
                ? `<span class="plugin-menu-shortcut">${escapeHtml(item.shortcut)}</span>`
                : '';
            const renderedSubmenu = item.children
                ? `<div class="toolbar-menu-submenu">${createMenuHtml(item.children, `${menuId}.`)}</div><span class="material-symbols-outlined toolbar-menu-chevron">chevron_right</span>`
                : '';

            // The update item gets a dot indicator instead of a material icon
            let iconHtml: string;
            if (item.icon === 'update-dot') {
                iconHtml =
                    '<span class="material-symbols-outlined menu-update-dot-indicator"></span>';
            } else {
                iconHtml = `<span class="material-symbols-outlined">${escapeHtml(item.icon)}</span>`;
            }

            const submenuAria = item.children ? ' aria-expanded="false"' : '';
            return `
                <div class="plugin-menu-item toolbar-menu-item${disabledClass}${submenuClass}" data-menu-id="${menuId}" data-label="${escapeHtml(item.label)}"${submenuAria}>
                    ${iconHtml}
                    <span>${escapeHtml(item.label)}</span>
                    ${renderedShortcut}
                    ${renderedSubmenu}
                </div>
            `;
        })
        .join('');

    return `<div class="plugin-menu toolbar-menu">${renderedItems}</div>`;
}

function getItemByMenuId(
    items: ToolbarMenuItem[],
    menuId: string
): ToolbarMenuItem | null {
    let current: ToolbarMenuItem | undefined;
    let currentItems = items;
    for (const segment of menuId.split('.')) {
        current = currentItems[Number(segment)];
        if (!current) {
            return null;
        }
        currentItems = current.children || [];
    }
    return current || null;
}

function bindToolbarMenuKeyboardNav(instance: TippyInstance): void {
    const menu = instance.popper.querySelector('.toolbar-menu');
    if (menu) {
        setupMenuKeyboardNav(menu);
    }
}

function getFileMenuItems(): ToolbarMenuItem[] {
    const saveButton = window.saveButton;
    const pending = getPendingUpdate();
    const hasFontOpen = !!window.fontManager?.currentFont;

    const items: ToolbarMenuItem[] = [];

    if (pending) {
        items.push({
            label: `Update to ${pending.version}`,
            icon: 'update-dot',
            action: async () => {
                window.location.reload();
            }
        });

        // Changelog only for non-preview versions
        if (!pending.isPreview) {
            items.push({
                label: 'Changelog',
                icon: 'open_in_new',
                action: async () => {
                    window.open(
                        `https://github.com/yanone/context/releases/tag/${pending.version}`,
                        '_blank'
                    );
                }
            });
        }

        // Separator between update items and regular file items
        items.push({
            label: '',
            icon: '',
            separator: true,
            action: async () => {}
        });
    }

    items.push(
        {
            label: 'New',
            icon: 'note_add',
            action: async () => {
                await window.fontManager?.handleNewFont?.();
            }
        },
        {
            label: 'Open…',
            icon: 'folder_open',
            shortcut: '⌘O',
            action: async () => {
                await window.showFontFileDialog?.({ mode: 'open' });
            }
        },
        {
            label: 'Save',
            icon: 'save',
            shortcut: '⌘S',
            disabled: !saveButton?.canSave?.(),
            action: async () => {
                await saveButton?.handleSave?.();
            }
        },
        {
            label: 'Save As…',
            icon: 'save_as',
            shortcut: '⌘⇧S',
            disabled: !saveButton?.canSaveAs?.(),
            action: async () => {
                await window.showFontFileDialog?.({ mode: 'save-as' });
            }
        },
        {
            label: 'Export binary font',
            icon: 'download',
            shortcut: '⌘E',
            disabled: !hasFontOpen,
            action: exportBinaryFont
        },
        {
            label: 'Export binary font as…',
            icon: 'save_as',
            shortcut: '⌘⇧E',
            disabled: !hasFontOpen,
            action: exportBinaryFontAs
        }
    );

    return items;
}

function getEditMenuItems(): ToolbarMenuItem[] {
    const hasFontOpen = !!window.fontManager?.currentFont;
    const hasGlyphSelection =
        (window.glyphOverviewInstance?.getSelectedGlyphNames?.().length || 0) >
        0;
    const canReplaceSelectedPaths = canReplaceSelectedPathsInPlace();

    return [
        {
            label: 'Undo',
            icon: 'undo',
            shortcut: '⌘Z',
            disabled: !hasFontOpen,
            action: triggerUndo
        },
        {
            label: 'Redo',
            icon: 'redo',
            shortcut: '⌘⇧Z',
            disabled: !hasFontOpen,
            action: triggerRedo
        },
        {
            label: 'Replace Path(s) In-Place',
            icon: 'swap_horiz',
            disabled: !canReplaceSelectedPaths,
            action: async () => {
                await window.glyphCanvas?.outlineEditor?.replaceSelectedPathsInPlace?.();
            }
        },
        {
            label: 'Rename Glyph(s)…',
            icon: 'edit',
            shortcut: '⌘⇧F',
            disabled: !hasFontOpen || !hasGlyphSelection,
            action: async () => {
                window.renameGlyphsDialog?.open();
            }
        },
        {
            label: 'Delete Glyph(s)',
            icon: 'delete',
            shortcut: '⌫',
            disabled: !canDeleteSelectedGlyphs(),
            action: async () => {
                window.deleteGlyphsDialog?.open();
            }
        }
    ];
}

function canReplaceSelectedPathsInPlace(): boolean {
    const canvas = window.glyphCanvas;
    const outlineEditor = canvas?.outlineEditor;
    if (!outlineEditor?.active) {
        return false;
    }
    const editorFocused = !!document
        .getElementById('view-editor')
        ?.classList.contains('focused');
    if (!editorFocused) {
        return false;
    }
    const selectedPoints = outlineEditor.selectedPoints;
    if (!Array.isArray(selectedPoints) || selectedPoints.length === 0) {
        return false;
    }
    return true;
}

function getFontMenuItems(): ToolbarMenuItem[] {
    const hasFontOpen = !!window.fontManager?.currentFont;
    const hasGlyphSelection =
        (window.glyphOverviewInstance?.getSelectedGlyphNames?.().length || 0) >
        0;
    return [
        {
            label: 'Add Glyph(s)…',
            icon: 'add_circle',
            shortcut: '⌘⇧G',
            disabled: !hasFontOpen,
            action: async () => {
                await window.addGlyphsDialog?.open();
            }
        },
        {
            label: 'Duplicate Glyph(s)',
            icon: 'content_copy',
            shortcut: '⌘D',
            disabled: !hasFontOpen || !hasGlyphSelection,
            action: async () => {
                window.glyphOverviewInstance?.duplicateSelectedGlyphs?.();
            }
        },
        {
            label: 'Kerning Editor…',
            icon: 'space_bar',
            disabled: !hasFontOpen,
            action: async () => {
                window.kerningEditorDialog?.open();
            }
        }
    ];
}

function getWindowMenuItems(): ToolbarMenuItem[] {
    return [
        {
            label: 'Open In New Window',
            icon: 'open_in_new',
            action: async () => {
                openLinkedEditorWindow();
            }
        }
    ];
}

function getToolsMenuItems(): ToolbarMenuItem[] {
    const destinations =
        fontDestinationPluginManager.getInstalledDestinations();
    const items: ToolbarMenuItem[] = [
        {
            label: 'Plugin Manager',
            icon: 'extension',
            action: showFontDestinationPluginManager
        }
    ];

    if (destinations.length) {
        items.push({ label: '', icon: '', separator: true });
        items.push({
            label: 'Font Destinations',
            icon: 'send',
            children: destinations.map((destination) => ({
                label: destination.name,
                icon: 'open_in_new',
                action: async () => {
                    fontDestinationPluginManager.openDestination(destination);
                }
            }))
        });
    }

    items.push({ label: '', icon: '', separator: true });
    items.push({
        label: 'Run Python Script',
        icon: 'play_arrow',
        shortcut: '⌘R',
        action: async () => {
            await openRunPythonScriptDialog();
        }
    });

    const lastRun = getLastRunPythonScript();
    if (lastRun) {
        items.push({
            label: `Re-run ${lastRun.title}`,
            icon: 'replay',
            shortcut: '⌘⌥R',
            action: async () => {
                await reRunLastPythonScript();
            }
        });
    }

    return items;
}

function getDeveloperMenuItems(): ToolbarMenuItem[] {
    const items: ToolbarMenuItem[] = [];

    if (window.cloudPlugin?.isVisibleInUI?.() !== false) {
        items.push({
            label: 'Copy Cloud Debug Snapshot',
            icon: 'content_copy',
            action: async () => {
                if (!window.cloudPlugin) {
                    alert('Cloud plugin is not available.');
                    return;
                }

                await window.cloudPlugin.copyCloudDebugSnapshot();
            }
        });
    }

    items.push({
        label: 'Copy History Items (Debug)',
        icon: 'content_copy',
        action: async () => {
            const engine = window.patchSyncEngine;
            if (!engine) {
                alert('Patch sync engine is not available.');
                return;
            }

            const items = engine.getCollaborationLog();
            if (!items.length) {
                alert('No history items to copy.');
                return;
            }

            const text = JSON.stringify(items, null, 2);
            try {
                await navigator.clipboard.writeText(text);
            } catch (error) {
                console.error(
                    'Failed to copy history items to clipboard:',
                    error
                );
                alert('Clipboard access failed while copying history items.');
                throw error;
            }
        }
    });

    return items;
}

let privacyPolicyEscapeBinding: ModalEscapeBinding | null = null;

function closePrivacyPolicyModal(): void {
    const modal = document.getElementById('privacy-policy-modal');
    privacyPolicyEscapeBinding?.release();
    privacyPolicyEscapeBinding = null;
    if (modal) {
        modal.style.display = 'none';
    }
}

function openPrivacyPolicyModal(): void {
    const modal = document.getElementById('privacy-policy-modal');
    if (!modal) {
        return;
    }
    modal.style.display = 'flex';
    privacyPolicyEscapeBinding?.release();
    privacyPolicyEscapeBinding = bindModalEscape(closePrivacyPolicyModal, {
        isOpen: () =>
            document.getElementById('privacy-policy-modal')?.style.display ===
            'flex'
    });
}

function getHelpMenuItems(): ToolbarMenuItem[] {
    return [
        {
            label: 'Documentation',
            icon: 'menu_book',
            action: async () => {
                window.openDocs?.();
            }
        },
        {
            label: 'Keyboard Shortcuts',
            icon: 'keyboard',
            action: async () => {
                window.openDocs?.('reference/keyboard-shortcuts');
            }
        },
        {
            label: 'Privacy Policy',
            icon: 'privacy_tip',
            action: async () => {
                openPrivacyPolicyModal();
            }
        }
    ];
}

function createToolbarMenu(
    buttonId: string,
    backdropClassName: string,
    itemFactory: () => ToolbarMenuItem[],
    refresh?: () => Promise<void>
): void {
    const button = document.getElementById(buttonId) as HTMLElement | null;
    if (!button) {
        return;
    }

    const backdrop = getOrCreateBackdrop(backdropClassName);
    // Latest items for delegated clicks — updated every time the menu opens.
    let currentItems: ToolbarMenuItem[] = itemFactory();
    let clickHandlerBound = false;

    const instance = tippy(button, {
        content: createMenuHtml(currentItems),
        allowHTML: true,
        trigger: 'manual',
        interactive: true,
        placement: 'bottom-start',
        theme: getTheme(),
        arrow: false,
        offset: [0, 4],
        hideOnClick: false,
        zIndex: 10001,
        onShow: (currentInstance) => {
            currentItems = itemFactory();
            currentInstance.setContent(createMenuHtml(currentItems));
            // Bind delegated click handling once on the tippy popper. Attaching
            // per-item listeners on every show stacked handlers on reused nodes
            // and queued duplicate alerts (e.g. Replace Path(s) In-Place errors).
            if (!clickHandlerBound) {
                clickHandlerBound = true;
                currentInstance.popper.addEventListener('click', (event) => {
                    const target = event.target as HTMLElement | null;
                    const element = target?.closest(
                        '.toolbar-menu-item'
                    ) as HTMLElement | null;
                    if (
                        !element ||
                        !currentInstance.popper.contains(element) ||
                        element.classList.contains('disabled')
                    ) {
                        return;
                    }
                    const item = getItemByMenuId(
                        currentItems,
                        element.dataset.menuId || ''
                    );
                    if (!item) {
                        return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    if (item.children) {
                        const isOpen = element.classList.toggle('submenu-open');
                        element.setAttribute('aria-expanded', String(isOpen));
                        return;
                    }
                    currentInstance.hide();
                    void item.action?.();
                });
            }
            window.requestAnimationFrame(() =>
                bindToolbarMenuKeyboardNav(currentInstance)
            );
            if (refresh) {
                void refresh().then(() => {
                    if (!currentInstance.state.isVisible) {
                        return;
                    }
                    currentItems = itemFactory();
                    currentInstance.setContent(createMenuHtml(currentItems));
                    window.requestAnimationFrame(() =>
                        bindToolbarMenuKeyboardNav(currentInstance)
                    );
                });
            }
        }
    });

    addTippyBackdropSupport(instance, backdrop, {
        targetElement: button,
        activeClass: 'menu-active'
    });

    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        if (instance.state.isVisible) {
            instance.hide();
        } else {
            instance.show();
        }
    });
}

function setupPrivacyPolicyModal(): void {
    const modal = document.getElementById('privacy-policy-modal');
    const closeBtn = document.getElementById('privacy-policy-modal-close-btn');
    if (!modal) return;

    closeBtn?.addEventListener('click', closePrivacyPolicyModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closePrivacyPolicyModal();
    });
}

function installGlobalShortcuts(): void {
    document.addEventListener(
        'keydown',
        (event: KeyboardEvent) => {
            if (event.defaultPrevented) {
                return;
            }

            const isMac = navigator.platform.toUpperCase().includes('MAC');
            const cmdKey = isMac ? event.metaKey : event.ctrlKey;
            if (!cmdKey || event.altKey) {
                return;
            }

            const key = event.key.toLowerCase();
            if (!event.shiftKey && key === 'o') {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                void window.showFontFileDialog?.({ mode: 'open' });
                return;
            }

            if (
                event.shiftKey &&
                key === 'g' &&
                window.fontManager?.currentFont
            ) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                void window.addGlyphsDialog?.open();
                return;
            }

            if (
                event.shiftKey &&
                key === 'f' &&
                window.fontManager?.currentFont &&
                (window.glyphOverviewInstance?.getSelectedGlyphNames?.()
                    .length || 0) > 0
            ) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                window.renameGlyphsDialog?.open();
                return;
            }

            if (event.shiftKey && key === 's') {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                void window.showFontFileDialog?.({ mode: 'save-as' });
                return;
            }

            if (key === 'e' && window.fontManager?.currentFont) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                void (event.shiftKey
                    ? exportBinaryFontAs()
                    : exportBinaryFont());
            }
        },
        true
    );
}

function initToolbarMenus(): void {
    createToolbarMenu(
        'toolbar-file-menu-btn',
        'toolbar-file-menu-backdrop',
        getFileMenuItems
    );
    createToolbarMenu(
        'toolbar-edit-menu-btn',
        'toolbar-edit-menu-backdrop',
        getEditMenuItems
    );
    createToolbarMenu(
        'toolbar-font-menu-btn',
        'toolbar-font-menu-backdrop',
        getFontMenuItems
    );
    createToolbarMenu(
        'toolbar-window-menu-btn',
        'toolbar-window-menu-backdrop',
        getWindowMenuItems
    );
    createToolbarMenu(
        'toolbar-tools-menu-btn',
        'toolbar-tools-menu-backdrop',
        getToolsMenuItems,
        () => fontDestinationPluginManager.discoverInstalledDestinations()
    );
    createToolbarMenu(
        'toolbar-developer-menu-btn',
        'toolbar-developer-menu-backdrop',
        getDeveloperMenuItems
    );
    createToolbarMenu(
        'toolbar-help-menu-btn',
        'toolbar-help-menu-backdrop',
        getHelpMenuItems
    );

    setupPrivacyPolicyModal();
    installGlobalShortcuts();

    // Listen for update-available events to toggle orange dot on File button
    document.addEventListener('counterpunch:update-available', () => {
        const fileBtn = document.getElementById('toolbar-file-menu-btn');
        if (!fileBtn) {
            return;
        }
        if (getPendingUpdate()) {
            fileBtn.classList.add('has-update');
        } else {
            fileBtn.classList.remove('has-update');
        }
    });

    // Check on init in case update was set before this module loaded
    const fileBtn = document.getElementById('toolbar-file-menu-btn');
    if (fileBtn && getPendingUpdate()) {
        fileBtn.classList.add('has-update');
    }

    console.log('[ToolbarMenus] Toolbar menus initialized');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initToolbarMenus);
} else {
    initToolbarMenus();
}
