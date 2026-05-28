# Cloud Collaboration Implementation Plan

## Goal

Implement secure multi-user sharing for cloud fonts, harden the live
collaboration runtime for commercial use, and prepare the data model for future
restore features without building user-facing restore yet.

Primary outcomes:

1. Secure owner/editor/viewer access model enforced both in the website control
   plane and in the Durable Object room runtime.
2. Strong data-integrity guarantees around journaling, checkpoint promotion,
   validation, and retention.
3. Invite-based sharing for collaborators and viewers.
4. Ownership transfer flow with acceptance and quota checks.
5. Snapshot and metadata layout that can support later whole-font restore.
6. Centralized policy hooks that can absorb future subscription-based quotas
   and retention rules.

## Explicit Non-Goals For This Plan

1. User-facing restore UI.
2. User-facing snapshot browser.
3. User-facing cherry-pick restore actions.
4. Cross-document sharing or cross-document transactions.
5. Full subscription tier implementation.

## Current State Summary

What exists today:

1. Cloud asset CRUD in the website.
2. Membership and invitation tables in the website schema.
3. One Durable Object room per asset.
4. Yjs update journaling in DO SQLite.
5. One operational checkpoint object per room in R2 at
   `font-assets/{assetId}/current.yjs`.
6. Local collaboration workflow and tests.
7. Room tokens and website sessions that are currently unsigned base64 JSON.

Current risks:

1. Tokens are forgeable.
2. Debug room endpoints are too open for production use.
3. The room does not yet enforce owner/editor/viewer write rules.
4. The operational checkpoint path retains effectively one snapshot only.
5. Recovery material is not yet protected by a full runtime font validation gate
   before destructive cleanup.

## Implementation Priorities

Priority order:

1. Signed identity and room tokens.
2. Lock down debug and room control surfaces.
3. Enforce owner/editor/viewer in the room runtime.
4. Implement secure sharing for collaborators and viewers.
5. Implement ownership transfer with quota-aware acceptance.
6. Centralize quota and retention policy hooks now, with current temporary
   defaults.
7. Make the checkpoint path restore-ready and validation-gated for full-font
   checkpoints.
8. Add observability, operational controls, and cleanup policies.

## Phase 1: Signed Identity And Room Tokens

Goal: replace unsigned base64 session and room tokens with signed tokens that
the website issues and the room worker verifies.

### Tasks

- [x] Define a signed session token format for the website.
- [x] Define a signed room token format for room access.
- [x] Include `iss`, `aud`, `sub`, `assetId`, `role`, `iat`, `exp`, and an
      access-revision claim in room tokens.
- [x] Add signing key configuration and key rotation support via `kid`.
- [x] Add token verification helpers in the website and collab worker.
- [x] Replace current base64 room-token issuance in the website.
- [x] Replace current base64 session-token handling in the website.
- [x] Update the collab worker auth path to verify signed room tokens.
- [x] Reject expired, malformed, or wrong-audience tokens in the collab worker.
- [x] Store verified `userId`, `role`, `assetId`, and access revision in the
      WebSocket attachment.
- [x] Add tests for valid owner/editor/viewer auth.
- [x] Add tests for expired token rejection.
- [x] Add tests for wrong asset rejection.
- [x] Add tests for forged token rejection.
- [x] Add tests for key rotation behavior.

## Phase 2: Lock Down Debug And Room Control Surfaces

Goal: keep operational visibility while removing production exposure of room
state and raw log data.

### Tasks

- [x] Audit all room-worker HTTP endpoints for production exposure.
- [x] Require admin or service authentication for room status endpoints.
- [x] Require stronger admin or service authentication for room log endpoints.
- [x] Remove raw update payloads from normal status responses.
- [x] Remove room-content previews from default debug responses.
- [x] Add an explicit production flag for debug availability.
- [x] Restrict room-worker CORS to the actual editor origins.
- [x] Validate WebSocket `Origin` against allowed editor origins.
- [x] Add tests for authenticated access to room status.
- [x] Add tests for denied unauthenticated access to room log endpoints.

## Phase 3: Enforce Owner / Editor / Viewer In The Room Runtime

Goal: ensure the Durable Object itself enforces write access and does not rely
only on website-side ACL checks.

### Tasks

