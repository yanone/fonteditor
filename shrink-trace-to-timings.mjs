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
    const projected = {
        ts: event.ts,
        name: event.name,
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

    return projected;
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
    };
}

function toMsFromStart(ts, startTs) {
    return round((ts - startTs) / 1000, 3);
}

function canonicalTimingName(rawName) {
    let normalized = String(rawName || "").trim();
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
        },
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
