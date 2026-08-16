#!/usr/bin/env node
/**
 * Print Unreleased bullets present in the new CHANGELOG but not the old one.
 * Usage: node scripts/unreleased-changelog-diff.mjs <old.md> <new.md>
 */

import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';

const PLACEHOLDER = /Add items here/;
const EMPTY_NOTES =
    'No new Unreleased changelog bullets since the previous preview.';

export function extractUnreleasedBullets(markdown) {
    const bullets = [];
    let inUnreleased = false;
    for (const line of markdown.split(/\r?\n/)) {
        if (line.startsWith('# ')) {
            if (inUnreleased) {
                break;
            }
            if (line === '# Unreleased') {
                inUnreleased = true;
            }
            continue;
        }
        if (inUnreleased && line.startsWith('- ')) {
            if (PLACEHOLDER.test(line)) {
                continue;
            }
            bullets.push(line);
        }
    }
    return bullets;
}

export function diffUnreleasedBullets(oldMarkdown, newMarkdown) {
    const previous = new Set(extractUnreleasedBullets(oldMarkdown));
    const added = extractUnreleasedBullets(newMarkdown).filter(
        (bullet) => !previous.has(bullet)
    );
    if (added.length === 0) {
        return EMPTY_NOTES;
    }
    return added.join('\n');
}

function isMain() {
    const entry = process.argv[1];
    return entry && import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
    const [oldPath, newPath] = process.argv.slice(2);
    if (!oldPath || !newPath) {
        console.error(
            'Usage: node scripts/unreleased-changelog-diff.mjs <old.md> <new.md>'
        );
        process.exit(1);
    }
    const notes = diffUnreleasedBullets(
        readFileSync(oldPath, 'utf8'),
        readFileSync(newPath, 'utf8')
    );
    process.stdout.write(notes.endsWith('\n') ? notes : `${notes}\n`);
}
