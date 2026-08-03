# Cloud Collaboration Architecture

## Status

Proposed target architecture. Supersedes prior cloud collaboration strategy
and developer docs (one-room whole-font Y.Doc, R2-via-WebSocket bootstrap with
DO hydration, and earlier sharded drafts that kept full dependency edges inside
always-resident `font-core`).

Cloud collaboration is currently disabled in production because the previous
design hit Cloudflare Durable Object isolate memory limits (~128 MB) when a
room held an entire font.

## Goals

- One architecture for small fonts (&lt;10k glyphs) and extremely large fonts
  (CJK, 100k+ glyphs). Policy differs; code paths do not fork.
- Keep Cloudflare Durable Objects for cheap, low-latency live exchange.
- Move bulk seed and hydrate traffic to HTTP + R2.
- Never require a DO to hold, hydrate, or compact a full font (or a full
  glyph set) in memory.
- Support migrating a font from “small” to “large” without a second product
  mode.

## Reference fonts (later evaluation)

Use these as stress cases when sizing catalog/deps budgets and hydrate UX:

- [Plangothic Project](https://github.com/Fitzgerald-Porthmouth-Koenigsegg/Plangothic_Project)
- [Source Han Sans](https://github.com/adobe-fonts/source-han-sans)

## Decision summary

| Concern | Decision |
| --- | --- |
| Document shape | One Yjs shard per `font-core`, one per `glyph:<glyphId>` |
| DO identity | One DO room per shard; never one DO for the whole font |
| Bulk transfer | HTTP streams to/from R2 (packs = multi-shard responses) |
| Live transfer | WebSocket to a small set of shard DOs |
| DO memory | Zero-hydration: auth, ordered durable tail, fan-out, metadata only |
| Compaction | External service; DOs do not build full-state checkpoints |
| Discovery | Lean identity catalog in core + separate compact deps index |
| Closure | Walk deps index from client-chosen seeds; then hydrate bodies |
| Small vs large | Same machinery; default hydrate policy is `all` vs working-set |

## Why one architecture

A Latin font under this design is already sharded. Opening it uses hydrate
policy `all` (one or few packs covering every catalog id). A CJK font uses the
same shards, packs, DOs, and residency model, but seeds a range, text run, or
active glyph and expands a dependency closure first.

Growing past a browser budget does not flip product modes. It only changes
hydrate selectivity and when full builds must run server-side.

## Shard model

```text
asset:<assetId>:font-core          non-glyph font data + lean glyph catalog
asset:<assetId>:font-deps          compact dependency graph (see below)
asset:<assetId>:glyph:<glyphId>    one glyph's editable CRDT state
```

Optional later shards (only if core still grows too large): kerning and/or
feature sources.

### Glyph identity

Glyph CRDT documents are keyed by an **immutable glyph id**, not by name.
Renames update the catalog; they do not move the shard.

### `font-core` (lean)

Always loaded for an editing session. Contains:

- True font-wide fields: UPM, names, axes, masters (without assuming huge
  kerning stays forever), instances, notes, etc.
- A **lean glyph catalog** for browse/search/order — not outline data.

Catalog entry (illustrative):

```ts
type GlyphCatalogEntry = {
    glyphId: string;
    name: string;
    codepoints: number[];
    productionName?: string;
    latestGlyphRevision: string;
    exported?: boolean;
    deleted?: boolean;
};
```

**Do not** put full component/metrics dependency lists in always-resident core
by default. That would make core larger than “today’s JSON minus `.glyphs`”
by an O(n) tax that still stresses memory at CJK scale.

Also watch existing core-resident O(n) bombs already in babelfont JSON:

- `first_kern_groups` / `second_kern_groups` membership lists
- `features.classes` / feature code as monolithic AFDKO strings
- `masters[].kerning` (and RTL) pair maps
- `variation_sequences`

`glyphOrder` in the collab Y.Doc is already a `Y.Array` of names derived from
glyph array order. Prefer granular insert/delete of immutable ids; never treat
“replace entire order” as the logical edit.

### `font-deps` (compact dependency index)

Separate from always-on core. Updated whenever a glyph commit changes
references.

```text
glyphId → dependency glyphIds   // components, metrics-key edges, …
(+ optional reverse index for dependents)
```

Authoritative component objects still live in the glyph shard. The deps index
is a **denormalized projection written at seed/commit time** by a party that
already has the glyph body (editing client, or seed/materializer). Core does
not discover references by hydrating unloaded glyphs.

Closure expansion walks this index (client-side, or Worker with the deps
artifact only). It does not open glyph Y.Docs and does not parse outlines.

### Glyph shards

Each `glyph:<glyphId>` document holds that glyph’s full editable state: layers,
paths, components, anchors, local metrics, etc. Same internal Yjs conventions
as today, scoped to one glyph.

## Residency in the browser

Unloaded ≠ missing.

```ts
type GlyphResidency =
    | { state: 'loaded'; glyphId: string }
    | { state: 'loading'; glyphId: string }
    | { state: 'unloaded'; glyphId: string }
    | { state: 'failed'; glyphId: string; error: string };
```

Code that iterates `font.glyphs` must choose: loaded-only, catalog paging, or
server-side full-font job. Local compile assembles an ephemeral font from core
+ loaded glyphs only, after closure hydration.

## Transport split

```text
Editor ── HTTP binary (seed / hydrate packs) ──► Worker ── stream ──► R2
   │                                              │
   │                                              ▼
   └── WebSocket (live, small working set) ──► per-shard DO
                                                  │
                                                  ▼
                                           SQLite durable tail
                                                  │
                                         External compactor
                                         (baseline promote)
```

### R2

Canonical baseline bytes per shard: core, deps index, each glyph checkpoint.
Immutable objects + manifest pointers. Temporary seed/candidate objects as
needed.

### Durable Object (per shard)

Keeps:

- Auth / access epoch
- Active baseline manifest metadata (keys, log ids, hashes) — not bodies
- Durable incremental tail after the baseline
- Connected peers and fan-out
- Bounded in-flight chunk buffers

Must not:

- `arrayBuffer()` seed/baseline/checkpoint bodies into a long-lived Y.Doc
- Answer generic “diff my arbitrary state vector against a hydrated server doc”
- Run full-state compaction

Websocket sync is **checkpoint-relative**: client has baseline N; DO replays
tail rows with `id > N`. Cold rebaseline is HTTP snapshot + tail, not
server-side Yjs diff generation.

### External compactor

Runs outside DO memory limits. Reads R2 baseline + exported tail, builds a
new compacted baseline, CAS-promotes the manifest on the DO. Edit durability
is baseline + acked tail, not “waiting for compaction.”

### Packs

A **pack** is only a transport efficiency layer: one HTTP request whose Worker
response multiplexes many shard payloads. It is not a second data model and
not a single live object shared by many DOs.

Worker implementation rules:

- Stream; do not buffer whole packs in memory
- Bounded concurrency when faning out to per-glyph DOs + R2
- Per glyph, recoverable state is `R2 baseline + DO tail` (fresh edits need
  not be compacted to R2 first)
- Cap batch size per request; schedule remaining ids in further batches —
  capping paces work, it does not drop updates

## Who chooses glyphs; who computes closure

1. **Client chooses seeds** from product intent:
   - active glyph
   - text-run / paragraph cmap hits
   - catalog range (Unicode block, filter)
   - policy `all` for small fonts
2. **Closure** expands seeds through the **deps index** (dependency direction
   for edit/preview/compile). Prefer client-side expansion once deps are
   loaded; Worker may expand using deps only.
3. **Hydrate** requests the missing set as a pack (or parallel per-shard GETs).
4. **Fallback:** if a loaded glyph references an id absent from deps, repair
   (request that id, patch deps). Not the steady-state path.

Feature-layout closure can explode for CJK. Bound browser hydrate; beyond
budget use subset compile or server preview rather than loading the world.

## Live subscription vs freshness

Persistent WebSocket subscriptions stay tiny:

| Channel | When |
| --- | --- |
| `font-core` | Always |
| Active glyph DO | While that glyph is being edited |
| Other glyph DOs | Not for whole text runs or full closures |

Visible / loaded-but-passive glyphs are **hydrated**, not live-subscribed.

When a remote edit commits:

1. Writer updates the affected glyph DO tails (and deps/catalog as needed).
2. Core broadcasts a compact dirty signal: `{ glyphId, revision }[]`.
3. Each peer intersects dirty ids with local interest (loaded ∪ visible ∪
   compile-needed).
4. Interested peers **one-shot catch-up** those shards via HTTP
   (`baseline + tail`), optionally packed — they do not open 21 WebSockets.

Switching the active glyph: unsubscribe previous (or tiny LRU), subscribe next,
catch up first if needed.

## Seeding

1. Client (or materializer) uploads shard baselines to R2 (core, deps, glyph
   packs).
2. Worker verifies size/hash; DO **adopts manifest metadata only**.
3. No DO applies full Yjs state into memory.

Initial seed is also when the deps index is first built: the seeder already
has full glyph bodies locally.

## Local vs full compilation

Local editing compile:

1. Load core (+ deps index as needed)
2. Resolve seeds from UI/text
3. Expand dependency closure
4. Hydrate missing shards
5. Assemble ephemeral font from loaded shards
6. Existing subset / layout-closure compiler on that assembly

Never treat unhydrated as absent.

Full binary builds for fonts over browser policy are a **server compiler**
job from a revision manifest of core + all glyph shards — never a DO or a
single browser loading the entire CJK font.

## Cross-document operations

Independent Y.Docs cannot atomically span core and glyphs. Use explicit
idempotent multi-doc ops in core for create / rename / delete / dependency
republish. Prefer immutable glyph ids and tombstones.

## Memory budgets (normative intent)

| Component | May scale with | Must not scale with |
| --- | --- | --- |
| Glyph DO | peers, tail, in-flight buffers | other glyphs, full font |
| Core DO | peers, tail, lean catalog churn | glyph outlines |
| Worker hydrate | concurrent stream buffers / page size | sum of all pack bytes held at once |
| Browser session | core + deps + working-set glyphs | entire CJK outline set by default |

## Migration sketch

1. Introduce immutable glyph ids + lean catalog + deps index writers on commit.
2. Generalize the committed-update funnel to document-scoped updates.
3. Implement residency + hydrate packs + closure from deps.
4. Shard DO identity and R2 layouts; zero-hydration join (HTTP baseline + tail).
5. External compaction per shard.
6. One-shot migrate legacy whole-font rooms into core + deps + per-glyph
   shards; validate equivalence before switching an asset.

## Explicit non-goals (for the first cut)

- Two parallel architectures (small-font mode vs CJK mode)
- Presigned client R2 credentials as the primary design
- Generic server-side Yjs state-vector diff against a hydrated DO doc
- Loading full feature closure into the browser for arbitrary CJK fonts
- DO-owned full-state checkpointing

## Open follow-ups

- Exact deps index encoding and whether reverse edges are stored or derived
- Browser budgets: glyph count, bytes, feature-closure size
- Whether kerning / feature sources leave core in v1 or later
- Structured feature-class membership vs AFDKO string leaves
- UX for range hydrate and “server preview required”
- Load measurements against Plangothic and Source Han Sans
