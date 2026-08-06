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
| Compaction | External to the room DO; Worker-class for shards, fat host if over recoverability |
| Discovery | Lean identity catalog in core (incl. cmap) + separate deps index |
| Closure | Layout closure (`close_layout`) ∪ deps-index expansion; then hydrate bodies |
| Linked windows | Main window is sole cloud hub; BC is multi-doc; per-window residency |
| Small vs large | Same machinery; default hydrate policy is `all` vs working-set |
| Full-font compile | Session-scoped Fly Machine (8–16 GB); core dirty + HTTP glyph catch-up |

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
  kerning stays forever), instances, notes, features, etc.
- A **lean glyph catalog** for browse/search/order — not outline data.
- Enough encoding data to resolve characters → glyphs **without hydrating
  glyph shards** (see cmap below).

Catalog entry (illustrative):

```ts
type GlyphCatalogEntry = {
    glyphId: string;
    name: string;
    codepoints: number[]; // required projection; see cmap
    productionName?: string;
    latestGlyphRevision: string;
    exported?: boolean;
    deleted?: boolean;
};
```

#### Cmap / character → glyph mapping

Today, Unicode encodings live only on each glyph (`glyph.codepoints`) inside
the hydrated glyph list. After sharding, that is not available until the glyph
body is loaded — too late for text-run seeding.

`font-core` must therefore carry a cmap-like index derived from those
encodings, updated whenever a glyph’s codepoints change:

- At minimum: every catalog entry’s `codepoints` (and a reverse lookup
  `codepoint → glyphId[]` or equivalent, built from the catalog or stored
  beside it).
- Optional later: a denser dedicated cmap structure if per-entry lists plus
  scan are too slow for CJK text.

This is how “expand encoded characters into a seed set” works before any
outline hydrate: text → codepoints → catalog/cmap → glyph ids → full closure.

Authoritative per-glyph `codepoints` may still also exist on the glyph shard
for editing; core’s map is the denormalized discovery copy, same pattern as
deps.

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
not discover component/metrics references by hydrating unloaded glyphs.

Component and metrics-key closure walks this index (client-side, or Worker with
the deps artifact only). It does not open glyph Y.Docs and does not parse
outlines. OpenType layout closure is a separate step and does not use this
index (see below).

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
                                    External compactor (per shard)
                                    Worker-class | fat if oversized
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

### Compaction (room DO vs external)

Edit durability is always **R2 baseline + acked DO tail**, never “waiting for
compaction.” Compaction only rewrites a new baseline and CAS-promotes the
manifest so tails can shrink.

#### Room DO (never the compactor)

Keeps zero-hydration. For compaction it only:

- Tracks dirty-byte / dirty-row thresholds and schedules work
- Exports the durable tail after the current checkpoint log id
- CAS-promotes a candidate baseline the external host wrote to R2

It must not load checkpoint bodies into a `Y.Doc`, GC-encode full state, or
stack compaction peak on the live WebSocket isolate. In-room
`encodeStateAsUpdate` / fresh-doc GC is allowed only for tiny seed / first
baseline promotion where no prior checkpoint exists yet — not as the steady
path.

#### Why “external” even when the host is still a Worker

Today’s `cf-compactor` is a **separate Workers isolate**, not unlimited RAM.
Externalization is still the right room design because:

1. Compaction peak must not share the live room heap (fan-out, auth, tail
   append).
2. Zero-hydration DOs cannot compact without rehydrating — which defeats the
   shard memory model.
3. After sharding, recoverable size is per-shard (`checkpoint + dirty tail`),
   not whole-font. Glyph and lean-core shards fit a Worker; whole-font rooms
   do not.

Probe order of magnitude (synthetic Yjs, `cf-compactor` probe): GC compact
peak heap is roughly **2–4×** encoded checkpoint size. A Worker recoverable
cap (today ~16 MiB encoded) is therefore a deliberate shard invariant, not a
font-size budget.

#### Two external host classes

