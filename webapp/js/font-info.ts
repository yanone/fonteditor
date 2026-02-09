/**
 * Font Info View Manager
 * Handles switching between Names and Features tabs in the font info view
 */

import { Logger } from './logger';
import type { Babelfont } from './babelfont';
import { getFeatureDescription } from './opentype-features';
const console = new Logger('FontInfo');

const FONTINFO_TAB_STORAGE_KEY = 'fontinfo-selected-tab';

type FontInfoTab = 'names' | 'features';
type FeatureItemType = 'prefix' | 'class' | 'feature';

interface SelectedItem {
    type: FeatureItemType;
    key: string | number; // string for prefix/class, number (index) for feature
}

class FontInfoManager {
    private currentTab: FontInfoTab = 'names';
    private namesTab: HTMLElement | null = null;
    private featuresTab: HTMLElement | null = null;
    private featuresEditor: any = null;
    private featuresEditorInitialized = false;
    private selectedItem: SelectedItem | null = null;
    private prefixListItems: Map<string, HTMLElement> = new Map();
    private classListItems: Map<string, HTMLElement> = new Map();
    private featureListItems: Map<number, HTMLElement> = new Map();
    private fontDataLoaded = false;

    init() {
        const viewContent = document.querySelector(
            '#view-fontinfo .view-content'
        );
        if (!viewContent) {
            console.error('Font info view content not found');
            return;
        }

        // Create tab selector buttons in title bar
        this.createTabButtons();

        // Create content containers
        this.createContentContainers(viewContent as HTMLElement);

        // Show saved or default tab (defer to ensure DOM is ready)
        const savedTab = this.getSavedTab();
        requestAnimationFrame(() => {
            this.switchTab(savedTab);
        });

        // Also re-apply tab state after layout is restored (resizer.js runs after 100ms)
        setTimeout(() => {
            this.switchTab(this.currentTab);
        }, 150);

        // Listen for font changes
        window.addEventListener('fontLoaded', () => this.onFontLoaded());

        console.log('[FontInfo] Initialized');
    }

    private getSavedTab(): FontInfoTab {
        const saved = localStorage.getItem(FONTINFO_TAB_STORAGE_KEY);
        if (saved === 'names' || saved === 'features') {
            return saved;
        }
        return 'names'; // Default to names tab
    }

    private createTabButtons() {
        const titleBar = document.querySelector(
            '#view-fontinfo .view-title-bar'
        );
        if (!titleBar) return;

        // Create view-title-right container if it doesn't exist
        let titleBarRight = titleBar.querySelector(
            '.view-title-right'
        ) as HTMLElement;
        if (!titleBarRight) {
            titleBarRight = document.createElement('div');
            titleBarRight.className = 'view-title-right';
            titleBar.appendChild(titleBarRight);
        }

        // Clear existing content
        titleBarRight.innerHTML = '';

        // Create Names button
        const namesButton = document.createElement('button');
        namesButton.className = 'view-title-button context-tab';
        namesButton.setAttribute('data-tab', 'names');
        namesButton.textContent = 'Names';
        namesButton.addEventListener('click', () => this.switchTab('names'));

        // Create Features button
        const featuresButton = document.createElement('button');
        featuresButton.className = 'view-title-button context-tab';
        featuresButton.setAttribute('data-tab', 'features');
        featuresButton.textContent = 'Features';
        featuresButton.addEventListener('click', () =>
            this.switchTab('features')
        );

        titleBarRight.appendChild(namesButton);
        titleBarRight.appendChild(featuresButton);
    }

