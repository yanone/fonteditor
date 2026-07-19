# Upstream-Truthful Node Strings

## Status

Proposed. Strategy-level architecture plan.

This document describes a memory- and file-size-first direction for returning
Counterpunch's resting font data to the upstream `babelfont-rs` node string
format while preserving fast JavaScript editing, live interpolation, and Rust
compilation performance.

This plan intentionally reverses the direction proposed in
`YDOC_GRANULAR_SCHEMA_REWRITE.md` for path nodes. That older plan optimized for
leaf-granular Yjs edits using stable editor ids. This plan optimizes for
upstream format truth, Durable Object memory reduction, file size reduction, and
small persisted collaboration state.

## Goal

Make every resting or persisted representation of font data 100% truthful to
upstream `babelfont-rs`:

- `.babelfont` files
- cloud snapshots
- Y.Doc room state
- worker bootstrap snapshots
- Rust-facing JSON
- compact Rust JSON caches

For paths, that means upstream-shaped data:

```json
{
    "nodes": "582 0 l 582 8 l 316 700 l",
    "closed": false
}
```

The JavaScript editor may still decode nodes into arrays for fast geometry and
editing, and Rust may still deserialize nodes into native `Vec<Node>` for fast
compilation. Those are runtime representations only. They must not leak into
file, Y.Doc, cloud, or compact cache state.

## Non-Goals

- Do not add `id` fields to upstream node or path data.
- Do not store `Node.id`, `Path.id`, `nodesById`, `nodeOrder`, `shapesById`, or
  `shapeOrder` in resting Y.Doc or saved JSON.
- Do not encode editor-only ids inside the upstream node string.
- Do not make every renderer, compiler call site, or sync path implement its own
  node parser.
- Do not use `Y.Text` for node strings. Node strings are structured geometry,
  not prose; text CRDT merges can corrupt geometry.

## Upstream Format Constraint

Current upstream `babelfont-rs` (`upstream/main` at `2c62749`) defines:

- `Path { nodes: Vec<Node>, closed, format_specific }`
- `Node { x, y, nodetype, smooth, format_specific }`
- no `id` on `Path`
- no `id` on `Node`
- `Path.nodes` serialized through `serde_helpers::serialize_nodes` as a compact
  string

The upstream node string stores each node as:

```text
x y nodeType[optionalSmooth] [optionalFormatSpecificJson]
```

Examples:

```text
582 0 l
582 0 cs
582 0 l {"glyphs":{"someKey":123}}
```

Node `format_specific` is appended as compact JSON emitted by
`serde_json::to_string`, so it remains a single whitespace-delimited token.

Counterpunch's resting schema must follow this format exactly.

## Representation Matrix

| Area | `nodes` representation | Purpose |
| --- | --- | --- |
| `.babelfont` files | string | upstream truth and file size |
| cloud save/open snapshots | string | memory and transfer size |
| Y.Doc room state | string | Durable Object memory reduction |
| worker/Yjs bootstrap snapshots | string | smaller cross-boundary state |
| Rust-facing JSON | string | upstream truth |
| compact Rust JSON cache | string | memory and cache footprint |
| Rust compile cache | native `Vec<Node>` | compile speed |
| Rust interpolation engine | native `Vec<Node>` | interpolation speed |
| JS active editing model | `Babelfont.Node[]` | geometry/editing speed |
| JS rendering/interpolation runtime | `Babelfont.Node[]` | canvas speed |

The system uses strings at rest, arrays/native structs while active.

## Single Conversion Boundary

All JavaScript string/array conversion must be concentrated in one module, for
example:

```text
webapp/js/node-encoding.ts
```

Suggested API:

```ts
parseNodeString(nodes: string): Babelfont.Node[];
serializeNodeArray(nodes: Babelfont.Node[]): string;

decodeNodeStringsForRuntime<T>(value: T): T;
encodeNodeArraysForStorage<T>(value: T): T;
```

Rules:

- Every JavaScript string-to-array conversion calls this module.
- Every JavaScript array-to-string conversion calls this module.
- No ad hoc parsers in glyph canvas, interpolation, Y.Doc, cloud, file manager,
  or compile code.
