/**
 * Preference: how much chrome Space preview hides, and which rectangle the
 * dotted viewport guide follows. Default small.
 *
 * Small: chrome stays visible (guide on the editor view). Medium: hide editor
 * title bar, sidebar, and property panel, but keep the focused view border
 * (guide on the canvas cutout). Full: hide toolbar and app shell
 * (guide on the canvas cutout).
 */

import {
    getPreviewArea as readPreviewArea,
    setPreviewAreaPreference
} from './window-ui-state';

export type PreviewArea = 'small' | 'medium' | 'full';

export function parsePreviewArea(value: string | null): PreviewArea {
    if (value === 'small' || value === 'medium' || value === 'full') {
        return value;
    }
    return 'small';
}

export function getPreviewArea(): PreviewArea {
    return readPreviewArea();
}

export function setPreviewArea(area: PreviewArea): void {
    const next = parsePreviewArea(area);
    setPreviewAreaPreference(next);
    window.dispatchEvent(
        new CustomEvent('editorPreviewAreaChanged', {
            detail: { area: next }
        })
    );
}
