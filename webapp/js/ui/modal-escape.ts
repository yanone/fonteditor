/**
 * Shared Escape handling for DOM modal overlays.
 *
 * Tippy menus always win when visible (see tippy-utils). Open modals form a
 * LIFO stack so nested overlays close from the top without falling through to
 * the glyph canvas or other view-level Escape handlers.
 *
 * The stack and capture listener live on `window` so every webpack copy of
 * this module (static vs async chunks) shares one order.
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

type ModalEscapeRuntime = {
    stack: ModalEscapeEntry[];
    listenerInstalled: boolean;
};

function getRuntime(): ModalEscapeRuntime {
    const holder = window as Window & {
        __modalEscapeRuntime?: ModalEscapeRuntime;
    };
    if (!holder.__modalEscapeRuntime) {
        holder.__modalEscapeRuntime = {
            stack: [],
            listenerInstalled: false
        };
    }
    return holder.__modalEscapeRuntime;
}

function installEscapeListener(): void {
    const runtime = getRuntime();
    if (runtime.listenerInstalled) {
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

            const { stack } = getRuntime();
            while (stack.length > 0) {
                const top = stack[stack.length - 1];
                if (!top) {
                    break;
                }
                if (top.isOpen && !top.isOpen()) {
                    stack.pop();
                    continue;
                }

                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();

                // Pop before close so a re-entrant bind from close/open is clean.
                stack.pop();
                top.close();
                scheduleFocusedViewRestore();
                return;
            }
        },
        true
    );

    runtime.listenerInstalled = true;
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

    const { stack } = getRuntime();
    const id = Symbol('modal-escape');
    const entry: ModalEscapeEntry = {
        id,
        close,
        isOpen: options?.isOpen
    };
    stack.push(entry);

    let released = false;
    return {
        release: () => {
            if (released) {
                return;
            }
            released = true;
            const runtimeStack = getRuntime().stack;
            const index = runtimeStack.findIndex(
                (candidate) => candidate.id === id
            );
            if (index >= 0) {
                runtimeStack.splice(index, 1);
            }
            scheduleFocusedViewRestore();
        }
    };
}

function scheduleFocusedViewRestore(): void {
    queueMicrotask(() => {
        if (hasBoundModalEscape()) {
            return;
        }
        window.restoreFocusedViewDomFocus?.();
    });
}

/** Whether any modal is currently bound for Escape dismissal. */
export function hasBoundModalEscape(): boolean {
    return getRuntime().stack.some((entry) => !entry.isOpen || entry.isOpen());
}
