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
5. Snapshot and metadata layout that can support later whole-font restore and
   cherry-pick restore.
6. Policy hooks for future subscription-based quotas and retention rules.

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
6. Add quota and retention policy helpers now, with unlimited defaults.
7. Make the checkpoint path restore-ready and validation-gated.
8. Add observability, operational controls, and cleanup policies.

## Phase 1: Signed Identity And Room Tokens

Goal: replace unsigned base64 session and room tokens with signed tokens that
the website issues and the room worker verifies.

### Tasks

- [ ] Define a signed session token format for the website.
- [ ] Define a signed room token format for room access.
- [ ] Include `iss`, `aud`, `sub`, `assetId`, `role`, `iat`, `exp`, and an
      access-revision claim in room tokens.
- [ ] Add signing key configuration and key rotation support via `kid`.
- [ ] Add token verification helpers in the website and collab worker.
- [ ] Replace current base64 room-token issuance in the website.
- [ ] Replace current base64 session-token handling in the website.
- [ ] Update the collab worker auth path to verify signed room tokens.
- [ ] Reject expired, malformed, or wrong-audience tokens in the collab worker.
- [ ] Store verified `userId`, `role`, `assetId`, and access revision in the
      WebSocket attachment.
- [ ] Add tests for valid owner/editor/viewer auth.
- [ ] Add tests for expired token rejection.
- [ ] Add tests for wrong asset rejection.
- [ ] Add tests for forged token rejection.
- [ ] Add tests for key rotation behavior.

## Phase 2: Lock Down Debug And Room Control Surfaces

Goal: keep operational visibility while removing production exposure of room
state and raw log data.

### Tasks

- [ ] Audit all room-worker HTTP endpoints for production exposure.
- [ ] Require admin or service authentication for room status endpoints.
- [ ] Require stronger admin or service authentication for room log endpoints.
- [ ] Remove raw update payloads from normal status responses.
- [ ] Remove room-content previews from default debug responses.
- [ ] Add an explicit production flag for debug availability.
- [ ] Restrict room-worker CORS to the actual editor origins.
- [ ] Validate WebSocket `Origin` against allowed editor origins.
- [ ] Add tests for authenticated access to room status.
- [ ] Add tests for denied unauthenticated access to room log endpoints.

## Phase 3: Enforce Owner / Editor / Viewer In The Room Runtime

Goal: ensure the Durable Object itself enforces write access and does not rely
only on website-side ACL checks.

### Tasks

- [ ] Define a final role matrix for room operations.
- [ ] Persist the verified role in the WebSocket attachment.
- [ ] Allow room open and sync-request for owner/editor/viewer.
- [ ] Allow live update only for owner and editor.
- [ ] Allow mutating sync-complete only for owner and editor.
- [ ] Reject viewer update attempts with a clear room error and close reason.
- [ ] Stop trusting any client-sent role or client identity fields.
- [ ] Ensure viewers still receive room broadcasts and sync state.
- [ ] Add tests that viewers can connect and sync.
- [ ] Add tests that viewers cannot write.
- [ ] Add tests that editors can write.
- [ ] Add tests that owners can write.

## Phase 4: Secure Sharing For Collaborators And Viewers

Goal: implement invite-based sharing now for editors and viewers, with clear
membership management and revocation.

### Data Model Tasks

- [ ] Review `font_asset_members` and `font_asset_invitations` for current
      suitability.
- [ ] Add normalized email storage for invitations.
- [ ] Add token hash storage for invitations instead of storing raw tokens.
- [ ] Add invitation status fields for revoked, accepted, and expired state.
- [ ] Add inviter metadata and resend metadata as needed.
- [ ] Add `access_epoch` or equivalent revision field to `font_assets`.

### API Tasks

- [ ] Add endpoint to list current asset members.
- [ ] Add endpoint to create editor/viewer invitations.
- [ ] Add endpoint to revoke pending invitations.
- [ ] Add endpoint to accept an invitation.
- [ ] Add endpoint to decline an invitation.
- [ ] Add endpoint to change an existing member's role between editor and
      viewer.
- [ ] Add endpoint to remove an existing member.

### Behavior Tasks

- [ ] Restrict invitation creation to owners.
- [ ] Require target role to be editor or viewer.
- [ ] Require invitation acceptance by an authenticated user.
- [ ] Require the accepting user's verified email to match the invited email.
- [ ] Create or update the member row on acceptance.
- [ ] Create the receiving user's `cloud_folder_entries` row on acceptance.
- [ ] Increment the asset access epoch when invitations are accepted or members
      are changed.
- [ ] Add audit events for invite create, revoke, accept, decline, role change,
      and remove.

### UI Tasks

- [ ] Add an owner-only member list in the cloud asset UI.
- [ ] Add owner controls to invite editor or viewer by email.
- [ ] Add owner controls to revoke pending invitations.
- [ ] Add owner controls to change member role.
- [ ] Add owner controls to remove a member.
- [ ] Add read-only role display for non-owners.
- [ ] Add invitation acceptance flow in the website.
- [ ] Add invitation email template.

### Test Tasks

- [ ] Add API tests for invitation creation.
- [ ] Add API tests for invitation revocation.
- [ ] Add API tests for invitation acceptance.
- [ ] Add API tests for role change.
- [ ] Add API tests for member removal.
- [ ] Add end-to-end test for editor invitation and write access.
- [ ] Add end-to-end test for viewer invitation and read-only access.

## Phase 5: Ownership Transfer

Goal: let the current owner transfer a font to another user by email, with
explicit acceptance and quota checks.

### Data Model Tasks

- [ ] Add a `font_asset_ownership_transfers` table.
- [ ] Store source owner, target email, target user id, token hash, status, and
      timestamps.
