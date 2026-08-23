import { Logger } from './logger';

const console = new Logger('WindowUi');

const TITLE_BAR_PX = 24;
const DOCS_MIN_PX = 200;
const DEFAULT_DOCS_PX = 340;
const COLLAPSE_SLOP_PX = 5;
const SAVE_DEBOUNCE_MS = 200;
const DISABLED_PLUGIN_PREFIX = '-';

export const DEFAULT_WINDOW_UI_STRING = 'v1;docs=-;rows=100,-;top=0,33,67';

export type OverviewDisplayMode = 'normal' | 'matrix';
export type PreviewArea = 'small' | 'medium' | 'full';

export type CanvasPluginRecord = {
    id: string;
    params: Record<string, string>;
};

export type WindowUiState = {
    docs: number | null;
    rows: { top: number; bottom: number | null };
    top: [number, number, number];
    bottom: [number, number, number, number] | null;
    filters: string[];
    overviewMode: OverviewDisplayMode;
    overviewSize: number;
    follow: boolean;
    fontinfo: string | null;
    docsPage: string | null;
    historyUnreachable: boolean;
    guides: boolean;
    metrics: boolean;
    preview: PreviewArea;
    plugins: CanvasPluginRecord[];
    /** Params for plugins that are off. Persisted, but not in the enabled set. */
    disabledPlugins: CanvasPluginRecord[];
    focus: string | null;
};

const DEFAULT_BOTTOM: [number, number, number, number] = [25, 25, 25, 25];

const DEFAULT_STATE: WindowUiState = {
    docs: null,
    rows: { top: 100, bottom: null },
    top: [0, 33, 67],
    bottom: null,
    filters: [],
    overviewMode: 'normal',
    overviewSize: 5,
    follow: false,
    fontinfo: null,
    docsPage: null,
    historyUnreachable: false,
    guides: false,
    metrics: false,
    preview: 'small',
    plugins: [],
    disabledPlugins: [],
    focus: null
};

type WindowUiRuntime = {
    loaded: boolean;
    applying: boolean;
    slot: string | null;
    state: WindowUiState;
    lastDocsPercent: number | null;
    lastBottom: [number, number, number, number] | null;
    saveTimer: number | null;
    pagehideBound: boolean;
};

function createRuntime(): WindowUiRuntime {
    return {
        loaded: false,
        applying: false,
        slot: null,
        state: cloneState(DEFAULT_STATE),
        lastDocsPercent: null,
        lastBottom: null,
        saveTimer: null,
        pagehideBound: false
    };
}

/**
 * Bootstrap and glyph-overview are separate webpack entries, so this
 * module is evaluated twice. Keep one runtime on window so layout
 * persist cannot wipe overview mode, tile size, or other extras.
 */
function getRuntime(): WindowUiRuntime {
    const existing = window.__windowUiRuntime;
    if (existing) {
        return existing;
    }
    const created = createRuntime();
    window.__windowUiRuntime = created;
    return created;
}

function clonePluginRecords(
    records: CanvasPluginRecord[]
): CanvasPluginRecord[] {
    return records.map((plugin) => ({
        id: plugin.id,
        params: { ...plugin.params }
    }));
}

function cloneState(value: WindowUiState): WindowUiState {
    return {
        ...value,
        rows: { ...value.rows },
        top: [...value.top],
        bottom: value.bottom ? [...value.bottom] : null,
        filters: [...(value.filters || [])],
        plugins: clonePluginRecords(value.plugins),
        disabledPlugins: clonePluginRecords(value.disabledPlugins || [])
    };
}

function pluginRecordsToMap(
    records: CanvasPluginRecord[]
): Map<string, Record<string, string>> {
    const map = new Map<string, Record<string, string>>();
    for (const plugin of records) {
        map.set(plugin.id, { ...plugin.params });
    }
    return map;
}

export function getWindowUiSlot(): string {
    const role = window.windowRole;
    if (!role || role.linkedOrdinal === null) {
        return 'main';
    }
    return String(role.linkedOrdinal);
}

