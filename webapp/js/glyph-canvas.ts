// Glyph Canvas Editor
// Handles canvas-based glyph editing with pan/zoom and text rendering

import { AxesManager } from './glyph-canvas/variations';
import { FeaturesManager } from './glyph-canvas/features';
import { TextRunEditor } from './glyph-canvas/textrun';
import { ViewportManager } from './glyph-canvas/viewport';
import { GlyphCanvasRenderer } from './glyph-canvas/renderer';
import { MeasurementTool } from './glyph-canvas/measurement-tool';
import { StackPreviewAnimator } from './glyph-canvas/stack-preview-animator';
import { get_glyph_name } from '../wasm-dist/babelfont_fontc_web';
import fontManager from './font-manager';
import { OutlineEditor } from './glyph-canvas/outline-editor';
import { Logger } from './logger';
import APP_SETTINGS from './settings';
import { attachTopRowSidebarInterpolation } from './top-row-sidebar-interpolation';
import { designspaceToUserspace, userspaceToDesignspace } from './locations';
import type { DesignspaceLocation, UserspaceLocation } from './locations';
import {
    Component,
    DecomposedAffineTransform,
    Glyph,
    Layer,
    Master
} from './babelfont-model';
import { updateUrlState, encodeLocation } from './url-state';
import { isSyncEnabled } from './state-sync';
import {
    timelineMark,
    timelineSpanEnd,
    timelineSpanStart
} from './perf-timeline';
import { SavedVariationState } from './saved-variation-state';
import { ArrowAdjustableTextInput } from './arrow-adjustable-text-input';
import { LayerDataNormalizer } from './layer-data-normalizer';
import tippy from 'tippy.js';
import {
    addTippyBackdropSupport,
    getOrCreateBackdrop,
    getTheme,
    setupMenuKeyboardNav
} from './tippy-utils';
import {
    applyLiveSidebearingVisualSync,
    syncModelSidebearingEditToCanvas
} from './sidebearing-utils';
import { getUndoRedoContext } from './undo-redo-context';

let console: Logger = new Logger('GlyphCanvas');
let latestOpenSessionId: string | null = null;

function syncLatestOpenSessionId(event: Event): void {
    const detail = (event as CustomEvent).detail;
    latestOpenSessionId = detail?.openSessionId || null;
}

function syncLatestOpenSessionIdFromLifecycle(event: Event): void {
    const detail = (event as CustomEvent).detail;
    if (detail?.phase !== 'fontLoaded') {
        return;
    }
    latestOpenSessionId = detail?.openSessionId || null;
}

function isPlainNumericInputValue(value: string): boolean {
    return /^[+-]?\d+(?:\.\d+)?$/.test(value.trim());
}

const GLYPHS_COMPONENT_ALIGNMENT_KEY = 'com.schriftgestalt.Glyphs.alignment';

function getSharedNumericValue(
    values: number[],
    epsilon = 0.000001
): number | null {
    if (values.length === 0) {
        return null;
    }

    const first = values[0];
    return values.every((value) => Math.abs(value - first) <= epsilon)
        ? first
        : null;
}

type QCGlyphProblem = {
    glyphName: string;
    userspaceLocation: UserspaceLocation | null;
    position: [number, number] | null;
};

type ActivePropertyInputState = {
    fieldKey: string;
    selectionStart: number | null;
    selectionEnd: number | null;
};

type ComponentTransformField =
    | 'translateX'
    | 'translateY'
    | 'rotation'
    | 'scaleX'
    | 'scaleY'
    | 'skewX'
    | 'skewY';

type ComponentCheckboxState = boolean | 'mixed';

type NormalizedDecomposedTransform = {
    translation: [number, number];
    scale: [number, number];
    rotation: number;
    skew: [number, number];
    order: 'Glyphs' | 'RestOfTheWorld';
};

type LayerListContextTarget = {
    glyphName: string;
    masterId: string;
    layerId: string | null;
    userspaceLocation: UserspaceLocation | null;
    designLocation: DesignspaceLocation | null;
    isMasterBound: boolean;
};

type KerningSide = 'first' | 'second';

type TextModeKerningStatus =
    | 'ready'
    | 'off-master'
    | 'bidi-boundary'
    | 'no-pair';

type TextRunClusterInfo = {
    glyphIndex: number;
    glyphCount: number;
    start: number;
    end: number;
    x: number;
    width: number;
    isRTL: boolean;
};

type TextModeKerningOperand = {
    side: KerningSide;
    kind: 'glyph' | 'group';
    name: string;
    key: string;
    label: string;
    removable: boolean;
    participates: boolean;
    compatible: boolean;
    active: boolean;
};

type TextModeKerningSelection = {
    firstKey: string | null;
    secondKey: string | null;
};

type TextModeKerningContext = {
    status: TextModeKerningStatus;
    message: string;
    isRTL: boolean;
    master: Master | null;
    metrics: Record<string, number> | null;
    firstGlyphName: string | null;
    secondGlyphName: string | null;
    firstCluster: TextRunClusterInfo | null;
    secondCluster: TextRunClusterInfo | null;
    firstOptions: TextModeKerningOperand[];
    secondOptions: TextModeKerningOperand[];
    selectedFirstKey: string | null;
    selectedSecondKey: string | null;
    selectedFirstLabel: string | null;
    selectedSecondLabel: string | null;
    selectedValue: number | null;
    hasSelectedValue: boolean;
};

type TextModeKerningOverlay = {
    minX: number;
    maxX: number;
    topY: number;
    bottomY: number;
    value: number;
};

type TextModeKerningPair = {
    firstKey: string;
    secondKey: string;
    pairKey: string;
};

type TextModeKerningOverlayCacheEntry = {
    adjacencyKey: string;
    firstKeys: string[];
    secondKeys: string[];
    secondCluster: TextRunClusterInfo;
    isRTL: boolean;
    resolvedFirstKey: string | null;
    resolvedSecondKey: string | null;
    value: number | null;
    overlay: TextModeKerningOverlay | null;
};

type TextModeKerningOverlayCache = {
    layoutVersion: number;
    masterId: string;
    overlays: TextModeKerningOverlay[];
    entries: TextModeKerningOverlayCacheEntry[];
    entriesByAdjacencyKey: Map<string, TextModeKerningOverlayCacheEntry>;
    candidatePairToAdjacencyKeys: Map<string, Set<string>>;
};

type KerningRow = Map<string, number> | Record<string, number>;
type KerningContainer =
    | Map<string, KerningRow | number>
    | Record<string, KerningRow | number>;

function isKerningRow(
    value: KerningRow | number | null | undefined
): value is KerningRow {
    return value instanceof Map || (!!value && typeof value === 'object');
}

function getFlatKerningPairKey(firstKey: string, secondKey: string): string {
    return `${firstKey}:${secondKey}`;
}

function getTextModeKerningPairKey(
    firstKey: string,
    secondKey: string
): string {
    return `${firstKey}\u0000${secondKey}`;
}

function getTextModeKerningAdjacencyKey(
    firstCluster: TextRunClusterInfo,
    secondCluster: TextRunClusterInfo
): string {
    return [
        firstCluster.start,
        firstCluster.end,
        secondCluster.start,
        secondCluster.end,
        firstCluster.isRTL ? 'rtl' : 'ltr'
    ].join('\u0000');
}

function buildOrderedTextModeKerningPairs(
    firstKeys: string[],
    secondKeys: string[]
): TextModeKerningPair[] {
    const glyphFirstKeys = firstKeys.filter((key) => !key.startsWith('@'));
    const groupFirstKeys = firstKeys.filter((key) => key.startsWith('@'));
    const glyphSecondKeys = secondKeys.filter((key) => !key.startsWith('@'));
    const groupSecondKeys = secondKeys.filter((key) => key.startsWith('@'));
    const orderedPairs: TextModeKerningPair[] = [];
    const seenPairKeys = new Set<string>();

    const appendPairs = (
        currentFirstKeys: string[],
        currentSecondKeys: string[]
    ) => {
        for (const firstKey of currentFirstKeys) {
            for (const secondKey of currentSecondKeys) {
                const pairKey = getTextModeKerningPairKey(firstKey, secondKey);
                if (seenPairKeys.has(pairKey)) {
                    continue;
                }
                seenPairKeys.add(pairKey);
                orderedPairs.push({ firstKey, secondKey, pairKey });
            }
        }
    };

    appendPairs(glyphFirstKeys, glyphSecondKeys);
    appendPairs(glyphFirstKeys, groupSecondKeys);
    appendPairs(groupFirstKeys, glyphSecondKeys);
    appendPairs(groupFirstKeys, groupSecondKeys);

    return orderedPairs;
}

function getFlatKerningPairValue(
    kerning: KerningContainer,
    firstKey: string,
    secondKey: string
): number | null {
    const flatKey = getFlatKerningPairKey(firstKey, secondKey);

    if (kerning instanceof Map) {
        const value = kerning.get(flatKey);
        return typeof value === 'number' ? value : null;
    }

    const value = kerning[flatKey];
    return typeof value === 'number' ? value : null;
}

function usesFlatKerningPairs(kerning: KerningContainer | undefined): boolean {
    if (!kerning) {
        return false;
    }

    if (kerning instanceof Map) {
        for (const [key, value] of kerning.entries()) {
            if (typeof value === 'number' || key.includes(':')) {
                return true;
            }
        }
        return false;
    }

    return Object.entries(kerning).some(
        ([key, value]) => typeof value === 'number' || key.includes(':')
    );
}

function collectKerningGroupMemberships(
    groups: Record<string, string[]> | undefined,
    glyphName: string | null
): string[] {
    if (!groups || !glyphName) {
        return [];
    }

    const memberships: string[] = [];
    for (const [groupName, members] of Object.entries(groups)) {
        if (!Array.isArray(members) || !members.includes(glyphName)) {
            continue;
        }
        memberships.push(groupName);
    }

    memberships.sort((left, right) => left.localeCompare(right));
    return memberships;
}

function formatKerningOperandLabel(
    kind: 'glyph' | 'group',
    name: string
): string {
    return kind === 'group' ? `@${name}` : name;
}

function getKerningPairValue(
    kerning: KerningContainer | undefined,
    firstKey: string,
    secondKey: string
): number | null {
    if (!kerning) {
        return null;
    }

    const flatValue = getFlatKerningPairValue(kerning, firstKey, secondKey);
    if (flatValue !== null) {
        return flatValue;
    }

    if (kerning instanceof Map) {
        const row = kerning.get(firstKey);
        if (!isKerningRow(row)) {
            return null;
        }
        if (row instanceof Map) {
            const value = row.get(secondKey);
            return typeof value === 'number' ? value : null;
        }
        const value = row[secondKey];
        return typeof value === 'number' ? value : null;
    }

    const row = kerning[firstKey];
    if (!isKerningRow(row)) {
        return null;
    }

    if (row instanceof Map) {
        const value = row.get(secondKey);
        return typeof value === 'number' ? value : null;
    }

    const value = row[secondKey];
    return typeof value === 'number' ? value : null;
}

function compareLocationMaps(
    left: Record<string, any> | null | undefined,
    right: Record<string, any> | null | undefined,
    axesOrder: string[]
): number {
    for (const tag of axesOrder) {
        const leftValue = Number(left?.[tag] ?? 0);
        const rightValue = Number(right?.[tag] ?? 0);
        const diff = leftValue - rightValue;
        if (Math.abs(diff) > 0.000001) {
            return diff;
        }
    }

    const extraLeftTags = Object.keys(left || {}).filter(
        (tag) => !axesOrder.includes(tag)
    );
    const extraRightTags = Object.keys(right || {}).filter(
        (tag) => !axesOrder.includes(tag)
    );
    const allExtraTags = Array.from(
        new Set([...extraLeftTags, ...extraRightTags])
    ).sort();

    for (const tag of allExtraTags) {
        const leftValue = Number(left?.[tag] ?? 0);
        const rightValue = Number(right?.[tag] ?? 0);
        const diff = leftValue - rightValue;
        if (Math.abs(diff) > 0.000001) {
            return diff;
        }
    }

    return 0;
}

export type QCCanvasMarker = {
    glyphName: string;
    position: [number, number];
    userspaceLocation?: UserspaceLocation | null;
};

class GlyphCanvas {
    static COLLAPSED_EDITOR_VIEWPORT_FREEZE_WIDTH = 96;

    container: HTMLElement;
    canvasHost: HTMLElement | null = null;
    canvas: HTMLCanvasElement | null = null;
    ctx: CanvasRenderingContext2D | null = null;
    outlineEditor: OutlineEditor = new OutlineEditor(this);

    axesManager: AxesManager | null = null;
    featuresManager: FeaturesManager | null = null;
    textRunEditor: TextRunEditor | null = null;
    renderer: GlyphCanvasRenderer | null = null;

    initialScale: number = 0.2;
    viewportManager: ViewportManager | null = null;

    currentFont: any = null;
    fontBlob: Blob | null = null;
    fontBytes: Uint8Array | null = null;
    sourceGlyphNames: { [gid: number]: string } = {};

    isFocused: boolean = false;
    initialFontLoaded: boolean = false;

    blurTimeoutId: any = null; // Delay blur to prevent cursor flicker when clicking sidebar

    mouseX: number = 0;
    mouseY: number = 0;
    glyphBounds: any[] = [];

    fontData: any = null;

    isSliderActive: boolean = false;

    glyphSelectionSequence: number = 0;

    textChangeDebounceTimer: any = null; // NodeJS.Timeout is not available in browser
    // Adaptive debounce timing for progressive typing compilation
    textChangeLastKeystrokeTime: number = 0;
    textChangeBurstThreshold: number = 200; // ms - keystrokes within this window considered "burst typing"
    textChangeFastDelay: number = 150; // ms - delay during fast typing bursts
    textChangeSlowDelay: number = 150; // ms - delay during slow typing
    textChangeLastSubsetKey: string = '';
    textInputFullCompileTimer: any = null; // Deferred full compilation after typing stops

    resizeObserver: ResizeObserver | null = null;

    // Track previous container dimensions for resize handling
    lastContainerWidth: number = 0;
    lastContainerHeight: number = 0;
    lastStableViewportSnapshot: {
        scale: number;
        panX: number;
        panY: number;
    } | null = null;
    collapsedViewportSnapshot: {
        scale: number;
        panX: number;
        panY: number;
    } | null = null;
    suppressNextViewportResizeAdjustment: boolean = false;

    private snapshotCurrentViewport(): {
        scale: number;
        panX: number;
        panY: number;
    } | null {
        if (!this.viewportManager) {
            return null;
        }

        return {
            scale: this.viewportManager.scale,
            panX: this.viewportManager.panX,
            panY: this.viewportManager.panY
        };
    }

    freezeViewportForCollapse(): void {
        const liveViewportSnapshot = this.snapshotCurrentViewport();
        if (!liveViewportSnapshot) {
            return;
        }

        this.collapsedViewportSnapshot = liveViewportSnapshot;
        this.lastStableViewportSnapshot = liveViewportSnapshot;
    }

    restoreViewportAfterCollapse(): void {
        if (!this.viewportManager) {
            return;
        }

        const snapshot =
            this.collapsedViewportSnapshot || this.lastStableViewportSnapshot;
        if (!snapshot) {
            return;
        }

        this.viewportManager.scale = snapshot.scale;
        this.viewportManager.panX = snapshot.panX;
        this.viewportManager.panY = snapshot.panY;
        this.lastStableViewportSnapshot = { ...snapshot };
        this.suppressNextViewportResizeAdjustment = true;
        this.render();
    }

    propertiesSection: HTMLElement | null = null;
    propertyPanel: HTMLElement | null = null;
    leftSidebar: HTMLElement | null = null;
    rightSidebar: HTMLElement | null = null;
    axesSection: HTMLElement | null = null;
    glyphStackLabel: HTMLElement | null = null;
    restoreCanvasFocusAfterPropertyCommit: boolean = false;
    textModeKerningSelection: TextModeKerningSelection = {
        firstKey: null,
        secondKey: null
    };
    textModeKerningSelectionPinned: boolean = false;
    textModeKerningSelectionScopeKey: string | null = null;
    textModeKerningDraftPairKey: string | null = null;
    textModeKerningDraftScopeKey: string | null = null;
    textModeKerningDraftValue: string | null = null;
    textModeKerningOverlayCache: TextModeKerningOverlayCache | null = null;

    zoomAnimation: {
        active: boolean;
        currentFrame: number;
        totalFrames: number;
        startScale: number;
        endScale: number;
        centerX: number;
        centerY: number;
    } = {
        active: false,
        currentFrame: 0,
        totalFrames: 0,
        startScale: 0,
        endScale: 0,
        centerX: 0,
        centerY: 0
    };

    // Internal state properties not in constructor
    measurementKeyPressed: boolean = false;
    isDraggingCanvas: boolean = false;
    lastMouseX: number = 0;
    lastMouseY: number = 0;
    mouseCanvasX: number = 0;
    mouseCanvasY: number = 0;
    cursorVisible: boolean = true;
    private mouseUpFinalization: Promise<void> | null = null;

    // Measurement tool
    measurementTool!: MeasurementTool; // Initialized in constructor

    // Stack preview animator for component visualization
    stackPreviewAnimator!: StackPreviewAnimator; // Initialized in constructor

    // Auto-pan anchor for text mode (cursor position)
    textModeAutoPanAnchorScreen: { x: number; y: number } | null = null;
    textModeEscapeState: SavedVariationState = new SavedVariationState();

    activeQcCanvasMarkers: QCCanvasMarker[] = [];

    // Pending anchors for feature changes that trigger font recompilation
    // These are applied after the editing font reloads to prevent glyph jumping
    pendingFeatureChangeAnchor: {
        editing: { x: number; y: number } | null;
        text: { x: number; y: number } | null;
    } = { editing: null, text: null };

    // Flag to suppress rendering during critical operations (e.g., layer data swap)
    renderSuppressed: boolean = false;
    hasDeferredRenderRequest: boolean = false;
    editModeGlyphResyncInProgress: boolean = false;

    // Flag to prevent overlapping updatePropertiesUI calls
    isUpdatingPropertiesUI: boolean = false;

    private handleLayerFingerprintChanged = (event: Event): void => {
        if (!this.outlineEditor.active) {
            return;
        }

        const detail = (event as CustomEvent).detail;
        const currentGlyphName =
            this.outlineEditor.getLayerLinkGlyphName() ||
            this.getCurrentGlyphName();

        if (detail?.glyphName && detail.glyphName !== currentGlyphName) {
            return;
        }

        if (this.outlineEditor.draggingSomething) {
            console.log(
                '[DRAG-DEBUG] Skipping updatePropertiesUI from layerFingerprintChanged during drag'
            );
            return;
        }

        void this.updatePropertiesUI();
    };

    private handleFontModelSync = (): void => {
        this.invalidateTextModeKerningOverlayCache();

        if (
            this.textModeKerningDraftPairKey === null &&
            this.textModeKerningDraftScopeKey === null &&
            this.textModeKerningDraftValue === null
        ) {
            if (this.outlineEditor.active || !this.propertyPanel) {
                return;
            }

            this.updatePropertyPanel();
            this.render();
            return;
        }

        this.textModeKerningDraftPairKey = null;
        this.textModeKerningDraftScopeKey = null;
        this.textModeKerningDraftValue = null;

        if (this.outlineEditor.active || !this.propertyPanel) {
            return;
        }

        this.updatePropertyPanel();
        this.render();
    };

    constructor(containerId: string) {
        this.container = document.getElementById(containerId)!;
        if (!this.container) {
            console.error(`Container ${containerId} not found`);
            return;
        }

        // Initialize measurement tool
        this.measurementTool = new MeasurementTool(this);

        // Initialize stack preview animator
        this.stackPreviewAnimator = new StackPreviewAnimator(this);

        this.axesManager = new AxesManager();
        this.featuresManager = new FeaturesManager();
        this.textRunEditor = new TextRunEditor(
            this.featuresManager,
            this.axesManager
        );

        this.init();
    }

    init(): void {
        this.container.replaceChildren();

        this.canvasHost = document.createElement('div');
        this.canvasHost.className = 'glyph-canvas-viewport';
        this.container.appendChild(this.canvasHost);

        // Create canvas element
        this.canvas = document.createElement('canvas');
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.display = 'block';
        this.canvas.style.cursor = 'default';
        this.canvas.style.outline = 'none'; // Remove focus outline
        this.canvas.tabIndex = 0; // Make canvas focusable
        this.canvas.dataset.hasContextMenu = 'true';
        this.canvasHost.appendChild(this.canvas);

        this.propertyPanel = document.createElement('div');
        this.propertyPanel.className = 'glyph-property-panel';
        this.container.appendChild(this.propertyPanel);

        this.outlineEditor.canvas = this.canvas;

        // Set up HiDPI canvas
        this.setupHiDPI();

        // Set initial scale and position with deterministic values
        // Using fixed values instead of getBoundingClientRect() for consistency
        this.viewportManager = new ViewportManager(
            this.initialScale,
            100, // Fixed horizontal pan
            250 // Fixed vertical pan
        );
        this.renderer = new GlyphCanvasRenderer(
            this.canvas,
            this,
            this.viewportManager,
            this.textRunEditor!
        );

        // Set up event listeners
        this.setupEventListeners();

        // Initial render
        this.render();

        this.textRunEditor!.init();
    }

    setupHiDPI(): void {
        const dpr = window.devicePixelRatio || 1;

        // Get the container size (not the canvas bounding rect, which might be stale)
        const measurementTarget = this.canvasHost || this.container;
        const containerWidth = measurementTarget.clientWidth;
        const containerHeight = measurementTarget.clientHeight;

        // Set the canvas size in actual pixels (accounting for DPR)
        this.canvas!.width = containerWidth * dpr;
        this.canvas!.height = containerHeight * dpr;

        // Set CSS size to match container
        this.canvas!.style.width = containerWidth + 'px';
        this.canvas!.style.height = containerHeight + 'px';

        // Get context again and scale for DPR
        this.ctx = this.canvas!.getContext('2d');
        this.ctx!.scale(dpr, dpr);
    }

