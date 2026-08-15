const {
    estimateJsValueBytes,
    jsStringHeapBytes,
    formatMemoryBytes,
    domainMeasuredBytes,
    breakdownMeasuredBytes,
    breakdownCoveragePercent
} = require('../js/memory-breakdown');

describe('memory breakdown helpers', () => {
    test('estimates shared object graphs once', () => {
        const shared = { name: 'A', nodes: [1, 2, 3] };
        const root = { left: shared, right: shared };
        const seen = new WeakSet();
        const first = estimateJsValueBytes(root, seen);
        const second = estimateJsValueBytes(shared, seen);
        expect(first).toBeGreaterThan(0);
        expect(second).toBe(0);
    });

    test('counts JS string heap as UTF-16', () => {
        expect(jsStringHeapBytes('abcd')).toBe(24 + 8);
        expect(jsStringHeapBytes('')).toBe(0);
        expect(jsStringHeapBytes(null)).toBe(0);
    });

    test('formats bytes and coverage against the matching heap', () => {
        expect(formatMemoryBytes(0)).toBe('0 B');
        expect(formatMemoryBytes(2048)).toBe('2.0 KB');
        expect(formatMemoryBytes(1048576)).toBe('1.00 MB');

        const domain = {
            id: 'main-js',
            label: 'Main JS',
            usedBytes: 1000,
            usedLabel: 'Used heap',
            rows: [
                {
                    id: 'a',
                    label: 'A',
                    bytes: 200,
                    method: 'exact',
                    inSum: true
                },
                {
                    id: 'b',
                    label: 'B',
                    bytes: 50,
                    method: 'est.',
                    inSum: true
                },
                {
                    id: 'c',
                    label: 'C',
                    bytes: 9999,
                    method: 'exact',
                    inSum: false
                }
            ]
        };
        expect(domainMeasuredBytes(domain)).toBe(250);

        const breakdown = {
            browserUsedBytes: 1000,
            browserLimitBytes: 4000,
            domains: [
                domain,
                {
                    id: 'worker-wasm',
                    label: 'Worker WASM / Rust',
                    usedBytes: 8000,
                    usedLabel: 'Linear memory',
                    rows: [
                        {
                            id: 'd',
                            label: 'D',
                            bytes: 150,
                            method: 'est.',
                            inSum: true
                        }
                    ]
                }
            ],
            otherRows: [
                {
                    id: 'pyodide',
                    label: 'Pyodide',
                    bytes: 5000,
                    method: 'exact',
                    inSum: false
                }
            ]
        };
        expect(breakdownMeasuredBytes(breakdown)).toBe(400);
        expect(breakdownCoveragePercent(breakdown)).toBe(40);
    });
});
