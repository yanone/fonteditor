import {
    get_font_features,
    get_font_features_with_tables,
    get_stylistic_set_names
} from '../../wasm-dist/babelfont_fontc_web';
import { getOpentypeFeatureInfo } from '../opentype-features';
import { ensureWasmInitialized } from '../wasm-init';
import { Logger } from '../logger';

const console = new Logger('OpentypeFeatures');

export class FeaturesManager {
    featureSettings: Record<string, boolean>;
    defaultFeatureSettings: Record<string, boolean>;
    featureAvailabilityInEditingSubset: Record<string, boolean>;
    fontBytes: Uint8Array | null;
    editingFontBytes: Uint8Array | null;
    featuresSection: HTMLElement | null;
    featureResetButton: HTMLButtonElement | null;
    callbacks: Record<string, Function[]>;

    constructor() {
        this.featureSettings = {}; // Store OpenType feature on/off states
        this.defaultFeatureSettings = {}; // Store default states for reset
        this.featureAvailabilityInEditingSubset = {}; // Store if feature is available in current editing subset
        this.fontBytes = null; // Typing font bytes (full features)
        this.editingFontBytes = null; // Editing font bytes (subset with closure)
        this.featuresSection = null;
        this.featureResetButton = null;
        this.callbacks = {}; // Optional callbacks for interaction with GlyphCanvas
    }

    on(event: string, callback: Function) {
        if (!this.callbacks[event]) {
            this.callbacks[event] = [];
        }
        this.callbacks[event].push(callback);
    }

    call(event: string, ...args: any[]) {
        if (this.callbacks[event]) {
            for (const callback of this.callbacks[event]) {
                callback(...args);
            }
        }
    }

    createFeaturesSection() {
        const featuresSection = document.createElement('div');
        featuresSection.id = 'glyph-features-section';
        featuresSection.style.display = 'flex';
        featuresSection.style.flexDirection = 'column';
        featuresSection.style.gap = '2px';
        featuresSection.style.marginTop = '10px';
        this.featuresSection = featuresSection;
        return featuresSection;
    }

    /**
     * Sort features by their order in the source font.
     * Features defined in the source are ordered by their first occurrence.
     * Compile-time features (not in source) are appended at the end,
     * preserving their relative order from the compiled font.
     */
    sortFeaturesBySourceOrder(
        features: Array<{ tag: string; [key: string]: any }>
    ): Array<{ tag: string; [key: string]: any }> {
        // Get source features from the font model
        const sourceFeatures = window.currentFontModel?.features?.features;
        if (!sourceFeatures || !Array.isArray(sourceFeatures)) {
            return features;
        }

        // Build a map of feature tag -> first index in source
        const sourceOrderMap = new Map<string, number>();
        sourceFeatures.forEach(([tag], index) => {
            if (!sourceOrderMap.has(tag)) {
                sourceOrderMap.set(tag, index);
            }
        });

        // Separate features into source-defined and compile-time
        const sourceFeaturesList: Array<{ tag: string; [key: string]: any }> =
            [];
        const compileTimeFeatures: Array<{
            tag: string;
            [key: string]: any;
        }> = [];

        features.forEach((feature) => {
            if (sourceOrderMap.has(feature.tag)) {
                sourceFeaturesList.push(feature);
            } else {
                compileTimeFeatures.push(feature);
            }
        });

        // Sort source features by their first occurrence index
        sourceFeaturesList.sort((a, b) => {
            const indexA = sourceOrderMap.get(a.tag)!;
            const indexB = sourceOrderMap.get(b.tag)!;
            return indexA - indexB;
        });

        // Compile-time features stay in their original order (already in features array order)
        // Append compile-time features after source features
        return [...sourceFeaturesList, ...compileTimeFeatures];
    }

