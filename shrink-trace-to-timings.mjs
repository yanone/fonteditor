#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const METADATA_EVENT_NAMES = new Set([
    "thread_name",
    "process_name",
    "process_uptime_seconds",
]);
const ALWAYS_KEEP_CATEGORIES = new Set(["blink.user_timing"]);
const NAVIGATION_CATEGORIES = new Set(["loading", "navigation"]);
const TIMING_NAME_PATTERNS = [
    /^cp:/,
    /^font\./,
    /^fontCompilation\./,
    /^font\.lifecycle\./,
    /^overview\./,
    /^canvas\./,
    /^app\./,
    /^UserTiming::/,
    /^TimeStamp$/,
    /^V8Console::TimeStamp$/,
    /largest.?contentful.?paint/i,
    /first.?contentful.?paint/i,
    /first.?paint/i,
    /domcontentloaded/i,
    /^load$/i,
    /navigation/i,
    /interactive/i,
];

const MINIMAL_ARG_KEYS = new Set([
    "data",
    "name",
    "message",
    "frame",
    "navigationId",
    "navigationType",
    "nodeId",
    "nodeName",
    "url",
    "value",
]);

const MILESTONE_PATTERNS = [
    /^cp:/,
    /contentful.?paint/i,
    /largest.?contentful.?paint/i,
    /domcontentloaded/i,
    /^load$/i,
    /navigation/i,
    /^TimeStamp$/,
    /^V8Console::TimeStamp$/,
    /^UserTiming::/,
    /interactive/i,
];

function printUsage() {
    console.log(
        "Usage: node shrink-trace-to-timings.mjs [--llm|--summary|--handoff] <input.json> [output.json]\n" +
            "Example: node shrink-trace-to-timings.mjs temp/Trace-20260222T095246.json",
    );
}

function parseArgs(argv) {
    const args = argv.slice(2);
    const llmMode = args.includes("--llm");
    const summaryMode = args.includes("--summary");
    const handoffMode = args.includes("--handoff");
    const positional = args.filter(
        (arg) => arg !== "--llm" && arg !== "--summary" && arg !== "--handoff",
    );
    return {
        llmMode,
        summaryMode,
        handoffMode,
        inputArg: positional[0],
        outputArg: positional[1],
    };
}