    private createContentContainers(viewContent: HTMLElement) {
        // Store existing content as Names tab
        this.namesTab = document.createElement('div');
        this.namesTab.id = 'fontinfo-names-content';
        this.namesTab.style.display = 'none';
        this.namesTab.style.height = '100%';
        this.namesTab.style.overflow = 'auto';

        // Move existing content to Names tab
        while (viewContent.firstChild) {
            this.namesTab.appendChild(viewContent.firstChild);
        }

        // Create Features tab
        this.featuresTab = document.createElement('div');
        this.featuresTab.id = 'fontinfo-features-content';
        this.featuresTab.style.display = 'none';
        this.featuresTab.style.height = '100%';
        this.featuresTab.style.overflow = 'hidden';
        this.featuresTab.innerHTML = `
            <div class="features-container">
                <div class="features-sidebar">
                    <div class="editor-section-title">Prefixes</div>
                    <div class="features-list" id="prefixes-list"></div>
                    <div class="editor-section-title">Classes</div>
                    <div class="features-list" id="classes-list"></div>
                    <div class="editor-section-title">Features</div>
                    <div class="features-list" id="features-list"></div>
                </div>
                <div class="features-editor-container">
                    <div class="features-editor-legend">
                        <label class="feature-auto-checkbox">
                            <input type="checkbox" id="feature-automatic-checkbox" />
                            <span>Automatically Generated</span>
                        </label>
                    </div>
                    <div class="features-editor" id="features-editor"></div>
                </div>
            </div>
        `;

        viewContent.appendChild(this.namesTab);
        viewContent.appendChild(this.featuresTab);

        // Set up automatic checkbox handler
        const autoCheckbox = this.featuresTab.querySelector(
            '#feature-automatic-checkbox'
        ) as HTMLInputElement;
        if (autoCheckbox) {
            autoCheckbox.addEventListener('change', () =>
                this.onAutomaticCheckboxChanged()
            );
        }
    }

    private initializeFeaturesEditor() {
        if (!window.ace) {
            console.error('Ace Editor not loaded');
            return;
        }

        const editorContainer = document.getElementById('features-editor');
        if (!editorContainer) {
            console.error('Features editor container not found');
            return;
        }

        // Create Ace editor
        this.featuresEditor = window.ace.edit('features-editor');

        // Set theme based on current theme preference
        const getInitialTheme = () => {
            const savedTheme =
                localStorage.getItem('preferred-theme') || 'auto';
            if (savedTheme === 'auto') {
                const isDark = window.matchMedia(
                    '(prefers-color-scheme: dark)'
                ).matches;
                return isDark ? 'ace/theme/monokai' : 'ace/theme/chrome';
            }
            return savedTheme === 'light'
                ? 'ace/theme/chrome'
                : 'ace/theme/monokai';
        };

        this.featuresEditor.setTheme(getInitialTheme());
        this.featuresEditor.session.setMode('ace/mode/text'); // Could be a custom FEA mode later
        this.featuresEditor.setOptions({
            fontSize: '12px',
            fontFamily: "'IBM Plex Mono', monospace",
            showPrintMargin: false,
            highlightActiveLine: true,
            enableBasicAutocompletion: false,
            enableLiveAutocompletion: false,
            showGutter: true,
            showLineNumbers: true,
            wrap: false
        });

        // Set up change handler
        this.featuresEditor.on('change', () => this.onFeatureCodeChanged());

        console.log('[FontInfo] Features editor initialized');
    }

    private switchTab(tab: FontInfoTab) {
        this.currentTab = tab;

        // Save to localStorage
        localStorage.setItem(FONTINFO_TAB_STORAGE_KEY, tab);

        // Update button states - use a small delay to ensure DOM is updated
        requestAnimationFrame(() => {
            const buttons = document.querySelectorAll(
                '#view-fontinfo .context-tab'
            );
            console.log(
                `[FontInfo] Found ${buttons.length} buttons when switching to ${tab}`
            );
            buttons.forEach((button) => {
                const buttonTab = button.getAttribute('data-tab');
                if (buttonTab === tab) {
                    button.classList.add('active');
                    console.log(`[FontInfo] Activated button: ${buttonTab}`);
                } else {
                    button.classList.remove('active');
                }
            });
        });

        // Show/hide content
        if (this.namesTab) {
            this.namesTab.style.display = tab === 'names' ? 'block' : 'none';
        }
        if (this.featuresTab) {
            this.featuresTab.style.display =
                tab === 'features' ? 'block' : 'none';
        }

        // Initialize Ace editor and load content when switching to features tab
        if (tab === 'features') {
            // Initialize editor lazily on first show
            if (!this.featuresEditorInitialized) {
                this.initializeFeaturesEditor();
                this.featuresEditorInitialized = true;
            }
            // Load font data if available and not already loaded
            if (window.currentFontModel && !this.fontDataLoaded) {
                console.log('[FontInfo] Loading features lists (switchTab)');
                this.loadAllLists();
                this.fontDataLoaded = true;
            }
        }

        console.log(`[FontInfo] Switched to ${tab} tab`);
    }

