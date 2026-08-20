/**
 * Reorderable tour script. Insert or move ids in TOUR_SLIDE_ORDER;
 * keep the matching entry in TOUR_SLIDES.
 */

export type TourCutoutRect = {
    left: number;
    top: number;
    width: number;
    height: number;
};

export type TourCutout = {
    id: string;
    padding?: number;
    radius?: number;
    /** When true, pointer events pass through the hole to the app. */
    interactive?: boolean;
    resolve: () => TourCutoutRect | null;
};

export type TourTooltip = {
    title: string;
    body: string;
    targetCutoutId: string;
    continueLabel?: string;
    placement?: 'top' | 'bottom' | 'left' | 'right';
};

export type TourSlide = {
    id: string;
    cutouts: TourCutout[];
    tooltip: TourTooltip;
    /**
     * View shortcut keys (the letter, e.g. 'e') that remain active.
     * Empty / omitted blocks every Cmd/Ctrl+Shift view shortcut.
     */
    allowedViewShortcutKeys?: string[];
    prepare?: () => void | Promise<void>;
};

export const TOUR_FUSTAT_PATH = '/user/Fustat.glyphs';
export const TOUR_SAMPLE_TEXT = 'Hämburger';

function getTextRunCutout(): TourCutoutRect | null {
    const canvas = window.glyphCanvas;
    const textRun = canvas?.textRunEditor;
    const viewport = canvas?.viewportManager;
    const canvasEl = canvas?.canvas;
    if (!canvas || !textRun || !viewport || !canvasEl) {
        return null;
    }

    const glyphs = textRun.shapedGlyphs || [];
    if (glyphs.length === 0) {
        return null;
    }

    const band = canvas.getTextModeVerticalMetricsBand();
    let minX = 0;
    let maxX = 0;
    let minY = band.lowest;
    let maxY = band.highest;
    let xPosition = 0;

    for (const glyph of glyphs) {
        const xOffset = glyph.dx || 0;
        const yOffset = glyph.dy || 0;
        const xAdvance = glyph.ax || 0;
        const glyphX = xPosition + xOffset;
        minX = Math.min(minX, glyphX);
        maxX = Math.max(maxX, glyphX + xAdvance);
        minY = Math.min(minY, band.lowest + yOffset);
        maxY = Math.max(maxY, band.highest + yOffset);
        xPosition += xAdvance;
    }

    const corners = [
        viewport.fontToScreenCoordinates(minX, minY),
        viewport.fontToScreenCoordinates(maxX, minY),
        viewport.fontToScreenCoordinates(minX, maxY),
        viewport.fontToScreenCoordinates(maxX, maxY)
    ];
    const canvasRect = canvasEl.getBoundingClientRect();
    const left = canvasRect.left + Math.min(...corners.map((point) => point.x));
    const top = canvasRect.top + Math.min(...corners.map((point) => point.y));
    const right =
        canvasRect.left + Math.max(...corners.map((point) => point.x));
    const bottom =
        canvasRect.top + Math.max(...corners.map((point) => point.y));

    return {
        left,
        top,
        width: Math.max(8, right - left),
        height: Math.max(8, bottom - top)
    };
}

function getElementCutout(selector: string): TourCutoutRect | null {
    const element = document.querySelector(selector);
    if (!(element instanceof Element)) {
        return null;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        return null;
    }
    return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
    };
}

export const TOUR_SLIDES: Record<string, TourSlide> = {
    'text-mode': {
        id: 'text-mode',
        tooltip: {
            title: 'Text Mode',
            body: 'In **Text Mode** you type the letters and words you want to design.',
            targetCutoutId: 'text-tool',
            continueLabel: 'Continue',
            placement: 'bottom'
        },
        cutouts: [
            {
                id: 'sample-text',
                padding: 28,
                radius: 12,
                resolve: getTextRunCutout
            },
            {
                id: 'text-tool',
                padding: 14,
                radius: 10,
                resolve: () => getElementCutout('#editor-tool-text')
            }
        ]
    }
};

/** Authoritative sequence. Insert new slide ids here. */
export const TOUR_SLIDE_ORDER: string[] = ['text-mode'];

export function getTourSlide(id: string): TourSlide | null {
    return TOUR_SLIDES[id] || null;
}

export function getTourSlideByIndex(index: number): TourSlide | null {
    const id = TOUR_SLIDE_ORDER[index];
    return id ? getTourSlide(id) : null;
}
