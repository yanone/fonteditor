# Live Collaboration v2

## Status

Phase 1 of the original v2 plan is complete, but the original runtime choice is
not the long-term path anymore.

What exists today:

- Cloud filesystem plugin, eligibility gating, asset CRUD, room-token issuance,
  and D1 ACLs are implemented.
- The current room runtime was built around one Cloudflare Durable Object per
  font asset.
- Large serialized font state is currently chunked across multiple SQLite blobs
  to fit the old room shape.

What changes now:

- Chunked SQLite blob storage is retired.
- Large font payloads move to R2.
- Hot collaborative room state moves off Cloudflare Durable Objects and onto an
  external VM-based Ysweet deployment.
- Transport behavior is selected by committed mutation footprint, not by the
  feature that produced the change.

This document supersedes the earlier Cloudflare-DO-centered version of v2.

---

## Why The Plan Changed

The original plan assumed that one asset-sized hot `Y.Doc` could live inside a
Cloudflare Durable Object and that SQLite inside the DO could carry the working
set plus serialized blobs. That is not robust for real fonts:

- the DO memory ceiling is too small for the desired hot state envelope;
- SQLite blob chunking is the wrong abstraction for large babelfont payloads;
- the browser, Yjs, JS object model, and Pyodide already consume a large memory
  multiplier over raw JSON size;
- full-font operations can legitimately touch a very large portion of the font,
  regardless of whether they come from Python, restore, or another edit path.

The new plan keeps Cloudflare where it is strong and moves the hot room runtime
to infrastructure that can scale memory sanely.

---

## New Architecture

```
Browser editor ────────────► Pages (website)                     control plane
        │                       │   D1: users, ACL, assets, folders,
        │                       │       membership, event index,
        │                       │       room directory, named versions
        │                       │   R2: bootstrap blobs, snapshots,
        │                       │       rebases, glyph snapshots,
        │                       │       migration output
        │   room token          │
        ▼                       ▼
   WebSocket ─────────────► Ysweet room runtime on external VMs  data plane
                               │
                               ├─ hot Yjs room state
                               ├─ room-local append log / short hot tail
                               ├─ memory telemetry and admission control
                               └─ snapshot / rebase handoff to R2

Heavy full-font operations ─► batch executor on external VMs
                               │
                               └─ emits live delta, staged commit,
                                  or full rebase based on committed size
```

Cloudflare remains the control plane:

- authentication and session ownership;
- room-token issuance;
- D1 metadata and searchable history index;
- R2 object storage for all large payloads;
- admin tools and asset CRUD.

External VMs run the hot room state via Ysweet.

---

## Design Principles

### 1. R2 is the blob store

R2 is the canonical location for large serialized state:

- initial uploaded babelfont JSON;
- bootstrap payloads;
- warm segments;
- full snapshots;
- glyph snapshots;
- full rebases;
- migration output from the legacy chunked-SQLite layout.

SQLite is no longer used as a bucket for large serialized font blobs.

### 2. Hot runtime is not on Cloudflare DOs

Durable Objects are not the long-term hot room runtime. They may remain useful
for narrow coordination tasks later, but v2 no longer depends on them to hold
asset-sized live Yjs state.

### 3. Transport mode depends on committed mutation footprint

The system does not special-case Python.

Every committed logical transaction is classified by:

- encoded Yjs delta size;
- number of glyphs touched;
- number of layers touched;
- whether font-scope state changed;
- whether kerning / features / font info changed;
- whether the change requires full-font materialization;
- expected client fan-out cost.

From that classification, the system chooses one of three transport modes:

1. `live-delta`
2. `staged-commit`
3. `rebase`

The origin of the change is not part of the routing decision.

### 4. Undo remains a local editor concern until committed

Personal undo stays local to the editor. When undo produces a committed forward
change, that committed transaction is classified the same way as any other
transaction.

### 5. Browser memory remains a real limit

Moving the hot room off Cloudflare does not remove browser memory limits.
Large-font support therefore depends on:

- keeping ordinary live collaboration incremental;
- avoiding unnecessary full-font materialization in the browser;
- using staged commits or rebases for very large mutations;
- optionally pushing very large full-font jobs to external execution.

---

## Room Model

Each asset still has one logical collaboration room, but that room is now a
YSweet room running on an external VM.

The room owns:

- hot Yjs state;
- awareness / presence;
- ordered mutation application;
- room versioning;
- short hot append log;
- live fan-out to connected clients.

The room does not own:

- long-term large blob storage;
- canonical asset bootstrap files;
- long-term snapshot retention;
- the searchable history index;
- heavy full-font batch processing.

---

## Transport Modes

### Live Delta

Use for small, bounded, ordinary collaborative edits.