/**
 * Per-window chrome layout and UI prefs as one compact v1 string.
 * Keys are `windowUi.main` and `windowUi.${slot}` for linked windows.
 */
export function getWindowUiStorageKey(
    slot: string = getWindowUiSlot()
): string {
    return `windowUi.${slot}`;
}

export function isApplyingWindowUi(): boolean {
    return getRuntime().applying;
}

export function renormalizePercents(values: number[]): number[] {
    const rounded = values.map((value) =>
        value <= 0 ? 0 : Math.max(0, Math.round(value))
    );
    const openIndexes: number[] = [];
    rounded.forEach((value, index) => {
        if (value > 0) {
            openIndexes.push(index);
        }
    });
    if (openIndexes.length === 0) {
        return rounded;
    }
    const sum = openIndexes.reduce((total, index) => total + rounded[index], 0);
    rounded[openIndexes[openIndexes.length - 1]] += 100 - sum;
    return rounded;
}

function parseClosedOrInt(raw: string): number | null {
    if (raw === '-' || raw === '') {
        return null;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function clampOpenPercent(value: number): number {
    return Math.min(100, Math.max(1, value));
}

export function parseOverviewDisplayMode(
    raw: string | null | undefined
): OverviewDisplayMode {
    if (raw === 'matrix' || raw === 'grid') {
        return 'matrix';
    }
    return 'normal';
}

function parsePreview(raw: string | null | undefined): PreviewArea {
    if (raw === 'medium' || raw === 'full') {
        return raw;
    }
    return 'small';
}

function encodePluginToken(value: string): string {
    return /[,;+:%]/.test(value) ? encodeURIComponent(value) : value;
}

function decodePluginToken(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

export function encodePlugins(plugins: CanvasPluginRecord[]): string {
    return plugins
        .map((plugin) => {
            const parts = [encodePluginToken(plugin.id)];
            for (const [key, value] of Object.entries(plugin.params)) {
                parts.push(
                    `${encodePluginToken(key)}:${encodePluginToken(value)}`
                );
            }
            return parts.join('+');
        })
        .join(',');
}

export function decodePlugins(raw: string): CanvasPluginRecord[] {
    if (!raw) {
        return [];
    }
    const plugins: CanvasPluginRecord[] = [];
    for (const record of raw.split(',')) {
        if (!record) {
            continue;
        }
        const bits = record.split('+');
        const id = decodePluginToken(bits[0] || '');
        if (!id) {
            continue;
        }
        const params: Record<string, string> = {};
        for (const bit of bits.slice(1)) {
            const colon = bit.indexOf(':');
            if (colon <= 0) {
                continue;
            }
            const key = decodePluginToken(bit.slice(0, colon));
            const value = decodePluginToken(bit.slice(colon + 1));
            if (key) {
                params[key] = value;
            }
        }
        plugins.push({ id, params });
    }
    return plugins;
}

function splitEncodedPluginRecords(records: CanvasPluginRecord[]): {
    enabled: CanvasPluginRecord[];
    disabled: CanvasPluginRecord[];
} {
    const enabled: CanvasPluginRecord[] = [];
    const disabled: CanvasPluginRecord[] = [];
    for (const plugin of records) {
        if (plugin.id.startsWith(DISABLED_PLUGIN_PREFIX)) {
            const id = plugin.id.slice(DISABLED_PLUGIN_PREFIX.length);
            if (id) {
                disabled.push({ id, params: plugin.params });
            }
            continue;
        }
        enabled.push(plugin);
    }
    return { enabled, disabled };
}

function pluginsFieldRecords(ui: WindowUiState): CanvasPluginRecord[] {
    const disabled = (ui.disabledPlugins || [])
        .filter((plugin) => Object.keys(plugin.params).length > 0)
        .map((plugin) => ({
            id: `${DISABLED_PLUGIN_PREFIX}${plugin.id}`,
            params: plugin.params
        }));
    return [...ui.plugins, ...disabled];
}

function encodeFilterList(filters: string[]): string {
    return filters
        .filter(Boolean)
        .map((id) => encodeURIComponent(id))
        .join(',');
}

function decodeFilterList(raw: string): string[] {
    if (!raw) {
        return [];
    }
    const ids: string[] = [];
    for (const token of raw.split(',')) {
        if (!token) {
            continue;
        }
        try {
            ids.push(decodeURIComponent(token));
        } catch {
            ids.push(token);
        }
    }
    return ids;
}

export function encodeWindowUi(ui: WindowUiState): string {
    const parts = ['v1'];
    parts.push(ui.docs == null ? 'docs=-' : `docs=${Math.round(ui.docs)}`);
    if (ui.rows.bottom == null) {
        parts.push('rows=100,-');
    } else {
        const rows = renormalizePercents([ui.rows.top, ui.rows.bottom]);
        parts.push(`rows=${rows[0]},${rows[1]}`);
    }
    parts.push(
        `top=${(renormalizePercents([...ui.top]) as [number, number, number]).join(',')}`
    );
    const bottom = ui.bottom ?? getRuntime().lastBottom;
    if (bottom) {
        parts.push(`bottom=${renormalizePercents([...bottom]).join(',')}`);
    }
    if (ui.filters.length > 0) {
        parts.push(`filter=${encodeFilterList(ui.filters)}`);
    }
    if (ui.overviewMode !== 'normal' || ui.overviewSize !== 5) {
        parts.push(`overview=${ui.overviewMode},${ui.overviewSize}`);
    }
    if (ui.follow) {
        parts.push('follow=1');
    }
    if (ui.fontinfo && ui.fontinfo !== 'names') {
        parts.push(`fontinfo=${ui.fontinfo}`);
    }
    if (ui.docsPage) {
        parts.push(`docsPage=${ui.docsPage}`);
    }
    if (ui.historyUnreachable) {
        parts.push('historyUnreachable=1');
    }
    if (ui.guides) {
        parts.push('guides=1');
    }
    if (ui.metrics) {
        parts.push('metrics=1');
    }
    if (ui.preview !== 'small') {
        parts.push(`preview=${ui.preview}`);
    }
    const pluginRecords = pluginsFieldRecords(ui);
    if (pluginRecords.length > 0) {
        parts.push(`plugins=${encodePlugins(pluginRecords)}`);
    }
    if (ui.focus) {
        parts.push(`focus=${ui.focus}`);
    }
    return parts.join(';');
}

export function decodeWindowUi(raw: string | null | undefined): WindowUiState {
    if (!raw || typeof raw !== 'string' || !raw.startsWith('v1;')) {
        return cloneState(DEFAULT_STATE);
    }
    const fields = new Map<string, string>();
    for (const part of raw.split(';').slice(1)) {
        const eq = part.indexOf('=');
        if (eq <= 0) {
            return cloneState(DEFAULT_STATE);
        }
        fields.set(part.slice(0, eq), part.slice(eq + 1));
    }
    if (!fields.has('docs') || !fields.has('rows') || !fields.has('top')) {
        return cloneState(DEFAULT_STATE);
    }

    const next = cloneState(DEFAULT_STATE);
    next.docs = parseClosedOrInt(fields.get('docs') || '-');
    if (next.docs != null) {
        next.docs = clampOpenPercent(next.docs);
        getRuntime().lastDocsPercent = next.docs;
    }

    const rowParts = (fields.get('rows') || '').split(',');
    const rowTop = Number.parseInt(rowParts[0] || '100', 10);
    const rowBottom = parseClosedOrInt(rowParts[1] || '-');
    if (rowBottom == null) {
        next.rows = { top: 100, bottom: null };
    } else {
        const rows = renormalizePercents([
            Number.isFinite(rowTop) ? rowTop : 100,
            rowBottom
        ]);
        next.rows = { top: rows[0], bottom: rows[1] };
    }

    const topParts = (fields.get('top') || '').split(',').map((part) => {
        const parsed = Number.parseInt(part, 10);
        return Number.isFinite(parsed) ? parsed : 0;
    });
    while (topParts.length < 3) {
        topParts.push(0);
    }
    next.top = renormalizePercents(topParts.slice(0, 3)) as [
        number,
        number,
        number
    ];

    if (fields.has('bottom')) {
        const bottomParts = (fields.get('bottom') || '')
            .split(',')
            .map((part) => {
                const parsed = Number.parseInt(part, 10);
                return Number.isFinite(parsed) ? parsed : 0;
            });
        while (bottomParts.length < 4) {
            bottomParts.push(0);
        }
        next.bottom = renormalizePercents(bottomParts.slice(0, 4)) as [
            number,
            number,
            number,
            number
        ];
        getRuntime().lastBottom = [...next.bottom];
    }

    next.filters = decodeFilterList(fields.get('filter') || '');

    const overview = fields.get('overview');
    if (overview) {
        const [modeRaw, sizeRaw] = overview.split(',');
        next.overviewMode = parseOverviewDisplayMode(modeRaw);
        const size = Number.parseInt(sizeRaw || '5', 10);
        next.overviewSize = Number.isFinite(size)
            ? Math.min(10, Math.max(0, size))
            : 5;
    }

    if (fields.has('follow')) {
        next.follow = fields.get('follow') === '1';
    }
    next.fontinfo = fields.get('fontinfo') || null;
    next.docsPage = fields.get('docsPage') || null;
    if (fields.has('historyUnreachable')) {
        next.historyUnreachable = fields.get('historyUnreachable') === '1';
    }
    if (fields.has('guides')) {
        next.guides = fields.get('guides') === '1';
    }
    if (fields.has('metrics')) {
        next.metrics = fields.get('metrics') === '1';
    }
    if (fields.has('preview')) {
        next.preview = parsePreview(fields.get('preview'));
    }
    if (fields.has('plugins')) {
        const split = splitEncodedPluginRecords(
            decodePlugins(fields.get('plugins') || '')
        );
        next.plugins = split.enabled;
        next.disabledPlugins = split.disabled;
    }
    next.focus = fields.get('focus') || null;
    return next;
}

function viewportWidth(): number {
    return window.innerWidth || document.documentElement.clientWidth || 1;
}

function viewportHeight(): number {
    return window.innerHeight || document.documentElement.clientHeight || 1;
}

function pxToDocsPercent(px: number): number {
    return clampOpenPercent(Math.round((px / viewportWidth()) * 100));
}

function bindPagehideFlush(): void {
    const rt = getRuntime();
    if (rt.pagehideBound) {
        return;
    }
    rt.pagehideBound = true;
    window.addEventListener('pagehide', () => {
        flushSaveWindowUi();
    });
}

function loadSlotIntoRuntime(rt: WindowUiRuntime, slot: string): WindowUiState {
    /**
     * Compact v1 chrome layout and window-local UI prefs for this window slot
     * (`main` or a linked ordinal).
     */
    const existing = localStorage.getItem(`windowUi.${slot}`);
    if (existing) {
        rt.state = decodeWindowUi(existing);
        if (rt.state.docs != null) {
            rt.lastDocsPercent = rt.state.docs;
        }
        if (rt.state.bottom) {
            rt.lastBottom = [...rt.state.bottom];
        }
        return rt.state;
    }

    rt.state = cloneState(DEFAULT_STATE);
    localStorage.setItem(`windowUi.${slot}`, DEFAULT_WINDOW_UI_STRING);
    return rt.state;
}

export function ensureWindowUiLoaded(): WindowUiState {
    const rt = getRuntime();
    const slot = getWindowUiSlot();
    bindPagehideFlush();
    if (rt.loaded && rt.slot === slot) {
        return rt.state;
    }
    rt.loaded = true;
    rt.slot = slot;
    return loadSlotIntoRuntime(rt, slot);
}

function persistWindowUi(): void {
    const rt = getRuntime();
    ensureWindowUiLoaded();
    const slot = rt.slot ?? getWindowUiSlot();
    localStorage.setItem(`windowUi.${slot}`, encodeWindowUi(rt.state));
}

function scheduleSave(): void {
    const rt = getRuntime();
    if (rt.applying) {
        return;
    }
    if (rt.saveTimer != null) {
        window.clearTimeout(rt.saveTimer);
    }
    rt.saveTimer = window.setTimeout(() => {
        rt.saveTimer = null;
        persistWindowUi();
    }, SAVE_DEBOUNCE_MS);
}

export function flushSaveWindowUi(): void {
    const rt = getRuntime();
    if (rt.saveTimer != null) {
        window.clearTimeout(rt.saveTimer);
        rt.saveTimer = null;
    }
    persistWindowUi();
}

export function getWindowUiState(): WindowUiState {
    return ensureWindowUiLoaded();
}

export function captureWindowUiFromDom(): WindowUiState {
    ensureWindowUiLoaded();
    const rt = getRuntime();
    const state = rt.state;
    const shell = document.getElementById('app-shell');
    const docs = document.getElementById('view-docs');
    const topRow = document.querySelector('.top-row') as HTMLElement | null;
    const bottomRow = document.querySelector(
        '.bottom-row'
    ) as HTMLElement | null;

    if (shell && docs) {
        if (shell.classList.contains('docs-open')) {
            const percent = pxToDocsPercent(
                Math.max(DOCS_MIN_PX, docs.offsetWidth || DEFAULT_DOCS_PX)
            );
            state.docs = percent;
            rt.lastDocsPercent = percent;
        } else {
            state.docs = null;
        }
    }

    if (topRow && bottomRow) {
        const container = topRow.parentElement;
        const height = container?.clientHeight || viewportHeight();
        const bottomClosed =
            bottomRow.offsetHeight <= TITLE_BAR_PX + COLLAPSE_SLOP_PX;
        if (bottomClosed || height <= 0) {
            state.rows = { top: 100, bottom: null };
        } else {
            const topPct = Math.round((topRow.offsetHeight / height) * 100);
            const rows = renormalizePercents([topPct, 100 - topPct]);
            state.rows = { top: rows[0], bottom: rows[1] };
        }
    }

    if (topRow) {
        const views = Array.from(
            topRow.querySelectorAll('.view')
        ) as HTMLElement[];
        if (views.length >= 3) {
            const shares = views.slice(0, 3).map((view) => {
                if (
                    view.offsetWidth <= TITLE_BAR_PX + COLLAPSE_SLOP_PX ||
                    view.classList.contains('collapsed-width')
                ) {
                    return 0;
                }
                return Math.max(view.offsetWidth, 1);
            });
            state.top = renormalizePercents(shares) as [number, number, number];
        }
    }

    if (bottomRow && state.rows.bottom != null) {
        const views = Array.from(
            bottomRow.querySelectorAll('.view')
        ) as HTMLElement[];
        if (views.length >= 4) {
            const shares = views
                .slice(0, 4)
                .map((view) => Math.max(view.offsetWidth, 1));
            state.bottom = renormalizePercents(shares) as [
                number,
                number,
                number,
                number
            ];
            rt.lastBottom = [...state.bottom];
        }
    }

    return state;
}

function applyFlexPercents(
    views: HTMLElement[],
    percents: number[],
    collapsedClass: 'collapsed-width' | 'collapsed'
): void {
    percents.forEach((percent, index) => {
        const view = views[index];
        if (!view) {
            return;
        }
        if (percent <= 0) {
            view.style.flex = `0 0 ${TITLE_BAR_PX}px`;
            view.classList.add(collapsedClass);
            view.classList.remove(
                collapsedClass === 'collapsed-width'
                    ? 'collapsed'
                    : 'collapsed-width'
            );
            return;
        }
        view.style.flex = String(percent);
        view.classList.remove('collapsed-width', 'collapsed');
    });
}

export function applyWindowUi(
    ui: WindowUiState = ensureWindowUiLoaded()
): void {
    const rt = getRuntime();
    rt.applying = true;
    rt.state = cloneState(ui);
    try {
        const shell = document.getElementById('app-shell');
        const docs = document.getElementById('view-docs');
        if (shell && docs) {
            if (ui.docs == null) {
                docs.style.flex = '0 0 0px';
                shell.classList.remove('docs-open');
                docs.setAttribute('aria-hidden', 'true');
            } else {
                const widthPx = Math.max(
                    DOCS_MIN_PX,
                    Math.round(
                        (ui.docs / 100) * (shell.clientWidth || viewportWidth())
                    )
                );
                docs.style.flex = `0 0 ${widthPx}px`;
                shell.classList.add('docs-open');
                docs.setAttribute('aria-hidden', 'false');
                rt.lastDocsPercent = ui.docs;
            }
        }

        const topRow = document.querySelector('.top-row') as HTMLElement | null;
        const bottomRow = document.querySelector(
            '.bottom-row'
        ) as HTMLElement | null;
        if (topRow && bottomRow) {
            if (ui.rows.bottom == null) {
                topRow.style.flex = '1';
                bottomRow.style.flex = `0 0 ${TITLE_BAR_PX}px`;
            } else {
                topRow.style.flex = String(ui.rows.top);
                bottomRow.style.flex = String(ui.rows.bottom);
            }
        }

        if (topRow) {
            applyFlexPercents(
                Array.from(topRow.querySelectorAll('.view')) as HTMLElement[],
                ui.top,
                'collapsed-width'
            );
        }

        if (bottomRow) {
            applyFlexPercents(
                Array.from(
                    bottomRow.querySelectorAll('.view')
                ) as HTMLElement[],
                ui.bottom ?? rt.lastBottom ?? DEFAULT_BOTTOM,
                'collapsed'
            );
        }

        window.resizableViews?.normalizeTopRowWidths();
        window.resizableViews?.syncCollapsedStatesAfterLayoutRestore();
    } finally {
        rt.applying = false;
    }
}

export function saveWindowUiFromDom(): void {
    captureWindowUiFromDom();
    persistWindowUi();
}

export function scheduleSaveWindowUi(): void {
    captureWindowUiFromDom();
    scheduleSave();
}

function mutate(patch: Partial<WindowUiState>): void {
    ensureWindowUiLoaded();
    Object.assign(getRuntime().state, patch);
    scheduleSave();
}

export function getGlyphFilterIds(): string[] {
    return [...ensureWindowUiLoaded().filters];
}

export function setGlyphFilterIds(ids: string[]): void {
    mutate({ filters: [...new Set(ids.filter(Boolean))] });
}

export function getOverviewDisplayMode(): OverviewDisplayMode {
    return ensureWindowUiLoaded().overviewMode;
}

export function setOverviewDisplayMode(mode: string): void {
    mutate({ overviewMode: parseOverviewDisplayMode(mode) });
}

export function getOverviewSize(): number {
    return ensureWindowUiLoaded().overviewSize;
}

export function setOverviewSize(size: number): void {
    const next = Number.isFinite(size)
        ? Math.min(10, Math.max(0, Math.round(size)))
        : 5;
    mutate({ overviewSize: next });
}

export function isOverviewFollowEnabled(): boolean {
    return ensureWindowUiLoaded().follow;
}

export function setOverviewFollowEnabled(enabled: boolean): void {
    mutate({ follow: enabled });
}

export function getFontInfoSection(): string | null {
    return ensureWindowUiLoaded().fontinfo;
}

export function setFontInfoSection(section: string): void {
    mutate({ fontinfo: section || null });
}

export function isHistoryUnreachableEnabled(): boolean {
    return ensureWindowUiLoaded().historyUnreachable;
}

export function setHistoryUnreachableEnabled(enabled: boolean): void {
    mutate({ historyUnreachable: enabled });
}

export function isGuidelinesVisible(): boolean {
    return ensureWindowUiLoaded().guides;
}

export function setGuidelinesVisible(visible: boolean): void {
    mutate({ guides: visible });
}

export function isShowAllMetricsEnabled(): boolean {
    return ensureWindowUiLoaded().metrics;
}

export function setShowAllMetricsEnabled(enabled: boolean): void {
    mutate({ metrics: enabled });
}

export function getPreviewArea(): PreviewArea {
    return ensureWindowUiLoaded().preview;
}

export function setPreviewAreaPreference(area: PreviewArea): void {
    mutate({ preview: parsePreview(area) });
}

export function getFocusViewId(): string | null {
    return ensureWindowUiLoaded().focus;
}

export function setFocusViewId(viewId: string | null): void {
    mutate({ focus: viewId });
}

export function getDocsPageId(): string | null {
    return ensureWindowUiLoaded().docsPage;
}

export function setDocsPageId(id: string): void {
    mutate({ docsPage: id });
}

export function isDocsOpen(): boolean {
    return ensureWindowUiLoaded().docs != null;
}

export function getDocsWidthPx(): number {
    ensureWindowUiLoaded();
    const rt = getRuntime();
    const percent = rt.state.docs ?? rt.lastDocsPercent;
    if (percent == null) {
        return DEFAULT_DOCS_PX;
    }
    const shell = document.getElementById('app-shell');
    const width = shell?.clientWidth || viewportWidth();
    return Math.max(DOCS_MIN_PX, Math.round((percent / 100) * width));
}

export function getEnabledCanvasPluginIds(): string[] {
    return ensureWindowUiLoaded().plugins.map((plugin) => plugin.id);
}

export function setEnabledCanvasPluginIds(ids: string[]): void {
    ensureWindowUiLoaded();
    const state = getRuntime().state;
    const enabled = new Set(ids);
    const currentById = pluginRecordsToMap(state.plugins);
    const disabledById = pluginRecordsToMap(state.disabledPlugins);
    for (const id of currentById.keys()) {
        if (!enabled.has(id)) {
            disabledById.set(id, {
                ...(disabledById.get(id) || {}),
                ...(currentById.get(id) || {})
            });
        }
    }
    state.plugins = ids.map((id) => ({
        id,
        params: {
            ...(disabledById.get(id) || {}),
            ...(currentById.get(id) || {})
        }
    }));
    for (const id of ids) {
        disabledById.delete(id);
    }
    state.disabledPlugins = [...disabledById.entries()].map(([id, params]) => ({
        id,
        params
    }));
    scheduleSave();
}

export function getCanvasPluginParam(
    className: string,
    paramId: string
): string | null {
    ensureWindowUiLoaded();
    const state = getRuntime().state;
    for (const plugin of state.plugins) {
        if (plugin.id === className && paramId in plugin.params) {
            return plugin.params[paramId];
        }
    }
    for (const plugin of state.disabledPlugins) {
        if (plugin.id === className && paramId in plugin.params) {
            return plugin.params[paramId];
        }
    }
    return null;
}

export function setCanvasPluginParam(
    className: string,
    paramId: string,
    value: string
): void {
    ensureWindowUiLoaded();
    const state = getRuntime().state;
    const plugin = state.plugins.find((entry) => entry.id === className);
    if (plugin) {
        plugin.params[paramId] = value;
        scheduleSave();
        return;
    }
    const disabled = state.disabledPlugins.find(
        (entry) => entry.id === className
    );
    if (disabled) {
        disabled.params[paramId] = value;
    } else {
        state.disabledPlugins.push({
            id: className,
            params: { [paramId]: value }
        });
    }
    scheduleSave();
}

const windowUiApi = {
    getCanvasPluginParam,
    setCanvasPluginParam,
    getEnabledCanvasPluginIds,
    setEnabledCanvasPluginIds,
    getState: getWindowUiState,
    save: saveWindowUiFromDom,
    apply: applyWindowUi
};

declare global {
    interface Window {
        windowUi: typeof windowUiApi;
        __windowUiRuntime?: WindowUiRuntime;
    }
}

window.windowUi = windowUiApi;
ensureWindowUiLoaded();