- No id generation or id preservation in the codec.
- The codec is idempotent: decode leaves arrays alone, encode leaves strings
  alone.
- Malformed node strings fail loudly with useful path/context information.
- Formatting must match upstream `babelfont-rs` string semantics, including
  smooth suffixes and node `format_specific` JSON.

Rust does not need an editor-specific duplicate conversion layer. Rust receives
upstream-truthful JSON and uses upstream `babelfont-rs` serde to obtain native
`Vec<Node>` internally.

## Y.Doc Schema

Y.Doc should store upstream-like data, not editor-indexed maps.

Target layer shape:

```ts
type StoredPath = {
    nodes: string;
    closed: boolean;
    format_specific?: Record<string, unknown>;
};

type StoredComponent = {
    reference: string;
    transform?: Babelfont.DecomposedAffine;
    location?: Record<string, number>;
    format_specific?: Record<string, unknown>;
};

type StoredLayer = {
    id: string;
    width?: number;
    height?: number;
    vertWidth?: number;
    shapes?: Array<StoredPath | StoredComponent>;
    anchors?: Babelfont.Anchor[];
    guides?: Babelfont.Guide[];
    format_specific?: Record<string, unknown>;
};
```

Layers may remain keyed by layer id because layer ids are real font model data.
Shapes and nodes should not use editor-generated ids.

Remove from resting Y.Doc:

- `nodesById`
- `nodeOrder`
- `shapesById`
- `shapeOrder`
- node ids
- path ids
- editor-only sidecars

This is the main Durable Object memory win. It removes the large number of
per-node `Y.Map` objects and order arrays that currently dominate shared-state
overhead for outline-heavy fonts.

## JavaScript Runtime Model

JavaScript should not parse strings on every draw or edit. It should expose a
runtime view/cache that calls the single codec once per boundary.

Suggested runtime structure:

```ts
type RuntimePath = {
    storagePathRef: StoredPath;
    sourceNodesString: string;
    sourceRevision: number;
    nodes: Babelfont.Node[];
    dirty: boolean;
};
```

Lifecycle:

1. First access to a stored path parses `StoredPath.nodes` through
   `parseNodeString`.
2. Editing mutates the runtime node array.
3. Rendering, snapping, hit testing, handles, sidebearing logic, and geometry
   calculations consume the runtime array.
4. Commit serializes the runtime array through `serializeNodeArray` and writes
   the string back to storage/Y.Doc.
5. Runtime caches are invalidated by path/layer revision or remote update.

Do not store decoded arrays globally for the whole font unless a measured hot
path requires it. Decode active/currently rendered layers and release cold
runtime arrays under memory pressure.

## Editing Hot Path

Editing must remain array-based while active.

On pointer down or edit activation:

```ts
const runtimePath = runtimeLayer.getPath(shapeIndex);
```

During drag:

```ts
runtimePath.nodes[nodeIndex].x += dx;
runtimePath.nodes[nodeIndex].y += dy;
runtimePath.dirty = true;
```

On commit:

```ts
storedPath.nodes = serializeNodeArray(runtimePath.nodes);
storedPath.closed = runtimePath.closed;
```

For normal drags, avoid writing a full path string into Y.Doc for every raw
pointer event. Prefer one of:

- local live editing plus commit on mouseup
- animation-frame coalesced commits
- throttled preview outside durable authoritative room state
- path/layer-level edit lock during drag

The editing performance requirement is: conversion happens at activation and
commit boundaries, not inside pointer-move, draw, snap, or geometry loops.

## Collaboration And Conflict Policy

Without node ids, same-path edits cannot be merged at node granularity by Yjs.
That is an intentional tradeoff for memory and upstream truthfulness.

Use index-based runtime editing plus path/layer revision checks.

First implementation:

- path or layer active-edit lock for structural outline edits
- base revision captured on edit start
- commit succeeds only if the stored path/layer revision still matches
- if revision changed, reject/reload the edit or ask the user to reapply

Later improvement:

- collect semantic path operations during editing
- rebase safe non-conflicting operations by index
- reject ambiguous conflicts

Safe rebases may include moving different nodes or changing metadata on
different indices. Unsafe conflicts include deleting a node another user moved,
both editing the same node, reversing/opening/closing a path while another user
edits by index, or simultaneous structural edits to the same segment.