    setupEventListeners(): void {
        window.addEventListener(
            'layerFingerprintChanged',
            this.handleLayerFingerprintChanged
        );
        window.addEventListener('fontModelSync', this.handleFontModelSync);

        // Mouse events for panning
        this.canvas!.addEventListener('mousedown', (e) => this.onMouseDown(e));
        this.canvas!.addEventListener('mousemove', (e) => this.onMouseMove(e));
        this.canvas!.addEventListener('mouseup', (e) => {
            void this.onMouseUp(e);
        });
        this.canvas!.addEventListener('mouseleave', (e) =>
            this.onMouseLeave(e)
        );
        this.canvas!.addEventListener('contextmenu', (e) => {
            const rect = this.canvas!.getBoundingClientRect();
            this.mouseX = e.clientX - rect.left;
            this.mouseY = e.clientY - rect.top;
            this.mouseCanvasX = (this.mouseX * this.canvas!.width) / rect.width;
            this.mouseCanvasY =
                (this.mouseY * this.canvas!.height) / rect.height;

            if (!this.measurementTool.shouldBlockHitDetection()) {
                this.outlineEditor.performHitDetection(e);
                this.updateHoveredGlyph();
            }

            this.outlineEditor.onContextMenu(e);
        });

        // Wheel event for zooming
        this.canvas!.addEventListener('wheel', (e) => this.onWheel(e), {
            passive: false
        });

        // Mouse move for hover detection
        this.canvas!.addEventListener('mousemove', (e) =>
            this.onMouseMoveHover(e)
        );

        // Keyboard events for cursor and text input
        this.canvas!.addEventListener('keydown', (e) => {
            if (this.shouldBlockTextEditingDuringLoopAnimation(e)) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }

            console.log(
                'keydown:',
                e.key,
                e.code,
                'metaKey:',
                e.metaKey,
                'spaceKeyPressed:',
                this.outlineEditor.spaceKeyPressed
            );
            // Track Tab for the measurement tool and keep focus on the canvas
            if (e.key === 'Tab' && !e.defaultPrevented) {
                e.preventDefault();
                if (!this.measurementKeyPressed) {
                    this.measurementKeyPressed = true;
                    this.measurementTool.handleMeasurementKeyPress();
                    this.render();
                }
            }
            this.onKeyDown(e);
            if (e.key === 'Alt') {
                this.outlineEditor.setAltKeyPressed(true);
            }
            if (e.key === 'Meta' || e.key === 'Control') {
                this.outlineEditor.setCommandKeyPressed(true);
                this.updateCursorStyle();
                this.render();
            }
        });
        this.canvas!.addEventListener('keyup', (e) => {
            if (this.shouldBlockTextEditingDuringLoopAnimation(e)) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }

            console.log(
                'keyup:',
                e.key,
                e.code,
                'metaKey:',
                e.metaKey,
                'spaceKeyPressed:',
                this.outlineEditor.spaceKeyPressed
            );

            // Track Tab release
            if (e.key === 'Tab' && !e.defaultPrevented) {
                e.preventDefault();
                this.measurementKeyPressed = false;
                this.measurementTool.handleMeasurementKeyRelease();
                this.updateCursorStyle(); // Update cursor immediately
                this.render();
            }

            // Track Space key release
            if (e.code === 'Space') {
                console.log(
                    '  -> Releasing Space key, active:',
                    this.outlineEditor.active
                );
                if (this.outlineEditor.active) {
                    // In edit mode, handle space as preview mode toggle
                    this.outlineEditor.onSpaceKeyReleased();
                } else {
                    // In text mode, handle space with delay logic
                    console.log('  -> Calling textRunEditor.handleKeyUp');
                    this.textRunEditor!.handleKeyUp(e);
                }
            }

            if (e.key === 'Alt') {
                this.outlineEditor.setAltKeyPressed(false);
            }
            if (e.key === 'Meta' || e.key === 'Control') {
                this.outlineEditor.setCommandKeyPressed(false);
                this.updateCursorStyle();
                this.render();
            }

            this.outlineEditor.onKeyUp(e);
        });

        // Reset key states when window loses focus (e.g., Cmd+Tab to switch apps)
        window.addEventListener('blur', () => {
            this.measurementKeyPressed = false;
            this.isDraggingCanvas = false;
            this.outlineEditor.onBlur();
            this.outlineEditor.setAltKeyPressed(false);
            if (this.canvas) {
                this.canvas.style.cursor = this.outlineEditor.active
                    ? 'default'
                    : 'text';
            }
        });

        // Reset modifier key states when window regains focus (e.g., Cmd+Tab back to app).
        // Without this, the app behaves as if Cmd/Ctrl is still held after switching back
        // because the keyup for the modifier may fire before focus returns or may be
        // intercepted by the OS. Resetting on focus ensures a clean slate — the user
        // must press the modifier key again within the app to activate Cmd/Ctrl features.
        window.addEventListener('focus', () => {
            this.outlineEditor.setCommandKeyPressed(false);
            this.outlineEditor.setAltKeyPressed(false);
        });

        // Also reset when canvas loses focus
        this.canvas!.addEventListener('blur', () => {
            this.measurementKeyPressed = false;
            this.isDraggingCanvas = false;
            this.outlineEditor.cancelQueuedKeyboardPreviewMoves();
            this.outlineEditor.setCommandKeyPressed(false);
            // Note: Don't reset spaceKeyPressed here - it should be handled by the keyup event
            // Resetting it here causes preview mode to malfunction because the keyup handler
            // can't tell if preview mode was activated
            // Don't exit preview mode when canvas loses focus to sidebar elements
            // (e.g., clicking sliders). Preview mode will be managed by slider events.
            // Only exit preview mode on true blur events (window blur, etc.)
        });

        // Capture Tab at the document level while the editor view is focused so
        // browser focus traversal cannot move to other HTML elements first.
        document.addEventListener(
            'keydown',
            (e) => {
                if (window.glyphCanvas !== this) {
                    return;
                }

                if (!this.shouldHandleMeasurementTabGlobally(e)) {
                    return;
                }

                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();

                this.focusCanvasForMeasurementTab();

                if (!this.measurementKeyPressed) {
                    this.measurementKeyPressed = true;
                    this.measurementTool.handleMeasurementKeyPress();
                    this.updateCursorStyle();
                    this.render();
                }
            },
            true
        );

        document.addEventListener(
            'keyup',
            (e) => {
                if (window.glyphCanvas !== this) {
                    return;
                }

                if (e.key !== 'Tab' || !this.measurementKeyPressed) {
                    return;
                }

                const editorView = document.querySelector('#view-editor');
                const isEditorFocused =
                    !!editorView && editorView.classList.contains('focused');
                const activeElement =
                    document.activeElement as HTMLElement | null;
                const isCanvasActive = activeElement === this.canvas;

                if (!isCanvasActive && !isEditorFocused) {
                    return;
                }

                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                this.focusCanvasForMeasurementTab();
                this.measurementKeyPressed = false;
                this.measurementTool.handleMeasurementKeyRelease();
                this.updateCursorStyle();
                this.render();
            },
            true
        );

        // Global Escape key handler (works even when sliders have focus)
        // Only active when editor view is focused
        // Note: Settings panel escape is handled in theme-switcher.js with capture phase
        document.addEventListener('keydown', (e) => {
            // Block all input during stack preview animation
            if (this.stackPreviewAnimator.isInputBlocked()) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }

            if (e.key === 'Escape') {
                // Check if stack preview is active first
                if (
                    this.stackPreviewAnimator.isActive &&
                    !this.stackPreviewAnimator.isAnimating
                ) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.stackPreviewAnimator.reverseAnimation();
                    return;
                }
                if (!this.outlineEditor.active) {
                    this.handleTextModeEscapeKey(e);
                    return;
                }
                this.outlineEditor.onEscapeKey(e);
            }
        });

        // Cmd+Alt+S handler with capture phase to activate stack preview
        document.addEventListener('keydown', (e) => {
            // Use code instead of key because Alt+S produces '‚' on macOS
            if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyS') {
                console.log('[GlyphCanvas] Cmd+Alt+S detected', {
                    key: e.key,
                    code: e.code,
                    metaKey: e.metaKey,
                    ctrlKey: e.ctrlKey,
                    altKey: e.altKey,
                    outlineEditorActive: this.outlineEditor.active,
                    stackPreviewActive: this.stackPreviewAnimator.isActive,
                    stackPreviewAnimating: this.stackPreviewAnimator.isAnimating
                });

                // Check if editing view is active and in editing mode
                const editorView = document.querySelector('#view-editor');
                const isEditorFocused =
                    editorView && editorView.classList.contains('focused');

                console.log('[GlyphCanvas] Editor focus check:', {
                    editorView: !!editorView,
                    isEditorFocused,
                    outlineEditorActive: this.outlineEditor.active
                });

                if (isEditorFocused && this.outlineEditor.active) {
                    e.preventDefault();
                    e.stopPropagation();

                    if (
                        !this.stackPreviewAnimator.isActive &&
                        !this.stackPreviewAnimator.isAnimating
                    ) {
                        console.log(
                            '[GlyphCanvas] Starting stack preview mode'
                        );
                        this.stackPreviewAnimator.startAnimation();
                    } else if (
                        this.stackPreviewAnimator.isActive &&
                        !this.stackPreviewAnimator.isAnimating
                    ) {
                        console.log('[GlyphCanvas] Closing stack preview mode');
                        this.stackPreviewAnimator.reverseAnimation();
                    } else {
                        console.log(
                            '[GlyphCanvas] Stack preview already active or animating'
                        );
                    }
                } else {
                    console.log(
                        '[GlyphCanvas] Not starting stack preview - editor not focused or not active'
                    );
                }
            }
        });

        document.addEventListener(
            'keydown',
            (e) => {
                if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyL') {
                    const editorView = document.querySelector('#view-editor');
                    const isEditorFocused =
                        !!editorView &&
                        editorView.classList.contains('focused');

                    if (!isEditorFocused || !this.outlineEditor.active) {
                        return;
                    }

                    e.preventDefault();
                    e.stopPropagation();

                    const summaryLinkButton =
                        this.propertiesSection?.querySelector(
                            '.editor-layer-link-summary-toggle'
                        ) as HTMLButtonElement | null;
                    summaryLinkButton?.click();
                }
            },
            true
        );

        document.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyG') {
                const editorView = document.querySelector('#view-editor');
                const isEditorFocused =
                    !!editorView && editorView.classList.contains('focused');

                if (!isEditorFocused) {
                    return;
                }

                e.preventDefault();
                e.stopPropagation();
                this.outlineEditor.toggleGuidelinesVisible();
            }
        });

        // Focus/blur for cursor blinking
        this.canvas!.addEventListener('focus', () => this.onFocus());
        this.canvas!.addEventListener('blur', () => this.onBlur());

        // Window resize
        window.addEventListener('resize', () => this.onResize());

        // Container resize (for when view dividers are moved)
        this.resizeObserver = new ResizeObserver(() => this.onResize());
        this.resizeObserver.observe(this.container);

        // Sidebar click handlers to restore canvas focus in editor mode
        this.setupSidebarFocusHandlers();
        this.setupAxesManagerEventHandlers();
        this.featuresManager!.on('change', async () => {
            console.log(
                '[GlyphCanvas]',
                'Features changed, re-running Stage 2 shaping'
            );

            // Capture anchor before reshaping (cursor in text mode, bbox in editing mode)
            if (
                this.outlineEditor.active &&
                this.outlineEditor.selectedLayerId
            ) {
                // Editing mode: capture bbox center before reshaping
                this.outlineEditor.captureAutoPanAnchor();
            } else {
                // Text mode: capture cursor position before reshaping
                this.captureTextModeAutoPanAnchor();
            }

            // Re-run Stage 2 only (apply new feature settings to existing glyphs).
            // Layout closure ensures all substituted glyphs are already in the editing font,
            // so no compile is needed for feature toggles.
            console.log(
                '[GlyphCanvas]',
                'Re-running Stage 2 with updated features (no font recompilation needed)'
            );
            this.textRunEditor!.shapeStage2WithBiDiRuns();

            // Build cluster map and update cursor position
            this.textRunEditor!.buildClusterMap();
            this.textRunEditor!.updateCursorVisualPosition();

            if (
                this.outlineEditor.active &&
                this.outlineEditor.selectedLayerId
            ) {
                // Rebuild glyph stack with the new glyph name after substitution
                const newGlyphName = this.getCurrentGlyphName();
                this.outlineEditor.currentGlyphName = newGlyphName;
                this.outlineEditor.buildGlyphStack(
                    newGlyphName,
                    this.outlineEditor.selectedLayerId!,
                    []
                );

                // Editing mode: fetch new layer data for the reshaped glyph.
                await this.outlineEditor.fetchLayerData(true, newGlyphName); // Skip render

                // Apply auto-pan adjustment and render
                this.outlineEditor.applyAutoPanAdjustment();
                this.outlineEditor.autoPanAnchorScreen = null;
                this.updateComponentBreadcrumb();
                this.render();
            } else {
                // Text mode: apply auto-pan to keep cursor centered and render
                this.applyTextModeAutoPanAdjustment();
                this.textModeAutoPanAnchorScreen = null;
                this.render();
            }
        });
        this.setupTextEditorEventHandlers();
    }

    setupSidebarFocusHandlers(): void {
        // Add event listeners to both sidebars to restore canvas focus when clicked in editor mode
        const leftSidebar = document.getElementById('glyph-properties-sidebar');
        const rightSidebar = document.getElementById('glyph-editor-sidebar');

        const restoreFocus = (e: MouseEvent) => {
            // Don't restore focus if clicking on text input fields
            const target = e.target as HTMLElement;
            if (target && this.isTextInputElement(target)) {
                return;
            }

            // Always restore focus to canvas when clicking sidebar
            setTimeout(() => this.canvas!.focus(), 0);
        };

        if (leftSidebar) {
            leftSidebar.addEventListener('mousedown', restoreFocus);
        }

        if (rightSidebar) {
            rightSidebar.addEventListener('mousedown', restoreFocus);
        }
    }

    isTextInputElement(element: HTMLElement): boolean {
        if (!element) return false;

        const tagName = element.tagName?.toLowerCase();
        const type = (element as HTMLInputElement).type?.toLowerCase();

        // Check if it's a text input type
        if (tagName === 'input') {
            const textInputTypes = [
                'text',
                'password',
                'email',
                'search',
                'tel',
                'url',
                'number'
            ];
            return !type || textInputTypes.includes(type);
        }

        // Check if it's a textarea
        if (tagName === 'textarea') {
            return true;
        }

        return false;
    }

    private shouldHandleMeasurementTabGlobally(event: KeyboardEvent): boolean {
        if (event.key !== 'Tab') {
            return false;
        }

        const target = event.target as HTMLElement | null;
        if (target && this.isTextInputElement(target)) {
            return false;
        }

        const editorView = document.querySelector('#view-editor');
        const isEditorFocused =
            !!editorView && editorView.classList.contains('focused');
        const activeElement = document.activeElement as HTMLElement | null;
        const isCanvasActive = activeElement === this.canvas;

        return isCanvasActive || isEditorFocused;
    }

    private focusCanvasForMeasurementTab(): void {
        if (!this.canvas || document.activeElement === this.canvas) {
            return;
        }

        this.canvas.focus({ preventScroll: true });
    }

    private focusCanvasForTextModeKerning(): void {
        if (this.outlineEditor.active) {
            return;
        }

        this.focusCanvasForMeasurementTab();
    }

    shouldBlockTextEditingDuringLoopAnimation(e: KeyboardEvent): boolean {
        if (!this.axesManager?.isLoopAnimating || this.outlineEditor.active) {
            return false;
        }

        if (e.metaKey || e.ctrlKey) {
            return false;
        }

        if (e.key === 'Backspace' || e.key === 'Delete') {
            return true;
        }

        if (e.code === 'Space') {
            return true;
        }

        return e.key.length === 1;
    }

    setupAxesManagerEventHandlers(): void {
        this.axesManager!.on('sliderMouseDown', async () => {
            // Ensure a full compile (with features/kerning) exists before
            // axis changes, since HarfBuzz shaping during slider animation
            // depends on GPOS/kerning tables being present in the font.
            await fontManager.ensureFullEditingCompile();
            this.outlineEditor.onSliderMouseDown();
            // Also capture text mode cursor position for auto-panning
            if (!this.outlineEditor.active && this.textRunEditor) {
                const selectedMasterId = this.textRunEditor.selectedMasterId;
                if (
                    this.axesManager &&
                    this.textModeEscapeState.save(
                        selectedMasterId,
                        this.axesManager.variationSettings
                    )
                ) {
                    console.log(
                        '[GlyphCanvas] Saved previous text mode state for Escape:',
                        {
                            masterId: selectedMasterId,
                            settings: this.axesManager.variationSettings
                        }
                    );
                }

                this.textRunEditor.selectedMasterId = null;
                this.updateMasterSelection();
                this.captureTextModeAutoPanAnchor();
            }
        });
        this.axesManager!.on('sliderMouseUp', async () => {
            console.log('[GlyphCanvas] sliderMouseUp event triggered');
            if (this.outlineEditor.active) {
                console.log(
                    '[GlyphCanvas] Calling outlineEditor.onSliderMouseUp()'
                );
                await this.outlineEditor.onSliderMouseUp();
            } else {
                await this.finalizeTextModeSliderInteraction();
                // In text editing mode, restore focus to canvas
                // Clear auto-pan anchor if animation is already complete
                if (!this.axesManager!.isAnimating) {
                    this.textModeAutoPanAnchorScreen = null;
                }
                setTimeout(() => this.canvas!.focus(), 0);
            }
        });
        this.axesManager!.on('textFieldAnimationComplete', async () => {
            // Skip layer selection during loop animation (play button)
            if (this.axesManager!.isLoopAnimating) {
                return;
            }
            // Handle layer selection after text field change animation completes
            if (this.outlineEditor.active) {
                await this.outlineEditor.autoSelectMatchingLayer();
                this.outlineEditor.isInterpolating = false;
                this.outlineEditor.autoPanAnchorScreen = null;
                this.render();
            }
        });
        this.axesManager!.on('animationInProgress', () => {
            // In text mode, reshape with HarfBuzz and apply auto-pan together (skip render in shapeText)
            if (!this.outlineEditor.active) {
                this.textRunEditor!.shapeText(true); // Skip render - we'll render after auto-pan
                this.applyTextModeAutoPanAdjustment();
                this.render(); // Single render after both HarfBuzz and auto-pan are updated
            } else {
                // In editing mode, sync HarfBuzz to the current variation settings
                // before calling outlineEditor. The outline handles interpolation of
                // glyph shapes, but HarfBuzz must match the current axis location
                // so text preview stays in sync during play-loop or slider animation.
                const textRun = this.textRunEditor;
                const location = this.axesManager!.variationSettings;
                if (
                    textRun &&
                    textRun.hbFont &&
                    Object.keys(location).length > 0
                ) {
                    textRun.hbFont.setVariations(location);
                }
                this.outlineEditor.animationInProgress();
            }
        });
        this.axesManager!.on('animationComplete', async () => {
            try {
                console.log('[GlyphCanvas] animationComplete event triggered', {
                    isInterpolating: this.outlineEditor.isInterpolating,
                    isLayerSwitchAnimating:
                        this.outlineEditor.isLayerSwitchAnimating,
                    isSliderActive: this.axesManager!.isSliderActive
                });
            } catch (e) {
                console.error(
                    '[GlyphCanvas] ERROR in animationComplete initial logging:',
                    e
                );
            }
            // If we were animating a layer switch, restore the target layer data
            if (this.outlineEditor.isLayerSwitchAnimating) {
                console.log(
                    '[GlyphCanvas] Animation complete - calling restoreTargetLayerDataAfterAnimating()'
                );
                this.outlineEditor.restoreTargetLayerDataAfterAnimating();
                this.outlineEditor.isLayerSwitchAnimating = false;
                console.log(
                    '[GlyphCanvas] Layer switch animation restoration complete'
                );

                // NOTE: autoSelectMatchingLayer() is already called inside restoreTargetLayerDataAfterAnimating()
                // so we don't need to call it again here

                // Clear auto-pan anchor now that animation is complete
                this.outlineEditor.autoPanAnchorScreen = null;

                this.textRunEditor!.shapeText();
                this.textModeAutoPanAnchorScreen = null;
                return;
            }

            // Final HarfBuzz sync — ensure text preview matches the final
            // axis location, even during or after outline interpolation.
            // This fixes the case where HarfBuzz lagged behind after stop or
            // layer switch animation completion.
            this.textRunEditor!.shapeText();

            // During manual slider interpolation (isInterpolating), clear flags
            // if slider is no longer active. The interpolation callback already
            // synced HarfBuzz, but we sync again here for safety.
            if (this.outlineEditor.isInterpolating) {
                if (!this.axesManager!.isSliderActive) {
                    this.outlineEditor.isInterpolating = false;
                    this.outlineEditor.autoPanAnchorScreen = null;
                    this.textModeAutoPanAnchorScreen = null;
                }
                return;
            }

            // Restore focus to canvas after animation completes (for text editing mode)
            if (!this.outlineEditor.active) {
                setTimeout(() => this.canvas!.focus(), 0);
            }
        });
        this.axesManager!.on(
            'onSliderChange',
            this.outlineEditor.onSliderChange.bind(this.outlineEditor)
        );
        // Auto-select or deselect master/layer when slider changes
        this.axesManager!.on('onSliderChange', () => {
            // Skip layer selection during loop animation (play button)
            if (this.axesManager!.isLoopAnimating) {
                return;
            }
            if (this.outlineEditor.active) {
                // In edit mode, auto-select matching layer during slider drag
                console.log(
                    '[GlyphCanvas] Slider changed in edit mode, calling autoSelectMatchingLayer'
                );
                this.outlineEditor.autoSelectMatchingLayer();
            } else {
                // In text mode, auto-select matching master
                console.log(
                    '[GlyphCanvas] Slider changed, calling autoSelectMatchingMaster'
                );
                this.autoSelectMatchingMaster();
            }
        });
        // Also check after animation completes to handle the final value
        this.axesManager!.on('animationComplete', () => {
            // Skip during loop animation (play button)
            if (this.axesManager!.isLoopAnimating) {
                return;
            }
            // Skip during layer switch animations - layer restoration will handle it
            if (this.outlineEditor.isLayerSwitchAnimating) {
                console.log(
                    '[GlyphCanvas] Animation complete during layer switch - skipping autoSelectMatchingMaster'
                );
                return;
            }
            console.log(
                '[GlyphCanvas] Animation complete, calling autoSelectMatchingMaster'
            );
            this.autoSelectMatchingMaster();
        });
    }

    setupTextEditorEventHandlers(): void {
        this.textRunEditor!.on('cursormoved', () => {
            this.updatePropertyPanel();
            this.panToCursor();
            this.render();
        });
        this.textRunEditor!.on('textchanged', () => {
            this.onTextChange();
        });
        this.textRunEditor!.on('render', () => {
            if (this.outlineEditor.active) {
                const nextGlyphName = this.getCurrentGlyphName();
                const activeRootGlyphName =
                    this.getActiveEditModeRootGlyphName();

                if (
                    nextGlyphName &&
                    nextGlyphName !== 'undefined' &&
                    nextGlyphName !== activeRootGlyphName
                ) {
                    void this.syncEditModeGlyphAfterTextMutation();
                    return;
                }
            }

            this.updatePropertyPanel();
            this.render();
        });
        this.textRunEditor!.on('exitcomponentediting', () => {
            this.outlineEditor.exitAllComponentEditing();
        });
        this.textRunEditor!.on('activatePreviewMode', () => {
            // Activate preview mode when space key timer expires in text mode
            this.outlineEditor.spaceKeyPressed = true;
            this.outlineEditor.isPreviewMode = true;
            // Store current cursor style and switch to grab cursor
            this.textRunEditor!.cursorStyleBeforePreview =
                this.canvas!.style.cursor;
            this.canvas!.style.cursor = 'grab';
            this.render();
        });
        this.textRunEditor!.on('deactivatePreviewMode', () => {
            // Deactivate preview mode when space key is released after long press
            console.log(
                '[GlyphCanvas] Deactivating preview mode, current state:',
                {
                    spaceKeyPressed: this.outlineEditor.spaceKeyPressed,
                    isPreviewMode: this.outlineEditor.isPreviewMode
                }
            );
            this.outlineEditor.spaceKeyPressed = false;
            this.outlineEditor.isPreviewMode = false;
            // Restore previous cursor style
            if (this.textRunEditor!.cursorStyleBeforePreview) {
                this.canvas!.style.cursor =
                    this.textRunEditor!.cursorStyleBeforePreview;
                this.textRunEditor!.cursorStyleBeforePreview = null;
            } else {
                // Fallback to text cursor
                this.canvas!.style.cursor = 'text';
            }
            // Ensure text cursor is visible
            this.cursorVisible = true;
            console.log('[GlyphCanvas] After deactivation:', {
                spaceKeyPressed: this.outlineEditor.spaceKeyPressed,
                isPreviewMode: this.outlineEditor.isPreviewMode,
                cursorVisible: this.cursorVisible
            });
            this.render();
        });
        this.textRunEditor!.on(
            'glyphselected',
            async (
                ix: number,
                previousIndex: number,
                fromKeyboard: boolean = false
            ) => {
                const wasInEditMode = this.outlineEditor.active;

                // Increment sequence counter to track this selection
                this.glyphSelectionSequence++;
                const currentSequence = this.glyphSelectionSequence;

                // Save the previous glyph's vertical bounds BEFORE clearing layer data
                if (
                    wasInEditMode &&
                    previousIndex >= 0 &&
                    previousIndex !== ix &&
                    this.outlineEditor.layerData
                ) {
                    try {
                        const prevBounds =
                            this.outlineEditor.calculateGlyphBoundingBox();
                        if (
                            prevBounds &&
                            previousIndex <
                                this.textRunEditor!.shapedGlyphs.length
                        ) {
                            const prevPos =
                                this.textRunEditor!._getGlyphPosition(
                                    previousIndex
                                );
                            const fontSpaceMinY =
                                prevPos.yOffset + prevBounds.minY;
                            const fontSpaceMaxY =
                                prevPos.yOffset + prevBounds.maxY;

                            // Update accumulated vertical bounds with previous glyph
                            if (
                                !this.viewportManager!.accumulatedVerticalBounds
                            ) {
                                this.viewportManager!.accumulatedVerticalBounds =
                                    {
                                        minY: fontSpaceMinY,
                                        maxY: fontSpaceMaxY
                                    };
                            } else {
                                this.viewportManager!.accumulatedVerticalBounds.minY =
                                    Math.min(
                                        this.viewportManager!
                                            .accumulatedVerticalBounds.minY,
                                        fontSpaceMinY
                                    );
                                this.viewportManager!.accumulatedVerticalBounds.maxY =
                                    Math.max(
                                        this.viewportManager!
                                            .accumulatedVerticalBounds.maxY,
                                        fontSpaceMaxY
                                    );
                            }
                            console.log(
                                'Saved previous glyph vertical bounds:',
                                {
                                    fontSpaceMinY,
                                    fontSpaceMaxY
                                }
                            );
                        }
                    } catch (error) {
                        console.warn(
                            'Could not save previous glyph bounds:',
                            error
                        );
                    }
                }

                if (
                    wasInEditMode &&
                    previousIndex >= 0 &&
                    previousIndex !== ix
                ) {
                    const nextGlyphName =
                        ix >= 0 && ix < this.textRunEditor!.shapedGlyphs.length
                            ? this.getCurrentGlyphName()
                            : 'undefined';
                    this.outlineEditor.prepareForGlyphSwitch(nextGlyphName);
                }

                // Clear layer data immediately to prevent rendering stale outlines
                this.outlineEditor.layerData = null;

                // Clear glyph_stack when switching to a new glyph
                // It will be rebuilt when a layer is selected for the new glyph
                this.outlineEditor.glyphStack = '';

                if (ix != -1) {
                    this.outlineEditor.active = true;
                    // Dispatch mode change event for URL sync
                    window.dispatchEvent(
                        new CustomEvent('editorModeChanged', {
                            detail: { mode: 'edit' }
                        })
                    );
                }
                // Update breadcrumb (will hide it since component stack is now empty)
                // Need to await doUIUpdate if we want to pan to glyph afterward
                if (
                    fromKeyboard &&
                    wasInEditMode &&
                    ix >= 0 &&
                    previousIndex !== ix
                ) {
                    // Need to wait for layer data to be loaded before panning
                    await this.doUIUpdateAsync();

                    // Check if this selection is still current (not superseded by a newer one)
                    if (currentSequence !== this.glyphSelectionSequence) {
                        console.log(
                            'Glyph selection superseded, skipping render/pan for sequence',
                            currentSequence
                        );
                        return;
                    }

                    // Only pan if we're on a layer (not interpolating)
                    // If interpolating, panToGlyph will be called after interpolation completes
                    if (this.outlineEditor.selectedLayerId !== null) {
                        this.panToGlyph(ix);
                    }
                } else {
                    // Not panning, just do regular UI update
                    this.doUIUpdate();

                    // Check if this selection is still current (not superseded by a newer one)
                    if (currentSequence !== this.glyphSelectionSequence) {
                        console.log(
                            'Glyph selection superseded, skipping render/pan for sequence',
                            currentSequence
                        );
                        return;
                    }
                }

                this.outlineEditor.onGlyphSelected();
                this.dispatchModeActivationEvent('edit', 'glyphselected');
            }
        );
    }

    async onMouseDown(e: MouseEvent): Promise<void> {
        if (e.button === 2) {
            return;
        }

        // Focus the canvas when clicked
        this.canvas!.focus();
        this.outlineEditor.setCommandKeyPressed(e.metaKey || e.ctrlKey);

        // Refresh mouse position + hover targets at click time.
        // Double-click handling relies on hovered* state and can otherwise use stale values
        // when the pointer did not move just before the click.
        const rect = this.canvas!.getBoundingClientRect();
        this.mouseX = e.clientX - rect.left;
        this.mouseY = e.clientY - rect.top;
        this.mouseCanvasX = (this.mouseX * this.canvas!.width) / rect.width;
        this.mouseCanvasY = (this.mouseY * this.canvas!.height) / rect.height;
        if (!this.measurementTool.shouldBlockHitDetection()) {
            this.outlineEditor.performHitDetection(e);
            this.updateHoveredGlyph();
        }

        // Priority: If Space key is pressed, start canvas panning immediately
        if (this.outlineEditor.spaceKeyPressed) {
            this.isDraggingCanvas = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            return;
        }

        // Check for double-click
        if (e.detail === 2) {
            // In outline editor mode with layer selected
            const doubleClickHandled = this.outlineEditor.onDoubleClick(e);
            if (doubleClickHandled) {
                return; // Skip single-click logic
            }

            // Double-click on glyph - select glyph (when not in edit mode)
            if (
                !this.outlineEditor.active &&
                this.outlineEditor.hoveredGlyphIndex >= 0
            ) {
                this.textRunEditor!.selectGlyphByIndex(
                    this.outlineEditor.hoveredGlyphIndex
                );
                return;
            }
        }

        // Let the measurement tool claim the click before edit-mode selection logic.
        if (this.measurementTool.handleMouseDown(e.clientX, e.clientY, rect)) {
            this.updateCursorStyle();
            this.render();
            return;
        }

        await this.outlineEditor.onSingleClick(e);

        // Check if clicking on text to position cursor (only in text edit mode, not on double-click or glyph)
        // Skip if hovering over a glyph since that might be a double-click to enter edit mode
        if (
            !this.outlineEditor.active &&
            !e.shiftKey &&
            !e.ctrlKey &&
            !e.metaKey &&
            this.outlineEditor.hoveredGlyphIndex < 0
        ) {
            const clickedPos = this.getClickedCursorPosition(e);
            if (clickedPos !== null) {
                this.textRunEditor!.clearSelection();
                this.textRunEditor!.cursorPosition = clickedPos;
                this.textRunEditor!.updateCursorVisualPosition();
                // Fire cursormoved event for URL sync
                this.textRunEditor!.call('cursormoved');
                this.render();
                // Keep text cursor
                this.canvas!.style.cursor = 'text';
                return; // Don't start dragging if clicking on text
            }
        }

        // Start canvas panning when Space key is pressed
        if (this.outlineEditor.spaceKeyPressed) {
            console.log(
                'Starting canvas panning, spaceKeyPressed:',
                this.outlineEditor.spaceKeyPressed
            );
            this.isDraggingCanvas = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            this.canvas!.style.cursor = 'grabbing';
        } else {
            console.log(
                'Not starting panning, spaceKeyPressed:',
                this.outlineEditor.spaceKeyPressed
            );
        }
    }

    onMouseMove(e: MouseEvent): void {
        this.outlineEditor.onMouseMove(e);

        // Handle measurement dragging
        if (this.measurementTool.isDragging) {
            this.render();
            return;
        }

        // Handle canvas panning
        if (this.isDraggingCanvas) {
            const deltaX = e.clientX - this.lastMouseX;
            const deltaY = e.clientY - this.lastMouseY;

            this.viewportManager!.pan(deltaX, deltaY);

            // Update mouse position for hit-testing during pan
            const rect = this.canvas!.getBoundingClientRect();
            this.mouseX = e.clientX - rect.left;
            this.mouseY = e.clientY - rect.top;
            this.mouseCanvasX = (this.mouseX * this.canvas!.width) / rect.width;
            this.mouseCanvasY =
                (this.mouseY * this.canvas!.height) / rect.height;

            // Perform hit-testing during panning (both text mode and editing mode)
            if (!this.measurementTool.shouldBlockHitDetection()) {
                this.outlineEditor.performHitDetection(e);
                this.updateHoveredGlyph();
                this.updateCursorStyle(e); // Update cursor after hit-testing
            }

            this.render();

            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            return;
        }
    }

    async onMouseUp(e: MouseEvent): Promise<void> {
        const finalization = this.outlineEditor.onMouseUp(e).catch((error) => {
            console.error('Outline mouseup failed:', error);
        });
        const trackedFinalization = finalization.finally(() => {
            if (this.mouseUpFinalization === trackedFinalization) {
                this.mouseUpFinalization = null;
            }
        });
        this.mouseUpFinalization = trackedFinalization;
        this.isDraggingCanvas = false;
        this.measurementTool.handleMouseUp();

        // Update cursor based on current mouse position and Cmd key state
        this.updateCursorStyle(e);

        this.render();

        await finalization;
    }

    onMouseLeave(e: MouseEvent): void {
        // Call onMouseUp first to handle any ongoing drag operations
        void this.onMouseUp(e);

        // Clear all hover states when mouse leaves the canvas
        const hadHover =
            this.outlineEditor.hoveredGlyphIndex >= 0 ||
            this.outlineEditor.hoveredGuideHandle !== null ||
            this.outlineEditor.hoveredComponentIndex !== null ||
            this.outlineEditor.hoveredAnchorIndex !== null ||
            this.outlineEditor.hoveredPointIndex !== null ||
            this.outlineEditor.hoveredAddPointPreview !== null ||
            this.outlineEditor.hoveredCommandCurvePreview !== null;

        this.outlineEditor.hoveredGlyphIndex = -1;
        this.outlineEditor.hoveredGuideHandle = null;
        this.outlineEditor.hoveredComponentIndex = null;
        this.outlineEditor.hoveredAnchorIndex = null;
        this.outlineEditor.hoveredPointIndex = null;
        this.outlineEditor.hoveredAddPointPreview = null;
        this.outlineEditor.hoveredCommandCurvePreview = null;

        // Re-render only if there was a hover state to clear
        if (hadHover) {
            this.render();
        }
    }

    onWheel(e: WheelEvent): void {
        e.preventDefault();

        // If Tab is pressed, turn off the measurement tool (cancel delay or hide if visible)
        if (this.measurementKeyPressed) {
            this.measurementTool.handleWheel();
            this.updateCursorStyle(); // Update cursor immediately
        }

        const rect = this.canvas!.getBoundingClientRect();

        // Update mouse position from wheel event (mouse doesn't move during trackpad pan)
        this.mouseX = e.clientX - rect.left;
        this.mouseY = e.clientY - rect.top;
        this.mouseCanvasX = (this.mouseX * this.canvas!.width) / rect.width;
        this.mouseCanvasY = (this.mouseY * this.canvas!.height) / rect.height;

        // Perform viewport pan/zoom (will call render callback)
        this.viewportManager!.handleWheel(e, rect, () => {
            // After pan/zoom, perform hit-testing since content moved under static cursor
            if (!this.measurementTool.shouldBlockHitDetection()) {
                this.outlineEditor.performHitDetection(e as any);
                this.updateHoveredGlyph();
                this.updateCursorStyle(e as any); // Update cursor after hit-testing
            }
            this.render();
        });
    }

    onMouseMoveHover(e: MouseEvent): void {
        if (this.outlineEditor.draggingSomething) return; // Don't detect hover while dragging

        const rect = this.canvas!.getBoundingClientRect();
        // Store both canvas and client coordinates
        this.mouseX = e.clientX - rect.left;
        this.mouseY = e.clientY - rect.top;
        // Scale for HiDPI
        this.mouseCanvasX = (this.mouseX * this.canvas!.width) / rect.width;
        this.mouseCanvasY = (this.mouseY * this.canvas!.height) / rect.height;

        // Don't perform hit detection when measurement tool is active
        if (!this.measurementTool.shouldBlockHitDetection()) {
            this.outlineEditor.performHitDetection(e);
            this.updateHoveredGlyph();
        }

        // Update cursor style based on position (after updating hover states)
        this.updateCursorStyle(e);

        // Re-render when auxiliary overlays depend on the pointer position.
        // Command-path snapping needs this even before a preview line exists,
        // because Cmd-hover alone can show snap guides/candidates.
        if (
            this.measurementKeyPressed ||
            this.outlineEditor.cmdKeyPressed ||
            this.outlineEditor.shouldRenderCommandPathPreview()
        ) {
            this.render();
        }
    }

    updateCursorStyle(e?: MouseEvent | KeyboardEvent): void {
        // Tab pressed in editing mode with measurement tool visible = crosshair cursor
        if (this.measurementTool.shouldShowCrosshair()) {
            this.canvas!.style.cursor = 'crosshair';
            return;
        }

        // Space key pressed in edit mode = show grab cursor for panning
        // In text mode preview = show grab cursor for panning
        if (this.outlineEditor.spaceKeyPressed) {
            this.canvas!.style.cursor = this.isDraggingCanvas
                ? 'grabbing'
                : 'grab';
            return;
        }

        // Stack preview has its own transformed hit targets and pointer behavior.
        if (this.stackPreviewAnimator.shouldRenderStackPreview()) {
            this.canvas!.style.cursor =
                this.stackPreviewAnimator.hoveredLayerTreeIndex !== null
                    ? 'pointer'
                    : 'default';
            return;
        }

        // In outline editor mode, let it control the cursor
        if (this.outlineEditor.active) {
            this.outlineEditor.cursorStyle();
            return;
        }

        // In text mode, show pointer when hovering over a glyph, otherwise text cursor
        if (this.outlineEditor.hoveredGlyphIndex !== -1) {
            this.canvas!.style.cursor = 'pointer';
        } else {
            this.canvas!.style.cursor = 'text';
        }
    }

    updateHoveredGlyph(): void {
        if (this.stackPreviewAnimator.shouldRenderStackPreview()) {
            const hoveredLayerTreeIndex =
                this.renderer?.hitTestStackPreviewLayer(
                    this.mouseX,
                    this.mouseY
                ) ?? null;

            let didChange = false;

            if (
                this.stackPreviewAnimator.hoveredLayerTreeIndex !==
                hoveredLayerTreeIndex
            ) {
                this.stackPreviewAnimator.hoveredLayerTreeIndex =
                    hoveredLayerTreeIndex;
                didChange = true;
            }

            if (this.outlineEditor.hoveredGlyphIndex !== -1) {
                this.outlineEditor.hoveredGlyphIndex = -1;
                didChange = true;
            }

            if (didChange) {
                this.render();
            }
            return;
        }

        if (
            this.outlineEditor.active &&
            (this.outlineEditor.hoveredResizeHandle !== null ||
                this.outlineEditor.hoveredContrastAxisHandle !== null ||
                this.outlineEditor.hoveredGuideHandle !== null ||
                this.outlineEditor.hoveredSidebearingHandle !== null ||
                this.outlineEditor.hoveredComponentIndex !== null ||
                this.outlineEditor.hoveredAnchorIndex !== null ||
                this.outlineEditor.hoveredPointIndex !== null ||
                this.outlineEditor.hoveredAddPointPreview !== null ||
                this.outlineEditor.hoveredCommandCurvePreview !== null)
        ) {
            if (this.outlineEditor.hoveredGlyphIndex !== -1) {
                this.outlineEditor.hoveredGlyphIndex = -1;
                this.render();
            }
            return;
        }

        if (this.outlineEditor.active && this.outlineEditor.cmdKeyPressed) {
            if (this.outlineEditor.hoveredGlyphIndex !== -1) {
                this.outlineEditor.hoveredGlyphIndex = -1;
                this.render();
            }
            return;
        }

        if (this.stackPreviewAnimator.hoveredLayerTreeIndex !== null) {
            this.stackPreviewAnimator.hoveredLayerTreeIndex = null;
        }

        let foundIndex = -1;

        // Check each glyph using path hit testing
        let xPosition = 0;
        for (let i = 0; i < this.textRunEditor!.shapedGlyphs.length; i++) {
            const glyph = this.textRunEditor!.shapedGlyphs[i];
            const glyphId = glyph.g;
            const xOffset = glyph.dx || 0;
            const yOffset = glyph.dy || 0;
            const xAdvance = glyph.ax || 0;

            const x = xPosition + xOffset;
            const y = yOffset;

            // Check if point is within this glyph's path
            try {
                const glyphData =
                    this.textRunEditor!.hbFont.glyphToPath(glyphId);
                if (glyphData) {
                    const path = new Path2D(glyphData);

                    // Create a temporary context for hit testing with proper transform
                    this.ctx!.save();

                    // Apply the same transform as rendering
                    const transform =
                        this.viewportManager!.getTransformMatrix();
                    this.ctx!.setTransform(
                        transform.a,
                        transform.b,
                        transform.c,
                        transform.d,
                        transform.e,
                        transform.f
                    );
                    this.ctx!.translate(x, y);

                    // Test if mouse point is in path or stroke (in canvas coordinates)
                    // Use stroke for better hit detection tolerance
                    // lineWidth is in transformed space, so divide by scale to get screen pixels
                    this.ctx!.lineWidth =
                        APP_SETTINGS.OUTLINE_EDITOR.HIT_TOLERANCE /
                        this.viewportManager!.scale;
                    if (
                        this.ctx!.isPointInPath(
                            path,
                            this.mouseX,
                            this.mouseY
                        ) ||
                        this.ctx!.isPointInStroke(
                            path,
                            this.mouseX,
                            this.mouseY
                        )
                    ) {
                        foundIndex = i;
                        this.ctx!.restore();
                        break;
                    }

                    this.ctx!.restore();
                }
            } catch (error) {
                // Skip this glyph if path extraction fails
            }

            xPosition += xAdvance;
        }

        if (foundIndex !== this.outlineEditor.hoveredGlyphIndex) {
            this.outlineEditor.hoveredGlyphIndex = foundIndex;
            this.render();
        }
    }

    onResize(): void {
        // Get current dimensions
        const newWidth = this.container.clientWidth;
        const newHeight = this.container.clientHeight;

        // Use stored previous dimensions (or current if first resize)
        const oldWidth = this.lastContainerWidth || newWidth;
        const oldHeight = this.lastContainerHeight || newHeight;

        // Store new dimensions for next resize
        this.lastContainerWidth = newWidth;
        this.lastContainerHeight = newHeight;

        this.setupHiDPI();

        if (!this.viewportManager) {
            this.render();
            return;
        }

        const freezeWidth = GlyphCanvas.COLLAPSED_EDITOR_VIEWPORT_FREEZE_WIDTH;
        const wasCollapsedWidth = oldWidth <= freezeWidth;
        const isCollapsedWidth = newWidth <= freezeWidth;

        if (isCollapsedWidth) {
            if (!this.collapsedViewportSnapshot) {
                this.freezeViewportForCollapse();
            }

            this.render();
            return;
        }

        if (wasCollapsedWidth && this.collapsedViewportSnapshot) {
            this.viewportManager.scale = this.collapsedViewportSnapshot.scale;
            this.viewportManager.panX = this.collapsedViewportSnapshot.panX;
            this.viewportManager.panY = this.collapsedViewportSnapshot.panY;
            this.lastStableViewportSnapshot = {
                ...this.collapsedViewportSnapshot
            };
            this.collapsedViewportSnapshot = null;
            this.suppressNextViewportResizeAdjustment = true;
            this.render();
            return;
        }

        if (
            this.suppressNextViewportResizeAdjustment &&
            this.lastStableViewportSnapshot
        ) {
            this.suppressNextViewportResizeAdjustment = false;
            this.viewportManager.scale = this.lastStableViewportSnapshot.scale;
            this.viewportManager.panX = this.lastStableViewportSnapshot.panX;
            this.viewportManager.panY = this.lastStableViewportSnapshot.panY;
            this.render();
            return;
        }

        // Skip viewport adjustment if no viewportManager or dimensions unchanged
        if (oldWidth === newWidth && oldHeight === newHeight) {
            this.lastStableViewportSnapshot = {
                scale: this.viewportManager.scale,
                panX: this.viewportManager.panX,
                panY: this.viewportManager.panY
            };
            this.render();
            return;
        }

        // Get the font-space point that was at the old screen center
        const oldCenterX = oldWidth / 2;
        const oldCenterY = oldHeight / 2;
        const fontSpaceCenter = this.viewportManager.getFontSpaceCoordinates(
            oldCenterX,
            oldCenterY
        );

        // Calculate zoom adjustment based on both width and height change (dampened by 30%)
        const oldScale = this.viewportManager.scale;
        const widthRatio = newWidth / oldWidth;
        const heightRatio = newHeight / oldHeight;
        // Use whichever dimension changed more
        const sizeRatio =
            Math.abs(widthRatio - 1) > Math.abs(heightRatio - 1)
                ? widthRatio
                : heightRatio;
        const dampenedRatio = 1 + (sizeRatio - 1) * 0.7; // 30% less zoom change
        const newScale = oldScale * dampenedRatio;

        // Only apply if within zoom limits
        if (newScale >= 0.01 && newScale <= 100) {
            this.viewportManager.scale = newScale;
        }

        // Adjust pan to keep the font-space center point at screen center
        // screen = scale * fontX + panX  =>  panX = screen - scale * fontX
        // For Y axis (flipped): screenY = -scale * fontY + panY  =>  panY = screenY + scale * fontY
        const newCenterX = newWidth / 2;
        const newCenterY = newHeight / 2;
        this.viewportManager.panX =
            newCenterX - this.viewportManager.scale * fontSpaceCenter.x;
        this.viewportManager.panY =
            newCenterY + this.viewportManager.scale * fontSpaceCenter.y;

        this.lastStableViewportSnapshot = {
            scale: this.viewportManager.scale,
            panX: this.viewportManager.panX,
            panY: this.viewportManager.panY
        };

        this.render();
    }

    setFont(
        fontArrayBuffer: ArrayBuffer,
        options?: {
            skipInitialShapeRender?: boolean;
            skipPropertiesUIUpdate?: boolean;
        }
    ): Promise<void> {
        if (!fontArrayBuffer) {
            console.error('No font data provided');
            return Promise.resolve();
        }

        try {
            this.textChangeLastSubsetKey = '';

            // Store current variation settings to restore after font reload
            const previousVariationSettings = {
                ...this.axesManager!.variationSettings
            };

            // Store editing font bytes on GlyphCanvas (for outline editor etc.)
            const fontBytesArray = new Uint8Array(fontArrayBuffer);
            this.fontBytes = fontBytesArray;
            console.log(
                '[GlyphCanvas]',
                'Editing font bytes stored, length:',
                fontBytesArray.length
            );
            this.axesManager!.fontBytes = fontBytesArray;

            // Create HarfBuzz blob, face, and font for the editing font
            // Pass initialFontLoaded flag to only load text from font on first load
            // Return the Promise so callers can await font loading completion
            const loadFontSpanId = timelineSpanStart(
                'canvas.setFont.loadHarfBuzz'
            );
            return this.textRunEditor!.setFont(
                fontBytesArray,
                !this.initialFontLoaded
            ).then(async (hbFont) => {
                timelineSpanEnd(loadFontSpanId);
                // Rebuild editing font name→GID map for Stage 2 shaping
                const gidMapSpanId = timelineSpanStart(
                    'canvas.setFont.rebuildNameToGidMap'
                );
                this.textRunEditor!.rebuildEditingFontNameToGid();
                timelineSpanEnd(gidMapSpanId);

                // Restore previous variation settings before updating UI
                this.axesManager!.variationSettings = previousVariationSettings;

                const axesUiSpanId = timelineSpanStart(
                    'canvas.setFont.updateAxesUI'
                );
                await this.axesManager!.updateAxesUI();
                timelineSpanEnd(axesUiSpanId);

                // Shape text with new editing font
                // (Stage 2 will use the rebuilt name→GID map)
                const shapeTextSpanId = timelineSpanStart(
                    'canvas.setFont.shapeText'
                );
                this.textRunEditor!.shapeText(
                    options?.skipInitialShapeRender === true
                );
                timelineSpanEnd(shapeTextSpanId);
                console.log(
                    '[GlyphCanvas]',
                    'Shaped text after editing font reload'
                );

                // Update properties UI to show master list in text mode
                if (!options?.skipPropertiesUIUpdate) {
                    const propertiesUiSpanId = timelineSpanStart(
                        'canvas.setFont.updatePropertiesUI'
                    );
                    await this.updatePropertiesUI();
                    timelineSpanEnd(propertiesUiSpanId);
                }

                // Auto-select first master on initial load
                if (
                    !this.initialFontLoaded &&
                    fontManager.currentFont?.fontModel?.masters
                ) {
                    const firstMaster =
                        fontManager.currentFont.fontModel.masters[0];
                    if (firstMaster && firstMaster.id && firstMaster.location) {
                        await this.selectMaster(
                            firstMaster.id,
                            firstMaster.location
                        );
                    }
                }

                // Zoom to fit the entire text in the canvas only on initial load
                if (!this.initialFontLoaded) {
                    const rect = this.canvas!.getBoundingClientRect();
                    const readyDetail = {
                        openSessionId: latestOpenSessionId,
                        source: 'initial-zoom-complete'
                    };
                    const initialZoom = this.viewportManager!.zoomToFitText(
                        this.textRunEditor!.shapedGlyphs,
                        rect,
                        this.render.bind(this),
                        null,
                        () => {
                            timelineMark('canvas.initialZoomComplete');
                            window.dispatchEvent(
                                new CustomEvent('canvasInitialReady', {
                                    detail: readyDetail
                                })
                            );
                        }
                    );
                    if (initialZoom === undefined) {
                        timelineMark('canvas.initialZoomComplete');
                        window.dispatchEvent(
                            new CustomEvent('canvasInitialReady', {
                                detail: {
                                    ...readyDetail,
                                    source: 'initial-zoom-skipped-empty-text'
                                }
                            })
                        );
                    }
                    this.initialFontLoaded = true;
                }
            });
        } catch (error) {
            console.error('Error setting font:', error);
            return Promise.reject(error);
        }
    }

    async enterGlyphEditModeAtCursor(): Promise<void> {
        // Enter glyph edit mode for the glyph at the current cursor position
        if (this.outlineEditor.active) return;
        let glyphIndex = this.textRunEditor!.getGlyphIndexAtCursorPosition();

        if (glyphIndex !== undefined && glyphIndex >= 0) {
            console.log(
                `Entering glyph edit mode at cursor position ${this.textRunEditor!.cursorPosition}, glyph index ${glyphIndex}`
            );
            await this.textRunEditor!.selectGlyphByIndex(glyphIndex);
        } else {
            console.log(
                `No glyph found at cursor position ${this.textRunEditor!.cursorPosition}`
            );
        }
    }

    exitGlyphEditMode(): void {
        // Exit glyph edit mode and return to text edit mode

        // Determine cursor position based on whether glyph was typed or shaped
        const savedGlyphIndex = this.textRunEditor!.selectedGlyphIndex;

        const glyph = this.textRunEditor!.shapedGlyphs[savedGlyphIndex];
        console.log(
            '[v2024-12-01-FIX] exitGlyphEditMode CALLED - selectedGlyphIndex:',
            this.textRunEditor!.selectedGlyphIndex,
            'shapedGlyphs.length:',
            this.textRunEditor!.shapedGlyphs.length,
            'glyph:',
            glyph
        );

        // Update cursor position to before the edited glyph
        if (
            savedGlyphIndex >= 0 &&
            savedGlyphIndex < this.textRunEditor!.shapedGlyphs.length
        ) {
            const glyphInfo =
                this.textRunEditor!.isGlyphFromTypedCharacter(savedGlyphIndex);
            const clusterStart = glyph.cl || 0;
            const isRTL = this.textRunEditor!.isPositionRTL(clusterStart);

            console.log(
                'Exit glyph edit mode [v2024-12-01-FIX] - glyphInfo:',
                glyphInfo,
                'clusterStart:',
                clusterStart,
                'isRTL:',
                isRTL
            );

            if (glyphInfo.isTyped) {
                // For typed characters, position cursor at the character's logical position
                // (which is the space before the character, where we entered from)
                this.textRunEditor!.cursorPosition = glyphInfo.logicalPosition;
                console.log(
                    'Typed character - set cursor position at logical position:',
                    this.textRunEditor!.cursorPosition
                );
            } else {
                // For shaped glyphs, position cursor at the cluster start
                this.textRunEditor!.cursorPosition = clusterStart;
                console.log(
                    'Shaped glyph - set cursor position at cluster start:',
                    this.textRunEditor!.cursorPosition
                );
            }
            this.textRunEditor!.updateCursorVisualPosition();
        }

        this.outlineEditor.active = false;
        this.textRunEditor!.selectedGlyphIndex = -1;
        this.outlineEditor.selectedLayerId = null;

        // Dispatch mode change event for URL sync
        window.dispatchEvent(
            new CustomEvent('editorModeChanged', {
                detail: { mode: 'text' }
            })
        );

        // Clear outline editor state
        this.outlineEditor.clearState();

        // Auto-select matching master based on current axis slider positions
        this.autoSelectMatchingMaster();

        console.log(`Exited glyph edit mode - returned to text edit mode`);
        this.updatePropertyPanel();
        this.updatePropertiesUI();
        this.render();
        this.dispatchModeActivationEvent('text', 'exitGlyphEditMode');
    }

    resetForOpenedFontReplacement(): void {
        this.initialFontLoaded = false;
        this.glyphSelectionSequence++;
        this.textChangeLastSubsetKey = '';
        latestAppliedEditingRevision = -1;
        editingFontApplyQueue = Promise.resolve();
        this.textModeAutoPanAnchorScreen = null;
        this.pendingFeatureChangeAnchor.editing = null;
        this.pendingFeatureChangeAnchor.text = null;
        this.renderSuppressed = false;
        this.hasDeferredRenderRequest = false;
        this.editModeGlyphResyncInProgress = false;
        this.isUpdatingPropertiesUI = false;

        this.outlineEditor.active = false;
        this.outlineEditor.selectedLayerId = null;
        this.outlineEditor.glyphStack = '';
        this.outlineEditor.clearState();

        if (this.textRunEditor) {
            this.textRunEditor.selectedGlyphIndex = -1;
            this.textRunEditor.selectedMasterId = null;
            this.textRunEditor.selectionStart = null;
            this.textRunEditor.selectionEnd = null;
            this.textRunEditor.skipRenderingDuringFeatureChange = false;

            // Clear shaping state so the compile fallback chain doesn't feed
            // stale glyph names from the previous font into a new empty font,
            // which would cause a Rust panic. The text buffer and glyph name
            // buffer are ephemeral shaping artifacts and must be invalidated
            // when the font is replaced.
            this.textRunEditor.textBuffer = '';
            this.textRunEditor.glyphNameBuffer = [];
            this.textRunEditor.shapedGlyphs = [];
            this.textRunEditor.explicitGlyphTokens = [];
            this.textRunEditor.intrinsicGlyphAdvances.clear();
            this.textRunEditor.fontBlob = null;
            this.textRunEditor.shapingFontBlob = null;
            this.textRunEditor.hbFont = null;
            this.textRunEditor.hbFace = null;
            this.textRunEditor.hbBlob = null;
            this.textRunEditor.shapingHbFont = null;
            this.textRunEditor.shapingHbFace = null;
            this.textRunEditor.shapingHbBlob = null;
        }

        if (this.propertiesSection) {
            this.propertiesSection.replaceChildren();
        }
        if (this.axesSection) {
            this.axesSection.replaceChildren();
        }
        if (this.axesManager) {
            this.axesManager.variationSettings = {};
        }
        if (this.featuresManager?.featuresSection) {
            this.featuresManager.featuresSection.replaceChildren();
            this.featuresManager.featureAvailabilityInEditingSubset = {};
            this.featuresManager.editingFontBytes = null;
        }

        window.dispatchEvent(
            new CustomEvent('editorModeChanged', {
                detail: { mode: 'text' }
            })
        );

        this.dispatchModeActivationEvent(
            'text',
            'resetForOpenedFontReplacement'
        );
        this.render();
    }

    async displayMastersList(
        targetContainer: HTMLElement = this.propertiesSection!,
        autoSelectLayer: boolean = true
    ): Promise<void> {
        // Display unified masters/layers list
        // In text mode: show all masters, click selects master location
        // In edit mode: show all masters, check if glyph has corresponding layers
        //   - if layer exists: show active, click loads layer
        //   - if layer missing: show inactive/disabled
        console.log(
            '[GlyphCanvas] displayMastersList called, selectedLayerId:',
            this.outlineEditor?.selectedLayerId
        );

        if (!targetContainer || !fontManager.currentFont?.fontModel) {
            console.log('[GlyphCanvas] No font model available');
            return;
        }

        const fontModel = fontManager.currentFont.fontModel;
        if (!fontModel.masters || fontModel.masters.length === 0) {
            console.log('[GlyphCanvas] No masters found');
            return;
        }

        const isEditMode = this.outlineEditor.active;
        const preselectedLayerId = isEditMode
            ? this.outlineEditor.selectedLayerId ||
              this.outlineEditor.findMatchingLayer()?.id
            : null;
        console.log(
            '[GlyphCanvas] Found',
            fontModel.masters.length,
            'masters, mode:',
            isEditMode ? 'edit' : 'text'
        );

        // In edit mode, get current glyph and its layers
        let glyph: Glyph | undefined;
        let glyphLayers: Layer[] = [];
        if (isEditMode) {
            // Fetch glyph data (needed for interpolation and layer management)
            this.fontData = await fontManager.fetchGlyphData(
                this.getCurrentGlyphName()
            );

            if (
                !this.fontData ||
                !this.fontData.layers ||
                this.fontData.layers.length === 0
            ) {
                console.log('[GlyphCanvas] No font data or layers found');
                return;
            }

            // Store glyph name for interpolation (needed even when not on a layer)
            // But only if we're NOT in component editing mode
            if (
                this.fontData.glyphName &&
                !this.outlineEditor.isEditingComponent()
            ) {
                this.outlineEditor.currentGlyphName = this.fontData.glyphName;
                console.log(
                    '[GlyphCanvas]',
                    'Set currentGlyphName from fontData:',
                    this.outlineEditor.currentGlyphName
                );
            }

            const glyphName =
                this.outlineEditor.getLayerLinkGlyphName() ||
                this.getCurrentGlyphName();
            glyph = fontModel.glyphs.find((g) => g.name === glyphName);
            glyphLayers = glyph?.layers || [];
            console.log(
                '[GlyphCanvas] Edit mode: glyph',
                glyphName,
                'has',
                glyphLayers.length,
                'layers'
            );
        }

        const layersWidget = document.createElement('div');
        layersWidget.className = 'editor-layers-widget';

        // Add section title
        const sectionTitle = document.createElement('div');
        sectionTitle.className = 'editor-section-title editor-layers-header';

        const sectionTitleText = document.createElement('span');
        sectionTitleText.className = 'editor-section-title-text';
        sectionTitleText.textContent = isEditMode ? 'Layers' : 'Masters';
        sectionTitle.appendChild(sectionTitleText);

        const glyphNameForLinkState =
            this.outlineEditor.getLayerLinkGlyphName() ||
            glyph?.name ||
            this.getCurrentGlyphName();
        const axesOrder =
            (fontModel as any).axesOrder ||
            (fontModel.axes || []).map((axis: any) => axis.tag).sort();
        const activeLayer =
            isEditMode && preselectedLayerId
                ? glyphLayers.find(
                      (candidate) => candidate.id === preselectedLayerId
                  )
                : undefined;
        const activeLayerFingerprint = activeLayer?.fingerprint || null;
        const displayedLayerIds: string[] = [];
        const layerLinkButtons: HTMLButtonElement[] = [];
        const layerRows: LayerListContextTarget[] = [];

        const isLayerCompatibleWithActive = (
            layer: Layer | undefined
        ): boolean => {
            if (!isEditMode || !layer?.id || !activeLayerFingerprint) {
                return true;
            }

            return (
                layer.id === activeLayer?.id ||
                layer.fingerprint === activeLayerFingerprint
            );
        };

        const setLinkButtonState = (
            button: HTMLButtonElement,
            linked: boolean,
            linkedTitle: string,
            unlinkedTitle: string
        ): void => {
            button.setAttribute('data-linked', linked ? 'true' : 'false');
            button.setAttribute('aria-pressed', linked ? 'true' : 'false');
            button.setAttribute('title', linked ? linkedTitle : unlinkedTitle);
            const icon = button.querySelector('.material-symbols-outlined');
            if (icon) {
                icon.textContent = linked ? 'link' : 'link_off';
            }
        };

        const createLinkButton = (
            onClick: (event: MouseEvent) => void,
            extraClassName: string = ''
        ): HTMLButtonElement => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className =
                `editor-layer-link-toggle ${extraClassName}`.trim();

            const icon = document.createElement('span');
            icon.className = 'material-symbols-outlined';
            button.appendChild(icon);

            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                onClick(event);
            });

            return button;
        };

        const createHeaderIconButton = (
            iconName: string,
            title: string,
            onClick: (event: MouseEvent) => void,
            extraClassName: string = ''
        ): HTMLButtonElement => {
            const button = createLinkButton(onClick, extraClassName);
            button.title = title;
            button.setAttribute('aria-label', title);
            const icon = button.querySelector('.material-symbols-outlined');
            if (icon) {
                icon.textContent = iconName;
            }
            return button;
        };

        const createCompatibilityIndicator = (): HTMLSpanElement => {
            const indicator = document.createElement('span');
            indicator.className = 'editor-layer-compatibility-indicator';
            indicator.title = 'Outline is incompatible with the active layer';

            const icon = document.createElement('span');
            icon.className = 'material-symbols-outlined';
            icon.textContent = 'broken_image';
            indicator.appendChild(icon);

            return indicator;
        };

        let summaryLinkButton: HTMLButtonElement | null = null;
        let addLayerButton: HTMLButtonElement | null = null;
        const refreshLayerLinkControls = (): void => {
            if (!isEditMode || !summaryLinkButton) {
                return;
            }

            const hasExactLayerAtCurrentLocation =
                !!this.outlineEditor.findMatchingLayer(glyphNameForLinkState);

            const allLinked = this.outlineEditor.areAllLayersLinked(
                displayedLayerIds,
                glyphNameForLinkState
            );

            summaryLinkButton.disabled = displayedLayerIds.length === 0;
            setLinkButtonState(
                summaryLinkButton,
                allLinked,
                'Unlink all layers (Cmd+Alt+L)',
                'Link all layers (Cmd+Alt+L)'
            );

            for (const button of layerLinkButtons) {
                const layerId = button.getAttribute('data-layer-id');
                const linked = this.outlineEditor.isLayerLinked(
                    layerId,
                    glyphNameForLinkState
                );
                setLinkButtonState(
                    button,
                    linked,
                    'Unlink layer',
                    'Link layer'
                );
            }

            if (addLayerButton) {
                addLayerButton.disabled =
                    !glyphNameForLinkState || hasExactLayerAtCurrentLocation;
            }
        };

        if (isEditMode) {
            const headerActions = document.createElement('div');
            headerActions.className = 'editor-layers-header-actions';

            addLayerButton = createHeaderIconButton(
                'add',
                'Create layer at current location',
                async () => {
                    const currentUserspaceLocation =
                        this.outlineEditor.getCurrentUserspaceLocation();
                    const masterId = this.outlineEditor.findClosestMasterId(
                        currentUserspaceLocation
                    );
                    if (!masterId) {
                        return;
                    }
                    const master = (fontModel.masters || []).find(
                        (candidate: any) => candidate.id === masterId
                    );
                    const designLocation = userspaceToDesignspace(
                        currentUserspaceLocation,
                        fontModel.axes || []
                    );
                    await this.outlineEditor.createInterpolatedLayer({
                        glyphName: glyphNameForLinkState,
                        userspaceLocation: currentUserspaceLocation,
                        masterId,
                        designLocation,
                        isMasterBound: false,
                        changeSource: 'layer-create-button',
                        selectNewLayer: true,
                        extrapolate: true
                    });
                    await this.updatePropertiesUI();
                    this.render();
                },
                'editor-layer-add-button'
            );
            headerActions.appendChild(addLayerButton);

            summaryLinkButton = createLinkButton(() => {
                const linkAll = !this.outlineEditor.areAllLayersLinked(
                    displayedLayerIds,
                    glyphNameForLinkState
                );
                this.outlineEditor.setAllLayersLinked(
                    displayedLayerIds,
                    linkAll,
                    glyphNameForLinkState
                );
                refreshLayerLinkControls();
            }, 'editor-layer-link-summary-toggle');
            headerActions.appendChild(summaryLinkButton);
            sectionTitle.appendChild(headerActions);
        }

        layersWidget.appendChild(sectionTitle);

        // Create masters/layers list
        const mastersList = document.createElement('div');
        mastersList.className = 'editor-layers-list';

        const getLocationTags = (
            ...locations: Array<Record<string, number> | undefined | null>
        ): string[] => {
            const extraTags = locations
                .flatMap((location) => Object.keys(location || {}))
                .filter((tag) => !axesOrder.includes(tag));

            return [...axesOrder, ...extraTags];
        };

        const formatCompactLocationSummary = (
            userspaceLocation: Record<string, number> | undefined | null,
            designspaceLocation: Record<string, number> | undefined | null
        ): string[] => {
            const tags = getLocationTags(
                userspaceLocation,
                designspaceLocation
            );
            const summary = tags
                .filter(
                    (tag: string) =>
                        userspaceLocation?.[tag] !== undefined ||
                        designspaceLocation?.[tag] !== undefined
                )
                .map((tag: string) => {
                    const userspaceValue = userspaceLocation?.[tag];
                    const designspaceValue = designspaceLocation?.[tag];

                    return `${tag}:${Math.round(Number(userspaceValue ?? designspaceValue))}/${Math.round(Number(designspaceValue ?? userspaceValue))}`;
                })
                .join(', ');

            return summary ? [summary] : ['default'];
        };

        const formatAxisValues = (
            location: DesignspaceLocation | undefined
        ): string[] => {
            const designspaceLocation = location
                ? ({ ...location } as Record<string, number>)
                : {};
            const userspaceLocation: Record<string, number> = location
                ? ({
                      ...designspaceToUserspace(location, fontModel.axes as any)
                  } as Record<string, number>)
                : {};

            for (const [tag, value] of Object.entries(designspaceLocation)) {
                if (userspaceLocation[tag] === undefined) {
                    userspaceLocation[tag] = value;
                }
            }

            return formatCompactLocationSummary(
                userspaceLocation,
                designspaceLocation
            );
        };

        const getLayerMasterId = (layer: Layer): string | undefined => {
            const layerMaster = layer.master;
            if (layerMaster && typeof layerMaster === 'object') {
                if ('type' in layerMaster) {
                    return (layerMaster as any).master;
                }
            }
            return undefined;
        };

        const getUserspaceLocationForDisplay = (
            location: DesignspaceLocation | undefined
        ): UserspaceLocation | null => {
            if (!location) {
                return null;
            }

            return designspaceToUserspace(location, fontModel.axes || []);
        };

        const buildLayerContextMenuHtml = (
            target: LayerListContextTarget
        ): string => {
            const items: string[] = [];

            if (!target.isMasterBound) {
                items.push(`
                    <div class="plugin-menu-item plugin-menu-item-danger" data-action="delete-layer" role="menuitem" tabindex="-1">
                        <span class="material-symbols-outlined">delete</span>
                        <span>Delete layer</span>
                    </div>
                `);
            }
            items.push(`
                <div class="plugin-menu-item" data-action="reinterpolate-layer" role="menuitem" tabindex="-1">
                    <span class="material-symbols-outlined">refresh</span>
                    <span>Reinterpolate</span>
                </div>
            `);

            return `<div class="plugin-menu" tabindex="0" role="menu" aria-label="Layer actions">${items.join('')}</div>`;
        };

        const runLayerContextAction = async (
            target: LayerListContextTarget,
            action: string | null
        ): Promise<void> => {
            if (action === 'delete-layer' && target.layerId) {
                await this.outlineEditor.deleteLayerById(target.layerId, {
                    glyphName: target.glyphName,
                    changeSource: 'layer-delete-context-menu'
                });
            } else if (action === 'reinterpolate-layer' && target.layerId) {
                await this.outlineEditor.reinterpolateLayerById(
                    target.layerId,
                    {
                        glyphName: target.glyphName,
                        changeSource: 'layer-reinterpolate-context-menu',
                        selectNewLayer: true
                    }
                );
            }

            await this.updatePropertiesUI();
            this.render();
        };

        const resolveLiveRowActionTarget = (
            item: HTMLDivElement,
            fallbackTarget: LayerListContextTarget
        ): LayerListContextTarget => {
            const glyphName =
                item.getAttribute('data-glyph-name') ||
                fallbackTarget.glyphName;
            const layerId = item.getAttribute('data-layer-id');

            return {
                ...fallbackTarget,
                glyphName,
                layerId: layerId || null
            };
        };

        const attachLayerContextMenu = (
            item: HTMLDivElement,
            target: LayerListContextTarget
        ): void => {
            if (!isEditMode || !target.layerId) {
                return;
            }

            const backdrop = getOrCreateBackdrop(
                'editor-layer-list-context-menu-backdrop'
            );
            const tippyInstance = tippy(item, {
                content: buildLayerContextMenuHtml(target),
                allowHTML: true,
                trigger: 'manual',
                interactive: true,
                appendTo: () => document.body,
                placement: 'right-start',
                theme: getTheme(),
                arrow: false,
                offset: [0, 4],
                hideOnClick: false,
                getReferenceClientRect: () => item.getBoundingClientRect(),
                onShown: (instance) => {
                    const menu = instance.popper.querySelector('.plugin-menu');
                    if (!menu) {
                        return;
                    }

                    setupMenuKeyboardNav(menu);
                    menu.querySelectorAll('.plugin-menu-item').forEach(
                        (menuItem) => {
                            (menuItem as HTMLElement).onclick = async () => {
                                const action =
                                    menuItem.getAttribute('data-action');
                                const liveTarget = resolveLiveRowActionTarget(
                                    item,
                                    target
                                );
                                instance.hide();
                                await new Promise((resolve) =>
                                    requestAnimationFrame(resolve)
                                );
                                await runLayerContextAction(liveTarget, action);
                            };
                        }
                    );
                }
            });

            addTippyBackdropSupport(tippyInstance, backdrop, {
                targetElement: item,
                activeClass: 'context-menu-active'
            });

            item.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const mouseX = event.clientX;
                const mouseY = event.clientY;
                tippyInstance.setProps({
                    content: buildLayerContextMenuHtml(target),
                    getReferenceClientRect: () => ({
                        width: 0,
                        height: 0,
                        top: mouseY,
                        bottom: mouseY,
                        left: mouseX,
                        right: mouseX,
                        x: mouseX,
                        y: mouseY,
                        toJSON: () => ({})
                    }),
                    theme: getTheme()
                });
                tippyInstance.show();
            });
        };

        const createLayerItem = (
            master: any,
            layer: Layer | undefined,
            displayName: string,
            axisValues: string[],
            italicizeName: boolean = false,
            target?: LayerListContextTarget
        ): HTMLDivElement => {
            const item = document.createElement('div');
            item.className = 'editor-layer-item';
            item.setAttribute('data-master-id', master.id!);
            if (target?.glyphName) {
                item.setAttribute('data-glyph-name', target.glyphName);
            }

            if (layer?.id) {
                item.setAttribute('data-layer-id', layer.id);
            }

            if (isEditMode) {
                if (layer?.id && preselectedLayerId === layer.id) {
                    item.classList.add('selected');
                }
            } else if (this.textRunEditor!.selectedMasterId === master.id) {
                item.classList.add('selected');
            }

            const itemContent = document.createElement('div');
            itemContent.className = 'editor-layer-item-content';

            const nameSpan = document.createElement('div');
            nameSpan.className = 'master-item-name';
            if (italicizeName) {
                nameSpan.classList.add('master-item-name-intermediate');
            }
            nameSpan.textContent = displayName;
            itemContent.appendChild(nameSpan);

            if (axisValues.length > 0) {
                const axisSpan = document.createElement('div');
                axisSpan.className = 'master-item-location';
                axisSpan.replaceChildren(
                    ...axisValues.map((line) => {
                        const lineEl = document.createElement('div');
                        lineEl.className = 'master-item-location-line';
                        lineEl.textContent = line;
                        return lineEl;
                    })
                );
                itemContent.appendChild(axisSpan);
            }

            item.appendChild(itemContent);

            if (isEditMode && layer?.id) {
                displayedLayerIds.push(layer.id);
                const linkButton = createLinkButton(() => {
                    const nextLinked = !this.outlineEditor.isLayerLinked(
                        layer.id,
                        glyphNameForLinkState
                    );
                    this.outlineEditor.setLayerLinked(
                        layer.id,
                        nextLinked,
                        glyphNameForLinkState
                    );
                    refreshLayerLinkControls();
                });

                linkButton.setAttribute('data-layer-id', layer.id);
                layerLinkButtons.push(linkButton);
                item.appendChild(linkButton);

                if (!isLayerCompatibleWithActive(layer)) {
                    item.appendChild(createCompatibilityIndicator());
                }
            }

            item.addEventListener('click', () => {
                if (isEditMode && layer) {
                    void this.outlineEditor.selectLayer({
                        id: layer.id,
                        name: layer.name,
                        master: layer.master,
                        location: layer.location,
                        shapes: layer.shapes || [],
                        width: layer.width,
                        isInterpolated: false
                    } as any);
                } else {
                    void this.selectMaster(master.id!, master.location || {});
                }

                const editorView = document.getElementById('view-editor');
                if (editorView && editorView.classList.contains('focused')) {
                    setTimeout(() => this.canvas!.focus(), 0);
                }
            });

            if (target) {
                attachLayerContextMenu(item, target);
            }

            return item;
        };

        for (const master of fontModel.masters) {
            const masterName =
                typeof master.name === 'string'
                    ? master.name
                    : master.name && 'dflt' in master.name
                      ? master.name.dflt
                      : master.name && 'en' in master.name
                        ? master.name.en
                        : null;

            let defaultLayer: Layer | undefined;
            let intermediateLayers: Layer[] = [];

            if (isEditMode) {
                defaultLayer = glyphLayers.find((layer) => {
                    const layerMaster = layer.master;
                    return (
                        layerMaster &&
                        typeof layerMaster === 'object' &&
                        'type' in layerMaster &&
                        layerMaster.type === 'DefaultForMaster' &&
                        getLayerMasterId(layer) === master.id
                    );
                });

                intermediateLayers = glyphLayers.filter((layer) => {
                    const layerMaster = layer.master;
                    return (
                        layerMaster &&
                        typeof layerMaster === 'object' &&
                        'type' in layerMaster &&
                        layerMaster.type === 'AssociatedWithMaster' &&
                        getLayerMasterId(layer) === master.id &&
                        !!layer.location &&
                        Object.keys(layer.location).length > 0
                    );
                });

                intermediateLayers.sort((left, right) => {
                    return compareLocationMaps(
                        (left.location || {}) as Record<string, any>,
                        (right.location || {}) as Record<string, any>,
                        axesOrder
                    );
                });
            }

            if (isEditMode) {
                if (defaultLayer) {
                    const masterTarget: LayerListContextTarget = {
                        glyphName: glyphNameForLinkState,
                        masterId: master.id,
                        layerId: defaultLayer.id || null,
                        userspaceLocation: getUserspaceLocationForDisplay(
                            master.location
                        ),
                        designLocation: master.location || null,
                        isMasterBound: true
                    };

                    const masterItem = createLayerItem(
                        master,
                        defaultLayer,
                        masterName || 'Default',
                        formatAxisValues(master.location),
                        false,
                        masterTarget
                    );
                    mastersList.appendChild(masterItem);
                    layerRows.push(masterTarget);
                }

                if (intermediateLayers.length > 0) {
                    for (const intermediateLayer of intermediateLayers) {
                        const braceTarget: LayerListContextTarget = {
                            glyphName: glyphNameForLinkState,
                            masterId: master.id,
                            layerId: intermediateLayer.id || null,
                            userspaceLocation: getUserspaceLocationForDisplay(
                                intermediateLayer.location
                            ),
                            designLocation: intermediateLayer.location || null,
                            isMasterBound: false
                        };
                        const braceItem = createLayerItem(
                            master,
                            intermediateLayer,
                            intermediateLayer.getComputedName(),
                            formatAxisValues(intermediateLayer.location),
                            true,
                            braceTarget
                        );
                        mastersList.appendChild(braceItem);
                        layerRows.push(braceTarget);
                    }
                }
            } else {
                const masterItem = createLayerItem(
                    master,
                    glyphLayers.find((l) => {
                        const lm = l.master;
                        return (
                            lm &&
                            typeof lm === 'object' &&
                            'type' in lm &&
                            lm.type === 'DefaultForMaster' &&
                            getLayerMasterId(l) === master.id
                        );
                    }) as Layer | undefined,
                    masterName || 'Default',
                    formatAxisValues(master.location),
                    false,
                    undefined
                );
                mastersList.appendChild(masterItem);
            }
        }

        layersWidget.appendChild(mastersList);
        refreshLayerLinkControls();
        targetContainer.appendChild(layersWidget);

        // In edit mode, add glyph_stack debug label (development mode only, not in test mode)
        if (isEditMode && window.isDevelopment?.() && !window.isTestMode?.()) {
            const stackLabel = document.createElement('div');
            stackLabel.className = 'glyph-stack-debug';
            stackLabel.style.cssText = `
                margin-top: 8px;
                padding: 8px;
                background: var(--input-bg);
                border-radius: 4px;
                font-family: 'IBM Plex Sans', monospace;
                font-size: 11px;
                color: var(--text-muted);
                word-break: break-all;
                line-height: 1.4;
            `;
            stackLabel.textContent = `Stack: ${this.outlineEditor.glyphStack || '(none)'}`;
            this.glyphStackLabel = stackLabel;
            targetContainer.appendChild(stackLabel);
        }

        // In edit mode, auto-select layer if current axis values match a layer's master location
        if (isEditMode && autoSelectLayer) {
            await this.outlineEditor.autoSelectMatchingLayer();
        }
    }

    async selectMaster(
        masterId: string,
        masterLocation: DesignspaceLocation
    ): Promise<void> {
        // Ensure a full compile before layer/master switch
        await fontManager.ensureFullEditingCompile();

        this.textModeEscapeState.clear();

        // Select a master and animate to its location
        console.log(
            '[GlyphCanvas] Selecting master:',
            masterId,
            'with design location:',
            masterLocation
        );

        // Convert design location to userspace location
        const fontModel = fontManager.currentFont?.fontModel;
        if (!fontModel?.axes) {
            console.warn(
                '[GlyphCanvas] Cannot convert location: no axes available'
            );
            return;
        }

        const userspaceLocation = designspaceToUserspace(
            masterLocation,
            fontModel.axes as any
        );
        console.log(
            '[GlyphCanvas] Converted to userspace location:',
            userspaceLocation
        );

        // Store selected master ID
        this.applyTextModeKerningMasterChange(masterId);

        // Update master list UI
        this.updateMasterSelection();
        this.updatePropertyPanel();

        // Capture cursor position for auto-pan during animation
        this.captureTextModeAutoPanAnchor();

        // Animate to master location (10 frames) using userspace coordinates
        await this.animateToLocation(userspaceLocation, 10);

        // Clear auto-pan anchor after animation
        this.textModeAutoPanAnchorScreen = null;

        // Update URL with new location after animation completes (only if sync enabled)
        if (isSyncEnabled()) {
            updateUrlState({
                location: encodeLocation(this.axesManager!.variationSettings)
            });
        }
    }

    async cycleMasters(moveUp: boolean): Promise<void> {
        // Cycle through masters with Cmd+Up (previous) or Cmd+Down (next) in text mode
        const fontModel = fontManager.currentFont?.fontModel;
        if (!fontModel?.masters || fontModel.masters.length === 0) {
            return;
        }

        const masters = fontModel.masters;
        const currentMasterId = this.textRunEditor!.selectedMasterId;

        // Find current master index
        let currentIndex = masters.findIndex((m) => m.id === currentMasterId);

        // If no master selected or not found, select first master
        if (currentIndex === -1) {
            await this.selectMaster(masters[0].id!, masters[0].location || {});
            return;
        }

        // Calculate next index (with wrapping)
        let nextIndex;
        if (moveUp) {
            nextIndex = currentIndex - 1;
            if (nextIndex < 0) {
                nextIndex = masters.length - 1; // Wrap to last
            }
        } else {
            nextIndex = currentIndex + 1;
            if (nextIndex >= masters.length) {
                nextIndex = 0; // Wrap to first
            }
        }

        // Select the next master
        await this.selectMaster(
            masters[nextIndex].id!,
            masters[nextIndex].location || {}
        );
    }

    updateMasterSelection(): void {
        // Update the visual selection highlight for master items
        if (!this.propertiesSection) return;

        const masterItems =
            this.propertiesSection.querySelectorAll('[data-master-id]');
        masterItems.forEach((item: any) => {
            const masterId = item.getAttribute('data-master-id');
            if (masterId === this.textRunEditor!.selectedMasterId) {
                item.classList.add('selected');
            } else {
                item.classList.remove('selected');
            }
        });
    }

    async finalizeTextModeSliderInteraction(): Promise<void> {
        if (
            this.outlineEditor.active ||
            !this.textRunEditor ||
            !this.axesManager
        ) {
            return;
        }

        await this.autoSelectMatchingMaster();

        if (this.textRunEditor.selectedMasterId !== null) {
            this.textModeEscapeState.sync(
                this.textRunEditor.selectedMasterId,
                this.axesManager.variationSettings
            );
            console.log(
                '[GlyphCanvas] Updated previous text mode state to new master:',
                {
                    masterId: this.textRunEditor.selectedMasterId,
                    settings: this.axesManager.variationSettings
                }
            );
        }
    }

    alignTextModeEscapeStateWithCurrentMaster(): void {
        if (
            this.outlineEditor.active ||
            !this.textRunEditor ||
            !this.axesManager
        ) {
            return;
        }

        this.textModeEscapeState.sync(
            this.textRunEditor.selectedMasterId,
            this.axesManager.variationSettings
        );
    }

    async handleTextModeEscapeKey(e: KeyboardEvent): Promise<void> {
        // Check if editor view is focused
        const editorView = document.querySelector('#view-editor');
        const isEditorFocused =
            editorView && editorView.classList.contains('focused');

        if (!isEditorFocused) {
            return;
        }

        if (this.axesManager?.isLoopAnimating) {
            e.preventDefault();
            this.axesManager.stopAllLoopAnimations();
            return;
        }

        if (!this.textModeEscapeState.hasSavedState()) {
            return;
        }

        e.preventDefault();

        if (
            this.textModeEscapeState.matchesCurrent(
                this.textRunEditor?.selectedMasterId || null
            )
        ) {
            this.textModeEscapeState.clear();
            return;
        }

        const previousState = this.textModeEscapeState.consume();
        if (!previousState) {
            return;
        }

        const fontModel = fontManager.currentFont?.fontModel;
        const previousMaster = fontModel?.masters?.find(
            (master) => master.id === previousState.selectionId
        );

        if (previousMaster?.location) {
            await this.selectMaster(
                previousState.selectionId,
                previousMaster.location
            );
            return;
        }

        if (previousState.variationSettings) {
            await this.animateToLocation(previousState.variationSettings, 10);
        }
    }

    async autoSelectMatchingMaster(): Promise<void> {
        // Check if current axis values match a master location
        // If so, select that master. If not, deselect current master.
        console.log('[GlyphCanvas] autoSelectMatchingMaster called');
        if (!fontManager.currentFont?.fontModel) {
            console.log('[GlyphCanvas] No font model, returning');
            return;
        }
        if (this.outlineEditor.active) {
            console.log('[GlyphCanvas] Outline editor active, returning');
            return; // Only for text mode
        }

        const fontModel = fontManager.currentFont.fontModel;
        if (!fontModel.masters || !fontModel.axes) {
            console.log('[GlyphCanvas] No masters or axes, returning');
            return;
        }

        const currentLocationUserspace: UserspaceLocation = {};

        // Get current location from axes manager (userspace coordinates)
        if (!this.axesManager) {
            console.log('[GlyphCanvas] No axes manager, returning');
            return;
        }

        const axes = await this.axesManager.getVariationAxes();
        for (const axis of axes) {
            currentLocationUserspace[axis.tag] =
                this.axesManager.getAxisValue(axis.tag) || axis.default;
        }

        // Convert to designspace for comparison with master.location (which is in designspace)
        const currentLocation = userspaceToDesignspace(
            currentLocationUserspace,
            fontModel.axes as any
        );

        // Check each master for a match (tolerance of 0.5)
        const tolerance = 0.5;
        let matchingMaster: any = null;

        console.log(
            '[GlyphCanvas] Checking masters. Current location (userspace):',
            currentLocationUserspace,
            '(designspace):',
            currentLocation
        );

        for (const master of fontModel.masters) {
            if (!master.location) continue;

            // Compare in designspace - both are in designspace
            const masterLocation = master.location;

            console.log(
                '[GlyphCanvas] Master',
                master.id,
                'location (designspace):',
                masterLocation
            );

            // Check if all axes match within tolerance
            let allMatch = true;
            for (const tag in masterLocation) {
                const masterValue = Number(masterLocation[tag]);
                const currentValue =
                    currentLocation[tag] === undefined
                        ? undefined
                        : Number(currentLocation[tag]);
                if (currentValue === undefined) {
                    allMatch = false;
                    break;
                }
                const diff = Math.abs(masterValue - currentValue);
                console.log(
                    `[GlyphCanvas]   Axis ${tag}: master=${masterValue}, current=${currentValue}, diff=${diff}, match=${diff <= tolerance}`
                );
                if (Math.abs(masterValue - currentValue) > tolerance) {
                    allMatch = false;
                    break;
                }
            }

            console.log(
                '[GlyphCanvas] Master',
                master.id,
                'allMatch:',
                allMatch
            );

            if (allMatch) {
                matchingMaster = master;
                break;
            }
        }

        // Update selection based on match
        if (
            matchingMaster &&
            this.textRunEditor!.selectedMasterId !== matchingMaster.id
        ) {
            console.log(
                '[GlyphCanvas] Auto-selecting master:',
                matchingMaster.id
            );
            this.applyTextModeKerningMasterChange(matchingMaster.id);
            this.updateMasterSelection();
            this.updatePropertyPanel();
        } else if (
            !matchingMaster &&
            this.textRunEditor!.selectedMasterId !== null
        ) {
            console.log('[GlyphCanvas] Deselecting master (no match)');
            this.applyTextModeKerningMasterChange(null);
            this.updateMasterSelection();
            this.updatePropertyPanel();
        }
    }

    async animateToLocation(
        targetLocation: UserspaceLocation,
        frames: number
    ): Promise<void> {
        // Animate userspace axis values from current to target over specified frames
        const startLocation: UserspaceLocation = {};
        const isEditing = this.outlineEditor.active;
        const previousIsAnimating = this.axesManager!.isAnimating;

        if (isEditing) {
            this.outlineEditor.onSliderMouseDown();
        }

        this.axesManager!.isAnimating = true;

        // Get current location from axes manager
        for (const tag in targetLocation) {
            startLocation[tag] =
                this.axesManager!.getAxisValue(tag) ?? targetLocation[tag];
        }

        console.log(
            '[GlyphCanvas] Animating from',
            startLocation,
            'to',
            targetLocation
        );

        // Animate over frames
        for (let frame = 0; frame <= frames; frame++) {
            const t = frame / frames; // 0 to 1
            const currentLocation: UserspaceLocation = {};

            for (const tag in targetLocation) {
                const startValue = Number(startLocation[tag]);
                const targetValue = Number(targetLocation[tag]);
                currentLocation[tag] =
                    startValue + (targetValue - startValue) * t;
            }

            // Update axes
            for (const tag in currentLocation) {
                this.axesManager!.setAxisValue(
                    tag,
                    Number(currentLocation[tag])
                );
            }

            // Update axis sliders UI to show the animation
            this.axesManager!.updateAxisSliders();

            if (isEditing) {
                this.outlineEditor.animationInProgress();
            } else {
                // Shape text with HarfBuzz and apply auto-pan for all frames
                this.textRunEditor!.shapeText(true); // Skip render - we'll render after auto-pan
                this.applyTextModeAutoPanAdjustment();
                this.render();
            }

            // Wait for next frame
            if (frame < frames) {
                await new Promise((resolve) => requestAnimationFrame(resolve));
            }
        }

        // Snap to exact target values at the end to avoid accumulated float drift.
        for (const tag in targetLocation) {
            this.axesManager!.setAxisValue(tag, Number(targetLocation[tag]));
        }
        this.axesManager!.updateAxisSliders();

        this.axesManager!.isAnimating = false;

        if (isEditing) {
            await this.outlineEditor.onSliderMouseUp();
        } else {
            this.textRunEditor!.shapeText(true);
            this.applyTextModeAutoPanAdjustment();
            this.render();
        }

        this.axesManager!.isAnimating = previousIsAnimating;

        // Notify listeners (e.g. glyph overview) about the final location
        const finalLocation: UserspaceLocation = {};
        for (const tag in targetLocation) {
            finalLocation[tag] = Math.round(Number(targetLocation[tag]));
        }
        window.dispatchEvent(
            new CustomEvent('variationLocationChanged', {
                detail: { location: finalLocation }
            })
        );

        await this.autoSelectMatchingMaster();
    }

    setActiveQcCanvasMarkers(markers: QCCanvasMarker[]): void {
        this.activeQcCanvasMarkers = [...markers];
        this.render();
    }

    clearActiveQcCanvasMarkers(): void {
        if (!this.activeQcCanvasMarkers.length) {
            return;
        }
        this.activeQcCanvasMarkers = [];
        this.render();
    }

    async activateQCGlyphProblem(problem: QCGlyphProblem): Promise<void> {
        if (!this.textRunEditor) {
            return;
        }

        const wasEditing = this.outlineEditor.active;

        const tokenText = `/${problem.glyphName}`;
        const currentStackGlyphName = (() => {
            if (!wasEditing) {
                return null;
            }

            const parsedStack = this.outlineEditor.parseGlyphStack();
            if (parsedStack.length) {
                return parsedStack[parsedStack.length - 1].glyphName;
            }

            const currentGlyphName = this.getCurrentGlyphName();
            return currentGlyphName === 'undefined' ? null : currentGlyphName;
        })();

        const isGlyphAlreadyLoaded =
            (typeof currentStackGlyphName === 'string' &&
                currentStackGlyphName === problem.glyphName) ||
            this.textRunEditor.textBuffer === tokenText;

        if (!isGlyphAlreadyLoaded) {
            this.textRunEditor.setTextBufferForNavigation(tokenText);
        }

        if (!isGlyphAlreadyLoaded && fontManager && fontManager.isReady()) {
            const subsetGlyphs =
                fontManager.deriveSubsetGlyphsFromText(tokenText);
            if (
                problem.glyphName &&
                !subsetGlyphs.includes(problem.glyphName)
            ) {
                subsetGlyphs.push(problem.glyphName);
            }

            await fontManager.compileEditingFont(
                tokenText,
                [],
                subsetGlyphs.length > 0 ? subsetGlyphs : undefined
            );
        }

        if (problem.userspaceLocation) {
            await this.animateToLocation(problem.userspaceLocation, 10);

            if (wasEditing) {
                await this.outlineEditor.autoSelectMatchingLayer();
                await this.displayMastersList();
                await this.doUIUpdateAsync();
            }
        }

        if (!this.outlineEditor.active) {
            this.textRunEditor.shapeText(true);

            const targetGlyphIndex = this.textRunEditor.shapedGlyphs.findIndex(
                (glyph: any) => glyph.explicitGlyphName === problem.glyphName
            );

            const glyphIndexToEdit =
                targetGlyphIndex >= 0
                    ? targetGlyphIndex
                    : this.textRunEditor.shapedGlyphs.length > 0
                      ? 0
                      : -1;

            if (glyphIndexToEdit >= 0) {
                await this.textRunEditor.selectGlyphByIndex(glyphIndexToEdit);
            }
        }

        if (problem.position) {
            this.setActiveQcCanvasMarkers([
                {
                    glyphName: problem.glyphName,
                    position: problem.position,
                    userspaceLocation: problem.userspaceLocation
                }
            ]);
        } else {
            this.clearActiveQcCanvasMarkers();
            this.render();
        }
    }

    getCurrentGlyphName(): string {
        // Get the selected glyph index
        const selectedIndex = this.textRunEditor!.selectedGlyphIndex;
        if (
            selectedIndex < 0 ||
            selectedIndex >= this.textRunEditor!.shapedGlyphs.length
        ) {
            return 'undefined';
        }

        // Get glyph ID from shaped glyphs (after OpenType feature substitutions)
        const shapedGlyph = this.textRunEditor!.shapedGlyphs[selectedIndex];
        if (shapedGlyph.explicitGlyphName) {
            return shapedGlyph.explicitGlyphName;
        }

        const glyphId = shapedGlyph.g;
        const bufferedGlyphName =
            this.textRunEditor!.glyphNameBuffer[selectedIndex] || null;

        // Get actual glyph name from the shaped glyph ID
        // This ensures we edit the correct glyph (e.g., "a.ss04" instead of "a")
        if (this.textRunEditor!.fontBlob) {
            try {
                const glyphName = get_glyph_name(
                    this.textRunEditor!.fontBlob,
                    glyphId
                );
                if (glyphName && glyphName !== '.notdef') {
                    return glyphName;
                }
            } catch (e) {
                console.warn(`Failed to get glyph name for GID ${glyphId}:`, e);
            }
        }

        if (bufferedGlyphName) {
            return bufferedGlyphName;
        }

        // Fallback to GID if font blob is not available
        return `GID ${glyphId}`;
    }

    doUIUpdate(): void {
        this.updateComponentBreadcrumb();
        this.updatePropertiesUI();
        this.updatePropertyPanel();

        // Only render if we're on a layer (not interpolating)
        // If interpolating, render will be called after interpolation completes
        if (this.outlineEditor.selectedLayerId !== null) {
            this.render();
            this.outlineEditor.performHitDetection(null);
        }
    }

    private dispatchModeActivationEvent(
        mode: 'text' | 'edit',
        source: string
    ): void {
        const eventName =
            mode === 'edit' ? 'editModeActivated' : 'textModeActivated';

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const isModeActive =
                    mode === 'edit'
                        ? this.outlineEditor.active &&
                          this.textRunEditor!.selectedGlyphIndex >= 0
                        : !this.outlineEditor.active &&
                          this.textRunEditor!.selectedGlyphIndex === -1;

                if (!isModeActive) {
                    return;
                }

                window.dispatchEvent(
                    new CustomEvent(eventName, {
                        detail: { mode, source }
                    })
                );
            });
        });
    }

    private getActiveEditModeRootGlyphName(): string | null {
        const parsedStack = this.outlineEditor.parseGlyphStack();
        return (
            parsedStack[0]?.glyphName ||
            this.outlineEditor.currentGlyphName ||
            null
        );
    }

    private async syncEditModeGlyphAfterTextMutation(): Promise<void> {
        if (this.editModeGlyphResyncInProgress || !this.outlineEditor.active) {
            return;
        }

        const nextGlyphName = this.getCurrentGlyphName();
        if (!nextGlyphName || nextGlyphName === 'undefined') {
            return;
        }

        const activeRootGlyphName = this.getActiveEditModeRootGlyphName();
        if (activeRootGlyphName === nextGlyphName) {
            return;
        }

        this.editModeGlyphResyncInProgress = true;

        try {
            if (activeRootGlyphName) {
                this.outlineEditor.prepareForGlyphSwitch(nextGlyphName);
            }

            this.outlineEditor.layerData = null;
            this.outlineEditor.glyphStack = '';
            this.outlineEditor.currentGlyphName = nextGlyphName;

            await this.updatePropertiesUI();
            this.updateComponentBreadcrumb();
            this.updatePropertyPanel();

            if (this.outlineEditor.selectedLayerId !== null) {
                this.render();
                this.outlineEditor.performHitDetection(null);
            }

            this.outlineEditor.onGlyphSelected();
        } finally {
            this.editModeGlyphResyncInProgress = false;
        }
    }

    async doUIUpdateAsync(): Promise<void> {
        // Async version that waits for layer data to be loaded
        this.updateComponentBreadcrumb();
        await this.updatePropertiesUI();
        this.updatePropertyPanel();

        // Only render if we're on a layer (not interpolating)
        // If interpolating, render will be called after interpolation completes
        if (this.outlineEditor.selectedLayerId !== null) {
            this.render();
            this.outlineEditor.performHitDetection(null);
        }
    }

    updateComponentBreadcrumb(): void {
        // This function now just calls updateEditorTitleBar
        // Keeping it for backward compatibility with existing calls
        this.outlineEditor.updateEditorTitleBar();
    }

    private getCurrentLayerModel(): Layer | null {
        const fontModel = fontManager.currentFont?.fontModel;
        if (!fontModel || !this.outlineEditor.selectedLayerId) {
            return null;
        }

        const glyphName = this.getCurrentGlyphName();
        const glyph = fontModel.findGlyph(glyphName);
        if (!glyph) {
            return null;
        }

        return glyph.findLayerById(this.outlineEditor.selectedLayerId) || null;
    }

    private getCurrentEditingLayerModel(): Layer | null {
        const fontModel = fontManager.currentFont?.fontModel;
        if (!fontModel) {
            return null;
        }

        const parsedStack = this.outlineEditor.parseGlyphStack();
        const currentStackItem =
            parsedStack.length > 0 ? parsedStack[parsedStack.length - 1] : null;
        const glyphName =
            currentStackItem?.glyphName ?? this.getCurrentGlyphName();
        const layerId =
            currentStackItem?.layerId ?? this.outlineEditor.selectedLayerId;

        if (!glyphName || !layerId) {
            return null;
        }

        const glyph = fontModel.findGlyph(glyphName);
        if (!glyph) {
            return null;
        }

        return glyph.findLayerById(layerId) || null;
    }

    private getSelectedComponentModels(layer: Layer): Component[] {
        const componentIndices = this.outlineEditor.selectedComponents;
        if (componentIndices.length === 0) {
            return [];
        }

        const components: Component[] = [];
        for (const componentIndex of componentIndices) {
            const shape = layer.shapes?.[componentIndex];
            if (shape?.isComponent()) {
                components.push(shape.asComponent());
            }
        }

        return components;
    }

    private canEditSelectedComponentTranslation(
        layer: Layer,
        components: Component[]
    ): boolean {
        return components.length > 0 && !layer.isAutomaticAlignedLayer();
    }

    private getAutomaticComponentAnchorOverrideOptions(
        layer: Layer,
        components: Component[]
    ): string[] {
        if (components.length !== 1 || !components[0].isAutomaticAligned()) {
            return [];
        }

        return layer.getAutomaticComponentTargetAnchorOptions(components[0]);
    }

    private getNormalizedComponentTransform(
        component: Component
    ): NormalizedDecomposedTransform {
        const transform =
            component.transform || DecomposedAffineTransform.identity();
        return {
            translation: [
                transform.translation?.[0] ?? 0,
                transform.translation?.[1] ?? 0
            ],
            scale: [transform.scale?.[0] ?? 1, transform.scale?.[1] ?? 1],
            rotation: transform.rotation ?? 0,
            skew: [transform.skew?.[0] ?? 0, transform.skew?.[1] ?? 0],
            order: (transform.order ?? 'RestOfTheWorld') as
                | 'Glyphs'
                | 'RestOfTheWorld'
        };
    }

    private getComponentTransformFieldValue(
        component: Component,
        field: ComponentTransformField
    ): number {
        const transform = this.getNormalizedComponentTransform(component);
        switch (field) {
            case 'translateX':
                return transform.translation[0];
            case 'translateY':
                return transform.translation[1];
            case 'rotation':
                return (transform.rotation * 180) / Math.PI;
            case 'scaleX':
                return transform.scale[0];
            case 'scaleY':
                return transform.scale[1];
            case 'skewX':
                return (transform.skew[0] * 180) / Math.PI;
            case 'skewY':
                return (transform.skew[1] * 180) / Math.PI;
        }
    }

    private setComponentTransformFieldValue(
        component: Component,
        field: ComponentTransformField,
        value: number
    ): boolean {
        const transform = this.getNormalizedComponentTransform(component);
        const next = {
            ...transform,
            translation: [
                transform.translation[0],
                transform.translation[1]
            ] as [number, number],
            scale: [transform.scale[0], transform.scale[1]] as [number, number],
            skew: [transform.skew[0], transform.skew[1]] as [number, number]
        };

        switch (field) {
            case 'translateX':
                next.translation[0] = value;
                break;
            case 'translateY':
                next.translation[1] = value;
                break;
            case 'rotation':
                next.rotation = (value * Math.PI) / 180;
                break;
            case 'scaleX':
                next.scale[0] = value;
                break;
            case 'scaleY':
                next.scale[1] = value;
                break;
            case 'skewX':
                next.skew[0] = (value * Math.PI) / 180;
                break;
            case 'skewY':
                next.skew[1] = (value * Math.PI) / 180;
                break;
        }

        const previous = this.getComponentTransformFieldValue(component, field);
        if (Math.abs(previous - value) <= 0.000001) {
            return false;
        }

        component.transform = next as Component['transform'];
        return true;
    }

    private getComponentAutoAlignmentValue(component: Component): boolean {
        const value =
            component.format_specific?.[GLYPHS_COMPONENT_ALIGNMENT_KEY];
        return value === 0;
    }

    private setComponentAutoAlignmentValue(
        component: Component,
        enabled: boolean
    ): boolean {
        const currentValue = this.getComponentAutoAlignmentValue(component);
        if (currentValue === enabled) {
            return false;
        }

        const formatSpecific = {
            ...(component.format_specific || {})
        } as Record<string, unknown>;
        formatSpecific[GLYPHS_COMPONENT_ALIGNMENT_KEY] = enabled ? 0 : 1;
        component.format_specific = formatSpecific;
        return true;
    }

    private getComponentAutoAlignmentState(
        components: Component[]
    ): ComponentCheckboxState {
        if (components.length === 0) {
            return false;
        }

        const values = components.map((component) =>
            this.getComponentAutoAlignmentValue(component)
        );
        const first = values[0];
        return values.every((value) => value === first) ? first : 'mixed';
    }

    private async finalizeComponentPropertyPanelMutation(
        affectedGlyphNames: string[],
        layerId: string | null
    ): Promise<void> {
        fontManager.setEditingCompileContext('keyboard', 'outline');
        fontManager.scheduleFullCompileDebounce();

        try {
            if (affectedGlyphNames.length > 0) {
                await window.fontManager?.refreshGlyphsAfterModelBatch?.(
                    affectedGlyphNames,
                    layerId || undefined
                );
            }
            await this.outlineEditor.fetchLayerData(true);
        } catch (error) {
            console.warn(
                'Failed to refresh layer after component property-panel update',
                error
            );
        }

        this.updatePropertyPanel();
        this.outlineEditor.performHitDetection(null);
        this.render();
    }

    private async commitComponentTransformPropertyPanelValue(
        field: ComponentTransformField,
        value: string
    ): Promise<void> {
        // During canvas drag operations, transform changes are already tracked
        // by the drag transaction in OutlineEditor. Avoid creating a second
        // history item from property-panel blur/change events.
        if (this.outlineEditor.draggingSomething) {
            return;
        }

        const layer = this.getCurrentEditingLayerModel();
        if (!layer) {
            return;
        }

        const trimmedValue = value.trim();
        if (!isPlainNumericInputValue(trimmedValue)) {
            this.updatePropertyPanel();
            return;
        }

        const numericValue = Number(trimmedValue);
        const selectedComponents = this.getSelectedComponentModels(layer);
        if (selectedComponents.length === 0) {
            return;
        }

        if (
            (field === 'translateX' || field === 'translateY') &&
            !this.canEditSelectedComponentTranslation(layer, selectedComponents)
        ) {
            this.updatePropertyPanel();
            return;
        }

        let changed = false;
        const affectedGlyphNames = new Set<string>();
        window.patchSyncEngine?.beginTransaction('Set component transform');
        try {
            for (const component of selectedComponents) {
                if (
                    this.setComponentTransformFieldValue(
                        component,
                        field,
                        numericValue
                    )
                ) {
                    changed = true;
                }
            }

            const glyphName = layer.parent()?.name;
            if (glyphName) {
                affectedGlyphNames.add(glyphName);
                for (const affectedGlyphName of fontManager.currentFont?.fontModel?.recomputeMetricsKeys(
                    new Set([glyphName])
                ) || []) {
                    affectedGlyphNames.add(affectedGlyphName);
                }
            }
        } finally {
            window.patchSyncEngine?.endTransaction();
        }

        if (!changed) {
            this.updatePropertyPanel();
            return;
        }

        const glyphName = layer.parent()?.name;
        if (!glyphName) {
            this.updatePropertyPanel();
            return;
        }

        await this.finalizeComponentPropertyPanelMutation(
            Array.from(
                affectedGlyphNames.size > 0
                    ? affectedGlyphNames
                    : new Set([glyphName])
            ),
            layer.id ?? null
        );
    }

    private async commitComponentAutoAlignmentPropertyPanelValue(
        checked: boolean
    ): Promise<void> {
        const currentLayer = this.getCurrentEditingLayerModel();
        if (!currentLayer) {
            return;
        }

        const glyph = currentLayer.parent();
        if (!glyph) {
            return;
        }

        const componentIndices = this.outlineEditor.selectedComponents;
        if (componentIndices.length === 0) {
            return;
        }

        let changed = false;
        const affectedGlyphNames = new Set<string>([glyph.name]);
        window.patchSyncEngine?.beginTransaction(
            'Set component automatic alignment'
        );
        try {
            for (const layer of glyph.layers || []) {
                for (const componentIndex of componentIndices) {
                    const shape = layer.shapes?.[componentIndex];
                    if (!shape?.isComponent()) {
                        continue;
                    }

                    const component = shape.asComponent();
                    if (
                        this.setComponentAutoAlignmentValue(component, checked)
                    ) {
                        changed = true;
                    }
                }
            }

            for (const affectedGlyphName of fontManager.currentFont?.fontModel?.recomputeMetricsKeys(
                new Set([glyph.name])
            ) || []) {
                affectedGlyphNames.add(affectedGlyphName);
            }
        } finally {
            window.patchSyncEngine?.endTransaction();
        }

        if (!changed) {
            this.updatePropertyPanel();
            return;
        }

        await this.finalizeComponentPropertyPanelMutation(
            Array.from(affectedGlyphNames),
            currentLayer.id ?? null
        );
    }

    private async commitComponentAnchorPropertyPanelValue(
        value: string
    ): Promise<void> {
        const currentLayer = this.getCurrentEditingLayerModel();
        if (!currentLayer) {
            return;
        }

        const selectedComponents =
            this.getSelectedComponentModels(currentLayer);
        if (selectedComponents.length !== 1) {
            return;
        }

        const component = selectedComponents[0];
        const trimmedValue = value.trim();
        const nextAnchor = trimmedValue || undefined;
        if ((component.anchor || undefined) === nextAnchor) {
            this.updatePropertyPanel();
            return;
        }

        const glyphName = currentLayer.parent()?.name;
        if (!glyphName) {
            this.updatePropertyPanel();
            return;
        }

        const affectedGlyphNames = new Set<string>([glyphName]);
        window.patchSyncEngine?.beginTransaction(
            'Set component anchor override'
        );
        try {
            component.anchor = nextAnchor;
            for (const affectedGlyphName of fontManager.currentFont?.fontModel?.recomputeMetricsKeys(
                new Set([glyphName])
            ) || []) {
                affectedGlyphNames.add(affectedGlyphName);
            }
        } finally {
            window.patchSyncEngine?.endTransaction();
        }

        await this.finalizeComponentPropertyPanelMutation(
            Array.from(affectedGlyphNames),
            currentLayer.id ?? null
        );
    }

    private hasComponentOnlySelection(): boolean {
        return (
            this.outlineEditor.selectedComponents.length > 0 &&
            this.outlineEditor.selectedPoints.length === 0 &&
            this.outlineEditor.selectedAnchors.length === 0 &&
            this.outlineEditor.selectedGuideHandle === null
        );
    }

    private collectLiveGlyphAdvancesForCurrentEdit(): Record<string, number> {
        if (!this.outlineEditor.active) {
            return {};
        }

        const currentLayer = this.getCurrentLayerModel();
        if (!currentLayer || !Number.isFinite(currentLayer.width)) {
            return {};
        }

        const parsedStack = this.outlineEditor.parseGlyphStack();
        const glyphName =
            parsedStack[parsedStack.length - 1]?.glyphName ??
            this.getCurrentGlyphName();
        if (!glyphName || glyphName === 'undefined') {
            return {};
        }

        if (fontManager.lastEditType !== 'anchor') {
            return { [glyphName]: currentLayer.width };
        }

        const currentLayerId = this.outlineEditor.selectedLayerId;
        const masterId =
            typeof currentLayer.master === 'object' && currentLayer.master
                ? currentLayer.master.master || null
                : null;
        const fontModel = fontManager.currentFont?.fontModel;
        if (!fontModel) {
            return { [glyphName]: currentLayer.width };
        }

        const glyphNames =
            fontManager.getAutomaticCompositionDragScopeGlyphNames(
                glyphName,
                fontModel
            );

        const glyphAdvances: Record<string, number> = {};
        for (const candidateGlyphName of glyphNames) {
            if (!candidateGlyphName || candidateGlyphName in glyphAdvances) {
                continue;
            }

            const glyph = fontModel.findGlyph(candidateGlyphName);
            const layer =
                (currentLayerId
                    ? glyph?.findLayerById(currentLayerId)
                    : undefined) ||
                (masterId ? glyph?.findLayerByMasterId(masterId) : undefined);
            if (!layer || !Number.isFinite(layer.width)) {
                continue;
            }

            glyphAdvances[candidateGlyphName] = layer.width;
        }

        if (!(glyphName in glyphAdvances)) {
            glyphAdvances[glyphName] = currentLayer.width;
        }

        return glyphAdvances;
    }

    reapplyActiveEditedGlyphAdvanceAfterShape(): boolean {
        if (!this.textRunEditor) {
            return false;
        }

        // Anchor-only recompiles must preserve HarfBuzz's freshly computed
        // cursive/GPOS advances. Overwriting them with model widths can tear
        // apart connected Arabic shaping until a later full render path.
        if (fontManager.lastEditType === 'anchor') {
            return false;
        }

        const glyphAdvances = this.collectLiveGlyphAdvancesForCurrentEdit();
        if (Object.keys(glyphAdvances).length === 0) {
            return false;
        }

        return this.textRunEditor.refreshGlyphAdvancesLive(glyphAdvances, {
            render: false
        });
    }

    private hasInspectableSelection(): boolean {
        return (
            this.outlineEditor.selectedPoints.length > 0 ||
            this.outlineEditor.selectedAnchors.length > 0 ||
            this.outlineEditor.selectedGuideHandle !== null
        );
    }

    private canOfferStrokeAwareScalingControl(): boolean {
        return this.outlineEditor.canOfferStrokeAwareScaling();
    }

    private setSidebearingKeyCompileContext(): void {
        fontManager.setEditingCompileContext('keyboard-sidebearing', 'outline');
    }

    private armSidebearingKeyCompileContext(): void {
        this.setSidebearingKeyCompileContext();
        fontManager.scheduleFullCompileDebounce?.();
    }

    private async commitPropertyPanelValue(
        side: 'left' | 'right',
        value: string
    ): Promise<void> {
        const trimmedValue = value.trim();

        const layer = this.getCurrentEditingLayerModel();
        if (!layer) {
            return;
        }

        if (
            layer.isAutomaticAlignedLayer() &&
            trimmedValue &&
            !/^==?[+-]/.test(trimmedValue)
        ) {
            this.updatePropertyPanel();
            this.outlineEditor.performHitDetection(null);
            this.render();
            return;
        }

        if (
            isPlainNumericInputValue(trimmedValue) &&
            this.outlineEditor.setSidebearingValue(side, Number(trimmedValue))
        ) {
            this.updatePropertyPanel();
            this.outlineEditor.performHitDetection(null);
            this.render();
            return;
        }

        const previousWidth = layer.width;
        const previousChangeSource = fontManager.lastChangeSource;
        const previousEditType = fontManager.lastEditType;
        const previousChangeVersion = fontManager.currentFont?.changeVersion;

        this.setSidebearingKeyCompileContext();
        const resolution = layer.applySidebearingInput(side, value);
        const glyphName =
            (typeof layer.parent === 'function'
                ? layer.parent()?.name
                : null) ?? this.getCurrentGlyphName();
        const usesIncrementalLayerRefresh = resolution.updateScope === 'layer';

        const { advancesRefreshed } = syncModelSidebearingEditToCanvas(this, {
            layer,
            glyphName,
            side,
            previousWidth,
            render: false
        });

        this.updatePropertyPanel();

        if (!advancesRefreshed) {
            this.render();
        }
        this.outlineEditor.performHitDetection(null);

        fontManager.setEditingCompileContext('keyboard-sidebearing', 'outline');
        const affectedGlyphNames = Array.from(
            new Set(
                resolution.affectedGlyphNames?.length
                    ? resolution.affectedGlyphNames
                    : glyphName
                      ? [glyphName]
                      : []
            )
        );
        const modelChanged =
            previousChangeVersion === undefined ||
            fontManager.currentFont?.changeVersion !== previousChangeVersion;
        const shouldRecompileAfterRefresh =
            !resolution.error &&
            !isPlainNumericInputValue(trimmedValue) &&
            affectedGlyphNames.length > 0;
        const shouldFetchLayerData =
            usesIncrementalLayerRefresh || layer.isAutomaticAlignedLayer();

        if (!modelChanged && !shouldRecompileAfterRefresh) {
            // No actual font data change — restore previous compile context.
            fontManager.setEditingCompileContext(
                previousChangeSource,
                previousEditType
            );
        }

        try {
            const bridgeOwnsCommittedRefresh = !!window.patchSyncEngine;

            if (!bridgeOwnsCommittedRefresh && affectedGlyphNames.length > 0) {
                await window.fontManager?.refreshGlyphsAfterModelBatch?.(
                    affectedGlyphNames,
                    usesIncrementalLayerRefresh
                        ? this.outlineEditor.selectedLayerId
                        : undefined
                );
            }

            if (!bridgeOwnsCommittedRefresh && shouldRecompileAfterRefresh) {
                fontManager.currentFont?.requestRecompileWithoutDataChange?.();
                window.autoCompileManager?.checkAndSchedule?.();
            }

            if (shouldFetchLayerData) {
                await this.outlineEditor.fetchLayerData(true);
            }
        } catch (error) {
            console.warn(
                'Failed to refresh layer after property-panel update',
                error
            );
        }

        if (shouldFetchLayerData) {
            this.updatePropertyPanel();
            this.outlineEditor.performHitDetection(null);
            this.render();
        }
    }

    syncCurrentOutlineLayerDataFromModel(layer: Layer): void {
        if (
            !this.outlineEditor.selectedLayerId ||
            this.outlineEditor.selectedLayerId !== layer.id ||
            !this.outlineEditor.layerData ||
            this.outlineEditor.layerData.isInterpolated
        ) {
            return;
        }

        this.outlineEditor.layerData = LayerDataNormalizer.normalize(
            layer.toJSON(),
            false
        );
    }

    private getActivePropertyInputState(): ActivePropertyInputState | null {
        if (this.restoreCanvasFocusAfterPropertyCommit) {
            return null;
        }

        const activeElement = document.activeElement as HTMLElement | null;
        if (
            !activeElement ||
            !(activeElement instanceof HTMLInputElement) ||
            !activeElement.classList.contains('glyph-property-input')
        ) {
            return null;
        }

        const fieldKey = activeElement.dataset.propertyField;
        if (!fieldKey) {
            return null;
        }

        return {
            fieldKey,
            selectionStart: activeElement.selectionStart,
            selectionEnd: activeElement.selectionEnd
        };
    }

    private restoreActivePropertyInput(
        activeInputState: ActivePropertyInputState | null
    ): void {
        if (!activeInputState || !this.propertyPanel) {
            return;
        }

        const replacementInput = this.propertyPanel.querySelector(
            `.glyph-property-input[data-property-field="${activeInputState.fieldKey}"]`
        ) as HTMLInputElement | null;
        if (!replacementInput) {
            return;
        }

        replacementInput.focus();

        const selectionStart = Math.max(
            0,
            Math.min(
                activeInputState.selectionStart ??
                    replacementInput.value.length,
                replacementInput.value.length
            )
        );
        const selectionEnd = Math.max(
            selectionStart,
            Math.min(
                activeInputState.selectionEnd ?? replacementInput.value.length,
                replacementInput.value.length
            )
        );
        replacementInput.setSelectionRange(selectionStart, selectionEnd);
    }

    private handlePropertyInputUndoRedo(event: KeyboardEvent): boolean {
        const cmdKey = event.metaKey || event.ctrlKey;
        if (!cmdKey || event.altKey || event.key.toLowerCase() !== 'z') {
            return false;
        }

        const parsedStack = this.outlineEditor.active
            ? this.outlineEditor.parseGlyphStack()
            : [];
        const {
            rootGlyphName: contextRootGlyphName,
            undoGlyphName: contextUndoGlyphName,
            undoLayerId: contextUndoLayerId,
            historyTargetKey
        } = getUndoRedoContext();
        const rootGlyphName = contextRootGlyphName ?? parsedStack[0]?.glyphName;
        const undoGlyphName =
            contextUndoGlyphName ??
            parsedStack[parsedStack.length - 1]?.glyphName ??
            undefined;
        const undoLayerId =
            contextUndoLayerId ?? this.outlineEditor.selectedLayerId ?? null;

        if (this.outlineEditor.active && (!rootGlyphName || !undoGlyphName)) {
            if (undoGlyphName || undoLayerId) {
                console.warn(
                    'Skipping property-input undo/redo: active outline editor has incomplete glyph stack'
                );
                return true;
            }
        }

        event.preventDefault();
        event.stopPropagation();

        void window.runBridgeUndoRedo?.(
            event.shiftKey ? 'redo' : 'undo',
            undoGlyphName,
            rootGlyphName,
            undoLayerId,
            historyTargetKey
        );
        return true;
    }

    private getSelectedTextModeKerningMaster(): Master | null {
        if (!this.textRunEditor?.selectedMasterId) {
            return null;
        }

        const fontModel = fontManager.currentFont?.fontModel;
        return (
            fontModel?.masters?.find(
                (candidate: Master) =>
                    candidate.id === this.textRunEditor?.selectedMasterId
            ) ?? null
        );
    }

    private getKerningGlyphNameForCluster(
        cluster: TextRunClusterInfo | null
    ): string | null {
        if (!cluster || !this.textRunEditor) {
            return null;
        }

        const glyphIndex = cluster.isRTL
            ? this.textRunEditor.findLastGlyphAtClusterPosition(cluster.start)
            : this.textRunEditor.findFirstGlyphAtClusterPosition(cluster.start);
        if (glyphIndex < 0) {
            return null;
        }

        return this.textRunEditor.glyphNameBuffer[glyphIndex] || null;
    }

    private clearTextModeKerningDraft(): void {
        this.textModeKerningDraftPairKey = null;
        this.textModeKerningDraftScopeKey = null;
        this.textModeKerningDraftValue = null;
    }

    private getTextModeKerningDraftScopeKey(
        masterId: string | null,
        isRTL: boolean
    ): string | null {
        if (!masterId) {
            return null;
        }

        return `${masterId}\u0000${isRTL ? 'rtl' : 'ltr'}`;
    }

    private applyTextModeKerningMasterChange(
        nextMasterId: string | null
    ): void {
        if (!this.textRunEditor) {
            return;
        }

        if (this.textRunEditor.selectedMasterId === nextMasterId) {
            return;
        }

        this.textRunEditor.selectedMasterId = nextMasterId;
        this.invalidateTextModeKerningOverlayCache();
        this.textModeKerningSelectionPinned = false;
        this.clearTextModeKerningDraft();
    }

    private syncTextModeKerningSelection(
        firstKeys: string[],
        secondKeys: string[]
    ): TextModeKerningSelection {
        const previousFirstKey = this.textModeKerningSelection.firstKey;
        const previousSecondKey = this.textModeKerningSelection.secondKey;
        const nextFirstKey = firstKeys.includes(
            this.textModeKerningSelection.firstKey || ''
        )
            ? this.textModeKerningSelection.firstKey
            : null;
        const nextSecondKey = secondKeys.includes(
            this.textModeKerningSelection.secondKey || ''
        )
            ? this.textModeKerningSelection.secondKey
            : null;

        this.textModeKerningSelection = {
            firstKey: nextFirstKey,
            secondKey: nextSecondKey
        };

        if (
            nextFirstKey !== previousFirstKey ||
            nextSecondKey !== previousSecondKey
        ) {
            this.textModeKerningSelectionPinned = false;
        }

        const pairKey =
            nextFirstKey && nextSecondKey
                ? getTextModeKerningPairKey(nextFirstKey, nextSecondKey)
                : null;
        if (pairKey !== this.textModeKerningDraftPairKey) {
            this.clearTextModeKerningDraft();
        }

        return this.textModeKerningSelection;
    }

    private syncTextModeKerningSelectionScope(scopeKey: string | null): void {
        if (this.textModeKerningSelectionScopeKey === scopeKey) {
            return;
        }

        this.textModeKerningSelectionScopeKey = scopeKey;
        this.textModeKerningSelectionPinned = false;
    }

    private getPreferredTextModeKerningSelection(
        master: Master | null,
        firstKeys: string[],
        secondKeys: string[],
        isRTL: boolean = false
    ): TextModeKerningSelection {
        const pickFallbackKey = (keys: string[]): string | null => {
            const groupKey = keys.find((key) => key.startsWith('@'));
            return groupKey ?? keys[0] ?? null;
        };
        const fallbackSelection = {
            firstKey: pickFallbackKey(firstKeys),
            secondKey: pickFallbackKey(secondKeys)
        };

        if (!master) {
            return fallbackSelection;
        }

        const kerning = (isRTL ? master.kerning_rtl : master.kerning) as
            | KerningContainer
            | undefined;
        if (!kerning) {
            return fallbackSelection;
        }

        const preferredPairs = buildOrderedTextModeKerningPairs(
            firstKeys,
            secondKeys
        );

        for (const { firstKey, secondKey } of preferredPairs) {
            const value = getKerningPairValue(kerning, firstKey, secondKey);
            if (value !== null && value !== 0) {
                return { firstKey, secondKey };
            }
        }

        for (const { firstKey, secondKey } of preferredPairs) {
            const value = getKerningPairValue(kerning, firstKey, secondKey);
            if (value !== null) {
                return { firstKey, secondKey };
            }
        }

        return fallbackSelection;
    }

    private resolveTextModeKerningSelection(
        master: Master | null,
        firstKeys: string[],
        secondKeys: string[],
        currentSelection: TextModeKerningSelection | null,
        isRTL: boolean = false
    ): TextModeKerningSelection {
        const preferredSelection = this.getPreferredTextModeKerningSelection(
            master,
            firstKeys,
            secondKeys,
            isRTL
        );

        if (
            !currentSelection ||
            !firstKeys.includes(currentSelection.firstKey ?? '') ||
            !secondKeys.includes(currentSelection.secondKey ?? '')
        ) {
            return preferredSelection;
        }

        if (!master) {
            return currentSelection;
        }

        const kerning = (isRTL ? master.kerning_rtl : master.kerning) as
            | KerningContainer
            | undefined;
        const currentValue =
            kerning &&
            currentSelection.firstKey != null &&
            currentSelection.secondKey != null
                ? getKerningPairValue(
                      kerning,
                      currentSelection.firstKey,
                      currentSelection.secondKey
                  )
                : null;
        const preferredValue =
            preferredSelection.firstKey &&
            preferredSelection.secondKey &&
            kerning
                ? getKerningPairValue(
                      kerning,
                      preferredSelection.firstKey,
                      preferredSelection.secondKey
                  )
                : null;

        if (
            (currentValue === null || currentValue === 0) &&
            !this.textModeKerningSelectionPinned &&
            preferredValue !== null &&
            preferredValue !== 0
        ) {
            return preferredSelection;
        }

        return currentSelection;
    }

    private buildTextModeKerningOperands(
        side: KerningSide,
        glyphName: string,
        groupNames: string[],
        master: Master | null,
        oppositeKeys: string[],
        selectedOppositeKey: string | null,
        activeKey: string | null,
        isRTL: boolean = false
    ): TextModeKerningOperand[] {
        const kerning = (
            master ? (isRTL ? master.kerning_rtl : master.kerning) : undefined
        ) as KerningContainer | undefined;
        const options = [
            {
                side,
                kind: 'glyph' as const,
                name: glyphName,
                key: glyphName,
                label: formatKerningOperandLabel('glyph', glyphName),
                removable: false
            },
            ...groupNames.map((groupName) => ({
                side,
                kind: 'group' as const,
                name: groupName,
                key: `@${groupName}`,
                label: formatKerningOperandLabel('group', groupName),
                removable: true
            }))
        ];

        return options.map((option) => {
            let participates = false;
            let compatible = false;

            if (kerning) {
                for (const oppositeKey of oppositeKeys) {
                    const value =
                        side === 'first'
                            ? getKerningPairValue(
                                  kerning,
                                  option.key,
                                  oppositeKey
                              )
                            : getKerningPairValue(
                                  kerning,
                                  oppositeKey,
                                  option.key
                              );
                    if (value !== null && value !== 0) {
                        participates = true;
                        break;
                    }
                }

                if (selectedOppositeKey) {
                    const selectedValue =
                        side === 'first'
                            ? getKerningPairValue(
                                  kerning,
                                  option.key,
                                  selectedOppositeKey
                              )
                            : getKerningPairValue(
                                  kerning,
                                  selectedOppositeKey,
                                  option.key
                              );
                    compatible = selectedValue !== null && selectedValue !== 0;
                }
            }

            return {
                ...option,
                participates,
                compatible,
                active: option.key === activeKey
            };
        });
    }

    private getCurrentTextModeKerningContext(): TextModeKerningContext {
        const defaultContext: TextModeKerningContext = {
            status: 'no-pair',
            message: 'Place the cursor between two glyphs',
            isRTL: false,
            master: null,
            metrics: null,
            firstGlyphName: null,
            secondGlyphName: null,
            firstCluster: null,
            secondCluster: null,
            firstOptions: [],
            secondOptions: [],
            selectedFirstKey: null,
            selectedSecondKey: null,
            selectedFirstLabel: null,
            selectedSecondLabel: null,
            selectedValue: null,
            hasSelectedValue: false
        };

        if (!this.textRunEditor || !fontManager.currentFont?.fontModel) {
            this.syncTextModeKerningSelectionScope(null);
            return defaultContext;
        }

        const clusterMap = this.textRunEditor.clusterMap as
            | TextRunClusterInfo[]
            | undefined;
        const cursorPosition = this.textRunEditor.cursorPosition;
        let firstCluster: TextRunClusterInfo | null = null;
        let secondCluster: TextRunClusterInfo | null = null;
        if (clusterMap) {
            for (const cluster of clusterMap) {
                if (cluster.end === cursorPosition) {
                    firstCluster = cluster;
                }
                if (
                    secondCluster === null &&
                    cluster.start === cursorPosition
                ) {
                    secondCluster = cluster;
                }
            }
        }
        if (!firstCluster || !secondCluster) {
            this.syncTextModeKerningSelectionScope(null);
            return defaultContext;
        }

        if (firstCluster.isRTL !== secondCluster.isRTL) {
            return {
                ...defaultContext,
                status: 'bidi-boundary',
                message: 'Kerning is disabled at direction boundaries',
                isRTL: firstCluster.isRTL,
                firstCluster,
                secondCluster
            };
        }

        const firstGlyphName = this.getKerningGlyphNameForCluster(firstCluster);
        const secondGlyphName =
            this.getKerningGlyphNameForCluster(secondCluster);
        if (!firstGlyphName || !secondGlyphName) {
            this.syncTextModeKerningSelectionScope(null);
            return defaultContext;
        }

        this.syncTextModeKerningSelectionScope(
            [
                this.textRunEditor.selectedMasterId || '',
                firstGlyphName,
                secondGlyphName,
                String(firstCluster.start),
                String(secondCluster.start),
                firstCluster.isRTL ? 'rtl' : 'ltr'
            ].join('\u0000')
        );

        const fontModel = fontManager.currentFont.fontModel;
        const firstGroupNames = collectKerningGroupMemberships(
            fontModel.first_kern_groups,
            firstGlyphName
        );
        const secondGroupNames = collectKerningGroupMemberships(
            fontModel.second_kern_groups,
            secondGlyphName
        );
        const firstKeys = [
            firstGlyphName,
            ...firstGroupNames.map((name) => `@${name}`)
        ];
        const secondKeys = [
            secondGlyphName,
            ...secondGroupNames.map((name) => `@${name}`)
        ];
        const selection = this.syncTextModeKerningSelection(
            firstKeys,
            secondKeys
        );
        const master = this.getSelectedTextModeKerningMaster();
        const resolvedSelection = this.resolveTextModeKerningSelection(
            master,
            firstKeys,
            secondKeys,
            selection,
            firstCluster.isRTL
        );

        this.textModeKerningSelection = resolvedSelection;
        const firstOptions = this.buildTextModeKerningOperands(
            'first',
            firstGlyphName,
            firstGroupNames,
            master,
            secondKeys,
            resolvedSelection.secondKey,
            resolvedSelection.firstKey,
            firstCluster.isRTL
        );
        const secondOptions = this.buildTextModeKerningOperands(
            'second',
            secondGlyphName,
            secondGroupNames,
            master,
            firstKeys,
            resolvedSelection.firstKey,
            resolvedSelection.secondKey,
            firstCluster.isRTL
        );

        const selectedValue =
            master && resolvedSelection.firstKey && resolvedSelection.secondKey
                ? getKerningPairValue(
                      (firstCluster.isRTL
                          ? master.kerning_rtl
                          : master.kerning) as KerningContainer | undefined,
                      resolvedSelection.firstKey,
                      resolvedSelection.secondKey
                  )
                : null;
        const selectedFirstLabel =
            firstOptions.find(
                (option) => option.key === resolvedSelection.firstKey
            )?.label ?? null;
        const selectedSecondLabel =
            secondOptions.find(
                (option) => option.key === resolvedSelection.secondKey
            )?.label ?? null;

        return {
            status: master ? 'ready' : 'off-master',
            message: master ? '' : 'Select an exact master to edit kerning',
            isRTL: firstCluster.isRTL,
            master,
            metrics: (master?.metrics as Record<string, number> | null) || null,
            firstGlyphName,
            secondGlyphName,
            firstCluster,
            secondCluster,
            firstOptions,
            secondOptions,
            selectedFirstKey: resolvedSelection.firstKey,
            selectedSecondKey: resolvedSelection.secondKey,
            selectedFirstLabel,
            selectedSecondLabel,
            selectedValue,
            hasSelectedValue: selectedValue !== null
        };
    }

    private buildTextModeKerningOverlay(
        secondCluster: TextRunClusterInfo,
        isRTL: boolean,
        metrics: Record<string, number> | null,
        value: number
    ): TextModeKerningOverlay | null {
        if (!metrics || value === 0) {
            return null;
        }

        const secondVisualEdge = isRTL
            ? secondCluster.x + secondCluster.width
            : secondCluster.x;
        const directionSign = isRTL ? -1 : 1;
        const adjustmentEdge = secondVisualEdge - directionSign * value;
        const metricValues = Object.values(metrics).filter((metricValue) =>
            Number.isFinite(metricValue)
        );
        const fontUpm = Number(fontManager.currentFont?.fontModel?.upm) || 1000;
        const topY =
            metricValues.length > 0
                ? Math.max(...metricValues, 0)
                : fontUpm * 0.8;
        const bottomY =
            metricValues.length > 0
                ? Math.min(...metricValues, 0)
                : -fontUpm * 0.2;

        return {
            minX: Math.min(secondVisualEdge, adjustmentEdge),
            maxX: Math.max(secondVisualEdge, adjustmentEdge),
            topY,
            bottomY,
            value
        };
    }

    private invalidateTextModeKerningOverlayCache(): void {
        this.textModeKerningOverlayCache = null;
    }

    private rebuildTextModeKerningOverlayCacheOverlays(
        cache: TextModeKerningOverlayCache
    ): void {
        cache.overlays = cache.entries
            .map((entry) => entry.overlay)
            .filter((overlay): overlay is TextModeKerningOverlay => !!overlay);
    }

    private recomputeTextModeKerningOverlayCacheEntry(
        entry: TextModeKerningOverlayCacheEntry,
        master: Master
    ): void {
        const kerning = (entry.isRTL ? master.kerning_rtl : master.kerning) as
            | KerningContainer
            | undefined;
        const metrics =
            (master.metrics as Record<string, number> | null) || null;
        const preferredSelection = this.getPreferredTextModeKerningSelection(
            master,
            entry.firstKeys,
            entry.secondKeys,
            entry.isRTL
        );

        entry.resolvedFirstKey = preferredSelection.firstKey;
        entry.resolvedSecondKey = preferredSelection.secondKey;
        entry.value =
            kerning &&
            preferredSelection.firstKey &&
            preferredSelection.secondKey
                ? getKerningPairValue(
                      kerning,
                      preferredSelection.firstKey,
                      preferredSelection.secondKey
                  )
                : null;
        entry.overlay =
            entry.value === null || entry.value === 0
                ? null
                : this.buildTextModeKerningOverlay(
                      entry.secondCluster,
                      entry.isRTL,
                      metrics,
                      entry.value
                  );
    }

    private buildTextModeKerningOverlayCache(): TextModeKerningOverlayCache | null {
        if (!this.textRunEditor || !fontManager.currentFont?.fontModel) {
            return null;
        }

        const master = this.getSelectedTextModeKerningMaster();
        if (!master?.id || !master.kerning || !master.metrics) {
            return null;
        }

        const fontModel = fontManager.currentFont.fontModel;
        const sortedClusters = [
            ...((this.textRunEditor.clusterMap as TextRunClusterInfo[]) || [])
        ].sort((left, right) => left.start - right.start);
        const entries: TextModeKerningOverlayCacheEntry[] = [];
        const entriesByAdjacencyKey = new Map<
            string,
            TextModeKerningOverlayCacheEntry
        >();
        const candidatePairToAdjacencyKeys = new Map<string, Set<string>>();

        for (let index = 0; index < sortedClusters.length - 1; index++) {
            const firstCluster = sortedClusters[index];
            const secondCluster = sortedClusters[index + 1];
            if (
                firstCluster.end !== secondCluster.start ||
                firstCluster.isRTL !== secondCluster.isRTL
            ) {
                continue;
            }

            const firstGlyphName =
                this.getKerningGlyphNameForCluster(firstCluster);
            const secondGlyphName =
                this.getKerningGlyphNameForCluster(secondCluster);
            if (!firstGlyphName || !secondGlyphName) {
                continue;
            }

            const firstGroupNames = collectKerningGroupMemberships(
                fontModel.first_kern_groups,
                firstGlyphName
            );
            const secondGroupNames = collectKerningGroupMemberships(
                fontModel.second_kern_groups,
                secondGlyphName
            );
            const firstKeys = [
                firstGlyphName,
                ...firstGroupNames.map((name) => `@${name}`)
            ];
            const secondKeys = [
                secondGlyphName,
                ...secondGroupNames.map((name) => `@${name}`)
            ];
            const adjacencyKey = getTextModeKerningAdjacencyKey(
                firstCluster,
                secondCluster
            );
            const entry: TextModeKerningOverlayCacheEntry = {
                adjacencyKey,
                firstKeys,
                secondKeys,
                secondCluster,
                isRTL: firstCluster.isRTL,
                resolvedFirstKey: null,
                resolvedSecondKey: null,
                value: null,
                overlay: null
            };

            this.recomputeTextModeKerningOverlayCacheEntry(entry, master);
            entries.push(entry);
            entriesByAdjacencyKey.set(adjacencyKey, entry);

            for (const pair of buildOrderedTextModeKerningPairs(
                firstKeys,
                secondKeys
            )) {
                let adjacencyKeys = candidatePairToAdjacencyKeys.get(
                    pair.pairKey
                );
                if (!adjacencyKeys) {
                    adjacencyKeys = new Set<string>();
                    candidatePairToAdjacencyKeys.set(
                        pair.pairKey,
                        adjacencyKeys
                    );
                }
                adjacencyKeys.add(adjacencyKey);
            }
        }

        const cache: TextModeKerningOverlayCache = {
            layoutVersion: this.textRunEditor.layoutVersion,
            masterId: master.id,
            overlays: [],
            entries,
            entriesByAdjacencyKey,
            candidatePairToAdjacencyKeys
        };
        this.rebuildTextModeKerningOverlayCacheOverlays(cache);
        return cache;
    }

    private getTextModeKerningOverlayCache(): TextModeKerningOverlayCache | null {
        if (!this.textRunEditor) {
            return null;
        }

        const master = this.getSelectedTextModeKerningMaster();
        if (!master?.id) {
            this.textModeKerningOverlayCache = null;
            return null;
        }

        const cache = this.textModeKerningOverlayCache;
        if (
            cache &&
            cache.layoutVersion === this.textRunEditor.layoutVersion &&
            cache.masterId === master.id
        ) {
            return cache;
        }

        this.textModeKerningOverlayCache =
            this.buildTextModeKerningOverlayCache();
        return this.textModeKerningOverlayCache;
    }

    private patchTextModeKerningOverlayCachePair(
        master: Master,
        firstKey: string,
        secondKey: string
    ): void {
        const cache = this.getTextModeKerningOverlayCache();
        if (!cache || cache.masterId !== master.id) {
            return;
        }

        const pairKey = getTextModeKerningPairKey(firstKey, secondKey);
        const adjacencyKeys = cache.candidatePairToAdjacencyKeys.get(pairKey);
        if (!adjacencyKeys || adjacencyKeys.size === 0) {
            return;
        }

        for (const adjacencyKey of adjacencyKeys) {
            const entry = cache.entriesByAdjacencyKey.get(adjacencyKey);
            if (!entry) {
                continue;
            }

            this.recomputeTextModeKerningOverlayCacheEntry(entry, master);
        }

        this.rebuildTextModeKerningOverlayCacheOverlays(cache);
    }

    getTextModeKerningOverlayStates(): TextModeKerningOverlay[] {
        return this.getTextModeKerningOverlayCache()?.overlays || [];
    }

    private setTextModeKerningSelection(side: KerningSide, key: string): void {
        this.textModeKerningSelection = {
            ...this.textModeKerningSelection,
            [side === 'first' ? 'firstKey' : 'secondKey']: key
        };
        this.textModeKerningSelectionPinned = true;
        this.textModeKerningDraftPairKey = null;
        this.textModeKerningDraftValue = null;
        this.updatePropertyPanel();
        this.render();
        this.focusCanvasForTextModeKerning();
    }

    private scheduleTextModeKerningCompile(reason: string): void {
        const isGroupEdit = reason === 'kerning-group-membership';
        fontManager.setEditingCompileContext(
            isGroupEdit ? 'keyboard-kerning-groups' : 'keyboard-kerning-value',
            isGroupEdit ? 'kerning-groups' : 'kerning-value'
        );
        fontManager.currentFont?.markDirty(reason);
        fontManager.scheduleFullCompileDebounce?.();
        // Kerning edits already flow through PatchSyncEngine and the shared
        // committed-change funnel, which requests the authoritative immediate
        // editing compile after the worker Yjs update settles. Waking the
        // auto-compile loop here creates a second local compile race that can
        // briefly apply an intermediate kerning result before the committed
        // compile lands.
        if (!window.patchSyncEngine) {
            fontManager.currentFont?.requestRecompileWithoutDataChange?.();
            window.autoCompileManager?.checkAndSchedule?.();
        }
    }

    private updateTextModeKerningGroupMembership(
        side: KerningSide,
        glyphName: string,
        groupName: string,
        include: boolean
    ): void {
        const normalizedGroupName = groupName.trim().replace(/^@+/, '');
        if (!normalizedGroupName) {
            return;
        }

        const fontModel = fontManager.currentFont?.fontModel;
        if (!fontModel) {
            return;
        }

        let groups =
            side === 'first'
                ? fontModel.first_kern_groups
                : fontModel.second_kern_groups;
        if (!groups) {
            if (!include) {
                return;
            }

            if (side === 'first') {
                fontModel.first_kern_groups = {};
                groups = fontModel.first_kern_groups;
            } else {
                fontModel.second_kern_groups = {};
                groups = fontModel.second_kern_groups;
            }
        }
        if (!groups) {
            return;
        }

        const existingGroupNames = collectKerningGroupMemberships(
            groups,
            glyphName
        );
        if (
            include &&
            existingGroupNames.length > 0 &&
            !existingGroupNames.includes(normalizedGroupName)
        ) {
            return;
        }

        window.patchSyncEngine?.beginTransaction(
            include
                ? 'Add kern group membership'
                : 'Remove kern group membership'
        );
        try {
            if (include) {
                if (!Array.isArray(groups[normalizedGroupName])) {
                    groups[normalizedGroupName] = [];
                }
                if (!groups[normalizedGroupName].includes(glyphName)) {
                    groups[normalizedGroupName].push(glyphName);
                    groups[normalizedGroupName].sort((left, right) =>
                        left.localeCompare(right)
                    );
                }
            } else {
                const members = groups[normalizedGroupName];
                if (!Array.isArray(members)) {
                    return;
                }
                const memberIndex = members.indexOf(glyphName);
                if (memberIndex >= 0) {
                    members.splice(memberIndex, 1);
                }
                if (members.length === 0) {
                    delete groups[normalizedGroupName];
                }
            }
        } finally {
            window.patchSyncEngine?.endTransaction();
        }

        this.scheduleTextModeKerningCompile('kerning-group-membership');
        this.invalidateTextModeKerningOverlayCache();
        this.updatePropertyPanel();
        this.render();
    }

    private promptAndAddTextModeKerningGroup(
        side: KerningSide,
        glyphName: string | null
    ): void {
        if (!glyphName) {
            return;
        }

        const fontModel = fontManager.currentFont?.fontModel;
        const existingGroupNames = collectKerningGroupMemberships(
            side === 'first'
                ? fontModel?.first_kern_groups
                : fontModel?.second_kern_groups,
            glyphName
        );
        if (existingGroupNames.length > 0) {
            return;
        }

        const groupName = window.prompt(
            `Add ${glyphName} to a ${side} kerning group`
        );
        if (groupName === null) {
            return;
        }

        this.updateTextModeKerningGroupMembership(
            side,
            glyphName,
            groupName,
            true
        );
    }

    private setKerningPairValueOnMaster(
        master: Master,
        firstKey: string,
        secondKey: string,
        nextValue: number | null,
        isRTL: boolean = false
    ): void {
        const kerning = (isRTL ? master.kerning_rtl : master.kerning) as
            | KerningContainer
            | undefined;
        const setKerning = (value: KerningContainer) => {
            if (isRTL) {
                master.kerning_rtl = value as Record<string, number>;
            } else {
                master.kerning = value as unknown as Master['kerning'];
            }
        };
        const flatKey = getFlatKerningPairKey(firstKey, secondKey);

        if (isRTL) {
            const nextKerning =
                kerning && !(kerning instanceof Map) ? { ...kerning } : {};

            if (nextValue === null) {
                delete nextKerning[flatKey];
            } else {
                nextKerning[flatKey] = nextValue;
            }

            setKerning(nextKerning as unknown as Master['kerning']);
            return;
        }

        if (!kerning || usesFlatKerningPairs(kerning)) {
            if (kerning instanceof Map) {
                if (nextValue === null) {
                    kerning.delete(flatKey);
                } else {
                    kerning.set(flatKey, nextValue);
                }
                return;
            }

            if (!kerning) {
                if (nextValue === null) {
                    return;
                }
                setKerning({
                    [flatKey]: nextValue
                } as unknown as Master['kerning']);
                return;
            }

            if (nextValue === null) {
                delete kerning[flatKey];
            } else {
                kerning[flatKey] = nextValue;
            }
            return;
        }

        if (kerning instanceof Map) {
            if (nextValue === null) {
                const row = kerning.get(firstKey);
                if (row instanceof Map) {
                    row.delete(secondKey);
                    if (row.size === 0) {
                        kerning.delete(firstKey);
                    }
                } else if (isKerningRow(row) && secondKey in row) {
                    delete row[secondKey];
                    if (Object.keys(row).length === 0) {
                        kerning.delete(firstKey);
                    }
                }
                return;
            }

            const existingRow = kerning.get(firstKey);
            if (existingRow instanceof Map) {
                existingRow.set(secondKey, nextValue);
                return;
            }
            if (isKerningRow(existingRow)) {
                existingRow[secondKey] = nextValue;
                return;
            }

            kerning.set(firstKey, new Map([[secondKey, nextValue]]));
            return;
        }

        if (!kerning) {
            if (nextValue === null) {
                return;
            }
            setKerning({
                [firstKey]: {
                    [secondKey]: nextValue
                }
            } as unknown as Master['kerning']);
            return;
        }

        if (nextValue === null) {
            const row = kerning[firstKey];
            if (!isKerningRow(row)) {
                return;
            }
            if (row instanceof Map) {
                row.delete(secondKey);
                if (row.size === 0) {
                    delete kerning[firstKey];
                }
                return;
            }

            delete row[secondKey];
            if (Object.keys(row).length === 0) {
                delete kerning[firstKey];
            }
            return;
        }

        if (!kerning[firstKey]) {
            kerning[firstKey] = {};
        }

        const row = kerning[firstKey];
        if (row instanceof Map) {
            row.set(secondKey, nextValue);
        } else if (isKerningRow(row)) {
            row[secondKey] = nextValue;
        }
    }

    private async commitTextModeKerningValue(
        value: string,
        context: TextModeKerningContext,
        focusCanvas: boolean = false
    ): Promise<void> {
        if (
            !context.master ||
            !context.selectedFirstKey ||
            !context.selectedSecondKey
        ) {
            return;
        }

        const trimmedValue = value.trim();
        const nextValue = trimmedValue === '' ? null : Number(trimmedValue);
        if (trimmedValue !== '' && !Number.isFinite(nextValue)) {
            this.updatePropertyPanel();
            if (focusCanvas) {
                this.focusCanvasForTextModeKerning();
            }
            return;
        }

        const currentValue = context.hasSelectedValue
            ? context.selectedValue
            : null;
        const nextPairKey = getTextModeKerningPairKey(
            context.selectedFirstKey,
            context.selectedSecondKey
        );
        if (currentValue === nextValue) {
            this.textModeKerningDraftPairKey = nextPairKey;
            this.textModeKerningDraftScopeKey =
                this.getTextModeKerningDraftScopeKey(
                    context.master.id || null,
                    context.isRTL
                );
            this.textModeKerningDraftValue = trimmedValue;
            this.updatePropertyPanel();
            if (focusCanvas) {
                this.focusCanvasForTextModeKerning();
            }
            return;
        }

        window.patchSyncEngine?.beginTransaction('Edit kerning pair');
        try {
            this.setKerningPairValueOnMaster(
                context.master,
                context.selectedFirstKey,
                context.selectedSecondKey,
                nextValue,
                context.isRTL
            );
            this.patchTextModeKerningOverlayCachePair(
                context.master,
                context.selectedFirstKey,
                context.selectedSecondKey
            );
        } finally {
            window.patchSyncEngine?.endTransaction();
        }

        this.textModeKerningDraftPairKey = nextPairKey;
        this.textModeKerningDraftScopeKey =
            this.getTextModeKerningDraftScopeKey(
                context.master.id || null,
                context.isRTL
            );
        this.textModeKerningDraftValue = trimmedValue;
        this.scheduleTextModeKerningCompile('kerning-property-panel');
        this.updatePropertyPanel();
        this.render();
        if (focusCanvas) {
            this.focusCanvasForTextModeKerning();
        }
    }

    private async nudgeTextModeKerningValue(delta: number): Promise<void> {
        const context = this.getCurrentTextModeKerningContext();
        if (
            context.status !== 'ready' ||
            !context.selectedFirstKey ||
            !context.selectedSecondKey
        ) {
            return;
        }

        const currentValue = context.selectedValue ?? 0;
        await this.commitTextModeKerningValue(
            String(currentValue + delta),
            context,
            true
        );
    }

    private updateTextModeKerningMirror(
        input: HTMLInputElement,
        mirror: HTMLElement
    ): void {
        const nextValue = input.value.trim() || input.placeholder || '0';
        mirror.textContent = nextValue;
        mirror.classList.toggle(
            'glyph-kerning-value-mirror-empty',
            !input.value.trim()
        );
    }

    getTextModeKerningOverlayState(): TextModeKerningOverlay | null {
        const context = this.getCurrentTextModeKerningContext();
        if (
            context.status !== 'ready' ||
            !context.firstCluster ||
            !context.secondCluster ||
            !context.metrics ||
            !context.hasSelectedValue ||
            context.selectedValue === null ||
            context.selectedValue === 0
        ) {
            return null;
        }

        return this.buildTextModeKerningOverlay(
            context.secondCluster,
            context.isRTL,
            context.metrics,
            context.selectedValue
        );
    }

    updatePropertyPanel(): void {
        if (!this.propertyPanel) {
            return;
        }

        const activeInputState = this.getActivePropertyInputState();
        this.propertyPanel.classList.remove('component-properties');
        this.propertyPanel.classList.remove('text-mode-kerning-panel');

        this.propertyPanel.textContent = '';

        if (!this.outlineEditor.active) {
            this.renderTextModePropertyPanel(activeInputState);
            return;
        }

        this.propertyPanel.classList.remove('hidden');

        const isComponentOnlySelection = this.hasComponentOnlySelection();
        if (this.hasInspectableSelection() && !isComponentOnlySelection) {
            const placeholder = document.createElement('div');
            placeholder.className = 'glyph-property-panel-placeholder';
            const content = document.createElement('div');
            content.className = 'glyph-component-property-panel-content';

            if (this.canOfferStrokeAwareScalingControl()) {
                const control = document.createElement('label');
                control.className =
                    'glyph-component-property-control glyph-component-property-checkbox';

                const input = document.createElement('input');
                input.type = 'checkbox';
                input.className = 'glyph-component-property-checkbox-input';
                input.dataset.propertyField = 'stroke-aware-scaling';
                input.checked =
                    this.outlineEditor.isStrokeAwareScalingEnabled();
                input.addEventListener('change', () => {
                    this.outlineEditor.setStrokeAwareScalingEnabled(
                        input.checked
                    );
                    this.updatePropertyPanel();
                    this.outlineEditor.performHitDetection(null);
                    this.render();
                });

                const label = document.createElement('span');
                label.className = 'glyph-property-control-label';
                label.textContent = 'Stroke Aware';
                label.title =
                    'Enable stroke-aware scaling for fully selected closed contours';

                control.appendChild(input);
                control.appendChild(label);
                content.appendChild(control);
            }

            placeholder.appendChild(content);
            this.propertyPanel.appendChild(placeholder);
            return;
        }

        if (isComponentOnlySelection) {
            const currentLayer = this.getCurrentEditingLayerModel();
            if (!currentLayer) {
                return;
            }

            const selectedComponents =
                this.getSelectedComponentModels(currentLayer);
            if (selectedComponents.length === 0) {
                return;
            }

            this.propertyPanel.classList.add('component-properties');

            const content = document.createElement('div');
            content.className = 'glyph-component-property-panel-content';
            const translationLocked = !this.canEditSelectedComponentTranslation(
                currentLayer,
                selectedComponents
            );
            const anchorOverrideOptions =
                this.getAutomaticComponentAnchorOverrideOptions(
                    currentLayer,
                    selectedComponents
                );

            const createComponentFieldControl = (
                field: ComponentTransformField,
                labelText: string
            ) => {
                const wrapper = document.createElement('label');
                wrapper.className = 'glyph-component-property-control';

                const label = document.createElement('span');
                label.className = 'glyph-property-control-label';
                label.textContent = labelText;
                const labelTooltips: Record<ComponentTransformField, string> = {
                    translateX: 'Component translation on X axis',
                    translateY: 'Component translation on Y axis',
                    rotation: 'Component rotation in degrees',
                    scaleX: 'Component scale on X axis',
                    scaleY: 'Component scale on Y axis',
                    skewX: 'Component skew on X axis in degrees',
                    skewY: 'Component skew on Y axis in degrees'
                };
                label.title = labelTooltips[field];

                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'glyph-property-input';
                input.dataset.propertyField = `component-${field}`;

                const sharedValue = getSharedNumericValue(
                    selectedComponents.map((component) =>
                        this.getComponentTransformFieldValue(component, field)
                    )
                );

                if (sharedValue === null) {
                    input.value = '';
                    input.placeholder = 'Multiple values';
                    input.classList.add('glyph-property-input-mixed');
                } else {
                    input.value = String(Number(sharedValue.toFixed(4)));
                }

                const isTranslationField =
                    field === 'translateX' || field === 'translateY';
                if (translationLocked && isTranslationField) {
                    input.disabled = true;
                    input.title =
                        'Automatic component translation is derived from anchor alignment';
                }

                const arrowInputController =
                    translationLocked && isTranslationField
                        ? null
                        : new ArrowAdjustableTextInput({
                              input,
                              getValue: () => {
                                  const trimmedValue = input.value.trim();
                                  if (isPlainNumericInputValue(trimmedValue)) {
                                      return Number(trimmedValue);
                                  }

                                  return (
                                      sharedValue ??
                                      this.getComponentTransformFieldValue(
                                          selectedComponents[0],
                                          field
                                      )
                                  );
                              },
                              applyValue: async (nextValue) => {
                                  input.dataset.skipNextPropertyCommit = 'true';
                                  await this.commitComponentTransformPropertyPanelValue(
                                      field,
                                      String(nextValue)
                                  );
                              },
                              findReplacementInput: () =>
                                  this.propertyPanel?.querySelector(
                                      `.glyph-property-input[data-property-field="component-${field}"]`
                                  ) as HTMLInputElement | null
                          });

                input.addEventListener('change', () => {
                    if (this.outlineEditor.draggingSomething) {
                        return;
                    }

                    if (input.dataset.skipNextPropertyCommit === 'true') {
                        delete input.dataset.skipNextPropertyCommit;
                        return;
                    }

                    void this.commitComponentTransformPropertyPanelValue(
                        field,
                        input.value
                    );
                });

                input.addEventListener('keydown', (event) => {
                    if (this.handlePropertyInputUndoRedo(event)) {
                        return;
                    }

                    if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        this.outlineEditor.restoreFocus();
                        return;
                    }

                    if (event.key === 'Enter') {
                        event.preventDefault();
                        this.restoreCanvasFocusAfterPropertyCommit = true;
                        input.dataset.skipNextPropertyCommit = 'true';
                        void this.commitComponentTransformPropertyPanelValue(
                            field,
                            input.value
                        );
                        input.blur();
                    }
                });

                input.addEventListener('blur', () => {
                    setTimeout(() => {
                        if (this.restoreCanvasFocusAfterPropertyCommit) {
                            this.restoreCanvasFocusAfterPropertyCommit = false;
                            if (!arrowInputController?.isApplyingStep) {
                                this.outlineEditor.restoreFocus();
                            }
                            return;
                        }

                        const activeElement =
                            document.activeElement as HTMLElement | null;
                        if (
                            activeElement &&
                            this.isTextInputElement(activeElement)
                        ) {
                            return;
                        }

                        if (!arrowInputController?.isApplyingStep) {
                            this.outlineEditor.restoreFocus();
                        }
                    }, 0);
                });

                wrapper.appendChild(label);
                wrapper.appendChild(input);
                return wrapper;
            };

            const fieldsRow = document.createElement('div');
            fieldsRow.className = 'glyph-component-property-grid';
            fieldsRow.appendChild(
                createComponentFieldControl('translateX', 'X')
            );
            fieldsRow.appendChild(
                createComponentFieldControl('translateY', 'Y')
            );
            fieldsRow.appendChild(createComponentFieldControl('rotation', 'R'));
            fieldsRow.appendChild(createComponentFieldControl('scaleX', 'SX'));
            fieldsRow.appendChild(createComponentFieldControl('scaleY', 'SY'));
            fieldsRow.appendChild(createComponentFieldControl('skewX', 'KX'));
            fieldsRow.appendChild(createComponentFieldControl('skewY', 'KY'));

            const alignmentState =
                this.getComponentAutoAlignmentState(selectedComponents);
            const alignmentControl = document.createElement('label');
            alignmentControl.className =
                'glyph-component-property-control glyph-component-property-checkbox';

            const alignmentInput = document.createElement('input');
            alignmentInput.type = 'checkbox';
            alignmentInput.className =
                'glyph-component-property-checkbox-input';
            alignmentInput.dataset.propertyField = 'component-auto-alignment';
            alignmentInput.checked = alignmentState === true;
            alignmentInput.indeterminate = alignmentState === 'mixed';

            const alignmentLabel = document.createElement('span');
            alignmentLabel.className = 'glyph-property-control-label';
            alignmentLabel.textContent = 'Auto Align';
            alignmentLabel.title =
                'Enable automatic component alignment for selected components';

            alignmentInput.addEventListener('change', () => {
                void this.commitComponentAutoAlignmentPropertyPanelValue(
                    alignmentInput.checked
                );
            });

            alignmentControl.appendChild(alignmentInput);
            alignmentControl.appendChild(alignmentLabel);

            content.appendChild(fieldsRow);
            fieldsRow.appendChild(alignmentControl);

            if (anchorOverrideOptions.length > 1) {
                const anchorWrapper = document.createElement('label');
                anchorWrapper.className = 'glyph-component-property-control';

                const anchorLabel = document.createElement('span');
                anchorLabel.className = 'glyph-property-control-label';
                anchorLabel.textContent = 'Anchor';
                anchorLabel.title =
                    'Choose which eligible target anchor this automatic component attaches to';

                const anchorSelect = document.createElement('select');
                anchorSelect.className = 'glyph-property-input';
                anchorSelect.dataset.propertyField = 'component-anchor';

                const automaticOption = document.createElement('option');
                automaticOption.value = '';
                automaticOption.textContent = 'Automatic';
                anchorSelect.appendChild(automaticOption);

                for (const anchorName of anchorOverrideOptions) {
                    const option = document.createElement('option');
                    option.value = anchorName;
                    option.textContent = anchorName;
                    anchorSelect.appendChild(option);
                }

                anchorSelect.value = selectedComponents[0].anchor || '';
                anchorSelect.addEventListener('change', () => {
                    void this.commitComponentAnchorPropertyPanelValue(
                        anchorSelect.value
                    );
                });

                anchorWrapper.appendChild(anchorLabel);
                anchorWrapper.appendChild(anchorSelect);
                content.appendChild(anchorWrapper);
            }

            this.propertyPanel.appendChild(content);
            this.restoreActivePropertyInput(activeInputState);
            return;
        }

        const layer = this.getCurrentEditingLayerModel();
        if (!layer) {
            return;
        }

        const content = document.createElement('div');
        content.className = 'glyph-property-panel-content';
        const automaticLayer = layer.isAutomaticAlignedLayer();

        const createControl = (side: 'left' | 'right', shortLabel: string) => {
            const wrapper = document.createElement('label');
            wrapper.className = 'glyph-property-control';

            const label = document.createElement('span');
            label.className = 'glyph-property-control-label';
            label.textContent = shortLabel;
            label.title =
                side === 'left' ? 'Left sidebearing' : 'Right sidebearing';

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'glyph-property-input';
            input.dataset.sidebearingSide = side;
            input.dataset.propertyField = `side-${side}`;

            const resolution = layer.resolveMetricsKey(side);
            const storedMetricsKey =
                (side === 'left'
                    ? layer.leftMetricsKey || layer.parent()?.leftMetricsKey
                    : layer.rightMetricsKey ||
                      layer.parent()?.rightMetricsKey) || undefined;
            const metricsKey = resolution.input
                ? storedMetricsKey || resolution.input
                : undefined;
            const showAutoPlaceholder = !metricsKey && automaticLayer;
            const displayedValue = showAutoPlaceholder
                ? ''
                : (metricsKey ??
                  String(side === 'left' ? layer.lsb : layer.rsb));
            input.value = displayedValue;
            if (showAutoPlaceholder) {
                input.placeholder = '=+0 or ==+0';
            }
            if (automaticLayer) {
                input.title =
                    'Automatic layers only accept =+/- or ==+/- sidebearing adjustments';
            }
            if (resolution.error) {
                input.classList.add('invalid');
            }

            const getResolvedValue = () =>
                resolution.value ?? (side === 'left' ? layer.lsb : layer.rsb);

            const arrowInputController = automaticLayer
                ? null
                : new ArrowAdjustableTextInput({
                      input,
                      getValue: () => {
                          const trimmedValue = input.value.trim();
                          return isPlainNumericInputValue(trimmedValue)
                              ? Number(trimmedValue)
                              : getResolvedValue();
                      },
                      applyValue: async (nextValue) => {
                          input.dataset.skipNextPropertyCommit = 'true';
                          await this.commitPropertyPanelValue(
                              side,
                              String(nextValue)
                          );
                      },
                      findReplacementInput: () =>
                          this.propertyPanel?.querySelector(
                              `.glyph-property-input[data-property-field="side-${side}"]`
                          ) as HTMLInputElement | null
                  });

            input.addEventListener('change', () => {
                if (input.dataset.skipNextPropertyCommit === 'true') {
                    delete input.dataset.skipNextPropertyCommit;
                    return;
                }

                void this.commitPropertyPanelValue(side, input.value);
            });
            input.addEventListener('keydown', (event) => {
                if (this.handlePropertyInputUndoRedo(event)) {
                    return;
                }

                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    this.outlineEditor.restoreFocus();
                    return;
                }

                if (event.key === 'Enter') {
                    event.preventDefault();
                    this.restoreCanvasFocusAfterPropertyCommit = true;
                    input.dataset.skipNextPropertyCommit = 'true';
                    void this.commitPropertyPanelValue(side, input.value);
                    input.blur();
                }
            });
            input.addEventListener('blur', () => {
                setTimeout(() => {
                    if (this.restoreCanvasFocusAfterPropertyCommit) {
                        this.restoreCanvasFocusAfterPropertyCommit = false;
                        if (!arrowInputController?.isApplyingStep) {
                            this.outlineEditor.restoreFocus();
                        }
                        return;
                    }

                    const activeElement =
                        document.activeElement as HTMLElement | null;
                    if (
                        activeElement &&
                        this.isTextInputElement(activeElement)
                    ) {
                        return;
                    }

                    if (!arrowInputController?.isApplyingStep) {
                        this.outlineEditor.restoreFocus();
                    }
                }, 0);
            });

            const valueLabel = document.createElement('span');
            valueLabel.className = 'glyph-property-value';
            valueLabel.textContent = String(
                resolution.value ?? (side === 'left' ? layer.lsb : layer.rsb)
            );

            wrapper.appendChild(label);
            wrapper.appendChild(input);
            wrapper.appendChild(valueLabel);
            return wrapper;
        };

        const createWidthDisplay = () => {
            const wrapper = document.createElement('div');
            wrapper.className = 'glyph-property-display';

            const label = document.createElement('span');
            label.className = 'glyph-property-control-label';
            label.textContent = 'W';
            label.title = 'Advance width';

            const valueLabel = document.createElement('span');
            valueLabel.className = 'glyph-property-display-value';
            valueLabel.textContent = String(layer.width);

            wrapper.appendChild(label);
            wrapper.appendChild(valueLabel);
            return wrapper;
        };

        content.appendChild(createControl('left', 'LSB'));
        content.appendChild(createWidthDisplay());
        content.appendChild(createControl('right', 'RSB'));
        this.propertyPanel.appendChild(content);
        this.restoreActivePropertyInput(activeInputState);
    }

    private renderTextModePropertyPanel(
        activeInputState: ActivePropertyInputState | null
    ): void {
        if (!this.propertyPanel || !this.textRunEditor) {
            return;
        }

        this.propertyPanel.classList.remove('hidden');
        this.propertyPanel.classList.add('text-mode-kerning-panel');

        const context = this.getCurrentTextModeKerningContext();
        if (
            context.status === 'no-pair' ||
            context.status === 'bidi-boundary'
        ) {
            const placeholder = document.createElement('div');
            placeholder.className = 'glyph-property-panel-placeholder';

            const message = document.createElement('span');
            message.className = 'glyph-property-value';
            message.textContent = context.message;

            placeholder.appendChild(message);
            this.propertyPanel.appendChild(placeholder);
            return;
        }

        const content = document.createElement('div');
        content.className =
            'glyph-property-panel-content glyph-kerning-panel-content';

        const shell = document.createElement('div');
        shell.className = 'glyph-kerning-panel-shell';

        const createSide = (
            side: KerningSide,
            title: string,
            glyphName: string | null,
            options: TextModeKerningOperand[]
        ) => {
            const sideElement = document.createElement('div');
            sideElement.className = 'glyph-kerning-side';

            const header = document.createElement('span');
            header.className = 'glyph-property-control-label';
            header.textContent = title;
            sideElement.appendChild(header);

            const pills = document.createElement('div');
            pills.className = 'glyph-kerning-pills';

            for (const option of options) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className =
                    'glyph-filter-legend-item glyph-kerning-pill';
                button.dataset.kerningSide = side;
                button.dataset.kerningKey = option.key;
                button.title = option.label;

                const label = document.createElement('span');
                label.className =
                    'glyph-filter-legend-label glyph-kerning-pill-label';
                label.textContent = option.label;

                button.appendChild(label);

                button.classList.toggle(
                    'glyph-kerning-pill-base',
                    option.kind === 'glyph'
                );
                if (option.participates) {
                    button.classList.add('glyph-kerning-pill-participates');
                }
                if (option.compatible && !option.active) {
                    button.classList.add('selected-glyph-group');
                }
                if (option.active) {
                    button.classList.add('active');
                }

                if (option.removable) {
                    const removeBadge = document.createElement('span');
                    removeBadge.className = 'glyph-kerning-pill-remove';
                    removeBadge.title = glyphName
                        ? `Remove kerning group "${option.name}" from glyph "${glyphName}"`
                        : `Remove kerning group "${option.name}"`;
                    removeBadge.setAttribute('aria-hidden', 'true');

                    const removeIcon = document.createElement('span');
                    removeIcon.className =
                        'material-symbols-outlined glyph-kerning-pill-remove-icon';
                    removeIcon.textContent = 'close';
                    removeIcon.setAttribute('aria-hidden', 'true');
                    removeBadge.appendChild(removeIcon);
                    button.appendChild(removeBadge);
                }

                button.addEventListener('click', (event) => {
                    const removeTarget = (
                        event.target as HTMLElement | null
                    )?.closest('.glyph-kerning-pill-remove');
                    if (removeTarget) {
                        event.preventDefault();
                        if (!glyphName) {
                            return;
                        }
                        this.updateTextModeKerningGroupMembership(
                            side,
                            glyphName,
                            option.name,
                            false
                        );
                        return;
                    }

                    this.setTextModeKerningSelection(side, option.key);
                });

                pills.appendChild(button);
            }

            sideElement.appendChild(pills);
            return sideElement;
        };

        const createAddButton = (
            side: KerningSide,
            glyphName: string | null
        ) => {
            const fontModel = fontManager.currentFont?.fontModel;
            const hasExistingGroup = glyphName
                ? collectKerningGroupMemberships(
                      side === 'first'
                          ? fontModel?.first_kern_groups
                          : fontModel?.second_kern_groups,
                      glyphName
                  ).length > 0
                : false;
            const addButton = document.createElement('button');
            addButton.type = 'button';
            addButton.className = 'glyph-kerning-pill-add';
            addButton.textContent = '+';
            addButton.disabled = hasExistingGroup;
            addButton.title = glyphName
                ? hasExistingGroup
                    ? `Glyph "${glyphName}" already has a ${side} kerning group`
                    : `Add kerning group to glyph "${glyphName}"`
                : 'Add kerning group';
            addButton.addEventListener('click', () => {
                this.promptAndAddTextModeKerningGroup(side, glyphName);
            });
            return addButton;
        };

        const center = document.createElement('div');
        center.className = 'glyph-kerning-center';

        if (context.status === 'off-master') {
            const message = document.createElement('span');
            message.className = 'glyph-property-value';
            message.textContent = context.message;
            center.appendChild(message);
        } else {
            const code = document.createElement('div');
            code.className = 'glyph-kerning-code';

            const addCodeToken = (text: string, className?: string) => {
                const token = document.createElement('span');
                token.className = className || 'glyph-property-value';
                token.textContent = text;
                code.appendChild(token);
            };

            const pairKey =
                context.selectedFirstKey && context.selectedSecondKey
                    ? `${context.selectedFirstKey}\u0000${context.selectedSecondKey}`
                    : null;
            const draftScopeKey = this.getTextModeKerningDraftScopeKey(
                context.master?.id || null,
                context.isRTL
            );
            const initialValue =
                pairKey &&
                this.textModeKerningDraftPairKey === pairKey &&
                this.textModeKerningDraftScopeKey === draftScopeKey
                    ? this.textModeKerningDraftValue || ''
                    : context.hasSelectedValue && context.selectedValue !== null
                      ? String(context.selectedValue)
                      : '';

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'glyph-property-input glyph-kerning-value-input';
            input.dataset.propertyField = 'text-mode-kerning-value';
            input.value = initialValue;
            input.placeholder = '0';

            const arrowInputController = new ArrowAdjustableTextInput({
                input,
                getValue: () => {
                    const trimmedValue = input.value.trim();
                    if (isPlainNumericInputValue(trimmedValue)) {
                        return Number(trimmedValue);
                    }

                    return context.selectedValue ?? 0;
                },
                applyValue: async (nextValue) => {
                    input.dataset.skipNextPropertyCommit = 'true';
                    if (pairKey) {
                        this.textModeKerningDraftPairKey = pairKey;
                        this.textModeKerningDraftScopeKey = draftScopeKey;
                        this.textModeKerningDraftValue = String(nextValue);
                    }
                    await this.commitTextModeKerningValue(
                        String(nextValue),
                        context,
                        true
                    );
                },
                findReplacementInput: () =>
                    this.propertyPanel?.querySelector(
                        '.glyph-property-input[data-property-field="text-mode-kerning-value"]'
                    ) as HTMLInputElement | null
            });

            input.addEventListener('input', () => {
                if (pairKey) {
                    this.textModeKerningDraftPairKey = pairKey;
                    this.textModeKerningDraftScopeKey = draftScopeKey;
                    this.textModeKerningDraftValue = input.value;
                }
            });

            input.addEventListener('change', () => {
                if (input.dataset.skipNextPropertyCommit === 'true') {
                    delete input.dataset.skipNextPropertyCommit;
                    return;
                }

                void this.commitTextModeKerningValue(
                    input.value,
                    context,
                    true
                );
            });

            input.addEventListener('keydown', (event) => {
                if (this.handlePropertyInputUndoRedo(event)) {
                    return;
                }

                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    this.clearTextModeKerningDraft();
                    this.updatePropertyPanel();
                    return;
                }

                if (event.key === 'Enter') {
                    event.preventDefault();
                    input.dataset.skipNextPropertyCommit = 'true';
                    void this.commitTextModeKerningValue(
                        input.value,
                        context,
                        true
                    );
                }
            });

            addCodeToken('pos\u00A0');
            addCodeToken(
                `${context.selectedFirstLabel || ''}\u00A0`,
                'glyph-property-value glyph-kerning-code-first'
            );
            addCodeToken(
                `${context.selectedSecondLabel || ''}\u00A0`,
                'glyph-property-value glyph-kerning-code-second'
            );

            if (context.isRTL) {
                addCodeToken('<0\u00A00\u00A0');
                code.appendChild(input);
                addCodeToken('\u00A00>;');
            } else {
                code.appendChild(input);
                addCodeToken(';');
            }

            input.addEventListener('blur', () => {
                setTimeout(() => {
                    const activeElement =
                        document.activeElement as HTMLElement | null;
                    if (
                        activeElement &&
                        this.isTextInputElement(activeElement)
                    ) {
                        return;
                    }

                    if (arrowInputController.isApplyingStep) {
                        return;
                    }

                    if (input.dataset.skipNextPropertyCommit === 'true') {
                        delete input.dataset.skipNextPropertyCommit;
                        return;
                    }

                    void this.commitTextModeKerningValue(
                        input.value,
                        context,
                        true
                    );
                }, 0);
            });

            center.appendChild(code);
        }

        shell.appendChild(createAddButton('first', context.firstGlyphName));
        shell.appendChild(
            createSide(
                'first',
                'First',
                context.firstGlyphName,
                context.firstOptions
            )
        );
        shell.appendChild(center);
        shell.appendChild(
            createSide(
                'second',
                'Second',
                context.secondGlyphName,
                context.secondOptions
            )
        );
        shell.appendChild(createAddButton('second', context.secondGlyphName));

        content.appendChild(shell);

        this.propertyPanel.appendChild(content);
        this.restoreActivePropertyInput(activeInputState);
    }

    getSortedLayers(): any[] {
        if (
            !this.fontData ||
            !this.fontData.layers ||
            this.fontData.layers.length === 0
        ) {
            return [];
        }

        // Get sorted layers by master order.
        // Within one master, keep default layers first, then brace layers.
        const sortedLayers = [...this.fontData.layers].sort((a, b) => {
            const masterIndexA = this.fontData.masters.findIndex(
                (m: any) => m.id === a._master
            );
            const masterIndexB = this.fontData.masters.findIndex(
                (m: any) => m.id === b._master
            );

            const posA =
                masterIndexA === -1
                    ? this.fontData.masters.length
                    : masterIndexA;
            const posB =
                masterIndexB === -1
                    ? this.fontData.masters.length
                    : masterIndexB;

            if (posA !== posB) {
                return posA - posB;
            }

            // Within same master: default layers (no location) before brace layers
            const isBraceA = !!a.location && Object.keys(a.location).length > 0;
            const isBraceB = !!b.location && Object.keys(b.location).length > 0;
            if (isBraceA !== isBraceB) {
                return isBraceA ? 1 : -1;
            }

            if (isBraceA && isBraceB) {
                const axesOrder =
                    (fontManager.currentFont?.fontModel as any)?.axesOrder ||
                    Object.keys({
                        ...(a.location || {}),
                        ...(b.location || {})
                    }).sort();
                return compareLocationMaps(
                    a.location || {},
                    b.location || {},
                    axesOrder
                );
            }

            return 0;
        });
        return sortedLayers;
    }

    doubleClickOnGlyph(index: number): void {
        if (index !== this.textRunEditor!.selectedGlyphIndex) {
            this.textRunEditor!.selectGlyphByIndex(index);
            return;
        }
    }

    frameCurrentGlyph(margin: number | null = null): void {
        // Pan and zoom to show the current glyph with margin around it
        // Delegates to ViewportManager.frameGlyph

        if (
            !this.outlineEditor.active ||
            this.textRunEditor!.selectedGlyphIndex < 0
        ) {
            return;
        }

        const bounds = this.outlineEditor.calculateGlyphBoundingBox();
        if (!bounds) {
            return;
        }

        const rect = this.canvas!.getBoundingClientRect();

        // Get glyph position in text run
        const glyphPosition = this.textRunEditor!._getGlyphPosition(
            this.textRunEditor!.selectedGlyphIndex
        );

        // If editing inside a component, transform the bounding box to glyph space
        let transformedBounds = bounds;
        if (this.outlineEditor.isEditingComponent()) {
            const transform = this.outlineEditor.getAccumulatedTransform();
            const [a, b, c, d, tx, ty] = transform;

            // Transform all four corners of the bbox
            const corners = [
                { x: bounds.minX, y: bounds.minY },
                { x: bounds.maxX, y: bounds.minY },
                { x: bounds.minX, y: bounds.maxY },
                { x: bounds.maxX, y: bounds.maxY }
            ];

            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;

            for (const corner of corners) {
                const transformedX = a * corner.x + c * corner.y + tx;
                const transformedY = b * corner.x + d * corner.y + ty;
                minX = Math.min(minX, transformedX);
                minY = Math.min(minY, transformedY);
                maxX = Math.max(maxX, transformedX);
                maxY = Math.max(maxY, transformedY);
            }

            transformedBounds = {
                minX,
                minY,
                maxX,
                maxY,
                width: maxX - minX,
                height: maxY - minY
            };
        }

        // Delegate to ViewportManager
        this.viewportManager!.frameGlyph(
            transformedBounds,
            glyphPosition,
            rect,
            this.render.bind(this),
            margin
        );
    }

    getCmdZeroViewportTarget(
        margin: number | null = null
    ): { scale: number; panX: number; panY: number } | null {
        if (
            !this.outlineEditor.active ||
            this.textRunEditor!.selectedGlyphIndex < 0 ||
            !this.viewportManager ||
            !this.canvas
        ) {
            return null;
        }

        const rootLayerData = this.outlineEditor.layerData;
        if (!rootLayerData) {
            return null;
        }

        // Always frame the root glyph (Cmd+0 behavior), even when editing nested components.
        const bounds = Layer.calculateBoundingBox(rootLayerData, true);
        if (!bounds) {
            return null;
        }

        const rect = this.canvas.getBoundingClientRect();
        const glyphPosition = this.textRunEditor!._getGlyphPosition(
            this.textRunEditor!.selectedGlyphIndex
        );

        const effectiveMargin =
            margin === null
                ? APP_SETTINGS.OUTLINE_EDITOR.CANVAS_MARGIN
                : margin;
        const fontSpaceMinX =
            glyphPosition.xPosition + glyphPosition.xOffset + bounds.minX;
        const fontSpaceMaxX =
            glyphPosition.xPosition + glyphPosition.xOffset + bounds.maxX;
        const fontSpaceMinY = glyphPosition.yOffset + bounds.minY;
        const fontSpaceMaxY = glyphPosition.yOffset + bounds.maxY;

        const fontSpaceCenterX = (fontSpaceMinX + fontSpaceMaxX) / 2;
        const fontSpaceCenterY = (fontSpaceMinY + fontSpaceMaxY) / 2;

        const scaleX = (rect.width - effectiveMargin * 2) / bounds.width;
        const scaleY = (rect.height - effectiveMargin * 2) / bounds.height;
        const targetScale = Math.min(scaleX, scaleY);
        const clampedScale = Math.max(
            0.01,
            Math.min(
                APP_SETTINGS.OUTLINE_EDITOR.MAX_ZOOM_FOR_CMD_ZERO,
                targetScale
            )
        );

        const targetPanX = rect.width / 2 - fontSpaceCenterX * clampedScale;
        const targetPanY = rect.height / 2 - -fontSpaceCenterY * clampedScale;

        return {
            scale: clampedScale,
            panX: targetPanX,
            panY: targetPanY
        };
    }

    panToGlyph(glyphIndex: number): void {
        // Pan to show a specific glyph (used when switching glyphs with cmd+left/right)
        // Delegates to ViewportManager.panToGlyph

        // Skip during slider interpolation - we use auto-pan instead
        if (
            this.outlineEditor.isInterpolating ||
            !this.outlineEditor.active ||
            glyphIndex < 0 ||
            glyphIndex >= this.textRunEditor!.shapedGlyphs.length
        ) {
            console.log(
                'panToGlyph: early return - not in edit mode or invalid index',
                {
                    isGlyphEditMode: this.outlineEditor.active,
                    glyphIndex,
                    shapedGlyphsLength: this.textRunEditor!.shapedGlyphs?.length
                }
            );
            return;
        }

        const bounds = this.outlineEditor.calculateGlyphBoundingBox();
        if (!bounds) {
            console.log('panToGlyph: no bounds calculated');
            return;
        }

        const rect = this.canvas!.getBoundingClientRect();

        // Get glyph position in text run
        const glyphPosition = this.textRunEditor!._getGlyphPosition(glyphIndex);

        // If editing inside a component, transform the bounding box to glyph space
        let transformedBounds = bounds;
        if (this.outlineEditor.isEditingComponent()) {
            const transform = this.outlineEditor.getAccumulatedTransform();
            const [a, b, c, d, tx, ty] = transform;

            // Transform all four corners of the bbox
            const corners = [
                { x: bounds.minX, y: bounds.minY },
                { x: bounds.maxX, y: bounds.minY },
                { x: bounds.minX, y: bounds.maxY },
                { x: bounds.maxX, y: bounds.maxY }
            ];

            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;

            for (const corner of corners) {
                const transformedX = a * corner.x + c * corner.y + tx;
                const transformedY = b * corner.x + d * corner.y + ty;
                minX = Math.min(minX, transformedX);
                minY = Math.min(minY, transformedY);
                maxX = Math.max(maxX, transformedX);
                maxY = Math.max(maxY, transformedY);
            }

            transformedBounds = {
                minX,
                minY,
                maxX,
                maxY,
                width: maxX - minX,
                height: maxY - minY
            };
        }

        // Delegate to ViewportManager
        this.viewportManager!.panToGlyph(
            transformedBounds,
            glyphPosition,
            rect,
            this.render.bind(this)
        );
    }

    async updatePropertiesUI(options?: {
        skipAutoSelectMatchingLayer?: boolean;
    }): Promise<void> {
        if (!this.propertiesSection) return;

        // Prevent overlapping calls
        if (this.isUpdatingPropertiesUI) {
            console.log(
                '[GlyphCanvas] updatePropertiesUI already in progress, skipping'
            );
            return;
        }

        this.isUpdatingPropertiesUI = true;

        try {
            // Check if propertiesSection is still in the DOM
            if (!this.propertiesSection.parentElement) {
                const leftSidebar = document.getElementById(
                    'glyph-properties-sidebar'
                );
                if (leftSidebar) {
                    this.propertiesSection.innerHTML = '';
                    leftSidebar.appendChild(this.propertiesSection);
                } else {
                    return;
                }
            }

            // Update editor title bar with glyph name
            this.outlineEditor.updateEditorTitleBar();

            const nextContent = document.createElement('div');

            // Show unified master/layer list for both text and edit modes
            if (!this.outlineEditor.active) {
                // Text mode
                await this.displayMastersList(nextContent);
                this.propertiesSection.replaceChildren(
                    ...Array.from(nextContent.childNodes)
                );
                this.isUpdatingPropertiesUI = false;
                return;
            }

            // Edit mode
            if (
                this.textRunEditor!.selectedGlyphIndex >= 0 &&
                this.textRunEditor!.selectedGlyphIndex <
                    this.textRunEditor!.shapedGlyphs.length
            ) {
                await this.displayMastersList(nextContent, false); // Build off-DOM first; select after mount
            } else {
                // No glyph selected
                const emptyMessage = document.createElement('div');
                emptyMessage.className = 'editor-empty-message';
                emptyMessage.textContent = 'No glyph selected';
                nextContent.appendChild(emptyMessage);
            }

            this.propertiesSection.replaceChildren(
                ...Array.from(nextContent.childNodes)
            );

            if (
                this.outlineEditor.active &&
                this.textRunEditor!.selectedGlyphIndex >= 0 &&
                this.textRunEditor!.selectedGlyphIndex <
                    this.textRunEditor!.shapedGlyphs.length
            ) {
                if (options?.skipAutoSelectMatchingLayer) {
                    this.outlineEditor.updateLayerSelection();
                    return;
                }
                if (this.outlineEditor.draggingSomething) {
                    console.log(
                        '[DRAG-DEBUG] Skipping autoSelectMatchingLayer from updatePropertiesUI during drag'
                    );
                    return;
                }
                await this.outlineEditor.autoSelectMatchingLayer({
                    skipRender: true
                });
                if (
                    this.outlineEditor.active &&
                    this.textRunEditor!.selectedGlyphIndex >= 0
                ) {
                    this.render();
                    this.outlineEditor.performHitDetection(null);
                }
            }
        } finally {
            this.isUpdatingPropertiesUI = false;
        }
    }

    onTextChange(): void {
        // shapeText() already updated glyphNameBuffer from current editing-font shaping.

        // Calculate adaptive debounce delay based on typing speed
        const now = Date.now();
        const timeSinceLastKeystroke = now - this.textChangeLastKeystrokeTime;
        this.textChangeLastKeystrokeTime = now;

        // Determine if user is typing fast (burst) or slow
        // Fast typing = keystrokes within burst threshold
        const isBurstTyping =
            timeSinceLastKeystroke < this.textChangeBurstThreshold;
        const debounceDelay = isBurstTyping
            ? this.textChangeFastDelay
            : this.textChangeSlowDelay;

        // Debounce editing font recompilation with subset
        if (this.textChangeDebounceTimer) {
            clearTimeout(this.textChangeDebounceTimer);
        }

        // Cancel any pending deferred full compile — typing is still active
        if (this.textInputFullCompileTimer) {
            clearTimeout(this.textInputFullCompileTimer);
            this.textInputFullCompileTimer = null;
        }

        this.textChangeDebounceTimer = setTimeout(() => {
            if (fontManager && fontManager.isReady()) {
                const textBuffer = this.textRunEditor!.textBuffer;
                const subsetGlyphs =
                    fontManager.deriveSubsetGlyphsFromText(textBuffer);

                // Always include space glyph — it's typed frequently
                // and must always be present in the compiled subset
                const spaceGlyph =
                    fontManager.currentFont?.fontModel?.findGlyphByCodepoint(
                        0x20
                    );
                if (
                    spaceGlyph?.name &&
                    !subsetGlyphs.includes(spaceGlyph.name)
                ) {
                    subsetGlyphs.push(spaceGlyph.name);
                }

                const subsetKey = [...subsetGlyphs].sort().join('\u0000');

                if (subsetKey === this.textChangeLastSubsetKey) {
                    return;
                }

                this.textChangeLastSubsetKey = subsetKey;
                fontManager.updateEditingSubsetSnapshot(subsetGlyphs);

                // Mark as text-input so the pipeline skips full JSON transfer
                // and skips features/kerning for faster compilation
                fontManager.setEditingCompileContext('text-input', null);

                fontManager
                    .compileEditingFont(
                        textBuffer,
                        [],
                        subsetGlyphs.length > 0 ? subsetGlyphs : undefined
                    )
                    .then(() => {
                        // Schedule a deferred full compile with features/kerning
                        // after typing settles, for correct OT rendering
                        this.scheduleTextInputFullCompile();
                    })
                    .catch((error: any) => {
                        console.error(
                            'Failed to recompile editing font:',
                            error
                        );
                    });
            }
        }, debounceDelay);
    }

    /**
     * Schedule a deferred full compile (with features/kerning) after typing stops.
     * Resets on each call, so rapid typing only triggers one full compile.
     */
    scheduleTextInputFullCompile(): void {
        if (this.textInputFullCompileTimer) {
            clearTimeout(this.textInputFullCompileTimer);
        }
        this.textInputFullCompileTimer = setTimeout(() => {
            this.textInputFullCompileTimer = null;
            if (
                fontManager &&
                fontManager.isReady() &&
                fontManager.lastCompilationMode !== 'full'
            ) {
                fontManager.clearEditingCompileContext();
                fontManager.currentFont?.markDirty('text-input-full-compile');
                window.autoCompileManager.checkAndSchedule();
            }
        }, 500);
    }

    startKeyboardZoom(zoomIn: boolean): void {
        // Don't start a new animation if one is already in progress
        if (this.zoomAnimation.active) return;

        const settings = APP_SETTINGS.OUTLINE_EDITOR;
        const zoomFactor = zoomIn
            ? settings.ZOOM_KEYBOARD_FACTOR
            : 1 / settings.ZOOM_KEYBOARD_FACTOR;

        const rect = this.canvas!.getBoundingClientRect();
        let centerX: number;
        let centerY: number;

        // Determine zoom center based on mode
        if (this.outlineEditor.active) {
            // Editing mode: zoom towards bbox center
            const bounds = this.outlineEditor.calculateGlyphBoundingBox();
            if (bounds) {
                // Get bbox center in glyph coordinates
                const bboxCenterX = (bounds.minX + bounds.maxX) / 2;
                const bboxCenterY = (bounds.minY + bounds.maxY) / 2;

                // Get glyph position in text run
                const glyphPosition = this.textRunEditor!._getGlyphPosition(
                    this.textRunEditor!.selectedGlyphIndex
                );

                // If editing inside a component, transform bbox center to glyph space
                let glyphSpaceX = bboxCenterX;
                let glyphSpaceY = bboxCenterY;
                if (this.outlineEditor.isEditingComponent()) {
                    const transform =
                        this.outlineEditor.getAccumulatedTransform();
                    const [a, b, c, d, tx, ty] = transform;
                    glyphSpaceX = a * bboxCenterX + c * bboxCenterY + tx;
                    glyphSpaceY = b * bboxCenterX + d * bboxCenterY + ty;
                }

                // Convert to screen coordinates
                const fontX =
                    glyphSpaceX +
                    glyphPosition.xPosition +
                    glyphPosition.xOffset;
                const fontY = glyphSpaceY + glyphPosition.yOffset;
                const screenPoint =
                    this.viewportManager!.fontToScreenCoordinates(fontX, fontY);
                centerX = screenPoint.x;
                centerY = screenPoint.y;
            } else {
                // Fallback to canvas center if no bounds
                centerX = rect.width / 2;
                centerY = rect.height / 2;
            }
        } else {
            // Text mode: zoom towards cursor center
            const cursorGlyphX = this.textRunEditor!.cursorX;
            const cursorGlyphY = 0; // Cursor is at baseline

            // Convert cursor position to screen coordinates
            const screenPoint = this.viewportManager!.fontToScreenCoordinates(
                cursorGlyphX,
                cursorGlyphY
            );
            centerX = screenPoint.x;
            centerY = screenPoint.y;
        }

        // Set up animation
        this.zoomAnimation.active = true;
        this.zoomAnimation.currentFrame = 0;
        this.zoomAnimation.totalFrames = 10;
        this.zoomAnimation.startScale = this.viewportManager!.scale;
        this.zoomAnimation.endScale = this.viewportManager!.scale * zoomFactor;
        this.zoomAnimation.centerX = centerX;
        this.zoomAnimation.centerY = centerY;

        // Start animation loop
        this.animateKeyboardZoom();
    }

    animateKeyboardZoom(): void {
        if (!this.zoomAnimation.active) return;

        this.zoomAnimation.currentFrame++;

        // Calculate progress (ease-in-out)
        const progress =
            this.zoomAnimation.currentFrame / this.zoomAnimation.totalFrames;
        const easedProgress =
            progress < 0.5
                ? 2 * progress * progress
                : 1 - Math.pow(-2 * progress + 2, 2) / 2;

        // Interpolate scale
        const currentScale =
            this.zoomAnimation.startScale +
            (this.zoomAnimation.endScale - this.zoomAnimation.startScale) *
                easedProgress;

        // Apply zoom
        const zoomFactor = currentScale / this.viewportManager!.scale;
        this.viewportManager!.zoom(
            zoomFactor,
            this.zoomAnimation.centerX,
            this.zoomAnimation.centerY
        );

        // Render
        this.render();

        // Continue or finish animation
        if (this.zoomAnimation.currentFrame < this.zoomAnimation.totalFrames) {
            requestAnimationFrame(() => this.animateKeyboardZoom());
        } else {
            this.zoomAnimation.active = false;
        }
    }

    render(): void {
        // Skip rendering if suppressed (during critical operations)
        if (this.renderSuppressed) {
            this.hasDeferredRenderRequest = true;
            timelineMark('canvas.render.deferredSuppressed');
            return;
        }

        this.hasDeferredRenderRequest = false;

        // Update glyph_stack label if it exists (development mode only, not in test mode)
        if (window.isDevelopment?.() && !window.isTestMode?.()) {
            // If we don't have a reference, try to find it in the DOM (in case it was created asynchronously)
            if (!this.glyphStackLabel) {
                this.glyphStackLabel = this.propertiesSection?.querySelector(
                    '.glyph-stack-debug'
                ) as HTMLElement | null;
            }

            if (this.glyphStackLabel) {
                this.glyphStackLabel.textContent = `Stack: ${this.outlineEditor.glyphStack || '(none)'}`;
            }
        }

        this.renderer!.render();
        const lastRenderState =
            ((window as any).__glyphCanvasRenderState as
                | { sequence?: number }
                | undefined) ?? undefined;
        const nextRenderState = {
            sequence: (lastRenderState?.sequence ?? 0) + 1,
            mode: this.outlineEditor.active ? 'edit' : 'text',
            selectedGlyphIndex: this.textRunEditor?.selectedGlyphIndex ?? -1,
            selectedLayerId: this.outlineEditor.selectedLayerId ?? null,
            glyphStack: this.outlineEditor.glyphStack || '',
            hasLayerData: Boolean(this.outlineEditor.layerData),
            isInterpolated: Boolean(
                this.outlineEditor.layerData?.isInterpolated
            )
        };
        (window as any).__glyphCanvasRenderState = nextRenderState;
        window.dispatchEvent(
            new CustomEvent('glyphCanvasRendered', {
                detail: nextRenderState
            })
        );
        timelineMark('canvas.render.completed');
    }

    requestRepaintAfterCompile(): void {
        this.hasDeferredRenderRequest = true;
        timelineMark('canvas.compileRepaint.requested');

        let attempts = 0;
        const maxAttempts = 180;

        const tryRepaint = () => {
            if (!this.hasDeferredRenderRequest) {
                return;
            }

            if (this.renderSuppressed) {
                attempts += 1;
                timelineMark('canvas.compileRepaint.waitingForUnsuppress');
                if (attempts >= maxAttempts) {
                    timelineMark('canvas.compileRepaint.timeout');
                    return;
                }

                requestAnimationFrame(tryRepaint);
                return;
            }

            timelineMark('canvas.compileRepaint.executingRender');
            this.render();
            if (this.outlineEditor.active) {
                this.outlineEditor.performHitDetection(null);
            }
            timelineMark('canvas.compileRepaint.completed');
        };

        requestAnimationFrame(tryRepaint);
    }

    destroy(): void {
        window.removeEventListener(
            'layerFingerprintChanged',
            this.handleLayerFingerprintChanged
        );
        window.removeEventListener('fontModelSync', this.handleFontModelSync);

        // Clear any pending blur timeout
        if (this.blurTimeoutId) {
            clearTimeout(this.blurTimeoutId);
            this.blurTimeoutId = null;
        }

        // Disconnect resize observer
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }

        // Clean up HarfBuzz resources
        this.textRunEditor!.destroyHarfbuzz();

        // Remove canvas
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }

        if (this.propertyPanel && this.propertyPanel.parentNode) {
            this.propertyPanel.parentNode.removeChild(this.propertyPanel);
        }
    }

    // ==================== Cursor Methods ====================

    onFocus(): void {
        // Cancel any pending blur timeout to prevent flicker
        if (this.blurTimeoutId) {
            clearTimeout(this.blurTimeoutId);
            this.blurTimeoutId = null;
        }
        this.isFocused = true;
        this.cursorVisible = true;
        // Don't render on focus change if in preview mode (no cursor visible)
        if (!this.outlineEditor.isPreviewMode) {
            this.render();
        }
    }

    onBlur(): void {
        // Delay blur to prevent cursor flicker when clicking sidebar elements
        // Focus is typically restored within a few ms, so 100ms is plenty
        this.blurTimeoutId = setTimeout(() => {
            this.blurTimeoutId = null;
            this.isFocused = false;
            // Don't render on blur if in preview mode (no cursor visible)
            if (!this.outlineEditor.isPreviewMode) {
                this.render();
            }
        }, 100);
    }

    onKeyDown(e: KeyboardEvent): void {
        if (this.mouseUpFinalization) {
            e.preventDefault();
            const finalization = this.mouseUpFinalization;
            void finalization.then(() => {
                if (this.mouseUpFinalization !== null) {
                    return;
                }
                this.onKeyDown(e);
            });
            return;
        }

        // Handle Cmd+Plus/Minus for zoom in/out
        if (
            (e.metaKey || e.ctrlKey) &&
            (e.key === '=' || e.key === '+' || e.key === '-')
        ) {
            e.preventDefault();
            const zoomIn = e.key === '=' || e.key === '+';
            this.startKeyboardZoom(zoomIn);
            return;
        }

        // Handle Cmd+Up/Down to cycle through masters in text mode
        if (
            (e.metaKey || e.ctrlKey) &&
            !this.outlineEditor.active &&
            (e.key === 'ArrowUp' || e.key === 'ArrowDown')
        ) {
            e.preventDefault();
            this.cycleMasters(e.key === 'ArrowUp');
            return;
        }

        if (
            !this.outlineEditor.active &&
            e.altKey &&
            (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
        ) {
            e.preventDefault();
            const magnitude =
                e.metaKey || e.ctrlKey ? 100 : e.shiftKey ? 10 : 1;
            const delta = e.key === 'ArrowLeft' ? -magnitude : magnitude;
            void this.nudgeTextModeKerningValue(delta);
            return;
        }

        // Handle arrow keys and spacebar in outline editor
        this.outlineEditor.onKeyDown(e);

        // Handle Cmd+Enter to enter glyph edit mode at cursor position (text editing mode only)
        if (
            (e.metaKey || e.ctrlKey) &&
            e.key === 'Enter' &&
            !this.outlineEditor.active
        ) {
            e.preventDefault();
            this.enterGlyphEditModeAtCursor();
            return;
        }

        // Handle cursor navigation and text editing
        // Note: Escape key is handled globally in constructor for better focus handling

        // Cmd+0 / Ctrl+0 - Frame current glyph (in edit mode) or reset zoom (in text mode)
        if ((e.metaKey || e.ctrlKey) && e.key === '0') {
            e.preventDefault();
            if (
                this.outlineEditor.active &&
                this.textRunEditor!.selectedGlyphIndex >= 0
            ) {
                // In glyph edit mode: frame the current glyph
                this.frameCurrentGlyph();
            } else {
                // In text mode: reset zoom and position
                this.resetZoomAndPosition();
            }
            return;
        }

        // In glyph edit mode: only prevent default for keys we handle
        // Let browser shortcuts (Cmd+R, Cmd+T, Cmd+W, etc.) pass through
        if (this.outlineEditor.active) {
            // Only prevent default for non-modifier keys and arrow keys that we handle
            if (!e.metaKey && !e.ctrlKey) {
                e.preventDefault();
            }
            return;
        }

        // Text run selection and editing shortcuts
        this.textRunEditor!.handleKeyDown(e);
    }

    getClickedCursorPosition(e: MouseEvent): number | null {
        // Convert click position to cursor position
        const rect = this.canvas!.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Transform to glyph space
        let { x: glyphX, y: glyphY } =
            this.viewportManager!.getFontSpaceCoordinates(mouseX, mouseY);

        // Check if clicking within cursor height range (same as cursor drawing)
        // Cursor goes from 1000 (top) to -300 (bottom)
        if (glyphY > 1000 || glyphY < -300) {
            return null; // Clicked outside cursor height - allow panning
        }
        return this.textRunEditor!.getGlyphIndexAtClick(glyphX, glyphY);
    }

    isCursorVisible(): boolean {
        // Check if cursor is within the visible viewport
        const rect = this.canvas!.getBoundingClientRect();

        // Transform cursor position from font space to screen space
        const screenX =
            this.textRunEditor!.cursorX * this.viewportManager!.scale +
            this.viewportManager!.panX;

        // Define margin from edges (in screen pixels)
        const margin = 30;

        // Check if cursor is within visible bounds with margin
        return screenX >= margin && screenX <= rect.width - margin;
    }

    panToCursor(): void {
        // Pan viewport to show cursor with smooth animation
        // Never pan to cursor in edit mode — the cursor position tracks the
        // selected glyph's text-run position and has no relation to what the
        // user is focusing on during outline editing. Spurious pans happen when
        // shapeText dispatches cursormoved after a compile completes post-edit.
        if (this.outlineEditor.active) {
            return;
        }

        if (this.isCursorVisible()) {
            return; // Cursor is already visible
        }

        const rect = this.canvas!.getBoundingClientRect();
        const margin = 30; // Same margin as visibility check

        // Calculate target panX to center cursor with margin
        const screenX =
            this.textRunEditor!.cursorX * this.viewportManager!.scale +
            this.viewportManager!.panX;

        let targetPanX;
        if (screenX < margin) {
            // Cursor is off left edge - position it at left margin
            targetPanX =
                margin -
                this.textRunEditor!.cursorX * this.viewportManager!.scale;
        } else {
            // Cursor is off right edge - position it at right margin
            targetPanX =
                rect.width -
                margin -
                this.textRunEditor!.cursorX * this.viewportManager!.scale;
        }

        // Start animation
        this.viewportManager!.animatePan(
            targetPanX,
            this.viewportManager!.panY,
            this.render.bind(this)
        );
    }

    captureTextModeAutoPanAnchor(): void {
        // Capture the current cursor screen position for auto-panning during slider animation
        if (!this.textRunEditor || !this.viewportManager) {
            this.textModeAutoPanAnchorScreen = null;
            return;
        }

        // Convert cursor position from font coordinates to screen coordinates
        const screenPos = this.viewportManager.fontToScreenCoordinates(
            this.textRunEditor.cursorX,
            0 // Y position doesn't matter for horizontal text
        );

        this.textModeAutoPanAnchorScreen = screenPos;
    }

    applyTextModeAutoPanAdjustment(): void {
        // Adjust pan to keep cursor at the anchor position during animation
        if (
            !this.textModeAutoPanAnchorScreen ||
            !this.textRunEditor ||
            !this.viewportManager
        ) {
            return;
        }

        // Get current cursor screen position
        const currentScreenPos = this.viewportManager.fontToScreenCoordinates(
            this.textRunEditor.cursorX,
            0
        );

        // Calculate the offset
        const offsetX = this.textModeAutoPanAnchorScreen.x - currentScreenPos.x;

        // Apply the pan adjustment (only horizontal for text mode)
        this.viewportManager.panX += offsetX;
    }

    resetZoomAndPosition(): void {
        // Zoom to fit text, matching the initial view when font loads
        const rect = this.canvas!.getBoundingClientRect();
        this.viewportManager!.zoomToFitText(
            this.textRunEditor!.shapedGlyphs,
            rect,
            this.render.bind(this)
        );
    }

    toGlyphLocal(x: number, y: number): { glyphX: number; glyphY: number } {
        return this.viewportManager!.getGlyphLocalCoordinates(
            x,
            y,
            this.textRunEditor!.shapedGlyphs,
            this.textRunEditor!.selectedGlyphIndex
        );
    }
}

