import { Logger } from './logger';
const console = new Logger('ViewTitleButtons');

/**
 * View Title Bar Buttons
 * Adds maximize and collapse buttons to view title bars
 */

interface ViewInfo {
    id: string;
    shortcut: string;
    hasSecondaryBehavior: boolean;
}

const VIEW_CONFIGS: ViewInfo[] = [
    { id: 'view-fontinfo', shortcut: '⌘⇧I', hasSecondaryBehavior: true },
    { id: 'view-overview', shortcut: '⌘⇧O', hasSecondaryBehavior: true },
    { id: 'view-editor', shortcut: '⌘⇧E', hasSecondaryBehavior: true },
    { id: 'view-files', shortcut: '⌘⇧F', hasSecondaryBehavior: true },
    { id: 'view-history', shortcut: '⌘⇧H', hasSecondaryBehavior: true },
    { id: 'view-scripts', shortcut: '⌘⇧S', hasSecondaryBehavior: true },
    { id: 'view-console', shortcut: '⌘⇧K', hasSecondaryBehavior: true },
    { id: 'view-assistant', shortcut: '⌘⇧A', hasSecondaryBehavior: true }
];

/**
 * Check if a view is collapsed
 */
function isViewCollapsed(view: HTMLElement): boolean {
    return (
        view.classList.contains('collapsed') ||
        view.classList.contains('collapsed-width')
    );
}

/**
 * Check if a view is maximized (or near maximum size)
 * Uses the same thresholds as keyboard-navigation.js resizeView logic
 */
function isViewMaximized(viewId: string): boolean {
    const view = document.getElementById(viewId);
    if (!view) return false;

    const container = document.querySelector('.container') as HTMLElement;
    if (!container) return false;

    const settings = (window as any).VIEW_SETTINGS;
    if (!settings) return false;

    const shortcutConfig = settings.shortcuts[viewId];
    if (!shortcutConfig) return false;

    const containerWidth = container.offsetWidth;
    const containerHeight = container.offsetHeight;
    const horizontalDividerHeight = 4;
    const availableHeight = containerHeight - horizontalDividerHeight;

    const isTopRow = view.closest('.top-row') !== null;
    const isBottomRow = view.closest('.bottom-row') !== null;
    const TITLE_BAR_SIZE = 24;

    // For views with 'maximize' behavior (editor)
    if (shortcutConfig.secondaryBehavior === 'maximize') {
        if (isTopRow) {
            const topRow = view.closest('.top-row');
            const topRowViews = topRow
                ? Array.from(topRow.querySelectorAll('.view'))
                : [];
            const otherTopRowViews = topRowViews.filter((v) => v !== view);
            const totalOtherTitleBarWidth =
                TITLE_BAR_SIZE * otherTopRowViews.length;

            const maxWidth =
                (containerWidth - totalOtherTitleBarWidth) / containerWidth;
            const maxHeight =
                (availableHeight - TITLE_BAR_SIZE) / availableHeight;

            const currentWidthRatio = view.offsetWidth / containerWidth;
            const currentHeightRatio =
                (topRow as HTMLElement).offsetHeight / availableHeight;

            // Consider maximized if within 5% of max dimensions
            return (
                currentWidthRatio >= maxWidth - 0.05 &&
                currentHeightRatio >= maxHeight - 0.05
            );
        } else if (isBottomRow) {
            const bottomRow = view.closest('.bottom-row') as HTMLElement;
            const maxHeight =
                (availableHeight - TITLE_BAR_SIZE) / availableHeight;
            const currentHeightRatio = bottomRow.offsetHeight / availableHeight;

            return currentHeightRatio >= maxHeight - 0.05;
        }
    }
    // For views with 'expandToTarget' behavior
    else if (shortcutConfig.secondaryBehavior === 'expandToTarget') {
        if (viewId === 'view-fontinfo' || viewId === 'view-overview') {
            // Check if at or near secondary target width (50%)
            const config = settings.activation.fontinfo;
            const targetWidth = containerWidth * config.widthTargetSecondary;
            const currentWidth = view.offsetWidth;

            // Consider maximized if within 5% of target
            return currentWidth >= targetWidth - containerWidth * 0.05;
        } else if (isBottomRow) {
            // Check if at or near resize target dimensions
            const resizeConfig = settings.resize[viewId];
            if (!resizeConfig) return false;

            const bottomRow = view.closest('.bottom-row') as HTMLElement;
            const targetHeight = availableHeight * resizeConfig.height;
            const targetWidth = containerWidth * resizeConfig.width;
            const currentHeight = bottomRow.offsetHeight;
            const currentWidth = view.offsetWidth;

            // Consider maximized if within 5% of target dimensions
            return (
                currentHeight >= targetHeight - availableHeight * 0.05 &&
                currentWidth >= targetWidth - containerWidth * 0.05
            );
        }
    }

    return false;
}

/**
 * Update button visibility based on view state
 */
function updateButtonVisibility(viewId: string): void {
    const view = document.getElementById(viewId);
    if (!view) return;

    const maximizeBtn = view.querySelector(
        '.view-title-maximize-btn'
    ) as HTMLElement;
    const collapseBtn = view.querySelector(
        '.view-title-collapse-btn'
    ) as HTMLElement;

    // Need at least the maximize button to exist
    if (!maximizeBtn) return;

    const collapsed = isViewCollapsed(view);
    const maximized = isViewMaximized(viewId);

    // Maximize button: visible when NOT collapsed AND NOT maximized
    maximizeBtn.style.display = !collapsed && !maximized ? 'flex' : 'none';

    // Collapse button: always visible when NOT collapsed (if it exists)
    if (collapseBtn) {
        collapseBtn.style.display = !collapsed ? 'flex' : 'none';
    }
}