function splitCategories(cat) {
    return String(cat || "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function isTimingsEvent(event) {
    if (!event || typeof event !== "object") {
        return false;
    }

    if (
        event.ph === "M" &&
        METADATA_EVENT_NAMES.has(String(event.name || ""))
    ) {
        return true;
    }

    const categories = splitCategories(event.cat);
    if (categories.some((category) => ALWAYS_KEEP_CATEGORIES.has(category))) {
        return true;
    }

    const eventName = String(event.name || "");
    if (TIMING_NAME_PATTERNS.some((pattern) => pattern.test(eventName))) {
        return true;
    }

    return categories.some((category) => NAVIGATION_CATEGORIES.has(category));
}

function pickMinimalArgs(args) {
    if (!args || typeof args !== "object") {
        return undefined;
    }

    const reducedArgs = {};
    for (const [key, value] of Object.entries(args)) {
        if (MINIMAL_ARG_KEYS.has(key)) {
            reducedArgs[key] = value;
        }
    }

    return Object.keys(reducedArgs).length > 0 ? reducedArgs : undefined;
}

function projectEventForLlm(event) {
    const { baseName, context } = parseMarkerNameContext(event.name);
    const projected = {
        ts: event.ts,
        name: baseName,
        ph: event.ph,
        cat: event.cat,
    };

    if (event.dur !== undefined) {
        projected.dur = event.dur;
    }

    if (event.pid !== undefined) {
        projected.pid = event.pid;
    }

    if (event.tid !== undefined) {
        projected.tid = event.tid;
    }

    const minimalArgs = pickMinimalArgs(event.args);
    if (minimalArgs) {
        projected.args = minimalArgs;
    }

    if (context.process) {
        projected.process = context.process;
    }
    if (context.traceId) {
        projected.traceId = context.traceId;
    }
    if (context.parentSpanId) {
        projected.parentSpanId = context.parentSpanId;
    }
    if (context.requestId) {
        projected.requestId = context.requestId;
    }
    if (context.fontRevisionKey) {
        projected.fontRevisionKey = context.fontRevisionKey;
    }

    return projected;
}

function parseMarkerNameContext(rawName) {
    const text = String(rawName || "");
    const [baseName, ...parts] = text.split("|");
    const context = {};

    for (const part of parts) {
        const separatorIndex = part.indexOf("=");
        if (separatorIndex <= 0) {
            continue;
        }

        const key = part.slice(0, separatorIndex).trim();
        const value = part.slice(separatorIndex + 1).trim();
        if (!value) {
            continue;
        }

        if (key === "proc") {
            context.process = value;
        } else if (key === "trace") {
            context.traceId = value;
        } else if (key === "parent") {
            context.parentSpanId = value;
        } else if (key === "req") {
            context.requestId = value;
        } else if (key === "rev") {
            context.fontRevisionKey = value;
        }
    }

    return {
        baseName,
        context,
    };
}

function getEventContext(event) {
    const { context } = parseMarkerNameContext(event.name);
    const process =
        context.process ||
        (event.pid !== undefined ? `pid:${String(event.pid)}` : "unknown");
    const traceId =
        context.traceId ||
        (event.pid !== undefined || event.tid !== undefined
            ? `pid:${String(event.pid ?? "na")}:tid:${String(event.tid ?? "na")}`
            : "unscoped");

    return {
        process,
        traceId,
        parentSpanId: context.parentSpanId,
        requestId: context.requestId,
        fontRevisionKey: context.fontRevisionKey,
    };
}

function round(value, digits = 2) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function addCount(map, key, amount = 1) {
    map.set(key, (map.get(key) || 0) + amount);
}

function topEntries(map, limit, mapper) {
    return [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([key, value]) => mapper(key, value));
}

function buildTraceGroups(events, startTs) {
    const grouped = new Map();

    for (const event of events) {
        const { process, traceId } = getEventContext(event);
        let processEntry = grouped.get(process);
        if (!processEntry) {
            processEntry = new Map();
            grouped.set(process, processEntry);
        }

        let traceEntry = processEntry.get(traceId);
        if (!traceEntry) {
            traceEntry = {
                eventCount: 0,
                firstTs: Number.POSITIVE_INFINITY,
                lastTs: Number.NEGATIVE_INFINITY,
                names: new Map(),
            };
            processEntry.set(traceId, traceEntry);
        }

        traceEntry.eventCount += 1;
        if (typeof event.ts === "number") {
            traceEntry.firstTs = Math.min(traceEntry.firstTs, event.ts);
            traceEntry.lastTs = Math.max(
                traceEntry.lastTs,
                event.ts + (event.dur || 0),
            );
        }

        const { baseName } = parseMarkerNameContext(event.name);
        addCount(traceEntry.names, baseName || String(event.name || ""));
    }

    return [...grouped.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([process, traces]) => ({
            process,
            traces: [...traces.entries()]
                .map(([traceId, entry]) => ({
                    traceId,
                    eventCount: entry.eventCount,
                    firstTsUs: Number.isFinite(entry.firstTs)
                        ? entry.firstTs
                        : null,
                    lastTsUs: Number.isFinite(entry.lastTs)
                        ? entry.lastTs
                        : null,
                    durationMs:
                        Number.isFinite(entry.firstTs) &&
                        Number.isFinite(entry.lastTs)
                            ? round((entry.lastTs - entry.firstTs) / 1000, 3)
                            : null,
                    firstMsFromStart: Number.isFinite(entry.firstTs)
                        ? round((entry.firstTs - startTs) / 1000, 3)
                        : null,
                    topNames: topEntries(entry.names, 8, (name, count) => ({
                        name,
                        count,
                    })),
                }))
                .sort((a, b) => b.eventCount - a.eventCount),
        }));
}

function isMilestoneEvent(event) {
    const name = String(event.name || "");
    if (MILESTONE_PATTERNS.some((pattern) => pattern.test(name))) {
        return true;
    }

    const categories = splitCategories(event.cat);
    return categories.some(
        (category) =>
            category === "blink.user_timing" || category === "navigation",
    );
}

function buildSummary(filteredEvents, inputPath, metadata) {
    const eventsWithTs = filteredEvents.filter(
        (event) => typeof event.ts === "number",
    );
    const startTs =
        eventsWithTs.length > 0
            ? Math.min(...eventsWithTs.map((event) => event.ts))
            : 0;
    const endTs =
        eventsWithTs.length > 0
            ? Math.max(
                  ...eventsWithTs.map((event) => event.ts + (event.dur || 0)),
              )
            : 0;
    const totalDurationUs = Math.max(0, endTs - startTs);

    const byCategory = new Map();
    const byName = new Map();
    const durationsByName = new Map();
    const timelineBuckets = new Map();
    const bucketSizeUs = 100_000;

    for (const event of filteredEvents) {
        addCount(byCategory, String(event.cat || ""));
        addCount(byName, String(event.name || ""));

        if (typeof event.dur === "number" && event.dur > 0) {
            const name = String(event.name || "");
            const entry = durationsByName.get(name) || {
                count: 0,
                totalDurUs: 0,
                maxDurUs: 0,
            };
            entry.count += 1;
            entry.totalDurUs += event.dur;
            entry.maxDurUs = Math.max(entry.maxDurUs, event.dur);
            durationsByName.set(name, entry);
        }

        if (typeof event.ts === "number") {
            const bucket = Math.floor((event.ts - startTs) / bucketSizeUs);
            const bucketEntry = timelineBuckets.get(bucket) || {
                eventCount: 0,
                totalDurationUs: 0,
            };
            bucketEntry.eventCount += 1;
            bucketEntry.totalDurationUs +=
                typeof event.dur === "number" ? event.dur : 0;
            timelineBuckets.set(bucket, bucketEntry);
        }
    }

    const milestones = filteredEvents
        .filter(isMilestoneEvent)
        .filter((event) => typeof event.ts === "number")
        .sort((a, b) => a.ts - b.ts)
        .slice(0, 200)
        .map((event) => ({
            name: String(event.name || ""),
            cat: String(event.cat || ""),
            ph: String(event.ph || ""),
            tsUs: event.ts,
            tMsFromStart: round((event.ts - startTs) / 1000, 3),
            durUs: typeof event.dur === "number" ? event.dur : undefined,
        }));

    const topMeasures = [...durationsByName.entries()]
        .sort((a, b) => b[1].totalDurUs - a[1].totalDurUs)
        .slice(0, 40)
        .map(([name, entry]) => ({
            name,
            count: entry.count,
            totalDurUs: Math.round(entry.totalDurUs),
            avgDurUs: Math.round(entry.totalDurUs / Math.max(1, entry.count)),
            maxDurUs: Math.round(entry.maxDurUs),
        }));

    const categoryCounts = topEntries(byCategory, 30, (cat, count) => ({
        cat,
        count,
    }));
    const nameCounts = topEntries(byName, 50, (name, count) => ({
        name,
        count,
    }));
    const timeline = [...timelineBuckets.entries()]
        .sort((a, b) => a[0] - b[0])
        .slice(0, 500)
        .map(([bucket, entry]) => ({
            bucketStartMs: bucket * 100,
            eventCount: entry.eventCount,
            totalDurationUs: Math.round(entry.totalDurationUs),
        }));

    return {
        mode: "summary",
        source: inputPath,
        metadata,
        stats: {
            filteredEvents: filteredEvents.length,
            startTsUs: startTs,
            endTsUs: endTs,
            totalDurationUs,
            totalDurationMs: round(totalDurationUs / 1000, 3),
        },
        milestones,
        topMeasures,
        categoryCounts,
        nameCounts,
        timeline,
        traceGroups: buildTraceGroups(filteredEvents, startTs),
    };
}

function toMsFromStart(ts, startTs) {
    return round((ts - startTs) / 1000, 3);
}

function percentile(values, ratio) {
    if (!values.length) {
        return null;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.floor(ratio * (sorted.length - 1))),
    );
    return sorted[index];
}

