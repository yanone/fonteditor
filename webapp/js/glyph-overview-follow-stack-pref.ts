/**
 * Preference: scroll the glyph overview when the editing glyph stack changes.
 * Default false — opt in via Editing View → View menu.
 */

const STORAGE_KEY = 'glyphOverviewFollowStackScroll';

export function isOverviewFollowStackScrollEnabled(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

export function setOverviewFollowStackScrollEnabled(enabled: boolean): void {
    try {
        localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
    } catch {
        // Ignore localStorage access failures.
    }

    window.dispatchEvent(
        new CustomEvent('overviewFollowStackScrollChanged', {
            detail: { enabled }
        })
    );
}

export function toggleOverviewFollowStackScrollEnabled(): boolean {
    const next = !isOverviewFollowStackScrollEnabled();
    setOverviewFollowStackScrollEnabled(next);
    return next;
}
