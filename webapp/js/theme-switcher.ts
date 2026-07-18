/**
 * Theme Switcher
 * Handles light/dark/auto theme switching with OS preference detection
 */

import { changeDiskRootFolder } from './file-browser';
import { DiskPlugin, pluginRegistry } from './filesystem-plugins';

(function () {
    'use strict';

    // Theme management
    const THEME_KEY = 'preferred-theme';
    const THEMES = {
        LIGHT: 'light',
        DARK: 'dark',
        AUTO: 'auto'
    };

    class ThemeSwitcher {
        settingsBtn: HTMLElement | null;
        settingsPanel: HTMLElement | null;
        settingsCloseBtn: HTMLElement | null;
        diskRootName: HTMLElement | null;
        diskRootChangeButton: HTMLButtonElement | null;
        themeOptions: NodeListOf<HTMLElement>;
        mediaQuery: MediaQueryList;

        constructor() {
            this.settingsBtn = document.getElementById('settings-btn');
            this.settingsPanel = document.getElementById('settings-panel');
            this.settingsCloseBtn =
                document.getElementById('settings-close-btn');
            this.diskRootName = document.getElementById(
                'settings-disk-root-name'
            );
            this.diskRootChangeButton = document.getElementById(
                'settings-disk-root-change-btn'
            ) as HTMLButtonElement | null;
            this.themeOptions = document.querySelectorAll('.theme-option');
            this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

            this.init();
        }

        init() {
            const urlTheme = this.getThemeFromUrl();
            if (urlTheme) {
                this.removeThemeParamFromUrl();
            }

            // Load saved theme preference
            const savedTheme =
                urlTheme || localStorage.getItem(THEME_KEY) || THEMES.AUTO;
            if (urlTheme) {
                localStorage.setItem(THEME_KEY, urlTheme);
            }
            this.applyThemePreference(savedTheme);
            this.updateActiveButton(savedTheme);

            // Settings panel toggle
            this.settingsBtn?.addEventListener('click', (e: MouseEvent) => {
                e.stopPropagation();
                this.toggleSettings();
            });
            this.settingsCloseBtn?.addEventListener('click', () =>
                this.closeSettings()
            );
            this.diskRootChangeButton?.addEventListener('click', async () => {
                this.diskRootChangeButton!.disabled = true;
                try {
                    await changeDiskRootFolder({ source: 'settings' });
                    await this.updateDiskRootSetting();
                } finally {
                    this.diskRootChangeButton!.disabled = false;
                }
            });
            window.addEventListener('diskFolderAccessChanged', () => {
                void this.updateDiskRootSetting();
            });
            void this.updateDiskRootSetting();

            // Click anywhere outside to close
            document.addEventListener('click', (e: MouseEvent) => {
                if (
                    this.settingsPanel?.classList.contains('open') &&
                    !this.settingsPanel.contains(e.target as Node | null) &&
                    e.target !== this.settingsBtn
                ) {
                    this.closeSettings();
                }
            });

            // Theme option clicks
            this.themeOptions.forEach((option) => {
                option.addEventListener('click', () => {
                    const theme = option.dataset.theme;
                    if (theme) {
                        this.setTheme(theme);
                    }
                });
            });

            // Listen for OS theme changes (only when in auto mode)
            this.mediaQuery.addEventListener(
                'change',
                (e: MediaQueryListEvent) => {
                    const currentPreference =
                        localStorage.getItem(THEME_KEY) || THEMES.AUTO;
                    if (currentPreference === THEMES.AUTO) {
                        this.applyTheme(e.matches ? THEMES.DARK : THEMES.LIGHT);
                    }
                }
            );

            // React to theme preference changes made in other windows.
            window.addEventListener('storage', (e: StorageEvent) => {
                if (e.key !== THEME_KEY || !e.newValue) {
                    return;
                }
                if (
                    e.newValue !== THEMES.LIGHT &&
                    e.newValue !== THEMES.DARK &&
                    e.newValue !== THEMES.AUTO
                ) {
                    return;
                }

                this.applyThemePreference(e.newValue);
                this.updateActiveButton(e.newValue);
            });

            // Keyboard shortcut: Cmd/Ctrl + ,
            document.addEventListener('keydown', (e: KeyboardEvent) => {
                if ((e.metaKey || e.ctrlKey) && e.key === ',') {
                    e.preventDefault();
                    this.toggleSettings();
                }
            });

            // ESC to close settings (only if no popups are open and event not already handled)
            // Use capture phase to ensure this runs before other escape handlers
            document.addEventListener(
                'keydown',
                (e: KeyboardEvent) => {
                    if (
                        e.key === 'Escape' &&
                        this.settingsPanel?.classList.contains('open')
                    ) {
                        // Don't close if event was already handled by a popup
                        if (e.defaultPrevented) {
                            return;
                        }
                        // Check if any popup is currently open
                        const openPopups = document.querySelectorAll(
                            '.info-popup-overlay[style*="display: flex"], .modal.active, .matplotlib-modal.active'
                        );
                        if (openPopups.length === 0) {
                            e.preventDefault();
                            e.stopImmediatePropagation(); // Prevent other escape handlers from firing
                            this.closeSettings();
                        }
                    }
                },
                true
            ); // Use capture phase to run before other handlers
        }

        toggleSettings() {
            const isOpen = this.settingsPanel?.classList.toggle('open');
            if (isOpen) {
                void this.updateDiskRootSetting();
            }
        }

        /** Render the currently selected user-controlled Disk root. */
        async updateDiskRootSetting(): Promise<void> {
            const diskPlugin = pluginRegistry.get('disk');
            const directoryName =
                diskPlugin instanceof DiskPlugin && (await diskPlugin.isReady())
                    ? diskPlugin.getDirectoryName()
                    : null;
            if (this.diskRootName) {
                this.diskRootName.textContent = directoryName || 'Not selected';
                this.diskRootName.title =
                    directoryName || 'No Disk root selected';
            }
            if (this.diskRootChangeButton) {
                this.diskRootChangeButton.textContent = directoryName
                    ? 'Change Folder'
                    : 'Choose Folder';
            }
        }

        closeSettings() {
            this.settingsPanel?.classList.remove('open');
            // Restore focus to canvas if editor view was active
            const editorView = document.getElementById('view-editor');
            if (
                editorView &&
                editorView.classList.contains('focused') &&
                window.glyphCanvas &&
                window.glyphCanvas.canvas
            ) {
                const canvas = window.glyphCanvas.canvas;
                if (canvas) {
                    setTimeout(() => canvas.focus(), 0);
                }
            }
        }

        setTheme(preference: string) {
            localStorage.setItem(THEME_KEY, preference);
            this.applyThemePreference(preference);
            this.updateActiveButton(preference);
        }

        getThemeFromUrl(): string | null {
            const params = new URLSearchParams(window.location.search);
            const value = params.get('theme');
            if (
                value === THEMES.LIGHT ||
                value === THEMES.DARK ||
                value === THEMES.AUTO
            ) {
                return value;
            }
            return null;
        }

        removeThemeParamFromUrl() {
            const url = new URL(window.location.href);
            if (!url.searchParams.has('theme')) {
                return;
            }
            url.searchParams.delete('theme');
            window.history.replaceState({}, '', url.toString());
        }

        applyThemePreference(preference: string) {
            let actualTheme;

            if (preference === THEMES.AUTO) {
                // Use OS preference
                actualTheme = this.mediaQuery.matches
                    ? THEMES.DARK
                    : THEMES.LIGHT;
            } else {
                actualTheme = preference;
            }

            this.applyTheme(actualTheme);
        }

        applyTheme(theme: string) {
            const root = document.documentElement;

            if (theme === THEMES.LIGHT) {
                root.setAttribute('data-theme', 'light');
            } else {
                root.removeAttribute('data-theme');
            }

            this.updateThemeColorMeta(theme);

            // Update Ace editor theme if it exists
            this.updateAceTheme(theme);

            // Update glyph canvas if it exists
            if (window.glyphCanvas) {
                window.glyphCanvas.render();
            }
        }

        updateThemeColorMeta(theme: string) {
            const themeColorMeta = document.querySelector(
                'meta[name="theme-color"]'
            );
            if (!themeColorMeta) {
                return;
            }

            const fallbackColor =
                theme === THEMES.LIGHT ? '#ffffff' : '#181818';
            const computedColor = getComputedStyle(document.documentElement)
                .getPropertyValue('--background-primary')
                .trim();

            themeColorMeta.setAttribute(
                'content',
                computedColor || fallbackColor
            );
        }

        updateAceTheme(theme: string) {
            // Wait for Ace editor to be initialized
            setTimeout(() => {
                const scriptEditor = window.scriptEditor;
                if (scriptEditor && scriptEditor.editor) {
                    if (theme === THEMES.LIGHT) {
                        scriptEditor.editor.setTheme('ace/theme/tomorrow');
                    } else {
                        scriptEditor.editor.setTheme(
                            'ace/theme/tomorrow_night'
                        );
                    }
                }

                // Update font info features editor theme
                const fontInfoManager = window.fontInfoManager;
                if (fontInfoManager && fontInfoManager.updateEditorTheme) {
                    fontInfoManager.updateEditorTheme(
                        theme === THEMES.LIGHT ? 'light' : 'dark'
                    );
                }
            }, 100);
        }

        updateActiveButton(preference: string) {
            this.themeOptions.forEach((option) => {
                if (option.dataset.theme === preference) {
                    option.classList.add('active');
                } else {
                    option.classList.remove('active');
                }
            });
        }

        getCurrentTheme() {
            return localStorage.getItem(THEME_KEY) || THEMES.AUTO;
        }

        getActualTheme() {
            const preference = this.getCurrentTheme();
            if (preference === THEMES.AUTO) {
                return this.mediaQuery.matches ? THEMES.DARK : THEMES.LIGHT;
            }
            return preference;
        }
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            window.themeSwitcher = new ThemeSwitcher();
            initFullscreenToggle();
        });
    } else {
        window.themeSwitcher = new ThemeSwitcher();
        initFullscreenToggle();
    }

    // Fullscreen toggle functionality
    function initFullscreenToggle() {
        const fullscreenBtn = document.getElementById('fullscreen-btn');
        const fullscreenIcon = fullscreenBtn?.querySelector(
            '.material-symbols-outlined'
        ) as HTMLElement | null;

        if (!fullscreenBtn || !fullscreenIcon) return;

        // Update icon based on fullscreen state
        function updateIcon() {
            const icon = fullscreenIcon;
            const btn = fullscreenBtn;
            if (!icon || !btn) {
                return;
            }
            if (document.fullscreenElement) {
                icon.textContent = 'fullscreen_exit';
                btn.title = 'Exit fullscreen';
            } else {
                icon.textContent = 'fullscreen';
                btn.title = 'Toggle fullscreen';
            }
        }

        // Toggle fullscreen
        fullscreenBtn.addEventListener('click', async () => {
            try {
                if (!document.fullscreenElement) {
                    await document.documentElement.requestFullscreen();
                } else {
                    await document.exitFullscreen();
                }
            } catch (err) {
                console.error('[Theme]', 'Error toggling fullscreen:', err);
            }
        });

        // Listen for fullscreen changes (also triggered by F11, Esc, etc.)
        document.addEventListener('fullscreenchange', updateIcon);

        // Initial icon update
        updateIcon();
    }
})();
