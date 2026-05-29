# Cloud Collaboration Production Readiness Remediation Plan

## Goal

Bring hosted cloud collaboration from a validated alpha happy path to a
production-ready system whose access controls, persistence behavior, and runtime
costs remain safe under long-lived rooms, network failures, stale clients, and
hostile input.

This plan addresses the final review findings from the multi-user collaboration
readiness pass. The current system can successfully run invited editor and viewer
flows, keeps normal remote outline edits on the editing fast path, and showed low
room-worker CPU during a warm multi-user test. Production readiness is still
blocked by several security and resource-hardening issues.

## Production Readiness Definition

The system is production-ready only when all of these are true:

1. Production APIs do not grant credentialed access to development origins.
2. Session tokens are never leaked to arbitrary redirect targets or durable
   browser history URLs.
3. Membership revocation and role demotion reliably remove stale room write
   access from already-connected clients.
4. The Durable Object room has explicit per-client and per-room memory bounds.
5. Room bootstrap payloads remain bounded for long-lived rooms.
6. Invite, membership, audit, and room-notification state changes are either
   atomic or recoverable through durable retry.
7. The production readiness gates at the end of this document pass in CI and in
   a staging deployment.

## Current Validation Baseline

Already passing at the time this plan was written:

1. `cd ../collab/collab && npm test`: 68 room-worker tests passed.
2. `cd ../website && npx vitest run test/cloud-sharing-api.test.js`: 13
   cloud-sharing API tests passed.
3. `cd webapp && npx playwright test tests/cloud-collaboration-local.spec.ts -g
"multi-user cloud outline edits stay on the editing fast path"`: passed
   against warm local services.
4. `cd webapp && npx playwright test tests/cloud-collaboration-local.spec.ts -g
"accepts an editor invite and allows live edits from the invited account"`:
   passed.

These tests are necessary but not sufficient for production readiness.

## Issue 1: Credentialed Production CORS Allows Development Origins

### Risk

The website middleware currently accepts localhost origins and returns
credentialed CORS headers. The production session cookie uses `SameSite=None`, so
credentialed production API responses can be exposed to a malicious local origin.
The room worker has a similar local-origin allowance. Tokens still protect many
paths, but production should not trust arbitrary local origins.

Primary files:

1. `../website/functions/_middleware.js`
2. `../collab/collab/src/index.js`
3. `../website/functions/api/auth/verify.js`
4. `../website/functions/api/auth/verify-email-change.js`

### Design

Use explicit environment-scoped origin policy.

1. Production accepts only configured production origins.
2. Preview accepts production plus configured preview origins.
3. Localhost and arbitrary local ports are accepted only when `LOCAL_DEV ===
"true"` or when the request host itself is local.
4. Credentialed CORS must never be returned for an unconfigured production
   origin.
5. The website and room worker must share the same origin policy vocabulary:
   `WEBSITE_ALLOWED_ORIGINS`, `EDITOR_ALLOWED_ORIGINS`, and `LOCAL_DEV`.

### Implementation Checklist

- [x] Add a shared origin normalization helper in the website, or a small local
      helper near `_middleware.js`, that accepts localhost only in local/dev
      mode.
- [x] Replace the unconditional localhost allowance in
      `../website/functions/_middleware.js` with the environment-gated helper.
- [x] Replace the unconditional localhost allowance in
      `../collab/collab/src/index.js` with the same rule.
- [x] Add a production default deny behavior for unknown origins: no
      `Access-Control-Allow-Origin`, no `Access-Control-Allow-Credentials`, and
      no useful preflight grant.
- [ ] Keep local worktree support by setting `LOCAL_DEV=true` in local wrangler
      state and local Playwright helpers.
- [x] Remove or reduce auth-token prefix logging in middleware so production
      logs do not contain reusable token material.
- [x] Confirm website session cookies include `HttpOnly`, `Secure`, and an
      intentionally chosen `SameSite` value.
- [x] If cross-site editor handoff still requires `SameSite=None`, document why
      and ensure it is paired with strict origin checks.

### Test Checklist

