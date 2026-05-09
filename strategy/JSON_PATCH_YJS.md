# JSON Patch + Yjs Migration Strategy

## Executive Summary

Counterpunch should move to a stricter collaboration and mutation architecture:

- Babelfont JSON remains the application source of truth.
- RFC 6902 JSON Patch becomes the only authoritative mutation contract.
- Yjs becomes a mirrored transport, snapshot, and state-vector substrate.
- Receiver compile metadata remains explicit and travels beside each patch batch.
- Rust applies the same JSON Patch batches to its cached JSON state.
- `store_font` and `storeFontJson` are removed as runtime fallbacks.

This is a policy change, not a refactor. The current system mixes app-level mutation meaning across custom change-log entries, sparse layer deltas, Yjs document updates, and Rust-specific incremental layer update messages. That split is exactly where omission-vs-deletion ambiguity, receiver normalization complexity, and fallback-driven corruption masking have accumulated.

The new design collapses that down to one contract: every committed edit yields one forward patch batch, one inverse patch batch, and one metadata envelope.

## The Core Authority Split

### Application truth

Babelfont JSON is the canonical app model. All edit producers already mutate or derive from this model, so the migration should formalize that instead of letting Yjs and Rust cache protocols invent parallel mutation semantics.

### Mutation truth

RFC 6902 JSON Patch is the only mutation language with application-level authority.

Every committed transaction must produce:

- `forwardPatches`
- `inversePatches`
- explicit metadata

No custom sparse delta, old/new value tuple, or receiver-side merge heuristic should be authoritative once this migration is complete.

### Synchronization truth

Yjs remains useful and should stay, but in a narrower role:

- mirrored shared state
- binary delta transport
- state-vector sync
- room snapshot substrate
- peer bootstrap
- append-only transport log if useful

Yjs should not be treated as the application mutation contract.

## Logical Caveat: JSON Patch vs Yjs Conflict Resolution

The tempting sentence is: "Use JSON Patch for mutations and Yjs for conflict resolution."

That sentence is only valid if conflict resolution happens at the patch transaction layer.

Yjs can converge a mirrored CRDT document. What Yjs does not guarantee is that an arbitrary merged Yjs state corresponds to a deterministic ordered stream of authoritative JSON Patch transactions. If both are allowed to define meaning independently, Babelfont JSON, mirrored Yjs state, and Rust cache state can all be "converged" differently.

So the system must choose one of these interpretations:

1. JSON Patch is authoritative, and Yjs mirrors ordered patch outcomes.
2. Yjs is authoritative, and JSON Patch is only an export/diagnostic format.

This strategy chooses option 1.

That means the implementation must add:

- a transaction id per mutation batch
- a base revision / precondition reference
- optional room-assigned sequence numbers for cloud ordering
- `test` ops or equivalent precondition validation
- stale patch rejection or explicit rebase behavior
- diagnostics when mirrored Yjs state differs from replaying the authoritative patch log

Without that, "JSON Patch authoritative, Yjs conflict-resolving" is a logical contradiction.

## JSON Patch Limitations We Still Need to Design Around

JSON Patch fixes omission-vs-deletion ambiguity because deletion is explicit `remove`. That is a big win over sparse layer deltas.

But JSON Patch is not magic:

- it is path-based, not domain-semantic
- it does not know glyph/layer identity rules
- it does not automatically preserve stable meaning across array index races
- it does not know compile fast-path requirements
- it does not generate the metadata needed for receiver recompilation

So Counterpunch still needs:

- explicit transaction boundaries
- stable path policy
- required-field validation
- compile/recomposition metadata
- domain-level invariants enforced before and after patch application

## Wire / Runtime Contract

## `MutationBatchEnvelope`

Every committed transaction should produce a single envelope with this conceptual shape:

- `schemaVersion`
- `transactionId`
- `localSequence`
- `roomSequence` (optional before server assignment)
- `baseRevision`
- `forwardPatches`
- `inversePatches`
- `metadata`
- `source`
- `label`
- `windowId`
- `timestamp`
- `validationFingerprint`

The patch arrays mutate data. The metadata drives scheduling, replay, diagnostics, and UI behavior.

## Required Metadata

Patch arrays alone are not enough for Counterpunch. The envelope metadata must preserve the information that currently powers efficient receiver behavior:

- changed glyph names
- changed layer ids
- edit type: `outline`, `anchor`, `metrics`, `feature`, `font`, `python`, `undo`, `redo`
- recomposition targets
- automatic-composition dependents
- sidebearing adjusted side
- visual anchor side
- worker cache update hints
- undo scope / history target
- whether trailing full compile is required
- whether full-font correctness pass is required

