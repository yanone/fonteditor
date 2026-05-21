# Rust/Yrs Batch Reinterpolation Strategy

## Purpose

This document defines the target architecture for making two expensive interpolation workflows fast again while preserving the Yjs-authoritative collaboration model from [APP.md](/Users/yanone/Code/Counterpunch/editor/APP.md):

- creating a new master with all newly required layers already interpolated
- reinterpolating all layers for one master from the masters-list context menu

The current correctness-first path performs too much work in JavaScript:

- JS scans all target glyphs and layers
- JS calls Rust interpolation repeatedly
- JS materializes interpolated layers in JS objects
- JS commits the result through full glyph snapshot sync

That restores correctness, but it is slower than necessary and performs redundant JSON and object work on the wrong side of the JS/WASM boundary.

The target design moves the heavy interpolation and Yrs mutation into Rust, returns one authoritative Yjs diff to JavaScript, and fans that same document change out to all other Rust caches.

## Scope

This strategy covers only two workflows:

- master creation with immediate interpolation of all newly needed layers
- master-wide reinterpolation of existing layers

This strategy does not change the authority model:

- Yjs remains the authoritative live document transport
- `PatchSyncEngine` remains the authoritative local and remote commit funnel
- undo and redo continue to operate through normal committed Yjs update flow
- replay targets remain side-channel metadata only for cache refresh, compile targeting, and UI refresh

## Goals

- Replace N per-layer JS-to-Rust interpolation calls with one Rust batch call
- Replace JS-side layer materialization plus full glyph snapshot commit with one binary Yjs update
- Keep add-master atomic so no receiver ever sees placeholder empty layers
- Keep linked windows and cloud collaboration on the same committed Yjs packet path
- Preserve one history item and one undo step per user action
- Keep layout-closure invalidation disabled for pure reinterpolation work
- Fan the new document state into every Rust cache that can answer future interpolation or compilation requests

## Non-Goals

- No fallback to full babelfont JSON resend during steady-state editing
- No fallback to full Yjs state resend for normal edits
- No second authority path where Rust mutates state silently and JS catches up later
- No receiver-side repair heuristics for missing or malformed data

## Core Principle

Rust may produce the change, but JavaScript must still commit the truth.

The fast path is valid only if Rust becomes a batch-diff producer, not a second document authority. The generated Yjs diff must still be applied through `PatchSyncEngine` as a local committed update so that:

- the local sender sees one history item
- UndoManagers track the transaction normally
- linked windows receive the normal collaboration message
- cloud relay receives the same authoritative packet
- committed-change listeners infer edit type from the same packet as every other edit

## Current Bottleneck

The current master-wide reinterpolation path effectively does this:

1. enumerate all target glyphs and layers in JS
2. interpolate each target layer through repeated Rust calls
3. normalize and materialize layer data in JS
4. commit the result back into the Yjs document through heavy glyph snapshot sync

That pays for boundary crossing repeatedly and rebuilds large JS object graphs only to convert them back into authoritative document mutations.

## Target Architecture

## Summary

The optimized path should be:

1. JS asks Rust to execute a batch operation against a Rust `yrs::Doc`
2. Rust performs all interpolation and Yrs mutation in one transaction
3. Rust updates the originating Rust cache immediately
4. Rust returns one binary Yjs update plus metadata describing the change
5. JS applies that update locally through a dedicated `PatchSyncEngine` entry point
6. JS emits the normal local collaboration packet
7. JS forwards the same Yjs update to every non-origin Rust cache
8. receivers apply the same packet and refresh only declared replay targets

## Authority Model

The authoritative data flow remains:

```text
Rust batch producer -> JS PatchSyncEngine local apply -> local emit/broadcast -> remote apply -> worker/cache fanout
```

Not this:

```text
Rust mutates live state -> JS notices later -> ad hoc repair or secondary commit path
```

## Required Invariants

### 1. Base-state precondition

Rust must not author a diff against stale state.

