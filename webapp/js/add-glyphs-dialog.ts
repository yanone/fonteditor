import { Font } from './babelfont-model';
import {
    glyphDataPluginManager,
    type GlyphDataSearchResult
} from './glyph-data-plugin-manager';
import { Logger } from './logger';

const console = new Logger('AddGlyphsDialog');

/**
 * Searches the bundled Unicode data and adds selected records to the font.
 * This intentionally has independent state from Find Glyph, whose list is
 * limited to glyphs already present in the current font.
 */
export class AddGlyphsDialog {
    private readonly modal = document.getElementById('add-glyphs-modal');
    private readonly content = document.getElementById(
        'add-glyphs-modal-content'
    );
    private searchInput: HTMLInputElement | null = null;
    private list: HTMLElement | null = null;
    private confirmButton: HTMLButtonElement | null = null;
    private results: GlyphDataSearchResult[] = [];
    private selectedCodepoints = new Set<number>();
    private activeIndex = -1;
    private selectionAnchor = -1;

    constructor() {
        this.buildContent();
        this.registerEvents();
    }

    async open(): Promise<void> {
        if (!this.modal || !this.searchInput) {
            return;
        }
        this.modal.style.display = 'flex';
        this.searchInput.disabled = true;
        this.searchInput.placeholder = 'Loading Glyph Data…';
        try {
            await glyphDataPluginManager.ensureReady();
            this.searchInput.disabled = false;
            this.searchInput.placeholder =
                'Search glyph names, Unicode names, characters, or U+ codepoints.';
            this.updateResults();
            requestAnimationFrame(() => this.searchInput?.focus());
        } catch (error) {
            console.error('Could not load Glyph Data', error);
            this.searchInput.placeholder = 'Glyph Data could not be loaded.';
        }
    }

    isOpen(): boolean {
        return this.modal?.style.display === 'flex';
    }

    private close(): void {
        if (this.modal) {
            this.modal.style.display = 'none';
        }
    }

    private buildContent(): void {
        if (!this.content) {
            return;
        }
        const search = document.createElement('div');
        search.className = 'find-glyph-search overview-search-control';
        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined overview-search-icon';
        icon.textContent = 'search';
        search.appendChild(icon);

        this.searchInput = document.createElement('input');
        this.searchInput.className = 'find-glyph-search-input';
        this.searchInput.type = 'search';
        this.searchInput.setAttribute('aria-label', 'Search glyph data');
        search.appendChild(this.searchInput);

        this.list = document.createElement('div');
        this.list.className = 'add-glyph-list';
        this.list.setAttribute('role', 'listbox');
        this.list.setAttribute('aria-multiselectable', 'true');

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
        this.confirmButton.addEventListener('click', () => this.addSelected());
        actions.appendChild(this.confirmButton);
        this.content.replaceChildren(search, this.list, actions);
        this.syncConfirmButton();
    }

