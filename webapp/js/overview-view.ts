// Overview View
// Handles overview view initialization with sidebar and glyph overview
// Note: glyphOverviewFilterManager is loaded via glyph-overview.ts bundle
// and available on window.glyphOverviewFilterManager

function timelineSpanStartSafe(
    stage: string,
    detail?: Record<string, unknown>
) {
    if (window.timelineSpanStart) {
        return window.timelineSpanStart(stage, detail);
    }

    const startMark = `cp:${stage}:${Date.now()}:start`;
    performance.mark(startMark);
    return startMark;
}

function timelineSpanEndSafe(spanId: string) {
    if (window.timelineSpanEnd) {
        window.timelineSpanEnd(spanId);
        return;
    }

    const endMark = `${spanId.replace(':start', ':end')}`;
    performance.mark(endMark);
    performance.measure('cp:overview.fallback', spanId, endMark);
}

function waitForNextAnimationFrame() {
    return new Promise((resolve) => {
        requestAnimationFrame(() => resolve(undefined));
    });
}

console.log('[OverviewView]', 'overview-view.js loaded');

let glyphOverviewInstance: any = null;
let pendingInitialOpenSession: string | null = null;
let pendingInitialOpenStartedAt: number | null = null;
let initialRenderInProgress = false;
let queuedRenderRequest: {
    reason: string;
    openSessionId: string | null;
} | null = null;
let pendingFallbackAttempts = 0;
const maxFallbackAttempts = 4;

function buildGlyphData() {
    if (!window.currentFontModel?.glyphs) {
        return [];
    }

    return window.currentFontModel.glyphs.map((glyph: any, index: number) => ({
        id: String(index),
        name: glyph.name
    }));
}

async function updateOverviewTiles() {
    if (!glyphOverviewInstance) {
        return [];
    }

    const updateTilesSpanId = timelineSpanStartSafe('overview.updateTiles', {
        glyphCount: window.currentFontModel?.glyphs?.length || 0
    });
    const glyphData = buildGlyphData();
    try {
        await glyphOverviewInstance.updateGlyphs(glyphData);
    } finally {
        timelineSpanEndSafe(updateTilesSpanId);
    }
    return glyphData;
}

async function refreshFilterPlugins() {
    if (window.glyphOverviewFilterManager?.isLoaded()) {
        const refreshFiltersSpanId = timelineSpanStartSafe(
            'overview.refreshFilterPlugins'
        );
        try {
            await window.glyphOverviewFilterManager.refreshPlugins({
                deferCounts: true
            });
        } finally {
            timelineSpanEndSafe(refreshFiltersSpanId);
        }
    }
}

function scheduleFallbackRender(sessionId: string | null, delayMs = 1200) {
    if (!sessionId) {
        return;
    }

    setTimeout(async () => {
        if (
            pendingInitialOpenSession !== sessionId ||
            !glyphOverviewInstance ||
            initialRenderInProgress
        ) {
            return;
        }

        if (pendingFallbackAttempts >= maxFallbackAttempts) {
            return;
        }

        pendingFallbackAttempts += 1;
        const success = await renderOverviewAndEmit(
            `fontReady-fallback-${pendingFallbackAttempts}`,
            sessionId
        );

        if (success && pendingInitialOpenSession === sessionId) {
            pendingInitialOpenSession = null;
            pendingInitialOpenStartedAt = null;
            return;
        }

        if (pendingInitialOpenSession === sessionId) {
            scheduleFallbackRender(sessionId, 1500);
        }
    }, delayMs);
}

