/**
 * PWA update state and Preferences version UI.
 *
 * The inline script in index.html sets window.__pendingUpdate and dispatches
 * 'counterpunch:update-available' when a new service worker activates.
 * Scheduled checks compare the running EDITOR_VERSION to the published
 * service-worker file and GitHub releases so the Preferences gear can notify
 * even before a new worker activates.
 */

import { Logger } from './logger';

const console = new Logger('UpdateManager');

const CHANGELOG_RELEASES_URL =
    'https://github.com/counterpunchspace/editor/releases/tag';

export const AUTO_CHECK_THROTTLE_MS = 60 * 1000;
export const AUTO_CHECK_INTERVAL_MS = 10 * 60 * 1000;

let lastAutoCheckAt = 0;
let checkInFlight = false;
let scheduledChecksInitialized = false;
let preferencesUiInitialized = false;
let forceUpdateOffered = false;
let forceReinstallInFlight = false;

const FORCE_UPDATE_QUERY = 'cp-force-update';

export type PendingUpdate = {
    version: string;
    tag?: string;
    isPreview: boolean;
};

export type SwVersionInfo = {
    tag: string;
    displayVersion: string;
    isPreview: boolean;
};

export type GitHubRelease = {
    tag_name?: string;
    name?: string;
    prerelease?: boolean;
    draft?: boolean;
};

export function getPendingUpdate(): PendingUpdate | null {
    return window.__pendingUpdate ?? null;
}

export function clearPendingUpdate(): void {
    window.__pendingUpdate = null;
}

const VERSION_ASSIGN_RE = /\bVERSION\s*=\s*['"](v[^'"]+)['"]/;
const DISPLAY_VERSION_ASSIGN_RE = /\bDISPLAY_VERSION\s*=\s*['"]([^'"]+)['"]/;
const GITHUB_RELEASES_URL =
    'https://api.github.com/repos/counterpunchspace/editor/releases?per_page=15';

export function parseSwVersions(text: string): SwVersionInfo | null {
    const versionMatch = text.match(VERSION_ASSIGN_RE);
    if (!versionMatch?.[1]) {
        return null;
    }
    const displayMatch = text.match(DISPLAY_VERSION_ASSIGN_RE);
    const tag = versionMatch[1];
    const displayVersion = displayMatch?.[1] || tag;
    return {
        tag,
        displayVersion,
        isPreview:
            tag.includes('preview') ||
            displayVersion.includes('preview') ||
            /^\d+-build-\d+$/.test(displayVersion)
    };
}

export function shouldShowForceUpdate(
    pending: PendingUpdate | null,
    offeredAfterManualCheck: boolean
): boolean {
    return !pending && offeredAfterManualCheck;
}

export function hasAvailableUpdate(
    published: SwVersionInfo,
    runningDisplayVersion: string | null,
    runningTag: string | null = null
): boolean {
    const runningIds = [runningDisplayVersion, runningTag].filter(
        (value): value is string => !!value && value !== 'Unknown'
    );
    if (runningIds.length === 0) {
        return false;
    }
    return !runningIds.some(
        (id) => id === published.displayVersion || id === published.tag
    );
}

export function changelogUrlForUpdate(pending: PendingUpdate): string {
    const releaseTag = pending.tag || pending.version;
    return `${CHANGELOG_RELEASES_URL}/${releaseTag}`;
}

export function pendingUpdateFromSw(info: SwVersionInfo): PendingUpdate {
    return {
        version: info.displayVersion,
        tag: info.tag,
        isPreview: info.isPreview
    };
}

function getRunningDisplayVersion(): string {
    if (window.EDITOR_VERSION) {
        return window.EDITOR_VERSION;
    }
    const versionSpan = document.getElementById('app-version');
    const displayVersion = versionSpan?.dataset.displayVersion;
    if (displayVersion) {
        return displayVersion;
    }
    return versionSpan?.dataset.version || 'Unknown';
}