    private onFontLoaded() {
        console.log(
            `[FontInfo] Font loaded event, current tab: ${this.currentTab}`
        );
        // Reset font data loaded flag for new font
        this.fontDataLoaded = false;
        // Clear editor state
        this.selectedItem = null;
        this.prefixListItems.clear();
        this.classListItems.clear();
        this.featureListItems.clear();
        // Load features data if we're on the features tab
        if (this.currentTab === 'features' && window.currentFontModel) {
            console.log('[FontInfo] Loading features lists (onFontLoaded)');
            // Defer to ensure font model is fully available and DOM is ready
            requestAnimationFrame(() => {
                this.loadAllLists();
                this.fontDataLoaded = true;
            });
        }
    }

    private loadAllLists() {
        console.log('[FontInfo] loadAllLists called');
        this.loadPrefixesList();
        this.loadClassesList();
        this.loadFeaturesList();
    }

    private loadPrefixesList() {
        const listContainer = document.getElementById('prefixes-list');
        console.log('[FontInfo] loadPrefixesList - container:', listContainer);
        if (!listContainer) return;

        const font = window.currentFontModel;
        if (!font || !font.features || !font.features.prefixes) {
            listContainer.innerHTML =
                '<div class="features-empty">No prefixes</div>';
            return;
        }

        const prefixes = font.features.prefixes;
        const prefixKeys = Object.keys(prefixes);
        console.log('[FontInfo] Found', prefixKeys.length, 'prefixes');

        if (prefixKeys.length === 0) {
            listContainer.innerHTML =
                '<div class="features-empty">No prefixes</div>';
            return;
        }

        this.prefixListItems.clear();
        listContainer.innerHTML = '';

        prefixKeys.forEach((key) => {
            const item = this.createListItem('prefix', key, prefixes[key]);
            this.prefixListItems.set(key, item);
            listContainer.appendChild(item);
        });
    }

    private loadClassesList() {
        const listContainer = document.getElementById('classes-list');
        if (!listContainer) return;

        const font = window.currentFontModel;
        if (!font || !font.features || !font.features.classes) {
            listContainer.innerHTML =
                '<div class="features-empty">No classes</div>';
            return;
        }

        const classes = font.features.classes;
        const classKeys = Object.keys(classes);

        if (classKeys.length === 0) {
            listContainer.innerHTML =
                '<div class="features-empty">No classes</div>';
            return;
        }

        this.classListItems.clear();
        listContainer.innerHTML = '';

        classKeys.forEach((key) => {
            const item = this.createListItem('class', key, classes[key]);
            this.classListItems.set(key, item);
            listContainer.appendChild(item);
        });
    }

