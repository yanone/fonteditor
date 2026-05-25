const { FontCompilation } = require('../js/font-compilation');

describe('FontCompilation worker document readiness', () => {
    function createReadyFontCompilation() {
        const fontCompilation = new FontCompilation({
            connectInterpolation: false
        });
        let postedMessage = null;
        fontCompilation.worker = {
            postMessage: jest.fn((message) => {
                postedMessage = message;
            })
        };
        fontCompilation.isInitialized = true;
        fontCompilation.workerCacheDocumentReady = true;

        return {
            fontCompilation,
            getPostedMessage: () => postedMessage
        };
    }

    test.each([
        {
            type: 'storeFontJson',
            payload: { babelfontJson: '{"glyphs":[]}', forceStore: true }
        },
        {
            type: 'seedYdoc',
            payload: { state: new Uint8Array([1, 2, 3]) }
        },
        {
            type: 'applyYjsUpdate',
            payload: { update: new Uint8Array([4, 5, 6]), changedGlyphs: [] }
        }
    ])(
        '$type closes the ready gate before worker response',
        async ({ type, payload }) => {
            const { fontCompilation, getPostedMessage } =
                createReadyFontCompilation();

            const messagePromise = fontCompilation.sendMessage({
                type,
                ...payload
            });

            expect(fontCompilation.worker.postMessage).toHaveBeenCalledTimes(1);
            expect(fontCompilation.workerCacheDocumentReady).toBe(false);

            fontCompilation.handleWorkerMessage({
                data: {
                    id: getPostedMessage().id,
                    type,
                    success: true
                }
            });

            await expect(messagePromise).resolves.toEqual(
                expect.objectContaining({ success: true })
            );
            expect(fontCompilation.workerCacheDocumentReady).toBe(true);
        }
    );

    test.each([
        {
            type: 'applyPreviewYjsUpdate',
            payload: { update: new Uint8Array([7, 8, 9]), changedGlyphs: [] }
        },
        {
            type: 'clearPreviewYjsState',
            payload: {}
        }
    ])(
        '$type does not close the authoritative ready gate',
        async ({ type, payload }) => {
            const { fontCompilation, getPostedMessage } =
                createReadyFontCompilation();

            const messagePromise = fontCompilation.sendMessage({
                type,
                ...payload
            });

            expect(fontCompilation.worker.postMessage).toHaveBeenCalledTimes(1);
            expect(fontCompilation.workerCacheDocumentReady).toBe(true);

            fontCompilation.handleWorkerMessage({
                data: {
                    id: getPostedMessage().id,
                    type,
                    success: true
                }
            });

            await expect(messagePromise).resolves.toEqual(
                expect.objectContaining({ success: true })
            );
            expect(fontCompilation.workerCacheDocumentReady).toBe(true);
        }
    );

    test('cached editing compiles send the incremental sentinel when the worker document is ready', async () => {
        const { fontCompilation } = createReadyFontCompilation();
        const sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({
                result: new Uint8Array([1, 2, 3]),
                filename: 'editing-font.ttf',
                time_taken: 1,
                fontRevisionKey: '7'
            });

        await expect(
            fontCompilation.compileEditingFromJsonCached(
                '{"glyphs":[{"name":"a"}]}',
                '7',
                ['a'],
                { compileSource: 'keyboard-outline' }
            )
        ).resolves.toEqual(expect.objectContaining({ fontRevisionKey: '7' }));

        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'compileEditingCached',
                babelfontJson: '__incremental_layer__',
                subsetGlyphs: ['a'],
                subsetKey: 'a',
                layoutClosureKey: 'a\u001e',
                _usePreviewWorkerCache: false
            })
        );
    });

    test('cached editing compiles forward the preview worker cache flag', async () => {
        const { fontCompilation } = createReadyFontCompilation();
        const sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({
                result: new Uint8Array([1, 2, 3]),
                filename: 'editing-font.ttf',
                time_taken: 1,
                fontRevisionKey: '8'
            });

        await fontCompilation.compileEditingFromJsonCached(
            '{"glyphs":[{"name":"a"}]}',
            '8',
            ['a'],
            {
                compileSource: 'mouse-drag-outline',
                usePreviewWorkerCache: true
            }
        );

        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'compileEditingCached',
                babelfontJson: '__incremental_layer__',
                _usePreviewWorkerCache: true
            })
        );
    });

    test('feature-code editing compiles still consume the supplied canonical JSON', async () => {
        const { fontCompilation } = createReadyFontCompilation();
        const compileFromJsonSpy = jest
            .spyOn(fontCompilation, 'compileFromJson')
            .mockResolvedValue({
                result: new Uint8Array([4, 5, 6]),
                filename: 'editing-font.ttf',
                time_taken: 2
            });

        await expect(
            fontCompilation.compileEditingFromJsonCached(
                '{"glyphs":[]}',
                '9',
                ['a'],
                { compileSource: 'feature-code' }
            )
        ).resolves.toEqual(expect.objectContaining({ fontRevisionKey: '9' }));

        expect(compileFromJsonSpy).toHaveBeenCalledWith(
            '{"glyphs":[]}',
            'editing-font.ttf',
            expect.any(Object)
        );
    });
});
