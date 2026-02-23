const MARK_PREFIX = 'cp';

type TimelineContext = {
    process?: string;
    traceId?: string;
    parentSpanId?: string;
    requestId?: string;
    fontRevisionKey?: string;
};

type TimelineSpanState = {
    stage: string;
    startMark: string;
    contextSuffix: string;
};

type TimelineSpanOptions = {
    detail?: TimelineDetail;
    context?: TimelineContext;
};

const activeSpans: Map<string, TimelineSpanState> = new Map();
let spanCounter = 0;

type TimelineDetail = Record<string, unknown>;

function toLabel(stage: string): string {
    return `${MARK_PREFIX}:${stage}`;
}

function sanitizeContextPart(value: unknown): string | null {
    const normalized = String(value ?? '').trim();
    if (!normalized) {
        return null;
    }
    return normalized.replace(/[|=:#\s]+/g, '_');
}

function contextSuffix(context?: TimelineContext): string {
    if (!context) {
        return '';
    }

    const entries: Array<[string, string | null]> = [
        ['proc', sanitizeContextPart(context.process)],
        ['trace', sanitizeContextPart(context.traceId)],
        ['parent', sanitizeContextPart(context.parentSpanId)],
        ['req', sanitizeContextPart(context.requestId)],
        ['rev', sanitizeContextPart(context.fontRevisionKey)]
    ];

    const parts = entries
        .filter(([, value]) => !!value)
        .map(([key, value]) => `${key}=${value}`);
    return parts.length > 0 ? `|${parts.join('|')}` : '';
}

function normalizeSpanOptions(
    detailOrOptions?: TimelineDetail | TimelineSpanOptions,
    explicitContext?: TimelineContext
): TimelineSpanOptions {
    if (!detailOrOptions) {
        return { context: explicitContext };
    }

    const candidate = detailOrOptions as TimelineSpanOptions;
    const candidateKeys = Object.keys(candidate as Record<string, unknown>);
    const hasOptionsShape =
        typeof detailOrOptions === 'object' &&
        detailOrOptions !== null &&
        ('detail' in candidate || 'context' in candidate) &&
        candidateKeys.every((key) => key === 'detail' || key === 'context');

    if (hasOptionsShape) {
        return {
            detail: candidate.detail,
            context: explicitContext ?? candidate.context
        };
    }

    return {
        detail: detailOrOptions as TimelineDetail,
        context: explicitContext
    };
}

function safeTimeStamp(label: string): void {
    try {
        globalThis.console?.timeStamp?.(label);
    } catch {
        // Ignore browsers without timestamp support
    }
}

function canMark(): boolean {
    return typeof globalThis.performance?.mark === 'function';
}

function canMeasure(): boolean {
    return typeof globalThis.performance?.measure === 'function';
}

export function timelineMark(stage: string, context?: TimelineContext): void {
    const label = toLabel(stage) + contextSuffix(context);
    if (canMark()) {
        globalThis.performance.mark(label);
    }
    safeTimeStamp(label);
}

export function timelineSpanStart(
    stage: string,
    detailOrOptions?: TimelineDetail | TimelineSpanOptions,
    explicitContext?: TimelineContext
): string {
    const options = normalizeSpanOptions(detailOrOptions, explicitContext);
    const suffix = contextSuffix(options.context);
    spanCounter += 1;
    const spanId = `${stage}#${spanCounter}`;
    const startMark = toLabel(`${spanId}:start`) + suffix;

    activeSpans.set(spanId, { stage, startMark, contextSuffix: suffix });
    if (canMark()) {
        if (options.detail !== undefined) {
            globalThis.performance.mark(startMark, { detail: options.detail });
        } else {
            globalThis.performance.mark(startMark);
        }
    }
    safeTimeStamp(startMark);

    return spanId;
}

export function timelineSpanEnd(spanId: string): void {
    const activeSpan = activeSpans.get(spanId);
    if (!activeSpan) {
        return;
    }

    const endMark = toLabel(`${spanId}:end`) + activeSpan.contextSuffix;
    if (canMark()) {
        globalThis.performance.mark(endMark);
    }
    if (canMeasure()) {
        globalThis.performance.measure(
            toLabel(activeSpan.stage) + activeSpan.contextSuffix,
            activeSpan.startMark,
            endMark
        );
    }
    safeTimeStamp(endMark);

    activeSpans.delete(spanId);
}

export function timelineWrap<T>(
    stage: string,
    fn: () => Promise<T>
): Promise<T> {
    const spanId = timelineSpanStart(stage);
    return fn().finally(() => {
        timelineSpanEnd(spanId);
    });
}

if (typeof window !== 'undefined') {
    window.timelineMark = timelineMark;
    window.timelineSpanStart = timelineSpanStart;
    window.timelineSpanEnd = timelineSpanEnd;
}
