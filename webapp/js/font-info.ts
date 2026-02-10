/**
 * Font Info View Manager
 * Handles switching between Names and Features tabs in the font info view
 */

import { Logger } from './logger';
import type { Babelfont } from './babelfont';
import {
    getFeatureDescription,
    getFeatureExecutionOrder,
    isDiscretionary,
    SCRIPT_TO_SHAPER
} from './opentype-features';
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
    private selectedShaper: string = 'default';
    private draggedFeatureIndex: number | null = null;

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

        // Listen for font changes - use fontReady which fires after currentFontModel is set
        window.addEventListener('fontReady', () => this.onFontLoaded());

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
                <div class="features-sidebar view-sidebar view-sidebar-left">
                    <div class="sidebar-section-title">Prefixes</div>
                    <div class="features-list sidebar-list" id="prefixes-list"></div>
                    <div class="sidebar-section-title">Classes</div>
                    <div class="features-list sidebar-list" id="classes-list"></div>
                    <div class="sidebar-section-title">Features</div>
                    <div class="features-list sidebar-list" id="features-list"></div>
                </div>
                <div class="features-editor-container">
                    <div class="glyph-filter-legend">
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
            wrap: true
        });
        // Enable indented soft wrap on the session (must be set on session, not editor)
        this.featuresEditor.session.setOption('indentedSoftWrap', true);

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
        if (this.currentTab === 'features') {
            console.log('[FontInfo] Loading features lists (onFontLoaded)');
            // Ensure editor is initialized before loading data
            if (!this.featuresEditorInitialized) {
                this.initializeFeaturesEditor();
                this.featuresEditorInitialized = true;
            }
            // Defer to ensure font model is fully available and DOM is ready
            requestAnimationFrame(() => {
                if (window.currentFontModel) {
                    this.loadAllLists();
                    this.fontDataLoaded = true;
                }
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

    private extractLanguageSystems(): string[] {
        const font = window.currentFontModel;
        if (!font || !font.features) return ['DFLT'];

        const scripts = new Set<string>();
        scripts.add('DFLT'); // Always include default

        // Parse all feature code for languagesystem declarations
        const allCode: string[] = [];

        // Collect from prefixes
        if (font.features.prefixes) {
            Object.values(font.features.prefixes).forEach((prefix) => {
                if (prefix.code) allCode.push(prefix.code);
            });
        }

        // Collect from features
        if (font.features.features) {
            font.features.features.forEach(([_, codeData]) => {
                if (codeData.code) allCode.push(codeData.code);
            });
        }

        // Parse languagesystem declarations
        const languageSystemRegex = /languagesystem\s+(\w+)\s+\w+/gi;
        allCode.forEach((code) => {
            let match;
            while ((match = languageSystemRegex.exec(code)) !== null) {
                scripts.add(match[1]);
            }
        });

        return Array.from(scripts).sort();
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

        // Detect supported scripts and create dropdown
        const supportedScripts = this.extractLanguageSystems();
        console.log('[FontInfo] Supported scripts:', supportedScripts);

        // Map scripts to shapers and deduplicate
        const shaperMap = new Map<string, string[]>(); // shaper -> [scripts]
        supportedScripts.forEach((script) => {
            const shaper = SCRIPT_TO_SHAPER[script] || 'default';
            if (!shaperMap.has(shaper)) {
                shaperMap.set(shaper, []);
            }
            shaperMap.get(shaper)!.push(script);
        });

        // Get unique shapers sorted alphabetically
        const availableShapers = Array.from(shaperMap.keys()).sort();

        // Ensure selectedShaper is valid, otherwise use first available
        if (
            !availableShapers.includes(this.selectedShaper) &&
            availableShapers.length > 0
        ) {
            this.selectedShaper = availableShapers[0];
            console.log(
                '[FontInfo] Defaulting to shaper:',
                this.selectedShaper
            );
        }

        // Build feature list with shaper dropdown
        // Save scroll position before rebuilding
        const sidebar = listContainer.closest('.features-sidebar');
        const wasAtBottom = sidebar ? 
            (sidebar.scrollHeight - sidebar.scrollTop - sidebar.clientHeight < 5) : false;
        
        this.featureListItems.clear();
        listContainer.innerHTML = '';

        // Add shaper selector dropdown if multiple shapers
        if (availableShapers.length > 1) {
            const scriptSelectorContainer = document.createElement('div');
            scriptSelectorContainer.className = 'feature-script-selector';
            scriptSelectorContainer.style.cssText = `
                margin-bottom: 8px;
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 11px;
            `;

            const label = document.createElement('span');
            label.textContent = 'Shaper:';
            label.style.color = 'var(--text-secondary)';

            const select = document.createElement('select');
            select.className = 'feature-script-dropdown';
            select.style.cssText = `
                flex: 1;
                padding: 4px 8px;
                background: var(--input-bg);
                color: var(--text-primary);
                border: 1px solid var(--border-primary);
                border-radius: 4px;
                font-family: var(--font-families-mono);
                font-size: 11px;
                cursor: pointer;
            `;

            availableShapers.forEach((shaper) => {
                const option = document.createElement('option');
                option.value = shaper;
                // Capitalize shaper name for display
                const displayName =
                    shaper.charAt(0).toUpperCase() + shaper.slice(1);
                option.textContent = displayName;
                if (shaper === this.selectedShaper) {
                    option.selected = true;
                }
                select.appendChild(option);
            });

            select.addEventListener('change', () => {
                this.selectedShaper = select.value;
                console.log(
                    '[FontInfo] Shaper changed to:',
                    this.selectedShaper
                );
                this.loadFeaturesList(); // Reload with new shaper order
            });

            scriptSelectorContainer.appendChild(label);
            scriptSelectorContainer.appendChild(select);
            listContainer.appendChild(scriptSelectorContainer);
        }

        // Get feature execution order for selected shaper
        const executionOrder = getFeatureExecutionOrder(this.selectedShaper);
        console.log(
            '[FontInfo] Execution order for',
            this.selectedShaper,
            ':',
            executionOrder
        );

        // Build categorized feature lists
        const categorized = this.categorizeFeaturesByScript(
            features,
            executionOrder,
            supportedScripts
        );

        // Helper to add section header
        const addSectionHeader = (text: string) => {
            const separator = document.createElement('div');
            separator.className = 'feature-section-separator';
            separator.style.cssText = `
                padding: 6px 12px;
                font-size: 10px;
                color: var(--text-secondary);
                opacity: 0.5;
                font-weight: 500;
                letter-spacing: 0.05em;
                text-transform: uppercase;
                margin-top: 8px;
            `;
            separator.textContent = text;
            listContainer.appendChild(separator);
        };

        // Add features by category
        if (categorized.usedByShaper.length > 0) {
            const shaperDisplayName =
                this.selectedShaper.charAt(0).toUpperCase() +
                this.selectedShaper.slice(1);
            addSectionHeader(`Used by ${shaperDisplayName} shaper`);
            categorized.usedByShaper.forEach(
                ({
                    tag,
                    codeData,
                    index,
                    isDiscretionary: isDisc,
                    isUserFeature
                }) => {
                    const item = this.createListItem(
                        'feature',
                        index,
                        codeData,
                        tag,
                        isDisc,
                        isUserFeature
                    );
                    this.featureListItems.set(index, item);
                    listContainer.appendChild(item);
                }
            );
        }

        if (categorized.notInLanguagesystem.length > 0) {
            addSectionHeader('Not in languagesystem');
            categorized.notInLanguagesystem.forEach(
                ({
                    tag,
                    codeData,
                    index,
                    isDiscretionary: isDisc,
                    isUserFeature
                }) => {
                    const item = this.createListItem(
                        'feature',
                        index,
                        codeData,
                        tag,
                        isDisc,
                        isUserFeature
                    );
                    this.featureListItems.set(index, item);
                    listContainer.appendChild(item);
                }
            );
        }

        if (categorized.discretionary.length > 0) {
            addSectionHeader('Discretionary (sortable)');
            categorized.discretionary.forEach(
                ({
                    tag,
                    codeData,
                    index,
                    isDiscretionary: isDisc,
                    isUserFeature
                }) => {
                    const item = this.createListItem(
                        'feature',
                        index,
                        codeData,
                        tag,
                        isDisc,
                        isUserFeature
                    );
                    this.featureListItems.set(index, item);
                    listContainer.appendChild(item);
                }
            );
        }

        // Post-USER FEATURES section (features that come after '--- USER FEATURES ---' marker)
        if (categorized.postUserFeatures.length > 0) {
            const shaperDisplayName =
                this.selectedShaper.charAt(0).toUpperCase() +
                this.selectedShaper.slice(1);
            addSectionHeader(`Used by ${shaperDisplayName} shaper, continued`);
            categorized.postUserFeatures.forEach(
                ({
                    tag,
                    codeData,
                    index,
                    isDiscretionary: isDisc,
                    isUserFeature
                }) => {
                    const item = this.createListItem(
                        'feature',
                        index,
                        codeData,
                        tag,
                        isDisc,
                        isUserFeature
                    );
                    this.featureListItems.set(index, item);
                    listContainer.appendChild(item);
                }
            );
        }

        // "Used by other shapers" section - moved to bottom with 70% opacity
        if (categorized.notUsedByShaper.length > 0) {
            const shaperDisplayName =
                this.selectedShaper.charAt(0).toUpperCase() +
                this.selectedShaper.slice(1);
            addSectionHeader(`Inactive for ${shaperDisplayName} shaper`);
            categorized.notUsedByShaper.forEach(
                ({
                    tag,
                    codeData,
                    index,
                    isDiscretionary: isDisc,
                    isUserFeature
                }) => {
                    const item = this.createListItem(
                        'feature',
                        index,
                        codeData,
                        tag,
                        isDisc,
                        isUserFeature
                    );
                    item.style.opacity = '0.6';
                    this.featureListItems.set(index, item);
                    listContainer.appendChild(item);
                }
            );
        }

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

        // Restore scroll position if was at bottom
        if (wasAtBottom && sidebar) {
            sidebar.scrollTop = sidebar.scrollHeight;
        }
    }

    private categorizeFeaturesByScript(
        features: Array<[string, Babelfont.PossiblyAutomaticCode]>,
        executionOrder: string[],
        supportedScripts: string[]
    ): {
        usedByShaper: Array<{
            tag: string;
            codeData: Babelfont.PossiblyAutomaticCode;
            index: number;
            isDiscretionary: boolean;
            isUserFeature: boolean;
        }>;
        postUserFeatures: Array<{
            tag: string;
            codeData: Babelfont.PossiblyAutomaticCode;
            index: number;
            isDiscretionary: boolean;
            isUserFeature: boolean;
        }>;
        notUsedByShaper: Array<{
            tag: string;
            codeData: Babelfont.PossiblyAutomaticCode;
            index: number;
            isDiscretionary: boolean;
            isUserFeature: boolean;
        }>;
        notInLanguagesystem: Array<{
            tag: string;
            codeData: Babelfont.PossiblyAutomaticCode;
            index: number;
            isDiscretionary: boolean;
            isUserFeature: boolean;
        }>;
        discretionary: Array<{
            tag: string;
            codeData: Babelfont.PossiblyAutomaticCode;
            index: number;
            isDiscretionary: boolean;
            isUserFeature: boolean;
        }>;
    } {
        const usedByShaper: any[] = [];
        const postUserFeatures: any[] = [];
        const notUsedByShaper: any[] = [];
        const notInLanguagesystem: any[] = [];
        const discretionary: any[] = [];

        // Split execution order at '--- USER FEATURES ---' marker
        const userFeaturesIndex = executionOrder.indexOf(
            '--- USER FEATURES ---'
        );
        let preUserFeatures: string[] = [];
        let postUserFeaturesList: string[] = [];

        if (userFeaturesIndex >= 0) {
            preUserFeatures = executionOrder
                .slice(0, userFeaturesIndex)
                .filter((f) => !f.startsWith('---'));
            postUserFeaturesList = executionOrder
                .slice(userFeaturesIndex + 1)
                .filter((f) => !f.startsWith('---'));
        } else {
            // No USER FEATURES marker, treat all as pre-user
            preUserFeatures = executionOrder.filter(
                (f) => !f.startsWith('---')
            );
        }

        const preUserFeaturesSet = new Set(preUserFeatures);
        const postUserFeaturesSet = new Set(postUserFeaturesList);

        features.forEach(([tag, codeData], index) => {
            const isDisc = isDiscretionary(tag);
            const featureData = {
                tag,
                codeData,
                index,
                isDiscretionary: isDisc,
                isUserFeature: isDisc
            };

            if (isDisc) {
                // Discretionary features go in their own category
                discretionary.push(featureData);
            } else {
                if (preUserFeaturesSet.has(tag)) {
                    // Feature before USER FEATURES marker
                    usedByShaper.push(featureData);
                } else if (postUserFeaturesSet.has(tag)) {
                    // Feature after USER FEATURES marker
                    postUserFeatures.push(featureData);
                } else {
                    // Required feature not used by current shaper
                    notUsedByShaper.push(featureData);
                }
            }
        });

        // Sort each category
        // Used by shaper: by execution order (before USER FEATURES)
        usedByShaper.sort((a, b) => {
            const aPos = preUserFeatures.indexOf(a.tag);
            const bPos = preUserFeatures.indexOf(b.tag);
            return aPos - bPos;
        });

        // Post-user features: by execution order (after USER FEATURES)
        postUserFeatures.sort((a, b) => {
            const aPos = postUserFeaturesList.indexOf(a.tag);
            const bPos = postUserFeaturesList.indexOf(b.tag);
            return aPos - bPos;
        });

        // Not used by shaper: alphabetically
        notUsedByShaper.sort((a, b) => a.tag.localeCompare(b.tag));

        // Not in languagesystem: alphabetically
        notInLanguagesystem.sort((a, b) => a.tag.localeCompare(b.tag));

        // Discretionary: by source order
        discretionary.sort((a, b) => a.index - b.index);

        return {
            usedByShaper,
            postUserFeatures,
            notUsedByShaper,
            notInLanguagesystem,
            discretionary
        };
    }

    private createListItem(
        type: FeatureItemType,
        key: string | number,
        codeData: Babelfont.PossiblyAutomaticCode,
        tag?: string,
        isDiscretionaryFeature?: boolean,
        isUserFeature?: boolean
    ): HTMLElement {
        const item = document.createElement('div');
        item.className = 'feature-list-item sidebar-item';

        // Add draggable attribute for discretionary features
        if (isDiscretionaryFeature && isUserFeature) {
            item.setAttribute('draggable', 'true');
            item.classList.add('draggable-feature');
            item.addEventListener('dragstart', (e) =>
                this.onFeatureDragStart(e, key as number)
            );
            item.addEventListener('dragover', (e) => this.onFeatureDragOver(e));
            item.addEventListener('drop', (e) =>
                this.onFeatureDrop(e, key as number)
            );
            item.addEventListener('dragend', () => this.onFeatureDragEnd());
        }

        // For features and prefixes, show GSUB/GPOS indicators
        if (type === 'feature' || type === 'prefix') {
            // Analyze code for GSUB/GPOS content
            const font = window.currentFontModel;
            let analysis = { hasGSUB: false, hasGPOS: false };
            
            if (font) {
                if (type === 'feature' && tag) {
                    analysis = font.analyzeFeatureTables(tag);
                } else if (type === 'prefix' && typeof key === 'string') {
                    analysis = font.analyzePrefix(key);
                }
            }

            // GSUB/GPOS indicators
            const tableIndicator = document.createElement('div');
            tableIndicator.className = 'feature-table-indicator';

            // GSUB indicator (left circle)
            const gsubCircle = document.createElement('div');
            gsubCircle.className = 'feature-table-circle';
            if (analysis.hasGSUB) {
                gsubCircle.style.opacity = '0.7';
                gsubCircle.title = 'GSUB (Glyph Substitution)';
            } else {
                gsubCircle.style.opacity = '0.1';
                gsubCircle.title = '';
            }
            tableIndicator.appendChild(gsubCircle);

            // GPOS indicator (right circle)
            const gposCircle = document.createElement('div');
            gposCircle.className = 'feature-table-circle';
            if (analysis.hasGPOS) {
                gposCircle.style.opacity = '0.7';
                gposCircle.title = 'GPOS (Glyph Positioning)';
            } else {
                gposCircle.style.opacity = '0.1';
                gposCircle.title = '';
            }
            tableIndicator.appendChild(gposCircle);

            item.appendChild(tableIndicator);

            if (type === 'feature' && tag) {
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
                // For prefixes, show the key in feature-name style
                const nameSpan = document.createElement('span');
                nameSpan.className = 'feature-name';
                nameSpan.textContent = String(key);
                item.appendChild(nameSpan);
            }
        } else {
            // For classes, show the key in feature-name style without indicators
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
            // Enable line wrapping for all cases (prefixes, classes, and features)
            this.featuresEditor.session.setUseWrapMode(true);
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

    private onFeatureDragStart(e: DragEvent, index: number) {
        this.draggedFeatureIndex = index;
        const target = e.target as HTMLElement;
        target.classList.add('dragging');
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
        }
    }

    private onFeatureDragOver(e: DragEvent) {
        e.preventDefault();
        if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'move';
        }
    }

    private onFeatureDrop(e: DragEvent, targetIndex: number) {
        e.preventDefault();

        if (
            this.draggedFeatureIndex === null ||
            this.draggedFeatureIndex === targetIndex
        ) {
            return;
        }

        const font = window.currentFontModel;
        if (!font || !font.features || !font.features.features) return;

        const features = font.features.features;
        const draggedTag = features[this.draggedFeatureIndex]?.[0];
        const targetTag = features[targetIndex]?.[0];

        // Only allow reordering discretionary features
        if (
            !draggedTag ||
            !targetTag ||
            !isDiscretionary(draggedTag) ||
            !isDiscretionary(targetTag)
        ) {
            return;
        }

        // Reorder features in the font model
        const [movedFeature] = features.splice(this.draggedFeatureIndex, 1);

        // Adjust target index if moving down
        const adjustedTargetIndex =
            this.draggedFeatureIndex < targetIndex
                ? targetIndex - 1
                : targetIndex;

        features.splice(adjustedTargetIndex, 0, movedFeature);

        // Mark font as dirty
        if (window.fontManager?.currentFont) {
            window.fontManager.currentFont.markDirty();
        }

        // Remember the dragged feature tag to re-select it
        const draggedFeatureTag = movedFeature[0];

        // Reload the list
        this.loadFeaturesList();

        // Re-select the moved feature
        const newIndex = features.findIndex(
            ([tag]) => tag === draggedFeatureTag
        );
        if (newIndex >= 0) {
            this.selectItem('feature', newIndex);
        }
    }

    private onFeatureDragEnd() {
        this.draggedFeatureIndex = null;
        // Reset dragging class
        document.querySelectorAll('.draggable-feature').forEach((item) => {
            item.classList.remove('dragging');
        });
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