    async getDiscretionaryFeatures() {
        // Get discretionary features from both typing and editing fonts
        if (!this.fontBytes) {
            console.log('[Features]', 'No fontBytes available');
            return [];
        }

        try {
            console.log(
                '[Features]',
                'Getting features from typing font, fontBytes length:',
                this.fontBytes.length
            );
            // Ensure WASM is initialized
            await ensureWasmInitialized();

            // Get all features from typing font using WASM
            const featuresJson = get_font_features(this.fontBytes);
            console.log('[Features]', 'Typing font features:', featuresJson);
            const typingFontFeatures: Set<string> = new Set(
                JSON.parse(featuresJson)
            );

            // Get table locations for all features from typing font (GSUB/GPOS)
            const typingFeaturesWithTablesJson = get_font_features_with_tables(
                this.fontBytes
            );
            const typingFeaturesWithTables: Record<string, string[]> =
                JSON.parse(typingFeaturesWithTablesJson);
            console.log(
                '[Features]',
                'Typing font features with tables:',
                typingFeaturesWithTables
            );

            // Get features from editing font (subset with closure)
            let editingFontFeatures: Set<string> = new Set();
            let editingFeaturesWithTables: Record<string, string[]> = {};
            if (this.editingFontBytes) {
                try {
                    const editingFeaturesJson = get_font_features(
                        this.editingFontBytes
                    );
                    editingFontFeatures = new Set(
                        JSON.parse(editingFeaturesJson)
                    );
                    console.log(
                        '[Features]',
                        'Editing font features:',
                        Array.from(editingFontFeatures)
                    );

                    // Get table locations from editing font
                    const editingFeaturesWithTablesJson =
                        get_font_features_with_tables(this.editingFontBytes);
                    editingFeaturesWithTables = JSON.parse(
                        editingFeaturesWithTablesJson
                    );
                    console.log(
                        '[Features]',
                        'Editing font features with tables:',
                        editingFeaturesWithTables
                    );
                } catch (error) {
                    console.warn(
                        '[Features]',
                        'Could not get editing font features:',
                        error
                    );
                }
            }

            // Union of features from both fonts
            const allFeatures = new Set([
                ...typingFontFeatures,
                ...editingFontFeatures
            ]);

            // Use table information only from editing font
            // (GSUB/GPOS indicators should reflect what's in the editing font)
            const featuresWithTables: Record<string, Set<string>> = {};

            // Only use editing font tables for indicators
            for (const [tag, tables] of Object.entries(
                editingFeaturesWithTables
            )) {
                featuresWithTables[tag] = new Set(tables);
            }

            console.log(
                '[Features]',
                'Union of features with tables:',
                featuresWithTables
            );
            console.log(
                '[Features]',
                'Union of all features:',
                Array.from(allFeatures)
            );

            // Get stylistic set names from typing font
            const ssNamesJson = get_stylistic_set_names(this.fontBytes);
            console.log('[Features]', 'Stylistic set names JSON:', ssNamesJson);
            const ssNames: Record<string, string> = JSON.parse(ssNamesJson);

            // Get feature info from JavaScript module
            const featureInfo = getOpentypeFeatureInfo();

            const defaultOnFeatures = new Set(featureInfo.default_on);
            const defaultOffFeatures = new Set(featureInfo.default_off);
            const allDiscretionary = new Set([
                ...defaultOnFeatures,
                ...defaultOffFeatures
            ]);
            const descriptions = featureInfo.descriptions;

            // Filter union to only discretionary features
            const discretionaryInFont: string[] = Array.from(
                allFeatures
            ).filter((tag: string) => allDiscretionary.has(tag));

            // Build feature list with metadata and availability
            const featureList = discretionaryInFont.map((tag: string) => {
                // Use stylistic set name if available, otherwise fall back to description
                const hasCustomName = !!ssNames[tag];
                const description = ssNames[tag] || descriptions[tag] || tag;
                const availableInEditingFont = editingFontFeatures.has(tag);

                return {
                    tag: tag,
                    defaultOn: defaultOnFeatures.has(tag),
                    description: description,
                    hasCustomName: hasCustomName,
                    availableInEditingFont: availableInEditingFont,
                    tables: featuresWithTables[tag]
                        ? Array.from(featuresWithTables[tag])
                        : []
                };
            });

            // Sort features by source order, with compile-time features appended
            return this.sortFeaturesBySourceOrder(featureList);
        } catch (error) {
            console.error('[Features]', 'Failed to get features:', error);
            return [];
        }
    }

