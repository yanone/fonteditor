#!/usr/bin/env node

/**
 * JavaScript Event Documentation Generator
 *
 * Scans the app source for emitted CustomEvent/Event instances and matching
 * addEventListener consumers, then generates developer documentation.
 *
 * Usage:
 *   node generate-js-event-docs.mjs
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, extname, join, relative } from "path";
import ts from "typescript";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCE_ROOT = join(__dirname, "webapp", "js");
const OUTPUT_PATH = join(__dirname, "developer-docs", "JS_EVENTS.md");

function walkFiles(dirPath) {
    const results = [];
    for (const entry of readdirSync(dirPath)) {
        const fullPath = join(dirPath, entry);
        const stats = statSync(fullPath);
        if (stats.isDirectory()) {
            results.push(...walkFiles(fullPath));
            continue;
        }
        const extension = extname(fullPath);
        if (
            (extension === ".ts" || extension === ".js") &&
            !fullPath.endsWith(".d.ts")
        ) {
            results.push(fullPath);
        }
    }
    return results;
}

function cleanCommentText(text) {
    return text
        .replace(/^\/\*+/, "")
        .replace(/\*+\/$/, "")
        .split("\n")
        .map((line) =>
            line
                .replace(/^\s*\* ?/, "")
                .replace(/^\s*\/\/+ ?/, "")
                .trim(),
        )
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
}

function summarizeCommentText(text) {
    const withoutTags = text.split(/\s+@\w+/)[0].trim();
    if (!withoutTags) {
        return null;
    }

    const sentences = withoutTags.split(/(?<=[.!?])\s+/);
    const summary = sentences[0]?.trim() || withoutTags;
    return summary;
}

function getLeadingCommentText(node, sourceText) {
    const ranges = ts.getLeadingCommentRanges(sourceText, node.pos) || [];
    for (let index = ranges.length - 1; index >= 0; index -= 1) {
        const range = ranges[index];
        const text = cleanCommentText(sourceText.slice(range.pos, range.end));
        if (text) {
            return text;
        }
    }
    return null;
}

function buildStringConstantMap(sourceFile) {
    const stringConstants = new Map();

    function visit(node) {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
            const initializer = node.initializer;
            if (
                initializer &&
                (ts.isStringLiteral(initializer) ||
                    ts.isNoSubstitutionTemplateLiteral(initializer))
            ) {
                stringConstants.set(node.name.text, initializer.text);
            }
        }
        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return stringConstants;
}

function resolveEventName(expr, stringConstants) {
    if (!expr) {
        return null;
    }
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
        return expr.text;
    }
    if (ts.isIdentifier(expr)) {
        return stringConstants.get(expr.text) ?? null;
    }
    return null;
}

function extractObjectKeys(expr) {
    if (!expr || !ts.isObjectLiteralExpression(expr)) {
        return [];
    }
    return expr.properties.flatMap((property) => {
        if (ts.isShorthandPropertyAssignment(property)) {
            return [property.name.text];
        }
        if (!ts.isPropertyAssignment(property)) {
            return [];
        }
        if (
            ts.isIdentifier(property.name) ||
            ts.isStringLiteral(property.name)
        ) {
            return [property.name.text];
        }
        return [];
    });
}

function getDetailInfo(optionsExpr, stringConstants, sourceFile) {
    if (!optionsExpr || !ts.isObjectLiteralExpression(optionsExpr)) {
        return { detailKeys: [], detailExpression: null };
    }

    const detailProperty = optionsExpr.properties.find(
        (property) =>
            ts.isPropertyAssignment(property) &&
            (ts.isIdentifier(property.name) ||
                ts.isStringLiteral(property.name)) &&
            property.name.text === "detail",
    );

    if (!detailProperty || !ts.isPropertyAssignment(detailProperty)) {
        return { detailKeys: [], detailExpression: null };
    }

    const initializer = detailProperty.initializer;
    const detailKeys = extractObjectKeys(initializer);
    if (detailKeys.length) {
        return { detailKeys, detailExpression: null };
    }

    if (ts.isIdentifier(initializer)) {
        return {
            detailKeys: [],
            detailExpression:
                stringConstants.get(initializer.text) ?? initializer.text,
        };
    }

    return {
        detailKeys: [],
        detailExpression: initializer.getText(sourceFile),
    };
}

function findEnclosingContext(node, sourceFile, sourceText) {
    let current = node;

    while (current) {
        if (
            ts.isMethodDeclaration(current) ||
            ts.isFunctionDeclaration(current)
        ) {
            return {
                name: current.name?.getText(sourceFile) ?? "anonymous function",
                kind: ts.isMethodDeclaration(current) ? "method" : "function",
                comment: getLeadingCommentText(current, sourceText),
            };
        }

        if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
            const parent = current.parent;
            if (
                parent &&
                ts.isVariableDeclaration(parent) &&
                ts.isIdentifier(parent.name)
            ) {
                return {
                    name: parent.name.text,
                    kind: "function",
                    comment: getLeadingCommentText(parent, sourceText),
                };
            }
        }

        current = current.parent;
    }

    return {
        name: "top-level module code",
        kind: "module",
        comment: null,
    };
}

function splitCamelCase(text) {
    return text
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .toLowerCase();
}

function generateFallbackDescription(
    eventName,
    targetText,
    detailKeys,
    contextName,
) {
    const words = splitCamelCase(eventName);

    let lead;
    if (eventName.endsWith("Changed")) {
        lead = `Indicates that ${words.replace(/ changed$/, "")} changed.`;
    } else if (eventName.endsWith("Ready")) {
        lead = `Indicates that ${words.replace(/ ready$/, "")} is ready.`;
    } else if (eventName.endsWith("Compiled")) {
        lead = `Indicates that ${words.replace(/ compiled$/, "")} compiled.`;
    } else if (eventName.endsWith("Complete")) {
        lead = `Indicates that ${words.replace(/ complete$/, "")} completed.`;
    } else if (eventName.endsWith("Pending")) {
        lead = `Indicates pending ${words.replace(/ pending$/, "")}.`;
    } else {
        lead = `Custom app event for ${words}.`;
    }

    const detailText = detailKeys.length
        ? ` Detail keys: ${detailKeys.map((key) => `\`${key}\``).join(", ")}.`
        : "";

    return `${lead} Emitted on \`${targetText}\` from \`${contextName}\`.${detailText}`;
}

function collectEvents(filePath) {
    const sourceText = readFileSync(filePath, "utf-8");
    const sourceFile = ts.createSourceFile(
        filePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
    );
    const stringConstants = buildStringConstantMap(sourceFile);
    const emitted = [];
    const listeners = [];

    function visit(node) {
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "dispatchEvent"
        ) {
            const [eventExpr] = node.arguments;
            if (eventExpr && ts.isNewExpression(eventExpr)) {
                const eventClass = eventExpr.expression.getText(sourceFile);
                if (eventClass === "CustomEvent" || eventClass === "Event") {
                    const eventName = resolveEventName(
                        eventExpr.arguments?.[0],
                        stringConstants,
                    );
                    if (eventName) {
                        const context = findEnclosingContext(
                            node,
                            sourceFile,
                            sourceText,
                        );
                        const statement =
                            ts.findAncestor(node, ts.isExpressionStatement) ||
                            node;
                        const statementComment = summarizeCommentText(
                            getLeadingCommentText(statement, sourceText) || "",
                        );
                        const contextComment = summarizeCommentText(
                            context.comment || "",
                        );
                        const { line } =
                            sourceFile.getLineAndCharacterOfPosition(
                                node.getStart(sourceFile),
                            );
                        const detailInfo = getDetailInfo(
                            eventExpr.arguments?.[1],
                            stringConstants,
                            sourceFile,
                        );
                        const targetText =
                            node.expression.expression.getText(sourceFile);

                        emitted.push({
                            eventName,
                            eventClass,
                            targetText,
                            filePath,
                            line: line + 1,
                            contextName: context.name,
                            contextKind: context.kind,
                            comment: statementComment || contextComment,
                            detailKeys: detailInfo.detailKeys,
                            detailExpression: detailInfo.detailExpression,
                        });
                    }
                }
            }
        }

        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "addEventListener"
        ) {
            const eventName = resolveEventName(
                node.arguments[0],
                stringConstants,
            );
            if (eventName) {
                const context = findEnclosingContext(
                    node,
                    sourceFile,
                    sourceText,
                );
                const { line } = sourceFile.getLineAndCharacterOfPosition(
                    node.getStart(sourceFile),
                );
                listeners.push({
                    eventName,
                    targetText: node.expression.expression.getText(sourceFile),
                    filePath,
                    line: line + 1,
                    contextName: context.name,
                    contextKind: context.kind,
                });
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return { emitted, listeners };
}

function formatRelativePath(filePath) {
    return relative(__dirname, filePath).replace(/\\/g, "/");
}

function toEventAnchor(eventName) {
    return `event-${eventName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function renderMarkdown(events) {
    const generatedAt = new Date().toISOString();

    const lines = [
        "# JavaScript Event Reference",
        "",
        "> Generated by `node generate-js-event-docs.mjs`. Do not edit this file by hand.",
        "",
        `Generated: ${generatedAt}`,
        "",
        "This document lists app-emitted JavaScript events discovered programmatically from source, along with generated descriptions, payload hints, emit sites, and listener sites.",
        "",
        "## Summary",
        "",
        "| Event | Class | Emitters | Listeners |",
        "| --- | --- | ---: | ---: |",
    ];

    for (const event of events) {
        lines.push(
            `| [\`${event.name}\`](#${toEventAnchor(event.name)}) | \`${event.eventClass}\` | ${event.emitters.length} | ${event.listeners.length} |`,
        );
    }

    for (const event of events) {
        lines.push(
            "",
            `<a id="${toEventAnchor(event.name)}"></a>`,
            "",
            `## \`${event.name}\``,
            "",
        );
        lines.push(`- Description: ${event.description}`);

        const targets = [
            ...new Set(
                event.emitters.map((emitter) => `\`${emitter.targetText}\``),
            ),
        ];
        lines.push(`- Emitted on: ${targets.join(", ")}`);

        if (event.detailKeys.length) {
            lines.push(
                `- Detail keys: ${event.detailKeys.map((key) => `\`${key}\``).join(", ")}`,
            );
        } else if (event.detailExpressions.length) {
            lines.push(
                `- Detail expression(s): ${event.detailExpressions.map((expr) => `\`${expr}\``).join(", ")}`,
            );
        } else {
            lines.push("- Detail keys: none detected");
        }

        lines.push("- Emit sites:");
        for (const emitter of event.emitters) {
            lines.push(
                `  - ${formatRelativePath(emitter.filePath)}:${emitter.line} via ${emitter.contextKind} \`${emitter.contextName}\` on \`${emitter.targetText}\``,
            );
        }

        if (event.listeners.length) {
            lines.push("- Listener sites:");
            for (const listener of event.listeners) {
                lines.push(
                    `  - ${formatRelativePath(listener.filePath)}:${listener.line} via ${listener.contextKind} \`${listener.contextName}\` on \`${listener.targetText}\``,
                );
            }
        } else {
            lines.push("- Listener sites: none detected");
        }
    }

    lines.push("");
    return `${lines.join("\n")}\n`;
}

function main() {
    const files = walkFiles(SOURCE_ROOT);
    const emittedByEvent = new Map();
    const listenersByEvent = new Map();

    for (const filePath of files) {
        const { emitted, listeners } = collectEvents(filePath);

        for (const entry of emitted) {
            if (!emittedByEvent.has(entry.eventName)) {
                emittedByEvent.set(entry.eventName, []);
            }
            emittedByEvent.get(entry.eventName).push(entry);
        }

        for (const entry of listeners) {
            if (!listenersByEvent.has(entry.eventName)) {
                listenersByEvent.set(entry.eventName, []);
            }
            listenersByEvent.get(entry.eventName).push(entry);
        }
    }

    const events = Array.from(emittedByEvent.entries())
        .map(([name, emitters]) => {
            const listeners = listenersByEvent.get(name) ?? [];
            const firstEmitter = emitters[0];
            const detailKeys = [
                ...new Set(emitters.flatMap((entry) => entry.detailKeys)),
            ].sort();
            const detailExpressions = [
                ...new Set(
                    emitters
                        .map((entry) => entry.detailExpression)
                        .filter(Boolean),
                ),
            ];
            const comment =
                emitters.find((entry) => entry.comment)?.comment ?? null;
            const description =
                comment ||
                generateFallbackDescription(
                    name,
                    firstEmitter.targetText,
                    detailKeys,
                    firstEmitter.contextName,
                );

            return {
                name,
                eventClass: firstEmitter.eventClass,
                emitters,
                listeners,
                detailKeys,
                detailExpressions,
                description,
            };
        })
        .sort((left, right) => left.name.localeCompare(right.name));

    writeFileSync(OUTPUT_PATH, renderMarkdown(events), "utf-8");
    console.log(
        `Generated ${events.length} event reference entr${events.length === 1 ? "y" : "ies"} at ${formatRelativePath(OUTPUT_PATH)}`,
    );
}

main();
