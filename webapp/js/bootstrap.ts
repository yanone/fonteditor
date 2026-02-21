import './wasm-init'; // Initialize WASM module
import './tab-lifecycle.js';
import './mcp-transport';
import './critical-error-handler';
import './state-manager'; // Initialize state manager early
import { Logger } from './logger';
import {
    timelineMark,
    timelineSpanEnd,
    timelineSpanStart
} from './perf-timeline';

const console = new Logger('Bootstrap');

timelineMark('app.bootstrap.moduleLoaded');

window.EDITOR_VERSION = process.env.EDITOR_VERSION || null;
window.BUILD_HASH_FULL = process.env.BUILD_HASH_FULL || null;
window.BUILD_HASH_SHORT = process.env.BUILD_HASH_SHORT || null;

function registerPwaLaunchFileConsumer() {
    const launchQueue = (window as any).launchQueue;
    if (!launchQueue || typeof launchQueue.setConsumer !== 'function') {
        return;
    }

    launchQueue.setConsumer((launchParams: any) => {
        const launchedHandles = Array.isArray(launchParams?.files)
            ? launchParams.files.filter(
                  (handle: any) => handle?.kind === 'file'
              )
            : [];

        if (!launchedHandles.length) {
            return;
        }

        const pendingHandles = Array.isArray(
            (window as any).__pendingLaunchFileHandles
        )
            ? (window as any).__pendingLaunchFileHandles
            : [];

        (window as any).__pendingLaunchFileHandles = [
            ...pendingHandles,
            ...launchedHandles
        ];

        window.dispatchEvent(new CustomEvent('pwaLaunchFilesPending'));
    });
}

registerPwaLaunchFileConsumer();

function isSupportedBrowser(): boolean {
    const ua = navigator.userAgent;
    const navWithUAData = navigator as Navigator & {
        userAgentData?: {
            brands?: { brand: string; version: string }[];
        };
    };
    const brands = navWithUAData.userAgentData?.brands || [];

    const hasEdgeBrand = brands.some((entry) =>
        entry.brand.toLowerCase().includes('edge')
    );
    const hasChromiumBrand = brands.some((entry) => {
        const brand = entry.brand.toLowerCase();
        return brand.includes('chromium') || brand.includes('chrome');
    });

    const isEdgeUA = /Edg\//.test(ua);
    const isChromiumUA = /Chrome\//.test(ua) || /Chromium\//.test(ua);
    const isSafariUA =
        /Safari\//.test(ua) &&
        !/Chrome\//.test(ua) &&
        !/Chromium\//.test(ua) &&
        !/CriOS\//.test(ua) &&
        !/Edg\//.test(ua) &&
        !/OPR\//.test(ua) &&
        !/FxiOS\//.test(ua) &&
        !/Firefox\//.test(ua) &&
        !/Android/.test(ua);

    return (
        hasEdgeBrand ||
        hasChromiumBrand ||
        isEdgeUA ||
        isChromiumUA ||
        isSafariUA
    );
}

function getBrowserMatrixKey():
    | 'chrome'
    | 'edge'
    | 'safari'
    | 'firefox'
    | 'brave'
    | null {
    const ua = navigator.userAgent;
    const navWithUAData = navigator as Navigator & {
        userAgentData?: {
            brands?: { brand: string; version: string }[];
        };
        brave?: unknown;
    };
    const brands = navWithUAData.userAgentData?.brands || [];

    const hasBrand = (needle: string) =>
        brands.some((entry) => entry.brand.toLowerCase().includes(needle));

    const isBrave =
        hasBrand('brave') ||
        /Brave\//.test(ua) ||
        typeof navWithUAData.brave !== 'undefined';
    if (isBrave) {
        return 'brave';
    }

    if (hasBrand('edge') || /Edg\//.test(ua)) {
        return 'edge';
    }

    const isSafari =
        /Safari\//.test(ua) &&
        !/Chrome\//.test(ua) &&
        !/Chromium\//.test(ua) &&
        !/CriOS\//.test(ua) &&
        !/Edg\//.test(ua) &&
        !/OPR\//.test(ua) &&
        !/FxiOS\//.test(ua) &&
        !/Firefox\//.test(ua) &&
        !/Android/.test(ua);
    if (isSafari) {
        return 'safari';
    }

    if (hasBrand('firefox') || /Firefox\//.test(ua) || /FxiOS\//.test(ua)) {
        return 'firefox';
    }

    if (
        hasBrand('chromium') ||
        hasBrand('chrome') ||
        /Chrome\//.test(ua) ||
        /Chromium\//.test(ua) ||
        /CriOS\//.test(ua)
    ) {
        return 'chrome';
    }

    return null;
}

