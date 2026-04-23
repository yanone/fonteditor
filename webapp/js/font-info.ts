/**
 * Font Info View Manager
 * Handles switching between Names and Features tabs in the font info view
 */

import { Logger } from './logger';
import type { TransactionHistoryTarget } from './change-bridge';
import type { Babelfont } from './babelfont';
import {
    getFeatureDescription,
    getFeatureExecutionOrder,
    isDiscretionary,
    SCRIPT_TO_SHAPER
} from './opentype-features';
import { extractPrimaryFeatureIssue } from './feature-error-parser';
// Import FEA mode for Ace Editor (registers the mode automatically)
import './mode-fea';
const console = new Logger('FontInfo');

const FONTINFO_TAB_STORAGE_KEY = 'fontinfo-selected-tab';

type FontInfoTab = 'names' | 'features';
type FeatureItemType = 'prefix' | 'class' | 'feature';

interface SelectedItem {
    type: FeatureItemType;
    key: string | number; // string for prefix/class, number (index) for feature
}

interface FeatureErrorSpanIssue {
    start: number;
    end: number;
    message: string;
    category: string;
    coordinateMode?: 'byte' | 'codeUnit';
}

interface SidebarFeatureErrorTarget {
    type: 'prefix' | 'class' | 'feature';
    key: string | number;
    message: string;
}

type FeatureHistoryScopeTarget = {
    type: FeatureItemType;
    key: string;
    label: string;
};

interface FeatureErrorLocation {
    type: 'prefix' | 'class' | 'feature';
    label: string;
}

interface FeatureSourceBlock {
    type: 'prefix' | 'class' | 'feature';
    key: string | number;
    code: string;
    globalByteStart: number;
    globalByteEnd: number;
    codeByteStart: number;
    globalCodeUnitStart: number;
    globalCodeUnitEnd: number;
    codeUnitStart: number;
}

interface ResolvedFeatureSpanTarget {
    target: FeatureSourceBlock;
    coordinateMode: 'byte' | 'codeUnit';
    normalizedStart: number;
    normalizedEnd: number;
}

class FontInfoManager {
    private currentTab: FontInfoTab = 'names';
    private namesTab: HTMLElement | null = null;
    private featuresTab: HTMLElement | null = null;
    private featuresEditor: any = null;
    private featuresEditorInitialized = false;
    private suppressFeatureEditorChange = false;
    private selectedItem: SelectedItem | null = null;
    private selectedFeatureTag: string | null = null;
    private prefixListItems: Map<string, HTMLElement> = new Map();
    private classListItems: Map<string, HTMLElement> = new Map();
    private featureListItems: Map<number, HTMLElement> = new Map();
    private fontDataLoaded = false;
    private selectedShaper: string = 'default';
    private draggedFeatureIndex: number | null = null;
    private featureDropTargetIndex: number | null = null;
    private featureDropTargetPlacement: 'before' | 'after' | null = null;
    private featureCodeDirty = false;

    // Search-related properties
    private searchInput: HTMLInputElement | null = null;
    private searchTerms: string[] = [];
    private prefixCodeData: Map<string, string> = new Map();
    private classCodeData: Map<string, string> = new Map();
    private featureCodeData: Map<number, { tag: string; code: string }> =
        new Map();
    private searchMarkers: number[] = [];
    private classGlyphMembers: Map<string, Set<string>> = new Map();
    private resizeObserver: ResizeObserver | null = null;
    private featureErrorMarkerId: number | null = null;
    private featureErrorTextMarkerId: number | null = null;
    private featureErrorLineWidget: any = null;
    private aceLineWidgetsCtor: any = null;
    private featureErrorTarget: SidebarFeatureErrorTarget | null = null;
    private featureErrorIssue: FeatureErrorSpanIssue | null = null;
    private pendingModelSyncRefresh = false;

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

        // Initialize search for features tab
        this.initFeaturesSearch();

        // Create content containers
        this.createContentContainers(viewContent as HTMLElement);

        // Show saved or default tab (defer to ensure DOM is ready)
        const savedTab = this.getSavedTab();
        requestAnimationFrame(() => {
            this.switchTab(savedTab);
        });

        // Listen for font changes - use fontReady which fires after currentFontModel is set
        window.addEventListener('fontReady', () => this.onFontLoaded());
        window.addEventListener('fontModelSync', () =>
            this.onFontModelSynced()
        );

        // Set up ResizeObserver to resize the Ace editor continuously during dragging
        this.setupResizeObserver();

        // Set up keyboard navigation for feature editor
        this.setupKeyboardNavigation();

