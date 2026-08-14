import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
    buildManifest,
    pageIdFromRelativePath,
    stripNumericPrefix
} from '../scripts/generate-documentation-manifest.mjs';

test('strips numeric prefixes from stable ids', () => {
    assert.equal(stripNumericPrefix('01-glyph-editor'), 'glyph-editor');
    assert.equal(
        pageIdFromRelativePath('editor/01-glyph-editor.md'),
        'editor/glyph-editor'
    );
});

test('builds a folder tree manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docs-manifest-'));
    try {
        await mkdir(join(root, 'editor'), { recursive: true });
        await writeFile(
            join(root, 'editor', '01-glyph-editor.md'),
            '# Glyph editor\n\nDraw outlines.\n'
        );
        await writeFile(join(root, 'README.md'), '# Authoring\n');
        const manifest = await buildManifest(root);
        assert.equal(manifest.defaultId, 'editor/glyph-editor');
        assert.equal(manifest.nodes.length, 1);
        assert.equal(manifest.nodes[0].kind, 'section');
        assert.equal(manifest.nodes[0].id, 'editor');
        assert.equal(manifest.nodes[0].children[0].id, 'editor/glyph-editor');
        assert.equal(
            manifest.nodes[0].children[0].path,
            'editor/01-glyph-editor.md'
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
