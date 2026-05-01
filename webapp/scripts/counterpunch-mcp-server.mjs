#!/usr/bin/env node

import process from 'node:process';
import { chromium } from '@playwright/test';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'counterpunch';
const SERVER_VERSION = '0.1.0';
const DEFAULT_APP_URL = process.env.CI
    ? 'http://localhost:9000'
    : 'https://localhost:8000';
const APP_URL = process.env.COUNTERPUNCH_MCP_URL || DEFAULT_APP_URL;
const HEADLESS = process.env.COUNTERPUNCH_MCP_HEADLESS !== 'false';
const TOOL_TIMEOUT_MS = 30000;

function log(message, detail) {
    if (detail === undefined) {
        process.stderr.write(`[CounterpunchMCP] ${message}\n`);
        return;
    }

    process.stderr.write(
        `[CounterpunchMCP] ${message} ${JSON.stringify(detail)}\n`
    );
}

function writeMessage(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

function makeTextResult(payload) {
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify(payload, null, 2)
            }
        ],
        structuredContent: payload
    };
}

class CounterpunchBrowserSession {
    constructor() {
        this.browser = null;
        this.context = null;
        this.mainPage = null;
    }

    async ensureReady() {
        if (this.mainPage && !this.mainPage.isClosed()) {
            return this.mainPage;
        }

        log('Launching headless browser session', {
            headless: HEADLESS,
            url: APP_URL
        });

        this.browser = await chromium.launch({
            headless: HEADLESS,
            args: [
                '--enable-features=SharedArrayBuffer',
                '--disable-extensions',
                '--disable-component-extensions-with-background-pages',
                '--disable-background-networking',
                '--disable-sync',
                '--no-default-browser-check',
                '--no-first-run'
            ]
        });

        this.context = await this.browser.newContext({
            ignoreHTTPSErrors: true,
            viewport: { width: 1680, height: 1050 }
        });
        this.mainPage = await this.context.newPage();
        await this.mainPage.goto(APP_URL, { waitUntil: 'domcontentloaded' });
        await this.waitForAutomationReady(this.mainPage);
        return this.mainPage;
    }

    async waitForAutomationReady(page) {
        await page.waitForFunction(
            () => {
                const automation = window.counterpunchAutomation;
                return (
                    !!automation &&
                    typeof automation.callTool === 'function' &&
                    typeof window.initFileBrowser === 'function' &&
                    typeof window.waitForFileBrowserReady === 'function'
                );
            },
            { timeout: 60000 }
        );

        await page.evaluate(async () => {
            await window.initFileBrowser();
            await window.waitForFileBrowserReady(15000);
        });
    }

    async callAutomation(method, args = {}) {
        const page = await this.ensureReady();
        return page.evaluate(
            async ({ nextMethod, nextArgs }) => {
                const automation = window.counterpunchAutomation;
                if (!automation) {
                    throw new Error(
                        'Counterpunch automation runtime is not available'
                    );
                }

                const fn = automation[nextMethod];
                if (typeof fn !== 'function') {
                    throw new Error(`Unknown automation method: ${nextMethod}`);
                }

                return await fn(nextArgs);
            },
            { nextMethod: method, nextArgs: args }
        );
    }

    async openFont(args) {
        return this.callAutomation('openFont', {
            path: args.path,
            timeoutMs: args.timeoutMs ?? TOOL_TIMEOUT_MS
        });
    }

    async listLinkedWindows(args) {
        return this.callAutomation('listLinkedWindows', {
            timeoutMs: args.timeoutMs ?? 500
        });
    }

    async openLinkedWindow(args) {
        const page = await this.ensureReady();
        const timeoutMs = args.timeoutMs ?? TOOL_TIMEOUT_MS;
        const popupPromise = page.waitForEvent('popup', {
            timeout: timeoutMs
        });
        const readyPromise = this.callAutomation('openLinkedWindow', {
            timeoutMs
        });
        const linkedPage = await popupPromise;
        await this.waitForAutomationReady(linkedPage);
        const { window: metadata } = await readyPromise;
        return { window: metadata };
    }

    async activateLinkedWindow(args) {
        const metadata = await this.callAutomation('activateLinkedWindow', {
            index: args.index,
            timeoutMs: args.timeoutMs ?? TOOL_TIMEOUT_MS
        });
        await this.bringToFront(metadata.index);
        return metadata;
    }

    async bringToFront(index) {
        const page = await this.pageForIndex(index);
        if (!page) {
            return;
        }
        try {
            await page.bringToFront();
        } catch {
            // Ignore focus failures in headless mode.
        }
    }

    async pageForIndex(index) {
        await this.ensureReady();
        const pages = this.context.pages();
        for (const page of pages) {
            if (page.isClosed()) {
                continue;
            }
            try {
                const pageIndex = await page.evaluate(() => {
                    return window.windowRole?.isMainWindow()
                        ? 0
                        : (window.windowRole?.linkedOrdinal ?? -1);
                });
                if (pageIndex === index) {
                    return page;
                }
            } catch {
                // Ignore pages mid-navigation.
            }
        }
        return null;
    }