function getRunningTag(): string | null {
    const running = window.EDITOR_VERSION;
    if (running?.startsWith('v')) {
        return running;
    }
    return null;
}

function setPendingUpdate(pending: PendingUpdate): void {
    window.__pendingUpdate = pending;
    document.dispatchEvent(
        new CustomEvent('counterpunch:update-available', {
            detail: pending
        })
    );
}

function setHidden(element: HTMLElement | null, hidden: boolean): void {
    if (!element) {
        return;
    }
    element.hidden = hidden;
}

function refreshPreferencesVersionUi(): void {
    const versionEl = document.getElementById('settings-current-version');
    if (versionEl) {
        versionEl.textContent = getRunningDisplayVersion();
    }

    const pending = getPendingUpdate();
    const availableRow = document.getElementById('settings-update-available');
    const availableLabel = document.getElementById(
        'settings-update-available-label'
    );
    const changelogLink = document.getElementById(
        'settings-changelog-link'
    ) as HTMLAnchorElement | null;
    const checkBtn = document.getElementById(
        'settings-check-updates-btn'
    ) as HTMLButtonElement | null;
    const updateBtn = document.getElementById(
        'settings-apply-update-btn'
    ) as HTMLButtonElement | null;
    const forceBtn = document.getElementById(
        'settings-force-update-btn'
    ) as HTMLButtonElement | null;

    if (pending) {
        if (availableLabel) {
            availableLabel.textContent = `Update available: ${pending.version}`;
        }
        if (changelogLink) {
            changelogLink.href = changelogUrlForUpdate(pending);
        }
        setHidden(availableRow, false);
        setHidden(checkBtn, true);
        setHidden(updateBtn, false);
        setHidden(forceBtn, true);
    } else {
        setHidden(availableRow, true);
        setHidden(checkBtn, false);
        setHidden(updateBtn, true);
        setHidden(
            forceBtn,
            !shouldShowForceUpdate(pending, forceUpdateOffered)
        );
    }

    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) {
        settingsBtn.classList.toggle('has-update', !!pending);
    }
}

async function fetchPublishedSwVersion(): Promise<SwVersionInfo | null> {
    const response = await fetch(`coi-serviceworker.js?t=${Date.now()}`, {
        cache: 'no-store'
    });
    if (!response.ok) {
        throw new Error(`Could not fetch service worker (${response.status})`);
    }
    return parseSwVersions(await response.text());
}

function prefersPreviewReleases(): boolean {
    return window.location.hostname.includes('preview');
}

async function fetchPublishedGitHubVersion(): Promise<SwVersionInfo | null> {
    const response = await fetch(GITHUB_RELEASES_URL, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`Could not fetch GitHub releases (${response.status})`);
    }
    return pickLatestGitHubRelease(
        (await response.json()) as GitHubRelease[],
        prefersPreviewReleases()
    );
}

export function pickLatestGitHubRelease(
    releases: GitHubRelease[],
    preview: boolean
): SwVersionInfo | null {
    const release = releases.find((item) => {
        if (!item.tag_name || item.draft) {
            return false;
        }
        return preview ? !!item.prerelease : !item.prerelease;
    });
    if (!release?.tag_name) {
        return null;
    }
    const displayVersion = release.name || release.tag_name;
    return {
        tag: release.tag_name,
        displayVersion,
        isPreview:
            !!release.prerelease ||
            release.tag_name.includes('preview') ||
            /^\d+-build-\d+$/.test(displayVersion)
    };
}

