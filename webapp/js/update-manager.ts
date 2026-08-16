/**
 * PWA update state and Preferences version UI.
 *
 * The inline script in index.html sets window.__pendingUpdate and dispatches
 * 'counterpunch:update-available' when a new service worker activates.
 */

import { Logger } from './logger';

const console = new Logger('UpdateManager');

const CHANGELOG_RELEASES_URL =
    'https://github.com/counterpunchspace/editor/releases/tag';

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
        isPreview: tag.includes('preview') || displayVersion.includes('preview')
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

async function checkForUpdates(): Promise<void> {
    const statusEl = document.getElementById('settings-update-status');
    const checkBtn = document.getElementById(
        'settings-check-updates-btn'
    ) as HTMLButtonElement | null;
    if (statusEl) {
        statusEl.textContent = 'Checking for updates…';
    }
    if (checkBtn) {
        checkBtn.disabled = true;
    }

    try {
        if (navigator.serviceWorker) {
            const registration =
                await navigator.serviceWorker.getRegistration();
            await registration?.update();
        }

        const published = await fetchPublishedSwVersion();
        const installedTag = getInstalledTag();
        if (published && installedTag && published.tag !== installedTag) {
            setPendingUpdate(pendingUpdateFromSw(published));
            if (statusEl) {
                statusEl.textContent = '';
            }
            return;
        }

        if (statusEl) {
            statusEl.textContent = getPendingUpdate()
                ? ''
                : 'You’re up to date.';
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('Update check failed:', message);
        if (statusEl) {
            statusEl.textContent = 'Could not check for updates.';
        }
    } finally {
        if (checkBtn) {
            checkBtn.disabled = false;
        }
        refreshPreferencesVersionUi();
    }
}

function applyPendingUpdate(): void {
    window.location.reload();
}

export function initPreferencesVersionUi(): void {
    refreshPreferencesVersionUi();

    document
        .getElementById('settings-check-updates-btn')
        ?.addEventListener('click', () => {
            void checkForUpdates();
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