| Host | Role | Memory contract |
| --- | --- | --- |
| **Worker-class compactor** (current `cf-compactor`) | Steady-state per-shard compact | `checkpointBytes + dirtyTailBytes ≤ MAX_COMPACTION_RECOVERABLE_BYTES`; reject/queue elsewhere if over |
| **Fat-process compactor** (same class as full-font builder VM / Containers) | Oversized shards, legacy whole-font migration, pathological cores | May hold multi‑100 MB Yjs GC peaks; not a DO or Worker isolate |

Flow (both hosts):

```text
Room DO alarm / threshold
  → export tail (no Y.Doc hydrate)
  → compactor: R2 baseline + tail → Y.Doc({gc:true}) → encode → R2 candidate
  → room DO: CAS promote manifest → truncate acked tail
```

Refuse to compact oversized recoverable state in a Worker; migrate/shard or
hand off to the fat host. Do not raise the Worker cap to “almost 128 MiB” as
a substitute for sharding — the multiplier and concurrent isolate noise leave
little headroom.

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

### Seeds

The **client** chooses seeds from product intent:

- active glyph
- text-run / paragraph characters, resolved through core’s **cmap/catalog**
  (`codepoint → glyphId`), not by inspecting unloaded glyph shards
- catalog range (Unicode block, filter) via the same encoding index
- policy `all` for small fonts

Without a core-resident character map, encoded text cannot become a seed set
until every possibly matching glyph is already hydrated — which defeats lazy
hydration.

### Full downloadable closure (no outline hydrate)

A hydrate pack’s glyph set is the union of two expansions. Neither step needs
glyph outline bodies loaded.

```text
seeds
  → (A) OpenType layout closure     // features + catalog names
  → (B) deps-index expansion        // components, metrics-key edges, …
  → hydrate missing ids from R2/DOs
```

**(A) Layout closure** uses babelfont’s existing `close_layout` preprocessor
(already used by the browser editing subset / WASM
`prime_layout_closure_cache` path). Inputs:

- feature source from `font-core` (`font.features` → FEA)
- glyph **name** universe from the lean catalog (not outlines)
- seed glyph names

`close_layout` parses the FEA AST and walks GSUB reachability (single /
multiple / alternate / ligature / reverse-chain subst, class defs, multi-round
lookups). Today’s API takes `&Font` for convenience; semantically it only
needs `{ features, glyphNames[], seeds }`. Empty name-only glyph stubs suffice
in babelfont tests — outlines are irrelevant.

**(B) Dependency-index expansion** then (or interleaved to fixpoint) adds
transitive component and metrics-key prerequisites via `font-deps`, matching
what the WASM path today does with `expand_closure_with_component_deps` after
`close_layout` — except the sharded world reads the deps index instead of
walking hydrated layers.

Prefer computing this on the client once core + deps are loaded. A Worker may
run the same algorithm if given seeds, core features/catalog names, and the
deps artifact — still without opening glyph Y.Docs.

### Hydrate and repair

1. **Hydrate** the missing set as a pack (or parallel per-shard GETs).
2. **Fallback:** if a loaded glyph references an id absent from deps, repair
   (request that id, patch deps). Not the steady-state path.

Layout closure for arbitrary CJK feature sets can still explode past browser
budget. Bound hydrate size; beyond budget use subset compile or server preview
rather than loading the world. That budget limit is a product policy on the
*result* of closure, not a reason to skip layout closure.

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

## Linked windows (same browser)

Today, linked windows share **one** whole-font Y.Doc over `BroadcastChannel`
(`WindowSync`): bootstrap via `full-state-request/response`, steady-state via
`yjs-update`. Only the **main** window connects to the cloud DO; it relays
peer updates up and cloud updates down (`APP.md`).

That hub model stays. What changes is document scope and bootstrap volume —
not “every window opens one WebSocket per glyph.”

### What stays

- Main window = only cloud WebSocket client for the asset.
- Linked windows talk to main (and peers) over BroadcastChannel.
- Authoritative transport = binary Yjs updates + collaboration metadata.
- Same committed-change funnel after apply.

### What changes

