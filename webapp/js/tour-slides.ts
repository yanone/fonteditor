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
    /** `**bold**`, `_italic_`. Wrap the action sentence in `_..._`. */
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
    /** Clicking this selector (or its feature row) advances the tour. */
    advanceOnClick?: string;
    /** Feature buttons: wait until the control has `.enabled`. */
    advanceOnClickRequireEnabled?: boolean;
    /** Advance when this range input is released inside [min, max]. */
    advanceOnSlider?: {
        selector: string;
        min: number;
        max: number;
    };
    /**
     * While this slide is up, clamp a range input. Values at or below
     * `latchMaxWhenAtOrBelow` latch the high end so you cannot return to
     * the start master location.
     */
    axisClamp?: {
        selector: string;
        min: number;
        max: number;
        latchMaxWhenAtOrBelow: number;
    };
    /** Double-clicking this sample-text letter (e.g. `m`) advances. */
    advanceOnGlyphDoubleClick?: string;
    prepare?: () => void | Promise<void>;
};

export const TOUR_FUSTAT_PATH = '/user/Fustat.glyphs';
export const TOUR_SAMPLE_TEXT = 'Hämburger';
export const TOUR_REGULAR_MASTER_NAME = 'Regular';
export const TOUR_EXTRABOLD_MASTER_NAME = 'ExtraBold';
export const TOUR_SS03_BUTTON_SELECTOR = 'button[data-feature-tag="ss03"]';
export const TOUR_EXTRABOLD_ITEM_SELECTOR =
    '.editor-layer-item[data-tour-master="ExtraBold"]';
export const TOUR_WGHT_SLIDER_SELECTOR =
    '.editor-axis-slider[data-axis-tag="wght"]';

function tourBody(text: string, action: string): string {
    const wrapped = action.startsWith('_') ? action : `_${action}_`;
    return `${text}\n\n${wrapped}`;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        window.setTimeout(resolve, ms);
    });
}

async function waitForElement(
    selector: string,
    timeoutMs = 8000
): Promise<Element | null> {
    const started = Date.now();
    let element = document.querySelector(selector);
    while (!element && Date.now() - started < timeoutMs) {
        await delay(50);
        element = document.querySelector(selector);
    }
    return element;
}

