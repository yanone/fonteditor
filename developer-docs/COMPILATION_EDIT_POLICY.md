# Compilation Edit Policy

This document is the authoritative source for how edit sources map to compilation scheduling, compilation modes, worker caching, and canvas update behavior in the editor. Changes to this behavior are policy changes, not incidental refactors.

If you change compilation behavior, update this document in the same change and discuss the policy change with the author before merging it.

## Goals

- Use the fastest safe compilation mode for each edit type.
- Keep the incremental worker path hot: incremental layer patching, cached babelfont reuse, cached subset reuse, and the editing subset target before fontc.
- Preserve a trailing full compile after interactive edits so layout-sensitive state returns to the fully correct font.
- Avoid accidental regressions where an optimized compile mode still exists in code but stops being scheduled.
- Only the main window runs full-font compilation and Fontspector; linked windows must not schedule or execute either.

## Source Of Truth

The policy is implemented primarily in these files:

- `webapp/js/glyph-canvas/outline-editor.ts`
- `webapp/js/glyph-canvas.ts`
- `webapp/js/font-manager.ts`
- `webapp/js/font-compilation.ts`
- `webapp/js/fontc-worker.ts`
- `webapp/js/full-font-compile-manager.ts`

When these files disagree with this document, treat that as a bug and reconcile them immediately.

## Core Rules

1. Active mouse drags must continue triggering live editing compiles.
2. Active mouse drags must not trigger full compiles or the full babelfont JSON sync that feeds those full compiles while the pointer is still down.
3. Background full-font QC work must not start while an outline drag is active; the shared worker must remain available for editing compiles and outline fetches.
4. Interactive keyboard edits must still compile live.
5. Interactive enriched edits must still schedule a trailing debounced full compile after the interaction settles.
6. Interactive drag and keyboard edits must continue using incremental layer updates into the worker rather than re-sending the full babelfont JSON.
7. Editing compiles must continue using the subsetted `editing` target before fontc.
8. Text input uses its own subset-only fast path and still schedules a deferred full compile after typing settles.
9. Full compiles remain the correctness fallback after interactive editing or when an edit type does not have a specialized fast path.
10. Linked windows must not run full-font compilation or Fontspector; only the main window may schedule and execute them. The `full-font-compile-manager` checks `windowRole.isMainWindow()` at every scheduling entry point and suppresses the monitor loop for linked windows.

## Edit-Type Matrix

