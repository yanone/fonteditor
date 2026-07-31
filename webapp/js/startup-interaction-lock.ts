let startupInteractionLockCount = 0;
let startupInteractionLockOverlay: HTMLDivElement | null = null;
const canUseStartupInteractionLockDom =
    typeof document !== 'undefined' && typeof window !== 'undefined';

function getOrCreateStartupInteractionLockOverlay(): HTMLDivElement {
    if (!canUseStartupInteractionLockDom) {
        throw new Error(
            'Startup interaction lock overlay requires browser DOM access.'
        );
    }

    if (startupInteractionLockOverlay) {
        return startupInteractionLockOverlay;
    }

    const overlay = document.createElement('div');
    overlay.id = 'startup-interaction-lock-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = 'transparent';
    overlay.style.pointerEvents = 'auto';
    overlay.style.zIndex = '2147483646';
    overlay.style.display = 'none';
    startupInteractionLockOverlay = overlay;
    return overlay;
}

function isModifierKeyEvent(event: KeyboardEvent): boolean {
    return (
        event.key === 'Shift' ||
        event.key === 'Control' ||
        event.key === 'Alt' ||
        event.key === 'Meta'
    );
}

function shouldBlockKeyboardEvent(event: KeyboardEvent): boolean {
    if (!startupInteractionLockCount) {
        return false;
    }

    if (isModifierKeyEvent(event)) {
        return false;
    }

    if (event.metaKey || event.ctrlKey || event.altKey) {
        return false;
    }

    return true;
}

function preventWhileLocked(event: Event): void {
    if (!startupInteractionLockCount) {
        return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
}

function preventKeyboardWhileLocked(event: KeyboardEvent): void {
    if (!shouldBlockKeyboardEvent(event)) {
        return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
}

function applyStartupInteractionLock(): void {
    if (!canUseStartupInteractionLockDom) {
        return;
    }

    const body = document.body;
    if (!body) {
        return;
    }

    const overlay = getOrCreateStartupInteractionLockOverlay();
    if (!overlay.isConnected) {
        body.appendChild(overlay);
    }
    overlay.style.display = 'block';
    body.classList.add('startup-interaction-locked');

    const activeElement = document.activeElement as HTMLElement | null;
    activeElement?.blur?.();
}

function clearStartupInteractionLock(): void {
    if (!canUseStartupInteractionLockDom) {
        return;
    }

    startupInteractionLockOverlay?.style.setProperty('display', 'none');
    document.body?.classList.remove('startup-interaction-locked');

    // applyStartupInteractionLock blurs the active element. Put DOM focus back
    // on the view that still has `.focused` so paste/typeahead match that view.
    const focusedView = document.querySelector(
        '.view.focused'
    ) as HTMLElement | null;
    if (focusedView?.id && typeof window.focusView === 'function') {
        window.focusView(focusedView.id);
    }
}

export function beginStartupInteractionLock(): void {
    if (!canUseStartupInteractionLockDom) {
        return;
    }

    startupInteractionLockCount += 1;

    if (startupInteractionLockCount === 1) {
        applyStartupInteractionLock();
    }
}

export function endStartupInteractionLock(): void {
    if (!canUseStartupInteractionLockDom) {
        return;
    }

    if (startupInteractionLockCount > 0) {
        startupInteractionLockCount -= 1;
    }

    if (startupInteractionLockCount === 0) {
        clearStartupInteractionLock();
    }
}

if (canUseStartupInteractionLockDom) {
    document.addEventListener('keydown', preventKeyboardWhileLocked, true);
    document.addEventListener('keypress', preventKeyboardWhileLocked, true);
    document.addEventListener('beforeinput', preventWhileLocked, true);
    document.addEventListener('input', preventWhileLocked, true);
    document.addEventListener('compositionstart', preventWhileLocked, true);
    document.addEventListener('compositionupdate', preventWhileLocked, true);
    document.addEventListener('compositionend', preventWhileLocked, true);
    document.addEventListener('paste', preventWhileLocked, true);
    document.addEventListener('drop', preventWhileLocked, true);
}
