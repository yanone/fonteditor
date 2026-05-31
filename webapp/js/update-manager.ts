/**
 * Shared update state for the PWA service worker update notification.
 *
 * The inline script in index.html sets window.__pendingUpdate directly
 * and dispatches a 'counterpunch:update-available' CustomEvent.
 * This module provides typed access for the TypeScript side.
 */

export type PendingUpdate = {
    version: string;
    isPreview: boolean;
};

/** Current pending update, or null. */
export function getPendingUpdate(): PendingUpdate | null {
    return window.__pendingUpdate ?? null;
}

/** Clear the pending update (e.g. after the user reloads). */
export function clearPendingUpdate(): void {
    window.__pendingUpdate = null;
}
