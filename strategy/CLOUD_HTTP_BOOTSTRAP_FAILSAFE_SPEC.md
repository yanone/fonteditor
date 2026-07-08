# Cloud HTTP Bootstrap Fail-Safe Spec

## Status

Proposed.

This document defines the required behavior for cloud Save As and cloud Open
once HTTP room-state transfer becomes the authoritative and only bootstrap
transport. It supersedes any design that treats WebSocket bootstrap as an
acceptable fallback for room seeding or room loading.

## Problem Statement

The current cloud flow can create or retain a visible cloud asset even when the
user-facing Save As or Open operation never completed successfully.

Observed failure modes:

1. Asset creation succeeds, but room bootstrap fails afterward.
2. The asset later appears in the cloud file browser, even though the user saw
   a failed Save As.
3. HTTP room-state failures can degrade into later WebSocket sync failures,
   obscuring the primary cause.
4. Error details may remain invisible in the UI, leaving the user with an
   inactive file dialog and no actionable explanation.

This violates the product contract. If Save As or Open does not complete, the
user must see a clear failure, remain in control of the UI, and must not be
left with a partially committed cloud asset that looks successful later.

## Product Principles

1. HTTP is the sole bootstrap transport.
2. WebSocket is not part of bootstrap correctness.
3. Save As is transactional from the user's perspective.
4. Open is transactional from the user's perspective.
5. A cloud asset is not visible or reusable until bootstrap is complete.
6. Every bootstrap failure must surface in the UI.
7. The user must never be trapped in a non-dismissable busy dialog.

## Scope

This spec covers:

1. Cloud Save As lifecycle.
2. Cloud Open lifecycle.
3. Client and server contracts for room seed and room load.
4. UI behavior for progress, failure, cancellation, and retry.
5. Failure cleanup and operational safety.
6. Validation and test requirements.

This spec does not redefine the steady-state live collaboration protocol after
bootstrap. WebSocket remains the live incremental transport after room
bootstrap succeeds.

## Transport Rules

### Authoritative bootstrap transport

The following operations must use HTTP as the primary and only transport:

1. Initial room seeding for Save As.
2. Initial room state loading for Open.
3. Initial room state loading for reconnect paths that require full room
   bootstrap.

### WebSocket role after this change

WebSocket remains responsible only for:

1. Authentication and live room attach.
2. Incremental Yjs updates after bootstrap.
3. Ack, durability, and collaboration sidecars after bootstrap.
4. Chunked transmission for oversized live packets only.

### Forbidden behavior

The following behaviors are explicitly forbidden:

1. Falling back to WebSocket full-state bootstrap when HTTP `GET /state`
   fails.
2. Falling back to WebSocket seed or sync-complete semantics when HTTP
   `POST /state` fails.
3. Declaring Save As success before HTTP bootstrap has succeeded.
4. Declaring Open success before HTTP bootstrap has succeeded.

## User-Visible Success Conditions

### Save As succeeds only when all of the following are true

1. The asset record was created in a non-visible pending state.
2. HTTP room seed succeeded.
3. The room's state is verifiably readable through the HTTP bootstrap path.
4. The live room attach reached a healthy post-bootstrap state.
5. The asset was finalized and became visible in the cloud listing.

### Open succeeds only when all of the following are true

1. HTTP room bootstrap succeeded.
2. The local bridge was initialized from the HTTP room state.
3. The editor completed font load from that bridge state.
4. The live room attach reached a healthy post-bootstrap state.

If any required step fails, the operation fails.

## Asset Lifecycle Model

### Required server states

Cloud assets must support at least the following lifecycle states:

1. `pending_bootstrap`
2. `active`
3. `bootstrap_failed`
4. `archived`

### Listing rules

1. `pending_bootstrap` assets must not appear in normal cloud asset listing.
2. `bootstrap_failed` assets must not appear in normal cloud asset listing.
3. Only `active` assets may appear in normal cloud asset listing or be
   openable from the editor file browser.

### Cleanup rules

1. A failed pending asset must be deleted automatically or transitioned into a
   server-owned failed state that is excluded from user-visible lists and later
   garbage-collected.
2. Any associated room-state artifacts for a failed pending asset must be
   removed or invalidated.