**Many local Y.Docs.** Each window keeps `font-core` (+ `font-deps`) always,
and only the glyph docs in **its** residency set. Two linked windows may
hydrate different glyphs (different text runs / active glyphs). That is
normal.

**Packets are document-scoped.** Every BC message carries a `documentId`
(`font-core` | `font-deps` | `glyph:<id>`). Receivers apply a glyph update
only if that shard is loaded (core/deps always apply).

**Bootstrap must not dump the whole font.** A single full-font
`full-state-response` is already painful and is impossible for CJK. Linked
open should:

1. Obtain **core** (+ deps) state from main over BC (or from R2 baseline for
   cloud assets).
2. Compute **this window’s** seeds → layout closure ∪ deps → missing glyph
   set.
3. Fetch those shard states from main **when main already has them**, else
   via the same HTTP hydrate path (R2 + tails) — never by shipping every
   glyph the main window has ever touched.

**Cloud live set is multiplexed on main.** Because only main holds DO
connections, main subscribes to:

- `font-core` (always), and
- the **union of active glyphs** across local windows (plus an optional small
  LRU),

while passive freshness for other hydrated glyphs uses core dirty signals +
HTTP catch-up — the same pattern as remote collaborators. Linked windows
announce interest (active glyph / residency) so main can adjust the live set.
They never open glyph DO sockets themselves.

**Cascade across windows.** If window A edits `a` and writes recomposed glyph
docs that window B has loaded, those document-scoped updates go out on BC
(and to the cloud via main). B applies them if resident; if not, B only sees
catalog/deps/dirty until it hydrates.

| Path | Linked windows |
| --- | --- |
| Local sync | BC, multi-doc packets; interest = local residency |
| Cloud live | Main multiplexes DO subs for the local window group |
| Bulk / catch-up | HTTP packs / baseline+tail, not BC full-font snapshots |
| Residency | Per-window; not required to match peers |

## Seeding

1. Client (or materializer) uploads shard baselines to R2 (core, deps, glyph
   packs).
2. Worker verifies size/hash; DO **adopts manifest metadata only**.
3. No DO applies full Yjs state into memory.

Initial seed is also when the deps index is first built: the seeder already
has full glyph bodies locally.

## Local vs full compilation

### Local editing compile (browser)

1. Load core (+ deps index as needed)
2. Resolve seeds from UI/text
3. Compute full closure: `close_layout` ∪ deps-index expansion
4. Hydrate missing shards
5. Assemble ephemeral font from loaded shards
6. Existing subset / compile pipeline on that assembly (`RetainGlyphs` et al.)

Never treat unhydrated as absent. The hydrate closure and the editing-subset
closure should use the same two-phase algorithm so packs and compiles agree.

### Server full-font compiler (proofing / export)

Full binary builds for fonts over browser policy are a **multi-core VM (or
container) job** — never a Durable Object and never a browser holding the
entire CJK outline set. The builder uses the **same shard model and update
semantics** as the editor; it does **not** open 65k glyph DO WebSockets.

```text
R2 baselines + DO tails
        │
        ▼  hydrate policy `all` (HTTP packs)
Full-font builder VM  ── font-core WS (dirty / revision)
  (multi-core fontc)  ── HTTP catch-up for dirty glyph shards only
        │
        ▼  OTF/TTF artifact
Proofing browser tab  ← stream / poll binary (+ stale/building status)
```

**Rough pipeline**

1. **Cold start:** HTTP hydrate `font-core` + `font-deps` + every
   `glyph:<id>` from R2 packs (Worker-streamed), apply outstanding DO tails
   the same way a client recovers recoverable state (baseline + tail).
2. **Materialize** one in-process babelfont (or fontc IR) for the full font.
3. **Compile** with native fontc using **real multiprocessing** (unavailable
   in browser WASM).
4. **Publish** the binary (R2 object and/or direct stream) with a revision id
   tied to the core/deps/glyph shard manifest used for the build.
5. **Proofing client** loads that binary into HarfBuzz (or downloads for
   export). UI shows building / ready / stale relative to the live room.

**Live updates (same language, different residency)**

