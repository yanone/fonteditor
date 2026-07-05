# R2 Direct Transfer — Moving Bootstrap and Seeding out of WebSocket

## Status

Proposed. Not yet implemented.

## Problem

All full-state font transfer between client and server goes through WebSocket
messages chunked at 750KB with base64 encoding (33% overhead). For a typical
3MB font Yjs state, the initial room connection requires 4 round-trips of
~1MB base64 strings, reassembled in order. This is slow, fragile (any lost
chunk invalidates the entire sync), and adds unnecessary complexity to both
client and server.

The R2 checkpoint already exists (and is now tombstone-free from the
compacted checkpoint implementation). The Worker already has the
`ROOM_STATE_BUCKET` R2 binding and already handles HTTP routes
(`/room/:roomId/status`, `/room/:roomId/log`, `/room/:roomId/control`).
The Durable Object already tracks the latest checkpoint manifest key and
SQLite `room_log` row IDs.

## Goal

Move bulk font state transfer (initial room connection and font seeding) to
authorized HTTP streaming to/from R2 via the Worker. The WebSocket stays for
live incremental editing, awareness, acks, and small post-checkpoint diffs.

Initial-sync chunking should become unnecessary after the R2 bootstrap path is
active. Live-update chunking should stay as a defensive fallback until telemetry
proves large live transactions cannot exceed Worker WebSocket frame limits.

## Architecture

```
┌──────────┐       HTTP (binary stream)       ┌──────────┐      R2      ┌──────────┐
│  Client  │ ←────────────────────────────────→│  Worker  │ ←──────────→ │   R2     │
│ (browser)│                                  │ (index.js)│              │ (bucket) │
└────┬─────┘                                  └─────┬──────┘              └──────────┘
     │                                              │
     │     WebSocket (incremental diffs only)       │ stub.fetch()
     │                                              ▼
     │                                       ┌──────────┐    SQLite    ┌──────────┐
     └────────────────────────────────────────│ FontRoomDO│ ←──────────→ │ room_log │
                                             └──────────┘              └──────────┘
```

### Why Worker-mediated (not presigned URLs)

Cloudflare R2 doesn't have native presigned URLs (the S3-compatible API
requires access keys the client shouldn't have). The Worker is the right
proxy:

- It already has the `ROOM_STATE_BUCKET` R2 binding
- The room-token verifier can be shared with the Durable Object, so the Worker
  can authorize each HTTP transfer before touching R2
- It already handles CORS for editor origins
- `R2.get()` returns a `ReadableStream` — the Worker streams it directly
  to the response without buffering
- `R2.put()` accepts a `ReadableStream` — the Worker streams the request
  body directly to R2

No presigned URLs, no S3 API, no new infrastructure. Just two new external
routes on the existing Worker, plus internal DO routes that are not reachable
from external HTTP clients.

## Authorization model

The new HTTP transfer routes must be at least as strict as the WebSocket auth
path. They expose full room state, so they cannot rely on CORS alone and cannot
stream from R2 before authorization succeeds.

1. Move the room-token verification helpers into a shared module imported by
   both `index.js` and `font-room-do.js`.
2. Every `GET /room/:roomId/state` and `POST /room/:roomId/state` request must
   require `Authorization: Bearer <room-token>`.
3. The Worker verifies the token signature, issuer, audience, expiry, schema
   expectations, and local-development fallback rules using the same logic as
   WebSocket auth.
4. The Worker rejects the request unless `payload.assetId === roomId`.
5. `GET /state` is allowed for roles that may read the room: owner, editor, and
   viewer.
6. `POST /state` is allowed only for roles that may write the room: owner and
   editor. Viewer tokens must receive `403 Forbidden`.
7. If the token includes an access epoch, the DO must verify that it is current
   before returning a manifest or applying a seed. Stale tokens must receive
   `401 Unauthorized` or `403 Forbidden`, matching the WebSocket close reason.
8. The Worker must not accept `r2Key`, `checkpointKey`, or `checkpointLogId`
   values from the client. Those values come only from the DO's internal
   manifest response or from Worker-generated seed keys.
9. HTTP responses must avoid leaking room existence before auth. Invalid or
   expired tokens return `401`; valid tokens for another room return `403`.
