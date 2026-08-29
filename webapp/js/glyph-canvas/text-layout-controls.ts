import { ArrowAdjustableTextInput } from '../arrow-adjustable-text-input';
import {
    DEFAULT_LINE_HEIGHT_PERCENT,
    isTextAlign,
    type TextAlign
} from './text-run-layout';

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

export class TextLayoutControls {
    section: HTMLElement | null = null;
    private lineHeightInput: HTMLInputElement | null = null;
    private arrowInput: ArrowAdjustableTextInput | null = null;

    createSection(): HTMLElement {
        const section = document.createElement('div');
        section.id = 'glyph-text-layout-section';
        this.section = section;
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

        const temp = document.createElement('div');

        const lineHeightRow = document.createElement('div');
        lineHeightRow.className = 'text-layout-row';

        const lineHeightLabel = document.createElement('label');
        lineHeightLabel.className = 'text-layout-label';
        lineHeightLabel.textContent = 'Line height';
        lineHeightLabel.setAttribute('for', 'glyph-line-height-input');

        const lineHeightField = document.createElement('div');
        lineHeightField.className = 'text-layout-lineheight-field';

        const input = document.createElement('input');
        input.id = 'glyph-line-height-input';
        input.type = 'text';
        input.inputMode = 'decimal';
        input.value = String(lineHeight);
        input.className = 'text-layout-lineheight-input';

        const suffix = document.createElement('span');
        suffix.className = 'text-layout-lineheight-suffix';
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

        input.addEventListener('change', commit);
        input.addEventListener('blur', commit);

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

        lineHeightField.appendChild(input);
        lineHeightField.appendChild(suffix);
        lineHeightRow.appendChild(lineHeightLabel);
        lineHeightRow.appendChild(lineHeightField);
        temp.appendChild(lineHeightRow);

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
            button.className = 'text-layout-align-button';
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
        });
    }
}

export const textLayoutControls = new TextLayoutControls();
