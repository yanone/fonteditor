# Yjs-Authoritative Collaboration Migration

This checklist converts collaboration to the APP.md policy:

- Yjs diffs are the only authoritative document mutation transport.
- Undo and redo must also travel as Yjs diffs only.
- Receiver-side state rebuild must come only from applying the forward Yjs update.
- Human-readable history and introspection may be derived from a Yjs message, but must never drive document replay.
- Replay targets remain narrow metadata for cache refresh, compilation, and UI invalidation only.

## Phase 1: Freeze the authority model

- [x] Remove all receiver-side document mutation paths that replay semantic patches after `Y.applyUpdate(...)`.
- [x] Remove all transport assumptions that `mutationBatchEnvelopes` can repair, complete, or overwrite font state.
- [x] Keep bootstrap and live sync as `encodeStateAsUpdate` / `applyUpdate` flows only.
- [x] Keep local undo scoping and Yjs UndoManager ownership intact.

Files:

- `webapp/js/patch-sync-engine.ts`
- `webapp/js/window-sync.ts`
- `webapp/js/cloud-adapter.ts`

## Phase 2: Replace patch transport with message metadata

- [x] Replace patch-pair wire payloads with a metadata-only collaboration message envelope.
- [x] Keep only summary, source, transaction identity, undo action kind, undo target identity, replay targets, and timestamps on the wire.
- [x] Stop serializing forward or inverse semantic patch data for transport.
- [x] Stop importing remote history from patch pairs.

Files:

- `webapp/js/collaboration-message.ts`
- `webapp/js/change-log.ts`
- `webapp/js/window-sync.ts`
- `webapp/js/cloud-adapter.ts`

## Phase 3: Rebuild history as Yjs-message introspection

- [x] Introduce a flat collaboration message log that records every local and remote Yjs message.
- [x] Derive the forward patch view only on the receiver or inspector side from before/after Yjs-derived JSON snapshots.
- [x] Do not hide undone items.
- [x] Remove history scoping from the view model.
- [x] Keep the info popup, but populate it from message metadata plus derived introspection.

Files:

- `webapp/js/history-view.ts`
- `webapp/js/patch-sync-engine.ts`
- `webapp/js/change-log.ts`

## Phase 4: Narrow replay targets to side-channel hints

- [x] Keep `workerReplayTargets` only for cache refresh and compile targeting.
- [x] Ensure remote refresh code reads metadata without assuming it can reconstruct document state.
- [x] Delete or rename helpers whose names still imply replay-authoritative behavior.

Files:

- `webapp/js/change-bridge-init.ts`
- `webapp/js/change-log.ts`
- `webapp/js/patch-sync-engine.ts`

## Phase 5: Consolidate drifting collaboration files by meaning

- [x] Collapse patch-envelope naming into collaboration-message naming.
- [x] Separate three concerns cleanly:
    - authoritative Yjs state sync
    - undo/history targeting metadata
    - human introspection derivation
- [x] Delete dead patch-authoritative helpers after call sites are removed.

Target structure:

- `webapp/js/patch-sync-engine.ts`: Yjs authority, undo managers, local/remote application, message logging.
- `webapp/js/collaboration-message.ts`: wire metadata and shared serialization helpers.
- `webapp/js/change-log.ts`: undo scope and local history targeting helpers only.
- `webapp/js/history-view.ts`: flat message inspector UI only.

## Phase 6: Tests and acceptance

- [x] Update linked-window tests to assert that remote state matches purely from Yjs updates.
- [x] Add tests that remote undo and redo converge without semantic replay payloads.
- [x] Add tests that history rows are flat and retain undone items.
- [x] Add tests that info-popup introspection is derived and non-authoritative.
- [x] Remove tests that depend on transported forward or inverse patch payloads.

Acceptance criteria:

- Applying a Yjs update is sufficient to converge every receiving window.
- Undo and redo do not need transported semantic patches.
- Bootstrap and live collaboration share the same authority model.
- History display is a message inspector, not a replay stack.
- No receiver path mutates font data from transported semantic patch payloads.