10. CORS remains an additional browser boundary for allowed editor origins, not
    the authorization mechanism.

## New HTTP routes

### `GET /room/:roomId/state` — download current font state

Streams the latest compacted checkpoint from R2 as raw binary.

```
Client                              Worker (index.js)
  │                                    │
  ├─ GET /room/:roomId/state ─────────►│
  │  Authorization: Bearer <token>     │
  │                                    │ verify room token + read role
  │                                    │ stub.fetch("/room/:roomId/internal/manifest")
  │                                    │   → DO verifies epoch and returns
  │                                    │     checkpoint key, logId, history key
  │                                    │ R2.get(checkpointKey) → ReadableStream
  │◄────────── binary stream ──────────│
  │  X-Checkpoint-Log-Id: 42           │
  │  Content-Type: application/octet   │
  │                                    │
  │  Y.applyUpdate(bridge.yDoc, body)  │
```

The Worker authorizes the request, asks the DO for the latest checkpoint
manifest, then streams the checkpoint object from R2 directly. The response
includes an `X-Checkpoint-Log-Id` header so the client can tell the server
"I already have everything up to logId 42" in the subsequent WebSocket sync.
The manifest response also identifies the mutation-history object associated
with that checkpoint for Worker-side/DO-side use only. The Worker must not
expose R2 object keys to the client. Keep `GET /state` as a pure binary
checkpoint stream; deliver the checkpoint mutation-history metadata in the
following WebSocket `sync-response` alongside the post-checkpoint replay
metadata. This avoids a second HTTP round-trip, uses the existing sync metadata
frame, and keeps the binary checkpoint response simple to pipe through.

If no checkpoint exists (brand new room), returns `404 Not Found`. The
client falls back to the WebSocket-only flow.

If R2 is unavailable, returns `503 Service Unavailable`. The client
falls back to the WebSocket-only flow. Graceful degradation.

### `POST /room/:roomId/state` — seed a new font into an empty room

Uploads the full Yjs state as a binary POST body. The Worker writes it
to R2, then notifies the DO to apply it.

```
Client                              Worker (index.js)
  │                                    │
  ├─ POST /room/:roomId/state ───────►│
  │  Authorization: Bearer <token>     │
  │  Content-Type: application/octet   │
  │  Body: binary Yjs state            │
  │                                    │ verify room token + write role
  │                                    │ R2.put(worker-generated seed key, body)
  │                                    │ stub.fetch("/room/:roomId/internal/apply-seed")
  │                                    │   DO reads seed from R2
  │                                    │   DO: Y.applyUpdate(this.yDoc, seed)
  │                                    │   DO: persist to SQLite + checkpoint
  │◄─ 200 OK ──────────────────────────│
  │                                    │
  │  room now has state                │
```

The Worker generates a seed object key under a room-scoped temporary prefix.
The client never chooses this key. The DO validates the room is empty and the
request was internally authorized before reading the seed object. If the room
already has state, the DO rejects the seed with `409 Conflict`. The Worker
deletes the temporary seed object after success or failure.

### Internal DO routes

The Worker calls the DO via `stub.fetch` with room-scoped internal paths:

- **`GET /room/:roomId/internal/manifest`** — returns the current checkpoint
  object key, mutation-history object key, checkpoint log ID, and current
  access epoch as JSON. Lightweight — reads the current manifest and validates
  the room/access epoch before returning any R2 key.

- **`POST /room/:roomId/internal/apply-seed`** — DO reads a Worker-generated
  seed key from an internal header or JSON body, applies it to `this.yDoc`,
  persists to SQLite `room_log`, and triggers a checkpoint. Returns `200` on
  success, `409` if room already has state.

These routes must reject normal external requests. Use an internal marker that
only the Worker sets when calling the Durable Object stub, and do not expose
the route through the public Worker router. The DO should still validate the
room ID, requested operation, and access epoch because it is the authority for
room state.

## Modified WebSocket flow

After the HTTP bootstrap, the WebSocket sync becomes trivially small:

```
Client                              Durable Object
  │                                    │
  │  (already downloaded R2 state)     │
  │  bridge.yDoc has checkpoint state  │
  │                                    │
  ├─ WebSocket connect + auth ────────►│
  │◄─ auth-ok ─────────────────────────┤
  │                                    │
  ├─ sync-request ────────────────────►│
  │  { stateVector, checkpointLogId: 42 }│
  │                                    │ replay SQLite room_log
  │                                    │   WHERE id > 42
  │◄─ sync-response ───────────────────┤
  │  { update: <small diff, <100KB> }  │
  │                                    │
  ├─ sync-complete ───────────────────►│
  │  { update: <client's local changes> }│
  │◄─ ack ─────────────────────────────┤
  │                                    │
  │  (live editing begins)             │
```

The `sync-request` now includes `checkpointLogId`. The server reconstructs the
post-checkpoint update from SQLite `room_log` rows with `id > checkpointLogId`
— typically 0 to a few hundred KB. Initial-sync chunking should not be needed
for this path. If the post-checkpoint replay unexpectedly exceeds the WebSocket
frame budget, keep the existing chunked sync fallback until production
telemetry proves it can be removed safely.

If `checkpointLogId` is absent (client didn't use HTTP bootstrap), the
server falls back to the current `Y.encodeStateAsUpdate(this.yDoc,
clientSV)` diff computation. Backward compatible.

## Client flow changes (`CloudAdapter`)

### Connect to existing room

```
 1. fetch(httpRoomUrl + '/state', { headers: { Authorization: token } })
 2. if 200: Y.applyUpdate(bridge.yDoc, await response.arrayBuffer())
          checkpointLogId = response.headers.get('X-Checkpoint-Log-Id')
 3. open WebSocket to wsRoomUrl
 4. send sync-request { stateVector, checkpointLogId }
 5. receive sync-response (small diff + checkpoint mutation-history metadata)
 6. send sync-complete (small diff)
 7. live editing begins
```

### Seed new font

```
1. open WebSocket to roomUrl
2. receive auth-ok { seedRequired: true }
3. fetch(httpRoomUrl + '/state', { method: 'POST', body: bridgeState, headers: { Authorization: token } })
4. if 200: room now has state
5. send sync-request { stateVector, checkpointLogId: <from POST response> }
6. receive sync-response (empty or tiny diff)
7. send sync-complete (empty or tiny diff)
8. live editing begins
```

### Reconnect after disconnect

Same as "connect to existing room." Download the latest checkpoint from
R2, then WebSocket for the diff. The diff might be larger if the client
was disconnected for a while, but it's still much smaller than the full
state and unlikely to hit the chunk threshold.

## What gets deleted

### From `cloud-adapter.ts` (client)

- `sync-response` chunk reassembly for the R2-bootstrap path
- Chunked `sync-complete` sender logic for initial bootstrap once seeding uses
  HTTP and checkpoint replay is validated
- Any dedicated initial-sync accumulator that is no longer used after the
  fallback window expires

### From `font-room-do.js` (server)

- `sync-chunk` outbound sender in `_handleSyncRequest` for checkpoint-backed
  initial sync
- Initial-sync chunk upload handling once HTTP seeding has replaced chunked
  `sync-complete`

Do not delete live `update-chunk` support in this project phase. It protects
against unusually large live transactions and uses the same frame-size safety
constraint as initial sync.

## What stays

- **WebSocket**: live incremental edits (200-800 bytes each), awareness,
  acks, and chunked live-update fallback
- **SQLite `room_log`**: durability for incremental updates
- **R2 checkpoints**: periodic snapshots (now compacted/tombstone-free)
- **`sync-request`/`response`/`complete` protocol**: simplified (no
  chunking on the checkpoint-backed happy path), still used for the small diff
  after HTTP bootstrap
- **Durable Object**: manages room state, WebSocket connections,
  checkpointing

## Edge cases

1. **Brand new room (no checkpoint)**: `GET /state` returns 404. Client
   skips HTTP download, opens WebSocket with empty state vector. Server
   sends full state via `sync-response` — but this path is rare (only
   the very first connection to a new room) and the state is small
   (empty font or minimal seed).

2. **Stale checkpoint**: Client downloads checkpoint at logId 42, but
   server is at logId 50. The WebSocket `sync-request` with
   `checkpointLogId: 42` causes the server to replay rows 43-50 from
   SQLite. Small diff, no chunking.

3. **R2 read failure**: If R2 is unavailable, `GET /state` returns 503.
   Client falls back to the WebSocket-only flow (which still works).
   Graceful degradation.

4. **Concurrent seed**: `POST /state` to a room that already has state
   returns 409 Conflict. The DO checks
   `this.yDoc.getMap("font").size > 0` and rejects the seed.

5. **Auth**: Both HTTP routes verify the same room JWT as the WebSocket. The
   verifier must be shared between Worker and DO code. The Worker checks token
   signature, expiry, room match, and role before any R2 access; the DO checks
   room state and access epoch before returning keys or applying seeds.

6. **CORS**: The Worker already handles CORS for editor origins. The
   new routes use the same `corsResponse` wrapper.

7. **Client has no local state (fresh browser session)**: The client's
   bridge is empty. `GET /state` downloads the full checkpoint. The
   WebSocket sync-request has `checkpointLogId` = the downloaded
   checkpoint's logId. The diff is whatever changed since the
   checkpoint. Normal flow.

8. **Client has local state but room is empty**: The client POSTs its
   local state to seed the room. If another client seeded first, the
   POST returns 409. The client then downloads the room's state via
   `GET /state` and proceeds normally.

9. **Viewer attempts to seed**: `POST /state` with a viewer token returns
   `403 Forbidden`. The Worker must not write a seed object to R2.

10. **Wrong-room token**: A token for room A used against room B returns
    `403 Forbidden`. The response must not include checkpoint metadata or R2
    object keys.

11. **Stale access epoch**: A token issued before access was revoked cannot
    download or seed state. The DO validates the epoch before returning a
    manifest or applying a seed.

12. **Mutation-history reconciliation**: A client that bootstraps from R2 must
    receive or reconstruct the collaboration message history up to the
    checkpoint, then receive post-checkpoint history from `room_log` replay.
    Otherwise pending durable collaboration messages may not reconcile cleanly.

## Benefits

1. **Speed**: HTTP streaming is faster than WebSocket chunking (no
   base64, no chunk reassembly, no sequential round-trips). A 3MB font
   downloads as a single binary stream in one request.

2. **Reliability**: HTTP is more resilient to network issues than
   WebSocket for large transfers (TCP retry, range requests, no
   message-ordering fragility).

3. **Simplicity**: Removes the large-state `sync-chunk` / `sync-response`
   machinery from the initial connection path. Live-update chunking remains as
   a narrow safety fallback.

4. **R2 efficiency**: The checkpoint is already in R2 (from the
   compacted checkpoint implementation) — the Worker just streams it
   through. No additional computation.

5. **Scalability**: R2 reads are cheap and fast; the Durable Object
   doesn't need to be warm to serve the initial state. The DO only
   handles the lightweight manifest lookup and the small diff replay.

6. **Worker CPU**: Streaming from R2 through the Worker uses negligible
   CPU (pipe a `ReadableStream` to the response). The Worker doesn't
   buffer the data.

## Implementation phases

### Phase 1 — Server security foundation

- Move room-token verification into a shared module used by both Worker and DO
- Worker validates token signature, expiry, room match, and role before R2
  access
- DO internal routes validate room ID and current access epoch before returning
  keys or applying seeds
- Add authorization tests for missing token, expired token, wrong-room token,
  viewer seed attempt, and stale access epoch

### Phase 2 — Server: checkpoint replay by `checkpointLogId`

- DO: if `sync-request` includes `checkpointLogId`, replay SQLite `room_log`
  rows with `id > checkpointLogId` instead of computing a full diff with
  `Y.encodeStateAsUpdate(this.yDoc, clientSV)`
- Include post-checkpoint collaboration-message history from replayed rows
- Fall back to current behavior if `checkpointLogId` is absent
- Keep chunked sync fallback for unexpectedly large replay responses until
  telemetry shows it is unnecessary
- Test: verify diff is minimal after a simulated checkpoint bootstrap

### Phase 3 — Server: `GET /room/:roomId/state`

- Add the route to `index.js`
- Add `GET /room/:roomId/internal/manifest` to the DO (returns checkpoint key,
  mutation-history key, checkpoint log ID, and access epoch)
- Worker reads R2 checkpoint and streams binary
- Include `X-Checkpoint-Log-Id` header
- Keep the response body as raw checkpoint bytes only; do not mix JSON metadata
  into the HTTP stream
- Preserve mutation-history reconciliation by sending checkpoint history in the
  following WebSocket `sync-response`
- Handle 404 (no checkpoint) and 503 (R2 failure)
- Test: authorized `curl -H "Authorization: ..." /room/test-room/state > font.yjs`
- Test: unauthenticated and wrong-room requests do not reveal state or R2 keys

### Phase 4 — Server: `POST /room/:roomId/state`

- Add the route to `index.js`
- Add `POST /room/:roomId/internal/apply-seed` to the DO (reads from R2,
  applies, persists, checkpoints)
- Worker streams request body to R2, then calls DO
- Worker generates the seed R2 key and deletes the temporary seed object after
  success or failure
- Handle 409 (room already has state)
- Test: authorized editor/owner seed succeeds only for an empty room
- Test: viewer, wrong-room, expired, and stale-epoch tokens cannot seed

### Phase 5 — Client: HTTP bootstrap before WebSocket

- `CloudAdapter`: before opening WebSocket, `fetch('/state')`
- If 200: apply state to bridge, capture `checkpointLogId`
- Defer checkpoint mutation-history reconciliation until the following
  WebSocket `sync-response`
- If 404: skip (room is empty)
- If 503: fall back to WebSocket-only flow
- Open WebSocket with `checkpointLogId` in `sync-request`
- Test: connect to existing room, verify fast connection

### Phase 6 — Client: HTTP seed for new rooms

- `CloudAdapter`: when `seedRequired: true`, `POST /state` with bridge
  state
- Handle 409 (another client seeded first) — download the room's state
  via `GET /state`
- Test: seed a new room, verify room has state

### Phase 7 — Remove initial-sync chunking after telemetry

- Remove initial-sync `sync-chunk` handlers and accumulators only after HTTP
  bootstrap and HTTP seed have been stable in tests
- Keep live `update-chunk` support unless a separate transport decision removes
  it safely
- Test: verify all bootstrap, seed, reconnect, and live-update flows still work

### Phase 8 — Hardening

- Test concurrent connections (multiple clients bootstrapping
  simultaneously)
- Test reconnect after long disconnect (large SQLite diff replay)
- Test R2 failure fallback
- Test concurrent seed (two clients seeding simultaneously)
- Test auth token expiry during HTTP transfer
- Test unauthorized clients cannot infer whether a room has a checkpoint
- Test temporary seed object cleanup on DO rejection and R2 failure
- Load test: measure connection time for 1MB, 5MB, 10MB fonts

## Key file references

| Concern                 | File                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------- |
| Worker HTTP routes      | `collab/collab/src/index.js`                                                           |
| DO internal routes      | `collab/collab/src/font-room-do.js` (`fetch` handler, 1277)                            |
| DO checkpoint manifest  | `collab/collab/src/font-room-do.js` (`_getCurrentManifestKey`, `_lastCheckpointLogId`) |
| DO SQLite room_log      | `collab/collab/src/font-room-do.js` (`_readRoomLogRows`, `_applyRowsToDoc`)            |
| Client sync flow        | `webapp/js/cloud-adapter.ts` (`_handleMessage`, sync-request/response/chunk handlers)  |
| Client chunk sending    | `webapp/js/cloud-adapter.ts` (`sendSyncComplete`, `SYNC_CHUNK_SIZE`)                   |
| R2 binding              | `collab/collab/wrangler.toml` (`ROOM_STATE_BUCKET`)                                    |
| Auth token verification | `collab/collab/src/font-room-do.js` (`verifyRoomToken`, to move into shared module)    |
| CORS handling           | `collab/collab/src/index.js` (`corsResponse`, `corsPreflightResponse`)                 |

## Out of scope

- Presigned R2 URLs (not needed — Worker mediation is simpler)
- S3-compatible API access from the client (security risk)
- Removing chunking for live incremental edits (`update-chunk`) without a
  separate risk analysis and telemetry
- Changing the SQLite room_log format (already works for diff replay)
- Changing the checkpoint format (already compacted/tombstone-free)
