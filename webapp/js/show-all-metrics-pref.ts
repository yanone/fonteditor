/**
 * Preference: draw OS/2 / hhea / typo metric lines in edit mode.
 * Default false — opt in via Editing View → View menu → Show All Metrics.
 */

const STORAGE_KEY = 'editorShowAllMetrics';

export function isShowAllMetricsEnabled(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

export function setShowAllMetricsEnabled(enabled: boolean): void {
    try {
        localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
    } catch {
        // Ignore localStorage access failures.
    }

    window.dispatchEvent(
        new CustomEvent('showAllMetricsChanged', {
            detail: { enabled }
        })
    );
}

export function toggleShowAllMetricsEnabled(): boolean {
    const next = !isShowAllMetricsEnabled();
    setShowAllMetricsEnabled(next);
    return next;
}
