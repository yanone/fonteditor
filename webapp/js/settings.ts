// Global application settings
// This file contains configuration values used across the application

// Shared by the glyph canvas and overview tiles. Edit these to retint
// auto vs manual components in both views.
// Manual resting: desaturated mix of dark gray (#8f8f8f) and orange (#ff9933).
// Auto resting: desaturated mix of dark gray and editing-view-border blue (#0066ff).
const COMPONENT_FILLS = {
    MANUAL_NORMAL: '#b6936fcc',
    MANUAL_HOVERED: '#c79461cc',
    MANUAL_SELECTED: '#ff9933ff',
    AUTO_NORMAL: '#5d81b6cc',
    AUTO_HOVERED: '#487ac7cc',
    AUTO_SELECTED: '#0066ffff'
};

const APP_SETTINGS = {
    // App internal ID
    APP_ID: 'org.context.fonteditor',

    // Compilation settings
    COMPILE_DEBOUNCE_DELAY: 150, // ms - delay before auto-compile triggers after changes

    // Shared idle delay before keyboard-previewed edits commit to Yjs/history.
    // Used by outline/anchor/sidebearing keyboard preview and text-mode kerning.
    KEYBOARD_PREVIEW_COMMIT_DEBOUNCE: 1000, // ms

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

    // Glyph overview tile bitmap + outline-JSON cache
    GLYPH_OVERVIEW: {
        // Cap cached tile backing stores (canvas pixels), not V8 heap.
        TILE_CACHE_MAX_BYTES: 500 * 1024 * 1024
    },

    // Outline editor display settings
    OUTLINE_EDITOR: {
        // Zoom thresholds
        MIN_ZOOM_FOR_HANDLES: 0.03, // 3% - below this, don't draw nodes/anchors/component markers; also size-interpolation min
        MIN_ZOOM_FOR_ANCHOR_LABELS: 0.7, // 70% - below this, don't draw anchor names
        MIN_ZOOM_FOR_GRID_FADE_START: 5.0, // grid starts fading in at this zoom
        MIN_ZOOM_FOR_GRID: 9.0, // grid is fully visible at this zoom
        HANDLE_SIZE_INTERPOLATION_MAX: 3.0, // zoom level where node/anchor max size is reached

        // Node (point) sizes (screen px; interpolated between MIN_ZOOM_FOR_HANDLES and HANDLE_SIZE_INTERPOLATION_MAX)
        NODE_SIZE_AT_MIN_ZOOM: 1.5,
        NODE_SIZE_AT_MAX_ZOOM: 7,

        // Anchor sizes (screen px; same zoom interpolation range as nodes)
        ANCHOR_SIZE_AT_MIN_ZOOM: 2,
        ANCHOR_SIZE_AT_MAX_ZOOM: 8,

        // Component marker size
        COMPONENT_MARKER_SIZE: 10, // px - size of component origin marker
        SHOW_COMPONENT_ORIGIN_MARKERS: false, // whether to draw component origin markers

        // Stroke widths
        OUTLINE_STROKE_WIDTH: 1, // px - width of glyph outline paths
        OUTLINE_OPACITY: 0.4, // opacity of glyph outline paths in editing mode
        HANDLE_LINE_OPACITY: 0.3, // opacity of off-curve point handle lines in editing mode
        // Canvas component strokes are derived from fill by darkening this much.
        // 100 would be black; keep below that so the hue still reads.
        COMPONENT_STROKE_DARKEN_PERCENT: 60,
        COMPONENT_FILLS,

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
        CMD_ZERO_FRAME_MARGIN: 100, // px - extra Cmd+0 glyph-frame padding
        MAX_ZOOM_FOR_CMD_ZERO: 2.5, // 250% cap when framing a glyph with Cmd+0
        CMD_ZERO_LINE_SCALE: 0.25, // 25% line-overview Cmd+0 stage
        CMD_ZERO_TEXT_FIT_MIN: 0.025, // 2.5% floor when fitting the whole run
        CMD_ZERO_TEXT_FIT_MAX: 0.15, // 15% cap when fitting the whole run
        MAX_ZOOM_FOR_TEXT_FIT: 1.5, // initial / default text-run zoom-to-fit cap

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
        SNAP_VISUALIZATION_OPACITY: 0.4, // Orange snap markers and guides when snapping is on

        // Measurement tool
        MEASUREMENT_TOOL_DISPLAY_DELAY: 0, // ms - measurement tool appears immediately when Tab is pressed
        MEASUREMENT_TOOL_GUIDE_LINES_OPACITY: 0.4, // opacity for horizontal/vertical guide lines when dragging measurement line

        // Preview mode
        PREVIEW_MODE_DELAY: 200, // ms - delay before activating preview mode with Space bar in text mode (below this delay, types a space character)

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

            // Components (aliases of COMPONENT_FILLS)
            COMPONENT_FILL_NORMAL: COMPONENT_FILLS.MANUAL_NORMAL,
            COMPONENT_FILL_HOVERED: COMPONENT_FILLS.MANUAL_HOVERED,
            COMPONENT_FILL_SELECTED: COMPONENT_FILLS.MANUAL_SELECTED,
            COMPONENT_FILL_AUTO_NORMAL: COMPONENT_FILLS.AUTO_NORMAL,
            COMPONENT_FILL_AUTO_HOVERED: COMPONENT_FILLS.AUTO_HOVERED,
            COMPONENT_FILL_AUTO_SELECTED: COMPONENT_FILLS.AUTO_SELECTED,

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
            PATH: '#808080'
        },

        // Colors - Glyph Overview (Dark Theme)
        GLYPH_OVERVIEW_COLORS_DARK: {
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

            // Components (aliases of COMPONENT_FILLS)
            COMPONENT_FILL_NORMAL: COMPONENT_FILLS.MANUAL_NORMAL,
            COMPONENT_FILL_HOVERED: COMPONENT_FILLS.MANUAL_HOVERED,
            COMPONENT_FILL_SELECTED: COMPONENT_FILLS.MANUAL_SELECTED,
            COMPONENT_FILL_AUTO_NORMAL: COMPONENT_FILLS.AUTO_NORMAL,
            COMPONENT_FILL_AUTO_HOVERED: COMPONENT_FILLS.AUTO_HOVERED,
            COMPONENT_FILL_AUTO_SELECTED: COMPONENT_FILLS.AUTO_SELECTED,

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
