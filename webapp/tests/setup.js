const hasWindow = typeof window !== 'undefined';

if (typeof CanvasRenderingContext2D !== 'undefined') {
    const proto = CanvasRenderingContext2D.prototype;
    if (typeof proto.roundRect !== 'function') {
        proto.roundRect = function roundRect(x, y, width, height) {
            this.rect(x, y, width, height);
            return this;
        };
    }
}

// Mock BroadcastChannel (not available in jsdom)
if (typeof globalThis.BroadcastChannel === 'undefined') {
    const channels = new Map(); // channelName → Set<BroadcastChannel>
    globalThis.BroadcastChannel = class BroadcastChannel {
        constructor(name) {
            this.name = name;
            this.onmessage = null;
            this._closed = false;
            if (!channels.has(name)) channels.set(name, new Set());
            channels.get(name).add(this);
        }
        postMessage(data) {
            if (this._closed) return;
            const peers = channels.get(this.name);
            if (!peers) return;
            for (const peer of peers) {
                if (peer !== this && !peer._closed && peer.onmessage) {
                    // Simulate async delivery
                    const msg = { data };
                    setTimeout(() => peer.onmessage(msg), 0);
                }
            }
        }
        close() {
            this._closed = true;
            const peers = channels.get(this.name);
            if (peers) peers.delete(this);
        }
    };
    // Expose for tests that need to inspect/reset
    globalThis.__broadcastChannels = channels;
}