3. Stale `pending_bootstrap` assets must expire automatically.

## Save As Operation Contract

### Required phases

Save As must run through the following explicit phases:

1. `creating_asset`
2. `fetching_room_token`
3. `seeding_room_via_http`
4. `verifying_room_bootstrap_via_http`
5. `attaching_live_room`
6. `finalizing_asset`
7. `completed`
8. `failed`
9. `cancelled`

### Save As flow

1. Create a pending asset.
2. Fetch a room token for that pending asset.
3. Upload the current bridge state through HTTP `POST /room/:id/state`.
4. Verify that the room is bootstrappable through HTTP `GET /room/:id/state`,
   or obtain equivalent server-side confirmation that the checkpoint was
   durably published and is readable.
5. Attach the live room through WebSocket.
6. Finalize the asset.
7. Refresh the file browser.
8. Close the dialog.

### Save As failure contract

If any phase before finalization fails:

1. The file dialog must remain closable.
2. The user must see an inline error.
3. The asset must not become visible in the normal cloud list.
4. The client must call abort cleanup when applicable.
5. The server must eventually delete or garbage-collect the pending asset.

### Save As cancellation contract

If the user cancels during Save As:

1. In-flight HTTP requests should be aborted when possible.
2. The client must request pending-asset cleanup.
3. The dialog must return to an interactive state immediately.
4. No visible cloud asset may remain from that attempt.

## Open Operation Contract

### Required phases

Open must run through the following explicit phases:

1. `fetching_room_token`
2. `loading_room_state_via_http`
3. `initializing_bootstrap_bridge`
4. `loading_font_into_editor`
5. `attaching_live_room`
6. `completed`
7. `failed`
8. `cancelled`

### Open flow

1. Fetch a room token.
2. Load room state through HTTP `GET /room/:id/state`.
3. Initialize the bootstrap bridge from the HTTP state.
4. Load the editor font from that bootstrap bridge.
5. Attach the live room through WebSocket.

### Open failure contract

If any phase fails before completion:

1. The editor must not switch into a partially cloud-open state.
2. The user must see an inline error in the file browser or open flow.
3. The operation must not degrade into a hidden WebSocket bootstrap attempt.
4. If a temporary bootstrap bridge exists, it must be discarded cleanly.

## UI Requirements

### File dialog progress UI

The file dialog must show explicit staged progress for cloud operations.

For Save As, the dialog must be able to display messages such as:

1. Creating cloud asset...
2. Preparing room access...
3. Uploading initial font state...
4. Verifying room bootstrap...
5. Connecting live collaboration...
6. Finalizing cloud asset...

For Open, the dialog must be able to display messages such as:

1. Preparing room access...
2. Loading room state...
3. Opening font from room state...
4. Connecting live collaboration...

### File dialog interactivity

The dialog must not hard-disable both close and cancel for the whole lifetime
of the operation.

Requirements:

1. Cancel must remain available for all cancellable phases.
2. Close must remain available once the operation has failed.
3. The dialog must recover to an interactive state immediately after failure.

### Inline error presentation

Cloud save/open failures must surface inside the file dialog UI, not only via
`alert()`.

The dialog error state must include:

1. A short user-facing title.
2. A primary human-readable message.
3. Optional expandable technical detail.
4. A retry action when retry is safe.
5. A cancel or close action.
6. A debug-copy action when diagnostics exist.

### Persistent post-failure UI

After the dialog closes or is cancelled, the user must still be able to see
the failure state elsewhere in the app when relevant.

Allowed surfaces:

1. Plugin message banner.
2. Cloud asset row status.
3. Title-bar cloud status pill.

## Error Taxonomy

Cloud bootstrap failures must be classified into stable user-visible error
categories.

Required categories:

1. Authentication failed.
2. Authorization failed.
3. Asset quota exceeded.
4. Room seed rejected.
5. Room state unavailable.
6. Room bootstrap verification failed.
7. Timeout during HTTP transfer.
8. Network or cross-origin failure.
9. Unexpected server error.

The UI must present stable, human-readable messages for each category.
Raw browser or fetch errors may appear only as secondary technical detail.

## Observability and Diagnostics

### Correlation id

