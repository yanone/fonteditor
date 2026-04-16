# Compilation Edit Policy

This document is the authoritative source for how edit sources map to compilation scheduling, compilation modes, worker caching, and canvas update behavior in the editor. Changes to this behavior are policy changes, not incidental refactors.

If you change compilation behavior, update this document in the same change and discuss the policy change with the author before merging it.

## Goals

- Use the fastest safe compilation mode for each edit type.
- Keep the incremental worker path hot: incremental layer patching, cached babelfont reuse, cached subset reuse, and the editing subset target before fontc.
- Preserve a trailing full compile after interactive edits so layout-sensitive state returns to the fully correct font.
- Avoid accidental regressions where an optimized compile mode still exists in code but stops being scheduled.

## Source Of Truth

The policy is implemented primarily in these files:

- `webapp/js/glyph-canvas/outline-editor.ts`
- `webapp/js/glyph-canvas.ts`
- `webapp/js/font-manager.ts`
- `webapp/js/font-compilation.ts`
- `webapp/js/fontc-worker.ts`

When these files disagree with this document, treat that as a bug and reconcile them immediately.

## Core Rules

1. Active mouse drags must continue triggering live editing compiles.
2. Active mouse drags must not trigger full compiles or the full babelfont JSON sync that feeds those full compiles while the pointer is still down.
3. Background full-font QC work must not start while the outline editor session is active; the shared worker must remain available for editing compiles and outline fetches.
4. Interactive keyboard edits must still compile live.
5. Interactive enriched edits must still schedule a trailing debounced full compile after the interaction settles.
6. Interactive drag and keyboard edits must continue using incremental layer updates into the worker rather than re-sending the full babelfont JSON.
7. Editing compiles must continue using the subsetted `editing` target before fontc.
8. Text input uses its own subset-only fast path and still schedules a deferred full compile after typing settles.
9. Full compiles remain the correctness fallback after interactive editing or when an edit type does not have a specialized fast path.

## Edit-Type Matrix

| Edit source                             | Origin                                                           | `lastEditType`                        | Immediate scheduling                             | Trailing debounce                                           | `compilationMode` | Option overrides                                                         | Worker font update path                                                                               | Canvas behavior                                                            |
| --------------------------------------- | ---------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `mouse-drag-outline`                    | `OutlineEditor` drag of nodes and sidebearings                   | `outline`                             | Yes, via `autoCompileManager.checkAndSchedule()` | Yes, `scheduleFullCompileDebounce()` re-arms until drag end | `outline-only`    | `skip_features: true`, `skip_kerning: true`, `produce_varc_table: false` | Incremental sentinel JSON plus `update_cached_layer()`; cached subset key reused                      | Live editing compile during drag; trailing full compile waits for mouseup  |
| `keyboard-outline`                      | `OutlineEditor` outline nudges and direct sidebearing saves      | `outline`                             | Yes                                              | Yes                                                         | `outline-only`    | `skip_features: true`, `skip_kerning: true`, `produce_varc_table: false` | Incremental sentinel JSON plus `update_cached_layer()`; cached subset key reused                      | Swap font blob and repaint only; skip HarfBuzz reshape                     |
| `mouse-drag-anchor`                     | `OutlineEditor` anchor drag                                      | `anchor`                              | Yes                                              | Yes, re-arms until drag end                                 | `anchor-only`     | `skip_kerning: true`, `produce_varc_table: false`                        | Incremental sentinel JSON plus `update_cached_layer()`; cached subset key reused                      | Live editing compile during drag; trailing full compile waits for mouseup  |
| `keyboard-anchor`                       | `OutlineEditor` anchor nudges                                    | `anchor`                              | Yes                                              | Yes                                                         | `anchor-only`     | `skip_kerning: true`, `produce_varc_table: false`                        | Incremental sentinel JSON plus `update_cached_layer()`; cached subset key reused                      | Swap font blob, reshape text, repaint                                      |
| `mouse-drag-guide`                      | `OutlineEditor` guide drag                                       | `null`                                | Yes                                              | No                                                          | `full`            | None                                                                     | Incremental sentinel JSON plus `update_cached_layer()` because it is still an interactive layer save  | Editing compile may run during drag; full compile manager remains deferred |
| `keyboard`                              | Generic `saveLayerData()` keyboard save without edit-type suffix | `null`                                | Yes                                              | No                                                          | `full`            | None                                                                     | Incremental sentinel JSON plus `update_cached_layer()` because `compileSource` starts with `keyboard` | Full compile/render path                                                   |
| `text-input`                            | `GlyphCanvas` text shaping subset updates                        | Not derived through `saveLayerData()` | Immediate direct compile call                    | Yes, `scheduleTextInputFullCompile()`                       | `text-input`      | `produce_varc_table: false`                                              | No full JSON transfer; worker reuses cached font and compiles against the updated subset key          | Specialized text-input path; keep shaping/layout intact                    |
| `text-input-full-compile`               | Deferred correctness pass after typing settles                   | `null`                                | Yes                                              | N/A, this is the debounce target                            | `full`            | None                                                                     | Reuses cached font data when possible; full compile wake-up through dirty flag                        | Full compile/render path                                                   |
| Debounced post-interaction full compile | `FontManager.scheduleFullCompileDebounce()`                      | Reset to `null` before compile        | Yes, when debounce fires                         | N/A, this is the debounce target                            | `full`            | None                                                                     | Uses latest synchronized babelfont JSON after pending sync is flushed                                 | Full compile/render path                                                   |

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

