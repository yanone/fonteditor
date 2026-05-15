/**
 * Tippy.js Utilities
 * Shared utilities for tippy menus across the application
 */

import { Logger } from './logger';

const console = new Logger('TippyUtils');

type EscapeHandler = () => void;

const visibleTippyStack: any[] = [];
const tippyEscapeHandlers = new WeakMap<any, EscapeHandler>();
const nativeContextMenuSuppressedElements = new WeakSet<HTMLElement>();
let escapePriorityListenerInstalled = false;

function suppressNativeContextMenu(element: HTMLElement | null): void {
    if (!element || nativeContextMenuSuppressedElements.has(element)) {
        return;
    }

    nativeContextMenuSuppressedElements.add(element);
    element.dataset.hasContextMenu = 'true';

    element.addEventListener(
        'contextmenu',
        (event: Event) => {
            event.preventDefault();
        },
        true
    );

    element.addEventListener(
        'pointerdown',
        (event: PointerEvent) => {
            if (event.button !== 2) {
                return;
            }

            event.preventDefault();
        },
        true
    );
}

function removeFromVisibleStack(instance: any): void {
    const idx = visibleTippyStack.lastIndexOf(instance);
    if (idx >= 0) {
        visibleTippyStack.splice(idx, 1);
    }
}

function installEscapePriorityListener(): void {
    if (escapePriorityListenerInstalled) {
        return;
    }

    document.addEventListener(
        'keydown',
        (e: KeyboardEvent) => {
            if (e.key !== 'Escape') {
                return;
            }

            if (visibleTippyStack.length === 0) {
                return;
            }

            const topInstance = visibleTippyStack[visibleTippyStack.length - 1];
            if (!topInstance || !topInstance.state?.isVisible) {
                removeFromVisibleStack(topInstance);
                return;
            }

            // Ensure open tippy menus consume Escape before any app-level handlers.
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            topInstance.hide();
            const onEscape = tippyEscapeHandlers.get(topInstance);
            if (onEscape) {
                onEscape();
            }
        },
        true
    );

    escapePriorityListenerInstalled = true;
}

/**
 * Create or get a backdrop element for modal-like menu behavior
 */
export function getOrCreateBackdrop(className: string): HTMLElement {
    let backdrop = document.querySelector(`.${className}`) as HTMLElement;
    if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.className = `plugin-menu-backdrop ${className}`;
        document.body.appendChild(backdrop);
    }
    return backdrop;
}

/**
 * Get current theme for tippy menus
 */
export function getTheme(): string {
    const root = document.documentElement;
    const theme = root.getAttribute('data-theme');
    return theme === 'light' ? 'light' : 'dark';
}

/**
 * Add backdrop and keyboard support to a Tippy instance
 */
export function addTippyBackdropSupport(
    tippyInstance: any,
    backdrop: HTMLElement,
    options?: {
        onEscape?: () => void;
        targetElement?: HTMLElement;
        activeClass?: string;
    }
): void {
    installEscapePriorityListener();

    suppressNativeContextMenu(options?.targetElement || null);
    suppressNativeContextMenu(tippyInstance.popper || null);
    suppressNativeContextMenu(backdrop);

    const originalOnShow = tippyInstance.props.onShow;
    const originalOnShown = tippyInstance.props.onShown;
    const originalOnHide = tippyInstance.props.onHide;

    if (options?.onEscape) {
        tippyEscapeHandlers.set(tippyInstance, options.onEscape);
    }

    // Add backdrop click handler to close menu
    const handleBackdropClick = () => {
        if (tippyInstance.state.isVisible) {
            tippyInstance.hide();
        }
    };

    tippyInstance.setProps({
        onShow: (instance: any) => {
            backdrop.classList.add('visible');
            if (options?.targetElement && options?.activeClass) {
                options.targetElement.classList.add(options.activeClass);
            }

            removeFromVisibleStack(instance);
            visibleTippyStack.push(instance);

            // Add backdrop click handler
            backdrop.addEventListener('click', handleBackdropClick);

            if (originalOnShow) originalOnShow(instance);
        },
        onShown: (instance: any) => {
            if (originalOnShown) originalOnShown(instance);
        },
        onHide: (instance: any) => {
            backdrop.classList.remove('visible');
            if (options?.targetElement && options?.activeClass) {
                options.targetElement.classList.remove(options.activeClass);
            }

            removeFromVisibleStack(instance);

            // Remove backdrop click handler
            backdrop.removeEventListener('click', handleBackdropClick);

            if (originalOnHide) originalOnHide(instance);
        }
    });
}

/**
 * Setup keyboard navigation for menu items
 * Call this after the menu is shown (in onShown callback)
 * @param menu - The menu container element (with .plugin-menu class)
 * @param itemSelector - CSS selector for menu items (default: '.plugin-menu-item')
 * @param autoFocusFirst - Whether to auto-focus the first item (default: false for context menus)
 */
export function setupMenuKeyboardNav(
    menu: Element,
    itemSelector: string = '.plugin-menu-item',
    autoFocusFirst: boolean = false
): void {
    const items = Array.from(menu.querySelectorAll(itemSelector));
    if (items.length === 0) return;

    let focusedIndex = -1; // -1 means no item focused initially

    const updateFocus = () => {
        items.forEach((el, i) => {
            el.classList.toggle('focused', i === focusedIndex);
        });
    };

    const handleKeydown = (e: Event) => {
        const keyEvent = e as KeyboardEvent;
        if (keyEvent.key === 'ArrowDown') {
            e.preventDefault();
            focusedIndex =
                focusedIndex < 0 ? 0 : (focusedIndex + 1) % items.length;
            updateFocus();
        } else if (keyEvent.key === 'ArrowUp') {
            e.preventDefault();
            focusedIndex =
                focusedIndex < 0
                    ? items.length - 1
                    : (focusedIndex - 1 + items.length) % items.length;
            updateFocus();
        } else if (keyEvent.key === 'Enter' && focusedIndex >= 0) {
            e.preventDefault();
            (items[focusedIndex] as HTMLElement).click();
        }
    };

    menu.addEventListener('keydown', handleKeydown);

    if (autoFocusFirst) {
        focusedIndex = 0;
        updateFocus();
    }
    (menu as HTMLElement).focus();
}
