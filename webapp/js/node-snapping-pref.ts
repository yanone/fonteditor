/**
 * Preference: snap outline points while dragging or drawing.
 * Default false — opt in via Editing View → View menu → Node Snapping.
 */

const STORAGE_KEY = 'editorNodeSnapping';

export function isNodeSnappingEnabled(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

export function setNodeSnappingEnabled(enabled: boolean): void {
    try {
        localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
    } catch {
        // Ignore localStorage access failures.
    }

    window.dispatchEvent(
        new CustomEvent('nodeSnappingChanged', {
            detail: { enabled }
        })
    );
}

export function toggleNodeSnappingEnabled(): boolean {
    const next = !isNodeSnappingEnabled();
    setNodeSnappingEnabled(next);
    return next;
}
