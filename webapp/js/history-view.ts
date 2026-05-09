import {
    buildHistoryStackItems,
    deriveObjectInfoFromPath,
    type ChangeLogEntry,
    type HistoryStackItem
} from './change-log';
import { Logger } from './logger';
import tippy, { type Instance as TippyInstance } from 'tippy.js';
import { getTheme } from './tippy-utils';

const console = new Logger('HistoryView');

type HistoryScope = 'layer' | 'glyph' | 'font' | 'feature';

type FeatureHistoryContext = {
    type: 'feature' | 'class' | 'prefix';
    key: string;
    label: string;
};

type GlyphSelectedListener = (
    index: number,
    previousIndex: number,
    fromKeyboard?: boolean
) => void;

type TextRunSelectionEmitter = {
    on(eventName: 'glyphselected', listener: GlyphSelectedListener): void;
};

type HistoryUndoContext = {
    scope: HistoryScope;
    glyphName: string | null;
    layerId: string | null;
    historyTargetKey: string | null;
};

class HistoryViewController {
    private initialized = false;
    private rootEl: HTMLElement | null = null;
    private breadcrumbEl: HTMLElement | null = null;
    private statusEl: HTMLElement | null = null;
    private listEl: HTMLElement | null = null;
    private currentGlyphName: string | null = null;
    private currentLayerId: string | null = null;
    private currentLayerDisplayName: string | null = null;
    private currentScope: HistoryScope = 'font';
    private currentFeatureContext: FeatureHistoryContext | null = null;
    private unsubscribeBridge: (() => void) | null = null;
    private attachedTextRunEditor: TextRunSelectionEmitter | null = null;
    private metadataTooltips: TippyInstance[] = [];
    private pendingRenderHandle: number | null = null;

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
        window.getHistoryUndoContext = () => this.getUndoContext();
        this.renderShell();
        this.bindWindowEvents();
        this.connectToBridge();
        this.attachTextRunListener();
        this.syncEditingContext(true);
        this.render();
        requestAnimationFrame(() => {
            this.syncEditingContext(true);
        });
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
                <div class="history-change-list" data-role="history-list"></div>
            </div>
        `;

        this.breadcrumbEl = this.rootEl.querySelector(
            '[data-role="history-breadcrumb"]'
        );
        this.statusEl = this.rootEl.querySelector(
            '[data-role="history-status"]'
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

        window.addEventListener('featureHistoryContextChanged', () => {
            this.syncEditingContext(true);
        });

        window.addEventListener('viewFocused', () => {
            this.syncEditingContext(true);
        });
    }

    private connectToBridge(): void {
        const bridge = window.patchSyncEngine;
        this.unsubscribeBridge?.();
        this.unsubscribeBridge = null;

        if (!bridge) {
            this.render();
            return;
        }

        this.unsubscribeBridge = bridge.onChangeLogUpdate(() => {
            this.scheduleRender();
        });
    }

    /**
     * Coalesce history-view DOM re-renders. Multiple change-log appends in
     * the same task or animation frame produce a single rebuild instead of
     * one per commit. Each render rebuilds N DOM rows + tippy tooltips, so
     * back-to-back commits without coalescing produce a long freeze. See
     * COMPILATION_EDIT_POLICY.md.
     */
    private scheduleRender(): void {
        if (this.pendingRenderHandle !== null) {
            return;
        }
        this.pendingRenderHandle = requestAnimationFrame(() => {
            this.pendingRenderHandle = null;
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
        const featureContext = this.resolveFeatureHistoryContext();
        this.currentFeatureContext = featureContext;

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

        if (featureContext) {
            this.currentScope = 'feature';
        } else if (!this.currentGlyphName) {
            this.currentScope = 'font';
        } else if (forceGlyphScope || glyphChanged || layerChanged) {
            this.currentScope = this.currentLayerId ? 'layer' : 'glyph';
        } else if (this.currentScope === 'layer' && !this.currentLayerId) {
            this.currentScope = 'glyph';
        }

        this.render();
    }

    private resolveFeatureHistoryContext(): FeatureHistoryContext | null {
        const target = window.fontInfoManager?.getHistoryScopeTarget?.();
        if (!target) {
            return null;
        }

        return {
            type: target.type,
            key: target.key,
            label: target.label
        };
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
        const bridge = window.patchSyncEngine;
        if (!bridge) {
            return [];
        }

        if (this.currentScope === 'feature' && this.currentFeatureContext) {
            return buildHistoryStackItems(bridge.getChangeLog(), {
                historyTargetKey: this.currentFeatureContext.key
            });
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

    private render(): void {
        if (!this.initialized) {
            return;
        }

        const sourceItems = this.getSourceItems();
        this.renderBreadcrumb();
        this.renderStatus(sourceItems.length, sourceItems.length);
        this.renderList(sourceItems);
    }

    private getUndoContext(): HistoryUndoContext {
        if (this.currentScope === 'font') {
            return {
                scope: 'font',
                glyphName: null,
                layerId: null,
                historyTargetKey: null
            };
        }

        if (this.currentScope === 'feature') {
            return {
                scope: 'feature',
                glyphName: null,
                layerId: null,
                historyTargetKey: this.currentFeatureContext?.key ?? null
            };
        }

        if (this.currentScope === 'glyph') {
            return {
                scope: 'glyph',
                glyphName: this.currentGlyphName,
                layerId: null,
                historyTargetKey: null
            };
        }

        return {
            scope: 'layer',
            glyphName: this.currentGlyphName,
            layerId: this.currentLayerId,
            historyTargetKey: null
        };
    }

    private renderBreadcrumb(): void {
        if (!this.breadcrumbEl) {
            return;
        }

        const fragment = document.createDocumentFragment();
        fragment.appendChild(this.createBreadcrumbItem('Font', 'font'));

        if (this.currentFeatureContext) {
            let separator = document.createElement('span');
            separator.className =
                'history-breadcrumb-separator material-symbols-outlined';
            separator.textContent = 'chevron_right';
            fragment.appendChild(separator);
            fragment.appendChild(
                this.createBreadcrumbItem('Features', 'feature', false)
            );

            separator = document.createElement('span');
            separator.className =
                'history-breadcrumb-separator material-symbols-outlined';
            separator.textContent = 'chevron_right';
            fragment.appendChild(separator);
            fragment.appendChild(
                this.createBreadcrumbItem(
                    this.currentFeatureContext.label,
                    'feature'
                )
            );

            this.breadcrumbEl.innerHTML = '';
            this.breadcrumbEl.appendChild(fragment);
            return;
        }

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
        scope: HistoryScope,
        active: boolean = true
    ): HTMLButtonElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.className =
            'history-breadcrumb-item' +
            (active && this.currentScope === scope ? ' active' : '');
        button.textContent = label;
        button.disabled =
            (scope === 'feature' && !this.currentFeatureContext) ||
            (scope === 'glyph' && !this.currentGlyphName) ||
            (scope === 'layer' && !this.currentLayerId);
        button.addEventListener('click', () => {
            if (scope === 'feature' && !this.currentFeatureContext) {
                return;
            }
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

        if (!window.patchSyncEngine) {
            this.statusEl.textContent = 'Waiting for font data';
            return;
        }

        if (this.currentScope === 'layer' && this.currentLayerDisplayName) {
            this.statusEl.textContent = `${filteredCount} of ${totalCount} history items in ${this.currentLayerDisplayName}`;
            return;
        }

        if (this.currentScope === 'feature' && this.currentFeatureContext) {
            this.statusEl.textContent = `${filteredCount} of ${totalCount} history items in ${this.currentFeatureContext.label}`;
            return;
        }

        if (this.currentScope === 'glyph' && this.currentGlyphName) {
            this.statusEl.textContent = `${filteredCount} of ${totalCount} history items in ${this.currentGlyphName}`;
            return;
        }

        this.statusEl.textContent = `${filteredCount} of ${totalCount} history items`;
    }

    private formatScopeLabel(item: HistoryStackItem): string {
        return `${item.undoScope} scope`;
    }

    private renderList(items: HistoryStackItem[]): void {
        if (!this.listEl) {
            return;
        }

        this.destroyMetadataTooltips();

        if (!window.patchSyncEngine) {
            this.listEl.innerHTML =
                '<div class="history-empty-state">Waiting for font data...</div>';
            return;
        }

        if (!items.length) {
            const message =
                this.currentScope === 'layer' && this.currentLayerDisplayName
                    ? `No history items for ${this.currentLayerDisplayName}`
                    : this.currentScope === 'feature' &&
                        this.currentFeatureContext
                      ? `No history items for ${this.currentFeatureContext.label}`
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
            const primaryObject = deriveObjectInfoFromPath(entry.path);
            const changeCountLabel = `${item.entries.length} change${
                item.entries.length === 1 ? '' : 's'
            }`;
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
                    <div class="history-meta-main">
                        <span class="history-time">${this.formatTime(item.timestamp)}</span>
                        ${item.transactionLabel ? `<span class="history-transaction-label">${this.escapeHtml(item.transactionLabel)}</span>` : ''}
                    </div>
                    <button
                        type="button"
                        class="history-info-button material-symbols-outlined"
                        data-role="history-info-button"
                        aria-label="Show history metadata"
                    >info</button>
                </div>
                <div class="history-item-tags">
                        <span class="history-badge history-window-badge">${this.escapeHtml(item.windowRoleLabel)}</span>
                        <span class="history-badge ${opClass}">${this.escapeHtml(entry.op)}</span>
                        <span class="history-badge">${this.escapeHtml(this.formatScopeLabel(item))}</span>
                        <span class="history-badge">${this.escapeHtml(primaryObject.objectType)}</span>
                    </div>
                ${item.entries.length === 1 && entry.op === 'set' && (entry.oldValue !== undefined || entry.newValue !== undefined) ? `<div class="history-values">${this.escapeHtml(this.truncate(entry.oldValue))} → ${this.escapeHtml(this.truncate(entry.newValue))}</div>` : `<div class="history-change-count">${changeCountLabel}</div>`}
            `;