async function resolvePublishedVersion(): Promise<SwVersionInfo | null> {
    const runningDisplay = getRunningDisplayVersion();
    const runningTag = getRunningTag();
    const [fromSw, fromGitHub] = await Promise.all([
        fetchPublishedSwVersion().catch((error) => {
            console.warn(
                'Published service worker lookup failed:',
                error instanceof Error ? error.message : String(error)
            );
            return null;
        }),
        fetchPublishedGitHubVersion().catch((error) => {
            console.warn(
                'GitHub releases lookup failed:',
                error instanceof Error ? error.message : String(error)
            );
            return null;
        })
    ]);
    if (fromSw && hasAvailableUpdate(fromSw, runningDisplay, runningTag)) {
        return fromSw;
    }
    if (
        fromGitHub &&
        hasAvailableUpdate(fromGitHub, runningDisplay, runningTag)
    ) {
        return fromGitHub;
    }
    return fromSw || fromGitHub;
}

export function isAutoCheckThrottled(
    lastCheckAt: number,
    now: number = Date.now()
): boolean {
    return lastCheckAt > 0 && now - lastCheckAt < AUTO_CHECK_THROTTLE_MS;
}

function shouldSkipScheduledChecks(): boolean {
    if (typeof window === 'undefined') {
        return true;
    }
    if (window.isTestMode?.() || window.isDevelopment?.()) {
        return true;
    }
    return !navigator.serviceWorker;
}

function isDevBuild(displayVersion: string): boolean {
    return displayVersion.endsWith('-dev');
}

async function checkForUpdates(userInitiated = false): Promise<void> {
    if (checkInFlight && !userInitiated) {
        return;
    }
    checkInFlight = true;
    lastAutoCheckAt = Date.now();

    const statusEl = document.getElementById('settings-update-status');
    const checkBtn = document.getElementById(
        'settings-check-updates-btn'
    ) as HTMLButtonElement | null;
    const forceBtn = document.getElementById(
        'settings-force-update-btn'
    ) as HTMLButtonElement | null;
    if (userInitiated && statusEl) {
        statusEl.textContent = 'Checking for updates…';
    }
    if (userInitiated && checkBtn) {
        checkBtn.disabled = true;
    }
    if (userInitiated && forceBtn) {
        forceBtn.disabled = true;
    }

    try {
        const registration = navigator.serviceWorker
            ? await navigator.serviceWorker.getRegistration()
            : undefined;
        const updatePromise = (
            registration?.update() ?? Promise.resolve()
        ).catch((error) => {
            console.warn(
                'Service worker update() failed:',
                error instanceof Error ? error.message : String(error)
            );
        });
        const publishedPromise = resolvePublishedVersion();
        await Promise.race([
            updatePromise,
            new Promise<void>((resolve) => {
                window.setTimeout(resolve, 8000);
            })
        ]);
        const published = await publishedPromise;
        const runningDisplay = getRunningDisplayVersion();
        const runningTag = getRunningTag();
        const waitingWorker = !!registration?.waiting;

        if (
            published &&
            !isDevBuild(runningDisplay) &&
            (hasAvailableUpdate(published, runningDisplay, runningTag) ||
                waitingWorker)
        ) {
            setPendingUpdate(pendingUpdateFromSw(published));
            if (statusEl) {
                statusEl.textContent = '';
            }
            return;
        }

        if (userInitiated && statusEl) {
            statusEl.textContent = getPendingUpdate()
                ? ''
                : 'You’re up to date.';
        }
        if (userInitiated && !getPendingUpdate()) {
            forceUpdateOffered = true;
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('Update check failed:', message);
        if (userInitiated && statusEl) {
            statusEl.textContent = 'Could not check for updates.';
        }
        if (userInitiated) {
            forceUpdateOffered = true;
        }
    } finally {
        checkInFlight = false;
        if (checkBtn) {
            checkBtn.disabled = false;
        }
        const forceBtn = document.getElementById(
            'settings-force-update-btn'
        ) as HTMLButtonElement | null;
        if (forceBtn) {
            forceBtn.disabled = forceReinstallInFlight;
        }
        refreshPreferencesVersionUi();
    }
}

function runScheduledUpdateCheck(bypassThrottle: boolean): void {
    if (checkInFlight) {
        return;
    }
    if (!bypassThrottle && isAutoCheckThrottled(lastAutoCheckAt)) {
        return;
    }
    void checkForUpdates(false);
}

function initScheduledUpdateChecks(): void {
    if (scheduledChecksInitialized || shouldSkipScheduledChecks()) {
        return;
    }
    scheduledChecksInitialized = true;

    runScheduledUpdateCheck(false);

    const onBecameVisible = () => {
        if (document.visibilityState === 'hidden') {
            return;
        }
        runScheduledUpdateCheck(false);
    };
    window.addEventListener('focus', onBecameVisible);
    window.addEventListener('pageshow', onBecameVisible);
    document.addEventListener('visibilitychange', onBecameVisible);

    window.setInterval(() => {
        runScheduledUpdateCheck(true);
    }, AUTO_CHECK_INTERVAL_MS);
}

function applyPendingUpdate(): void {
    const reload = () => {
        window.location.reload();
    };
    if (!navigator.serviceWorker) {
        reload();
        return;
    }
    void navigator.serviceWorker.getRegistration().then((registration) => {
        if (!registration?.waiting) {
            reload();
            return;
        }
        navigator.serviceWorker.addEventListener('controllerchange', reload, {
            once: true
        });
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        window.setTimeout(reload, 2000);
    });
}

function stripForceUpdateQuery(): void {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(FORCE_UPDATE_QUERY)) {
        return;
    }
    url.searchParams.delete(FORCE_UPDATE_QUERY);
    window.history.replaceState(window.history.state, '', url.toString());
}