### Interactive layer saves

`FontManager.saveLayerData()` does three separate things for interactive saves and all three are required:

1. It marks the font dirty immediately.
2. It wakes `autoCompileManager` immediately so live editing compiles continue during dragging.
3. For `outline` and `anchor` edits, it also schedules `scheduleFullCompileDebounce()` so the editor returns to a full compile after the interaction.

While the pointer is still down for a mouse drag, the live editing compile path must remain active. What must stay suppressed is only the full-compile side: full compile execution itself and the JSON/model sync required to feed that full compile. Mid-drag pauses may continue to produce editing compiles, but must not flush `pendingBabelfontJsonSyncAfterDrag` or run full-font compilation until the drag ends.

### Debounced full compile

`scheduleFullCompileDebounce()` is the correctness pass after interactive edits. It resets `lastEditType` to `null`, requests recompilation without additional data changes, and wakes the auto-compile loop to produce a full compile with features and kerning restored.

If an outline or anchor drag is still active when the debounce fires, the debounce must re-arm itself and wait until the drag has ended before flushing `pendingBabelfontJsonSyncAfterDrag`. Flushing the pending JSON/model sync during an active drag is a regression because it can commit a stale mid-drag state into the trailing full-compile baseline and break undo.

Separately, active mouse drags must not let the full-font compile path run. The editing compile manager remains active during drag; only the trailing full compile and full-font compile manager must stay deferred until mouseup.

### Background full-font QC while outline editing

The background full-font compile manager shares the same worker as interactive editing compiles and explicit glyph outline fetches. When the outline editor session is active, background full-font QC must stay deferred even if no drag is currently in progress. Otherwise the worker can be monopolized by `compileFromJson` and Fontspector work just before the next point drag or key nudge, causing the following editing compile to block behind background jobs.

The monitor loop may continue polling while outline editing is active, but it must not start a full-font compile until the editor leaves outline editing mode.

### Text input

Text input does not go through `saveLayerData()`. Instead it:

1. Recomputes the editing subset.
2. Marks `lastChangeSource = 'text-input'`.
3. Calls `compileEditingFont()` directly so no full font JSON transfer is needed.
4. Schedules `scheduleTextInputFullCompile()` to restore a full compile after typing settles.

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

### Anchor edits

Anchor edits still benefit from incremental layer patching and cached subset reuse, but they cannot skip all feature work because GPOS mark attachment must stay correct. They keep a live compile path, but use `anchor-only` rather than `outline-only`.

### Generic keyboard saves

Generic `keyboard` saves do not carry an edit-type suffix, so they fall back to full compile mode while still benefiting from the interactive worker path when the save came from `saveLayerData()`.

### Text input

Text input changes the shaping subset rather than the font data. It therefore bypasses `saveLayerData()`, reuses the cached worker font, compiles only the updated editing subset, and schedules a trailing full compile for correctness.

## Non-Regression Requirements

The following are required and should be covered by tests or explicit review whenever compilation code changes:

1. `mouse-drag-outline` and `mouse-drag-anchor` continue to wake live editing compilation during drag and still schedule the trailing full compile.
2. The trailing full compile for drag edits does not execute, and its pending JSON/model sync does not flush, until the drag has ended.
3. `keyboard-outline` and `keyboard-anchor` continue to wake compilation immediately and still schedule the trailing full compile.
4. Interactive layer edits continue to use `update_cached_layer()` rather than full font JSON transfer in the steady state.
5. The editing compile continues to use the subsetted `editing` target before fontc.
6. `outline-only` still skips reshape and `anchor-only` still reshapes.
7. Text input still uses the subset-only fast path and still schedules a deferred full compile.

## Change Control

This document must always be followed.

Any change to compilation policy, scheduling, cache invalidation, subset handling, worker update strategy, or compile-mode mapping must be discussed with the author before implementation and this document must be updated in the same change.
