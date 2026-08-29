export type UiSliderOptions = {
    min: number;
    max: number;
    step: number;
    value: number;
    ariaLabel?: string;
    className?: string;
    onInput?: (value: number) => void;
    onChange?: (value: number) => void;
};

export type UiSliderController = {
    element: HTMLInputElement;
    getValue: () => number;
    setValue: (value: number) => void;
};

function clampSliderValue(
    value: number,
    min: number,
    max: number,
    step: number
): number {
    if (!Number.isFinite(value)) {
        return min;
    }
    const clamped = Math.min(max, Math.max(min, value));
    if (!(step > 0)) {
        return clamped;
    }
    const steps = Math.round((clamped - min) / step);
    return Math.min(max, Math.max(min, min + steps * step));
}

export function updateUiSliderFill(slider: HTMLInputElement): void {
    const min = Number.parseFloat(slider.min);
    const max = Number.parseFloat(slider.max);
    const value = Number.parseFloat(slider.value);
    const span = max - min;
    const percent = span === 0 ? 0 : ((value - min) / span) * 100;
    slider.style.setProperty('--value-percent', `${percent}%`);
}

export function createUiSlider(options: UiSliderOptions): UiSliderController {
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = ['ui-slider', options.className]
        .filter(Boolean)
        .join(' ');
    slider.min = String(options.min);
    slider.max = String(options.max);
    slider.step = String(options.step);
    if (options.ariaLabel) {
        slider.setAttribute('aria-label', options.ariaLabel);
    }

    const readValue = (): number =>
        clampSliderValue(
            Number.parseFloat(slider.value),
            options.min,
            options.max,
            options.step
        );

    const setValue = (value: number): void => {
        slider.value = String(
            clampSliderValue(value, options.min, options.max, options.step)
        );
        updateUiSliderFill(slider);
    };

    setValue(options.value);

    slider.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
    });
    slider.addEventListener('mousedown', (event) => {
        event.stopPropagation();
    });
    slider.addEventListener('keydown', (event) => {
        event.stopPropagation();
    });
    slider.addEventListener('input', () => {
        updateUiSliderFill(slider);
        options.onInput?.(readValue());
    });
    slider.addEventListener('change', () => {
        updateUiSliderFill(slider);
        options.onChange?.(readValue());
    });

    return {
        element: slider,
        getValue: readValue,
        setValue
    };
}
