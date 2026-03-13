# Yjs Undo/Redo & Cross-Window Collaboration

## Summary

A Yjs-based collaboration layer for the Counterpunch font editor providing:

1. **Per-glyph undo/redo** (Cmd+Z / Cmd+Shift+Z)
2. **Cross-window font syncing** via BroadcastChannel
3. **Standalone undo manager window** with searchable/filterable history
4. **Bidirectional Rust WASM delta application** (JS→Rust and Rust→JS)
5. **Batch transaction support** for Python scripts, drag operations, and bulk UI actions

The Yjs `Y.Doc` mirrors the full babelfont JSON structure as nested `Y.Map`/`Y.Array` types, enabling true CRDT merge semantics for future multi-user cloud collaboration.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Font Window                                                │
│  ┌──────────────┐    ┌───────────────┐    ┌──────────────┐ │
│  │ babelfont     │◄──►│ ChangeBridge   │◄──►│ Y.Doc        │ │
│  │ model (JSON)  │    │ (central proc) │    │ (CRDT)       │ │
│  └──────────────┘    └───────┬───────┘    └──────┬───────┘ │
│                              │ JS events          │         │
│                              ▼                    │         │
│                     ┌────────────────┐            │         │
│                     │ UI consumers   │            │         │
│                     └────────────────┘            │         │
│  ┌──────────────┐                                 │         │
│  │ fontc Worker  │◄── delta msgs ─────────────────┤         │
│  │ (Rust WASM)   │──► delta responses ────────────┤         │
│  └──────────────┘                                 │         │
│  ┌──────────────────────────┐                     │         │
│  │ UndoManager (per-glyph)  │◄────────────────────┘         │
│  │ UndoManager (font-level) │                               │
│  └──────────────────────────┘                               │
└────────────────────────────────┬────────────────────────────┘
                                 │ BroadcastChannel
                                 │ (keyed by font path)
                 ┌───────────────┼───────────────┐
                 ▼               ▼               ▼
         ┌──────────┐   ┌──────────┐   ┌────────────────┐
         │ Window 2  │   │ Window 3  │   │ Undo Manager   │
         └──────────┘   └──────────┘   └────────────────┘
                                 │
                           (future) │ y-websocket
                                 ▼
                         ┌──────────────┐
                         │ Cloud Server  │
                         └──────────────┘
```

## Data Flow

1. **Local edit** → setter in `babelfont-model.ts` → calls `ChangeBridge.recordChange(path, oldValue, newValue)`
2. **ChangeBridge** → updates Y.Doc at the corresponding `Y.Map`/`Y.Array` path inside a Yjs transaction
3. **Y.Doc** emits update → ChangeBridge broadcasts via BroadcastChannel
4. **Y.Doc** observer → ChangeBridge emits `CustomEvent("fontDataChanged", { detail: { path, value, source } })`
5. **Remote update** arrives via BroadcastChannel → applied to local Y.Doc → observer fires → ChangeBridge applies to local babelfont JSON → emits JS event
6. **Undo** → Yjs `UndoManager.undo()` → reverses Y.Doc changes → observer fires → applies to JSON → broadcasts

## Y.Doc ↔ Babelfont JSON Structure Mapping

```
Y.Doc root (Y.Map "font")
├── "upm" → number
├── "version" → Y.Array [major, minor]
├── "note" → string
├── "date" → string
├── "source" → string
├── "names" → Y.Map { locale → Y.Map { key → string } }
├── "features" → Y.Map (mirrors Babelfont.Features)
├── "format_specific" → Y.Map (recursively nested Y.Maps)
├── "custom_ot_values" → Y.Array
├── "variation_sequences" → Y.Map of Y.Maps
├── "first_kern_groups" → Y.Map { groupName → Y.Array [glyphName, ...] }
├── "second_kern_groups" → Y.Map { groupName → Y.Array [glyphName, ...] }
├── "glyphs" → Y.Map { glyphName → Y.Map }    (keyed by name, not array index)
│   └── [glyphName] → Y.Map
│       ├── "name" → string
│       ├── "production_name" → string
│       ├── "category" → string or Y.Map for { Custom: string }
│       ├── "codepoints" → Y.Array [number, ...]
│       ├── "exported" → boolean
│       ├── "direction" → string
│       ├── "formatspecific" → Y.Map (deep)
│       └── "layers" → Y.Map { layerId → Y.Map }    (keyed by layer UUID)
│           └── [layerId] → Y.Map
│               ├── "width" → number
│               ├── "name" → string
│               ├── "id" → string
│               ├── "master" → Y.Map { type, master? }
│               ├── "location" → Y.Map { axisTag → number }
│               ├── "format_specific" → Y.Map (deep)
│               ├── "shapes" → Y.Array of Y.Maps
│               │   └── [i] → Y.Map
│               │       ├── "type" → "Path" | "Component"
│               │       ├── (Path) "nodes" → Y.Array of Y.Maps { x, y, nodetype, smooth }
│               │       ├── (Path) "closed" → boolean
│               │       ├── (Component) "reference" → string
│               │       ├── (Component) "transform" → Y.Map
│               │       ├── (Component) "location" → Y.Map
│               │       └── "format_specific" → Y.Map
│               ├── "anchors" → Y.Array of Y.Maps { x, y, name, format_specific }
│               └── "guides" → Y.Array of Y.Maps { pos, name, color, format_specific }
├── "axes" → Y.Array of Y.Maps
│   └── [i] → Y.Map { name, tag, id, min, max, default, map, hidden, ... }
├── "masters" → Y.Array of Y.Maps
│   └── [i] → Y.Map { name, id, location, metrics, kerning, ... }
│       └── "kerning" → Y.Map { first → Y.Map { second → number } }
│       └── "guides" → Y.Array of Y.Maps
└── "instances" → Y.Array of Y.Maps
    └── [i] → Y.Map { id, name, location, ... }
