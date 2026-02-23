const MARK_PREFIX = 'cp';

const activeSpans: Map<string, { stage: string; startMark: string }> =
    new Map();
let spanCounter = 0;

type TimelineDetail = Record<string, unknown>;

function toLabel(stage: string): string {
    return `${MARK_PREFIX}:${stage}`;
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

export function timelineMark(stage: string): void {
    const label = toLabel(stage);
    if (canMark()) {
        globalThis.performance.mark(label);
    }
    safeTimeStamp(label);
}

export function timelineSpanStart(
    stage: string,
    detail?: TimelineDetail
): string {
    spanCounter += 1;
    const spanId = `${stage}#${spanCounter}`;
    const startMark = toLabel(`${spanId}:start`);

    activeSpans.set(spanId, { stage, startMark });
    if (canMark()) {
        if (detail !== undefined) {
            globalThis.performance.mark(startMark, { detail });
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

    const endMark = toLabel(`${spanId}:end`);
    if (canMark()) {
        globalThis.performance.mark(endMark);
    }
    if (canMeasure()) {
        globalThis.performance.measure(
            toLabel(activeSpan.stage),
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