- [x] Add website middleware tests: production rejects
      `http://localhost:9999` as a credentialed origin.
- [x] Add website middleware tests: production accepts
      `https://editor.counterpunch.space`.
- [x] Add website middleware tests: local/dev accepts localhost worktree
      origins.
- [x] Add room-worker tests: production rejects localhost websocket origins.
- [x] Add room-worker tests: local/dev accepts localhost websocket origins.
- [ ] Add a staging smoke test that calls a credentialed website endpoint from
      an unlisted origin and verifies that the browser cannot read the response.

### Done When

- [x] Production has no credentialed localhost CORS path.
- [x] Local Playwright collaboration tests still work without hard-coded
      production exceptions.
- [x] The policy is documented in deployment configuration.

## Issue 2: Magic-Link `returnTo` Can Leak Session Tokens Cross-Origin

### Risk

The login request stores caller-provided `returnTo`, and verification appends
`session=<token>` to cross-origin redirects. Without a strict allowlist, this is
an account takeover risk: a victim can be redirected to an attacker-controlled
origin with a fresh session token in the URL.

Primary files:

1. `../website/functions/api/auth/request-login.js`
2. `../website/functions/api/auth/verify.js`
3. `../website/utils/auth.js`
4. Editor-side login handoff code that consumes `?session=`.

### Design

Use a two-stage fix.

Stage 1 is the immediate production blocker fix:

1. Validate `returnTo` at request time against an allowlist.
2. Reject or coerce invalid values to `/`.
3. Never redirect a session token to an unrecognized origin.

Stage 2 removes session tokens from URLs entirely:

1. Replace `?session=` with a one-time handoff code.
2. Store handoff codes in D1 with a short TTL, target origin, user id, and used
   flag.
3. The editor exchanges the handoff code for a session token through a
   credentialed, origin-checked endpoint.
4. The handoff code must be audience-bound to the exact editor origin.

### Implementation Checklist

- [x] Add `isAllowedAuthRedirect(returnTo, request, env)`.
- [x] Allow only same-origin relative paths by default.
- [x] Allow editor origins only from a configured allowlist.
- [x] Reject protocol-relative URLs, invalid URLs, non-HTTP(S) schemes, and
      origins outside the allowlist.
- [x] Store a normalized redirect target, not the raw input.
- [x] Update `request-login.js` to validate before inserting `auth_tokens`.
- [x] Update `verify.js` to revalidate stored `return_to` before redirecting.
- [x] Add `auth_handoff_tokens` or equivalent D1 table for one-time editor
      handoff codes.
- [x] Add a `POST /api/auth/exchange-handoff` endpoint that checks origin,
      expiry, target origin, and used state before returning a session token.
- [x] Update the editor to consume handoff codes rather than `?session=`.
- [x] Remove session-token query logging and scrub any existing debug logs that
      print redirect URLs with tokens.
- [x] Add cleanup for expired handoff tokens.

### Test Checklist

- [x] Unit test that arbitrary `https://evil.example` return targets are
      rejected or coerced.
- [x] Unit test that `javascript:`, `data:`, and protocol-relative redirect
      values are rejected.
- [x] Unit test that configured editor origins are accepted.
- [x] Unit test that `verify.js` refuses an invalid stored `return_to`, even if
      it somehow reached D1.
- [x] Unit test that a handoff code can be exchanged once.
- [x] Unit test that a handoff code cannot be exchanged from the wrong origin.
- [x] Playwright test for website login to editor using the handoff-code flow.

### Done When

- [x] No fresh session token is ever appended to an arbitrary URL.
- [x] No production code path requires a reusable session token in a query
      string.
- [ ] The editor login flow still works for production, preview, and local dev.

## Issue 3: Access Revocation Is Best-Effort For Already-Connected Clients

### Risk

Member role changes, member removal, invitation acceptance, and ownership
transfer bump `font_assets.access_epoch`, then best-effort notify the room DO.
If the room-control call fails, existing sockets can continue with stale
attachments until a later successful epoch update reaches the DO. This is most
severe for member removal or editor-to-viewer demotion.

