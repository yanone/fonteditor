import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
    checkRule,
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
});
