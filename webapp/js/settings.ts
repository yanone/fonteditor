// Global application settings
// This file contains configuration values used across the application

const APP_SETTINGS = {
    // App internal ID
    APP_ID: 'org.context.fonteditor',

    // Compilation settings
    COMPILE_DEBOUNCE_DELAY: 150, // ms - delay before auto-compile triggers after changes

    // Axis animation settings
    AXIS_ANIMATION_WAVELENGTH: 5000, // ms - wavelength of sine wave for axis animation

    // Font Manager settings
    FONT_MANAGER: {
        SAVE_DEBUG_FONTS: true // Set to true to save typing/editing fonts to file system for inspection
    },

    // In-browser live diagnostic checks
    IN_BROWSER_LIVE_TESTS: {
        ENABLE_WORKER_DRIFT_CHECKS: true // Runtime drift sentinels for live debugging of drag/keyboard worker state
    },

    // Text display settings
    TEXT_DISPLAY: {
        LOAD_FROM_FONT: true // Set to true to load display string from font.format_specific on font open
    },

    // Outline editor display settings
    OUTLINE_EDITOR: {
        // Zoom thresholds
        MIN_ZOOM_FOR_HANDLES: 0.2, // 20% - below this, don't draw nodes/anchors/component markers
        MIN_ZOOM_FOR_ANCHOR_LABELS: 0.7, // 50% - below this, don't draw anchor names
        MIN_ZOOM_FOR_GRID_FADE_START: 5.0, // grid starts fading in at this zoom
        MIN_ZOOM_FOR_GRID: 9.0, // grid is fully visible at this zoom

        // Node (point) sizes
        NODE_SIZE_AT_MIN_ZOOM: 2, // px - node size at min zoom
        NODE_SIZE_AT_MAX_ZOOM: 7, // px - node size at max zoom
        NODE_SIZE_INTERPOLATION_MIN: 0.2, // zoom level where min size starts
        NODE_SIZE_INTERPOLATION_MAX: 3.0, // zoom level where max size is reached

        // Anchor sizes
        ANCHOR_SIZE_AT_MIN_ZOOM: 3, // px - anchor size at min zoom
        ANCHOR_SIZE_AT_MAX_ZOOM: 8, // px - anchor size at max zoom
        ANCHOR_SIZE_INTERPOLATION_MIN: 0.2, // zoom level where min size starts
        ANCHOR_SIZE_INTERPOLATION_MAX: 3.0, // zoom level where max size is reached

        // Component marker size
        COMPONENT_MARKER_SIZE: 10, // px - size of component origin marker
        SHOW_COMPONENT_ORIGIN_MARKERS: false, // whether to draw component origin markers

        // Stroke widths
        OUTLINE_STROKE_WIDTH: 1, // px - width of glyph outline paths
        OUTLINE_OPACITY: 0.4, // opacity of glyph outline paths in editing mode
        HANDLE_LINE_OPACITY: 0.3, // opacity of off-curve point handle lines in editing mode

        // Hit detection
        HIT_TOLERANCE: 15, // px - hit detection tolerance for glyphs and components (screen pixels)
        // Node/anchor pick radii track visual size + padding, with a floor for low zoom.
        NODE_HIT_PADDING: 2, // px added to visual node radius for hover/click picking
        ANCHOR_HIT_PADDING: 2, // px added to visual anchor radius for hover/click picking
        POINT_HIT_RADIUS_MIN: 5, // px - minimum node/anchor pick radius (screen pixels)
        // Prefer on-curve nodes when an off-curve handle is within this many screen px.
        ON_CURVE_HIT_PREFERENCE: 1.5,

        // Canvas margins
        CANVAS_MARGIN: 50, // px - margin around glyphs when framing or panning
        MAX_ZOOM_FOR_CMD_ZERO: 1.5, // maximum zoom level (150%) when framing glyph with Cmd+0

        // Zoom settings
        ZOOM_SPEED_MOUSE: 0.015, // zoom speed for mouse wheel (per deltaY unit)
        ZOOM_SPEED_TRACKPAD: 0.005, // zoom speed for trackpad scroll (per deltaY unit)
        ZOOM_SPEED_PINCH: 0.01, // zoom speed for trackpad pinch gesture (per deltaY unit)
        ZOOM_KEYBOARD_FACTOR: 1.5, // zoom factor for keyboard zoom (Cmd +/-)

        // Pan settings
        PAN_SPEED_TRACKPAD: 1.0, // trackpad pan speed (vertical and horizontal)
        PAN_SPEED_MOUSE_VERTICAL: 1.5, // mouse wheel vertical pan speed
        PAN_SPEED_MOUSE_HORIZONTAL: 1.5, // mouse wheel horizontal pan speed (Shift+scroll)

        // Debug/development
        INTERPOLATION_ANIMATION_DELAY: 0, // ms - delay between animation frames for debugging (0 = no delay)
        SHOW_BBOX_CENTER_CROSSHAIR: false, // Draw the active layer bounding-box center in development

        // Node snapping
        SNAP_DISTANCE_PX: 3, // Snapping distance in screen pixels

        // Measurement tool
        MEASUREMENT_TOOL_DISPLAY_DELAY: 0, // ms - measurement tool appears immediately when Tab is pressed
        MEASUREMENT_TOOL_GUIDE_LINES_OPACITY: 0.4, // opacity for horizontal/vertical guide lines when dragging measurement line

        // Preview mode
        PREVIEW_MODE_DELAY: 200, // ms - delay before activating preview mode with Space bar in text mode (below this delay, types a space character)

        // Keyboard preview commits
        KEYBOARD_PREVIEW_COMMIT_DEBOUNCE: 1000, // ms - idle delay before previewed keyboard edits commit to Yjs/history

        // Colors - Light Theme
        COLORS_LIGHT: {
            // Grid
            GRID: 'rgba(0, 0, 0, 0.075)',

            // Glyphs in text/preview mode
            GLYPH_NORMAL: '#000000',
            GLYPH_HOVERED: '#888888',
            GLYPH_SELECTED: '#090a09',
            GLYPH_NOTDEF: 'rgba(0, 0, 0, 0.15)', // .notdef during font compilation

            // Glyphs when outline editor is active
            GLYPH_ACTIVE_IN_EDITOR: '#000000', // The glyph being edited
            GLYPH_INACTIVE_IN_EDITOR: 'rgba(0, 0, 0, 0.2)', // Other glyphs (dimmed)
            GLYPH_HOVERED_IN_EDITOR: 'rgba(0, 0, 0, 0.4)', // Hovered inactive glyph (darker)
            GLYPH_BACKGROUND_IN_EDITOR: 'rgba(0, 0, 0, 0.05)', // HB-rendered background of active glyph

            // Nodes (on-curve points)
            NODE_NORMAL: '#00d500',
            NODE_HOVERED: '#ff8800',
            NODE_SELECTED: '#ff0000',
            NODE_STROKE: '#000000',

            // Off-curve control points
            CONTROL_POINT_NORMAL: '#00aaff',
            CONTROL_POINT_HOVERED: '#ff8800',
            CONTROL_POINT_SELECTED: '#ff0000',
            CONTROL_POINT_STROKE: '#000000',

            // Anchors
            ANCHOR_NORMAL: '#8800ff',
            ANCHOR_HOVERED: '#ff88ff',
            ANCHOR_SELECTED: '#ff00ff',
            ANCHOR_STROKE: '#000000',

            // Components
            COMPONENT_FILL_NORMAL: '#75b5c6cc',
            COMPONENT_FILL_HOVERED: '#75b5c6aa',
            COMPONENT_FILL_SELECTED: '#2f8ceaff',
            COMPONENT_FILL_AUTO_NORMAL: '#8f8f8fcc',
            COMPONENT_FILL_AUTO_HOVERED: '#a3a3a3cc',
            COMPONENT_FILL_AUTO_SELECTED: '#7a7a7aff',

            // Measurement tool
            MEASUREMENT_TOOL_LINE: '#000000',
            MEASUREMENT_TOOL_DOT: '#000000',
            MEASUREMENT_TOOL_LABEL_TEXT: '#ffffff',
            MEASUREMENT_TOOL_LABEL_BG: 'rgba(0, 0, 0, 0.85)',
            MEASUREMENT_TOOL_CROSSHAIR: '#000000',

            // Node snapping
            SNAP_DEBUG_NODE: 'rgba(0, 120, 200, 0.5)', // Snap candidate node marker color
            SNAP_HIGHLIGHT_NODE: '#ff7700', // Active snap target node marker
            SNAP_HIGHLIGHT_LINE: '#ff7700', // Line from dragged node to snap target

            // Hover labels (glyph tooltips and component labels)
            HOVER_LABEL_BG: '#c7c7c7',
            HOVER_LABEL_BORDER: 'rgba(255, 255, 255, 0.5)',
            HOVER_LABEL_TEXT: '#000000'
        },

        // Colors - Glyph Overview (Light Theme)
        GLYPH_OVERVIEW_COLORS_LIGHT: {
            COMPONENT: '#4f8ea0',
            PATH: '#808080'
        },

        // Colors - Glyph Overview (Dark Theme)
        GLYPH_OVERVIEW_COLORS_DARK: {
            COMPONENT: '#93cfde',
            PATH: '#9a9a9a'
        },

        // Colors - Dark Theme
        COLORS_DARK: {
            // Grid
            GRID: 'rgba(255, 255, 255, 0.075)',

            // Glyphs in text/preview mode
            GLYPH_NORMAL: '#ffffff',
            GLYPH_HOVERED: '#777777',
            GLYPH_SELECTED: '#00ff00',
            GLYPH_NOTDEF: 'rgba(255, 255, 255, 0.15)', // .notdef during font compilation

            // Glyphs when outline editor is active
            GLYPH_ACTIVE_IN_EDITOR: '#ffffff', // The glyph being edited
            GLYPH_INACTIVE_IN_EDITOR: 'rgba(255, 255, 255, 0.2)', // Other glyphs (dimmed)
            GLYPH_HOVERED_IN_EDITOR: 'rgba(255, 255, 255, 0.4)', // Hovered inactive glyph (darker)
            GLYPH_BACKGROUND_IN_EDITOR: 'rgba(255, 255, 255, 0.05)', // HB-rendered background of active glyph

            // Nodes (on-curve points)
            NODE_NORMAL: '#00ff00',
            NODE_HOVERED: '#ff8800',
            NODE_SELECTED: '#ff0000',
            NODE_STROKE: '#ffffff',

            // Off-curve control points
            CONTROL_POINT_NORMAL: '#00aaff',
            CONTROL_POINT_HOVERED: '#ff8800',
            CONTROL_POINT_SELECTED: '#ff0000',
            CONTROL_POINT_STROKE: '#ffffff',

            // Anchors
            ANCHOR_NORMAL: '#8800ff',
            ANCHOR_HOVERED: '#ff88ff',
            ANCHOR_SELECTED: '#ff00ff',
            ANCHOR_STROKE: '#ffffff',

            // Components
            COMPONENT_FILL_NORMAL: '#75b5c6cc',
            COMPONENT_FILL_HOVERED: '#75b5c6aa',
            COMPONENT_FILL_SELECTED: '#2f8ceaff',
            COMPONENT_FILL_AUTO_NORMAL: '#8f8f8fcc',
            COMPONENT_FILL_AUTO_HOVERED: '#a3a3a3cc',
            COMPONENT_FILL_AUTO_SELECTED: '#7a7a7aff',

            // Measurement tool
            MEASUREMENT_TOOL_LINE: '#ffffff',
            MEASUREMENT_TOOL_DOT: '#ffffff',
            MEASUREMENT_TOOL_LABEL_TEXT: '#000000',
            MEASUREMENT_TOOL_LABEL_BG: 'rgba(255, 255, 255, 0.85)',
            MEASUREMENT_TOOL_CROSSHAIR: '#ffffff',

            // Node snapping
            SNAP_DEBUG_NODE: 'rgba(80, 180, 255, 0.5)', // Snap candidate node marker color
            SNAP_HIGHLIGHT_NODE: '#ff9900', // Active snap target node marker
            SNAP_HIGHLIGHT_LINE: '#ff9900', // Line from dragged node to snap target

            // Hover labels (glyph tooltips and component labels)
            HOVER_LABEL_BG: '#444444',
            HOVER_LABEL_BORDER: 'rgba(0, 0, 0, 0.5)',
            HOVER_LABEL_TEXT: '#ffffff'
        }
    }

    // Add other settings here as needed
};

