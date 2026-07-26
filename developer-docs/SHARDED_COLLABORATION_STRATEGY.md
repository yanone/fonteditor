# Sharded Collaboration Strategy

## Status

Proposed architecture. This document defines the direction for restoring
cloud collaboration while supporting fonts too large to keep in one browser
or one Cloudflare Durable Object (DO), including CJK fonts.

## Problem

The current cloud collaboration room owns one complete Y.Doc for an entire
font. The document contains all glyph data, is reconstructed in the DO after
hibernation, and is encoded in full for checkpoints and some sync paths.

This cannot scale safely under the Cloudflare DO memory limit. A large font
also cannot be loaded or compiled in full in the browser.

The desired product behavior is:

- Keep Cloudflare DOs for inexpensive, low-latency live communication.
- Store authoritative font state outside DO memory.
- Load only the glyphs necessary for local editing, preview, and a local
  compilation subset.
- Allow collaborators to edit different glyphs independently and edit the
  same glyph concurrently with Yjs convergence.
- Compile complete fonts in a separate server-side compilation service.

## Decision

Represent a collaborative font as multiple independently synchronized Yjs
documents instead of one whole-font Y.Doc.

Each document is a separately persisted and synchronized shard:

| Document | Contents | Residency |
| --- | --- | --- |
| `font-core` | All non-glyph font data and the glyph catalog | Always loaded in an editing session |
| `glyph:<glyph-id>` | One glyph's complete editable data | Loaded only when required |
| Optional future shards | Kerning or feature sources if either proves too large for core | Loaded on demand |

The glyph document ID uses an immutable glyph ID, not a glyph name. Renaming a
glyph must not move its CRDT document.

## Architecture

```text
                       +-------------------------+
                       | Font persistence service |
                       | checkpoints + update log |
                       +------------+------------+
                                    ^
                                    | durable updates / compaction
                                    v
 +----------------+       +-------------------------+       +----------------+
 | Browser client | <---> | Cloudflare DO shard room | <---> | Browser client |
 | core + active  |       | one Y.Doc per shard      |       | core + active  |
 | glyph docs     |       | live relay and journal   |       | glyph docs     |
 +-------+--------+       +-------------------------+       +-------+--------+
         |                                                            |
         +---------------- local subset assembly --------------------+
                                    |
                                    v
                       +-------------------------+
                       | Browser WASM compiler   |
                       | closure subset only     |
                       +-------------------------+

                       +-------------------------+
                       | Server compiler service |
                       | complete revision build |
                       +-------------------------+
```

### Durable Object identity

A DO must coordinate one shard, never a whole font made of loaded shard docs.

```text
asset:<asset-id>:font-core
asset:<asset-id>:glyph:<glyph-id>
```

The DO continues to provide:

- Authenticated WebSocket connections.
- Yjs state-vector synchronization.
- Fan-out to live subscribers of the same shard.
- Durable acknowledgement after persistence.
- Small SQLite update tails and checkpoint coordination.
- Chunking for individual messages below WebSocket and SQLite limits.

The DO must not retain a map of glyph Y.Docs or hydrate unrelated glyphs to
serve a request.

## Data Model

### Core document

`font-core` contains every non-glyph field in the font JSON, plus a lightweight
glyph catalog. It must not contain paths, layers, components, anchors, or other
large per-glyph payloads.

Each catalog entry needs sufficient metadata to discover, display, load, and
assemble a glyph without loading its outline first.

```ts
type GlyphCatalogEntry = {
    glyphId: string;
    name: string;
    codepoints: number[];
    productionName?: string;
    componentDependencies: string[];
    metricsDependencies: string[];
    featureDependencyHints: string[];
    latestGlyphRevision: string;
    deleted?: boolean;
};
```

The catalog is the source for glyph order, search, Unicode lookup, and
on-demand hydration. Dependency indexes are derived data but must be updated
transactionally enough that clients can conservatively fetch more glyphs when
they are stale.

### Glyph document

Each `glyph:<glyph-id>` document owns one glyph's complete editable state:

- Glyph metadata not needed by the global catalog.
- Layers, paths, components, anchors, guides, and local metrics keys.
- Background layers and feature-variation data.

The existing internal Yjs representation should be preserved inside this
document: layers remain maps keyed by stable layer ID, and collection entries
retain stable IDs where available. This preserves current fine-grained merge
behavior for concurrent edits within one glyph.

