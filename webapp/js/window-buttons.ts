/**
 * window-buttons.ts — Toolbar buttons for undo/redo and "Open in New Window".
 *
 * Wired up after DOM is ready. The undo/redo buttons reflect state from
 * the ChangeBridge; the "new window" button opens the same font URL
 * with a `sync` parameter.
 */

import { Logger } from './logger';
import { runBridgeUndoRedo } from './change-bridge-init';

const console = new Logger('WindowButtons');
const undoManagerWindows = new Set<Window>();
const editorChildWindows = new Set<Window>();
const editorThemeWindowId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let suppressEditorThemeBroadcast = false;

type ThemePreference = 'light' | 'dark' | 'auto';

interface EditorThemeMessage {
    type: 'editor-theme-sync';
    sourceWindowId: string;
    preference: ThemePreference;
    theme: 'light' | 'dark';
}

function isThemePreference(value: unknown): value is ThemePreference {
    return value === 'light' || value === 'dark' || value === 'auto';
}

function isEditorThemeMessage(data: unknown): data is EditorThemeMessage {
    if (!data || typeof data !== 'object') {
        return false;
    }

    const msg = data as Partial<EditorThemeMessage>;
    return (
        msg.type === 'editor-theme-sync' &&
        typeof msg.sourceWindowId === 'string' &&
        isThemePreference(msg.preference) &&
        (msg.theme === 'light' || msg.theme === 'dark')
    );
}

function isUndoManagerReadyMessage(
    data: unknown
): data is { type: 'undo-manager-ready' } {
    if (!data || typeof data !== 'object') {
        return false;
    }
    return (data as { type?: string }).type === 'undo-manager-ready';
}

function getCurrentEditorTheme(): 'light' | 'dark' {
    return document.documentElement.getAttribute('data-theme') === 'light'
        ? 'light'
        : 'dark';
}

function getCurrentThemePreference(): ThemePreference {
    const preference = window.themeSwitcher?.getCurrentTheme?.();
    return isThemePreference(preference) ? preference : 'auto';
}

function postUndoManagerMessage(payload: Record<string, unknown>): void {
    for (const win of Array.from(undoManagerWindows)) {
        if (win.closed) {
            undoManagerWindows.delete(win);
            continue;
        }
        try {
            win.postMessage(payload, window.location.origin);
        } catch {
            // Ignore per-window postMessage failures.
        }
    }
}

function postEditorThemeToChildWindows(payload: EditorThemeMessage): void {
    for (const win of Array.from(editorChildWindows)) {
        if (win.closed) {
            editorChildWindows.delete(win);
            continue;
        }
        try {
            win.postMessage(payload, window.location.origin);
        } catch {
            // Ignore per-window postMessage failures.
        }
    }
}

function postEditorThemeToOpener(payload: EditorThemeMessage): void {
    if (!window.opener || window.opener.closed) {
        return;
    }
    try {
        window.opener.postMessage(payload, window.location.origin);
    } catch {
        // Ignore opener postMessage failures.
    }
}

function broadcastEditorTheme(preference: ThemePreference): void {
    const payload: EditorThemeMessage = {
        type: 'editor-theme-sync',
        sourceWindowId: editorThemeWindowId,
        preference,
        theme:
            preference === 'light'
                ? 'light'
                : preference === 'dark'
                  ? 'dark'
                  : getCurrentEditorTheme()
    };

    postEditorThemeToChildWindows(payload);
    postEditorThemeToOpener(payload);
}

function syncUndoManagerTheme(): void {
    postUndoManagerMessage({
        type: 'undo-manager-theme',
        theme: getCurrentEditorTheme()
    });
}

function syncUndoManagerMetadata(): void {
    const fontPath = window.fontManager?.currentFont?.path ?? 'unsaved';
    postUndoManagerMessage({
        type: 'undo-manager-metadata',
        theme: getCurrentEditorTheme(),
        fontPath
    });
}

function registerUndoManagerWindow(win: Window): void {
    undoManagerWindows.add(win);

    const pushMetadata = () => {
        try {
            if (win.closed) {
                undoManagerWindows.delete(win);
                return;
            }
            const fontPath = window.fontManager?.currentFont?.path ?? 'unsaved';
            win.postMessage(
                {
                    type: 'undo-manager-metadata',
                    theme: getCurrentEditorTheme(),
                    fontPath
                },
                window.location.origin
            );
        } catch {
            // Ignore cross-window metadata push failures.
        }
    };

    win.addEventListener('load', pushMetadata);
    window.setTimeout(pushMetadata, 200);
}

