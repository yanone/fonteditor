/**
 * Preference: how much chrome Space preview fades, and which rectangle the
 * dotted viewport guide follows. Default small.
 *
 * Small: no chrome fade (guide on the editor view). Medium: fade editor
 * chrome (guide on the canvas cutout). Full: fade toolbar and app shell
 * (guide on the canvas cutout).
 */

export type PreviewArea = 'small' | 'medium' | 'full';

const STORAGE_KEY = 'editorPreviewArea';
const DEFAULT_AREA: PreviewArea = 'small';

export function parsePreviewArea(value: string | null): PreviewArea {
    if (value === 'small' || value === 'medium' || value === 'full') {
        return value;
    }
    return DEFAULT_AREA;
}

export function getPreviewArea(): PreviewArea {
    try {
        return parsePreviewArea(localStorage.getItem(STORAGE_KEY));
    } catch {
        return DEFAULT_AREA;
    }
}

export function setPreviewArea(area: PreviewArea): void {
    const next = parsePreviewArea(area);
    try {
        localStorage.setItem(STORAGE_KEY, next);
    } catch {
        // Ignore localStorage access failures.
    }

    window.dispatchEvent(
        new CustomEvent('editorPreviewAreaChanged', {
            detail: { area: next }
        })
    );
}