### Browser residency

The browser must distinguish an unloaded glyph from a missing glyph. Omitting
an unloaded glyph from `font.glyphs` is not sufficient because existing code
would interpret it as genuinely absent from the font.

```ts
type GlyphResidency =
    | { state: 'loaded'; glyphId: string }
    | { state: 'loading'; glyphId: string }
    | { state: 'unloaded'; glyphId: string }
    | { state: 'failed'; glyphId: string; error: string };
```

The font model needs catalog-aware APIs such as:

```ts
font.findGlyphCatalogEntry(name);
font.ensureGlyphLoaded(glyphId);
font.getLoadedGlyph(name);
font.isGlyphLoaded(name);
```

Code that globally iterates `font.glyphs` must explicitly choose one of these
semantics:

- Operate on loaded glyphs only.
- Page through the catalog without loading outlines.
- Delegate a complete-font operation to the server.

## Collaboration Semantics

Every transport update must identify its target document:

```ts
type ShardUpdate = {
    assetId: string;
    documentId: 'font-core' | `glyph:${string}`;
    update: Uint8Array;
    clientTransactionId: string;
    collaborationMessages?: CollaborationMessageEnvelope[];
};
```

Clients always subscribe to `font-core`, then subscribe on demand to:

- The active glyph.
- Visible neighboring glyphs.
- Glyphs in the active text run.
- Component dependencies.
- Metrics-key and automatic-composition dependencies.
- Glyphs required by the currently selected local feature and layout closure.

Users editing different glyphs exchange no glyph payload unless they both
subscribe to the same glyph. Users editing one glyph receive the same Yjs
updates and retain normal CRDT convergence.

The existing committed-update funnel must remain authoritative. A local or
remote shard update must still pass through the same serialization point for:

- Change metadata and history.
- Worker synchronization.
- Edit-type inference.
- Compile wakeups.
- Glyph overview invalidation.

The funnel changes from handling an unqualified Yjs update to handling a Yjs
update tagged with a document ID.

## Persistence Contract

The external service stores CRDT data, not last-write-wins glyph JSON.

For every shard, persist:

- A compacted Yjs checkpoint.
- An ordered append-only Yjs update tail after the checkpoint.
- State-vector or revision metadata.
- Idempotency identifiers: asset ID, document ID, client transaction ID, and
  chunk index.
- Bounded collaboration/history metadata separate from document state.

Durability sequence:

1. A client sends a shard update to the DO.
2. The DO validates and durably journals the update.
3. The DO acknowledges only after the write is durable.
4. The DO broadcasts to subscribers of that same shard.
5. A compactor writes a compacted checkpoint and prunes the corresponding tail.

Materialized glyph JSON may be stored as a derived index for search or server
compilation, but it must not replace Yjs updates as the conflict-resolution
source of truth.

## Cross-Document Operations

Independent Y.Docs cannot make one atomic Yjs transaction across core and
glyph documents. Cross-document operations therefore require an explicit,
idempotent application protocol.

Examples include:

- Creating or deleting a glyph.
- Renaming a glyph.
- Updating component dependencies.
- Changing master data that invalidates glyph data.
- Changing feature code that changes local compilation closure requirements.

Use an operation manifest in `font-core` for operations that span documents:

```ts
type MultiDocumentOperation = {
    operationId: string;
    kind: 'create-glyph' | 'rename-glyph' | 'delete-glyph' | 'dependency-change';
    affectedDocumentIds: string[];
    status: 'prepared' | 'committed' | 'aborted';
};
```

Each affected shard update is retryable using the same operation ID. Clients
must treat a prepared operation as pending rather than exposing a partial
result as stable state.

Prefer immutable glyph IDs, core-managed names, and deletion tombstones. This
avoids moving documents or breaking remote references during rename/delete.

## Local Compilation

The existing editing subset compiler remains useful, but its position in the
pipeline changes. It currently subsets a complete worker-side document. The
new pipeline assembles a complete-enough local view first.

```text
1. Load font-core.
2. Resolve target glyphs from text and active editing state.
3. Expand a dependency closure from catalog data.
4. Hydrate missing glyph documents in that closure.
5. Assemble an ephemeral font from core and loaded glyph documents.
6. Run the existing layout closure and RetainGlyphs subset compiler.
7. Compile only the resulting closure.
```

