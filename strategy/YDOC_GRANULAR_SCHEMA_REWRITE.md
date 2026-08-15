# Y.Doc Granular Schema Rewrite

## Status

Proposed. Alpha stage — no backward-compatibility constraints.

## Goal

Make every leaf-level font-data edit (a node coordinate, a kerning value, a
sidebearing, an anchor position, a node-type conversion) transmit only that
leaf over the collaboration channel and into the Rust worker — never the
surrounding array, shape, layer, or glyph. Keep storage and CPU at the floor
on both the editor and the `collab` Durable Object.

This is a prerequisite for efficient online collaboration: the current schema
re-serializes whole layers/glyphs on routine structural path operations, which
violates `COMPILATION_EDIT_POLICY.md` §11/§12 (incremental Yjs only, no
full-document resends) and balloons wire traffic and server storage under
editing churn.

## Current state — what's granular and what isn't

| Collection | Current storage | Granular on small edit? | Failure mode |
| --- | --- | --- | --- |
| `glyphs`, `layers` | `Y.Map` keyed by name/id | Yes | — |
| `format_specific` (all levels) | nested `Y.Map`, deep-merged | Yes | — |
| `master.kerning`, `metrics` | nested `Y.Map` | Yes | — |
| `features.classes`, `prefixes` | `Y.Map` keyed by name | Yes | — |
| **`layer.shapes`** | `Y.Array<Y.Map>` | **No** | wholesale-replaced in `_applyLayerDelta` (`patch-sync-engine.ts:5017`) |
| **`path.nodes`** | `Y.Array<Y.Map>` inside shapes | **No** | inherits shapes replace; `_replaceYArrayContents` tears down on any length change |
| **`layer.anchors`**, **`layer.guides`** | `Y.Array<Y.Map>` | **No** | same wholesale-replace special case |
| `first/second_kern_groups` values | `Y.Map<group, Y.Array<string>>` | Partial | group add/delete granular; membership change hits array teardown |
| `features.features` | `Y.Array<[tag, code]>` | Partial | teardown on length change (tags are **not** unique — confirmed) |
| `codepoints`, `axes`, `instances`, `masters` | `Y.Array` | Yes/Partial | small N, low churn — not worth optimizing |

**Headline inefficiency:** a node drag commits a layer-snapshot, and
`_applyLayerDelta` does `layerMap.set('shapes', toYType(value))` — the entire
`shapes` array (every path, every node of the layer) goes into the binary
delta.

## The path-operations problem (researched)

Structural path operations have **two** wholesale layers stacked on top of the
shapes wholesale-replace:

### Layer 1 — model recording

Fifteen `recordAndMarkDirty(this, 'nodes', oldNodes, nextNodes)` call sites in
`babelfont-model.ts` replace the entire `nodes` array and record it as a
whole-`nodes`-field change:

| Operation | Site | What it records |
| --- | --- | --- |
| `set nodes` setter (escape hatch) | `:3881` | whole `nodes` array |
| `_addPoint` (insert node on a segment) | `:4003` | whole `nodes` array (new node + reindexed siblings) |
| `_setStartNode` (change start point, closed contour) | `:4271` | whole `nodes` array — **but it's a pure rotation, no node data changes** |
| open-at-node (rotate + set first to Move) | `:4212` | whole `nodes` array — also a pure rotation + one field flip |
| `_splitOpenPathAtNode` | `:4233` | whole `nodes` array for the first contour; second contour created separately |
| `_reverseDirection` | `:4294`+ | whole `nodes` array — a **pure reorder** of control points within segments, no node data changes |
| `_deleteNodes` (multi-delete with segment merge) | `:4541`, `:4601` | whole merged `nodes` array |
| convert / normalize / toggle-smooth paths | `:4366`, `:4399`, `:4464`, `:4505` | whole `nodes` array |

Only `insertNode` (`:3933`) and `removeNode` (`:3956`) record granular
index-based entries. Everything else — including operations that are
fundamentally *reorders* (set start point, reverse direction) where no node
*data* changes at all — rebuilds and records the whole array. The rebuild uses
`cloneNodeData`, so **node identity is destroyed** on every structural op:
reverse and set-start-point produce cloned nodes, not reordered originals.