This metadata is normative. It must not be re-inferred opportunistically from patch paths alone.

## No-Repair Integrity Rule

This migration must explicitly preserve the current integrity stance:

- invalid or missing `Layer.width` is not repaired downstream
- cloud open must not synthesize `width = 0`
- receiver sync must not silently borrow sibling or prior values
- malformed patch batches fail loudly, are logged, and are quarantined

Repair logic hides corruption and invalidates the whole point of having an authoritative mutation contract.

## Replacement Inventory

## Webapp: custom mutation and replay code to replace

### `webapp/js/change-bridge.ts`

Primary retirement targets:

- `recordChange`
- `recordAdd`
- `recordRemove`
- `_commitOperations`
- `_queueOrCommitOperations`
- `syncGlyphFromJson`
- `syncGlyphsFromJson`
- `syncLayersFromJson`
- `_trySyncSingleLayer`
- `_normalizeFontSnapshot`
- `_normalizeGlyphSnapshot`
- `_normalizeLayerSnapshot`
- `_normalizeLayerMasterSnapshot` as transport repair logic
- `_applyGlyphSnapshot`
- `_applyLayerSnapshot` / `_applyLayerDelta`
- `_patchLayerFromYDoc`
- `_syncJsonFromYDoc`
- `_applyBufferedOperation` old custom mutation mode handling
- `_applyHistoryItem`
- `_canReplayHistoryItemDirectly`
- `_getHistoryReplayValue`
- layer fingerprint change emission used as patch authority

After migration, `ChangeBridge` should coordinate mirrored transport and local integration, not invent its own mutation language.

### `webapp/js/change-bridge-ydoc.ts`

Keep, but demote:

- `jsonToYDoc`
- `yDocToJson`
- `toYType`
- `fromYType`

Retire as mutation authority:

- `setYPath`
- `getYPath`
- `deleteYPath`

These helpers remain useful for bootstrap, export, diagnostics, and mirror projection.

### `webapp/js/change-log.ts`

Replace:

- `ChangeLogEntry` as the mutation source of truth
- `buildHistoryStackItems`
- `createLogEntry`
- custom replay-target folding
- incremental fold over old/new operation entries

History should store committed patch envelopes and precomputed display metadata.

### `webapp/js/change-bridge-init.ts`

Replace:

- `handleRemoteChangeRefresh`
- `syncRustCacheAndRefreshCanvas` replay-target extraction path
- `collectRemoteChangeWorkerReplayTargets`
- `collectUndoRedoWorkerReplayTargets`
- `historyItemHasIncrementalWorkerReplayTargets`

Remote receive should apply patch envelopes and schedule recompilation from explicit metadata.

### `webapp/js/window-sync.ts` and `webapp/js/cloud-adapter.ts`

Replace custom `changeLogEntries` mutation truth with:

- Yjs update
- `MutationBatchEnvelope`

Batching behavior should stay.

### `webapp/js/cloud-plugin.ts`

Cloud open/save must follow the no-repair rule.

Any fallback that synthesizes `width = 0` or borrows data from sibling layers is incompatible with the target architecture.

### `webapp/js/babelfont-model.ts`

Replace setter/list hooks that currently emit:

- `recordChange`
- `recordAdd`
- `recordRemove`
- direct `store_font` cache sync paths

These hooks should join the transaction coordinator instead.

### `webapp/js/python-ui-sync.ts` and `webapp/js/python-post-execution.ts`

Python should emit one patch envelope per script transaction, not trigger a `storeFontJson` aftermath path.

### `webapp/js/glyph-canvas/outline-editor.ts`

Replace direct `syncGlyphFromJson`, `syncGlyphsFromJson`, and `syncLayersFromJson` calls with transaction commits that include all dependent layers in one authoritative patch batch.

## Worker boundary and Rust replacement targets

### `webapp/js/font-manager.ts`

Replace:

- `submitLayerUpdatesToWorkerCache`
- `refreshWorkerCacheForReplayTargets`
- `submitLayerToWorkerCache`
- `forceFullWorkerCacheUpdate`
- `workerLayerFingerprintCache`
- `recordFullFontCrossing`
- `dirtyLayerUpdates` as mutation protocol

These become one patch-envelope worker dispatch path.

### `webapp/js/font-compilation.ts`

Replace:

- `lastStoredFontJson`
- `pendingStoreFontJsonPromise`
- `pendingStoreFontJsonPayload`
- `storeFontJson` special path
- `forceStoreFontJson`
- `dirtyLayerUpdates`

