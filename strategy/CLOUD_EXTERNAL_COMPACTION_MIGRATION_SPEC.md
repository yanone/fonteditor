# Cloud External Compaction Migration Spec

## Status

Proposed.

This spec defines the migration from Durable Object-owned full-state
checkpointing to an R2 baseline plus durable tail model with external
compaction. It supersedes any cloud collaboration design that requires the room
Durable Object to read, hydrate, compact, or checkpoint a full font state.

## Problem Statement

The current HTTP seed path streams the uploaded font state into R2, then asks
the room Durable Object to read that full seed object back, apply it to a
server-side `Y.Doc`, journal it, and checkpoint it. This still makes the room DO
hold the complete asset and can exceed the Cloudflare 128 MB isolate memory
limit for realistic font states.

The current checkpoint path has the same structural problem. A DO-generated
checkpoint requires a full in-memory `Y.Doc`, at least one encoded full-state
snapshot, and a second compacting `Y.Doc`. This makes DO memory scale with font
size and edit history, which is not acceptable for paid cloud collaboration.

The target architecture must preserve acknowledged edit durability even if the
only connected browser disappears. Browser-uploaded snapshots may never be the
only durable copy of recent work.

## Product Principles

1. HTTP/R2 is the only full-state bootstrap and baseline transport.
2. WebSocket is only for live incremental collaboration and bounded replay.
3. Acknowledged live edits must be durable before the client receives a durable
   ack.
4. The room DO must not hold the complete asset in memory.
5. Full-state compaction must run outside the room DO hot path.
6. Browser bandwidth must not be required for checkpoint compaction.
7. Compaction improves startup cost and tail size, but is not part of edit
   durability.
8. Every baseline promotion must be compare-and-swap guarded and stale-safe.
9. Operational room health must be visible in the website dashboard before this
   system is considered production-ready.

## Target Architecture

```
Editor Browser ── HTTP binary baseline ──► Worker ── stream ──► R2
      │                                      │                  ▲
      │                                      │ manifest/tail    │
      │                                      ▼                  │
      └──── WebSocket live updates ───► FontRoomDO ◄──── External Compactor
                                             │
                                             ▼
                                      SQLite durable tail
```

### R2 responsibilities

R2 stores immutable full-state artifacts:

1. Initial baseline snapshots.
2. Compacted baseline snapshots.
3. Current manifest pointer.
4. Candidate manifests written by the compactor.
5. Optional mutation-history sidecars for diagnostics and history UI support.
6. Temporary upload or compaction artifacts awaiting promotion or cleanup.

### Durable Object responsibilities

The room DO stores and coordinates only bounded state:

1. Room metadata and access epoch.
2. Active baseline manifest metadata.
3. Durable incremental tail rows after the active baseline.
4. Connected WebSocket clients and verified role attachments.
5. In-flight live update chunk buffers with strict byte limits and TTL.
6. Replay cursors and small replay batches.
7. Compaction request and promotion metadata.
8. Runtime health counters for the website dashboard.

The room DO must not:

1. Read an R2 baseline object body.
2. Call `arrayBuffer()` on seed, baseline, or checkpoint objects.
3. Apply a full baseline to a long-lived server-side `Y.Doc`.
4. Generate full-state checkpoints.
5. Require full-state Yjs hydration to answer a normal room join.
6. Treat browser checkpoint uploads as authoritative durability.

### External compactor responsibilities

The external compactor is a service operated by us. It may run as a scheduled
process, queue consumer, or containerized worker, but it must run outside the
room DO. It is allowed to use memory proportional to the full font state.

The compactor:

1. Finds rooms whose durable tail exceeds compaction thresholds.
2. Fetches the active baseline from R2.
3. Fetches durable tail rows after the active baseline boundary.
4. Reconstructs a `Y.Doc` outside the DO.
5. Reuses the current compacting algorithm as closely as possible.
6. Writes a candidate compacted baseline and sidecars to R2.
7. Requests atomic promotion from the DO.
8. Cleans up stale candidate artifacts after failed or superseded attempts.

## Source Of Truth Model