- [ ] Store the policy for the previous owner's role after transfer.
- [ ] Add indexes for lookup by asset, token, and status.

### API Tasks

- [ ] Add endpoint to create an ownership transfer request.
- [ ] Add endpoint to inspect a transfer by token.
- [ ] Add endpoint to accept a transfer.
- [ ] Add endpoint to decline a transfer.
- [ ] Add endpoint to cancel a pending transfer.

### Behavior Tasks

- [ ] Restrict transfer creation to the current owner.
- [ ] Require the target email to be normalized and stored securely.
- [ ] Cancel or supersede existing pending transfers for the same asset.
- [ ] Require acceptance by an authenticated user whose email matches the
      transfer target email.
- [ ] Re-check that the accepting user can own the asset at acceptance time.
- [ ] Update `font_assets.owner_user_id` only inside a transaction-safe flow.
- [ ] Promote the accepting user to `owner` membership.
- [ ] Demote the previous owner to the selected fallback role.
- [ ] Ensure the target user has a folder entry for the asset.
- [ ] Increment the asset access epoch on successful transfer.
- [ ] Add audit events for transfer create, accept, decline, and cancel.

### UI Tasks

- [ ] Add owner-only ownership transfer controls.
- [ ] Let the owner choose the previous owner's fallback role after transfer.
- [ ] Show pending transfer state and cancellation control.
- [ ] Add transfer acceptance page in the website.
- [ ] Add transfer email template.

### Test Tasks

- [ ] Add API tests for transfer creation.
- [ ] Add API tests for transfer cancellation.
- [ ] Add API tests for transfer acceptance.
- [ ] Add API tests for transfer decline.
- [ ] Add end-to-end test for successful transfer.
- [ ] Add end-to-end test for post-transfer owner capabilities.

## Phase 6: Quota And Subscription Policy Preparation

Goal: prepare all ownership, sharing, and snapshot paths to consume
subscription-based policy later without enforcing artificial limits today.

### Tasks

- [ ] Replace separate quota helpers with a structured cloud policy helper.
- [ ] Represent `maxFontsOwned` in the policy helper.
- [ ] Represent collaborator limits in the policy helper.
- [ ] Represent snapshot retention limits in the policy helper.
- [ ] Represent operational checkpoint retention count in the policy helper.
- [ ] Use the policy helper during asset creation.
- [ ] Use the policy helper during invitation creation.
- [ ] Use the policy helper during ownership transfer acceptance.
- [ ] Return unlimited defaults for current production behavior.
- [ ] Add tests for unlimited default policy.
- [ ] Add tests for quota-blocked ownership transfer with mocked limited policy.

## Phase 7: Restore-Ready Snapshot Data Model

Goal: do not build user-facing restore now, but make operational and retained
snapshots structured enough to support future whole-font and cherry-pick restore.

### Tasks

- [ ] Replace the single overwrite-in-place checkpoint model with immutable
      checkpoint objects.
- [ ] Add a current checkpoint manifest pointer in R2.
- [ ] Add a manifest format with asset id, room version, log id, schema
      versions, hash, byte length, and validation state.
- [ ] Add an index sidecar format with glyph, layer, master, and section-level
      hashes for future restore tooling.
- [ ] Keep operational checkpoint objects distinct from future named snapshots.
- [ ] Define R2 key layout for operational checkpoints, manifests, and future
      retained versions.
- [ ] Record enough stable identifiers in the checkpoint index for later
      cherry-pick operations.
- [ ] Keep current operational retention separate from future user-facing
      retained versions.

## Phase 8: Runtime Babelfont Validation Before Destructive Cleanup

Goal: never prune recovery material based only on Yjs validity; require a valid
runtime font payload before destructive cleanup.

### Tasks

- [ ] Define the runtime Babelfont validation boundary for checkpoint
      candidates.
- [ ] Choose the runtime validator approach for the room worker.
- [ ] Validate a reconstructed candidate font payload after checkpoint write and
      before promotion.
- [ ] Add semantic invariants that go beyond TypeScript shape validation.
- [ ] Fail checkpoint promotion if runtime validation fails.
- [ ] Keep journal rows intact on validation failure.
- [ ] Preserve prior operational checkpoints on validation failure.
- [ ] Record validation failures as audit or operational events.
- [ ] Add tests for validation failure preserving logs.
- [ ] Add tests for validation success allowing prune.

## Phase 9: Two-Phase Checkpoint Promotion And Retention

Goal: make checkpoint publication and log pruning safe under failures and keep a
short recovery window.

### Tasks

- [ ] Write candidate checkpoint objects to immutable R2 keys.
- [ ] Validate candidate checkpoints before promotion.
- [ ] Write a checkpoint manifest only after successful validation.
- [ ] Promote the current manifest pointer only after manifest write succeeds.
- [ ] Prune journal rows only after current manifest promotion succeeds.
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
8. Structured quota policy helper.
9. Restore-ready checkpoint manifest and retention model.
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
- [ ] Ownership transfer is implemented and quota-aware.
- [ ] Debug endpoints are locked down.

Minimum gate for shipping integrity hardening:

- [ ] Runtime validation blocks destructive prune when snapshot candidates are
      malformed.
- [ ] Current plus previous operational checkpoints are retained.
- [ ] Recovery fallback from a prior checkpoint works.
- [ ] Checkpoint promotion is manifest-based and two-phase.
- [ ] Alerts exist for checkpoint and validation failures.

## Future Follow-Up After This Plan

This plan intentionally prepares, but does not implement, user-facing restore.
When restore work starts later, it should build on:

1. immutable retained checkpoints;
2. manifest and index sidecars;
3. stable glyph/layer/master identifiers;
4. validated Babelfont payloads;
5. policy-driven retention and quota helpers.