Every batch request must include a base-state precondition. At minimum this should be a Yjs state vector or equivalent revision token. If the Rust worker does not match the caller's expected base, the operation must fail loudly and return no diff.

There is no repair fallback in this strategy.

### 2. One user action, one committed Yjs update

Each workflow must resolve to one local committed Yjs transaction:

- one collaboration message
- one history item
- one undo step
- one redo step

### 3. Replay targets stay metadata-only

Replay targets remain narrow hints for:

- worker cache refresh
- compile targeting
- canvas and overview refresh

Replay targets must never become a second mutation authority.

### 4. No placeholder-state exposure

Add-master must become atomic. Neither the sender nor any receiver may observe:

- master exists but layers are still empty
- layers exist but are not yet interpolated
- master metadata committed separately from generated layers

### 5. Layout-closure policy must remain intact

Pure reinterpolation of already-known glyph and layer content must keep `invalidateLayoutClosure: false`.

If a batch includes non-glyph structural data that truly changes layout closure inputs, that must be explicit in metadata rather than inferred loosely.

### 6. All Rust caches must converge from the same change

The generated change must not stop at JS model state. The same authoritative document mutation must reach every Rust-side cache that can serve future interpolation or compilation results.

This includes:

- the originating interpolation worker/cache
- the full compile worker/cache
- any editing or incremental compile worker/cache
- any main-thread Rust-backed interpolation cache still participating in the current runtime path

## New Rust Batch APIs

## API A: reinterpolate existing master layers

Conceptual shape:

```ts
reinterpolate_master_layers_yjs({
    masterId,
    baseStateVector,
    operationId,
    sourceWorkerId
}) => {
    update,
    stateVectorBefore,
    stateVectorAfter,
    changedGlyphs,
    replayTargets,
    label: 'Reinterpolate layer batch sync',
    editType: 'outline',
    undoScope: 'font',
    nonGlyphHints: [],
    invalidateLayoutClosure: false,
    originCachePatched: true
}
```

Responsibilities:

- derive the affected glyphs and layers for the target master
- compute all interpolated layer content in Rust
- write that content into one `yrs::Doc` transaction
- return one encoded Yjs update representing the whole batch
- patch the originating Rust cache immediately so it can answer follow-up work without waiting for JS echo

## API B: add master with interpolated layers

Conceptual shape:

```ts
add_master_with_interpolated_layers_yjs({
    masterRecord,
    baseStateVector,
    operationId,
    sourceWorkerId
}) => {
    update,
    stateVectorBefore,
    stateVectorAfter,
    changedGlyphs,
    replayTargets,
    label: 'Add master',
    editType: 'font',
    undoScope: 'font',
    nonGlyphHints: ['masters'],
    invalidateLayoutClosure: false | true,
    originCachePatched: true
}
```

Responsibilities:

- insert the master record
- create every required layer for that master
- compute the final interpolated layer contents in the same transaction
- return one atomic Yjs update containing both the master insertion and final layers

This replaces the current model where JS creates empty layers and then repairs them by reinterpolation.

## PatchSyncEngine Integration

Add a dedicated local-authoritative entry point in `PatchSyncEngine`.

Conceptual shape:

```ts
applyLocalGeneratedYjsUpdate({
    update,
    label,
    editType,
    undoScope,
    changedGlyphs,
    replayTargets,
    nonGlyphHints,
    invalidateLayoutClosure,
    sourceWorkerId,
    operationId,
    stateVectorBefore,
    stateVectorAfter,
});
```

Responsibilities:

1. verify local JS document state matches `stateVectorBefore`
2. apply the returned Yjs update with a local tracked origin
3. create exactly one change-log/history item
4. rebuild or patch JS model state from the authoritative JS Y.Doc
5. emit the normal local update
6. run the normal committed-change funnel
7. forward the update to non-origin Rust caches
8. broadcast the collaboration message to linked windows and cloud peers

This API must not reuse remote-apply code and must not bypass UndoManager tracking.

