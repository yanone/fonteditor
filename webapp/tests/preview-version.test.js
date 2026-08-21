const { execFileSync } = require('child_process');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '../../scripts/preview-version.mjs');

function resolve(date, refs) {
    const output = execFileSync('node', [SCRIPT, `--date=${date}`], {
        encoding: 'utf8',
        input: refs.join('\n') + (refs.length ? '\n' : '')
    });
    return Object.fromEntries(
        output
            .trim()
            .split('\n')
            .map((line) => {
                const eq = line.indexOf('=');
                return [line.slice(0, eq), line.slice(eq + 1)];
            })
    );
}

describe('preview version numbering', () => {
    test('increments a running build number across days', () => {
        const resolved = resolve('20260821', [
            'v0.0.0-preview.20260816.1',
            'v0.0.0-preview.20260816.2',
            'v0.0.0-preview.20260816.3'
        ]);
        expect(resolved.DISPLAY_VERSION).toBe('20260821-build-4');
        expect(resolved.TAG).toBe('v0.0.0-preview.20260821.4');
        expect(resolved.PREV_TAG).toBe('v0.0.0-preview.20260816.3');
        expect(resolved.NEXT_N).toBe('4');
    });

    test('continues past a day that reset N in the old per-day sequence', () => {
        const resolved = resolve('20260822', [
            'v0.0.0-preview.20260816.3',
            'v0.0.0-preview.20260821.1'
        ]);
        expect(resolved.DISPLAY_VERSION).toBe('20260822-build-4');
        expect(resolved.TAG).toBe('v0.0.0-preview.20260822.4');
        expect(resolved.PREV_TAG).toBe('v0.0.0-preview.20260821.1');
    });

    test('starts at 1 when there are no preview tags', () => {
        const resolved = resolve('20260821', []);
        expect(resolved.DISPLAY_VERSION).toBe('20260821-build-1');
        expect(resolved.TAG).toBe('v0.0.0-preview.20260821.1');
        expect(resolved.PREV_TAG).toBe('');
    });

    test('reads N from DATE-build-N titles as well as tags', () => {
        const resolved = resolve('20260821', ['20260816-build-3']);
        expect(resolved.NEXT_N).toBe('4');
        expect(resolved.PREV_TAG).toBe('');
    });
});
