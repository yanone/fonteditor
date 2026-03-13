/**
 * undo-manager-app.ts — Entry point for the standalone Undo Manager window.
 *
 * Connects to the editor windows via BroadcastChannel, receives the full
 * change log, and renders a searchable/filterable history list.
 */

import { ChangeBridge } from './change-bridge';
import { WindowSync } from './window-sync';
import type { ChangeLogEntry } from './change-log';

// ── State ────────────────────────────────────────────────────────

let changeLog: ChangeLogEntry[] = [];
let bridge: ChangeBridge | null = null;
let sync: WindowSync | null = null;
let searchQuery = '';
let activeTypeFilter: string | null = null;

// ── DOM refs ─────────────────────────────────────────────────────

const searchInput = document.getElementById('search-input') as HTMLInputElement;
const statusEl = document.getElementById('status')!;
const filtersEl = document.getElementById('filters')!;
const listEl = document.getElementById('change-list')!;

// ── Rendering ────────────────────────────────────────────────────

function formatTime(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function truncate(val: unknown, maxLen = 40): string {
    if (val === undefined) return 'undefined';
    const s = JSON.stringify(val);
    if (s === undefined) return 'undefined';
    return s.length > maxLen ? s.slice(0, maxLen) + '...' : s;
}

function renderFilters(): void {
    const types = new Set<string>();
    for (const entry of changeLog) {
        types.add(entry.objectType);
    }

    filtersEl.innerHTML = '';
    for (const t of [...types].sort()) {
        const tag = document.createElement('span');
        tag.className = 'tag' + (activeTypeFilter === t ? ' active' : '');
        tag.textContent = t;
        tag.addEventListener('click', () => {
            activeTypeFilter = activeTypeFilter === t ? null : t;
            renderFilters();
            renderList();
        });
        filtersEl.appendChild(tag);
    }
}

function matchesSearch(entry: ChangeLogEntry): boolean {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
        entry.path.toLowerCase().includes(q) ||
        entry.objectType.toLowerCase().includes(q) ||
        entry.objectId.toLowerCase().includes(q) ||
        (entry.transactionLabel ?? '').toLowerCase().includes(q) ||
        entry.property.toLowerCase().includes(q)
    );
}

function renderList(): void {
    const filtered = changeLog.filter((e) => {
        if (activeTypeFilter && e.objectType !== activeTypeFilter) return false;
        return matchesSearch(e);
    });

    if (filtered.length === 0) {
        listEl.innerHTML = '<div class="empty-state">No matching changes</div>';
        return;
    }

    const frag = document.createDocumentFragment();

    // Newest first
    for (let i = filtered.length - 1; i >= 0; i--) {
        const e = filtered[i];
        const div = document.createElement('div');
        div.className = 'change-entry';

        const opClass =
            e.op === 'add'
                ? 'op-add'
                : e.op === 'remove'
                  ? 'op-remove'
                  : 'op-set';

        div.innerHTML = `
            <div class="meta">
                <span class="time">${formatTime(e.timestamp)}</span>
                <span class="badge ${opClass}">${e.op}</span>
                <span class="badge">${e.objectType}</span>
                ${e.transactionLabel ? `<span class="badge">${e.transactionLabel}</span>` : ''}
            </div>
            <div class="path">${e.path}${e.property ? '.' + e.property : ''}</div>
            ${e.op === 'set' ? `<div class="values">${truncate(e.oldValue)} → ${truncate(e.newValue)}</div>` : ''}
        `;
        frag.appendChild(div);
    }

    listEl.innerHTML = '';
    listEl.appendChild(frag);
}

// ── BroadcastChannel connection ──────────────────────────────────

function connect(): void {
    // Get channel name from URL params
    const params = new URLSearchParams(window.location.search);
    const channelName = params.get('channel');
    if (!channelName) {
        statusEl.textContent = 'No channel specified in URL';
        return;
    }

    bridge = new ChangeBridge('undo-manager');
    sync = new WindowSync(bridge, channelName);

    bridge.onRemoteChange(() => {
        changeLog = bridge!.getChangeLog();
        statusEl.textContent = `${changeLog.length} changes`;
        renderFilters();
        renderList();
    });

    // Request full state from an existing editor window
    sync.requestFullState();
    statusEl.textContent = 'Requesting state...';

    // Also listen for incremental change-log updates
    // (remote changes already update the bridge's change log via importChangeLog
    //  in applyFullState, or through the observer on applyRemoteUpdate)
}

// ── Event wiring ─────────────────────────────────────────────────

searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    renderList();
});

connect();
