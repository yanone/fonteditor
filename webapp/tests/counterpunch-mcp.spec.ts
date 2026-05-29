/// <reference types="node" />

import { test, expect } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const { getWorktreeAppUrl } = require('../scripts/worktree-config.cjs');

const APP_URL = process.env.CI
    ? 'http://localhost:9000/?test=true'
    : getWorktreeAppUrl('/?test=true');

class StdioMcpClient {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly pending = new Map<
        number,
        {
            resolve: (value: any) => void;
            reject: (error: Error) => void;
        }
    >();
    private nextId = 1;
    private buffer = '';

    constructor(child: ChildProcessWithoutNullStreams) {
        this.child = child;
        this.child.stdout.setEncoding('utf8');
        this.child.stdout.on('data', (chunk: string) => {
            this.buffer += chunk;
            const lines = this.buffer.split('\n');
            this.buffer = lines.pop() || '';
            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line) {
                    continue;
                }
                const message = JSON.parse(line);
                if (
                    typeof message.id === 'number' &&
                    this.pending.has(message.id)
                ) {
                    const pending = this.pending.get(message.id)!;
                    this.pending.delete(message.id);
                    if (message.error) {
                        pending.reject(new Error(message.error.message));
                    } else {
                        pending.resolve(message.result);
                    }
                }
            }
        });
    }

    async request(method: string, params?: Record<string, unknown>) {
        const id = this.nextId++;
        const payload = {
            jsonrpc: '2.0',
            id,
            method,
            ...(params ? { params } : {})
        };

        const result = new Promise<any>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
        });

        this.child.stdin.write(`${JSON.stringify(payload)}\n`);
        return result;
    }

    notify(method: string, params?: Record<string, unknown>) {
        const payload = {
            jsonrpc: '2.0',
            method,
            ...(params ? { params } : {})
        };
        this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    }

    static toolPayload(result: any) {
        if (result?.isError) {
            const text = result?.content?.[0]?.text || 'Unknown MCP tool error';
            throw new Error(text);
        }
        if (result?.structuredContent !== undefined) {
            return result.structuredContent;
        }
        const text = result?.content?.[0]?.text;
        return text ? JSON.parse(text) : null;
    }
}

test.describe('Counterpunch MCP bridge', () => {
    test('opens fonts and linked windows end to end', async () => {
        const child = spawn('node', ['scripts/counterpunch-mcp-server.mjs'], {
            cwd: '/Users/yanone/Code/Counterpunch/editor/webapp',
            env: {
                ...process.env,
                COUNTERPUNCH_MCP_URL: APP_URL,
                COUNTERPUNCH_MCP_HEADLESS: 'true'
            },
            stdio: ['pipe', 'pipe', 'pipe']
        });

        const stderr: string[] = [];
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            stderr.push(chunk);
        });

        const client = new StdioMcpClient(child);

        try {
            const initResult = await client.request('initialize', {
                protocolVersion: '2025-06-18',
                capabilities: {},
                clientInfo: {
                    name: 'counterpunch-mcp-spec',
                    version: '1.0.0'
                }
            });
            expect(initResult.serverInfo.name).toBe('counterpunch');
            client.notify('notifications/initialized');

            const toolsList = await client.request('tools/list');
            const toolNames = toolsList.tools.map(
                (tool: { name: string }) => tool.name
            );
            expect(toolNames).toEqual(
                expect.arrayContaining([
                    'open_font',
                    'open_linked_window',
                    'list_linked_windows',
                    'activate_linked_window'
                ])
            );

            const openFontResult = StdioMcpClient.toolPayload(
                await client.request('tools/call', {
                    name: 'open_font',
                    arguments: {
                        path: 'memory:///user/Fustat.glyphs'
                    }
                })
            );
            expect(openFontResult.path).toBe('/user/Fustat.glyphs');
            expect(openFontResult.openSessionId).not.toBeNull();
            expect(openFontResult.window.index).toBe(0);

            const openLinkedWindowResult = StdioMcpClient.toolPayload(
                await client.request('tools/call', {
                    name: 'open_linked_window',
                    arguments: {}
                })
            );
            expect(openLinkedWindowResult.window.index).toBeGreaterThan(0);
            expect(openLinkedWindowResult.window.fontPath).toBe(
                '/user/Fustat.glyphs'
            );
            expect(openLinkedWindowResult.window.openSessionId).not.toBeNull();

            let listWindowsResult: {
                windows: Array<{
                    index: number;
                    textBuffer?: string | null;
                }>;
            } | null = null;
            await expect
                .poll(
                    async () => {
                        listWindowsResult = StdioMcpClient.toolPayload(
                            await client.request('tools/call', {
                                name: 'list_linked_windows',
                                arguments: {}
                            })
                        );
                        return listWindowsResult?.windows.length ?? 0;
                    },
                    { timeout: 30000 }
                )
                .toBe(2);
            expect(listWindowsResult).not.toBeNull();
            const resolvedListWindowsResult = listWindowsResult!;

            expect(Array.isArray(resolvedListWindowsResult.windows)).toBe(true);
            expect(resolvedListWindowsResult.windows).toHaveLength(2);
            expect(
                resolvedListWindowsResult.windows.map(
                    (win: { index: number }) => win.index
                )
            ).toEqual(
                expect.arrayContaining([0, openLinkedWindowResult.window.index])
            );
            const listedLinkedWindow = resolvedListWindowsResult.windows.find(
                (win: { index: number }) =>
                    win.index === openLinkedWindowResult.window.index
            );
            expect(listedLinkedWindow).toBeDefined();
            expect(listedLinkedWindow?.textBuffer).toBeTruthy();

            const activateWindowResult = StdioMcpClient.toolPayload(
                await client.request('tools/call', {
                    name: 'activate_linked_window',
                    arguments: {
                        index: openLinkedWindowResult.window.index
                    }
                })
            );
            expect(activateWindowResult.window.index).toBe(
                openLinkedWindowResult.window.index
            );
            expect(activateWindowResult.window.role).toBe('linked');
        } finally {
            child.kill('SIGTERM');
            await new Promise((resolve) => child.once('exit', resolve));
        }

        expect(stderr.join('')).not.toContain('Timed out');
    });
});