Properties:

- immediate WebSocket fan-out;
- normal local compile behavior;
- normal local undo behavior;
- appended to the room hot log;
- later rolled into segments / snapshots.

### Staged Commit

Use when a committed logical transaction is too large for a single safe live
fan-out frame, but is still naturally represented as a patch set.

Properties:

- one logical transaction ID;
- chunked transport to clients;
- client applies only after the full staged commit is received;
- preserves atomic visible semantics without requiring one giant message.

### Rebase

Use when a committed logical transaction is too large or too global for safe
live patch fan-out.

Properties:

- executor or room writes a new authoritative snapshot to R2;
- clients receive a control message describing the new room version;
- clients switch to the new version instead of applying a huge live delta;
- history records it as one logical operation.

Typical triggers:

- very large multi-glyph edits;
- full-font restore;
- large import or migration output;
- global transformation whose patch fan-out would be unsafe.

---

## External Execution

Some mutations are cheap even when produced by Python. Some non-Python edits can
be globally expensive. Therefore the decision to use external execution is based
on the mutation footprint, not the feature.

External execution is appropriate when:

- the change requires full-font materialization;
- projected browser apply cost is too high;
- projected room RSS spike is too high;
- the resulting patch fan-out would be too large;
- a rebase is more robust than a live patch stream.

External execution can produce any of the three transport modes, but it will
most often emit `staged-commit` or `rebase`.

---

## Persistence Layout

### D1

D1 remains metadata and index storage only.

It stores:

- `font_assets`
- `font_asset_members`
- `font_asset_invitations`
- `cloud_folders`
- `cloud_folder_entries`
- `font_asset_versions`
- `font_asset_events`
- `user_cloud_overrides`
- room-directory / placement metadata for the Ysweet VM pool

Per-update large binary writes do not go to D1.

### R2

R2 stores:

- original uploaded babelfont payloads;
- asset bootstrap blobs;
- warm segments;
- full Yjs snapshots;
- Brotli babelfont snapshots;
- glyph snapshots;
- rebases;
- migration artifacts when importing legacy chunked SQLite data.

### Room-local hot log

The Ysweet room keeps only a short hot log sufficient for recovery from recent
crashes and orderly segment rolling. The hot log is not a long-term large blob
store.

---

## Snapshot And Recovery Model

The semantic model remains the same:

- named versions;
- session boundaries;
- restore is a forward operation;
- per-glyph recovery matters;
- searchable history lives outside the binary room state.

What changes is where snapshots live and how large restores are delivered.

### Snapshot kinds

- `named`
- `session-end`
- `session-start`
- `pre-op`
- `recovery`
- `explicit`
- `import`
- `migration`

### Snapshot storage

- full snapshots go to R2;
- glyph snapshots also go to R2;
- metadata rows go to D1.

### Restore routing

- small glyph / layer restore: `live-delta` or `staged-commit`
- large or whole-font restore: `rebase`

---

## VM Placement Strategy

YSweet runs on external VMs under conservative admission control.

Initial operating policy:

- start with memory-heavy VMs, not tiny instances;
- classify rooms as `small`, `medium`, or `large` by measured memory and load;
- allow one suspiciously large room per VM until telemetry is stable;
- pack multiple rooms onto one VM only after measured RSS, spikes, and open-time
  behavior are understood;
- heavy external execution may run in the same fleet at first, but is a
  separate logical service from the live room.

Room placement must consider:

- current RSS;
- projected RSS after room load;
- number of connected clients;
- recent mutation volume;
- snapshot / rebase cost;
- whether the room is currently in a high-risk state.

---

## Migration From The Current Implementation

Phase 1 shipped under the old plan. The immediate task now is migration, not
incremental extension of the old Durable Object storage model.

### Legacy state that must be retired

- asset-sized serialized JSON chunked across SQLite blobs;
- assumption that the Cloudflare room runtime is the long-term hot state owner;
- any future persistence work that deepens the chunked-SQLite path.

### Migration target

- asset bootstrap blob in R2;
- room hot state in Ysweet on external VMs;
- D1 metadata unchanged where still valid;
- history/snapshot metadata preserved;
- legacy chunked SQLite data imported once, then abandoned.

---

## Actionable Checklist

This is the forward plan from the current state.

### Phase 1.5 — Stop Digging

- [ ] Freeze all new work that increases reliance on chunked SQLite blobs.
- [ ] Treat the current DO runtime as a temporary compatibility layer only.
- [ ] Document the exact legacy blob format and asset bootstrap path that exists
      today.

### Phase 2 — Move Blobs To R2

