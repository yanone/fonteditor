// Tab Lifecycle Management
// Prevents the browser from discarding the tab and protects font editor data

class TabLifecycleManager {
    lockHeld: boolean;
    persistentStorageGranted: boolean;
    keepAliveInterval: ReturnType<typeof setInterval> | null;
    wakeLock: WakeLockSentinel | null;

    constructor() {
        this.lockHeld = false;
        this.persistentStorageGranted = false;
        this.keepAliveInterval = null;
        this.wakeLock = null;
    }

    async initialize() {
        console.log('[Tab Lifecycle] Initializing tab protection...');

        // Request persistent storage
        await this.requestPersistentStorage();

        // Acquire Web Lock to prevent tab discard
        this.acquireWebLock();

        // Acquire Screen Wake Lock to prevent tab freeze
        await this.acquireWakeLock();

        // Set up visibility change handler
        this.setupVisibilityHandler();

        // Set up beforeunload warning
        this.setupBeforeUnloadWarning();

        console.log('[Tab Lifecycle] Tab protection initialized');
    }

    async requestPersistentStorage() {
        if (!navigator.storage || !navigator.storage.persist) {
            console.warn(
                '[Tab Lifecycle] Persistent Storage API not supported'
            );
            return false;
        }

        try {
            // Check if already persistent
            const isPersisted = await navigator.storage.persisted();

            if (isPersisted) {
                console.log('[Tab Lifecycle] ✅ Storage is already persistent');
                this.persistentStorageGranted = true;
                return true;
            }

            // Request persistence
            const granted = await navigator.storage.persist();

            if (granted) {
                console.log(
                    '[Tab Lifecycle] ✅ Persistent storage granted - data will not be cleared'
                );
                this.persistentStorageGranted = true;

                // Check quota
                if (navigator.storage.estimate) {
                    const estimate = await navigator.storage.estimate();
                    const usage = estimate.usage ?? 0;
                    const quota = estimate.quota ?? 1;
                    const percentUsed = ((usage / quota) * 100).toFixed(2);
                    console.log(
                        `[Tab Lifecycle] Storage: ${this.formatBytes(usage)} / ${this.formatBytes(quota)} (${percentUsed}%)`
                    );
                }

                return true;
            } else {
                console.warn(
                    '[Tab Lifecycle] ⚠️ Persistent storage denied - localStorage may be cleared during low disk space'
                );
                console.info(
                    '[Tab Lifecycle] ℹ️ Your tab is still protected by Web Lock - it will not be killed'
                );
                console.info(
                    '[Tab Lifecycle] ℹ️ In-memory font data remains safe. Save regularly to disk for backup.'
                );
                return false;
            }
        } catch (error) {
            console.error(
                '[Tab Lifecycle] Error requesting persistent storage:',
                error
            );
            return false;
        }
    }

    acquireWebLock() {
        if (!('locks' in navigator)) {
            console.warn('[Tab Lifecycle] Web Locks API not supported');
            return;
        }

        // Request a lock that will be held as long as the tab is active
        navigator.locks
            .request(
                'font_editor_active',
                { mode: 'exclusive' },
                async (lock) => {
                    console.log(
                        '[Tab Lifecycle] 🔒 Web Lock acquired - tab protected from discard'
                    );
                    this.lockHeld = true;

                    // This promise never resolves, keeping the lock active indefinitely
                    // The lock will be automatically released when:
                    // 1. The tab is closed
                    // 2. The page navigates away
                    // 3. The browser crashes
                    return new Promise(() => {
                        // Keep the lock active forever
                    });
                }
            )
            .catch((error) => {
                console.error(
                    '[Tab Lifecycle] Error acquiring Web Lock:',
                    error
                );
                this.lockHeld = false;
            });
    }

    async acquireWakeLock() {
        if (!('wakeLock' in navigator)) {
            console.warn('[Tab Lifecycle] Screen Wake Lock API not supported');
            return;
        }

        // Don't re-acquire if already held
        if (this.wakeLock) return;

        try {
            this.wakeLock = await navigator.wakeLock.request('screen');
            console.log(
                '[Tab Lifecycle] ⏰ Screen Wake Lock acquired - tab protected from freeze'
            );

            // The wake lock is auto-released when the tab becomes hidden.
            // Listen for release so we can re-acquire when visible again.
            this.wakeLock.addEventListener('release', () => {
                console.log(
                    '[Tab Lifecycle] Screen Wake Lock released (will re-acquire on next visibility)'
                );
                this.wakeLock = null;
            });
        } catch (error) {
            console.warn(
                '[Tab Lifecycle] Failed to acquire Screen Wake Lock:',
                error
            );
            this.wakeLock = null;
        }
    }