## Rust Cache Fanout

## Requirement

The new document state must be fanned out to all relevant Rust caches, not just JS.

The originating Rust worker is only one of several consumers of the authoritative document. After the batch operation, every Rust cache that may answer future interpolation, shaping, or compilation work must converge from the same Yjs update.

## Origin cache behavior

The originating Rust worker has already executed the mutation. Its local cache must be updated during the batch operation itself.

That means:

- its local `yrs::Doc` is already advanced
- its derived font and glyph caches are already patched or rebuilt for the changed replay targets
- it must not need JS to replay the same update back just to become correct

## Non-origin cache behavior

Every other Rust cache must receive the same authoritative Yjs update through the existing worker update path.

Each non-origin cache must:

1. apply the Yjs update to its own `yrs::Doc`
2. derive the changed glyph and layer data from that updated doc
3. patch or rebuild only the affected cache entries
4. preserve layout closure unless metadata says otherwise

## Self-replay suppression

The system must avoid replaying the exact same update back into the worker that originated it.

Required mechanism:

- every generated batch carries `sourceWorkerId` and `operationId`
- JS fanout skips re-applying the update to the origin worker only
- JS still forwards the same update to all other local Rust caches
- linked windows and cloud peers still receive the normal packet

If this cannot be implemented precisely, the safer first version is to build the diff against a cloned Rust doc and let the normal JS fanout update every worker, including the one that requested the batch. That is less efficient, but it preserves correctness while the skip-self path is hardened.

## Cache update modes

There are two acceptable internal Rust cache update strategies after `apply_yjs_update`:

- targeted patching of changed glyph and layer caches from replay targets
- local rebuild of only the changed portions of the canonical JSON-derived structures

What is not acceptable:

- full document resend from JS to repair a stale cache
- silent divergence between one Rust cache and another
- origin worker staying ahead while other caches lag on old state

## Workflow A: master-wide reinterpolation

1. User chooses reinterpolate-all-layers for one master.
2. JS requests `reinterpolate_master_layers_yjs(...)` from the originating Rust worker.
3. Rust verifies base state.
4. Rust computes all target layer results and mutates one Yrs transaction.
5. Rust updates its own cache immediately.
6. Rust returns one Yjs update plus metadata.
7. JS calls `applyLocalGeneratedYjsUpdate(...)`.
8. JS emits one local collaboration packet.
9. JS forwards the same update to all non-origin Rust caches.
10. remote receivers apply the same packet and refresh only declared targets.

Expected outcome:

- one user-visible history item
- one undo step
- one update fanout
- no full glyph snapshot sync
- no per-layer JS interpolation loop

## Workflow B: add master with interpolated layers

1. User creates a new master.
2. JS does not pre-create empty layers locally.
3. JS requests `add_master_with_interpolated_layers_yjs(...)`.
4. Rust verifies base state.
5. Rust inserts the master and computes all required layer contents in one Yrs transaction.
6. Rust updates its own cache immediately.
7. Rust returns one Yjs update plus metadata.
8. JS applies that update locally through `PatchSyncEngine`.
9. JS emits one local collaboration packet.
10. JS fans the same update out to all non-origin Rust caches.

Expected outcome:

- receivers never observe empty placeholder layers
- undo removes the master and generated layers together
- redo restores the same final state atomically

## Undo and Redo

Both workflows are font-scoped atomic edits.

Required behavior:

- one history item per batch operation
- one undo removes the full result of the batch
- one redo restores the full result of the batch
- undo and redo still emit normal committed Yjs updates
- receiving windows still learn about undo and redo through the same authoritative packet flow

Forbidden behavior:

- separate undo items for master insertion and layer generation
- remote-only apply semantics for local Rust-generated batches
- hidden side channel that mutates Rust caches without an authoritative Yjs delta

## Collaboration and Linked Windows

Receivers must not need a special protocol for these batch operations.

