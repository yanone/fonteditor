/**
 * Shared web storage documentation generator for localStorage and sessionStorage.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, extname, join, relative } from "path";
import ts from "typescript";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TS_SOURCE_ROOT = join(__dirname, "webapp", "js");
const PLUGIN_SOURCE_ROOT = join(__dirname, "plugins");

const STORAGE_METHODS = new Set(["getItem", "setItem", "removeItem"]);

const SKIP_DIRECTORIES = new Set([
    "build",
    "dist",
    "__pycache__",
    "node_modules",
    ".git",
]);

function walkFiles(dirPath, extensions) {
    const results = [];
    for (const entry of readdirSync(dirPath)) {
        if (SKIP_DIRECTORIES.has(entry)) {
            continue;
        }
        const fullPath = join(dirPath, entry);
        const stats = statSync(fullPath);
        if (stats.isDirectory()) {
            results.push(...walkFiles(fullPath, extensions));
            continue;
        }
        if (extensions.has(extname(fullPath))) {
            results.push(fullPath);
        }
    }
    return results;
}

function formatRelativePath(filePath) {
    return relative(__dirname, filePath).replace(/\\/g, "/");
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
    if (!text) {
        return null;
    }
    const withoutTags = text.split(/\s+@\w+/)[0].trim();
    if (!withoutTags) {
        return null;
    }
    const sentences = withoutTags.split(/(?<=[.!?])\s+/);
    return sentences[0]?.trim() || withoutTags;
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

function splitWords(text) {
    return text
        .replace(/\$\{[^}]+\}/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[._:/`-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function fallbackDescription(key) {
    const words = splitWords(key) || "this value";
    return `Persists ${words}.`;
}

function toKeyAnchor(key) {
    return `key-${key.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function isStringLiteralLike(node) {
    return (
        ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    );
}

function templateToPattern(node) {
    let result = node.head.text;
    for (const span of node.templateSpans) {
        result += `\${${expressionToPlaceholder(span.expression)}}${span.literal.text}`;
    }
    return result;
}

function expressionToPlaceholder(expr) {
    if (ts.isIdentifier(expr)) {
        return expr.text;
    }
    if (ts.isPropertyAccessExpression(expr)) {
        return expr.name.text;
    }
    if (
        ts.isCallExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        expr.expression.text === "encodeURIComponent" &&
        expr.arguments[0]
    ) {
        return expressionToPlaceholder(expr.arguments[0]);
    }
    return expr
        .getText()
        .replace(/\s+/g, "")
        .replace(/^this\./, "");
}

function keyInfo(value, { pattern = false, comment = null } = {}) {
    return { value, pattern, comment: summarizeCommentText(comment) };
}

function findReturnedKeyExpression(body) {
    if (!body) {
        return null;
    }
    if (!ts.isBlock(body)) {
        return literalOrTemplateKey(body) ? body : null;
    }

    const returns = [];
    function visit(node) {
        if (ts.isReturnStatement(node) && node.expression) {
            if (literalOrTemplateKey(node.expression)) {
                returns.push(node.expression);
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(body);
    return returns[0] || null;
}

function literalOrTemplateKey(expr, comment = null) {
    if (!expr) {
        return null;
    }
    if (isStringLiteralLike(expr)) {
        return keyInfo(expr.text, { comment });
    }
    if (ts.isTemplateExpression(expr)) {
        return keyInfo(templateToPattern(expr), {
            pattern: true,
            comment,
        });
    }
    return null;
}

function collectFileBindings(sourceFile, sourceText) {
    const constants = new Map();
    const classProperties = new Map();
    const callables = new Map();

    function recordCallable(name, node, body) {
        const returnExpr = findReturnedKeyExpression(body);
        const key = literalOrTemplateKey(
            returnExpr,
            getLeadingCommentText(node, sourceText),
        );
        if (key) {
            callables.set(name, key);
        }
    }

    function visit(node) {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
            const key = literalOrTemplateKey(
                node.initializer,
                getLeadingCommentText(node, sourceText) ||
                    getLeadingCommentText(node.parent, sourceText),
            );
            if (key) {
                constants.set(node.name.text, key);
            }
        }

        if (ts.isFunctionDeclaration(node) && node.name) {
            recordCallable(node.name.text, node, node.body);
        }

        if (ts.isClassDeclaration(node) && node.name) {
            const className = node.name.text;
            const properties = new Map();
            for (const member of node.members) {
                if (
                    ts.isPropertyDeclaration(member) &&
                    member.name &&
                    ts.isIdentifier(member.name)
                ) {
                    const key = literalOrTemplateKey(
                        member.initializer,
                        getLeadingCommentText(member, sourceText),
                    );
                    if (key) {
                        properties.set(member.name.text, key);
                    }
                }
                if (
                    (ts.isMethodDeclaration(member) ||
                        ts.isGetAccessorDeclaration(member)) &&
                    member.name &&
                    ts.isIdentifier(member.name)
                ) {
                    recordCallable(
                        `${className}.${member.name.text}`,
                        member,
                        member.body,
                    );
                    recordCallable(member.name.text, member, member.body);
                }
            }
            classProperties.set(className, properties);
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return { constants, classProperties, callables };
}

function findEnclosingClassName(node) {
    let current = node;
    while (current) {
        if (ts.isClassDeclaration(current) && current.name) {
            return current.name.text;
        }
        current = current.parent;
    }
    return null;
}

function findEnclosingFunction(node) {
    let current = node;
    while (current) {
        if (
            ts.isMethodDeclaration(current) ||
            ts.isFunctionDeclaration(current) ||
            ts.isFunctionExpression(current) ||
            ts.isArrowFunction(current) ||
            ts.isConstructorDeclaration(current)
        ) {
            return current;
        }
        current = current.parent;
    }
    return null;
}

function collectLocalBindings(functionNode, sourceText) {
    const locals = new Map();
    if (!functionNode?.body) {
        return locals;
    }

    function visit(node) {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
            const comment =
                getLeadingCommentText(node, sourceText) ||
                getLeadingCommentText(node.parent, sourceText);
            const key = literalOrTemplateKey(node.initializer, comment);
            locals.set(node.name.text, {
                initializer: node.initializer || null,
                key,
                comment: summarizeCommentText(comment),
            });
        }
        ts.forEachChild(node, visit);
    }

    visit(functionNode.body);
    return locals;
}

function findEnclosingContext(node, sourceFile, sourceText) {
    let current = node;
    while (current) {
        if (
            ts.isMethodDeclaration(current) ||
            ts.isFunctionDeclaration(current) ||
            ts.isConstructorDeclaration(current)
        ) {
            const name =
                ts.isConstructorDeclaration(current)
                    ? "constructor"
                    : (current.name?.getText(sourceFile) ?? "anonymous");
            return {
                name,
                kind: ts.isMethodDeclaration(current)
                    ? "method"
                    : ts.isConstructorDeclaration(current)
                      ? "constructor"
                      : "function",
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
        comment: getLeadingCommentText(node, sourceText),
    };
}

function lookupNamedKey(name, bindings, className) {
    if (className) {
        const property = bindings.classProperties.get(className)?.get(name);
        if (property) {
            return property;
        }
        const method = bindings.callables.get(`${className}.${name}`);
        if (method) {
            return method;
        }
    }
    return bindings.constants.get(name) || bindings.callables.get(name) || null;
}

function resolveKeyExpr(expr, bindings, locals, className, depth = 0) {
    if (!expr || depth > 8) {
        return null;
    }

    const literal = literalOrTemplateKey(expr);
    if (literal) {
        return literal;
    }

    if (ts.isIdentifier(expr)) {
        const local = locals.get(expr.text);
        if (local?.key) {
            return local.key;
        }
        if (local?.initializer) {
            return resolveKeyExpr(
                local.initializer,
                bindings,
                locals,
                className,
                depth + 1,
            );
        }
        return lookupNamedKey(expr.text, bindings, className);
    }

    if (ts.isPropertyAccessExpression(expr)) {
        return lookupNamedKey(expr.name.text, bindings, className);
    }

    if (ts.isCallExpression(expr)) {
        const callee = expr.expression;
        if (ts.isIdentifier(callee)) {
            return lookupNamedKey(callee.text, bindings, className);
        }
        if (ts.isPropertyAccessExpression(callee)) {
            return lookupNamedKey(callee.name.text, bindings, className);
        }
    }

    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) {
        return resolveKeyExpr(
            expr.expression,
            bindings,
            locals,
            className,
            depth + 1,
        );
    }

    return null;
}

function isStorageApiAccess(node, apiName) {
    if (ts.isIdentifier(node) && node.text === apiName) {
        return true;
    }
    if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === apiName &&
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "window" || node.expression.text === "js")
    ) {
        return true;
    }
    return false;
}

function getStorageMethod(node, apiName) {
    if (!ts.isCallExpression(node)) {
        return null;
    }
    const expr = node.expression;
    if (!ts.isPropertyAccessExpression(expr)) {
        return null;
    }
    const method = expr.name.text;
    if (!STORAGE_METHODS.has(method)) {
        return null;
    }
    return isStorageApiAccess(expr.expression, apiName) ? method : null;
}

function isEnclosingFunctionParameter(identifier, functionNode) {
    if (!identifier || !functionNode?.parameters) {
        return false;
    }
    return functionNode.parameters.some(
        (parameter) =>
            ts.isIdentifier(parameter.name) &&
            parameter.name.text === identifier.text,
    );
}

function inferDefaultValue(callNode) {
    let current = callNode.parent;
    while (current && ts.isParenthesizedExpression(current)) {
        current = current.parent;
    }
    if (!current || !ts.isBinaryExpression(current)) {
        return null;
    }

    const operator = current.operatorToken.kind;
    const right = current.right;
    if (
        operator === ts.SyntaxKind.BarBarToken &&
        isStringLiteralLike(right)
    ) {
        return right.text;
    }
    if (
        operator === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
        isStringLiteralLike(right) &&
        right.text === "false"
    ) {
        return "true";
    }
    if (
        operator === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        isStringLiteralLike(right)
    ) {
        if (right.text === "true") {
            return "false";
        }
        if (right.text === "1") {
            return "0";
        }
    }
    return null;
}

function getFileHeaderComment(sourceText) {
    const match = sourceText.match(/^\s*\/\*\*([\s\S]*?)\*\//);
    return match ? summarizeCommentText(cleanCommentText(match[0])) : null;
}

function pickComment(...candidates) {
    for (const candidate of candidates) {
        if (candidate) {
            return candidate;
        }
    }
    return null;
}

function collectTypeScriptKeys(filePath, apiName) {
    const sourceText = readFileSync(filePath, "utf-8");
    const sourceFile = ts.createSourceFile(
        filePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
    );
    const bindings = collectFileBindings(sourceFile, sourceText);
    const fileComment = filePath.endsWith("-pref.ts")
        ? getFileHeaderComment(sourceText)
        : null;
    const usages = [];

    function visit(node) {
        const method = getStorageMethod(node, apiName);
        if (method) {
            const keyExpr = node.arguments[0];
            const className = findEnclosingClassName(node);
            const enclosingFunction = findEnclosingFunction(node);
            if (
                keyExpr &&
                ts.isIdentifier(keyExpr) &&
                isEnclosingFunctionParameter(keyExpr, enclosingFunction)
            ) {
                ts.forEachChild(node, visit);
                return;
            }
            const locals = collectLocalBindings(
                enclosingFunction,
                sourceText,
            );
            const resolved =
                resolveKeyExpr(keyExpr, bindings, locals, className) ||
                keyInfo(
                    keyExpr
                        ? `<unresolved: ${keyExpr.getText(sourceFile)}>`
                        : "<missing>",
                    { pattern: true },
                );
            const context = findEnclosingContext(node, sourceFile, sourceText);
            const constantComment =
                ts.isIdentifier(keyExpr) && bindings.constants.get(keyExpr.text)
                    ? bindings.constants.get(keyExpr.text).comment
                    : null;
            const propertyComment =
                ts.isPropertyAccessExpression(keyExpr) &&
                className &&
                bindings.classProperties
                    .get(className)
                    ?.get(keyExpr.name.text)?.comment;
            const { line } = sourceFile.getLineAndCharacterOfPosition(
                node.getStart(sourceFile),
            );

            usages.push({
                key: resolved.value,
                pattern: resolved.pattern,
                operation: method,
                filePath,
                line: line + 1,
                contextName: context.name,
                contextKind: context.kind,
                comment: pickComment(
                    resolved.comment,
                    constantComment,
                    propertyComment,
                    fileComment,
                ),
                defaultValue:
                    method === "getItem" ? inferDefaultValue(node) : null,
            });
        }
        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return usages;
}

function collectPythonKeys(filePath, apiName) {
    const source = readFileSync(filePath, "utf-8");
    const usages = [];
    const escapedApi = apiName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    if (apiName !== "localStorage") {
        for (const match of source.matchAll(
            new RegExp(
                `js\\.${escapedApi}\\.(getItem|setItem|removeItem)\\(\\s*(['"])([^'"]+)\\2`,
                "g",
            ),
        )) {
            usages.push({
                key: match[3],
                pattern: false,
                operation: match[1],
                filePath,
                line: source.slice(0, match.index).split("\n").length,
                contextName: formatRelativePath(filePath),
                contextKind: "module",
                comment: null,
                defaultValue: null,
            });
        }
        return usages;
    }

    const classMatch = source.match(
        /^class\s+(\w+)\s*\([^)]*BaseCanvasPlugin/m,
    );
    const className = classMatch?.[1] || null;
    const uiIds = [];
    const uiMatch = source.match(
        /def\s+get_ui_elements[\s\S]*?(?=\n    def |\nclass |\n\S|$)/,
    );
    if (uiMatch) {
        for (const idMatch of uiMatch[0].matchAll(
            /["']id["']\s*:\s*["']([^"']+)["']/g,
        )) {
            uiIds.push(idMatch[1]);
        }
    }

    const storageKeyFn = source.match(
        /def\s+_get_storage_key\s*\([\s\S]*?return\s+f(["'])([^"']+)\1/,
    );
    if (storageKeyFn) {
        const pattern = storageKeyFn[2]
            .replace(/\{plugin_name\}/g, "${plugin_name}")
            .replace(/\{param_id\}/g, "${param_id}");
        const fnIndex = source.indexOf("def _get_storage_key");
        const comment =
            "Canvas plugin parameter value keyed by plugin class name and parameter id.";
        const getSetMatches = [
            ...source.matchAll(/js\.localStorage\.(getItem|setItem)\(/g),
        ];
        if (getSetMatches.length === 0) {
            usages.push({
                key: pattern,
                pattern: true,
                operation: "getItem",
                filePath,
                line: source.slice(0, fnIndex).split("\n").length,
                contextName: "_get_storage_key",
                contextKind: "function",
                comment,
                defaultValue: null,
            });
        }
        for (const match of getSetMatches) {
            usages.push({
                key: pattern,
                pattern: true,
                operation: match[1],
                filePath,
                line: source.slice(0, match.index).split("\n").length,
                contextName:
                    match[1] === "getItem"
                        ? "_load_parameter_from_storage"
                        : "_save_parameter_to_storage",
                contextKind: "function",
                comment,
                defaultValue: null,
            });
        }
    }

    if (className && className !== "BaseCanvasPlugin") {
        const classIndex = source.indexOf(`class ${className}`);
        const line = source.slice(0, classIndex).split("\n").length;
        for (const paramId of uiIds) {
            for (const operation of ["getItem", "setItem"]) {
                usages.push({
                    key: `canvasPlugin.${className}.${paramId}`,
                    pattern: false,
                    operation,
                    filePath,
                    line,
                    contextName: className,
                    contextKind: "class",
                    comment: `Canvas plugin setting for \`${className}\` parameter \`${paramId}\`.`,
                    defaultValue: null,
                });
            }
        }
    }

    for (const match of source.matchAll(
        /js\.localStorage\.(getItem|setItem|removeItem)\(\s*(['"])([^'"]+)\2/g,
    )) {
        usages.push({
            key: match[3],
            pattern: false,
            operation: match[1],
            filePath,
            line: source.slice(0, match.index).split("\n").length,
            contextName: className || formatRelativePath(filePath),
            contextKind: className ? "class" : "module",
            comment: null,
            defaultValue: null,
        });
    }

    return usages;
}

function mergeUsages(usages) {
    const byKey = new Map();
    for (const usage of usages) {
        const existing = byKey.get(usage.key);
        if (!existing) {
            byKey.set(usage.key, {
                key: usage.key,
                pattern: usage.pattern,
                operations: new Set([usage.operation]),
                comments: [],
                defaults: [],
                sites: [],
            });
        }
        const entry = byKey.get(usage.key);
        entry.pattern = entry.pattern || usage.pattern;
        entry.operations.add(usage.operation);
        if (usage.comment) {
            entry.comments.push(usage.comment);
        }
        if (usage.defaultValue) {
            entry.defaults.push(usage.defaultValue);
        }
        entry.sites.push({
            filePath: usage.filePath,
            line: usage.line,
            operation: usage.operation,
            contextKind: usage.contextKind,
            contextName: usage.contextName,
        });
    }

    return Array.from(byKey.values())
        .map((entry) => {
            entry.sites.sort((left, right) => {
                const fileCmp = formatRelativePath(left.filePath).localeCompare(
                    formatRelativePath(right.filePath),
                );
                return fileCmp !== 0 ? fileCmp : left.line - right.line;
            });
            const uniqueFiles = [
                ...new Set(
                    entry.sites.map((site) => formatRelativePath(site.filePath)),
                ),
            ];
            return {
                key: entry.key,
                pattern: entry.pattern,
                operations: ["getItem", "setItem", "removeItem"].filter(
                    (operation) => entry.operations.has(operation),
                ),
                description:
                    entry.comments.find(Boolean) ||
                    fallbackDescription(entry.key),
                defaultValue: sanitizeDefault(entry.defaults[0]),
                files: uniqueFiles,
                sites: entry.sites,
            };
        })
        .sort((left, right) => {
            if (left.pattern !== right.pattern) {
                return left.pattern ? 1 : -1;
            }
            return left.key.localeCompare(right.key);
        });
}

function sanitizeDefault(value) {
    if (!value) {
        return null;
    }
    const flattened = String(value).replace(/\s+/g, " ").trim();
    if (!flattened || flattened.length > 80) {
        return null;
    }
    return flattened.replace(/`/g, "'");
}

function escapeTableCell(text) {
    return text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

function renderMarkdown(keys, config) {
    const lines = [
        `# ${config.title}`,
        "",
        `> Generated by \`node ${config.scriptName}\`. Do not edit this file by hand.`,
        "",
        config.intro,
        "",
        config.excludeNote,
        "",
        "## Summary",
        "",
        `| Keys | Literal | Pattern |`,
        `| ---: | ---: | ---: |`,
        `| ${keys.length} | ${keys.filter((key) => !key.pattern).length} | ${keys.filter((key) => key.pattern).length} |`,
        "",
        "| Key | Purpose | Operations | Files |",
        "| --- | --- | --- | --- |",
    ];

    for (const entry of keys) {
        const files = entry.files.map((file) => `\`${file}\``).join(", ");
        lines.push(
            `| [\`${entry.key}\`](#${toKeyAnchor(entry.key)}) | ${escapeTableCell(entry.description)} | ${entry.operations.join(", ")} | ${files} |`,
        );
    }

    for (const entry of keys) {
        lines.push(
            "",
            `<a id="${toKeyAnchor(entry.key)}"></a>`,
            "",
            `## \`${entry.key}\``,
            "",
            `- Purpose: ${entry.description}`,
            `- Kind: ${entry.pattern ? "pattern" : "literal"}`,
            `- Operations: ${entry.operations.map((operation) => `\`${operation}\``).join(", ")}`,
        );
        if (entry.defaultValue) {
            lines.push(`- Default when unset: \`${entry.defaultValue}\``);
        }
        lines.push("- Sites:");
        for (const site of entry.sites) {
            lines.push(
                `  - ${formatRelativePath(site.filePath)}:${site.line} \`${site.operation}\` via ${site.contextKind} \`${site.contextName}\``,
            );
        }
    }

    lines.push("");
    return `${lines.join("\n")}\n`;
}

export function generateWebStorageDocs(config) {
    const outputPath = join(__dirname, "developer-docs", config.outputName);
    const tsFiles = [
        ...walkFiles(TS_SOURCE_ROOT, new Set([".ts", ".js"])).filter(
            (filePath) => !filePath.endsWith(".d.ts"),
        ),
        ...(config.extraFiles || []).map((relativePath) =>
            join(__dirname, relativePath),
        ),
    ];
    const pyFiles = config.includePlugins
        ? walkFiles(PLUGIN_SOURCE_ROOT, new Set([".py"]))
        : [];

    const usages = [
        ...tsFiles.flatMap((filePath) =>
            collectTypeScriptKeys(filePath, config.apiName),
        ),
        ...pyFiles.flatMap((filePath) =>
            collectPythonKeys(filePath, config.apiName),
        ),
    ];
    const keys = mergeUsages(usages);
    const unresolved = keys.filter((entry) =>
        entry.key.startsWith("<unresolved:"),
    );
    if (unresolved.length) {
        console.error(`Unresolved ${config.apiName} key expression(s):`);
        for (const entry of unresolved) {
            console.error(`  ${entry.key}`);
            for (const site of entry.sites) {
                console.error(
                    `    ${formatRelativePath(site.filePath)}:${site.line}`,
                );
            }
        }
        process.exitCode = 1;
        return;
    }

    writeFileSync(outputPath, renderMarkdown(keys, config), "utf-8");
    console.log(
        `Generated ${keys.length} ${config.apiName} key reference entr${keys.length === 1 ? "y" : "ies"} at ${formatRelativePath(outputPath)}`,
    );
}