| Edit source                             | Origin                                                           | `lastEditType`                        | Immediate scheduling                                                                | Trailing debounce                                                                                         | `compilationMode` | Option overrides                                                         | Worker font update path                                                                                                                                                                | Canvas behavior                                                                                       |
| --------------------------------------- | ---------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `mouse-drag-outline`                    | `OutlineEditor` drag of nodes and sidebearings                   | `outline`                             | Yes, via `refreshGlyphsAfterModelBatch()` + `autoCompileManager.checkAndSchedule()` | Yes, final mouseup `saveLayerData()` arms the trailing full compile                                       | `outline-only`    | `skip_features: true`, `skip_kerning: true`, `produce_varc_table: false` | Drag-time model sync plus incremental `refreshGlyphsAfterModelBatch()` for the edited layer and visible metrics dependents; final mouseup save restores the pending full-sync baseline | Live editing compile during drag; trailing full compile waits for mouseup                             |
| `mouse-drag-sidebearing`                | `OutlineEditor` sidebearing handle drag                          | `outline`                             | Yes, via recomposition loop + `autoCompileManager.checkAndSchedule()`               | Yes, `scheduleFullCompileDebounce()` re-arms until drag end; mouseup calls `saveLayerData` for final sync | `outline-only`    | `skip_features: true`, `skip_kerning: true`, `produce_varc_table: false` | No `saveLayerData` during drag; live refresh syncs model + `refreshGlyphsAfterModelBatch` sends all affected layers in one batch; cached subset key reused                             | Live editing compile during drag (no overview tile repaints); trailing full compile waits for mouseup |
| `keyboard-outline`                      | `OutlineEditor` outline nudges and direct sidebearing saves      | `outline`                             | Yes                                                                                 | Yes                                                                                                       | `outline-only`    | `skip_features: true`, `skip_kerning: true`, `produce_varc_table: false` | Incremental sentinel JSON plus `update_cached_layer()`; cached subset key reused                                                                                                       | Swap font blob and repaint only; skip HarfBuzz reshape                                                |
| `keyboard-sidebearing`                  | `OutlineEditor` keyboard sidebearing adjustments (nudge, set)    | `outline`                             | Yes                                                                                 | Yes                                                                                                       | `outline-only`    | `skip_features: true`, `skip_kerning: true`, `produce_varc_table: false` | Incremental batch via `refreshGlyphsAfterModelBatch`; cached subset key reused                                                                                                         | Swap font blob and repaint only; skip HarfBuzz reshape                                                |
| `mouse-drag-anchor`                     | `OutlineEditor` anchor drag                                      | `anchor`                              | Yes, via recomposition loop + `autoCompileManager.checkAndSchedule()`               | Yes, `scheduleFullCompileDebounce()` re-arms until drag end; mouseup calls `saveLayerData` for final sync | `anchor-only`     | `skip_kerning: true`, `produce_varc_table: false`                        | No `saveLayerData` during drag; recomposition syncs model + `refreshGlyphsAfterModelBatch` sends all affected layers in one batch; cached subset key reused                            | Live editing compile during drag (no overview tile repaints); trailing full compile waits for mouseup |
| `keyboard-anchor`                       | `OutlineEditor` anchor nudges                                    | `anchor`                              | Yes                                                                                 | Yes                                                                                                       | `anchor-only`     | `skip_kerning: true`, `produce_varc_table: false`                        | Incremental sentinel JSON plus `update_cached_layer()`; cached subset key reused                                                                                                       | Swap font blob, reshape text, repaint                                                                 |
| `mouse-drag-guide`                      | `OutlineEditor` guide drag                                       | `null`                                | Yes                                                                                 | No                                                                                                        | `full`            | None                                                                     | Incremental sentinel JSON plus `update_cached_layer()` because it is still an interactive layer save                                                                                   | Editing compile may run during drag; full compile manager remains deferred                            |
| `keyboard`                              | Generic `saveLayerData()` keyboard save without edit-type suffix | `null`                                | Yes                                                                                 | No                                                                                                        | `full`            | None                                                                     | Incremental sentinel JSON plus `update_cached_layer()` because `compileSource` starts with `keyboard`                                                                                  | Full compile/render path                                                                              |
| `text-input`                            | `GlyphCanvas` text shaping subset updates                        | Not derived through `saveLayerData()` | Immediate direct compile call                                                       | Yes, `scheduleTextInputFullCompile()`                                                                     | `text-input`      | `produce_varc_table: false`                                              | No full JSON transfer; worker reuses cached font and compiles against the updated subset key                                                                                           | Specialized text-input path; keep shaping/layout intact                                               |
| `feature-code-edit`                     | `FontInfoManager` OpenType feature source edits                  | `null`                                | Yes, on Cmd+Enter, editor blur, and 5 s typing debounce                             | No separate trailing debounce; the idle timer is itself the compile trigger                               | `full`            | None                                                                     | Sync full babelfont JSON from the model before recompiling so feature code, GSUB, and GPOS rebuild from current source                                                                 | Full compile/render path                                                                              |
| `text-input-full-compile`               | Deferred correctness pass after typing settles                   | `null`                                | Yes                                                                                 | N/A, this is the debounce target                                                                          | `full`            | None                                                                     | Reuses cached font data when possible; full compile wake-up through dirty flag                                                                                                         | Full compile/render path                                                                              |
| Debounced post-interaction full compile | `FontManager.scheduleFullCompileDebounce()`                      | Reset to `null` before compile        | Yes, when debounce fires                                                            | N/A, this is the debounce target                                                                          | `full`            | None                                                                     | Uses latest synchronized babelfont JSON after pending sync is flushed                                                                                                                  | Full compile/render path                                                                              |
| `remote-anchor`                         | Linked window `onRemoteChange` from a main-window anchor edit    | `anchor`                              | Yes, via `autoCompileManager.checkAndSchedule()`                                    | No (trailing full compile handled by main window)                                                         | `anchor-only`     | `skip_kerning: true`, `produce_varc_table: false`                        | Incremental layer updates via `workerReplayTargets` from change log entries; no full JSON resync to worker                                                                             | Linked window editing font updated; canvas refreshed                                                  |
| `remote-outline`                        | Linked window `onRemoteChange` from a main-window outline edit   | `outline`                             | Yes, via `autoCompileManager.checkAndSchedule()`                                    | No (trailing full compile handled by main window)                                                         | `outline-only`    | `skip_features: true`, `skip_kerning: true`, `produce_varc_table: false` | Incremental layer updates via `workerReplayTargets` from change log entries; no full JSON resync to worker                                                                             | Linked window editing font updated; canvas refreshed                                                  |
| `remote-change`                         | Linked window `onRemoteChange` (unknown edit type)               | `null`                                | Yes, via `autoCompileManager.checkAndSchedule()`                                    | No (trailing full compile handled by main window)                                                         | `full`            | None                                                                     | `syncRustCacheAndRefreshCanvas` with available replay targets; falls back to full JSON resync when targets unavailable                                                                 | Full compile/render path in linked window                                                             |