function registerEditorChildWindow(win: Window): void {
    editorChildWindows.add(win);

    const pushTheme = () => {
        if (win.closed) {
            editorChildWindows.delete(win);
            return;
        }

        const payload: EditorThemeMessage = {
            type: 'editor-theme-sync',
            sourceWindowId: editorThemeWindowId,
            preference: getCurrentThemePreference(),
            theme: getCurrentEditorTheme()
        };

        try {
            win.postMessage(payload, window.location.origin);
        } catch {
            // Ignore per-window postMessage failures.
        }
    };

    win.addEventListener('load', pushTheme);
    window.setTimeout(pushTheme, 200);
}

function applyRemoteThemePreference(preference: ThemePreference): void {
    const switcher = window.themeSwitcher;
    if (!switcher || typeof switcher.setTheme !== 'function') {
        return;
    }

    if (switcher.getCurrentTheme?.() === preference) {
        return;
    }

    suppressEditorThemeBroadcast = true;
    try {
        switcher.setTheme(preference);
    } finally {
        suppressEditorThemeBroadcast = false;
    }
}

window.addEventListener('message', (event: MessageEvent) => {
    if (event.origin !== window.location.origin) {
        return;
    }

    if (isUndoManagerReadyMessage(event.data)) {
        syncUndoManagerMetadata();
        return;
    }

    if (!isEditorThemeMessage(event.data)) {
        return;
    }

    if (event.data.sourceWindowId === editorThemeWindowId) {
        return;
    }

    applyRemoteThemePreference(event.data.preference);
    postEditorThemeToChildWindows(event.data);
});

window.addEventListener('beforeunload', () => {
    postUndoManagerMessage({ type: 'undo-manager-reload' });
});

const themeObserver = new MutationObserver(() => {
    syncUndoManagerTheme();
    if (!suppressEditorThemeBroadcast) {
        broadcastEditorTheme(getCurrentThemePreference());
    }
});
themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme']
});

window.addEventListener('fontModelReady', () => {
    syncUndoManagerMetadata();
});

function initWindowButtons(): void {
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');
    const newWindowBtn = document.getElementById('open-new-window-btn');

    if (undoBtn) {
        undoBtn.addEventListener('click', async () => {
            const bridge = window.changeBridge;
            if (!bridge) return;
            const oe = window.glyphCanvas?.outlineEditor;
            const parsedStack = oe?.active ? oe.parseGlyphStack() : [];
            const rootGlyphName = parsedStack[0]?.glyphName;
            const undoGlyphName =
                parsedStack[parsedStack.length - 1]?.glyphName;
            if (oe?.active && (!rootGlyphName || !undoGlyphName)) {
                console.warn(
                    'Skipping undo: active outline editor has incomplete glyph stack'
                );
                return;
            }
            await runBridgeUndoRedo('undo', undoGlyphName, rootGlyphName);
        });
    }

    if (redoBtn) {
        redoBtn.addEventListener('click', async () => {
            const bridge = window.changeBridge;
            if (!bridge) return;
            const oe = window.glyphCanvas?.outlineEditor;
            const parsedStack = oe?.active ? oe.parseGlyphStack() : [];
            const rootGlyphName = parsedStack[0]?.glyphName;
            const undoGlyphName =
                parsedStack[parsedStack.length - 1]?.glyphName;
            if (oe?.active && (!rootGlyphName || !undoGlyphName)) {
                console.warn(
                    'Skipping redo: active outline editor has incomplete glyph stack'
                );
                return;
            }
            await runBridgeUndoRedo('redo', undoGlyphName, rootGlyphName);
        });
    }

    if (newWindowBtn) {
        newWindowBtn.addEventListener('click', () => {
            const url = new URL(window.location.href);
            url.searchParams.set('sync', 'true');
            url.searchParams.set('theme', getCurrentThemePreference());
            const childWindow = window.open(url.toString(), '_blank');
            if (childWindow) {
                registerEditorChildWindow(childWindow);
            }
        });
    }

    const undoManagerBtn = document.getElementById('open-undo-manager-btn');
    if (undoManagerBtn) {
        undoManagerBtn.addEventListener('click', () => {
            const fontPath = window.fontManager?.currentFont?.path ?? 'unsaved';
            const channelName = `counterpunch-font:${fontPath}`;
            const url = new URL('undo-manager.html', window.location.href);
            url.searchParams.set('channel', channelName);
            url.searchParams.set('theme', getCurrentEditorTheme());
            const undoWindow = window.open(
                url.toString(),
                '_blank',
                'width=500,height=700'
            );
            if (undoWindow) {
                registerUndoManagerWindow(undoWindow);
            }
        });
    }
}

// Initialize after DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWindowButtons);
} else {
    initWindowButtons();
}