function initCanvas() {
    const editorContent = document.querySelector('#view-editor .view-content');
    if (editorContent) {
        // Create main container with flexbox layout
        const mainContainer = document.createElement('div');
        mainContainer.style.display = 'flex';
        mainContainer.style.width = '100%';
        mainContainer.style.height = '100%';
        mainContainer.style.overflow = 'hidden';

        // Create left sidebar for glyph properties
        const leftSidebar = document.createElement('div');
        leftSidebar.id = 'glyph-properties-sidebar';
        leftSidebar.className = 'view-sidebar view-sidebar-left';

        // Create right sidebar for axes
        const rightSidebar = document.createElement('div');
        rightSidebar.id = 'glyph-editor-sidebar';
        rightSidebar.className = 'view-sidebar view-sidebar-right';

        const rightSidebarScrollContent = document.createElement('div');
        rightSidebarScrollContent.id = 'glyph-editor-scroll-content';
        rightSidebar.appendChild(rightSidebarScrollContent);

        // Create canvas container
        const canvasContainer = document.createElement('div');
        canvasContainer.id = 'glyph-canvas-container';
        canvasContainer.style.flex = '1';
        canvasContainer.style.height = '100%';
        canvasContainer.style.position = 'relative';

        // Assemble layout (left sidebar, canvas, right sidebar)
        mainContainer.appendChild(leftSidebar);
        mainContainer.appendChild(canvasContainer);
        mainContainer.appendChild(rightSidebar);
        editorContent.appendChild(mainContainer);

        const responsiveEditorView = document.getElementById('view-editor');
        if (responsiveEditorView) {
            attachTopRowSidebarInterpolation(responsiveEditorView);
        }

        // Initialize canvas
        window.glyphCanvas = new GlyphCanvas('glyph-canvas-container');

        // Create glyph properties container (initially empty)
        const propertiesSection = document.createElement('div');
        propertiesSection.id = 'glyph-properties-section';
        leftSidebar.appendChild(propertiesSection);

        // Create variable axes container (initially empty)
        const axesSection = window.glyphCanvas.axesManager!.createAxesSection();
        rightSidebarScrollContent.appendChild(axesSection);

        // Create OpenType features container (initially empty)
        const featuresSection =
            window.glyphCanvas.featuresManager!.createFeaturesSection();
        rightSidebarScrollContent.appendChild(featuresSection);

        // Create font QC summary container (bottom of right sidebar)
        const fontQcSection = document.createElement('div');
        fontQcSection.id = 'font-qc-summary-section';
        fontQcSection.className = 'font-qc-summary collapsed';

        const fontQcHeaderContainer = document.createElement('div');
        fontQcHeaderContainer.className = 'font-qc-header-container';

        const fontQcListContainer = document.createElement('div');
        fontQcListContainer.className = 'font-qc-list-container';

        const fontQcHeader = document.createElement('div');
        fontQcHeader.className = 'font-qc-header';

        const fontQcTitleWrap = document.createElement('div');
        fontQcTitleWrap.className = 'font-qc-title-wrap';

        const fontQcTitle = document.createElement('div');
        fontQcTitle.className = 'editor-section-title';
        fontQcTitle.textContent = 'Fontspector';

        const fontQcShortcut = document.createElement('span');
        fontQcShortcut.className =
            'font-qc-title-shortcut view-title-shortcut button-shortcut';
        fontQcShortcut.innerHTML =
            '<span class="material-symbols-outlined">keyboard_command_key</span><span class="material-symbols-outlined">keyboard_option_key</span>F';

        const fontQcCompileDot = document.createElement('span');
        fontQcCompileDot.className = 'font-qc-compile-dot';
        fontQcCompileDot.title = 'Fontspector idle';

        const fontQcCloseBtn = document.createElement('button');
        fontQcCloseBtn.className = 'font-qc-close-button';
        fontQcCloseBtn.type = 'button';
        fontQcCloseBtn.title = 'Close Fontspector';
        fontQcCloseBtn.innerHTML =
            '<span class="material-symbols-outlined">close</span>';

        const fontQcCounts = document.createElement('div');
        fontQcCounts.className = 'font-qc-counts';

        const failCount = document.createElement('button');
        failCount.className = 'font-qc-pill fail active';
        failCount.type = 'button';
        failCount.innerHTML =
            '<span class="label">Fail</span><span class="value">0</span>';

        const warnCount = document.createElement('button');
        warnCount.className = 'font-qc-pill warn active';
        warnCount.type = 'button';
        warnCount.innerHTML =
            '<span class="label">Warn</span><span class="value">0</span>';

        const infoCount = document.createElement('button');
        infoCount.className = 'font-qc-pill info active';
        infoCount.type = 'button';
        infoCount.innerHTML =
            '<span class="label">Info</span><span class="value">0</span>';

        const fontQcStatus = document.createElement('div');
        fontQcStatus.className = 'font-qc-status';
        fontQcStatus.textContent = 'Waiting';

        const fontQcProfileRow = document.createElement('div');
        fontQcProfileRow.className = 'font-qc-profile-row';

        const fontQcProfileLabel = document.createElement('label');
        fontQcProfileLabel.className = 'font-qc-profile-label';
        fontQcProfileLabel.setAttribute('for', 'font-qc-profile-select');
        fontQcProfileLabel.textContent = 'Profile';

        const fontQcProfileSelect = document.createElement('select');
        fontQcProfileSelect.id = 'font-qc-profile-select';
        fontQcProfileSelect.className = 'font-qc-profile-select';

        const fontQcSearchRow = document.createElement('div');
        fontQcSearchRow.className = 'font-qc-search-row';

        const fontQcSearchInput = document.createElement('input');
        fontQcSearchInput.className = 'font-qc-search-input';
        fontQcSearchInput.type = 'search';
        fontQcSearchInput.placeholder = 'Search checks';
        fontQcSearchInput.setAttribute(
            'aria-label',
            'Search Fontspector checks'
        );

        const fontQcBody = document.createElement('div');
        fontQcBody.className = 'font-qc-body';

        const fontQcList = document.createElement('div');
        fontQcList.className = 'font-qc-list';
        fontQcBody.appendChild(fontQcList);

        fontQcTitleWrap.appendChild(fontQcTitle);
        fontQcTitleWrap.appendChild(fontQcShortcut);
        fontQcTitleWrap.appendChild(fontQcCompileDot);
        fontQcHeader.appendChild(fontQcTitleWrap);
        fontQcHeader.appendChild(fontQcCloseBtn);
        fontQcCounts.appendChild(failCount);
        fontQcCounts.appendChild(warnCount);
        fontQcCounts.appendChild(infoCount);

        fontQcHeaderContainer.appendChild(fontQcHeader);
        fontQcHeaderContainer.appendChild(fontQcCounts);
        fontQcSearchRow.appendChild(fontQcSearchInput);
        fontQcHeaderContainer.appendChild(fontQcSearchRow);
        fontQcProfileRow.appendChild(fontQcProfileLabel);
        fontQcProfileRow.appendChild(fontQcProfileSelect);
        fontQcHeaderContainer.appendChild(fontQcProfileRow);
        fontQcHeaderContainer.appendChild(fontQcStatus);
        fontQcListContainer.appendChild(fontQcBody);
        fontQcSection.appendChild(fontQcHeaderContainer);
        fontQcSection.appendChild(fontQcListContainer);
        rightSidebar.appendChild(fontQcSection);

        let qcExpanded = false;
        let qcChecks: any[] = [];
        let qcAvailableProfiles: string[] = [];
        let selectedQcGlyphButton: {
            checkKey: string;
            checkSignature: string;
            glyphProblemSignature: string;
            glyphName: string;
            lastKnownPosition: [number, number] | null;
        } | null = null;
        const getSidebarCollapsedWidth = (): number => {
            const responsiveWidth = Number.parseFloat(
                getComputedStyle(rightSidebar).getPropertyValue(
                    '--top-row-sidebar-width'
                )
            );
            if (Number.isFinite(responsiveWidth) && responsiveWidth > 0) {
                return responsiveWidth;
            }

            return (
                Number.parseFloat(getComputedStyle(rightSidebar).width) || 200
            );
        };

        const syncRightSidebarWidth = (): void => {
            if (qcExpanded) {
                const expandedWidth = getSidebarCollapsedWidth() * 2;
                rightSidebar.style.width = `${expandedWidth}px`;
                rightSidebar.style.minWidth = `${expandedWidth}px`;
                return;
            }

            rightSidebar.style.width = '';
            rightSidebar.style.minWidth = '';
        };
        const qcFilters: Record<'fail' | 'warn' | 'info', boolean> = {
            fail: true,
            warn: true,
            info: true
        };
        let qcSearchQuery = '';

        const isRecord = (value: unknown): value is Record<string, unknown> =>
            typeof value === 'object' && value !== null;

        const parseUserspaceLocation = (
            value: unknown
        ): UserspaceLocation | null => {
            if (!isRecord(value)) {
                return null;
            }

            const location: UserspaceLocation = {};
            for (const [tag, rawValue] of Object.entries(value)) {
                if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
                    location[tag] = rawValue;
                }
            }

            return Object.keys(location).length ? location : null;
        };

        const parsePosition = (value: unknown): [number, number] | null => {
            if (!Array.isArray(value) || value.length < 2) {
                return null;
            }

            const [x, y] = value;
            if (
                typeof x !== 'number' ||
                typeof y !== 'number' ||
                !Number.isFinite(x) ||
                !Number.isFinite(y)
            ) {
                return null;
            }

            return [x, y];
        };

        const extractGlyphProblems = (item: any): QCGlyphProblem[] => {
            if (!Array.isArray(item?.metadata)) {
                return [];
            }

            const uniqueProblems = new Map<string, QCGlyphProblem>();

            for (const metadataEntry of item.metadata) {
                if (!isRecord(metadataEntry)) {
                    continue;
                }

                const rawGlyphProblem = metadataEntry.GlyphProblem;
                if (!isRecord(rawGlyphProblem)) {
                    continue;
                }

                const glyphName = rawGlyphProblem.glyph_name;
                if (typeof glyphName !== 'string' || !glyphName) {
                    continue;
                }

                const userspaceLocation = parseUserspaceLocation(
                    rawGlyphProblem.userspace_location
                );
                const position = parsePosition(rawGlyphProblem.position);

                const dedupeKey = JSON.stringify({
                    glyphName,
                    userspaceLocation,
                    position
                });

                uniqueProblems.set(dedupeKey, {
                    glyphName,
                    userspaceLocation,
                    position
                });
            }

            return Array.from(uniqueProblems.values());
        };

        const extractCodes = (item: any): string[] => {
            const uniqueCodes = new Set<string>();

            const pushCode = (value: unknown): void => {
                if (typeof value !== 'string') {
                    return;
                }

                const code = value.trim();
                if (code) {
                    uniqueCodes.add(code);
                }
            };

            if (Array.isArray(item?.codes)) {
                for (const codeValue of item.codes) {
                    pushCode(codeValue);
                }
            }

            pushCode(item?.code);

            if (!uniqueCodes.size) {
                uniqueCodes.add('uncoded');
            }

            return Array.from(uniqueCodes);
        };

        const getCheckName = (item: any): string => {
            if (typeof item?.checkId === 'string' && item.checkId.trim()) {
                return item.checkId.trim();
            }
            if (typeof item?.check === 'string' && item.check.trim()) {
                return item.check.trim();
            }
            if (typeof item?.name === 'string' && item.name.trim()) {
                return item.name.trim();
            }
            return '';
        };

        const stringifyMetadataEntry = (entry: unknown): string => {
            if (typeof entry === 'string') {
                return entry;
            }

            try {
                return JSON.stringify(entry);
            } catch {
                return '';
            }
        };

        const getMetadataSearchLines = (item: any): string[] => {
            if (!Array.isArray(item?.metadata)) {
                return [];
            }

            return item.metadata
                .map((entry: unknown) => stringifyMetadataEntry(entry).trim())
                .filter((entry: string) => Boolean(entry));
        };

        const getSearchHaystack = (item: any): string => {
            const level =
                typeof item?.level === 'string' ? item.level.toLowerCase() : '';
            const codes = extractCodes(item).join(' ');
            const message =
                typeof item?.message === 'string' ? item.message : '';
            const checkName = getCheckName(item);
            const metadata = getMetadataSearchLines(item).join(' ');

            return [level, checkName, codes, message, metadata]
                .join(' ')
                .toLowerCase();
        };

        const matchesQcSearch = (item: any, query: string): boolean => {
            const normalizedQuery = query.trim().toLowerCase();
            if (!normalizedQuery) {
                return true;
            }

            return getSearchHaystack(item).includes(normalizedQuery);
        };

        const appendHighlightedText = (
            container: HTMLElement,
            text: string,
            query: string
        ): void => {
            const normalizedQuery = query.trim();
            container.textContent = '';

            if (!normalizedQuery || !text) {
                container.textContent = text;
                return;
            }

            const lowerText = text.toLowerCase();
            const lowerQuery = normalizedQuery.toLowerCase();
            let scanIndex = 0;

            while (scanIndex < text.length) {
                const hitIndex = lowerText.indexOf(lowerQuery, scanIndex);
                if (hitIndex === -1) {
                    container.appendChild(
                        document.createTextNode(text.slice(scanIndex))
                    );
                    break;
                }

                if (hitIndex > scanIndex) {
                    container.appendChild(
                        document.createTextNode(text.slice(scanIndex, hitIndex))
                    );
                }

                const mark = document.createElement('mark');
                mark.className = 'font-qc-search-highlight';
                mark.textContent = text.slice(
                    hitIndex,
                    hitIndex + lowerQuery.length
                );
                container.appendChild(mark);

                scanIndex = hitIndex + lowerQuery.length;
            }
        };

        const getMetadataMatchSnippet = (item: any, query: string): string => {
            const normalizedQuery = query.trim().toLowerCase();
            if (!normalizedQuery) {
                return '';
            }

            const metadataLines = getMetadataSearchLines(item);
            for (const line of metadataLines) {
                if (line.toLowerCase().includes(normalizedQuery)) {
                    return line;
                }
            }

            return '';
        };

        const getQcCheckKey = (item: any, fallbackIndex: number): string => {
            if (typeof item?.__qcKey === 'string' && item.__qcKey) {
                return item.__qcKey;
            }
            return `qc-${fallbackIndex}`;
        };

        const serializeUserspaceLocation = (
            location: UserspaceLocation | null
        ): string => {
            if (!location) {
                return '';
            }

            const sortedEntries = Object.entries(location).sort(([a], [b]) =>
                a.localeCompare(b)
            );
            return JSON.stringify(sortedEntries);
        };

        const getCheckSignature = (item: any): string => {
            const level = (item?.level || 'info').toLowerCase();
            const message =
                typeof item?.message === 'string' ? item.message : '';
            const checkId =
                typeof item?.checkId === 'string' ? item.checkId : '';
            const codes = extractCodes(item);

            return JSON.stringify({ level, message, checkId, codes });
        };

        const getGlyphProblemSignature = (problem: QCGlyphProblem): string => {
            return JSON.stringify({
                glyphName: problem.glyphName,
                userspaceLocation: serializeUserspaceLocation(
                    problem.userspaceLocation
                )
            });
        };

        const clearActiveQcSelection = (): void => {
            selectedQcGlyphButton = null;
            window.glyphCanvas?.clearActiveQcCanvasMarkers();
        };

        const syncActiveSelectionToChecks = (
            status: 'ready' | 'compiling' | 'idle' | 'error'
        ): void => {
            if (!selectedQcGlyphButton) {
                return;
            }

            let matchedCheckKey: string | null = null;
            let matchedCheckSignature: string | null = null;
            let matchedGlyphProblem: QCGlyphProblem | null = null;
            let matchedGlyphProblemSignature: string | null = null;

            const distanceSquared = (
                first: [number, number],
                second: [number, number]
            ): number => {
                const dx = first[0] - second[0];
                const dy = first[1] - second[1];
                return dx * dx + dy * dy;
            };

            let bestMatchScore = Number.POSITIVE_INFINITY;
            let bestDistance = Number.POSITIVE_INFINITY;

            for (let index = 0; index < qcChecks.length; index++) {
                const check = qcChecks[index];
                const checkSignature = getCheckSignature(check);
                const glyphProblems = extractGlyphProblems(check);
                for (const glyphProblem of glyphProblems) {
                    if (
                        glyphProblem.glyphName !==
                        selectedQcGlyphButton.glyphName
                    ) {
                        continue;
                    }

                    const glyphProblemSignature =
                        getGlyphProblemSignature(glyphProblem);
                    const checkMatches =
                        checkSignature === selectedQcGlyphButton.checkSignature;
                    const glyphMatches =
                        glyphProblemSignature ===
                        selectedQcGlyphButton.glyphProblemSignature;

                    let score = 4;
                    if (checkMatches && glyphMatches) {
                        score = 0;
                    } else if (glyphMatches) {
                        score = 1;
                    } else if (checkMatches) {
                        score = 2;
                    } else {
                        score = 3;
                    }

                    let distance = Number.POSITIVE_INFINITY;
                    if (
                        selectedQcGlyphButton.lastKnownPosition &&
                        glyphProblem.position
                    ) {
                        distance = distanceSquared(
                            glyphProblem.position,
                            selectedQcGlyphButton.lastKnownPosition
                        );
                    }

                    if (
                        score < bestMatchScore ||
                        (score === bestMatchScore && distance < bestDistance)
                    ) {
                        bestMatchScore = score;
                        bestDistance = distance;
                        matchedCheckKey = getQcCheckKey(check, index);
                        matchedCheckSignature = checkSignature;
                        matchedGlyphProblem = glyphProblem;
                        matchedGlyphProblemSignature = glyphProblemSignature;
                    }
                }
            }

            if (
                !matchedCheckKey ||
                !matchedGlyphProblem ||
                !matchedCheckSignature ||
                !matchedGlyphProblemSignature
            ) {
                if (status === 'compiling' || qcChecks.length === 0) {
                    return;
                }
                clearActiveQcSelection();
                return;
            }

            selectedQcGlyphButton.checkKey = matchedCheckKey;
            selectedQcGlyphButton.checkSignature = matchedCheckSignature;
            selectedQcGlyphButton.glyphProblemSignature =
                matchedGlyphProblemSignature;
            selectedQcGlyphButton.lastKnownPosition =
                matchedGlyphProblem.position;

            if (matchedGlyphProblem.position) {
                window.glyphCanvas?.setActiveQcCanvasMarkers([
                    {
                        glyphName: matchedGlyphProblem.glyphName,
                        position: matchedGlyphProblem.position,
                        userspaceLocation: matchedGlyphProblem.userspaceLocation
                    }
                ]);
            } else {
                window.glyphCanvas?.clearActiveQcCanvasMarkers();
            }
        };

        const getCurrentStackGlyphName = (): string | null => {
            if (!window.glyphCanvas?.outlineEditor?.active) {
                return null;
            }

            const parsedStack =
                window.glyphCanvas.outlineEditor.parseGlyphStack();
            if (!parsedStack.length) {
                return null;
            }

            const currentEntry = parsedStack[parsedStack.length - 1];
            return currentEntry?.glyphName || null;
        };

        const createQcItemElement = (
            item: any,
            fallbackIndex: number,
            query: string
        ): HTMLElement => {
            const level = (item?.level || 'info').toLowerCase();
            const codes = extractCodes(item);
            const message = item?.message || '';
            const checkName = getCheckName(item);
            const checkKey = getQcCheckKey(item, fallbackIndex);
            const checkSignature = getCheckSignature(item);

            const itemElement = document.createElement('div');
            itemElement.className = `font-qc-item ${level}`;

            const metaElement = document.createElement('div');
            metaElement.className = 'font-qc-item-meta';

            const levelElement = document.createElement('span');
            levelElement.className = 'font-qc-item-meta-level';
            appendHighlightedText(
                levelElement,
                String(level).toUpperCase(),
                query
            );
            metaElement.appendChild(levelElement);

            if (checkName) {
                const checkNameElement = document.createElement('span');
                checkNameElement.className = 'font-qc-item-check-name';
                appendHighlightedText(checkNameElement, checkName, query);
                metaElement.appendChild(checkNameElement);
            }

            const codesElement = document.createElement('div');
            codesElement.className = 'font-qc-item-codes';
            for (const code of codes) {
                const codeElement = document.createElement('span');
                codeElement.className = 'font-qc-item-code';
                appendHighlightedText(codeElement, code, query);
                codesElement.appendChild(codeElement);
            }

            const messageElement = document.createElement('div');
            messageElement.className = 'font-qc-item-message';
            appendHighlightedText(messageElement, message, query);

            const metadataMatchSnippet = getMetadataMatchSnippet(item, query);
            itemElement.appendChild(metaElement);
            itemElement.appendChild(codesElement);
            itemElement.appendChild(messageElement);

            if (metadataMatchSnippet) {
                const metadataElement = document.createElement('div');
                metadataElement.className = 'font-qc-item-metadata';

                const metadataPrefix = document.createElement('span');
                metadataPrefix.className = 'font-qc-item-metadata-label';
                metadataPrefix.textContent = 'Meta:';
                metadataElement.appendChild(metadataPrefix);

                const metadataText = document.createElement('span');
                metadataText.className = 'font-qc-item-metadata-text';
                appendHighlightedText(
                    metadataText,
                    metadataMatchSnippet,
                    query
                );
                metadataElement.appendChild(metadataText);

                itemElement.appendChild(metadataElement);
            }

            const glyphProblems = extractGlyphProblems(item);

            const currentStackGlyphName = getCurrentStackGlyphName();
            if (
                currentStackGlyphName &&
                glyphProblems.some(
                    (problem) => problem.glyphName === currentStackGlyphName
                )
            ) {
                itemElement.classList.add('is-current-stack-glyph');
            }

            if (!glyphProblems.length) {
                return itemElement;
            }

            const actionsElement = document.createElement('div');
            actionsElement.className = 'font-qc-item-actions';

            const actionsLabel = document.createElement('span');
            actionsLabel.className = 'font-qc-item-actions-label';
            actionsLabel.textContent = 'Glyph:';
            actionsElement.appendChild(actionsLabel);

            for (const glyphProblem of glyphProblems) {
                const glyphButton = document.createElement('button');
                glyphButton.type = 'button';
                glyphButton.className = 'font-qc-glyph-button';
                glyphButton.textContent = glyphProblem.glyphName;
                const glyphProblemSignature =
                    getGlyphProblemSignature(glyphProblem);

                if (
                    selectedQcGlyphButton &&
                    selectedQcGlyphButton.checkKey === checkKey &&
                    selectedQcGlyphButton.glyphName ===
                        glyphProblem.glyphName &&
                    selectedQcGlyphButton.checkSignature === checkSignature &&
                    selectedQcGlyphButton.glyphProblemSignature ===
                        glyphProblemSignature
                ) {
                    glyphButton.classList.add('is-selected');
                }

                glyphButton.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();

                    selectedQcGlyphButton = {
                        checkKey,
                        checkSignature,
                        glyphProblemSignature,
                        glyphName: glyphProblem.glyphName,
                        lastKnownPosition: glyphProblem.position
                    };
                    if (qcExpanded) {
                        renderQcList();
                    }

                    void window.glyphCanvas
                        ?.activateQCGlyphProblem(glyphProblem)
                        .catch((error: unknown) => {
                            console.warn(
                                '[GlyphCanvas] Failed to activate QC glyph problem',
                                error
                            );
                        })
                        .finally(() => {
                            if (qcExpanded) {
                                renderQcList();
                            }
                        });
                });

                actionsElement.appendChild(glyphButton);
            }

            itemElement.appendChild(actionsElement);
            return itemElement;
        };

        const renderQcList = () => {
            if (!qcChecks.length) {
                fontQcList.innerHTML =
                    '<div class="font-qc-empty">No QC messages yet.</div>';
                return;
            }

            const visible = qcChecks.filter((item) => {
                const level = item?.level as 'fail' | 'warn' | 'info';
                return (
                    qcFilters[level] !== false &&
                    matchesQcSearch(item, qcSearchQuery)
                );
            });

            if (!visible.length) {
                fontQcList.innerHTML =
                    '<div class="font-qc-empty">No messages match current filters/search.</div>';
                return;
            }

            fontQcList.innerHTML = '';
            visible.forEach((item, index) => {
                fontQcList.appendChild(
                    createQcItemElement(item, index, qcSearchQuery)
                );
            });
        };

        const setQcExpanded = (expanded: boolean) => {
            qcExpanded = expanded;
            fontQcSection.classList.toggle('expanded', expanded);
            fontQcSection.classList.toggle('collapsed', !expanded);
            rightSidebar.classList.toggle('font-qc-expanded', expanded);
            rightSidebarScrollContent.style.display = expanded ? 'none' : '';
            syncRightSidebarWidth();

            if (expanded) {
                renderQcList();
            } else {
                clearActiveQcSelection();
            }
        };

        if (responsiveEditorView) {
            const responsiveSidebarObserver = new ResizeObserver(() => {
                syncRightSidebarWidth();
            });
            responsiveSidebarObserver.observe(responsiveEditorView);
        }

        const syncProfileOptions = (
            profiles: string[],
            selectedProfile: string | null
        ) => {
            const normalizedProfiles = profiles.length
                ? profiles
                : ['opentype'];
            const needsRebuild =
                normalizedProfiles.length !== qcAvailableProfiles.length ||
                normalizedProfiles.some(
                    (value, index) => qcAvailableProfiles[index] !== value
                );

            if (needsRebuild) {
                qcAvailableProfiles = [...normalizedProfiles];
                fontQcProfileSelect.innerHTML = '';
                for (const profile of qcAvailableProfiles) {
                    const option = document.createElement('option');
                    option.value = profile;
                    option.textContent = profile;
                    fontQcProfileSelect.appendChild(option);
                }
            }

            if (
                selectedProfile &&
                fontQcProfileSelect.value !== selectedProfile &&
                qcAvailableProfiles.includes(selectedProfile)
            ) {
                fontQcProfileSelect.value = selectedProfile;
            }
        };

        const updateQcSummary = (detail: any) => {
            const summary = detail?.summary || { fails: 0, warns: 0, infos: 0 };
            const status = detail?.status || 'idle';
            const isCompiling = status === 'compiling';
            const incomingChecks = Array.isArray(detail?.checks)
                ? detail.checks
                : qcChecks;
            const qcVersionSeed =
                typeof detail?.changeVersion === 'number'
                    ? detail.changeVersion
                    : 0;
            qcChecks = incomingChecks.map((check: any, index: number) => ({
                ...check,
                __qcKey: `${qcVersionSeed}:${index}`
            }));

            syncActiveSelectionToChecks(status);
            const checksWithMetadata = qcChecks.filter((check) =>
                Array.isArray(check?.metadata)
            ).length;
            const checksWithGlyphProblem = qcChecks.filter((check) =>
                Array.isArray(check?.metadata)
                    ? check.metadata.some(
                          (entry: unknown) =>
                              isRecord(entry) && isRecord(entry.GlyphProblem)
                      )
                    : false
            ).length;
            console.log(
                '[GlyphCanvas] Fontspector panel received checks:',
                qcChecks.length,
                'with metadata:',
                checksWithMetadata,
                'with GlyphProblem:',
                checksWithGlyphProblem,
                'status:',
                status,
                'profile:',
                detail?.profile
            );
            const availableProfiles = Array.isArray(detail?.availableProfiles)
                ? detail.availableProfiles
                : qcAvailableProfiles;
            const selectedProfile =
                typeof detail?.profile === 'string'
                    ? detail.profile
                    : window.fullCompileManager?.getProfile?.() || 'opentype';

            syncProfileOptions(availableProfiles, selectedProfile);

            const failValue = failCount.querySelector('.value');
            const warnValue = warnCount.querySelector('.value');
            const infoValue = infoCount.querySelector('.value');

            if (failValue) {
                failValue.textContent = String(summary.fails ?? 0);
            }
            if (warnValue) {
                warnValue.textContent = String(summary.warns ?? 0);
            }
            if (infoValue) {
                infoValue.textContent = String(summary.infos ?? 0);
            }

            failCount.style.display = (summary.fails ?? 0) > 0 ? '' : 'none';
            warnCount.style.display = (summary.warns ?? 0) > 0 ? '' : 'none';
            infoCount.style.display = (summary.infos ?? 0) > 0 ? '' : 'none';

            fontQcSection.classList.toggle('is-compiling', isCompiling);
            fontQcCompileDot.title = isCompiling ? 'Fontspector compiling' : '';

            if (status === 'error') {
                fontQcStatus.textContent = 'QC failed';
            } else if (status === 'ready') {
                fontQcStatus.textContent = '';
            } else {
                fontQcStatus.textContent = '';
            }

            if (qcExpanded) {
                renderQcList();
            }
        };

        const initialProfiles =
            window.fullCompileManager?.getAvailableProfiles?.() || ['opentype'];
        const initialProfile =
            window.fullCompileManager?.getProfile?.() || 'opentype';
        syncProfileOptions(initialProfiles, initialProfile);

        failCount.style.display = 'none';
        warnCount.style.display = 'none';
        infoCount.style.display = 'none';

        fontQcProfileSelect.addEventListener('click', (event) => {
            event.stopPropagation();
        });

        fontQcProfileSelect.addEventListener('mousedown', (event) => {
            event.stopPropagation();
        });

        fontQcProfileSelect.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });

        fontQcProfileRow.addEventListener('click', (event) => {
            event.stopPropagation();
        });

        fontQcProfileRow.addEventListener('mousedown', (event) => {
            event.stopPropagation();
        });

        fontQcProfileSelect.addEventListener('change', (event) => {
            event.stopPropagation();
            const selected = fontQcProfileSelect.value;
            window.fullCompileManager?.setProfile?.(selected);
        });

        fontQcSearchInput.addEventListener('click', (event) => {
            event.stopPropagation();
        });

        fontQcSearchInput.addEventListener('mousedown', (event) => {
            event.stopPropagation();
        });

        fontQcSearchInput.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });

        fontQcSearchInput.addEventListener('keydown', (event) => {
            event.stopPropagation();
        });

        fontQcSearchInput.addEventListener('input', () => {
            qcSearchQuery = fontQcSearchInput.value;
            if (!qcExpanded) {
                setQcExpanded(true);
                return;
            }
            renderQcList();
        });

        const toggleFilter = (level: 'fail' | 'warn' | 'info') => {
            if (!qcExpanded) {
                setQcExpanded(true);
                return;
            }

            qcFilters[level] = !qcFilters[level];
            failCount.classList.toggle('active', qcFilters.fail);
            warnCount.classList.toggle('active', qcFilters.warn);
            infoCount.classList.toggle('active', qcFilters.info);
            renderQcList();
        };

        failCount.addEventListener('click', (event) => {
            event.stopPropagation();
            toggleFilter('fail');
        });
        warnCount.addEventListener('click', (event) => {
            event.stopPropagation();
            toggleFilter('warn');
        });
        infoCount.addEventListener('click', (event) => {
            event.stopPropagation();
            toggleFilter('info');
        });

        fontQcCloseBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            setQcExpanded(false);
        });

        document.addEventListener(
            'keydown',
            (event: KeyboardEvent) => {
                if (qcExpanded && event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();
                    setQcExpanded(false);
                }
            },
            true
        );

        document.addEventListener(
            'keydown',
            (event: KeyboardEvent) => {
                const isCmdAltFShortcut =
                    (event.metaKey || event.ctrlKey) &&
                    event.altKey &&
                    event.code === 'KeyF';

                if (!isCmdAltFShortcut) {
                    return;
                }

                const editorView = document.querySelector('#view-editor');
                const isEditorFocused =
                    editorView?.classList.contains('focused');
                if (!isEditorFocused) {
                    return;
                }

                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();

                if (!qcExpanded) {
                    setQcExpanded(true);
                }

                window.requestAnimationFrame(() => {
                    fontQcSearchInput.focus();
                    fontQcSearchInput.select();
                });
            },
            true
        );

        const expandQcPanel = (event: Event) => {
            event.stopPropagation();
            if (!qcExpanded) {
                setQcExpanded(true);
            }
        };

        fontQcHeader.addEventListener('click', expandQcPanel);
        fontQcCounts.addEventListener('click', expandQcPanel);
        fontQcStatus.addEventListener('click', expandQcPanel);

        window.addEventListener('fontspectorUpdated', (event: Event) => {
            updateQcSummary((event as CustomEvent).detail);
        });

        window.addEventListener('glyphStackChanged', () => {
            renderQcList();
        });

        window.addEventListener('editorModeChanged', (event: Event) => {
            const mode = (event as CustomEvent).detail?.mode;
            if (mode === 'text') {
                clearActiveQcSelection();
            }

            renderQcList();
        });

        // Store reference to sidebars for later updates
        window.glyphCanvas.leftSidebar = leftSidebar;
        window.glyphCanvas.propertiesSection = propertiesSection;
        window.glyphCanvas.rightSidebar = rightSidebar;
        window.glyphCanvas.axesSection = axesSection;

        // Observe when the editor view gains/loses focus (via 'focused' class)
        // CSS handles sidebar background color changes based on .view.focused
        const editorView = document.querySelector('#view-editor');
        if (editorView) {
            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (
                        mutation.type === 'attributes' &&
                        mutation.attributeName === 'class'
                    ) {
                        // Render when focused class changes
                        window.glyphCanvas.render();
                    }
                });
            });
            observer.observe(editorView, {
                attributes: true,
                attributeFilter: ['class']
            });
        }

        // Listen for font compilation events
        setupFontLoadingListener();

        // Set up editor shortcuts modal
        setupEditorShortcutsModal();

        console.log('Glyph canvas initialized');
    } else {
        setTimeout(initCanvas, 100);
    }
}