            const infoButton = row.querySelector(
                '[data-role="history-info-button"]'
            ) as HTMLButtonElement | null;
            if (infoButton) {
                this.attachMetadataTooltip(infoButton, item);
            }

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

    private destroyMetadataTooltips(): void {
        for (const tooltip of this.metadataTooltips) {
            tooltip.destroy();
        }
        this.metadataTooltips = [];
    }

    private attachMetadataTooltip(
        button: HTMLButtonElement,
        item: HistoryStackItem
    ): void {
        const tooltip = tippy(button, {
            content: this.buildMetadataTooltip(item),
            allowHTML: true,
            interactive: true,
            trigger: 'click',
            appendTo: () => document.body,
            maxWidth: 460,
            placement: 'left-start',
            theme: getTheme()
        });
        this.metadataTooltips.push(tooltip);
    }

    private buildMetadataTooltip(item: HistoryStackItem): string {
        const summaryRows = [
            this.buildMetadataRow('History item', item.id),
            this.buildMetadataRow(
                'Timestamp',
                this.formatTimestamp(item.timestamp)
            ),
            this.buildMetadataRow('Last action', item.lastAction),
            this.buildMetadataRow('Active', item.isActive ? 'Yes' : 'No'),
            this.buildMetadataRow('Window', item.windowRoleLabel),
            this.buildMetadataRow('Undo scope', item.undoScope),
            this.buildMetadataRow('Transaction label', item.transactionLabel),
            this.buildMetadataRow('Entry count', String(item.entries.length)),
            this.buildMetadataRow(
                'Touched paths',
                this.formatList(item.touchedPaths)
            )
        ].join('');

        const entrySections = item.entries
            .map((entry, index) => {
                const derivedObject = deriveObjectInfoFromPath(entry.path);
                const entryRows = [
                    this.buildMetadataRow('Entry ID', String(entry.id)),
                    this.buildMetadataRow(
                        'Timestamp',
                        this.formatTimestamp(entry.timestamp)
                    ),
                    this.buildMetadataRow(
                        'History action',
                        entry.historyAction
                    ),
                    this.buildMetadataRow(
                        'Target item',
                        entry.targetHistoryItemId
                    ),
                    this.buildMetadataRow(
                        'Transaction ID',
                        this.formatNullableNumber(entry.transactionId)
                    ),
                    this.buildMetadataRow('Window ID', entry.windowId),
                    this.buildMetadataRow('Window', entry.windowRoleLabel),
                    this.buildMetadataRow('Operation', entry.op),
                    this.buildMetadataRow(
                        'Object type',
                        derivedObject.objectType
                    ),
                    this.buildMetadataRow('Object ID', derivedObject.objectId),
                    this.buildMetadataRow('Undo scope', entry.undoScope),
                    this.buildMetadataRow('Path', entry.path),
                    this.buildMetadataRow(
                        'Old value',
                        this.formatFullValue(entry.oldValue)
                    ),
                    this.buildMetadataRow(
                        'New value',
                        this.formatFullValue(entry.newValue)
                    )
                ].join('');

                return `
                    <section class="history-metadata-section">
                        <h4 class="history-metadata-section-title">Change ${index + 1}</h4>
                        <dl class="history-metadata-grid">${entryRows}</dl>
                    </section>
                `;
            })
            .join('');

        return `
            <div class="history-metadata-tooltip">
                <section class="history-metadata-section">
                    <h4 class="history-metadata-section-title">Summary</h4>
                    <dl class="history-metadata-grid">${summaryRows}</dl>
                </section>
                ${entrySections}
            </div>
        `;
    }

    private buildMetadataRow(label: string, value: string | null): string {
        return `
            <div class="history-metadata-row">
                <dt>${this.escapeHtml(label)}</dt>
                <dd>${this.escapeHtml(value ?? '—')}</dd>
            </div>
        `;
    }

    private formatList(values: string[]): string {
        return values.length ? values.join(', ') : '—';
    }

    private formatNullableNumber(value: number | null): string {
        return value === null ? '—' : String(value);
    }

    private formatFullValue(value: unknown): string {
        if (value === undefined) {
            return '—';
        }
        if (typeof value === 'string') {
            return value;
        }
        const json = JSON.stringify(value, null, 2);
        return json ?? String(value);
    }

    private formatTimestamp(timestamp: number): string {
        return new Date(timestamp).toLocaleString([], {
            year: 'numeric',
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    private escapeHtml(value: string): string {
        return value
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;');
    }
}

new HistoryViewController();
