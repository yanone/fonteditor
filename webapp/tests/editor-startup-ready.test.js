describe('editor startup readiness', () => {
    let waitForFontEditorReady;
    let markFontEditorReady;
    let markFontEditorReadyFailed;
    let __resetFontEditorReadyForTests;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.resetModules();

        class TestCustomEvent extends Event {
            constructor(type, params = {}) {
                super(type);
                this.detail = params.detail;
            }
        }

        const testWindow = new EventTarget();
        testWindow.setTimeout = setTimeout.bind(global);
        testWindow.clearTimeout = clearTimeout.bind(global);
        testWindow.dispatchEvent = testWindow.dispatchEvent.bind(testWindow);
        testWindow.addEventListener =
            testWindow.addEventListener.bind(testWindow);
        testWindow.removeEventListener =
            testWindow.removeEventListener.bind(testWindow);

        global.window = testWindow;
        global.CustomEvent = TestCustomEvent;

        ({
            waitForFontEditorReady,
            markFontEditorReady,
            markFontEditorReadyFailed,
            __resetFontEditorReadyForTests
        } = require('../js/editor-startup-ready.js'));

        __resetFontEditorReadyForTests();
    });

    afterEach(() => {
        __resetFontEditorReadyForTests();
        jest.useRealTimers();
        delete global.window;
        delete global.CustomEvent;
    });

    it('waits for full font editor readiness before resolving', async () => {
        let resolved = false;
        const readyPromise = waitForFontEditorReady().then(() => {
            resolved = true;
        });

        await Promise.resolve();
        expect(resolved).toBe(false);

        markFontEditorReady();
        await readyPromise;

        expect(resolved).toBe(true);
    });

    it('rejects when startup fails before readiness', async () => {
        const readyPromise = waitForFontEditorReady();

        markFontEditorReadyFailed(new Error('startup failed'));

        await expect(readyPromise).rejects.toThrow('startup failed');
    });

    it('remains pending beyond the former startup deadline', async () => {
        let resolved = false;
        const readyPromise = waitForFontEditorReady().then(() => {
            resolved = true;
        });

        jest.advanceTimersByTime(30000);
        await Promise.resolve();

        expect(resolved).toBe(false);

        markFontEditorReady();
        await readyPromise;
        expect(resolved).toBe(true);
    });
});