async function renderOverviewAndEmit(
    reason: string,
    openSessionId: string | null = null
) {
    if (!glyphOverviewInstance) {
        return false;
    }

    if (initialRenderInProgress) {
        queuedRenderRequest = { reason, openSessionId };
        return false;
    }

    initialRenderInProgress = true;
    const renderOverviewSpanId = timelineSpanStartSafe(
        'overview.renderAndEmit',
        {
            reason,
            openSessionId,
            glyphCount: window.currentFontModel?.glyphs?.length || 0
        }
    );
    const renderStart = performance.now();
    let success = false;

    try {
        await glyphOverviewInstance.renderGlyphOutlines();
        success = true;

        const renderDurationMs = performance.now() - renderStart;
        const totalElapsedMs =
            pendingInitialOpenStartedAt !== null
                ? performance.now() - pendingInitialOpenStartedAt
                : null;
        const glyphCount = window.currentFontModel?.glyphs?.length || 0;

        console.log(
            '[OverviewView]',
            `Overview rendered (${glyphCount} glyphs, reason: ${reason}, render: ${renderDurationMs.toFixed(2)}ms)`
        );

        void refreshFilterPlugins();

        // Capture deferred style/layout/paint work that lands after JS handlers
        // (common with very large tile counts).
        const settleSpanId = timelineSpanStartSafe(
            'overview.postMutationSettle',
            {
                reason,
                glyphCount
            }
        );
        await waitForNextAnimationFrame();
        await waitForNextAnimationFrame();
        timelineSpanEndSafe(settleSpanId);

        if (openSessionId) {
            window.dispatchEvent(
                new CustomEvent('overviewInitialRenderComplete', {
                    detail: {
                        openSessionId,
                        reason,
                        glyphCount,
                        renderDurationMs,
                        totalElapsedMs
                    }
                })
            );
        }
    } catch (error) {
        console.error('[OverviewView]', 'Failed to render glyphs:', error);
    } finally {
        timelineSpanEndSafe(renderOverviewSpanId);
        initialRenderInProgress = false;

        if (queuedRenderRequest) {
            const request = queuedRenderRequest;
            queuedRenderRequest = null;
            setTimeout(() => {
                void renderOverviewAndEmit(
                    request.reason,
                    request.openSessionId
                );
            }, 0);
        }
    }

    return success;
}

async function initOverviewView() {
    const overviewContent = document.querySelector(
        '#view-overview .view-content'
    ) as HTMLElement | null;
    if (overviewContent) {
        // Create main container with flexbox layout
        const mainContainer = document.createElement('div');
        mainContainer.style.display = 'flex';
        mainContainer.style.width = '100%';
        mainContainer.style.height = '100%';
        mainContainer.style.overflow = 'hidden';

        // Create left sidebar (uses consolidated sidebar styles)
        const leftSidebar = document.createElement('div');
        leftSidebar.id = 'overview-sidebar';
        leftSidebar.className = 'view-sidebar view-sidebar-left';
        leftSidebar.style.width = '200px';
        leftSidebar.style.height = '100%';
        leftSidebar.style.borderRight = '1px solid var(--border-primary)';
        leftSidebar.style.padding = '12px';
        leftSidebar.style.overflowY = 'auto';
        leftSidebar.style.display = 'flex';
        leftSidebar.style.flexDirection = 'column';
        leftSidebar.style.gap = '12px';
        leftSidebar.style.flexShrink = '0'; // Prevent sidebar from shrinking

        // Create filter sidebar container
        const filterSidebarContainer = document.createElement('div');
        filterSidebarContainer.id = 'overview-filters';
        leftSidebar.appendChild(filterSidebarContainer);

        // Create main content area with flex column layout
        const mainContent = document.createElement('div');
        mainContent.id = 'overview-main';
        mainContent.style.flex = '1';
        mainContent.style.height = '100%';
        mainContent.style.position = 'relative';
        mainContent.style.overflow = 'hidden';
        mainContent.style.display = 'flex';
        mainContent.style.flexDirection = 'column';

        // Create group legend container (hidden by default, shown when filter has groups)
        const groupLegendContainer = document.createElement('div');
        groupLegendContainer.id = 'overview-group-legend';
        groupLegendContainer.className = 'glyph-filter-legend';
        groupLegendContainer.style.display = 'none';
        mainContent.appendChild(groupLegendContainer);

        // Create glyph container that will hold the glyph overview
        const glyphContainer = document.createElement('div');
        glyphContainer.id = 'overview-glyph-container';
        glyphContainer.style.flex = '1';
        glyphContainer.style.overflow = 'hidden';
        glyphContainer.style.position = 'relative';
        mainContent.appendChild(glyphContainer);

        // Initialize glyph overview in the glyph container
        if (window.GlyphOverview) {
            glyphOverviewInstance = new window.GlyphOverview(glyphContainer);
            window.glyphOverviewInstance = glyphOverviewInstance;

            // Populate with current font glyphs if available
            if (window.currentFontModel?.glyphs) {
                const glyphData = await updateOverviewTiles();

                // Render glyphs if font is already compiled
                // (font needs to be cached in Rust via store_font before rendering)
                setTimeout(async () => {
                    await renderOverviewAndEmit('init');
                    console.log(
                        '[OverviewView]',
                        `Initial render: ${glyphData.length} glyph tiles`
                    );
                }, 500);
            }
        } else {
            console.warn(
                '[OverviewView]',
                'GlyphOverview class not available yet'
            );
        }

        // Initialize filter manager with sidebar and glyph overview
        if (glyphOverviewInstance && window.glyphOverviewFilterManager) {
            window.glyphOverviewFilterManager.initialize(
                filterSidebarContainer,
                glyphOverviewInstance,
                groupLegendContainer
            );
        }

        // Assemble layout (sidebar, main content)
        mainContainer.appendChild(leftSidebar);
        mainContainer.appendChild(mainContent);
        overviewContent.appendChild(mainContainer);

        // Observe when the overview view gains/loses focus (via 'focused' class)
        // CSS handles sidebar background color changes based on .view.focused
        const overviewView = document.querySelector('#view-overview');
        if (overviewView) {
            const updateCollapsedState = () => {
                const isCollapsed =
                    overviewView.classList.contains('collapsed-width');
                // Hide entire container when view is collapsed
                mainContainer.style.display = isCollapsed ? 'none' : 'flex';
            };

            const observer = new MutationObserver(
                (mutations: MutationRecord[]) => {
                    mutations.forEach((mutation: MutationRecord) => {
                        if (
                            mutation.type === 'attributes' &&
                            mutation.attributeName === 'class'
                        ) {
                            updateCollapsedState();
                        }
                    });
                }
            );
            observer.observe(overviewView, {
                attributes: true,
                attributeFilter: ['class']
            });

            // Set initial state
            updateCollapsedState();
        }

        console.log('[OverviewView]', 'Overview view initialized with sidebar');
    } else {
        setTimeout(initOverviewView, 100);
    }
}

