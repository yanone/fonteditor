import { Logger } from './logger';

const console = new Logger('ViewFocus');

const TOP_ROW_COLLAPSED_WIDTH = 24;
const COLLAPSED_WIDTH_THRESHOLD = 5;

/**
 * Nearest still-expanded top-row view, by distance between bounding-box
 * centers. Used when a top-row view collapses and focus must move.
 */
export function getClosestExpandedTopRowViewId(
    collapsedViewId: string
): string | null {
    const collapsedView = document.getElementById(collapsedViewId);
    const topRow = collapsedView?.closest('.top-row');
    if (!collapsedView || !topRow) {
        return null;
    }

    const siblings = Array.from(topRow.querySelectorAll('.view')).filter(
        (view): view is HTMLElement => view instanceof HTMLElement
    );
    const collapsedCenter = getViewCenterX(collapsedView);
    const expandedSiblings = siblings.filter((view) => {
        if (view.id === collapsedViewId) {
            return false;
        }
        return (
            view.getBoundingClientRect().width >
            TOP_ROW_COLLAPSED_WIDTH + COLLAPSED_WIDTH_THRESHOLD
        );
    });

    if (expandedSiblings.length === 0) {
        console.log('No expanded top-row replacement for', collapsedViewId);
        return null;
    }

    expandedSiblings.sort((left, right) => {
        const leftDistance = Math.abs(getViewCenterX(left) - collapsedCenter);
        const rightDistance = Math.abs(getViewCenterX(right) - collapsedCenter);
        return leftDistance - rightDistance;
    });

    return expandedSiblings[0].id;
}

function getViewCenterX(view: HTMLElement): number {
    const rect = view.getBoundingClientRect();
    return rect.left + rect.width / 2;
}
