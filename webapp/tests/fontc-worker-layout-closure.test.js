jest.mock('../wasm-dist/babelfont_fontc_web.js', () =>
    require('./__mocks__/babelfontWasmMock')
);

const {
    compileFromLastLayoutClosureWithReprime,
    isMissingPrimedLayoutClosureError,
    shouldReprimeMissingLayoutClosure
} = require('../js/fontc-worker');

describe('fontc-worker layout closure retry predicates', () => {
    test('detects Rust missing-primed-layout-closure errors', () => {
        expect(
            isMissingPrimedLayoutClosureError(
                new Error(
                    'No primed layout closure. Call prime_layout_closure_cache() first.'
                )
            )
        ).toBe(true);
        expect(
            isMissingPrimedLayoutClosureError({
                message:
                    'No primed layout closure. Call prime_layout_closure_cache() first.'
            })
        ).toBe(true);
        expect(
            isMissingPrimedLayoutClosureError('No primed layout closure')
        ).toBe(true);
    });

    test('does not classify unrelated compile errors as stale closure metadata', () => {
        expect(
            isMissingPrimedLayoutClosureError(new Error('bad feature'))
        ).toBe(false);
        expect(isMissingPrimedLayoutClosureError(null)).toBe(false);
    });

    test('only re-primes missing closure errors when subset glyphs are available', () => {
        const error = new Error('No primed layout closure');

        expect(shouldReprimeMissingLayoutClosure(error, ['o'])).toBe(true);
        expect(shouldReprimeMissingLayoutClosure(error, [])).toBe(true);
        expect(shouldReprimeMissingLayoutClosure(error, null)).toBe(false);
        expect(
            shouldReprimeMissingLayoutClosure(new Error('bad feature'), ['o'])
        ).toBe(false);
    });

    test('re-primes and retries cached compile when closure metadata is stale', () => {
        const compiledBytes = new Uint8Array([1, 2, 3]);
        const compileFromLastClosure = jest
            .fn()
            .mockImplementationOnce(() => {
                throw new Error(
                    'No primed layout closure. Call prime_layout_closure_cache() first.'
                );
            })
            .mockReturnValueOnce(compiledBytes);
        const primeLayoutClosure = jest.fn().mockReturnValue(2);
        const onReprime = jest.fn();

        const result = compileFromLastLayoutClosureWithReprime(
            { skip_features: true },
            'epoch:subset',
            ['o', 'odieresis'],
            compileFromLastClosure,
            primeLayoutClosure,
            onReprime
        );

        expect(result).toBe(compiledBytes);
        expect(compileFromLastClosure).toHaveBeenCalledTimes(2);
        expect(primeLayoutClosure).toHaveBeenCalledWith(
            'epoch:subset',
            JSON.stringify(['o', 'odieresis'])
        );
        expect(onReprime).toHaveBeenCalledWith(2);
    });

    test('does not re-prime unrelated cached compile errors', () => {
        const compileError = new Error('bad feature syntax');
        const compileFromLastClosure = jest.fn(() => {
            throw compileError;
        });
        const primeLayoutClosure = jest.fn();

        expect(() =>
            compileFromLastLayoutClosureWithReprime(
                {},
                'epoch:subset',
                ['o'],
                compileFromLastClosure,
                primeLayoutClosure
            )
        ).toThrow(compileError);
        expect(compileFromLastClosure).toHaveBeenCalledTimes(1);
        expect(primeLayoutClosure).not.toHaveBeenCalled();
    });
});
