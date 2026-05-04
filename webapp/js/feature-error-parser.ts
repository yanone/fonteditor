export interface ParsedFeatureIssue {
    category: string;
    message: string;
    isError: boolean;
    start?: number;
    end?: number;
}

function decodeRustString(value: string): string {
    return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function normalizeCategory(categoryHint?: string): string {
    if (!categoryHint || categoryHint.trim().length === 0) {
        return 'FeatureParsing';
    }
    return categoryHint;
}

function parseSpan(
    spanValue: unknown
): { start: number; end: number } | undefined {
    if (!spanValue) {
        return undefined;
    }

    if (typeof spanValue === 'string') {
        const match =
            spanValue.match(/(\d+)\.\.(\d+)/) ||
            spanValue.match(
                /Span\s*\{\s*start:\s*(\d+)\s*,\s*end:\s*(\d+)\s*\}/i
            );
        if (!match) {
            return undefined;
        }
        const start = Number(match[1]);
        const end = Number(match[2]);
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
            return undefined;
        }
        return { start, end };
    }

    if (Array.isArray(spanValue) && spanValue.length >= 2) {
        const start = Number(spanValue[0]);
        const end = Number(spanValue[1]);
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
            return undefined;
        }
        return { start, end };
    }

    if (typeof spanValue === 'object') {
        const record = spanValue as Record<string, unknown>;
        const start = Number(record.start);
        const end = Number(record.end);
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
            return undefined;
        }
        return { start, end };
    }

    return undefined;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') {
        return value;
    }
    return fallback;
}

function collectFromRustDebugString(source: string): ParsedFeatureIssue[] {
    if (!/feature\s*parsing|featureerror/i.test(source)) {
        return [];
    }

    const issues: ParsedFeatureIssue[] = [];
    const categoryMatch = source.match(/(FeatureParsing|FeatureError)/i);
    const category = normalizeCategory(categoryMatch?.[1]);

    const detailedRegex =
        /FeatureError\s*\{\s*message:\s*"((?:[^"\\]|\\.)*)"(?:\s*,\s*span:\s*(\d+)\.\.(\d+))?(?:\s*,\s*is_error:\s*(true|false))?[^}]*\}/gi;

    for (const match of source.matchAll(detailedRegex)) {
        const message = decodeRustString(
            match[1] || 'Feature compilation error'
        );
        const start =
            typeof match[2] === 'string' ? Number(match[2]) : undefined;
        const end = typeof match[3] === 'string' ? Number(match[3]) : undefined;
        issues.push({
            category,
            message,
            isError: match[4] ? match[4].toLowerCase() === 'true' : true,
            start: Number.isFinite(start) ? start : undefined,
            end: Number.isFinite(end) ? end : undefined
        });
    }

    if (issues.length > 0) {
        return issues;
    }

    const diagnosticRegex =
        /Diagnostic\s*\{\s*message:\s*Message\s*\{\s*text:\s*"((?:[^"\\]|\\.)*)"\s*,\s*file:\s*FileId\(\d+\)\s*,\s*span:\s*Span\s*\{\s*start:\s*(\d+)\s*,\s*end:\s*(\d+)\s*\}\s*\}\s*,\s*level:\s*(Error|Warning)\s*\}/gi;

    for (const match of source.matchAll(diagnosticRegex)) {
        const start = Number(match[2]);
        const end = Number(match[3]);
        issues.push({
            category,
            message: decodeRustString(match[1] || 'Feature compilation error'),
            isError: (match[4] || 'Error').toLowerCase() === 'error',
            start: Number.isFinite(start) ? start : undefined,
            end: Number.isFinite(end) ? end : undefined
        });
    }

    if (issues.length > 0) {
        return issues;
    }

    const messageMatch = source.match(/message:\s*"((?:[^"\\]|\\.)*)"/i);
    const spanMatch =
        source.match(/span:\s*(\d+)\.\.(\d+)/i) ||
        source.match(
            /span:\s*Span\s*\{\s*start:\s*(\d+)\s*,\s*end:\s*(\d+)\s*\}/i
        );
    if (!messageMatch && !spanMatch) {
        return [];
    }

    const start = spanMatch?.[1] ? Number(spanMatch[1]) : undefined;
    const end = spanMatch?.[2] ? Number(spanMatch[2]) : undefined;

    return [
        {
            category,
            message: messageMatch?.[1]
                ? decodeRustString(messageMatch[1])
                : 'Feature compilation error',
            isError: true,
            start: Number.isFinite(start) ? start : undefined,
            end: Number.isFinite(end) ? end : undefined
        }
    ];
}

