import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

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

function getNodeName(node) {
    return ts.isIdentifier(node) || ts.isStringLiteral(node)
        ? node.text
        : "<anonymous>";
}

function getEnclosingSymbol(node) {
    for (let current = node.parent; current; current = current.parent) {
        if (ts.isMethodDeclaration(current)) {
            const classDeclaration = current.parent;
            if (
                ts.isClassDeclaration(classDeclaration) &&
                classDeclaration.name
            ) {
                return `${classDeclaration.name.text}.${getNodeName(current.name)}`;
            }
        }
        if (ts.isFunctionDeclaration(current) && current.name) {
            return current.name.text;
        }
    }
    return "<module>";
}

/** Find full-document worker message type literals, including helper inputs. */
export function findWorkerMessageSites(sourceText, filePath, messageTypes) {
    const sourceFile = ts.createSourceFile(
        filePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        filePath.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
    );
    const sites = [];

    const visit = (node) => {
        if (ts.isStringLiteral(node) && messageTypes.includes(node.text)) {
            sites.push(
                `${filePath}::${getEnclosingSymbol(node)}::${node.text}`,
            );
        }
        ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return [...new Set(sites)].sort();
}

function collectSourceFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const entryPath = join(directory, entry.name);
        if (entry.isDirectory()) {
            return collectSourceFiles(entryPath);
        }
        return entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name)
            ? [entryPath]
            : [];
    });
}

/** Find full-document worker requests in the checked-in production sources. */
export function queryWorkerMessageSites(rule) {
    return collectSourceFiles(join(repositoryRoot, rule.path))
        .filter(
            (filePath) =>
                !rule.excludedPaths?.includes(
                    relative(repositoryRoot, filePath),
                ),
        )
        .flatMap((filePath) =>
            findWorkerMessageSites(
                readFileSync(filePath, "utf8"),
                relative(repositoryRoot, filePath),
                rule.messageTypes,
            ),
        )
        .sort();
}

/** Compare full-document worker requests to their reviewed source locations. */
export function checkSourceRule(rule, getSites = queryWorkerMessageSites) {
    const actual = getSites(rule);
    const expected = [...rule.allowedSites].sort();
    const unexpected = actual.filter((site) => !expected.includes(site));
    const missing = expected.filter((site) => !actual.includes(site));

    if (unexpected.length === 0 && missing.length === 0) {
        console.log(`PASS ${rule.id}`);
        return;
    }

    const details = [
        `Source chokepoint guard failed: ${rule.id}`,
        rule.description,
        ...(unexpected.length
            ? [
                  `Unexpected full-document requests:\n${unexpected.map((value) => `  + ${value}`).join("\n")}`,
              ]
            : []),
        ...(missing.length
            ? [
                  `Missing reviewed requests:\n${missing.map((value) => `  - ${value}`).join("\n")}`,
              ]
            : []),
        "Route steady-state edits through incremental Yjs updates, or deliberately review and update architecture/graph-chokepoints.json.",
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
    for (const rule of configuration.sourceRules ?? []) {
        checkSourceRule(rule);
    }
}
