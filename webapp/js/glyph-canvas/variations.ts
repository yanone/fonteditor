import { get_font_axes } from '../../wasm-dist/babelfont_fontc_web';
import Babelfont from '../babelfont';
import { ensureWasmInitialized } from '../wasm-init';
import { Logger } from '../logger';
import {
    designspaceToUserspace,
    userspaceToDesignspace,
    type UserspaceCoordinate,
    type UserspaceLocation
} from '../locations';

const console = new Logger('Variations');

interface VariationAxis {
    tag: string;
    name: string;
    min: UserspaceCoordinate;
    max: UserspaceCoordinate;
    default: UserspaceCoordinate;
}

/**
 * Persistent state for a play-loop animation on one axis.
 * Stored in a map keyed by axis tag so it survives axes UI rebuilds.
 */
interface LoopAnimationState {
    active: boolean;
    startTime: number;
    frameId: number | null;
    startValue: number;
}

export class AxesManager {
    variationSettings: UserspaceLocation;
    axesSection: HTMLElement | null;
    // Animation state
    animationFrames: number;
    isAnimating: boolean;
    animationStartValues: UserspaceLocation;
    animationTargetValues: UserspaceLocation;
    animationCurrentFrame: number;
    fontBytes: Uint8Array | null;
    callbacks: Record<string, Function[]>; // Support multiple callbacks per event
    isSliderActive: boolean;
    isTextFieldChange: boolean;
    pendingSliderMouseUp: boolean;
    lastSliderReleaseTime: number;
    isLoopAnimating: boolean;
    loopAnimationStopCallbacks: (() => void)[];
    /** Per-axis persistent play-loop state (survives axes UI DOM rebuilds). */
    loopAnimationStates: Map<string, LoopAnimationState>;

    constructor() {
        this.variationSettings = {}; // Current variation settings
        this.axesSection = null; // Container for axes UI
        // Animation state
        this.animationFrames = parseInt(
            localStorage.getItem('animationFrames') || '10',
            10
        );
        this.isAnimating = false;
        this.animationStartValues = {};
        this.animationTargetValues = {};
        this.animationCurrentFrame = 0;
        this.isSliderActive = false;
        this.isTextFieldChange = false;
        this.pendingSliderMouseUp = false;
        this.lastSliderReleaseTime = 0;
        this.isLoopAnimating = false;
        this.loopAnimationStopCallbacks = [];
        this.loopAnimationStates = new Map();

        this.fontBytes = null; // To be set externally
        this.callbacks = {}; // Array of callbacks for each event
    }

    stopAllLoopAnimations() {
        // Stop via persistent states — handles cases where button DOM was
        // rebuilt while an animation was running.
        for (const state of this.loopAnimationStates.values()) {
            if (state.active) {
                if (state.frameId !== null) {
                    cancelAnimationFrame(state.frameId);
                    state.frameId = null;
                }
                state.active = false;
            }
        }
        // Also call legacy-style stop callbacks for safety.
        if (this.loopAnimationStopCallbacks.length > 0) {
            console.log('[AxesManager] Stopping all loop animations');
            this.loopAnimationStopCallbacks.forEach((stop) => stop());
            this.loopAnimationStopCallbacks = [];
        }
        this.isLoopAnimating = false;
        // Update any remaining button DOM to play icon
        this.syncLoopButtonDom();

        // Trigger sliderMouseUp to finalize
        this.isSliderActive = false;
        if (this.isAnimating) {
            this.pendingSliderMouseUp = true;
        } else {
            this.call('sliderMouseUp');
        }
    }

    /** Sync play/pause button icons in the DOM to match persistent state. */
    private syncLoopButtonDom(): void {
        if (!this.axesSection) return;
        this.axesSection
            .querySelectorAll('.editor-axis-play-button')
            .forEach((btn) => {
                const button = btn as HTMLElement;
                const tag = button.getAttribute('data-axis-tag');
                if (!tag) return;
                const state = this.loopAnimationStates.get(tag);
                if (state?.active) {
                    button.innerHTML =
                        '<span class="material-symbols-outlined">pause</span>';
                    button.classList.add('playing');
                } else {
                    button.innerHTML =
                        '<span class="material-symbols-outlined">play_arrow</span>';
                    button.classList.remove('playing');
                }
            });
    }

