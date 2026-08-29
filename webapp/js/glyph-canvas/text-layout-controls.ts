import { ArrowAdjustableTextInput } from '../arrow-adjustable-text-input';
import {
    DEFAULT_LINE_HEIGHT_PERCENT,
    isTextAlign,
    type TextAlign
} from './text-run-layout';
import {
    formatPointSize,
    getScreenUnitScale,
    parsePointSize,
    pointSizeToViewportScale,
    viewportScaleToPointSize
} from './point-size';
import { showScreenCalibrationDialog } from './screen-calibration-dialog';

function alignmentIconSvg(align: TextAlign): string {
    const bars =
        align === 'left'
            ? [
                  { x: 3, width: 14 },
                  { x: 3, width: 10 },
                  { x: 3, width: 14 },
                  { x: 3, width: 8 }
              ]
            : align === 'center'
              ? [
                    { x: 3, width: 14 },
                    { x: 5, width: 10 },
                    { x: 3, width: 14 },
                    { x: 6, width: 8 }
                ]
              : [
                    { x: 3, width: 14 },
                    { x: 7, width: 10 },
                    { x: 3, width: 14 },
                    { x: 9, width: 8 }
                ];
    const rects = bars
        .map(
            (bar, index) =>
                `<rect x="${bar.x}" y="${3 + index * 3.5}" width="${bar.width}" height="2" rx="0.5" fill="currentColor"/>`
        )
        .join('');
    return `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">${rects}</svg>`;
}

function iconLabelHtml(icon: string): string {
    return `<span class="material-symbols-outlined" aria-hidden="true">${icon}</span>`;
}

const TEXT_LAYOUT_FIELD_IDS = new Set([
    'glyph-line-height-input',
    'glyph-point-size-input'
]);

function isTitleBarTextField(element: EventTarget | null): boolean {
    return (
        element instanceof HTMLElement &&
        (TEXT_LAYOUT_FIELD_IDS.has(element.id) ||
            element.closest('.view-title-field') !== null)
    );
}

function restoreCanvasAfterTextLayoutField(
    arrowInput: ArrowAdjustableTextInput | null,
    relatedTarget: EventTarget | null
): void {
    if (arrowInput?.isApplyingStep) {
        return;
    }
    if (isTitleBarTextField(relatedTarget)) {
        return;
    }
    setTimeout(() => {
        if (arrowInput?.isApplyingStep) {
            return;
        }
        if (isTitleBarTextField(document.activeElement)) {
            return;
        }
        window.glyphCanvas?.canvas?.focus({ preventScroll: true });
    }, 0);
}

function bindFieldCommitAndCanvasFocus(
    input: HTMLInputElement,
    commit: () => void,
    getArrowInput: () => ArrowAdjustableTextInput | null
): void {
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        commit();
        input.blur();
    });
    input.addEventListener('blur', (event) => {
        commit();
        restoreCanvasAfterTextLayoutField(getArrowInput(), event.relatedTarget);
    });
}

export class TextLayoutControls {
    section: HTMLElement | null = null;
    private lineHeightInput: HTMLInputElement | null = null;
    private pointSizeInput: HTMLInputElement | null = null;
    private arrowInput: ArrowAdjustableTextInput | null = null;
    private pointSizeArrowInput: ArrowAdjustableTextInput | null = null;
    private listenersBound = false;

    constructor() {
        this.bindGlobalListeners();
    }

    private bindGlobalListeners(): void {
        if (this.listenersBound) {
            return;
        }
        this.listenersBound = true;
        window.addEventListener('glyphCanvasViewportChanged', () => {
            this.syncPointSizeField();
        });
        window.addEventListener('screenUnitScaleChanged', () => {
            this.syncPointSizeField();
        });
    }

    currentPointSize(): number | null {
        const scale = window.glyphCanvas?.viewportManager?.scale;
        if (!Number.isFinite(scale) || scale === undefined) {
            return null;
        }
        return viewportScaleToPointSize(
            scale,
            window.currentFontModel?.upm,
            getScreenUnitScale()
        );
    }

