describe('binary font export', () => {
    let awaitStableWorkerStateMock;
    let bootstrapWorkerCacheFromFontStateMock;
    let compileCachedMock;
    let resolvePicker;
    let createWritableMock;
    let showSaveFilePickerMock;
    let postMessageSpy;
    let currentFont;

    async function flushAsyncWork() {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    }

    beforeEach(() => {
        jest.resetModules();
        document.body.innerHTML =
            '<span id="file-dirty-indicator" class="file-dirty-indicator">●</span>';

        currentFont = {
            path: '/fonts/Example.babelfont',
            changeVersion: 7
        };
        awaitStableWorkerStateMock = jest.fn().mockResolvedValue(undefined);
        bootstrapWorkerCacheFromFontStateMock = jest
            .fn()
            .mockResolvedValue(undefined);
        compileCachedMock = jest.fn().mockResolvedValue({
            result: new Uint8Array([1, 2, 3]),
            filename: 'Example.ttf',
            time_taken: 12
        });
        createWritableMock = jest.fn().mockResolvedValue({
            write: jest.fn().mockResolvedValue(undefined),
            close: jest.fn().mockResolvedValue(undefined)
        });
        showSaveFilePickerMock = jest.fn().mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolvePicker = resolve;
                })
        );
        postMessageSpy = jest.spyOn(window, 'postMessage').mockImplementation();

        window.fontManager = {
            currentFont,
            workerCacheUpdatePromise: null,
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([4, 5, 6]))
        };
        window.showSaveFilePicker = showSaveFilePickerMock;

        jest.doMock('../js/font-compilation', () => ({
            awaitStableWorkerState: awaitStableWorkerStateMock,
            fontCompilation: {
                awaitWorkerDocumentSync: jest.fn(),
                hasWorkerCacheDocument: jest.fn()
            },
            fullFontCompilation: {
                bootstrapWorkerCacheFromFontState:
                    bootstrapWorkerCacheFromFontStateMock,
                compileCached: compileCachedMock
            }
        }));
        jest.doMock('../js/logger', () => ({
            Logger: class {
                log() {}
                warn() {}
                error() {}
            }
        }));
    });

    afterEach(() => {
        postMessageSpy.mockRestore();
        delete window.showSaveFilePicker;
        delete window.fontManager;
        jest.dontMock('../js/font-compilation');
        jest.dontMock('../js/logger');
    });

    function finishPicker() {
        resolvePicker({
            name: 'Example.ttf',
            createWritable: createWritableMock
        });
    }

    test('reuses the selected destination and publishes each exported binary', async () => {
        const { exportBinaryFont } = require('../js/binary-font-export.ts');

        const firstExport = exportBinaryFont();
        await flushAsyncWork();

        const dirtyIndicator = document.getElementById('file-dirty-indicator');
        expect(dirtyIndicator.classList.contains('visible')).toBe(true);
        expect(dirtyIndicator.classList.contains('exporting')).toBe(true);

        finishPicker();
        await firstExport;

        expect(dirtyIndicator.classList.contains('exporting')).toBe(false);
        expect(dirtyIndicator.classList.contains('visible')).toBe(false);

        const secondExport = exportBinaryFont();
        await flushAsyncWork();
        finishPicker();
        await secondExport;

        expect(showSaveFilePickerMock).toHaveBeenCalledTimes(1);
        expect(awaitStableWorkerStateMock).toHaveBeenCalledTimes(2);
        expect(bootstrapWorkerCacheFromFontStateMock).toHaveBeenCalledTimes(2);
        expect(compileCachedMock).toHaveBeenNthCalledWith(
            1,
            'user',
            'Example.ttf'
        );
        expect(createWritableMock).toHaveBeenCalledTimes(2);
        expect(postMessageSpy).toHaveBeenCalledTimes(2);
        expect(postMessageSpy).toHaveBeenLastCalledWith(
            expect.objectContaining({
                type: 'counterpunch:binary-font-exported',
                version: 1,
                bytes: expect.any(ArrayBuffer),
                metadata: expect.objectContaining({
                    byteLength: 3,
                    changeVersion: 7,
                    filename: 'Example.ttf'
                })
            }),
            window.location.origin,
            [expect.any(ArrayBuffer)]
        );
    });

    test('export as always chooses a new destination', async () => {
        const { exportBinaryFontAs } = require('../js/binary-font-export.ts');

        const firstExport = exportBinaryFontAs();
        await flushAsyncWork();
        finishPicker();
        await firstExport;

        const secondExport = exportBinaryFontAs();
        await flushAsyncWork();
        finishPicker();
        await secondExport;

        expect(showSaveFilePickerMock).toHaveBeenCalledTimes(2);
    });

    test('restores a hidden dirty dot after export feedback', async () => {
        const { exportBinaryFont } = require('../js/binary-font-export.ts');

        const exportPromise = exportBinaryFont();
        await flushAsyncWork();

        const dirtyIndicator = document.getElementById('file-dirty-indicator');
        expect(dirtyIndicator.classList.contains('visible')).toBe(true);
        expect(dirtyIndicator.classList.contains('exporting')).toBe(true);

        finishPicker();
        await exportPromise;

        expect(dirtyIndicator.classList.contains('visible')).toBe(false);
        expect(dirtyIndicator.classList.contains('exporting')).toBe(false);
    });

    test('returns a visible dirty dot to red after export feedback', async () => {
        const dirtyIndicator = document.getElementById('file-dirty-indicator');
        dirtyIndicator.classList.add('visible');

        const { exportBinaryFont } = require('../js/binary-font-export.ts');

        const exportPromise = exportBinaryFont();
        await flushAsyncWork();
        expect(dirtyIndicator.classList.contains('visible')).toBe(true);
        expect(dirtyIndicator.classList.contains('exporting')).toBe(true);

        finishPicker();
        await exportPromise;

        expect(dirtyIndicator.classList.contains('visible')).toBe(true);
        expect(dirtyIndicator.classList.contains('exporting')).toBe(false);
    });
});