Do not introduce node ids solely to solve these conflicts. That reintroduces the
memory and format problems this plan is meant to remove.

## Live Interpolation

Live interpolation is a critical boundary because Rust computes geometry and JS
must render it immediately.

Preferred flow:

1. JS requests interpolation from Rust.
2. Rust computes using native `Vec<Node>`.
3. Rust serializes the interpolated layer as upstream-truthful JSON with string
   `nodes`.
4. JS receives the layer JSON.
5. JS calls `decodeNodeStringsForRuntime` exactly once at the interpolation
   response boundary.
6. Canvas rendering consumes decoded arrays.

Example:

```ts
const storedLayer = await rust.getInterpolatedLayer(request);
const runtimeLayer = decodeNodeStringsForRuntime(storedLayer);
render(runtimeLayer);
```

Do not parse node strings in the renderer. Do not add a second interpolation
parser. If interpolation decode time is too high, optimize the single codec.

Possible optimization:

```ts
type InterpolationRuntimeCache = {
    key: string;
    sourceHash: string;
    runtimeLayer: LayerWithNodeArrays;
};
```

Invalidation inputs:

- glyph name
- layer id
- interpolation location
- source master layer revisions
- component dependency revisions
- selected feature/variation context if relevant

Returning strings from Rust should be the default because it keeps the WASM/JS
payload smaller and the API upstream-truthful. Returning arrays from Rust should
only be added if a benchmark shows that transfer plus JS parsing is slower than
transferring expanded arrays.

## JS-Rust Border

The JS-Rust border should exchange upstream-truthful JSON.

JS sends string-node JSON. Rust deserializes it into native Rust model structs.
Rust sends string-node JSON. JS decodes it into runtime arrays only when needed.

Avoid:

- sending editor node arrays to Rust compile APIs
- returning editor node arrays from Rust as the default API
- repeatedly parsing/stringifying whole-font JSON in compile loops
- storing editor-only ids in Rust-facing JSON

## Rust Cache Architecture

Rust worker caches should split compact storage from decoded hot data.

Suggested shape:

```rust
struct StoredLayerCache {
    upstream_json: serde_json::Value, // string nodes, upstream truthful
    revision: u64,
}

struct DecodedLayerCache {
    layer: babelfont::Layer, // native Vec<Node>
    source_revision: u64,
}
```

On a Y.Doc/string update:

1. update `StoredLayerCache`
2. mark decoded cache dirty
3. decode to `babelfont::Layer` only when compile/interpolation needs it
4. reuse decoded data until the stored revision changes

For compile speed, update changed layer/path caches instead of rebuilding the
whole font whenever possible. For memory, decoded caches should be evictable;
the compact upstream JSON cache remains authoritative.

The same principle applies to glyph, subset, and interpolation caches:

- compact upstream JSON for resting memory
- native decoded structs for hot compile/interpolation work
- revision-based invalidation

## File, Cloud, And Open/Save

Open path:

```text
raw JSON string
→ JSON.parse
→ decodeNodeStringsForRuntime
→ Font.fromData / editor model
```

Save path:

```text
editor runtime/model data
→ encodeNodeArraysForStorage
→ JSON.stringify
→ write file/cloud snapshot
```

`OpenedFont.constructor`, `OpenedFont.syncJsonFromModel`, and `OpenedFont.save`
are likely choke points, but they should call the single codec rather than
owning conversion logic.

Cloud seed/open paths should use the same codec. A cloud snapshot must not
contain editor-only arrays if the storage target is the upstream-truthful room
format.

## Undo And Redo

Undo/redo should distinguish runtime edit state from committed shared state.

During an active edit, local runtime data can hold arrays. Once committed, undo
entries that represent shared/resting state should store strings or path-level
operation metadata, not node arrays with ids.

Simple path-level undo entry:

```ts
type PathStringUndoEntry = {
    glyphName: string;
    layerId: string;
    shapeIndex: number;
    beforeNodes: string;
    afterNodes: string;
    beforeClosed?: boolean;
    afterClosed?: boolean;
};
```

This keeps history compact and format-truthful. Runtime arrays are reconstructed
from strings when applying undo/redo.