    on(event: string, callback: Function) {
        if (!this.callbacks[event]) {
            this.callbacks[event] = [];
        }
        this.callbacks[event].push(callback);
    }

    async call(event: string, ...args: any[]) {
        if (this.callbacks[event]) {
            for (const callback of this.callbacks[event]) {
                try {
                    await callback(...args);
                } catch (error) {
                    console.error(
                        `[AxesManager] Error in ${event} callback:`,
                        error
                    );
                }
            }
        }
    }

    createAxesSection() {
        const axesSection = document.createElement('div');
        axesSection.id = 'glyph-axes-section';
        this.axesSection = axesSection;
        return axesSection;
    }

    private getFontAxes(): any[] {
        return ((window as any).currentFontModel?.axes || []) as any[];
    }

    private formatAxisCoordinate(value: number): string {
        return Math.round(value).toString();
    }

    private sanitizeIntegerInput(value: string): string {
        const trimmed = value.trimStart();
        if (!trimmed) {
            return '';
        }

        let result = '';
        let hasDigits = false;

        for (let index = 0; index < trimmed.length; index += 1) {
            const char = trimmed[index];
            if (char === '-' && result.length === 0 && !hasDigits) {
                result = '-';
                continue;
            }

            if (/\d/.test(char)) {
                result += char;
                hasDigits = true;
                continue;
            }

            if (hasDigits) {
                break;
            }
        }

        return result;
    }

    private getDesignspaceValueForAxis(
        axisTag: string,
        userspaceValue: number
    ): number {
        const axes = this.getFontAxes();
        if (!axes.length) {
            return userspaceValue;
        }

        const designspaceLocation = userspaceToDesignspace(
            { [axisTag]: userspaceValue },
            axes
        ) as Record<string, number>;

        return designspaceLocation[axisTag] ?? userspaceValue;
    }

    private getUserspaceValueForAxis(
        axisTag: string,
        designspaceValue: number
    ): number {
        const axes = this.getFontAxes();
        if (!axes.length) {
            return designspaceValue;
        }

        const userspaceLocation = designspaceToUserspace(
            { [axisTag]: designspaceValue },
            axes
        ) as Record<string, number>;

        return userspaceLocation[axisTag] ?? designspaceValue;
    }

    updateAxisSliders() {
        // Update axis slider positions to match current variationSettings
        if (!this.axesSection) return;

        // Update all sliders
        const sliders = this.axesSection.querySelectorAll(
            '.editor-axis-slider[data-axis-tag]'
        );
        sliders.forEach((slider) => {
            const input = slider as HTMLInputElement;
            const axisTag: string | null = slider.getAttribute('data-axis-tag');
            if (axisTag && this.variationSettings[axisTag] !== undefined) {
                input.value = this.variationSettings[axisTag].toString();

                // Update slider fill
                const min = parseFloat(input.min);
                const max = parseFloat(input.max);
                const value = parseFloat(input.value);
                const percent = ((value - min) / (max - min)) * 100;
                input.style.setProperty('--value-percent', `${percent}%`);
            }
        });

        // Update all value labels
        const valueLabels = this.axesSection.querySelectorAll(
            'input[data-axis-tag].editor-axis-value'
        );
        valueLabels.forEach((label: any) => {
            const axisTag: string | null = label.getAttribute('data-axis-tag');
            if (axisTag && this.variationSettings[axisTag] !== undefined) {
                (label as HTMLInputElement).value = this.formatAxisCoordinate(
                    Number(this.variationSettings[axisTag])
                );
            }
        });

        const designspaceValueLabels = this.axesSection.querySelectorAll(
            'input[data-axis-tag].editor-axis-value-designspace'
        );
        designspaceValueLabels.forEach((label: any) => {
            const axisTag: string | null = label.getAttribute('data-axis-tag');
            if (axisTag && this.variationSettings[axisTag] !== undefined) {
                (label as HTMLInputElement).value = this.formatAxisCoordinate(
                    this.getDesignspaceValueForAxis(
                        axisTag,
                        Number(this.variationSettings[axisTag])
                    )
                );
            }
        });
    }

