/**
 * Spotlight overlay: dimmed mask with cutouts, Tippy callout, and input lock.
 *
 * Visual holes are an SVG luminance mask. Hit-testing uses HTML rectangles
 * that cover the viewport minus interactive cutouts (hit padding may be
 * tighter than the visual hole). Keyboard: capture-phase lock
 * (Cmd/Ctrl+Shift+R reload is allowed); view shortcuts are blocked separately.
 */

import tippy, { type Instance as TippyInstance } from 'tippy.js';
import 'tippy.js/dist/tippy.css';
import { Logger } from './logger';
import {
    TOUR_SAMPLE_TEXT_CUTOUT,
    type TourCutout,
    type TourCutoutRect,
    type TourSlide,
    type TourTooltip
} from './tour-slides';

const console = new Logger('Tour');

const OVERLAY_Z_INDEX = 13000;
export const TOUR_FADE_MS = 500;
const FADE_MS = TOUR_FADE_MS;
/** After the text-buffer spotlight fades in, pause so the user can refocus. */
export const TOUR_POST_FADE_BEFORE_APPLY_MS = 500;
/** Watch the applied click (feature / master) before the next slide. */
export const TOUR_AFTER_APPLY_MS = 1500;
/** Native slider / glyph reaction: short hold before the next slide. */
export const TOUR_AFTER_SLIDER_MS = 500;
const DEFAULT_CUTOUT_PADDING = 24;

type FinishReactionOptions = {
    previewTextBeforeApply?: boolean;
    afterApplyMs?: number;
};

type SpotlightHost = {
    root: HTMLElement | null;
    svg: SVGSVGElement | null;
    maskBg: SVGRectElement | null;
    dimmerRect: SVGRectElement | null;
    maskPath: SVGPathElement | null;
    hitLayer: HTMLElement | null;
    tooltip: HTMLElement | null;
    tippy: TippyInstance | null;
    slide: TourSlide | null;
    visible: boolean;
    advancing: boolean;
    onContinue: (() => void) | null;
    resizeObserver: ResizeObserver | null;
    listenersBound: boolean;
    slideUnbind: (() => void) | null;
};

function getHost(): SpotlightHost {
    const holder = window as Window & { __tourSpotlightHost?: SpotlightHost };
    if (!holder.__tourSpotlightHost) {
        holder.__tourSpotlightHost = {
            root: null,
            svg: null,
            maskBg: null,
            dimmerRect: null,
            maskPath: null,
            hitLayer: null,
            tooltip: null,
            tippy: null,
            slide: null,
            visible: false,
            advancing: false,
            onContinue: null,
            resizeObserver: null,
            listenersBound: false,
            slideUnbind: null
        };
    }
    return holder.__tourSpotlightHost;
}

let viewShortcutsBlocked = false;
let allowedViewShortcutKeys: string[] = [];

export function isTourBlockingViewShortcuts(): boolean {
    return viewShortcutsBlocked;
}

export function isViewShortcutAllowedDuringTour(key: string): boolean {
    if (!viewShortcutsBlocked) {
        return true;
    }
    return allowedViewShortcutKeys.includes(key);
}

function setViewShortcutLock(slide: TourSlide | null): void {
    viewShortcutsBlocked = !!slide;
    allowedViewShortcutKeys = slide?.allowedViewShortcutKeys || [];
}

function roundedRectPath(
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number
): string {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    if (r <= 0) {
        return `M${x},${y} H${x + width} V${y + height} H${x} Z`;
    }
    return [
        `M${x + r},${y}`,
        `H${x + width - r}`,
        `A${r},${r} 0 0 1 ${x + width},${y + r}`,
        `V${y + height - r}`,
        `A${r},${r} 0 0 1 ${x + width - r},${y + height}`,
        `H${x + r}`,
        `A${r},${r} 0 0 1 ${x},${y + height - r}`,
        `V${y + r}`,
        `A${r},${r} 0 0 1 ${x + r},${y} Z`
    ].join(' ');
}

function padRect(rect: TourCutoutRect, padding: number): TourCutoutRect {
    return {
        left: rect.left - padding,
        top: rect.top - padding,
        width: rect.width + padding * 2,
        height: rect.height + padding * 2
    };
}

