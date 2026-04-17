# Development Notes

This page collects developer-only information that does not belong in the user-facing README.

## Local Development

Run the app locally from `webapp`:

```bash
cd webapp
npm run dev
```

Useful development-only helpers:

- Load the assistant test conversation with `?assistant_style_test`
- Trigger end-to-end error reporting tests from DevTools with `window.triggerRuntimeErrorForTesting()` and `window.triggerUnhandledRejectionForTesting()`

## Python Runtime Model

Counterpunch runs Python in two separate Pyodide environments:

- Main-thread Pyodide for the console, script editor, and regular Python execution
- Glyph-filter worker Pyodide for glyph filter plugins off the UI thread

These environments are isolated. Python objects and module state are not shared directly.

### Sharing JSON-like Data Between Threads

Use the shared plugin context channel for JSON-like data only:

- Main thread sets context via `window.glyphOverviewFilterManager`
- Worker-side filter Python reads it via `Context()`
- Worker-side filter Python can send updates back via `SetContextPatch({...})`

Main-thread API:

```javascript
// Replace full snapshot
window.glyphOverviewFilterManager.setSharedPluginContext({
    project: "MyFont",
    ui: { mode: "review" },
    thresholds: { maxNodes: 1200 },
});

// Shallow patch
window.glyphOverviewFilterManager.updateSharedPluginContext({
    ui: { mode: "edit" },
});

// Read current snapshot
const ctx = window.glyphOverviewFilterManager.getSharedPluginContext();
```

Worker-side Python plugin example:

```python
def filter_glyphs(font):
    ctx = Context()  # Live Python mapping over shared context
    thresholds = ctx.thresholds if hasattr(ctx, 'thresholds') else {}
    max_nodes = thresholds.maxNodes if hasattr(thresholds, 'maxNodes') else 1000

    flagged = 0
    for glyph in font.glyphs:
        node_count = 0
        for layer in glyph.layers:
            for shape in layer.shapes:
                if hasattr(shape, 'nodes') and shape.nodes:
                    node_count += len(shape.nodes)

        if node_count > max_nodes:
            flagged += 1
            yield {'glyph_name': glyph.name, 'group': 'complex'}

    # Send patch back to main-thread context
    SetContextPatch({'lastRun': {'flagged': flagged}})
```

Object model dictionaries are also live mappings, including `master.kerning`, `font.names`, and `instance.custom_names`, and can be read or written with normal Python dict syntax without calling `.to_py()` first.

Notes:

- Keep shared context JSON-like: objects, arrays, and primitives only
- Worker uses versioned snapshots and drops stale context updates
- `SetContextPatch` applies a shallow patch merge on the main-thread context

Quick DevTools verification:

```javascript
// 1) Seed shared context from the main thread
window.glyphOverviewFilterManager.setSharedPluginContext({
    debugRunId: Date.now(),
    note: "hello-from-main",
});

// 2) Run any glyph filter that calls SetContextPatch({ ... })
// 3) Inspect merged context after the filter run
console.log(window.glyphOverviewFilterManager.getSharedPluginContext());
```

### Micropip Packages Across Both Runtimes

Because the runtimes are separate, a package needed in both must be installed in both.

- Startup wheel installs are done in both runtimes
- Lazy `micropip.install(...)` in the main thread is mirrored automatically into the glyph-filter worker

## WASM And Type Generation

### Rebuild The WASM Component

The WASM component is based on the babelfont fork at https://github.com/yanone/babelfont-rs.

To build a new WASM binary:

1. Sync the fork with upstream.
2. Note the pinned commit hash from the fork into `.babelfont-rs-ref`.
3. Run `./update-rust-deps.sh`.
4. Run `./build-fontc-wasm.sh`.
5. Run `./check-type-drift.sh` after the rebuild.

### Type Drift Detection

TypeScript types are auto-generated from `babelfont-rs` and must stay in sync. The type drift check runs automatically in `npm test`.

```bash
# Update WASM and types from latest babelfont-rs
./update-rust-deps.sh
./build-fontc-wasm.sh
./regenerate-types.sh

# Verify sync (runs in CI)
./check-type-drift.sh
```

Type generation and drift checks use `../babelfont-rs` when available. In CI, or without a local clone, the scripts fall back to `.babelfont-rs-ref` and clone a pinned repo plus commit for deterministic checks.

Pin file format:

```text
repo=https://github.com/<owner>/babelfont-rs.git
commit=<full-40-char-sha>
```

## Performance Timeline

Timeline instrumentation uses User Timing entries with the `cp:` prefix.

### Naming Map

- `cp:app.*` for app and bootstrap milestones
- `cp:font.open*` for file read, convert, and open dispatch flow
- `cp:font.openSession` and `cp:font.lifecycle.*` for post-open initialization phases
- `cp:font.compileEditing`, `cp:font.compileTyping`, and `cp:font.compileFull` for compile stages
- `cp:font.fontspectorInference` for QA check timing
- `cp:fontCompilation.*` for main-thread worker bridge and compile request lifecycle
- `cp:font.worker.*` for worker-side phases such as init, compile, open, outlines, and cache operations

### Where To Monitor In Browser

Use Chrome or Edge DevTools:

1. Open Performance in DevTools.
2. Start recording, perform an action such as opening a font or compiling, then stop recording.
3. Inspect the Timings track for `cp:*` marks and measures.

Optional console queries:

- Marks: `performance.getEntriesByType('mark').filter((e) => e.name.startsWith('cp:'))`
- Measures: `performance.getEntriesByType('measure').filter((e) => e.name.startsWith('cp:'))`

### Shrink Exported Traces For LLM Analysis

- Script: `node shrink-trace-to-timings.mjs [--llm|--summary] temp/<trace>.json [output.json]`
- Modes: default filtered `traceEvents`, `--llm` for minimal event fields, `--summary` for compact aggregates only

## Release Process

Create and deploy a new release from the repository root:

```bash
./release.sh v1.0.0
```

The script:

- Updates the version in `webapp/coi-serviceworker.js`
- Extracts release notes from the Unreleased section in `CHANGELOG.md`
- Commits the version change
- Creates and pushes a git tag
- Triggers GitHub Actions to create a release and deploy to Cloudflare Pages

Users will see an orange update notification button in the title bar within about 10 minutes and can reload to get the latest version without manually clearing cache.

## Related Developer Docs

- `APP.md` is the principal authority for application behavior
- `developer-docs/COMPILATION_EDIT_POLICY.md` is the authority for compilation scheduling and fast-path behavior
- `developer-docs/JS_EVENTS.md` documents emitted JavaScript events