### Layer 2 — commit path

After any structural path op, `OutlineEditor.syncStructuralGlyphChangeTransaction`
(`outline-editor.ts:5262`) calls `bridge.syncGlyphFromJson` /
`syncLayersFromJson` (`patch-sync-engine.ts:1066`/`1097`). These **re-serialize
the entire glyph (or multiple whole layers) from the model JSON** and push them
as `glyph-snapshot` / `layer-snapshot` operations — regardless of the granular
entries the model just recorded. The recorded change-log entries are used for
undo/history; the *Yjs apply* gets the whole-glyph snapshot. This is the
"full JSON" path and a direct violation of policy §11/§12.

So the current reality for "set start point of a 20-node contour": the model
clones all 20 nodes into a rotated array, records a 20-node change, then the
commit re-serializes the entire glyph and pushes it as a snapshot — when the
*logical* change is "reorder 20 ids, mutate zero node fields."

## Root cause summary

Three reinforcing causes:

1. **No stable node identity.** Nodes have no `id`; the model addresses them by
   array index. Any index shift (insert/delete/reorder) "changes" every
   downstream node's address, so the easy expression is "here's the new whole
   array." `cloneNodeData` in reorder ops destroys identity too.
2. **The shapes/anchors/guides wholesale-replace** in `_applyLayerDelta`
   (`patch-sync-engine.ts:5017`) — the Rust deserialization workaround from
   commit `0eaaae52` (numeric-keyed-Y.Map and wrapped-shapes failures).
3. **`syncStructuralGlyphChangeTransaction` uses `syncGlyphFromJson`** for all
   structural path ops, bypassing the granular change-log path entirely.

The indexed-map schema dissolves #1 and #2 structurally. #3 is a commit-path
change that must land alongside the schema.

### Origin of the Rust deserialization concern (commit `0eaaae52`)

Two failure modes, both triggered by in-place `Y.Array<Y.Map>` mutation:

- **Wrapped shapes.** The babelfont model stores a `Shape` as a tagged union
  `{Path: {…}}` / `{Component: {…}}`; babelfont-rs expects the unwrapped form.
  In-place mutation bypassed the unwrap boundary, so wrapped shapes leaked into
  the Y.Doc and `serde_json::from_value::<Shape>` failed. (Already fixed
  permanently by strict validation at boundaries —
  `extractPathShape`/`extractComponentShape` + `layer-data-normalizer`.)
- **Nodes as a numeric-keyed `Y.Map`.** In-place `Y.Array<Y.Map>` rewrites
  intermittently produced `Y.Map`s with keys `"0"`, `"1"`, … where a `Y.Array`
  was expected, specifically for `nodes`. The defensive `yrs_map_to_json`
  numeric-key heuristic (`lib.rs:1612`, test at `:4320`) papered over the common
  case but couldn't handle mixed keys, so `Shape` deserialization still failed
  intermittently. The wholesale-replace was the blunt fix.

The rewrite dissolves both: `nodes` is *defined* to be a `Y.Map<id, nodeMap>`
(data) + `Y.Array<id>` (order), so the "is this a Y.Array or a numeric-keyed
Y.Map?" ambiguity cannot arise. Shapes carry an explicit `kind` discriminator,
so no tagged-union wrapper can leak. The numeric-key heuristic and the
wholesale-replace special case both become dead code and are deleted together.

## New Y.Doc schema

Principle: **`Y.Map` keyed by stable id for identity-stable collections;
`Y.Array` only to carry order, holding primitive ids.**