Primary files:

1. `../website/functions/api/cloud/assets/[id]/members/[userId].js`
2. `../website/functions/api/cloud/invitations/accept.js`
3. `../website/functions/api/cloud/ownership-transfers/accept.js`
4. `../website/utils/cloud-room-control.js`
5. `../collab/collab/src/font-room-do.js`

### Design

Make access epoch propagation durable and observable.

1. The website remains the source of truth for membership and `access_epoch`.
2. The room DO remains the active socket enforcer.
3. Every access-epoch bump creates a durable notification record in D1.
4. Room-control delivery is retried until the DO acknowledges the target epoch.
5. High-risk mutations, especially removal and demotion, should either fail
   closed when notification cannot be enqueued or return a pending state that
   blocks further writes from that user through token issuance.

### Implementation Checklist

- [x] Add an `asset_access_epoch_notifications` table with `id`, `asset_id`,
      `access_epoch`, `reason`, `status`, `attempt_count`, `last_error`,
      `created_at`, `updated_at`, and `next_attempt_at`.
- [x] Wrap membership mutation and notification enqueue in one D1 batch or
      transaction-equivalent flow.
- [x] Change `notifyRoomAccessEpoch` from best-effort side effect to a delivery
      function that records success/failure against the notification row.
- [x] Add a retry worker path. Options: a scheduled Worker, a website admin
      repair endpoint, or a queue-style Durable Object for access notifications.
- [x] Make role demotion and removal return an explicit warning or pending
      state if the DO could not be reached immediately.
- [x] Ensure `/room-token` always issues tokens with the latest D1
      `access_epoch`.
- [x] Teach the editor to close or reconnect when it receives stale-access or
      role-change errors.
- [x] Add room status fields for current access epoch and last access-control
      notification time.
- [x] Add admin tooling to replay pending access epoch notifications.

### Test Checklist

- [x] Website unit test: member removal enqueues access notification in the same
      flow as the membership delete.
- [x] Website unit test: role demotion enqueues notification.
- [x] Website unit test: invitation acceptance enqueues notification.
- [x] Room-worker unit test: control request advances epoch and closes stale
      editor sockets.
- [x] Integration test: if initial notify fails, retry later closes the stale
      socket.
- [x] Playwright test: removed editor cannot continue editing in an already-open
      browser context.
- [x] Playwright test: editor demoted to viewer loses write access without a
      manual reload.

### Done When

- [x] A failed transient room-control call cannot silently leave a removed
      editor with long-lived write access.
- [ ] Pending epoch notifications are visible to operators.
- [x] Stale access cleanup is covered by tests at API, room-worker, and browser
      levels.

## Issue 4: DO Sync Chunk Handling Has No Explicit Resource Bounds

### Risk

Authenticated clients can send `sync-chunk` frames that allocate per-client
chunk buffers. The current path validates basic chunk shape but does not cap
total chunk count, total byte size, chunk age, or viewer participation. Close and
error handlers schedule flushes but do not clear pending chunk buffers. This is
a memory-pressure and cost-control issue.

Primary file:

1. `../collab/collab/src/font-room-do.js`

### Design

Bound chunk upload state at every layer.

1. Only owner/editor sockets may upload mutating sync chunks.
2. Sync chunks must have explicit max total chunks and max total decoded bytes.
3. Pending chunk state must expire quickly.
4. Pending chunk state must be cleared on close, error, auth failure, role
   failure, mismatched totals, and sync-complete failure.
5. Exceeding resource limits closes the socket with a stable close reason.

### Implementation Checklist

- [x] Add constants such as `MAX_SYNC_UPLOAD_CHUNKS`,
      `MAX_SYNC_UPLOAD_BYTES`, `MAX_SYNC_CHUNK_BASE64_BYTES`, and
      `SYNC_CHUNK_TTL_MS`.
- [x] Extend `_clientChunks` state to include `createdAt`, `updatedAt`, and
      `totalBytes`.
