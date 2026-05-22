// Glyph Overview
// Displays grid of glyph tiles with selection support
// Uses direct canvas rendering for fast display

import { fastGlyphTileRenderer } from './glyph-tile-renderer-fast';
// Import filter manager to bundle it with glyph-overview entry point
// It self-registers on window.glyphOverviewFilterManager
import './glyph-overview-filters';
import { Logger } from './logger';
import { timelineSpanStart, timelineSpanEnd } from './perf-timeline';

const console = new Logger('GlyphOverview');

// Use the shared fontCompilation instance from window (set by bootstrap)
// Do NOT import from './font-compilation' as this is a separate webpack entry point
// and would create a separate worker instance with its own cache
declare const window: Window & { fontCompilation?: any };

interface GlyphTile {
    element: HTMLDivElement;
    glyphId: string;
    glyphName: string;
    selected: boolean;
    cachedData?: any; // Cached glyph outline data for resizing
    canvas?: HTMLCanvasElement; // Reusable canvas element
    filterColor?: string; // Primary background overlay color from active filter
    filterColors?: string[]; // All unique colors for multi-group display
}

/**
 * Filter result from glyph filter plugins
 */
export interface FilterResult {
    glyph_name: string;
    group?: string; // Single group keyword
    groups?: string[]; // Array of group keywords for multi-group support
    color?: string; // Primary color for display
    colors?: string[]; // All colors for multi-group
}

type OverviewViewMode = 'lines' | 'grid';

interface GridNameParts {
    baseName: string;
    variantSuffix: string;
}

interface GridLayoutData {
    columns: string[];
    rows: Array<Array<string | null>>;
    visibleIds: string[];
}

type ResizeFocusAnchor =
    | {
          type: 'selection';
          glyphIds: string[];
      }
    | {
          type: 'active';
          glyphName: string;
      };

class GlyphOverview {
    private container: HTMLDivElement | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private resizeSyncRafId: number | null = null;
    private lastContainerWidth = 0;
    private tiles: Map<string, GlyphTile> = new Map();
    private isDragging = false;
    private hasDragged = false;
    private dragStartX = 0;
    private dragStartY = 0;
    private selectionBox: HTMLDivElement | null = null;
    private currentLocation: Record<string, number> = {};
    private intersectionObserver: IntersectionObserver | null = null;
    private lazyLoadEnabled: boolean = false;
    // Batched lazy loading
    private pendingGlyphIds: Set<string> = new Set();
    private batchDebounceTimer: number | null = null;
    private isBatchRendering: boolean = false;
    private tileBuildRunId = 0;
    private tileBuildPromise: Promise<void> = Promise.resolve();
    private tileBuildResolve: (() => void) | null = null;
    private deferredTileBuildTimer: number | null = null;
    private linesVirtualizationActive = false;
    private virtualizedRenderRafPending = false;
    private scrollVisibilitySyncRafId: number | null = null;
    private virtualizedRenderRange: { start: number; end: number } | null =
        null;
    private readonly linesVirtualizationThreshold = 1200;
    private readonly linesVirtualizationBufferRows = 6;
    private onContainerScrollBound = this.onContainerScroll.bind(this);
    private onCapturedScrollBound = this.onCapturedScroll.bind(this);
    private lazyBatchSize = 240;
    private readonly minLazyBatchSize = 80;
    private readonly maxLazyBatchSize = 500;
    private updateGlyphsSpanId: string | null = null;
    // Cached metrics for tile rendering
    private renderMetrics: {
        ascender: number;
        descender: number;
        upm: number;
    } | null = null;
    // Currently highlighted editing glyph
    private highlightedGlyphName: string | null = null;
    private highlightScrollSyncRafId: number | null = null;
    private highlightScrollSyncAttempts = 0;
    private readonly maxHighlightScrollSyncAttempts = 8;
    private pendingChangedGlyphNames: Set<string> = new Set();
    private pendingChangedGlyphRefreshTimer: number | null = null;
    private readonly deferredGlyphRefreshDelayMs = 16;
    private readonly activeDragGlyphRefreshDelayMs = 120;
    // Tile size control
    private currentSizeStep: number = 2; // Default to middle (step 2 of 11)
    private sizeSlider: HTMLInputElement | null = null;
    // Search control
    private searchInput: HTMLInputElement | null = null;
    private searchTerms: string[] = [];
    // View mode control
    private viewMode: OverviewViewMode = 'lines';
    private linesModeButton: HTMLButtonElement | null = null;
    private gridModeButton: HTMLButtonElement | null = null;
    private visibleGlyphIds: string[] = [];
    private glyphOrderIds: string[] = [];
    private glyphDataById: Map<string, { id: string; name: string }> =
        new Map();
    private totalGlyphDatasetCount = 0;
    private gridRowsForNavigation: Array<Array<string | null>> = [];
    private gridColumnCount = 0;
    private readonly viewModeStorageKey = 'glyphOverviewViewMode';
    // Active filter
    private activeFilterResults: Map<string, FilterResult> | null = null;
    // Error overlay for filter errors
    private errorOverlay: HTMLDivElement | null = null;
    // Track the last glyph clicked by mouse (for keyboard navigation reference)
    private lastClickedGlyphId: string | null = null;
    // Track anchor point for shift+keyboard selection
    private keyboardAnchorGlyphId: string | null = null;
    // Snapshot of selection before last plain single-click (used to restore on double-click)
    private preDoubleClickSelectionGlyphIds: string[] = [];
    private preDoubleClickGlyphId: string | null = null;
    private preDoubleClickTimestamp = 0;

    constructor(parentElement: HTMLElement) {
        this.init(parentElement);
        this.initSizeControl();
        this.initSearchControl();
        this.initViewModeControl();
    }