if (typeof document !== 'undefined' && document.addEventListener) {
    // Initialize when document is ready
    document.addEventListener('DOMContentLoaded', () => {
        // Wait for the editor view to be ready
        initCanvas();
    });
}

window.addEventListener(
    'fontOpenLifecycle',
    syncLatestOpenSessionIdFromLifecycle
);
window.addEventListener('fontReady', syncLatestOpenSessionId);

// Event handlers stored to prevent duplicate listeners
let editingFontCompiledHandler: ((e: Event) => void) | null = null;
let fontCompiledHandler: ((e: Event) => void) | null = null;
let editingFontApplyQueue: Promise<void> = Promise.resolve();
let latestAppliedEditingRevision: number = -1;

// Set up listener for compiled fonts
function setupFontLoadingListener() {
    console.log('🔧 Setting up font loading listeners...');

    // Remove any existing listeners to prevent duplicates
    if (editingFontCompiledHandler) {
        window.removeEventListener(
            'editingFontCompiled',
            editingFontCompiledHandler
        );
    }
    if (fontCompiledHandler) {
        window.removeEventListener('fontCompiled', fontCompiledHandler);
    }

    // Listen for editing font compiled by font manager (primary)
    editingFontCompiledHandler = async (e: Event) => {
        const detail = (e as CustomEvent).detail;
        timelineMark('canvas.editingFontCompiled.received');
        editingFontApplyQueue = editingFontApplyQueue
            .then(async () => {
                const currentFontPath = window.fontManager?.currentFont?.path;
                if (
                    typeof detail?.fontPath === 'string' &&
                    typeof currentFontPath === 'string' &&
                    detail.fontPath !== currentFontPath
                ) {
                    timelineMark(
                        'canvas.editingFontCompiled.skippedMismatchedFontPath'
                    );
                    return;
                }

                const incomingRevision = Number(detail?.fontRevisionKey);
                const latestRequestedRevision = Number(
                    window.fontManager?.currentFont?.compileRequestVersion
                );
                if (
                    Number.isFinite(incomingRevision) &&
                    Number.isFinite(latestRequestedRevision) &&
                    incomingRevision < latestRequestedRevision
                ) {
                    timelineMark(
                        'canvas.editingFontCompiled.skippedSupersededRevision'
                    );
                    return;
                }

                if (
                    Number.isFinite(incomingRevision) &&
                    incomingRevision < latestAppliedEditingRevision
                ) {
                    timelineMark(
                        'canvas.editingFontCompiled.skippedOutOfOrderRevision'
                    );
                    return;
                }

                console.log(
                    '[GlyphCanvas]',
                    'Editing font compiled event received'
                );
                console.log('[GlyphCanvas]', '   Event detail:', detail);
                console.log(
                    '[GlyphCanvas]',
                    '   Canvas exists:',
                    !!window.glyphCanvas
                );
                if (window.glyphCanvas && detail && detail.fontBytes) {
                    console.log(
                        '[GlyphCanvas]',
                        '   Loading editing font into canvas...'
                    );
                    const isDragActive = !!detail.dragActive;
                    const compilationMode = detail.compilationMode || 'full';
                    const arrayBuffer = detail.fontBytes.buffer.slice(
                        detail.fontBytes.byteOffset,
                        detail.fontBytes.byteOffset +
                            detail.fontBytes.byteLength
                    );

                    const gc = window.glyphCanvas;

                    // Fast path: outline-only compilation — swap blob, skip reshape
                    if (compilationMode === 'outline-only') {
                        const fontBytesArray = new Uint8Array(arrayBuffer);
                        gc.fontBytes = fontBytesArray;
                        gc.axesManager!.fontBytes = fontBytesArray;
                        gc.textRunEditor!.swapFontBlob(fontBytesArray);
                        timelineMark(
                            'canvas.editingFontCompiled.outlineOnlySwapped'
                        );

                        if (Number.isFinite(incomingRevision)) {
                            latestAppliedEditingRevision = incomingRevision;
                        }

                        gc.requestRepaintAfterCompile();
                        return;
                    }

                    // Anchor-only compilation — swap blob + reshape for GPOS mark positions
                    if (compilationMode === 'anchor-only') {
                        const fontBytesArray = new Uint8Array(arrayBuffer);
                        gc.fontBytes = fontBytesArray;
                        gc.axesManager!.fontBytes = fontBytesArray;
                        gc.textRunEditor!.swapFontBlob(fontBytesArray);
                        gc.textRunEditor!.shapeText(true);
                        timelineMark(
                            'canvas.editingFontCompiled.anchorOnlySwapped'
                        );

                        if (Number.isFinite(incomingRevision)) {
                            latestAppliedEditingRevision = incomingRevision;
                        }

                        gc.requestRepaintAfterCompile();
                        return;
                    }

                    if (compilationMode === 'kerning-only') {
                        const fontBytesArray = new Uint8Array(arrayBuffer);
                        gc.textRunEditor!.setShapingFontBlob(fontBytesArray);
                        gc.textRunEditor!.shapeText(true);
                        timelineMark(
                            'canvas.editingFontCompiled.kerningOnlyShaped'
                        );

                        if (Number.isFinite(incomingRevision)) {
                            latestAppliedEditingRevision = incomingRevision;
                        }

                        gc.requestRepaintAfterCompile();
                        return;
                    }

                    // Full compilation path — existing behavior
                    if (gc.featuresManager) {
                        gc.featuresManager.editingFontBytes = detail.fontBytes;
                        if (!isDragActive) {
                            const featuresUiSpanId = timelineSpanStart(
                                'canvas.editingFontCompiled.updateFeaturesUI'
                            );
                            await gc.featuresManager.updateFeaturesUI();
                            timelineSpanEnd(featuresUiSpanId);
                        }
                    }

                    const hasPendingAnchor =
                        gc.pendingFeatureChangeAnchor.editing ||
                        gc.pendingFeatureChangeAnchor.text;

                    const setFontSpanId = timelineSpanStart(
                        'canvas.editingFontCompiled.setFont'
                    );
                    await window.glyphCanvas.setFont(arrayBuffer, {
                        skipInitialShapeRender: true,
                        skipPropertiesUIUpdate: isDragActive
                    });
                    timelineSpanEnd(setFontSpanId);
                    timelineMark('canvas.editingFontCompiled.fontApplied');
                    console.log(
                        '[GlyphCanvas]',
                        '   ✅ Editing font loaded and text shaped'
                    );

                    if (gc.textRunEditor) {
                        gc.textRunEditor.skipRenderingDuringFeatureChange = false;
                    }

                    if (gc.pendingFeatureChangeAnchor.editing) {
                        console.log(
                            '[GlyphCanvas]',
                            '   Applying pending editing mode anchor after font reload'
                        );
                        gc.outlineEditor.autoPanAnchorScreen =
                            gc.pendingFeatureChangeAnchor.editing;
                        gc.outlineEditor.applyAutoPanAdjustment();
                        gc.outlineEditor.autoPanAnchorScreen = null;
                        gc.pendingFeatureChangeAnchor.editing = null;
                    } else if (gc.pendingFeatureChangeAnchor.text) {
                        console.log(
                            '[GlyphCanvas]',
                            '   Applying pending text mode anchor after font reload'
                        );
                        gc.textModeAutoPanAnchorScreen =
                            gc.pendingFeatureChangeAnchor.text;
                        gc.applyTextModeAutoPanAdjustment();
                        gc.textModeAutoPanAnchorScreen = null;
                        gc.pendingFeatureChangeAnchor.text = null;
                    }

                    if (hasPendingAnchor) {
                        timelineMark(
                            'canvas.editingFontCompiled.pendingAnchorApplied'
                        );
                    }

                    const forceShapeTextSpanId = timelineSpanStart(
                        'canvas.editingFontCompiled.forceShapeText'
                    );
                    gc.textRunEditor!.shapeText(true);
                    timelineSpanEnd(forceShapeTextSpanId);

                    timelineMark('canvas.editingFontCompiled.shapeTextForced');

                    if (Number.isFinite(incomingRevision)) {
                        latestAppliedEditingRevision = incomingRevision;
                    }

                    gc.requestRepaintAfterCompile();
                } else {
                    console.warn(
                        '[GlyphCanvas]',
                        '   ⚠️ Cannot load font - missing canvas or fontBytes'
                    );
                    timelineMark(
                        'canvas.editingFontCompiled.skippedMissingData'
                    );
                }
            })
            .catch((error) => {
                console.error(
                    '[GlyphCanvas] Failed to apply editing font update:',
                    error
                );
                timelineMark('canvas.editingFontCompiled.applyFailed');
            });
    };

    // Legacy: Custom event when font is compiled via compile button
    fontCompiledHandler = async (e: Event) => {
        const detail = (e as CustomEvent).detail;
        console.log('[GlyphCanvas]', 'Font compiled event received (legacy)');
        timelineMark('canvas.fontCompiledLegacy.received');
        if (window.glyphCanvas && detail && detail.ttfBytes) {
            const arrayBuffer = detail.ttfBytes.buffer.slice(
                detail.ttfBytes.byteOffset,
                detail.ttfBytes.byteOffset + detail.ttfBytes.byteLength
            );
            await window.glyphCanvas.setFont(arrayBuffer);
            window.glyphCanvas.requestRepaintAfterCompile();
            timelineMark('canvas.fontCompiledLegacy.fontApplied');
        } else {
            timelineMark('canvas.fontCompiledLegacy.skippedMissingData');
        }
    };

    window.addEventListener('editingFontCompiled', editingFontCompiledHandler);
    window.addEventListener('fontCompiled', fontCompiledHandler);
}

// Set up editor keyboard shortcuts info modal
function setupEditorShortcutsModal() {
    const infoButton = document.getElementById('editor-info-btn');
    const modal = document.getElementById('editor-shortcuts-modal');
    const closeBtn = document.getElementById(
        'editor-shortcuts-modal-close-btn'
    );

    if (!infoButton || !modal || !closeBtn) return;

    // Open modal
    infoButton.addEventListener('click', (event: Event) => {
        event.stopPropagation();
        modal.style.display = 'flex';
    });

    // Close modal
    const closeModal = () => {
        modal.style.display = 'none';
        // Restore focus to canvas if editor view was active
        const editorView = document.getElementById('view-editor');
        if (
            editorView &&
            editorView.classList.contains('focused') &&
            window.glyphCanvas &&
            window.glyphCanvas.canvas
        ) {
            setTimeout(() => window.glyphCanvas.canvas!.focus(), 0);
        }
    };

    closeBtn.addEventListener('click', closeModal);

    // Close on backdrop click
    modal.addEventListener('click', (e: Event) => {
        if (e.target === modal) {
            closeModal();
        }
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.style.display === 'flex') {
            e.preventDefault();
            e.stopPropagation();
            closeModal();
        }
    });
}

export { GlyphCanvas };