The collaboration envelope should remain the same class of message already used for other committed Yjs edits, carrying:

- binary Yjs update
- label
- edit classification
- replay targets
- changed glyphs
- non-glyph hints
- layout-closure policy
- source and transaction identity

Remote windows then:

1. apply the Yjs update locally
2. patch their JS model from their Y.Doc
3. forward the update to their own Rust caches
4. run the standard committed-change classification and refresh path

## Failure Policy

Batch operations must fail loudly rather than degrade into hidden repair behavior.

Failure conditions include:

- base-state mismatch
- malformed generated layer data
- inability to encode the final Yjs update
- cache patch failure inside the originating Rust worker

Allowed response:

- abort the operation
- surface a clear error
- leave document state unchanged

Disallowed response:

- silently fall back to full JSON transport
- silently re-seed the worker during steady-state editing
- commit part of the operation and repair the rest later

## Rollout Plan

### Phase 0: Instrument the current path

Measure:

- number of target layers per operation
- number of JS-to-Rust calls
- total interpolation time
- total commit time
- Yjs payload size
- Rust cache fanout time

### Phase 1: Add the new JS commit entry point

Implement `applyLocalGeneratedYjsUpdate(...)` in `PatchSyncEngine` without yet switching the workflows.

Acceptance:

- one local generated diff can be applied with one history item
- linked-window and cloud emission still use the normal packet path

### Phase 2: Implement Rust batch reinterpolation for existing masters

Start with the safer version if needed:

- either build the diff against a cloned Rust doc first
- or mutate the live origin doc only if skip-self replay is already reliable

Acceptance:

- context-menu reinterpolate no longer loops over layers in JS
- no full glyph snapshot sync remains in the hot path

### Phase 3: Add Rust cache fanout and origin-skip logic

Acceptance:

- origin cache is not double-applied
- all non-origin Rust caches still receive exactly one update
- no cache diverges after repeated batch operations and undo/redo

### Phase 4: Move add-master to one atomic Rust batch

Acceptance:

- no empty-layer intermediate state exists anywhere
- undo/redo for add-master is atomic

### Phase 5: Remove the old JS workaround path

Delete:

- per-layer JS interpolation loop for master-wide reinterpolation
- heavy full glyph snapshot sync used only as this repair path
- any temporary compatibility shims no longer needed

### Phase 6: Update policy and regression coverage

Update [developer-docs/COMPILATION_EDIT_POLICY.md](/Users/yanone/Code/Counterpunch/editor/developer-docs/COMPILATION_EDIT_POLICY.md) once the new path is implemented and validated.

## Required Tests

### Rust tests

- batch reinterpolation generates a valid Yjs update
- applying that update to another `yrs::Doc` yields the same changed layers
- origin cache is patched during the batch operation
- non-origin cache update from the same Yjs delta converges to the same result

### JS integration tests

- `applyLocalGeneratedYjsUpdate(...)` creates one history item and one local emission
- the generating worker is not double-applied
- all other Rust caches receive the update exactly once
- linked windows classify master reinterpolation as the correct edit type
- layout closure is preserved for pure reinterpolation

### Workflow tests

- reinterpolate-all-layers updates outlines correctly for all target glyphs
- add-master creates the master and interpolated layers atomically
- no receiver ever observes placeholder layers
- undo and redo for both workflows remain single-step and correct

### Performance assertions

- one Rust batch call per user action
- one committed Yjs update per user action
- zero per-layer JS interpolation calls in the new hot path
- zero full glyph snapshot sync commits in the new hot path

## Acceptance Criteria

This strategy is complete when all of the following are true:

- both target workflows run as Rust-authored batch Yjs updates
- JS remains the only authority for committed local and remote application
- every Rust cache converges from the same authoritative change
- the origin worker does not need a self-echo replay to remain correct
- linked windows and cloud peers continue to work without special fallback channels
- undo and redo remain single-step and Yjs-authoritative
- the old correctness-only full glyph snapshot workaround is removed