// Production overrides
// These settings override the defaults when running in production mode
const PRODUCTION_OVERRIDES = {
    OUTLINE_EDITOR: {
        SHOW_COMPONENT_ORIGIN_MARKERS: false, // Hide component origin markers in production
        SHOW_BBOX_CENTER_CROSSHAIR: false // Hide the development bbox-center marker in production
    },
    FONT_MANAGER: {
        SAVE_DEBUG_FONTS: false // Disable debug font generation in production
    },
    IN_BROWSER_LIVE_TESTS: {
        ENABLE_WORKER_DRIFT_CHECKS: false // Disable live runtime drift sentinels in production
    }
};

type SettingsGlobalScope = typeof globalThis & {
    APP_SETTINGS?: typeof APP_SETTINGS;
    isDevelopment?: () => boolean;
    isProduction?: () => boolean;
};

const settingsGlobalScope = globalThis as SettingsGlobalScope;

// Use the global isDevelopment function from index.html (defined before this script loads)
// Export wrapper for convenience in modules
export const isProduction = () => {
    const isDevelopmentHook = settingsGlobalScope.isDevelopment;
    return typeof isDevelopmentHook === 'function'
        ? !isDevelopmentHook()
        : false;
};

// Apply production overrides if in production mode
if (isProduction()) {
    console.log('[Settings] Running in production mode - applying overrides');

    // Deep merge production overrides into APP_SETTINGS
    if (PRODUCTION_OVERRIDES.OUTLINE_EDITOR) {
        Object.assign(
            APP_SETTINGS.OUTLINE_EDITOR,
            PRODUCTION_OVERRIDES.OUTLINE_EDITOR
        );
    }

    if (PRODUCTION_OVERRIDES.FONT_MANAGER) {
        Object.assign(
            APP_SETTINGS.FONT_MANAGER,
            PRODUCTION_OVERRIDES.FONT_MANAGER
        );
    }

    if (PRODUCTION_OVERRIDES.IN_BROWSER_LIVE_TESTS) {
        Object.assign(
            APP_SETTINGS.IN_BROWSER_LIVE_TESTS,
            PRODUCTION_OVERRIDES.IN_BROWSER_LIVE_TESTS
        );
    }
} else {
    console.log('[Settings] Running in development mode');
}

// Expose globally for runtime access
settingsGlobalScope.APP_SETTINGS = APP_SETTINGS;
settingsGlobalScope.isProduction = isProduction;

export default APP_SETTINGS;