- [x] Reject `sync-chunk` from viewers before decoding and storing the chunk.
- [x] Reject chunk descriptors whose `totalChunks` exceeds the max.
- [x] Reject individual base64 frames above the configured max.
- [x] Track decoded bytes as chunks arrive and reject once the total exceeds the
      max.
- [x] Clear pending chunks for the client in `webSocketClose` and
      `webSocketError`.
- [x] Clear stale pending chunks opportunistically before accepting a new chunk.
- [x] Add operational event counters for chunk-limit rejection and chunk-timeout
      cleanup.
- [x] Document the configured limits in the room-worker README or strategy
      comments.

### Test Checklist

- [x] Unit test: viewer `sync-chunk` is rejected and closed.
- [x] Unit test: excessive `totalChunks` is rejected.
- [x] Unit test: excessive accumulated bytes are rejected.
- [x] Unit test: close clears `_clientChunks` for that client.
- [x] Unit test: error clears `_clientChunks` for that client.
- [x] Unit test: stale chunk state is expired before accepting more chunks.
- [x] Load test: repeated malicious chunk attempts do not grow DO memory
      without bound.

### Done When

- [x] The room has a documented maximum memory footprint for partial sync
      uploads.
- [x] All client-controlled chunk buffers have cleanup paths.
- [x] Chunk abuse shows up in operational metrics.

## Issue 5: Mutation History Grows Without Bound And Is Sent In Bootstrap

### Risk

The DO appends collaboration message envelopes to `_mutationBatchHistory`, sends
the full history in every `sync-response`, and stores the full history with each
checkpoint. The Yjs document is chunked, but the history JSON header is not. A
long-lived room can eventually make bootstrap slow, expensive, or too large to
send.

Primary file:

1. `../collab/collab/src/font-room-do.js`

### Design

Make mutation history a bounded metadata stream, separate from authoritative
Yjs state.

1. Yjs remains the only authoritative document state.
2. Collaboration message history is advisory metadata for UI/history recovery.
3. The DO should keep only the history range needed by currently expected
   clients.
4. New clients should receive a bounded tail or a checkpoint-aligned history
   window, never an unbounded array.
5. Older history can be summarized, paginated through a debug/admin endpoint, or
   omitted entirely if it is not required for convergence.

### Implementation Checklist

- [ ] Define the minimum collaboration history required for a fresh client to
      render useful history UI.
- [x] Add retention settings such as `MAX_MUTATION_HISTORY_ENVELOPES` and
      `MAX_MUTATION_HISTORY_BYTES`.
- [x] Trim `_mutationBatchHistory` after every append.
- [x] Store `firstRetainedLogId`, `lastRetainedLogId`, and truncation metadata
      in mutation-history snapshots.
- [x] Change `sync-response` to send only the retained history tail.
- [ ] If the editor needs older history, add an explicit paginated history API
      rather than expanding the bootstrap frame.
- [x] Ensure checkpoint promotion writes bounded mutation history.
- [x] Ensure checkpoint fallback/reload handles truncated history metadata.
- [x] Add room status metrics for retained history count and bytes.

### Test Checklist

- [x] Unit test: history is trimmed by envelope count.
- [x] Unit test: history is trimmed by byte budget.
- [x] Unit test: sync response never exceeds the configured metadata byte
      budget.
- [x] Unit test: checkpoint snapshot stores truncation metadata.
- [x] Unit test: reload from checkpoint preserves only the retained window.
- [ ] Playwright test: long edit sequence still lets a new collaborator join.
- [ ] Load test: bootstrap time stays within budget after thousands of edits.

### Done When

- [x] Room bootstrap payload size is bounded independently of room age.
- [x] Long-lived rooms do not repeatedly write unbounded metadata to R2.
- [ ] The UI degrades gracefully when older advisory history is truncated.

## Issue 6: Invite, Audit, And Membership Persistence Is Not Fully Atomic

### Risk

Several website flows perform multiple D1 writes and external effects in
sequence. Invitation creation now survives email delivery failures, but audit
failure after invite insertion can still produce a client-visible failure while
the invite exists and might have been emailed. Invitation acceptance and member
mutation flows also update several tables and then notify the room outside a
single durable recovery model.