    async getVariationAxes(): Promise<VariationAxis[]> {
        if (!this.fontBytes) {
            console.log('[AxesManager]', 'No fontBytes available');
            return [];
        }

        try {
            console.log(
                '[AxesManager]',
                'Getting axes from WASM, fontBytes length:',
                this.fontBytes.length
            );
            await ensureWasmInitialized();
            const axesJson = get_font_axes(this.fontBytes);
            console.log('[AxesManager]', 'Axes JSON:', axesJson);
            return JSON.parse(axesJson);
        } catch (error) {
            console.error('[AxesManager]', 'Failed to get font axes:', error);
            return [];
        }
    }

    getAxisValue(axisTag: string): number | undefined {
        const value = this.variationSettings[axisTag];
        return value === undefined ? undefined : Number(value);
    }

    setAxisValue(axisTag: string, value: number): void {
        this.variationSettings[axisTag] = value;
        this.updateAxisSliders();
    }

    async updateAxesUI() {
        if (!this.axesSection) return;

        const axes = await this.getVariationAxes();

        if (axes.length === 0) {
            await this.call('updated');
            requestAnimationFrame(() => {
                this.axesSection!.innerHTML = '';
            });
            return; // No variable axes
        }

        // Build content off-screen first, then swap in one operation
        const tempContainer = document.createElement('div');

        // Add section title
        const title = document.createElement('div');
        title.className = 'editor-section-title';
        title.textContent = 'Variable Axes';
        tempContainer.appendChild(title);

        const valueColumnsHeader = document.createElement('div');
        valueColumnsHeader.className = 'editor-axis-columns-header';
        valueColumnsHeader.title =
            'US = userspace coordinate used by the editor. DS = designspace coordinate mapped through the axis map.';

        const valueColumnsSpacer = document.createElement('span');
        valueColumnsSpacer.className = 'editor-axis-columns-spacer';
        valueColumnsHeader.appendChild(valueColumnsSpacer);

        const userspaceHeader = document.createElement('span');
        userspaceHeader.className = 'editor-axis-column-label';
        userspaceHeader.textContent = 'US';
        valueColumnsHeader.appendChild(userspaceHeader);

        const designspaceHeader = document.createElement('span');
        designspaceHeader.className = 'editor-axis-column-label';
        designspaceHeader.textContent = 'DS';
        valueColumnsHeader.appendChild(designspaceHeader);
        tempContainer.appendChild(valueColumnsHeader);

        // Create slider for each axis
        axes.forEach((axis: VariationAxis) => {
            const axisContainer = document.createElement('div');
            axisContainer.className = 'editor-axis-container';

            // Label row (axis name and value)
            const labelRow = document.createElement('div');
            labelRow.className = 'editor-axis-label-row';

            const axisLabel = document.createElement('span');
            axisLabel.className = 'editor-axis-name';
            axisLabel.textContent = axis.name || axis.tag;

            const valueLabel = document.createElement('input');
            valueLabel.type = 'text';
            valueLabel.className = 'editor-axis-value';
            valueLabel.setAttribute('data-axis-tag', axis.tag);
            valueLabel.setAttribute('inputmode', 'numeric');

            const designspaceValueLabel = document.createElement('input');
            designspaceValueLabel.type = 'text';
            designspaceValueLabel.className =
                'editor-axis-value editor-axis-value-designspace';
            designspaceValueLabel.setAttribute('data-axis-tag', axis.tag);
            designspaceValueLabel.setAttribute('inputmode', 'numeric');

            // Play/pause button — get persistent state, create if missing
            const playButton = document.createElement('button');
            playButton.className = 'editor-axis-play-button';
            playButton.setAttribute('data-axis-tag', axis.tag);
            playButton.title = 'Animate axis';

            let state = this.loopAnimationStates.get(axis.tag);
            if (!state) {
                state = {
                    active: false,
                    startTime: 0,
                    frameId: null,
                    startValue: 0
                };
                this.loopAnimationStates.set(axis.tag, state);
            }

            // Set button icon from persistent state
            if (state.active) {
                playButton.innerHTML =
                    '<span class="material-symbols-outlined">pause</span>';
                playButton.classList.add('playing');
            } else {
                playButton.innerHTML =
                    '<span class="material-symbols-outlined">play_arrow</span>';
            }

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.className = 'editor-axis-slider';
            slider.min = axis.min.toString();
            slider.max = axis.max.toString();
            slider.step = '1';
            slider.setAttribute('data-axis-tag', axis.tag);

            // Restore value if it exists, otherwise use default
            const initialValue =
                this.variationSettings[axis.tag] !== undefined
                    ? Number(this.variationSettings[axis.tag])
                    : Number(axis.default);

            slider.value = initialValue.toString();

            // Initialize variation setting
            this.variationSettings[axis.tag] = initialValue;

            const syncAxisValueFields = (userspaceValue: number) => {
                valueLabel.value = this.formatAxisCoordinate(userspaceValue);
                designspaceValueLabel.value = this.formatAxisCoordinate(
                    this.getDesignspaceValueForAxis(axis.tag, userspaceValue)
                );
            };

            syncAxisValueFields(initialValue);

            // Function to update slider fill
            const updateSliderFill = () => {
                const min = parseFloat(slider.min);
                const max = parseFloat(slider.max);
                const theValue = parseFloat(slider.value);
                const percent = ((theValue - min) / (max - min)) * 100;
                slider.style.setProperty('--value-percent', `${percent}%`);
            };

            // Set initial fill
            updateSliderFill();

            const animateAxis = () => {
                if (!state!.active) return;

                const now = performance.now();
                const elapsed = now - state!.startTime;
                const wavelength =
                    (window as any).APP_SETTINGS?.AXIS_ANIMATION_WAVELENGTH ||
                    5000;

                const midpoint = (Number(axis.min) + Number(axis.max)) / 2;
                const amplitude = (Number(axis.max) - Number(axis.min)) / 2;
                const normalizedStart =
                    (state!.startValue - midpoint) / amplitude;
                const startPhase = Math.asin(
                    Math.max(-1, Math.min(1, normalizedStart))
                );

                const sineValue = Math.sin(
                    startPhase + (elapsed / wavelength) * 2 * Math.PI
                );
                const value = midpoint + sineValue * amplitude;

                // Update slider and value label in current DOM
                slider.value = value.toString();
                syncAxisValueFields(value);
                updateSliderFill();

                // Immediate update — no nested eased animation per tick
                this.variationSettings[axis.tag] = value;
                this.updateAxisSliders();
                this.call('onSliderChange', axis.tag, value);
                this.call('animationInProgress');

                state!.frameId = requestAnimationFrame(animateAxis);
            };

            // Helper to update a specific button's icon from persistent state
            const updateButtonIcon = () => {
                if (state!.active) {
                    playButton.innerHTML =
                        '<span class="material-symbols-outlined">pause</span>';
                    playButton.classList.add('playing');
                } else {
                    playButton.innerHTML =
                        '<span class="material-symbols-outlined">play_arrow</span>';
                    playButton.classList.remove('playing');
                }
            };

            playButton.addEventListener('click', async () => {
                if (!state!.active) {
                    // --- START ---
                    state!.active = true;
                    state!.frameId = null;
                    state!.startTime = performance.now();
                    state!.startValue = parseFloat(slider.value);
                    updateButtonIcon();

                    this.isLoopAnimating = true;

                    this.isSliderActive = true;
                    await this.call('sliderMouseDown');

                    // Start animation only if still active (not stopped during await)
                    if (state!.active) {
                        animateAxis();
                    }
                } else {
                    // --- STOP ---
                    state!.active = false;
                    if (state!.frameId !== null) {
                        cancelAnimationFrame(state!.frameId);
                        state!.frameId = null;
                    }
                    updateButtonIcon();

                    // Check if any other axis still has an active animation
                    let hasActive = false;
                    for (const [_, s] of this.loopAnimationStates) {
                        if (s.active) {
                            hasActive = true;
                            break;
                        }
                    }
                    if (!hasActive) {
                        this.isLoopAnimating = false;
                    }

                    this.isSliderActive = false;
                    if (this.isAnimating) {
                        this.pendingSliderMouseUp = true;
                    } else {
                        await this.call('sliderMouseUp');
                    }
                }
            });

            labelRow.appendChild(playButton);
            labelRow.appendChild(axisLabel);

            const valueFields = document.createElement('div');
            valueFields.className = 'editor-axis-value-fields';
            valueFields.appendChild(valueLabel);
            valueFields.appendChild(designspaceValueLabel);
            labelRow.appendChild(valueFields);

            // Slider
            axisContainer.appendChild(labelRow);
            axisContainer.appendChild(slider);
            tempContainer.appendChild(axisContainer);

            // Handle value input changes
            valueLabel.addEventListener('input', (e) => {
                const target = e.target as HTMLInputElement;
                target.value = this.sanitizeIntegerInput(target.value);
            });

            designspaceValueLabel.addEventListener('input', (e) => {
                const target = e.target as HTMLInputElement;
                target.value = this.sanitizeIntegerInput(target.value);
            });

            valueLabel.addEventListener('change', async (e) => {
                const target = e.target as HTMLInputElement;
                let value = parseInt(target.value, 10);

                // Clamp value to axis bounds
                if (isNaN(value)) {
                    value = initialValue;
                } else {
                    value = Math.max(
                        Number(axis.min),
                        Math.min(Number(axis.max), value)
                    );
                }

                syncAxisValueFields(value);

                // Update the slider position to match
                slider.value = value.toString();

                // Update slider fill
                updateSliderFill();

                // Mark this as a text field change
                this.isTextFieldChange = true;

                // Execute the same sequence as slider interaction:
                // 1. Mouse down to start interpolation
                await this.call('sliderMouseDown');

                // 2. Change the value and trigger animation
                this.setVariation(axis.tag, value);
                this.call('onSliderChange', axis.tag, value);

                // Note: Layer selection will be handled when animation completes
            });

            designspaceValueLabel.addEventListener('change', async (e) => {
                const target = e.target as HTMLInputElement;
                const rawValue = parseInt(target.value, 10);
                const currentUserspaceValue =
                    this.variationSettings[axis.tag] !== undefined
                        ? Number(this.variationSettings[axis.tag])
                        : initialValue;
                let userspaceValue = Number.isNaN(rawValue)
                    ? currentUserspaceValue
                    : this.getUserspaceValueForAxis(axis.tag, rawValue);
                userspaceValue = Math.round(userspaceValue);

                userspaceValue = Math.max(
                    Number(axis.min),
                    Math.min(Number(axis.max), userspaceValue)
                );

                syncAxisValueFields(userspaceValue);
                slider.value = userspaceValue.toString();
                updateSliderFill();

                this.isTextFieldChange = true;
                await this.call('sliderMouseDown');
                this.setVariation(axis.tag, userspaceValue);
                this.call('onSliderChange', axis.tag, userspaceValue);
            });

            valueLabel.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    // @ts-ignore
                    e.target.blur();
                }
            });

