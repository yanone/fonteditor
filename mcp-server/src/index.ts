#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer, WebSocket } from "ws";

interface LogEntry {
    timestamp: number;
    level: string;
    prefix: string;
    args: any[];
    stackTrace?: string;
}

interface RuntimeData {
    [key: string]: any;
}

interface RuntimeLookupResult {
    found: boolean;
    value: any;
    traversedPath: string[];
    missingSegment?: string;
}

class ContextFontEditorMCP {
    private server: Server;
    private wss!: WebSocketServer;
    private logs: LogEntry[] = [];
    private runtimeData: RuntimeData = {};
    private maxLogs = 1000;
    private wsPort = 9876;
    private webappClients: Set<WebSocket> = new Set();

    constructor() {
        this.server = new Server(
            {
                name: "context-font-editor-mcp",
                version: "0.1.0",
            },
            {
                capabilities: {
                    resources: {},
                    tools: {},
                },
            },
        );

        this.setupWebSocketServer();
        this.setupHandlers();
    }

    private setupWebSocketServer() {
        this.wss = new WebSocketServer({ port: this.wsPort });

        this.wss.on("listening", () => {
            console.error(
                `[MCP] WebSocket server listening on ws://localhost:${this.wsPort}`,
            );
        });
        this.wss.on("connection", (ws: WebSocket) => {
            console.error("[MCP] Webapp connected");
            this.webappClients.add(ws);

            ws.on("message", (data: Buffer) => {
                try {
                    const message = JSON.parse(data.toString());

                    if (message.type === "log") {
                        this.addLog(message.data);
                    } else if (message.type === "runtime-data") {
                        this.updateRuntimeData(message.data);
                    }
                } catch (error) {
                    console.error("[MCP] Error processing message:", error);
                }
            });

            ws.on("close", () => {
                console.error("[MCP] Webapp disconnected");
                this.webappClients.delete(ws);
            });

            ws.on("error", (error) => {
                console.error("[MCP] WebSocket error:", error);
            });
        });

        this.wss.on("error", (error) => {
            console.error("[MCP] WebSocket server error:", error);
        });
    }