- [x] Define a final role matrix for room operations.
- [x] Persist the verified role in the WebSocket attachment.
- [x] Allow room open and sync-request for owner/editor/viewer.
- [x] Allow live update only for owner and editor.
- [x] Allow mutating sync-complete only for owner and editor.
- [x] Reject viewer update attempts with a clear room error and close reason.
- [x] Stop trusting any client-sent role or client identity fields.
- [x] Ensure viewers still receive room broadcasts and sync state.
- [x] Add tests that viewers can connect and sync.
- [x] Add tests that viewers cannot write.
- [x] Add tests that editors can write.
- [x] Add tests that owners can write.

## Phase 4: Secure Sharing For Collaborators And Viewers

Goal: implement invite-based sharing now for editors and viewers, with clear
membership management and revocation.

### Data Model Tasks

- [x] Review `font_asset_members` and `font_asset_invitations` for current
      suitability.
- [x] Add normalized email storage for invitations.
- [x] Add token hash storage for invitations instead of storing raw tokens.
- [x] Add invitation status fields for revoked, accepted, and expired state.
- [x] Add inviter metadata and resend metadata as needed.
- [x] Add `access_epoch` or equivalent revision field to `font_assets`.

### API Tasks

- [x] Add endpoint to list current asset members.
- [x] Add endpoint to create editor/viewer invitations.
- [x] Add endpoint to revoke pending invitations.
- [x] Add endpoint to accept an invitation.
- [x] Add endpoint to decline an invitation.
- [x] Add endpoint to change an existing member's role between editor and
      viewer.
- [x] Add endpoint to remove an existing member.

### Behavior Tasks

- [x] Restrict invitation creation to owners.
- [x] Require target role to be editor or viewer.
- [x] Require invitation acceptance by an authenticated user.
- [x] Require the accepting user's verified email to match the invited email.
- [x] Create or update the member row on acceptance.
- [x] Create the receiving user's `cloud_folder_entries` row on acceptance.
- [x] Increment the asset access epoch when invitations are accepted or members
      are changed.
- [x] Add audit events for invite create, revoke, accept, decline, role change,
      and remove.

### UI Tasks

- [x] Add an owner-only member list in the cloud asset UI.
- [x] Add owner controls to invite editor or viewer by email.
- [x] Add owner controls to revoke pending invitations.
- [x] Add owner controls to change member role.
- [x] Add owner controls to remove a member.
- [x] Add read-only role display for non-owners.
- [x] Add invitation acceptance flow in the website.
- [x] Add invitation email template.

### Test Tasks

- [x] Add API tests for invitation creation.
- [x] Add API tests for invitation revocation.
- [x] Add API tests for invitation acceptance.
- [x] Add API tests for role change.
- [x] Add API tests for member removal.
- [x] Add end-to-end test for editor invitation and write access.
- [x] Add end-to-end test for viewer invitation and read-only access.

## Phase 5: Ownership Transfer

Goal: let the current owner transfer a font to another user by email, with
explicit acceptance and quota checks.

### Data Model Tasks

- [x] Add a `font_asset_ownership_transfers` table.
- [x] Store source owner, target email, target user id, token hash, status, and
      timestamps.
- [x] Store the policy for the previous owner's role after transfer.
- [x] Add indexes for lookup by asset, token, and status.

### API Tasks

- [x] Add endpoint to create an ownership transfer request.
- [x] Add endpoint to inspect a transfer by token.
- [x] Add endpoint to accept a transfer.
- [x] Add endpoint to decline a transfer.
- [x] Add endpoint to cancel a pending transfer.

### Behavior Tasks

- [x] Restrict transfer creation to the current owner.
- [x] Require the target email to be normalized and stored securely.
- [x] Cancel or supersede existing pending transfers for the same asset.
- [x] Require acceptance by an authenticated user whose email matches the
      transfer target email.
- [x] Re-check that the accepting user can own the asset at acceptance time.
- [x] Update `font_assets.owner_user_id` only inside a transaction-safe flow.
- [x] Promote the accepting user to `owner` membership.
- [x] Demote the previous owner to the selected fallback role.
- [x] Ensure the target user has a folder entry for the asset.
- [x] Increment the asset access epoch on successful transfer.
- [x] Add audit events for transfer create, accept, decline, and cancel.

### UI Tasks

- [x] Add owner-only ownership transfer controls.
- [x] Let the owner choose the previous owner's fallback role after transfer.
- [x] Show pending transfer state and cancellation control.
- [x] Add transfer acceptance page in the website.
- [x] Add transfer email template.

### Test Tasks

- [x] Add API tests for transfer creation.
- [x] Add API tests for transfer cancellation.
- [x] Add API tests for transfer acceptance.
- [x] Add API tests for transfer decline.
- [x] Add end-to-end test for successful transfer.
- [x] Add end-to-end test for post-transfer owner capabilities.