## Current Code Areas To Change

Primary areas:

- `webapp/js/change-bridge-ydoc.ts`
  - remove indexed node/shape Y.Doc schema for paths
  - store upstream shape arrays and string-node paths
  - route runtime conversion through the single codec

- `webapp/js/babelfont-model.ts`
  - remove persistent `Node.id` / `Path.id` assumptions
  - keep arrays as runtime data only
  - do not make low-level `Layer.toJSON()` implicitly stringify unless explicitly
    in storage mode

- `webapp/js/font-manager.ts`
  - decode storage JSON for runtime during open
  - encode runtime arrays for storage during save/sync

- `webapp/js/patch-sync-engine.ts`
  - replace indexed-array granular node operations with path/layer string
    commits and revision/conflict handling

- `babelfont-fontc-build/src/lib.rs`
  - reconstruct Y.Doc layer JSON as upstream string-node JSON
  - keep compact string-node JSON caches separate from decoded native caches

- interpolation worker/API
  - return upstream string-node layer JSON by default
  - decode exactly once on JS response boundary

Secondary areas:

- glyph canvas and outline editor runtime accessors
- layer-data normalizer
- cloud open/save paths
- Python sync/post-execution JSON diff paths
- full-font compile manager and worker cache bootstrap
- tests that assert `nodesById`/`nodeOrder` currently exist

## Tests

Add or rewrite tests for these invariants:

- saved `.babelfont` has string `nodes`
- no `id` appears on path/node objects in saved JSON
- Y.Doc room state has string `nodes`
- Y.Doc room state has no `nodesById`, `nodeOrder`, `shapesById`, or
  `shapeOrder`
- JS runtime path access returns arrays
- editing commits arrays back to strings
- interpolation result decodes once and renders
- Rust compile accepts string-node Y.Doc/cache data
- malformed node strings fail at the codec boundary
- node `format_specific` survives string round-trip
- file-size benchmark stays near upstream string size

Keep a large fixture such as `Fustat.glyphs` as a size regression target. The
earlier benchmark showed string nodes around 4.19 MB raw versus array nodes
around 11.16 MB raw for the generated `.babelfont` file.

## Benchmarks

Measure before and after:

- `.babelfont` raw size
- `.babelfont` gzip and brotli size
- Y.Doc encoded room bootstrap size
- Durable Object heap after room load
- Durable Object heap after a typical editing session
- open decode time
- first active glyph/layer decode time
- path drag frame time
- drag commit stringify time
- interpolation response payload size
- interpolation decode time in JS
- Rust layer decode time
- Rust cache update time
- incremental compile time
- undo/redo latency

Success does not require zero conversion cost. Success means conversion happens
once at controlled boundaries and the cost is outweighed by lower file size,
lower room memory, lower transfer size, and retained editing responsiveness.

## Migration Plan

1. Add the single JS node codec with round-trip tests.
2. Add runtime decode/encode helpers without changing Y.Doc schema yet.
3. Make open/save/cloud JSON use upstream string-node storage behind a feature
   flag.
4. Add Rust-side cache separation between compact upstream JSON and decoded
   native layers.
5. Add interpolation response decoding through the codec, with benchmarks.
6. Replace Y.Doc path node storage with upstream string-node paths behind a
   schema-version flag.
7. Replace node-id granular sync with path/layer revision checks.
8. Remove persistent node/path ids and indexed node/shape maps from resting
   state.
9. Run compile, collaboration, undo/redo, cloud, and interpolation validation.
10. Remove the old indexed-map schema once migration and room compatibility are
    settled.

## Final Architecture

```text
upstream-truthful strings at rest
        ↓ single JS codec
JS arrays while active
        ↓ single JS codec
upstream-truthful strings when committed/shared/saved
        ↓ upstream Rust serde
native Vec<Node> inside Rust hot caches
```

This satisfies the combined goals:

- truthful upstream `babelfont-rs` file and memory format
- smaller `.babelfont` files
- smaller cloud/Y.Doc room state
- lower Durable Object memory pressure
- fast JS editing through decoded runtime arrays
- fast Rust compilation/interpolation through native decoded caches
- one auditable string/array conversion boundary