## Scheduling Details

### Undo/redo

Undo/redo must request an editing-font compile immediately so the auto-compile
loop wakes up, and must request it again after `syncRustCacheAndRefreshCanvas()`
completes. The second request is required because undo/redo first patches the
model/Yjs state and only then refreshes the Rust worker cache. Without the
post-refresh request, the first compile can run against stale worker cache data
and leave the editing font one undo step behind.

Undo/redo should prefer incremental worker-cache refresh whenever the recorded
history entries carry explicit layer replay targets. Change messages for
interactive layer-backed edits must therefore persist the exact glyph/layer
targets needed to repopulate the worker with `storeLayerUpdates`. Full
`storeFontJson` remains the fallback only for edits whose history entries do not
carry replayable layer targets, such as true font-wide data changes.

When the undone/redone history item touches anchors, undo/redo must set
`lastEditType = 'anchor'` (and `lastChangeSource = 'keyboard-anchor'`) before
requesting the editing-font compile so the compile loop uses the faster
`anchor-only` mode instead of `full`. When the undone/redone history item
touches sidebearings, undo/redo must set `lastEditType = 'outline'` (and
`lastChangeSource = 'keyboard-outline'`) so the compile loop uses the faster
`outline-only` mode instead of `full`. The trailing debounced full compile still
resets `lastEditType` to `null` for correctness, but the immediate editing-font
compile benefits from the same fast path as the original edit.

Anchor-edit history entries (both mouse-drag and keyboard) must carry
`workerReplayTargets` that include all downstream auto-composite glyph/layer
pairs. For keyboard anchor nudges, `rebuildAutomaticCompositesForCurrentEditedGlyph`
must run before `saveLayerData` so the model is current when the Yjs entry is
recorded, and `_syncCurrentGlyphToYDoc` must pass the collected targets. This
ensures that `shouldForceFullRustSyncAfterUndoRedo` returns `false` (incremental
path) instead of forcing a slow full `storeFontJson` on undo.

### Interactive layer saves

`FontManager.saveLayerData()` does three separate things for interactive saves and all three are required for keyboard saves and drag-finalization saves:

