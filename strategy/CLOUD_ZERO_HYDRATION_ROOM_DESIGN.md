# Cloud Zero-Hydration Room Design

This document describes the current collaboration design problem, why the
recent auth-gate fix is only a partial mitigation, and a possible next
architecture in which the Durable Object room never hydrates a full Y.Doc in
memory.

This is a strategy document, not an implementation plan. The goal is to define
the boundary we actually want, the protocol consequences of that boundary, and
the tradeoffs we accept to get there.

## Problem

The current collaboration design still assumes that the room can act as a Yjs
state authority when needed.

That assumption is the real scalability limit.

Even after the auth-path fix that suppresses unnecessary background hydration
for checkpointed rooms, the room still contains code paths that may rebuild a
full Y.Doc in memory in order to:

- answer generic Yjs sync requests
- derive a server state vector
- replay state after hibernation wake
- recover uncheckpointed rooms
- handle some sync-complete and cold-start paths

As long as those paths exist, large rooms can still hit the Durable Object
memory ceiling.

The recent fix reduced memory pressure by avoiding an eager post-auth hydrate
for checkpointed rooms. It did not remove the underlying architectural hazard.

## What The Recent Fix Did

The worker now avoids scheduling background `_ensureDocLoaded()` immediately
after `auth-ok` when persisted checkpoint metadata already proves the room has
operational state.

That changes the checkpointed-room auth path from:

1. authenticate
2. send `auth-ok`
3. eagerly hydrate full room state in the background

to:

1. authenticate
2. send `auth-ok`
3. do not hydrate anything unless a later path actually requires it

This is correct and necessary. It prevents a checkpointed room from pulling a
15 MB+ snapshot into memory just because a client authenticated.

But an uncheckpointed room can still break the same memory barrier, and even a
checkpointed room can still do so if a later code path falls back to full
hydration.

## The Real Requirement

The real requirement is stronger than "avoid unnecessary hydration after
auth".

The room should not hydrate a Y.Doc at all.

That means the room must stop behaving like a document engine and instead act
as:

- an auth gate
- an ordered append log
- a fan-out transport
- a lightweight metadata holder

The external compactor should own checkpoint materialization.

If the room ever needs to reconstruct full authoritative document state in
memory, then document size still leaks back into room memory usage and the
ceiling remains file-size dependent.

## Current Sync Model

Today there are effectively two sync modes.

### 1. Checkpoint-tail sync

If the client first bootstraps from HTTP state and then sends a websocket
`sync-request` with `checkpointLogId`, the worker can answer with only the room
log rows after that checkpoint.

Semantically this means:

"I already have checkpoint N. Send me all updates after checkpoint N."

This path does not inherently require a hydrated server document to build the
outbound update payload.

### 2. Generic Yjs state-vector sync

If the client sends a `sync-request` that is interpreted as a general Yjs
question:

"Here is my state vector. Tell me exactly what I am missing."

then the server needs authoritative document state in order to compute the
exact diff.

In the current implementation that means:

- a hydrated Y.Doc
- `Y.encodeStateAsUpdate(this.yDoc, clientStateVector)`
- `Y.encodeStateVector(this.yDoc)`

That path is incompatible with a zero-hydration room.

## Why The Current Design Still Hits The Ceiling

The checkpoint fast path helps only when all of these are true:

- the client successfully bootstrapped from HTTP snapshot
- the client includes a valid `checkpointLogId`
- the server still has the required tail after that checkpoint
- no later path requires a generic Yjs server diff

The design still fails to scale when any of these break:

- a room is new and has no checkpoint yet
- a reconnect happens after compaction moved the basis forward
- a cold path still wants a generic state-vector answer
- hibernation wake reconstructs the whole room in memory
- sync-complete or follow-up logic assumes a live room-side doc exists

This means file-size pressure has not been eliminated. It has only been moved
off one hot path.

## Design Goal

Room memory usage must not scale with font size.

Room memory should scale only with:

- connected peer count
- in-flight message buffering
- uncheckpointed tail length
- retained metadata

Document size must be paid for in persisted storage and client bootstrap, not
in the live DO process.

## Proposed Direction

The room becomes a zero-hydration append-and-broadcast service.

### Responsibilities the room keeps

- authenticate clients
- validate room/token/schema metadata
- assign ordering and durable ids to inbound updates
- append opaque Yjs update payloads to durable log storage
- broadcast committed updates to connected peers
- expose lightweight room metadata
- expose checkpoint pointers and retained-tail boundaries