    private addLog(log: LogEntry) {
        this.logs.push(log);
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }
    }

    private updateRuntimeData(data: RuntimeData) {
        this.runtimeData = { ...this.runtimeData, ...data };
    }

    private parseKeyPath(key: string): string[] {
        return key
            .replace(/\[(\d+)\]/g, ".$1")
            .split(".")
            .map((segment) => segment.trim())
            .filter(Boolean);
    }

    private getRuntimeValueByPath(key: string): RuntimeLookupResult {
        const path = this.parseKeyPath(key);
        let value: any = this.runtimeData;
        const traversedPath: string[] = [];

        if (path.length === 0) {
            return {
                found: true,
                value: this.runtimeData,
                traversedPath,
            };
        }

        for (const segment of path) {
            if (
                value !== null &&
                value !== undefined &&
                typeof value === "object" &&
                segment in value
            ) {
                traversedPath.push(segment);
                value = value[segment];
            } else {
                return {
                    found: false,
                    value: null,
                    traversedPath,
                    missingSegment: segment,
                };
            }
        }

        return {
            found: true,
            value,
            traversedPath,
        };
    }

    private sendToWebapp(command: string, data?: any): boolean {
        if (this.webappClients.size === 0) {
            return false;
        }

        const message = JSON.stringify({ type: command, data });
        let sentCount = 0;

        this.webappClients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
                sentCount++;
            }
        });

        return sentCount > 0;
    }

    private setupHandlers() {
        // List available resources
        this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
            resources: [
                {
                    uri: "context://logs/all",
                    name: "All Console Logs",
                    description: "All captured console logs from the webapp",
                    mimeType: "application/json",
                },
                {
                    uri: "context://logs/recent",
                    name: "Recent Console Logs",
                    description: "Last 50 console logs",
                    mimeType: "application/json",
                },
                {
                    uri: "context://runtime/data",
                    name: "Runtime Data",
                    description: "Current runtime data from the webapp",
                    mimeType: "application/json",
                },
            ],
        }));

        // Read resources
        this.server.setRequestHandler(
            ReadResourceRequestSchema,
            async (request) => {
                const uri = request.params.uri.toString();

                if (uri === "context://logs/all") {
                    return {
                        contents: [
                            {
                                uri,
                                mimeType: "application/json",
                                text: JSON.stringify(this.logs, null, 2),
                            },
                        ],
                    };
                }

                if (uri === "context://logs/recent") {
                    const recentLogs = this.logs.slice(-50);
                    return {
                        contents: [
                            {
                                uri,
                                mimeType: "application/json",
                                text: JSON.stringify(recentLogs, null, 2),
                            },
                        ],
                    };
                }

                if (uri === "context://runtime/data") {
                    return {
                        contents: [
                            {
                                uri,
                                mimeType: "application/json",
                                text: JSON.stringify(this.runtimeData, null, 2),
                            },
                        ],
                    };
                }

                throw new Error(`Unknown resource: ${uri}`);
            },
        );

        // List available tools
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: "query_logs",
                    description:
                        "Query console logs with filters (level, prefix, search text, time range)",
                    inputSchema: {
                        type: "object",
                        properties: {
                            level: {
                                type: "string",
                                description:
                                    "Filter by log level (log, warn, error, etc.)",
                            },
                            prefix: {
                                type: "string",
                                description:
                                    "Filter by log prefix (e.g., [FontCompilation], [GlyphCanvas])",
                            },
                            search: {
                                type: "string",
                                description: "Search text in log arguments",
                            },
                            limit: {
                                type: "number",
                                description:
                                    "Maximum number of logs to return (default: 50)",
                            },
                            since: {
                                type: "number",
                                description:
                                    "Only return logs since this timestamp (ms)",
                            },
                        },
                    },
                },
                {
                    name: "get_runtime_value",
                    description: "Get a specific value from runtime data",
                    inputSchema: {
                        type: "object",
                        properties: {
                            key: {
                                type: "string",
                                description:
                                    "The key path to retrieve (supports dot notation)",
                            },
                        },
                        required: ["key"],
                    },
                },
                {
                    name: "clear_logs",
                    description: "Clear all captured logs",
                    inputSchema: {
                        type: "object",
                        properties: {},
                    },
                },
                {
                    name: "reload_webapp",
                    description: "Reload the webapp page in the browser",
                    inputSchema: {
                        type: "object",
                        properties: {},
                    },
                },
                {
                    name: "execute_javascript",
                    description:
                        "Execute JavaScript code in the webapp context",
                    inputSchema: {
                        type: "object",
                        properties: {
                            code: {
                                type: "string",
                                description: "The JavaScript code to execute",
                            },
                        },
                        required: ["code"],
                    },
                },
            ],
        }));

        // Handle tool calls
        this.server.setRequestHandler(
            CallToolRequestSchema,
            async (request) => {
                const { name, arguments: args } = request.params;

                if (name === "query_logs") {
                    let filtered = [...this.logs];

                    if (args?.level) {
                        filtered = filtered.filter(
                            (log) => log.level === args.level,
                        );
                    }

                    if (args?.prefix) {
                        filtered = filtered.filter(
                            (log) => log.prefix === args.prefix,
                        );
                    }

                    if (args?.search) {
                        const searchLower = String(args.search).toLowerCase();
                        filtered = filtered.filter((log) =>
                            JSON.stringify(log.args)
                                .toLowerCase()
                                .includes(searchLower),
                        );
                    }

                    if (args?.since) {
                        const sinceTime = Number(args.since);
                        filtered = filtered.filter(
                            (log) => log.timestamp >= sinceTime,
                        );
                    }

                    const limit = args?.limit || 50;
                    const result = filtered.slice(-limit);

                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(result, null, 2),
                            },
                        ],
                    };
                }

                if (name === "get_runtime_value") {
                    const key =
                        typeof args?.key === "string" ? args.key.trim() : "";

                    if (!key) {
                        throw new Error(
                            "Key parameter is required and must be a string",
                        );
                    }

                    const lookup = this.getRuntimeValueByPath(key);
                    const hasRuntimeData =
                        Object.keys(this.runtimeData).length > 0;

                    const responsePayload = {
                        key,
                        found: lookup.found,
                        value: lookup.value,
                        traversedPath: lookup.traversedPath,
                        missingSegment: lookup.missingSegment || null,
                        availableTopLevelKeys: Object.keys(this.runtimeData),
                        hint: !hasRuntimeData
                            ? "No runtime data received yet. Send data from the webapp via window.mcpTransport.sendRuntimeData({...})."
                            : lookup.found
                              ? null
                              : "Key path not found in runtime data.",
                    };

                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(responsePayload, null, 2),
                            },
                        ],
                    };
                }

                if (name === "clear_logs") {
                    this.logs = [];
                    return {
                        content: [
                            {
                                type: "text",
                                text: "Logs cleared",
                            },
                        ],
                    };
                }

                if (name === "reload_webapp") {
                    const sent = this.sendToWebapp("reload");
                    return {
                        content: [
                            {
                                type: "text",
                                text: sent
                                    ? "Reload command sent to webapp"
                                    : "No webapp clients connected",
                            },
                        ],
                    };
                }

                if (name === "execute_javascript") {
                    const code = args?.code as string;
                    if (!code) {
                        throw new Error("Code parameter is required");
                    }
                    const sent = this.sendToWebapp("execute", { code });
                    return {
                        content: [
                            {
                                type: "text",
                                text: sent
                                    ? `JavaScript execution command sent to webapp:\n${code}`
                                    : "No webapp clients connected",
                            },
                        ],
                    };
                }

                throw new Error(`Unknown tool: ${name}`);
            },
        );
    }

    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error("[MCP] Context Font Editor MCP Server running");
    }
}

const mcp = new ContextFontEditorMCP();
mcp.run().catch(console.error);