function visualRectForCutout(
    cutout: TourSlide['cutouts'][number],
    raw: TourCutoutRect
): TourCutoutRect {
    return padRect(raw, cutout.padding ?? DEFAULT_CUTOUT_PADDING);
}

function hitRectForCutout(
    cutout: TourSlide['cutouts'][number],
    raw?: TourCutoutRect | null
): TourCutoutRect | null {
    const source = raw ?? cutout.resolve();
    if (!source) {
        return null;
    }
    return padRect(
        source,
        cutout.hitPadding ?? cutout.padding ?? DEFAULT_CUTOUT_PADDING
    );
}

function clientPointInRect(
    x: number,
    y: number,
    rect: TourCutoutRect
): boolean {
    return (
        x >= rect.left &&
        x <= rect.left + rect.width &&
        y >= rect.top &&
        y <= rect.top + rect.height
    );
}

function subtractRect(
    base: TourCutoutRect,
    hole: TourCutoutRect
): TourCutoutRect[] {
    const a = {
        left: base.left,
        top: base.top,
        right: base.left + base.width,
        bottom: base.top + base.height
    };
    const b = {
        left: hole.left,
        top: hole.top,
        right: hole.left + hole.width,
        bottom: hole.top + hole.height
    };
    const ix = Math.max(a.left, b.left);
    const iy = Math.max(a.top, b.top);
    const ir = Math.min(a.right, b.right);
    const ib = Math.min(a.bottom, b.bottom);
    if (ix >= ir || iy >= ib) {
        return [base];
    }
    const pieces: TourCutoutRect[] = [];
    if (a.top < iy) {
        pieces.push({
            left: a.left,
            top: a.top,
            width: a.right - a.left,
            height: iy - a.top
        });
    }
    if (ib < a.bottom) {
        pieces.push({
            left: a.left,
            top: ib,
            width: a.right - a.left,
            height: a.bottom - ib
        });
    }
    if (a.left < ix) {
        pieces.push({
            left: a.left,
            top: iy,
            width: ix - a.left,
            height: ib - iy
        });
    }
    if (ir < a.right) {
        pieces.push({
            left: ir,
            top: iy,
            width: a.right - ir,
            height: ib - iy
        });
    }
    return pieces.filter((piece) => piece.width > 0 && piece.height > 0);
}

function coverViewportMinusHoles(
    width: number,
    height: number,
    holes: TourCutoutRect[]
): TourCutoutRect[] {
    let pieces: TourCutoutRect[] = [{ left: 0, top: 0, width, height }];
    for (const hole of holes) {
        pieces = pieces.flatMap((piece) => subtractRect(piece, hole));
    }
    return pieces;
}

function appendInlineMarkup(parent: HTMLElement, text: string): void {
    const parts = text.split(/\*\*(.+?)\*\*/);
    parts.forEach((part, index) => {
        if (index % 2 === 1) {
            const strong = document.createElement('strong');
            strong.textContent = part;
            parent.append(strong);
            return;
        }
        if (part) {
            parent.append(document.createTextNode(part));
        }
    });
}

/** Inline markup: `**bold**` and `_italic_`. Italic wraps the action sentence. */
function renderInlineEmphasis(text: string): HTMLElement {
    const paragraph = document.createElement('p');
    const parts = text.split(/_(.+?)_/);
    parts.forEach((part, index) => {
        if (!part) {
            return;
        }
        if (index % 2 === 1) {
            const em = document.createElement('em');
            appendInlineMarkup(em, part);
            paragraph.append(em);
            return;
        }
        appendInlineMarkup(paragraph, part);
    });
    return paragraph;
}

function appendTooltipBody(container: HTMLElement, body: string): void {
    const blocks = body
        .split(/\n\n+/)
        .map((block) => block.trim())
        .filter(Boolean);
    for (const block of blocks) {
        container.append(renderInlineEmphasis(block));
    }
}