function showUnsupportedBrowserOverlay() {
    if (isSupportedBrowser()) {
        (window as any).__unsupportedBrowserWarningRequired = false;
        (window as any).__unsupportedBrowserWarningAcknowledged = true;
        return;
    }

    (window as any).__unsupportedBrowserWarningRequired = true;
    (window as any).__unsupportedBrowserWarningAcknowledged = false;

    const loadingOverlay = document.getElementById('loading-overlay');
    if (!loadingOverlay) {
        return;
    }

    if (document.getElementById('unsupported-browser-overlay')) {
        return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'unsupported-browser-overlay';
    overlay.className = 'unsupported-browser-overlay';
    const currentBrowser = getBrowserMatrixKey();
    const highlightClass = (key: string) =>
        currentBrowser === key ? ' current-browser' : '';
    const supportIcon = (supported: boolean) =>
        `<span class="material-symbols-outlined matrix-support-icon ${
            supported ? 'matrix-support-icon-yes' : 'matrix-support-icon-no'
        }" aria-label="${supported ? 'Supported' : 'Not supported'}">${supported ? 'check' : 'close'}</span>`;
    const noteForBrowser = (key: string) => {
        const notes: string[] = [];
        if (key === 'chrome') {
            notes.push(
                '<span class="browser-note-recommended">Recommended</span>'
            );
        }
        if (currentBrowser === key) {
            notes.push(
                '<span class="browser-note-current">← Your browser</span>'
            );
        }
        return notes.join(' ');
    };
    overlay.innerHTML = `
        <div class="unsupported-browser-panel" role="alert" aria-live="polite">
            <h2 class="unsupported-browser-title">Browser Compatibility Warning</h2>
            <p class="unsupported-browser-text">Counterpunch officially supports <strong>Chrome/Chromium</strong>, <strong>Edge</strong>, and <strong>Safari</strong>.</p>
            <p class="unsupported-browser-text"><strong>Chrome/Chromium</strong> is recommended because it is currently the only browser that supports hot-reloading of external files.</p>
            <div class="browser-feature-matrix-wrapper">
                <table class="browser-feature-matrix" aria-label="Browser feature support matrix">
                    <thead>
                        <tr>
                            <th>Browser</th>
                            <th>Native disk access</th>
                            <th>Hot reloading</th>
                            <th>Notes</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr class="${highlightClass('chrome')}">
                            <td>Chrome/Chromium</td>
                            <td class="matrix-support-cell">${supportIcon(true)}</td>
                            <td class="matrix-support-cell">${supportIcon(true)}</td>
                            <td class="matrix-note-cell">${noteForBrowser('chrome')}</td>
                        </tr>
                        <tr class="${highlightClass('edge')}">
                            <td>Edge</td>
                            <td class="matrix-support-cell">${supportIcon(true)}</td>
                            <td class="matrix-support-cell">${supportIcon(false)}</td>
                            <td class="matrix-note-cell">${noteForBrowser('edge')}</td>
                        </tr>
                        <tr class="${highlightClass('safari')}">
                            <td>Safari</td>
                            <td class="matrix-support-cell">${supportIcon(true)}</td>
                            <td class="matrix-support-cell">${supportIcon(false)}</td>
                            <td class="matrix-note-cell">${noteForBrowser('safari')}</td>
                        </tr>
                        <tr class="${highlightClass('firefox')}">
                            <td>Firefox</td>
                            <td class="matrix-support-cell">${supportIcon(false)}</td>
                            <td class="matrix-support-cell">${supportIcon(false)}</td>
                            <td class="matrix-note-cell">${noteForBrowser('firefox')}</td>
                        </tr>
                        <tr class="${highlightClass('brave')}">
                            <td>Brave</td>
                            <td class="matrix-support-cell">${supportIcon(false)}</td>
                            <td class="matrix-support-cell">${supportIcon(false)}</td>
                            <td class="matrix-note-cell">${noteForBrowser('brave')}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <p class="unsupported-browser-text"><strong>Firefox</strong> and <strong>Brave</strong> generally run, but they do not support native disk access and are not recommended. In these browsers, only Memory file access is available.</p>
            <button type="button" class="unsupported-browser-continue">Continue</button>
        </div>
    `;

    const continueButton = overlay.querySelector(
        '.unsupported-browser-continue'
    ) as HTMLButtonElement | null;
    continueButton?.addEventListener('click', () => {
        (window as any).__unsupportedBrowserWarningAcknowledged = true;
        overlay.remove();
        window.dispatchEvent(new CustomEvent('unsupportedBrowserContinue'));
    });

    loadingOverlay.appendChild(overlay);
    console.warn('Unsupported browser detected; warning overlay shown.');
}

// Utility function to update loading status (extracted from loading-animation.js)
window.updateLoadingStatus = function (
    message: string,
    isReady: boolean = false
) {
    const statusElement = document.getElementById('loading-status');
    if (statusElement) {
        statusElement.textContent = message;
        if (isReady) {
            statusElement.classList.add('ready');
        } else {
            statusElement.classList.remove('ready');
        }
    }
};

// Handle URL-based font opening special case
const handleURLFontOpen = () => {
    const urlOpenSpan = timelineSpanStart('app.urlFontOpen');
    const urlParams = new URLSearchParams(window.location.search);
    const fileParam = urlParams.get('file');
    const legacyPath = urlParams.get('path');

    let fontPath: string | null = null;

    // Try new file URI format first
    if (fileParam) {
        // parseFileUri will be available after file-browser.ts loads
        // For bootstrap, parse inline to avoid dependency
        const match = fileParam.match(/^([^:]+):\/\/\/(.*)$/);
        if (match) {
            fontPath = '/' + match[2];
        }
    } else if (legacyPath) {
        // Fall back to legacy format
        fontPath = legacyPath;
    }

    if (fontPath) {
        timelineMark('app.urlFontOpen.fontPathDetected');
        const loadingContent = document.querySelector(
            '.loading-content'
        ) as HTMLElement;
        const statusElement = document.getElementById('loading-status');
        const loadingOverlay = document.getElementById('loading-overlay');

        // Hide logo, icon, and status label
        if (loadingContent) {
            loadingContent.style.display = 'none';
        }
        if (statusElement) {
            statusElement.style.display = 'none';
        }

        // Create and show simple loading message
        const filename = fontPath.split('/').pop() || fontPath;
        const fontLoadingLabel = document.createElement('div');
        fontLoadingLabel.textContent = `Opening ${filename}`;
        fontLoadingLabel.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            font-family: 'Inter', sans-serif;
            font-size: 24px;
            color: var(--text-primary);
            text-align: center;
            z-index: 999999;
        `;
        if (loadingOverlay) {
            loadingOverlay.appendChild(fontLoadingLabel);
        }
    }

    timelineSpanEnd(urlOpenSpan);
};

// Initialize on DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', handleURLFontOpen);
} else {
    handleURLFontOpen();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        timelineMark('app.domContentLoaded');
    });
} else {
    timelineMark('app.domContentLoaded.alreadyReady');
}

if (document.readyState === 'loading') {
    document.addEventListener(
        'DOMContentLoaded',
        showUnsupportedBrowserOverlay
    );
} else {
    showUnsupportedBrowserOverlay();
}

// Disable default browser context menu in production
// Allow only on elements with custom tippy menus (marked with data-has-context-menu)
// or text input elements where selection context menu is useful
const disableDefaultContextMenu = () => {
    if (window.isProduction && window.isProduction()) {
        document.addEventListener(
            'contextmenu',
            (e) => {
                const target = e.target as HTMLElement;

                // Allow on text input/textarea for copy/paste
                if (
                    target.tagName === 'INPUT' ||
                    target.tagName === 'TEXTAREA'
                ) {
                    return;
                }

                // Allow on contenteditable elements
                if (target.isContentEditable) {
                    return;
                }

                // Allow on Ace editor (has its own context menu)
                if (target.closest('.ace_editor')) {
                    return;
                }

                // Block default context menu everywhere else
                e.preventDefault();
            },
            true
        );
        console.log(
            '[Bootstrap]',
            'Default context menu disabled in production'
        );
    }
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', disableDefaultContextMenu);
} else {
    disableDefaultContextMenu();
}

import './auth-manager.js'; // Authentication with fonteditorwebsite
import './ai-assistant.js';
import './auto-compile-manager';
import './cache-manager.js';
import './canvas-plugin-manager';
import './editor-plugins-ui.js';
import './example-loader.js';
import './file-browser';
import './full-font-compile-manager';
import './font-info'; // Font info view manager (Names/Features tabs)
import './font-interpolation';
import './font-manager';
import './fonteditor.js';
import './state-sync'; // URL state synchronization
import './state-restore'; // URL state restoration
import './glyph-canvas';
import './keyboard-navigation.js';
import './matplotlib-handler.js';
import './memory-monitor.js';
import './python-utils.js';
import './pyodide-official-console.js';
import './python-execution-wrapper.js';
import './python-package-lazy-loader.js';
import './python-ui-sync.js';
import './python-post-execution';
import './resizer.js';
import './save-button.js';
import './script-editor';
import './share-button';
import './theme-switcher.js';
import './view-settings.js';
import { initViewTitleButtons } from './view-title-buttons';

// Initialize view title buttons after DOM is ready and keyboard navigation is initialized
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        // Delay slightly to ensure keyboard-navigation.js has initialized
        setTimeout(() => {
            initViewTitleButtons();
        }, 100);
    });
} else {
    setTimeout(() => {
        initViewTitleButtons();
    }, 100);
}
