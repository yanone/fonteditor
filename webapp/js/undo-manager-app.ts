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
const fontNameEl = document.getElementById('font-name');

function decodePathSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

function extractFontPathFromChannel(channelName: string | null): string {
    if (!channelName) {
        return 'unsaved';
    }
    return channelName.replace(/^counterpunch-font:/, '') || 'unsaved';
}

function extractFileNameFromPath(pathValue: string): string {
    const normalized = pathValue.replace(/\\/g, '/');
    const rawName = normalized.split('/').pop() || normalized || 'unsaved';
    return decodePathSegment(rawName);
}

function applyTheme(theme: 'light' | 'dark'): void {
    if (theme === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
    } else {
        document.documentElement.removeAttribute('data-theme');
    }
}

function applyThemePreference(preference: 'light' | 'dark' | 'auto'): void {
    if (preference === 'auto') {
        applyTheme(
            window.matchMedia('(prefers-color-scheme: dark)').matches
                ? 'dark'
                : 'light'
        );
        return;
    }
    applyTheme(preference);
}

function updateFontName(pathValue: string): void {
    if (!fontNameEl) {
        return;
    }
    fontNameEl.textContent = extractFileNameFromPath(pathValue);
    fontNameEl.setAttribute('title', decodePathSegment(pathValue));
}

// ── Rendering ────────────────────────────────────────────────────

function formatTime(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function truncate(val: unknown, maxLen = 60): string {
    if (val === undefined) return '';
    if (val === null) return 'null';
    const s = typeof val === 'string' ? val : JSON.stringify(val);
    if (s === undefined) return '';
    return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
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
            ${e.op === 'set' && (e.oldValue !== undefined || e.newValue !== undefined) ? `<div class="values">${truncate(e.oldValue)} → ${truncate(e.newValue)}</div>` : ''}
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
    const startupTheme = params.get('theme');
    if (startupTheme === 'light' || startupTheme === 'dark') {
        applyTheme(startupTheme);
    }
    const storedPreference = localStorage.getItem('preferred-theme');
    if (
        storedPreference === 'light' ||
        storedPreference === 'dark' ||
        storedPreference === 'auto'
    ) {
        applyThemePreference(storedPreference);
    }
    updateFontName(extractFontPathFromChannel(channelName));

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

window.addEventListener('message', (event: MessageEvent) => {
    if (event.origin !== window.location.origin) {
        return;
    }

    const data = event.data as {
        type?: string;
        theme?: 'light' | 'dark';
        fontPath?: string;
    } | null;

    if (!data?.type) {
        return;
    }

    if (data.type === 'undo-manager-theme' && data.theme) {
        applyTheme(data.theme);
        return;
    }

    if (data.type === 'undo-manager-metadata') {
        if (data.theme) {
            applyTheme(data.theme);
        }
        if (data.fontPath) {
            updateFontName(data.fontPath);
        }
        return;
    }

    if (data.type === 'undo-manager-reload') {
        window.location.reload();
    }
});

window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key !== 'preferred-theme' || !event.newValue) {
        return;
    }
    if (
        event.newValue !== 'light' &&
        event.newValue !== 'dark' &&
        event.newValue !== 'auto'
    ) {
        return;
    }
    applyThemePreference(event.newValue);
});

if (window.opener && !window.opener.closed) {
    try {
        window.opener.postMessage(
            { type: 'undo-manager-ready' },
            window.location.origin
        );
    } catch {
        // Ignore opener messaging failures.
    }
}

searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    renderList();
});

connect();
