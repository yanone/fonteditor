import * as fs from 'fs';
import * as path from 'path';
import type {
    FullConfig,
    FullResult,
    Reporter,
    Suite,
    TestCase,
    TestResult,
    TestStep
} from '@playwright/test/reporter';

interface StepRecord {
    testTitle: string;
    testFile: string;
    stepTitle: string;
    category: string;
    bucket: string;
    durationMs: number;
    depth: number;
    parentTitle: string | null;
}

interface BucketStats {
    bucket: string;
    count: number;
    totalMs: number;
    maxMs: number;
    maxTest: string;
    maxStep: string;
}

interface TestStats {
    testTitle: string;
    testFile: string;
    durationMs: number;
    status: string;
    topSteps: Array<{ title: string; bucket: string; durationMs: number }>;
}

function normalizeBucket(title: string, category: string): string {
    const t = title.trim();

    if (t.startsWith('helper:')) {
        return t;
    }

    if (
        category === 'expect' ||
        /^Expect |toHaveScreenshot|toMatchSnapshot|toEqual|toBe/i.test(t)
    ) {
        if (/screenshot|toHaveScreenshot/i.test(t)) {
            return 'expect:screenshot';
        }
        if (/snapshot|toMatchSnapshot|toEqual/i.test(t)) {
            return 'expect:snapshot';
        }
        return 'expect:other';
    }

    if (/^goto |Navigate to|page\.goto/i.test(t)) {
        return 'nav:goto';
    }
    if (/Reload|page\.reload/i.test(t)) {
        return 'nav:reload';
    }
    if (/Wait for timeout|waitForTimeout/i.test(t)) {
        const match = t.match(/(\d+)\s*ms/i);
        if (match) {
            const ms = Number(match[1]);
            if (ms >= 1000) {
                return 'sleep:>=1000ms';
            }
            if (ms >= 400) {
                return 'sleep:400-999ms';
            }
            if (ms >= 100) {
                return 'sleep:100-399ms';
            }
            return 'sleep:<100ms';
        }
        return 'sleep:other';
    }
    if (/Wait for function|waitForFunction/i.test(t)) {
        return 'wait:function';
    }
    if (/Wait for selector|waitFor\(|locator\.waitFor/i.test(t)) {
        return 'wait:selector';
    }
    if (
        /Wait for load|waitForLoadState|networkidle|domcontentloaded/i.test(t)
    ) {
        return 'wait:load';
    }
    if (/Click|click/i.test(t) && category === 'pw:api') {
        return 'action:click';
    }
    if (/Press|keyboard|type|fill/i.test(t) && category === 'pw:api') {
        return 'action:input';
    }
    if (/Hover|drag|mouse|Wheel/i.test(t) && category === 'pw:api') {
        return 'action:pointer';
    }
    if (/Evaluate|page\.evaluate/i.test(t)) {
        return 'page:evaluate';
    }
    if (/screenshot|Screenshot/i.test(t)) {
        return 'capture:screenshot';
    }
    if (category === 'fixture') {
        return `fixture:${t}`;
    }
    if (category === 'hook') {
        return `hook:${t}`;
    }
    if (category === 'test.step') {
        return `step:${t}`;
    }

    return `${category || 'other'}:${t.slice(0, 80)}`;
}

function collectSteps(
    test: TestCase,
    result: TestResult,
    step: TestStep,
    depth: number,
    parentTitle: string | null,
    out: StepRecord[]
): void {
    // Prefer leaf attribution for nested helper steps; still record parents
    // so semantic helper wrappers show up even when they contain pw:api children.
    out.push({
        testTitle: test.titlePath().slice(1).join(' › '),
        testFile: path.relative(process.cwd(), test.location.file),
        stepTitle: step.title,
        category: step.category,
        bucket: normalizeBucket(step.title, step.category),
        durationMs: step.duration,
        depth,
        parentTitle
    });

    for (const child of step.steps || []) {
        collectSteps(test, result, child, depth + 1, step.title, out);
    }
}

function formatMs(ms: number): string {
    if (ms >= 60000) {
        return `${(ms / 60000).toFixed(1)}m`;
    }
    if (ms >= 1000) {
        return `${(ms / 1000).toFixed(1)}s`;
    }
    return `${Math.round(ms)}ms`;
}

function pct(part: number, whole: number): string {
    if (whole <= 0) {
        return '0%';
    }
    return `${((part / whole) * 100).toFixed(1)}%`;
}

export default class StepTimingReporter implements Reporter {
    private config!: FullConfig;
    private steps: StepRecord[] = [];
    private tests: TestStats[] = [];
    private suiteStartedAt = 0;

    onBegin(config: FullConfig, _suite: Suite): void {
        this.config = config;
        this.suiteStartedAt = Date.now();
        this.steps = [];
        this.tests = [];
    }

    onTestEnd(test: TestCase, result: TestResult): void {
        const topSteps: TestStats['topSteps'] = [];

        for (const step of result.steps || []) {
            collectSteps(test, result, step, 0, null, this.steps);
        }

        const leafish = this.steps
            .filter(
                (s) =>
                    s.testTitle === test.titlePath().slice(1).join(' › ') &&
                    s.testFile ===
                        path.relative(process.cwd(), test.location.file)
            )
            .slice()
            .sort((a, b) => b.durationMs - a.durationMs)
            .slice(0, 12)
            .map((s) => ({
                title: s.stepTitle,
                bucket: s.bucket,
                durationMs: s.durationMs
            }));

        topSteps.push(...leafish);

        this.tests.push({
            testTitle: test.titlePath().slice(1).join(' › '),
            testFile: path.relative(process.cwd(), test.location.file),
            durationMs: result.duration,
            status: result.status,
            topSteps
        });
    }

    async onEnd(result: FullResult): Promise<void> {
        const outputDir =
            this.config.metadata?.['stepTimingOutputDir'] ||
            path.join(process.cwd(), 'test-results');
        fs.mkdirSync(outputDir, { recursive: true });

        const wallMs = Date.now() - this.suiteStartedAt;
        const testTotalMs = this.tests.reduce(
            (sum, t) => sum + t.durationMs,
            0
        );

        // Aggregate by bucket using top-level semantic steps preferentially:
        // helper:* and sleep:* and nav:* get full durations; nested pw:api under
        // helpers are still useful for drill-down but double-count if summed raw.
        const helperOrSemantic = this.steps.filter(
            (s) =>
                s.bucket.startsWith('helper:') ||
                s.bucket.startsWith('sleep:') ||
                s.bucket.startsWith('nav:') ||
                s.bucket.startsWith('expect:') ||
                s.bucket.startsWith('wait:') ||
                s.depth === 0
        );

        const byBucket = new Map<string, BucketStats>();
        for (const step of helperOrSemantic) {
            const existing = byBucket.get(step.bucket) || {
                bucket: step.bucket,
                count: 0,
                totalMs: 0,
                maxMs: 0,
                maxTest: '',
                maxStep: ''
            };
            existing.count += 1;
            existing.totalMs += step.durationMs;
            if (step.durationMs > existing.maxMs) {
                existing.maxMs = step.durationMs;
                existing.maxTest = step.testTitle;
                existing.maxStep = step.stepTitle;
            }
            byBucket.set(step.bucket, existing);
        }

        const buckets = Array.from(byBucket.values()).sort(
            (a, b) => b.totalMs - a.totalMs
        );

        // Also aggregate raw leaf-ish pw:api / helper titles for drill-down
        const byExactTitle = new Map<
            string,
            { title: string; count: number; totalMs: number; maxMs: number }
        >();
        for (const step of this.steps) {
            // Prefer depth 0-1 and helper wrappers to reduce noise
            if (step.depth > 2 && !step.bucket.startsWith('helper:')) {
                continue;
            }
            const key = `${step.category}::${step.stepTitle}`;
            const existing = byExactTitle.get(key) || {
                title: step.stepTitle,
                count: 0,
                totalMs: 0,
                maxMs: 0
            };
            existing.count += 1;
            existing.totalMs += step.durationMs;
            existing.maxMs = Math.max(existing.maxMs, step.durationMs);
            byExactTitle.set(key, existing);
        }
        const exactTitles = Array.from(byExactTitle.values()).sort(
            (a, b) => b.totalMs - a.totalMs
        );

        const slowestSteps = this.steps
            .slice()
            .sort((a, b) => b.durationMs - a.durationMs)
            .slice(0, 40);

        const slowestTests = this.tests
            .slice()
            .sort((a, b) => b.durationMs - a.durationMs);

        const payload = {
            generatedAt: new Date().toISOString(),
            suiteStatus: result.status,
            wallClockMs: wallMs,
            summedTestDurationMs: testTotalMs,
            testCount: this.tests.length,
            stepCount: this.steps.length,
            buckets,
            exactTitles: exactTitles.slice(0, 80),
            slowestSteps,
            slowestTests,
            allSteps: this.steps
        };

        const jsonPath = path.join(outputDir, 'step-timings.json');
        fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));

        const lines: string[] = [];
        lines.push('# Playwright step timing summary');
        lines.push('');
        lines.push(`- Generated: ${payload.generatedAt}`);
        lines.push(`- Suite status: ${result.status}`);
        lines.push(`- Wall clock: ${formatMs(wallMs)}`);
        lines.push(`- Summed test durations: ${formatMs(testTotalMs)}`);
        lines.push(`- Tests: ${this.tests.length}`);
        lines.push(`- Recorded steps: ${this.steps.length}`);
        lines.push('');
        lines.push('## Slowest tests');
        lines.push('');
        for (const t of slowestTests.slice(0, 25)) {
            lines.push(
                `- ${formatMs(t.durationMs)} (${pct(t.durationMs, testTotalMs)}) — ${t.testFile} › ${t.testTitle} [${t.status}]`
            );
        }
        lines.push('');
        lines.push('## Time by bucket (semantic aggregation)');
        lines.push('');
        lines.push('| Bucket | Count | Total | % of tests | Max | Max test |');
        lines.push('| --- | ---: | ---: | ---: | ---: | --- |');
        for (const b of buckets.slice(0, 40)) {
            lines.push(
                `| ${b.bucket} | ${b.count} | ${formatMs(b.totalMs)} | ${pct(b.totalMs, testTotalMs)} | ${formatMs(b.maxMs)} | ${b.maxTest.slice(0, 60)} |`
            );
        }
        lines.push('');
        lines.push('## Slowest individual steps');
        lines.push('');
        for (const s of slowestSteps.slice(0, 30)) {
            lines.push(
                `- ${formatMs(s.durationMs)} — [${s.bucket}] ${s.stepTitle} @ ${s.testFile} › ${s.testTitle}`
            );
        }
        lines.push('');
        lines.push('## Top exact step titles by cumulative time');
        lines.push('');
        for (const e of exactTitles.slice(0, 30)) {
            lines.push(
                `- ${formatMs(e.totalMs)} across ${e.count}× (max ${formatMs(e.maxMs)}) — ${e.title}`
            );
        }
        lines.push('');
        lines.push(`Full JSON: ${jsonPath}`);

        const mdPath = path.join(outputDir, 'step-timings-summary.md');
        fs.writeFileSync(mdPath, lines.join('\n'));

        // Always print a concise console summary for the run log.
        console.log('\n========== STEP TIMING SUMMARY ==========');
        console.log(
            `Wall clock: ${formatMs(wallMs)} | Tests: ${this.tests.length}`
        );
        console.log('Top buckets:');
        for (const b of buckets.slice(0, 15)) {
            console.log(
                `  ${formatMs(b.totalMs).padStart(7)}  ${String(b.count).padStart(4)}×  ${b.bucket}`
            );
        }
        console.log('Slowest tests:');
        for (const t of slowestTests.slice(0, 10)) {
            console.log(
                `  ${formatMs(t.durationMs).padStart(7)}  ${t.testFile} › ${t.testTitle}`
            );
        }
        console.log(`Wrote ${mdPath}`);
        console.log('=========================================\n');
    }
}
