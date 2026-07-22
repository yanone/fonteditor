import { fastGlyphTileRenderer } from './glyph-tile-renderer-fast';
import {
    glyphNameMatchesSearchTerms,
    parseGlyphSearchTerms
} from './glyph-search';
import { Logger } from './logger';

const console = new Logger('FindGlyphDialog');

interface FindableGlyph {
    name: string;
    codepoints?: readonly number[];
}

interface FontGlyphSource {
    glyphs?: readonly FindableGlyph[];
}

interface GlyphOutlineResponse {
    outlinesJson: string;
    error?: string;
}

interface FontCompilationMessenger {
    sendMessage(message: {
        type: 'getGlyphOutlines';
        glyphNames: string[];
        location: Record<string, number>;
        flattenComponents: boolean;
    }): Promise<GlyphOutlineResponse>;
}

export type GlyphSelectionMode = 'single' | 'multiple';

export interface FindGlyphDialogOptions {
    selectionMode?: GlyphSelectionMode;
    selectedGlyphNames?: readonly string[];
    confirmLabel?: string;
    onConfirm?: (glyphNames: string[]) => void;
}

type GlyphOutlineData = Parameters<
    typeof fastGlyphTileRenderer.renderToCanvas
>[0];

function isGlyphOutlineData(value: unknown): value is GlyphOutlineData {
    if (!value || typeof value !== 'object' || !('name' in value)) {
        return false;
    }

    return typeof (value as { name?: unknown }).name === 'string';
}

/**
 * Return the current font's glyphs in their stored font order.
 */
function getCurrentFontGlyphs(): FindableGlyph[] {
    const fontModel = (
        window as Window & {
            currentFontModel?: FontGlyphSource;
        }
    ).currentFontModel;
    return fontModel?.glyphs ? Array.from(fontModel.glyphs) : [];
}

/**
 * Format assigned codepoints for the glyph list's secondary label.
 */
function formatUnicodeValue(codepoints?: readonly number[]): string | null {
    const values = codepoints?.filter(Number.isInteger) ?? [];
    if (!values.length) {
        return null;
    }

    return values
        .map(
            (codepoint) =>
                `U+${codepoint.toString(16).toUpperCase().padStart(4, '0')}`
        )
        .join(' ');
}

/**
 * A virtualized dialog for finding glyphs in the current font.
 */
export class FindGlyphDialog {
    private readonly modal: HTMLElement | null;
    private readonly closeButton: HTMLButtonElement | null;
    private readonly openButton: HTMLButtonElement | null;
    private readonly content: HTMLElement | null;
    private searchInput: HTMLInputElement | null = null;
    private list: HTMLDivElement | null = null;
    private confirmButton: HTMLButtonElement | null = null;
    private glyphs: FindableGlyph[] = [];
    private visibleGlyphs: FindableGlyph[] = [];
    private searchTerms: string[] = [];
    private selectionMode: GlyphSelectionMode = 'single';
    private selectedGlyphNames = new Set<string>();
    private onConfirm: ((glyphNames: string[]) => void) | null = null;
    private previewCanvases = new Map<string, HTMLCanvasElement>();
    private outlineCache = new Map<string, GlyphOutlineData>();
    private pendingGlyphNames = new Set<string>();
    private previewRenderQueued = false;
    private renderedRange: { start: number; end: number } | null = null;
    private readonly rowHeight = 68;
    private readonly overscanRows = 6;

    constructor() {
        this.modal = document.getElementById('find-glyph-modal');
        this.closeButton = document.getElementById(
            'find-glyph-modal-close-btn'
        ) as HTMLButtonElement | null;
        this.openButton = document.getElementById(
            'find-glyph-btn'
        ) as HTMLButtonElement | null;
        this.content = document.getElementById('find-glyph-modal-content');

        this.buildContent();
        this.registerEvents();
    }

    /**
     * Open the dialog with configurable single or multiple glyph selection.
     */
    public open(options: FindGlyphDialogOptions = {}): void {
        if (!this.modal) {
            return;
        }

        this.glyphs = getCurrentFontGlyphs();
        this.selectionMode = options.selectionMode ?? 'single';
        this.selectedGlyphNames = new Set(
            (options.selectedGlyphNames ?? []).filter((glyphName) =>
                this.glyphs.some((glyph) => glyph.name === glyphName)
            )
        );
        if (
            this.selectionMode === 'single' &&
            this.selectedGlyphNames.size > 1
        ) {
            const [firstSelectedGlyphName] = this.selectedGlyphNames;
            if (firstSelectedGlyphName) {
                this.selectedGlyphNames = new Set([firstSelectedGlyphName]);
            }
        }
        this.onConfirm = options.onConfirm ?? null;
        this.confirmButton!.textContent = options.confirmLabel ?? 'Select';
        this.syncConfirmButton();
        this.searchTerms = [];
        this.visibleGlyphs = [...this.glyphs];
        this.outlineCache.clear();
        this.pendingGlyphNames.clear();
        this.searchInput!.value = '';
        this.list!.scrollTop = 0;
        this.renderedRange = null;
        this.modal.style.display = 'flex';
        this.renderVisibleWindow(true);
        requestAnimationFrame(() => this.searchInput?.focus());
    }