Primary files:

1. `../website/functions/api/cloud/assets/[id]/invitations/index.js`
2. `../website/functions/api/cloud/invitations/accept.js`
3. `../website/functions/api/cloud/assets/[id]/members/[userId].js`
4. `../website/functions/api/cloud/ownership-transfers/accept.js`
5. `../website/utils/cloud-sharing.js`
6. `../website/utils/cloud-room-control.js`

### Design

Separate durable state transitions from external delivery, then make all
external effects replayable.

1. D1 state changes should be batched whenever D1 supports it for the local
   operation.
2. Audit event recording should not make the primary state transition
   ambiguous.
3. Email delivery should be an outbox item, not a synchronous requirement for
   invite creation.
4. Room-control notification should be an outbox item for access-sensitive
   transitions.
5. API responses should clearly distinguish `created`, `emailQueued`,
   `emailDelivered`, `auditRecorded`, and `roomNotificationQueued`.

### Implementation Checklist

- [x] Add a durable outbox table for email events, or extend the invitation
      table with a clear `email_delivery_status` state machine.
- [ ] Insert invitation and audit state in one batch where possible.
- [x] If audit insert fails, return a deterministic response that includes the
      created invitation rather than surfacing a generic fetch failure.
- [x] Move email delivery to an outbox processor, retry endpoint, or scheduled
      worker.
- [x] Store delivery attempts and last error for support visibility.
- [ ] For acceptance/member/transfer flows, batch membership table updates,
      folder entries, access epoch bump, audit event, and notification enqueue.
- [ ] Make all externally visible side effects idempotent by stable operation
      id.
- [ ] Add repair tooling to replay incomplete audit/email/room-notification
      outbox entries.
- [x] Ensure local schema bootstrap includes all new outbox columns and indexes.

### Test Checklist

- [x] Unit test: invitation remains visible if email delivery fails.
- [x] Unit test: invitation creation response is deterministic if audit insert
      fails after the invite insert.
- [x] Unit test: duplicate invite create retries do not send duplicate active
      invitations for the same email/asset.
- [x] Unit test: email outbox retry is idempotent.
- [x] Unit test: access notification outbox retry is idempotent.
- [x] Integration test: member removal with initial room-control failure is
      repaired by retry and closes stale sockets.
- [x] Migration test: stale local D1 state receives all new columns on startup.

### Done When

- [ ] No API returns an ambiguous failure after creating a durable invitation or
      membership mutation.
- [ ] Every external side effect can be retried safely.
- [ ] Operators can see and repair pending email, audit, and room-control
      delivery failures.

## Issue 7: Production CPU And Latency Budgets Need Server-Side Telemetry

### Risk

The local warm multi-user run showed that browser compile/render work dominated
CPU and the local room-worker stayed near idle. That is encouraging but not a
Cloudflare billing proof. Production cost depends on per-message CPU time,
storage writes, R2 checkpoint cost, fanout count, reconnect loops, and bootstrap
payload size.

Primary files:

1. `../collab/collab/src/font-room-do.js`
2. `../collab/collab/src/index.js`
3. `../website/utils/cloud-sharing.js`
4. `webapp/tests/cloud-collaboration-local.spec.ts`

### Design

Add lightweight server-side observability with strict budgets.

1. Measure per-update DO work, not just process CPU.
2. Track fanout count, update bytes, journal rows, checkpoint bytes, and
   bootstrap bytes.
3. Expose aggregated status to admin/debug endpoints without raw payloads.
4. Fail tests if regression scenarios exceed conservative budgets.

### Implementation Checklist

- [x] Add per-message timing around auth, sync-request, sync-complete, update,
      checkpoint, and room-control paths.
- [x] Track counters for update bytes in, update bytes out, peers fanned out,
      journal rows written, and R2 bytes written.
- [x] Track bootstrap metadata bytes separately from Yjs update bytes.
- [x] Add rolling max/average fields to room status.
- [x] Keep metrics payloads small and free of font content.
- [x] Add a local Playwright or node harness that performs a fixed multi-user
      edit burst and records room status before/after.