```

**Key decisions:**

- Glyphs keyed by name in Y.Map (not Y.Array index) → avoids index-shift conflicts on add/remove
- Layers keyed by UUID in Y.Map → stable identity across insertions/deletions
- Axes/Masters/Instances remain Y.Array → ordering matters, structural edits rare

## Implementation Phases

### Phase 1: Dependencies & Core Infrastructure

1. Add `yjs` to `webapp/package.json`
2. Create `webapp/js/change-log.ts` — `ChangeLogEntry` interface
3. Create `webapp/js/change-bridge-ydoc.ts` — Y.Doc ↔ JSON sync utilities
4. Create `webapp/js/change-bridge.ts` — central change processor

### Phase 2: Model Integration

5. Add `getPath(): string[]` to `ModelBase` in `babelfont-model.ts`
6. Refactor every setter to capture old value + call `changeBridge.recordChange()`
7. Refactor collection mutations (addGlyph, removeGlyph, addLayer, etc.) to emit deltas
8. Handle `format_specific` deep dict tracking
9. Expose `window.changeBridge` in `index.d.ts`, init in `bootstrap.ts`

### Phase 3: Transaction Batching

10. Python execution → `beginTransaction("Python script")` / `endTransaction()`
11. Mouse drag → `beginTransaction("Drag ...")` / `endTransaction()`
12. Batch UI → nesting via depth counter, outermost commits

### Phase 4: Cross-Window Communication

13. Create `webapp/js/window-sync.ts` — BroadcastChannel, protocol messages
14. Font identification by file path, UUID fallback
15. New-window bootstrap via full-state-request/response

### Phase 5: Per-Glyph Undo/Redo

16. One `Y.UndoManager` per glyph (lazy), one font-level UndoManager
17. Cmd+Z / Cmd+Shift+Z shortcuts, scoped to current glyph when editing
18. UI feedback after undo/redo

### Phase 6: Undo Manager Window

19. `webapp/undo-manager.html` + `webapp/js/undo-manager-app.ts`
20. Change list with timestamp, source window, object, property, transaction label
21. Text search + object-type tag cloud + glyph-name tag cloud + window filter
22. Selective undo: "Revert this change" / "Revert entire batch"

### Phase 7: Rust/WASM Delta Bridge

23. `apply_font_delta(delta_json)` in lib.rs → patches FONT_CACHE in-place
24. `execute_font_operation(op_json) -> String` → runs op, returns deltas
25. Worker message types `applyDelta` and `executeFontOperation`
26. ChangeBridge sends deltas to worker instead of full JSON
27. Rebuild WASM

### Phase 8: Jest Tests

28. `webapp/tests/change-bridge.test.js` — every property, lifecycle, format_specific, transactions, cross-window, undo/redo
29. `webapp/tests/change-bridge-rust-delta.test.js` — Rust delta application
30. Mock BroadcastChannel in `setup.js`

### Phase 9: UI Integration

31. Title bar buttons + CSS
32. Integrate with existing compile pipeline
33. Logger facility names

## Selective Undo Conflict Resolution

### 1. Target object deleted → auto-restore

Walk target path top-down, check each segment exists in Y.Doc. Missing ancestors restored from change log snapshot (`oldValue` from deletion). Recursive (glyph → layer → shape). Single transaction labeled "Auto-restore for revert: {label}".

### 2. Target object renamed → follow renames

Change log records rename ops. `selectiveRevert()` scans forward from target change to HEAD, tracking renames affecting any path segment. UI annotates "(was A)".

### 3. Structural cascade warnings

Reverting additions computes "cascade set" of dependent changes. Shows "N dependent changes will also be reverted" with confirmation. All in one transaction.

Cascades:

- Undo glyph addition → discard subsequent glyph edits
- Undo axis addition → remove axis from all master/instance locations
- Undo master addition → remove associated layers

### 4. Concurrent cross-window edits

Reverts are forward operations (new Y.Doc changes), never history rewrites. CRDT merge handles convergence.

### 5. Shape/anchor/guide identity

Y.Array items tracked by index + content fingerprint (first+last node coords for paths, name for anchors). If fingerprint fails, undo manager shows warning.

## Key Decisions

- **Y.Doc mirrors full babelfont structure** (true CRDT, not delta log)
- **Glyphs keyed by name, layers by UUID** in Y.Map
- **`markFontDirty()` augmented, not replaced** — ChangeBridge calls it internally
- **Undo manager = separate window.open()** — same I/O as sync windows
- **BroadcastChannel for local sync** — sufficient for same-origin tabs
- **Font identified by file path** — UUID fallback for unsaved fonts
- **Auto-restore deleted prerequisites** on selective revert
- **Follow renames** across change log
- **Structural undo cascade** with user confirmation
- **Layers keyed by UUID** in Y.Doc and getPath()
- **Content fingerprints** for index-based objects

## Cloud Hosting Strategy (Future)

**Star topology with leader relay:**

1. First window connecting to cloud = "relay leader"
2. Leader bridges BroadcastChannel ↔ y-websocket
3. Non-leader windows use BroadcastChannel only (1 server connection, not N)
4. Leader failover via `window-closing` message
5. Yjs CRDT handles merge; offline via y-indexeddb

## New Files

- `webapp/js/change-bridge.ts`
- `webapp/js/change-bridge-ydoc.ts`
- `webapp/js/change-log.ts`
- `webapp/js/window-sync.ts`
- `webapp/js/window-buttons.ts`
- `webapp/js/undo-manager-app.ts`
- `webapp/undo-manager.html`
- `webapp/tests/change-bridge.test.js`
- `webapp/tests/change-bridge-rust-delta.test.js`

## Modified Files

- `webapp/package.json` — add yjs
- `webapp/js/babelfont-model.ts` — refactor setters, add getPath()
- `webapp/js/index.d.ts` — window.changeBridge
- `webapp/js/bootstrap.ts` — init ChangeBridge
- `webapp/js/python-ui-sync.ts` — transaction hooks
- `webapp/js/glyph-canvas/outline-editor.ts` — drag transactions
- `webapp/js/fontc-worker.ts` — delta message types
- `webapp/js/font-manager.ts` — ChangeBridge integration
- `webapp/js/url-state.ts` — fontSessionId
- `webapp/index.html` — toolbar buttons
- `webapp/css/style.css` — button styles
- `webapp/webpack.config.js` — undo-manager entry point
- `webapp/tests/setup.js` — BroadcastChannel mock
- `webapp/js/logger.ts` — facility names
- `babelfont-fontc-build/src/lib.rs` — apply_font_delta, execute_font_operation
- `babelfont-fontc-build/pkg/babelfont_fontc_web.d.ts` — new function types
