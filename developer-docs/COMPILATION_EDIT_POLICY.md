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
6. Interactive drag and keyboard edits must continue using incremental JSON patch batches into the worker rather than re-sending the full babelfont JSON.
7. Editing compiles must continue using the subsetted `editing` target before fontc.
8. Text input uses its own subset-only fast path and still schedules a deferred full compile after typing settles.
9. Full compiles remain the correctness fallback after interactive editing or when an edit type does not have a specialized fast path.
10. Linked windows must not run full-font compilation or Fontspector; only the main window may schedule and execute them. The `full-font-compile-manager` checks `windowRole.isMainWindow()` at every scheduling entry point and suppresses the monitor loop for linked windows.
11. Every interactive commit MUST cross the JS ↔ Rust/worker boundary through `submitLayerUpdatesToWorkerCache` (one batched `applyJsonPatches` worker message per commit, regardless of the number of changed layers). Full-font `storeFontJson` crossings MUST stay at zero outside of font open, external reload, and explicit force-full sync (`forceFullWorkerCacheUpdate`). The receiver path (`syncRustCacheAndRefreshCanvas`) and undo/redo path use `refreshWorkerCacheForReplayTargets` for the same single-batch crossing; the receiver fallback `submitLayerToWorkerCache` (singular) routes through the same batched API so its boundary-crossing counters and fingerprint-cache updates are uniform. The fingerprint baseline used to skip unchanged layers is the in-memory `workerLayerFingerprintCache`; it is updated incrementally on every successful submit and cleared on every full-font crossing (`recordFullFontCrossing`), so the cache stays consistent with whatever Rust currently holds without ever re-deriving fingerprints by parsing `babelfontJson` on the hot path.
12. Collaboration and history transport MUST use named forward/inverse patch pairs, not raw numeric JSON Pointer batches. The source window derives those pairs from the same concrete document diff that would produce RFC 6902 JSON patches, then rewrites glyph/layer array segments to stable glyph-name/layer-id addresses before sending them to linked windows or cloud history.
13. Python edits MUST follow the same rule: derive forward/inverse JSON patch pairs from normalized before/after font snapshots, translate them to named patch pairs, then feed the bridge/history pipeline from those translated pairs. Python must not bypass the shared collaboration funnel with ad hoc full-font sync alone.

## Boundary-Crossing Budget

`FontManager` exposes `getBoundaryCrossingStats()` and `resetBoundaryCrossingStats()` so tests and the AI profiling harness can pin per-edit traffic across the JS ↔ Rust/worker boundary. The locked-down budget is:

| Operation                                                      | `submitBatchCalls` | `layersTransmitted` | `glyphsTransmitted` | `fullFontCrossings` |
| -------------------------------------------------------------- | ------------------ | ------------------- | ------------------- | ------------------- |
| Single-layer commit (keyboard / drag-end)                      | `1`                | `1`                 | `1`                 | `0`                 |
| Multi-glyph cascade commit (e.g. anchor cascade, metrics keys) | `1`                | `N` (changed)       | `M` (distinct)      | `0`                 |
| Receiver `syncRustCacheAndRefreshCanvas` with replay targets   | `1`                | `N` (targets)       | `M` (distinct)      | `0`                 |
| Undo / redo with `workerReplayTargets`                         | `1`                | `N` (targets)       | `M` (distinct)      | `0`                 |
| Font open / external reload / `forceFullWorkerCacheUpdate`     | `0`                | `0`                 | `0`                 | `1`                 |

Steady-state lock-down: 50+ sequential commits MUST keep the per-commit budget flat at `(1, 1, 1, 0)`. Any growth indicates a regression. `tests/font-manager.test.js` (`FontManager boundary-crossing budget`) enforces this directly.

## History-Notification Budget

Every change-log notification fires `bridge.onChangeLogUpdate` listeners synchronously inside the transaction commit, so any per-listener cost is paid as freeze time on the commit critical path. The locked-down rules:

- **`computeHistoryState` MUST be incremental.** It is keyed by the `_changeLog` array reference (a `WeakMap`) and folds only the new tail entries on each call. The cache is invalidated automatically when `_changeLog` is reassigned (font open, restore, reset). The change-log MUST stay append-only between resets — no `splice`/`pop`/`shift`/`length=N`/in-place reorder. Any code that needs to mutate it in place must reset and rebuild instead.
- **`computeHistoryState` MUST NOT materialize per-item array views inside its entry loop.** `touchedPaths`, `historyTargetKeys`, and `workerReplayTargets` are O(N²) hazards (each new path/target re-spreads the full set). They are materialized exactly once per visible item in `stripMutableHistoryItem`, after the fold is complete.
- **`history-view.render()` MUST be coalesced** behind `requestAnimationFrame` for all change-log-driven invocations. Multiple commits in the same animation frame produce one DOM rebuild. Synchronous `render()` calls are reserved for explicit user-driven scope/breadcrumb changes.
- Tests in `tests/change-bridge.test.js` (`buildHistoryStackItems scales sub-linearly...` and `incremental cache correctly applies undo/redo entries...`) lock in both the perf budget and the correctness of the incremental fold under undo/redo stack rotation.