For each room, the authoritative recoverable state is:

```
active R2 baseline manifest + durable room_log rows with id > checkpointLogId
```

The active manifest identifies the latest compacted baseline and the log id
through which that baseline is complete. All acknowledged edits after that
boundary must exist as durable tail rows until a later baseline promotion moves
the boundary forward.

## Manifest Contract

Keep the existing manifest layout wherever possible. The active manifest must
contain at least:

1. `assetId`
2. `roomVersion` or manifest generation
3. `checkpointAt`
4. `checkpointLogId`
5. `checkpointObjectKey`
6. optional `mutationHistoryObjectKey`
7. `snapshotBytes`
8. `snapshotSha256`
9. `schemaVersion`
10. `createdBy`: `initial-seed` or `external-compactor`

The current manifest pointer remains the public room baseline pointer. Candidate
manifests are written under non-current keys and become visible only after DO
promotion succeeds.

## Initial Seed Migration

### Current behavior to remove

The current seed path writes the uploaded seed to R2, then asks the DO to read
and apply it. That behavior is forbidden after this migration.

### New behavior

1. The editor uploads the initial bridge state through HTTP.
2. The Worker streams the request body into a temporary R2 object.
3. The Worker computes or verifies size and SHA-256 for the uploaded object.
4. The Worker writes a candidate baseline object under a room-scoped immutable
   key, or promotes the temporary object into that layout.
5. The Worker calls the DO internal `adopt-baseline` route with metadata only.
6. The DO verifies the room is pending/empty and the object metadata is valid.
7. The DO stores the manifest pointer and initializes the baseline boundary.
8. The DO returns success without reading the object body.
9. The website finalizes the asset only after baseline adoption succeeds.

### Required internal route

`POST /room/:roomId/internal/adopt-baseline`

Input:

1. `checkpointObjectKey`
2. `snapshotBytes`
3. `snapshotSha256`
4. `schemaVersion`
5. `checkpointAt`
6. `createdBy: "initial-seed"`
7. token role and access epoch headers already used by internal routes

Rules:

1. Reject if the room already has an active baseline or durable tail.
2. Reject stale access epochs.
3. Reject keys outside the room-owned R2 prefix.
4. Commit the manifest pointer inside the same logical room-state update that
   marks the room seeded.
5. Do not apply, validate, merge, diff, or checkpoint the full Yjs update in the
   DO.

## Room Open And Join Flow

1. The editor obtains a room token.
2. The editor downloads `GET /room/:roomId/state` over HTTP.
3. The Worker asks the DO for the active manifest metadata.
4. The Worker streams the R2 baseline body to the editor.
5. The editor applies the baseline locally.
6. The editor opens the WebSocket.
7. The editor sends `sync-request` with:
   - local state vector
   - `checkpointLogId` from the baseline response
   - optional manifest generation/hash for diagnostics
8. The DO replays durable tail rows with `id > checkpointLogId`.
9. The editor applies the replayed tail and enters live collaboration.

The first implementation should prefer log-boundary replay over server-side
full-doc diffing. Tail replay can be chunked if it exceeds the live message
budget, but it remains incremental tail replay, not full-state bootstrap.

## Live Update Durability

The live update path remains close to the current implementation but treats Yjs
updates as opaque durable packets.

On each writable live update:

1. Verify role and room attachment.
2. Enforce message and chunk limits.
3. Validate the Yjs update bytes if validation remains memory-bounded for live
   packets.
4. Write the update to `room_log` before acking durable success.
5. Update room counters:
   - `last_log_id`
   - `last_write_at`
   - `dirty_row_count`
   - `dirty_byte_count`
   - `oldest_uncheckpointed_log_id`
   - `oldest_uncheckpointed_at`
6. Broadcast the same update to connected peers.

The DO must not apply the update to a full server-side document only for the
sake of checkpointing.

## External Compactor

### Trigger policy

The compactor should initially use thresholds close to the current DO
checkpoint cadence:

1. Dirty tail row count exceeds the current checkpoint row threshold.
2. Dirty tail byte count exceeds the current checkpoint byte threshold.
3. Oldest uncheckpointed edit exceeds a maximum age.
4. Room has been idle for a short quiet period after recent writes.
5. Manual dashboard action requests compaction for a room.

