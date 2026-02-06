/**
 * Logger with Facility Registry
 *
 * Allows selective enabling/disabling of log facilities.
 * Errors and warnings are always printed.
 * Normal logs (log, info, debug) are conditional on the registry.
 *
 * Usage:
 *   import { Logger, FACILITY_REGISTRY } from './logger';
 *   const console = new Logger('FacilityName');
 *   console.log('message');  // Conditional on registry
 *   console.warn('warning'); // Always printed
 *   console.error('error');  // Always printed
 *
 * To toggle facilities, edit FACILITY_REGISTRY directly in this file:
 *   FACILITY_REGISTRY.FacilityName = false;  // Disable normal logs
 *   FACILITY_REGISTRY.FacilityName = true;   // Enable normal logs
 */

// Static facility registry - edit this object directly to enable/disable facilities
// true = enabled (normal logs will print)
// false = disabled (only errors and warnings will print)
export const FACILITY_REGISTRY: Record<string, boolean> = {
    AutoCompileManager: true,
    BabelfontModel: false,
    Bootstrap: false,
    CanvasPluginManager: false,
    CriticalErrorHandler: false,
    Design: false,
    Features: false,
    FileBrowser: false,
    FileSystemAdapter: false,
    FilesystemPlugins: false,
    FontCompilation: true,
    FontInterpolation: false,
    FontManager: true,
    GlyphCanvas: true,
    GlyphOverview: false,
    GlyphOverviewFilters: false,
    GlyphTileRendererFast: false,
    LayerDataNormalizer: false,
    Locations: false,
    MeasurementTool: false,
    OpentypeFeatures: true,
    OutlineEditor: false,
    PythonPostExecution: false,
    Renderer: false,
    ScriptEditor: false,
    ShareButton: false,
    SidebarErrorDisplay: false,
    StackPreviewAnimator: false,
    StateRestore: false,
    StateSync: false,
    TextRun: true,
    TippyUtils: false,
    URLState: false,
    Variations: true,
    WasmInit: false
};

export class Logger {
    facility: string;

    constructor(facility: string) {
        this.facility = facility;
    }

    /**
     * Check if this facility is enabled for logging
     */
    private isEnabled(): boolean {
        // Check static registry first, default to enabled if not found
        return FACILITY_REGISTRY[this.facility] ?? true;
    }

    log(...args: any[]) {
        if (this.isEnabled()) {
            console.log(`[${this.facility}]`, ...args);
        }
    }

    info(...args: any[]) {
        if (this.isEnabled()) {
            console.info(`[${this.facility}]`, ...args);
        }
    }

    debug(...args: any[]) {
        if (this.isEnabled()) {
            console.debug(`[${this.facility}]`, ...args);
        }
    }

    warn(...args: any[]) {
        // Warnings are always printed
        console.warn(`[${this.facility}]`, ...args);
    }

    error(...args: any[]) {
        // Errors are always printed
        console.error(`[${this.facility}]`, ...args);
    }

    /**
     * Static method to enable a facility at runtime
     */
    static enable(facility: string): void {
        FACILITY_REGISTRY[facility] = true;
        console.log(`[Logger] Enabled facility: ${facility}`);
    }

    /**
     * Static method to disable a facility at runtime
     */
    static disable(facility: string): void {
        FACILITY_REGISTRY[facility] = false;
        console.log(`[Logger] Disabled facility: ${facility}`);
    }

    /**
     * Static method to check if a facility is enabled
     */
    static isEnabled(facility: string): boolean {
        return FACILITY_REGISTRY[facility] ?? true;
    }

    /**
     * Static method to get all facilities and their states
     */
    static getRegistry(): Record<string, boolean> {
        return { ...FACILITY_REGISTRY };
    }

    /**
     * Static method to disable all facilities except specific ones
     */
    static enableOnly(facilities: string[]): void {
        // Disable all facilities
        Object.keys(FACILITY_REGISTRY).forEach((facility) => {
            FACILITY_REGISTRY[facility] = false;
        });
        // Enable only the specified ones
        facilities.forEach((facility) => {
            FACILITY_REGISTRY[facility] = true;
        });
        console.log(`[Logger] Enabled only: ${facilities.join(', ')}`);
    }

    /**
     * Static method to reset all facilities to default (all enabled)
     */
    static reset(): void {
        Object.keys(FACILITY_REGISTRY).forEach((facility) => {
            FACILITY_REGISTRY[facility] = true;
        });
        console.log('[Logger] Reset all facilities to enabled');
    }
}

// Expose Logger and FACILITY_REGISTRY on window for debugging and runtime control
declare global {
    interface Window {
        Logger: typeof Logger;
        FACILITY_REGISTRY: Record<string, boolean>;
    }
}

if (typeof window !== 'undefined') {
    window.Logger = Logger;
    window.FACILITY_REGISTRY = FACILITY_REGISTRY;
}