These exist specifically because the current runtime still treats full-font JSON store as a fallback truth path.

### `webapp/js/fontc-worker.ts`

Remove as runtime mutation protocol:

- `store_font` import/use
- `IncrementalLayerUpdate`
- `normalizeIncrementalLayerUpdates`
- `applyIncrementalLayerUpdates`
- `storeLayerUpdates` worker message
- `storeFontJson` worker message
- fallback `store_font(babelfontJson)` calls

Replace with a patch-batch apply message.

### `babelfont-fontc-build/src/lib.rs`

Replace:

- `store_font`
- `update_cached_layer`
- `update_cached_layers_batch`
- custom cache patching semantics
- runtime assumption: "Call `store_font()` first"

The Rust side should hold canonical cached JSON, apply RFC 6902 batches using `json-patch`, then update derived caches based on changed paths and metadata.

## No-`store_font` Invariant

This migration should explicitly remove `store_font` and `storeFontJson` as runtime fallback mechanisms.

That is not optional. It is the proof that JSON Patch truly became authoritative.

End-state rules:

- no production JS code imports or calls `store_font`
- no `storeFontJson` worker message exists
- no `forceStoreFontJson` path exists
- no identical-JSON full-store dedupe path exists because full-store does not exist anymore
- Rust bootstrap happens by applying an initial root patch batch against empty state, not by calling a separate full-store API
- if Rust patch state is missing or stale, the system fails loudly instead of silently calling `store_font`

## Recommended Libraries

### JavaScript

Use `fast-json-patch` for:

- patch validation
- patch application
- scoped object comparison
- optional `test` op generation

### Rust

Use `json-patch` on `serde_json::Value` for:

- applying RFC 6902 patch batches
- diff support where needed

## Rollout Phases

### Phase 1: establish the contract

- add `MutationBatchEnvelope` types
- add JS patch utilities
- add Rust dependency
- write canonical tests for envelope and patch equivalence

### Phase 2: centralize transaction production

- introduce mutation coordinator
- route Babelfont model, outline editor, and Python through it
- dual-emit old and new outputs for diagnostics only

### Phase 3: migrate transports and undo/redo

- cross-window transport sends Yjs update plus envelope
- cloud transport sends Yjs update plus envelope
- history stores envelopes
- undo uses inverse patches
- redo uses forward patches

### Phase 4: migrate worker and Rust cache

- replace `storeLayerUpdates` and `dirtyLayerUpdates`
- add patch-batch worker message
- Rust applies same patches to cached JSON
- remove `store_font`

### Phase 5: delete the old path

- remove custom sparse delta logic
- remove change-log mutation authority
- remove repair/defaulting logic
- remove full-store fallback paths

## Validation Plan

### Canonical correctness tests

Add coverage for:

- outline drag patch generation
- structural point insert/delete patch generation
- anchor drag with dependent recomposition
- sidebearing cascade
- Python batch transaction
- undo via inverse patches
- redo via forward patches

### Cross-window and cloud tests

Mixed-topology tests must prove:

- patch envelope metadata survives transport
- Yjs mirror converges
- Babelfont JSON converges
- replaying the patch log matches the mirrored Yjs result
- malformed or stale patches fail loudly

### Rust equivalence tests

Prove the same RFC 6902 patch batch produces equivalent canonical JSON in JS and Rust.

### No-fallback tests

Add tests that fail if runtime code still:

- imports `store_font`
- sends `storeFontJson`
- falls back to `width = 0` repair on cloud open

### Performance guards

Update boundary-crossing policy and tests so the worker boundary becomes one patch-batch crossing per commit, with zero full-store crossings after bootstrap.

## Policy Impact

`developer-docs/COMPILATION_EDIT_POLICY.md` must be updated when this migration lands. The current policy still documents `storeLayerUpdates` and allows `store_font()` as a fallback. Under the new system, the policy should describe:

- one patch-batch worker crossing per committed edit
- zero runtime full-store crossings after bootstrap
- metadata-driven fast-path compile scheduling

## Non-Goals

- replacing Yjs itself
- replacing Cloudflare DO room snapshots immediately
- changing compile scheduling semantics beyond the metadata handoff required to preserve current fast paths
- preserving custom sparse layer deltas as a second contract

## Immediate Next Slice

The safest first implementation slice is:

1. add the strategy document
2. add envelope/type scaffolding
3. remove width-repair fallback from cloud open
4. add tests that lock no-repair behavior and the new contract scaffolding

That slice improves integrity immediately without deepening the existing custom sparse-delta experiment.