```
font (Y.Map)
├── glyphs (Y.Map<name, glyphMap>)                ← unchanged
│   └── glyphMap (Y.Map)
│       ├── name, production_name, category, exported, direction   (primitives)
│       ├── codepoints (Y.Array<number>)          ← small, leave
│       ├── layers (Y.Map<layerId, layerMap>)     ← unchanged
│       │   └── layerMap (Y.Map)
│       │       ├── width, name, color, layer_index, is_background,
│       │       │   background_layer_id, master, location          (primitives / small maps)
│       │       ├── format_specific (Y.Map)       ← unchanged, granular
│       │       ├── shapesById   (Y.Map<shapeId, shapeMap>)   ← NEW
│       │       ├── shapeOrder   (Y.Array<shapeId>)           ← NEW (order only)
│       │       ├── anchorsById  (Y.Map<anchorId, anchorMap>) ← NEW
│       │       ├── anchorOrder  (Y.Array<anchorId>)          ← NEW
│       │       ├── guidesById   (Y.Map<guideId, guideMap>)   ← NEW
│       │       └── guideOrder   (Y.Array<guideId>)           ← NEW
│       └── component_axes (Y.Array)              ← rare, leave
├── masters (Y.Map<masterId, masterMap>)          ← promote Array→Map
│   └── masterMap: kerning/metrics already granular; guidesById+guideOrder if needed
├── features (Y.Map)
│   ├── classes, prefixes (Y.Map<name, …>)        ← unchanged, granular
│   └── features (Y.Array<[tag, featCodeMap]>)    ← keep Array (tags not unique); LCS-diff
├── first_kern_groups  (Y.Map<group, Y.Array<string>>)   ← keep; LCS-diff the lists
├── second_kern_groups (Y.Map<group, Y.Array<string>>)   ← same
├── axes, instances, cross_axis_mappings (Y.Array)       ← small/rare, leave
└── format_specific (Y.Map)                               ← unchanged
```

### Shape sub-schemas (explicit `kind` discriminator — no tagged-union wrapper)

```
shapeMap (Y.Map)
├── kind: "Path" | "Component"     ← explicit; eliminates wrapped-shape ambiguity
├── shapeId: string                ← mirrors the shapesById key (debugging/Rust)
└── …kind-specific fields…

Path:
├── kind: "Path"
├── nodesById (Y.Map<nodeId, nodeMap>)    ← THE hot leaf container
├── nodeOrder (Y.Array<nodeId>)           ← order only
├── closed (boolean)
└── format_specific (Y.Map)

Component:
├── kind: "Component"
├── reference (string)
├── transform (Y.Map: translation, scale, rotation, skew, order)   ← granular sub-fields
├── location (Y.Map<string, number>)                               ← granular
└── format_specific (Y.Map)

nodeMap (Y.Map): nodeId, x, y, nodetype, smooth?   ← each a primitive leaf
```

### Per-edit cost after the rewrite

| Edit | Yjs ops | Binary delta |
| --- | --- | --- |
| Drag node (x,y) | `nodesById.get(id).set('x'/'y',…)` | ~2 leaf Sets — **floor** |
| Insert node (append/simple) | `nodesById.set(newId, nodeMap)` + `nodeOrder.insert(k,[newId])` | 2 ops |
| Insert node on segment (`_addPoint`) | 1 `nodesById.set` + 1 `nodeOrder` insert | 2 ops (was: whole glyph snapshot) |
| Delete node | `nodesById.delete(id)` + `nodeOrder.delete(idx,1)` | 2 ops |
| Multi-delete with merge | N × (`nodesById.delete` + `nodeOrder.delete`) | 2N small ops (was: whole nodes array) |
| **Set start point** | `nodeOrder` array diff only — **zero node-data writes** | ~N id refs (was: whole glyph snapshot) |
| **Reverse direction** | `nodeOrder` array diff only — **zero node-data writes** | ~N id refs (was: whole glyph snapshot) |
| Split contour | move ids between `nodeOrder` + new `shapesById` entry | ~N id refs + 1 shape add |
| Convert node type / toggle smooth | `nodesById.get(id).set('nodetype'/'smooth',…)` | 1 leaf Set |
| Add/remove a path | one `shapesById` set/delete + one `shapeOrder` ins/del | 2 ops |
| Move anchor | `anchorsById.get(id).set('x'/'y',…)` | ~2 leaf Sets |
| Change sidebearing | `layerMap.format_specific.…` leaf set | 1 op |
| Change kerning pair | `masters.byId[m].kerning[left][right]` leaf set | 1 op |