function computePearsonCorrelation(valuesA, valuesB) {
    if (
        !Array.isArray(valuesA) ||
        !Array.isArray(valuesB) ||
        valuesA.length !== valuesB.length ||
        valuesA.length < 2
    ) {
        return null;
    }

    const meanA =
        valuesA.reduce((sum, value) => sum + value, 0) / valuesA.length;
    const meanB =
        valuesB.reduce((sum, value) => sum + value, 0) / valuesB.length;
    const deviationsA = valuesA.map((value) => value - meanA);
    const deviationsB = valuesB.map((value) => value - meanB);
    const numerator = deviationsA.reduce(
        (sum, deviationA, index) => sum + deviationA * deviationsB[index],
        0,
    );
    const denominator = Math.sqrt(
        deviationsA.reduce((sum, value) => sum + value * value, 0) *
            deviationsB.reduce((sum, value) => sum + value * value, 0),
    );

    if (!Number.isFinite(denominator) || denominator === 0) {
        return null;
    }

    return numerator / denominator;
}

function summarizeNumericValues(values) {
    if (!values.length) {
        return null;
    }

    return {
        count: values.length,
        avg: round(
            values.reduce((sum, value) => sum + value, 0) / values.length,
            3,
        ),
        min: round(Math.min(...values), 3),
        max: round(Math.max(...values), 3),
    };
}