| Concern | Editing browser | Full-font builder |
| --- | --- | --- |
| Hydrate policy | Working set (`all` only for small fonts) | Always `all` |
| Live DO sockets | `font-core` + active glyph(s) | `font-core` only (optional build-control channel) |
| Glyph freshness | Dirty signal + HTTP catch-up | Same: patch only touched glyphs, enqueue rebuild |
| Optional trigger | N/A | Commit / compaction hooks enqueue builds without a long-lived subscriber |

Do **not** subscribe the builder to every glyph DO. 65k live sockets would
dwarf the compile cost. Core dirty fan-out + selective glyph catch-up (or a
build queue) is enough and stays aligned with how passive hydrated glyphs
already refresh in the editor.

**Debounce and status.** Full CJK compiles are tens of seconds to minutes.
Debounce rebuilds on edit bursts; proofing tabs must tolerate lag and show
stale-vs-current clearly. Live updates reuse the editor’s **document-patch**
language (core dirty → HTTP glyph catch-up → rematerialize). Expect mostly
**full native fontc recompiles** after that — the warm machine’s win is
avoiding re-hydrate + IR rebuild every edit, not fine-grained fontc IR reuse
(unless measured later).

**Where it runs (recommended infrastructure).**

Never a Durable Object or Worker isolate. Same fat-process class as the
oversized-shard / migration compactor — not the steady-state Worker
compactor.

| Mode | Host | When |
| --- | --- | --- |
| **Interactive proofing (default)** | **Session-scoped Fly Machine** (or equivalent microVM): start when a proofing client attaches, stop/suspend after idle | Needs the full font resident for the editing session |
| One-shot export / offline build | Same image as a queue job; scale to zero after publish | No live listen required |
| Cloudflare Containers | Acceptable CF-native alternative for lighter fonts | Max instance is **12 GiB**; fine for Plangothic-class, tight for heavy multi-master peaks |

**Session model (interactive).** One machine per active proofing session (or
per asset while proofing is open), sized from the RAM table below (**8 GB**
Plangothic-like, **16 GB** heavy CJK VF). Lifecycle:

1. Collab Worker (or proofing control API) starts the machine.
2. Machine cold-hydrates all shards once, materializes IR, compiles, publishes.
3. Stays warm: `font-core` dirty channel + HTTP catch-up for touched glyphs →
   debounced recompile → new binary revision.
4. On proofing disconnect / idle timeout: suspend or destroy. Persist only R2
   shards + last binary artifact — do **not** keep full-font RAM between
   sessions.

**Cost vs spin-up.** Bill **RAM × session hours**, not 24/7 per asset. OS/container
cold start (≈1–3 s, or ~1 s Fly resume-from-suspend) is noise next to first
hydrate of a ~100–450 MB CJK glyph set. Therefore: keep warm for the session;
scale to zero between sessions; never hydrate-from-cold on every edit.

Do **not** use a shared always-on fleet until concurrent CJK proofing rooms
justify it. Do **not** use scale-to-zero **per edit** — that re-pays hydrate
cost and ruins interactive feel.

### Rough RAM estimates (order of magnitude)

Measured compact JSON from the sibling CJK sizing experiment
(`cjk-collab-sizing/results/sizing.md`), ~65k-glyph class:

| Source (compact JSON) | Glyphs | Glyphs JSON | Core JSON | Notes |
| --- | ---: | ---: | ---: | --- |
| Plangothic P1 | 64,579 | ~100 MB | ~6 MB | Single master; sane core |
| Plangothic P2 | 41,994 | ~59 MB | ~4 MB | |
| Source Han Sans SC VF (TTF round-trip) | 65,535 | ~218 MB | ~133 MB | Core almost all enumerated FEA artifact; **not** target shape |
| SHS-like with class kerning (est.) | ~65k | ~218 MB | ~6–10 MB | Source-shaped features; glyphs still heavy |

In-process budgets are larger than compact JSON:

| Stage | Plangothic-like (~65k, 1 master) | Heavy CJK VF (~65k, multi-master, sane FEA) |
| --- | --- | --- |
| Shard payloads on disk / R2 | ~100–160 MB | ~200–450 MB |
| Hydrated source IR in builder | ~0.3–0.8 GB | ~0.8–2 GB |
| Peak during fontc (IR + tables + temps) | ~1–3 GB | ~3–8 GB |
| Output OTF/TTF (order of mag.) | tens of MB | tens–low hundreds of MB |
| **Suggested VM RAM** | **4–8 GB** | **8–16 GB** |

Factors that move the peak: master count, contour density, feature/kerning
complexity, concurrent builds, and whether two revisions overlap in memory.
**Do not** size from TTF-uncompiled feature dumps (~129 MB FEA prefixes alone);
keep source-shaped features in core.

Browser / DO remain unbound by these peaks: they never hold the full outline
set for CJK-scale proofing builds.

## Cross-document operations

Independent Y.Docs cannot atomically span core and glyphs. Use explicit
idempotent multi-doc ops in core for create / rename / delete / dependency
republish. Prefer immutable glyph ids and tombstones.

## Memory budgets (normative intent)

| Component | May scale with | Must not scale with |
| --- | --- | --- |
| Glyph DO | peers, tail, in-flight buffers | other glyphs, full font, compaction peak |
| Core DO | peers, tail, lean catalog churn | glyph outlines, compaction peak |
| Worker-class compactor | one shard’s baseline + dirty tail (+ ~2–4× GC peak) | whole font; any shard over recoverable cap |
| Fat-process compactor / builder VM | oversized shard or full glyph set + fontc peak | DO / Worker isolate limits |
| Worker hydrate | concurrent stream buffers / page size | sum of all pack bytes held at once |
| Browser session | core + deps + working-set glyphs | entire CJK outline set by default |

## Migration sketch

1. Introduce immutable glyph ids + lean catalog (with codepoints/cmap) + deps
   index writers on commit.
2. Generalize the committed-update funnel to document-scoped updates.
3. Implement residency + hydrate packs + full closure
   (`close_layout` ∪ deps index), reusing the existing babelfont/WASM layout
   closure path with catalog names instead of a full glyph list. Extend
   `WindowSync` to document-scoped BC packets and shard-scoped linked
   bootstrap (core/deps + requested glyphs), keeping main as the sole cloud
   hub.
4. Shard DO identity and R2 layouts; zero-hydration join (HTTP baseline + tail).
5. External compaction per shard on the Worker-class host; refuse or hand off
   shards above the recoverable-byte cap.
6. One-shot migrate legacy whole-font rooms into core + deps + per-glyph
   shards (fat-process compact during migration if needed); validate
   equivalence before switching an asset.

## Explicit non-goals (for the first cut)

- Two parallel architectures (small-font mode vs CJK mode)
- Presigned client R2 credentials as the primary design
- Generic server-side Yjs state-vector diff against a hydrated DO doc
- Loading full feature closure into the browser for arbitrary CJK fonts
- DO-owned steady-state full-state checkpointing / GC compaction
- Treating today’s Worker compactor as unlimited RAM (“outside 128 MiB”)

## Open follow-ups

- Exact deps index encoding and whether reverse edges are stored or derived
- Cmap encoding in core: per-entry `codepoints` only vs dedicated
  `codepoint → glyphId[]` structure for CJK text performance
- Linked-window interest protocol: how precisely main aggregates active-glyph
  DO subscriptions across local windows
- Thinner `close_layout` API: `{ features, glyphNames, seeds }` without a full
  `Font` (optional cleanup in babelfont-rs)
- Browser budgets: glyph count, bytes, layout-closure result size
- Whether kerning / feature sources leave core in v1 or later
- Structured feature-class membership vs AFDKO string leaves
- UX for range hydrate and “server preview required”
- Load measurements against Plangothic and Source Han Sans
- Server builder: measured fontc peak RAM on real Plangothic / SHS-source
  builds; proofing stream protocol; Fly vs CF Containers bake-off at 8–12 GB
- Fat-process compactor: when to enqueue from Worker 413 vs migrate-only;
  shared image/host pool with the session builder or separate
