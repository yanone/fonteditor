#!/usr/bin/env node
/**
 * Next preview version from existing preview tags.
 * N is a monotonic build number across days. DATE is the UTC day of this cut.
 * Tag form v0.0.0-preview.DATE.N still sorts descending: DATE is compared
 * first (YYYYMMDD), then N numerically, and N never decreases.
 *
 * Usage: git tag -l 'v0.0.0-preview.*' | node scripts/preview-version.mjs --date=YYYYMMDD
 * Prints TAG, DISPLAY_VERSION, PREV_TAG, NEXT_N as KEY=value lines.
 */

import { pathToFileURL } from 'url';
import { readFileSync } from 'fs';

const DOTTED_TAG = /^v0\.0\.0-preview\.(\d+)\.(\d+)$/;
const DISPLAY_NAME = /^(\d+)-build-(\d+)$/;
const LEGACY_NAME = /^preview-build-(\d+)-on-(\d+)$/;

/**
 * @typedef {{ date: string, n: number, tag: string | null }} PreviewRef
 */

/**
 * @param {string} value
 * @returns {PreviewRef | null}
 */
export function parsePreviewRef(value) {
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    let match = trimmed.match(DOTTED_TAG);
    if (match) {
        return { date: match[1], n: Number(match[2]), tag: trimmed };
    }
    match = trimmed.match(DISPLAY_NAME);
    if (match) {
        return { date: match[1], n: Number(match[2]), tag: null };
    }
    match = trimmed.match(LEGACY_NAME);
    if (match) {
        return { date: match[2], n: Number(match[1]), tag: null };
    }
    return null;
}

/**
 * @param {PreviewRef} candidate
 * @param {PreviewRef | null} current
 */
function isNewerPreview(candidate, current) {
    if (!current) {
        return true;
    }
    if (Number(candidate.date) !== Number(current.date)) {
        return Number(candidate.date) > Number(current.date);
    }
    return candidate.n > current.n;
}

/**
 * @param {string[]} refs
 * @param {string} date
 */
export function resolveNextPreviewVersion(refs, date) {
    if (!/^\d{8}$/.test(date)) {
        throw new Error(`Expected UTC date YYYYMMDD, got ${date}`);
    }

    let maxN = 0;
    /** @type {PreviewRef | null} */
    let previous = null;
    for (const ref of refs) {
        const parsed = parsePreviewRef(ref);
        if (!parsed) {
            continue;
        }
        if (parsed.n > maxN) {
            maxN = parsed.n;
        }
        if (isNewerPreview(parsed, previous)) {
            previous = parsed;
        }
    }

    const nextN = maxN + 1;
    return {
        nextN,
        displayVersion: `${date}-build-${nextN}`,
        tag: `v0.0.0-preview.${date}.${nextN}`,
        prevTag: previous?.tag ?? ''
    };
}

function readRefsFromStdin() {
    const input = readFileSync(0, 'utf8');
    return input.split(/\r?\n/).filter(Boolean);
}

function parseDateArg(argv) {
    const dateArg = argv.find((arg) => arg.startsWith('--date='));
    if (!dateArg) {
        throw new Error('Missing --date=YYYYMMDD');
    }
    return dateArg.slice('--date='.length);
}

export function main(argv = process.argv.slice(2), refs = readRefsFromStdin()) {
    const resolved = resolveNextPreviewVersion(refs, parseDateArg(argv));
    process.stdout.write(
        [
            `TAG=${resolved.tag}`,
            `DISPLAY_VERSION=${resolved.displayVersion}`,
            `PREV_TAG=${resolved.prevTag}`,
            `NEXT_N=${resolved.nextN}`
        ].join('\n') + '\n'
    );
}

function isMain() {
    const entry = process.argv[1];
    return entry && import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
    main();
}