The two bolded rows are the prize of the path-ops research: operations that
today send a whole glyph snapshot become **pure order-array diffs with zero
node-data writes**, because node identity is preserved and only the id sequence
changes.

## Stable identity — the prerequisite

The indexed-map pattern requires a stable `id` on `Node`, `Anchor`, `Path`,
`Component`, `Guide`. Content-hashing fails (editing a node changes its hash).
**Add an optional `id` field to those structs in babelfont-rs; generate a UUID
on load when absent; persist across `.glyphs`/`.babelfont`/`.ufo` round-trips.**

This is independently useful beyond Yjs: the editor's selection state, undo,
and linked-layer matching currently rely on fragile array indices; stable ids
fix a whole class of bugs. Coordinate with the babelfont-rs author (already
rewriting) so all format round-trips preserve `id` or regenerate deterministically.

Fallback if the Rust change slips: client-generated ids stashed in
`format_specific["counterpunch.id"]` per element. Pollutes `format_specific`
and complicates Rust, so push for the native field.

## Model-side path-operation rewrite (the core addition)

The model must stop treating structural path ops as "rebuild the whole nodes
array." Two rules:

### Rule 1 — Preserve node identity

Reorder operations (`_setStartNode`, `_reverseDirection`, open-at-node) must
stop using `cloneNodeData` + rebuild. They reorder the existing node objects in
`data.nodes` in place (each keeps its `.id`), then emit an order-only change.
The node *data* (x, y, nodetype, smooth) does not change for any node in a pure
reorder.

### Rule 2 — Emit granular id-based change-log entries

Each operation decomposes into entries against the indexed-map structure:

| Operation | Change-log entries emitted |
| --- | --- |
| `_addPoint` (insert on segment) | `recordAdd([...path,'nodesById',newId], nodeData)` + `recordPathChange([...path,'nodeOrder'], oldOrder, newOrder)` |
| `_setStartNode` | `recordPathChange([...path,'nodeOrder'], oldOrder, rotatedOrder)` — **zero node-data entries** |
| `_reverseDirection` | `recordPathChange([...path,'nodeOrder'], oldOrder, reversedOrder)` — **zero node-data entries** |
| open-at-node | `recordPathChange([...path,'nodeOrder'], …)` + `recordPathChange([...path,'nodesById',id,'nodetype'], …, 'Move')` + `recordPathChange([...path,'closed'], …, false)` |
| `_splitOpenPathAtNode` | `recordPathChange([...path,'nodeOrder'], …, firstOrder)` + `recordAdd([...layerPath,'shapesById',newShapeId], newShapeMap)` + `recordAdd([...layerPath,'shapeOrder',k], newShapeId)` — moved nodes keep their ids/data, just reparented |
| `_deleteNodes` (merge) | per deleted id: `recordRemove([...path,'nodesById',id], …)` + `recordPathChange([...path,'nodeOrder'], …)` |
| convert / toggle-smooth | `recordPathChange([...path,'nodesById',id,'nodetype'/'smooth'], …)` — one leaf |
| `insertNode`/`removeNode` (already granular) | unchanged, but path becomes `[...,'nodesById',newId]` + `[...,'nodeOrder',idx]` instead of `[...,'nodes',idx]` |

The `set nodes` setter (`:3881`, the escape hatch) is removed or restricted to
construction. All mutations go through the granular methods.

The model can keep `data.nodes` as a flat array internally for
geometry/rendering (the canvas reads it); the indexed-map structure is the
Y.Doc boundary representation. The model's path ops mutate the flat array in
place (preserving ids) and emit the corresponding id-based change entries. A
small `NodeOrder` helper can derive/maintain `nodeOrder` from the flat array
when emitting order changes.

## Commit-side rewrite

`syncStructuralGlyphChangeTransaction` (`outline-editor.ts:5262`) must **stop
calling `syncGlyphFromJson` / `syncLayersFromJson`** for path operations. Those
methods re-serialize the whole glyph/layer and push a snapshot — the policy
violation.

