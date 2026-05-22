describe('babelfont-model worker-safe imports', () => {
    const originalWindow = global.window;
    const originalDocument = global.document;

    afterEach(() => {
        jest.resetModules();

        if (typeof originalWindow === 'undefined') {
            delete global.window;
        } else {
            global.window = originalWindow;
        }

        if (typeof originalDocument === 'undefined') {
            delete global.document;
        } else {
            global.document = originalDocument;
        }
    });

    test('imports without window or document for glyph filter worker use', () => {
        delete global.window;
        delete global.document;

        expect(() => {
            jest.isolateModules(() => {
                require('../js/babelfont-model');
            });
        }).not.toThrow();
    });
});
