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
    const matches = [];
    for (const value of strings) {
        for (const matcher of riskyPathMatchers) {
            const matchedPath = value.match(matcher)?.[0];
            if (matchedPath) {
                matches.push(matchedPath);
            }
        }
    }
    return unique(matches);
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

if (phase === "post") {
    if (isEditTool && riskyRefs.length) {
        const nextFiles = unique([...(state.files || []), ...riskyRefs]);
        saveState({ pending: true, files: nextFiles });
        process.stdout.write(
            JSON.stringify({
                continue: true,
                systemMessage: `QA review is now required because this edit touched: ${riskyRefs.join(", ")}. Before ending this prompt, run the Compilation Change Bridge Undo QA agent to review the main agent's work.`,
            }),
        );
        process.exit(0);
    }

    if (state.pending && isQaAgentInvocation) {
        clearState();
        process.stdout.write(
            JSON.stringify({
                continue: true,
                systemMessage:
                    "Compilation/change-bridge QA requirement cleared after dedicated QA agent review.",
            }),
        );
        process.exit(0);
    }

    if (state.pending && isValidationCommand) {
        process.stdout.write(
            JSON.stringify({
                continue: true,
                systemMessage:
                    "Validation command recorded, but the dedicated Compilation Change Bridge Undo QA agent still must run before the prompt can end.",
            }),
        );
        process.exit(0);
    }
}

if (phase === "stop") {
    if (state.pending) {
        process.stdout.write(
            JSON.stringify({
                continue: false,
                stopReason:
                    "QA-critical edits were made without a final Compilation Change Bridge Undo QA agent review.",
                systemMessage: `Before ending the prompt, run the Compilation Change Bridge Undo QA agent to review these files: ${(state.files || []).join(", ")}.`,
            }),
        );
        process.exit(2);
    }
}

process.exit(0);