Instead: the granular id-based change-log entries recorded by the model ops
(Rule 2 above) flow through the normal commit path. The transaction wraps them
in `beginTransaction`/`endTransaction` for atomic undo, but the individual
entries are deep-path granular sets/adds/removes, which route through
`setYPath(this.fontMap, applyPath, applyValue)` (`patch-sync-engine.ts:3463`) —
the granular apply path, not `_applyLayerDelta`/`_applyGlyphSnapshot`.
`workerReplayTargets` are still stamped on the transaction (policy §11) so the
worker gets `layerTargets` for Rust cache patching; the Yjs delta itself is
granular.

`syncGlyphFromJson`/`syncLayersFromJson`/`syncGlyphsFromJson` remain only for
genuine whole-glyph/whole-layer events (font open, Python bulk edits that truly
rewrite a glyph, cross-glyph renames) — not for routine structural path edits.

## Reorder policy

Out of scope for this rewrite. Ship with `Y.Array<id>` order (clean for
different-element concurrent ops, deterministic for same-element). **Block
simultaneous glyph editing in a later pass** to eliminate same-element reorder
conflicts entirely. Isolate order read/write behind an `OrderCollection`
interface (`getOrder`, `move`, `insert`, `remove`) so a future swap to
fractional-index `Y.Map<id, pos>` (Figma-style) is a drop-in if blocking proves
too coarse.

The common operations — coordinate updates, inserts, deletes — are clean and
unsurprising under CRDT semantics regardless; they don't need the blocking.

## Server-side tombstone control

With per-coordinate leaf Sets, the remaining storage concern is tombstone
accumulation from churn. Two levers:

1. **Client coalescing** (already mandated by policy): live drags use the
   preview-overlay path; the authoritative Y.Doc only sees the commit-on-pointer-up
   final value, not every pixel. Keep this invariant — it's what stops a
   1000-step drag from producing 1000 tombstones.

2. **Compacted checkpoints** (`collab/collab/src/font-room-do.js`): today
   `_checkpointToR2` writes `Y.encodeStateAsUpdate(this.yDoc)` with `gc: false`,
   so R2 snapshots carry tombstones. Replace with: construct a fresh
   `Y.Doc({gc: true})`, `Y.applyUpdate(fresh, Y.encodeStateAsUpdate(old))`, then
   snapshot the fresh doc to R2. The fresh doc never observed the individual
   deletes as separate ops, so its encoded state is tombstone-free → R2 snapshots
   shrink to logical font size. SQLite `room_log` rows are already trimmed
   post-checkpoint, so SQLite stays bounded.

   Optionally flip the live relay doc (`this.yDoc = new Y.Doc({ gc: false })`
   at `:1216`) to `gc: true` as well — stale-state-vector concerns are already
   handled by the `sync-step1/step2` round-trip and full-state bootstrap. Test
   it; if any peer-sync edge appears, fall back to `gc:false`-live +
   compacted-checkpoints.

## Worker cache — single funnel (done / required)

Do not keep a second long-lived JS `Y.Doc` (`workerCacheYDoc`) or whole-layer
encode path (`buildWorkerYjsLayerUpdate*` / `submitLayerUpdatesToWorkerCache`).
The worker receives only authoritative `PatchSyncEngine` deltas via
`forwardWorkerYjsUpdate`. Bootstrap and quarantine recovery reseed Rust from
`encodeBridgeState()` only.

## Implementation phases

### Phase 0 — Stable ids in babelfont-rs + model

- Add optional `id` to `Node`, `Anchor`, `Path`, `Component`, `Guide` in
  babelfont-rs; UUID on load; round-trip all formats.
- `babelfont-model.ts`: expose `id`; node/shape/anchor/guide wrappers carry it.
- Unblocks everything; standalone selection/undo win.

### Phase 1 — Editor selection-by-id

- `OutlineEditor` selection migrates from array index to id. Prerequisite: the
  schema rewrite is useless if selection can't address by id. Validates id
  plumbing before touching the Y.Doc.

### Phase 2 — Model path-op identity preservation + granular recording

- Rewrite the 15 `recordAndMarkDirty(this, 'nodes', …)` sites per the table
  above.
