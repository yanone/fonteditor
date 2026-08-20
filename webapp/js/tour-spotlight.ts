/**
 * Spotlight overlay: dimmed mask with cutouts, Tippy callout, and input lock.
 *
 * Clicks: the SVG evenodd mask lets pointer events through holes. Non-interactive
 * holes get blocker rects so only the tooltip (and later opt-in holes) receive
 * clicks. Keyboard: capture-phase lock; view shortcuts are blocked separately.
 */

import tippy, { type Instance as TippyInstance } from 'tippy.js';
import 'tippy.js/dist/tippy.css';
import { Logger } from './logger';
import type { TourCutoutRect, TourSlide, TourTooltip } from './tour-slides';

const console = new Logger('Tour');

const OVERLAY_Z_INDEX = 13000;
const FADE_MS = 280;
const DEFAULT_CUTOUT_PADDING = 24;

type SpotlightHost = {
    root: HTMLElement | null;
    svg: SVGSVGElement | null;
    maskPath: SVGPathElement | null;
    blockers: HTMLElement | null;
    tooltip: HTMLElement | null;
    tippy: TippyInstance | null;
    slide: TourSlide | null;
    visible: boolean;
    onContinue: (() => void) | null;
    resizeObserver: ResizeObserver | null;
    listenersBound: boolean;
};

function getHost(): SpotlightHost {
    const holder = window as Window & { __tourSpotlightHost?: SpotlightHost };
    if (!holder.__tourSpotlightHost) {
        holder.__tourSpotlightHost = {
            root: null,
            svg: null,
            maskPath: null,
            blockers: null,
            tooltip: null,
            tippy: null,
            slide: null,
            visible: false,
            onContinue: null,
            resizeObserver: null,
            listenersBound: false
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

function renderInlineEmphasis(text: string): HTMLElement {
    const paragraph = document.createElement('p');
    const parts = text.split(/\*\*(.+?)\*\*/);
    parts.forEach((part, index) => {
        if (index % 2 === 1) {
            const strong = document.createElement('strong');
            strong.textContent = part;
            paragraph.append(strong);
            return;
        }
        if (part) {
            paragraph.append(document.createTextNode(part));
        }
    });
    return paragraph;
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

function resolvedCutouts(
    slide: TourSlide
): Array<{ cutout: TourSlide['cutouts'][number]; rect: TourCutoutRect }> {
    const resolved: Array<{
        cutout: TourSlide['cutouts'][number];
        rect: TourCutoutRect;
    }> = [];
    for (const cutout of slide.cutouts) {
        const raw = cutout.resolve();
        if (!raw) {
            continue;
        }
        resolved.push({
            cutout,
            rect: padRect(raw, cutout.padding ?? DEFAULT_CUTOUT_PADDING)
        });
    }
    return resolved;
}

function paintSpotlight(slide: TourSlide): void {
    const host = getHost();
    if (!host.svg || !host.maskPath || !host.blockers || !host.tippy) {
        return;
    }

    const width = window.innerWidth;
    const height = window.innerHeight;
    host.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    host.svg.setAttribute('width', String(width));
    host.svg.setAttribute('height', String(height));

    const holes = resolvedCutouts(slide);
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
    host.maskPath.setAttribute(
        'd',
        `M0,0 H${width} V${height} H0 Z ${holePaths}`
    );

    host.blockers.replaceChildren();
    for (const { cutout, rect } of holes) {
        if (cutout.interactive) {
            continue;
        }
        const blocker = document.createElement('div');
        blocker.className = 'tour-spotlight-hole-blocker';
        blocker.style.left = `${rect.left}px`;
        blocker.style.top = `${rect.top}px`;
        blocker.style.width = `${rect.width}px`;
        blocker.style.height = `${rect.height}px`;
        host.blockers.append(blocker);
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

function onTourKeyDown(event: KeyboardEvent): void {
    const host = getHost();
    if (!host.visible) {
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

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('tour-spotlight-svg');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.classList.add('tour-spotlight-mask-path');
    path.setAttribute('fill-rule', 'evenodd');
    svg.append(path);

    const blockers = document.createElement('div');
    blockers.className = 'tour-spotlight-blockers';

    const anchor = document.createElement('div');
    anchor.className = 'tour-tooltip-anchor';

    const tooltip = document.createElement('div');
    tooltip.className = 'tour-tooltip';
    tooltip.setAttribute('role', 'dialog');
    tooltip.setAttribute('aria-modal', 'true');

    root.append(svg, blockers, anchor);
    document.body.append(root);

    host.root = root;
    host.svg = svg;
    host.maskPath = path;
    host.blockers = blockers;
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

    const body = renderInlineEmphasis(slide.tooltip.body);

    const actions = document.createElement('div');
    actions.className = 'tour-tooltip-actions';
    const continueBtn = document.createElement('button');
    continueBtn.type = 'button';
    continueBtn.className = 'dialog-button dialog-button-primary';
    continueBtn.dataset.tourAction = 'continue';
    continueBtn.textContent = slide.tooltip.continueLabel || 'Continue';
    continueBtn.addEventListener('click', () => {
        host.onContinue?.();
    });
    actions.append(continueBtn);

    host.tooltip.append(title, body, actions);
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
    setViewShortcutLock(slide);
    fillTooltip(slide);
    await slide.prepare?.();
    paintSpotlight(slide);

    if (!host.listenersBound) {
        document.addEventListener('keydown', onTourKeyDown, true);
        window.addEventListener('resize', onWindowResize);
        host.listenersBound = true;
    }
    if (!host.resizeObserver && typeof ResizeObserver !== 'undefined') {
        host.resizeObserver = new ResizeObserver(() => {
            if (host.slide && host.visible) {
                paintSpotlight(host.slide);
            }
        });
        host.resizeObserver.observe(document.documentElement);
    }

    requestAnimationFrame(() => {
        if (host.slide) {
            paintSpotlight(host.slide);
        }
        host.root?.classList.add('is-visible');
        const continueBtn = host.tooltip?.querySelector(
            '[data-tour-action="continue"]'
        ) as HTMLElement | null;
        continueBtn?.focus();
    });
}

function onWindowResize(): void {
    const host = getHost();
    if (host.slide && host.visible) {
        paintSpotlight(host.slide);
    }
}

export async function transitionTourSlide(
    slide: TourSlide,
    onContinue: () => void
): Promise<void> {
    const host = getHost();
    host.root?.classList.remove('is-visible');
    await wait(FADE_MS);
    await showTourSlide(slide, onContinue);
}

export function hideTourSpotlight(): void {
    const host = getHost();
    host.visible = false;
    host.slide = null;
    host.onContinue = null;
    setViewShortcutLock(null);
    document.removeEventListener('keydown', onTourKeyDown, true);
    window.removeEventListener('resize', onWindowResize);
    host.listenersBound = false;
    host.resizeObserver?.disconnect();
    host.resizeObserver = null;
    host.root?.classList.remove('is-visible');
    host.tippy?.hide();
    window.setTimeout(() => {
        host.tippy?.destroy();
        host.tippy = null;
        host.root?.remove();
        host.root = null;
        host.svg = null;
        host.maskPath = null;
        host.blockers = null;
        host.tooltip = null;
    }, FADE_MS);
}

export function wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
        window.setTimeout(resolve, ms);
    });
}
