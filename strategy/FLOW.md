                         ┌──────────────────────────────┐
                         │                              │
                         │   1.  EDIT PRODUCERS         │
                         │                              │
                         │   keyboard  │  mouse drag    │
                         │   Python    │  drag-end      │
                         │   undo/redo │  remote        │
                         │   toggle smooth              │
                         │   set sidebearing            │
                         │                              │
                         └──────────┬───────────────────┘
                                    │
                                    │
                    ┌───────────────┴───────────────────────────────┐
                    │              DRAG?                            │
                    │                                               │
                    │          YES ──────► 2. LiveDragEditFunnel    │
                    │                        (while dragging)       │
                    │                                               │
                    │          NO ───────►  x  (go to 3 directly)   │
                    │                                               │
                    └───────────────────────┬───────────────────────┘
                                            │
                                            ▼
               ┌─────────────────────────────────────────────────────────┐
               │                                                         │
               │  3.  computeRecompositionClosure(scope, editKinds,     │
               │      sourceTargets)                                     │
               │                                                         │
               │      Called from:  onKeyDown(), drag-end,              │
               │      moveSelectedSidebearing(), toggleSmooth(),        │
               │      setSidebearing(), syncKeyboardOutlineLayerEdit(), │
               │      and via bridge fallback in                        │
               │      buildCascadingRecompositionOperations()            │
               │                                                         │
               │      scope: 'visible' = live drag (live text refresh)  │
               │      scope: 'all'     = every committed edit           │
               │                                                         │
               │      Returns:  { allTargets, dependentTargets,         │
               │                  affectedGlyphNames }                   │
               │                                                         │
               └──────────────────────────┬──────────────────────────────┘
                                          │  closure.allTargets
                                          ▼
               ┌─────────────────────────────────────────────────────────┐
               │                                                         │
               │  4.  _syncCurrentGlyphToYDoc(                           │
               │        label, oldValue, newValue, visualAnchorSide,     │
               │        closure.allTargets)                               │
               │                                                         │
               │      - Merges dependent layer data from model into      │
               │        babelfontData for Yjs delta computation          │
               │      - Calls syncLayersFromJson(allTargets, label,      │
               │        ..., allTargets)                                  │
               │        ↑ allTargets passed as BOTH sync targets AND     │
               │          workerReplayTargets metadata                   │
               │                                                         │
               └──────────────────────────┬──────────────────────────────┘
                                          │
                                          ▼
               ┌─────────────────────────────────────────────────────────┐
               │                                                         │
               │  5.  PatchSyncEngine.syncLayersFromJson()               │
               │                                                         │
               │      - For each target: compares babelfontData vs      │
               │        current Yjs state                                │
               │      - Builds sparse delta (only changed fields)        │
               │      - Skips byte-equal targets (no Yjs operation)      │
               │      - Creates change-log entry with:                   │
               │          path = single layer path                       │
               │          workerReplayTargets = full closure             │
               │      - Emits Yjs binary update                          │
               │      - Triggers committed-change listeners              │
               │                                                         │
               └──────────────────┬──────────────────┬───────────────────┘
                                  │                  │
                                  ▼                  ▼
               ┌──────────────────────────┐  ┌──────────────────────────────┐
               │                          │  │                              │
               │  6.  onCommittedChange   │  │  7.  setYjsWorkerCallback    │
               │      (change-bridge-     │  │                              │
               │       init.ts)           │  │   - Derives layerTargets     │
               │                          │  │     from workerReplayTargets │
               │   - handleCommitted      │  │     (= closure.allTargets)   │
               │     ChangeRefresh()      │  │                              │
               │   - queueRustCache...    │  │   - Derives changedGlyphs    │
               │   - requestCommitted     │  │     from operation paths     │
               │     EditingFontCompile() │  │                              │
               │                          │  │   - Calls                    │
               │                          │  │     forwardWorkerYjsUpdate(  │
               └──────────┬───────────────┘  │       update,               │
                          │                  │       changedGlyphs,         │
                          │                  │       { layerTargets })      │
                          │                  │                              │
                          ▼                  └──────────────┬───────────────┘
               ┌───────────────────────────────────────────────┘
               │
               ▼
               ┌───────────────────────────────────────────────────────────────┐
               │                                                               │
               │  8.  processCommittedEdit(compiled-edit-funnel.ts)            │
               │                                                               │
               │      1) cancelDeferredFullCompile()     ← kill stale timer    │
               │      2) requestRecompileWithoutDataChange()                   │
               │      3) forceTrigger()                     ← if undo/redo     │
               │         forceFullEditingCacheRefresh = true                   │
               │      4) armDeferredFullCompile()   ← if local + not force     │
               │                                                               │
               └──────────────────────────────┬────────────────────────────────┘
                                              │
                                              ▼
               ┌───────────────────────────────────────────────────────────────┐
               │                                                               │
               │  9.  recompileEditingFont()                                   │
               │                                                               │
               │      - getEditingSubsetSnapshot()                             │
               │      - [+ active edited glyph]                                │
               │      - compileEditingFont(text, features, subsetGlyphs)        │
               │        → sends 'compileCached' message to worker              │
               │                                                               │
               └──────────────────────────────┬────────────────────────────────┘
                                              │
                                              ▼
               ┌───────────────────────────────────────────────────────────────┐
               │                                                               │
               │ 10.  Rust WASM Worker (fontc-worker.ts)                       │
               │                                                               │
               │      apply_yjs_update(update, changedGlyphs,                  │
               │                        { layerTargets }):                      │
               │        - Updates Rust Y.Doc                                   │
               │        - changed_layer_snapshots built from layerTargets       │
               │          (includes EVERY closure target, not just Yjs-changed) │
               │        - COMPOSITE FIX: for each target in subset:            │
               │          even byte-equal layer JSON → push to                 │
               │          touched_subset_glyphs → refreshes SUBSET_FONT_CACHE  │
               │                                                               │
               │      compile_cached_font_from_last_layout_closure(options):    │
               │        - Gets or builds subset font from SUBSET_FONT_CACHE    │
               │        - Runs filter pipeline                                 │
               │        - Calls compile_with_feature_debug_context()            │
               │          → BabelfontIrSource::compile()                       │
               │          → zero_head_timestamps()    ← DETERMINISM            │
               │            (zeros head.created and head.modified timestamps)  │
               │        - Returns byte-identical Vec<u8>                       │
               │                                                               │
               └──────────────────────────────┬────────────────────────────────┘
                                              │
                                              ▼
               ┌───────────────────────────────────────────────────────────────┐
               │                                                               │
               │ 11.  Client: receives compiled font bytes                     │
               │      - editingFontCompiled event fires                        │
               │      - waitForCompileSettle() resolves                        │
               │      - HarfBuzz shapes text with new font                     │
               │      - Canvas re-renders                                      │
               │      - stabiliseCanvas() → 3× RAF + 50ms wait                │
               │      - captureCanvas() → PNG data URL                        │
               │                                                               │
               └───────────────────────────────────────────────────────────────┘