    private loadFeaturesList() {
        const listContainer = document.getElementById('features-list');
        console.log('[FontInfo] loadFeaturesList - container:', listContainer);
        if (!listContainer) return;

        const font = window.currentFontModel;
        if (!font || !font.features) {
            listContainer.innerHTML =
                '<div class="features-empty">No features</div>';
            return;
        }

        const features = font.features.features || [];
        console.log('[FontInfo] Found', features.length, 'features');

        if (features.length === 0) {
            listContainer.innerHTML =
                '<div class="features-empty">No features</div>';
            return;
        }

        // Build feature list
        this.featureListItems.clear();
        listContainer.innerHTML = '';

        features.forEach(
            (
                [tag, codeData]: [string, Babelfont.PossiblyAutomaticCode],
                index: number
            ) => {
                const item = this.createListItem(
                    'feature',
                    index,
                    codeData,
                    tag
                );
                this.featureListItems.set(index, item);
                listContainer.appendChild(item);
            }
        );

        // Select first item if none selected
        if (!this.selectedItem && features.length > 0) {
            this.selectItem('feature', 0);
        } else if (
            this.selectedItem?.type === 'feature' &&
            typeof this.selectedItem.key === 'number' &&
            this.selectedItem.key >= features.length
        ) {
            this.selectItem('feature', features.length - 1);
        } else if (this.selectedItem) {
            // Re-select current item to refresh
            this.selectItem(this.selectedItem.type, this.selectedItem.key);
        }
    }

    private createListItem(
        type: FeatureItemType,
        key: string | number,
        codeData: Babelfont.PossiblyAutomaticCode,
        tag?: string
    ): HTMLElement {
        const item = document.createElement('div');
        item.className = 'feature-list-item';

        // For features, show GSUB/GPOS indicators and feature name
        if (type === 'feature' && tag) {
            // GSUB/GPOS indicators (placeholder)
            const tableIndicator = document.createElement('div');
            tableIndicator.className = 'feature-table-indicator';

            const gsubCircle = document.createElement('div');
            gsubCircle.className = 'feature-table-circle';
            gsubCircle.title = 'GSUB';
            tableIndicator.appendChild(gsubCircle);

            const gposCircle = document.createElement('div');
            gposCircle.className = 'feature-table-circle';
            gposCircle.title = 'GPOS';
            tableIndicator.appendChild(gposCircle);

            item.appendChild(tableIndicator);

            // Feature tag (4-digit code)
            const tagSpan = document.createElement('span');
            tagSpan.className = 'feature-tag';
            tagSpan.textContent = tag;
            item.appendChild(tagSpan);

            // Feature name
            const description = getFeatureDescription(tag);
            const nameSpan = document.createElement('span');
            nameSpan.className = 'feature-name';
            nameSpan.textContent = description.split(' - ')[0] || tag;
            item.appendChild(nameSpan);
        } else {
            // For prefixes and classes, show the key in feature-name style
            const nameSpan = document.createElement('span');
            nameSpan.className = 'feature-name';
            nameSpan.textContent = String(key);
            item.appendChild(nameSpan);
        }

        // Automatic generation indicator
        if (codeData.automatic) {
            const autoIcon = document.createElement('span');
            autoIcon.className = 'material-symbols-outlined feature-auto-icon';
            autoIcon.textContent = 'manufacturing';
            autoIcon.title = 'Automatically generated';
            item.appendChild(autoIcon);
        }

        item.addEventListener('click', () => this.selectItem(type, key));

        return item;
    }

