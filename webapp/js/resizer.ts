console.log('[Resizer]', 'resizer.js loaded');

type RowVisitOrder = {
    top: string[];
    bottom: string[];
};

type SavedViewLayout = {
    horizontal?: { top: string; bottom: string };
    vertical?: { top?: string[]; bottom?: string[] };
    visitOrder?: Partial<RowVisitOrder>;
};

class ResizableViews {
    // Minimum sizes for different view types
    static TITLE_BAR_HEIGHT = 24;
    static PRIMARY_MIN_WIDTH = 200;
    static PRIMARY_MIN_HEIGHT = 200;
    static SECONDARY_MIN_WIDTH = 100;
    static SECONDARY_MIN_HEIGHT = 24; // Title bar only
    static FONTINFO_MIN_WIDTH = 24; // Title bar width when rotated
    static FONTINFO_MIN_HEIGHT = 100;

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
        if ((view as HTMLElement).closest('.top-row')) {
            return ResizableViews.FONTINFO_MIN_WIDTH;
        }
        if (view.classList.contains('view-editor')) {
            return ResizableViews.PRIMARY_MIN_WIDTH;
        }
        return ResizableViews.SECONDARY_MIN_WIDTH;
    }

    getTopRowReplacementFocusViewId(collapsedView: HTMLElement): string | null {
        const topRow = collapsedView.closest('.top-row');
        if (!topRow) {
            return null;
        }

        const threshold = 5;
        const siblings = Array.from(topRow.querySelectorAll('.view')).filter(
            (view): view is HTMLElement => view instanceof HTMLElement
        );
        const expandedSiblings = siblings.filter((view) => {
            if (view.id === collapsedView.id) {
                return false;
            }

            return (
                view.getBoundingClientRect().width >
                this.getMinWidth(view) + threshold
            );
        });

        if (expandedSiblings.length === 0) {
            return null;
        }

        const editorSibling = expandedSiblings.find(
            (view) => view.id === 'view-editor'
        );
        return editorSibling?.id || expandedSiblings[0].id;
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
            const rect = viewEl.getBoundingClientRect();
            const titleBarHeight = ResizableViews.TITLE_BAR_HEIGHT;
            const threshold = 5; // Tolerance for float comparison

            if (viewEl.closest('.top-row')) {
                // Top-row views collapse by width
                const isWidthCollapsed =
                    rect.width <= this.getMinWidth(viewEl) + threshold;
                const wasCollapsed =
                    viewEl.classList.contains('collapsed-width');
                viewEl.classList.toggle('collapsed-width', isWidthCollapsed);
                viewEl.classList.remove('collapsed');

                // If this view just became collapsed and it was the focused view, move focus to an expanded sibling
                if (
                    allowFocusShift &&
                    isWidthCollapsed &&
                    !wasCollapsed &&
                    viewEl.id === currentFocusedView
                ) {
                    replacementFocusViewId ||=
                        this.getTopRowReplacementFocusViewId(viewEl);
                }
            } else {
                // Other secondary views collapse by height
                const isHeightCollapsed =
                    rect.height <= titleBarHeight + threshold;
                const wasCollapsed = viewEl.classList.contains('collapsed');
                viewEl.classList.toggle('collapsed', isHeightCollapsed);
                viewEl.classList.remove('collapsed-width');

                // If this view just became collapsed and it was the focused view, mark to focus editor
                if (
                    allowFocusShift &&
                    isHeightCollapsed &&
                    !wasCollapsed &&
                    viewEl.id === currentFocusedView
                ) {
                    replacementFocusViewId ||= 'view-editor';
                }
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
        if (!topRow) {
            return;
        }

        const views = Array.from(
            topRow.querySelectorAll('.view')
        ) as HTMLElement[];
        const threshold = 5;

        let totalFixedWidth = 0;
        const collapsedViews: Array<{ view: HTMLElement; width: number }> = [];
        const nonCollapsedViews: Array<{
            view: HTMLElement;
            width: number;
        }> = [];

        // Identify collapsed and non-collapsed views
        views.forEach((view) => {
            const rect = view.getBoundingClientRect();
            const minWidth = this.getMinWidth(view);
            const isCollapsed = rect.width <= minWidth + threshold;

            if (isCollapsed) {
                collapsedViews.push({ view, width: minWidth });
                totalFixedWidth += minWidth;
            } else {
                nonCollapsedViews.push({ view, width: rect.width });
            }
        });

        if (nonCollapsedViews.length > 0) {
            // Lock collapsed views to fixed width (if any)
            collapsedViews.forEach(({ view, width }) => {
                view.style.flex = `0 0 ${width}px`;
            });

            // Set non-collapsed views to flexible with proper proportions
            const containerWidth = topRow.offsetWidth;
            const availableWidth = containerWidth - totalFixedWidth;

            let totalNonCollapsedWidth = 0;
            nonCollapsedViews.forEach(({ width }) => {
                totalNonCollapsedWidth += width;
            });

            nonCollapsedViews.forEach(({ view, width }) => {
                const proportion = width / totalNonCollapsedWidth;
                const targetWidth = availableWidth * proportion;
                view.style.flex = `${targetWidth}`;
            });
        }
    }

    /**
     * Handle window resize: normalize top-row widths and update collapsed states.
     */
    handleWindowResize() {
        // Normalize top-row flex widths to current viewport
        this.normalizeTopRowWidths();

        // Process bottom row (horizontal layout)
        const bottomRow = document.querySelector(
            '.bottom-row'
        ) as HTMLElement | null;
        if (bottomRow) {
            const views = Array.from(
                bottomRow.querySelectorAll('.view')
            ) as HTMLElement[];
            const threshold = 5;

            let totalFixedHeight = 0;
            const collapsedViews: Array<{ view: HTMLElement; height: number }> =
                [];
            const nonCollapsedViews: Array<{
                view: HTMLElement;
                height: number;
            }> = [];

            // Identify collapsed and non-collapsed views
            views.forEach((view) => {
                const rect = view.getBoundingClientRect();
                const minHeight = this.getMinHeight(view);
                const isCollapsed = rect.height <= minHeight + threshold;

                if (isCollapsed) {
                    collapsedViews.push({ view, height: minHeight });
                    totalFixedHeight += minHeight;
                } else {
                    nonCollapsedViews.push({ view, height: rect.height });
                }
            });

            // For bottom row, we mainly care about horizontal resizing, not vertical
            // So we don't need to lock heights, just update collapsed states
        }

        // Update collapsed state classes
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
        try {
            const saved = localStorage.getItem('viewLayout');
            if (!saved) {
                console.log(
                    '[Resizer]',
                    'No saved view layout found - applying defaults'
                );
                this.applyDefaultLayout();
                return;
            }

            const layout = JSON.parse(saved) as SavedViewLayout;
            console.log('[Resizer]', 'Loading view layout:', layout);

            // Apply horizontal layout
            if (layout.horizontal) {
                const topRow = document.querySelector(
                    '.top-row'
                ) as HTMLElement | null;
                const bottomRow = document.querySelector(
                    '.bottom-row'
                ) as HTMLElement | null;
                if (topRow && bottomRow) {
                    // Check if bottom row should be collapsed
                    const savedBottomFlex = layout.horizontal.bottom;
                    if (!savedBottomFlex.includes('0 0')) {
                        const flexValue = parseFloat(savedBottomFlex);
                        // If bottom row flex is very small, it's collapsed - use fixed pixel height
                        if (flexValue < 0.1) {
                            bottomRow.style.flex = `0 0 ${ResizableViews.SECONDARY_MIN_HEIGHT}px`;
                            topRow.style.flex = `1`;
                        } else {
                            topRow.style.flex = layout.horizontal.top;
                            bottomRow.style.flex = layout.horizontal.bottom;
                        }
                    } else {
                        topRow.style.flex = layout.horizontal.top;
                        bottomRow.style.flex = layout.horizontal.bottom;
                    }
                    console.log('[Resizer]', 'Applied horizontal layout');
                }
            }

            // Apply vertical layouts
            if (layout.vertical) {
                if (layout.vertical.top) {
                    const topLayout = layout.vertical.top;
                    const topRow = document.querySelector(
                        '.top-row'
                    ) as HTMLElement | null;
                    const topViews = topRow?.querySelectorAll('.view');
                    topViews?.forEach((view: Element, index: number) => {
                        const viewEl = view as HTMLElement;
                        if (topLayout[index] !== undefined) {
                            const savedFlex = topLayout[index];
                            // Check if this is a fontinfo/overview view that should be collapsed
                            if (
                                (viewEl.classList.contains('view-fontinfo') ||
                                    viewEl.classList.contains(
                                        'view-overview'
                                    )) &&
                                !savedFlex.includes('0 0')
                            ) {
                                // Convert old flex ratio to fixed pixel width if it's very small (collapsed)
                                const flexValue = parseFloat(savedFlex);
                                if (flexValue < 0.05) {
                                    viewEl.style.flex = `0 0 24px`;
                                } else {
                                    viewEl.style.flex = savedFlex;
                                }
                            } else {
                                viewEl.style.flex = savedFlex;
                            }
                        }
                    });
                    console.log(
                        '[Resizer]',
                        `Applied ${topViews?.length} top view layouts`
                    );
                }

                if (layout.vertical.bottom) {
                    const bottomLayout = layout.vertical.bottom;
                    const bottomRow = document.querySelector(
                        '.bottom-row'
                    ) as HTMLElement | null;
                    const bottomViews = bottomRow?.querySelectorAll('.view');
                    bottomViews?.forEach((view: Element, index: number) => {
                        const viewEl = view as HTMLElement;
                        if (bottomLayout[index] !== undefined) {
                            viewEl.style.flex = bottomLayout[index];
                        }
                    });
                    console.log(
                        '[Resizer]',
                        `Applied ${bottomViews?.length} bottom view layouts`
                    );
                }
            }

            if (layout.visitOrder && window.setViewVisitOrder) {
                window.setViewVisitOrder(layout.visitOrder);
            }

            // Normalize flex values to current viewport after restoring saved layout.
            // Saved layouts may contain stale pixel values from a different window size.
            this.normalizeTopRowWidths();

            console.log(
                '[Resizer]',
                '✅ View layout restored from localStorage'
            );
        } catch (e) {
            console.warn('[Resizer]', 'Failed to load view layout:', e);
        }
    }

    applyDefaultLayout() {
        console.log('[Resizer]', 'Applying default view layout');

        const topRow = document.querySelector('.top-row') as HTMLElement | null;
        const topViews = topRow?.querySelectorAll('.view') as
            | NodeListOf<HTMLElement>
            | undefined;

        if (topViews && topViews.length === 3) {
            // fontinfo: collapsed (24px), overview: 35%, editor: 65%
            // Use fixed pixel width for collapsed fontinfo
            topViews[0].style.flex = `0 0 24px`; // fontinfo - collapsed
            topViews[1].style.flex = `0.35`; // overview
            topViews[2].style.flex = `0.65`; // editor

            console.log(
                '[Resizer]',
                'Applied default top row layout: fontinfo collapsed, overview 35%, editor 65%'
            );
        }

        // Update collapsed states to reflect the collapsed fontinfo
        setTimeout(() => {
            this.normalizeTopRowWidths();
        }, 100);
    }

    saveLayout() {
        try {
            const topRow = document.querySelector(
                '.top-row'
            ) as HTMLElement | null;
            const bottomRow = document.querySelector(
                '.bottom-row'
            ) as HTMLElement | null;

            const layout: SavedViewLayout = {
                horizontal: {
                    top: topRow?.style.flex || '1',
                    bottom: bottomRow?.style.flex || '1'
                },
                vertical: {
                    top: [],
                    bottom: []
                },
                visitOrder: window.getViewVisitOrder
                    ? window.getViewVisitOrder()
                    : undefined
            };
            const topLayout = layout.vertical?.top;
            const bottomLayout = layout.vertical?.bottom;

            // Save top row views
            const topViews = topRow?.querySelectorAll('.view');
            if (topLayout) {
                topViews?.forEach((view: Element) => {
                    topLayout.push((view as HTMLElement).style.flex || '1');
                });
            }

            // Save bottom row views
            const bottomViews = bottomRow?.querySelectorAll('.view');
            if (bottomLayout) {
                bottomViews?.forEach((view: Element) => {
                    bottomLayout.push((view as HTMLElement).style.flex || '1');
                });
            }

            localStorage.setItem('viewLayout', JSON.stringify(layout));
        } catch (e) {
            console.warn('[Resizer]', 'Failed to save view layout:', e);
        }
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
        if (!this.currentDivider?.parentElement) {
            return;
        }
        const container = this.currentDivider.parentElement;
        const views = container.querySelectorAll('.view');

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
        const deltaX = e.clientX - this.startX;
        if (!this.currentDivider?.parentElement) {
            return;
        }
        const container = this.currentDivider.parentElement;
        const views = Array.from(
            container.querySelectorAll('.view')
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

        // Save layout after resize
        this.saveLayout();
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