    private registerEvents(): void {
        const close = document.getElementById('add-glyphs-modal-close-btn');
        close?.addEventListener('click', () => this.close());
        this.modal?.addEventListener('click', (event) => {
            if (event.target === this.modal) {
                this.close();
            }
        });
        this.searchInput?.addEventListener('input', () => this.updateResults());
        document.addEventListener(
            'keydown',
            (event) => {
                if (!this.isOpen()) {
                    return;
                }
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    this.close();
                } else if (
                    event.key === 'ArrowDown' ||
                    event.key === 'ArrowUp'
                ) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    this.moveActive(
                        event.key === 'ArrowDown' ? 1 : -1,
                        event.shiftKey
                    );
                } else if (event.key === ' ') {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    this.toggleActive();
                } else if (event.key === 'Enter') {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    this.addSelected();
                }
            },
            true
        );
    }

    private updateResults(): void {
        const query = this.searchInput?.value || '';
        this.results = glyphDataPluginManager.search(query);
        this.selectedCodepoints.clear();
        this.activeIndex = this.results.length ? 0 : -1;
        this.selectionAnchor = this.activeIndex;
        this.renderResults();
    }

    private renderResults(): void {
        if (!this.list) {
            return;
        }
        const font = window.currentFontModel;
        const fragment = document.createDocumentFragment();
        this.results.forEach((record, index) => {
            const existing = font?.findGlyphByCodepoint(record.codepoint);
            const nameCollision = font?.findGlyph(record.glyph_name);
            const unavailable = Boolean(existing || nameCollision);
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'add-glyph-row';
            row.classList.toggle('is-active', index === this.activeIndex);
            row.classList.toggle(
                'is-selected',
                this.selectedCodepoints.has(record.codepoint)
            );
            row.disabled = unavailable;
            row.setAttribute('role', 'option');
            row.setAttribute(
                'aria-selected',
                String(this.selectedCodepoints.has(record.codepoint))
            );
            row.addEventListener('click', (event) =>
                this.selectRow(
                    index,
                    event.shiftKey,
                    event.metaKey || event.ctrlKey
                )
            );

            const preview = document.createElement('span');
            preview.className = 'add-glyph-preview';
            preview.textContent = record.general_category.startsWith('M')
                ? `\u25cc${record.character}`
                : record.character || '—';
            row.appendChild(preview);

            const details = document.createElement('span');
            details.className = 'add-glyph-details';
            const name = document.createElement('strong');
            name.textContent = record.glyph_name;
            details.appendChild(name);
            const unicodeName = document.createElement('span');
            unicodeName.textContent = record.name;
            details.appendChild(unicodeName);
            row.appendChild(details);

            const properties = document.createElement('span');
            properties.className = 'add-glyph-properties';
            const extras = [
                `U+${record.codepoint.toString(16).toUpperCase().padStart(4, '0')}`,
                record.script,
                record.general_category,
                record.joining_type ? `join ${record.joining_type}` : ''
            ].filter(Boolean);
            properties.textContent = existing
                ? 'Already in font'
                : nameCollision
                  ? 'Glyph name already in font'
                  : extras.join(' · ');
            row.appendChild(properties);
            fragment.appendChild(row);
        });
        this.list.replaceChildren(fragment);
        this.syncConfirmButton();
    }

    private selectRow(index: number, range: boolean, toggle: boolean): void {
        const record = this.results[index];
        if (!record || this.isUnavailable(record)) {
            return;
        }
        this.activeIndex = index;
        if (range && this.selectionAnchor >= 0) {
            this.selectedCodepoints.clear();
            const [start, end] = [this.selectionAnchor, index].sort(
                (a, b) => a - b
            );
            for (let candidate = start; candidate <= end; candidate += 1) {
                const codepoint = this.results[candidate]!.codepoint;
                if (!this.isUnavailable(this.results[candidate]!)) {
                    this.selectedCodepoints.add(codepoint);
                }
            }
        } else if (toggle) {
            if (this.selectedCodepoints.has(record.codepoint)) {
                this.selectedCodepoints.delete(record.codepoint);
            } else {
                this.selectedCodepoints.add(record.codepoint);
            }
            this.selectionAnchor = index;
        } else {
            this.selectedCodepoints = new Set([record.codepoint]);
            this.selectionAnchor = index;
        }
        this.renderResults();
    }

    private moveActive(delta: number, extend: boolean): void {
        const next = this.activeIndex + delta;
        if (next < 0 || next >= this.results.length) {
            return;
        }
        this.selectRow(next, extend, false);
        this.list?.children[next]?.scrollIntoView({ block: 'nearest' });
    }

    private toggleActive(): void {
        if (this.activeIndex >= 0) {
            this.selectRow(this.activeIndex, false, true);
        }
    }

    private syncConfirmButton(): void {
        if (!this.confirmButton) {
            return;
        }
        const count = this.selectedCodepoints.size;
        this.confirmButton.disabled = count === 0;
        this.confirmButton.textContent =
            count === 1 ? 'Add Glyph' : `Add ${count} Glyphs`;
    }

    private isUnavailable(record: GlyphDataSearchResult): boolean {
        const font = window.currentFontModel;
        return Boolean(
            font?.findGlyphByCodepoint(record.codepoint) ||
            font?.findGlyph(record.glyph_name)
        );
    }

    private addSelected(): void {
        const font = window.currentFontModel as Font | null;
        if (!font || this.selectedCodepoints.size === 0) {
            return;
        }
        const selected = this.results.filter((record) =>
            this.selectedCodepoints.has(record.codepoint)
        );
        const existingNames = new Set(font.glyphs.map((glyph) => glyph.name));
        const additions = selected.filter(
            (record) =>
                !font.findGlyphByCodepoint(record.codepoint) &&
                !existingNames.has(record.glyph_name)
        );
        font.addGlyphs(
            additions.map((record) => ({
                name: record.glyph_name,
                codepoints: [record.codepoint],
                category: record.general_category.startsWith('M')
                    ? 'Mark'
                    : 'Base'
            }))
        );
        this.close();
    }
}

window.addGlyphsDialog = new AddGlyphsDialog();
