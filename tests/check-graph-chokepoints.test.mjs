import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
    checkRule,
    checkSourceRule,
    findWorkerMessageSites,
    parseCallerRows,
} from "../scripts/check-graph-chokepoints.mjs";

describe("graph chokepoint guard", () => {
    test("parses GitNexus markdown caller rows", () => {
        assert.deepEqual(
            parseCallerRows(`| caller_name | caller_path |
| --- | --- |
| funnel | webapp/js/funnel.ts |
| bridge | webapp/js/bridge.ts |`),
            [
                {
                    caller_name: "funnel",
                    caller_path: "webapp/js/funnel.ts",
                },
                {
                    caller_name: "bridge",
                    caller_path: "webapp/js/bridge.ts",
                },
            ],
        );
    });

    test("rejects an unreviewed caller", () => {
        const rule = {
            id: "protected-boundary",
            description: "Only approved callers may cross this boundary.",
            query: "query",
            allowedCallers: ["webapp/js/funnel.ts::throughFunnel"],
        };

        assert.throws(
            () =>
                checkRule(rule, () => [
                    "webapp/js/funnel.ts::throughFunnel",
                    "webapp/js/sidecar.ts::bypass",
                ]),
            /Unexpected callers:\n  \+ webapp\/js\/sidecar.ts::bypass/,
        );
    });

    test("finds direct and helper-routed full-document worker requests", () => {
        assert.deepEqual(
            findWorkerMessageSites(
                `class Compiler {
    seed() {
        const request = { type: 'seedYdoc', state: [] };
        return this.sendMessage(request);
    }
}`,
                "webapp/js/compiler.ts",
                ["seedYdoc", "storeFontJson"],
            ),
            ["webapp/js/compiler.ts::Compiler.seed::seedYdoc"],
        );
    });

    test("finds full-document message types stored in variables", () => {
        assert.deepEqual(
            findWorkerMessageSites(
                `function seed() {
    const type = 'seedYdoc';
    return sendWorkerMessage({ type });
}`,
                "webapp/js/bootstrap.ts",
                ["seedYdoc"],
            ),
            ["webapp/js/bootstrap.ts::seed::seedYdoc"],
        );
    });

    test("does not treat dispatcher message checks as requests", () => {
        assert.deepEqual(
            findWorkerMessageSites(
                `function sendMessage(message) {
    if (message.type === 'seedYdoc') return seed(message);
    if (message.type === 'storeFontJson') return store(message);
}`,
                "webapp/js/compiler.ts",
                ["seedYdoc", "storeFontJson"],
            ),
            [],
        );
    });

    test("does not treat a full-document response as a request", () => {
        assert.deepEqual(
            findWorkerMessageSites(
                `function sendMessage(message) {
    postMessage(message);
    return { type: 'storeFontJson', success: true };
}`,
                "webapp/js/compiler.ts",
                ["storeFontJson"],
            ),
            [],
        );
    });

    test("finds full-document requests in JavaScript sources", () => {
        assert.deepEqual(
            findWorkerMessageSites(
                `function reload() {
    return worker.sendMessage({ type: 'storeFontJson', json: '{}' });
}`,
                "webapp/js/reload.js",
                ["storeFontJson"],
            ),
            ["webapp/js/reload.js::reload::storeFontJson"],
        );
    });

    test("rejects an unreviewed full-document worker request", () => {
        const rule = {
            id: "full-worker-document-requests",
            description: "Only bootstrap may replace the worker document.",
            allowedSites: ["webapp/js/bootstrap.ts::seed::seedYdoc"],
        };

        assert.throws(
            () =>
                checkSourceRule(rule, () => [
                    "webapp/js/bootstrap.ts::seed::seedYdoc",
                    "webapp/js/sidecar.ts::bypass::storeFontJson",
                ]),
            /Unexpected full-document requests:\n  \+ webapp\/js\/sidecar.ts::bypass::storeFontJson/,
        );
    });
});
