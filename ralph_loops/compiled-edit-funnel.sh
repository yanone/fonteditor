ralph "Act as Ralph Wiggum on a mission to protect the editing compile funnels.

Counterpunch now has two related compile funnels:

- `webapp/js/compiled-edit-funnel.ts` owns every COMMITTED editing-font compile
   wake-up after a Yjs packet lands locally or remotely.
- `webapp/js/live-drag-edit-funnel.ts` owns PRE-COMMIT live mouse-drag refreshes
   and drag-time compile wake-ups while the pointer is still down.

Keep those roles distinct. Committed packets MUST enter the committed funnel.
Active drags may use the live drag funnel before commit, but must drain it
before mouse-up finalization so drag-time state cannot poison later keyboard,
undo/redo, or remote compiles.

Follow this exact process every loop:

1. VERIFY COMPILE TRIGGERS ONLY LIVE IN THE RIGHT FUNNEL

   Search the entire codebase for direct calls to:
   - window.autoCompileManager.checkAndSchedule()
   - window.autoCompileManager?.checkAndSchedule?.()
   - fontManager.requestRecompileWithoutDataChange()

    For every hit outside:
    - webapp/js/compiled-edit-funnel.ts
    - webapp/js/live-drag-edit-funnel.ts
    - webapp/js/auto-compile-manager.ts

    determine which side of the boundary it belongs to:

   a) If it's during an ACTIVE MOUSE DRAG (no Yjs commit yet):
         - It belongs in the live drag funnel.
         - The drag path may request a live compile directly.
         - It MUST NOT request the committed funnel in parallel.
         - It MUST drain before mouse-up commit finalization.

   b) If it's after a COMMITTED EDIT (keyboard, mouse-up, property panel,
      undo/redo):
      - REMOVE the direct autoCompileManager call.
      - The edit MUST go through: mutate model -> Yjs commit ->
        handleCommittedChangeRefresh -> CompiledEditFunnel.processCommittedEdit()
         - The committed funnel will infer the edit type from Yjs metadata.

   c) If it's scheduleFullCompileDebounce:
         - REMOVE it unless the call is clearly legacy/backward-compat.
         - Prefer the committed funnel's armDeferredFullCompile().
      - The funnel timer fires processCommittedEdit('deferred-full', null).

   d) If it's markDirty calling fullCompileManager.checkAndSchedule:
      - REMOVE it. The full-compile manager's 200ms monitor detects
        changeVersion increments naturally.

2. VERIFY BOTH FUNNELS HAVE CLEAN BOUNDARIES

   Search for calls to:
   - fontManager.setEditingCompileContext(...)
    - fontManager.clearEditingCompileContext(...)
    - liveDragEditFunnel.queue(...)
    - drainLiveDragRefreshBeforeCommit()

    Allowed owners are:
    - `CompiledEditFunnel.processCommittedEdit()` for committed requests.
    - `LiveDragEditFunnel.requestLiveCompile()` for active drag requests only.

    Requirements:
    - Live drag compile context must be request-scoped and cleared immediately
       after the drag request is queued.
    - Mouse-up commit paths must not leave queued or running drag refresh work
       behind after finalization.
    - Keyboard, undo/redo, property-panel, remote, and drag-end committed paths
       must derive their compile mode from committed metadata, not stale drag globals.

   In all cases, try to simplify code and code paths, not add new workarounds or exceptions.
    The funnels are designed to separate live drag work from committed work.


3. VERIFY NON-COMPILING EDIT TYPES

   Search for edit paths related to:
   - guide edits
   - contrast-axis edits

   These types MUST be detected by inferCommittedEditTypeFromEntries() and
   return the correct editType ('guide' etc). The funnel's
   NON_COMPILING_EDIT_TYPES set MUST contain them. When the funnel receives
   a non-compiling edit type, it returns immediately without setting compile
   context or requesting any compile.

   Guide edits still sync to Yjs for undo/history, but the funnel skips them.