The first version may run a scheduled scan every few minutes. A later version
may add a queue when the DO crosses thresholds.

### Worker model

For fast delivery, run one compaction process with bounded concurrency:

1. Start with one room at a time.
2. Increase concurrency only after production memory and CPU telemetry is known.
3. Use a per-room compaction lease so two compactor processes cannot compact the
   same room concurrently.
4. Use process memory limits high enough for real font sizes, initially 1-2 GB.

### Compaction algorithm

The compactor should model speed and output closely after today’s
`_checkpointToR2()` behavior:

1. Download active baseline bytes from R2.
2. Create `liveDoc = new Y.Doc()`.
3. Apply baseline to `liveDoc`.
4. Fetch durable tail rows with ids greater than the manifest checkpoint id.
5. Reassemble multi-row update chunks exactly as the DO replay path does.
6. Apply tail updates to `liveDoc` in durable order.
7. Encode `liveSnapshot = Y.encodeStateAsUpdate(liveDoc)`.
8. Create `compactedDoc = new Y.Doc({ gc: true })`.
9. Apply `liveSnapshot` to `compactedDoc`.
10. Encode `compactedSnapshot = Y.encodeStateAsUpdate(compactedDoc)`.
11. Write `compactedSnapshot` to R2 under a candidate key.
12. Write mutation-history sidecar if still required.
13. Build candidate manifest with the same hashing rules as today.
14. Request DO promotion.
15. Destroy both docs and release memory.

The compactor may later optimize with Yjs binary update APIs, but the first
version should prioritize behavioral equivalence with the current checkpoint
output.

### Tail export contract

The compactor needs an authenticated way to fetch tail rows. Use either a new
internal admin endpoint on the room Worker/DO or a service-only route.

`GET /room/:roomId/internal/tail-export?afterLogId=...&limit=...`

Rules:

1. Service authentication required.
2. External browsers cannot call this route.
3. Response is chunked or paginated.
4. Raw update bytes may be returned only to the service principal.
5. Export preserves update ordering and chunk grouping.
6. Export includes enough metadata to set the new checkpoint boundary.

### Promotion contract

`POST /room/:roomId/internal/promote-compaction`

Input:

1. `parentManifestGeneration`
2. `parentCheckpointLogId`
3. `newCheckpointLogId`
4. `checkpointObjectKey`
5. `snapshotBytes`
6. `snapshotSha256`
7. optional `mutationHistoryObjectKey`
8. compaction runtime metrics

Rules:

1. Reject unless service authenticated.
2. Reject unless the active manifest still matches the parent generation.
3. Reject unless the active checkpoint log id still matches the parent id.
4. Reject unless `newCheckpointLogId <= last_log_id`.
5. Reject keys outside the room-owned candidate/checkpoint prefixes.
6. Promote the new manifest atomically.
7. Delete or mark tail rows `<= newCheckpointLogId` only after promotion.
8. If cleanup fails, keep correctness and retry cleanup later.

## DO Memory-Efficiency Requirements

The DO must be explicitly memory-bounded. These are implementation rules, not
guidelines:

1. Baseline bytes must never be loaded into DO memory.
2. Snapshot R2 objects must never be passed through DO memory.
3. The DO must not retain a long-lived room `Y.Doc` for normal operation.
4. Replay to joiners must be batched with maximum bytes per batch.
5. Chunk accumulators must have per-client and per-room byte caps.
6. Chunk accumulators must expire on timeout, disconnect, auth failure, or
   protocol error.
7. Room status endpoints must not serialize raw update blobs by default.
8. Tail export must page data so a single response cannot exceed memory budget.
9. Cleanup must be incremental and retryable.

The expected resident memory per room should scale with:

1. number of connected clients
2. bounded in-flight chunk buffers
3. bounded replay/export page size
4. metadata and counters

It must not scale with:

1. full font size
2. total edit history
3. previous checkpoint size
4. number of historical baseline objects

## Website Dashboard Section

