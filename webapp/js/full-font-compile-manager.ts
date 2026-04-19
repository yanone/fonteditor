import APP_SETTINGS from './settings';
import { fullFontCompilation } from './font-compilation';
import fontManager from './font-manager';
import { Logger } from './logger';
import { timelineSpanEnd, timelineSpanStart } from './perf-timeline';
import { sidebarErrorDisplay } from './sidebar-error-display';
import { extractFeatureIssuesFromCompilationError } from './feature-error-parser';

const console = new Logger('FullFontCompileManager');

type QCSummary = {
    fails: number;
    warns: number;
    infos: number;
};

type QCCheck = {
    level: 'fail' | 'warn' | 'info';
    code: string;
    codes?: string[];
    message: string;
    severity?: string;
    checkId?: string;
    metadata?: unknown[];
};

const FONT_QC_PROFILE_STORAGE_KEY = 'fontQcProfile';
const DEFAULT_QC_PROFILE = 'universal';
const AVAILABLE_QC_PROFILES = [
    'opentype',
    'universal',
    'googlefonts',
    'iso15008',
    'fontwerk'
] as const;

// Temporary global kill-switch for startup/performance debugging.
// Keep code paths intact, but prevent any full compile / Fontspector work.
const TEMP_DISABLE_FULL_COMPILE = false;

type QcProfile = (typeof AVAILABLE_QC_PROFILES)[number];

