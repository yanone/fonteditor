const {
    cancelManagedFileInternalWrite,
    consumeManagedFileInternalWritePaths,
    markManagedFileInternalWrite,
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

    test('wereAllManagedPathsInternalWrites suppresses a complete settings echo', () => {
        markManagedFileInternalWrite('settings', '/Filters/example.py');

        expect(
            wereAllManagedPathsInternalWrites('settings', [
                '/Filters/example.py'
            ])
        ).toBe(true);
        // Marker is consumed; a second echo is not suppressed.
        expect(
            wereAllManagedPathsInternalWrites('settings', [
                '/Filters/example.py'
            ])
        ).toBe(false);
    });

    test('wereAllManagedPathsInternalWrites keeps mixed batches external', () => {
        markManagedFileInternalWrite('settings', '/Filters/example.py');

        expect(
            wereAllManagedPathsInternalWrites('settings', [
                '/Filters/example.py',
                '/Filters/other.py'
            ])
        ).toBe(false);

        // Mixed batch must not consume the marker for the internal path.
        expect(
            wereAllManagedPathsInternalWrites('settings', [
                '/Filters/example.py'
            ])
        ).toBe(true);
    });
});
