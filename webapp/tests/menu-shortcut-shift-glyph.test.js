const fs = require('fs');
const path = require('path');
const {
    commandModifierIconName,
    formatMenuShortcut,
    formatPlainShortcut,
    formatShortcutHtml,
    keyboardShortcutHtml,
    MENU_COMMAND_SYMBOL,
    MENU_RETURN_SYMBOL,
    MENU_SHIFT_SYMBOL,
    shortcutSpecFromHandbook
} = require('../js/keyboard-shortcut-display');

const UNICODE_SHIFT = '\u21E7';
const WEBAPP_JS_DIR = path.resolve(__dirname, '../js');

const ALLOWED_SHIFT_GLYPH_FILES = new Set([
    'view-settings.ts',
    'view-title-buttons.ts'
]);

function walkSourceFiles(dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...walkSourceFiles(full));
            continue;
        }
        if (entry.isFile() && /\.(ts|js)$/.test(entry.name)) {
            files.push(full);
        }
    }
    return files;
}

describe('unified keyboard shortcut chips', () => {
    test('renders shift and command with title-bar icons', () => {
        const html = formatShortcutHtml(
            `${MENU_COMMAND_SYMBOL}${MENU_SHIFT_SYMBOL}S`
        );
        expect(html).toContain(
            '<span class="material-symbols-outlined">arrow_upward</span>'
        );
        expect(html).toContain('shortcut-command-modifier');
        expect(html).toContain('S');
        expect(html).not.toContain(MENU_SHIFT_SYMBOL);
        expect(html).not.toContain(MENU_COMMAND_SYMBOL);
        expect(keyboardShortcutHtml('⌘S')).toContain('keyboard-shortcut');
    });

    test('formatMenuShortcut is an alias of formatShortcutHtml', () => {
        expect(formatMenuShortcut('⌘Z')).toBe(formatShortcutHtml('⌘Z'));
    });

    test('parses handbook Cmd/Ctrl chords', () => {
        expect(shortcutSpecFromHandbook('Cmd/Ctrl+Shift+O')).toBe(
            `${MENU_COMMAND_SYMBOL}${MENU_SHIFT_SYMBOL}O`
        );
        expect(shortcutSpecFromHandbook('Cmd+Enter')).toBe(
            `${MENU_COMMAND_SYMBOL}${MENU_RETURN_SYMBOL}`
        );
        expect(shortcutSpecFromHandbook('v')).toBeNull();
        expect(shortcutSpecFromHandbook('print()')).toBeNull();
    });

    test('source does not use the unicode shift symbol outside title-bar config', () => {
        const offenders = [];
        for (const file of walkSourceFiles(WEBAPP_JS_DIR)) {
            if (ALLOWED_SHIFT_GLYPH_FILES.has(path.basename(file))) {
                continue;
            }
            const source = fs.readFileSync(file, 'utf8');
            if (!source.includes(UNICODE_SHIFT)) {
                continue;
            }
            const lines = source.split('\n');
            lines.forEach((line, index) => {
                if (line.includes(UNICODE_SHIFT)) {
                    offenders.push(
                        `${path.relative(WEBAPP_JS_DIR, file)}:${index + 1}: ${line.trim()}`
                    );
                }
            });
        }

        expect(offenders).toEqual([]);
    });

    test('plugin-menu-shortcut markup does not embed a raw command glyph', () => {
        const offenders = [];
        for (const file of walkSourceFiles(WEBAPP_JS_DIR)) {
            const source = fs.readFileSync(file, 'utf8');
            const lines = source.split('\n');
            lines.forEach((line, index) => {
                if (
                    line.includes('plugin-menu-shortcut') &&
                    line.includes(MENU_COMMAND_SYMBOL) &&
                    !line.includes('keyboardShortcutHtml') &&
                    !line.includes('formatMenuShortcut') &&
                    !line.includes('formatShortcutHtml')
                ) {
                    offenders.push(
                        `${path.relative(WEBAPP_JS_DIR, file)}:${index + 1}: ${line.trim()}`
                    );
                }
            });
        }
        expect(offenders).toEqual([]);
    });
});

describe('command modifier glyph', () => {
    const originalPlatform = navigator.platform;

    afterEach(() => {
        Object.defineProperty(navigator, 'platform', {
            configurable: true,
            value: originalPlatform
        });
    });

    test('uses the Control icon on Windows', () => {
        Object.defineProperty(navigator, 'platform', {
            configurable: true,
            value: 'Win32'
        });
        expect(commandModifierIconName()).toBe('keyboard_control_key');
        expect(formatPlainShortcut(`${MENU_COMMAND_SYMBOL}S`)).toBe('\u2303S');
    });

    test('uses the Command icon on macOS', () => {
        Object.defineProperty(navigator, 'platform', {
            configurable: true,
            value: 'MacIntel'
        });
        expect(commandModifierIconName()).toBe('keyboard_command_key');
        expect(formatPlainShortcut(`${MENU_COMMAND_SYMBOL}S`)).toBe(
            `${MENU_COMMAND_SYMBOL}S`
        );
    });
});