- [ ] Define canonical R2 object keys for: - imported asset bootstrap blobs - full Yjs snapshots - babelfont snapshots - glyph snapshots - rebases
- [ ] Add migration code to read each asset's current chunked SQLite payload,
      reassemble it once, and write the canonical bootstrap blob to R2.
- [ ] Add D1 fields or metadata rows that point each asset to its canonical R2
      bootstrap object.
- [ ] Verify a migrated asset can open from R2 without consulting chunked
      SQLite blobs.
- [ ] Mark migrated assets so the legacy chunked blobs are no longer read.
- [ ] Add a one-way cleanup step for deleting obsolete chunked blobs after the
      migration is verified.

### Phase 3 — Stand Up Ysweet On External VMs

- [ ] Provision a small VM pool for Ysweet.
- [ ] Define room directory metadata in D1: room ID, current VM owner,
      heartbeat, room class, version.
- [ ] Implement room-token issuance for the Ysweet endpoint instead of the old
      DO WebSocket endpoint.
- [ ] Teach the editor to connect to the Ysweet room endpoint returned by the
      control plane.
- [ ] Keep the old room path behind a compatibility flag until migrated assets
      are verified.

### Phase 4 — Replace The Old Room Path

- [ ] Migrate one real asset end-to-end: R2 bootstrap, Ysweet room, live open,
      edit, reconnect.
- [ ] Verify multiple browsers converge on the migrated asset.
- [ ] Verify local undo still behaves correctly after migration.
- [ ] Switch new room creation to Ysweet by default.
- [ ] Disable new writes to the old DO room path.

### Phase 5 — Introduce Mutation Routing

- [ ] Define a transaction classifier that runs on committed logical
      transactions, not low-level Yjs fragments.
- [ ] Record at least these classifier inputs: - encoded delta bytes - glyph count touched - layer count touched - scope kind(s) - requires full-font materialization - projected fan-out size
- [ ] Define thresholds for `live-delta`, `staged-commit`, and `rebase`.
- [ ] Implement staged commit transport.
- [ ] Implement rebase transport via R2 snapshot publication.
- [ ] Ensure routing decisions are independent of whether the change came from
      Python, restore, or any other feature.

### Phase 6 — External Execution

- [ ] Add a batch executor path for large committed mutations.
- [ ] Route only footprint-heavy transactions there.
- [ ] Keep small scripts and other small mutations on the normal live path.
- [ ] Make the executor capable of producing `staged-commit` or `rebase`.

### Phase 7 — History And Recovery On The New Architecture

- [ ] Reconnect `font_asset_events` and `font_asset_versions` to the new room
      runtime.
- [ ] Store full and glyph snapshots in R2.
- [ ] Implement per-glyph restore on top of the new storage layout.
- [ ] Implement whole-font restore as a routed large operation, usually a
      rebase.

---

## Local Development Gate

The project must maintain a working local collaboration workflow before moving
further into VM deployment work.

Current local baseline:

- editor on `https://localhost:8000`
- website on `http://localhost:8788`
- room worker on `http://localhost:8787`
- one-command local stack start via `npm run dev:collab:local`
- one-command local workflow verification via `npm run test:collab:local`

The local verification path must prove:

1. local cloud session bootstrap
2. save a font into the cloud asset path
3. reopen that asset in a second page
4. apply a real glyph edit in page A
5. observe the propagated remote update in page B

Deployment packaging is not the source of truth for collaboration behavior.
The source of truth is the local end-to-end editor, control-plane, and
room-runtime flow.

### Phase 8 — Operational Hardening

- [ ] Measure VM RSS per room continuously.
- [ ] Track room open time, snapshot duration, staged commit size, rebase size,
      and reconnect time.
- [ ] Start conservative room packing: one large room per VM.
- [ ] Only pack more rooms per VM after real telemetry shows safe headroom.
- [ ] Add alarms for memory pressure, rebase failures, and room crash loops.

---

## Immediate Non-Goals

These are explicitly not required for the next step:

- Cloudflare Durable Objects as the long-term hot room runtime;
- broad glyph-sharding before the new baseline room runtime is stable;
- feature-specific routing rules for Python;
- preserving the chunked SQLite layout as a supported steady state.

---

## Acceptance Criteria For The Revised v2

The revised v2 is complete when:

- assets open from canonical R2 bootstrap blobs, not chunked SQLite blobs;
- hot collaboration runs through Ysweet on external VMs;
- small committed changes travel as normal live deltas;
- larger committed changes are automatically routed as staged commits or
  rebases based on mutation footprint;
- routing does not depend on whether the change came from Python;
- local personal undo still only undoes the user's own work;
- snapshots, versions, and history remain queryable from D1 + R2;
- one migrated real asset survives reconnect, snapshot, and restore flows on
  the new architecture.