## Window-Sync Budget

The local-update broadcast in `window-sync.ts` runs synchronously inside the
Yjs transaction. Encoding the full Yjs document (`Y.encodeStateAsUpdate` plus
`Array.from()` to send over `BroadcastChannel`) for a 3 MB font costs
100–200 ms per commit and was the dominant freeze source on routine outline
edits.

- The `yjs-update` broadcast MUST omit the `fullState` payload on the ordinary
  edit hot path, even when the sender has known peers. Encoding the full state
  inside a local edit transaction is too expensive for routine linked-window
  edits.
- Local `yjs-update` broadcasts MUST be microtask-batched. Multiple Yjs updates
  emitted during the same event-loop turn merge into one Yjs update payload and
  one concatenated `changeLogEntries` array, producing one
  `BroadcastChannel.postMessage` and one receiver refresh.
- Receiver-side `yjs-update` handling MUST also be microtask-batched. Multiple
  incoming messages in one turn merge into one `applyRemoteUpdate` call so the
  replay targets reach `syncRustCacheAndRefreshCanvas` as one batch.
- Broadcast payloads SHOULD use structured-cloned `Uint8Array` data instead of
  `Array.from()` number arrays. Receivers may accept the older number-array
  shape for compatibility.
- Live `yjs-update` payloads MUST carry only the Yjs delta plus the associated
  `changeLogEntries` replay metadata. They MUST NOT include `fullState`, layer
  repair snapshots, or any other side-band repair state. Partial layer snapshots
  must be rejected or applied non-destructively at the producer boundary; the
  collaboration transport must not repair malformed transactions after the
  fact.
- New peers still bootstrap correctly via the `full-state-request` /
  `full-state-response` round-trip in `_handleMessage`. They do not depend on
  the bundled `fullState` from `yjs-update` for first-time bootstrap.
- Tests in `tests/change-bridge.test.js` (`no peers: yjs-update broadcast omits
fullState...`, `with a peer: yjs-update broadcast omits fullState...`,
  `same-tick local updates are batched...`, and the partial layer snapshot
  producer-invariant tests) lock the budget and the no-repair live-update
  contract. The same suite also locks layer-scoped undo after inbound batching.

## Edit-Type Matrix

