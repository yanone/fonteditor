const {
    buildDocsHref,
    normalizeDocsId,
    parseDocsLink,
    resolveDocsTarget,
    rewriteHtmlAnchorsForDocs,
    setHandbookManifestForTests
} = require('../js/link-navigation.ts');

describe('link-navigation', () => {
    beforeEach(() => {
        setHandbookManifestForTests([
            {
                id: 'editor',
                title: 'Editor',
                kind: 'section',
                children: [
                    {
                        id: 'editor/outline-drawing',
                        title: 'Outline drawing',
                        kind: 'page',
                        path: 'editor/02-outline-drawing.md'
                    }
                ]
            }
        ]);
    });

    test('builds and parses docs:// links', () => {
        expect(buildDocsHref('editor/outline-drawing')).toBe(
            'docs://editor/outline-drawing'
        );
        expect(buildDocsHref('editor/outline-drawing', 'nodes')).toBe(
            'docs://editor/outline-drawing#nodes'
        );
        expect(parseDocsLink('docs://editor/outline-drawing')).toEqual({
            id: 'editor/outline-drawing'
        });
        expect(parseDocsLink('docs://editor/outline-drawing#nodes')).toEqual({
            id: 'editor/outline-drawing',
            heading: 'nodes'
        });
        expect(parseDocsLink('#docs=editor/outline-drawing')).toEqual({
            id: 'editor/outline-drawing'
        });
    });

    test('normalizes docs:// and path topics', () => {
        expect(normalizeDocsId('docs://editor/outline-drawing#x')).toBe(
            'editor/outline-drawing'
        );
        expect(normalizeDocsId('#docs=editor/outline-drawing')).toBe(
            'editor/outline-drawing'
        );
    });

    test('resolves known handbook markdown paths to docs targets', () => {
        expect(resolveDocsTarget('editor/02-outline-drawing.md')).toEqual({
            id: 'editor/outline-drawing'
        });
        expect(resolveDocsTarget('editor/outline-drawing')).toEqual({
            id: 'editor/outline-drawing'
        });
        expect(
            resolveDocsTarget(
                'https://localhost:8000/editor/02-outline-drawing.md'
            )
        ).toEqual({ id: 'editor/outline-drawing' });
        expect(
            resolveDocsTarget('/handbook/editor/02-outline-drawing.md#nodes')
        ).toEqual({
            id: 'editor/outline-drawing',
            heading: 'nodes'
        });
    });

    test('rewrites assistant HTML anchors to docs://', () => {
        const html =
            '<p><a href="editor/02-outline-drawing.md">Outline</a></p>';
        expect(rewriteHtmlAnchorsForDocs(html)).toContain(
            'href="docs://editor/outline-drawing"'
        );
    });
});