    releaseWakeLock() {
        if (this.wakeLock) {
            this.wakeLock.release();
            this.wakeLock = null;
        }
    }

    setupVisibilityHandler() {
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                console.log('[Tab Lifecycle] Tab hidden - starting keepalive');
                this.startKeepAlive();
                // Wake lock auto-released by browser when tab hides;
                // release our reference so we can re-acquire on return
                this.wakeLock = null;
            } else {
                console.log('[Tab Lifecycle] Tab visible - stopping keepalive');
                this.stopKeepAlive();
                // Re-acquire wake lock when user returns
                this.acquireWakeLock();
            }
        });

        // Also handle page freeze events (if supported)
        document.addEventListener(
            'freeze',
            (e) => {
                console.warn(
                    '[Tab Lifecycle] Page freeze detected - tab may be suspended'
                );
            },
            { capture: true }
        );

        document.addEventListener(
            'resume',
            (e) => {
                console.log('[Tab Lifecycle] Page resumed from freeze');
            },
            { capture: true }
        );
    }

    startKeepAlive() {
        // Clear any existing interval
        this.stopKeepAlive();

        // Create a minimal activity to prevent tab discard
        // This runs when the tab is hidden/backgrounded
        this.keepAliveInterval = setInterval(() => {
            // Minimal console log to show activity
            // Some browsers use this as a signal that the tab is "active"
            if (document.hidden) {
                console.log('[Tab Lifecycle] Keepalive ping');

                // Also touch localStorage to signal activity
                try {
                    localStorage.setItem(
                        'tab_keepalive_timestamp',
                        Date.now().toString()
                    );
                } catch (e) {
                    // Ignore storage errors
                }
            }
        }, 30000); // Every 30 seconds
    }

    stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
    }

    setupBeforeUnloadWarning() {
        // Skip beforeunload warning in development mode so tests can run uninterrupted
        if (window.isDevelopment?.()) {
            return;
        }

        // Track mailto: clicks to exclude from beforeunload warning
        let isMailtoNavigation = false;

        document.addEventListener(
            'click',
            (e: MouseEvent) => {
                const target = (e.target as Element | null)?.closest('a');
                if (
                    target &&
                    target.href &&
                    target.href.startsWith('mailto:')
                ) {
                    isMailtoNavigation = true;
                    setTimeout(() => {
                        isMailtoNavigation = false;
                    }, 100);
                }
            },
            true
        );

        window.addEventListener('beforeunload', (e) => {
            // Don't warn for mailto: links - they don't navigate away
            if (isMailtoNavigation) {
                return;
            }

            // Check if there are unsaved changes
            const hasUnsavedChanges = this.checkUnsavedChanges();

            if (hasUnsavedChanges) {
                // Modern browsers ignore custom messages, but we still need to set returnValue
                e.preventDefault();
                e.returnValue =
                    'You have unsaved changes in the font editor. Are you sure you want to leave?';
                return e.returnValue;
            }
        });
    }

    checkUnsavedChanges() {
        if (window.windowRole?.isLinkedWindow()) {
            return false;
        }

        // Check model state only to avoid stale UI indicator false positives.
        try {
            const fontManager = window.fontManager;
            if (!fontManager) {
                return false;
            }

            if (fontManager.shouldShowDirtyState(fontManager.currentFont)) {
                return true;
            }

            for (const openedFont of fontManager.openedFonts.values()) {
                if (fontManager.shouldShowDirtyState(openedFont)) {
                    return true;
                }
            }

            return false;
        } catch (error) {
            console.error(
                '[Tab Lifecycle] Error checking unsaved changes:',
                error
            );
            // Err on the side of caution
            return true;
        }
    }

    formatBytes(bytes: number) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return (
            Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i]
        );
    }

    getStatus() {
        return {
            lockHeld: this.lockHeld,
            persistentStorageGranted: this.persistentStorageGranted,
            tabHidden: document.hidden,
            keepAliveActive: this.keepAliveInterval !== null,
            wakeLockHeld: this.wakeLock !== null
        };
    }
}

// Create global instance
window.tabLifecycleManager = new TabLifecycleManager();

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.tabLifecycleManager.initialize();
    });
} else {
    // DOM already loaded
    window.tabLifecycleManager.initialize();
}