Every Save As and Open bootstrap operation must carry a shared operation id
through:

1. Asset creation.
2. Room token fetch.
3. HTTP room seed.
4. HTTP room bootstrap load.
5. Asset finalization.
6. Cleanup or abort calls.

The same id must appear in:

1. Client debug snapshots.
2. UI technical detail.
3. Website logs.
4. Worker logs.
5. Durable Object logs.

### Required structured server events

The backend must emit structured events for:

1. Pending asset created.
2. Room token issued.
3. HTTP seed started.
4. HTTP seed succeeded.
5. HTTP seed failed.
6. HTTP bootstrap verification started.
7. HTTP bootstrap verification succeeded.
8. HTTP bootstrap verification failed.
9. Asset finalized.
10. Pending asset cleanup requested.
11. Pending asset cleanup succeeded.
12. Pending asset cleanup failed.

## Server API Shape

Exact naming may vary, but the server must support the following logical
operations:

1. `createPendingAsset(name)`
2. `issueRoomToken(assetId)`
3. `finalizePendingAsset(assetId)`
4. `abortPendingAsset(assetId, reason)`
5. `cleanupExpiredPendingAssets()`

### Required semantics

1. `createPendingAsset` must not create a user-visible active asset.
2. `finalizePendingAsset` must fail unless room bootstrap has completed.
3. `abortPendingAsset` must be idempotent.
4. `cleanupExpiredPendingAssets` must be safe to run repeatedly.

## Client Implementation Requirements

### CloudAdapter requirements

1. Remove any fallback from HTTP bootstrap failure to WebSocket bootstrap.
2. Remove any fallback from HTTP seed failure to WebSocket seed-equivalent
   behavior.
3. Preserve WebSocket chunking only for oversized live packets.
4. Raise typed bootstrap errors instead of generic later sync failures.

### CloudPlugin requirements

1. Treat Save As and Open as phaseful operations with explicit status.
2. Distinguish pre-finalization bootstrap failure from post-attach live-sync
   failure.
3. Trigger cleanup or abort for failed pending assets.
4. Surface meaningful errors into file-dialog and plugin-message UI.

### File browser requirements

1. Replace the fully locked busy state for cloud Save As and Open with a
   cancellable staged progress state.
2. Render inline cloud operation errors inside the dialog.
3. Re-enable controls immediately after failure.

## Migration Requirements

The implementation must be staged so that no code path still relies on
WebSocket fallback for seed or load once the final flag is enabled.

Recommended order:

1. Add pending-asset lifecycle on the website backend.
2. Add finalize and abort cleanup APIs.
3. Add typed HTTP bootstrap verification on the client.
4. Remove HTTP-to-WebSocket fallback in `CloudAdapter` behind a temporary
   feature flag if necessary.
5. Update file-dialog UI to support staged progress and inline failure.
6. Remove the feature flag and old fallback behavior.

## Test Requirements

### Unit tests

1. Save As does not report success until finalize succeeds.
2. Save As failure before finalize triggers cleanup and leaves no visible
   asset.
3. Open fails immediately on HTTP bootstrap failure.
4. HTTP seed failure does not continue into WebSocket bootstrap.
5. HTTP load failure does not continue into WebSocket bootstrap.
6. File dialog returns to interactive state after cloud failure.

### Integration and Playwright tests

1. Save As with failing HTTP seed leaves no visible asset.
2. Save As with failing HTTP bootstrap verification leaves no visible asset.
3. Open with failing HTTP bootstrap shows a visible recoverable error.
4. Cancelling pending Save As leaves no visible asset.
5. Cloud error is shown in the dialog and can be dismissed without reloading
   the app.
6. WebSocket chunking remains available only for oversized live edit packets,
   not for room bootstrap.

## Acceptance Criteria

This spec is satisfied only when all of the following are true:

1. Save As cannot leave a visible asset behind after a failed bootstrap.
2. Open cannot silently degrade into a fallback bootstrap path.
3. All seed and load bootstrap paths are HTTP-only.
4. Bootstrap failures are visible in the UI.
5. The user can always recover control of the file dialog after failure.
6. Production logs can correlate a failed user-visible bootstrap with server
   events and cleanup outcomes.
