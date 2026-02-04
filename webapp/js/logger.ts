export class Logger {
    facility: string;

    constructor(facility: string) {
        this.facility = facility;
    }

    log(...args: any[]) {
        console.log(`[${this.facility}]`, ...args);
    }
    info(...args: any[]) {
        console.info(`[${this.facility}]`, ...args);
    }
    debug(...args: any[]) {
        console.debug(`[${this.facility}]`, ...args);
    }
    warn(...args: any[]) {
        console.warn(`[${this.facility}]`, ...args);
    }
    error(...args: any[]) {
        console.error(`[${this.facility}]`, ...args);
    }
}

// Expose Logger on window for JavaScript files
declare global {
    interface Window {
        Logger: typeof Logger;
    }
}
window.Logger = Logger;
