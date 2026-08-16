#!/usr/bin/env node
/**
 * Re-format Playwright JSON state snapshots with Prettier.
 *
 * Playwright's toMatchSnapshot writer omits the trailing newline and expands
 * short arrays; Prettier (pre-commit) then rewrites them. Run this after
 * Playwright so those formatting-only diffs never linger in the working tree.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webappRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
);
const prettierBin = path.join(webappRoot, 'node_modules', '.bin', 'prettier');
const pattern = 'tests/**/*-snapshots/**/*.json';

export default async function formatSnapshotJson() {
    const result = spawnSync(
        prettierBin,
        [
            '--write',
            '--log-level',
            'warn',
            // Snapshot JSON is exempted in .prettierignore via negation, but
            // keep an explicit ignore-path bypass so this script always formats
            // even if ignore rules drift.
            '--ignore-path',
            '/dev/null',
            pattern
        ],
        {
            cwd: webappRoot,
            stdio: 'inherit',
            shell: process.platform === 'win32'
        }
    );

    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(
            `prettier failed formatting snapshot JSON (exit ${result.status})`
        );
    }
}

const isMain =
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
    formatSnapshotJson().catch((error) => {
        console.error('[format-snapshot-json]', error);
        process.exit(1);
    });
}
