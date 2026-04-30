# Counterpunch MCP Server Setup In VS Code

This workspace now includes a local Counterpunch MCP server entry in [.vscode/mcp.json](../.vscode/mcp.json).

## What It Does

The server exposes four tools:

- `open_font`
- `open_linked_window`
- `list_linked_windows`
- `activate_linked_window`

The server starts a headless Chromium session, opens the Counterpunch app, and calls the permanent in-browser automation runtime instead of relying on ad hoc browser JavaScript.

## Prerequisites

1. Install webapp dependencies:

```bash
cd webapp
npm install
```

2. Start the app locally:

```bash
cd webapp
npm run dev
```

The default MCP configuration expects the app at `https://localhost:8000/?test=true`.

## VS Code Setup

The workspace MCP config includes this server:

```json
{
    "type": "stdio",
    "command": "node",
    "args": ["webapp/scripts/counterpunch-mcp-server.mjs"],
    "env": {
        "COUNTERPUNCH_MCP_URL": "https://localhost:8000/?test=true",
        "COUNTERPUNCH_MCP_HEADLESS": "true"
    }
}
```

To use it:

1. Open the workspace in VS Code.
2. Open Chat.
3. Start or restart the `counterpunch` MCP server from the MCP server UI or `MCP: List Servers`.
4. Trust the server when prompted.
5. Use the tools in chat.

## Environment Variables

- `COUNTERPUNCH_MCP_URL`: App URL to open.
- `COUNTERPUNCH_MCP_HEADLESS`: `true` by default. Set to `false` only for local visual debugging.

## Tool Behavior

### `open_font`

Accepts a filesystem URI such as `memory:///user/Fustat.glyphs` and resolves only after the app fires `fontReady` for that font.

### `open_linked_window`

Creates a linked window using the same URL/session semantics as the title-bar button and resolves only after the linked window fires `fontReady` and reports readiness back to the main window.

### `list_linked_windows`

Returns the main window as index `0` plus all linked windows with metadata including text buffer, focused view, active glyph, and font path.

### `activate_linked_window`

Targets a window by index and asks that window to focus itself and reassert its active editor view.

## Headless Validation

Run the dedicated MCP end-to-end test:

```bash
cd webapp
npm run test:mcp
```

This starts the app through Playwright's configured web server, launches the MCP bridge, opens `memory:///user/Fustat.glyphs`, creates a linked window, lists windows, and activates the linked window.