| Edit source                             | Origin                                                           | `lastEditType`                        | Immediate scheduling                                                                 | Trailing debounce                                                                                         | `compilationMode` | Option overrides                                                         | Worker font update path                                                                                                                                                                | Canvas behavior                                                                                       |
| --------------------------------------- | ---------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `mouse-drag-outline`                    | `OutlineEditor` drag of nodes and sidebearings                   | `outline`                             | Yes, via `refreshGlyphsAfterModelBatch()` + `autoCompileManager.checkAndSchedule()`  | Yes, final mouseup `saveLayerData()` arms the trailing full compile                                       | `outline-only`    | `skip_features: true`, `skip_kerning: true`, `produce_varc_table: false` | Drag-time model sync plus incremental `refreshGlyphsAfterModelBatch()` for the edited layer and visible metrics dependents; final mouseup save restores the pending full-sync baseline | Live editing compile during drag; trailing full compile waits for mouseup                             |
| `mouse-drag-sidebearing`                | `OutlineEditor` sidebearing handle drag                          | `outline`                             | Yes, via visible-scoped recomposition loop + `autoCompileManager.checkAndSchedule()` | Yes, `scheduleFullCompileDebounce()` re-arms until drag end; mouseup calls `saveLayerData` for final sync | `outline-only`    | `skip_features: true`, `skip_kerning: true`, `produce_varc_table: false` | No `saveLayerData` during drag; live refresh sends source + visible affected layers, then mouseup recomputes and syncs the complete affected layer batch                               | Live editing compile during drag (no overview tile repaints); trailing full compile waits for mouseup |
| `keyboard-outline`                      | `OutlineEditor` outline nudges and direct sidebearing saves      | `outline`                             | Yes                                                                                  | Yes                                                                                                       | `outline-only`    | `skip_features: true`, `skip_kerning: true`, `produce_varc_table: false` | Incremental sentinel JSON plus `update_cached_layer()`; cached subset key reused                                                                                                       | Swap font blob and repaint only; skip HarfBuzz reshape                                                |
| `keyboard-sidebearing`                  | `OutlineEditor` keyboard sidebearing adjustments (nudge, set)    | `outline`                             | Yes                                                                                  | Yes                                                                                                       | `outline-only`    | `skip_features: true`, `skip_kerning: true`, `produce_varc_table: false` | Incremental batch via `refreshGlyphsAfterModelBatch`; cached subset key reused                                                                                                         | Swap font blob and repaint only; skip HarfBuzz reshape                                                |
| `mouse-drag-anchor`                     | `OutlineEditor` anchor drag                                      | `anchor`                              | Yes, via recomposition loop + `autoCompileManager.checkAndSchedule()`                | Yes, `scheduleFullCompileDebounce()` re-arms until drag end; mouseup calls `saveLayerData` for final sync | `anchor-only`     | `produce_varc_table: false`                                              | No `saveLayerData` during drag; recomposition syncs model + `refreshGlyphsAfterModelBatch` sends all affected layers in one batch; cached subset key reused                            | Live editing compile during drag (no overview tile repaints); trailing full compile waits for mouseup |
| `keyboard-anchor`                       | `OutlineEditor` anchor nudges                                    | `anchor`                              | Yes                                                                                  | Yes                                                                                                       | `anchor-only`     | `produce_varc_table: false`                                              | Incremental sentinel JSON plus `update_cached_layer()`; cached subset key reused                                                                                                       | Swap font blob, reshape text, repaint                                                                 |
| `mouse-drag-guide`                      | `OutlineEditor` guide drag                                       | `null`                                | Yes                                                                                  | No                                                                                                        | `full`            | None                                                                     | Incremental sentinel JSON plus `update_cached_layer()` because it is still an interactive layer save                                                                                   | Editing compile may run during drag; full compile manager remains deferred                            |
| `keyboard`                              | Generic `saveLayerData()` keyboard save without edit-type suffix | `null`                                | Yes                                                                                  | No                                                                                                        | `full`            | None                                                                     | Incremental sentinel JSON plus `update_cached_layer()` because `compileSource` starts with `keyboard`                                                                                  | Full compile/render path                                                                              |
| `text-input`                            | `GlyphCanvas` text shaping subset updates                        | Not derived through `saveLayerData()` | Immediate direct compile call                                                        | Yes, `scheduleTextInputFullCompile()`                                                                     | `text-input`      | `produce_varc_table: false`                                              | No full JSON transfer; worker reuses cached font and compiles against the updated subset key                                                                                           | Specialized text-input path; keep shaping/layout intact                                               |
| `feature-code-edit`                     | `FontInfoManager` OpenType feature source edits                  | `null`                                | Yes, on Cmd+Enter, editor blur, and 5 s typing debounce                              | No separate trailing debounce; the idle timer is itself the compile trigger                               | `full`            | None                                                                     | Sync full babelfont JSON from the model before recompiling so feature code, GSUB, and GPOS rebuild from current source                                                                 | Full compile/render path                                                                              |
| `text-input-full-compile`               | Deferred correctness pass after typing settles                   | `null`                                | Yes                                                                                  | N/A, this is the debounce target                                                                          | `full`            | None                                                                     | Reuses cached font data when possible; full compile wake-up through dirty flag                                                                                                         | Full compile/render path                                                                              |
| Debounced post-interaction full compile | `FontManager.scheduleFullCompileDebounce()`                      | Reset to `null` before compile        | Yes, when debounce fires                                                             | N/A, this is the debounce target                                                                          | `full`            | None                                                                     | Uses latest synchronized babelfont JSON after pending sync is flushed                                                                                                                  | Full compile/render path                                                                              |
| `remote-anchor`                         | Linked window `onRemoteChange` from a main-window anchor edit    | `anchor`                              | Yes, via `autoCompileManager.checkAndSchedule()`                                     | No (trailing full compile handled by main window)                                                         | `anchor-only`     | `produce_varc_table: false`                                              | Incremental layer updates via `workerReplayTargets` from change log entries; no full JSON resync to worker                                                                             | Linked window editing font updated; canvas refreshed                                                  |
| `remote-outline`                        | Linked window `onRemoteChange` from a main-window outline edit   | `outline`                             | Yes, via `autoCompileManager.checkAndSchedule()`                                     | No (trailing full compile handled by main window)                                                         | `outline-only`    | `skip_features: true`, `skip_kerning: true`, `produce_varc_table: false` | Incremental layer updates via `workerReplayTargets` from change log entries; no full JSON resync to worker                                                                             | Linked window editing font updated; canvas refreshed                                                  |
| `remote-change`                         | Linked window `onRemoteChange` (unknown edit type)               | `null`                                | Yes, via `autoCompileManager.checkAndSchedule()`                                     | No (trailing full compile handled by main window)                                                         | `full`            | None                                                                     | `syncRustCacheAndRefreshCanvas` with available replay targets; falls back to full JSON resync when targets unavailable                                                                 | Full compile/render path in linked window                                                             |

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

