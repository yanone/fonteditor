/**
 * Shared Escape handling for DOM modal overlays.
 *
 * Tippy menus always win when visible (see tippy-utils). Open modals form a
 * LIFO stack so nested overlays close from the top without falling through to
 * the glyph canvas or other view-level Escape handlers.
 */

import { hasVisibleTippyMenus } from '../tippy-utils';

export type ModalEscapeClose = () => void;

export type ModalEscapeBinding = {
    /** Remove this modal from the Escape stack. Idempotent. */
    release: () => void;
};

export type BindModalEscapeOptions = {
    /**
     * When provided, Escape skips (and drops) stale entries whose modal is no
     * longer open. Important when module reloads leave old document listeners.
     */
    isOpen?: () => boolean;
};

type ModalEscapeEntry = {
    id: symbol;
    close: ModalEscapeClose;
    isOpen?: () => boolean;
};

const modalEscapeStack: ModalEscapeEntry[] = [];
let escapeListenerInstalled = false;

function installEscapeListener(): void {
    if (escapeListenerInstalled) {
        return;
    }

    document.addEventListener(
        'keydown',
        (event: KeyboardEvent) => {
            if (event.key !== 'Escape') {
                return;
            }

            // Tippy menus consume Escape first.
            if (hasVisibleTippyMenus()) {
                return;
            }

            while (modalEscapeStack.length > 0) {
                const top = modalEscapeStack[modalEscapeStack.length - 1];
                if (!top) {
                    break;
                }
                if (top.isOpen && !top.isOpen()) {
                    modalEscapeStack.pop();
                    continue;
                }

                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();

                // Pop before close so a re-entrant bind from close/open is clean.
                modalEscapeStack.pop();
                top.close();
                return;
            }
        },
        true
    );

    escapeListenerInstalled = true;
}

/**
 * Register a modal so Escape closes it (LIFO).
 * Call `release()` when the modal closes by any means (button, backdrop, etc.).
 */
export function bindModalEscape(
    close: ModalEscapeClose,
    options?: BindModalEscapeOptions
): ModalEscapeBinding {
    installEscapeListener();

    const id = Symbol('modal-escape');
    const entry: ModalEscapeEntry = {
        id,
        close,
        isOpen: options?.isOpen
    };
    modalEscapeStack.push(entry);

    let released = false;
    return {
        release: () => {
            if (released) {
                return;
            }
            released = true;
            const index = modalEscapeStack.findIndex(
                (candidate) => candidate.id === id
            );
            if (index >= 0) {
                modalEscapeStack.splice(index, 1);
            }
        }
    };
}

/** Whether any modal is currently bound for Escape dismissal. */
export function hasBoundModalEscape(): boolean {
    return modalEscapeStack.some((entry) => !entry.isOpen || entry.isOpen());
}
