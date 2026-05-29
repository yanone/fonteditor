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

## Implementation checklist

### Client transport

- [x] Stop dropping pending outbound updates when the socket is temporarily unavailable.
- [x] Stop dropping pending outbound updates on transient websocket close.
- [x] Preserve pending durability messages until acknowledged.
- [x] Re-register outbound forwarding after reconnect.
- [x] Persist the outbox to IndexedDB.

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

## Validation

- [x] Focused Jest validation: `cd webapp && npx jest tests/cloud-adapter.test.js --runInBand`
- [x] Webapp build validation: `cd webapp && npm run build`
- [x] Focused room-worker validation: `cd ../collab/collab && node --test test/font-room-do.test.js`
- [x] Focused Playwright validation: `cd webapp && npx playwright test tests/cloud-collaboration-local.spec.ts --grep "shows the reconnect pill and catches up visible glyph edits after reconnect"`

## Follow-up notes

- The current reconnect rebaseline explicitly covers the visible editing font, text preview shaping, glyph canvas, glyph overview, and active font-info tab.
- Any newly introduced visible derived panes should hook into the same reconnect rebaseline pattern when they are added.