Description of each numbered box

1. EDIT PRODUCERS — The entry points that trigger visual edits: keyboard arrow keys (onKeyDown), mouse drag (\_handleDrag → drag-end handler), Python scripts, undo/redo, remote sync, property panel (setSidebearingValue, togglePointSmooth). Each determines the source (edited glyph+layer), the edit kinds (outline/anchor/sidebearing/component), and the scope (visible vs all).
2. LiveDragEditFunnel — While a drag is in progress (draggingSomething === true), live refreshes are queued here. They use scope: 'visible' to refresh only visible glyphs. Each tick coalesces behind the running refresh. On mouse-up, drainAndClearQueued() ensures all pending work completes before entering the committed path. The funnel does NOT compute recomposition itself — it delegates to the shared closure.
3. computeRecompositionClosure(scope, editKinds, sourceTargets) — The single function that derives the complete set of layer targets needing cache refresh. Uses computeLayerRecompositionClosure from the shared module. Branches on scope: 'visible' limits dependents to currently visible text-run glyphs; 'all' includes the full transitive closure (component dependents, automatic composites, metrics-key dependents). Returns allTargets (source + dependents), dependentTargets, and affectedGlyphNames.
4. \_syncCurrentGlyphToYDoc(label, ..., closure.allTargets) — The only method that sends data from the editor to the Yjs bridge. It receives pre-computed closure targets from step 3 and does NOT perform any further dependent discovery. It merges dependent model layers into babelfontData so the bridge sees current data, then calls syncLayersFromJson(allTargets, ..., allTargets) where allTargets appears twice: once as the set of layers to sync, and once as the workerReplayTargets metadata.
5. PatchSyncEngine.syncLayersFromJson() — For each target in allTargets, computes a sparse Yjs delta (only fields that differ between babelfontData and current Yjs state). Byte-equal targets produce no Yjs operation but the change-log entry still carries the full workerReplayTargets metadata. Emits the Yjs binary update and triggers listeners.
6. onCommittedChange handler — Receives the emitted change-log entries. Enters handleCommittedChangeRefresh() which deduplicates work, applies visual sync (viewport pan compensation), queues Rust cache refresh, and requests a compile via requestCommittedEditingFontCompile() → processCommittedEdit().
7. setYjsWorkerCallback — Forwards the Yjs update to the Rust worker. Derives layerTargets from entry.workerReplayTargets (the full closure set). Derives changedGlyphs from entry.path (single layer path). Calls forwardWorkerYjsUpdate(update, changedGlyphs, { layerTargets }).
8. processCommittedEdit(compiled-edit-funnel.ts) — The single committed-compile funnel. Cancels any pending deferred full compile to prevent stale timer races. Requests a recompile. For force-triggered edits (undo/redo/remote), enables forceFullEditingCacheRefresh and directly calls forceTrigger() to bypass the compile loop's idle checks. For local fast-path edits, arms a deferred full-compile timer as a trailing correctness pass.
9. recompileEditingFont() — Reads the current subset snapshot (getEditingSubsetSnapshot()), ensures the active edited glyph is included, then calls compileEditingFont() which sends a compileCached message to the Rust worker.
10. Rust WASM Worker — Two key operations:
    - apply_yjs_update: Updates the Rust Y.Doc, builds changed_layer_snapshots from all layerTargets (not just glyphs with Yjs changes), and with the touches_subset fix, pushes every subset-present target to touched_subset_glyphs even when its layer JSON is byte-equal — forcing SUBSET_FONT_CACHE refresh for composite-dependent glyphs.
    - compile_cached_font_from_last_layout_closure: Gets or builds the subset font from SUBSET_FONT_CACHE, runs filter pipeline, compiles via BabelfontIrSource, then runs zero_head_timestamps to zero the head.created and head.modified fields for deterministic output.