    private init(parentElement: HTMLElement): void {
        // Create main container for glyph tiles
        this.container = document.createElement('div');
        this.container.id = 'glyph-overview-container';

        parentElement.appendChild(this.container);
        this.setupResizeObserver();

        // Set up mouse event listeners for drag selection
        this.container.addEventListener(
            'mousedown',
            this.onMouseDown.bind(this)
        );
        document.addEventListener('mousemove', this.onMouseMove.bind(this));
        document.addEventListener('mouseup', this.onMouseUp.bind(this));

        // Listen for glyph changes to update tiles
        window.addEventListener('glyphChanged', this.onGlyphChanged.bind(this));

        // Listen for glyph stack changes to update highlight immediately
        window.addEventListener(
            'glyphStackChanged',
            this.onGlyphStackChanged.bind(this)
        );

        // Listen for mode changes to clear border when switching to text mode
        window.addEventListener(
            'editorModeChanged',
            this.onModeChanged.bind(this)
        );
        window.addEventListener('scroll', this.onCapturedScrollBound, {
            capture: true,
            passive: true
        });

        // Listen for variation location changes to re-render tiles
        window.addEventListener('variationLocationChanged', ((
            e: CustomEvent
        ) => {
            void this.renderGlyphOutlines(e.detail.location);
        }) as EventListener);

        // Listen for theme changes to re-render tiles
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (
                    mutation.type === 'attributes' &&
                    mutation.attributeName === 'data-theme'
                ) {
                    this.onThemeChanged();
                }
            });
        });
        observer.observe(document.documentElement, { attributes: true });
    }

    private setupResizeObserver(): void {
        if (!this.container) {
            return;
        }

        this.lastContainerWidth = this.container.clientWidth;
        this.resizeObserver = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry || !this.container) {
                return;
            }

            const nextWidth = Math.round(entry.contentRect.width);
            if (nextWidth <= 0 || nextWidth === this.lastContainerWidth) {
                return;
            }

            this.lastContainerWidth = nextWidth;
            this.scheduleResizeFocusSync();
        });
        this.resizeObserver.observe(this.container);
    }

    private scheduleResizeFocusSync(): void {
        if (this.resizeSyncRafId !== null) {
            cancelAnimationFrame(this.resizeSyncRafId);
        }

        this.resizeSyncRafId = requestAnimationFrame(() => {
            this.resizeSyncRafId = null;

            if (this.linesVirtualizationActive) {
                this.renderVirtualizedLinesWindow(true);
            }

            this.applyResizeFocusAnchor(this.getResizeFocusAnchor());
        });
    }

    private initSizeControl(): void {
        // Load saved size from localStorage
        const savedSize = localStorage.getItem('glyphOverviewSize');
        if (savedSize !== null) {
            const parsedSize = parseInt(savedSize, 10);
            if (!isNaN(parsedSize) && parsedSize >= 0 && parsedSize <= 10) {
                this.currentSizeStep = parsedSize;
            }
        }

        // Find slider in DOM
        this.sizeSlider = document.getElementById(
            'overview-size-slider'
        ) as HTMLInputElement;
        if (this.sizeSlider) {
            this.sizeSlider.value = String(this.currentSizeStep);
            this.updateSliderProgress();

            // Listen for size changes
            this.sizeSlider.addEventListener('input', (e) => {
                const newSize = parseInt(
                    (e.target as HTMLInputElement).value,
                    10
                );
                this.currentSizeStep = newSize;
                this.updateSliderProgress();
                this.updateTileSize();
                localStorage.setItem('glyphOverviewSize', String(newSize));
            });
        }

        // Set initial tile dimensions
        const dims = this.getTileDimensions();
        if (this.container) {
            this.container.style.setProperty('--tile-width', `${dims.width}px`);
            this.container.style.setProperty(
                '--tile-height',
                `${dims.height}px`
            );
        }
    }

    private updateSliderProgress(): void {
        if (!this.sizeSlider) return;
        const percent = (this.currentSizeStep / 10) * 100;
        this.sizeSlider.style.setProperty('--value-percent', `${percent}%`);
    }

    private initSearchControl(): void {
        // Find search input in DOM
        this.searchInput = document.getElementById(
            'overview-search-input'
        ) as HTMLInputElement;

        if (this.searchInput) {
            // Listen for input changes
            this.searchInput.addEventListener('input', (e) => {
                const value = (e.target as HTMLInputElement).value.trim();
                this.searchTerms = value
                    .split(/\s+/)
                    .filter((term) => term.length > 0)
                    .map((term) => term.toLowerCase());
                this.applySearchFilter();
            });
        }

        // Listen for keyboard shortcut (Cmd+F)
        document.addEventListener('keydown', (e) => {
            if (
                (e.metaKey || e.ctrlKey) &&
                e.key === 'f' &&
                this.isViewActive()
            ) {
                e.preventDefault();
                if (this.searchInput) {
                    this.searchInput.focus();
                    this.searchInput.select();
                }
            } else if (e.key === 'Escape' && this.isViewActive()) {
                // Clear all glyph and group selections
                e.preventDefault();
                this.clearSelection();
                // Also clear keyboard anchor
                this.keyboardAnchorGlyphId = null;
                if (window.glyphOverviewFilterManager) {
                    window.glyphOverviewFilterManager.clearGroupSelection();
                }
            } else if (
                (e.metaKey || e.ctrlKey) &&
                e.key === 'Enter' &&
                this.isViewActive()
            ) {
                e.preventDefault();
                this.insertSelectedGlyphTokens();
            } else if (
                ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(
                    e.key
                )
            ) {
                // Handle arrow key navigation for glyph selection
                if (this.isViewActive()) {
                    e.preventDefault();
                    this.handleArrowKeyNavigation(e.key, e.shiftKey);
                }
            }
        });
    }

    private initViewModeControl(): void {
        const savedMode = localStorage.getItem(this.viewModeStorageKey);
        if (savedMode === 'grid') {
            this.viewMode = 'grid';
        }

        this.linesModeButton = document.getElementById(
            'overview-mode-lines'
        ) as HTMLButtonElement;
        this.gridModeButton = document.getElementById(
            'overview-mode-grid'
        ) as HTMLButtonElement;

        if (this.linesModeButton) {
            this.linesModeButton.addEventListener('click', () => {
                this.setViewMode('lines');
            });
        }

        if (this.gridModeButton) {
            this.gridModeButton.addEventListener('click', () => {
                this.setViewMode('grid');
            });
        }

        this.setViewMode(this.viewMode, false, true);
    }

    private setViewMode(
        mode: OverviewViewMode,
        persist: boolean = true,
        force: boolean = false
    ): void {
        if (!force && this.viewMode === mode) return;

        this.viewMode = mode;
        if (persist) {
            localStorage.setItem(this.viewModeStorageKey, mode);
        }
        this.updateViewModeButtonState();
        this.renderByViewMode();
    }

    private updateViewModeButtonState(): void {
        const isLines = this.viewMode === 'lines';

        if (this.linesModeButton) {
            this.linesModeButton.classList.toggle('active', isLines);
            this.linesModeButton.setAttribute(
                'aria-pressed',
                isLines ? 'true' : 'false'
            );
        }

        if (this.gridModeButton) {
            this.gridModeButton.classList.toggle('active', !isLines);
            this.gridModeButton.setAttribute(
                'aria-pressed',
                isLines ? 'false' : 'true'
            );
        }
    }

    private applySearchFilter(): void {
        if (
            this.viewMode === 'lines' &&
            this.searchTerms.length === 0 &&
            this.activeFilterResults === null &&
            this.totalGlyphDatasetCount < this.linesVirtualizationThreshold
        ) {
            this.visibleGlyphIds = [...this.glyphOrderIds];
            this.renderLinesModeNoRelayout();
            return;
        }

        if (
            this.searchTerms.length === 0 &&
            this.activeFilterResults === null
        ) {
            this.visibleGlyphIds = [...this.glyphOrderIds];
            this.renderByViewMode();
            return;
        }

        this.visibleGlyphIds = this.computeVisibleGlyphIds();
        this.renderByViewMode();
    }

    private renderLinesModeNoRelayout(): void {
        if (!this.container) return;

        this.detachLinesVirtualization();

        this.container.classList.remove('glyph-overview-grid-mode');
        this.container.classList.add('glyph-overview-lines-mode');
        this.gridRowsForNavigation = [];
        this.gridColumnCount = 0;

        this.tiles.forEach((tile) => {
            tile.element.style.display = '';
        });
    }

    private computeVisibleGlyphIds(): string[] {
        const visibleIds: string[] = [];

        this.tiles.forEach((tile, glyphId) => {
            const passesFilter =
                this.activeFilterResults === null ||
                this.activeFilterResults.has(tile.glyphName);

            let passesSearch = true;
            if (this.searchTerms.length > 0) {
                const glyphNameLower = tile.glyphName.toLowerCase();
                passesSearch = this.searchTerms.every((term) =>
                    glyphNameLower.includes(term)
                );
            }

            if (passesFilter && passesSearch) {
                visibleIds.push(glyphId);
            }
        });

        return visibleIds;
    }

    private renderByViewMode(): void {
        if (!this.container) return;

        if (this.viewMode === 'grid') {
            this.renderGridMode();
            this.scheduleHighlightedGlyphVisibilitySync();
            return;
        }

        this.renderLinesMode();
        this.scheduleHighlightedGlyphVisibilitySync();
    }

    private renderLinesMode(): void {
        if (!this.container) return;

        if (this.shouldVirtualizeLinesMode()) {
            this.enableLinesVirtualization();
            this.renderVirtualizedLinesWindow(true);
            return;
        }

        this.detachLinesVirtualization();

        const visibleSet = new Set(this.visibleGlyphIds);
        this.container.classList.remove('glyph-overview-grid-mode');
        this.container.classList.add('glyph-overview-lines-mode');
        this.gridRowsForNavigation = [];
        this.gridColumnCount = 0;

        const fragment = document.createDocumentFragment();
        this.tiles.forEach((tile, glyphId) => {
            tile.element.style.display = visibleSet.has(glyphId) ? '' : 'none';
            fragment.appendChild(tile.element);
        });

        this.container.innerHTML = '';
        this.container.appendChild(fragment);
    }

    private renderGridMode(): void {
        if (!this.container) return;

        this.detachLinesVirtualization();

        const layout = this.buildGridLayoutData(this.visibleGlyphIds);
        this.container.classList.remove('glyph-overview-lines-mode');
        this.container.classList.add('glyph-overview-grid-mode');
        this.gridRowsForNavigation = layout.rows;
        this.gridColumnCount = layout.columns.length;

        const visibleSet = new Set(layout.visibleIds);
        this.tiles.forEach((tile, glyphId) => {
            tile.element.style.display = visibleSet.has(glyphId) ? '' : 'none';
        });

        const fragment = document.createDocumentFragment();

        const headerRowElement = document.createElement('div');
        headerRowElement.className = 'glyph-grid-row glyph-grid-header-row';
        headerRowElement.style.gridTemplateColumns = `repeat(${layout.columns.length}, var(--tile-width))`;

        layout.columns.forEach((columnSuffix) => {
            const headerCellElement = document.createElement('div');
            headerCellElement.className = 'glyph-grid-header-cell';
            headerCellElement.textContent = columnSuffix;
            headerCellElement.title = columnSuffix;
            headerRowElement.appendChild(headerCellElement);
        });

        fragment.appendChild(headerRowElement);

        layout.rows.forEach((row) => {
            const rowElement = document.createElement('div');
            rowElement.className = 'glyph-grid-row';
            rowElement.style.gridTemplateColumns = `repeat(${layout.columns.length}, var(--tile-width))`;

            row.forEach((glyphId) => {
                const cellElement = document.createElement('div');
                cellElement.className = 'glyph-grid-cell';

                if (glyphId) {
                    const tile = this.tiles.get(glyphId);
                    if (tile) {
                        cellElement.appendChild(tile.element);
                    }
                } else {
                    cellElement.classList.add('empty');
                }

                rowElement.appendChild(cellElement);
            });

            fragment.appendChild(rowElement);
        });

        this.container.innerHTML = '';
        this.container.appendChild(fragment);
    }

    private shouldVirtualizeLinesMode(): boolean {
        return (
            this.viewMode === 'lines' &&
            this.visibleGlyphIds.length >= this.linesVirtualizationThreshold
        );
    }

    private enableLinesVirtualization(): void {
        if (!this.container) return;

        if (!this.linesVirtualizationActive) {
            this.linesVirtualizationActive = true;
            this.container.addEventListener(
                'scroll',
                this.onContainerScrollBound,
                {
                    passive: true
                }
            );
        }

        this.container.classList.remove('glyph-overview-grid-mode');
        this.container.classList.add('glyph-overview-lines-mode');
    }

    private detachLinesVirtualization(): void {
        if (!this.container || !this.linesVirtualizationActive) {
            return;
        }

        this.linesVirtualizationActive = false;
        this.virtualizedRenderRafPending = false;
        this.virtualizedRenderRange = null;
        this.container.removeEventListener(
            'scroll',
            this.onContainerScrollBound
        );
    }

    private onContainerScroll(): void {
        if (!this.linesVirtualizationActive || !this.container) {
            return;
        }

        this.scheduleScrollVisibilitySync();
    }

    private onCapturedScroll(event: Event): void {
        if (!this.lazyLoadEnabled || !this.container) {
            return;
        }

        const target = event.target;
        const isRelevantScrollTarget =
            target === this.container ||
            (target instanceof Node &&
                (target.contains(this.container) ||
                    this.container.contains(target)));

        if (!isRelevantScrollTarget) {
            return;
        }

        this.scheduleScrollVisibilitySync();
    }

    private scheduleScrollVisibilitySync(): void {
        if (this.scrollVisibilitySyncRafId !== null) {
            return;
        }

        this.scrollVisibilitySyncRafId = requestAnimationFrame(() => {
            this.scrollVisibilitySyncRafId = null;

            if (!this.container || !this.lazyLoadEnabled) {
                return;
            }

            if (this.linesVirtualizationActive) {
                this.renderVirtualizedLinesWindow();
            }

            const queuedVisibleTileCount = this.queueVisibleUncachedTiles();
            if (queuedVisibleTileCount > 0) {
                this.scheduleBatchRender();
            }
        });
    }

    private queueVisibleUncachedTiles(): number {
        if (!this.container) {
            return 0;
        }

        const containerRect = this.container.getBoundingClientRect();
        if (containerRect.width <= 0 || containerRect.height <= 0) {
            return 0;
        }

        const viewportMargin = 100;
        let queuedCount = 0;

        for (const tile of this.tiles.values()) {
            if (tile.cachedData || !tile.element.isConnected) {
                continue;
            }

            const tileRect = tile.element.getBoundingClientRect();
            if (tileRect.width <= 0 || tileRect.height <= 0) {
                continue;
            }

            const intersectsViewport =
                tileRect.bottom >= containerRect.top - viewportMargin &&
                tileRect.top <= containerRect.bottom + viewportMargin &&
                tileRect.right >= containerRect.left - viewportMargin &&
                tileRect.left <= containerRect.right + viewportMargin;

            if (!intersectsViewport) {
                continue;
            }

            if (!this.pendingGlyphIds.has(tile.glyphId)) {
                this.pendingGlyphIds.add(tile.glyphId);
                queuedCount += 1;
            }
        }

        return queuedCount;
    }

    private renderVirtualizedLinesWindow(force: boolean = false): void {
        if (!this.container) return;

        const total = this.visibleGlyphIds.length;
        if (total === 0) {
            this.virtualizedRenderRange = { start: 0, end: 0 };
            this.container.innerHTML = '';
            return;
        }

        const dims = this.getTileDimensions();
        const columns = Math.max(1, this.getGridColumns());
        const rowHeight = dims.height + 2;
        const totalRows = Math.ceil(total / columns);
        const viewportTop = this.container.scrollTop;
        const viewportBottom = viewportTop + this.container.clientHeight;

        const startRow = Math.max(
            0,
            Math.floor(viewportTop / rowHeight) -
                this.linesVirtualizationBufferRows
        );
        const endRow = Math.min(
            totalRows - 1,
            Math.ceil(viewportBottom / rowHeight) +
                this.linesVirtualizationBufferRows
        );

        const start = Math.min(total, startRow * columns);
        const end = Math.min(total, (endRow + 1) * columns);

        if (
            !force &&
            this.virtualizedRenderRange &&
            this.virtualizedRenderRange.start === start &&
            this.virtualizedRenderRange.end === end
        ) {
            return;
        }

        this.virtualizedRenderRange = { start, end };

        const topSpacerHeight = startRow * rowHeight;
        const bottomSpacerHeight = Math.max(
            0,
            (totalRows - endRow - 1) * rowHeight
        );
        let queuedVisibleTileCount = 0;

        const fragment = document.createDocumentFragment();

        if (topSpacerHeight > 0) {
            const topSpacer = document.createElement('div');
            topSpacer.style.width = '100%';
            topSpacer.style.height = `${topSpacerHeight}px`;
            topSpacer.style.flex = '0 0 100%';
            topSpacer.dataset.role = 'virtual-spacer-top';
            fragment.appendChild(topSpacer);
        }

        for (let index = start; index < end; index += 1) {
            const glyphId = this.visibleGlyphIds[index];
            let tile = this.tiles.get(glyphId);
            if (!tile) {
                const glyphData = this.glyphDataById.get(glyphId);
                if (glyphData) {
                    tile = this.createGlyphTile(glyphData.id, glyphData.name);
                    this.tiles.set(glyphId, tile);
                }
            }
            if (!tile) continue;
            tile.element.style.display = '';
            fragment.appendChild(tile.element);
            if (!tile.cachedData && !this.pendingGlyphIds.has(glyphId)) {
                this.pendingGlyphIds.add(glyphId);
                queuedVisibleTileCount += 1;
            }
            if (this.intersectionObserver) {
                this.intersectionObserver.observe(tile.element);
            }
        }

        if (bottomSpacerHeight > 0) {
            const bottomSpacer = document.createElement('div');
            bottomSpacer.style.width = '100%';
            bottomSpacer.style.height = `${bottomSpacerHeight}px`;
            bottomSpacer.style.flex = '0 0 100%';
            bottomSpacer.dataset.role = 'virtual-spacer-bottom';
            fragment.appendChild(bottomSpacer);
        }

        this.container.innerHTML = '';
        this.container.appendChild(fragment);

        if (queuedVisibleTileCount > 0) {
            this.scheduleBatchRender();
        }
    }

    private buildGridLayoutData(visibleIds: string[]): GridLayoutData {
        const rowByBase = new Map<string, Map<string, string>>();
        const baseOrder: string[] = [];
        const variantSuffixes = new Set<string>();

        visibleIds.forEach((glyphId) => {
            const tile = this.tiles.get(glyphId);
            if (!tile) return;

            const { baseName, variantSuffix } = this.parseGridName(
                tile.glyphName
            );

            if (!rowByBase.has(baseName)) {
                rowByBase.set(baseName, new Map());
                baseOrder.push(baseName);
            }

            rowByBase.get(baseName)!.set(variantSuffix, glyphId);

            if (variantSuffix) {
                variantSuffixes.add(variantSuffix);
            }
        });

        const sortedVariantSuffixes = Array.from(variantSuffixes).sort((a, b) =>
            a.localeCompare(b, undefined, { sensitivity: 'base' })
        );
        const columns = ['', ...sortedVariantSuffixes];

        const rows: Array<Array<string | null>> = baseOrder.map((baseName) => {
            const rowMap = rowByBase.get(baseName)!;
            return columns.map(
                (columnSuffix) => rowMap.get(columnSuffix) ?? null
            );
        });

        return {
            columns,
            rows,
            visibleIds
        };
    }

    private parseGridName(glyphName: string): GridNameParts {
        if (glyphName.startsWith('.')) {
            return {
                baseName: glyphName,
                variantSuffix: ''
            };
        }

        const dotIndex = glyphName.indexOf('.');
        if (dotIndex <= 0) {
            return {
                baseName: glyphName,
                variantSuffix: ''
            };
        }

        return {
            baseName: glyphName.slice(0, dotIndex),
            variantSuffix: glyphName.slice(dotIndex)
        };
    }

    private getTileDimensions(): { width: number; height: number } {
        // Smallest: 25x42 (a bit smaller than current 30x50)
        // Largest: 200x250
        // Interpolate between them
        const minWidth = 25;
        const maxWidth = 200;
        const minHeight = 42;
        const maxHeight = 250;

        const t = this.currentSizeStep / 10; // 0 to 1
        const width = Math.round(minWidth + (maxWidth - minWidth) * t);
        const height = Math.round(minHeight + (maxHeight - minHeight) * t);

        return { width, height };
    }

    private updateTileSize(): void {
        const resizeFocusAnchor = this.getResizeFocusAnchor();
        const dims = this.getTileDimensions();

        if (this.highlightScrollSyncRafId !== null) {
            cancelAnimationFrame(this.highlightScrollSyncRafId);
            this.highlightScrollSyncRafId = null;
        }
        this.highlightScrollSyncAttempts = 0;

        // Update CSS custom properties for tile sizing
        if (this.container) {
            this.container.style.setProperty('--tile-width', `${dims.width}px`);
            this.container.style.setProperty(
                '--tile-height',
                `${dims.height}px`
            );
        }

        // Re-render all tiles with new size in a single frame
        requestAnimationFrame(() => {
            this.tiles.forEach((tile) => {
                if (tile.cachedData) {
                    this.renderTileCanvas(
                        tile,
                        tile.cachedData,
                        dims.width,
                        dims.height
                    );
                }
            });

            if (this.linesVirtualizationActive) {
                this.renderVirtualizedLinesWindow(true);
            }

            this.applyResizeFocusAnchor(resizeFocusAnchor);
        });
    }

    private getResizeFocusAnchor(): ResizeFocusAnchor | null {
        const selectedGlyphIds = this.getSelectedGlyphs().filter((glyphId) =>
            this.visibleGlyphIds.includes(glyphId)
        );
        if (selectedGlyphIds.length > 0) {
            return {
                type: 'selection',
                glyphIds: selectedGlyphIds
            };
        }

        const activeGlyphName = this.getCurrentActiveGlyphName();
        if (activeGlyphName) {
            return {
                type: 'active',
                glyphName: activeGlyphName
            };
        }

        return null;
    }

    private getCurrentActiveGlyphName(): string | null {
        const glyphCanvas = (window as any).glyphCanvas;
        const isEditMode = glyphCanvas?.outlineEditor?.active;
        if (!isEditMode) {
            return this.highlightedGlyphName;
        }

        if (glyphCanvas?.outlineEditor?.parseGlyphStack) {
            const parsed = glyphCanvas.outlineEditor.parseGlyphStack();
            if (parsed.length > 0) {
                return parsed[parsed.length - 1].glyphName;
            }
        }

        return this.highlightedGlyphName;
    }

    private applyResizeFocusAnchor(anchor: ResizeFocusAnchor | null): void {
        if (!anchor) {
            return;
        }

        if (anchor.type === 'selection') {
            this.centerGlyphIdsInView(anchor.glyphIds);
            return;
        }

        const activeTile = Array.from(this.tiles.values()).find(
            (tile) => tile.glyphName === anchor.glyphName
        );
        if (!activeTile) {
            return;
        }

        this.scrollToTile(activeTile.element, false);
    }

    private centerGlyphIdsInView(glyphIds: string[]): void {
        if (!this.container || !glyphIds.length) {
            return;
        }

        const visibleSelectedGlyphIds = glyphIds.filter((glyphId) =>
            this.visibleGlyphIds.includes(glyphId)
        );
        if (!visibleSelectedGlyphIds.length) {
            return;
        }

        const visibleIndexes = visibleSelectedGlyphIds
            .map((glyphId) => this.visibleGlyphIds.indexOf(glyphId))
            .filter((index) => index !== -1)
            .sort((a, b) => a - b);
        if (!visibleIndexes.length) {
            return;
        }

        const averageIndex =
            visibleIndexes.reduce((sum, index) => sum + index, 0) /
            visibleIndexes.length;
        const dims = this.getTileDimensions();
        const columns = Math.max(1, this.getGridColumns());
        const rowHeight = dims.height + 2;
        const averageRow = averageIndex / columns;
        const selectionCenterY = averageRow * rowHeight + dims.height / 2;

        this.setCenteredScrollTop(selectionCenterY);
    }

    private setCenteredScrollTop(contentCenterY: number): void {
        if (!this.container) {
            return;
        }

        const targetScroll = Math.max(
            0,
            contentCenterY - this.container.clientHeight / 2
        );
        const maxScroll = Math.max(
            0,
            this.container.scrollHeight - this.container.clientHeight
        );
        this.container.scrollTop = Math.min(targetScroll, maxScroll);
        this.renderVirtualizedLinesWindow(true);
    }

    private isViewActive(): boolean {
        const overviewView = document.querySelector('#view-overview');
        return overviewView?.classList.contains('focused') ?? false;
    }

    public updateGlyphs(
        glyphs: Array<{ id: string; name: string }>
    ): Promise<void> {
        if (!this.container) return Promise.resolve();

        this.totalGlyphDatasetCount = glyphs.length;
        this.glyphOrderIds = glyphs.map((glyph) => glyph.id);
        this.glyphDataById = new Map(glyphs.map((glyph) => [glyph.id, glyph]));

        if (this.updateGlyphsSpanId) {
            timelineSpanEnd(this.updateGlyphsSpanId);
            this.updateGlyphsSpanId = null;
        }

        this.updateGlyphsSpanId = timelineSpanStart('overview.updateGlyphs', {
            glyphCount: glyphs.length
        });

        if (this.tileBuildResolve) {
            this.tileBuildResolve();
            this.tileBuildResolve = null;
        }

        this.tileBuildPromise = new Promise<void>((resolve) => {
            this.tileBuildResolve = resolve;
        });

        if (this.deferredTileBuildTimer !== null) {
            clearTimeout(this.deferredTileBuildTimer);
            this.deferredTileBuildTimer = null;
        }

        this.tileBuildRunId += 1;
        const currentBuildRunId = this.tileBuildRunId;

        const finishBuild = () => {
            if (currentBuildRunId !== this.tileBuildRunId) {
                return;
            }

            this.applySearchFilter();

            if (this.updateGlyphsSpanId) {
                timelineSpanEnd(this.updateGlyphsSpanId);
                this.updateGlyphsSpanId = null;
            }

            if (this.tileBuildResolve) {
                this.tileBuildResolve();
                this.tileBuildResolve = null;
            }
        };

        // Clear existing tiles
        this.container.innerHTML = '';
        this.tiles.clear();
        this.pendingGlyphIds.clear();

        if (this.intersectionObserver) {
            this.intersectionObserver.disconnect();
            this.intersectionObserver = null;
        }

        const totalGlyphs = glyphs.length;
        if (totalGlyphs === 0) {
            finishBuild();
            return this.tileBuildPromise;
        }

        // Small fonts: build synchronously for immediate interaction.
        if (totalGlyphs <= 1000) {
            const fragment = document.createDocumentFragment();
            glyphs.forEach((glyph) => {
                const tile = this.createGlyphTile(glyph.id, glyph.name);
                this.tiles.set(glyph.id, tile);
                fragment.appendChild(tile.element);
            });
            this.container.appendChild(fragment);
            finishBuild();
            return this.tileBuildPromise;
        }

        const buildVirtualizedOnly =
            totalGlyphs >= this.linesVirtualizationThreshold;

        // Large fonts: create tile objects in chunks. When virtualization is
        // active, do not attach all tiles to DOM (windowed mount handles that).
        const initialVisibleTarget = Math.min(totalGlyphs, 720);
        let initialChunkReady = false;

        const buildChunk = (startIndex: number) => {
            if (!this.container || currentBuildRunId !== this.tileBuildRunId) {
                return;
            }

            const chunkSize =
                totalGlyphs > 5000 ? 80 : totalGlyphs > 2500 ? 100 : 120;
            const endIndex = Math.min(startIndex + chunkSize, totalGlyphs);
            const shouldAttachChunk =
                !buildVirtualizedOnly || !initialChunkReady;
            const fragment = shouldAttachChunk
                ? document.createDocumentFragment()
                : null;
            const attachedTiles: GlyphTile[] = [];

            for (let index = startIndex; index < endIndex; index += 1) {
                const glyph = glyphs[index];
                let tile = this.tiles.get(glyph.id);
                if (!tile) {
                    tile = this.createGlyphTile(glyph.id, glyph.name);
                    this.tiles.set(glyph.id, tile);
                }
                if (fragment) {
                    fragment.appendChild(tile.element);
                }
                attachedTiles.push(tile);
            }

            if (fragment) {
                this.container.appendChild(fragment);
            }

            if (this.intersectionObserver && shouldAttachChunk) {
                attachedTiles.forEach((tile) => {
                    this.intersectionObserver!.observe(tile.element);
                });
            }

            if (
                buildVirtualizedOnly &&
                !initialChunkReady &&
                endIndex >= initialVisibleTarget
            ) {
                initialChunkReady = true;
                finishBuild();
            }

            if (buildVirtualizedOnly && this.linesVirtualizationActive) {
                this.renderVirtualizedLinesWindow(true);
            }

            if (endIndex < totalGlyphs) {
                this.deferredTileBuildTimer = window.setTimeout(() => {
                    this.deferredTileBuildTimer = null;
                    requestAnimationFrame(() => buildChunk(endIndex));
                }, 0);
                return;
            }

            if (!initialChunkReady) {
                initialChunkReady = true;
                finishBuild();
            }
        };

        requestAnimationFrame(() => buildChunk(0));

        return this.tileBuildPromise;
    }

    /**
     * Render glyph outlines at a specific location in designspace
     * @param location - Axis location object, e.g., { wght: 400 }. Empty object uses default location.
     */
    public async renderGlyphOutlines(
        location: Record<string, number> = {}
    ): Promise<void> {
        if (!this.container) {
            console.warn('[GlyphOverview]', 'No container, cannot render');
            return;
        }

        await this.tileBuildPromise;

        this.currentLocation = location;

        // Invalidate cached outline data so tiles re-fetch at the new location
        this.tiles.forEach((tile) => {
            tile.cachedData = undefined;
        });
        this.pendingGlyphIds.clear();

        // Cache metrics from font model for consistent tile sizing
        this.updateRenderMetrics();

        const glyphCount = this.tiles.size;

        const totalSpanId = timelineSpanStart('overview.renderGlyphOutlines', {
            glyphCount
        });

        // Use lazy loading for all fonts for consistent behavior.
        this.lazyLoadEnabled = true;
        this.setupLazyLoading();

        // Prime initial visible tiles immediately so first render is not empty
        // when screenshots/tests run right after open.
        let primedCount = this.queueVisibleUncachedTiles();
        if (primedCount === 0) {
            primedCount = this.primeInitialVisibleTileBatch();
        }
        if (primedCount > 0) {
            await this.processBatchRender();
        }

        timelineSpanEnd(totalSpanId);
    }

    private primeInitialVisibleTileBatch(): number {
        if (!this.container) {
            return 0;
        }

        const maxInitialTiles = 480;
        let queued = 0;

        this.tiles.forEach((tile, glyphId) => {
            if (queued >= maxInitialTiles) {
                return;
            }

            if (!tile.element.isConnected) {
                return;
            }

            if (tile.cachedData) {
                return;
            }

            this.pendingGlyphIds.add(glyphId);
            queued += 1;
        });

        return queued;
    }

    private async renderOutlinesInChunks(
        outlines: any[],
        glyphNames: string[],
        dims: { width: number; height: number }
    ): Promise<void> {
        const chunkSize = 48;

        const glyphNameToTile = new Map<string, GlyphTile>();
        this.tiles.forEach((tile) => {
            glyphNameToTile.set(tile.glyphName, tile);
        });

        await new Promise<void>((resolve) => {
            let index = 0;
            let chunkIndex = 0;

            const renderChunk = () => {
                const end = Math.min(index + chunkSize, outlines.length);
                const frameSpanId = timelineSpanStart(
                    'overview.outlines.renderChunkFrame',
                    {
                        chunkIndex,
                        startIndex: index,
                        endIndex: end,
                        count: end - index,
                        mode: 'initial'
                    }
                );

                for (let i = index; i < end; i += 1) {
                    const glyphData = outlines[i];
                    const glyphName = glyphData?.name;
                    let tile = glyphName
                        ? glyphNameToTile.get(glyphName)
                        : undefined;
                    if (!tile && glyphNames[i]) {
                        tile = glyphNameToTile.get(glyphNames[i]);
                    }
                    if (!tile) {
                        continue;
                    }

                    const rendered = this.renderTileCanvas(
                        tile,
                        glyphData,
                        dims.width,
                        dims.height
                    );
                    if (rendered) {
                        tile.cachedData = glyphData;
                    }
                }

                index = end;
                chunkIndex += 1;
                timelineSpanEnd(frameSpanId);

                if (index < outlines.length) {
                    requestAnimationFrame(renderChunk);
                } else {
                    resolve();
                }
            };

            requestAnimationFrame(renderChunk);
        });
    }

    /**
     * Update cached render metrics from font model
     */
    private updateRenderMetrics(): void {
        const font = (window as any).currentFontModel;
        if (!font) {
            this.renderMetrics = null;
            return;
        }

        const upm = font.upm || 1000;
        // Default ascender/descender fallback from UPM
        let fallbackAscender = upm * 0.8;
        let fallbackDescender = -(upm * 0.2);

        const customParams = font.custom_opentype_values || [];
        if (Array.isArray(customParams)) {
            const hheaAsc = customParams.find(
                (entry: any) => entry?.name === 'hheaAscender'
            )?.value;
            const hheaDesc = customParams.find(
                (entry: any) => entry?.name === 'hheaDescender'
            )?.value;
            if (typeof hheaAsc === 'number' && Number.isFinite(hheaAsc)) {
                fallbackAscender = hheaAsc;
            }
            if (typeof hheaDesc === 'number' && Number.isFinite(hheaDesc)) {
                fallbackDescender = hheaDesc;
            }
        }

        let ascender = fallbackAscender;
        let descender = fallbackDescender;

        // Try to get metrics from first master
        const master = font.masters?.[0];
        if (master?.metrics) {
            // Look for Ascender/Descender in metrics (case may vary)
            const metrics = master.metrics;
            if (
                metrics.Ascender !== undefined &&
                Number.isFinite(metrics.Ascender)
            ) {
                ascender = metrics.Ascender;
            } else if (
                metrics.ascender !== undefined &&
                Number.isFinite(metrics.ascender)
            ) {
                ascender = metrics.ascender;
            }
            if (
                metrics.Descender !== undefined &&
                Number.isFinite(metrics.Descender)
            ) {
                descender = metrics.Descender;
            } else if (
                metrics.descender !== undefined &&
                Number.isFinite(metrics.descender)
            ) {
                descender = metrics.descender;
            }
        }

        const metricsHeight = ascender - descender;
        const minExpectedHeight = upm * 0.5;
        const maxExpectedHeight = upm * 2.0;
        if (
            !Number.isFinite(metricsHeight) ||
            metricsHeight < minExpectedHeight ||
            metricsHeight > maxExpectedHeight
        ) {
            ascender = fallbackAscender;
            descender = fallbackDescender;
        }

        this.renderMetrics = { ascender, descender, upm };
    }

    /**
     * Render glyph data to tile's pre-existing canvas (no DOM manipulation)
     */
    private renderTileCanvas(
        tile: GlyphTile,
        glyphData: any,
        width?: number,
        height?: number
    ): boolean {
        // Use provided dimensions or get current size
        const dims =
            width && height ? { width, height } : this.getTileDimensions();

        // Render directly to the tile's pre-existing canvas
        if (tile.canvas) {
            try {
                fastGlyphTileRenderer.renderToCanvas(
                    glyphData,
                    this.renderMetrics || undefined,
                    dims.width,
                    dims.height,
                    tile.canvas
                );
                return true;
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);
                console.warn(
                    `[GlyphOverview] Failed to render tile ${tile.glyphName}: ${message}`
                );
                return false;
            }
        }

        return false;
    }

    /**
     * Legacy renderTile for compatibility - updates cache and calls renderTileCanvas
     */
    private renderTile(
        tile: GlyphTile,
        glyphData: any,
        width?: number,
        height?: number
    ): void {
        const rendered = this.renderTileCanvas(tile, glyphData, width, height);
        if (rendered) {
            // Cache data for future resizing
            tile.cachedData = glyphData;
        }
    }

    /**
     * Handle glyph change events - re-render the affected tile
     */
    private async onGlyphChanged(event: Event): Promise<void> {
        const detail = (event as CustomEvent).detail;
        const forceImmediateRefresh = detail?.forceImmediateRefresh === true;
        const glyphNames = Array.isArray(detail?.glyphNames)
            ? detail.glyphNames.filter(
                  (glyphName: unknown): glyphName is string =>
                      typeof glyphName === 'string' && glyphName.length > 0
              )
            : typeof detail?.glyphName === 'string' && detail.glyphName.length
              ? [detail.glyphName]
              : [];
        if (!glyphNames.length) {
            return;
        }

        let queuedAnyGlyph = false;
        const immediateGlyphNames = new Set<string>();

        for (const glyphName of glyphNames) {
            let targetTile: GlyphTile | undefined;
            for (const tile of this.tiles.values()) {
                if (tile.glyphName === glyphName) {
                    targetTile = tile;
                    break;
                }
            }

            if (!targetTile) {
                continue;
            }

            targetTile.cachedData = undefined;
            if (forceImmediateRefresh) {
                immediateGlyphNames.add(glyphName);
                this.pendingChangedGlyphNames.delete(glyphName);
            } else {
                this.pendingChangedGlyphNames.add(glyphName);
            }
            queuedAnyGlyph = true;
        }

        if (!queuedAnyGlyph) {
            return;
        }

        if (forceImmediateRefresh) {
            void this.refreshChangedGlyphTiles(Array.from(immediateGlyphNames));
            return;
        }

        this.schedulePendingChangedGlyphRefresh();
    }

    /**
     * Handle glyph stack change events for immediate highlight updates
     */
    private onGlyphStackChanged(event: Event): void {
        const detail = (event as CustomEvent).detail;
        const glyphStack = detail?.glyphStack;
        if (!glyphStack) {
            this.setEditingHighlight(null);
            return;
        }

        this.syncActiveGlyphFocus();
    }

    public syncActiveGlyphFocus(): void {
        const glyphCanvas = (window as any).glyphCanvas;
        const isEditMode = glyphCanvas?.outlineEditor?.active;

        if (!isEditMode) {
            // In text mode, don't show the editing border
            this.setEditingHighlight(null);
            return;
        }

        // Parse the stack to get the last glyph (deepest component being edited)
        if (glyphCanvas?.outlineEditor?.parseGlyphStack) {
            const parsed = glyphCanvas.outlineEditor.parseGlyphStack();
            if (parsed.length > 0) {
                const editingGlyph = parsed[parsed.length - 1].glyphName;
                if (editingGlyph === this.highlightedGlyphName) {
                    this.scheduleHighlightedGlyphVisibilitySync();
                    return;
                }

                this.setEditingHighlight(editingGlyph);
            } else {
                this.setEditingHighlight(null);
            }
        }
    }

    /**
     * Handle mode changes to clear border when switching to text mode
     */
    private onModeChanged(event: Event): void {
        const detail = (event as CustomEvent).detail;
        const mode = detail?.mode;

        if (mode === 'text') {
            // Clear editing highlight when switching to text mode
            this.setEditingHighlight(null);
            this.schedulePendingChangedGlyphRefresh(true);
        }
    }

    private isOutlineDragActive(): boolean {
        return !!(window as any).glyphCanvas?.outlineEditor?.draggingSomething;
    }

    private schedulePendingChangedGlyphRefresh(forceImmediate = false): void {
        if (this.pendingChangedGlyphRefreshTimer !== null) {
            clearTimeout(this.pendingChangedGlyphRefreshTimer);
        }

        const delay = forceImmediate
            ? 0
            : this.isOutlineDragActive()
              ? this.activeDragGlyphRefreshDelayMs
              : this.deferredGlyphRefreshDelayMs;

        this.pendingChangedGlyphRefreshTimer = window.setTimeout(() => {
            this.pendingChangedGlyphRefreshTimer = null;

            if (!forceImmediate && this.isOutlineDragActive()) {
                this.schedulePendingChangedGlyphRefresh();
                return;
            }

            void this.flushPendingChangedGlyphRefreshes();
        }, delay);
    }

    private async flushPendingChangedGlyphRefreshes(): Promise<void> {
        if (!this.pendingChangedGlyphNames.size) {
            return;
        }

        const glyphNames = Array.from(this.pendingChangedGlyphNames);
        this.pendingChangedGlyphNames.clear();
        await this.refreshChangedGlyphTiles(glyphNames);
    }

    private async refreshChangedGlyphTiles(
        glyphNames: string[]
    ): Promise<void> {
        if (!glyphNames.length) {
            return;
        }

        const glyphNameToTile: Map<string, GlyphTile> = new Map();
        for (const glyphName of glyphNames) {
            for (const tile of this.tiles.values()) {
                if (tile.glyphName === glyphName) {
                    glyphNameToTile.set(glyphName, tile);
                    break;
                }
            }
        }

        const refreshGlyphNames = Array.from(glyphNameToTile.keys());

        if (!refreshGlyphNames.length) {
            return;
        }

        try {
            const fontComp = window.fontCompilation;
            if (!fontComp) {
                return;
            }

            const response = await fontComp.sendMessage({
                type: 'getGlyphOutlines',
                glyphNames: refreshGlyphNames,
                location: this.currentLocation,
                flattenComponents: false
            });

            if (response.error) {
                console.error(
                    '[GlyphOverview]',
                    'Failed to refresh changed glyph tiles:',
                    response.error
                );
                return;
            }

            const outlines = JSON.parse(response.outlinesJson || '[]');
            if (!Array.isArray(outlines) || !outlines.length) {
                return;
            }

            const dims = this.getTileDimensions();
            for (const outline of outlines) {
                if (!outline?.name) {
                    continue;
                }

                const tile = glyphNameToTile.get(outline.name);
                if (!tile) {
                    continue;
                }

                this.renderTile(tile, outline, dims.width, dims.height);
            }
        } catch (error) {
            console.error(
                '[GlyphOverview]',
                'Error refreshing changed glyph tiles:',
                error
            );
        }
    }

    /**
     * Handle theme changes to re-render tiles with new colors
     */
    private onThemeChanged(): void {
        // Update theme colors in renderer
        fastGlyphTileRenderer.updateThemeColors();

        // Re-render all tiles with cached data in a single frame
        const dims = this.getTileDimensions();
        requestAnimationFrame(() => {
            this.tiles.forEach((tile) => {
                if (tile.cachedData) {
                    this.renderTileCanvas(
                        tile,
                        tile.cachedData,
                        dims.width,
                        dims.height
                    );
                }
            });
        });
    }

    /**
     * Set the editing highlight on a specific glyph tile
     */
    private setEditingHighlight(glyphName: string | null): void {
        if (glyphName === this.highlightedGlyphName) {
            if (!glyphName) {
                return;
            }

            for (const tile of this.tiles.values()) {
                if (tile.glyphName !== glyphName) {
                    continue;
                }

                tile.element.style.boxShadow =
                    'inset 0 0 0 2px var(--accent-blue)';
                this.scheduleHighlightedGlyphVisibilitySync();
                return;
            }

            return;
        }

        if (this.highlightScrollSyncRafId !== null) {
            cancelAnimationFrame(this.highlightScrollSyncRafId);
            this.highlightScrollSyncRafId = null;
        }
        this.highlightScrollSyncAttempts = 0;

        // Remove highlight from previous tile
        if (this.highlightedGlyphName) {
            for (const tile of this.tiles.values()) {
                if (tile.glyphName === this.highlightedGlyphName) {
                    tile.element.style.boxShadow = '';
                    break;
                }
            }
        }

        // Add highlight to new tile and scroll into view
        this.highlightedGlyphName = glyphName;
        if (glyphName) {
            for (const tile of this.tiles.values()) {
                if (tile.glyphName === glyphName) {
                    tile.element.style.boxShadow =
                        'inset 0 0 0 2px var(--accent-blue)';
                    this.scheduleHighlightedGlyphVisibilitySync();
                    break;
                }
            }
        }
    }

    private scheduleHighlightedGlyphVisibilitySync(): void {
        if (!this.highlightedGlyphName || !this.container) {
            return;
        }

        if (this.highlightScrollSyncRafId !== null) {
            cancelAnimationFrame(this.highlightScrollSyncRafId);
            this.highlightScrollSyncRafId = null;
        }
        this.highlightScrollSyncAttempts = 0;

        const syncStep = () => {
            if (!this.highlightedGlyphName || !this.container) {
                this.highlightScrollSyncRafId = null;
                return;
            }

            let highlightedTile: GlyphTile | null = null;
            for (const tile of this.tiles.values()) {
                if (tile.glyphName === this.highlightedGlyphName) {
                    highlightedTile = tile;
                    break;
                }
            }

            if (!highlightedTile) {
                this.highlightScrollSyncRafId = null;
                return;
            }

            if (!this.isTileFullyVisible(highlightedTile.element)) {
                this.scrollToTile(highlightedTile.element);
            }

            this.highlightScrollSyncAttempts += 1;
            if (
                this.highlightScrollSyncAttempts <
                this.maxHighlightScrollSyncAttempts
            ) {
                this.highlightScrollSyncRafId = requestAnimationFrame(syncStep);
                return;
            }

            this.highlightScrollSyncRafId = null;
        };

        this.highlightScrollSyncRafId = requestAnimationFrame(syncStep);
    }

    private isTileFullyVisible(element: HTMLElement): boolean {
        if (!this.container || !element.isConnected) {
            return false;
        }

        const containerRect = this.container.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();

        if (
            containerRect.height <= 0 ||
            elementRect.height <= 0 ||
            elementRect.width <= 0
        ) {
            return false;
        }

        return (
            elementRect.top >= containerRect.top &&
            elementRect.bottom <= containerRect.bottom
        );
    }

    /**
     * Fast smooth scroll to tile element
     */
    private scrollToTile(element: HTMLElement, animate: boolean = true): void {
        if (!this.container) return;

        const glyphId = element.dataset.glyphId;

        // If the tile isn't mounted (or has no measurable box yet), use index-based
        // scrolling to avoid bad geometry reads that can jump to the top.
        if (!element.isConnected) {
            if (glyphId) {
                this.scrollToGlyphId(glyphId);
            }
            return;
        }

        if (this.container.clientHeight <= 0) {
            return;
        }

        if (this.linesVirtualizationActive) {
            if (glyphId) {
                this.scrollToGlyphId(glyphId);
                return;
            }
        }

        const containerRect = this.container.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();

        if (
            containerRect.height <= 0 ||
            elementRect.height <= 0 ||
            elementRect.width <= 0
        ) {
            if (glyphId) {
                this.scrollToGlyphId(glyphId);
            }
            return;
        }

        // Check if element is already fully visible
        if (
            elementRect.top >= containerRect.top &&
            elementRect.bottom <= containerRect.bottom
        ) {
            return;
        }

        // Calculate target scroll position
        const elementTop =
            elementRect.top - containerRect.top + this.container.scrollTop;
        const targetScroll =
            elementTop - containerRect.height / 2 + elementRect.height / 2;

        if (!animate) {
            const maxScroll = Math.max(
                0,
                this.container.scrollHeight - this.container.clientHeight
            );
            this.container.scrollTop = Math.min(
                Math.max(0, targetScroll),
                maxScroll
            );
            this.renderVirtualizedLinesWindow(true);
            return;
        }

        // Animate scroll with 150ms duration
        const startScroll = this.container.scrollTop;
        const distance = targetScroll - startScroll;
        const duration = 150;
        const startTime = performance.now();

        const animateScroll = (currentTime: number) => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            // Ease out quad
            const eased = 1 - (1 - progress) * (1 - progress);
            this.container!.scrollTop = startScroll + distance * eased;
            if (progress < 1) {
                requestAnimationFrame(animateScroll);
            }
        };

        requestAnimationFrame(animateScroll);
    }

    private scrollToGlyphId(
        glyphId: string,
        forceCenter: boolean = false
    ): void {
        if (!this.container) return;
        if (this.container.clientHeight <= 0) return;

        const index = this.visibleGlyphIds.indexOf(glyphId);
        if (index === -1) return;

        const dims = this.getTileDimensions();
        const columns = Math.max(1, this.getGridColumns());
        const row = Math.floor(index / columns);
        const rowHeight = dims.height + 2;
        const tileTop = row * rowHeight;
        const tileBottom = tileTop + dims.height;
        const viewportTop = this.container.scrollTop;
        const viewportBottom = viewportTop + this.container.clientHeight;

        if (
            !forceCenter &&
            tileTop >= viewportTop &&
            tileBottom <= viewportBottom
        ) {
            return;
        }

        const targetScroll = Math.max(
            0,
            tileTop - this.container.clientHeight / 2 + dims.height / 2
        );
        const maxScroll = Math.max(
            0,
            this.container.scrollHeight - this.container.clientHeight
        );
        this.container.scrollTop = Math.min(targetScroll, maxScroll);
        this.renderVirtualizedLinesWindow(true);
    }

    private setupLazyLoading(): void {
        if (this.intersectionObserver) {
            this.intersectionObserver.disconnect();
        }

        this.intersectionObserver = new IntersectionObserver(
            (entries) => {
                let addedCount = 0;
                entries.forEach((entry) => {
                    if (entry.isIntersecting) {
                        const glyphId = (entry.target as HTMLElement).dataset
                            .glyphId;
                        if (glyphId) {
                            const tile = this.tiles.get(glyphId);
                            // Only add if not already rendered (check for cachedData instead of canvas presence)
                            if (tile && !tile.cachedData) {
                                this.pendingGlyphIds.add(glyphId);
                                addedCount++;
                            }
                        }
                    }
                });
                if (addedCount > 0) {
                    this.scheduleBatchRender();
                }
            },
            { root: this.container, rootMargin: '100px' }
        );

        // Observe all tiles
        this.tiles.forEach((tile) => {
            this.intersectionObserver!.observe(tile.element);
        });
    }

    private scheduleBatchRender(): void {
        // Debounce: wait 16ms (one frame) to collect more tiles before rendering
        if (this.batchDebounceTimer !== null) {
            return; // Already scheduled
        }
        this.batchDebounceTimer = window.setTimeout(() => {
            this.batchDebounceTimer = null;
            this.processBatchRender();
        }, 16);
    }

    private async processBatchRender(): Promise<void> {
        if (this.isBatchRendering || this.pendingGlyphIds.size === 0) {
            return;
        }

        const batchSpanId = timelineSpanStart(
            'overview.outlines.processBatchRender',
            {
                pendingCount: this.pendingGlyphIds.size,
                batchSize: this.lazyBatchSize
            }
        );

        this.isBatchRendering = true;

        const batchSize = this.lazyBatchSize;
        const glyphIds = Array.from(this.pendingGlyphIds).slice(0, batchSize);
        glyphIds.forEach((id) => this.pendingGlyphIds.delete(id));

        // Build glyph name list
        const glyphNames: string[] = [];
        const glyphNameToTile: Map<string, GlyphTile> = new Map();
        for (const glyphId of glyphIds) {
            const tile = this.tiles.get(glyphId);
            // Check cachedData instead of canvas presence (canvas is now pre-created)
            if (tile && !tile.cachedData) {
                glyphNames.push(tile.glyphName);
                glyphNameToTile.set(tile.glyphName, tile);
            }
        }

        if (glyphNames.length === 0) {
            this.isBatchRendering = false;
            if (this.pendingGlyphIds.size > 0) {
                this.scheduleBatchRender();
            }
            timelineSpanEnd(batchSpanId);
            return;
        }

        try {
            const fontComp = window.fontCompilation;
            if (!fontComp) {
                throw new Error('fontCompilation not available on window');
            }
            const fetchBatchSpanId = timelineSpanStart(
                'overview.outlines.fetchBatch',
                {
                    glyphCount: glyphNames.length
                }
            );
            let response;
            try {
                response = await fontComp.sendMessage({
                    type: 'getGlyphOutlines',
                    glyphNames: glyphNames,
                    location: this.currentLocation,
                    flattenComponents: false // Don't flatten - preserve component structure with layerData
                });
            } finally {
                timelineSpanEnd(fetchBatchSpanId);
            }

            if (response.error) {
                throw new Error(response.error);
            }

            const parseBatchSpanId = timelineSpanStart(
                'overview.outlines.parseBatch',
                {
                    jsonBytes: response.outlinesJson.length,
                    glyphCount: glyphNames.length
                }
            );
            let outlines;
            try {
                outlines = JSON.parse(response.outlinesJson);
            } finally {
                timelineSpanEnd(parseBatchSpanId);
            }

            // Batch all renders in a single animation frame
            const dims = this.getTileDimensions();
            let renderDurationMs = 0;
            const renderBatchSpanId = timelineSpanStart(
                'overview.outlines.renderBatch',
                {
                    glyphCount: outlines.length
                }
            );
            await new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    const renderBatchFrameSpanId = timelineSpanStart(
                        'overview.outlines.renderBatchFrame',
                        {
                            glyphCount: outlines.length
                        }
                    );
                    const renderStart = performance.now();
                    outlines.forEach((glyphData: any) => {
                        const tile = glyphNameToTile.get(glyphData.name);
                        if (!tile) {
                            return;
                        }

                        const rendered = this.renderTileCanvas(
                            tile,
                            glyphData,
                            dims.width,
                            dims.height
                        );
                        if (rendered) {
                            tile.cachedData = glyphData; // Cache for resizing
                        } else {
                            this.pendingGlyphIds.add(tile.glyphId);
                        }
                    });

                    renderDurationMs = performance.now() - renderStart;
                    timelineSpanEnd(renderBatchFrameSpanId);
                    resolve();
                });
            });
            timelineSpanEnd(renderBatchSpanId);

            if (renderDurationMs > 18) {
                this.lazyBatchSize = Math.max(
                    this.minLazyBatchSize,
                    Math.floor(this.lazyBatchSize * 0.8)
                );
            } else if (renderDurationMs < 8) {
                this.lazyBatchSize = Math.min(
                    this.maxLazyBatchSize,
                    Math.ceil(this.lazyBatchSize * 1.15)
                );
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[GlyphOverview]', `Batch render failed: ${msg}`);
        }

        this.isBatchRendering = false;

        // Process remaining pending glyphs
        if (this.pendingGlyphIds.size > 0) {
            this.scheduleBatchRender();
        }

        timelineSpanEnd(batchSpanId);
    }

    private createGlyphTile(glyphId: string, glyphName: string): GlyphTile {
        const tileElement = document.createElement('div');
        tileElement.className = 'glyph-tile';
        tileElement.dataset.glyphId = glyphId;
        tileElement.dataset.glyphName = glyphName;
        if (glyphName === this.highlightedGlyphName) {
            tileElement.style.boxShadow = 'inset 0 0 0 2px var(--accent-blue)';
        }

        // Pre-create canvas to avoid DOM insertion during render
        const canvas = document.createElement('canvas');
        canvas.className = 'glyph-tile-canvas';
        tileElement.appendChild(canvas);

        // Create label for glyph name (display name, not ID)
        const label = document.createElement('div');
        label.className = 'glyph-tile-label';
        label.textContent = glyphName;
        label.title = glyphName; // Tooltip for truncated names

        tileElement.appendChild(label);

        // Click handler for selection
        tileElement.addEventListener('click', (e) => {
            // Don't handle click if view is not active
            if (!this.isViewActive()) {
                return;
            }
            // Don't handle click if a drag just occurred
            if (this.hasDragged) {
                return;
            }

            // Keep click immediate (no lag). For plain clicks, capture selection snapshot
            // so a following double-click can restore it.
            if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
                this.preDoubleClickSelectionGlyphIds = this.getSelectedGlyphs();
                this.preDoubleClickGlyphId = glyphId;
                this.preDoubleClickTimestamp = Date.now();
            }

            this.handleTileClick(glyphId, e);
        });

        // Double-click inserts explicit glyph token into text buffer
        tileElement.addEventListener('dblclick', (e) => {
            if (!this.isViewActive()) {
                return;
            }
            if (this.hasDragged) {
                return;
            }

            e.preventDefault();
            e.stopPropagation();

            if (this.shouldRestoreSelectionForDoubleClick(glyphId)) {
                this.applySelectionByGlyphIds(
                    this.preDoubleClickSelectionGlyphIds
                );
            }

            this.insertGlyphToken(glyphName);
        });

        return {
            element: tileElement,
            glyphId: glyphId,
            glyphName: glyphName,
            selected: false,
            canvas: canvas
        };
    }

    private handleTileClick(glyphId: string, event: MouseEvent): void {
        const tile = this.tiles.get(glyphId);
        if (!tile) return;

        // Track this glyph as the last clicked (for keyboard navigation reference)
        this.lastClickedGlyphId = glyphId;
        // Also set as keyboard anchor for shift+keyboard selection
        this.keyboardAnchorGlyphId = glyphId;

        if (event.shiftKey) {
            // Shift+click: range selection
            this.handleRangeSelection(glyphId);
        } else if (event.metaKey || event.ctrlKey) {
            // Cmd/Ctrl+click: toggle selection
            this.toggleSelection(glyphId);
        } else {
            // Regular click: select only this tile
            this.clearSelection();
            this.selectTile(glyphId);
        }
    }

    private shouldRestoreSelectionForDoubleClick(glyphId: string): boolean {
        const maxDelayMs = 500;
        return (
            this.preDoubleClickGlyphId === glyphId &&
            Date.now() - this.preDoubleClickTimestamp <= maxDelayMs
        );
    }

    private applySelectionByGlyphIds(glyphIds: string[]): void {
        const selectedSet = new Set(glyphIds);
        this.tiles.forEach((tile) => {
            const shouldBeSelected = selectedSet.has(tile.glyphId);
            if (tile.selected === shouldBeSelected) {
                return;
            }

            tile.selected = shouldBeSelected;
            tile.element.classList.toggle('selected', shouldBeSelected);
        });
        this.updateSelectedGlyphGroups();
    }

    private getSelectedGlyphNames(): string[] {
        return Array.from(this.tiles.values())
            .filter((tile) => tile.selected)
            .map((tile) => tile.glyphName);
    }

    private insertSelectedGlyphTokens(fallbackGlyphName?: string): void {
        const selectedGlyphNames = this.getSelectedGlyphNames();
        const glyphNamesToInsert =
            selectedGlyphNames.length > 0
                ? selectedGlyphNames
                : fallbackGlyphName
                  ? [fallbackGlyphName]
                  : [];

        if (!glyphNamesToInsert.length) {
            return;
        }

        const tokenText = glyphNamesToInsert
            .map((glyphName) => `/${glyphName}`)
            .join(' ');
        this.insertExplicitGlyphTokenText(`${tokenText} `);
    }

    private insertGlyphToken(glyphName: string): void {
        this.insertExplicitGlyphTokenText(`/${glyphName} `);
    }

    private insertExplicitGlyphTokenText(tokenText: string): void {
        const glyphCanvas = window.glyphCanvas;
        const textRunEditor = glyphCanvas?.textRunEditor;
        if (!textRunEditor) {
            console.warn(
                '[GlyphOverview]',
                'Cannot insert explicit glyph token: textRunEditor unavailable'
            );
            return;
        }

        if (
            glyphCanvas?.outlineEditor?.active &&
            typeof textRunEditor.insertTextAfterSelectedGlyph === 'function'
        ) {
            void textRunEditor.insertTextAfterSelectedGlyph(tokenText);
        } else {
            textRunEditor.insertText(tokenText);
        }
        console.log(
            '[GlyphOverview]',
            'Inserted explicit glyph token text:',
            tokenText
        );
    }

    private handleRangeSelection(glyphId: string): void {
        const selectedGlyphs = this.getSelectedGlyphs();
        if (selectedGlyphs.length === 0) {
            // No previous selection, just select this one
            this.selectTile(glyphId);
            return;
        }

        // Find range between last selected and current
        const glyphArray = this.getVisibleGlyphIds();
        const lastSelected = [...selectedGlyphs]
            .reverse()
            .find((id) => glyphArray.includes(id));
        if (!lastSelected) return;
        const startIdx = glyphArray.indexOf(lastSelected);
        const endIdx = glyphArray.indexOf(glyphId);

        if (startIdx === -1 || endIdx === -1) return;

        const [from, to] =
            startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];

        for (let i = from; i <= to; i++) {
            this.selectTile(glyphArray[i]);
        }
    }

    private toggleSelection(glyphId: string): void {
        const tile = this.tiles.get(glyphId);
        if (!tile) return;

        if (tile.selected) {
            this.deselectTile(glyphId);
        } else {
            this.selectTile(glyphId);
        }
    }

    private selectTile(glyphId: string): void {
        const tile = this.tiles.get(glyphId);
        if (!tile || tile.selected) return;

        tile.selected = true;
        tile.element.classList.add('selected');

        // Notify filter manager of selection change
        this.updateSelectedGlyphGroups();
    }

    private deselectTile(glyphId: string): void {
        const tile = this.tiles.get(glyphId);
        if (!tile || !tile.selected) return;

        tile.selected = false;
        tile.element.classList.remove('selected');

        // Notify filter manager of selection change
        this.updateSelectedGlyphGroups();
    }

    private clearSelection(): void {
        this.tiles.forEach((tile) => {
            if (tile.selected) {
                tile.selected = false;
                tile.element.classList.remove('selected');
            }
        });

        // Notify filter manager of selection change
        this.updateSelectedGlyphGroups();
    }

    private getSelectedGlyphs(): string[] {
        return Array.from(this.tiles.values())
            .filter((tile) => tile.selected)
            .map((tile) => tile.glyphId);
    }

    /**
     * Handle arrow key navigation for glyph selection
     * Navigates to adjacent glyphs based on visual grid layout
     * When shift is held, performs range selection from the anchor point
     */
    private handleArrowKeyNavigation(
        key: string,
        shiftKey: boolean = false
    ): void {
        const selectedGlyphs = this.getSelectedGlyphs();

        // Get the current glyph to navigate from
        let currentGlyphId: string | null = null;

        if (selectedGlyphs.length === 0) {
            // No selection yet, select the first visible glyph
            const firstVisibleTile = this.findFirstVisibleTile();
            if (firstVisibleTile) {
                if (shiftKey) {
                    // With shift, set anchor and select
                    this.keyboardAnchorGlyphId = firstVisibleTile.glyphId;
                }
                this.selectTile(firstVisibleTile.glyphId);
                this.scrollToTile(firstVisibleTile.element);
            }
            return;
        } else {
            // Use the appropriate selected glyph as reference based on direction
            if (key === 'ArrowLeft') {
                // When moving left, use the leftmost (first) selected glyph
                currentGlyphId = selectedGlyphs[0];
            } else if (key === 'ArrowRight') {
                // When moving right, use the rightmost (last) selected glyph
                currentGlyphId = selectedGlyphs[selectedGlyphs.length - 1];
            } else {
                // For up/down, prefer the last clicked glyph if it's in the selection
                // This handles shift+click range selections properly
                if (
                    this.lastClickedGlyphId &&
                    selectedGlyphs.includes(this.lastClickedGlyphId)
                ) {
                    currentGlyphId = this.lastClickedGlyphId;
                } else {
                    // Fall back to the rightmost selected glyph
                    currentGlyphId = selectedGlyphs[selectedGlyphs.length - 1];
                }
            }
        }

        if (!currentGlyphId) return;

        // Get all visible glyph IDs in order
        const visibleGlyphIds = this.getVisibleGlyphIds();
        if (visibleGlyphIds.length === 0) return;

        let targetGlyphId: string | null = null;

        if (this.viewMode === 'grid') {
            targetGlyphId = this.getGridNavigationTarget(currentGlyphId, key);
        } else {
            const columns = this.getGridColumns();
            if (columns === 0) return;

            const currentIndex = visibleGlyphIds.indexOf(currentGlyphId);
            if (currentIndex === -1) return;

            let targetIndex = -1;
            switch (key) {
                case 'ArrowRight':
                    targetIndex = currentIndex + 1;
                    break;
                case 'ArrowLeft':
                    targetIndex = currentIndex - 1;
                    break;
                case 'ArrowDown':
                    targetIndex = currentIndex + columns;
                    break;
                case 'ArrowUp':
                    targetIndex = currentIndex - columns;
                    break;
            }

            if (targetIndex >= 0 && targetIndex < visibleGlyphIds.length) {
                targetGlyphId = visibleGlyphIds[targetIndex];
            }
        }

        if (targetGlyphId) {
            const targetTile = this.tiles.get(targetGlyphId);
            if (!targetTile) return;

            if (shiftKey) {
                this.handleKeyboardRangeSelection(
                    targetGlyphId,
                    visibleGlyphIds
                );
            } else {
                this.clearSelection();
                this.selectTile(targetGlyphId);
                this.keyboardAnchorGlyphId = targetGlyphId;
            }

            this.lastClickedGlyphId = targetGlyphId;
            this.scrollToTile(targetTile.element);
        }
    }

    private getGridNavigationTarget(
        currentGlyphId: string,
        key: string
    ): string | null {
        const position = this.findGridPosition(currentGlyphId);
        if (!position) return null;

        const { row, column } = position;

        if (key === 'ArrowRight' || key === 'ArrowLeft') {
            const step = key === 'ArrowRight' ? 1 : -1;
            for (
                let col = column + step;
                col >= 0 && col < this.gridColumnCount;
                col += step
            ) {
                const glyphId = this.gridRowsForNavigation[row]?.[col] ?? null;
                if (glyphId) {
                    return glyphId;
                }
            }

            const visibleGlyphIds = this.getVisibleGlyphIds();
            const currentIndex = visibleGlyphIds.indexOf(currentGlyphId);
            if (currentIndex === -1) return null;
            const fallbackIndex =
                key === 'ArrowRight' ? currentIndex + 1 : currentIndex - 1;
            return visibleGlyphIds[fallbackIndex] ?? null;
        }

        const rowStep = key === 'ArrowDown' ? 1 : -1;
        for (
            let targetRow = row + rowStep;
            targetRow >= 0 && targetRow < this.gridRowsForNavigation.length;
            targetRow += rowStep
        ) {
            const glyphId =
                this.gridRowsForNavigation[targetRow]?.[column] ?? null;
            if (glyphId) {
                return glyphId;
            }
        }

        return null;
    }

    private findGridPosition(
        glyphId: string
    ): { row: number; column: number } | null {
        for (let row = 0; row < this.gridRowsForNavigation.length; row++) {
            const column = this.gridRowsForNavigation[row].indexOf(glyphId);
            if (column !== -1) {
                return { row, column };
            }
        }
        return null;
    }

    /**
     * Handle range selection for keyboard navigation (shift+arrow keys)
     * Selects all glyphs between the anchor and target, following the linear order
     * (like text selection: goes along the line, then wraps to next line)
     */
    private handleKeyboardRangeSelection(
        targetGlyphId: string,
        visibleGlyphIds: string[]
    ): void {
        // If no anchor is set, use the last clicked glyph or first selected
        if (!this.keyboardAnchorGlyphId) {
            const selectedGlyphs = this.getSelectedGlyphs();
            if (selectedGlyphs.length > 0) {
                this.keyboardAnchorGlyphId = selectedGlyphs[0];
            } else {
                // No anchor and no selection, just select the target
                this.selectTile(targetGlyphId);
                this.keyboardAnchorGlyphId = targetGlyphId;
                return;
            }
        }

        const anchorIndex = visibleGlyphIds.indexOf(this.keyboardAnchorGlyphId);
        const targetIndex = visibleGlyphIds.indexOf(targetGlyphId);

        if (anchorIndex === -1 || targetIndex === -1) return;

        // Clear current selection
        this.clearSelection();

        // Select all glyphs between anchor and target (inclusive)
        const [from, to] =
            anchorIndex < targetIndex
                ? [anchorIndex, targetIndex]
                : [targetIndex, anchorIndex];

        for (let i = from; i <= to; i++) {
            this.selectTile(visibleGlyphIds[i]);
        }
    }

    /**
     * Get the number of columns in the grid based on container width
     */
    private getGridColumns(): number {
        if (this.viewMode === 'grid' && this.gridColumnCount > 0) {
            return this.gridColumnCount;
        }

        if (!this.container) return 0;

        const containerWidth = this.container.clientWidth;
        const tileWidth = parseFloat(
            getComputedStyle(this.container).getPropertyValue('--tile-width') ||
                '30'
        );
        const gap = 2; // From CSS: gap: 2px
        const padding = 4; // From CSS: padding: 2px on each side

        if (tileWidth === 0) return 0;

        // Calculate how many tiles fit per row
        const availableWidth = containerWidth - padding;
        const columns = Math.floor((availableWidth + gap) / (tileWidth + gap));

        return Math.max(1, columns);
    }

    /**
     * Get an array of all visible (not hidden) glyph IDs in order
     */
    private getVisibleGlyphIds(): string[] {
        return [...this.visibleGlyphIds];
    }

    /**
     * Find the first visible tile in the grid
     */
    private findFirstVisibleTile(): GlyphTile | null {
        if (this.visibleGlyphIds.length === 0) {
            return null;
        }
        return this.tiles.get(this.visibleGlyphIds[0]) ?? null;
    }

    /**
     * Update the filter manager with groups of currently selected glyphs
     */
    public updateSelectedGlyphGroups(): void {
        if (!this.activeFilterResults) {
            // No filter active, nothing to update
            if (window.glyphOverviewFilterManager) {
                window.glyphOverviewFilterManager.updateSelectedGlyphGroups(
                    new Set()
                );
            }
            return;
        }

        // Build set of all groups that selected glyphs belong to
        const selectedGroups = new Set<string>();

        this.tiles.forEach((tile) => {
            if (tile.selected) {
                const result = this.activeFilterResults!.get(tile.glyphName);
                if (result && result.groups) {
                    result.groups.forEach((group) => selectedGroups.add(group));
                }
            }
        });

        // Notify filter manager
        if (window.glyphOverviewFilterManager) {
            window.glyphOverviewFilterManager.updateSelectedGlyphGroups(
                selectedGroups
            );
        }
    }

    // Drag selection handlers
    private onMouseDown(e: MouseEvent): void {
        // Don't allow drag selection if view is not active
        if (!this.isViewActive()) {
            return;
        }

        this.isDragging = true;
        this.hasDragged = false;
        const rect = this.container!.getBoundingClientRect();
        this.dragStartX = e.clientX - rect.left + this.container!.scrollLeft;
        this.dragStartY = e.clientY - rect.top + this.container!.scrollTop;

        // Clear selection if no modifier key (but only if we're dragging, not clicking a tile)
        // We'll handle this in onMouseMove when we know it's actually a drag
    }

    private onMouseMove(e: MouseEvent): void {
        if (!this.isDragging || !this.container) return;

        const rect = this.container.getBoundingClientRect();
        const currentX = e.clientX - rect.left + this.container.scrollLeft;
        const currentY = e.clientY - rect.top + this.container.scrollTop;

        // Check if we've moved enough to consider this a drag (not just a click)
        const deltaX = Math.abs(currentX - this.dragStartX);
        const deltaY = Math.abs(currentY - this.dragStartY);
        if (deltaX > 3 || deltaY > 3) {
            if (!this.hasDragged) {
                this.hasDragged = true;

                // Clear selection if no modifier key (now that we know it's a drag)
                if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
                    this.clearSelection();
                }
            }

            // Create selection box on first movement
            if (!this.selectionBox) {
                this.selectionBox = document.createElement('div');
                this.selectionBox.style.position = 'absolute';
                this.selectionBox.style.border =
                    '1px solid var(--accent-primary)';
                this.selectionBox.style.backgroundColor =
                    'rgba(var(--accent-primary-rgb), 0.1)';
                this.selectionBox.style.pointerEvents = 'none';
                this.container!.appendChild(this.selectionBox);
            }
        }

        if (!this.selectionBox) return;

        const left = Math.min(this.dragStartX, currentX);
        const top = Math.min(this.dragStartY, currentY);
        const width = Math.abs(currentX - this.dragStartX);
        const height = Math.abs(currentY - this.dragStartY);

        this.selectionBox.style.left = `${left}px`;
        this.selectionBox.style.top = `${top}px`;
        this.selectionBox.style.width = `${width}px`;
        this.selectionBox.style.height = `${height}px`;

        // Update selection based on intersection with tiles
        this.updateDragSelection(left, top, width, height);
    }

    private onMouseUp(e: MouseEvent): void {
        if (this.isDragging) {
            this.isDragging = false;
            if (this.selectionBox) {
                this.selectionBox.remove();
                this.selectionBox = null;
            }
        }
    }

    private updateDragSelection(
        boxLeft: number,
        boxTop: number,
        boxWidth: number,
        boxHeight: number
    ): void {
        const boxRight = boxLeft + boxWidth;
        const boxBottom = boxTop + boxHeight;

        this.tiles.forEach((tile) => {
            if (!tile.element.isConnected) {
                return;
            }

            const rect = tile.element.getBoundingClientRect();
            const containerRect = this.container!.getBoundingClientRect();

            const tileLeft =
                rect.left - containerRect.left + this.container!.scrollLeft;
            const tileTop =
                rect.top - containerRect.top + this.container!.scrollTop;
            const tileRight = tileLeft + rect.width;
            const tileBottom = tileTop + rect.height;

            // Check if tile intersects with selection box
            const intersects = !(
                boxRight < tileLeft ||
                boxLeft > tileRight ||
                boxBottom < tileTop ||
                boxTop > tileBottom
            );

            if (intersects && !tile.selected) {
                this.selectTile(tile.glyphId);
            }
        });
    }

    /**
     * Show a filter error overlay instead of glyphs
     * @param pluginName - Name of the plugin that errored
     * @param error - Error message or object
     */
    /**
     * Show a filter error overlay instead of glyphs
     * @param pluginName - Name of the plugin that errored
     * @param error - Error message or object
     * @param lineOffset - Number of wrapper lines to subtract from line numbers (for user code errors)
     * @param filePath - Optional file path for user filters (to enable "Fix with AI" button)
     * @param pythonCode - Optional Python code that caused the error
     */
    public showFilterError(
        pluginName: string,
        error: any,
        lineOffset: number = 0,
        filePath?: string,
        pythonCode?: string
    ): void {
        this.clearFilterError();

        // Create error overlay
        this.errorOverlay = document.createElement('div');
        this.errorOverlay.className = 'glyph-overview-error-overlay';

        const errorContent = document.createElement('div');
        errorContent.className = 'glyph-overview-error-content';

        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined glyph-overview-error-icon';
        icon.textContent = 'error';

        const title = document.createElement('div');
        title.className = 'glyph-overview-error-title';
        title.textContent = `Filter "${pluginName}" Error`;

        const message = document.createElement('pre');
        message.className = 'glyph-overview-error-message';
        // Extract error message
        let errorText = '';
        if (error instanceof Error) {
            // For PythonError from Pyodide, message already contains full Python traceback
            // Don't append stack (which contains JS/WASM traces)
            errorText = error.message;
            if (error.stack && error.constructor.name !== 'PythonError') {
                errorText += '\n\n' + error.stack;
            }
            // Clean Python traceback to remove Pyodide internal frames and adjust line numbers
            if (error.constructor.name === 'PythonError') {
                const tracebackCleaner =
                    typeof window !== 'undefined' &&
                    typeof window.cleanPythonTraceback === 'function'
                        ? window.cleanPythonTraceback
                        : null;
                if (tracebackCleaner) {
                    errorText = tracebackCleaner(errorText, {
                        lineOffset,
                        skipExecFrames: true
                    });
                }
            }
        } else if (typeof error === 'string') {
            errorText = error;
        } else if (error && error.toString) {
            errorText = error.toString();
        } else {
            errorText = JSON.stringify(error, null, 2);
        }
        message.textContent = errorText;

        errorContent.appendChild(icon);
        errorContent.appendChild(title);
        errorContent.appendChild(message);

        // Add "Fix error with assistant" button for user filters
        if (filePath && pythonCode) {
            const fixButton = document.createElement('button');
            fixButton.className = 'glyph-overview-fix-error-btn ai-btn';
            fixButton.innerHTML =
                '<span class="material-symbols-outlined">auto_fix_high</span>Fix error with assistant';
            fixButton.addEventListener('click', async () => {
                await this.fixFilterErrorWithAssistant(
                    filePath,
                    pythonCode,
                    errorText
                );
            });
            errorContent.appendChild(fixButton);
        }

        this.errorOverlay.appendChild(errorContent);

        // Hide tiles and show error
        if (this.container) {
            this.container.style.display = 'none';
            this.container.parentElement?.appendChild(this.errorOverlay);
        }
    }

    /**
     * Fix a filter error using the AI assistant
     */
    private async fixFilterErrorWithAssistant(
        filePath: string,
        pythonCode: string,
        errorTraceback: string
    ): Promise<void> {
        // Check if AI assistant is available
        if (!window.aiAssistant || !window.aiAssistant.sessionManager) {
            alert('AI Assistant not available');
            return;
        }

        const aiAssistant = window.aiAssistant;
        const sessionManager = aiAssistant.sessionManager;

        // Check if there's already a session linked to this file
        const currentLinkedPath = sessionManager.getLinkedFilePath();
        const hasExistingSession =
            currentLinkedPath === filePath && sessionManager.currentChatId;

        // Check if a chat already exists for this file path
        const existingChatId = sessionManager.getChatIdForFilePath(filePath);

        if (existingChatId && !hasExistingSession) {
            // Load existing chat for this file
            console.log(
                '[GlyphOverview] Loading existing chat for file:',
                filePath
            );
            await sessionManager.loadChatSession(existingChatId);
            sessionManager.setLinkedFilePath(filePath); // Re-link the file path
        } else if (!hasExistingSession) {
            // Start a new chat session for this file
            // Confirm if there's an active chat
            if (
                sessionManager.currentChatId &&
                aiAssistant.messages.length > 0
            ) {
                if (
                    !confirm(
                        'Start a new chat for this filter? The current chat will be saved.'
                    )
                ) {
                    return;
                }
            }

            // Reset chat state
            sessionManager.currentChatId = null;
            sessionManager.isContextLocked = true;
            sessionManager.setLinkedFilePath(filePath);
            aiAssistant.messages = [];
            aiAssistant.messagesContainer.innerHTML = '';
            localStorage.removeItem('ai_last_chat_id');

            // Set context to glyphfilter
            aiAssistant.setContext('glyphfilter');

            // Add a system message indicating the linked file
            const messageDiv = document.createElement('div');
            messageDiv.className = 'ai-message ai-message-system';

            const fileName = filePath.split('/').pop();
            messageDiv.innerHTML = `
                <div class="ai-system-message">
                    <span class="ai-context-display-icon ai-context-tag-glyphfilter"><span class="material-symbols-outlined">filter_alt</span></span>
                    <div>
                        <strong>Glyph Filter Context selected</strong>
                        <p>Creating or editing glyph filter: ${fileName}</p>
                    </div>
                </div>
            `;

            aiAssistant.messagesContainer.appendChild(messageDiv);
            sessionManager.updateFilePathDisplay();
            aiAssistant.scrollToBottom();
        }

        // Switch to assistant view
        const assistantView = document.getElementById('view-assistant');
        if (assistantView) {
            assistantView.click();
        }

        // Send error fix message
        const fixPrompt = `The filter script has an error. Here is the current code:\n\n\`\`\`python\n${pythonCode}\n\`\`\`\n\nError traceback:\n\`\`\`\n${errorTraceback}\n\`\`\`\n\nPlease fix the error and provide the corrected code.`;

        // Set the prompt and trigger send
        aiAssistant.promptInput.value = fixPrompt;
        await aiAssistant.sendMessage();

        console.log('[GlyphOverview] Sent error fix request to AI assistant');
    }

    /**
     * Show a filter notice overlay (info, not error)
     * @param pluginName - Name of the plugin
     * @param message - Notice message to display
     * @param type - 'info' or 'warning'
     */
    public showFilterNotice(
        pluginName: string,
        message: string,
        type: 'info' | 'warning' = 'info'
    ): void {
        this.clearFilterError();

        // Create notice overlay
        this.errorOverlay = document.createElement('div');
        this.errorOverlay.className = `glyph-overview-error-overlay glyph-overview-notice-${type}`;

        const noticeContent = document.createElement('div');
        noticeContent.className = 'glyph-overview-error-content';

        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined glyph-overview-error-icon';
        icon.textContent = type === 'warning' ? 'warning' : 'info';

        const title = document.createElement('div');
        title.className = 'glyph-overview-error-title';
        title.textContent = `Filter "${pluginName}"`;

        const messageEl = document.createElement('div');
        messageEl.className =
            'glyph-overview-error-message glyph-overview-notice-message';
        messageEl.textContent = message;

        noticeContent.appendChild(icon);
        noticeContent.appendChild(title);
        noticeContent.appendChild(messageEl);
        this.errorOverlay.appendChild(noticeContent);

        // Hide tiles and show notice
        if (this.container) {
            this.container.style.display = 'none';
            this.container.parentElement?.appendChild(this.errorOverlay);
        }
    }

    /**
     * Clear the filter error overlay and show tiles again
     */
    public clearFilterError(): void {
        if (this.errorOverlay) {
            this.errorOverlay.remove();
            this.errorOverlay = null;
        }
        if (this.container) {
            this.container.style.display = '';
        }
    }

    /**
     * Set the active filter and apply visibility/colors
     * @param results - Array of filter results or null to clear filter
     */
    public setActiveFilter(results: FilterResult[] | null): void {
        const filterSpanId = timelineSpanStart('overview.setActiveFilter', {
            resultCount: results?.length ?? 0,
            tileCount: this.tiles.size
        });

        // Clear any previous error
        this.clearFilterError();

        if (results === null) {
            if (this.activeFilterResults === null) {
                timelineSpanEnd(filterSpanId);
                return;
            }

            // Clear filter
            this.activeFilterResults = null;
            this.clearFilterColors();
        } else {
            // Build map for fast lookup by glyph name
            this.activeFilterResults = new Map();
            for (const result of results) {
                this.activeFilterResults.set(result.glyph_name, result);
            }
            this.applyFilterColors();
        }

        // Re-apply combined filter + search
        this.applySearchFilter();

        const hasRenderedTiles = Array.from(this.tiles.values()).some(
            (tile) => !!tile.cachedData
        );
        if (this.tiles.size > 0 && !hasRenderedTiles) {
            void this.renderGlyphOutlines(this.currentLocation);
        }

        timelineSpanEnd(filterSpanId);
    }

    /**
     * Apply filter colors to tiles as background overlay
     * For glyphs with multiple groups, displays horizontal stripes
     */
    private applyFilterColors(): void {
        if (!this.activeFilterResults) return;

        this.tiles.forEach((tile) => {
            const result = this.activeFilterResults!.get(tile.glyphName);
            if (result && result.colors && result.colors.length > 0) {
                // Deduplicate colors while preserving order
                const uniqueColors = [...new Set(result.colors)];
                tile.filterColors = uniqueColors;
                tile.filterColor = uniqueColors[0];

                if (uniqueColors.length === 1) {
                    // Single color - use solid background
                    tile.element.style.setProperty(
                        '--filter-color',
                        this.cssColorToRgba(uniqueColors[0], 0.25)
                    );
                    tile.element.style.backgroundImage = 'none';
                } else {
                    // Multiple colors - create horizontal stripe gradient
                    const stripeGradient = this.buildStripeGradient(
                        uniqueColors,
                        0.25
                    );
                    tile.element.style.setProperty(
                        '--filter-color',
                        'transparent'
                    );
                    tile.element.style.backgroundImage = stripeGradient;
                }
            } else if (result && result.color) {
                // Fallback to single color if colors array not present
                tile.filterColor = result.color;
                tile.filterColors = [result.color];
                tile.element.style.setProperty(
                    '--filter-color',
                    this.cssColorToRgba(result.color, 0.25)
                );
                tile.element.style.backgroundImage = 'none';
            } else {
                tile.filterColor = undefined;
                tile.filterColors = undefined;
                tile.element.style.setProperty('--filter-color', 'transparent');
                tile.element.style.backgroundImage = 'none';
            }
        });
    }

    /**
     * Build a horizontal stripe gradient from multiple colors
     */
    private buildStripeGradient(colors: string[], alpha: number): string {
        const stripeCount = colors.length;
        const stripePercent = 100 / stripeCount;
        const stops: string[] = [];

        colors.forEach((color, index) => {
            const rgbaColor = this.cssColorToRgba(color, alpha);
            const startPercent = index * stripePercent;
            const endPercent = (index + 1) * stripePercent;
            // Hard stops for crisp stripes (no blending between colors)
            stops.push(`${rgbaColor} ${startPercent}%`);
            stops.push(`${rgbaColor} ${endPercent}%`);
        });

        return `linear-gradient(to right, ${stops.join(', ')})`;
    }

    /**
     * Clear filter colors from all tiles
     */
    private clearFilterColors(): void {
        this.tiles.forEach((tile) => {
            tile.filterColor = undefined;
            tile.filterColors = undefined;
            tile.element.style.setProperty('--filter-color', 'transparent');
            tile.element.style.backgroundImage = 'none';
        });
    }

    /**
     * Convert any CSS color to rgba with alpha
     * Handles: hex (#fff, #ffffff), rgb(), rgba(), hsl(), hsla(), named colors (red, blue, etc.)
     */
    private cssColorToRgba(color: string, alpha: number): string {
        // Use a temporary element to parse CSS colors
        const tempEl = document.createElement('div');
        tempEl.style.color = color;
        document.body.appendChild(tempEl);

        // Get computed color (always returns rgb/rgba format)
        const computedColor = getComputedStyle(tempEl).color;
        document.body.removeChild(tempEl);

        // Parse rgb/rgba values
        const match = computedColor.match(
            /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/
        );

        if (match) {
            const r = match[1];
            const g = match[2];
            const b = match[3];
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }

        // Fallback: return transparent if parsing fails
        return 'transparent';
    }

    public getRenderStatus(): {
        tileCount: number;
        renderedTileCount: number;
        pendingGlyphCount: number;
        isBatchRendering: boolean;
    } {
        const renderedTileCount = Array.from(this.tiles.values()).filter(
            (tile) => !!tile.cachedData
        ).length;

        return {
            tileCount: this.tiles.size,
            renderedTileCount,
            pendingGlyphCount: this.pendingGlyphIds.size,
            isBatchRendering: this.isBatchRendering
        };
    }

    public async ensureTilesRendered(
        minRenderedTiles: number = 3
    ): Promise<void> {
        if (!this.container || this.tiles.size === 0) {
            return;
        }

        const target = Math.max(1, minRenderedTiles);
        const timeoutMs = 10000;
        const start = performance.now();

        while (performance.now() - start < timeoutMs) {
            const status = this.getRenderStatus();
            if (status.renderedTileCount >= target) {
                return;
            }

            await this.processBatchRender();

            await new Promise<void>((resolve) => {
                requestAnimationFrame(() => resolve());
            });
        }
    }

    public destroy(): void {
        if (this.intersectionObserver) {
            this.intersectionObserver.disconnect();
            this.intersectionObserver = null;
        }
        if (this.pendingChangedGlyphRefreshTimer !== null) {
            clearTimeout(this.pendingChangedGlyphRefreshTimer);
            this.pendingChangedGlyphRefreshTimer = null;
        }
        window.removeEventListener(
            'glyphChanged',
            this.onGlyphChanged.bind(this)
        );
        if (this.container) {
            this.container.remove();
        }
        this.tiles.clear();
    }
}

// Export for use in overview-view
(window as any).GlyphOverview = GlyphOverview;