/**
 * Drop the service worker and Cache Storage, then reload from the network.
 * Used when version comparison reports no update but the running shell may
 * still be a stale cached build.
 */
async function forceReinstallFromNetwork(): Promise<void> {
    if (forceReinstallInFlight) {
        return;
    }
    forceReinstallInFlight = true;

    const statusEl = document.getElementById('settings-update-status');
    const checkBtn = document.getElementById(
        'settings-check-updates-btn'
    ) as HTMLButtonElement | null;
    const forceBtn = document.getElementById(
        'settings-force-update-btn'
    ) as HTMLButtonElement | null;
    if (statusEl) {
        statusEl.textContent = 'Reinstalling from the network…';
    }
    if (checkBtn) {
        checkBtn.disabled = true;
    }
    if (forceBtn) {
        forceBtn.disabled = true;
    }

    try {
        if ('caches' in window) {
            const cacheNames = await caches.keys();
            await Promise.all(cacheNames.map((name) => caches.delete(name)));
        }
        if (navigator.serviceWorker) {
            const registration =
                await navigator.serviceWorker.getRegistration();
            if (registration?.waiting) {
                registration.waiting.postMessage({ type: 'SKIP_WAITING' });
            }
            await registration?.unregister();
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('Force update failed:', message);
    }

    const url = new URL(window.location.href);
    url.searchParams.set(FORCE_UPDATE_QUERY, String(Date.now()));
    window.location.replace(url.toString());
}

export function initPreferencesVersionUi(): void {
    stripForceUpdateQuery();
    refreshPreferencesVersionUi();
    initScheduledUpdateChecks();

    if (preferencesUiInitialized) {
        return;
    }
    preferencesUiInitialized = true;

    document
        .getElementById('settings-check-updates-btn')
        ?.addEventListener('click', () => {
            void checkForUpdates(true);
        });
    document
        .getElementById('settings-apply-update-btn')
        ?.addEventListener('click', () => {
            applyPendingUpdate();
        });
    document
        .getElementById('settings-force-update-btn')
        ?.addEventListener('click', () => {
            void forceReinstallFromNetwork();
        });

    document.addEventListener('counterpunch:update-available', () => {
        const statusEl = document.getElementById('settings-update-status');
        if (statusEl && getPendingUpdate()) {
            statusEl.textContent = '';
        }
        refreshPreferencesVersionUi();
    });
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPreferencesVersionUi);
    } else {
        initPreferencesVersionUi();
    }
}
