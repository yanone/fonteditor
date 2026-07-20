/**
 * Encode and decode babelfont path node strings.
 *
 * This module is the single JavaScript boundary between upstream-truthful
 * babelfont storage strings and runtime node arrays used by the editor.
 */

type NodeRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatNumber(value: unknown, context: string): string {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) {
        throw new TypeError(`Invalid node coordinate at ${context}.`);
    }
    return String(numberValue);
}

function encodeNodeType(node: NodeRecord, index: number): string {
    const rawType = node.nodetype ?? node.type;
    if (typeof rawType !== 'string' || rawType.length === 0) {
        throw new TypeError(`Invalid node type at nodes[${index}].`);
    }

    const suffix = node.smooth === true ? 's' : '';
    if (rawType === 'Move') return `m${suffix}`;
    if (rawType === 'Line') return `l${suffix}`;
    if (rawType === 'Curve') return `c${suffix}`;
    if (rawType === 'QCurve') return `q${suffix}`;
    if (rawType === 'OffCurve') return `o${suffix}`;
    return `${rawType}${suffix}`;
}

function decodeNodeType(token: string): { nodetype: string; smooth: boolean } {
    if (!token.length) {
        throw new TypeError('Invalid empty node type token.');
    }

    const smooth = token.endsWith('s');
    const baseToken = smooth ? token.slice(0, -1) : token;
    if (baseToken === 'm') return { nodetype: 'Move', smooth };
    if (baseToken === 'l') return { nodetype: 'Line', smooth };
    if (baseToken === 'c') return { nodetype: 'Curve', smooth };
    if (baseToken === 'q') return { nodetype: 'QCurve', smooth };
    if (baseToken === 'o') return { nodetype: 'OffCurve', smooth };
    return { nodetype: baseToken, smooth };
}

function tokenizeNodeString(nodes: string): string[] {
    const tokens: string[] = [];
    let index = 0;
    while (index < nodes.length) {
        while (index < nodes.length && /\s/.test(nodes[index])) {
            index++;
        }
        if (index >= nodes.length) break;

        if (nodes[index] !== '{') {
            let end = index + 1;
            while (end < nodes.length && !/\s/.test(nodes[end])) {
                end++;
            }
            tokens.push(nodes.slice(index, end));
            index = end;
            continue;
        }

        let depth = 0;
        let inString = false;
        let escaped = false;
        let end = index;
        for (; end < nodes.length; end++) {
            const char = nodes[end];
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }
            if (char === '"') {
                inString = !inString;
                continue;
            }
            if (inString) continue;
            if (char === '{') depth++;
            if (char === '}') {
                depth--;
                if (depth === 0) {
                    end++;
                    break;
                }
            }
        }
        if (depth !== 0 || inString) {
            throw new TypeError('Malformed node format_specific JSON token.');
        }
        tokens.push(nodes.slice(index, end));
        index = end;
    }
    return tokens;
}

export function serializeNodeArray(nodes: unknown): string {
    if (typeof nodes === 'string') {
        return nodes;
    }
    if (!Array.isArray(nodes)) {
        throw new TypeError('Path nodes must be an array or upstream string.');
    }

    const parts: string[] = [];
    nodes.forEach((node, index) => {
        if (!isPlainObject(node)) {
            throw new TypeError(`Invalid node at nodes[${index}].`);
        }
        parts.push(formatNumber(node.x, `nodes[${index}].x`));
        parts.push(formatNumber(node.y, `nodes[${index}].y`));
        parts.push(encodeNodeType(node, index));
        if (
            node.format_specific !== undefined &&
            node.format_specific !== null
        ) {
            parts.push(JSON.stringify(node.format_specific));
        }
    });
    return parts.join(' ');
}

export function parseNodeString(nodes: unknown): NodeRecord[] {
    if (Array.isArray(nodes)) {
        return nodes as NodeRecord[];
    }
    if (typeof nodes !== 'string') {
        throw new TypeError('Path nodes must be an upstream string or array.');
    }
    const tokens = tokenizeNodeString(nodes);
    const parsedNodes: NodeRecord[] = [];
    let index = 0;
    while (index < tokens.length) {
        if (index + 2 >= tokens.length) {
            throw new TypeError(
                'Malformed node string: incomplete node record.'
            );
        }
        const x = Number(tokens[index++]);
        const y = Number(tokens[index++]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new TypeError('Malformed node string: invalid coordinate.');
        }
        const { nodetype, smooth } = decodeNodeType(tokens[index++]);
        const node: NodeRecord = { x, y, nodetype, smooth };
        const maybeFormatSpecific = tokens[index];
        if (maybeFormatSpecific?.startsWith('{')) {
            node.format_specific = JSON.parse(maybeFormatSpecific);
            index++;
        }
        parsedNodes.push(node);
    }
    return parsedNodes;
}

function transformNodeValues(
    value: unknown,
    mode: 'runtime' | 'storage'
): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => transformNodeValues(item, mode));
    }
    if (!isPlainObject(value)) {
        return value;
    }

    const result: Record<string, unknown> = {};
    for (const [key, childValue] of Object.entries(value)) {
        if (key === 'nodes') {
            result[key] =
                mode === 'runtime'
                    ? parseNodeString(childValue)
                    : serializeNodeArray(childValue);
        } else {
            result[key] = transformNodeValues(childValue, mode);
        }
    }
    return result;
}

export function decodeNodeStringsForRuntime<T>(value: T): T {
    return transformNodeValues(value, 'runtime') as T;
}

export function encodeNodeArraysForStorage<T>(value: T): T {
    return transformNodeValues(value, 'storage') as T;
}