            designspaceValueLabel.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    // @ts-ignore
                    e.target.blur();
                }
            });

            // Enter preview mode on mousedown
            slider.addEventListener('mousedown', () => {
                this.isSliderActive = true;
                this.call('sliderMouseDown');
            });

            // Handle both mouseup (for clicks) and change (for drags)
            const handleSliderRelease = () => {
                const now = Date.now();
                // Prevent duplicate calls within 50ms
                if (now - this.lastSliderReleaseTime < 50) {
                    console.log(
                        '[Variations] Ignoring duplicate slider release event'
                    );
                    return;
                }
                this.lastSliderReleaseTime = now;

                console.log('[Variations] slider release handler called', {
                    isSliderActive: this.isSliderActive,
                    isAnimating: this.isAnimating
                });

                this.isSliderActive = false;

                // If animation is still running, defer sliderMouseUp until it completes
                if (this.isAnimating) {
                    console.log(
                        '[Variations] Animation still running, deferring sliderMouseUp'
                    );
                    this.pendingSliderMouseUp = true;
                } else {
                    console.log(
                        '[Variations] Calling sliderMouseUp immediately'
                    );
                    this.call('sliderMouseUp');
                }
            };

            // mouseup fires for clicks, change fires after drag ends
            slider.addEventListener('mouseup', handleSliderRelease);
            slider.addEventListener('change', handleSliderRelease);

            // Update on change
            slider.addEventListener('input', (e) => {
                // @ts-ignore
                const value = parseFloat(e.target.value);
                syncAxisValueFields(value);

                // Update slider fill
                updateSliderFill();

                console.log(
                    '[Variations] Slider input event, calling onSliderChange',
                    axis.tag,
                    value
                );
                this.setVariation(axis.tag, value);
                this.call('onSliderChange', axis.tag, value);
            });
            console.log(
                '[Variations] Attached input listener to slider for axis:',
                axis.tag
            );
        });

        console.log(
            '[Variations] About to swap DOM content in requestAnimationFrame'
        );
        // Swap content in one frame to prevent flicker
        requestAnimationFrame(() => {
            console.log('[Variations] Swapping DOM content now');
            this.axesSection!.innerHTML = '';
            while (tempContainer.firstChild) {
                this.axesSection!.appendChild(tempContainer.firstChild);
            }
            console.log('[Variations] DOM swap complete');
        });

        console.log(
            '[Variations]',
            `Created ${axes.length} variable axis sliders`
        );

        await this.call('updated');

        // Global mouseup handler to exit preview mode if slider was active
        // This catches cases where mouse is released outside the slider element
        document.addEventListener('mouseup', () => {
            console.log(
                '[Variations] Global mouseup event, isSliderActive:',
                this.isSliderActive
            );
            if (this.isSliderActive) {
                this.isSliderActive = false;
                // If animation is still running, defer sliderMouseUp until it completes
                if (this.isAnimating) {
                    console.log(
                        '[Variations] Global mouseup: Animation still running, deferring'
                    );
                    this.pendingSliderMouseUp = true;
                } else {
                    console.log(
                        '[Variations] Global mouseup: Calling sliderMouseUp'
                    );
                    this.call('sliderMouseUp');
                }
            }
        });
    }

    setVariation(axisTag: string, value: number) {
        this._setupAnimation({ [axisTag]: value });
    }

    /**
     * Set variation immediately without eased animation.
     * Used by play-loop animation which needs to update every RAF frame
     * without starting a nested 10-frame eased animation per tick.
     */
    setVariationImmediate(axisTag: string, value: number) {
        this.variationSettings[axisTag] = value;
        this.updateAxisSliders();
        this.call('onSliderChange', axisTag, value);
        this.call('animationInProgress');
    }

    _setupAnimation(newSettings: UserspaceLocation) {
        if (this.isAnimating) {
            this.isAnimating = false;
        }

        this.animationStartValues = { ...this.variationSettings };
        this.animationTargetValues = {
            ...this.variationSettings,
            ...newSettings
        };
        this.animationCurrentFrame = 0;
        this.isAnimating = true;
        this.animateVariation();
    }

    async animateVariation() {
        if (!this.isAnimating) return;

        this.animationCurrentFrame++;
        const progress = Math.min(
            this.animationCurrentFrame / this.animationFrames,
            1.0
        );

        // Ease-out cubic for smoother animation
        const easedProgress = 1 - Math.pow(1 - progress, 3);

        // Interpolate all axes
        for (const axisTag in this.animationTargetValues) {
            const startValue =
                Number(this.animationStartValues[axisTag]) ||
                Number(this.animationTargetValues[axisTag]);
            const targetValue = Number(this.animationTargetValues[axisTag]);
            this.variationSettings[axisTag] =
                startValue + (targetValue - startValue) * easedProgress;
        }

        // Update sliders during animation
        this.updateAxisSliders();
        // Skip rendering on frame 1 (just after setup) to prevent jitter
        // Frame 1 would show the target layer at near-start position which causes a flash
        if (this.animationCurrentFrame > 1) {
            this.call('animationInProgress');
        }

        if (progress < 1.0) {
            const delay =
                (window as any).APP_SETTINGS?.OUTLINE_EDITOR
                    ?.INTERPOLATION_ANIMATION_DELAY || 0;
            if (delay > 0) {
                setTimeout(
                    () => requestAnimationFrame(() => this.animateVariation()),
                    delay
                );
            } else {
                requestAnimationFrame(() => this.animateVariation());
            }
        } else {
            // Ensure we end exactly at target values
            this.variationSettings = { ...this.animationTargetValues };
            this.updateAxisSliders(); // Update slider UI to match final values

            // If this was a text field change, trigger layer selection now
            if (this.isTextFieldChange) {
                this.isTextFieldChange = false;
                this.call('textFieldAnimationComplete');
            }

            // If slider was released during animation, trigger sliderMouseUp now
            if (this.pendingSliderMouseUp) {
                console.log(
                    '[Variations] Animation complete, triggering deferred sliderMouseUp'
                );
                this.pendingSliderMouseUp = false;
                this.call('sliderMouseUp');
            }

            this.call('animationComplete');

            // Clear isAnimating AFTER deferred sliderMouseUp and animationComplete
            // Always clear isAnimating when animation completes, regardless of isSliderActive state
            // The isSliderActive flag is managed separately by mousedown/mouseup handlers
            this.isAnimating = false;
        }
    }
}