function getNearestVerticalScroller(element: HTMLElement): HTMLElement | null {
    const named = element.closest('#glyph-editor-scroll-content');
    if (named instanceof HTMLElement) {
        return named;
    }
    let current = element.parentElement;
    while (current) {
        const style = window.getComputedStyle(current);
        if (
            (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            current.scrollHeight > current.clientHeight + 1
        ) {
            return current;
        }
        current = current.parentElement;
    }
    return null;
}

/**
 * Nested overflow:hidden ancestors make Element.scrollIntoView skip the
 * editor sidebar scroller. Move that scroller so the target is on-screen.
 */
function scrollTourTargetIntoView(element: HTMLElement): void {
    const container = getNearestVerticalScroller(element);
    if (container) {
        const elementRect = element.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const fullyVisible =
            elementRect.height > 0 &&
            containerRect.height > 0 &&
            elementRect.top >= containerRect.top &&
            elementRect.bottom <= containerRect.bottom;
        if (!fullyVisible) {
            const delta =
                elementRect.top +
                elementRect.height / 2 -
                (containerRect.top + containerRect.height / 2);
            const maxTop = Math.max(
                0,
                container.scrollHeight - container.clientHeight
            );
            container.scrollTop = Math.min(
                maxTop,
                Math.max(0, container.scrollTop + delta)
            );
        }
        return;
    }
    if (typeof element.scrollIntoView === 'function') {
        element.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
}

function getMasterDisplayName(master: {
    name?: string | { dflt?: string; en?: string };
}): string {
    const name = master.name;
    if (typeof name === 'string') {
        return name;
    }
    if (name?.dflt) {
        return name.dflt;
    }
    if (name?.en) {
        return name.en;
    }
    return '';
}

function getFontMasters(): Array<{
    id?: string;
    name?: string | { dflt?: string; en?: string };
    location?: Record<string, number>;
}> {
    const fontModel =
        window.currentFontModel || window.fontManager?.currentFont?.fontModel;
    return fontModel?.masters || [];
}

export async function selectTourMasterByName(name: string): Promise<void> {
    const canvas = window.glyphCanvas;
    const master = getFontMasters().find(
        (entry) => getMasterDisplayName(entry) === name
    );
    if (!master?.id || !canvas?.selectMaster) {
        return;
    }
    await canvas.selectMaster(master.id, master.location || {});
}

function markMasterListItem(name: string): HTMLElement | null {
    const items = document.querySelectorAll(
        '#glyph-properties-section .editor-layer-item[data-master-id], .editor-layer-item[data-master-id]'
    );
    for (const item of items) {
        if (!(item instanceof HTMLElement)) {
            continue;
        }
        const label = item.querySelector('.master-item-name');
        if (label?.textContent?.trim() === name) {
            item.setAttribute('data-tour-master', name);
            return item;
        }
    }
    return null;
}

async function prepareSs03FeatureSlide(): Promise<void> {
    const button = await waitForElement(TOUR_SS03_BUTTON_SELECTOR);
    if (!(button instanceof HTMLElement)) {
        return;
    }
    if (button.classList.contains('enabled')) {
        button.click();
        await delay(0);
    }
    const row = button.closest('.editor-feature-row') || button;
    if (row instanceof HTMLElement) {
        scrollTourTargetIntoView(row);
    }
    await delay(50);
}

async function prepareMastersListSlide(): Promise<void> {
    const started = Date.now();
    let item = markMasterListItem(TOUR_EXTRABOLD_MASTER_NAME);
    while (!item && Date.now() - started < 8000) {
        await delay(50);
        item = markMasterListItem(TOUR_EXTRABOLD_MASTER_NAME);
    }
    if (item) {
        scrollTourTargetIntoView(item);
    }
    await delay(50);
}

async function prepareAxisSlidersSlide(): Promise<void> {
    const scroller = document.getElementById('glyph-editor-scroll-content');
    if (scroller) {
        scroller.scrollTop = 0;
    }
    await waitForElement(TOUR_WGHT_SLIDER_SELECTOR);
    await delay(50);
}

function getTextRunGlyphMetrics(letter: string): {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
} | null {
    const canvas = window.glyphCanvas;
    const textRun = canvas?.textRunEditor;
    const viewport = canvas?.viewportManager;
    if (!canvas || !textRun || !viewport) {
        return null;
    }
    const glyphs = textRun.shapedGlyphs || [];
    const buffer = textRun.textBuffer || TOUR_SAMPLE_TEXT;
    const letterIndex = buffer.indexOf(letter);
    if (letterIndex < 0 || glyphs.length === 0) {
        return null;
    }
    const band = canvas.getTextModeVerticalMetricsBand();
    let xPosition = 0;
    for (const glyph of glyphs) {
        const xOffset = glyph.dx || 0;
        const yOffset = glyph.dy || 0;
        const xAdvance = glyph.ax || 0;
        const cluster = glyph.cl || 0;
        if (cluster === letterIndex) {
            return {
                minX: xPosition + xOffset,
                maxX: xPosition + xOffset + xAdvance,
                minY: band.lowest + yOffset,
                maxY: band.highest + yOffset
            };
        }
        xPosition += xAdvance;
    }
    return null;
}

function fontRectToCutout(
    minX: number,
    maxX: number,
    minY: number,
    maxY: number
): TourCutoutRect | null {
    const canvas = window.glyphCanvas;
    const viewport = canvas?.viewportManager;
    const canvasEl = canvas?.canvas;
    if (!canvas || !viewport || !canvasEl) {
        return null;
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

    return fontRectToCutout(minX, maxX, minY, maxY);
}

function getTextRunLetterCutout(letter: string): TourCutoutRect | null {
    const metrics = getTextRunGlyphMetrics(letter);
    if (!metrics) {
        return null;
    }
    return fontRectToCutout(
        metrics.minX,
        metrics.maxX,
        metrics.minY,
        metrics.maxY
    );
}

function getElementCutoutFromElement(
    element: Element | null
): TourCutoutRect | null {
    if (!element) {
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

function getElementCutout(selector: string): TourCutoutRect | null {
    return getElementCutoutFromElement(document.querySelector(selector));
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
    },
    'ss03-features': {
        id: 'ss03-features',
        tooltip: {
            title: 'Active OpenType features',
            body: tourBody(
                'The OpenType feature buttons will substitute or position glyphs according to features definitions in the font.',
                'Click on Stylistic Set 3 (**ss03**) to activate it.'
            ),
            targetCutoutId: 'ss03-feature',
            placement: 'left'
        },
        advanceOnClick: TOUR_SS03_BUTTON_SELECTOR,
        advanceOnClickRequireEnabled: true,
        prepare: prepareSs03FeatureSlide,
        cutouts: [
            {
                id: 'ss03-feature',
                padding: 12,
                radius: 8,
                interactive: true,
                resolve: () => {
                    const button = document.querySelector(
                        TOUR_SS03_BUTTON_SELECTOR
                    );
                    const row = button?.closest('.editor-feature-row');
                    if (row instanceof Element) {
                        return getElementCutoutFromElement(row);
                    }
                    return getElementCutout(TOUR_SS03_BUTTON_SELECTOR);
                }
            }
        ]
    },
    'masters-list': {
        id: 'masters-list',
        tooltip: {
            title: 'Masters List',
            body: tourBody(
                'Choosing another master in the **Masters List** will preview the font in that designspace location.',
                'Click on the ExtraBold master.'
            ),
            targetCutoutId: 'extrabold-master',
            placement: 'right'
        },
        advanceOnClick: TOUR_EXTRABOLD_ITEM_SELECTOR,
        prepare: prepareMastersListSlide,
        cutouts: [
            {
                id: 'extrabold-master',
                padding: 10,
                radius: 8,
                interactive: true,
                resolve: () => {
                    markMasterListItem(TOUR_EXTRABOLD_MASTER_NAME);
                    return getElementCutout(TOUR_EXTRABOLD_ITEM_SELECTOR);
                }
            }
        ]
    },
    'axis-sliders': {
        id: 'axis-sliders',
        tooltip: {
            title: 'Axis Sliders',
            body: tourBody(
                'The **Axis Sliders** allow fine-grained interpolation preview.',
                'Move the slider just a little bit to preview.'
            ),
            targetCutoutId: 'wght-slider',
            placement: 'left'
        },
        prepare: prepareAxisSlidersSlide,
        advanceOnSlider: {
            selector: TOUR_WGHT_SLIDER_SELECTOR,
            min: 500,
            max: 700
        },
        axisClamp: {
            selector: TOUR_WGHT_SLIDER_SELECTOR,
            min: 500,
            max: 700,
            latchMaxWhenAtOrBelow: 700
        },
        cutouts: [
            {
                id: 'wght-slider',
                padding: 16,
                radius: 8,
                interactive: true,
                resolve: () => getElementCutout(TOUR_WGHT_SLIDER_SELECTOR)
            }
        ]
    },
    'enter-edit-mode': {
        id: 'enter-edit-mode',
        tooltip: {
            title: 'Enter Edit Mode',
            body: tourBody(
                'In **Text Mode** you double-click on glyphs to edit them in **Edit Mode**.',
                "Double click on the letter 'm' to edit it."
            ),
            targetCutoutId: 'letter-m',
            placement: 'top'
        },
        advanceOnGlyphDoubleClick: 'm',
        cutouts: [
            {
                id: 'letter-m',
                padding: 20,
                radius: 12,
                interactive: true,
                resolve: () => getTextRunLetterCutout('m')
            }
        ]
    }
};

/** Authoritative sequence. Insert new slide ids here. */
export const TOUR_SLIDE_ORDER: string[] = [
    'text-mode',
    'ss03-features',
    'masters-list',
    'axis-sliders',
    'enter-edit-mode'
];

export function getTourSlide(id: string): TourSlide | null {
    return TOUR_SLIDES[id] || null;
}

export function getTourSlideByIndex(index: number): TourSlide | null {
    const id = TOUR_SLIDE_ORDER[index];
    return id ? getTourSlide(id) : null;
}
