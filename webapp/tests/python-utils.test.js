require('../js/python-utils.ts');

describe('sanitizePythonRuntimeError', () => {
    test('rewrites JsProxy subscript errors without naming the JS runtime', () => {
        const sanitized = window.sanitizePythonRuntimeError(
            "TypeError: 'pyodide.ffi.JsProxy' object is not subscriptable"
        );

        expect(sanitized).toContain(
            'object is not subscriptable; use attribute access (for example name.dflt)'
        );
        expect(sanitized.toLowerCase()).not.toContain('jsproxy');
        expect(sanitized.toLowerCase()).not.toContain('pyodide');
        expect(sanitized).not.toContain('js.');
    });

    test('cleanPythonTraceback also strips JsProxy from the error line', () => {
        const cleaned = window.cleanPythonTraceback(
            "Traceback (most recent call last):\nTypeError: 'pyodide.ffi.JsProxy' object is not subscriptable"
        );

        expect(cleaned.toLowerCase()).not.toContain('jsproxy');
        expect(cleaned.toLowerCase()).not.toContain('pyodide');
    });
});
