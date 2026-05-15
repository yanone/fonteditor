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
});