The local compiler must distinguish these conditions:

- A glyph is genuinely absent from the font.
- A glyph is present but not yet hydrated.
- A glyph is required by the closure but cannot be fetched.
- A requested feature closure exceeds the browser policy limit.

It must never silently treat an unhydrated glyph as absent.

For CJK fonts, feature closure may itself be too large for browser memory. In
that case the UI must present an explicit state such as "server preview
required" rather than trying to load the full font. Editing outlines and
locally safe subsets must remain available.

## Full Server Compilation

Full builds are a separate service and never require a browser or DO to load
the complete font.

The service must:

1. Read a stable revision manifest for `font-core` and all glyph documents.
2. Materialize the full font at those exact revisions.
3. Compile it outside Cloudflare DO memory limits.
4. Store the binary artifact with the source revision manifest.
5. Report when the font changed during the build, rather than labeling an old
   artifact as current.

A full-build request is not well-defined without this revision manifest.

## DO Memory Rules

- A shard DO loads exactly one shard document.
- Checkpoint compaction operates on that one shard.
- Synchronization sends only that shard's state or update tail.
- Chunk buffers are bounded by size, count, and TTL.
- Mutation-history metadata is bounded and is never a substitute for Yjs
  document state.
- Observability records per-shard document bytes, checkpoint bytes, tail bytes,
  subscribers, update rate, hydration duration, and compaction duration.
- A DO must reject or defer work before a shard could exceed its defined memory
  budget.

## Migration Plan

### Phase 1: Define boundaries

- Introduce immutable glyph IDs and a core glyph catalog.
- Define core and glyph document serializers using the existing Yjs keyed-map
  conventions.
- Define shard document IDs and protocol versioning.

### Phase 2: Generalize local synchronization

- Make the browser patch bridge and committed-change funnel document-aware.
- Preserve the current one-document behavior behind the generalized interface.
- Move undo ownership and history grouping to document-aware transaction IDs.

### Phase 3: Implement glyph hydration

- Load `font-core` first.
- Add loaded/loading/unloaded/failed glyph residency.
- Hydrate the active glyph and visible dependencies.
- Update canvas, overview, and text-run paths to request glyphs rather than
  assuming global glyph residency.

### Phase 4: Shard cloud transport and storage

- Give each shard an independent DO identity.
- Persist independent checkpoints and update tails.
- Restrict broadcast and state-vector sync to shard subscribers.
- Migrate direct R2 checkpoint download and tail sync to shard endpoints.

### Phase 5: Assemble local compiler inputs

- Implement catalog-driven dependency closure hydration.
- Assemble an ephemeral local font from core and loaded glyphs.
- Update the Rust/Yjs worker contract to accept partial assembled state and
  report missing closure dependencies.
- Enforce feature-closure browser limits.

### Phase 6: Add full builds and migrate data

- Implement server compilation from a revision manifest.
- Materialize existing legacy whole-font Y.Docs once.
- Seed one core document and one glyph document per legacy glyph.
- Validate logical font equivalence before switching an asset to sharded mode.

## Compatibility and Product Rules

- Yjs remains the single source of truth for edits.
- Binary Yjs updates remain the authoritative incremental transport format.
- A browser must not use full-font JSON as a normal synchronization or repair
  mechanism.
- A DO may retain a full state only for one small shard, never the full font.
- Local editing compilation is permitted to be partial by design.
- Full-font compilation is server-only for fonts that exceed browser policy.
- Python, glyph filters, batch edits, and exports must declare whether they
  operate on the loaded subset or require a server-side complete-font job.
- Existing cloud rooms cannot be upgraded in place without an explicit schema
  migration because their Y.Doc shape and room identity are fundamentally
  different.

## Open Decisions

- Which service owns durable shard persistence and the revision manifest.
- Whether the first version keeps kerning and feature source in `font-core`.
- The maximum browser glyph count, bytes, and feature-closure size.
- The catalog dependency information required to avoid fetching excessive
  glyphs while remaining correct.
- Server compiler queueing, authorization, artifact retention, and cost model.
- The user-facing behavior when a required glyph is unavailable or a closure
  requires server preview.
- The exact cross-document operation protocol and recovery UX for a pending
  operation.
