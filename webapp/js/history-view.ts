import {
    buildHistoryStackItems,
    type ChangeLogEntry,
    type HistoryStackItem
} from './change-log';
import { Logger } from './logger';

const console = new Logger('HistoryView');

type HistoryScope = 'layer' | 'glyph' | 'font';

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
    private statusEl: HTMLElement | null = null;
    private filtersEl: HTMLElement | null = null;
    private listEl: HTMLElement | null = null;
    private activeTypeFilter: string | null = null;
    private currentGlyphName: string | null = null;
    private currentLayerId: string | null = null;
    private currentLayerDisplayName: string | null = null;
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
                </div>
                <div class="history-filters" data-role="history-filters"></div>
                <div class="history-change-list" data-role="history-list"></div>
            </div>
        `;

        this.breadcrumbEl = this.rootEl.querySelector(
            '[data-role="history-breadcrumb"]'
        );
        this.statusEl = this.rootEl.querySelector(
            '[data-role="history-status"]'
        );
        this.filtersEl = this.rootEl.querySelector(
            '[data-role="history-filters"]'
        );
        this.listEl = this.rootEl.querySelector('[data-role="history-list"]');
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
        const nextLayerId = this.resolveCurrentLayerId();
        const glyphChanged = nextGlyphName !== this.currentGlyphName;
        const layerChanged = nextLayerId !== this.currentLayerId;

        this.currentGlyphName = nextGlyphName;
        this.currentLayerId = nextLayerId;
        this.currentLayerDisplayName = this.resolveLayerDisplayName(
            nextGlyphName,
            nextLayerId
        );

        if (!this.currentGlyphName) {
            this.currentScope = 'font';
        } else if (forceGlyphScope || glyphChanged || layerChanged) {
            this.currentScope = this.currentLayerId ? 'layer' : 'glyph';
        } else if (this.currentScope === 'layer' && !this.currentLayerId) {
            this.currentScope = 'glyph';
        }

        if (glyphChanged || layerChanged) {
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

    private resolveCurrentLayerId(): string | null {
        const outlineEditor = window.glyphCanvas?.outlineEditor;
        if (!outlineEditor?.active) {
            return null;
        }
        return outlineEditor.selectedLayerId ?? null;
    }

    private resolveLayerDisplayName(
        glyphName: string | null,
        layerId: string | null
    ): string | null {
        if (!glyphName || !layerId) {
            return null;
        }

        const fontModel = window.fontManager?.currentFont?.fontModel;
        const glyph = fontModel?.glyphs?.find(
            (entry: { name: string }) => entry.name === glyphName
        );
        const layer = glyph?.layers?.find(
            (entry: { id: string }) => entry.id === layerId
        );
        if (!layer) {
            return layerId;
        }

        const layerMaster = layer.master;
        const masterId =
            layerMaster &&
            typeof layerMaster === 'object' &&
            'type' in layerMaster
                ? layerMaster.master
                : undefined;

        const isBraceLayer =
            layerMaster &&
            typeof layerMaster === 'object' &&
            'type' in layerMaster &&
            layerMaster.type === 'AssociatedWithMaster' &&
            !!layer.location &&
            Object.keys(layer.location).length > 0;

        if (isBraceLayer) {
            return layer.name && layer.name.trim() !== ''
                ? layer.name
                : 'Brace';
        }

        const master = fontModel?.masters?.find(
            (entry: { id: string }) => entry.id === masterId
        );
        if (typeof master?.name === 'string') {
            return master.name;
        }
        if (master?.name && 'dflt' in master.name) {
            return master.name.dflt;
        }
        if (master?.name && 'en' in master.name) {
            return master.name.en;
        }
        return 'Default';
    }

    private getSourceItems(): HistoryStackItem[] {
        const bridge = window.changeBridge;
        if (!bridge) {
            return [];
        }

        if (
            this.currentScope === 'layer' &&
            this.currentGlyphName &&
            this.currentLayerId
        ) {
            return buildHistoryStackItems(bridge.getChangeLog(), {
                glyphName: this.currentGlyphName,
                layerId: this.currentLayerId
            });
        }

        if (this.currentScope === 'glyph' && this.currentGlyphName) {
            return buildHistoryStackItems(bridge.getChangeLog(), {
                glyphName: this.currentGlyphName
            });
        }

        return buildHistoryStackItems(bridge.getChangeLog());
    }

    private getFilteredItems(items: HistoryStackItem[]): HistoryStackItem[] {
        return items.filter((item) => {
            if (
                this.activeTypeFilter &&
                !item.entries.some(
                    (entry) => entry.objectType === this.activeTypeFilter
                )
            ) {
                return false;
            }
            return true;
        });
    }

    private render(): void {
        if (!this.initialized) {
            return;
        }

        const sourceItems = this.getSourceItems();
        const filteredItems = this.getFilteredItems(sourceItems);
        this.renderBreadcrumb();
        this.renderStatus(filteredItems.length, sourceItems.length);
        this.renderFilters(sourceItems);
        this.renderList(filteredItems);
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

        if (this.currentLayerId && this.currentLayerDisplayName) {
            const separator = document.createElement('span');
            separator.className =
                'history-breadcrumb-separator material-symbols-outlined';
            separator.textContent = 'chevron_right';
            fragment.appendChild(separator);
            fragment.appendChild(
                this.createBreadcrumbItem(this.currentLayerDisplayName, 'layer')
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
        button.disabled =
            (scope === 'glyph' && !this.currentGlyphName) ||
            (scope === 'layer' && !this.currentLayerId);
        button.addEventListener('click', () => {
            if (scope === 'glyph' && !this.currentGlyphName) {
                return;
            }
            if (scope === 'layer' && !this.currentLayerId) {
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

        if (this.currentScope === 'layer' && this.currentLayerDisplayName) {
            this.statusEl.textContent = `${filteredCount} of ${totalCount} history items in ${this.currentLayerDisplayName}`;
            return;
        }

        if (this.currentScope === 'glyph' && this.currentGlyphName) {
            this.statusEl.textContent = `${filteredCount} of ${totalCount} history items in ${this.currentGlyphName}`;
            return;
        }

        this.statusEl.textContent = `${filteredCount} of ${totalCount} history items`;
    }

    private renderFilters(items: HistoryStackItem[]): void {
        if (!this.filtersEl) {
            return;
        }

        const types = new Set<string>();
        for (const item of items) {
            for (const entry of item.entries) {
                types.add(entry.objectType);
            }
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

    private formatItemPath(item: HistoryStackItem): string {
        const uniquePaths = [
            ...new Set(item.entries.map((entry) => entry.path))
        ];
        if (!uniquePaths.length) {
            return '';
        }
        if (uniquePaths.length === 1) {
            return uniquePaths[0];
        }
        if (uniquePaths.length === 2) {
            return `${uniquePaths[0]} and ${uniquePaths[1]}`;
        }
        return `${uniquePaths[0]}, ${uniquePaths[1]}, +${uniquePaths.length - 2} more`;
    }

    private formatScopeLabel(item: HistoryStackItem): string {
        return `${item.undoScope} scope`;
    }

    private renderList(items: HistoryStackItem[]): void {
        if (!this.listEl) {
            return;
        }

        if (!window.changeBridge) {
            this.listEl.innerHTML =
                '<div class="history-empty-state">Waiting for font data...</div>';
            return;
        }

        if (!items.length) {
            const message =
                this.currentScope === 'layer' && this.currentLayerDisplayName
                    ? `No history items for ${this.currentLayerDisplayName}`
                    : this.currentScope === 'glyph' && this.currentGlyphName
                      ? `No history items for ${this.currentGlyphName}`
                      : 'No matching history items';
            this.listEl.innerHTML = `<div class="history-empty-state">${message}</div>`;
            return;
        }

        const fragment = document.createDocumentFragment();

        for (let index = items.length - 1; index >= 0; index--) {
            const item = items[index];
            const entry = item.entries[item.entries.length - 1];
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
                    <span class="history-time">${this.formatTime(item.timestamp)}</span>
                    <span class="history-badge history-window-badge">${item.windowRoleLabel}</span>
                    <span class="history-badge ${opClass}">${entry.op}</span>
                    <span class="history-badge">${this.formatScopeLabel(item)}</span>
                    <span class="history-badge">${item.primaryObjectType}</span>
                    ${item.transactionLabel ? `<span class="history-badge">${item.transactionLabel}</span>` : ''}
                    ${item.entries.length > 1 ? `<span class="history-badge">${item.entries.length} changes</span>` : ''}
                </div>
                <div class="history-path">${this.formatItemPath(item)}</div>
                ${item.entries.length === 1 && entry.op === 'set' && (entry.oldValue !== undefined || entry.newValue !== undefined) ? `<div class="history-values">${this.truncate(entry.oldValue)} → ${this.truncate(entry.newValue)}</div>` : ''}
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
