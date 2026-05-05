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

const console = new Logger('ToolbarMenus');

type ToolbarMenuItem = {
    label: string;
    icon: string;
    shortcut?: string;
    disabled?: boolean;
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
            const disabledClass = item.disabled ? ' disabled' : '';
            const renderedShortcut = item.shortcut
                ? `<span class="plugin-menu-shortcut">${escapeHtml(item.shortcut)}</span>`
                : '';

            return `
                <div class="plugin-menu-item toolbar-menu-item${disabledClass}" data-label="${escapeHtml(item.label)}">
                    <span class="material-symbols-outlined">${escapeHtml(item.icon)}</span>
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

    return [
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
    ];
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
    installGlobalShortcuts();

    console.log('[ToolbarMenus] Toolbar menus initialized');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initToolbarMenus);
} else {
    initToolbarMenus();
}