    async updateFeaturesUI() {
        if (!this.featuresSection) {
            console.warn('[Features]', 'Features section not created yet');
            return;
        }

        const features = await this.getDiscretionaryFeatures();
        console.log('[Features]', 'Updating features');

        if (features.length === 0) {
            console.log(
                '[Features]',
                'No discretionary features found in font'
            );
            this.featureAvailabilityInEditingSubset = {};
            requestAnimationFrame(() => {
                this.featuresSection!.innerHTML = '';
            });
            this.call('updated');
            return; // No discretionary features
        }

        // Build content off-screen first, then swap in one operation
        const tempContainer = document.createElement('div');

        // Add section header with reset button
        const headerRow = document.createElement('div');
        headerRow.className = 'editor-section-header';
        headerRow.style.display = 'flex';
        headerRow.style.justifyContent = 'space-between';
        headerRow.style.alignItems = 'center';
        headerRow.style.marginBottom = '8px';

        const title = document.createElement('div');
        title.className = 'editor-section-title';
        title.textContent = 'OpenType Features';
        title.style.margin = '0';

        const resetButton = document.createElement('button');
        resetButton.className = 'feature-reset-button';
        resetButton.textContent = 'Reset';
        resetButton.style.fontSize = '11px';
        resetButton.style.padding = '2px 8px';
        resetButton.style.cursor = 'pointer';
        resetButton.style.opacity = '0.5';
        resetButton.style.pointerEvents = 'none';
        resetButton.disabled = true;

        resetButton.addEventListener('click', () => {
            this.resetFeaturesToDefaults();
        });

        headerRow.appendChild(title);
        headerRow.appendChild(resetButton);
        tempContainer.appendChild(headerRow);

        // Store reset button reference
        this.featureResetButton = resetButton;

        // Initialize default states and current states
        features.forEach((feature: any) => {
            this.defaultFeatureSettings[feature.tag] = feature.defaultOn;
            if (this.featureSettings[feature.tag] === undefined) {
                this.featureSettings[feature.tag] = feature.defaultOn;
            }
        });

        // Track availability based on the same condition used for sidebar buttons
        this.featureAvailabilityInEditingSubset = {};
        features.forEach((feature: any) => {
            this.featureAvailabilityInEditingSubset[feature.tag] =
                feature.availableInEditingFont !== false;
        });

        // Create button for each feature (no separate scrollable container)
        features.forEach((feature: any) => {
            const featureRow = document.createElement('div');
            featureRow.className = 'editor-feature-row';
            featureRow.style.display = 'flex';
            featureRow.style.alignItems = 'center';
            featureRow.style.gap = '8px';
            featureRow.style.fontSize = '12px';
            featureRow.style.padding = '2px 0';

            // Add GSUB/GPOS indicator
            const tableIndicator = document.createElement('div');
            tableIndicator.className = 'feature-table-indicator';
            tableIndicator.style.width = '11px';
            tableIndicator.style.height = '12px';
            tableIndicator.style.display = 'flex';
            tableIndicator.style.alignItems = 'center';
            tableIndicator.style.justifyContent = 'space-between';
            tableIndicator.style.flexShrink = '0';

            const tables = feature.tables || [];
            const hasGSUB = tables.includes('GSUB');
            const hasGPOS = tables.includes('GPOS');

            // GSUB indicator (left side)
            const gsubCircle = document.createElement('div');
            gsubCircle.style.width = '4px';
            gsubCircle.style.height = '4px';
            gsubCircle.style.borderRadius = '50%';
            gsubCircle.style.backgroundColor = 'var(--text-primary)';
            if (hasGSUB) {
                gsubCircle.style.opacity = '0.7';
                gsubCircle.title = 'GSUB';
            } else {
                gsubCircle.style.opacity = '0.1';
            }
            tableIndicator.appendChild(gsubCircle);

            // GPOS indicator (right side)
            const gposCircle = document.createElement('div');
            gposCircle.style.width = '4px';
            gposCircle.style.height = '4px';
            gposCircle.style.borderRadius = '50%';
            gposCircle.style.backgroundColor = 'var(--text-primary)';
            if (hasGPOS) {
                gposCircle.style.opacity = '0.7';
                gposCircle.title = 'GPOS';
            } else {
                gposCircle.style.opacity = '0.1';
            }
            tableIndicator.appendChild(gposCircle);

            featureRow.appendChild(tableIndicator);

            const tagButton = document.createElement('button');
            tagButton.className = 'editor-feature-tag-button tag-button';
            tagButton.setAttribute('data-feature-tag', feature.tag);
            tagButton.textContent = feature.tag;

            // Set initial state
            const isEnabled = this.featureSettings[feature.tag];
            tagButton.classList.toggle('enabled', isEnabled);

            // Disable if not available in editing font
            const isAvailable =
                this.featureAvailabilityInEditingSubset[feature.tag] !== false;
            if (!isAvailable) {
                tagButton.disabled = true;
                tagButton.style.opacity = '0.4';
                tagButton.style.cursor = 'not-allowed';
                tagButton.title = 'Not available in current subset';
            }

            tagButton.addEventListener('click', () => {
                if (!isAvailable) return;
                console.log('[Features]', `Toggling feature ${feature.tag}`);
                this.featureSettings[feature.tag] =
                    !this.featureSettings[feature.tag];
                tagButton.classList.toggle(
                    'enabled',
                    this.featureSettings[feature.tag]
                );
                console.log(
                    '[Features]',
                    `Feature ${feature.tag} is now ${this.featureSettings[feature.tag] ? 'enabled' : 'disabled'}`
                );
                if (!isAvailable) {
                    descSpan.style.opacity = '0.4';
                }
                this.updateFeatureResetButton();
                console.log('[Features]', 'Calling change callback');
                this.call('change');
            });

            const descSpan = document.createElement('span');
            descSpan.className = 'editor-feature-description tag-description';
            if (feature.hasCustomName) {
                descSpan.classList.add('custom-name');
            }
            // Extract just the feature name (before the dash)
            const shortDesc = feature.description.split(' - ')[0];
            descSpan.textContent = shortDesc;

            featureRow.appendChild(tagButton);
            featureRow.appendChild(descSpan);
            tempContainer.appendChild(featureRow);
        });

        // Swap content in one frame to prevent flicker
        requestAnimationFrame(() => {
            this.featuresSection!.innerHTML = '';
            while (tempContainer.firstChild) {
                this.featuresSection!.appendChild(tempContainer.firstChild);
            }
        });

        this.updateFeatureResetButton();

        // Notify listeners that feature state/UI has been fully refreshed.
        // This allows external state synchronizers to capture initial/default states
        // (e.g. default-on features like kern) without implying a user change.
        this.call('updated');

        console.log('[Features]', `Created ${features.length} feature buttons`);
    }