11. Client rendering — Receives the compiled font bytes. Fires editingFontCompiled event. HarfBuzz shapes the text buffer with the new font. Canvas re-renders. The test waits via waitForCompileSettle() (event listener + timeout + RAF) and stabiliseCanvas() (3× RAF + 50ms), then captures the PNG data URL for comparison.

###

                         ┌──────────────────────────────────────────────────────────────┐
                         │                                                              │
                         │  1. EDIT PRODUCERS                                           │
                         │                                                              │
                         │  keyboard: OutlineEditor.onKeyDown(e)                        │
                         │       → moveSelectedPoints(dx, dy, preserveHandle)           │
                         │       → moveSelectedAnchors(dx, dy)                          │
                         │       → moveSelectedComponents(dx, dy)                       │
                         │       → moveSelectedSidebearing(dx)                          │
                         │                                                              │
                         │  mouse drag:   OutlineEditor._handleDrag(e)                  │
                         │       while dragging→_updateDraggedSidebearing(dx)            │
                         │                    →_updateDragSelection(e)                  │
                         │                                                              │
                         │  drag-end:     OutlineEditor.onMouseUp(e)                    │
                         │                                                              │
                         │  property panel: setSidebearingValue(side, targetValue)      │
                         │                   togglePointSmooth(points)                  │
                         │                                                              │
                         │  undo/redo:    patch-sync-engine.ts undo() / redo()          │
                         │                                                              │
                         │  remote:       handleCommittedChangeRefresh(entries,'remote')│
                         │                                                              │
                         └───────────────────────────┬──────────────────────────────────┘
                                                     │
                                  ┌──────────────────┴───────────────────┐
                                  │  WHILE DRAGGING?                    │
                                  │                                      │
                                  │ YES → 2. LiveDragEditFunnel         │
                                  │           .queue({ run: ...,        │
                                  │             compile: { changeSource,│
                                  │                       editType } }) │
                                  │           .drainAndClearQueued()     │
                                  │                                      │
                                  │ NO → (go to 3 directly)             │
                                  └──────────────────┬───────────────────┘
                                                     │
                                                     ▼
           ┌───────────────────────────────────────────────────────────────────────────────┐
           │                                                                               │
           │  3. computeRecompositionClosure({ sourceTargets, editKinds, scope,             │
           │                                   activeLayerId })                             │
           │                                                                               │
           │      outline-editor.ts (delegates to recomposition-closure.ts):                │
           │        computeLayerRecompositionClosure({ fontModel, sourceTargets,            │
           │          editKinds, scope, activeLayerId, sourceGlyphName,                     │
           │          suppressor: patchSyncEngine, visibleGlyphNames })                     │
           │                                                                               │
           │      Returns: { allTargets, dependentTargets, affectedGlyphNames }             │
           │        allTargets = sourceTargets + dependentTargets, deduped, normalized     │
           │        dependentTargets = resolved {glyphName, layerId} pairs for             │
           │          composite dependents (adieresis→a) + automatic composites +           │
           │          metrics-key dependents                                                │
           │        affectedGlyphNames = Set<glyphName> of all touched glyphs              │
           │                                                                               │
           └─────────────────────────────┬─────────────────────────────────────────────────┘
                                         │ closure.allTargets
                                         ▼
           ┌───────────────────────────────────────────────────────────────────────────────┐
           │                                                                               │
           │  4. _syncCurrentGlyphToYDoc(label, oldValue, newValue,                         │
           │                              visualAnchorSide, closure.allTargets)             │
           │                                                                               │
           │      outline-editor.ts:                                                        │
           │        - No further dependent discovery (caller's targets are authoritative)    │
           │        - Merges dependent model layers → babelfontData:                        │
           │            for each target in allTargets                                       │
           │              if target !== source → read modelLayer.toJSON()                   │
           │                → write into storedGlyph.layers[storedLayerIndex]               │
           │        - Calls:                                                                │
           │            window.patchSyncEngine                                              │
           │              .syncLayersFromJson(allTargets, label, oldValue,                  │
           │                                 newValue, visualAnchorSide,                    │
           │                                 allTargets)                                    │
           │            ↑                                      ↑                            │
           │            sync targets                workerReplayTargets metadata            │
           │            (which layers to                     (= complete closure)           │
           │             produce Yjs deltas for)                                            │
           │                                                                               │
           └─────────────────────────────┬─────────────────────────────────────────────────┘
                                         │
                                         ▼
           ┌───────────────────────────────────────────────────────────────────────────────┐
           │                                                                               │
           │  5. PatchSyncEngine.syncLayersFromJson(                                        │
           │        layerTargets: WorkerReplayTarget[],                                     │
           │        label: string,                                                         │
           │        oldValue?: string,                                                     │
           │        newValue?: string,                                                     │
           │        visualAnchorSide?,                                                      │
           │        workerReplayTargets: WorkerReplayTarget[]   ← full closure              │
           │     )                                                                          │
           │                                                                               │
           │      For each target in layerTargets:                                         │
           │        - Reads babelfontData[glyph].layers[layerId]                           │
           │        - Reads current Yjs state for same layer                               │
           │        - Builds sparse delta (only fields that differ)                         │
           │        - If delta has changes → creates TransactionBufferedOperation:          │
           │            path: ['glyphs', glyphName, 'layers', layerId]                     │
           │            oldValue: previous Yjs snapshot                                    │
           │            newValue: sparse delta                                             │
           │            workerReplayTargets: allTargets  ← full closure on EVERY operation │
           │            applyMode: 'layer-snapshot'                                        │
           │        - If no changes → skips (no Yjs operation for byte-equal layers)       │
           │            BUT: the other operations in the batch still carry the full         │
           │            closure in their workerReplayTargets!                               │
           │                                                                               │
           │      Calls _commitOperations(operations, label)                                │
           │        → for each operation: createLogEntry({ path, workerReplayTargets, ... }) │
           │        → Y.applyUpdate(this.yDoc, update)     ← applies Yjs delta             │
           │        → this._emitLocalUpdate(update, changeLogEntries)                      │
           │                                                                               │
           └──────────────────────┬───────────────────────┬────────────────────────────────┘
                                  │                       │
                                  ▼                       ▼
           ┌────────────────────────────────────┐  ┌──────────────────────────────────────────┐
           │                                    │  │                                          │
           │  6. _emitLocalUpdate is called      │  │  7. setYjsWorkerCallback fires            │
           │                                    │  │                                          │
           │      patch-sync-engine.ts:          │  │    change-bridge-init.ts handle:          │
           │        cb(update, collabMsg,        │  │      deriveGlyphNamesFromPaths(paths)     │
           │          emissionEntries)           │  │        → ['a'] (only changed paths)       │
           │        for each _localUpdateListener│  │                                          │
           │        for each _committedChange    │  │      collectWorkerLayerTargetsFrom        │
           │          Listener:                  │  │        ChangeLogEntries(entries)          │
           │          cb(emissionEntries,        │  │        → reads entry.workerReplayTargets  │
           │             { origin: 'local',      │  │          = closure.allTargets            │
           │               update })             │  │          → [{a},{adieresis},...]          │
           │                                    │  │                                          │
           ▼                                    │  │      forwardWorkerYjsUpdate(              │
           ┌────────────────────────────────────┐  │        update,                            │
           │  6a. onCommittedChange handler     │  │        changedGlyphs: ['a'],               │
           │        (registered in              │  │        { layerTargets } )                  │
           │        change-bridge-init.ts)      │  │                                          │
           │                                    │  │    Also mirrors to fullFontCompilation    │
           │    handleCommittedChangeRefresh(   │  │    worker.                                │
           │      entries, origin,              │  │                                          │
           │      { requestCompile,             │  └──────────────────┬───────────────────────┘
           │        queueCacheRefresh })        │                     │
           │                                    │                     ▼
           │    If local + not GUI-complete:    │  ┌──────────────────────────────────────────┐
           │      queueRustCacheAndRefresh      │  │  7a. Rust WASM: apply_yjs_update         │
           │      Canvas(..., {                 │  │                                          │
           │        workerReplayTargets })       │  │    parse_apply_yjs_update_metadata()      │
           │                                    │  │      → (changedGlyphs, hints,            │
           │    requestCommittedEditingFont      │  │         layerTargets)                    │
           │      Compile(changeSource,          │  │                                          │
           │        editType,                    │  │    changed_layer_snapshots: for each      │
           │        { forceTrigger })            │  │      layerTarget → read from Y.Doc:      │
           │                                    │  │        ydoc_get_layer_json_with_txn()     │
           │                                    │  │                                          │
           └──────────────────┬─────────────────┘  │    CANONICAL_JSON_CACHE update:           │
                              │                    │      refresh_caches_for_layer_targets()   │
                              ▼                    │      replace_top_level_json_entry()        │
           ┌────────────────────────────────────┐  │      replace_layer_json_entry()           │
           │                                    │  │        → false (byte-equal for            │
           │  8. processCommittedEdit(          │  │          adieresis)                       │
           │       changeSource, editType,      │  │                                          │
           │       { forceTrigger })             │  │    SUBSET_JSON_CACHE update:              │
           │                                    │  │      for each layerTarget in subset:      │
           │    compiled-edit-funnel.ts:         │  │        touches_subset = true              │
           │      cancelDeferredFullCompile()    │  │        if(changed || touches_subset)      │
           │      fm.currentFont                 │  │          → push to touched_subset_glyphs │
           │        .requestRecompileWithout      │  │            = ['a','adieresis',...]       │
           │        DataChange({compileContext})  │  │        subset_epoch++                   │
           │      fm.clearEditingCompileContext() │  │        SUBSET_FONT_CACHE epoch updated   │
           │      autoCompileManager              │  │        FILTERED_FONT_CACHE = None        │
           │        .checkAndSchedule()           │  │                                          │
           │      if(forceTrigger):              │  └──────────────────────────────────────────┘
           │        fm.forceFullEditingCache                                                    │
           │          Refresh = true                                                            │
           │        await autoCompileManager                                                     │
           │          .forceTrigger()                                                            │
           │      if(!forceTrigger):                                                             │
           │        armDeferredFullCompile()                                                     │
           │                                                                                     │
           └──────────────────┬──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
           ┌────────────────────────────────────────────────────────────────────────────────────┐
           │                                                                                    │
           │  9. AutoCompileManager.forceTrigger() → triggerCompilation()                        │
           │                                                                                    │
           │      auto-compile-manager.ts:                                                       │
           │        while(needsRecompile && currentFont?.needsRecompile):                        │
           │          needsRecompile = await fontManager.recompileEditingFont()                  │
           │                                                                                    │
           │    font-manager.ts recompileEditingFont():                                          │
           │      await this.awaitWorkerCacheUpdate()                                            │
           │      subsetGlyphs = this.getEditingSubsetSnapshot()                                 │
           │        → cached snapshot: ['a','adieresis',...] (from text buffer "aä")             │
           │      if empty → derive from text → update snapshot                                 │
           │      activeEditedGlyphName = outlineEditor.currentGlyphName                         │
           │      if activeGlyph not in subsetGlyphs → add it                                   │
           │      await this.compileEditingFont(text, features, subsetGlyphs)                    │
           │                                                                                    │
           └──────────────────┬─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
           ┌────────────────────────────────────────────────────────────────────────────────────┐
           │                                                                                    │
           │ 10. fontCompilation.compileCached() → worker message type: 'compileCached'          │
           │                                                                                    │
           │    fontc-worker.ts:                                                                 │
           │      case 'compileCached':                                                         │
           │        compile_cached_font(options)                                                │
           │          → get_or_rebuild_font_cache()                                             │
           │          → RetainGlyphs filter with subsetGlyphs                                   │
           │          → compile_with_feature_debug_context(&font, &options, "compile_cached_font")│
           │            → BabelfontIrSource::compile(font.clone(), options.clone())              │
           │            → zero_head_timestamps(&compiled)                                        │
           │              → parses table directory, finds 'head' table                          │
           │              → zeroes created[8] and modified[8] fields                           │
           │              → returns deterministic Vec<u8>                                        │
           │                                                                                    │
           │    (Editing font path also uses:                                                    │
           │      compile_cached_font_from_last_layout_closure(options)                          │
           │        → gets subset from LAYOUT_CLOSURE_CACHE                                     │
           │        → gets filtered font from FILTERED_FONT_CACHE                               │
           │        → compile_with_feature_debug_context(...)                                    │
           │        → zero_head_timestamps(&compiled) )                                         │
           │                                                                                    │
           └──────────────────┬─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
           ┌────────────────────────────────────────────────────────────────────────────────────┐
           │                                                                                    │
           │ 11. Client-side:                                                                    │
           │                                                                                    │
           │      Worker returns compiled font bytes → Promise resolves                          │
           │      editingFontCompiled CustomEvent fires                                          │
           │        → waitForCompileSettle resolves                                              │
           │        → (event listener + 300ms timeout + requestAnimationFrame)                  │
           │      HarfBuzz shapes text "aä" with new font                                       │
           │      Canvas re-renders with shaped glyph positions                                  │
           │      stabiliseCanvas(): gc.render() + 3×requestAnimationFrame + 50ms wait          │
           │      captureCanvas(): canvas.toDataURL('image/png') → base64 data URL              │
           │      expect.soft(canvas4).toBe(canvas2)  ← strict equality check                   │
           │                                                                                    │
           └────────────────────────────────────────────────────────────────────────────────────┘
    BRIDGE FALLBACK (triggered at step 5, inside _commitOperations → transaction finalizer):
    ┌───────────────────────────────────────────────────────────────────────────────────────────┐
    │                                                                                           │
    │    change-bridge-init.ts buildCascadingRecompositionOperations(bridge, operations)          │
    │                                                                                           │
    │      1) collectCascadeTriggerSourceTargets(operations) → source glyph/layer pairs          │
    │      2) operationCarriesCompleteGuiReplayTargets(op) for each operation                    │
    │         → checks if op.workerReplayTargets includes the direct source target               │
    │         → if ALL cascade-triggering ops are "complete" → return [] (skip fallback)         │
    │      3) If incomplete: calls computeLayerRecompositionClosure(...) same shared function!   │
    │      4) buildCascadeLayerOperations(bridge, closure.dependentTargets, operations)          │
    │         → emits extra layer-snapshot Yjs operations for dependents that changed            │
    │         → these extra operations ALSO carry full closure in workerReplayTargets            │
    │                                                                                           │
    └───────────────────────────────────────────────────────────────────────────────────────────┘

The undo/redo path diverges at step 5's listener chain. Instead of \_syncCurrentGlyphToYDoc, the undo path:
undo() (patch-sync-engine.ts)
→ targetItem = \_resolveUndoHistoryItem(glyph, layer, 'undo')
→ getSemanticEntriesForHistoryItem(targetItem, 'undo', ...)
→ clones forward entries (same workerReplayTargets)
→ workerReplayTargets = normalizeWorkerReplayTargets([
...(targetItem?.workerReplayTargets ?? []),
{ glyphName: target.glyphName, layerId: target.layerId }
])
→ createLogEntry({ workerReplayTargets, ... })
→ um?.undo() // Yjs reverts the undone edit's change
→ \_syncRemoteJsonFromYDoc(changeLogEntries) // Yjs→babelfontData sync
→ \_emitCanonicalLocalUpdateSince(localUpdateBaseline)
→ \_emitLocalUpdate(update, changeLogEntries)
→ same setYjsWorkerCallback, onCommittedChange, processCommittedEdit as
a forward edit — all driven from the same `workerReplayTargets` metadata
cloned from the original forward entry
