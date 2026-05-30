# Cloud Transport Reliability Plan

This document tracks the implementation work needed to make cloud collaboration transport and reconnect behavior robust, predictable, and visibly trustworthy.

## Goals

- [x] Keep Yjs as the authoritative document state transport.
- [x] Preserve semantic sidecars for live connected fast-path rendering.
- [x] Treat reconnect as an explicit state rebaseline boundary.
- [x] Rebuild all visible surfaces from authoritative state after reconnect.
- [x] Preserve cloud-bound local work across transient socket loss.
- [x] Make degraded/reconnecting state much more visible in the title area.
- [x] Persist the cloud outbox across full page reloads or crashes.
- [x] Introduce server-side idempotent client transaction IDs independent of socket session IDs.

## Scope

- [x] Client reconnect reliability in `webapp/js/cloud-adapter.ts`
- [x] Client-visible cloud status in `webapp/js/font-manager.ts` and CSS
- [x] Reconnect rebaseline of editing font, glyph canvas, glyph overview, font-info surfaces, and visible text shaping
- [x] Targeted regression coverage for reconnect/rebaseline behavior
- [x] DO-side durable protocol upgrades for cross-session resend and idempotent dedupe

## Design

### Live connected path

- [x] Continue sending binary Yjs updates as the authoritative state transport.
- [x] Continue sending semantic sidecars on live committed packets for fast-path rendering and cache refresh.

### Reconnect path

- [x] After reconnect, treat the document as entering a rebaseline phase.
- [x] Apply the authoritative Yjs server state/diff first.
- [x] Re-send missing local state through the existing Yjs sync-complete diff.
- [x] Do not require sidecar replay to restore correctness after reconnect.
- [x] Rebuild visible surfaces from state before reporting `connected` again.

### Visible surfaces to rebuild

- [x] Editing font
- [x] Visible text-run shaping / text preview
- [x] Active glyph canvas/layer data
- [x] Visible glyph overview tiles
- [x] Active font-info sidebar tab
- [x] Current visible derived surfaces are explicitly rebuilt on reconnect

### User-facing status

- [x] Replace the weak warning triangle treatment with a visible sync-status pill.
- [x] Show degraded/reconnecting/offline-like states near the font title/share controls.
- [x] Keep the indicator visible until reconnect rebaseline finishes.
- [x] Distinguish durable pending-outbox state from mere socket connectivity with a dedicated count/status line.
- [x] Treat cloud-backed-but-unattached fonts as unhealthy so a saved cloud font cannot silently sit disconnected.

## Implementation checklist

### Client transport

- [x] Stop dropping pending outbound updates when the socket is temporarily unavailable.
- [x] Stop dropping pending outbound updates on transient websocket close.
- [x] Preserve pending durability messages until acknowledged.
- [x] Re-register outbound forwarding after reconnect.
- [x] Persist the outbox to IndexedDB.
- [x] After Save As seeding succeeds, finalize the current owner window as the active cloud asset and attach its live bridge immediately.

### Rebaseline orchestration

- [x] Track when a reconnect requires a visible rebaseline.
- [x] Delay the final `connected` state until rebaseline completes.
- [x] Recompile the editing font from current authoritative state.
- [x] Reshape visible text previews from current authoritative state.
- [x] Refresh the active glyph canvas from current authoritative state.
- [x] Re-render visible glyph overview outlines.
- [x] Refresh the active font-info tab through a public refresh entry point.

### UI

- [x] Render a pill-style cloud status badge instead of the old warning icon.
- [x] Provide text labels for reconnect/sync/error states.
- [x] Surface pending durable-sync counts in the pill while the socket is otherwise healthy.
- [x] Add stronger styling for non-healthy states.

### Tests

- [x] Cloud adapter retains unsent outbound packets until reconnect.
- [x] Cloud adapter runs reconnect rebaseline before reporting connected.
- [x] Cloud adapter reconnect rebaseline refreshes visible surfaces when present.
- [x] End-to-end cloud local Playwright coverage for reconnect-state pill and visible rebaseline.
- [x] End-to-end cloud local Playwright coverage for crash/restart outbox recovery.
- [x] End-to-end cloud local Playwright coverage for fresh-session duplicate resend dedupe.
- [x] End-to-end cloud local Playwright coverage for connected pending durable-sync pill recovery.
- [x] Unit coverage for Save As returning after durable seeding while the live room attach continues in the background.
- [x] Unit coverage for cloud-backed but disconnected title-bar signaling.

## Reliability Hardening Plan

### Connection state invariants

- [x] A cloud-backed current font must always have a resolvable asset id.
- [x] A cloud-backed current font whose live adapter is missing, disconnected, connecting, authenticating, syncing, or errored must show visible title-bar status.
- [x] Successful Save As seeding must immediately set the current font path, source plugin, role cache, and active asset id before returning to the UI.
- [ ] Add a periodic invariant check that repairs or loudly reports `cloudBacked=yes` with no active room attachment.
- [ ] Include the active adapter asset id, websocket phase, last auth/token fetch time, last close code/reason, and room token epoch in the debug snapshot.

### Post-save attach

- [x] Do not reopen the saved cloud asset as a required success condition; the upload is complete when seeding reaches durable cloud sync.
- [x] Start the owner window's live bridge connection immediately after seeding.
- [x] Keep the visible status in a non-healthy state until that live bridge reaches `connected`.
- [ ] Add Playwright coverage for Save As returning before live attach completes while the title bar shows the connecting/offline state.
- [ ] Add a retry budget and terminal error state for post-save live attach failures, with a manual reconnect affordance.

### Access epoch and invitation changes

- [x] Treat stale access epochs as expected reconnect boundaries, not user-facing fatal errors.
- [x] Fetch fresh room tokens without browser cache reuse.
- [x] Rebaseline visible state before reporting connected after reconnect.
- [ ] Verify owner windows stay attached and reconnect after invite acceptance, role changes, member removal, and ownership transfer acceptance in a single multi-user Playwright matrix.
- [ ] Surface repeated access-epoch reconnect loops as an explicit warning instead of silently retrying forever.

### Server and observability

- [x] Room-control delivery is durable for access-epoch changes and asset deletion.
- [ ] Expose room status fields needed by the editor to distinguish no peers, stale epoch, auth failure, and persistence degradation.
- [ ] Add a one-click user-facing cloud debug export that includes editor state, room status, and recent connection transitions for the active asset.
- [ ] Add production probes for Save As seed sync, owner/editor fanout, invitation acceptance reconnect, and room-control delivery.

## Validation

- [x] Focused Jest validation: `cd webapp && npx jest tests/cloud-adapter.test.js --runInBand`
- [x] Webapp build validation: `cd webapp && npm run build`
- [x] Focused room-worker validation: `cd ../collab/collab && node --test test/font-room-do.test.js`
- [x] Focused Playwright validation: `cd webapp && npx playwright test tests/cloud-collaboration-local.spec.ts --grep "shows the reconnect pill and catches up visible glyph edits after reconnect"`

## Additional validation

- [x] Focused Playwright validation: `cd webapp && npx playwright test tests/cloud-collaboration-local.spec.ts --grep "recovers a persisted cloud outbox edit after a page restart|dedupes a resent persisted cloud edit from a fresh websocket session|shows a connected pending-sync pill until the durable ack is recovered on restart"`

## Follow-up notes

- The current reconnect rebaseline explicitly covers the visible editing font, text preview shaping, glyph canvas, glyph overview, and active font-info tab.
- Any newly introduced visible derived panes should hook into the same reconnect rebaseline pattern when they are added.
