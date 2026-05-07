# Live Collaboration v2

## Status

Phase 1 of the original v2 plan is complete.

What exists today:

- Cloud filesystem plugin, eligibility gating, asset CRUD, room-token issuance,
  and D1 ACLs are implemented.
- The live room runtime is one Cloudflare Durable Object per font asset.
- Local collaboration works against the real local stack, including cloud save,
  reopen, second-page open, and remote update convergence.
- URL-based cloud asset reopen works from the asset id rather than a room id.
- Large serialized font state is still chunked across SQLite blobs in the
  current compatibility path.

What changes now:

- Live Cloudflare Durable Objects remain the primary hot room runtime.
- Large canonical font payloads should still move to R2 over time.
- The undocumented 128 MB memory-limit claim is no longer treated as an
  architectural fact; runtime decisions must be based on measured telemetry.
- Transport behavior is still selected by committed mutation footprint, not by
  the feature that produced the change.

This document replaces the earlier Ysweet-pivot revision and restores the
Durable-Object-based runtime as the active plan.

---

## Why The Plan Changed Again

The earlier Ysweet pivot was based partly on an outdated assumption about a
documented Cloudflare Durable Object memory limit. The current Cloudflare
limits page does not publish a hard 128 MB memory ceiling for Durable Objects,
so that specific claim should not drive architecture.

The plan is therefore adjusted to continue on the already working Durable
Object path while fixing the real remaining issues:

- SQLite blob chunking is the wrong abstraction for large babelfont payloads;
- the browser, Yjs, JS object model, and Pyodide already consume a large memory
  multiplier over raw JSON size;
- full-font operations can legitimately touch a very large portion of the font,
  regardless of whether they come from Python, restore, or another edit path;
- the current DO-based workflow is already integrated end to end, while a
  runtime swap would add migration risk before we have measured the current
  system properly.

The new plan keeps the hot room runtime on Cloudflare Durable Objects, adds
telemetry and guardrails, moves large persistent blobs toward R2, and keeps
external execution as an optional later escalation path rather than the default
runtime.

---

## Architecture

```
Browser editor ────────────► Pages (website)                     control plane
        │                       │   D1: users, ACL, assets, folders,
        │                       │       membership, event index,
        │                       │       named versions, room metadata
        │                       │   R2: bootstrap blobs, snapshots,
        │                       │       rebases, glyph snapshots,
        │                       │       migration output
        │   room token          │
        ▼                       ▼
   WebSocket ─────────────► Durable Object room runtime          data plane
                               │
                               ├─ hot Yjs room state
                               ├─ presence and live fan-out
                               ├─ room versioning / reconnect path
                               ├─ short hot recovery state
                               └─ snapshot / bootstrap handoff to R2

Heavy full-font operations ─► optional external executor
                               │
                               └─ emits live delta, staged commit,
                                  or full rebase based on committed size
```

Cloudflare remains the control plane and primary room runtime:

- authentication and session ownership;
- room-token issuance;
- live room hosting through Durable Objects;
- D1 metadata and searchable history index;
- R2 object storage for large payloads;
- admin tools and asset CRUD.

External infrastructure is optional and should be introduced only if measured
DO telemetry shows that specific workloads cannot be handled safely enough on
the live Cloudflare path.

---

## Design Principles

### 1. R2 is the canonical blob store

R2 is the target location for large serialized state:

- initial uploaded babelfont JSON;
- asset bootstrap blobs;
- warm segments;
- full snapshots;
- glyph snapshots;
- full rebases;
- migration output from the legacy chunked-SQLite layout.

SQLite inside a Durable Object should not remain the long-term bucket for large
font payloads.

### 2. Hot runtime stays on Cloudflare DOs

Durable Objects are the active hot room runtime for v2.

What changes is not the runtime choice, but the discipline around it:

- do not cite undocumented memory numbers as hard limits;
- instrument open time, reconnect time, payload size, and persistence cost;
- keep room state lean and move canonical large blobs to R2;
- add escalation paths for footprint-heavy committed changes.

### 3. Transport mode depends on committed mutation footprint

The system does not special-case Python.

Every committed logical transaction is classified by:

- encoded Yjs delta size;
- number of glyphs touched;
- number of layers touched;
- whether font-scope state changed;
- whether kerning, features, or font info changed;
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

Keeping the hot room on Cloudflare does not remove browser memory limits.
Large-font support therefore still depends on:

- keeping ordinary live collaboration incremental;
- avoiding unnecessary full-font materialization in the browser;
- using staged commits or rebases for very large mutations;
- optionally pushing very large full-font jobs to external execution.

---

## Room Model

Each asset has one logical collaboration room, hosted by one Cloudflare Durable
Object.

The room owns:

- hot Yjs state;
- awareness and presence;
- ordered mutation application;
- room versioning;
- live fan-out to connected clients;
- short-lived recovery state for reconnect and persistence handoff.

The room does not own the canonical long-term blob store.

---

## Transport Modes

### Live Delta