/**
 * Handle maximize button click
 */
function handleMaximizeClick(viewId: string): void {
    console.log('Maximize clicked for:', viewId);

    // Trigger the same behavior as pressing the view's keyboard shortcut a second time
    // This calls resizeView from keyboard-navigation.js
    if (window.resizeView) {
        window.resizeView(viewId);
    }
}

/**
 * Handle collapse button click
 */
function handleCollapseClick(viewId: string): void {
    console.log('Collapse clicked for:', viewId);

    // Trigger the same behavior as Cmd+Escape
    // This calls collapseActiveView from keyboard-navigation.js
    if (window.collapseActiveView) {
        window.collapseActiveView(viewId);
    }
}

/**
 * Create and add buttons to a view's title bar
 */
function addButtonsToView(viewConfig: ViewInfo): void {
    const view = document.getElementById(viewConfig.id);
    if (!view) {
        console.warn('View not found:', viewConfig.id);
        return;
    }

    const titleBar = view.querySelector('.view-title-bar');
    if (!titleBar) {
        console.warn('Title bar not found for:', viewConfig.id);
        return;
    }

    const titleLeft = titleBar.querySelector('.view-title-left') as HTMLElement;
    const titleHeading = titleBar.querySelector(
        '.view-title-heading'
    ) as HTMLElement;

    if (!titleLeft || !titleHeading) {
        console.warn('Title left/heading not found for:', viewConfig.id);
        return;
    }

    // Create (or reuse) container for window actions on the LEFT of title
    let titleWindowActions = titleBar.querySelector(
        '.view-title-window-actions'
    ) as HTMLElement;
    if (!titleWindowActions) {
        titleWindowActions = document.createElement('div');
        titleWindowActions.className = 'view-title-window-actions';
        titleLeft.insertBefore(titleWindowActions, titleHeading);
    }

    // Create maximize button
    const maximizeBtn = document.createElement('button');
    maximizeBtn.className = 'view-title-action-btn view-title-maximize-btn';
    maximizeBtn.title = `Maximize view (${viewConfig.shortcut})`;
    maximizeBtn.innerHTML = `<span class="material-symbols-outlined">open_in_full</span>`;
    maximizeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleMaximizeClick(viewConfig.id);
    });

    // Append buttons to left-side window actions
    // Skip collapse button for editor view
    if (viewConfig.id !== 'view-editor') {
        const collapseBtn = document.createElement('button');
        collapseBtn.className = 'view-title-action-btn view-title-collapse-btn';
        collapseBtn.title = 'Collapse view (⌘Escape)';
        collapseBtn.innerHTML = `<span class="material-symbols-outlined">close</span>`;
        collapseBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            handleCollapseClick(viewConfig.id);
        });
        titleWindowActions.appendChild(collapseBtn);
    }
    titleWindowActions.appendChild(maximizeBtn);

    // Update initial visibility
    updateButtonVisibility(viewConfig.id);

    console.log('Added buttons to:', viewConfig.id);
}

/**
 * Initialize title bar buttons for all views
 */
export function initViewTitleButtons(): void {
    console.log('Initializing view title buttons');

    VIEW_CONFIGS.forEach((viewConfig) => {
        addButtonsToView(viewConfig);
    });

    // Set up observers for view state changes
    setupStateObserver();

    console.log('View title buttons initialized');
}

/**
 * Set up mutation observer to watch for view state changes
 */
function setupStateObserver(): void {
    // Watch for class changes on views (collapsed, collapsed-width)
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (
                mutation.type === 'attributes' &&
                mutation.attributeName === 'class'
            ) {
                const target = mutation.target as HTMLElement;
                if (target.classList.contains('view') && target.id) {
                    updateButtonVisibility(target.id);
                }
            }
        });
    });

    // Observe all views
    VIEW_CONFIGS.forEach((viewConfig) => {
        const view = document.getElementById(viewConfig.id);
        if (view) {
            observer.observe(view, { attributes: true });
        }
    });

    // Also listen for resize events to update maximize button visibility
    let resizeTimeout: number | null = null;
    window.addEventListener('resize', () => {
        if (resizeTimeout) {
            clearTimeout(resizeTimeout);
        }
        resizeTimeout = window.setTimeout(() => {
            VIEW_CONFIGS.forEach((viewConfig) => {
                updateButtonVisibility(viewConfig.id);
            });
        }, 100);
    });

    // Listen for custom events from keyboard-navigation when views are resized
    window.addEventListener('viewResized', ((e: CustomEvent) => {
        const viewId = e.detail?.viewId;
        if (viewId) {
            updateButtonVisibility(viewId);
        }
    }) as EventListener);
}

/**
 * Update all button states (can be called externally)
 */
export function updateAllButtonStates(): void {
    VIEW_CONFIGS.forEach((viewConfig) => {
        updateButtonVisibility(viewConfig.id);
    });
}

// Expose updateButtonVisibility globally for other modules
(window as any).updateViewTitleButtonVisibility = updateButtonVisibility;