    updateFeatureResetButton() {
        if (!this.featureResetButton) return;

        // Check if any feature is not in default state
        const isNonDefault = Object.keys(this.featureSettings).some((tag) => {
            return (
                this.featureSettings[tag] !== this.defaultFeatureSettings[tag]
            );
        });

        if (isNonDefault) {
            this.featureResetButton.style.opacity = '1';
            this.featureResetButton.style.pointerEvents = 'auto';
            this.featureResetButton.disabled = false;
        } else {
            this.featureResetButton.style.opacity = '0.5';
            this.featureResetButton.style.pointerEvents = 'none';
            this.featureResetButton.disabled = true;
        }
    }

    resetFeaturesToDefaults() {
        // Reset all features to their default states
        Object.keys(this.defaultFeatureSettings).forEach((tag) => {
            this.featureSettings[tag] = this.defaultFeatureSettings[tag];
        });

        // Update buttons
        if (this.featuresSection) {
            const buttons = this.featuresSection.querySelectorAll(
                'button[data-feature-tag]'
            );
            buttons.forEach((button) => {
                const tag = button.getAttribute('data-feature-tag');
                const isEnabled = this.defaultFeatureSettings[tag!];
                button.classList.toggle('enabled', isEnabled);
            });
        }

        this.updateFeatureResetButton();
        this.call('change');
    }

    getHarfBuzzFeatures() {
        // Build HarfBuzz feature string from feature settings
        // Format: "liga=1,dlig=0,kern=1" or undefined if no features
        const featureParts = [];

        for (const [tag, enabled] of Object.entries(this.featureSettings)) {
            featureParts.push(`${tag}=${enabled ? 1 : 0}`);
        }

        // Return undefined if no features (allows HarfBuzz to use defaults)
        return featureParts.length > 0 ? featureParts.join(',') : undefined;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { FeaturesManager };
}
