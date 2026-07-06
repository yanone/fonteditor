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

const console = new Logger('ToolbarMenus');

type ToolbarMenuItem = {
    label: string;
    icon: string;
    shortcut?: string;
    disabled?: boolean;
    separator?: boolean;
    action: () => Promise<void>;
};

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function createMenuHtml(items: ToolbarMenuItem[]): string {
    const renderedItems = items
        .map((item) => {
            if (item.separator) {
                return '<div class="plugin-menu-separator"></div>';
            }

            const disabledClass = item.disabled ? ' disabled' : '';
            const renderedShortcut = item.shortcut
                ? `<span class="plugin-menu-shortcut">${escapeHtml(item.shortcut)}</span>`
                : '';

            // The update item gets a dot indicator instead of a material icon
            let iconHtml: string;
            if (item.icon === 'update-dot') {
                iconHtml =
                    '<span class="material-symbols-outlined menu-update-dot-indicator"></span>';
            } else {
                iconHtml = `<span class="material-symbols-outlined">${escapeHtml(item.icon)}</span>`;
            }

            return `
                <div class="plugin-menu-item toolbar-menu-item${disabledClass}" data-label="${escapeHtml(item.label)}">
                    ${iconHtml}
                    <span>${escapeHtml(item.label)}</span>
                    ${renderedShortcut}
                </div>
            `;
        })
        .join('');

    return `<div class="plugin-menu toolbar-menu">${renderedItems}</div>`;
}

function setupHandlers(
    instance: TippyInstance,
    items: ToolbarMenuItem[]
): void {
    const menu = instance.popper.querySelector('.toolbar-menu');
    if (!menu) {
        return;
    }

    menu.querySelectorAll('.toolbar-menu-item:not(.disabled)').forEach(
        (element, index) => {
            element.addEventListener('click', async () => {
                instance.hide();
                await items[index].action();
            });
        }
    );

    setupMenuKeyboardNav(menu);
}

function getFileMenuItems(): ToolbarMenuItem[] {
    const saveButton = window.saveButton;
    const pending = getPendingUpdate();

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
            shortcut: '⌘N',
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
        }
    );

    return items;
}

function getEditMenuItems(): ToolbarMenuItem[] {
    const hasFontOpen = !!window.fontManager?.currentFont;

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

function getDeveloperMenuItems(): ToolbarMenuItem[] {
    return [
        {
            label: 'Copy Cloud Debug Snapshot',
            icon: 'content_copy',
            action: async () => {
                if (!window.cloudPlugin) {
                    alert('Cloud plugin is not available.');
                    return;
                }

                await window.cloudPlugin.copyCloudDebugSnapshot();
            }
        },
        {
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
                    alert(
                        'Clipboard access failed while copying history items.'
                    );
                    throw error;
                }
            }
        }
    ];
}

function createToolbarMenu(
    buttonId: string,
    backdropClassName: string,
    itemFactory: () => ToolbarMenuItem[]
): void {
    const button = document.getElementById(buttonId) as HTMLElement | null;
    if (!button) {
        return;
    }

    const backdrop = getOrCreateBackdrop(backdropClassName);
    const instance = tippy(button, {
        content: createMenuHtml(itemFactory()),
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
            const items = itemFactory();
            currentInstance.setContent(createMenuHtml(items));
            window.requestAnimationFrame(() =>
                setupHandlers(currentInstance, items)
            );
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
            if (!event.shiftKey && key === 'n') {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                void window.fontManager?.handleNewFont?.();
                return;
            }

            if (!event.shiftKey && key === 'o') {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                void window.showFontFileDialog?.({ mode: 'open' });
                return;
            }

            if (event.shiftKey && key === 's') {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                void window.showFontFileDialog?.({ mode: 'save-as' });
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
        'toolbar-window-menu-btn',
        'toolbar-window-menu-backdrop',
        getWindowMenuItems
    );
    createToolbarMenu(
        'toolbar-developer-menu-btn',
        'toolbar-developer-menu-backdrop',
        getDeveloperMenuItems
    );
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