## Phase 6: Quota And Subscription Policy Preparation

Goal: centralize current cloud eligibility, ownership caps, and retention
defaults behind the existing entitlement helpers so later subscription policy
can change without reopening call sites.

Scope note: this phase does not introduce the final structured policy object.
It keeps today's temporary policy surface centralized and explicit, and defers
collaborator caps plus richer retention policy until real subscription tiers
exist.

### Tasks

- [x] Centralize cloud hosting eligibility decisions in the entitlement helper
      module.
- [x] Centralize owned-font quota decisions in the entitlement helper module.
- [x] Centralize snapshot retention defaults in the entitlement helper module.
- [x] Use the centralized helpers during asset creation.
- [x] Use the centralized helpers during ownership transfer acceptance.
- [x] Keep the current temporary hosting default explicit: authenticated users
      may host cloud assets.
- [x] Keep the current temporary ownership cap explicit: one owned cloud asset
      per user.
- [x] Keep the current temporary snapshot-retention default explicit: named
      snapshot retention remains unlimited until that feature exists.
- [x] Add tests for the current helper defaults.

## Phase 7: Restore-Ready Snapshot Data Model

Goal: do not build user-facing restore now, but make operational and retained
snapshots structured enough to support future whole-font restore.

Scope note: this phase prepares immutable full-font checkpoint data in R2 only.
If named snapshots are added later, the website can add metadata rows that
store user-visible names and point at immutable R2 objects or manifests. That
website metadata layer is out of scope now. Defining cherry-pick semantics is
also out of scope now and should wait for later restore design.

### Tasks

- [x] Replace the single overwrite-in-place checkpoint model with immutable
      checkpoint objects.
- [x] Add a current checkpoint manifest pointer in R2.
- [x] Add a manifest format with asset id, room version, log id, schema
      versions, hash, byte length, and validation state.
- [x] Keep operational checkpoint objects distinct from future named snapshots.
- [x] Define R2 key layout for operational checkpoints, manifests, and future
      retained versions.
- [x] Reserve future retained-version objects for later website metadata
      without implementing that metadata layer yet.
- [x] Keep current operational retention separate from future user-facing
      retained versions.

## Phase 8: Runtime Babelfont Validation Before Destructive Cleanup

Goal: never let a malformed reconstructed font payload destroy recovery
material, while keeping live collaboration and repair attempts unblocked.

Scope note: validation in this phase is a promotion and prune gate, not a live
sync gate. Invalid candidate checkpoints must leave the room in a degraded
persistence state that preserves the last known-good operational checkpoint and
the unpruned journal so users can continue editing toward a repair.

### Tasks

- [x] Define the validation boundary on reconstructed candidate font payloads,
      not on individual live sync updates.
- [x] Make runtime validation non-blocking for live collaboration and required
      only for checkpoint promotion and destructive prune.
- [x] Use a collab-local Rust validator boundary for now, with a planned later
      swap to a babelfont-rs validator once one exists upstream.
- [x] Validate a reconstructed candidate font payload after candidate checkpoint
      write and before promotion.
- [x] Add semantic invariants that go beyond raw JSON parse and TypeScript shape
      validation.
- [x] Enter degraded persistence mode on validation failure instead of blocking
      live sync.
- [x] Keep journal rows intact on validation failure.
- [x] Preserve the prior known-good operational checkpoint on validation
      failure.
- [x] Surface degraded persistence status to connected clients so repair can be
      guided in the UI later.
- [x] Record validation failures as audit or operational events.
- [x] Add tests for validation failure preserving logs and prior checkpoints.
- [x] Add tests for validation success allowing later promotion and prune.

## Phase 9: Two-Phase Checkpoint Promotion And Retention

Goal: make checkpoint publication and log pruning safe under failures and keep a
short recovery window.

### Tasks

- [ ] Write candidate checkpoint objects to immutable R2 keys.
- [x] Validate candidate checkpoints before promotion.
- [x] Write a checkpoint manifest only after successful validation.
- [x] Promote the current manifest pointer only after manifest write succeeds.
- [x] Prune journal rows only after current manifest promotion succeeds.
- [ ] Retain at least `current + previous 2` operational checkpoints.
- [ ] Protect the current manifest target from cleanup.
- [ ] Add cleanup logic for superseded operational checkpoints beyond retention.
- [ ] Add recovery fallback logic from current checkpoint to previous
      checkpoints.
- [ ] Add tests for fallback to previous checkpoints.
- [ ] Add tests for missing current checkpoint manifest behavior.
- [ ] Add tests for checkpoint promotion race safety.

