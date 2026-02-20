// Overview View
// Handles overview view initialization with sidebar and glyph overview
// Note: glyphOverviewFilterManager is loaded via glyph-overview.ts bundle
// and available on window.glyphOverviewFilterManager

console.log('[OverviewView]', 'overview-view.js loaded');

let glyphOverviewInstance = null;
let pendingInitialOpenSession = null;
let pendingInitialOpenStartedAt = null;
let initialRenderInProgress = false;

function buildGlyphData() {
    if (!window.currentFontModel?.glyphs) {
        return [];
    }

    return window.currentFontModel.glyphs.map((glyph, index) => ({
        id: String(index),
        name: glyph.name
    }));
}

function updateOverviewTiles() {
    if (!glyphOverviewInstance) {
        return [];
    }

    const glyphData = buildGlyphData();
    glyphOverviewInstance.updateGlyphs(glyphData);
    return glyphData;
}

async function refreshFilterPlugins() {
    if (window.glyphOverviewFilterManager?.isLoaded()) {
        await window.glyphOverviewFilterManager.refreshPlugins();
    }
}

async function renderOverviewAndEmit(reason, openSessionId = null) {
    if (!glyphOverviewInstance) {
        return;
    }

    if (initialRenderInProgress) {
        return;
    }

    initialRenderInProgress = true;
    const renderStart = performance.now();

    try {
        await glyphOverviewInstance.renderGlyphOutlines();

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

        await refreshFilterPlugins();

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
        initialRenderInProgress = false;
    }
}

function initOverviewView() {
    const overviewContent = document.querySelector(
        '#view-overview .view-content'
    );
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

            // Populate with current font glyphs if available
            if (window.currentFontModel?.glyphs) {
                const glyphData = updateOverviewTiles();

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

            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (
                        mutation.type === 'attributes' &&
                        mutation.attributeName === 'class'
                    ) {
                        updateCollapsedState();
                    }
                });
            });
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
window.addEventListener('fontReady', async (event) => {
    console.log('[OverviewView]', 'Font ready, updating glyph overview');

    const detail = event?.detail || {};
    pendingInitialOpenSession = detail.openSessionId || null;
    pendingInitialOpenStartedAt =
        typeof detail.openedAt === 'number' ? detail.openedAt : null;

    // Wait a bit for currentFontModel to be set
    setTimeout(async () => {
        if (glyphOverviewInstance && window.currentFontModel?.glyphs) {
            const glyphData = updateOverviewTiles();

            if (!pendingInitialOpenSession) {
                await renderOverviewAndEmit('fontReady-no-session');
            }

            console.log(
                '[OverviewView]',
                `Updated glyph overview tiles (${glyphData.length})`
            );
        }
    }, 100);
});

window.addEventListener('fontOpenEditingCompiled', async (event) => {
    const detail = event?.detail || {};
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

    await renderOverviewAndEmit('editing-compile-ready', openSessionId);
    pendingInitialOpenSession = null;
    pendingInitialOpenStartedAt = null;
});

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOverviewView);
} else {
    initOverviewView();
}
