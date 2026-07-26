# Proposal: Stable Shape Identity in Y.Doc

**Status:** Proposal. Do not begin a partial migration.

**Motivation:** Repeated committed edits to a path can leave the Rust/Yrs
worker with duplicate parent shapes while the browser Y.Doc and object model
remain correct. This has produced both empty binary glyphs and fontc
`InconsistentPathElements` errors.

---

## Evidence

The failure has been reproduced with two sequential `l.LSB` commits.

```text
Browser object model l shapes: 1
Browser PatchSync Y.Doc l shapes: 1
Rust worker Y.Doc l shapes: 2
Rust worker canonical/subset l shapes: 2
```

The emitted second-commit operation was:

```text
set glyphs / l / layers / <layer-id> / shapes / 0 / nodes
```

Only one `applyYjsUpdate` message was sent. The browser Y.Doc applied the
update correctly; Rust/Yrs appended a duplicate parent shape. The same class
of corruption affected `a.ss03`:

```text
Main model a.ss03 ExtraBold shapes: 3
Browser Y.Doc a.ss03 ExtraBold shapes: 3
Rust worker a.ss03 ExtraBold shapes: 6
```

The duplicated worker shapes carried the same stable IDs as the originals.

---

## Current Containment

Committed layer snapshots currently force an atomic replacement of `shapes`.
This avoids the corrupting repeated nested node update and is the safe active
transport until this migration is complete.

```text
committed snapshot: set layer.shapes
not:                set layer.shapes[index].nodes
```

This is intentionally a containment mechanism, not the desired long-term
schema. It sends more data than a granular path update.

---

## Failed Partial Transition

An experiment stored `nodes` as scalar strings instead of nested `Y.Text`.
Rust already supports scalar `Any::String` nodes, but the second update still
used this parent path:

```text
shapes / 0 / nodes
```

Rust then produced:

```json
{
  "shapes": [
    { "closed": true, "nodes": "..." },
    { "closed": true }
  ]
}
```

The second blank shape cannot deserialize as a babelfont `Shape`. Therefore
changing the node leaf representation alone is insufficient; the parent shape
must also be addressed through a stable CRDT identity.

The scalar-node experiment was rolled back. The current active transport uses
the safe containment above.

---

## Target Schema

Replace the flat numeric `shapes` Y.Array with an indexed collection:

```text
layer Y.Map
├── shapesById: Y.Map<shapeId, Y.Map<shape>>
└── shapeOrder: Y.Array<shapeId>
```

Then a node update resolves through stable shape identity:

```text
glyphs / l / layers / <layer-id> / shapes / <shape-id> / nodes
```

The external babelfont JSON remains unchanged:

```json
{
  "shapes": [
    { "id": "runtime-id", "nodes": "serialized upstream node string" }
  ]
}
```

Shape IDs are Y.Doc/runtime identity. They must be stripped only when writing
external source formats that do not support them.

---

## Invariants

1. A shape has one stable ID for its lifetime in the Y.Doc.
2. `shapeOrder` is the only ordering authority.
3. No normal edit addresses a shape through a numeric Y.Array index.
4. Browser Y.Doc and Rust Y.Doc receive the same stable-ID operation graph.
5. Y.Doc conversion always reconstructs ordinary ordered `shapes` arrays for
   the object model, source save, and font compiler.
6. Legacy flat `shapes` arrays are migrated once, atomically, before a shape
   receives any granular update.
7. The migration must not be mixed per layer or per client after a document is
   shared; a layer is either legacy flat or indexed during its migration
   transaction, never both as active sources of truth.

---

## Required JavaScript Work

### `change-bridge-ydoc.ts`

1. Add `shapes` to `INDEXED_MAP_KEYS`.
2. Make `layerToYMap` create `shapesById` and `shapeOrder`.
3. Extend `fromYLayerMap` to reconstruct ordered flat `shapes` from the
   indexed representation.
4. Extend `toYType`, `mergeYMapContents`, `applyLayerDelta`, `getYPath`, and
   `setYPath` so shape access resolves numeric editor paths through
   `shapeOrder` to `shapesById`.
5. Implement a dedicated legacy migration helper:
   - read old flat `shapes` Y.Array
   - assign/adopt stable IDs
   - write `shapesById` and `shapeOrder`
   - remove flat `shapes` in the same Yjs transaction
6. Do not use the generic array LCS routine for shapes after migration.

### `patch-sync-engine.ts`

1. Preserve shape IDs in bridge/Y.Doc snapshots.
2. Extend `_adoptIndexedLayerIds` to adopt shape IDs by stable order only at
   the legacy migration boundary.
3. Use indexed shape updates for granular path/component changes.
4. Remove atomic committed `shapes` containment only after worker convergence
   tests pass.
5. Audit undo/redo and remote replay so replay values preserve shape IDs in
   Y.Doc but external source serialization strips them.

### Model and Rendering

1. Continue decoding node strings before object-model adoption.
2. Keep `Layer.data` free of raw storage-only forms.
3. Ensure source save uses the existing external serialization path to strip
   shape IDs when required by the output format.

---

## Required Rust Work

Rust already reconstructs `shapesById + shapeOrder` when flat `shapes` is
absent. The migration must make this a first-class supported schema.

1. Confirm `ydoc_layer_to_json` always prefers indexed shapes when present.
2. Ensure all worker cache patch paths (`apply_yjs_update`, subset cache,
   canonical cache, preview overlay) preserve indexed shape order exactly.
3. Add an explicit error if `shapeOrder` references a missing shape ID.
4. Keep legacy flat-array read support until documents written before the
   migration are no longer supported.
5. Do not silently accept blank shape objects such as `{ "closed": true }`.
   They indicate a CRDT integrity failure and must fail with glyph/layer/path
   context.

---

## Test Plan

### JavaScript Unit Tests

1. Create a flat legacy layer and migrate it; assert:

   ```text
   flat shapes removed
   shapesById count matches source shape count
   shapeOrder preserves source order
   round-trip JSON has the original ordered shapes
   ```

2. Two sequential node edits to the same shape:

   ```text
   main Y.Doc shape count remains 1
   path uses stable shape identity internally
   reconstructed JSON has one shape and latest nodes
   ```

3. Shape insert/delete/reorder and component transform edits preserve IDs and
   order.

4. Undo/redo and remote apply preserve the same shape count and IDs.

### Browser to Rust Integration Test

This is mandatory. Browser-only Yjs tests did not reproduce the failure.

```text
fresh worker seeded from exact browser bridge state
apply l.LSB commit
apply l.LSB commit again

assert browser main Y.Doc l shapes == 1
assert Rust worker Y.Doc l shapes == 1
assert Rust canonical/subset l shapes == 1
assert compiled glyphToPath(l) is non-empty
```

Repeat for `a.ss03`:

```text
main / worker / canonical / subset ExtraBold shapes == 3
```

### Metrics/Recomposition Regression

Keep the existing chain regressions:

```text
l → n → a → adieresis
l → n → a.ss03 (visible with hidden n prerequisite)
```

These prove shape schema changes do not regress the central recomposition
engine or worker snapshot target selection.

---

## Rollout

1. Land the full indexed-shape schema behind a document-version or explicit
   migration transaction.
2. Test fresh document, legacy document, remote peer, undo/redo, and worker
   state convergence.
3. Remove atomic `shapes` containment only after the browser-to-Rust test is
   reliable.
4. Retain flat-shape read compatibility for old documents until a separate
   compatibility policy retires it.

Do not ship a mixed partial schema. The scalar-node-only experiment showed
that changing a leaf while retaining numeric parent addressing is insufficient
and can create malformed worker shapes.
