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

1. Active mouse drags must not trigger editing compiles, full compiles, or full babelfont JSON sync while the pointer is still down.
2. Interactive keyboard edits must still compile live.
3. Interactive enriched edits must still schedule a trailing debounced full compile after the interaction settles.
4. Interactive drag and keyboard edits must continue using incremental layer updates into the worker rather than re-sending the full babelfont JSON.
5. Editing compiles must continue using the subsetted `editing` target before fontc.
6. Text input uses its own subset-only fast path and still schedules a deferred full compile after typing settles.
7. Full compiles remain the correctness fallback after interactive editing or when an edit type does not have a specialized fast path.

## Edit-Type Matrix

| Edit source                             | Origin                                                           | `lastEditType`                        | Immediate scheduling                           | Trailing debounce                             | `compilationMode` | Option overrides                                                         | Worker font update path                                                                               | Canvas behavior                                               |
| --------------------------------------- | ---------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------- | --------------------------------------------- | ----------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `mouse-drag-outline`                    | `OutlineEditor` drag of nodes and sidebearings                   | `outline`                             | No while drag is active; wake once on drag end | No while drag is active; schedule on drag end | `outline-only`    | `skip_features: true`, `skip_kerning: true`, `produce_varc_table: false` | Incremental layer state stays local during drag; worker/cache sync resumes after drag end             | Live layerData redraw during drag; compile resumes on mouseup |
| `keyboard-outline`                      | `OutlineEditor` outline nudges and direct sidebearing saves      | `outline`                             | Yes                                            | Yes                                           | `outline-only`    | `skip_features: true`, `skip_kerning: true`, `produce_varc_table: false` | Incremental sentinel JSON plus `update_cached_layer()`; cached subset key reused                      | Swap font blob and repaint only; skip HarfBuzz reshape        |
| `mouse-drag-anchor`                     | `OutlineEditor` anchor drag                                      | `anchor`                              | No while drag is active; wake once on drag end | No while drag is active; schedule on drag end | `anchor-only`     | `skip_kerning: true`, `produce_varc_table: false`                        | Incremental layer state stays local during drag; worker/cache sync resumes after drag end             | Live layerData redraw during drag; compile resumes on mouseup |
| `keyboard-anchor`                       | `OutlineEditor` anchor nudges                                    | `anchor`                              | Yes                                            | Yes                                           | `anchor-only`     | `skip_kerning: true`, `produce_varc_table: false`                        | Incremental sentinel JSON plus `update_cached_layer()`; cached subset key reused                      | Swap font blob, reshape text, repaint                         |
| `mouse-drag-guide`                      | `OutlineEditor` guide drag                                       | `null`                                | No while drag is active; wake once on drag end | No                                            | `full`            | None                                                                     | Incremental layer state stays local during drag; worker/cache sync resumes after drag end             | Live guide redraw during drag; compile resumes on mouseup     |
| `keyboard`                              | Generic `saveLayerData()` keyboard save without edit-type suffix | `null`                                | Yes                                            | No                                            | `full`            | None                                                                     | Incremental sentinel JSON plus `update_cached_layer()` because `compileSource` starts with `keyboard` | Full compile/render path                                      |
| `text-input`                            | `GlyphCanvas` text shaping subset updates                        | Not derived through `saveLayerData()` | Immediate direct compile call                  | Yes, `scheduleTextInputFullCompile()`         | `text-input`      | `produce_varc_table: false`                                              | No full JSON transfer; worker reuses cached font and compiles against the updated subset key          | Specialized text-input path; keep shaping/layout intact       |
| `text-input-full-compile`               | Deferred correctness pass after typing settles                   | `null`                                | Yes                                            | N/A, this is the debounce target              | `full`            | None                                                                     | Reuses cached font data when possible; full compile wake-up through dirty flag                        | Full compile/render path                                      |
| Debounced post-interaction full compile | `FontManager.scheduleFullCompileDebounce()`                      | Reset to `null` before compile        | Yes, when debounce fires                       | N/A, this is the debounce target              | `full`            | None                                                                     | Uses latest synchronized babelfont JSON after pending sync is flushed                                 | Full compile/render path                                      |

## Scheduling Details

### Interactive layer saves

`FontManager.saveLayerData()` does three separate things for interactive saves and all three are required once the interaction is ready to compile:

1. It marks the font dirty immediately.
2. If a mouse drag is no longer active, it wakes `autoCompileManager` so compilation resumes from the settled drag state.
3. For `outline` and `anchor` edits, if the drag is no longer active, it also schedules `scheduleFullCompileDebounce()` so the editor returns to a full compile after the interaction.

While the pointer is still down for a mouse drag, step 2 and step 3 must stay suppressed. Mid-drag pauses must not trigger editing compiles, full compiles, or the JSON/model sync required to feed those compiles. The final mouseup save is the first point where compile wakeups may resume.

### Debounced full compile

`scheduleFullCompileDebounce()` is the correctness pass after interactive edits. It resets `lastEditType` to `null`, requests recompilation without additional data changes, and wakes the auto-compile loop to produce a full compile with features and kerning restored.

If an outline or anchor drag is still active when the debounce fires, the debounce must re-arm itself and wait until the drag has ended before flushing `pendingBabelfontJsonSyncAfterDrag`. Flushing the pending JSON/model sync during an active drag is a regression because it can commit a stale mid-drag state into the trailing full-compile baseline and break undo.

Separately, active mouse drags must not wake either compile manager in the first place. A paused drag should remain on live `layerData` rendering only, without any editing compile or full compile work until mouseup.

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

1. `mouse-drag-outline` and `mouse-drag-anchor` do not wake compilation while the drag is active, but they do wake it from the final post-drag save and still schedule the trailing full compile.
2. `keyboard-outline` and `keyboard-anchor` continue to wake compilation immediately and still schedule the trailing full compile.
3. Interactive layer edits continue to use `update_cached_layer()` rather than full font JSON transfer in the steady state.
4. The editing compile continues to use the subsetted `editing` target before fontc.
5. `outline-only` still skips reshape and `anchor-only` still reshapes.
6. Text input still uses the subset-only fast path and still schedules a deferred full compile.

## Change Control

This document must always be followed.

Any change to compilation policy, scheduling, cache invalidation, subset handling, worker update strategy, or compile-mode mapping must be discussed with the author before implementation and this document must be updated in the same change.
