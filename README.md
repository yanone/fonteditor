# Counterpunch Font Editor

## Live App

Try the editor live:

- Latest official release (using `release.sh`): https://editor.counterpunch.space
- Latest preview (updated after each succesful push): https://preview.editor.counterpunch.space

## Develop

Run the app locally with `cd webapp && npm run dev`

- Load assistant test conversation with `?assistant_style_test`
- Trigger end-to-end error reporting tests from DevTools: `window.triggerRuntimeErrorForTesting()` and `window.triggerUnhandledRejectionForTesting()`

### Python Runtime Model (Main Thread + Worker)

Counterpunch now runs Python in two separate Pyodide environments:

- **Main thread Pyodide**: console, script editor, regular Python execution.
- **Glyph filter worker Pyodide**: glyph filter plugins, off the UI thread.

These environments are isolated. Python objects and module state are not shared directly.

### Sharing JSON-like Data Between Threads

Use the shared plugin context channel (JSON-like data only):

- Main thread sets context via `window.glyphOverviewFilterManager`.
- Worker-side filter Python reads it via `Context()`.
- Worker-side filter Python can send updates back via `SetContextPatch({...})`.

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
		thresholds = ctx.thresholds if hasattr(ctx, "thresholds") else {}
		max_nodes = thresholds.maxNodes if hasattr(thresholds, "maxNodes") else 1000

		flagged = 0
		for glyph in font.glyphs:
				node_count = 0
				for layer in glyph.layers:
						for shape in layer.shapes:
								if hasattr(shape, "nodes") and shape.nodes:
										node_count += len(shape.nodes)

				if node_count > max_nodes:
						flagged += 1
						yield {"glyph_name": glyph.name, "group": "complex"}

		# Send patch back to main thread context
		SetContextPatch({"lastRun": {"flagged": flagged}})
```

Object model dictionaries are also live mappings (e.g. `master.kerning`, `font.names`, `instance.custom_names`) and can be read/written with normal Python dict syntax without calling `.to_py()` first.

Notes:

- Keep shared context **JSON-like** (objects/arrays/primitives); avoid functions/class instances.
- Worker uses versioned snapshots and drops stale context updates.
- `SetContextPatch` is a shallow patch merge on the main-thread context.

Quick DevTools verification (context round-trip):

```javascript
// 1) Seed shared context from main thread
window.glyphOverviewFilterManager.setSharedPluginContext({
    debugRunId: Date.now(),
    note: "hello-from-main",
});

// 2) Run any glyph filter that calls SetContextPatch({ ... })
// 3) Inspect merged context after filter run
console.log(window.glyphOverviewFilterManager.getSharedPluginContext());
```

### Micropip Packages Across Both Runtimes

Because runtimes are separate, a package needed in both must be installed in both.

- Startup wheel installs are done in both runtimes.
- Lazy `micropip.install(...)` in main thread is mirrored automatically into the glyph filter worker.

### Rebuild wasm component

Currently the wasm component is based on the babelfont fork https://github.com/yanone/babelfont-rs because of changes that we sometimes PR. To build a new wasm binary, do the following:

1. Sync fork with upstream
2. Note down pinned commit hash from fork into `.babelfont-rs-ref`
3. Run `./update-rust-deps.sh`
4. Run `./build-fontc-wasm.sh`
5. Either later or immediately run `./check-type-drift.sh`, see below

### Type Drift Detection

TypeScript types are auto-generated from `babelfont-rs` and must stay in sync. The type drift check runs automatically in `npm test`:

```bash
# Update WASM and types from latest babelfont-rs
./update-rust-deps.sh
./build-fontc-wasm.sh
./regenerate-types.sh