Add a website dashboard section for cloud room operations. This section is for
administrators/operators, not normal font users.

### Navigation

Add a Cloud Operations section with at least one page:

1. `Room Health`

Future pages may include storage cost, failed bootstrap cleanup, and audit logs,
but they are not required for the first migration.

### Summary cards

Room Health must show:

1. Total cloud assets.
2. Total active room baselines.
3. Rooms with connected clients.
4. Rooms with dirty uncheckpointed tail.
5. Rooms over compaction thresholds.
6. Oldest uncheckpointed edit age.
7. Largest dirty tail by bytes.
8. Largest dirty tail by row count.
9. Highest estimated DO room memory.
10. Recent DO reset or crash count, if available from logs/metrics.
11. Last successful compaction time.
12. Last failed compaction time.

### Room table

The dashboard table must include one row per room/asset with:

1. Asset id.
2. Asset name.
3. Owner user id or email.
4. Asset lifecycle state.
5. Active manifest generation.
6. Active checkpoint log id.
7. Last log id.
8. Dirty tail rows.
9. Dirty tail bytes.
10. Oldest uncheckpointed edit timestamp.
11. Oldest uncheckpointed edit age.
12. Last write timestamp.
13. Connected client count.
14. Viewer/editor/owner connection counts if available.
15. Estimated DO memory bytes.
16. Maximum observed live chunk bytes.
17. Maximum observed replay batch bytes.
18. Last compaction status.
19. Last compaction duration.
20. Last compaction input bytes.
21. Last compaction output bytes.
22. Last compaction error.
23. R2 baseline bytes.
24. Estimated recoverable state bytes: baseline bytes + dirty tail bytes.
25. Health state: ok, needs compaction, compaction stuck, bootstrap failed, or
    missing baseline.

### Memory metric definition

Cloudflare does not expose reliable per-room heap usage as a normal application
metric. The dashboard must therefore distinguish:

1. `estimatedRoomMemoryBytes`: application-estimated room memory pressure.
2. `observedRuntimeFailureCount`: resets/crashes observed through logs or room
   status events.
3. `maxOperationBytes`: largest single in-flight live chunk, replay batch, or
   export page observed by the DO.

`estimatedRoomMemoryBytes` should be calculated from bounded components the DO
can know:

1. connected client count times an estimated socket attachment budget
2. current in-flight chunk accumulator bytes
3. current replay/export page bytes
4. pending metadata/history JSON bytes
5. fixed per-room overhead constant

The dashboard label must make clear that this is an estimate, not Cloudflare
heap telemetry.

### Filtering and sorting

The dashboard must support sorting/filtering by:

1. dirty tail bytes descending
2. oldest uncheckpointed edit age descending
3. estimated memory descending
4. last compaction failure
5. active connected clients
6. lifecycle state
7. owner/user

### Operator actions

The first version should include these admin-only actions:

1. Request compaction for one room.
2. Clear stale compaction lease.
3. Retry failed cleanup for one room.
4. Copy room diagnostics JSON.

Dangerous actions, such as deleting room state or force-promoting a manifest,
must not be included in the first version.

### Dashboard API

Add website API endpoints that aggregate website DB state with collab room
status:

1. `GET /api/admin/cloud/rooms/health-summary`
2. `GET /api/admin/cloud/rooms`
3. `GET /api/admin/cloud/rooms/:assetId`
4. `POST /api/admin/cloud/rooms/:assetId/request-compaction`
5. `POST /api/admin/cloud/rooms/:assetId/retry-cleanup`

The website must authenticate these as admin/operator-only. The website should
call service-authenticated collab worker endpoints rather than exposing room
internal endpoints directly to the browser.

### Collab worker admin status endpoint

Expose a service-authenticated room status endpoint for the website aggregator:

`GET /room/:roomId/internal/health`

Response fields must include the room table metrics listed above, except for
website-only fields such as asset name and owner email.

## Migration Phases

### Phase 1: Spec and tests