1. It marks the font dirty immediately.
2. It wakes `autoCompileManager` immediately so live editing compiles continue during dragging.
3. For `outline` and `anchor` edits, it also schedules `scheduleFullCompileDebounce()` so the editor returns to a full compile after the interaction.

While the pointer is still down for a mouse drag, the live editing compile path must remain active. What must stay suppressed is only the full-compile side: full compile execution itself and the JSON/model sync required to feed that full compile. Mid-drag pauses may continue to produce editing compiles, but must not flush `pendingBabelfontJsonSyncAfterDrag` or run full-font compilation until the drag ends.

Outline point/component drags now mirror the anchor-drag pattern during the active drag: they keep the model current, batch-refresh the edited layer plus visible metrics-key dependents into the worker with `refreshGlyphsAfterModelBatch()`, and request recompilation without routing every drag tick through `saveLayerData()`. The final `saveLayerData('mouse-drag-outline')` still fires on mouseup for Yjs/collaboration sync, undo history, and the trailing full compile baseline.

Anchor drags skip `saveLayerData()` entirely during the drag. Instead, the recomposition loop (`queueLiveVisibleAnchorDependentRefresh`) keeps the model in sync via `syncFromEditorLayerData` + `rebuildAutomaticCompositesForGlyphs`, and sends all affected layers (source + downstream) to the worker in a single `refreshGlyphsAfterModelBatch` call. The final `saveLayerData('mouse-drag-anchor')` fires on mouseup for the Yjs/collaboration sync and undo history.

Sidebearing drags skip `saveLayerData()` during the drag, mirroring the anchor drag pattern. The live refresh loop (`queueLiveVisibleSidebearingDependentRefresh`) keeps the model in sync via `syncFromEditorLayerData` + `recomputeMetricsKeys` with `skipAutomaticCompositeRebuild: true`, and sends all affected layers (source + downstream) to the worker in a single `refreshGlyphsAfterModelBatch` call. The final `saveLayerData('mouse-drag-outline')` fires on mouseup for the Yjs/collaboration sync and undo history.

Keyboard sidebearing adjustments use the same incremental `refreshGlyphsAfterModelBatch` path for downstream glyphs instead of the full `syncJsonFromModel` + `forceFullWorkerCacheUpdate` path.

### Debounced full compile

`scheduleFullCompileDebounce()` is the correctness pass after interactive edits. It resets `lastEditType` to `null`, requests recompilation without additional data changes, and wakes the auto-compile loop to produce a full compile with features and kerning restored.

If an outline or anchor drag is still active when the debounce fires, the debounce must re-arm itself and wait until the drag has ended before flushing `pendingBabelfontJsonSyncAfterDrag`. Flushing the pending JSON/model sync during an active drag is a regression because it can commit a stale mid-drag state into the trailing full-compile baseline and break undo.

Separately, active mouse drags must not let the full-font compile path run. The editing compile manager remains active during drag; only the trailing full compile and full-font compile manager must stay deferred until mouseup.

### Background full-font QC while dragging

The background full-font compile manager shares the same worker as interactive editing compiles and explicit glyph outline fetches. When an outline drag is active, background full-font QC must stay deferred. Otherwise the worker can be monopolized by `compileFromJson` and Fontspector work mid-drag, causing the following editing compile to block behind background jobs.

The monitor loop may continue polling while editing is idle, and it should resume full-font compilation as soon as the drag ends so Fontspector and the full-compile indicator catch up to the current font version, including after Python-driven edits.

### Text input

Text input does not go through `saveLayerData()`. Instead it:

1. Recomputes the editing subset.
2. Marks `lastChangeSource = 'text-input'`.
3. Calls `compileEditingFont()` directly so no full font JSON transfer is needed.
4. Schedules `scheduleTextInputFullCompile()` to restore a full compile after typing settles.

### OpenType feature source edits