function collectFromStructuredValue(
    value: unknown,
    categoryHint: string | undefined,
    issues: ParsedFeatureIssue[],
    seen: WeakSet<object>
) {
    if (value === null || value === undefined) {
        return;
    }

    if (typeof value === 'string') {
        issues.push(...collectFromRustDebugString(value));
        return;
    }

    if (typeof value !== 'object') {
        return;
    }

    if (seen.has(value)) {
        return;
    }
    seen.add(value);

    if (Array.isArray(value)) {
        value.forEach((entry) => {
            collectFromStructuredValue(entry, categoryHint, issues, seen);
        });
        return;
    }

    const record = value as Record<string, unknown>;
    const message =
        typeof record.message === 'string' ? record.message : undefined;
    const span = parseSpan(record.span);
    const hasFeatureCategoryHint = /feature/i.test(categoryHint || '');
    const hasFeatureName =
        typeof record.name === 'string' && /feature/i.test(record.name);

    if (message && (span || hasFeatureCategoryHint || hasFeatureName)) {
        issues.push({
            category: normalizeCategory(categoryHint),
            message,
            isError: parseBoolean(record.is_error ?? record.isError, true),
            start: span?.start,
            end: span?.end
        });
    }

    Object.entries(record).forEach(([key, nested]) => {
        if (
            key === 'message' ||
            key === 'span' ||
            key === 'is_error' ||
            key === 'isError'
        ) {
            return;
        }

        const nextCategory = /feature/i.test(key) ? key : categoryHint;
        collectFromStructuredValue(nested, nextCategory, issues, seen);
    });
}

function getErrorSources(errorInput: unknown): unknown[] {
    const sources: unknown[] = [errorInput];

    if (errorInput instanceof Error) {
        sources.push(errorInput.message);

        const withPayload = errorInput as Error & {
            compilationErrorPayload?: unknown;
            cause?: unknown;
        };

        if (withPayload.compilationErrorPayload !== undefined) {
            sources.push(withPayload.compilationErrorPayload);
        }

        if (withPayload.cause !== undefined) {
            sources.push(withPayload.cause);
        }
    }

    return sources;
}

export function extractFeatureIssuesFromCompilationError(
    errorInput: unknown
): ParsedFeatureIssue[] {
    const issues: ParsedFeatureIssue[] = [];
    const seen = new WeakSet<object>();

    getErrorSources(errorInput).forEach((source) => {
        if (typeof source === 'string') {
            issues.push(...collectFromRustDebugString(source));
        }
        collectFromStructuredValue(source, undefined, issues, seen);
    });

    const unique = new Map<string, ParsedFeatureIssue>();
    issues.forEach((issue) => {
        const key = `${issue.category}|${issue.message}|${issue.start ?? ''}|${issue.end ?? ''}|${issue.isError}`;
        if (!unique.has(key)) {
            unique.set(key, issue);
        }
    });

    const deduped = Array.from(unique.values());
    deduped.sort((a, b) => {
        if (a.isError !== b.isError) {
            return a.isError ? -1 : 1;
        }
        const aHasSpan = a.start !== undefined && a.end !== undefined;
        const bHasSpan = b.start !== undefined && b.end !== undefined;
        if (aHasSpan !== bHasSpan) {
            return aHasSpan ? -1 : 1;
        }
        return 0;
    });

    return deduped;
}

export function extractPrimaryFeatureIssue(
    errorInput: unknown
): ParsedFeatureIssue | null {
    const issues = extractFeatureIssuesFromCompilationError(errorInput);
    const withSpan = issues.find(
        (issue) => issue.start !== undefined && issue.end !== undefined
    );
    return withSpan || issues[0] || null;
}