function resolveAdvanceClickTarget(
    event: Event,
    selector: string
): HTMLElement | null {
    const eventTarget = event.target;
    if (!(eventTarget instanceof Element)) {
        return null;
    }
    const direct = eventTarget.closest(selector);
    if (direct instanceof HTMLElement) {
        return direct;
    }
    const row = eventTarget.closest('.editor-feature-row');
    const nested = row?.querySelector(selector);
    if (nested instanceof HTMLElement && row?.contains(eventTarget)) {
        return nested;
    }
    return null;
}

function unbindSlideInteraction(): void {
    const host = getHost();
    host.slideUnbind?.();
    host.slideUnbind = null;
}

function setCutoutsVisible(visible: boolean): void {
    getHost().root?.classList.toggle('is-cutouts-visible', visible);
}

function setTooltipVisible(visible: boolean): void {
    getHost().root?.classList.toggle('is-tooltip-visible', visible);
}

async function fadeOutCutoutsAndTooltip(): Promise<void> {
    setCutoutsVisible(false);
    setTooltipVisible(false);
    await wait(FADE_MS);
}

async function fadeInTextBufferSpotlight(): Promise<void> {
    const host = getHost();
    if (!host.slide) {
        return;
    }
    paintSpotlight(host.slide, {
        punchHits: false,
        cutouts: [TOUR_SAMPLE_TEXT_CUTOUT],
        showTooltip: false
    });
    await wait(0);
    setCutoutsVisible(true);
    await wait(FADE_MS);
}

function restoreSlideChrome(slide: TourSlide): void {
    paintSpotlight(slide);
    setCutoutsVisible(true);
    setTooltipVisible(true);
    bindSlideInteraction(slide);
}

async function finishWithReaction(
    applyReaction?: () => boolean | void | Promise<boolean | void>,
    options?: FinishReactionOptions
): Promise<void> {
    const host = getHost();
    if (!host.visible || host.advancing) {
        return;
    }
    host.advancing = true;
    unbindSlideInteraction();
    try {
        if (options?.previewTextBeforeApply) {
            await fadeOutCutoutsAndTooltip();
            if (!host.visible) {
                return;
            }
            await fadeInTextBufferSpotlight();
            if (!host.visible) {
                return;
            }
            await wait(TOUR_POST_FADE_BEFORE_APPLY_MS);
            if (!host.visible) {
                return;
            }
        }
        const applied = await applyReaction?.();
        if (applied === false) {
            if (host.visible && host.slide) {
                restoreSlideChrome(host.slide);
            }
            return;
        }
        await wait(options?.afterApplyMs ?? TOUR_AFTER_APPLY_MS);
        if (!host.visible) {
            return;
        }
        host.onContinue?.();
    } finally {
        host.advancing = false;
    }
}