- Eliminate `cloneNodeData` in reorder ops; reorder existing node objects in
  place.
- Add `NodeOrder` helper to derive/maintain `nodeOrder` from the flat array.
- Restrict/remove the `set nodes` escape hatch.
- This is the largest model-side change and the heart of the path-ops fix.

### Phase 3 — Indexed-map schema, JS side

- `toYType`/`fromYType`/`setYPath`/`deleteYPath` (`change-bridge-ydoc.ts`):
  emit/read `shapesById`+`shapeOrder`, `nodesById`+`nodeOrder`,
  `anchorsById`+`anchorOrder`, `guidesById`+`guideOrder`.
- Rewrite `_applyLayerDelta` to apply the indexed-map layout; **delete the
  shapes/anchors/guides wholesale-replace** (`patch-sync-engine.ts:5017`).
- Introduce the `OrderCollection` interface over `Y.Array<id>`.
- Update `serializeLayerForStorage`/`serializeLayerForCommittedSync`/
  `syncSerializedLayerIntoObjectModel`/`syncSerializedLayerIntoStoredFontData`
  for the new read-back shape.
- **Rewrite `syncStructuralGlyphChangeTransaction`** to route through the
  granular commit path (the recorded id-based entries), not `syncGlyphFromJson`.
  Keep `syncGlyphFromJson` only for genuine whole-glyph events.

### Phase 4 — Indexed-map schema, Rust side

- `ydoc_layer_to_json`/`ydoc_glyph_to_json`/`ydoc_get_layer_json_with_txn`/
  `ydoc_get_glyph_json_with_txn`: read `shapesById`+`shapeOrder` etc.,
  reconstruct ordered JSON for babelfont-rs deserialization.
- `apply_sparse_layer_json_to_cached_layer` / `replace_layer_in_font_cache` /
  `replace_glyph_in_font_cache` / `replace_layer_json_entry`: consume the new
  JSON shape.
- **Delete the `yrs_map_to_json` numeric-key heuristic** (`lib.rs:1612`, test
  `:4320`) — no longer load-bearing.
- Worker-cache steady-state is `forwardWorkerYjsUpdate` only (single funnel);
  no JS worker-mirror `Y.Doc` and no whole-layer encode exceptions.

### Phase 5 — LCS diffing for remaining `Y.Array`s

- Replace `_replaceYArrayContents` teardown with minimal-op LCS diff.
- Targets: `features.features`, kern-group glyph-name lists, `codepoints`.
- Small/rare arrays (`axes`, `instances`, `masters` structural) stay on the
  simple path.

### Phase 6 — Server-side compaction

- `font-room-do.js`: compacted (tombstone-free) snapshots at checkpoint;
  optionally `gc: true` on the relay doc after validating stale-peer sync.
- Trim old `room_log` rows after compacted checkpoint (existing logic).

### Phase 7 — Budget tests + regression locks

- `tests/change-bridge.test.js` / `tests/font-manager.test.js`: per-edit Yjs
  delta byte budgets —
  - node-coordinate edit → < ~200 bytes
  - kerning-value edit → < ~150 bytes
  - anchor move → < ~200 bytes
  - sidebearing → < ~150 bytes
  - insert/delete node → < ~250 bytes
  - **set start point (20-node contour) → < ~600 bytes (order-only, zero
    node-data writes)**
  - **reverse direction (20-node contour) → < ~600 bytes (order-only)**
- Extend the boundary-crossing budget (policy) to assert Yjs delta bytes, not
  just `submitBatchCalls`/`layersTransmitted`/`fullFontCrossings`.
- Regression test: Rust worker deserializes a layer after a granular
  node-coordinate edit (the original `0eaaae52` failure mode) — proves the
  schema fix.