### Responsibilities the room gives up

- reconstructing full Y.Doc state in memory
- answering generic state-vector diff requests
- generating snapshots
- acting as the canonical source of full document state
- preserving infinite undo history across reconnects

### Responsibilities moved outside the room

- checkpoint creation
- snapshot validation
- snapshot publication
- mutation-history compaction
- retention-window advancement

The external compactor is the natural owner of those responsibilities.

## New Meaning Of Bootstrap And Sync

In the zero-hydration design, bootstrap and websocket sync must become more
explicit.

### HTTP bootstrap becomes authoritative

`GET /room/:roomId/state` returns the current persisted baseline for the room.

The response should carry:

- snapshot bytes
- `checkpointLogId`
- schema version
- optional retained-tail metadata
- optional snapshot generation metadata

The client applies that snapshot locally and treats it as the authoritative
basis for the next websocket phase.

### Websocket sync becomes checkpoint-relative

The websocket `sync-request` should no longer mean:

"Here is my arbitrary state vector. Compute a server diff for me."

It should mean:

"I have checkpoint N. Send me the durable updates after checkpoint N."

This is a much narrower contract, but it is precisely what allows the room to
answer without a hydrated Y.Doc.

### Warm reconnects

If the tab still has its local Y.Doc in memory and reconnects quickly, the room
may still answer using only tail metadata, as long as the client's basis is not
older than the retained tail window.

That means a warm reconnect can remain tail-only.

### Cold reconnects or stale bases

If the client has reloaded, lost its local state, or fallen behind the retained
tail basis, the answer should be:

1. fetch latest snapshot by HTTP
2. apply snapshot locally
3. request only the tail after that checkpoint

This is acceptable and should be treated as the normal rebaseline path.

## What Happens To `sync-request`

Under this design there are two options.

### Option A: Keep the message name, change the contract

Continue using `sync-request`, but define it as checkpoint-relative only.

Required fields would become something like:

- `checkpointLogId`
- optional client-side retained metadata
- no generic state-vector meaning

This is the most practical migration path.

### Option B: Split the concept into two explicit operations

Use one message for catch-up and another for capability negotiation.

For example:

- `catch-up-request { checkpointLogId }`
- `catch-up-response { updates..., retainedFromLogId, latestLogId }`

This is clearer semantically, but requires more protocol churn.

The important point is the same either way: a no-hydration room cannot support
generic Yjs "tell me exactly what I am missing from this arbitrary state
vector" semantics unless it stores additional index structures that effectively
replace the live server doc.

## Can Tail-Only Sync Replace Generic Yjs Sync?

Yes, but only if the system accepts a stricter basis contract.

Tail-only sync works when the client says:

"I have checkpoint N. Give me all updates after N."

Tail-only sync does not work as a general replacement for:

"Here is my arbitrary state vector. Compute the exact missing diff."

That latter problem requires either:

- a hydrated authoritative doc
- or persisted per-client/per-clock summary structures rich enough to compute a
  diff without the doc

Those summary structures would be complicated enough that they are unlikely to
be worth it. If the system already requires HTTP snapshot bootstrap, it is much
simpler to make snapshot-plus-tail the only supported rebaseline model.

## The Hard Part: Uncheckpointed Rooms

This is the most important design consequence.

If the room never hydrates a doc, then a new room cannot rely on
"temporarily build the whole document in memory until the first checkpoint
exists".

That would recreate the same memory problem.

So the system needs a different first-state rule.

### Preferred model: seed-by-snapshot

The first durable state of a room should already be a snapshot artifact.

That means room creation should work like this:

1. client uploads or provides baseline snapshot bytes through the existing HTTP
   seed path
2. external adoption/publish step marks that snapshot as checkpoint 0
3. room stores only metadata pointing at that checkpoint
4. all subsequent websocket traffic is append-only tail after checkpoint 0

This is the cleanest zero-hydration model because there is never a period where
the room must reconstruct a large uncheckpointed doc.

### Acceptable fallback: bounded pre-checkpoint window

If a true seed-by-snapshot path is temporarily unavailable, the system could
allow a very small append-only pre-checkpoint window and force compaction early.

This is weaker and operationally riskier. It should be treated as a migration
bridge, not the target design.

## Undo And History Under The New Design

This design becomes much easier if undo is treated as session-scoped.

That means:

- local UndoManager stacks are authoritative only within the current live
  browser session