function bindSlideInteraction(slide: TourSlide): void {
    unbindSlideInteraction();
    const host = getHost();
    const cleanups: Array<() => void> = [];

    const selector = slide.advanceOnClick;
    if (selector) {
        let ignoreClick = false;
        const handler = (event: Event) => {
            if (!host.visible || host.slide !== slide || host.advancing) {
                return;
            }
            if (ignoreClick) {
                return;
            }
            const button = resolveAdvanceClickTarget(event, selector);
            if (!button) {
                return;
            }
            if (button instanceof HTMLButtonElement && button.disabled) {
                return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            void finishWithReaction(
                async () => {
                    ignoreClick = true;
                    button.click();
                    ignoreClick = false;
                    if (
                        slide.advanceOnClickRequireEnabled &&
                        !button.classList.contains('enabled')
                    ) {
                        return false;
                    }
                    return true;
                },
                {
                    previewTextBeforeApply:
                        slide.previewTextBeforeApply !== false,
                    afterApplyMs: slide.advanceDelayMs ?? TOUR_AFTER_APPLY_MS
                }
            );
        };
        document.addEventListener('click', handler, true);
        cleanups.push(() => {
            document.removeEventListener('click', handler, true);
        });
    }

    if (slide.axisClamp) {
        const clamp = slide.axisClamp;
        let ceilingLatched = false;
        const handler = (event: Event) => {
            if (!host.visible || host.slide !== slide) {
                return;
            }
            const slider = event.target;
            if (!(slider instanceof HTMLInputElement)) {
                return;
            }
            if (!slider.matches(clamp.selector)) {
                return;
            }
            let value = parseFloat(slider.value);
            if (!Number.isFinite(value)) {
                return;
            }
            if (value <= clamp.latchMaxWhenAtOrBelow) {
                ceilingLatched = true;
            }
            if (value < clamp.min) {
                value = clamp.min;
            }
            if (ceilingLatched && value > clamp.max) {
                value = clamp.max;
            }
            if (slider.value !== String(value)) {
                slider.value = String(value);
            }
        };
        document.addEventListener('input', handler, true);
        cleanups.push(() => {
            document.removeEventListener('input', handler, true);
        });
    }

    if (slide.advanceOnSlider) {
        const config = slide.advanceOnSlider;
        let advanced = false;
        const maybeAdvance = (event: Event) => {
            if (advanced || !host.visible || host.slide !== slide) {
                return;
            }
            const eventTarget = event.target;
            if (!(eventTarget instanceof Element)) {
                return;
            }
            const slider = eventTarget.closest(config.selector);
            if (!(slider instanceof HTMLInputElement)) {
                return;
            }
            const value = parseFloat(slider.value);
            if (value >= config.min && value <= config.max) {
                advanced = true;
                void finishWithReaction(undefined, {
                    afterApplyMs: TOUR_AFTER_SLIDER_MS
                });
            }
        };
        document.addEventListener('change', maybeAdvance, false);
        document.addEventListener('pointerup', maybeAdvance, false);
        cleanups.push(() => {
            document.removeEventListener('change', maybeAdvance, false);
            document.removeEventListener('pointerup', maybeAdvance, false);
        });
    }

    if (slide.advanceOnGlyphDoubleClick) {
        const letterCutout = slide.cutouts.find(
            (cutout) => cutout.id === slide.tooltip.targetCutoutId
        );
        let advanced = false;
        const handler = (event: MouseEvent) => {
            if (!host.visible || host.slide !== slide) {
                return;
            }
            const hitRect = letterCutout
                ? hitRectForCutout(letterCutout)
                : null;
            if (
                !hitRect ||
                !clientPointInRect(event.clientX, event.clientY, hitRect)
            ) {
                event.preventDefault();
                event.stopImmediatePropagation();
                return;
            }
            if (advanced) {
                return;
            }
            advanced = true;
            void finishWithReaction(undefined, {
                afterApplyMs: slide.advanceDelayMs ?? TOUR_AFTER_APPLY_MS
            });
        };
        document.addEventListener('dblclick', handler, true);
        cleanups.push(() => {
            document.removeEventListener('dblclick', handler, true);
        });
    }

    if (slide.advanceOnNodeDrag) {
        const letterCutout = slide.cutouts.find(
            (cutout) => cutout.id === 'letter-m'
        );
        let origin: { x: number; y: number } | null = null;
        let moved = false;
        let advanced = false;
        const onPointerDown = (event: MouseEvent) => {
            if (!host.visible || host.slide !== slide || host.advancing) {
                return;
            }
            const hitRect = letterCutout
                ? hitRectForCutout(letterCutout)
                : null;
            if (
                !hitRect ||
                !clientPointInRect(event.clientX, event.clientY, hitRect)
            ) {
                origin = null;
                moved = false;
                return;
            }
            origin = { x: event.clientX, y: event.clientY };
            moved = false;
        };
        const onPointerMove = (event: MouseEvent) => {
            if (!origin || advanced) {
                return;
            }
            if (
                Math.hypot(
                    event.clientX - origin.x,
                    event.clientY - origin.y
                ) >= 6
            ) {
                moved = true;
            }
        };
        const onPointerUp = () => {
            if (advanced || !moved) {
                origin = null;
                moved = false;
                return;
            }
            advanced = true;
            origin = null;
            moved = false;
            void finishWithReaction(undefined, {
                afterApplyMs: slide.advanceDelayMs ?? TOUR_AFTER_SLIDER_MS
            });
        };
        document.addEventListener('mousedown', onPointerDown, true);
        document.addEventListener('mousemove', onPointerMove, true);
        document.addEventListener('mouseup', onPointerUp, true);
        cleanups.push(() => {
            document.removeEventListener('mousedown', onPointerDown, true);
            document.removeEventListener('mousemove', onPointerMove, true);
            document.removeEventListener('mouseup', onPointerUp, true);
        });
    }

    host.slideUnbind = () => {
        for (const cleanup of cleanups) {
            cleanup();
        }
    };
}

function cutoutToClientRect(rect: TourCutoutRect): DOMRect {
    if (
        typeof DOMRect !== 'undefined' &&
        typeof DOMRect.fromRect === 'function'
    ) {
        return DOMRect.fromRect({
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height
        });
    }
    const left = rect.left;
    const top = rect.top;
    const width = rect.width;
    const height = rect.height;
    return {
        x: left,
        y: top,
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        toJSON() {
            return this;
        }
    } as DOMRect;
}

function positionTooltip(
    target: TourCutoutRect,
    placement: TourTooltip['placement']
): void {
    const host = getHost();
    if (!host.tippy) {
        return;
    }
    host.tippy.setProps({
        getReferenceClientRect: () => cutoutToClientRect(target),
        placement: placement || 'bottom'
    });
    if (!host.tippy.state.isVisible) {
        host.tippy.show();
    } else {
        host.tippy.popperInstance?.update();
    }
}

function resolvedCutouts(cutouts: TourCutout[]): Array<{
    cutout: TourCutout;
    rect: TourCutoutRect;
    hitRect: TourCutoutRect;
}> {
    const resolved: Array<{
        cutout: TourCutout;
        rect: TourCutoutRect;
        hitRect: TourCutoutRect;
    }> = [];
    for (const cutout of cutouts) {
        const raw = cutout.resolve();
        if (!raw) {
            continue;
        }
        const hitRect = hitRectForCutout(cutout, raw);
        if (!hitRect) {
            continue;
        }
        resolved.push({
            cutout,
            rect: visualRectForCutout(cutout, raw),
            hitRect
        });
    }
    return resolved;
}

function paintSpotlight(
    slide: TourSlide,
    options?: {
        punchHits?: boolean;
        cutouts?: TourCutout[];
        showTooltip?: boolean;
    }
): void {
    const host = getHost();
    if (
        !host.svg ||
        !host.maskPath ||
        !host.maskBg ||
        !host.dimmerRect ||
        !host.hitLayer ||
        !host.tippy
    ) {
        return;
    }

    const width = window.innerWidth;
    const height = window.innerHeight;
    host.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    host.svg.setAttribute('width', String(width));
    host.svg.setAttribute('height', String(height));
    host.maskBg.setAttribute('width', String(width));
    host.maskBg.setAttribute('height', String(height));
    host.dimmerRect.setAttribute('width', String(width));
    host.dimmerRect.setAttribute('height', String(height));

    const holes = resolvedCutouts(options?.cutouts ?? slide.cutouts);
    const holePaths = holes
        .map(({ cutout, rect }) =>
            roundedRectPath(
                rect.left,
                rect.top,
                rect.width,
                rect.height,
                cutout.radius ?? 8
            )
        )
        .join(' ');
    host.maskPath.setAttribute('d', holePaths);

    const punchHits = options?.punchHits !== false;
    const interactiveHoles = punchHits
        ? holes
              .filter(({ cutout }) => cutout.interactive)
              .map(({ hitRect }) => hitRect)
        : [];
    host.hitLayer.replaceChildren();
    for (const piece of coverViewportMinusHoles(
        width,
        height,
        interactiveHoles
    )) {
        const el = document.createElement('div');
        el.className = 'tour-spotlight-hit-piece';
        el.style.left = `${piece.left}px`;
        el.style.top = `${piece.top}px`;
        el.style.width = `${piece.width}px`;
        el.style.height = `${piece.height}px`;
        host.hitLayer.append(el);
    }

    if (options?.showTooltip === false) {
        host.tippy.hide();
        return;
    }

    const target = holes.find(
        (entry) => entry.cutout.id === slide.tooltip.targetCutoutId
    );
    if (target) {
        positionTooltip(target.rect, slide.tooltip.placement);
    } else if (!host.tippy.state.isVisible) {
        host.tippy.show();
    }
}

function isBrowserReloadShortcut(event: KeyboardEvent): boolean {
    const cmdOrCtrl = event.metaKey || event.ctrlKey;
    return (
        cmdOrCtrl && event.shiftKey && !event.altKey && event.code === 'KeyR'
    );
}

function onTourKeyDown(event: KeyboardEvent): void {
    const host = getHost();
    if (!host.visible) {
        return;
    }
    if (isBrowserReloadShortcut(event)) {
        return;
    }
    const allowedKey = host.slide?.allowedKeys?.includes(
        event.key.toLowerCase()
    );
    if (allowedKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
        return;
    }
    const target = event.target as HTMLElement | null;
    const onContinue = target?.closest?.('[data-tour-action="continue"]');
    if (onContinue && (event.key === 'Enter' || event.key === ' ')) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
}

function bindSpotlightChrome(): void {
    const host = getHost();
    if (host.root) {
        return;
    }

    const root = document.createElement('div');
    root.className = 'tour-spotlight-root';
    root.style.zIndex = String(OVERLAY_Z_INDEX);

    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.classList.add('tour-spotlight-svg');
    svg.setAttribute('aria-hidden', 'true');

    const defs = document.createElementNS(svgNs, 'defs');
    const mask = document.createElementNS(svgNs, 'mask');
    mask.id = 'tour-cutout-mask';
    mask.setAttribute('maskUnits', 'userSpaceOnUse');
    mask.setAttribute('maskContentUnits', 'userSpaceOnUse');
    mask.setAttribute('mask-type', 'luminance');

    const maskBg = document.createElementNS(svgNs, 'rect');
    maskBg.classList.add('tour-spotlight-mask-bg');
    maskBg.setAttribute('x', '0');
    maskBg.setAttribute('y', '0');
    maskBg.setAttribute('fill', '#fff');

    const path = document.createElementNS(svgNs, 'path');
    path.classList.add('tour-spotlight-holes');
    path.setAttribute('fill', '#000');
    mask.append(maskBg, path);
    defs.append(mask);

    const dimmerRect = document.createElementNS(svgNs, 'rect');
    dimmerRect.classList.add('tour-spotlight-dimmer-rect');
    dimmerRect.setAttribute('x', '0');
    dimmerRect.setAttribute('y', '0');
    dimmerRect.setAttribute('mask', 'url(#tour-cutout-mask)');
    svg.append(defs, dimmerRect);

    const hitLayer = document.createElement('div');
    hitLayer.className = 'tour-spotlight-hit';

    const anchor = document.createElement('div');
    anchor.className = 'tour-tooltip-anchor';

    const tooltip = document.createElement('div');
    tooltip.className = 'tour-tooltip';
    tooltip.setAttribute('role', 'dialog');
    tooltip.setAttribute('aria-modal', 'true');

    root.append(svg, hitLayer, anchor);
    document.body.append(root);

    host.root = root;
    host.svg = svg;
    host.maskBg = maskBg;
    host.dimmerRect = dimmerRect;
    host.maskPath = path;
    host.hitLayer = hitLayer;
    host.tooltip = tooltip;
    host.tippy = tippy(anchor, {
        content: tooltip,
        interactive: true,
        trigger: 'manual',
        hideOnClick: false,
        theme: 'tour',
        arrow: true,
        animation: false,
        maxWidth: 340,
        offset: [0, 16],
        zIndex: OVERLAY_Z_INDEX + 1,
        appendTo: () => root,
        popperOptions: {
            strategy: 'fixed'
        }
    });
}

function fillTooltip(slide: TourSlide): void {
    const host = getHost();
    if (!host.tooltip) {
        return;
    }
    const titleId = 'tour-tooltip-title';
    host.tooltip.setAttribute('aria-labelledby', titleId);
    host.tooltip.replaceChildren();

    const title = document.createElement('h3');
    title.id = titleId;
    title.textContent = slide.tooltip.title;

    host.tooltip.append(title);
    appendTooltipBody(host.tooltip, slide.tooltip.body);

    if (slide.tooltip.continueLabel) {
        const actions = document.createElement('div');
        actions.className = 'tour-tooltip-actions';
        const continueBtn = document.createElement('button');
        continueBtn.type = 'button';
        continueBtn.className = 'dialog-button dialog-button-primary';
        continueBtn.dataset.tourAction = 'continue';
        continueBtn.textContent = slide.tooltip.continueLabel;
        continueBtn.addEventListener('click', () => {
            host.onContinue?.();
        });
        actions.append(continueBtn);
        host.tooltip.append(actions);
    }
}

export async function showTourSlide(
    slide: TourSlide,
    onContinue: () => void
): Promise<void> {
    bindSpotlightChrome();
    const host = getHost();
    host.slide = slide;
    host.onContinue = onContinue;
    host.visible = true;
    host.advancing = false;
    setViewShortcutLock(slide);
    fillTooltip(slide);
    await slide.prepare?.();
    paintSpotlight(slide, { punchHits: false });

    if (!host.listenersBound) {
        document.addEventListener('keydown', onTourKeyDown, true);
        window.addEventListener('resize', onTourGeometryChange);
        window.addEventListener('glyphCanvasRendered', onTourGeometryChange);
        window.addEventListener('editorModeChanged', onTourGeometryChange);
        host.listenersBound = true;
    }
    if (!host.resizeObserver && typeof ResizeObserver !== 'undefined') {
        host.resizeObserver = new ResizeObserver(() => {
            if (host.slide && host.visible && !host.advancing) {
                paintSpotlight(host.slide);
            }
        });
        host.resizeObserver.observe(document.documentElement);
    }

    host.root?.classList.add('is-visible');
    requestAnimationFrame(() => {
        if (host.slide) {
            paintSpotlight(host.slide, { punchHits: false });
        }
        host.root?.classList.add('is-cutouts-visible');
        host.root?.classList.add('is-tooltip-visible');
        const continueBtn = host.tooltip?.querySelector(
            '[data-tour-action="continue"]'
        ) as HTMLElement | null;
        continueBtn?.focus();
    });
    await wait(FADE_MS);
    if (host.slide !== slide || !host.visible) {
        return;
    }
    paintSpotlight(slide, { punchHits: true });
    bindSlideInteraction(slide);
}

let geometryFrame = 0;

function onTourGeometryChange(): void {
    if (geometryFrame) {
        return;
    }
    geometryFrame = window.requestAnimationFrame(() => {
        geometryFrame = 0;
        const host = getHost();
        if (host.slide && host.visible && !host.advancing) {
            paintSpotlight(host.slide);
        }
    });
}

export async function transitionTourSlide(
    slide: TourSlide,
    onContinue: () => void
): Promise<void> {
    unbindSlideInteraction();
    setCutoutsVisible(false);
    setTooltipVisible(false);
    await wait(FADE_MS);
    await showTourSlide(slide, onContinue);
}

export function hideTourSpotlight(): void {
    const host = getHost();
    host.visible = false;
    host.slide = null;
    host.onContinue = null;
    host.advancing = false;
    unbindSlideInteraction();
    setViewShortcutLock(null);
    document.removeEventListener('keydown', onTourKeyDown, true);
    window.removeEventListener('resize', onTourGeometryChange);
    window.removeEventListener('glyphCanvasRendered', onTourGeometryChange);
    window.removeEventListener('editorModeChanged', onTourGeometryChange);
    host.listenersBound = false;
    host.resizeObserver?.disconnect();
    host.resizeObserver = null;
    host.root?.classList.remove('is-cutouts-visible');
    host.root?.classList.remove('is-tooltip-visible');
    host.root?.classList.remove('is-visible');
    host.tippy?.hide();
    window.setTimeout(() => {
        host.tippy?.destroy();
        host.tippy = null;
        host.root?.remove();
        host.root = null;
        host.svg = null;
        host.maskBg = null;
        host.dimmerRect = null;
        host.maskPath = null;
        host.hitLayer = null;
        host.tooltip = null;
    }, FADE_MS);
}

export function wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
        window.setTimeout(resolve, ms);
    });
}
