import { getClosestExpandedTopRowViewId } from './view-focus';
import {
    applyWindowUi,
    applyDefaultWindowUi,
    getDirectRowViews,
    isViewWidthCollapsed,
    saveWindowUiFromDom
} from './window-ui-state';

console.log('[Resizer]', 'resizer.js loaded');

class ResizableViews {
    // Minimum sizes for different view types
    static TITLE_BAR_HEIGHT = 24;
    static PRIMARY_MIN_WIDTH = 200;
    static PRIMARY_MIN_HEIGHT = 200;
    static SECONDARY_MIN_WIDTH = 100;
    static SECONDARY_MIN_HEIGHT = 24; // Title bar only
    static FONTINFO_MIN_WIDTH = 24; // Title bar width when rotated
    static FONTINFO_MIN_HEIGHT = 100;
    static DOCS_MIN_WIDTH = 200;
    static WORKSPACE_MIN_WIDTH = 400;

    isResizing: boolean;
    currentDivider: HTMLElement | null;
    direction: 'vertical' | 'horizontal' = 'vertical';
    startX: number;
    startY: number;
    startWidths: Record<number, number>;
    startHeights: { top: number; bottom: number };

    constructor() {
        console.log('[Resizer]', 'ResizableViews constructor called');
        this.isResizing = false;
        this.currentDivider = null;
        this.startX = 0;
        this.startY = 0;
        this.startWidths = {};
        this.startHeights = { top: 0, bottom: 0 };

        this.init();
    }

    /**
     * Get the minimum width for a view based on its type
     */
    getMinWidth(view: Element): number {
        if ((view as HTMLElement).id === 'view-docs') {
            return ResizableViews.DOCS_MIN_WIDTH;
        }
        if ((view as HTMLElement).closest('.top-row')) {
            return ResizableViews.FONTINFO_MIN_WIDTH;
        }
        if (view.classList.contains('view-editor')) {
            return ResizableViews.PRIMARY_MIN_WIDTH;
        }
        return ResizableViews.SECONDARY_MIN_WIDTH;
    }

    getTopRowReplacementFocusViewId(collapsedView: HTMLElement): string | null {
        return getClosestExpandedTopRowViewId(collapsedView.id);
    }

    /**
     * Get the minimum height for a view based on its type
     */
    getMinHeight(view: Element): number {
        if (view.classList.contains('view-editor')) {
            return ResizableViews.PRIMARY_MIN_HEIGHT;
        }
        if (
            view.classList.contains('view-fontinfo') ||
            view.classList.contains('view-overview')
        ) {
            return ResizableViews.FONTINFO_MIN_HEIGHT;
        }
        return ResizableViews.SECONDARY_MIN_HEIGHT;
    }

