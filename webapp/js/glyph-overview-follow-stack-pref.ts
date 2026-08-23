/**
 * Preference: scroll the glyph overview when the editing glyph stack changes.
 * Default false — opt in via Editing View → View menu.
 */

import {
    isOverviewFollowEnabled,
    setOverviewFollowEnabled
} from './window-ui-state';

export function isOverviewFollowStackScrollEnabled(): boolean {
    return isOverviewFollowEnabled();
}

export function setOverviewFollowStackScrollEnabled(enabled: boolean): void {
    setOverviewFollowEnabled(enabled);
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
