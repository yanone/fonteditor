import type { CollaborationLogItem } from './patch-sync-engine';
import { getUndoReachabilityForContext } from './change-log';
import { getUndoRedoContext } from './undo-redo-context';
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

type HistoryDisplayItem = CollaborationLogItem & {
    historyItemIds: string[];
};

class HistoryViewController {
    private initialized = false;
    private rootEl: HTMLElement | null = null;
    private listEl: HTMLElement | null = null;
    private currentGlyphName: string | null = null;
    private currentLayerId: string | null = null;
    private currentFeatureContext: FeatureHistoryContext | null = null;
    private unsubscribeBridge: (() => void) | null = null;
    private attachedTextRunEditor: TextRunSelectionEmitter | null = null;
    private metadataTooltips: TippyInstance[] = [];
    private pendingRenderHandle: number | null = null;
    private collaborationItems: CollaborationLogItem[] = [];

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
        this.syncEditingContext();
        this.render();
    }

    private renderShell(): void {
        if (!this.rootEl) {
            return;
        }

        this.rootEl.innerHTML = `
            <div class="history-panel history-panel-flat">
                <div class="history-change-list" data-role="history-list"></div>
            </div>
        `;

        this.listEl = this.rootEl.querySelector('[data-role="history-list"]');
    }

    private bindWindowEvents(): void {
        window.addEventListener('fontModelReady', () => {
            this.connectToBridge();
            this.attachTextRunListener();
            this.syncEditingContext();
        });

        window.addEventListener('glyphStackChanged', () => {
            this.syncEditingContext();
        });

        window.addEventListener('glyphChanged', () => {
            this.syncEditingContext();
        });

        window.addEventListener('editorModeChanged', () => {
            this.syncEditingContext();
        });

        window.addEventListener('featureHistoryContextChanged', () => {
            this.syncEditingContext();
        });

        window.addEventListener('viewFocused', () => {
            this.syncEditingContext();
        });
    }

    private connectToBridge(): void {
        const bridge = window.patchSyncEngine;
        this.unsubscribeBridge?.();
        this.unsubscribeBridge = null;

        if (!bridge) {
            this.collaborationItems = [];
            this.render();
            return;
        }

        this.unsubscribeBridge = bridge.onCollaborationLogUpdate((items) => {
            this.collaborationItems = items;
            this.scheduleRender();
        });
    }

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
            this.syncEditingContext();
        });
    }

    private syncEditingContext(): void {
        this.currentFeatureContext = this.resolveFeatureHistoryContext();
        this.currentGlyphName = this.resolveCurrentGlyphName();
        this.currentLayerId = this.resolveCurrentLayerId();
        this.scheduleRender();
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

    private render(): void {
        if (!this.initialized || !this.listEl) {
            return;
        }

        this.destroyMetadataTooltips();

        if (!window.patchSyncEngine) {
            this.listEl.innerHTML =
                '<div class="history-empty-state">Waiting for font data...</div>';
            return;
        }

        if (!this.collaborationItems.length) {
            this.listEl.innerHTML =
                '<div class="history-empty-state">No collaboration messages yet</div>';
            return;
        }

        const groupedItems = new Map<string, HistoryDisplayItem>();
        for (const item of this.collaborationItems) {
            const groupKey = item.promptGroupId ?? item.id;
            const existing = groupedItems.get(groupKey);
            if (!existing) {
                groupedItems.set(groupKey, {
                    ...item,
                    historyItemIds: [item.historyItemId],
                    groupedMessageCount: 1
                });
                continue;
            }

            groupedItems.set(groupKey, {
                ...item,
                historyItemIds: [
                    ...new Set([...existing.historyItemIds, item.historyItemId])
                ],
                changedGlyphNames: [
                    ...new Set([
                        ...existing.changedGlyphNames,
                        ...item.changedGlyphNames
                    ])
                ],
                changedLayerIds: [
                    ...new Set([
                        ...existing.changedLayerIds,
                        ...item.changedLayerIds
                    ])
                ],
                changes: [...existing.changes, ...item.changes],
                derivedForwardChanges: [
                    ...existing.derivedForwardChanges,
                    ...item.derivedForwardChanges
                ],
                groupedMessageCount: (existing.groupedMessageCount ?? 1) + 1
            });
        }

        const displayItems = [...groupedItems.values()].sort(
            (left, right) => left.timestamp - right.timestamp
        );
        const undoContext = getUndoRedoContext();
        const changeLog = window.patchSyncEngine.getChangeLog?.() ?? [];
        const { reachableHistoryItemIds, nextUndoHistoryItemId } =
            getUndoReachabilityForContext(changeLog, {
                glyphName: undoContext.undoGlyphName,
                layerId: undoContext.undoLayerId,
                historyTargetKey: undoContext.historyTargetKey
            });
        const fragment = document.createDocumentFragment();

        for (let index = displayItems.length - 1; index >= 0; index--) {
            const item = displayItems[index];
            const isReachable = item.historyItemIds.some((historyItemId) =>
                reachableHistoryItemIds.has(historyItemId)
            );
            const isNextUndo =
                !!nextUndoHistoryItemId &&
                item.historyItemIds.includes(nextUndoHistoryItemId);
            const row = document.createElement('div');
            row.className = [
                'history-entry',
                'history-entry-flat',
                isReachable
                    ? 'history-entry-cmdz-reachable'
                    : 'history-entry-cmdz-unreachable',
                isNextUndo ? 'history-entry-cmdz-next' : ''
            ]
                .filter(Boolean)
                .join(' ');
            row.title = isNextUndo
                ? 'Next ⌘Z target in current editing context'
                : isReachable
                  ? 'Reachable by ⌘Z in current editing context'
                  : 'Not reachable by ⌘Z in current editing context';
            row.innerHTML = `
                <div class="history-entry-main">
                    <div class="history-entry-summary">${this.escapeHtml(item.summary)}</div>
                    <div class="history-entry-subtitle">${this.escapeHtml(this.buildSubtitle(item))}</div>
                </div>
                <button
                    type="button"
                    class="history-info-button material-symbols-outlined"
                    data-role="history-info-button"
                    aria-label="Show message details"
                >info</button>
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

    private buildSubtitle(item: CollaborationLogItem): string {
        return [
            this.formatTime(item.timestamp),
            item.windowRoleLabel,
            item.historyAction,
            item.groupedMessageCount && item.groupedMessageCount > 1
                ? `${item.groupedMessageCount} prompt calls`
                : null,
            this.formatDuration(item.transactionDurationMs),
            `${item.updateByteLength} B`
        ]
            .filter((part): part is string => !!part)
            .join(' • ');
    }

    private getUndoContext(): HistoryUndoContext {
        if (this.currentFeatureContext) {
            return {
                scope: 'feature',
                glyphName: null,
                layerId: null,
                historyTargetKey: this.currentFeatureContext.key
            };
        }

        if (this.currentGlyphName && this.currentLayerId) {
            return {
                scope: 'layer',
                glyphName: this.currentGlyphName,
                layerId: this.currentLayerId,
                historyTargetKey: null
            };
        }

        if (this.currentGlyphName) {
            return {
                scope: 'glyph',
                glyphName: this.currentGlyphName,
                layerId: null,
                historyTargetKey: null
            };
        }

        return {
            scope: 'font',
            glyphName: null,
            layerId: null,
            historyTargetKey: null
        };
    }

    private formatTime(timestamp: number): string {
        const date = new Date(timestamp);
        return date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    private formatDuration(
        durationMs: number | null | undefined
    ): string | null {
        if (durationMs == null || Number.isNaN(durationMs)) {
            return null;
        }

        const measuredDurationMs: number = durationMs;

        if (measuredDurationMs >= 1000) {
            return `${(measuredDurationMs / 1000).toFixed(2)} s`;
        }

        return `${measuredDurationMs.toFixed(1)} ms`;
    }

    private destroyMetadataTooltips(): void {
        for (const tooltip of this.metadataTooltips) {
            tooltip.destroy();
        }
        this.metadataTooltips = [];
    }

    private attachMetadataTooltip(
        button: HTMLButtonElement,
        item: CollaborationLogItem
    ): void {
        const tooltip = tippy(button, {
            content: this.buildMetadataTooltip(item),
            allowHTML: true,
            interactive: true,
            trigger: 'click',
            appendTo: () => document.body,
            maxWidth: 520,
            placement: 'left-start',
            theme: getTheme()
        });
        this.metadataTooltips.push(tooltip);
    }

    private buildMetadataTooltip(item: CollaborationLogItem): string {
        const summaryRows = [
            this.buildMetadataRow('Summary', item.summary),
            this.buildMetadataRow('Label', item.label),
            this.buildMetadataRow('Direction', item.direction),
            this.buildMetadataRow('Source', item.source),
            this.buildMetadataRow('Edit source', item.editSource),
            this.buildMetadataRow(
                'Timestamp',
                this.formatTimestamp(item.timestamp)
            ),
            this.buildMetadataRow(
                'Transaction duration',
                this.formatDuration(item.transactionDurationMs)
            ),
            this.buildMetadataRow('Window', item.windowRoleLabel),
            this.buildMetadataRow('History action', item.historyAction),
            this.buildMetadataRow('Undo scope', item.undoScope),
            this.buildMetadataRow('History item', item.historyItemId),
            this.buildMetadataRow(
                'Prompt calls',
                item.groupedMessageCount && item.groupedMessageCount > 1
                    ? String(item.groupedMessageCount)
                    : null
            ),
            this.buildMetadataRow('Target item', item.targetHistoryItemId),
            this.buildMetadataRow(
                'Changed glyphs',
                this.formatList(item.changedGlyphNames)
            ),
            this.buildMetadataRow(
                'Changed layers',
                this.formatList(item.changedLayerIds)
            ),
            this.buildMetadataRow(
                'Replay targets',
                this.formatReplayTargets(item)
            ),
            this.buildMetadataRow('Yjs bytes', String(item.updateByteLength)),
            this.buildMetadataRow(
                'Yjs preview',
                item.updateBase64Preview || '—'
            )
        ].join('');

        const changeRows = item.derivedForwardChanges
            .map(
                (change, index) => `
                    <section class="history-metadata-section">
                        <h4 class="history-metadata-section-title">Forward change ${index + 1}</h4>
                        <dl class="history-metadata-grid">
                            ${this.buildMetadataRow('Path', change.path)}
                            ${this.buildMetadataRow('Operation', change.op)}
                            ${this.buildMetadataRow('Object type', change.objectType)}
                            ${this.buildMetadataRow('Old value', this.formatFullValue(change.oldValue))}
                            ${this.buildMetadataRow('New value', this.formatFullValue(change.newValue))}
                        </dl>
                    </section>
                `
            )
            .join('');

        const messageRows = item.changes
            .map(
                (change, index) => `
                    <section class="history-metadata-section">
                        <h4 class="history-metadata-section-title">Message path ${index + 1}</h4>
                        <dl class="history-metadata-grid">
                            ${this.buildMetadataRow('Path', change.path)}
                            ${this.buildMetadataRow('Operation', change.op)}
                            ${this.buildMetadataRow(
                                'Replay targets',
                                this.formatReplayTargetList(
                                    change.workerReplayTargets
                                )
                            )}
                        </dl>
                    </section>
                `
            )
            .join('');

        return `
            <div class="history-metadata-tooltip">
                <section class="history-metadata-section">
                    <h4 class="history-metadata-section-title">Message</h4>
                    <dl class="history-metadata-grid">${summaryRows}</dl>
                </section>
                ${messageRows}
                ${changeRows}
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

    private formatReplayTargets(item: CollaborationLogItem): string {
        return this.formatReplayTargetList(item.workerReplayTargets);
    }

    private formatReplayTargetList(
        targets: Array<{ glyphName: string; layerId: string }> | undefined
    ): string {
        if (!targets?.length) {
            return '—';
        }

        return targets
            .map((target) => `${target.glyphName}/${target.layerId}`)
            .join(', ');
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
