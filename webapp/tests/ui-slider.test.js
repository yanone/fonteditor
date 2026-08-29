/**
 * @jest-environment jsdom
 */

const { createUiSlider, updateUiSliderFill } = require('../js/ui/slider');
const {
    createPropertySliderWidget
} = require('../js/ui/property-slider-widget');
const {
    createPathFillOpacityMenuControl
} = require('../js/path-fill-opacity-pref');

describe('ui slider', () => {
    test('createUiSlider sets fill percent and reports value', () => {
        const onInput = jest.fn();
        const slider = createUiSlider({
            min: 0,
            max: 10,
            step: 1,
            value: 5,
            onInput
        });

        expect(slider.element.type).toBe('range');
        expect(slider.getValue()).toBe(5);
        expect(slider.element.style.getPropertyValue('--value-percent')).toBe(
            '50%'
        );

        slider.element.value = '7';
        slider.element.dispatchEvent(new Event('input'));
        expect(onInput).toHaveBeenCalledWith(7);
        expect(slider.element.style.getPropertyValue('--value-percent')).toBe(
            '70%'
        );
    });

    test('createPropertySliderWidget uses the property-panel frame', () => {
        const widget = createPropertySliderWidget({
            label: 'Opacity',
            title: 'Example slider',
            propertyField: 'example-opacity',
            min: 0,
            max: 0.12,
            step: 0.001,
            value: 0.02
        });

        expect(widget.className).toContain('glyph-property-control');
        expect(widget.className).toContain('glyph-property-slider-widget');
        expect(widget.dataset.propertyField).toBe('example-opacity');
        expect(
            widget.querySelector('.glyph-property-control-label').textContent
        ).toBe('Opacity');
        expect(widget.querySelector('input.ui-slider')).not.toBeNull();
    });

    test('createPathFillOpacityMenuControl is a View-menu Fill slider', () => {
        const control = createPathFillOpacityMenuControl();
        expect(control.className).toContain('plugin-menu-fill-setting');
        expect(
            control.querySelector('.plugin-menu-setting-label').textContent
        ).toBe('Fill');
        const slider = control.querySelector('input.ui-slider');
        expect(slider).not.toBeNull();
        expect(slider.disabled).toBe(false);
    });

    test('createPathFillOpacityMenuControl can be disabled', () => {
        const control = createPathFillOpacityMenuControl({ disabled: true });
        expect(control.getAttribute('aria-disabled')).toBe('true');
        expect(control.querySelector('input.ui-slider').disabled).toBe(true);
    });

    test('updateUiSliderFill handles a zero span', () => {
        const input = document.createElement('input');
        input.type = 'range';
        input.min = '3';
        input.max = '3';
        input.value = '3';
        updateUiSliderFill(input);
        expect(input.style.getPropertyValue('--value-percent')).toBe('0%');
    });
});