        console.log('[FontInfo] Initialized');
    }

    private isViewActive(): boolean {
        const fontInfoView = document.querySelector('#view-fontinfo');
        return fontInfoView?.classList.contains('focused') ?? false;
    }

    private setupResizeObserver() {
        const fontInfoView = document.querySelector('#view-fontinfo');
        if (!fontInfoView) return;

        this.resizeObserver = new ResizeObserver(() => {
            if (this.featuresEditor) {
                this.featuresEditor.resize();
                this.refreshFeatureErrorLineWidgetLayout();
            }
        });

        this.resizeObserver.observe(fontInfoView);
    }

    private setupKeyboardNavigation() {
        document.addEventListener('keydown', (e: KeyboardEvent) => {
            // Only handle arrow keys when font info view is active and features tab is visible
            if (!this.isViewActive()) return;
            if (this.currentTab !== 'features') return;
            if (!this.featuresTab || this.featuresTab.style.display === 'none')
                return;

            // Don't handle if Ace editor has focus
            if (this.featuresEditor && this.featuresEditor.isFocused()) return;

            // Don't handle if focus is in an input or textarea
            const activeElement = document.activeElement;
            if (
                activeElement &&
                (activeElement.tagName === 'INPUT' ||
                    activeElement.tagName === 'TEXTAREA' ||
                    activeElement.getAttribute('contenteditable') === 'true')
            ) {
                return;
            }

            if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.navigateSidebar('up');
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.navigateSidebar('down');
            }
        });
    }

    private getAllSidebarItems(): HTMLElement[] {
        // Get all feature-list-item elements in DOM order (prefixes, then classes, then features)
        if (!this.featuresTab) return [];
        return Array.from(
            this.featuresTab.querySelectorAll('.feature-list-item')
        );
    }

    private navigateSidebar(direction: 'up' | 'down') {
        const items = this.getAllSidebarItems();
        if (items.length === 0) return;

        // Find currently selected item
        let currentIndex = -1;
        if (this.selectedItem) {
            const selectedElement =
                this.selectedItem.type === 'prefix'
                    ? this.prefixListItems.get(this.selectedItem.key as string)
                    : this.selectedItem.type === 'class'
                      ? this.classListItems.get(this.selectedItem.key as string)
                      : this.featureListItems.get(
                            this.selectedItem.key as number
                        );

            if (selectedElement) {
                currentIndex = items.indexOf(selectedElement);
            }
        }

        // Calculate new index
        let newIndex: number;
        if (direction === 'up') {
            newIndex = currentIndex - 1;
            // Don't wrap - stop at top
            if (newIndex < 0) return;
        } else {
            newIndex = currentIndex + 1;
            // Don't wrap - stop at bottom
            if (newIndex >= items.length) return;
        }

        // Get the target item and find its type and key
        const targetItem = items[newIndex];
        if (!targetItem) return;

        // Find the type and key from the stored maps
        let targetType: FeatureItemType | null = null;
        let targetKey: string | number | null = null;

        // Check prefix map
        for (const [key, element] of this.prefixListItems.entries()) {
            if (element === targetItem) {
                targetType = 'prefix';
                targetKey = key;
                break;
            }
        }

        // Check class map
        if (!targetType) {
            for (const [key, element] of this.classListItems.entries()) {
                if (element === targetItem) {
                    targetType = 'class';
                    targetKey = key;
                    break;
                }
            }
        }

        // Check feature map
        if (!targetType) {
            for (const [key, element] of this.featureListItems.entries()) {
                if (element === targetItem) {
                    targetType = 'feature';
                    targetKey = key;
                    break;
                }
            }
        }

        if (targetType && targetKey !== null) {
            this.selectItem(targetType, targetKey, true);
        }
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

        // Remove existing tab buttons but preserve search control
        const existingButtons = titleBarRight.querySelectorAll('.context-tab');
        existingButtons.forEach((btn: Element) => btn.remove());

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

    private initFeaturesSearch() {
        // Find search input in DOM
        this.searchInput = document.getElementById(
            'fontinfo-search-input'
        ) as HTMLInputElement;

        if (this.searchInput) {
            // Listen for input changes
            this.searchInput.addEventListener('input', (e) => {
                const value = (e.target as HTMLInputElement).value.trim();
                this.searchTerms = value
                    .split(/\s+/)
                    .filter((term) => term.length > 0)
                    .map((term) => term.toLowerCase());
                this.applyFeaturesSearch();
            });

            // Listen for keyboard shortcut (Cmd+F)
            document.addEventListener('keydown', (e) => {
                if (
                    (e.metaKey || e.ctrlKey) &&
                    e.key === 'f' &&
                    this.isViewActive() &&
                    this.currentTab === 'features'
                ) {
                    e.preventDefault();
                    if (this.searchInput) {
                        this.searchInput.focus();
                        this.searchInput.select();
                    }
                }

                // Escape key clears selection and filters
                if (
                    e.key === 'Escape' &&
                    this.isViewActive() &&
                    this.currentTab === 'features'
                ) {
                    // Only handle if search input is focused or there's an active selection
                    if (
                        this.searchInput &&
                        this.searchInput === document.activeElement
                    ) {
                        this.searchInput.blur();
                    }
                    if (this.searchTerms.length > 0) {
                        this.searchTerms = [];
                        if (this.searchInput) {
                            this.searchInput.value = '';
                        }
                        this.applyFeaturesSearch();
                    }
                }
            });
        }
    }

    private applyFeaturesSearch() {
        if (!this.featuresTab) return;

        // Get the three list containers
        const prefixesList = document.getElementById('prefixes-list');
        const classesList = document.getElementById('classes-list');
        const featuresList = document.getElementById('features-list');

        // Track visibility of sections
        let hasVisiblePrefixes = false;
        let hasVisibleClasses = false;
        let hasVisibleFeatures = false;

        // Filter prefixes
        if (prefixesList) {
            this.prefixListItems.forEach((element, key) => {
                let visible = true;
                if (this.searchTerms.length > 0) {
                    const codeData = this.prefixCodeData.get(key);
                    const searchText = (
                        key +
                        ' ' +
                        (codeData || '')
                    ).toLowerCase();
                    visible = this.searchTerms.every((term) =>
                        searchText.includes(term)
                    );
                }
                element.style.display = visible ? '' : 'none';
                if (visible) hasVisiblePrefixes = true;
            });
        }

        // Helper function to check if any search term matches a glyph name
        const termMatchesGlyph = (glyphName: string): boolean => {
            const glyphLower = glyphName.toLowerCase();
            return this.searchTerms.every((term) => glyphLower.includes(term));
        };

        // Find all classes that contain matching glyphs (recursively)
        const matchingClasses = new Set<string>();
        if (this.searchTerms.length > 0) {
            this.classGlyphMembers.forEach((_, className) => {
                const allGlyphs = this.getAllGlyphsInClass(className);
                for (const glyph of allGlyphs) {
                    if (termMatchesGlyph(glyph)) {
                        matchingClasses.add(className);
                        break;
                    }
                }
            });
        }

        // Filter classes
        if (classesList) {
            this.classListItems.forEach((element, key) => {
                let visible = true;
                if (this.searchTerms.length > 0) {
                    const codeData = this.classCodeData.get(key);
                    // Check: direct match in name/code OR class contains matching glyph
                    const directMatch = (
                        key +
                        ' ' +
                        (codeData || '')
                    ).toLowerCase();
                    const hasDirectMatch = this.searchTerms.every((term) =>
                        directMatch.includes(term)
                    );
                    const hasMatchingGlyph = matchingClasses.has(key);
                    visible = hasDirectMatch || hasMatchingGlyph;
                }
                element.style.display = visible ? '' : 'none';
                if (visible) hasVisibleClasses = true;
            });
        }

        // Filter features
        if (featuresList) {
            this.featureListItems.forEach((element, key) => {
                let visible = true;
                if (this.searchTerms.length > 0) {
                    const codeData = this.featureCodeData.get(key);
                    const searchText = codeData
                        ? (
                              codeData.tag +
                              ' ' +
                              (codeData.code || '')
                          ).toLowerCase()
                        : '';
                    // Check: direct match in tag/code OR feature references a matching class
                    const hasDirectMatch = this.searchTerms.every((term) =>
                        searchText.includes(term)
                    );
                    // Check if feature references any class that contains matching glyphs
                    let referencesMatchingClass = false;
                    if (codeData?.code) {
                        for (const className of matchingClasses) {
                            const classRef = '@' + className;
                            if (codeData.code.includes(classRef)) {
                                referencesMatchingClass = true;
                                break;
                            }
                        }
                    }
                    visible = hasDirectMatch || referencesMatchingClass;
                }
                element.style.display = visible ? '' : 'none';
                if (visible) hasVisibleFeatures = true;
            });

            // Hide section separators that don't have any visible features
            if (this.searchTerms.length > 0) {
                const allChildren = Array.from(featuresList.children);
                let currentSeparator: Element | null = null;
                let hasVisibleFeatureInSection = false;

                allChildren.forEach((child) => {
                    if (child.classList.contains('feature-section-separator')) {
                        // Hide previous separator if no visible features in its section
                        if (currentSeparator && !hasVisibleFeatureInSection) {
                            (currentSeparator as HTMLElement).style.display =
                                'none';
                        }
                        currentSeparator = child;
                        hasVisibleFeatureInSection = false;
                    } else if (child.classList.contains('feature-list-item')) {
                        if ((child as HTMLElement).style.display !== 'none') {
                            hasVisibleFeatureInSection = true;
                        }
                    }
                });

                // Handle the last separator
                if (currentSeparator && !hasVisibleFeatureInSection) {
                    (currentSeparator as HTMLElement).style.display = 'none';
                }
            } else {
                // Show all separators when no search
                const separators = featuresList.querySelectorAll(
                    '.feature-section-separator'
                );
                separators.forEach((sep: Element) => {
                    (sep as HTMLElement).style.display = '';
                });
            }
        }

        // Show/hide section titles based on whether they have visible items
        const sidebar = this.featuresTab.querySelector('.features-sidebar');
        if (sidebar) {
            const sectionTitles = sidebar.querySelectorAll(
                '.sidebar-section-title'
            );
            sectionTitles.forEach((title: Element, index: number) => {
                let hasVisibleItems = false;
                if (index === 0) hasVisibleItems = hasVisiblePrefixes;
                else if (index === 1) hasVisibleItems = hasVisibleClasses;
                else if (index === 2) hasVisibleItems = hasVisibleFeatures;

                (title as HTMLElement).style.display =
                    hasVisibleItems || this.searchTerms.length === 0
                        ? ''
                        : 'none';
            });
        }

        // Update search highlighting in editor
        this.highlightSearchTermsInEditor();
    }

    private highlightSearchTermsInEditor() {
        if (!this.featuresEditor) return;

        // Clear existing markers
        this.searchMarkers.forEach((id) =>
            this.featuresEditor.session.removeMarker(id)
        );
        this.searchMarkers = [];

        // If no search terms, don't add any markers
        if (this.searchTerms.length === 0) return;

        // Get the Range class from Ace
        const Range = window.ace.require('ace/range').Range;
        const content = this.featuresEditor.getValue();

        // Find and highlight each occurrence of each search term
        this.searchTerms.forEach((term) => {
            // Escape special regex characters in the search term
            const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(escapedTerm, 'gi');
            let match;

            while ((match = regex.exec(content)) !== null) {
                const startPos =
                    this.featuresEditor.session.doc.indexToPosition(
                        match.index
                    );
                const endPos = this.featuresEditor.session.doc.indexToPosition(
                    match.index + match[0].length
                );
                const range = new Range(
                    startPos.row,
                    startPos.column,
                    endPos.row,
                    endPos.column
                );
                const markerId = this.featuresEditor.session.addMarker(
                    range,
                    'ace_search_highlight',
                    'text'
                );
                this.searchMarkers.push(markerId);
            }
        });

        // Also highlight class names that contain matching glyphs
        this.classGlyphMembers.forEach((members, className) => {
            const allGlyphs = this.getAllGlyphsInClass(className);
            const hasMatchingGlyph = Array.from(allGlyphs).some((glyph) => {
                const glyphLower = glyph.toLowerCase();
                return this.searchTerms.every((term) =>
                    glyphLower.includes(term)
                );
            });

            if (hasMatchingGlyph) {
                // Highlight class name references (@ClassName)
                const classRefPattern = new RegExp(
                    '@' + className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                    'g'
                );
                let match;
                while ((match = classRefPattern.exec(content)) !== null) {
                    const startPos =
                        this.featuresEditor.session.doc.indexToPosition(
                            match.index
                        );
                    const endPos =
                        this.featuresEditor.session.doc.indexToPosition(
                            match.index + match[0].length
                        );
                    const range = new Range(
                        startPos.row,
                        startPos.column,
                        endPos.row,
                        endPos.column
                    );
                    const markerId = this.featuresEditor.session.addMarker(
                        range,
                        'ace_search_highlight',
                        'text'
                    );
                    this.searchMarkers.push(markerId);
                }
            }
        });

        // Highlight individual glyph names within class definitions
        const classDefPattern = /@(\w+)\s*=\s*\[([\s\S]*?)\]/g;
        let classDefMatch;
        while ((classDefMatch = classDefPattern.exec(content)) !== null) {
            const className = classDefMatch[1];
            const classContent = classDefMatch[2];
            const classStartIndex =
                classDefMatch.index + classDefMatch[0].indexOf('[') + 1;

            // Check if this class contains matching glyphs
            const allGlyphs = this.getAllGlyphsInClass(className);
            const matchingGlyphs = Array.from(allGlyphs).filter((glyph) => {
                const glyphLower = glyph.toLowerCase();
                return this.searchTerms.every((term) =>
                    glyphLower.includes(term)
                );
            });

            if (matchingGlyphs.length > 0) {
                // Highlight each matching glyph within the class definition
                matchingGlyphs.forEach((glyph) => {
                    const glyphPattern = new RegExp(
                        '(?:(?<=\\s)|(?<=\\[))' +
                            glyph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                            '(?:(?=\\s)|(?=\\]))',
                        'g'
                    );
                    let glyphMatch;
                    while (
                        (glyphMatch = glyphPattern.exec(classContent)) !== null
                    ) {
                        const absoluteIndex =
                            classStartIndex + glyphMatch.index;
                        const startPos =
                            this.featuresEditor.session.doc.indexToPosition(
                                absoluteIndex
                            );
                        const endPos =
                            this.featuresEditor.session.doc.indexToPosition(
                                absoluteIndex + glyphMatch[0].length
                            );
                        const range = new Range(
                            startPos.row,
                            startPos.column,
                            endPos.row,
                            endPos.column
                        );
                        const markerId = this.featuresEditor.session.addMarker(
                            range,
                            'ace_search_highlight',
                            'text'
                        );
                        this.searchMarkers.push(markerId);
                    }
                });
            }
        }
    }

    private clearFeatureErrorMarker() {
        if (
            !this.featuresEditor ||
            (this.featureErrorMarkerId === null &&
                this.featureErrorTextMarkerId === null)
        ) {
            return;
        }

        if (this.featureErrorMarkerId !== null) {
            try {
                this.featuresEditor.session.removeMarker(
                    this.featureErrorMarkerId
                );
            } catch (e) {
                console.warn(
                    '[FontInfo] Failed to remove feature error line marker:',
                    e
                );
            }
        }

        if (this.featureErrorTextMarkerId !== null) {
            try {
                this.featuresEditor.session.removeMarker(
                    this.featureErrorTextMarkerId
                );
            } catch (e) {
                console.warn(
                    '[FontInfo] Failed to remove feature error text marker:',
                    e
                );
            }
        }

        this.featureErrorMarkerId = null;
        this.featureErrorTextMarkerId = null;
        this.clearFeatureErrorLineWidget();
    }

    private isFeatureErrorTarget(
        type: FeatureItemType,
        key: string | number
    ): boolean {
        return (
            !!this.featureErrorTarget &&
            this.featureErrorTarget.type === type &&
            this.featureErrorTarget.key === key
        );
    }

    private utf8ByteLength(text: string): number {
        return new TextEncoder().encode(text).length;
    }

    private utf8ByteOffsetToCodeUnitIndex(
        text: string,
        byteOffset: number
    ): number {
        if (byteOffset <= 0) {
            return 0;
        }

        let byteCount = 0;
        let codeUnitIndex = 0;

        for (const char of text) {
            const charByteLen = this.utf8ByteLength(char);
            if (byteCount + charByteLen > byteOffset) {
                break;
            }
            byteCount += charByteLen;
            codeUnitIndex += char.length;
        }

        return codeUnitIndex;
    }

    private buildFeatureSourceBlocks(): FeatureSourceBlock[] {
        const font = window.currentFontModel;
        if (!font?.features) {
            return [];
        }

        const blocks: FeatureSourceBlock[] = [];
        let byteCursor = 0;
        let codeUnitCursor = 0;

        const classes = font.features.classes || {};
        Object.entries(classes).forEach(([className, codeData]) => {
            const code = codeData?.code || '';
            const prefix = `@${className} = [`;
            const suffix = `];\n`;
            const blockText = `${prefix}${code}${suffix}`;
            const blockByteLen = this.utf8ByteLength(blockText);
            const blockCodeUnitLen = blockText.length;

            blocks.push({
                type: 'class',
                key: className,
                code,
                globalByteStart: byteCursor,
                globalByteEnd: byteCursor + blockByteLen,
                codeByteStart: this.utf8ByteLength(prefix),
                globalCodeUnitStart: codeUnitCursor,
                globalCodeUnitEnd: codeUnitCursor + blockCodeUnitLen,
                codeUnitStart: prefix.length
            });

            byteCursor += blockByteLen;
            codeUnitCursor += blockCodeUnitLen;
        });

        const prefixes = font.features.prefixes || {};
        Object.entries(prefixes).forEach(([prefixName, codeData]) => {
            const code = codeData?.code || '';
            const header =
                prefixName !== 'anonymous' ? `# Prefix: ${prefixName}\n` : '';
            const suffix = `\n`;
            const blockText = `${header}${code}${suffix}`;
            const blockByteLen = this.utf8ByteLength(blockText);
            const blockCodeUnitLen = blockText.length;

            blocks.push({
                type: 'prefix',
                key: prefixName,
                code,
                globalByteStart: byteCursor,
                globalByteEnd: byteCursor + blockByteLen,
                codeByteStart: this.utf8ByteLength(header),
                globalCodeUnitStart: codeUnitCursor,
                globalCodeUnitEnd: codeUnitCursor + blockCodeUnitLen,
                codeUnitStart: header.length
            });

            byteCursor += blockByteLen;
            codeUnitCursor += blockCodeUnitLen;
        });

        const features = font.features.features || [];
        features.forEach(([featureTag, codeData], featureIndex) => {
            const code = codeData?.code || '';
            const head = `feature ${featureTag} {\n`;
            const tail = `\n} ${featureTag};\n`;
            const blockText = `${head}${code}${tail}`;
            const blockByteLen = this.utf8ByteLength(blockText);
            const blockCodeUnitLen = blockText.length;

            blocks.push({
                type: 'feature',
                key: featureIndex,
                code,
                globalByteStart: byteCursor,
                globalByteEnd: byteCursor + blockByteLen,
                codeByteStart: this.utf8ByteLength(head),
                globalCodeUnitStart: codeUnitCursor,
                globalCodeUnitEnd: codeUnitCursor + blockCodeUnitLen,
                codeUnitStart: head.length
            });

            byteCursor += blockByteLen;
            codeUnitCursor += blockCodeUnitLen;
        });

        return blocks;
    }

    private addFeatureErrorIcon(item: HTMLElement, message: string) {
        const existingIcon = item.querySelector('.feature-error-icon');
        if (existingIcon) {
            existingIcon.remove();
        }

        const errorIcon = document.createElement('span');
        errorIcon.className = 'material-symbols-outlined feature-error-icon';
        errorIcon.textContent = 'warning';
        errorIcon.title = message || 'Feature compilation error';
        item.appendChild(errorIcon);
    }

    private refreshFeatureErrorIconInSidebar() {
        const allItems = [
            ...this.prefixListItems.values(),
            ...this.featureListItems.values(),
            ...this.classListItems.values()
        ];

        allItems.forEach((item) => {
            const icon = item.querySelector('.feature-error-icon');
            if (icon) {
                icon.remove();
            }
        });

        if (!this.featureErrorTarget) {
            return;
        }

        const targetElement =
            this.featureErrorTarget.type === 'prefix'
                ? this.prefixListItems.get(
                      this.featureErrorTarget.key as string
                  )
                : this.featureErrorTarget.type === 'class'
                  ? this.classListItems.get(
                        this.featureErrorTarget.key as string
                    )
                  : this.featureListItems.get(
                        this.featureErrorTarget.key as number
                    );

        if (targetElement) {
            this.addFeatureErrorIcon(
                targetElement,
                this.featureErrorTarget.message
            );
        }
    }

    private setFeatureErrorLineWidget(row: number, text: string) {
        if (!this.featuresEditor) {
            return;
        }

        const LineWidgets = this.getAceLineWidgetsCtor();
        if (!LineWidgets) {
            console.warn('[FontInfo] Ace ext/line_widgets not available');
            return;
        }

        const session = this.featuresEditor.session;
        if (!session.widgetManager) {
            session.widgetManager = new LineWidgets(session);
            session.widgetManager.attach(this.featuresEditor);
        }

        this.clearFeatureErrorLineWidget();

        const node = document.createElement('div');
        node.className = 'feature-error-line-widget';
        node.textContent = text;

        this.featureErrorLineWidget = {
            row,
            el: node,
            fixedWidth: true,
            coverGutter: false
        };

        session.widgetManager.addLineWidget(this.featureErrorLineWidget);
        this.refreshFeatureErrorLineWidgetLayout();
    }

    private refreshFeatureErrorLineWidgetLayout() {
        if (!this.featuresEditor || !this.featureErrorLineWidget?.el) {
            return;
        }

        const scroller = this.featuresEditor.renderer?.scroller as
            | HTMLElement
            | undefined;
        const manager = this.featuresEditor.session?.widgetManager;
        if (!scroller || !manager) {
            return;
        }

        const horizontalPadding = 36;
        const maxWidth = Math.max(
            120,
            scroller.clientWidth - horizontalPadding
        );
        const widgetEl = this.featureErrorLineWidget.el as HTMLElement;
        widgetEl.style.width = `${maxWidth}px`;

        if (typeof manager.onWidgetChanged === 'function') {
            manager.onWidgetChanged(this.featureErrorLineWidget);
        }
    }

    private getAceLineWidgetsCtor(): any {
        if (this.aceLineWidgetsCtor) {
            return this.aceLineWidgetsCtor;
        }

        const moduleIds = ['ace/line_widgets', 'ace/ext/line_widgets'];
        for (const moduleId of moduleIds) {
            try {
                const module = window.ace?.require?.(moduleId);
                if (module?.LineWidgets) {
                    this.aceLineWidgetsCtor = module.LineWidgets;
                    return this.aceLineWidgetsCtor;
                }
            } catch {
                // Try next module id
            }
        }

        return null;
    }

    private clearFeatureErrorLineWidget() {
        if (!this.featuresEditor || !this.featureErrorLineWidget) {
            this.featureErrorLineWidget = null;
            return;
        }

        const session = this.featuresEditor.session;
        if (!session?.widgetManager) {
            this.featureErrorLineWidget = null;
            return;
        }

        try {
            session.widgetManager.removeLineWidget(this.featureErrorLineWidget);
        } catch (e) {
            console.warn(
                '[FontInfo] Failed to remove feature error widget:',
                e
            );
        }

        this.featureErrorLineWidget = null;
    }

    clearFeatureErrorHighlight() {
        this.clearFeatureErrorMarker();
        this.featureErrorTarget = null;
        this.featureErrorIssue = null;
        this.refreshFeatureErrorIconInSidebar();
    }

    getFeatureCompilationErrorLocation(
        errorInput: unknown
    ): FeatureErrorLocation | null {
        const details = this.getFeatureCompilationErrorDetails(errorInput);
        if (!details || !details.type) {
            return null;
        }

        return {
            type: details.type,
            label: details.label
        };
    }

    getFeatureCompilationErrorDetails(errorInput: unknown): {
        type: 'prefix' | 'class' | 'feature' | null;
        label: string;
        message: string;
    } | null {
        const issue = this.extractFeatureSpanIssue(errorInput);
        if (!issue) {
            return null;
        }

        const resolved = this.resolveFeatureSpanTarget(
            issue.start,
            issue.end,
            issue.message
        );
        const target = resolved?.target || null;

        if (!target) {
            return {
                type: null,
                label: 'feature code',
                message: issue.message
            };
        }

        return {
            type: target.type,
            label: this.getFeatureTargetLabel(target.type, target.key),
            message: issue.message
        };
    }

    showFeatureCompilationError(errorInput: unknown) {
        const issue = this.extractFeatureSpanIssue(errorInput);
        if (!issue) {
            this.clearFeatureErrorHighlight();
            return;
        }

        const resolved = this.resolveFeatureSpanTarget(
            issue.start,
            issue.end,
            issue.message
        );
        const target = resolved?.target || null;
        if (!target) {
            this.featureErrorIssue = issue;
            this.featureErrorTarget = null;
            this.clearFeatureErrorMarker();
            this.refreshFeatureErrorIconInSidebar();
            return;
        }

        issue.start = resolved!.normalizedStart;
        issue.end = resolved!.normalizedEnd;
        issue.coordinateMode = resolved!.coordinateMode;

        this.featureErrorTarget = {
            type: target.type,
            key: target.key,
            message: `${issue.category}: ${issue.message}`
        };
        this.featureErrorIssue = issue;
        this.refreshFeatureErrorIconInSidebar();

        if (!this.featuresEditorInitialized) {
            this.initializeFeaturesEditor();
            this.featuresEditorInitialized = true;
        }

        if (window.currentFontModel && !this.fontDataLoaded) {
            this.loadAllLists();
            this.fontDataLoaded = true;
        }

        this.updateFeatureErrorDisplayForSelection();

        console.log(
            '[FontInfo] Feature compilation span resolved:',
            issue,
            '->',
            target
        );
    }

    openFeatureCompilationError(errorInput: unknown) {
        this.showFeatureCompilationError(errorInput);

        if (!this.featureErrorIssue || !this.featureErrorTarget) {
            return;
        }

        if (typeof window.focusView === 'function') {
            window.focusView('view-fontinfo');
        }

        this.switchTab('features');
        this.selectItem(
            this.featureErrorTarget.type,
            this.featureErrorTarget.key,
            true
        );

        const resolved = this.resolveFeatureSpanTarget(
            this.featureErrorIssue.start,
            this.featureErrorIssue.end,
            this.featureErrorIssue.message
        );
        const target = resolved?.target || null;
        if (!target || !this.featuresEditor) {
            return;
        }

        const coordinateMode =
            this.featureErrorIssue.coordinateMode || resolved?.coordinateMode;

        const localCodeUnitStartIndex =
            coordinateMode === 'codeUnit'
                ? Math.max(
                      0,
                      Math.min(
                          target.code.length,
                          this.featureErrorIssue.start -
                              (target.globalCodeUnitStart +
                                  target.codeUnitStart)
                      )
                  )
                : this.utf8ByteOffsetToCodeUnitIndex(
                      target.code,
                      Math.max(
                          0,
                          Math.min(
                              this.utf8ByteLength(target.code),
                              this.featureErrorIssue.start -
                                  (target.globalByteStart +
                                      target.codeByteStart)
                          )
                      )
                  );
        const row = this.featuresEditor.session.doc.indexToPosition(
            localCodeUnitStartIndex
        ).row;

        if (typeof this.featuresEditor.scrollToLine === 'function') {
            this.featuresEditor.scrollToLine(row, true, true);
        }
    }

    private updateFeatureErrorDisplayForSelection() {
        if (!this.featuresEditor || !this.selectedItem) {
            this.clearFeatureErrorMarker();
            return;
        }

        if (!this.featureErrorIssue || !this.featureErrorTarget) {
            this.clearFeatureErrorMarker();
            return;
        }

        if (
            this.selectedItem.type !== this.featureErrorTarget.type ||
            this.selectedItem.key !== this.featureErrorTarget.key
        ) {
            this.clearFeatureErrorMarker();
            return;
        }

        const resolved = this.resolveFeatureSpanTarget(
            this.featureErrorIssue.start,
            this.featureErrorIssue.end,
            this.featureErrorIssue.message
        );
        const target = resolved?.target || null;
        if (!target) {
            this.clearFeatureErrorMarker();
            return;
        }

        this.featureErrorIssue.coordinateMode =
            this.featureErrorIssue.coordinateMode || resolved!.coordinateMode;

        this.renderFeatureErrorInEditor(this.featureErrorIssue, target);
    }

    private renderFeatureErrorInEditor(
        issue: FeatureErrorSpanIssue,
        target: {
            type: 'prefix' | 'class' | 'feature';
            key: string | number;
            globalByteStart: number;
            codeByteStart: number;
            globalCodeUnitStart: number;
            codeUnitStart: number;
            code: string;
        }
    ) {
        if (!this.featuresEditor) {
            return;
        }

        const coordinateMode = issue.coordinateMode || 'byte';
        const localCodeUnitStartIndex =
            coordinateMode === 'codeUnit'
                ? Math.max(
                      0,
                      Math.min(
                          target.code.length,
                          issue.start -
                              (target.globalCodeUnitStart +
                                  target.codeUnitStart)
                      )
                  )
                : this.utf8ByteOffsetToCodeUnitIndex(
                      target.code,
                      Math.max(
                          0,
                          Math.min(
                              this.utf8ByteLength(target.code),
                              issue.start -
                                  (target.globalByteStart +
                                      target.codeByteStart)
                          )
                      )
                  );

        let localCodeUnitEndIndex =
            coordinateMode === 'codeUnit'
                ? Math.max(
                      0,
                      Math.min(
                          target.code.length,
                          issue.end -
                              (target.globalCodeUnitStart +
                                  target.codeUnitStart)
                      )
                  )
                : this.utf8ByteOffsetToCodeUnitIndex(
                      target.code,
                      Math.max(
                          0,
                          Math.min(
                              this.utf8ByteLength(target.code),
                              issue.end -
                                  (target.globalByteStart +
                                      target.codeByteStart)
                          )
                      )
                  );

        if (localCodeUnitEndIndex <= localCodeUnitStartIndex) {
            localCodeUnitEndIndex = Math.min(
                target.code.length,
                localCodeUnitStartIndex + 1
            );
        }

        const startPos = this.featuresEditor.session.doc.indexToPosition(
            localCodeUnitStartIndex
        );
        const endPos = this.featuresEditor.session.doc.indexToPosition(
            localCodeUnitEndIndex
        );

        const row = startPos.row;

        const Range = window.ace.require('ace/range').Range;
        this.clearFeatureErrorMarker();
        this.featureErrorMarkerId = this.featuresEditor.session.addMarker(
            new Range(row, 0, row, 1),
            'ace_feature_error_line',
            'fullLine'
        );
        this.featureErrorTextMarkerId = this.featuresEditor.session.addMarker(
            new Range(startPos.row, startPos.column, endPos.row, endPos.column),
            'ace_feature_error_text',
            'text'
        );
        this.setFeatureErrorLineWidget(
            row,
            `${issue.category}: ${issue.message}`
        );
    }

    private extractFeatureSpanIssue(
        errorInput: unknown
    ): FeatureErrorSpanIssue | null {
        const issue = extractPrimaryFeatureIssue(errorInput);
        if (!issue || issue.start === undefined || issue.end === undefined) {
            return null;
        }

        return {
            start: issue.start,
            end: issue.end,
            message: issue.message,
            category: issue.category
        };
    }

    private findFeatureItemFromGlobalSpan(
        start: number,
        end: number,
        coordinateMode: 'byte' | 'codeUnit' = 'byte'
    ): {
        type: 'prefix' | 'class' | 'feature';
        key: string | number;
        globalByteStart: number;
        globalByteEnd: number;
        codeByteStart: number;
        globalCodeUnitStart: number;
        globalCodeUnitEnd: number;
        codeUnitStart: number;
        code: string;
    } | null {
        const blocks = this.buildFeatureSourceBlocks();
        if (!blocks.length) {
            return null;
        }

        const endInclusive = Math.max(start, end - 1);

        const matching =
            blocks.find(
                (block) =>
                    start >=
                        (coordinateMode === 'byte'
                            ? block.globalByteStart
                            : block.globalCodeUnitStart) &&
                    start <
                        (coordinateMode === 'byte'
                            ? block.globalByteEnd
                            : block.globalCodeUnitEnd)
            ) ||
            blocks.find(
                (block) =>
                    endInclusive >=
                        (coordinateMode === 'byte'
                            ? block.globalByteStart
                            : block.globalCodeUnitStart) &&
                    endInclusive <
                        (coordinateMode === 'byte'
                            ? block.globalByteEnd
                            : block.globalCodeUnitEnd)
            );

        if (!matching) {
            return null;
        }

        return {
            type: matching.type,
            key: matching.key,
            globalByteStart: matching.globalByteStart,
            globalByteEnd: matching.globalByteEnd,
            codeByteStart: matching.codeByteStart,
            globalCodeUnitStart: matching.globalCodeUnitStart,
            globalCodeUnitEnd: matching.globalCodeUnitEnd,
            codeUnitStart: matching.codeUnitStart,
            code: matching.code
        };
    }

    private resolveFeatureSpanTarget(
        start: number,
        end: number,
        issueMessage?: string
    ): ResolvedFeatureSpanTarget | null {
        const normalizedStart = Math.max(0, start);
        const normalizedEnd = Math.max(normalizedStart, end);

        const candidates: Array<{
            start: number;
            end: number;
            coordinateMode: 'byte' | 'codeUnit';
        }> = [
            {
                start: normalizedStart,
                end: normalizedEnd,
                coordinateMode: 'byte'
            },
            {
                start: Math.max(0, normalizedStart - 1),
                end: Math.max(0, normalizedEnd - 1),
                coordinateMode: 'byte'
            },
            {
                start: normalizedStart,
                end: normalizedEnd,
                coordinateMode: 'codeUnit'
            },
            {
                start: Math.max(0, normalizedStart - 1),
                end: Math.max(0, normalizedEnd - 1),
                coordinateMode: 'codeUnit'
            }
        ];

        for (const candidate of candidates) {
            const target = this.findFeatureItemFromGlobalSpan(
                candidate.start,
                candidate.end,
                candidate.coordinateMode
            );
            if (target) {
                return {
                    target,
                    coordinateMode: candidate.coordinateMode,
                    normalizedStart: candidate.start,
                    normalizedEnd: candidate.end
                };
            }
        }

        return null;
    }

    private getFeatureTargetLabel(
        type: 'prefix' | 'class' | 'feature',
        key: string | number
    ): string {
        if (type === 'feature') {
            const font = window.currentFontModel;
            const features = font?.features?.features || [];
            const featureEntry =
                typeof key === 'number' ? features[key] : undefined;
            const featureTag = featureEntry?.[0];
            if (!featureTag) {
                return `#${String(key)}`;
            }

            const occurrence =
                typeof key === 'number'
                    ? features
                          .slice(0, key + 1)
                          .filter(([tag]) => tag === featureTag).length
                    : 1;
            return occurrence > 1 ? `${featureTag} #${occurrence}` : featureTag;
        }

        return String(key);
    }

    getHistoryScopeTarget(): FeatureHistoryScopeTarget | null {
        if (!this.isViewActive() || this.currentTab !== 'features') {
            return null;
        }

        if (!this.selectedItem) {
            return null;
        }

        const { type, key } = this.selectedItem;
        if (type === 'prefix' && typeof key === 'string') {
            return {
                type,
                key: `prefix:${key}`,
                label: key
            };
        }

        if (type === 'class' && typeof key === 'string') {
            return {
                type,
                key: `class:${key}`,
                label: key
            };
        }

        if (type === 'feature' && typeof key === 'number') {
            const font = window.currentFontModel;
            const features = font?.features?.features || [];
            const featureEntry = features[key];
            const tag = featureEntry?.[0];
            if (!tag) {
                return {
                    type,
                    key: `feature-index:${key}`,
                    label: `#${key + 1}`
                };
            }

            const occurrence = features
                .slice(0, key + 1)
                .filter(([featureTag]) => featureTag === tag).length;

            return {
                type,
                key: `feature:${tag}:${occurrence}`,
                label: occurrence > 1 ? `${tag} #${occurrence}` : String(tag)
            };
        }

        return null;
    }

    private notifyHistoryScopeChange() {
        window.dispatchEvent(new CustomEvent('featureHistoryContextChanged'));
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

        // Set FEA mode with error handling
        try {
            this.featuresEditor.session.setMode('ace/mode/fea');
            console.log('[FontInfo] FEA mode loaded successfully');
        } catch (e) {
            console.error('[FontInfo] Failed to load FEA mode:', e);
            // Fallback to text mode
            this.featuresEditor.session.setMode('ace/mode/text');
        }
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
        this.featuresEditor.on('blur', () => this.commitFeatureCodeChanges());
        this.featuresEditor.commands.addCommand({
            name: 'commitFeatureCodeChanges',
            bindKey: { win: 'Ctrl-Enter', mac: 'Command-Enter' },
            exec: () => {
                this.commitFeatureCodeChanges();
            }
        });
        this.featuresEditor.renderer.on('afterRender', () => {
            this.refreshFeatureErrorLineWidgetLayout();
        });

        console.log('[FontInfo] Features editor initialized');
    }

    private switchTab(tab: FontInfoTab) {
        this.currentTab = tab;
        this.notifyHistoryScopeChange();

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
            buttons.forEach((button: Element) => {
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
            if (
                window.currentFontModel &&
                (!this.fontDataLoaded || this.pendingModelSyncRefresh)
            ) {
                console.log('[FontInfo] Loading features lists (switchTab)');
                this.refreshVisibleFeatureContent();
            }
            // Show search control
            const searchControl = document.getElementById(
                'fontinfo-search-control'
            );
            if (searchControl) {
                searchControl.style.display = '';
            }
        } else {
            // Hide search control and clear search when leaving features tab
            const searchControl = document.getElementById(
                'fontinfo-search-control'
            );
            if (searchControl) {
                searchControl.style.display = 'none';
            }
            // Clear search terms and reset visibility
            if (this.searchTerms.length > 0) {
                this.searchTerms = [];
                if (this.searchInput) {
                    this.searchInput.value = '';
                }
                // Reset all items to visible
                this.applyFeaturesSearch();
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
        this.pendingModelSyncRefresh = false;
        this.featureCodeDirty = false;
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

    private onFontModelSynced() {
        this.fontDataLoaded = false;
        this.pendingModelSyncRefresh = true;

        if (this.currentTab !== 'features') {
            return;
        }

        if (this.featuresEditor?.isFocused?.() && this.featureCodeDirty) {
            return;
        }

        requestAnimationFrame(() => this.refreshVisibleFeatureContent());
    }

    private refreshVisibleFeatureContent() {
        if (this.currentTab !== 'features' || !window.currentFontModel) {
            return;
        }

        if (this.featuresEditor?.isFocused?.() && this.featureCodeDirty) {
            return;
        }

        if (!this.featuresEditorInitialized) {
            this.initializeFeaturesEditor();
            this.featuresEditorInitialized = true;
        }

        const previousSelection = this.selectedItem
            ? { ...this.selectedItem }
            : null;
        const previousCursor =
            this.featuresEditor?.getCursorPosition?.() ?? null;
        const previousScrollTop =
            this.featuresEditor?.session?.getScrollTop?.() ?? null;
        const previousScrollLeft =
            this.featuresEditor?.session?.getScrollLeft?.() ?? null;

        this.loadAllLists();
        this.fontDataLoaded = true;
        this.pendingModelSyncRefresh = false;

        if (
            previousSelection &&
            this.selectedItem &&
            previousSelection.type === this.selectedItem.type &&
            previousSelection.key === this.selectedItem.key
        ) {
            if (previousCursor) {
                this.featuresEditor?.moveCursorTo?.(
                    previousCursor.row,
                    previousCursor.column
                );
            }
            if (previousScrollTop !== null) {
                this.featuresEditor?.session?.setScrollTop?.(previousScrollTop);
            }
            if (previousScrollLeft !== null) {
                this.featuresEditor?.session?.setScrollLeft?.(
                    previousScrollLeft
                );
            }
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
        this.prefixCodeData.clear();
        listContainer.innerHTML = '';

        prefixKeys.forEach((key) => {
            const item = this.createListItem('prefix', key, prefixes[key]);
            this.prefixListItems.set(key, item);
            this.prefixCodeData.set(key, prefixes[key].code || '');
            listContainer.appendChild(item);
        });

        // Apply search filter if there are active search terms
        if (this.searchTerms.length > 0) {
            this.applyFeaturesSearch();
        }
    }

    private parseClassGlyphMembers(classCode: string): Set<string> {
        const glyphs = new Set<string>();
        if (!classCode) return glyphs;

        // Remove comments
        const codeWithoutComments = classCode.replace(/#.*/g, '');

        // Split by whitespace - the class code is already a space-separated list
        const tokens = codeWithoutComments
            .split(/\s+/)
            .map((t) => t.trim())
            .filter((t) => t.length > 0);

        tokens.forEach((token) => {
            if (token.startsWith('@')) {
                // It's a nested class reference - will be resolved later
                glyphs.add(token);
            } else {
                // It's a glyph name
                glyphs.add(token);
            }
        });

        return glyphs;
    }

    private getAllGlyphsInClass(
        className: string,
        visited: Set<string> = new Set()
    ): Set<string> {
        const allGlyphs = new Set<string>();

        // Prevent infinite recursion
        if (visited.has(className)) return allGlyphs;
        visited.add(className);

        // Remove @ prefix if present
        const cleanName = className.startsWith('@')
            ? className.slice(1)
            : className;
        const members = this.classGlyphMembers.get(cleanName);

        if (!members) return allGlyphs;

        members.forEach((member) => {
            if (member.startsWith('@')) {
                // Recursively get glyphs from nested class
                const nestedGlyphs = this.getAllGlyphsInClass(member, visited);
                nestedGlyphs.forEach((g) => allGlyphs.add(g));
            } else {
                allGlyphs.add(member);
            }
        });

        return allGlyphs;
    }

    private classContainsGlyph(className: string, glyphName: string): boolean {
        const allGlyphs = this.getAllGlyphsInClass(className);
        return allGlyphs.has(glyphName);
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
        this.classCodeData.clear();
        this.classGlyphMembers.clear();
        listContainer.innerHTML = '';

        classKeys.forEach((key) => {
            const item = this.createListItem('class', key, classes[key]);
            this.classListItems.set(key, item);
            this.classCodeData.set(key, classes[key].code || '');
            // Parse and store glyph members for this class
            const members = this.parseClassGlyphMembers(
                classes[key].code || ''
            );
            this.classGlyphMembers.set(key, members);
            listContainer.appendChild(item);
        });

        // Apply search filter if there are active search terms
        if (this.searchTerms.length > 0) {
            this.applyFeaturesSearch();
        }
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

        this.clearFeatureDropIndicator();

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
        const wasAtBottom = sidebar
            ? sidebar.scrollHeight - sidebar.scrollTop - sidebar.clientHeight <
              5
            : false;

        this.featureListItems.clear();
        this.featureCodeData.clear();
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
                    this.featureCodeData.set(index, {
                        tag,
                        code: codeData.code || ''
                    });
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
                    this.featureCodeData.set(index, {
                        tag,
                        code: codeData.code || ''
                    });
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
                    this.featureCodeData.set(index, {
                        tag,
                        code: codeData.code || ''
                    });
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
                    this.featureCodeData.set(index, {
                        tag,
                        code: codeData.code || ''
                    });
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
                    this.featureCodeData.set(index, {
                        tag,
                        code: codeData.code || ''
                    });
                    listContainer.appendChild(item);
                }
            );
        }

        // Apply search filter if there are active search terms
        if (this.searchTerms.length > 0) {
            this.applyFeaturesSearch();
        }

        // Restore selection by feature tag when possible (stable across fonts/index changes)
        if (this.selectedFeatureTag) {
            const matchingFeatureIndex = features.findIndex(
                ([tag]) => tag === this.selectedFeatureTag
            );
            if (matchingFeatureIndex >= 0) {
                this.selectItem('feature', matchingFeatureIndex);
            } else if (!this.selectedItem && features.length > 0) {
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
        } else if (!this.selectedItem && features.length > 0) {
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
            item.dataset.featureIndex = String(key);
            item.classList.add('draggable-feature');
            item.addEventListener('dragstart', (e) =>
                this.onFeatureDragStart(e, key as number)
            );
            item.addEventListener('dragover', (e) =>
                this.onFeatureDragOver(e, key as number)
            );
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

        if (this.isFeatureErrorTarget(type, key)) {
            this.addFeatureErrorIcon(item, this.featureErrorTarget!.message);
        }

        item.addEventListener('click', () => this.selectItem(type, key));

        return item;
    }

    private selectItem(
        type: FeatureItemType,
        key: string | number,
        scrollIntoView: boolean = false
    ) {
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
            this.selectedFeatureTag = tag;
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
            // Scroll into view if navigating with keyboard
            if (scrollIntoView) {
                selectedElement.scrollIntoView({
                    block: 'nearest',
                    behavior: 'smooth'
                });
            }
        }

        // Load code into editor
        if (this.featuresEditor) {
            this.suppressFeatureEditorChange = true;
            this.featuresEditor.setValue(codeData.code || '', -1);
            this.suppressFeatureEditorChange = false;
            this.featureCodeDirty = false;
            // Enable line wrapping for all cases (prefixes, classes, and features)
            this.featuresEditor.session.setUseWrapMode(true);
            // Highlight search terms in the loaded content
            this.highlightSearchTermsInEditor();
        }

        // Update automatic checkbox
        const autoCheckbox = document.getElementById(
            'feature-automatic-checkbox'
        ) as HTMLInputElement;
        if (autoCheckbox) {
            autoCheckbox.checked = codeData.automatic || false;
        }

        this.updateFeatureErrorDisplayForSelection();
        this.notifyHistoryScopeChange();

        console.log(`[FontInfo] Selected ${label}`);
    }

    private clearEditor() {
        this.selectedItem = null;
        this.clearFeatureErrorMarker();
        this.featureErrorTarget = null;
        this.notifyHistoryScopeChange();
        if (this.featuresEditor) {
            this.suppressFeatureEditorChange = true;
            this.featuresEditor.setValue('', -1);
            this.suppressFeatureEditorChange = false;
            this.featureCodeDirty = false;
            // Clear search markers when editor is cleared
            this.searchMarkers.forEach((id) =>
                this.featuresEditor.session.removeMarker(id)
            );
            this.searchMarkers = [];
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
        if (this.suppressFeatureEditorChange) {
            return;
        }
        this.featureCodeDirty = true;
        this.clearFeatureErrorMarker();
        this.featureErrorTarget = null;
        this.featureErrorIssue = null;
        this.refreshFeatureErrorIconInSidebar();
    }

    private commitFeatureCodeChanges() {
        if (!this.featuresEditor || !this.selectedItem) {
            this.featureCodeDirty = false;
            return;
        }

        const font = window.currentFontModel;
        if (!font || !font.features) {
            this.featureCodeDirty = false;
            return;
        }

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

        if (!codeData) {
            this.featureCodeDirty = false;
            return;
        }

        const newCode = this.featuresEditor.getValue();
        const previousCode = codeData.code || '';

        if (newCode === previousCode) {
            this.featureCodeDirty = false;
            if (this.pendingModelSyncRefresh) {
                requestAnimationFrame(() =>
                    this.refreshVisibleFeatureContent()
                );
            }
            return;
        }

        codeData.code = newCode;
        this.featureCodeDirty = false;

        // Mark font as dirty
        if (window.fontManager?.currentFont) {
            window.fontManager.currentFont.markDirty();
        }

        if (window.fontManager?.isReady()) {
            if (window.fontManager.currentFont) {
                window.fontManager.currentFont.syncJsonFromModel();
            }

            window.fontManager.recompileEditingFont().catch((error: any) => {
                console.error(
                    'Failed to compile font after feature code change:',
                    error
                );
            });
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
        this.clearFeatureDropIndicator();
        const target = e.target as HTMLElement;
        target.classList.add('dragging');
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
        }
    }

    private onFeatureDragOver(e: DragEvent, targetIndex: number) {
        e.preventDefault();
        if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'move';
        }

        if (this.draggedFeatureIndex === null) {
            return;
        }

        const target = e.currentTarget as HTMLElement | null;
        if (!target) {
            return;
        }

        const rect = target.getBoundingClientRect();
        const placement =
            e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
        this.setFeatureDropIndicator(targetIndex, placement);
    }

    private onFeatureDrop(e: DragEvent, targetIndex: number) {
        e.preventDefault();

        const insertionIndex = this.getFeatureDropInsertionIndex(targetIndex);
        this.clearFeatureDropIndicator();

        if (this.draggedFeatureIndex === null || insertionIndex === null) {
            return;
        }

        const font = window.currentFontModel;
        if (!font || !font.features || !font.features.features) return;

        const features = font.features.features;
        const draggedTag = features[this.draggedFeatureIndex]?.[0];
        const targetTag = features[targetIndex]?.[0];
        const originalDraggedIndex = this.draggedFeatureIndex;
        const adjustedTargetIndex =
            originalDraggedIndex < insertionIndex
                ? insertionIndex - 1
                : insertionIndex;
        const historyTarget = this.getFeatureHistoryTarget(
            features,
            originalDraggedIndex
        );

        // Only allow reordering discretionary features
        if (
            !draggedTag ||
            !targetTag ||
            !isDiscretionary(draggedTag) ||
            !isDiscretionary(targetTag)
        ) {
            return;
        }

        if (adjustedTargetIndex === originalDraggedIndex) {
            return;
        }

        const bridge = window.changeBridge;
        bridge?.beginTransaction('Reorder features', historyTarget);

        let movedFeature;

        try {
            // Reorder features in the font model
            [movedFeature] = features.splice(originalDraggedIndex, 1);

            features.splice(adjustedTargetIndex, 0, movedFeature);
        } finally {
            bridge?.endTransaction();
        }

        if (!movedFeature) {
            return;
        }

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
        this.clearFeatureDropIndicator();
        this.draggedFeatureIndex = null;
        // Reset dragging class
        document
            .querySelectorAll('.draggable-feature')
            .forEach((item: Element) => {
                item.classList.remove('dragging');
            });
    }

    private setFeatureDropIndicator(
        targetIndex: number,
        placement: 'before' | 'after'
    ) {
        if (
            this.featureDropTargetIndex === targetIndex &&
            this.featureDropTargetPlacement === placement
        ) {
            return;
        }

        this.clearFeatureDropIndicator();

        const target = this.featureListItems.get(targetIndex);
        if (!target) {
            return;
        }

        target.classList.add(
            placement === 'before'
                ? 'feature-drop-target-before'
                : 'feature-drop-target-after'
        );
        this.featureDropTargetIndex = targetIndex;
        this.featureDropTargetPlacement = placement;
    }

    private clearFeatureDropIndicator() {
        if (this.featureDropTargetIndex !== null) {
            const previousTarget = this.featureListItems.get(
                this.featureDropTargetIndex
            );
            previousTarget?.classList.remove(
                'feature-drop-target-before',
                'feature-drop-target-after'
            );
        }

        this.featureDropTargetIndex = null;
        this.featureDropTargetPlacement = null;
    }

    private getFeatureDropInsertionIndex(
        fallbackTargetIndex: number
    ): number | null {
        if (this.draggedFeatureIndex === null) {
            return null;
        }

        const targetIndex = this.featureDropTargetIndex ?? fallbackTargetIndex;
        const placement = this.featureDropTargetPlacement ?? 'before';
        return placement === 'after' ? targetIndex + 1 : targetIndex;
    }

    private getFeatureHistoryTarget(
        features: Array<[string, Babelfont.PossiblyAutomaticCode]>,
        featureIndex: number
    ): TransactionHistoryTarget | null {
        const featureEntry = features[featureIndex];
        if (!featureEntry) {
            return null;
        }

        const tag = String(featureEntry[0] ?? '');
        if (!tag) {
            return null;
        }

        let occurrence = 0;
        for (let index = 0; index <= featureIndex; index++) {
            if (String(features[index]?.[0] ?? '') === tag) {
                occurrence += 1;
            }
        }

        return {
            type: 'feature',
            key: `feature:${tag}:${occurrence}`,
            label: occurrence > 1 ? `${tag} #${occurrence}` : tag
        };
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