    async shutdown() {
        if (this.context) {
            await this.context.close();
            this.context = null;
        }
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
        this.mainPage = null;
    }
}

const browserSession = new CounterpunchBrowserSession();

const tools = [
    {
        name: 'open_font',
        title: 'Open Font',
        description:
            'Open a font in Counterpunch from a filesystem URI such as memory:///user/Fustat.glyphs and resolve after fontReady. Note: fontReady takes 5-15 seconds for large fonts like Fustat.glyphs due to WASM compilation and initial render. Use timeoutMs=60000 for safety.',
        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Filesystem URI or path to open'
                },
                timeoutMs: {
                    type: 'number',
                    description:
                        'Optional fontReady timeout in milliseconds (default: 30000; use 60000 for large fonts)'
                }
            },
            required: ['path'],
            additionalProperties: false
        }
    },
    {
        name: 'open_linked_window',
        title: 'Open Linked Window',
        description:
            'Open a linked Counterpunch editor window and resolve only after that window has fired fontReady. Note: fontReady on linked windows takes 5-20 seconds due to Yjs full-state transfer, model rebuild, and initial WASM compilation. Use timeoutMs=60000 for safety.',
        inputSchema: {
            type: 'object',
            properties: {
                timeoutMs: {
                    type: 'number',
                    description:
                        'Optional readiness timeout in milliseconds (default: 30000; use 60000 for large fonts)'
                }
            },
            additionalProperties: false
        }
    },
    {
        name: 'list_linked_windows',
        title: 'List Linked Windows',
        description:
            'List the main Counterpunch window and all linked windows with their index and metadata such as text buffer and font path.',
        inputSchema: {
            type: 'object',
            properties: {
                timeoutMs: {
                    type: 'number',
                    description: 'Optional collection window in milliseconds'
                }
            },
            additionalProperties: false
        }
    },
    {
        name: 'activate_linked_window',
        title: 'Activate Linked Window',
        description:
            'Focus the Counterpunch main window or a linked window by index.',
        inputSchema: {
            type: 'object',
            properties: {
                index: {
                    type: 'number',
                    description: 'Window index, where 0 is the main window'
                },
                timeoutMs: {
                    type: 'number',
                    description: 'Optional activation timeout in milliseconds'
                }
            },
            required: ['index'],
            additionalProperties: false
        }
    }
];

async function handleToolCall(name, args) {
    switch (name) {
        case 'open_font':
            return browserSession.openFont(args);
        case 'open_linked_window':
            return browserSession.openLinkedWindow(args);
        case 'list_linked_windows':
            return {
                windows: await browserSession.listLinkedWindows(args)
            };
        case 'activate_linked_window':
            return {
                window: await browserSession.activateLinkedWindow(args)
            };
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}

function makeErrorResponse(id, code, message) {
    return {
        jsonrpc: '2.0',
        id,
        error: {
            code,
            message
        }
    };
}

async function handleRequest(request) {
    switch (request.method) {
        case 'initialize':
            return {
                jsonrpc: '2.0',
                id: request.id,
                result: {
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: {
                        tools: {}
                    },
                    serverInfo: {
                        name: SERVER_NAME,
                        version: SERVER_VERSION
                    }
                }
            };

        case 'notifications/initialized':
            return null;

        case 'ping':
            return {
                jsonrpc: '2.0',
                id: request.id,
                result: {}
            };

        case 'tools/list':
            return {
                jsonrpc: '2.0',
                id: request.id,
                result: {
                    tools
                }
            };

        case 'tools/call': {
            const toolName = request.params?.name;
            const toolArgs = request.params?.arguments || {};
            try {
                const result = await handleToolCall(toolName, toolArgs);
                return {
                    jsonrpc: '2.0',
                    id: request.id,
                    result: makeTextResult(result)
                };
            } catch (error) {
                return {
                    jsonrpc: '2.0',
                    id: request.id,
                    result: {
                        isError: true,
                        content: [
                            {
                                type: 'text',
                                text:
                                    error instanceof Error
                                        ? error.message
                                        : String(error)
                            }
                        ]
                    }
                };
            }
        }

        default:
            return makeErrorResponse(
                request.id ?? null,
                -32601,
                `Method not found: ${request.method}`
            );
    }
}

let inputBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
    inputBuffer += chunk;
    const lines = inputBuffer.split('\n');
    inputBuffer = lines.pop() || '';

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }

        let request;
        try {
            request = JSON.parse(line);
        } catch {
            writeMessage(makeErrorResponse(null, -32700, 'Parse error'));
            continue;
        }

        try {
            const response = await handleRequest(request);
            if (response) {
                writeMessage(response);
            }
        } catch (error) {
            writeMessage(
                makeErrorResponse(
                    request.id ?? null,
                    -32603,
                    error instanceof Error ? error.message : String(error)
                )
            );
        }
    }
});

process.stdin.on('end', async () => {
    await browserSession.shutdown();
    process.exit(0);
});

process.on('SIGINT', async () => {
    await browserSession.shutdown();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await browserSession.shutdown();
    process.exit(0);
});