- [ ] Define initial budgets for staging, then tighten with real production
      data.

Current enforced local edit-burst budget:

1. A fixed authenticated two-peer burst of 5 updates must keep
   `update.metadataBytesTotal === 0` for plain outline edits.
2. That same burst must keep `update.bytesOutTotal < 10_000` in the room
   status runtime metrics.

### Test Checklist

- [x] Unit test: room status includes timing and byte metrics without raw update
      payloads.
- [x] Unit test: fanout count increments exactly by authenticated peer count.
- [x] Integration test: fixed edit burst stays below an update-byte and
      metadata-byte budget.
- [ ] Staging test: room-worker CPU time and subrequest counts are reported for
      a real invited-editor session.
- [x] Alert test: reconnect loop and checkpoint failure alerts fire when
      thresholds are exceeded.

### Done When

- [ ] Production cost can be estimated from room metrics, not local Activity
      Monitor samples.
- [ ] Bootstrap and edit latency have explicit budgets.
- [ ] Operators can identify whether cost is browser compile, DO fanout,
      checkpointing, reconnect loops, or website control-plane traffic.

## Suggested Implementation Order

1. Fix credentialed CORS and magic-link redirect/session-token handling first.
   These are security blockers independent of collaboration load.
2. Add durable access-epoch notification and stale-socket revocation next. This
   closes the most important collaboration authorization gap.
3. Add DO chunk bounds and cleanup. This protects room CPU and memory from
   malicious or broken clients.
4. Bound mutation history and bootstrap metadata. This protects long-lived rooms
   and R2 writes.
5. Convert invitation/email/audit/room-notification delivery into outbox-style
   recoverable flows.
6. Add server-side CPU and latency metrics, then define staging budgets.

## Production Readiness Gate Checklist

### Security Gates

- [x] Production credentialed CORS accepts only configured production/preview
      origins.
- [x] Localhost origins are accepted only in local/dev mode.
- [x] Login redirect targets are allowlisted.
- [x] Session tokens are not sent to arbitrary URLs.
- [x] Session cookies are `HttpOnly` unless there is a documented exception.
- [x] Room tokens remain short-lived, signed, audience-bound, and asset-bound.
- [x] Debug room endpoints require authenticated admin/service access.
- [x] Removed and demoted editors lose write access without a manual reload.

### Persistence Gates

- [x] Every live update is journaled before broadcast.
- [x] Duplicate updates are idempotently acknowledged without replay.
- [x] Checkpoint validation failure preserves journal rows.
- [x] Checkpoint promotion cannot delete updates that arrive during promotion.
- [x] Current manifest fallback works when the latest checkpoint target is
      missing.
- [x] Mutation history is bounded and checkpoint reload handles truncation.
- [ ] Invite/member/audit/email/room-notification flows are unambiguous and
      repairable.

### CPU And Cost Gates

- [ ] Per-update DO metrics are recorded in staging.
- [x] Bootstrap metadata bytes are bounded.
- [x] Partial sync uploads have explicit memory limits.
- [x] Room update fanout is linear only in authenticated peer count.
- [x] Room status/debug responses do not include raw font or Yjs payloads by
      default.
- [ ] Local and staging edit-burst runs stay within agreed latency and CPU
      budgets.

### Test Gates

- [x] `cd ../collab/collab && npm test`
- [x] `cd ../website && npm test`
- [x] `cd webapp && npm run test:ci`
- [x] Invited-editor Playwright collaboration test.
- [x] Invited-viewer read-only Playwright collaboration test.
- [x] Removed-editor stale-socket Playwright test.
- [x] Long-lived-room bootstrap Playwright or node integration test.
- [ ] Staging smoke test with production-like secrets and origin allowlists.

## Final Ship Rule

Do not enable production cloud collaboration for real users until all high-risk
sections above are complete and the production readiness gate checklist passes.
The current system is suitable for continued alpha testing and local/staging
validation, but not for unrestricted production use.
