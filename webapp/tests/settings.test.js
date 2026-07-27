describe('settings bootstrap', () => {
    const originalWindow = global.window;
    const originalAppSettings = globalThis.APP_SETTINGS;
    const originalIsDevelopment = globalThis.isDevelopment;
    const originalIsProduction = globalThis.isProduction;

    afterEach(() => {
        jest.resetModules();

        if (typeof originalWindow === 'undefined') {
            delete global.window;
        } else {
            global.window = originalWindow;
        }

        if (typeof originalAppSettings === 'undefined') {
            delete globalThis.APP_SETTINGS;
        } else {
            globalThis.APP_SETTINGS = originalAppSettings;
        }

        if (typeof originalIsDevelopment === 'undefined') {
            delete globalThis.isDevelopment;
        } else {
            globalThis.isDevelopment = originalIsDevelopment;
        }

        if (typeof originalIsProduction === 'undefined') {
            delete globalThis.isProduction;
        } else {
            globalThis.isProduction = originalIsProduction;
        }
    });

    test('imports without window and defaults to non-production', () => {
        delete global.window;
        delete globalThis.APP_SETTINGS;
        delete globalThis.isProduction;
        delete globalThis.isDevelopment;

        let settingsModule;
        expect(() => {
            jest.isolateModules(() => {
                settingsModule = require('../js/settings');
            });
        }).not.toThrow();

        expect(settingsModule.isProduction()).toBe(false);
        expect(globalThis.APP_SETTINGS).toBe(settingsModule.default);
        expect(globalThis.isProduction).toBe(settingsModule.isProduction);
    });

    test('uses global isDevelopment hook without requiring window', () => {
        delete global.window;
        globalThis.isDevelopment = () => false;

        let settingsModule;
        jest.isolateModules(() => {
            settingsModule = require('../js/settings');
        });

        expect(settingsModule.isProduction()).toBe(true);
        expect(settingsModule.default.FONT_MANAGER.SAVE_DEBUG_FONTS).toBe(
            false
        );
        expect(
            settingsModule.default.IN_BROWSER_LIVE_TESTS
                .ENABLE_WORKER_DRIFT_CHECKS
        ).toBe(false);
        expect(
            settingsModule.default.OUTLINE_EDITOR.SHOW_COMPONENT_ORIGIN_MARKERS
        ).toBe(false);
        expect(
            settingsModule.default.OUTLINE_EDITOR.SHOW_BBOX_CENTER_CROSSHAIR
        ).toBe(false);
    });

    test('enables in-browser live drift checks by default outside production', () => {
        delete global.window;
        globalThis.isDevelopment = () => true;

        let settingsModule;
        jest.isolateModules(() => {
            settingsModule = require('../js/settings');
        });

        expect(
            settingsModule.default.IN_BROWSER_LIVE_TESTS
                .ENABLE_WORKER_DRIFT_CHECKS
        ).toBe(true);
    });
});