function canonicalTimingName(rawName) {
    let normalized = String(rawName || "").trim();
    normalized = normalized.split("|")[0];
    if (normalized.startsWith("cp:")) {
        normalized = normalized.slice(3);
    }
    normalized = normalized.replace(/#[0-9]+:(start|end)$/u, "");
    return normalized;
}

function collectNamedEvents(events, names) {
    return events.filter((event) =>
        names.has(canonicalTimingName(String(event.name || ""))),
    );
}

function buildCompileRenderHandoff(filteredEvents, inputPath, metadata) {
    const events = filteredEvents
        .filter((event) => typeof event.ts === "number")
        .sort((a, b) => a.ts - b.ts);

    const userTimingEvents = events.filter((event) =>
        splitCategories(event.cat).includes("blink.user_timing"),
    );
    const startTs =
        userTimingEvents.length > 0
            ? userTimingEvents[0].ts
            : events.length > 0
              ? events[0].ts
              : 0;

    const compileSuccessNames = new Set([
        "font.worker.compileEditingCached.success",
        "font.worker.compile.success",
        "font.worker.legacyCompile.success",
    ]);

    const renderMilestoneNames = new Set([
        "font.lifecycle.editingCompileComplete",
        "font.lifecycle.canvasInitialReady",
        "font.lifecycle.overviewInitialRenderComplete",
        "canvas.initialZoomComplete",
        "overview.renderGlyphOutlines",
        "overview.outlines.renderBatchFrame",
        "font.lifecycle.startupReleased",
        "canvas.render.completed",
        "canvas.compileRepaint.completed",
    ]);

    const compileDispatchNames = new Set([
        "font.compileEditing.dispatchEvent.editingFontCompiled",
        "font.compileEditing.dispatchEvent.editingFontCompiled.done",
    ]);

    const shapeAndRepaintNames = new Set([
        "canvas.editingFontCompiled.received",
        "canvas.editingFontCompiled.fontApplied",
        "canvas.editingFontCompiled.shapeTextForced",
        "canvas.compileRepaint.requested",
        "canvas.compileRepaint.completed",
        "canvas.render.completed",
        "canvas.editingFontCompiled.skippedOutOfOrderRevision",
        "canvas.editingFontCompiled.skippedMissingData",
        "canvas.editingFontCompiled.applyFailed",
        "canvas.compileRepaint.timeout",
    ]);

    const lifecyclePhaseNames = new Set([
        "font.lifecycle.fontLoaded",
        "font.lifecycle.storeFontJsonComplete",
        "font.lifecycle.loadFontComplete",
        "font.lifecycle.fontReadyDispatched",
        "font.lifecycle.onOpenedComplete",
        "font.lifecycle.editingCompileStart",
        "font.lifecycle.editingCompileComplete",
        "font.lifecycle.canvasInitialReady",
        "font.lifecycle.overviewInitialRenderComplete",
        "font.lifecycle.startup-ready-timeout-waiting",
        "font.lifecycle.startupReleased",
    ]);

    const compileSuccesses = collectNamedEvents(events, compileSuccessNames);
    const renderMilestones = collectNamedEvents(events, renderMilestoneNames);
    const compileDispatchEvents = collectNamedEvents(
        events,
        compileDispatchNames,
    );
    const shapeAndRepaintEvents = collectNamedEvents(
        events,
        shapeAndRepaintNames,
    );
    const lifecyclePhases = collectNamedEvents(events, lifecyclePhaseNames);

    const wasmClosurePhasePattern =
        /^cp:wasm:compile_cached_font_from_last_layout_closure\.([^#]+)#(\d+):(start|end)$/;
    const wasmClosurePhaseEvents = events
        .map((event) => {
            const { baseName } = parseMarkerNameContext(event.name);
            const match = String(baseName || "").match(wasmClosurePhasePattern);
            if (!match) {
                return null;
            }

            return {
                tsUs: event.ts,
                phaseName: match[1],
                phaseId: Number(match[2]),
                side: match[3],
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.tsUs - b.tsUs);

    // Generic extractor for any cp:wasm:<prefix>.<subphase>#<id>:(start|end) pattern.
    // Returns sorted array of {tsUs, phaseName, phaseId, side} for a given prefix.
    function extractWasmPhaseEvents(prefix) {
        const re = new RegExp(
            `^cp:wasm:${prefix.replace(/\./g, "\\.")}(?:\\.([^#]+))?#(\\d+):(start|end)$`,
        );
        return events
            .map((event) => {
                const { baseName } = parseMarkerNameContext(event.name);
                const match = String(baseName || "").match(re);
                if (!match) return null;
                return {
                    tsUs: event.ts,
                    phaseName: match[1] ?? "total",
                    phaseId: Number(match[2]),
                    side: match[3],
                };
            })
            .filter(Boolean)
            .sort((a, b) => a.tsUs - b.tsUs);
    }

    // Build a map of phaseId→{startUs, endUs} for a flat list of phase events.
    function buildPhaseMap(phaseEvents) {
        const map = new Map(); // phaseId → {startUs, endUs, phaseName}
        for (const ev of phaseEvents) {
            if (!map.has(ev.phaseId)) {
                map.set(ev.phaseId, {
                    phaseName: ev.phaseName,
                    startUs: null,
                    endUs: null,
                });
            }
            const entry = map.get(ev.phaseId);
            if (ev.side === "start") entry.startUs = ev.tsUs;
            else entry.endUs = ev.tsUs;
        }
        return map;
    }

    // Collect completed (start+end) intervals from a phase map, keyed by phaseName.
    // When multiple intervals share a phaseName, keep the one matching a given
    // totalId bracket; otherwise take the first complete one.
    function collectIntervals(phaseMap) {
        const byName = new Map();
        for (const [phaseId, entry] of phaseMap) {
            if (entry.startUs === null || entry.endUs === null) continue;
            const name = entry.phaseName;
            if (!byName.has(name)) byName.set(name, []);
            byName
                .get(name)
                .push({ phaseId, startUs: entry.startUs, endUs: entry.endUs });
        }
        return byName;
    }

    // Extract store_font runs (total + sub-phases)
    const storeFontPhaseEvents = extractWasmPhaseEvents("store_font");
    const storeFontPhaseMap = buildPhaseMap(storeFontPhaseEvents);
    const storeFontByName = collectIntervals(storeFontPhaseMap);
    const storeFontTotals = (storeFontByName.get("total") || []).sort(
        (a, b) => a.startUs - b.startUs,
    );

    // Extract prime_layout_closure_cache runs (and sub-phases of layout_closure_cached)
    const primeClosurePhaseEvents = extractWasmPhaseEvents(
        "prime_layout_closure_cache",
    );
    const primeClosurePhaseMap = buildPhaseMap(primeClosurePhaseEvents);
    const primeClosureByName = collectIntervals(primeClosurePhaseMap);
    const primeClosureTotals = (primeClosureByName.get("total") || []).sort(
        (a, b) => a.startUs - b.startUs,
    );

    // Extract layout_closure_cached sub-phases (close_layout, component_deps, etc.)
    const closureCachedEvents = extractWasmPhaseEvents("layout_closure_cached");
    const closureCachedPhaseMap = buildPhaseMap(closureCachedEvents);
    const closureCachedByName = collectIntervals(closureCachedPhaseMap);
    // Key sub-phase names we care about (our A-phase benchmarks)
    const closeLayoutIntervals = (
        closureCachedByName.get("compute.close_layout") || []
    ).sort((a, b) => a.startUs - b.startUs);
    const componentDepsIntervals = (
        closureCachedByName.get("normalize.component_deps") || []
    ).sort((a, b) => a.startUs - b.startUs);
    const feaPipelineIntervals = (
        closureCachedByName.get("apply_filters.fea_parse_pipeline") || []
    ).sort((a, b) => a.startUs - b.startUs);

    // Helper: find the interval in a sorted list whose time window overlaps [winStart, winEnd]
    // and was consumed most recently before winEnd; returns the first hit.
    function findIntervalBefore(sortedIntervals, winStart, winEnd) {
        for (const iv of sortedIntervals) {
            if (iv.startUs >= winStart && iv.endUs <= winEnd) return iv;
        }
        return null;
    }

    // Build compile-cycle associations by walking WASM runs and correlated
    // store_font / prime_closure intervals in chronological order.
    // For each compile_cached run we pick the immediately-preceding interval
    // from each ancillary list (consuming it so it won't match again).
    function buildCompileCycleMap(compileCachedRuns, ancillaryIntervals) {
        // ancillaryIntervals: [{startUs, endUs}] sorted ascending
        const result = new Map(); // runIndex (1-based) → interval or null
        let ancillaryIdx = 0;
        for (const run of compileCachedRuns) {
            // The run starts at run.startUs; any ancillary that ended at or
            // before that point and hasn't been consumed belongs to this run.
            const preceding = [];
            while (
                ancillaryIdx < ancillaryIntervals.length &&
                ancillaryIntervals[ancillaryIdx].endUs <= run.startUs + 5000 // 5ms slack
            ) {
                preceding.push(ancillaryIntervals[ancillaryIdx]);
                ancillaryIdx++;
            }
            // The closest preceding interval (last one in the list)
            result.set(
                run.runIndex ?? run.totalPhaseId,
                preceding.length ? preceding[preceding.length - 1] : null,
            );
        }
        return result;
    }

    const openTotalStack = [];
    const rawWasmClosureRuns = [];

    for (const phaseEvent of wasmClosurePhaseEvents) {
        if (phaseEvent.phaseName === "total" && phaseEvent.side === "start") {
            openTotalStack.push({
                totalPhaseId: phaseEvent.phaseId,
                startUs: phaseEvent.tsUs,
                endUs: null,
                phaseEvents: [],
            });
            continue;
        }

        if (phaseEvent.phaseName === "total" && phaseEvent.side === "end") {
            const openRun = openTotalStack.pop();
            if (openRun) {
                openRun.endUs = phaseEvent.tsUs;
                rawWasmClosureRuns.push(openRun);
            }
            continue;
        }

        if (openTotalStack.length > 0) {
            openTotalStack[openTotalStack.length - 1].phaseEvents.push(
                phaseEvent,
            );
        }
    }

    // Cursor-based consumption for ancillary intervals.
    // Intervals are sorted ascending by endUs. For each compile run (processed
    // chronologically) we advance the cursor past all intervals whose endUs is
    // strictly before run.startUs, keeping the most-recently-consumed one.
    // This ensures each store_font/prime_closure call is attributed to exactly
    // one compile run — the first run that starts after the interval ends.
    let storeFontCursor = 0;
    let primeClosureCursor = 0;
    let closeLayoutCursor = 0;
    let componentDepsCursor = 0;
    let feaPipelineCursor = 0;

    // Ensure runs are in chronological start order before cursor sweep
    rawWasmClosureRuns.sort((a, b) => (a.startUs ?? 0) - (b.startUs ?? 0));

    let wasmClosureRuns = rawWasmClosureRuns
        .map((run, index) => {
            if (!run.startUs || !run.endUs) {
                return null;
            }

            const phases = new Map();
            for (const phaseEvent of run.phaseEvents) {
                let phaseEntry = phases.get(phaseEvent.phaseName);
                if (!phaseEntry) {
                    phaseEntry = { startUs: null, endUs: null, phaseId: null };
                    phases.set(phaseEvent.phaseName, phaseEntry);
                }

                if (phaseEntry.phaseId === null) {
                    phaseEntry.phaseId = phaseEvent.phaseId;
                }

                if (phaseEvent.side === "start") {
                    phaseEntry.startUs = phaseEvent.tsUs;
                } else if (phaseEntry.phaseId === phaseEvent.phaseId) {
                    phaseEntry.endUs = phaseEvent.tsUs;
                }
            }

            const irCompile = phases.get("ir_compile");
            if (!irCompile?.startUs || !irCompile?.endUs) {
                return null;
            }

            const buildPhase = (phaseName) => {
                const phase = phases.get(phaseName);
                if (!phase?.startUs || !phase?.endUs) {
                    return null;
                }

                return {
                    phaseId: phase.phaseId,
                    startUs: phase.startUs,
                    endUs: phase.endUs,
                    durationMs: round((phase.endUs - phase.startUs) / 1000, 3),
                    startMsFromStart: toMsFromStart(phase.startUs, startTs),
                    endMsFromStart: toMsFromStart(phase.endUs, startTs),
                };
            };

            const totalPhase = {
                phaseId: run.totalPhaseId,
                startUs: run.startUs,
                endUs: run.endUs,
                durationMs: round((run.endUs - run.startUs) / 1000, 3),
                startMsFromStart: toMsFromStart(run.startUs, startTs),
                endMsFromStart: toMsFromStart(run.endUs, startTs),
            };
            const irCompilePhase = buildPhase("ir_compile");
            const cacheReadPhase = buildPhase("cache_read");
            const preparedSubsetLookupPhase = buildPhase(
                "prepared_subset_lookup",
            );
            const patchDirtyGlyphsPhase = buildPhase("patch_dirty_glyphs");
            const fetchLastClosurePhase = buildPhase("fetch_last_closure");
            const fetchClosureSubsetPhase = buildPhase("fetch_closure_subset");
            const postIrCompilePhase = buildPhase("post_ir_compile");

            const preIrCompileMs = round(
                (irCompile.startUs - run.startUs) / 1000,
                3,
            );
            const postIrCompileTailMs = round(
                (run.endUs - irCompile.endUs) / 1000,
                3,
            );

            // Correlate store_font and prime_layout_closure_cache to this compile
            // run using cursor-based consumption. The cursors advance chronologically
            // so each ancillary interval is attributed to exactly ONE compile run.
            const advanceCursor = (list, cursorVal) => {
                let idx = cursorVal;
                while (
                    idx < list.length &&
                    list[idx].endUs <= run.startUs + 5000
                ) {
                    idx++;
                }
                return {
                    newCursor: idx,
                    lastConsumed: idx > cursorVal ? list[idx - 1] : null,
                };
            };

            const sfResult = advanceCursor(storeFontTotals, storeFontCursor);
            storeFontCursor = sfResult.newCursor;
            const storeFontIv = sfResult.lastConsumed;

            const pcResult = advanceCursor(
                primeClosureTotals,
                primeClosureCursor,
            );
            primeClosureCursor = pcResult.newCursor;
            const primeClosureIv = pcResult.lastConsumed;

            // Sub-phases of prime_layout_closure: correlate within the prime-closure window
            const clResult = advanceCursor(
                closeLayoutIntervals,
                closeLayoutCursor,
            );
            closeLayoutCursor = clResult.newCursor;
            const closeLayoutIv = clResult.lastConsumed;

            const cdResult = advanceCursor(
                componentDepsIntervals,
                componentDepsCursor,
            );
            componentDepsCursor = cdResult.newCursor;
            const componentDepsIv = cdResult.lastConsumed;

            const fpResult = advanceCursor(
                feaPipelineIntervals,
                feaPipelineCursor,
            );
            feaPipelineCursor = fpResult.newCursor;
            const feaPipelineIv = fpResult.lastConsumed;

            const makeTiming = (iv) =>
                iv
                    ? {
                          durationMs: round((iv.endUs - iv.startUs) / 1000, 3),
                          startMsFromStart: toMsFromStart(iv.startUs, startTs),
                          endMsFromStart: toMsFromStart(iv.endUs, startTs),
                      }
                    : null;

            return {
                runIndex: index + 1,
                total: totalPhase,
                irCompile: irCompilePhase,
                cacheRead: cacheReadPhase,
                preparedSubsetLookup: preparedSubsetLookupPhase,
                patchDirtyGlyphs: patchDirtyGlyphsPhase,
                fetchLastClosure: fetchLastClosurePhase,
                fetchClosureSubset: fetchClosureSubsetPhase,
                postIrCompile: postIrCompilePhase,
                preIrCompileMs,
                postIrCompileTailMs,
                irCompileShareOfTotalPct: round(
                    (irCompilePhase.durationMs / totalPhase.durationMs) * 100,
                    2,
                ),
                // Per-compile context: store_font and layout-closure phases
                storeFontMs: makeTiming(storeFontIv),
                primeLayoutClosureMs: makeTiming(primeClosureIv),
                closeLayoutMs: makeTiming(closeLayoutIv),
                componentDepsMs: makeTiming(componentDepsIv),
                feaParsePipelineMs: makeTiming(feaPipelineIv),
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.runIndex - b.runIndex);

    let wasmClosurePhaseSource = "hash-markers";
    if (wasmClosureRuns.length === 0) {
        const totalMeasureName =
            "wasm:compile_cached_font_from_last_layout_closure.total";
        const totalMeasureEvents = events
            .filter((event) => {
                if (typeof event.ts !== "number") {
                    return false;
                }

                if (typeof event.dur !== "number" || event.dur <= 0) {
                    return false;
                }

                return (
                    canonicalTimingName(String(event.name || "")) ===
                    totalMeasureName
                );
            })
            .sort((a, b) => a.ts - b.ts);

        if (totalMeasureEvents.length > 0) {
            wasmClosurePhaseSource = "measure-total-only";
            wasmClosureRuns = totalMeasureEvents.map((event, index) => {
                const endUs = event.ts + event.dur;
                return {
                    runIndex: index + 1,
                    total: {
                        phaseId: null,
                        startUs: event.ts,
                        endUs,
                        durationMs: round(event.dur / 1000, 3),
                        startMsFromStart: toMsFromStart(event.ts, startTs),
                        endMsFromStart: toMsFromStart(endUs, startTs),
                    },
                    irCompile: null,
                    cacheRead: null,
                    preparedSubsetLookup: null,
                    patchDirtyGlyphs: null,
                    fetchLastClosure: null,
                    fetchClosureSubset: null,
                    postIrCompile: null,
                    preIrCompileMs: null,
                    postIrCompileTailMs: null,
                    irCompileShareOfTotalPct: null,
                };
            });
        } else {
            wasmClosurePhaseSource = "none";
        }
    }

    const runsWithTail = wasmClosureRuns.filter(
        (run) => typeof run.postIrCompileTailMs === "number",
    );
    const runsWithIr = wasmClosureRuns.filter(
        (run) => run.irCompile && typeof run.irCompile.durationMs === "number",
    );
    const runsWithPre = wasmClosureRuns.filter(
        (run) => typeof run.preIrCompileMs === "number",
    );

    const wasmTailValues = runsWithTail.map((run) => run.postIrCompileTailMs);
    const wasmPreValues = runsWithPre.map((run) => run.preIrCompileMs);
    const wasmIrValues = runsWithIr.map((run) => run.irCompile.durationMs);
    const wasmTotalValues = wasmClosureRuns.map((run) => run.total.durationMs);

    const wasmClosureTailSummary = wasmClosureRuns.length
        ? {
              runCount: wasmClosureRuns.length,
              phaseSource: wasmClosurePhaseSource,
              hasSubphaseBreakdown: wasmTailValues.length > 0,
              avgTailMs:
                  wasmTailValues.length > 0
                      ? round(
                            wasmTailValues.reduce(
                                (sum, value) => sum + value,
                                0,
                            ) / wasmTailValues.length,
                            3,
                        )
                      : null,
              p50TailMs:
                  wasmTailValues.length > 0
                      ? percentile(wasmTailValues, 0.5)
                      : null,
              p90TailMs:
                  wasmTailValues.length > 0
                      ? percentile(wasmTailValues, 0.9)
                      : null,
              minTailMs:
                  wasmTailValues.length > 0
                      ? Math.min(...wasmTailValues)
                      : null,
              maxTailMs:
                  wasmTailValues.length > 0
                      ? Math.max(...wasmTailValues)
                      : null,
              avgPreIrCompileMs:
                  wasmPreValues.length > 0
                      ? round(
                            wasmPreValues.reduce(
                                (sum, value) => sum + value,
                                0,
                            ) / wasmPreValues.length,
                            3,
                        )
                      : null,
              avgIrCompileMs:
                  wasmIrValues.length > 0
                      ? round(
                            wasmIrValues.reduce(
                                (sum, value) => sum + value,
                                0,
                            ) / wasmIrValues.length,
                            3,
                        )
                      : null,
              avgTotalMs: round(
                  wasmTotalValues.reduce((sum, value) => sum + value, 0) /
                      wasmTotalValues.length,
                  3,
              ),
              notes:
                  wasmClosurePhaseSource === "measure-total-only"
                      ? "Trace contains only total measure events for compile_cached_font_from_last_layout_closure; subphase breakdown (ir_compile/post_ir_compile) is unavailable in this capture."
                      : null,
          }
        : null;

    const numericRunValue = (run, key) =>
        typeof run[key] === "number" ? run[key] : null;
    const numericPhaseDuration = (run, key) => {
        if (!run[key] || typeof run[key] !== "object") {
            return null;
        }

        const duration = run[key].durationMs;
        return typeof duration === "number" ? duration : null;
    };
    const collectRunValues = (key) =>
        wasmClosureRuns
            .map((run) => numericRunValue(run, key))
            .filter((value) => value !== null);
    const collectPhaseDurations = (key) =>
        wasmClosureRuns
            .map((run) => numericPhaseDuration(run, key))
            .filter((value) => value !== null);

    const pairwiseValues = {
        tailVsPostIr: [],
        tailVsCacheRead: [],
        tailVsPreparedSubsetLookup: [],
    };

    for (const run of wasmClosureRuns) {
        const tail = numericRunValue(run, "postIrCompileTailMs");
        const postIr = numericPhaseDuration(run, "postIrCompile");
        const cacheRead = numericPhaseDuration(run, "cacheRead");
        const preparedSubsetLookup = numericPhaseDuration(
            run,
            "preparedSubsetLookup",
        );

        if (tail !== null && postIr !== null) {
            pairwiseValues.tailVsPostIr.push([tail, postIr]);
        }
        if (tail !== null && cacheRead !== null) {
            pairwiseValues.tailVsCacheRead.push([tail, cacheRead]);
        }
        if (tail !== null && preparedSubsetLookup !== null) {
            pairwiseValues.tailVsPreparedSubsetLookup.push([
                tail,
                preparedSubsetLookup,
            ]);
        }
    }

    const tailVsPostIrDiffs = pairwiseValues.tailVsPostIr.map(
        ([tail, postIr]) => Math.abs(tail - postIr),
    );
    const extractLeft = (pairs) => pairs.map(([left]) => left);
    const extractRight = (pairs) => pairs.map(([, right]) => right);

    const wasmClosurePhaseAnalysis = wasmClosureRuns.length
        ? {
              runCount: wasmClosureRuns.length,
              scalarStats: {
                  preIrCompileMs: summarizeNumericValues(
                      collectRunValues("preIrCompileMs"),
                  ),
                  postIrCompileTailMs: summarizeNumericValues(
                      collectRunValues("postIrCompileTailMs"),
                  ),
              },
              phaseDurationStats: {
                  total: summarizeNumericValues(collectPhaseDurations("total")),
                  irCompile: summarizeNumericValues(
                      collectPhaseDurations("irCompile"),
                  ),
                  postIrCompile: summarizeNumericValues(
                      collectPhaseDurations("postIrCompile"),
                  ),
                  cacheRead: summarizeNumericValues(
                      collectPhaseDurations("cacheRead"),
                  ),
                  preparedSubsetLookup: summarizeNumericValues(
                      collectPhaseDurations("preparedSubsetLookup"),
                  ),
                  patchDirtyGlyphs: summarizeNumericValues(
                      collectPhaseDurations("patchDirtyGlyphs"),
                  ),
              },
              consistency: {
                  tailVsPostIr: {
                      pairCount: pairwiseValues.tailVsPostIr.length,
                      avgAbsDiffMs: tailVsPostIrDiffs.length
                          ? round(
                                tailVsPostIrDiffs.reduce(
                                    (sum, value) => sum + value,
                                    0,
                                ) / tailVsPostIrDiffs.length,
                                3,
                            )
                          : null,
                      maxAbsDiffMs: tailVsPostIrDiffs.length
                          ? round(Math.max(...tailVsPostIrDiffs), 3)
                          : null,
                  },
              },
              correlations: {
                  tailVsCacheRead: {
                      pairCount: pairwiseValues.tailVsCacheRead.length,
                      pearson: (() => {
                          const value = computePearsonCorrelation(
                              extractLeft(pairwiseValues.tailVsCacheRead),
                              extractRight(pairwiseValues.tailVsCacheRead),
                          );
                          return value === null ? null : round(value, 3);
                      })(),
                  },
                  tailVsPreparedSubsetLookup: {
                      pairCount:
                          pairwiseValues.tailVsPreparedSubsetLookup.length,
                      pearson: (() => {
                          const value = computePearsonCorrelation(
                              extractLeft(
                                  pairwiseValues.tailVsPreparedSubsetLookup,
                              ),
                              extractRight(
                                  pairwiseValues.tailVsPreparedSubsetLookup,
                              ),
                          );
                          return value === null ? null : round(value, 3);
                      })(),
                  },
              },
          }
        : null;

    const handoffWindows = compileSuccesses.map((compileEvent) => {
        const nextRender = renderMilestones.find(
            (event) => event.ts >= compileEvent.ts,
        );
        const deltaMs = nextRender
            ? round((nextRender.ts - compileEvent.ts) / 1000, 3)
            : null;

        return {
            compileEvent: {
                name: canonicalTimingName(String(compileEvent.name || "")),
                rawName: String(compileEvent.name || ""),
                tsUs: compileEvent.ts,
                tMsFromStart: toMsFromStart(compileEvent.ts, startTs),
            },
            nextRenderEvent: nextRender
                ? {
                      name: canonicalTimingName(String(nextRender.name || "")),
                      rawName: String(nextRender.name || ""),
                      tsUs: nextRender.ts,
                      tMsFromStart: toMsFromStart(nextRender.ts, startTs),
                  }
                : null,
            deltaMs,
            stalled: !nextRender || deltaMs > 2000,
        };
    });

    const compileToCanvasChains = compileDispatchEvents
        .filter(
            (event) =>
                canonicalTimingName(String(event.name || "")) ===
                "font.compileEditing.dispatchEvent.editingFontCompiled",
        )
        .map((dispatchEvent) => {
            const nextReceived = shapeAndRepaintEvents.find(
                (event) =>
                    event.ts >= dispatchEvent.ts &&
                    canonicalTimingName(String(event.name || "")) ===
                        "canvas.editingFontCompiled.received",
            );

            const nextShapeForced = nextReceived
                ? shapeAndRepaintEvents.find(
                      (event) =>
                          event.ts >= nextReceived.ts &&
                          canonicalTimingName(String(event.name || "")) ===
                              "canvas.editingFontCompiled.shapeTextForced",
                  )
                : null;

            const nextRepaintCompleted = nextReceived
                ? shapeAndRepaintEvents.find(
                      (event) =>
                          event.ts >= nextReceived.ts &&
                          (canonicalTimingName(String(event.name || "")) ===
                              "canvas.compileRepaint.completed" ||
                              canonicalTimingName(String(event.name || "")) ===
                                  "canvas.render.completed"),
                  )
                : null;

            return {
                dispatch: {
                    name: canonicalTimingName(String(dispatchEvent.name || "")),
                    tsUs: dispatchEvent.ts,
                    tMsFromStart: toMsFromStart(dispatchEvent.ts, startTs),
                },
                received: nextReceived
                    ? {
                          name: canonicalTimingName(
                              String(nextReceived.name || ""),
                          ),
                          tsUs: nextReceived.ts,
                          tMsFromStart: toMsFromStart(nextReceived.ts, startTs),
                          deltaFromDispatchMs: round(
                              (nextReceived.ts - dispatchEvent.ts) / 1000,
                              3,
                          ),
                      }
                    : null,
                shapeForced: nextShapeForced
                    ? {
                          name: canonicalTimingName(
                              String(nextShapeForced.name || ""),
                          ),
                          tsUs: nextShapeForced.ts,
                          tMsFromStart: toMsFromStart(
                              nextShapeForced.ts,
                              startTs,
                          ),
                          deltaFromDispatchMs: round(
                              (nextShapeForced.ts - dispatchEvent.ts) / 1000,
                              3,
                          ),
                      }
                    : null,
                repaintCompleted: nextRepaintCompleted
                    ? {
                          name: canonicalTimingName(
                              String(nextRepaintCompleted.name || ""),
                          ),
                          tsUs: nextRepaintCompleted.ts,
                          tMsFromStart: toMsFromStart(
                              nextRepaintCompleted.ts,
                              startTs,
                          ),
                          deltaFromDispatchMs: round(
                              (nextRepaintCompleted.ts - dispatchEvent.ts) /
                                  1000,
                              3,
                          ),
                      }
                    : null,
                completed:
                    !!nextReceived &&
                    !!nextShapeForced &&
                    !!nextRepaintCompleted,
            };
        });

    const lastCompile = compileSuccesses[compileSuccesses.length - 1];
    const startupReleased = lifecyclePhases.find(
        (event) =>
            canonicalTimingName(String(event.name || "")) ===
            "font.lifecycle.startupReleased",
    );
    const timeoutWaiting = lifecyclePhases.find(
        (event) =>
            canonicalTimingName(String(event.name || "")) ===
            "font.lifecycle.startup-ready-timeout-waiting",
    );
    const canvasReady = lifecyclePhases.find(
        (event) =>
            canonicalTimingName(String(event.name || "")) ===
            "font.lifecycle.canvasInitialReady",
    );
    const overviewReady = lifecyclePhases.find(
        (event) =>
            canonicalTimingName(String(event.name || "")) ===
            "font.lifecycle.overviewInitialRenderComplete",
    );

    let inferredBreakReason = "No compile→render handoff issue detected.";
    if (lastCompile && !startupReleased) {
        if (timeoutWaiting && !canvasReady && overviewReady) {
            inferredBreakReason =
                "Compile completed, but startup release timed out waiting for canvas readiness.";
        } else if (timeoutWaiting && canvasReady && !overviewReady) {
            inferredBreakReason =
                "Compile completed, but startup release timed out waiting for overview initial render.";
        } else if (timeoutWaiting && !canvasReady && !overviewReady) {
            inferredBreakReason =
                "Compile completed, but both canvas and overview readiness milestones are missing before startup timeout.";
        } else {
            inferredBreakReason =
                "Compile completed, but startup release milestone is missing; render-gate release likely blocked.";
        }
    }

    return {
        mode: "handoff",
        source: inputPath,
        metadata,
        stats: {
            filteredEvents: filteredEvents.length,
            compileSuccessCount: compileSuccesses.length,
            renderMilestoneCount: renderMilestones.length,
            lifecyclePhaseCount: lifecyclePhases.length,
            compileDispatchCount: compileDispatchEvents.length,
            shapeAndRepaintEventCount: shapeAndRepaintEvents.length,
            completedCompileToCanvasChains: compileToCanvasChains.filter(
                (chain) => chain.completed,
            ).length,
            wasmClosureRunCount: wasmClosureRuns.length,
            storeFontCallCount: storeFontTotals.length,
        },
        traceGroups: buildTraceGroups(events, startTs),
        inferredBreakReason,
        keyLifecycle: lifecyclePhases.map((event) => ({
            name: canonicalTimingName(String(event.name || "")),
            rawName: String(event.name || ""),
            tsUs: event.ts,
            tMsFromStart: toMsFromStart(event.ts, startTs),
        })),
        renderMilestones: renderMilestones.map((event) => ({
            name: canonicalTimingName(String(event.name || "")),
            rawName: String(event.name || ""),
            tsUs: event.ts,
            tMsFromStart: toMsFromStart(event.ts, startTs),
        })),
        shapeAndRepaintEvents: shapeAndRepaintEvents.map((event) => ({
            name: canonicalTimingName(String(event.name || "")),
            rawName: String(event.name || ""),
            tsUs: event.ts,
            tMsFromStart: toMsFromStart(event.ts, startTs),
        })),
        wasmClosureTailSummary,
        storeFontSummary: (() => {
            const durations = storeFontTotals
                .filter((iv) => iv.startUs !== null && iv.endUs !== null)
                .map((iv) => round((iv.endUs - iv.startUs) / 1000, 3));
            if (!durations.length) return null;
            return {
                callCount: durations.length,
                avgMs: round(
                    durations.reduce((s, v) => s + v, 0) / durations.length,
                    3,
                ),
                minMs: round(Math.min(...durations), 3),
                maxMs: round(Math.max(...durations), 3),
                totalMs: round(
                    durations.reduce((s, v) => s + v, 0),
                    3,
                ),
                note: "Each store_font call fully re-parses the font JSON. Ideally 0 or 1 per session (only on font load).",
            };
        })(),
        wasmClosurePhaseAnalysis,
        wasmClosureRuns,
        compileToCanvasChains,
        handoffWindows,
    };
}

function resolveOutputPath(inputPath, outputArg, mode) {
    if (outputArg) {
        return path.resolve(outputArg);
    }

    const parsed = path.parse(inputPath);
    const extension = parsed.ext || ".json";
    if (mode === "summary") {
        return path.join(
            parsed.dir,
            `${parsed.name}.timings.summary${extension}`,
        );
    }

    if (mode === "handoff") {
        return path.join(
            parsed.dir,
            `${parsed.name}.timings.handoff${extension}`,
        );
    }

    if (mode === "llm") {
        return path.join(parsed.dir, `${parsed.name}.timings.llm${extension}`);
    }

    return path.join(parsed.dir, `${parsed.name}.timings${extension}`);
}

function main() {
    const { llmMode, summaryMode, handoffMode, inputArg, outputArg } =
        parseArgs(process.argv);
    if (!inputArg) {
        printUsage();
        process.exitCode = 1;
        return;
    }

    const modeFlagCount = [llmMode, summaryMode, handoffMode].filter(
        Boolean,
    ).length;
    if (modeFlagCount > 1) {
        console.error(
            "Use only one mode flag: --llm, --summary, or --handoff.",
        );
        process.exitCode = 1;
        return;
    }

    const mode = handoffMode
        ? "handoff"
        : summaryMode
          ? "summary"
          : llmMode
            ? "llm"
            : "default";

    const inputPath = path.resolve(inputArg);
    const outputPath = resolveOutputPath(inputPath, outputArg, mode);

    if (!fs.existsSync(inputPath)) {
        console.error(`Input file does not exist: ${inputPath}`);
        process.exitCode = 1;
        return;
    }

    let raw;
    try {
        raw = fs.readFileSync(inputPath, "utf8");
    } catch (error) {
        console.error(`Failed to read input file: ${error.message}`);
        process.exitCode = 1;
        return;
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        console.error(`Input is not valid JSON: ${error.message}`);
        process.exitCode = 1;
        return;
    }

    if (!Array.isArray(parsed.traceEvents)) {
        console.error(
            "Expected a DevTools trace export with a traceEvents array.",
        );
        process.exitCode = 1;
        return;
    }

    const originalCount = parsed.traceEvents.length;
    const filteredEvents = parsed.traceEvents.filter(isTimingsEvent);

    const output =
        mode === "summary"
            ? buildSummary(filteredEvents, inputPath, parsed.metadata)
            : mode === "handoff"
              ? buildCompileRenderHandoff(
                    filteredEvents,
                    inputPath,
                    parsed.metadata,
                )
              : mode === "llm"
                ? {
                      metadata: parsed.metadata,
                      source: inputPath,
                      mode: "llm",
                      traceEvents: filteredEvents.map(projectEventForLlm),
                  }
                : {
                      ...parsed,
                      traceEvents: filteredEvents,
                  };

    fs.writeFileSync(outputPath, JSON.stringify(output));

    const inputBytes = Buffer.byteLength(raw, "utf8");
    const outputBytes = Buffer.byteLength(JSON.stringify(output), "utf8");
    const percent =
        inputBytes > 0 ? ((outputBytes / inputBytes) * 100).toFixed(2) : "0.00";

    console.log(`Input:  ${inputPath}`);
    console.log(`Output: ${outputPath}`);
    console.log(`Mode:   ${mode}`);
    console.log(`Events: ${originalCount} -> ${filteredEvents.length}`);
    console.log(
        `Size:   ${inputBytes} -> ${outputBytes} bytes (${percent}% kept)`,
    );
}

main();