    /**
     * Update collapsed state classes based on current view dimensions
     * @param options.allowFocusShift - when false, skip focus reassignment (safe for startup)
     */
    updateCollapsedStates(options?: { allowFocusShift?: boolean }) {
        const allowFocusShift = options?.allowFocusShift !== false; // Default true
        const views = document.querySelectorAll('.view');
        let replacementFocusViewId: string | null = null;
        const currentFocusedView = window.getCurrentFocusedView
            ? window.getCurrentFocusedView()
            : null;

        views.forEach((view: Element) => {
            const viewEl = view as HTMLElement;
            if (viewEl.id === 'view-docs') {
                return;
            }

            const inTopRow = Boolean(viewEl.closest('.top-row'));
            const inBottomRow = Boolean(viewEl.closest('.bottom-row'));
            if (inBottomRow) {
                const row = viewEl.closest('.bottom-row') as HTMLElement;
                const isRowHeightCollapsed =
                    row.offsetHeight > 0 &&
                    row.offsetHeight <= ResizableViews.TITLE_BAR_HEIGHT + 5;
                viewEl.classList.remove('collapsed-width');
                viewEl.classList.toggle('collapsed', isRowHeightCollapsed);
                if (
                    allowFocusShift &&
                    isRowHeightCollapsed &&
                    viewEl.id === currentFocusedView
                ) {
                    replacementFocusViewId ||= 'view-editor';
                }
                return;
            }
            if (inTopRow) {
                const isWidthCollapsed = isViewWidthCollapsed(viewEl);
                const wasCollapsed =
                    viewEl.classList.contains('collapsed-width');
                viewEl.classList.toggle('collapsed-width', isWidthCollapsed);
                viewEl.classList.remove('collapsed');

                if (
                    allowFocusShift &&
                    isWidthCollapsed &&
                    !wasCollapsed &&
                    viewEl.id === currentFocusedView
                ) {
                    replacementFocusViewId ||=
                        this.getTopRowReplacementFocusViewId(viewEl);
                }
                return;
            }

            const rect = viewEl.getBoundingClientRect();
            const titleBarHeight = ResizableViews.TITLE_BAR_HEIGHT;
            const threshold = 5;
            const isHeightCollapsed = rect.height <= titleBarHeight + threshold;
            const wasCollapsed = viewEl.classList.contains('collapsed');
            viewEl.classList.toggle('collapsed', isHeightCollapsed);
            viewEl.classList.remove('collapsed-width');

            if (
                allowFocusShift &&
                isHeightCollapsed &&
                !wasCollapsed &&
                viewEl.id === currentFocusedView
            ) {
                replacementFocusViewId ||= 'view-editor';
            }
        });

        // Focus a still-expanded replacement if the currently focused view collapsed
        if (allowFocusShift && replacementFocusViewId && window.focusView) {
            window.focusView(replacementFocusViewId);
        }
    }

    /**
     * Pure layout helper: normalize top-row flex widths to current viewport.
     * Does NOT update collapsed-state classes or reassign focus.
     * Safe to call at startup without side effects on editor state.
     */
    normalizeTopRowWidths(): void {
        const topRow = document.querySelector('.top-row') as HTMLElement | null;
        if (topRow) {
            this.normalizeRowWidths(topRow);
        }
    }

    normalizeRowWidths(row: HTMLElement): void {
        if (row.classList.contains('bottom-row')) {
            return;
        }
        const views = getDirectRowViews(row);
        if (views.length === 0) {
            return;
        }

        const collapsedViews: HTMLElement[] = [];
        const openViews: Array<{ view: HTMLElement; width: number }> = [];

        for (const view of views) {
            if (isViewWidthCollapsed(view)) {
                collapsedViews.push(view);
                continue;
            }
            const width = view.getBoundingClientRect().width;
            if (width <= 0) {
                return;
            }
            openViews.push({ view, width });
        }

        if (openViews.length === 0) {
            return;
        }

        const rail = ResizableViews.FONTINFO_MIN_WIDTH;
        collapsedViews.forEach((view) => {
            view.style.flex = `0 0 ${rail}px`;
        });

        const availableWidth = row.offsetWidth - rail * collapsedViews.length;
        const totalOpenWidth = openViews.reduce(
            (sum, entry) => sum + entry.width,
            0
        );
        if (totalOpenWidth <= 0 || availableWidth <= 0) {
            return;
        }

        openViews.forEach(({ view, width }) => {
            const percent = Math.max(
                1,
                Math.round((width / totalOpenWidth) * 100)
            );
            view.style.flex = `${percent} 1 0%`;
        });
    }

    syncCollapsedStatesAfterLayoutRestore(): void {
        requestAnimationFrame(() => {
            this.updateCollapsedStates({ allowFocusShift: false });
        });
    }

    /**
     * Handle window resize: normalize top-row widths and update collapsed states.
     */
    handleWindowResize() {
        this.normalizeTopRowWidths();
        this.updateCollapsedStates();
    }