if (hasWindow) {
    if (!Object.getOwnPropertyDescriptor(window, 'changeBridge')?.get) {
        Object.defineProperty(window, 'changeBridge', {
            configurable: true,
            enumerable: false,
            get() {
                return window.patchSyncEngine;
            },
            set(value) {
                window.patchSyncEngine = value;
            }
        });
    }

    // Mock isDevelopment/isProduction functions (from index.html)
    // These must be defined BEFORE importing any modules that use them
    if (typeof window.isDevelopment === 'undefined') {
        window.isDevelopment = () => true;
    }
    if (typeof window.isProduction === 'undefined') {
        window.isProduction = () => !window.isDevelopment();
    }

    global.GlyphCanvas = require('../js/glyph-canvas').GlyphCanvas;
    global.ViewportManager =
        require('../js/glyph-canvas/viewport').ViewportManager;

    // Mock browser-specific APIs that are not available in JSDOM by default
    if (typeof window.requestAnimationFrame === 'undefined') {
        window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
    }
    if (typeof window.ResizeObserver === 'undefined') {
        window.ResizeObserver = class ResizeObserver {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
    }
}

const originalConsoleWarn = console.warn.bind(console);
const suppressedWarningSubstrings = [
    'No layer selected - cannot save',
    'No current font to update cache',
    'Cannot mark font dirty - no currentFont'
];

console.warn = (...args) => {
    const warningText = args
        .map((arg) => (typeof arg === 'string' ? arg : String(arg)))
        .join(' ');

    if (
        suppressedWarningSubstrings.some((substring) =>
            warningText.includes(substring)
        )
    ) {
        return;
    }

    originalConsoleWarn(...args);
};

// Mock for HarfBuzz
if (typeof createHarfBuzz === 'undefined') {
    global.createHarfBuzz = async () => ({});
    global.hbjs = () => ({
        createBlob: () => ({ destroy: () => {} }),
        createFace: () => ({ destroy: () => {} }),
        createFont: () => ({
            setVariations: () => {},
            glyphToPath: () => 'M0 0 L1 1',
            destroy: () => {}
        }),
        createBuffer: () => ({
            addText: () => {},
            guessSegmentProperties: () => {},
            setDirection: () => {},
            json: () => [],
            destroy: () => {}
        }),
        shape: () => {}
    });
}

// Mock for python interface
if (hasWindow && typeof window.pyodide === 'undefined') {
    window.pyodide = {
        runPythonAsync: async (_code) => {
            return '{}';
        }
    };
}
if (hasWindow && typeof window.fontManager === 'undefined') {
    window.fontManager = {
        getGlyphName: () => 'mockGlyphName',
        setFormatSpecific: () => {}
    };
}
// Also set on global in case window.fontManager is redefined
global.fontManager = {
    getGlyphName: () => 'mockGlyphName',
    setFormatSpecific: () => {}
};
if (typeof APP_SETTINGS === 'undefined') {
    global.APP_SETTINGS = {
        OUTLINE_EDITOR: {
            COLORS_DARK: {
                GRID: 'rgba(255, 255, 255, 0.075)',
                GLYPH_NORMAL: '#ffffff',
                GLYPH_HOVERED: '#ff00ff',
                GLYPH_SELECTED: '#00ff00',
                GLYPH_ACTIVE_IN_EDITOR: '#ffffff',
                GLYPH_INACTIVE_IN_EDITOR: 'rgba(255, 255, 255, 0.2)',
                GLYPH_HOVERED_IN_EDITOR: 'rgba(255, 255, 255, 0.4)',
                GLYPH_BACKGROUND_IN_EDITOR: 'rgba(255, 255, 255, 0.05)',
                NODE_NORMAL: '#00ff00',
                NODE_HOVERED: '#ff8800',
                NODE_SELECTED: '#ff0000',
                NODE_STROKE: '#ffffff',
                CONTROL_POINT_NORMAL: '#00aaff',
                CONTROL_POINT_HOVERED: '#ff8800',
                CONTROL_POINT_SELECTED: '#ff0000',
                CONTROL_POINT_STROKE: '#ffffff',
                ANCHOR_NORMAL: '#8800ff',
                ANCHOR_HOVERED: '#ff88ff',
                ANCHOR_SELECTED: '#ff00ff',
                ANCHOR_STROKE: '#ffffff',
                COMPONENT_FILL_NORMAL: 'rgba(0, 255, 255, 0.15)',
                COMPONENT_FILL_HOVERED: 'rgba(255, 136, 255, 0.2)',
                COMPONENT_FILL_SELECTED: 'rgba(255, 0, 255, 0.3)'
            },
            GLYPH_OVERVIEW_COLORS_DARK: {
                COMPONENT: '#75b5c6',
                PATH: '#777777'
            },
            GLYPH_OVERVIEW_COLORS_LIGHT: {
                COMPONENT: '#75b5c6',
                PATH: '#aaaaaa'
            },
            COLORS_LIGHT: {
                GRID: 'rgba(0, 0, 0, 0.075)',
                GLYPH_NORMAL: '#000000',
                GLYPH_HOVERED: '#ff00ff',
                GLYPH_SELECTED: '#00ff00',
                GLYPH_ACTIVE_IN_EDITOR: '#000000',
                GLYPH_INACTIVE_IN_EDITOR: 'rgba(0, 0, 0, 0.2)',
                GLYPH_HOVERED_IN_EDITOR: 'rgba(0, 0, 0, 0.4)',
                GLYPH_BACKGROUND_IN_EDITOR: 'rgba(0, 0, 0, 0.05)',
                NODE_NORMAL: '#00ff00',
                NODE_HOVERED: '#ff8800',
                NODE_SELECTED: '#ff0000',
                NODE_STROKE: '#000000',
                CONTROL_POINT_NORMAL: '#00aaff',
                CONTROL_POINT_HOVERED: '#ff8800',
                CONTROL_POINT_SELECTED: '#ff0000',
                CONTROL_POINT_STROKE: '#000000',
                ANCHOR_NORMAL: '#8800ff',
                ANCHOR_HOVERED: '#ff88ff',
                ANCHOR_SELECTED: '#ff00ff',
                ANCHOR_STROKE: '#000000',
                COMPONENT_FILL_NORMAL: 'rgba(0, 153, 204, 0.15)',
                COMPONENT_FILL_HOVERED: 'rgba(204, 102, 204, 0.2)',
                COMPONENT_FILL_SELECTED: 'rgba(204, 0, 204, 0.25)'
            },
            MIN_ZOOM_FOR_GRID: 1,
            MIN_ZOOM_FOR_HANDLES: 0.04,
            MIN_ZOOM_FOR_ANCHOR_LABELS: 0.2,
            HANDLE_SIZE_INTERPOLATION_MAX: 1,
            NODE_SIZE_AT_MAX_ZOOM: 5,
            NODE_SIZE_AT_MIN_ZOOM: 1.5,
            ANCHOR_SIZE_AT_MAX_ZOOM: 5,
            ANCHOR_SIZE_AT_MIN_ZOOM: 2,
            COMPONENT_MARKER_SIZE: 5,
            OUTLINE_STROKE_WIDTH: 1
        }
    };
}

if (hasWindow) {
    window._jestSetupDone = true;
}
