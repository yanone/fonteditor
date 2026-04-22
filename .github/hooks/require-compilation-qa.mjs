#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const phase = String(process.env.HOOK_PHASE || "").toLowerCase();
const workspaceRoot = process.cwd();
const rawInput = fs.readFileSync(0, "utf8");

let payload = {};
try {
    payload = rawInput ? JSON.parse(rawInput) : {};
} catch {
    payload = {};
}

const statePath = path.join(
    os.tmpdir(),
    `counterpunch-compilation-qa-${Buffer.from(workspaceRoot).toString("hex")}.json`,
);

const riskyPathMatchers = [
    /webapp\/js\/change-bridge(?:-[^/]+)?\.ts/i,
    /webapp\/js\/window-sync\.ts/i,
    /webapp\/js\/history-view\.ts/i,
    /webapp\/js\/undo-redo-context\.ts/i,
    /webapp\/js\/change-log\.ts/i,
    /webapp\/js\/fontc-worker\.ts/i,
    /webapp\/js\/font-compilation\.ts/i,
    /webapp\/js\/auto-compile-manager\.ts/i,
    /webapp\/js\/full-font-compile-manager\.ts/i,
    /webapp\/js\/font-manager\.ts/i,
    /webapp\/js\/python-post-execution\.ts/i,
    /webapp\/js\/python-ui-sync\.ts/i,
    /webapp\/js\/babelfont-model\.ts/i,
    /babelfont-fontc-build\/src\/.+\.rs/i,
    /developer-docs\/COMPILATION_EDIT_POLICY\.md/i,
];

function collectStrings(value, out = []) {
    if (typeof value === "string") {
        out.push(value);
        return out;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            collectStrings(item, out);
        }
        return out;
    }
    if (value && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
            out.push(key);
            collectStrings(item, out);
        }
    }
    return out;
}

function loadState() {
    try {
        return JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch {
        return { pending: false, files: [] };
    }
}

function saveState(state) {
    fs.writeFileSync(statePath, JSON.stringify(state));
}

function clearState() {
    try {
        fs.unlinkSync(statePath);
    } catch {
        // Ignore missing state.
    }
}

function unique(values) {
    return [...new Set(values)];
}

function riskyReferences(strings) {
    return unique(
        strings.filter((value) =>
            riskyPathMatchers.some((matcher) => matcher.test(value)),
        ),
    );
}

const strings = collectStrings(payload);
const payloadText = JSON.stringify(payload).toLowerCase();
const riskyRefs = riskyReferences(strings);

const isEditTool =
    payloadText.includes("apply_patch") ||
    payloadText.includes("create_file") ||
    payloadText.includes("edit_notebook_file");

const isQaAgentInvocation =
    payloadText.includes("runsubagent") &&
    payloadText.includes("compilation change bridge undo qa");

const isValidationCommand =
    payloadText.includes("run_in_terminal") &&
    /(npm\s+test|npm\s+run\s+test|npm\s+run\s+test:jest|npm\s+run\s+build|npx\s+jest|playwright|vitest|cargo\s+test)/i.test(
        JSON.stringify(payload),
    );

const state = loadState();

if (phase === "pre") {
    if (state.pending && isQaAgentInvocation) {
        process.stdout.write(
            JSON.stringify({
                continue: true,
                systemMessage:
                    "Pending compilation/change-bridge QA requirement detected. Running the dedicated QA agent now.",
            }),
        );
        process.exit(0);
    }

    if (state.pending && isValidationCommand) {
        process.stdout.write(
            JSON.stringify({
                continue: true,
                systemMessage:
                    "Pending compilation/change-bridge QA requirement detected. Validation command accepted.",
            }),
        );
        process.exit(0);
    }

    if (isEditTool && riskyRefs.length) {
        process.stdout.write(
            JSON.stringify({
                hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "ask",
                    permissionDecisionReason:
                        "This edit touches compilation, change-bridge, Yjs, or undo code and requires QA validation after the edit.",
                },
                systemMessage: `QA-critical edit detected in: ${riskyRefs.join(", ")}. After editing, run the Compilation Change Bridge Undo QA agent or targeted validation commands before proceeding.`,
            }),
        );
        process.exit(0);
    }

    process.exit(0);
}

if (phase === "post") {
    if (isEditTool && riskyRefs.length) {
        saveState({ pending: true, files: riskyRefs });
        process.stdout.write(
            JSON.stringify({
                continue: true,
                systemMessage: `QA validation is now required because this edit touched: ${riskyRefs.join(", ")}. Next step: run the Compilation Change Bridge Undo QA agent or targeted validation commands before additional risky edits or task completion.`,
            }),
        );
        process.exit(0);
    }

    if (state.pending && (isQaAgentInvocation || isValidationCommand)) {
        clearState();
        process.stdout.write(
            JSON.stringify({
                continue: true,
                systemMessage:
                    "Compilation/change-bridge QA requirement cleared after QA agent invocation or validation command.",
            }),
        );
        process.exit(0);
    }
}

process.exit(0);