    init() {
        // Add event listeners for all dividers
        const verticalDividers = document.querySelectorAll('.vertical-divider');
        const horizontalDivider = document.querySelector(
            '.horizontal-divider'
        ) as HTMLElement | null;

        verticalDividers.forEach((divider: Element) => {
            const dividerEl = divider as HTMLElement;
            dividerEl.addEventListener('mousedown', (e: Event) =>
                this.startResize(e as MouseEvent, 'vertical')
            );
        });

        if (horizontalDivider) {
            horizontalDivider.addEventListener('mousedown', (e: Event) =>
                this.startResize(e as MouseEvent, 'horizontal')
            );
        }

        // Global mouse events
        document.addEventListener('mousemove', (e: MouseEvent) =>
            this.resize(e)
        );
        document.addEventListener('mouseup', () => this.stopResize());

        // Prevent text selection during resize
        document.addEventListener('selectstart', (e: Event) => {
            if (this.isResizing) {
                e.preventDefault();
            }
        });

        // Load saved layout after a short delay to ensure DOM is ready
        setTimeout(() => this.loadLayout(), 100);
    }

    loadLayout() {
        applyWindowUi();
    }

    applyDefaultLayout() {
        applyDefaultWindowUi();
    }

    saveLayout() {
        saveWindowUiFromDom();
    }

    startResize(e: MouseEvent, direction: 'vertical' | 'horizontal') {
        e.preventDefault();
        this.isResizing = true;
        this.currentDivider = e.target as HTMLElement;
        this.direction = direction;
        this.startX = e.clientX;
        this.startY = e.clientY;

        // Add active class for visual feedback
        this.currentDivider.classList.add('active');

        // Store initial dimensions
        if (direction === 'vertical') {
            this.storeVerticalDimensions();
        } else {
            this.storeHorizontalDimensions();
        }

        // Change cursor for the entire document
        document.body.style.cursor =
            direction === 'vertical' ? 'col-resize' : 'row-resize';
        document.body.style.userSelect = 'none';
    }

    storeVerticalDimensions() {
        if (this.currentDivider?.id === 'docs-divider') {
            const docsView = document.getElementById('view-docs');
            this.startWidths[0] = docsView?.offsetWidth || 0;
            return;
        }
        if (!this.currentDivider?.parentElement) {
            return;
        }
        const container = this.currentDivider.parentElement;
        const views = container.querySelectorAll(':scope > .view');

        views.forEach((view: Element, index: number) => {
            const viewEl = view as HTMLElement;
            const actualWidth = viewEl.offsetWidth;
            const minWidth = this.getMinWidth(viewEl);
            // If view is collapsed, lock to exact minimum width to prevent drift
            const isCollapsed = actualWidth <= minWidth + 5;
            this.startWidths[index] = isCollapsed ? minWidth : actualWidth;
        });
    }

    storeHorizontalDimensions() {
        const topRow = document.querySelector('.top-row') as HTMLElement | null;
        const bottomRow = document.querySelector(
            '.bottom-row'
        ) as HTMLElement | null;

        if (!topRow || !bottomRow) {
            return;
        }

        this.startHeights = {
            top: topRow.offsetHeight,
            bottom: bottomRow.offsetHeight
        };
    }

    resize(e: MouseEvent) {
        if (!this.isResizing) return;

        e.preventDefault();

        if (this.direction === 'vertical') {
            this.resizeVertical(e);
        } else {
            this.resizeHorizontal(e);
        }
    }