## Phase 10: Access Epoch And Live Revocation

Goal: support timely revocation and role changes for already-connected users,
not just future token issuance.

### Tasks

- [ ] Add `access_epoch` or equivalent revision field to the asset model.
- [ ] Include the access revision in room tokens.
- [ ] Increment access revision on member changes.
- [ ] Increment access revision on ownership transfer acceptance.
- [ ] Reject stale access-revision tokens during room auth.
- [ ] Add room-control path or equivalent mechanism to close stale sockets.
- [ ] Re-authenticate clients cleanly after access changes.
- [ ] Add tests for token rejection on stale access revision.
- [ ] Add tests for member removal affecting active room access.

## Phase 11: Sharing UI And Viewer Behavior

Goal: implement the user-facing sharing workflow now while keeping restore out
of scope.

### Tasks

- [ ] Add owner-facing member management UI.
- [ ] Add viewer-visible read-only role indication.
- [ ] Disable editing affordances in viewer mode.
- [ ] Ensure the server remains the source of truth for read-only enforcement.
- [ ] Surface invitation acceptance and pending membership states in the UI.
- [ ] Add error handling for revoked or expired invitations.
- [ ] Add error handling for write-forbidden viewer state.

## Phase 12: Audit Trail And Observability

Goal: make all access and integrity-sensitive actions auditable and operationally
visible.

### Tasks

- [ ] Define audit event names for sharing, ownership, auth, and checkpoint
      flows.
- [ ] Record invite lifecycle audit events.
- [ ] Record ownership transfer audit events.
- [ ] Record room-auth failure events.
- [ ] Record checkpoint candidate, validation, promotion, and prune events.
- [ ] Add metrics for checkpoint age, dirty journal size, and checkpoint
      failures.
- [ ] Add metrics for room load failures and reconnect loops.
- [ ] Add alerts for repeated validation failures.
- [ ] Add alerts for repeated checkpoint failures.
- [ ] Add alerts for storage-full conditions.

## Phase 13: Cost Controls And Retention Cleanup

Goal: keep the current Cloudflare architecture cost-efficient while adding the
new safety features.

### Tasks

- [ ] Coalesce alarm scheduling to avoid unnecessary storage writes.
- [ ] Avoid rescheduling alarms when an earlier suitable alarm already exists.
- [ ] Keep debug endpoints non-polling and admin-only.
- [ ] Keep D1 out of the high-frequency live update path.
- [ ] Keep R2 Standard storage for current operational checkpoints.
- [ ] Add lifecycle cleanup rules for temporary, quarantine, and migration
      objects.
- [ ] Add retention cleanup for superseded operational checkpoints.
- [ ] Add policy hooks for future plan-based snapshot retention windows.

## Execution Order

Recommended implementation order:

1. Signed identity and room tokens.
2. Lock down debug and room control surfaces.
3. DO role enforcement.
4. Sharing API and data model.
5. Sharing UI and invitation emails.
6. Ownership transfer API and data model.
7. Ownership transfer UI and emails.
8. Centralized quota helper updates.
9. Restore-ready full-font checkpoint manifest and retention model.
10. Runtime Babelfont validation gate.
11. Two-phase checkpoint promotion and prune protection.
12. Access epoch and live revocation.
13. Audit trail and observability.
14. Cost controls and cleanup policies.

## Delivery Gates

Minimum gate for shipping sharing:

- [ ] Signed website sessions are live.
- [ ] Signed room tokens are live.
- [ ] Room runtime enforces owner/editor/viewer.
- [ ] Invitation flow works end to end.
- [ ] Viewer mode is server-enforced.
- [x] Ownership transfer is implemented and quota-aware.
- [ ] Debug endpoints are locked down.

Minimum gate for shipping integrity hardening:

- [x] Runtime validation never blocks live sync and blocks destructive prune
      when candidate snapshots are malformed.
- [ ] Current plus previous operational checkpoints are retained.
- [ ] Recovery fallback from a prior checkpoint works.
- [ ] Checkpoint promotion is manifest-based and two-phase.
- [ ] Alerts exist for checkpoint and validation failures.

## Future Follow-Up After This Plan

This plan intentionally prepares, but does not implement, user-facing restore.
When restore work starts later, it should build on:

1. immutable retained checkpoints;
2. manifest pointers and immutable payload metadata;
3. validated Babelfont payloads;
4. a later decision about named-snapshot metadata rows; and
5. policy-driven retention and quota helpers.