Use for small, bounded, ordinary collaborative edits.

Properties:

- immediate WebSocket fan-out;
- normal local compile behavior;
- normal local undo behavior;
- appended to the room hot state path;
- later rolled into snapshots or other persistence outputs.

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

Some mutations are cheap even when produced by Python. Some non-Python edits
can be globally expensive. Therefore the decision to use external execution is
based on the mutation footprint, not the feature.

External execution is appropriate when:

- the change requires full-font materialization;
- projected browser apply cost is too high;
- projected room pressure is too high;
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
- room metadata needed for room-token issuance and future observability

Per-update large binary writes do not belong in D1.

### R2

R2 stores or should store:

- original uploaded babelfont payloads;
- asset bootstrap blobs;
- full Yjs snapshots;
- Brotli babelfont snapshots;
- glyph snapshots;
- rebases;
- migration artifacts when importing legacy chunked SQLite data.

### Room-local hot state

The Durable Object should keep only the active hot state and short-lived
recovery data needed for orderly reconnect and persistence handoff. It should
not remain the canonical long-term large-blob store.

---

## Delta-Journal And Checkpoint Policy

### Write path

Every accepted edit is appended to a DO-local SQLite delta journal (the
`room_log` table). The acknowledgement to the client is issued after the
journal append completes — **not** after an R2 write. R2 writes never block
the ack or broadcast path.

The journal stores binary Yjs update deltas. Full document state is never
recomputed per update on the hot path.

### Checkpoint triggers

A full-state checkpoint (snapshot written to R2) is triggered when **any** of
the following conditions is met while the journal has un-checkpointed rows:

| Condition                                            | Threshold             |
| ---------------------------------------------------- | --------------------- |
| Idle — no updates for N seconds                      | 30–60 s               |
| Accumulated delta bytes                              | 2–8 MB                |
| Accumulated delta row count                          | 500–2 000 rows        |
| Safety interval — maximum time since last checkpoint | 10–30 min             |
| Room drains — last client disconnects                | immediate             |
| DO alarm fires                                       | periodic safety flush |

Thresholds are intentionally expressed as ranges; the implementation should
start at the conservative end (60 s idle, 8 MB, 2 000 rows, 30 min) and move
inward as telemetry justifies it.

### Checkpoint operation

1. Call `Y.encodeStateAsUpdate(yDoc)` to capture the full current state.
2. Write the resulting binary blob to R2 at the canonical key
   (`font-assets/{assetId}/current.yjs`), **overwriting** the previous object
   in place. No new R2 key is created; there is no accumulation of distinct
   snapshot objects.
3. Record the highest journal sequence number included in this checkpoint.
4. Prune all `room_log` rows up to and including that sequence number.
5. Optionally retain the previous R2 object version briefly (R2 versioning or
   a shadow key) for a single-rollback safety window, then delete it.

### Cold-start recovery

On DO wake-up with no in-memory state:

1. Fetch the canonical R2 snapshot (`current.yjs`) and apply it to an empty
   Yjs document.
2. Replay any `room_log` rows with sequence number above the last checkpoint
   sequence.
3. Proceed normally — the reconstructed document is now the live state.

If the R2 snapshot is missing and journal rows are present, replay them from
scratch. If both are absent, the room is empty (first open).

### Snapshot retention

Only one canonical R2 object exists per asset room at any given time
(`current.yjs`). Named version snapshots (user-created checkpoints, session
boundaries, pre-op snapshots) are separate keys and are not pruned by
compaction.

### No accumulating checkpoint objects

The checkpoint rotation **must not** write to a new timestamped key on each
cycle. Writing `current-{timestamp}.yjs` on every checkpoint would accumulate
unbounded R2 objects. The canonical key is always overwritten in place.

### R2 lifecycle rules

- Named version keys (`versions/{id}.yjs`) are managed by explicit retention
  policy attached to each version record in D1.
- Temporary migration artifacts have a 7-day TTL enforced by an R2 lifecycle
  rule.
- The canonical `current.yjs` key has no TTL; it is deleted only when the
  asset is deleted.

### What is never stored in the journal

- Full document state. Only incremental binary deltas go into `room_log`.
- Metadata. `room_log` rows are pure binary payloads plus a sequence counter
  and timestamp.

---

## Snapshot And Recovery Model

The semantic model remains the same:

- named versions;
- session boundaries;
- restore is a forward operation;
- per-glyph recovery matters;
- searchable history lives outside the binary room state.

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

- small glyph or layer restore: `live-delta` or `staged-commit`
- large or whole-font restore: `rebase`

---

## DO Runtime Policy

The Cloudflare Durable Object runtime is the active production direction.

Initial operating policy:

- keep one DO per asset;
- measure open time, reconnect time, update size, and persistence cost before
  changing the runtime again;
- classify suspicious rooms by observed pressure, not by guessed hard caps;
- move canonical large payloads to R2 so DO storage is not treated as the
  long-term blob layer;
- keep external execution available only for footprint-heavy mutations if later
  needed.