(function () {
    'use strict';

    let isEnabled = !TEMP_DISABLE_FULL_COMPILE;
    let isCompiling = false;
    let debounceTimer: number | null = null;
    let monitorTimer: number | null = null;
    let lastObservedVersion = -1;
    let lastObservedPath: string | null = null;
    let lastCompiledVersion = -1;
    let lastCompiledPath: string | null = null;
    let lastCompiledProfile: QcProfile | null = null;
    let lastChecks: QCCheck[] = [];
    let selectedProfile: QcProfile = DEFAULT_QC_PROFILE;

    const DEBOUNCE_MS = 350;
    const MONITOR_MS = 200;

    function isCompilationBlockedByEditingSession(): boolean {
        return !!window.glyphCanvas?.outlineEditor?.draggingSomething;
    }

    function isValidProfile(profile: string): profile is QcProfile {
        return AVAILABLE_QC_PROFILES.includes(profile as QcProfile);
    }

    function loadProfileFromStorage(): QcProfile {
        try {
            const stored = localStorage.getItem(FONT_QC_PROFILE_STORAGE_KEY);
            if (stored && isValidProfile(stored)) {
                return stored;
            }
        } catch (error) {
            console.warn(
                'Unable to load Font QC profile from localStorage',
                error
            );
        }
        return DEFAULT_QC_PROFILE;
    }

    function persistProfile(profile: QcProfile): void {
        try {
            localStorage.setItem(FONT_QC_PROFILE_STORAGE_KEY, profile);
        } catch (error) {
            console.warn(
                'Unable to persist Font QC profile to localStorage',
                error
            );
        }
    }

    function dispatchQcUpdate(
        summary: QCSummary | null,
        status: 'ready' | 'compiling' | 'idle' | 'error',
        changeVersion: number,
        error?: string,
        checks?: QCCheck[]
    ): void {
        window.dispatchEvent(
            new CustomEvent('fontspectorUpdated', {
                detail: {
                    summary,
                    status,
                    changeVersion,
                    error: error || null,
                    checks: checks || [],
                    profile: selectedProfile,
                    availableProfiles: [...AVAILABLE_QC_PROFILES]
                }
            })
        );
    }

    function saveDebugFullFont(fontBytes: Uint8Array): void {
        if (!APP_SETTINGS.FONT_MANAGER?.SAVE_DEBUG_FONTS) {
            return;
        }

        window.uploadFiles(
            [
                new File(
                    [fontBytes as Uint8Array<ArrayBuffer>],
                    '_debug_full_font.ttf',
                    { type: 'font/ttf' }
                )
            ],
            {
                directory: '/user',
                pluginId: 'memory'
            }
        );
    }

    function scheduleCompilation(delayMs: number = DEBOUNCE_MS): void {
        if (!isEnabled || TEMP_DISABLE_FULL_COMPILE) {
            return;
        }

        if (isCompilationBlockedByEditingSession()) {
            return;
        }

        if (debounceTimer !== null) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }

        debounceTimer = window.setTimeout(() => {
            debounceTimer = null;
            void runCompilationLoop();
        }, delayMs);
    }

    function checkAndSchedule(): void {
        if (!isEnabled || TEMP_DISABLE_FULL_COMPILE) {
            return;
        }

        if (isCompilationBlockedByEditingSession()) {
            return;
        }

        const currentFont = fontManager.currentFont;
        if (!currentFont) {
            return;
        }

        const currentPath = currentFont.path || null;
        const currentVersion = currentFont.changeVersion;
        const pathChanged = currentPath !== lastObservedPath;
        const versionChanged = currentVersion !== lastObservedVersion;

        if (pathChanged || versionChanged) {
            lastObservedPath = currentPath;
            lastObservedVersion = currentVersion;
            scheduleCompilation();
        }
    }

    async function runCompilationLoop(): Promise<void> {
        if (!isEnabled || isCompiling || TEMP_DISABLE_FULL_COMPILE) {
            return;
        }

        isCompiling = true;

        try {
            while (isEnabled) {
                const currentFont = fontManager.currentFont;
                if (!currentFont) {
                    dispatchQcUpdate(null, 'idle', -1);
                    break;
                }

                if (isCompilationBlockedByEditingSession()) {
                    scheduleCompilation(MONITOR_MS);
                    break;
                }

                if (window.autoCompileManager?.getStatus?.().isCompiling) {
                    scheduleCompilation(200);
                    break;
                }

                const targetPath = currentFont.path || null;
                const targetVersion = currentFont.changeVersion;
                const shouldCompile =
                    targetPath !== lastCompiledPath ||
                    targetVersion > lastCompiledVersion ||
                    selectedProfile !== lastCompiledProfile;

                if (!shouldCompile) {
                    dispatchQcUpdate(
                        fontManager.fullFontQcSummary,
                        'ready',
                        targetVersion,
                        undefined,
                        lastChecks
                    );
                    break;
                }

                dispatchQcUpdate(
                    fontManager.fullFontQcSummary,
                    'compiling',
                    targetVersion,
                    undefined,
                    lastChecks
                );

                const startedAt = performance.now();
                const fullCompileSpanId = timelineSpanStart('font.compileFull');
                try {
                    // Always sync babelfontJson from the current model before full compile.
                    // This converts any array-format nodes back to Rust's compact string
                    // format and regenerates the JSON string from the latest model state.
                    currentFont.syncJsonFromModel();
                    const compileResult =
                        await fullFontCompilation.compileFromJson(
                            currentFont.babelfontJson,
                            'full-font.ttf',
                            'full'
                        );

                    const fullFontBytes = new Uint8Array(compileResult.result);
                    const duration = (performance.now() - startedAt).toFixed(2);

                    let summary: QCSummary | null = null;
                    let checks: QCCheck[] = [];
                    try {
                        const fontspectorSpanId = timelineSpanStart(
                            'font.fontspectorInference'
                        );
                        let qaResult;
                        try {
                            qaResult = await fullFontCompilation.sendMessage({
                                type: 'runFontspector',
                                fontBytes: fullFontBytes,
                                profile: selectedProfile
                            });
                        } finally {
                            timelineSpanEnd(fontspectorSpanId);
                        }
                        if (qaResult?.summary) {
                            summary = qaResult.summary as QCSummary;
                        }
                        if (Array.isArray(qaResult?.checks)) {
                            checks = qaResult.checks as QCCheck[];
                        }
                    } catch (qaError) {
                        console.warn(
                            'Fontspector failed after full compile:',
                            qaError
                        );
                    }

                    fontManager.fullFont = fullFontBytes;
                    fontManager.fullFontQcSummary = summary;

                    saveDebugFullFont(fullFontBytes);

                    window.dispatchEvent(
                        new CustomEvent('fullFontCompiled', {
                            detail: {
                                fontBytes: fullFontBytes,
                                duration,
                                changeVersion: targetVersion,
                                qcSummary: summary,
                                qcChecks: checks
                            }
                        })
                    );

                    lastChecks = checks;
                    dispatchQcUpdate(
                        summary,
                        'ready',
                        targetVersion,
                        undefined,
                        checks
                    );

                    lastCompiledPath = targetPath;
                    lastCompiledVersion = targetVersion;
                    lastCompiledProfile = selectedProfile;

                    const latestPath = fontManager.currentFont?.path || null;
                    const latestVersion =
                        fontManager.currentFont?.changeVersion ?? -1;
                    const stillBehind =
                        latestPath !== lastCompiledPath ||
                        latestVersion > lastCompiledVersion;

                    if (!stillBehind) {
                        break;
                    }
                } catch (error) {
                    const message =
                        error instanceof Error ? error.message : String(error);
                    const featureIssues =
                        extractFeatureIssuesFromCompilationError(error);
                    const humanReadableMessage =
                        featureIssues.length > 0
                            ? `${featureIssues[0].category}: ${featureIssues[0].message}`
                            : message;
                    console.error('Full background compilation failed:', error);
                    sidebarErrorDisplay.showError(error);
                    dispatchQcUpdate(
                        fontManager.fullFontQcSummary,
                        'error',
                        targetVersion,
                        humanReadableMessage,
                        lastChecks
                    );
                    break;
                } finally {
                    timelineSpanEnd(fullCompileSpanId);
                }
            }
        } finally {
            isCompiling = false;
        }
    }

    function setEnabled(enabled: boolean): void {
        if (TEMP_DISABLE_FULL_COMPILE) {
            isEnabled = false;
            dispatchQcUpdate(
                fontManager.fullFontQcSummary,
                'idle',
                -1,
                undefined,
                lastChecks
            );
            return;
        }

        isEnabled = enabled;

        if (!isEnabled && debounceTimer !== null) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }

        if (isEnabled) {
            checkAndSchedule();
        }
    }

    function getProfile(): QcProfile {
        return selectedProfile;
    }

    function getAvailableProfiles(): QcProfile[] {
        return [...AVAILABLE_QC_PROFILES];
    }

    function setProfile(profile: string): boolean {
        if (!isValidProfile(profile)) {
            console.warn('Ignoring invalid Font QC profile', profile);
            return false;
        }

        if (selectedProfile === profile) {
            return false;
        }

        selectedProfile = profile;
        persistProfile(selectedProfile);
        scheduleCompilation(0);
        return true;
    }

    function getStatus() {
        return {
            isEnabled: isEnabled && !TEMP_DISABLE_FULL_COMPILE,
            isCompiling,
            lastObservedVersion,
            lastCompiledVersion,
            lastObservedPath,
            lastCompiledPath,
            selectedProfile
        };
    }

    selectedProfile = loadProfileFromStorage();

    window.fullCompileManager = {
        checkAndSchedule,
        scheduleCompilation,
        setEnabled,
        getProfile,
        setProfile,
        getAvailableProfiles,
        getStatus
    };

    if (!TEMP_DISABLE_FULL_COMPILE) {
        monitorTimer = window.setInterval(checkAndSchedule, MONITOR_MS);
    } else {
        dispatchQcUpdate(
            fontManager.fullFontQcSummary,
            'idle',
            -1,
            undefined,
            lastChecks
        );
    }

    if (!monitorTimer) {
        console.warn('Failed to start full compile monitor timer');
    }
})();
