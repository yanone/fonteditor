const {
    cancelManagedFileInternalWrite,
    consumeManagedFileInternalWritePaths,
    dispatchManagedFileChanged,
    hasManagedFileInternalWrite,
    markManagedFileInternalWrite,
    wereAllBasenamesInternalWrites,
    wereAllManagedPathsInternalWrites
} = require('../js/managed-file-events');

describe('managed file internal writes', () => {
    afterEach(() => {
        jest.useRealTimers();
        cancelManagedFileInternalWrite('disk', '/sources/example.glyphs');
        cancelManagedFileInternalWrite('settings', '/Filters/example.py');
        cancelManagedFileInternalWrite('settings', '/Filters/other.py');
    });

    test('consumes only the matching self-written disk path', () => {
        markManagedFileInternalWrite('disk', '/sources/example.glyphs');

        expect(
            consumeManagedFileInternalWritePaths('disk', [
                '/sources/externally-edited.glyphs'
            ])
        ).toEqual([]);
        expect(
            consumeManagedFileInternalWritePaths('disk', [
                'sources/example.glyphs'
            ])
        ).toEqual(['/sources/example.glyphs']);
        expect(
            consumeManagedFileInternalWritePaths('disk', [
                '/sources/example.glyphs'
            ])
        ).toEqual([]);
    });

    test('cancels a failed self-write marker', () => {
        markManagedFileInternalWrite('disk', '/sources/example.glyphs');
        cancelManagedFileInternalWrite('disk', '/sources/example.glyphs');

        expect(
            consumeManagedFileInternalWritePaths('disk', [
                '/sources/example.glyphs'
            ])
        ).toEqual([]);
    });

    test('does not suppress a change after the self-write marker expires', () => {
        jest.useFakeTimers();
        markManagedFileInternalWrite('disk', '/sources/example.glyphs');

        jest.advanceTimersByTime(5001);

        expect(
            consumeManagedFileInternalWritePaths('disk', [
                '/sources/example.glyphs'
            ])
        ).toEqual([]);
    });

    test('wereAllManagedPathsInternalWrites peeks without consuming', () => {
        markManagedFileInternalWrite('settings', '/Filters/example.py');

        expect(
            wereAllManagedPathsInternalWrites('settings', [
                '/Filters/example.py'
            ])
        ).toBe(true);
        // Peek-only: a second echo within the TTL is still suppressed.
        expect(
            wereAllManagedPathsInternalWrites('settings', [
                '/Filters/example.py'
            ])
        ).toBe(true);
        expect(
            hasManagedFileInternalWrite('settings', '/Filters/example.py')
        ).toBe(true);
    });

    test('wereAllManagedPathsInternalWrites keeps mixed batches external', () => {
        markManagedFileInternalWrite('settings', '/Filters/example.py');

        expect(
            wereAllManagedPathsInternalWrites('settings', [
                '/Filters/example.py',
                '/Filters/other.py'
            ])
        ).toBe(false);
        expect(
            wereAllManagedPathsInternalWrites('settings', [
                '/Filters/example.py'
            ])
        ).toBe(true);
    });

    test('wereAllBasenamesInternalWrites matches pending filter files', () => {
        markManagedFileInternalWrite('settings', '/Filters/nested/example.py');

        expect(wereAllBasenamesInternalWrites('settings', ['example.py'])).toBe(
            true
        );
        expect(
            wereAllBasenamesInternalWrites('settings', [
                'example.py',
                'other.py'
            ])
        ).toBe(false);
    });

    test('dispatchManagedFileChanged re-arms internalWrite markers', () => {
        jest.useFakeTimers();
        markManagedFileInternalWrite('settings', '/Filters/example.py');
        jest.advanceTimersByTime(4000);

        dispatchManagedFileChanged({
            pluginId: 'settings',
            source: 'script-editor-save',
            paths: ['/Filters/example.py'],
            internalWrite: true
        });

        jest.advanceTimersByTime(2000);
        expect(
            hasManagedFileInternalWrite('settings', '/Filters/example.py')
        ).toBe(true);
    });
});
