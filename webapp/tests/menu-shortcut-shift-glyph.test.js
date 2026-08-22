const fs = require('fs');
const path = require('path');
const { formatMenuShortcut, MENU_SHIFT_SYMBOL } = require('../js/tippy-utils');

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

describe('Tippy menu shift glyph', () => {
    test('renders shift as the title-bar upward arrow icon', () => {
        const html = formatMenuShortcut(`⌘${MENU_SHIFT_SYMBOL}S`);
        expect(html).toContain(
            '<span class="material-symbols-outlined">arrow_upward</span>'
        );
        expect(html).toContain('⌘');
        expect(html).toContain('S');
        expect(html).not.toContain(MENU_SHIFT_SYMBOL);
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
});
