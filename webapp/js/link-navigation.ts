/**
 * App-wide link navigation:
 * - docs://{pageId}[#heading] opens the in-app docs viewer
 * - unknown navigational links open in a new tab (never unload the editor)
 * - beforeunload warns when the font has unsynced changes
 */

import { Logger } from './logger';

const console = new Logger('LinkNavigation');

export const DOCS_SCHEME = 'docs://';

type HandbookManifestNode = {
    id: string;
    title?: string;
    kind: 'section' | 'page';
    path?: string;
    children?: HandbookManifestNode[];
};

export type DocsLinkTarget = {
    id: string;
    heading?: string;
};

let pathToId: Map<string, string> | null = null;
let knownIds: Set<string> | null = null;
let manifestLoad: Promise<void> | null = null;
let guardInstalled = false;

export function buildDocsHref(id: string, heading?: string): string {
    const cleanId = normalizeDocsId(id);
    if (!cleanId) {
        return DOCS_SCHEME;
    }
    return heading
        ? `${DOCS_SCHEME}${cleanId}#${heading}`
        : `${DOCS_SCHEME}${cleanId}`;
}

export function normalizeDocsId(value: string): string {
    return value
        .replace(/^docs:\/\//i, '')
        .replace(/^#docs=/i, '')
        .replace(/^\/+/, '')
        .replace(/#.*$/, '')
        .trim();
}

export function parseDocsLink(href: string): DocsLinkTarget | null {
    const trimmed = href.trim();
    if (!trimmed) {
        return null;
    }

    if (/^docs:\/\//i.test(trimmed)) {
        const body = trimmed.slice(DOCS_SCHEME.length);
        const hashIndex = body.indexOf('#');
        const idPart = hashIndex === -1 ? body : body.slice(0, hashIndex);
        const heading =
            hashIndex === -1 ? undefined : body.slice(hashIndex + 1);
        const id = decodeURIComponent(idPart.replace(/^\/+/, '')).trim();
        if (!id) {
            return null;
        }
        return heading ? { id, heading } : { id };
    }

    if (trimmed.startsWith('#docs=')) {
        const body = trimmed.slice('#docs='.length);
        const hashIndex = body.indexOf('#');
        const idPart = hashIndex === -1 ? body : body.slice(0, hashIndex);
        const heading =
            hashIndex === -1 ? undefined : body.slice(hashIndex + 1);
        const id = decodeURIComponent(idPart).trim();
        if (!id) {
            return null;
        }
        return heading ? { id, heading } : { id };
    }

    return null;
}

function indexManifest(nodes: HandbookManifestNode[]): void {
    const nextPathToId = new Map<string, string>();
    const nextIds = new Set<string>();

    const walk = (list: HandbookManifestNode[]) => {
        for (const node of list) {
            if (node.kind === 'page' && node.id) {
                nextIds.add(node.id);
                if (node.path) {
                    nextPathToId.set(node.path, node.id);
                    nextPathToId.set(node.path.replace(/\.md$/i, ''), node.id);
                }
            }
            if (node.children?.length) {
                walk(node.children);
            }
        }
    };

    walk(nodes);
    pathToId = nextPathToId;
    knownIds = nextIds;
}

export function setHandbookManifestForTests(
    nodes: HandbookManifestNode[]
): void {
    indexManifest(nodes);
}

function handbookPathCandidate(href: string): string | null {
    let path = href.trim();
    if (!path) {
        return null;
    }

    try {
        if (/^https?:\/\//i.test(path)) {
            path = new URL(path).pathname;
        }
    } catch {
        // Keep the original string when URL parsing fails.
    }

    path = path.replace(/^\/+/, '');
    if (path.startsWith('handbook/')) {
        path = path.slice('handbook/'.length);
    }

    const pathOnly = path.split('#')[0]?.split('?')[0] ?? '';
    if (!pathOnly.toLowerCase().endsWith('.md')) {
        return null;
    }
    return pathOnly;
}

/**
 * Resolve a href to a docs viewer target when it is docs://, #docs=, or a
 * known handbook markdown path.
 */
export function resolveDocsTarget(href: string): DocsLinkTarget | null {
    const direct = parseDocsLink(href);
    if (direct) {
        return direct;
    }

    if (!pathToId || !knownIds) {
        return null;
    }

    const trimmed = href.trim();
    const hashIndex = trimmed.indexOf('#');
    const withoutHash =
        hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex);
    const heading =
        hashIndex === -1
            ? undefined
            : trimmed.slice(hashIndex + 1) || undefined;

    const bareId = withoutHash.replace(/^\/+/, '');
    if (knownIds.has(bareId)) {
        return heading ? { id: bareId, heading } : { id: bareId };
    }

    const path = handbookPathCandidate(href);
    if (!path) {
        return null;
    }

    const id =
        pathToId.get(path) || pathToId.get(path.replace(/\.md$/i, '')) || null;
    if (!id) {
        return null;
    }

    return heading ? { id, heading } : { id };
}

export function rewriteHtmlAnchorsForDocs(html: string): string {
    if (!html.includes('<a') && !html.includes('<A')) {
        return html;
    }

    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    wrap.querySelectorAll('a[href]').forEach((anchor) => {
        const href = anchor.getAttribute('href');
        if (!href) {
            return;
        }
        const target = resolveDocsTarget(href);
        if (!target) {
            return;
        }
        anchor.setAttribute('href', buildDocsHref(target.id, target.heading));
    });
    return wrap.innerHTML;
}

async function loadHandbookManifest(): Promise<void> {
    if (pathToId) {
        return;
    }
    if (!manifestLoad) {
        manifestLoad = (async () => {
            try {
                const response = await fetch('/handbook/manifest.json');
                if (!response.ok) {
                    throw new Error(
                        `Failed to load handbook manifest (${response.status})`
                    );
                }
                const manifest = (await response.json()) as {
                    nodes?: HandbookManifestNode[];
                };
                if (Array.isArray(manifest.nodes)) {
                    indexManifest(manifest.nodes);
                }
            } catch (error) {
                console.warn(
                    'Handbook manifest unavailable for link rewrite',
                    error
                );
                manifestLoad = null;
            }
        })();
    }
    await manifestLoad;
}

function fontHasUnsyncedChanges(): boolean {
    const fontManager = window.fontManager;
    if (!fontManager) {
        return false;
    }
    if (typeof fontManager.hasAnyDirtyState === 'function') {
        return fontManager.hasAnyDirtyState();
    }
    return false;
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
    if (!fontHasUnsyncedChanges()) {
        return;
    }
    event.preventDefault();
    event.returnValue = '';
}

function onDocumentClick(event: MouseEvent): void {
    if (event.defaultPrevented || event.button !== 0) {
        return;
    }

    const target = event.target;
    if (!(target instanceof Element)) {
        return;
    }

    const anchor = target.closest('a');
    if (!(anchor instanceof HTMLAnchorElement)) {
        return;
    }
    if (anchor.hasAttribute('download')) {
        return;
    }

    const rawHref = anchor.getAttribute('href');
    if (rawHref == null || rawHref === '') {
        return;
    }

    const docsTarget = resolveDocsTarget(rawHref) || parseDocsLink(rawHref);
    if (docsTarget) {
        event.preventDefault();
        event.stopPropagation();
        void window.openDocs?.(docsTarget.id, docsTarget.heading);
        return;
    }

    // In-page fragments and script URLs stay in-document.
    if (
        rawHref.startsWith('#') ||
        rawHref.toLowerCase().startsWith('javascript:')
    ) {
        return;
    }

    const linkTarget = (anchor.getAttribute('target') || '').toLowerCase();
    if (linkTarget === '_blank' || linkTarget === '_new') {
        if (!anchor.rel) {
            anchor.rel = 'noopener noreferrer';
        }
        return;
    }

    // Modifier-clicks already open a separate tab/window in the browser.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
    }

    // Unknown navigational link: never unload the editor tab.
    event.preventDefault();
    event.stopPropagation();
    window.open(anchor.href, '_blank', 'noopener,noreferrer');
}

export function initLinkNavigationGuard(): void {
    if (guardInstalled || typeof document === 'undefined') {
        return;
    }
    guardInstalled = true;
    document.addEventListener('click', onDocumentClick, true);
    window.addEventListener('beforeunload', onBeforeUnload);
    void loadHandbookManifest();
    console.log('Link navigation guard installed');
}