    /**
     * Close the Find Glyph dialog.
     */
    public close(): void {
        if (this.modal) {
            this.modal.style.display = 'none';
        }
    }

    /**
     * Build the reusable dialog's search and virtual-list content.
     */
    private buildContent(): void {
        if (!this.content) {
            return;
        }

        const search = document.createElement('div');
        search.className = 'find-glyph-search overview-search-control';

        const searchIcon = document.createElement('span');
        searchIcon.className = 'material-symbols-outlined overview-search-icon';
        searchIcon.textContent = 'search';
        search.appendChild(searchIcon);

        this.searchInput = document.createElement('input');
        this.searchInput.className = 'find-glyph-search-input';
        this.searchInput.type = 'search';
        this.searchInput.placeholder = 'Search glyph names';
        this.searchInput.setAttribute('aria-label', 'Search glyph names');
        search.appendChild(this.searchInput);

        this.list = document.createElement('div');
        this.list.className = 'find-glyph-list';
        this.list.setAttribute('role', 'list');

        this.content.replaceChildren(search, this.list);

        const actions = document.createElement('div');
        actions.className = 'find-glyph-actions';

        const cancel = document.createElement('button');
        cancel.className = 'ai-login-button';
        cancel.type = 'button';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => this.close());
        actions.appendChild(cancel);

        this.confirmButton = document.createElement('button');
        this.confirmButton.className = 'ai-login-button';
        this.confirmButton.type = 'button';
        this.confirmButton.addEventListener('click', () =>
            this.confirmSelection()
        );
        actions.appendChild(this.confirmButton);