# Verify sync (runs in CI)
./check-type-drift.sh
```

Type generation and drift checks use `../babelfont-rs` when available. In CI (or without a local clone), scripts fall back to `.babelfont-rs-ref` and clone a pinned repo+commit for deterministic checks.

Pin file format:

```text
repo=https://github.com/<owner>/babelfont-rs.git
commit=<full-40-char-sha>
```

### Performance Timeline (Developer)

Timeline instrumentation uses User Timing entries with the `cp:` prefix.

#### Naming Map (high-level)

- `cp:app.*` → app/bootstrap milestones (module load, URL-open path, DOM ready)
- `cp:font.open*` → file read/convert/open dispatch flow
- `cp:font.openSession` and `cp:font.lifecycle.*` → post-open initialization phases
- `cp:font.compileEditing`, `cp:font.compileTyping`, `cp:font.compileFull` → compile stages
- `cp:font.fontspectorInference` → QA check timing
- `cp:fontCompilation.*` → main-thread worker bridge and compile request lifecycle
- `cp:font.worker.*` → worker-side phases (init, compile, open, outlines, interpolation, cache ops)

#### Where to Monitor in Browser

Use Chrome or Edge DevTools:

1. Open **DevTools → Performance**
2. Start recording, perform an action (open font / compile), stop recording
3. Inspect **Timings** track for `cp:*` marks/measures

Optional live console queries:

- Marks: `performance.getEntriesByType('mark').filter(e => e.name.startsWith('cp:'))`
- Measures: `performance.getEntriesByType('measure').filter(e => e.name.startsWith('cp:'))`

#### Shrink exported traces for LLM analysis

- Script: `node shrink-trace-to-timings.mjs [--llm|--summary] temp/<trace>.json [output.json]`
- Modes: default = filtered `traceEvents`, `--llm` = minimal event fields, `--summary` = compact aggregates only.

## Releasing a New Version

To create and deploy a new release, run the release script from the repository root:

```bash
./release.sh v1.0.0
```

This script automatically:

- Updates the version number in `webapp/coi-serviceworker.js`
- Extracts release notes from the "Unreleased" section in `CHANGELOG.md`
- Commits the version change
- Creates and pushes a git tag
- Triggers GitHub Actions to create a release and deploy to Cloudflare Pages

Users will see an orange update notification button in the title bar within 10 minutes and can reload to get the latest version without manually clearing their cache.

## Roadmap

### Pre-historic bootstrapping phase

- ✅ Bidirectional text shaping
- ✅ Super basic outline editing
- ✅ Live recompilation during editing
- ✅ Variable preview, live interpolation, animation
- ✅ Assistant generates Python code
- ✅ Canvas drawing plugins

### Pre-babelfont-ts Foundation (Due: Feb 2, 2026)

**Website and subscription system while waiting for `babelfont-ts`**

- ✅ Cloudflare setup
- ✅ Cloudflare Workers - AI Assistant Relay
- ✅ Authentication system - Passwordless
- ✅ Usage metering and billing sync
- ✅ User dashboard
- ✅ Stripe setup
- ✅ Website content
- ✅ Terms of service, privacy policy
- ✅ Configure custom domains
- ✅ Website design
- ✅ Canvas plugin system

### v0.2 (Due: Feb 15, 2026)

**`babelfont-ts` object model integration — Counterpunch becomes an analysis tool**

- ✅ User file sytem I/O
- ✅ App state saved in URL, can be shared and restored
- ✅ .babelfont input/outut
- ✅ .glyphs input/outut
- ✅ .glyphspackage input
- ✅ .sfb input
- ◻️ .vfj input
- ◻️ .vfb input
- ✅ Python scripts I/O
- ✅ Glyph overview
- ✅ Grid glyph overview
- ✅ Glyph search and filtering
- ✅ Glyph filtering plugins
- ✅ Insert glyphs into editor text
- ✅ Show intermediate masters
- ✅ OpenType feature code editor
- ✅ OpenType feature code error display inline
- ✅ Hot-reloading fonts on external changes (Chrome/Chromium only)
- ✅ Fontspector integration (glyph-level messages later)
- ✅ Open fonts in PWA directly
- ◻️ Interactive demo
- ✅ Basic documentation
- ✅ First video

### v0.3 (Due: Mar 10, 2026)

**Counterpunch becomes a simple font editor**

- ◻️ Multi-line editing
- ◻️ Basic layer/glyph operations
- ◻️ Contour point manipulation
- ◻️ Component editing
- ◻️ Anchor editing
- ◻️ Guideline editing
- ◻️ Layer management UI
- ◻️ Python script fast UI
- ✅ Undo/redo system
- ◻️ Clipboard operations
- ◻️ Selection tools
- ◻️ Font info editing
- ◻️ Master/instance management
- ◻️ Path operations (boolean)
- ◻️ Transform tools
- ◻️ Kerning UI
- ◻️ Automatic glyph metric updates
- ◻️ Automatic glyph composition

### v0.4 (Due: Apr 1, 2026)

**Extended features — Counterpunch becomes a full-featured font editor**

- ◻️ avar2 editor
- ◻️ Variable components
- ◻️ OpenType feature code generator
- ◻️ Glyph composition UI (OpenType ccmp)
- ◻️ Contextual kerning/positioning UI
- ✅ Multiple font windows
- ◻️ Plugin system architecture complete

### v0.5 (Due: Apr 21, 2026)

Cleanup, documentation, testing, videos

- ◻️ Performance optimization
- ◻️ Memory usage optimization
- ◻️ Unit test coverage
- ◻️ Integration test suite
- ◻️ End-to-end tests
- ◻️ Browser compatibility testing
- ◻️ Code documentation
- ◻️ Load testing
- ◻️ User guide completion

### v0.6 Public Beta (Due: May 10, 2026)

- ◻️ Monitoring and analytics setup
- ◻️ Security and penetration testing
- ◻️ Demo video production
- ◻️ Public announcement

### v0.7...v0.9

Polish, incorporate user feedback

### v1.0 Public Release (Due: October 2026)
