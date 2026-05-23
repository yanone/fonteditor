# Keyboard-After-Drag Stale Editing Font Handoff (2026-05-23)

## 1) Problem Statement

We are fixing a long-running regression in Counterpunch where:

- Mouse drag edits update and compile correctly.
- Subsequent keyboard outline edits (especially Arrow key nudges) can compile against stale editing state after a drag.
- User-visible symptom: visual behavior still appears broken after prior fixes; drag path works, keyboard-after-drag does not.

This is in the critical hot path: `PatchSyncEngine` -> `change-bridge-init` -> `FontManager` compile scheduling -> Rust worker incremental Yjs update path.

## 2) Why This Is Hard

The code has multiple overlapping triggers that can request compiles:

- Dirty callbacks (`onDirty`),
- committed change funnel (`handleCommittedChangeRefresh` -> `processCommittedEdit`),
- deferred full compile timer,
- live drag compile path.

If any trigger increments `compileRequestVersion` without explicit packet context, it can poison compile mode selection and ordering.

## 3) What We Tried In This Session

### 3.1 Earlier architecture and test hardening (already in flight)

Significant changes were already made before this final debugging loop, including:

- Explicit request-scoped compile context snapshots (instead of ambient fallback).
- Exact committed packet emission in `PatchSyncEngine` (authoritative Yjs delta + in-hand semantic entries).
- Mouse-up finalization gating before keyboard handling.
- Deferred full compile ownership cleanup in `CompiledEditFunnel`.
- Policy doc updates and many new/updated tests.

### 3.2 Live runtime instrumentation against the real app

Attached to running editor page:

- `https://localhost:8001/?file=memory:///user/Fustat.glyphs...`

Added temporary runtime probes (in browser console via DevTools evaluate) to log:

- local Yjs packet emission,
- forwarded worker Yjs updates,
- compile request revision/context,
- `requestRecompileWithoutDataChange` calls,
- compile mode and worker-ready state.

### 3.3 Scripted reproduction in page context

Programmatically simulated:

1. Point drag finalization (`onMouseUp` path),
2. keyboard point move (`moveSelectedPoints` path),
3. worker outline fetch (`getGlyphOutlines`) before/after each step.

Observed from logs:

- Worker outlines did update for both drag and keyboard move in this scripted scenario.
- However, each commit showed an extra early compile request with null context before the explicit `keyboard-outline` context request.

## 4) Key Finding (Most Important)

A race/ordering issue still exists in bridge dirty handling:

- `change-bridge-init.ts` registers `bridge.onDirty(() => currentFont.markDirty())`.
- `markDirty()` by default sets `requestEditingCompile = true`, increments `compileRequestVersion`, and records context from ambient fields (often null at that moment).
- This creates an uncontexted editing compile request before the committed-change funnel can submit the packet-explicit compile request.

This is exactly the class of bug we were trying to eliminate.

## 5) Patch Applied In This Session

### 5.1 Code change

In `webapp/js/change-bridge-init.ts`, changed dirty callback behavior:

- Before: `fontManager.currentFont.markDirty();`
- After: `fontManager.currentFont.markDirty(undefined, { requestEditingCompile: false });`

Intent:

- Keep unsaved/dirty tracking and UI updates,
- prevent ambient/no-context compile request creation,
- leave compile ownership to committed funnel with explicit context.

### 5.2 Regression test added

In `webapp/tests/change-bridge-init.test.js`, added test:

- `dirty callback marks unsaved state without creating an ambient editing compile request`

Asserts:

- `markDirty(undefined, { requestEditingCompile: false })` is used,
- no direct `requestRecompileWithoutDataChange` call from dirty callback,
- dirty indicator + save button updates still happen.

### 5.3 Test harness fix

First run failed because mocked `window.windowRole` lacked `getRoleLabel()` required by `PatchSyncEngine`.

Applied test fix by adding:

- `getRoleLabel: () => 'main'`

to the mocked `window.windowRole` in the new test.

## 6) Current Validation Status

### Confirmed earlier in session (before latest patch)

- `tests/change-bridge.test.js`: PASS
- `tests/change-bridge-init.test.js`: PASS
- `tests/canonical/compiled-edit-funnel.test.js`: PASS
- `tests/canonical/live-drag-edit-funnel.test.js`: PASS
- `tests/font-manager.test.js -t "FontManager editing subset inclusion"`: PASS
- `npm run build`: PASS

Known unrelated/pre-existing failure (not introduced here):

- full `tests/font-manager.test.js` has isolated failure in keyed sidebearing normalization test.

### After latest dirty-callback patch

- `tests/change-bridge-init.test.js` was run once and failed only due test mock setup (`getRoleLabel` missing).
- Mock was fixed, but suite has not yet been rerun in this conversation state.

## 7) Successes So Far

- Reproduced and instrumented real runtime behavior instead of relying only on unit tests.
- Identified concrete remaining source of ambient compile requests (`bridge.onDirty` -> default `markDirty`).
- Applied targeted fix aligned with packet-explicit policy.
- Added regression test to prevent this class of reintroduction.

## 8) Failures / Dead Ends / Pitfalls

1. Green focused tests gave false confidence while runtime still regressed.
2. Multiple compile triggers can silently compete; the earliest request can carry null context and still execute.
3. Dirty tracking and compile scheduling were still coupled in one callback, violating single-owner intent.
4. Test harness mocks must include `windowRole.getRoleLabel()` when `PatchSyncEngine` is instantiated.
5. DevTools attachment can accidentally target `about:blank`; confirm attached page before debugging.

## 9) Recommended Next Steps (Immediate)

1. Rerun:
    - `cd webapp && npx jest --runTestsByPath tests/change-bridge-init.test.js --runInBand --silent`
2. Run focused regression set:
    - `tests/change-bridge.test.js`
    - `tests/canonical/compiled-edit-funnel.test.js`
    - `tests/canonical/live-drag-edit-funnel.test.js`
    - `tests/font-manager.test.js -t "FontManager editing subset inclusion"`
3. Run build:
    - `cd webapp && npm run build`
4. Reproduce manually in live app with user scenario:
    - drag node,
    - keyboard nudge same node,
    - verify visible outline + worker outline both move.
5. If still failing in manual flow, keep runtime probes and compare event order around:
    - `bridge.localUpdate`,
    - `fm.forwardWorkerYjsUpdate.*`,
    - `font.requestRecompileWithoutDataChange`,
    - `fm.compileEditingFont.start` context.

## 10) Files Touched In This Final Loop

- `webapp/js/change-bridge-init.ts`
- `webapp/tests/change-bridge-init.test.js`

## 11) Strategic Takeaway

The remaining bug vector was not "drag path vs keyboard path logic" by itself; it was an ordering leak where dirty bookkeeping still created a compile request outside the packet-explicit committed funnel. Keeping compile requests single-owner and context-explicit is essential for this subsystem.