- [ ] Add tests that fail if DO seed adoption reads R2 object bodies.
- [ ] Add tests that fail if room open requires DO full-doc hydration.
- [ ] Add tests that acknowledged live updates survive sole-client disconnect.
- [ ] Add tests for service-authenticated tail export and promotion contracts.
- [ ] Add dashboard API tests for summary metrics and admin authorization.

### Phase 2: Metadata-only seed adoption

- [ ] Replace `/internal/apply-seed` with `/internal/adopt-baseline` for HTTP
   seed.
- [ ] Keep old route only temporarily behind tests proving it is unused, then
   delete it.
- [ ] Store active manifest without hydrating seed bytes.
- [ ] Verify Save As finalization still waits for readable baseline state.

### Phase 3: Tail replay join path

- [ ] Make `sync-request.checkpointLogId` the normal post-baseline join path.
- [ ] Replay `room_log` rows after that log id without a full server `Y.Doc`.
- [ ] Batch replay responses by byte budget.
- [ ] Preserve mutation-history sidecars if still needed by the editor.

### Phase 4: Remove DO checkpoint ownership

- [ ] Disable checkpoint alarm scheduling.
- [ ] Remove calls to DO `_checkpointToR2()` from live updates and seed.
- [ ] Remove cold-load full baseline hydration from normal join handling.
- [ ] Keep only bounded metadata and tail state in the DO.

### Phase 5: External compactor service

- [ ] Add service authentication between compactor, website, and collab worker.
- [ ] Add tail export endpoint.
- [ ] Add promotion endpoint.
- [ ] Implement compactor using current Yjs compaction algorithm outside the DO.
- [ ] Run scheduled scans with one-room concurrency.
- [ ] Record compaction metrics back to room state.

### Phase 6: Dashboard

- [ ] Add admin-only website API aggregation endpoints.
- [ ] Add Cloud Operations > Room Health page.
- [ ] Show summary cards, sortable room table, and room detail diagnostics.
- [ ] Add request-compaction and retry-cleanup actions.
- [ ] Add tests for authorization and metric rendering.

### Phase 7: Cleanup and hardening

- [ ] Delete obsolete full-state DO seed/checkpoint paths.
- [ ] Add production alerts for rooms over thresholds, compaction failures, and DO
   resets.
- [ ] Add stale artifact cleanup for candidate baselines and failed seed objects.
- [ ] Load-test with large real font assets.

## Validation Requirements

The migration is complete only when all of these are true:

- [ ] A 15-50 MB initial seed succeeds without DO memory reset.
- [ ] DO seed adoption can be tested with an R2 object whose `arrayBuffer()` throws.
- [ ] A cold room open applies baseline from R2 and tail from DO without full DO
   hydration.
- [ ] A sole editor can disconnect after durable acks, and all acked edits are
   recoverable from baseline plus tail.
- [ ] The external compactor can promote a new baseline while edits continue.
- [ ] Stale compactor promotion attempts are rejected.
- [ ] Cleanup failure after promotion does not corrupt room recovery.
- [ ] The website dashboard shows room counts, oldest uncheckpointed edit, dirty
   tail sizes, estimated memory, and compaction status.
- [ ] Normal users cannot access dashboard APIs or internal room health endpoints.
- [ ] WebSocket full-state bootstrap remains forbidden for seed/open fallback.

## Explicit Non-Goals For First Delivery

1. Browser-generated compaction snapshots.
2. Browser checkpoint uploader election.
3. Multipart browser-to-R2 uploads for compaction.
4. Replacing DO SQLite tail with R2 segmented tail storage.
5. Multi-node compactor fleet.
6. User-facing restore or snapshot browser.
7. Exact Cloudflare per-room heap telemetry.

## Implementation Notes

1. This project is alpha; remove obsolete routes once the new tests prove they
   are unused.
2. Reuse current manifest and checkpoint hashing helpers where possible.
3. Keep the first compactor intentionally simple and serial.
4. Prefer correctness and bounded memory over clever diff minimization.
5. Dashboard memory must be labelled as estimated unless backed by real runtime
   heap telemetry.
6. The older R2 direct-transfer design allowed WebSocket fallback and DO seed
   application. Those parts are obsolete under this spec.