        this.content.replaceChildren(search, this.list, actions);
    }

    /**
     * Connect dialog controls and keyboard behavior.
     */
    private registerEvents(): void {
        this.openButton?.addEventListener('click', () => this.open());
        this.closeButton?.addEventListener('click', () => this.close());
        this.modal?.addEventListener('click', (event) => {
            if (event.target === this.modal) {
                this.close();
            }
        });
        this.searchInput?.addEventListener('input', () => {
            this.searchTerms = parseGlyphSearchTerms(this.searchInput!.value);
            this.visibleGlyphs = this.glyphs.filter((glyph) =>
                glyphNameMatchesSearchTerms(glyph.name, this.searchTerms)
            );
            this.list!.scrollTop = 0;
            this.renderedRange = null;
            this.renderVisibleWindow(true);
        });
        this.list?.addEventListener('scroll', () => this.renderVisibleWindow());
        document.addEventListener('keydown', (event) => {
            if (
                event.key === 'Escape' &&
                this.modal?.style.display === 'flex'
            ) {
                event.preventDefault();
                this.close();
            }
        });
    }

    /**
     * Mount only the visible rows, preserving total scroll height with spacers.
     */
    private renderVisibleWindow(force: boolean = false): void {
        if (!this.list) {
            return;
        }

        const total = this.visibleGlyphs.length;
        if (!total) {
            this.renderedRange = { start: 0, end: 0 };
            this.list.replaceChildren(this.createEmptyState());
            return;
        }

        const start = Math.max(
            0,
            Math.floor(this.list.scrollTop / this.rowHeight) - this.overscanRows
        );
        const end = Math.min(
            total,
            Math.ceil(
                (this.list.scrollTop + this.list.clientHeight) / this.rowHeight
            ) + this.overscanRows
        );

        if (
            !force &&
            this.renderedRange?.start === start &&
            this.renderedRange.end === end
        ) {
            return;
        }

        this.renderedRange = { start, end };
        this.previewCanvases.clear();
        const fragment = document.createDocumentFragment();
        this.appendSpacer(fragment, start * this.rowHeight);

        for (let index = start; index < end; index += 1) {
            fragment.appendChild(
                this.createGlyphRow(this.visibleGlyphs[index])
            );
        }

        this.appendSpacer(fragment, (total - end) * this.rowHeight);
        this.list.replaceChildren(fragment);
        this.queueVisiblePreviewRender();
    }

    /**
     * Add a virtual-list spacer only when it has height.
     */
    private appendSpacer(fragment: DocumentFragment, height: number): void {
        if (height <= 0) {
            return;
        }

        const spacer = document.createElement('div');
        spacer.className = 'find-glyph-spacer';
        spacer.style.height = `${height}px`;
        fragment.appendChild(spacer);
    }

    /**
     * Create one glyph's preview and metadata row.
     */
    private createGlyphRow(glyph: FindableGlyph): HTMLDivElement {
        const row = document.createElement('div');
        row.className = 'find-glyph-row';
        row.dataset.glyphName = glyph.name;
        row.setAttribute('role', 'listitem');
        row.tabIndex = 0;
        const selected = this.selectedGlyphNames.has(glyph.name);
        row.setAttribute('aria-selected', String(selected));
        row.addEventListener('click', () =>
            this.toggleGlyphSelection(glyph.name)
        );
        row.addEventListener('dblclick', () => {
            this.selectGlyphForDefaultAction(glyph.name);
            this.confirmSelection();
        });
        row.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.toggleGlyphSelection(glyph.name);
            }
        });

        const canvas = document.createElement('canvas');
        canvas.className = 'find-glyph-preview';
        canvas.setAttribute('aria-hidden', 'true');
        row.appendChild(canvas);
        this.previewCanvases.set(glyph.name, canvas);

        const details = document.createElement('div');
        details.className = 'find-glyph-details';

        const name = document.createElement('div');
        name.className = 'find-glyph-name';
        name.textContent = glyph.name;
        details.appendChild(name);

        const unicode = formatUnicodeValue(glyph.codepoints);
        if (unicode) {
            const value = document.createElement('div');
            value.className = 'find-glyph-unicode';
            value.textContent = unicode;
            details.appendChild(value);
        }

        row.appendChild(details);
        return row;
    }

    /**
     * Update selection for a clicked glyph according to the configured mode.
     */
    private toggleGlyphSelection(glyphName: string): void {
        if (this.selectionMode === 'single') {
            this.selectedGlyphNames = new Set([glyphName]);
        } else if (this.selectedGlyphNames.has(glyphName)) {
            this.selectedGlyphNames.delete(glyphName);
        } else {
            this.selectedGlyphNames.add(glyphName);
        }

        this.syncConfirmButton();
        this.renderVisibleWindow(true);
    }

    /**
     * Include a glyph in the current selection before invoking the default action.
     */
    private selectGlyphForDefaultAction(glyphName: string): void {
        if (this.selectionMode === 'single') {
            this.selectedGlyphNames = new Set([glyphName]);
        } else {
            this.selectedGlyphNames.add(glyphName);
        }

        this.syncConfirmButton();
    }

    /**
     * Enable confirmation only when the user has selected at least one glyph.
     */
    private syncConfirmButton(): void {
        if (this.confirmButton) {
            this.confirmButton.disabled = this.selectedGlyphNames.size === 0;
        }
    }

    /**
     * Confirm selected glyphs in their stored font order and close the dialog.
     */
    private confirmSelection(): void {
        const glyphNames = this.glyphs
            .filter((glyph) => this.selectedGlyphNames.has(glyph.name))
            .map((glyph) => glyph.name);
        if (!glyphNames.length) {
            return;
        }

        this.onConfirm?.(glyphNames);
        this.close();
    }

    /**
     * Create the list state shown when no glyph names match the search.
     */
    private createEmptyState(): HTMLDivElement {
        const empty = document.createElement('div');
        empty.className = 'find-glyph-empty';
        empty.textContent = 'No matching glyphs';
        return empty;
    }

    /**
     * Schedule one frame of preview work for currently mounted glyph rows.
     */
    private queueVisiblePreviewRender(): void {
        if (this.previewRenderQueued) {
            return;
        }

        this.previewRenderQueued = true;
        requestAnimationFrame(() => {
            this.previewRenderQueued = false;
            void this.renderVisiblePreviews();
        });
    }

    /**
     * Fetch and draw outlines only for glyph rows currently mounted in the list.
     */
    private async renderVisiblePreviews(): Promise<void> {
        const glyphNames = Array.from(this.previewCanvases.keys()).filter(
            (glyphName) =>
                !this.outlineCache.has(glyphName) &&
                !this.pendingGlyphNames.has(glyphName)
        );
        if (!glyphNames.length) {
            this.drawCachedPreviews();
            return;
        }

        const fontCompilation = (
            window as Window & {
                fontCompilation?: FontCompilationMessenger;
            }
        ).fontCompilation;
        if (!fontCompilation) {
            return;
        }

        glyphNames.forEach((glyphName) =>
            this.pendingGlyphNames.add(glyphName)
        );
        try {
            const response = await fontCompilation.sendMessage({
                type: 'getGlyphOutlines',
                glyphNames,
                location: {},
                flattenComponents: false
            });
            if (response.error) {
                throw new Error(response.error);
            }

            const parsed: unknown = JSON.parse(response.outlinesJson);
            const outlines = Array.isArray(parsed)
                ? parsed.filter(isGlyphOutlineData)
                : [];
            outlines.forEach((outline) =>
                this.outlineCache.set(outline.name, outline)
            );
            this.drawCachedPreviews();
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            console.warn('Could not render glyph previews', message);
        } finally {
            glyphNames.forEach((glyphName) =>
                this.pendingGlyphNames.delete(glyphName)
            );
        }
    }

    /**
     * Draw cached outlines into the canvases that remain mounted in the list.
     */
    private drawCachedPreviews(): void {
        this.previewCanvases.forEach((canvas, glyphName) => {
            const outline = this.outlineCache.get(glyphName);
            if (!outline || !canvas.isConnected) {
                return;
            }

            fastGlyphTileRenderer.renderToCanvas(
                outline,
                undefined,
                52,
                52,
                canvas
            );
        });
    }
}

window.findGlyphDialog = new FindGlyphDialog();