OpenType feature source edits in the font-info Features editor are font-wide source changes, so they must stay on the full compile path rather than any outline or text-input fast path.

The editor commits and recompiles feature code in three cases:

1. Immediately on `Cmd+Enter` / `Ctrl+Enter`.
2. Immediately when the Ace editor loses focus.
3. Automatically after 5 seconds with no further typing.

All three triggers must use the same commit path: write the current Ace buffer into the model, mark the font dirty, sync babelfont JSON from the model, and call `recompileEditingFont()`. Blur and explicit commit must cancel any pending idle timer so one edit burst produces at most one automatic compile.

## Worker Cache Policy

The fast path depends on these rules staying true:

1. Drag and keyboard layer edits use the incremental sentinel JSON path in `font-compilation.ts` rather than sending the full babelfont JSON to the worker.
2. `fontc-worker.ts` patches the cached font via `update_cached_layer()` whenever dirty glyph, layer ID, and layer data are available.
3. The editing subset key is reused when unchanged so layout closure does not get rebuilt unnecessarily.
4. Full `store_font()` calls are fallbacks for invalidation or missing cache state, not the steady-state path for interactive editing.

Any change that increases full JSON transfers during interactive editing is a regression unless explicitly documented and approved.

## Rendering Policy

1. `outline-only` compiles must skip HarfBuzz reshape and only swap the font blob plus repaint.
2. `anchor-only` compiles must reshape text because anchor edits affect GPOS positioning.
3. `full` compiles continue through the existing complete render/update path.
4. `text-input` stays on its dedicated path because the font data is unchanged and only the shaped subset changed.

## Rationale By Edit Type

### Outline edits

Outline and sidebearing edits only change glyph geometry. They can use the most aggressive fast path: incremental layer patching, the subsetted editing target, no feature compilation, no kerning compilation, no VARC generation, and no text reshape on the canvas.

### Sidebearing edits with cascading metrics keys

Sidebearing edits that trigger metrics-key cascades use a fast path in `recomputeMetricsKeys` with `skipAutomaticCompositeRebuild: true`. This skips the expensive `rebuildAutomaticComposition()` layout recalculation for downstream automatic-composite layers, instead directly updating their widths. For LSB cascades, the downstream layer contents are translated horizontally (so RSB stays intact); for RSB cascades, only the advance width changes. The model is pushed to the worker via incremental `refreshGlyphsAfterModelBatch` instead of a full JSON sync.

### Anchor edits

Anchor edits still benefit from incremental layer patching and cached subset reuse, but they cannot skip all feature work because GPOS mark attachment must stay correct. They keep a live compile path, but use `anchor-only` rather than `outline-only`.

### Generic keyboard saves

Generic `keyboard` saves do not carry an edit-type suffix, so they fall back to full compile mode while still benefiting from the interactive worker path when the save came from `saveLayerData()`.

### Text input

Text input changes the shaping subset rather than the font data. It therefore bypasses `saveLayerData()`, reuses the cached worker font, compiles only the updated editing subset, and schedules a trailing full compile for correctness.

### Linked windows

Linked windows share the same font model as the main window via Y.Doc sync. They need editing compiles for live canvas feedback but must not duplicate the expensive full-font compilation and Fontspector QC work that the main window already performs.

**Full-font compile suppression:** The `full-font-compile-manager` enforces `windowRole.isMainWindow()` in `scheduleCompilation`, `checkAndSchedule`, `runCompilationLoop`, `setEnabled`, and the startup monitor loop. Linked windows report Fontspector status as `idle` and never start the monitor interval.

**Editing compile efficiency:** When a linked window receives a remote change, `onRemoteChange` extracts edit-type metadata and `workerReplayTargets` from the change log entries and uses them to:

1. Pass `workerReplayTargets` to `syncRustCacheAndRefreshCanvas` for incremental layer updates to the WASM worker cache (instead of a full JSON resync).
2. Infer the original edit type (`anchor` / `outline`) so the linked window's editing compile uses the matching fast-path compilation mode (`anchor-only` / `outline-only`) instead of always falling back to the slowest `full` mode.
3. Set `lastChangeSource` to `remote-anchor` or `remote-outline` (or `remote-change` for unknown types) so `isIncrementalEditingCompile` recognizes the source and the compile uses the correct compilation mode.

For sidebearing edits that update downstream metrics-key dependents, the sender must sync the full affected layer batch through `syncLayersFromJson`, not only attach `workerReplayTargets`. The receiver still rebuilds the object model from the patched Y.Doc via `Font.fromData`, but that Y.Doc patch must include every affected layer so linked windows see the same downstream layer state that the Rust worker cache receives. Batched keyboard sidebearing entries may carry a generic transaction label such as `Arrow key`; in that case, explicit side metadata (`visualAnchorSide`) must still allow the receiver to classify the edit as `remote-outline` and keep the outline-only fast path.

**Echo gate (Y.Doc broadcast filter):** The `ChangeBridge` constructor's Y.Doc `update` listener uses a whitelist of known local edit origins (`USER_EDIT_ORIGIN`, `FONT_EDIT_ORIGIN`, `GLYPH_EDIT_ORIGIN`, `HISTORY_REPLAY_ORIGIN`, and `LAYER_EDIT_ORIGIN_PREFIX`-prefixed origins) to decide which updates to broadcast to other windows. Yjs CRDT reconciliation updates have `origin = undefined` and must NOT be broadcast, or they create a ping-pong echo loop between windows.

The linked window's editing font is recompiled because each window has a different editing subset (the glyphs visible in that window's editor view). The compilation uses the same fast-path mode as the originating edit, keeping it efficient.

## Non-Regression Requirements

The following are required and should be covered by tests or explicit review whenever compilation code changes:

1. `mouse-drag-outline`, `mouse-drag-sidebearing`, and `mouse-drag-anchor` continue to wake live editing compilation during drag and still schedule the trailing full compile.
2. The trailing full compile for drag edits does not execute, and its pending JSON/model sync does not flush, until the drag has ended.
3. `keyboard-outline`, `keyboard-sidebearing`, and `keyboard-anchor` continue to wake compilation immediately and still schedule the trailing full compile.
4. Interactive layer edits continue to use `update_cached_layer()` rather than full font JSON transfer in the steady state.
5. The editing compile continues to use the subsetted `editing` target before fontc.
6. `outline-only` still skips reshape and `anchor-only` still reshapes.
7. Text input still uses the subset-only fast path and still schedules a deferred full compile.
8. Sidebearing edits with cascading metrics keys use `refreshGlyphsAfterModelBatch` instead of `forceFullWorkerCacheUpdate`, and skip `rebuildAutomaticComposites` for downstream automatic-composite layers that only need width updates.
9. Undo/redo of anchor edits uses `anchor-only` compilation mode and incremental worker-cache refresh (not full `storeFontJson`) when the history item carries `workerReplayTargets` for downstream auto-composite layers.
10. Undo/redo of sidebearing edits uses `outline-only` compilation mode and incremental worker-cache refresh when the history item carries `workerReplayTargets` for downstream layers affected by metrics-key cascades.
11. Linked windows never schedule or execute full-font compilation or Fontspector; only the main window does.
12. Linked windows recompile their own editing font on remote changes, using the same fast-path compilation mode (anchor-only / outline-only) as the originating edit when the change log entries carry the edit-type metadata.
13. OpenType feature source edits auto-compile on blur and after 5 seconds of typing idle, while cancelling the pending idle timer when an immediate commit already ran.

## Change Control

This document must always be followed.

Any change to compilation policy, scheduling, cache invalidation, subset handling, worker update strategy, or compile-mode mapping must be discussed with the author before implementation and this document must be updated in the same change.
