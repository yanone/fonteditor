import type { ChangeLogEntry } from './change-log';
import { Logger } from './logger';

const console = new Logger('HistoryView');

type HistoryScope = 'glyph' | 'font';

type GlyphSelectedListener = (
    index: number,
    previousIndex: number,
    fromKeyboard?: boolean
) => void;

type TextRunSelectionEmitter = {
    on(eventName: 'glyphselected', listener: GlyphSelectedListener): void;
};

class HistoryViewController {
    private initialized = false;
    private rootEl: HTMLElement | null = null;
    private breadcrumbEl: HTMLElement | null = null;
    private searchInputEl: HTMLInputElement | null = null;
    private statusEl: HTMLElement | null = null;
    private filtersEl: HTMLElement | null = null;
    private listEl: HTMLElement | null = null;
    private searchQuery = '';
    private activeTypeFilter: string | null = null;
    private currentGlyphName: string | null = null;
    private currentScope: HistoryScope = 'font';
    private unsubscribeBridge: (() => void) | null = null;
    private attachedTextRunEditor: TextRunSelectionEmitter | null = null;

    constructor() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.init(), {
                once: true
            });
            return;
        }
        this.init();
    }

    private init(): void {
        if (this.initialized) {
            return;
        }

        const rootEl = document.getElementById('history-view-content');
        if (!rootEl) {
            console.warn('History view container not found');
            return;
        }

        this.initialized = true;
        this.rootEl = rootEl;
        this.renderShell();
        this.bindDomEvents();
        this.bindWindowEvents();
        this.connectToBridge();
        this.attachTextRunListener();
        this.syncEditingContext(true);
        this.render();
    }

    private renderShell(): void {
        if (!this.rootEl) {
            return;
        }

        this.rootEl.innerHTML = `
            <div class="history-panel">
                <div class="history-toolbar">
                    <div class="history-breadcrumb-wrap">
                        <div class="history-breadcrumb" data-role="history-breadcrumb"></div>
                        <span class="history-status" data-role="history-status"></span>
                    </div>
                    <input
                        class="history-search-input"
                        data-role="history-search"
                        type="text"
                        placeholder="Filter changes..."
                    />
                </div>
                <div class="history-filters" data-role="history-filters"></div>
                <div class="history-change-list" data-role="history-list"></div>
            </div>
        `;

        this.breadcrumbEl = this.rootEl.querySelector(
            '[data-role="history-breadcrumb"]'
        );
        this.searchInputEl = this.rootEl.querySelector(
            '[data-role="history-search"]'
        ) as HTMLInputElement | null;
        this.statusEl = this.rootEl.querySelector(
            '[data-role="history-status"]'
        );
        this.filtersEl = this.rootEl.querySelector(
            '[data-role="history-filters"]'
        );
        this.listEl = this.rootEl.querySelector('[data-role="history-list"]');
    }

    private bindDomEvents(): void {
        this.searchInputEl?.addEventListener('input', () => {
            this.searchQuery = this.searchInputEl?.value ?? '';
            this.render();
        });
    }

    private bindWindowEvents(): void {
        window.addEventListener('fontModelReady', () => {
            this.connectToBridge();
            this.attachTextRunListener();
            this.syncEditingContext(true);
        });

        window.addEventListener('glyphStackChanged', () => {
            this.syncEditingContext(true);
        });

        window.addEventListener('glyphChanged', () => {
            this.syncEditingContext(true);
        });

        window.addEventListener('editorModeChanged', () => {
            this.syncEditingContext(true);
        });
    }

    private connectToBridge(): void {
        const bridge = window.changeBridge;
        this.unsubscribeBridge?.();
        this.unsubscribeBridge = null;

        if (!bridge) {
            this.render();
            return;
        }

        this.unsubscribeBridge = bridge.onChangeLogUpdate(() => {
            this.render();
        });
    }

    private attachTextRunListener(): void {
        const textRunEditor = window.glyphCanvas
            ?.textRunEditor as TextRunSelectionEmitter | null;
        if (!textRunEditor || this.attachedTextRunEditor === textRunEditor) {
            return;
        }

        this.attachedTextRunEditor = textRunEditor;
        textRunEditor.on('glyphselected', () => {
            this.syncEditingContext(true);
        });
    }

    private syncEditingContext(forceGlyphScope: boolean): void {
        const nextGlyphName = this.resolveCurrentGlyphName();
        const glyphChanged = nextGlyphName !== this.currentGlyphName;

        this.currentGlyphName = nextGlyphName;

        if (!this.currentGlyphName) {
            this.currentScope = 'font';
        } else if (forceGlyphScope || glyphChanged) {
            this.currentScope = 'glyph';
        }

        if (glyphChanged) {
            this.activeTypeFilter = null;
        }

        this.render();
    }

    private resolveCurrentGlyphName(): string | null {
        const outlineEditor = window.glyphCanvas?.outlineEditor;
        if (outlineEditor?.active) {
            const parsedStack = outlineEditor.parseGlyphStack();
            const glyphName =
                parsedStack[parsedStack.length - 1]?.glyphName ??
                outlineEditor.currentGlyphName;
            if (glyphName && glyphName !== 'undefined') {
                return glyphName;
            }
        }

        const glyphName = window.glyphCanvas?.getCurrentGlyphName?.();
        if (glyphName && glyphName !== 'undefined') {
            return glyphName;
        }

        return null;
    }

    private getSourceEntries(): ChangeLogEntry[] {
        const bridge = window.changeBridge;
        if (!bridge) {
            return [];
        }

        if (this.currentScope === 'glyph' && this.currentGlyphName) {
            return bridge.getChangeLogForGlyph(this.currentGlyphName);
        }

        return bridge.getChangeLog();
    }

    private getFilteredEntries(entries: ChangeLogEntry[]): ChangeLogEntry[] {
        return entries.filter((entry) => {
            if (
                this.activeTypeFilter &&
                entry.objectType !== this.activeTypeFilter
            ) {
                return false;
            }
            return this.matchesSearch(entry);
        });
    }

    private matchesSearch(entry: ChangeLogEntry): boolean {
        if (!this.searchQuery) {
            return true;
        }

        const query = this.searchQuery.toLowerCase();
        return (
            entry.path.toLowerCase().includes(query) ||
            entry.objectType.toLowerCase().includes(query) ||
            entry.objectId.toLowerCase().includes(query) ||
            (entry.glyphName ?? '').toLowerCase().includes(query) ||
            (entry.transactionLabel ?? '').toLowerCase().includes(query) ||
            entry.property.toLowerCase().includes(query)
        );
    }

    private render(): void {
        if (!this.initialized) {
            return;
        }

        const sourceEntries = this.getSourceEntries();
        const filteredEntries = this.getFilteredEntries(sourceEntries);
        this.renderBreadcrumb();
        this.renderStatus(filteredEntries.length, sourceEntries.length);
        this.renderFilters(sourceEntries);
        this.renderList(filteredEntries);
    }

    private renderBreadcrumb(): void {
        if (!this.breadcrumbEl) {
            return;
        }

        const fragment = document.createDocumentFragment();
        fragment.appendChild(this.createBreadcrumbItem('Font', 'font'));

        if (this.currentGlyphName) {
            const separator = document.createElement('span');
            separator.className =
                'history-breadcrumb-separator material-symbols-outlined';
            separator.textContent = 'chevron_right';
            fragment.appendChild(separator);
            fragment.appendChild(
                this.createBreadcrumbItem(this.currentGlyphName, 'glyph')
            );
        }

        this.breadcrumbEl.innerHTML = '';
        this.breadcrumbEl.appendChild(fragment);
    }

    private createBreadcrumbItem(
        label: string,
        scope: HistoryScope
    ): HTMLButtonElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.className =
            'history-breadcrumb-item' +
            (this.currentScope === scope ? ' active' : '');
        button.textContent = label;
        button.disabled = scope === 'glyph' && !this.currentGlyphName;
        button.addEventListener('click', () => {
            if (scope === 'glyph' && !this.currentGlyphName) {
                return;
            }
            this.currentScope = scope;
            this.render();
        });
        return button;
    }

    private renderStatus(filteredCount: number, totalCount: number): void {
        if (!this.statusEl) {
            return;
        }

        if (!window.changeBridge) {
            this.statusEl.textContent = 'Waiting for font data';
            return;
        }

        if (this.currentScope === 'glyph' && this.currentGlyphName) {
            this.statusEl.textContent = `${filteredCount} of ${totalCount} changes in ${this.currentGlyphName}`;
            return;
        }

        this.statusEl.textContent = `${filteredCount} of ${totalCount} changes`;
    }

    private renderFilters(entries: ChangeLogEntry[]): void {
        if (!this.filtersEl) {
            return;
        }

        const types = new Set<string>();
        for (const entry of entries) {
            types.add(entry.objectType);
        }

        if (this.activeTypeFilter && !types.has(this.activeTypeFilter)) {
            this.activeTypeFilter = null;
        }

        const fragment = document.createDocumentFragment();
        for (const type of [...types].sort()) {
            const tag = document.createElement('button');
            tag.type = 'button';
            tag.className =
                'history-filter-button' +
                (this.activeTypeFilter === type ? ' active' : '');
            tag.textContent = type;
            tag.addEventListener('click', () => {
                this.activeTypeFilter =
                    this.activeTypeFilter === type ? null : type;
                this.render();
            });
            fragment.appendChild(tag);
        }

        this.filtersEl.innerHTML = '';
        this.filtersEl.appendChild(fragment);
    }

    private renderList(entries: ChangeLogEntry[]): void {
        if (!this.listEl) {
            return;
        }

        if (!window.changeBridge) {
            this.listEl.innerHTML =
                '<div class="history-empty-state">Waiting for font data...</div>';
            return;
        }

        if (!entries.length) {
            const message =
                this.currentScope === 'glyph' && this.currentGlyphName
                    ? `No changes for ${this.currentGlyphName}`
                    : 'No matching changes';
            this.listEl.innerHTML = `<div class="history-empty-state">${message}</div>`;
            return;
        }

        const fragment = document.createDocumentFragment();

        for (let index = entries.length - 1; index >= 0; index--) {
            const entry = entries[index];
            const row = document.createElement('div');
            row.className = 'history-entry';

            const opClass =
                entry.op === 'add'
                    ? 'op-add'
                    : entry.op === 'remove'
                      ? 'op-remove'
                      : 'op-set';

            row.innerHTML = `
                <div class="history-meta">
                    <span class="history-time">${this.formatTime(entry.timestamp)}</span>
                    <span class="history-badge ${opClass}">${entry.op}</span>
                    <span class="history-badge">${entry.objectType}</span>
                    ${entry.transactionLabel ? `<span class="history-badge">${entry.transactionLabel}</span>` : ''}
                </div>
                <div class="history-path">${entry.path}</div>
                ${entry.op === 'set' && (entry.oldValue !== undefined || entry.newValue !== undefined) ? `<div class="history-values">${this.truncate(entry.oldValue)} → ${this.truncate(entry.newValue)}</div>` : ''}
            `;
            fragment.appendChild(row);
        }

        this.listEl.innerHTML = '';
        this.listEl.appendChild(fragment);
    }

    private formatTime(timestamp: number): string {
        const date = new Date(timestamp);
        return date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    private truncate(value: unknown, maxLength = 60): string {
        if (value === undefined) {
            return '';
        }
        if (value === null) {
            return 'null';
        }

        const text = typeof value === 'string' ? value : JSON.stringify(value);
        if (text === undefined) {
            return '';
        }

        return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
    }
}

new HistoryViewController();
