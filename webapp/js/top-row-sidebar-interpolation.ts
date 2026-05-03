const MIN_VIEW_WIDTH = 600;
const MAX_VIEW_WIDTH = 1200;
const MIN_SIDEBAR_WIDTH = 100;
const MAX_SIDEBAR_WIDTH = 200;

const handles = new WeakMap<HTMLElement, ResizeObserver>();

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function lerp(min: number, max: number, ratio: number): number {
    return min + (max - min) * ratio;
}

function applySidebarInterpolation(view: HTMLElement): void {
    const viewWidth = view.getBoundingClientRect().width;
    const ratio = clamp(
        (viewWidth - MIN_VIEW_WIDTH) / (MAX_VIEW_WIDTH - MIN_VIEW_WIDTH),
        0,
        1
    );

    const sidebarWidth = lerp(MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, ratio);
    const sidebarPadding = lerp(8, 12, ratio);
    const sidebarGap = lerp(8, 12, ratio);
    const sectionTitleMarginTop = lerp(4, 6, ratio);
    const itemInlinePadding = lerp(8, 12, ratio);
    const itemBlockPadding = lerp(4, 5, ratio);
    const filterTreeInset = lerp(6, 9, ratio);
    const filterNodeHeaderInlinePadding = lerp(3, 4, ratio);
    const filterNodeHeaderBlockPadding = lerp(2, 3, ratio);
    const filterNodeIndentStep = lerp(6, 8, ratio);
    const filterItemInlinePadding = lerp(4, 6, ratio);
    const filterItemBlockPadding = lerp(2, 3, ratio);
    const filterItemBaseIndent = lerp(6, 8, ratio);
    const filterItemIndentStep = lerp(3, 4, ratio);
    const filterCountInlinePadding = lerp(4, 5, ratio);
    const filterCountMinWidth = lerp(16, 20, ratio);
    const fontInfoControlInlinePadding = lerp(8, 12, ratio);
    const fontInfoControlBlockPadding = lerp(4, 6, ratio);

    view.style.setProperty('--top-row-sidebar-width', `${sidebarWidth}px`);
    view.style.setProperty('--top-row-sidebar-padding', `${sidebarPadding}px`);
    view.style.setProperty('--top-row-sidebar-gap', `${sidebarGap}px`);
    view.style.setProperty(
        '--top-row-sidebar-list-bleed',
        `${sidebarPadding}px`
    );
    view.style.setProperty(
        '--top-row-sidebar-section-title-margin-top',
        `${sectionTitleMarginTop}px`
    );
    view.style.setProperty(
        '--top-row-sidebar-item-inline-padding',
        `${itemInlinePadding}px`
    );
    view.style.setProperty(
        '--top-row-sidebar-item-block-padding',
        `${itemBlockPadding}px`
    );
    view.style.setProperty(
        '--top-row-overview-filter-tree-inset',
        `${filterTreeInset}px`
    );
    view.style.setProperty(
        '--top-row-overview-filter-node-header-inline-padding',
        `${filterNodeHeaderInlinePadding}px`
    );
    view.style.setProperty(
        '--top-row-overview-filter-node-header-block-padding',
        `${filterNodeHeaderBlockPadding}px`
    );
    view.style.setProperty(
        '--top-row-overview-filter-node-indent-step',
        `${filterNodeIndentStep}px`
    );
    view.style.setProperty(
        '--top-row-overview-filter-item-inline-padding',
        `${filterItemInlinePadding}px`
    );
    view.style.setProperty(
        '--top-row-overview-filter-item-block-padding',
        `${filterItemBlockPadding}px`
    );
    view.style.setProperty(
        '--top-row-overview-filter-item-base-indent',
        `${filterItemBaseIndent}px`
    );
    view.style.setProperty(
        '--top-row-overview-filter-item-indent-step',
        `${filterItemIndentStep}px`
    );
    view.style.setProperty(
        '--top-row-overview-filter-count-inline-padding',
        `${filterCountInlinePadding}px`
    );
    view.style.setProperty(
        '--top-row-overview-filter-count-min-width',
        `${filterCountMinWidth}px`
    );
    view.style.setProperty(
        '--top-row-fontinfo-control-inline-padding',
        `${fontInfoControlInlinePadding}px`
    );
    view.style.setProperty(
        '--top-row-fontinfo-control-block-padding',
        `${fontInfoControlBlockPadding}px`
    );
}

export function attachTopRowSidebarInterpolation(
    viewOrId: HTMLElement | string
): void {
    const view =
        typeof viewOrId === 'string'
            ? (document.getElementById(viewOrId) as HTMLElement | null)
            : viewOrId;

    if (!view || handles.has(view)) {
        return;
    }

    applySidebarInterpolation(view);

    const observer = new ResizeObserver(() => {
        applySidebarInterpolation(view);
    });

    observer.observe(view);
    handles.set(view, observer);
}