/**
 * Opt-in samples for COMPILE_BENCH Playwright. Production paths no-op unless
 * the benchmark page installed `window.__compileBench`.
 */

export type CompileBenchRecompositionKind = 'closure' | 'rebuild';

export function recordCompileBenchRecomposition(
    kind: CompileBenchRecompositionKind,
    durationMs: number,
    extra?: { glyphCount?: number }
): void {
    if (typeof window === 'undefined') {
        return;
    }
    const bench = (
        window as Window & {
            __compileBench?: {
                lane?: string;
                recompositionSamples?: Array<{
                    lane: string;
                    kind: CompileBenchRecompositionKind;
                    ms: number;
                    glyphCount?: number;
                }>;
            };
        }
    ).__compileBench;
    if (!bench?.recompositionSamples) {
        return;
    }
    bench.recompositionSamples.push({
        lane: bench.lane || 'idle',
        kind,
        ms: durationMs,
        ...(extra?.glyphCount !== undefined
            ? { glyphCount: extra.glyphCount }
            : {})
    });
}