    resizeVertical(e: MouseEvent) {
        if (this.currentDivider?.id === 'docs-divider') {
            this.resizeDocsColumn(e);
            return;
        }
        const deltaX = e.clientX - this.startX;
        if (!this.currentDivider?.parentElement) {
            return;
        }
        const container = this.currentDivider.parentElement;
        const views = Array.from(
            container.querySelectorAll(':scope > .view')
        ) as HTMLElement[];
        const dividers = Array.from(
            container.querySelectorAll('.vertical-divider')
        );

        // Find which divider is being dragged
        const dividerIndex = dividers.indexOf(this.currentDivider);
        if (dividerIndex === -1) return;

        // Get the view to the left of the divider
        const leftView = views[dividerIndex];
        if (!leftView) return;

        // Get all views to the right
        const rightViews = views.slice(dividerIndex + 1);
        if (rightViews.length === 0) return;

        // Filter out collapsed views from the right side
        const nonCollapsedRightViews = rightViews.filter((view) => {
            const index = views.indexOf(view);
            const minWidth = this.getMinWidth(view);
            return this.startWidths[index] > minWidth + 5;
        });

        // Calculate current widths
        const leftStartWidth = this.startWidths[dividerIndex];
        let newLeftWidth = leftStartWidth + deltaX;

        // Check minimums
        const leftMinWidth = this.getMinWidth(leftView);

        // Snap to minimum if within 10 pixels
        const snapThreshold = 10;
        if (Math.abs(newLeftWidth - leftMinWidth) < snapThreshold) {
            newLeftWidth = leftMinWidth;
        }

        const widthChangeBeforeClamp = newLeftWidth - leftStartWidth;
        const isExpandingRightSide = widthChangeBeforeClamp < 0;

        if (!isExpandingRightSide && nonCollapsedRightViews.length === 0) {
            return;
        }

        // Clamp left width to the available slack on the right side
        let rightSlack = 0;
        nonCollapsedRightViews.forEach((view) => {
            const index = views.indexOf(view);
            rightSlack += this.startWidths[index] - this.getMinWidth(view);
        });

        const maxLeftWidth = leftStartWidth + rightSlack;
        if (newLeftWidth < leftMinWidth) {
            newLeftWidth = leftMinWidth;
        }
        if (newLeftWidth > maxLeftWidth) {
            newLeftWidth = maxLeftWidth;
        }

        // Calculate new widths
        const newWidths: Record<number, number> = {};

        // Set new left width (clamped to minimum)
        newWidths[dividerIndex] = newLeftWidth;

        // Recalculate right widths after clamping, keeping each view above its minimum
        const widthChange = newLeftWidth - leftStartWidth;
        const rightViewsToAdjust =
            widthChange >= 0 ? nonCollapsedRightViews : rightViews;

        if (rightViewsToAdjust.length > 0) {
            if (widthChange >= 0) {
                const totalSlack = nonCollapsedRightViews.reduce(
                    (sum, view) => {
                        const index = views.indexOf(view);
                        return (
                            sum +
                            (this.startWidths[index] - this.getMinWidth(view))
                        );
                    },
                    0
                );

                nonCollapsedRightViews.forEach((view) => {
                    const index = views.indexOf(view);
                    const minWidth = this.getMinWidth(view);
                    const viewSlack = this.startWidths[index] - minWidth;
                    const reduction =
                        totalSlack > 0
                            ? (viewSlack / totalSlack) * widthChange
                            : 0;
                    newWidths[index] = this.startWidths[index] - reduction;
                });
            } else {
                const expansion = Math.abs(widthChange);
                const totalStartWidth = rightViewsToAdjust.reduce(
                    (sum, view) => {
                        const index = views.indexOf(view);
                        return sum + this.startWidths[index];
                    },
                    0
                );

                rightViewsToAdjust.forEach((view) => {
                    const index = views.indexOf(view);
                    const proportion =
                        totalStartWidth > 0
                            ? this.startWidths[index] / totalStartWidth
                            : 1 / rightViewsToAdjust.length;
                    newWidths[index] =
                        this.startWidths[index] + expansion * proportion;
                });
            }

            rightViewsToAdjust.forEach((view) => {
                const index = views.indexOf(view);
                const minWidth = this.getMinWidth(view);
                if (newWidths[index] < minWidth) {
                    newWidths[index] = minWidth;
                }
            });
        }

        // Lock all other views to minimum width if collapsed, otherwise keep unchanged
        views.forEach((view, index) => {
            if (!(index in newWidths)) {
                const minWidth = this.getMinWidth(view);
                const isCollapsed = this.startWidths[index] <= minWidth + 5;
                newWidths[index] = isCollapsed
                    ? minWidth
                    : this.startWidths[index];
            }
        });

        // Calculate total width
        let totalWidth = 0;
        views.forEach((view, index) => {
            totalWidth += newWidths[index];
        });

        // Check if we're in the bottom row - only apply 1/6 ratio there
        const isBottomRow = container.classList.contains('bottom-row');
        const adjustedWidths = { ...newWidths };

        if (isBottomRow) {
            // Enforce 1/6 minimum ratio constraint per view in bottom row only
            const minRatio = 1 / 6;

            views.forEach((view, viewIndex) => {
                const viewWidth = adjustedWidths[viewIndex];
                const minRequiredWidth = totalWidth * minRatio;

                if (viewWidth < minRequiredWidth) {
                    // This view is below minimum, lock it at minimum ratio
                    adjustedWidths[viewIndex] = minRequiredWidth;

                    // Take the shortfall from other non-minimal views proportionally
                    const shortfall = minRequiredWidth - viewWidth;
                    const otherIndices: number[] = [];
                    let otherTotal = 0;

                    views.forEach((otherView, otherIndex) => {
                        if (otherIndex !== viewIndex) {
                            const otherWidth = adjustedWidths[otherIndex];
                            const otherMinWidth = totalWidth * minRatio;
                            // Only take from views that have room to give
                            if (otherWidth > otherMinWidth + 1) {
                                otherIndices.push(otherIndex);
                                otherTotal += otherWidth - otherMinWidth;
                            }
                        }
                    });

                    // Distribute the shortfall proportionally
                    if (otherTotal >= shortfall) {
                        otherIndices.forEach((otherIndex) => {
                            const available =
                                adjustedWidths[otherIndex] -
                                totalWidth * minRatio;
                            const reduction =
                                (available / otherTotal) * shortfall;
                            adjustedWidths[otherIndex] -= reduction;
                        });
                    } else {
                        // Can't satisfy constraint, reject this resize
                        return;
                    }
                }
            });
        }

        let shouldRestoreCollapsedEditorViewport = false;

        // Apply the adjusted widths - use fixed pixel width for collapsed views
        views.forEach((view, index) => {
            const minWidth = this.getMinWidth(view);
            if (adjustedWidths[index] <= minWidth + 5) {
                const isNewlyCollapsed = this.startWidths[index] > minWidth + 5;
                if (isNewlyCollapsed && view.id === 'view-editor') {
                    window.glyphCanvas?.freezeViewportForCollapse?.();
                }

                // Collapsed view - use fixed pixel width
                view.style.flex = `0 0 ${minWidth}px`;
            } else {
                const isNewlyExpanded = this.startWidths[index] <= minWidth + 5;
                if (isNewlyExpanded && view.id === 'view-editor') {
                    shouldRestoreCollapsedEditorViewport = true;
                }

                // Non-collapsed view - keep pixel-proportional flex weights so the row fully fills.
                view.style.flex = `${adjustedWidths[index]}`;
            }
        });

        // Update collapsed states
        this.updateCollapsedStates();

        if (shouldRestoreCollapsedEditorViewport) {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    window.glyphCanvas?.restoreViewportAfterCollapse?.();
                });
            });
        }
    }

    resizeHorizontal(e: MouseEvent) {
        const deltaY = e.clientY - this.startY;
        const topRow = document.querySelector('.top-row') as HTMLElement | null;
        const bottomRow = document.querySelector(
            '.bottom-row'
        ) as HTMLElement | null;

        if (!topRow || !bottomRow) {
            return;
        }

        const containerHeight = (
            document.querySelector('.container') as HTMLElement
        ).offsetHeight;
        const dividerHeight = 4; // Fixed divider height
        const availableHeight = containerHeight - dividerHeight;

        const topStartHeight = this.startHeights.top;
        const bottomStartHeight = this.startHeights.bottom;

        let newTopHeight = topStartHeight + deltaY;
        let newBottomHeight = bottomStartHeight - deltaY;

        // Calculate minimum heights based on views in each row
        // Top row contains fontinfo and editor - use editor's min height
        const topMinHeight = ResizableViews.PRIMARY_MIN_HEIGHT;
        // Bottom row contains secondary views - use title bar height
        const bottomMinHeight = ResizableViews.SECONDARY_MIN_HEIGHT;

        // Snap to minimum height if within 10 pixels (for bottom row collapse)
        const snapThreshold = 10;
        if (Math.abs(newBottomHeight - bottomMinHeight) < snapThreshold) {
            newBottomHeight = bottomMinHeight;
            newTopHeight = availableHeight - bottomMinHeight;
        }

        if (
            newTopHeight >= topMinHeight &&
            newBottomHeight >= bottomMinHeight
        ) {
            // Check if bottom row is collapsed (at or near minimum height)
            const isBottomCollapsed =
                Math.abs(newBottomHeight - bottomMinHeight) < 5;

            if (isBottomCollapsed) {
                // Use fixed pixel height for collapsed bottom row
                topRow.style.flex = `1`;
                bottomRow.style.flex = `0 0 ${bottomMinHeight}px`;
            } else {
                // Calculate flex-grow values based on the ratio of each row
                const totalHeight = newTopHeight + newBottomHeight;
                const topFlex = newTopHeight / totalHeight;
                const bottomFlex = newBottomHeight / totalHeight;

                topRow.style.flex = `${topFlex}`;
                bottomRow.style.flex = `${bottomFlex}`;
            }

            // Update collapsed states
            this.updateCollapsedStates();
        }
    }

    resizeDocsColumn(e: MouseEvent) {
        const docsView = document.getElementById('view-docs');
        const shell = document.getElementById('app-shell');
        if (!docsView || !shell || !this.currentDivider) {
            return;
        }

        const minDocs = ResizableViews.DOCS_MIN_WIDTH;
        const minWorkspace = ResizableViews.WORKSPACE_MIN_WIDTH;
        const maxDocs = Math.max(
            minDocs,
            shell.clientWidth - this.currentDivider.offsetWidth - minWorkspace
        );
        let newWidth = this.startWidths[0] + (e.clientX - this.startX);

        const snapThreshold = 10;
        if (Math.abs(newWidth - minDocs) < snapThreshold) {
            newWidth = minDocs;
        }
        if (newWidth < minDocs) {
            newWidth = minDocs;
        }
        if (newWidth > maxDocs) {
            newWidth = maxDocs;
        }

        docsView.style.flex = `0 0 ${newWidth}px`;
    }

    stopResize() {
        if (!this.isResizing) return;

        this.isResizing = false;

        if (this.currentDivider) {
            this.currentDivider.classList.remove('active');
            this.currentDivider = null;
        }

        // Reset cursor and selection
        document.body.style.cursor = 'default';
        document.body.style.userSelect = 'auto';

        // Final update of collapsed states
        this.updateCollapsedStates();
        this.saveLayout();

        window.restoreFocusedViewDomFocus?.();
    }
}

// Initialize the resizable views when the DOM is loaded
function initResizableViews() {
    console.log('[Resizer]', 'Initializing ResizableViews...');
    window.resizableViews = new ResizableViews();
    // collapsed states are updated after layout settles via applyDefaultLayout's own timer
    console.log('[Resizer]', 'ResizableViews initialized');
}

// Check if DOM is already loaded (in case script loads late)
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initResizableViews);
} else {
    // DOM already loaded, run immediately
    initResizableViews();
}

// Handle window resize to maintain proportions and collapsed states
window.addEventListener('resize', () => {
    if (window.resizableViews) {
        window.resizableViews.handleWindowResize();
    }
});
