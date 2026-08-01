import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const configurationPath = fileURLToPath(
    new URL("../architecture/graph-chokepoints.json", import.meta.url),
);

/** Parse the GitNexus CLI's compact markdown table into caller identities. */
export function parseCallerRows(markdown) {
    const lines = markdown.split("\n").filter((line) => line.startsWith("|"));
    if (lines.length < 2) {
        return [];
    }

    const headers = lines[0]
        .split("|")
        .slice(1, -1)
        .map((value) => value.trim());
    return lines.slice(2).map((line) => {
        const values = line
            .split("|")
            .slice(1, -1)
            .map((value) => value.trim());
        return Object.fromEntries(
            headers.map((header, index) => [header, values[index] ?? ""]),
        );
    });
}

/** Run one graph query and return its production caller identities. */
export function queryCallers(query) {
    let output;
    try {
        output = execFileSync(
            "npx",
            ["--no-install", "gitnexus", "cypher", query],
            {
                cwd: repositoryRoot,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
    } catch (error) {
        const detail = error.stderr?.toString().trim() || error.message;
        throw new Error(`GitNexus query failed: ${detail}`);
    }

    let response;
    try {
        response = JSON.parse(output);
    } catch (error) {
        throw new Error(
            `GitNexus returned non-JSON output: ${error.message}\n${output}`,
        );
    }

    if (Array.isArray(response)) {
        return [];
    }
    if (typeof response.markdown !== "string") {
        throw new Error("GitNexus response did not include a markdown result");
    }

    return parseCallerRows(response.markdown)
        .map((row) => `${row.caller_path}::${row.caller_name}`)
        .sort();
}

/** Compare each protected chokepoint's actual callers to its reviewed baseline. */
export function checkRule(rule, getCallers = queryCallers) {
    const actual = getCallers(rule.query);
    const expected = [...rule.allowedCallers].sort();
    const unexpected = actual.filter((caller) => !expected.includes(caller));
    const missing = expected.filter((caller) => !actual.includes(caller));

    if (unexpected.length === 0 && missing.length === 0) {
        console.log(`PASS ${rule.id}`);
        return;
    }

    const details = [
        `Graph chokepoint guard failed: ${rule.id}`,
        rule.description,
        ...(unexpected.length
            ? [
                  `Unexpected callers:\n${unexpected.map((value) => `  + ${value}`).join("\n")}`,
              ]
            : []),
        ...(missing.length
            ? [
                  `Missing reviewed callers:\n${missing.map((value) => `  - ${value}`).join("\n")}`,
              ]
            : []),
        "Update the implementation to use the protected funnel, or deliberately review and update architecture/graph-chokepoints.json.",
    ];
    throw new Error(details.join("\n"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const configuration = JSON.parse(readFileSync(configurationPath, "utf8"));
    if (
        !Array.isArray(configuration.rules) ||
        configuration.rules.length === 0
    ) {
        throw new Error(
            "Graph chokepoint configuration must contain at least one rule",
        );
    }

    for (const rule of configuration.rules) {
        checkRule(rule);
    }
}