4. CHECK THE LIVE DRAG FUNNEL TOO

   Read `webapp/js/live-drag-edit-funnel.ts` and the drag-end path in
   `webapp/js/glyph-canvas/outline-editor.ts`.

   Confirm:
   a) Live drag requests only run while the drag is active.
   b) Mouse-up drains the live drag funnel before the final committed save/Yjs sync.
   c) A late drag refresh cannot bump compile state after the committed edit has taken over.
   d) Non-compiling drag helpers like guide or contrast-axis do not accidentally arm a committed compile.

5. RUN THE CANONICAL FUNNEL TESTS

   cd webapp && npx jest tests/canonical/compiled-edit-funnel.test.js

   All 15 tests must pass. Key invariants locked down:

   a) processCommittedEdit sets compile context and requests compile
   b) Guide edits skip compile context AND skip compilation
   c) Contrast-axis edits skip compilation
   d) Bootstrap guard skips changeVersion===0 before first editing font
   e) Bootstrap does NOT skip when editingFont already exists
   f) forceTrigger fires when available
   g) Deferred full compile fires 500ms after last edit
   h) Deferred timer re-arms while draggingSomething is true
   i) Deferred timer skips when lastCompilationMode is already 'full'
   j) Timer is cancelled and re-armed on subsequent edits
   k) NO guard blocks the funnel — it always processes even when
      lastFullCompiledDataVersion >= changeVersion

6. RUN RELATED LIVE-EDIT TESTS

   Also run focused tests around:
   - webapp/tests/canonical/live-drag-edit-funnel.test.js
   - webapp/tests/font-manager.test.js

   Pay special attention to regressions where:
   - a mouse drag leaves stale compile context behind
   - a mouse drag leaves stale canonical JSON that breaks later keyboard compiles
   - a queued drag refresh survives mouseup and supersedes a later keyboard compile

7. RUN THE FULL TEST SUITE

   cd webapp && npx jest --no-coverage

   Only pre-existing failures are acceptable. If NEW tests fail, the change
   introduced a regression and must be reverted or fixed.

8. VERIFY THE POLICY DOC IS IN SYNC

   Read developer-docs/COMPILATION_EDIT_POLICY.md and check:

   a) The CompiledEditFunnel section accurately describes the architecture.
   b) The edit-type matrix has correct rows for guide (no compile) and
      the deferred full compile (CompiledEditFunnel owner).
   c) Non-regression requirements 15, 16, 17 are present and accurate.
   d) The High-priority compile context cleanup section says the funnel
      is the sole owner of compile context.
   
   Read and understand the Document Collaboration section in APP.md 
   to ensure the funnel architecture aligns with the overall collaboration model.

9. WARN ABOUT THESE SPECIFIC REGRESSION PATTERNS

   If you see ANY of these, flag them immediately:

   a) A new 'lastFullDataVersion >= changeVersion' guard appearing anywhere.
      The old guard was removed because it caused the funnel to silently
      drop compile wake-ups. The funnel always processes now.

   b) scheduleFullCompileDebounce being called from anywhere outside
      backward-compat callers. The funnel owns the deferred timer.

   c) Any code setting committed compile context from stale drag state after mouseup.
      Request-scoped drag state must not poison later committed compiles.

   d) Any drag path that does not drain `LiveDragEditFunnel` before final commit.
      Late drag refreshes must not survive into keyboard/undo/redo time.

   e) Any guide edit path calling saveLayerData during drag.
      Guide edits mutate the model directly in _updateDraggedGuide and sync
      to Yjs on mouseup. No saveLayerData needed during drag.

   f) Any full-font JSON resend, storeFontJson, initYdoc, or seedYdoc
      appearing in an interactive edit path. Steady-state editing is
      incremental-Yjs-only (Core Rule 11).

   g) Any non-drag interactive compile reusing stale canonical JSON after a prior drag.
      Active mouse drags may stay on their live incremental path, but the next
      committed keyboard/undo/redo compile must not build on a stale pre-drag base.

Output <promise>DONE</promise> when complete." \
  --max-iterations 10