- Test: `yrs_map_to_json` heuristic removed and nodes still deserialize (proves
  it's dead code).

### Phase 8 (follow-up, separate) — Block simultaneous glyph editing

- Per-glyph edit lock to eliminate same-element concurrent-reorder conflicts.
  `OrderCollection` interface leaves room for fractional-index upgrade if
  blocking proves too coarse.

## Policy doc updates (land with the relevant phases)

- **§11** — update: structural path operations (insert/delete node, set start
  point, reverse, split, convert) now emit granular id-based entries through the
  shared funnel; they no longer use `syncGlyphFromJson`/`syncLayersFromJson`
  whole-snapshot sync. `layerTargets` still stamped on the transaction.
- **§22** ("Node arrays are producer invariants") — reframe: node data is
  materialized as `nodesById` entries with stable ids; `nodeOrder` carries only
  ids. The no-sanitizing spirit is preserved (boundaries throw on missing ids,
  not repair). The `nodes: Node[]` flat array remains a model-internal
  representation for geometry; the Y.Doc boundary uses the indexed-map form.
- **§12** — affirm: structural path ops now enter the single funnel with
  granular entries, not parallel glyph-snapshot paths.
- **New rule — node identity preservation:** reorder operations must not clone
  nodes; they reorder existing node objects, preserving `.id`, so that
  order-only changes produce zero node-data Yjs ops.

## Coordinated change — compile-hint reclassification for layer-level `format_specific` kerning

Separate from this rewrite but coordinated with the babelfont-rs author's
kerningRTL move (see `developer-docs/RTL_KERNING_STRATEGY.md`): once
`kerningRTL` lives under `Layer.format_specific` instead of
`Font.format_specific`, the edit path becomes layer-scoped
(`glyphs.X.layers.Y.format_specific.…kerningRTL`).
`shouldInvalidateLayoutClosureForCommittedEntries` and
`inferCommittedEditTypeFromEntries` (`change-bridge-init.ts`) currently read
layer-scoped `format_specific` paths as visual layer edits. Add detection for
`format_specific[…kerningRTL]` (and `…kerningVertical`) paths → emit
`nonGlyphChangeHints: ['kerning-value']` + `kerning-only` compile mode,
mirroring how `isSidebearingKeyMetadataPath` special-cases
`.format_specific.metric_left/right` today.

## Out of scope

- Concurrent same-element reorder semantics (Phase 8 blocks it).
- `features.features` uniqueness (confirmed not unique; stays `Y.Array` + LCS).
- Small/rare arrays (`axes`, `instances`, `masters` structural,
  `cross_axis_mappings`, `codepoints` beyond LCS).
- Backward compatibility (alpha).

## Key file references

| Concern | File |
| --- | --- |
| Y.Doc ↔ JS conversion | `webapp/js/change-bridge-ydoc.ts` (`toYType`, `fromYType`, `setYPath`, `deleteYPath`) |
| Layer/glyph apply + array merge | `webapp/js/patch-sync-engine.ts` (`_applyLayerDelta`, `_replaceYArrayContents`, `_replaceYMapContents`, `syncGlyphFromJson`, `syncLayersFromJson`) |
| Structural path-op commit | `webapp/js/glyph-canvas/outline-editor.ts` (`syncStructuralGlyphChangeTransaction`) |
| Model path operations | `webapp/js/babelfont-model.ts` (`Path.insertNode`/`_addPoint`/`_setStartNode`/`_reverseDirection`/`_splitOpenPathAtNode`/`_deleteNodes`, `Layer.addShape`/`removeShape`) |
| Layer serialization | `webapp/js/font-manager.ts` (`serializeLayerForStorage`, `serializeLayerForCommittedSync`, `buildWorkerYjsLayerUpdateForDoc`, `submitLayerUpdatesToWorkerCache`) |
| Rust Y.Doc read/write | `babelfont-fontc-build/src/lib.rs` (`ydoc_layer_to_json`, `yrs_map_to_json`, `apply_sparse_layer_json_to_cached_layer`, `apply_yjs_update`) |
| Collab server (tombstone/checkpoint) | `../collab/collab/src/font-room-do.js` (`_applyAndJournalUpdate`, `_checkpointToR2`) |
| Authoritative edit policy | `developer-docs/COMPILATION_EDIT_POLICY.md` (§11, §12, §19, §22, §26) |
| RTL kerning strategy | `developer-docs/RTL_KERNING_STRATEGY.md` |
