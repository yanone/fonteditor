ralph "Act as Ralph Wiggum on a mission to protect the CompiledEditFunnel.

The CompiledEditFunnel is the single post-commit reaction owner for ALL editing
font compiles. Every committed Yjs packet, local or remote, MUST enter this
funnel. There is no other path to trigger an editing compile from committed data.

Follow this exact process every loop:

1. VERIFY THE FUNNEL IS THE ONLY COMPILE TRIGGER

   Search the entire codebase for direct calls to:
   - window.autoCompileManager.checkAndSchedule()
   - window.autoCompileManager?.checkAndSchedule?.()
   - fontManager.requestRecompileWithoutDataChange()

   For every hit outside webapp/js/compiled-edit-funnel.ts and
   webapp/js/auto-compile-manager.ts, determine:

   a) If it's during an ACTIVE MOUSE DRAG (no Yjs commit yet):
      - Drag live refresh MUST keep its direct autoCompileManager call.
      - It MUST NOT call setEditingCompileContext.
      - It MUST NOT call scheduleFullCompileDebounce.

   b) If it's after a COMMITTED EDIT (keyboard, mouse-up, property panel,
      undo/redo):
      - REMOVE the direct autoCompileManager call.
      - The edit MUST go through: mutate model -> Yjs commit ->
        handleCommittedChangeRefresh -> CompiledEditFunnel.processCommittedEdit()
      - The funnel will infer the edit type from Yjs metadata and set the
        compile context.

   c) If it's scheduleFullCompileDebounce:
      - REMOVE it. The funnel's armDeferredFullCompile() handles this.
      - The funnel timer fires processCommittedEdit('deferred-full', null).

   d) If it's markDirty calling fullCompileManager.checkAndSchedule:
      - REMOVE it. The full-compile manager's 200ms monitor detects
        changeVersion increments naturally.

2. VERIFY COMPILE CONTEXT HYGIENE

   Search for calls to:
   - fontManager.setEditingCompileContext(...)
   - this.setInteractiveAnchorCompileContext()
   - this.setSidebearingKeyCompileContext()

   The ONLY code that may set compile context is:
   - CompiledEditFunnel.processCommittedEdit() line with:
     fm.setEditingCompileContext(changeSource, editType as ...)

   All other call sites must be removed. The funnel owns the context.
   Drag live refresh paths must NOT set it (they don't need it — the
   drag compiles use whatever mode is active; the final mouse-up compile
   through the funnel will get the right mode from Yjs metadata).

   In all cases, try to simplify code and code paths, not add new workarounds or exceptions.
   The funnel is designed to be the single source of truth for compile context.


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

4. RUN THE CANONICAL FUNNEL TESTS

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

5. RUN THE FULL TEST SUITE

   cd webapp && npx jest --no-coverage

   Only pre-existing failures are acceptable. If NEW tests fail, the change
   introduced a regression and must be reverted or fixed.

6. VERIFY THE POLICY DOC IS IN SYNC

   Read developer-docs/COMPILATION_EDIT_POLICY.md and check:

   a) The CompiledEditFunnel section accurately describes the architecture.
   b) The edit-type matrix has correct rows for guide (no compile) and
      the deferred full compile (CompiledEditFunnel owner).
   c) Non-regression requirements 15, 16, 17 are present and accurate.
   d) The High-priority compile context cleanup section says the funnel
      is the sole owner of compile context.
   
   Read and understand the Document Collaboration section in APP.md 
   to ensure the funnel architecture aligns with the overall collaboration model.

7. WARN ABOUT THESE SPECIFIC REGRESSION PATTERNS

   If you see ANY of these, flag them immediately:

   a) A new 'lastFullDataVersion >= changeVersion' guard appearing anywhere.
      The old guard was removed because it caused the funnel to silently
      drop compile wake-ups. The funnel always processes now.

   b) scheduleFullCompileDebounce being called from anywhere outside
      backward-compat callers. The funnel owns the deferred timer.

   c) Any code setting lastChangeSource/lastEditType outside the funnel.
      The funnel is the sole owner.

   d) Any guide edit path calling saveLayerData during drag.
      Guide edits mutate the model directly in _updateDraggedGuide and sync
      to Yjs on mouseup. No saveLayerData needed during drag.

   e) Any full-font JSON resend, storeFontJson, initYdoc, or seedYdoc
      appearing in an interactive edit path. Steady-state editing is
      incremental-Yjs-only (Core Rule 11).

Output <promise>DONE</promise> when complete." \
  --max-iterations 10