    syncPointSizeField(): void {
        const input = this.pointSizeInput;
        if (!input || document.activeElement === input) {
            return;
        }
        const pointSize = this.currentPointSize();
        if (pointSize === null) {
            return;
        }
        const next = formatPointSize(pointSize);
        if (input.value !== next) {
            input.value = next;
        }
    }

    applyPointSize(pointSize: number): void {
        const scale = pointSizeToViewportScale(
            pointSize,
            window.currentFontModel?.upm,
            getScreenUnitScale()
        );
        window.glyphCanvas?.setScaleTowardFocus(scale);
        this.syncPointSizeField();
    }

    createSection(): HTMLElement {
        const section = document.createElement('div');
        section.id = 'glyph-text-layout-section';
        this.section = section;
        document.getElementById('editor-text-layout')?.appendChild(section);
        this.render();
        return section;
    }

    render() {
        if (!this.section) {
            return;
        }

        const textRun = window.glyphCanvas?.textRunEditor;
        const lineHeight =
            textRun?.lineHeightPercent ?? DEFAULT_LINE_HEIGHT_PERCENT;
        const align = textRun?.textAlign ?? 'left';
        const pointSize = this.currentPointSize();

        const temp = document.createElement('div');

        const lineHeightField = document.createElement('div');
        lineHeightField.className = 'view-title-field text-layout-field';

        const lineHeightLabel = document.createElement('label');
        lineHeightLabel.className = 'text-layout-icon-label';
        lineHeightLabel.setAttribute('for', 'glyph-line-height-input');
        lineHeightLabel.setAttribute('title', 'Line height');
        lineHeightLabel.setAttribute('aria-label', 'Line height');
        lineHeightLabel.innerHTML = iconLabelHtml('format_line_spacing');

        const input = document.createElement('input');
        input.id = 'glyph-line-height-input';
        input.type = 'text';
        input.inputMode = 'decimal';
        input.value = String(lineHeight);
        input.className = 'text-layout-input';
        input.setAttribute('aria-label', 'Line height');
        input.title = 'Line height';

        const suffix = document.createElement('span');
        suffix.className = 'text-layout-suffix';
        suffix.textContent = '%';

        const commit = () => {
            const parsed = Number.parseFloat(input.value);
            const next = Number.isFinite(parsed)
                ? parsed
                : DEFAULT_LINE_HEIGHT_PERCENT;
            window.glyphCanvas?.textRunEditor?.setLineHeightPercent(next);
            input.value = String(
                window.glyphCanvas?.textRunEditor?.lineHeightPercent ??
                    DEFAULT_LINE_HEIGHT_PERCENT
            );
        };

        this.arrowInput = new ArrowAdjustableTextInput({
            input,
            getValue: () =>
                window.glyphCanvas?.textRunEditor?.lineHeightPercent ??
                DEFAULT_LINE_HEIGHT_PERCENT,
            applyValue: (value) => {
                window.glyphCanvas?.textRunEditor?.setLineHeightPercent(value);
                input.value = String(
                    window.glyphCanvas?.textRunEditor?.lineHeightPercent ??
                        DEFAULT_LINE_HEIGHT_PERCENT
                );
            },
            findReplacementInput: () =>
                document.querySelector('#glyph-line-height-input')
        });

        bindFieldCommitAndCanvasFocus(input, commit, () => this.arrowInput);

        lineHeightField.appendChild(lineHeightLabel);
        lineHeightField.appendChild(input);
        lineHeightField.appendChild(suffix);
        temp.appendChild(lineHeightField);

        const pointSizeField = document.createElement('div');
        pointSizeField.className = 'view-title-field text-layout-field';

        const pointSizeLabel = document.createElement('label');
        pointSizeLabel.className = 'text-layout-icon-label';
        pointSizeLabel.setAttribute('for', 'glyph-point-size-input');
        pointSizeLabel.setAttribute('title', 'Point size');
        pointSizeLabel.setAttribute('aria-label', 'Point size');
        pointSizeLabel.innerHTML = iconLabelHtml('format_size');

        const pointInput = document.createElement('input');
        pointInput.id = 'glyph-point-size-input';
        pointInput.type = 'text';
        pointInput.inputMode = 'decimal';
        pointInput.value = pointSize === null ? '' : formatPointSize(pointSize);
        pointInput.className = 'text-layout-input';
        pointInput.setAttribute('aria-label', 'Point size');
        pointInput.title = 'Point size';

        const pointSuffix = document.createElement('span');
        pointSuffix.className = 'text-layout-suffix';
        pointSuffix.textContent = 'pt';

        const commitPointSize = () => {
            const parsed = parsePointSize(pointInput.value);
            if (parsed === null) {
                this.syncPointSizeField();
                return;
            }
            this.applyPointSize(parsed);
            const next = this.currentPointSize();
            pointInput.value =
                next === null ? formatPointSize(parsed) : formatPointSize(next);
        };

        this.pointSizeArrowInput = new ArrowAdjustableTextInput({
            input: pointInput,
            getValue: () => this.currentPointSize() ?? 12,
            applyValue: (value) => {
                if (!Number.isFinite(value) || value <= 0) {
                    return;
                }
                this.applyPointSize(value);
                const next = this.currentPointSize();
                const liveInput = document.querySelector(
                    '#glyph-point-size-input'
                ) as HTMLInputElement | null;
                if (liveInput) {
                    liveInput.value =
                        next === null
                            ? formatPointSize(value)
                            : formatPointSize(next);
                }
            },
            findReplacementInput: () =>
                document.querySelector('#glyph-point-size-input')
        });

        bindFieldCommitAndCanvasFocus(
            pointInput,
            commitPointSize,
            () => this.pointSizeArrowInput
        );

        const calibrateButton = document.createElement('button');
        calibrateButton.type = 'button';
        calibrateButton.className = 'text-layout-calibrate-btn';
        calibrateButton.setAttribute('aria-label', 'Calibrate screen');
        calibrateButton.title = 'Calibrate screen';
        calibrateButton.innerHTML = iconLabelHtml('straighten');
        calibrateButton.addEventListener('click', () => {
            showScreenCalibrationDialog();
        });

        pointSizeField.appendChild(pointSizeLabel);
        pointSizeField.appendChild(pointInput);
        pointSizeField.appendChild(pointSuffix);
        pointSizeField.appendChild(calibrateButton);
        temp.appendChild(pointSizeField);

        const alignRow = document.createElement('div');
        alignRow.className = 'text-layout-align';
        alignRow.setAttribute('role', 'group');
        alignRow.setAttribute('aria-label', 'Text alignment');

        const options: Array<{ id: TextAlign; label: string }> = [
            { id: 'left', label: 'Left' },
            { id: 'center', label: 'Center' },
            { id: 'right', label: 'Right' }
        ];
        for (const option of options) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'view-title-button text-layout-align-button';
            button.setAttribute('aria-label', option.label);
            button.setAttribute(
                'aria-pressed',
                option.id === align ? 'true' : 'false'
            );
            if (option.id === align) {
                button.classList.add('active');
            }
            button.innerHTML = alignmentIconSvg(option.id);
            button.addEventListener('click', () => {
                if (!isTextAlign(option.id)) {
                    return;
                }
                window.glyphCanvas?.textRunEditor?.setTextAlign(option.id);
                this.section
                    ?.querySelectorAll('.text-layout-align-button')
                    .forEach((el) => {
                        const isActive =
                            el.getAttribute('aria-label') === option.label;
                        el.classList.toggle('active', isActive);
                        el.setAttribute(
                            'aria-pressed',
                            isActive ? 'true' : 'false'
                        );
                    });
            });
            alignRow.appendChild(button);
        }
        temp.appendChild(alignRow);

        requestAnimationFrame(() => {
            if (!this.section) {
                return;
            }
            this.section.replaceChildren(...Array.from(temp.childNodes));
            this.lineHeightInput = this.section.querySelector(
                '#glyph-line-height-input'
            );
            this.pointSizeInput = this.section.querySelector(
                '#glyph-point-size-input'
            );
        });
    }
}

export const textLayoutControls = new TextLayoutControls();