---

## Evolution From The Current Implementation

Phase 1 shipped on the current Durable Object path. The next task is to evolve
that implementation, not replace the runtime prematurely.

### State that still needs work

- asset-sized serialized JSON chunked across SQLite blobs;
- missing canonical R2 bootstrap and snapshot path;
- missing runtime telemetry and pressure-based operational policy;
- missing transport escalation for very large committed mutations.

### Near-term target

- live room runtime stays on Durable Objects;
- canonical bootstrap and snapshot blobs move to R2;
- D1 metadata remains authoritative for ACLs, assets, and history rows;
- legacy chunked SQLite data is retired once R2 bootstrap is in place;
- external execution remains optional and scope-limited.

---

## Actionable Checklist

This is the forward plan from the current state.

### Completed so far

- [x] Cloud filesystem plugin in the editor.
- [x] Eligibility gating and admin overrides.
- [x] D1-backed asset and folder CRUD.
- [x] ACL-backed room-token issuance.
- [x] Live WebSocket room runtime on Cloudflare Durable Objects.
- [x] Local auth bootstrap helper for collaboration development.
- [x] Local end-to-end collaboration workflow and smoke coverage.
- [x] URL-based reopen of cloud assets by asset ID.

### Phase 2 — Stabilize And Instrument The DO Path

- [ ] Freeze all new work that increases reliance on chunked SQLite blobs.
- [ ] Document the exact legacy blob format and current asset bootstrap path.
- [ ] Add runtime telemetry for room open time, reconnect time, payload size,
      and persistence cost.
- [ ] Add explicit operational guidance for suspiciously large rooms based on
      measured behavior, not undocumented limits.

### Phase 3 — Move Canonical Blobs To R2

- [ ] Define canonical R2 object keys for imported asset bootstrap blobs, full
      Yjs snapshots, babelfont snapshots, glyph snapshots, and rebases.
- [ ] Add migration code to read each asset's current chunked SQLite payload,
      reassemble it once, and write the canonical bootstrap blob to R2.
- [ ] Add D1 fields or metadata rows that point each asset to its canonical R2
      bootstrap object.
- [ ] Verify a migrated asset can open from R2 while the live room still runs in
      a Durable Object.
- [ ] Mark migrated assets so the legacy chunked blobs are no longer read.
- [ ] Add a one-way cleanup step for deleting obsolete chunked blobs after the
      migration is verified.

### Phase 4 — Introduce Mutation Routing

- [ ] Define a transaction classifier that runs on committed logical
      transactions, not low-level Yjs fragments.
- [ ] Record at least these classifier inputs: encoded delta bytes, glyph count
      touched, layer count touched, scope kind(s), requires full-font
      materialization, and projected fan-out size.
- [ ] Define thresholds for `live-delta`, `staged-commit`, and `rebase`.
- [ ] Implement staged commit transport.
- [ ] Implement rebase transport via R2 snapshot publication.
- [ ] Ensure routing decisions are independent of whether the change came from
      Python, restore, or any other feature.

### Phase 5 — Optional External Execution

- [ ] Add a batch executor path for large committed mutations.
- [ ] Route only footprint-heavy transactions there.
- [ ] Keep small scripts and other small mutations on the normal live path.
- [ ] Make the executor capable of producing `staged-commit` or `rebase`.

### Phase 6 — History And Recovery On The DO-Based Architecture

- [ ] Reconnect `font_asset_events` and `font_asset_versions` to the room
      runtime cleanly.
- [ ] Store full and glyph snapshots in R2.
- [ ] Implement per-glyph restore on top of the new storage layout.
- [ ] Implement whole-font restore as a routed large operation, usually a
      rebase.

---

## Local Development Gate

The project must maintain a working local collaboration workflow before moving
further into deployment changes.

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

### Phase 7 — Operational Hardening

- [ ] Measure room pressure and persistence cost continuously.
- [ ] Track room open time, snapshot duration, staged commit size, rebase size,
      and reconnect time.
- [ ] Add alarms for persistence failures, rebase failures, and room crash
      loops.

---

## Immediate Non-Goals

These are explicitly not required for the next step:

- switching the hot room runtime off Durable Objects before telemetry justifies
  it;
- broad glyph-sharding before the baseline room runtime is stable;
- feature-specific routing rules for Python;
- preserving the chunked SQLite layout as a supported steady state.

---

## Acceptance Criteria For The Revised v2

The revised v2 is complete when:

- assets open from canonical R2 bootstrap blobs, not chunked SQLite blobs;
- hot collaboration still runs through Cloudflare Durable Objects;
- small committed changes travel as normal live deltas;
- larger committed changes are automatically routed as staged commits or
  rebases based on mutation footprint;
- routing does not depend on whether the change came from Python;
- local personal undo still only undoes the user's own work;
- snapshots, versions, and history remain queryable from D1 + R2;
- one real asset survives reconnect, snapshot, and restore flows on the updated
  DO-based architecture.
