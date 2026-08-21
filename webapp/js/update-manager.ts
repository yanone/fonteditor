/**
 * PWA update state and Preferences version UI.
 *
 * The inline script in index.html sets window.__pendingUpdate and dispatches
 * 'counterpunch:update-available' when a new service worker activates.
 * Scheduled checks also compare the published service-worker tag so the
 * Preferences gear can notify even before that message arrives.
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

export function getPendingUpdate(): PendingUpdate | null {
    return window.__pendingUpdate ?? null;
}

export function clearPendingUpdate(): void {
    window.__pendingUpdate = null;
}

export function parseSwVersions(text: string): SwVersionInfo | null {
    const versionMatch = text.match(
        /const\s+VERSION\s*=\s*['"](v[^\s'"]+)['"]/
    );
    if (!versionMatch?.[1]) {
        return null;
    }
    const displayMatch = text.match(
        /const\s+DISPLAY_VERSION\s*=\s*['"]([^'"]+)['"]/
    );
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

function getInstalledDisplayVersion(): string {
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

function getInstalledTag(): string | null {
    const versionSpan = document.getElementById('app-version');
    return versionSpan?.dataset.version || window.EDITOR_VERSION || null;
}

async function getInstalledTagWhenReady(): Promise<string | null> {
    const existing = document.getElementById('app-version')?.dataset.version;
    if (existing) {
        return existing;
    }
    const timeoutAt = Date.now() + 4000;
    while (Date.now() < timeoutAt) {
        await new Promise((resolve) => {
            window.setTimeout(resolve, 50);
        });
        const tag = document.getElementById('app-version')?.dataset.version;
        if (tag) {
            return tag;
        }
    }
    return getInstalledTag();
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
        versionEl.textContent = getInstalledDisplayVersion();
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
    } else {
        setHidden(availableRow, true);
        setHidden(checkBtn, false);
        setHidden(updateBtn, true);
    }

    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) {
        settingsBtn.classList.toggle('has-update', !!pending);
    }
}

async function fetchPublishedSwVersion(): Promise<SwVersionInfo | null> {
    const response = await fetch(`coi-serviceworker.js?t=${Date.now()}`, {
        cache: 'reload'
    });
    if (!response.ok) {
        throw new Error(`Could not fetch service worker (${response.status})`);
    }
    return parseSwVersions(await response.text());
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
    if (window.isTestMode?.() || window.isTest?.()) {
        return true;
    }
    return !navigator.serviceWorker;
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
    if (userInitiated && statusEl) {
        statusEl.textContent = 'Checking for updates…';
    }
    if (userInitiated && checkBtn) {
        checkBtn.disabled = true;
    }

    try {
        if (navigator.serviceWorker) {
            const registration =
                await navigator.serviceWorker.getRegistration();
            await registration?.update();
        }

        const published = await fetchPublishedSwVersion();
        const installedTag = userInitiated
            ? getInstalledTag()
            : await getInstalledTagWhenReady();
        if (
            published &&
            installedTag &&
            published.tag !== installedTag &&
            (userInitiated || installedTag.startsWith('v'))
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
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('Update check failed:', message);
        if (userInitiated && statusEl) {
            statusEl.textContent = 'Could not check for updates.';
        }
    } finally {
        checkInFlight = false;
        if (checkBtn) {
            checkBtn.disabled = false;
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

    window.addEventListener('focus', () => {
        runScheduledUpdateCheck(false);
    });

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

export function initPreferencesVersionUi(): void {
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
