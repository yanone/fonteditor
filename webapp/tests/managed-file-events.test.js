const {
    cancelManagedFileInternalWrite,
    consumeManagedFileInternalWritePaths,
    markManagedFileInternalWrite
} = require('../js/managed-file-events');

describe('managed file internal writes', () => {
    afterEach(() => {
        jest.useRealTimers();
        cancelManagedFileInternalWrite('disk', '/sources/example.glyphs');
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
});