Sidebearing drags skip `saveLayerData()` during the drag, mirroring the anchor drag pattern. The active handle-delta path and live refresh loop keep the model in sync for the source glyph, visible metrics-key dependents, and visible automatic-composition dependents by combining `syncFromEditorLayerData`, scoped `rebuildAutomaticCompositesForGlyphs`, and scoped `recomputeMetricsKeys`, then sending that visible batch to the worker with `refreshGlyphsAfterModelBatch`. On mouseup, the editor reruns the same recomposition without the visible-only filter before collecting `syncLayersFromJson` targets, so collaboration, undo, and receivers get the complete downstream layer batch even though hidden dependents were deferred during drag. The final `saveLayerData('mouse-drag-outline')` fires on mouseup for the Yjs/collaboration sync and undo history.

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
2. `fontc-worker.ts` patches the cached font via `applyJsonPatches`. Generic raw JSON patch batches must invalidate the cached subset/layout-closure epoch so the next cached compile re-primes from patched font data.
3. Incremental layer-replacement patch batches for outline, anchor, and sidebearing edits explicitly opt out of layout-closure invalidation because they replace already-known visible layers in place and must stay on the interactive patched-cache fast path.
4. The editing subset key is reused when unchanged and the worker font-cache epoch is unchanged so layout closure does not get rebuilt unnecessarily.
5. Full `store_font()` calls are fallbacks for invalidation or missing cache state, not the steady-state path for interactive editing.

Any change that increases full JSON transfers during interactive editing is a regression unless explicitly documented and approved.

## Collaboration Patch Policy

There are two distinct mutation formats in the system, and they serve different boundaries:

1. Rust worker boundary: official RFC 6902 JSON Patch batches against the concrete cached babelfont JSON held by Rust/WASM.
2. Collaboration/history boundary: named forward/inverse patch pairs whose paths use stable semantic identity for glyphs and layers.

The collaboration/history format exists because linked windows, cloud durability, and undo metadata must survive document version changes that make raw numeric array indices unstable. The named patch pair therefore remains the canonical transport format between JS peers, even though the pair is derived from a concrete JSON Patch diff.

Required properties of every collaboration patch pair:

- It carries both `forward` and `inverse` operations explicitly.
- Each operation uses JSON-Patch-style verbs (`add`, `remove`, `replace`).
- Glyph and layer addressing must use glyph names and layer ids instead of numeric array indices.
- Per-patch replay metadata may attach `workerReplayTargets` and edit-side metadata, but undo must not depend on recomputing the inverse later.

Legacy persisted envelopes containing raw `forwardPatches` / `inversePatches` remain readable for compatibility, but all new envelopes must be emitted in the named forward/inverse pair format.

## Rendering Policy

1. `outline-only` compiles must skip HarfBuzz reshape and only swap the font blob plus repaint.
2. `anchor-only` compiles must reshape text because anchor edits affect GPOS positioning.
3. `full` compiles continue through the existing complete render/update path.
4. `text-input` stays on its dedicated path because the font data is unchanged and only the shaped subset changed.

## Rationale By Edit Type

### Outline edits

Outline and sidebearing edits only change glyph geometry. They can use the most aggressive fast path: incremental layer patching, the subsetted editing target, no feature compilation, no kerning compilation, no VARC generation, and no text reshape on the canvas.

### Sidebearing edits with cascading metrics keys

Sidebearing edits that trigger metrics-key cascades still use the incremental worker fast path, but they must rebuild downstream automatic-composite layers for the same affected scope that anchor edits use. During drag that scope stays visible-only so hidden dependents remain deferred; on mouseup the filter is removed and the full downstream set is recomputed before Yjs sync. The model is pushed to the worker via incremental `refreshGlyphsAfterModelBatch` instead of a full JSON sync.

### Anchor edits

Anchor edits still benefit from incremental layer patching and cached subset reuse, but they cannot skip all feature work because GPOS mark attachment must stay correct. They also keep kerning enabled, because this path reshapes text immediately and the live editing font must retain complete positioning data. They keep a live compile path, but use `anchor-only` rather than `outline-only`.

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

Linked-window/cloud replay must rebuild change-log entries from the named forward/inverse patch pairs, not from raw worker JSON patches. The worker patch batch is a receiver-local cache refresh detail; it is not the cross-window source of truth.
3. Set `lastChangeSource` to `remote-anchor` or `remote-outline` (or `remote-change` for unknown types) so `isIncrementalEditingCompile` recognizes the source and the compile uses the correct compilation mode.

The receiver must refresh the worker cache before requesting its remote editing-font compile. Requesting a compile before the cache refresh completes can compile against stale Rust cache data and then immediately request a second compile. The linked-window remote path therefore schedules one editing compile after `syncRustCacheAndRefreshCanvas` has applied the replay targets or completed its fallback refresh.

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