// Update glyph overview when font is loaded
window.addEventListener('fontReady', async (event: Event) => {
    console.log('[OverviewView]', 'Font ready, updating glyph overview');

    const fontReadyOverviewSpanId = timelineSpanStartSafe(
        'overview.fontReadyHandler'
    );

    const detail =
        (event as CustomEvent<{ openSessionId?: string; openedAt?: number }>)
            .detail || {};
    pendingInitialOpenSession = detail.openSessionId || null;
    pendingInitialOpenStartedAt =
        typeof detail.openedAt === 'number' ? detail.openedAt : null;
    pendingFallbackAttempts = 0;

    // Wait a bit for currentFontModel to be set
    setTimeout(async () => {
        try {
            if (glyphOverviewInstance && window.currentFontModel?.glyphs) {
                const glyphData = await updateOverviewTiles();

                if (!pendingInitialOpenSession) {
                    await renderOverviewAndEmit('fontReady-no-session');
                } else {
                    scheduleFallbackRender(pendingInitialOpenSession, 1200);
                }

                console.log(
                    '[OverviewView]',
                    `Updated glyph overview tiles (${glyphData.length})`
                );
            }
        } finally {
            timelineSpanEndSafe(fontReadyOverviewSpanId);
        }
    }, 100);
});

window.addEventListener('fontOpenEditingCompiled', async (event: Event) => {
    const detail =
        (event as CustomEvent<{ openSessionId?: string }>).detail || {};
    const openSessionId = detail.openSessionId;

    if (!openSessionId || !pendingInitialOpenSession) {
        return;
    }

    if (openSessionId !== pendingInitialOpenSession) {
        return;
    }

    if (!glyphOverviewInstance || !window.currentFontModel?.glyphs) {
        return;
    }

    const success = await renderOverviewAndEmit(
        'editing-compile-ready',
        openSessionId
    );
    if (success && pendingInitialOpenSession === openSessionId) {
        pendingInitialOpenSession = null;
        pendingInitialOpenStartedAt = null;
    }
});

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOverviewView);
} else {
    initOverviewView();
}
