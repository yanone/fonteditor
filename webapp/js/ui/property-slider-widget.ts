import { createUiSlider, type UiSliderOptions } from './slider';

export type PropertySliderWidgetOptions = UiSliderOptions & {
    label: string;
    title?: string;
    propertyField?: string;
};

export function createPropertySliderWidget(
    options: PropertySliderWidgetOptions
): HTMLElement {
    const widget = document.createElement('div');
    widget.className = 'glyph-property-control glyph-property-slider-widget';
    if (options.propertyField) {
        widget.dataset.propertyField = options.propertyField;
    }

    const label = document.createElement('span');
    label.className = 'glyph-property-control-label';
    label.textContent = options.label;
    if (options.title) {
        label.title = options.title;
        widget.title = options.title;
    }
    widget.appendChild(label);

    const slider = createUiSlider(options);
    widget.appendChild(slider.element);
    return widget;
}