    private selectItem(type: FeatureItemType, key: string | number) {
        const font = window.currentFontModel;
        if (!font || !font.features) return;

        let codeData: Babelfont.PossiblyAutomaticCode | undefined;
        let label = '';

        // Get the code data based on type
        if (type === 'prefix') {
            if (typeof key !== 'string') return;
            codeData = font.features.prefixes?.[key];
            label = `prefix: ${key}`;
        } else if (type === 'class') {
            if (typeof key !== 'string') return;
            codeData = font.features.classes?.[key];
            label = `class: ${key}`;
        } else if (type === 'feature') {
            if (typeof key !== 'number') return;
            const features = font.features.features || [];
            if (key < 0 || key >= features.length) return;
            const [tag, code] = features[key];
            codeData = code;
            label = `feature: ${tag}`;
        }

        if (!codeData) return;

        this.selectedItem = { type, key };

        // Update all list item states
        this.prefixListItems.forEach((item) =>
            item.classList.remove('selected')
        );
        this.classListItems.forEach((item) =>
            item.classList.remove('selected')
        );
        this.featureListItems.forEach((item) =>
            item.classList.remove('selected')
        );

        // Highlight selected item
        const selectedElement =
            type === 'prefix'
                ? this.prefixListItems.get(key as string)
                : type === 'class'
                  ? this.classListItems.get(key as string)
                  : this.featureListItems.get(key as number);

        if (selectedElement) {
            selectedElement.classList.add('selected');
        }

        // Load code into editor
        if (this.featuresEditor) {
            this.featuresEditor.setValue(codeData.code || '', -1);
        }

        // Update automatic checkbox
        const autoCheckbox = document.getElementById(
            'feature-automatic-checkbox'
        ) as HTMLInputElement;
        if (autoCheckbox) {
            autoCheckbox.checked = codeData.automatic || false;
        }

        console.log(`[FontInfo] Selected ${label}`);
    }

    private clearEditor() {
        this.selectedItem = null;
        if (this.featuresEditor) {
            this.featuresEditor.setValue('', -1);
        }
        const autoCheckbox = document.getElementById(
            'feature-automatic-checkbox'
        ) as HTMLInputElement;
        if (autoCheckbox) {
            autoCheckbox.checked = false;
            autoCheckbox.disabled = true;
        }
    }

    private onFeatureCodeChanged() {
        const font = window.currentFontModel;
        if (!font || !font.features || !this.selectedItem) return;

        const { type, key } = this.selectedItem;
        let codeData: Babelfont.PossiblyAutomaticCode | undefined;

        if (type === 'prefix' && typeof key === 'string') {
            codeData = font.features.prefixes?.[key];
        } else if (type === 'class' && typeof key === 'string') {
            codeData = font.features.classes?.[key];
        } else if (type === 'feature' && typeof key === 'number') {
            const features = font.features.features || [];
            if (key < features.length) {
                codeData = features[key][1];
            }
        }

        if (!codeData) return;

        const newCode = this.featuresEditor.getValue();
        codeData.code = newCode;

        // Mark font as dirty
        if (window.fontManager?.currentFont) {
            window.fontManager.currentFont.markDirty();
        }
    }

    private onAutomaticCheckboxChanged() {
        const font = window.currentFontModel;
        if (!font || !font.features || !this.selectedItem) return;

        const { type, key } = this.selectedItem;
        let codeData: Babelfont.PossiblyAutomaticCode | undefined;

        if (type === 'prefix' && typeof key === 'string') {
            codeData = font.features.prefixes?.[key];
        } else if (type === 'class' && typeof key === 'string') {
            codeData = font.features.classes?.[key];
        } else if (type === 'feature' && typeof key === 'number') {
            const features = font.features.features || [];
            if (key < features.length) {
                codeData = features[key][1];
            }
        }

        if (!codeData) return;

        const autoCheckbox = document.getElementById(
            'feature-automatic-checkbox'
        ) as HTMLInputElement;

        if (autoCheckbox) {
            codeData.automatic = autoCheckbox.checked;

            // Update the indicator in the list
            this.loadAllLists();

            // Mark font as dirty
            if (window.fontManager?.currentFont) {
                window.fontManager.currentFont.markDirty();
            }
        }
    }

    /**
     * Update editor theme when app theme changes
     */
    updateEditorTheme(theme: 'light' | 'dark') {
        if (this.featuresEditor) {
            const aceTheme =
                theme === 'light' ? 'ace/theme/chrome' : 'ace/theme/monokai';
            this.featuresEditor.setTheme(aceTheme);
        }
    }
}

// Create singleton instance
const fontInfoManager = new FontInfoManager();

// Export for global access
(window as any).fontInfoManager = fontInfoManager;

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => fontInfoManager.init());
} else {
    fontInfoManager.init();
}

export { fontInfoManager };