- a full snapshot rebootstrap starts a new undo epoch
- older history before that snapshot is considered committed state, not
  live-session undoable state

This matches the actual user requirement better than trying to preserve
cross-session undo forever.

### Current retained history is already bounded

The current worker already trims semantic mutation history to a fixed retained
window:

- maximum 250 envelopes
- maximum 512 KB

So cross-reconnect undo is already a best-effort retained window, not an
infinite ledger.

### Recommended undo rule

Use these explicit boundaries:

- warm reconnect with local state still present: preserve local undo stacks
- snapshot rebootstrap: clear undo/redo stacks and begin a new session epoch
- no attempt to make the room preserve arbitrary old undo beyond snapshot
  boundaries

This is a major simplification and removes pressure to keep more state in the
room than collaboration correctness actually requires.

## Proposed Protocol Shape

### HTTP

#### `GET /room/:roomId/state`

Returns:

- checkpoint snapshot bytes
- `X-Checkpoint-Log-Id`
- schema version
- optional retained-tail metadata headers

#### `POST /room/:roomId/state`

Seeds an empty room by publishing a baseline snapshot and checkpoint metadata.

The room should adopt metadata, not reconstruct the uploaded font in memory.

### WebSocket

#### `auth`

Returns:

- role
- schema version
- room metadata
- retained-tail metadata
- never triggers background full hydration

#### `sync-request`

Becomes checkpoint-relative.

Client sends:

- `checkpointLogId`

Server returns:

- updates after that checkpoint
- latest retained/log boundaries
- optional chunking metadata

#### `sync-complete`

If kept, this should represent only the client's local changes produced during
the reconnect window, not a generic arbitrary Yjs reconciliation against a
server-side doc.

That means the reconnect contract becomes:

1. client bootstraps from checkpoint
2. client catches up from tail
3. client uploads any pending local unsent updates

not:

1. compare arbitrary server/client state vectors on both sides
2. compute missing diffs from live docs on both sides

## Operational Consequences

### Benefits

- room memory no longer scales with font size
- hibernation wake becomes cheaper
- auth stops being dangerous for large rooms
- checkpoint creation is decoupled from websocket critical paths
- reconnect behavior becomes easier to reason about
- snapshot boundaries become explicit rebaseline points

### Costs

- the protocol becomes less "pure Yjs" and more application-specific
- reconnect behavior becomes more explicit and less magical
- stale clients may need snapshot reloads more often
- the compactor becomes more operationally important
- migration requires tightening invariants around checkpoint publication

## Migration Strategy

### Phase 1: Keep current transport but narrow the hot paths

- keep HTTP bootstrap as primary
- prefer checkpoint-tail sync whenever possible
- avoid all unnecessary room hydrations
- treat generic state-vector fallback as deprecated

### Phase 2: Make checkpoint-relative catch-up the only supported reconnect

- require reconnect flows to start from checkpoint basis
- remove arbitrary server-side diff generation for reconnect
- expose retained-tail boundaries explicitly

### Phase 3: Move checkpoint authority fully to compactor/published artifacts

- room adopts published checkpoints by metadata only
- room never reconstructs full doc state after hibernation
- snapshot validation leaves websocket request path entirely

### Phase 4: Remove room-side full hydration paths

- delete `_ensureDocLoaded()` dependency from live sync flows
- delete generic Yjs server diff path
- keep the room as append-log plus fan-out only

## Open Questions

1. What exact retained-tail boundary should the server expose so the client can
   decide between warm tail catch-up and cold snapshot rebaseline?
2. Should `sync-request` keep its current name for migration compatibility, or
   should checkpoint-relative catch-up get a new explicit message type?
3. Should the first checkpoint always be `logId = 0`, or should seed adoption
   reserve a distinct baseline marker?
4. How aggressively should the system force fresh snapshot bootstrap when a
   client reconnects from an old basis?
5. Do we want any semantic history replay to survive snapshot rebootstrap, or
   should that boundary always clear undo completely?

## Recommendation

Adopt the zero-hydration room as the target architecture.

Specifically:

- treat HTTP snapshot bootstrap as authoritative
- redefine websocket sync as checkpoint-relative tail catch-up
- make snapshot reload an explicit rebaseline and undo boundary
- move checkpoint materialization responsibility fully to the external
  compactor/publisher path
- remove all room-side assumptions that a full Y.Doc can be rebuilt safely in
  memory

The recent auth-gate fix remains correct and worth keeping, but it should be
understood as a tactical mitigation on the way to this design, not the final
solution.