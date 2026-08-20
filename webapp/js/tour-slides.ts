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
    /**
     * Padding for the click-through hole. Omit to match `padding`.
     * Use `0` so a padded visual hole does not let neighbors receive clicks.
     */
    hitPadding?: number;
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
    /** Advance after the user drags a node on the letter cutout. */
    advanceOnNodeDrag?: boolean;
    /**
     * Wait after the slide's action before switching. Defaults to the
     * spotlight apply delay (feature / master clicks).
     */
    advanceDelayMs?: number;
    /**
     * When advancing from a click, fade to the sample-text spotlight first.
     * Defaults to true for `advanceOnClick`.
     */
    previewTextBeforeApply?: boolean;
    /** Unmodified letter keys the tour key lock still lets through (`p`). */
    allowedKeys?: string[];
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
export const TOUR_LAYERS_LIST_SELECTOR =
    '#glyph-properties-section .editor-layers-widget:not(.editor-feature-variations-widget) .editor-layers-list';
export const TOUR_LAYER_ITEM_SELECTOR = `${TOUR_LAYERS_LIST_SELECTOR} .editor-layer-item`;
export const TOUR_SELECT_TOOL_SELECTOR = '#editor-tool-select';
export const TOUR_DRAW_TOOL_SELECTOR = '#editor-tool-pen';

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

export const TOUR_SAMPLE_TEXT_CUTOUT: TourCutout = {
    id: 'sample-text',
    padding: 28,
    radius: 12,
    resolve: getTextRunCutout
};

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

function getSelectedGlyphOutlineRect(): {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
} | null {
    const canvas = window.glyphCanvas;
    if (!canvas?.outlineEditor?.active) {
        return null;
    }
    const index = canvas.textRunEditor?.selectedGlyphIndex;
    if (typeof index !== 'number' || index < 0) {
        return null;
    }
    const bounds = canvas.glyphBounds?.[index];
    if (
        !bounds ||
        !Number.isFinite(bounds.x1) ||
        !Number.isFinite(bounds.x2) ||
        !Number.isFinite(bounds.y1) ||
        !Number.isFinite(bounds.y2)
    ) {
        return null;
    }
    return {
        minX: bounds.x + bounds.x1,
        maxX: bounds.x + bounds.x2,
        minY: bounds.y + bounds.y1,
        maxY: bounds.y + bounds.y2
    };
}

/** Outline bounds in edit mode; text-run `m` before that. Follows interpolation. */
function getCurrentGlyphOutlineCutout(): TourCutoutRect | null {
    const outline = getSelectedGlyphOutlineRect();
    if (outline) {
        return fontRectToCutout(
            outline.minX,
            outline.maxX,
            outline.minY,
            outline.maxY
        );
    }
    return getTextRunLetterCutout('m');
}

function getDrawAreaAboveGlyphCutout(): TourCutoutRect | null {
    const outline = getSelectedGlyphOutlineRect();
    if (outline) {
        const height = Math.max(8, outline.maxY - outline.minY);
        return fontRectToCutout(
            outline.minX,
            outline.maxX,
            outline.maxY,
            outline.maxY + height
        );
    }
    const metrics = getTextRunGlyphMetrics('m');
    if (!metrics) {
        return null;
    }
    const height = Math.max(8, metrics.maxY - metrics.minY);
    return fontRectToCutout(
        metrics.minX,
        metrics.maxX,
        metrics.maxY,
        metrics.maxY + height
    );
}

function getLayersListCutout(): TourCutoutRect | null {
    return (
        getElementCutout(TOUR_LAYERS_LIST_SELECTOR) ||
        getElementCutout('#glyph-properties-section .editor-layers-list')
    );
}

function letterMCutout(interactive: boolean): TourCutout {
    return {
        id: 'letter-m',
        padding: 20,
        hitPadding: interactive ? 0 : undefined,
        radius: 12,
        interactive,
        resolve: getCurrentGlyphOutlineCutout
    };
}

async function prepareLayersListSlide(): Promise<void> {
    await waitForElement(
        `${TOUR_LAYERS_LIST_SELECTOR}, #glyph-properties-section .editor-layers-list`
    );
    const list =
        document.querySelector(TOUR_LAYERS_LIST_SELECTOR) ||
        document.querySelector('#glyph-properties-section .editor-layers-list');
    if (list instanceof HTMLElement) {
        scrollTourTargetIntoView(list);
    }
    await delay(50);
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
            TOUR_SAMPLE_TEXT_CUTOUT,
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
        advanceDelayMs: 1000,
        cutouts: [letterMCutout(true)]
    },
    'cant-edit-interpolations': {
        id: 'cant-edit-interpolations',
        tooltip: {
            title: 'Can’t Edit Interpolations',
            body: tourBody(
                'Gray nodes mean that this is an **interpolation**, not a master layer, so you **can’t edit** this here. You need to return to a real master-bound layer to edit.',
                'Choose any layer from the layer list.'
            ),
            targetCutoutId: 'letter-m',
            placement: 'right'
        },
        prepare: prepareLayersListSlide,
        advanceOnClick: `${TOUR_LAYER_ITEM_SELECTOR}, #glyph-properties-section .editor-layers-list .editor-layer-item`,
        previewTextBeforeApply: false,
        advanceDelayMs: 500,
        cutouts: [
            letterMCutout(false),
            {
                id: 'layers-list',
                padding: 12,
                radius: 10,
                interactive: true,
                resolve: getLayersListCutout
            }
        ]
    },
    'select-tool': {
        id: 'select-tool',
        tooltip: {
            title: 'Select Tool',
            body: tourBody(
                'The Select tool (shortcut **v**) is on by default when you enter.',
                'Select a node by mouse and move it a bit.'
            ),
            targetCutoutId: 'select-tool',
            placement: 'bottom'
        },
        allowedKeys: ['v'],
        advanceOnNodeDrag: true,
        advanceDelayMs: 500,
        cutouts: [
            letterMCutout(true),
            {
                id: 'select-tool',
                padding: 14,
                radius: 10,
                interactive: true,
                resolve: () => getElementCutout(TOUR_SELECT_TOOL_SELECTOR)
            }
        ]
    },
    'draw-tool': {
        id: 'draw-tool',
        tooltip: {
            title: 'Draw Tool',
            body: tourBody(
                'Select the Draw tool (shortcut **p**) and draw a closed triangle into the marked area.',
                'Close the shape by ending the drawing on the first node.'
            ),
            targetCutoutId: 'draw-area',
            placement: 'right'
        },
        allowedKeys: ['p', 'v'],
        cutouts: [
            {
                id: 'draw-area',
                padding: 16,
                radius: 12,
                interactive: true,
                resolve: getDrawAreaAboveGlyphCutout
            },
            {
                id: 'draw-tool',
                padding: 14,
                radius: 10,
                interactive: true,
                resolve: () => getElementCutout(TOUR_DRAW_TOOL_SELECTOR)
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
    'enter-edit-mode',
    'cant-edit-interpolations',
    'select-tool',
    'draw-tool'
];

export function getTourSlide(id: string): TourSlide | null {
    return TOUR_SLIDES[id] || null;
}

export function getTourSlideByIndex(index: number): TourSlide | null {
    const id = TOUR_SLIDE_ORDER[index];
    return id ? getTourSlide(id) : null;
}
