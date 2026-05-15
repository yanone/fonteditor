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
6. Interactive edit-time flows must keep the Rust worker congruent via incremental Yjs updates only. Edit-time Rust promotion is incremental-Yjs-only; worker-cache JSON patch batches, full babelfont JSON resends, and full Yjs-state resends are not part of the steady-state editing path.
7. Editing compiles must continue using the subsetted `editing` target before fontc.
8. Text input uses its own subset-only fast path and still schedules a deferred full compile after typing settles.
9. Full compiles remain the correctness fallback after interactive editing or when an edit type does not have a specialized fast path.
10. Linked windows must not run full-font compilation or Fontspector; only the main window may schedule and execute them. The `full-font-compile-manager` checks `windowRole.isMainWindow()` at every scheduling entry point and suppresses the monitor loop for linked windows.
11. Every interactive commit MUST keep the JS and Rust documents aligned through the shared Yjs transaction stream. Full-font `storeFontJson`, `seedYdoc`, `initYdoc`, or any other full-document crossing MUST stay at zero during steady-state editing, undo, redo, Python execution, feature-code commits, and linked-window edit replay. Edit-time compiles must wait for the already-emitted incremental Yjs worker update instead of forcing any full-document resend.
12. Every committed Yjs packet, local or remote, MUST enter one shared serialized committed-change funnel for post-commit reactions. That funnel owns committed edit-type inference, editing-compile wakeup, and overview invalidation. Sender-local save helpers may prepare model state and arm trailing debounces, but they MUST NOT run a separate committed compile or committed `glyphChanged` path in parallel.
13. Missing replay metadata, worker-sync rejection, or any other edit-time inconsistency MUST be treated as a bug in the incremental pipeline, not as justification for a full-document repair path. Normal editing has no escape hatches.
14. Collaboration and cloud convergence MUST use binary Yjs updates as the authoritative document transport. Semantic change metadata may accompany those updates for history, human-readable inspection, undo labels and scopes, and replay-target hints, but it MUST NOT be used as the state-replay source for normal linked-window or cloud convergence.
15. Python edits MUST enter `PatchSyncEngine` and emit the same committed Yjs packet plus change-log metadata as every other persisted edit. Python may derive synthetic operations from normalized before/after font snapshots, including named path metadata, but it MUST first canonicalize the current font in place and refresh the serialized snapshot, then derive the post-execution snapshot from that freshly regenerated canonical serialization rather than from any stale pre-sync `babelfontJson` cache. It MUST NOT bypass the shared committed-change funnel with ad hoc full-font sync or direct post-commit reactions.
16. Visual glyph edits MUST NOT invalidate the layout-closure cache. The closure may be re-primed only when the closed glyph set changes, which is driven by the editing text/subset or the selected OpenType feature set, or when feature/glyphset source data changes. Outline, anchor, sidebearing, component, guide, and layer-visual commits must keep the existing closure intact.
17. Startup bridge/bootstrap noise MUST NOT request a no-data committed editing compile before the first editing font exists. The initial startup editing compile owns first readiness; bootstrap-local packets with `changeVersion === 0` must not bump `compileRequestVersion` and invalidate that first result.
18. **Bridge-finalizer bypass for GUI-complete layer packets.** `buildCascadingRecompositionOperations` MUST skip cascade recomposition when every cascade-triggering operation in the transaction already carries complete `workerReplayTargets` that include the source glyph/layer pair. The predicate `operationCarriesCompleteGuiReplayTargets` detects this: a cascade-triggering operation (width, anchor, layer-snapshot, glyph-snapshot with cascade data) is complete when it has non-empty `workerReplayTargets` and at least one target matches the operation's own `(glyphName, layerId)`. When all cascade-triggering ops are complete, the finalizer returns `[]` without calling `recomputeCascadeAffectedGlyphNames`. Producers that supply complete recomposed snapshots include the anchor, sidebearing, and outline drag-end paths in `outline-editor.ts`. Incomplete packets (e.g. plain width/anchor scalar paths without explicit replay targets) still fall back to the finalizer recomposition. See `webapp/js/change-bridge-init.ts` `operationCarriesCompleteGuiReplayTargets` and `buildCascadingRecompositionOperations`.
19. **Local post-commit cache refresh skip for GUI-complete layer packets.** After `awaitLocalCommittedWorkerCacheSettled` resolves, `handleCommittedChangeRefresh` MUST skip the `queueRustCacheAndRefreshCanvas` / `refreshWorkerCacheForReplayTargets` call for local GUI commits whose Yjs worker update was already forwarded by `setYjsWorkerCallback`. All entries in the commit must have layer-scoped paths (matching `.layers.` or `:layers.`) and non-empty `workerReplayTargets`. The authoritative binary Yjs update already reached Rust through `forwardWorkerYjsUpdate`; a second replay-target cache refresh would duplicate serialization and a second `applyYjsUpdate`. The receiver (remote) branch still runs the cache refresh because linked windows need scoped layer refresh before their editing-font compile. See `webapp/js/change-bridge-init.ts` `handleCommittedChangeRefresh`.
20. **Tighter layout-closure invalidation for visual paths only.** `shouldInvalidateLayoutClosureForCommittedEntries` MUST return `false` for any path that contains `.layers.` or `:layers.` — these are visual layer-scoped edits that only change data inside the existing closed glyph set. The function still returns `true` for `features.*` paths and `glyphs.*` paths without layer scope (structural changes). See `webapp/js/change-bridge-init.ts` `shouldInvalidateLayoutClosureForCommittedEntries`.
21. **Worker-side sentinel clearing respects explicit `invalidateLayoutClosure: false`.** The `applyYjsUpdate` handler in `fontc-worker.ts` MUST NOT clear `cachedBaseSubsetKey` / `cachedClosureGlyphCount` when the sender passes `invalidateLayoutClosure: false`, even if `changedGlyphCount === 0`. The old condition `changedGlyphCount === 0` that overrode an explicit `false` was removed. Feature-code and top-level updates still invalidate closure by sending `invalidateLayoutClosure: true`. See `webapp/js/fontc-worker.ts` `applyYjsUpdate` handler.
22. **Node arrays are producer invariants, never sanitizer output.** Path shapes MUST be produced with `nodes` already materialized as `Babelfont.Node[]` at the source of the edit or payload construction. No edit, exact-layer payload builder, Yjs serializer, compile validator, or worker-cache serializer may unwrap wrapped shapes, convert string path data to arrays, preserve old shapes to hide malformed nodes, or otherwise sanitize malformed path structure. If `nodes` is not an array when a path shape crosses one of those boundaries, that code path is buggy and MUST throw instead of repairing the data.
23. **Undo/redo control rows must never define emitted packet semantics.** Undo and redo may append coarse control entries to the change log only to rotate history-stack state (`targetHistoryItemId`, `Undo`/`Redo` labels, scopes). Those control rows MUST NOT be forwarded as the semantic metadata observed by local update listeners, worker callbacks, collaboration transport, or the committed-change funnel. Emitted committed packets MUST always unwrap back to clones of the original forward entries from the same authoritative Yjs delta, with only `historyAction` changed to `undo` or `redo` and `targetHistoryItemId` attached. There must be exactly one local emission path for committed Yjs deltas: `_emitCanonicalLocalUpdateSince(...)` / Yjs `update` -> `_emitLocalUpdate(...)`. Undo/redo-specific local emission helpers are forbidden.
24. **Worker document mutations close the compile-ready gate before posting.** `storeFontJson`, `seedYdoc`, and `applyYjsUpdate` mutate the Rust worker document/cache and may clear the primed layout closure. `FontCompilation.sendMessage()` MUST set `workerCacheDocumentReady = false` synchronously before posting any of those messages, then restore readiness only after the matching worker response succeeds. Cached editing compiles MUST wait for the tracked worker-document sync whenever that gate is closed. This prevents linked-window bootstrap or any other worker reseed/update from racing a cached editing compile that would otherwise try to reuse a JS-visible subset key after Rust cleared its layout-closure cache.

## Committed Packet Lifecycle

For normal edit-time convergence, including undo and redo, the authoritative
event chain is:

```text
Local mutation -> derive authoritative Yjs delta -> local post-commit reactor on that delta -> send delta -> remote apply delta -> remote post-commit reactor
```

Interpret each step literally:

1. Local mutation updates the authoritative local Yjs document first.
2. The committed binary Yjs delta is derived from that committed Yjs state.
3. The local sender enters the shared committed-change funnel from that same
   authoritative delta.
4. That same delta is broadcast to linked windows and collaboration peers.
5. Receivers apply the delta to their local Yjs document.
6. Receivers then enter the same committed-change funnel, with receiver-only
   visual compensation allowed before the shared post-commit work begins.

Important nuance: this is not a plain "mutate JS model first, then encode to
Yjs" flow. For steady-state editing, undo, and redo, Yjs is authoritative. The
local JSON/model view is patched from the committed Yjs state immediately after
that mutation, and the local and remote post-commit reactors are both supposed
to consume the same authoritative Yjs packet rather than parallel ad hoc local
reaction paths.

Undo and redo add one extra constraint on top of that chain: if history UI
state needs a coarse control row in the change log, that row is history-only.
The packet observed by post-commit consumers must still be the same semantic
entry shape as the original forward edit. In other words, history may record
"Undo"/"Redo", but worker/cache/compile/broadcast consumers must observe only
the cloned original forward entries from the committed Yjs delta.

## Boundary-Crossing Budget

`FontManager` exposes `getBoundaryCrossingStats()` and `resetBoundaryCrossingStats()` so tests and the AI profiling harness can pin per-edit traffic across the JS ↔ Rust/worker boundary. The locked-down budget is:

| Operation                                                      | `submitBatchCalls` | `layersTransmitted` | `glyphsTransmitted` | `fullFontCrossings` |
| -------------------------------------------------------------- | ------------------ | ------------------- | ------------------- | ------------------- |
| Single-layer commit (keyboard / drag-end)                      | `1`                | `1`                 | `1`                 | `0`                 |
| Multi-glyph cascade commit (e.g. anchor cascade, metrics keys) | `1`                | `N` (changed)       | `M` (distinct)      | `0`                 |
| Receiver `syncRustCacheAndRefreshCanvas` with replay targets   | `1`                | `N` (targets)       | `M` (distinct)      | `0`                 |
| Undo / redo with `workerReplayTargets`                         | `1`                | `N` (targets)       | `M` (distinct)      | `0`                 |
| Font open / external reload                                    | `0`                | `0`                 | `0`                 | `1`                 |

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

| Edit source                             | Origin                                                           | `lastEditType`                        | Immediate scheduling                                                                 | Trailing debounce                                                                                         | `compilationMode` | Option overrides                                                         | Worker font update path                                                                                                                                                                                                                                                                                                                                                                                                       | Canvas behavior                                                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mouse-drag-outline`                    | `OutlineEditor` drag of nodes and sidebearings                   | `outline`                             | Yes, via `refreshGlyphsAfterModelBatch()` + `autoCompileManager.checkAndSchedule()`  | Yes, final mouseup `saveLayerData()` arms the trailing full compile                                       | `outline-only`    | `skip_features: true`, `skip_kerning: true`, `produce_varc_table: false` | Drag-time model sync plus incremental `refreshGlyphsAfterModelBatch()` for the edited layer and visible metrics dependents; final mouseup save restores the pending full-sync baseline                                                                                                                                                                                                                                        | Live editing compile during drag; trailing full compile waits for mouseup                                                                         |
| `mouse-drag-sidebearing`                | `OutlineEditor` sidebearing handle drag                          | `outline`                             | Yes, via visible-scoped recomposition loop + `autoCompileManager.checkAndSchedule()` | Yes, `scheduleFullCompileDebounce()` re-arms until drag end; mouseup calls `saveLayerData` for final sync | `outline-only`    | `skip_features: true`, `skip_kerning: true`, `produce_varc_table: false` | No `saveLayerData` during drag; live refresh sends source + visible affected layers, then mouseup recomputes and syncs the complete affected layer batch                                                                                                                                                                                                                                                                      | Live editing compile during drag (no overview tile repaints); trailing full compile waits for mouseup                                             |
| `keyboard-outline`                      | `OutlineEditor` outline nudges and direct sidebearing saves      | `outline`                             | Yes                                                                                  | Yes                                                                                                       | `outline-only`    | `skip_features: true`, `skip_kerning: true`, `produce_varc_table: false` | Incremental sentinel JSON plus `update_cached_layer()`; cached subset key reused                                                                                                                                                                                                                                                                                                                                              | Swap font blob and repaint only; skip HarfBuzz reshape                                                                                            |
| `keyboard-sidebearing`                  | `OutlineEditor` keyboard sidebearing adjustments (nudge, set)    | `outline`                             | Yes                                                                                  | Yes                                                                                                       | `outline-only`    | `skip_features: true`, `skip_kerning: true`, `produce_varc_table: false` | Incremental batch via `refreshGlyphsAfterModelBatch`; cached subset key reused                                                                                                                                                                                                                                                                                                                                                | Swap font blob and repaint only; skip HarfBuzz reshape                                                                                            |
| `mouse-drag-anchor`                     | `OutlineEditor` anchor drag                                      | `anchor`                              | Yes, via recomposition loop + `autoCompileManager.checkAndSchedule()`                | Yes, `scheduleFullCompileDebounce()` re-arms until drag end; mouseup calls `saveLayerData` for final sync | `anchor-only`     | `produce_varc_table: false`                                              | No `saveLayerData` during drag; recomposition syncs model + `refreshGlyphsAfterModelBatch` sends all affected layers in one batch; cached subset key reused                                                                                                                                                                                                                                                                   | Live editing compile during drag; sender and receiving windows both refresh affected overview tiles live; trailing full compile waits for mouseup |
| `keyboard-anchor`                       | `OutlineEditor` anchor nudges                                    | `anchor`                              | Yes                                                                                  | Yes                                                                                                       | `anchor-only`     | `produce_varc_table: false`                                              | Incremental sentinel JSON plus `update_cached_layer()`; cached subset key reused                                                                                                                                                                                                                                                                                                                                              | Swap font blob, reshape text, repaint                                                                                                             |
| `mouse-drag-guide`                      | `OutlineEditor` guide drag                                       | `null`                                | Yes                                                                                  | No                                                                                                        | `full`            | None                                                                     | Incremental sentinel JSON plus `update_cached_layer()` because it is still an interactive layer save                                                                                                                                                                                                                                                                                                                          | Editing compile may run during drag; full compile manager remains deferred                                                                        |
| `keyboard`                              | Generic `saveLayerData()` keyboard save without edit-type suffix | `null`                                | Yes                                                                                  | No                                                                                                        | `full`            | None                                                                     | Incremental sentinel JSON plus `update_cached_layer()` because `compileSource` starts with `keyboard`                                                                                                                                                                                                                                                                                                                         | Full compile/render path                                                                                                                          |
| `text-input`                            | `GlyphCanvas` text shaping subset updates                        | Not derived through `saveLayerData()` | Immediate direct compile call                                                        | Yes, `scheduleTextInputFullCompile()`                                                                     | `text-input`      | `produce_varc_table: false`                                              | No full JSON transfer; worker reuses cached font and compiles against the updated subset key                                                                                                                                                                                                                                                                                                                                  | Specialized text-input path; keep shaping/layout intact                                                                                           |
| `feature-code-edit`                     | `FontInfoManager` OpenType feature source edits                  | `null`                                | Yes, on Cmd+Enter, editor blur, and 5 s typing debounce                              | No separate trailing debounce; the idle timer is itself the compile trigger                               | `full`            | None                                                                     | Commit through `PatchSyncEngine.applySyntheticChangeSet()`, forward the resulting Yjs update to Rust, then wait for that worker sync before recompiling. The editing compile must validate against the full cached Rust font through the normal feature filter pipeline, not the subset-retained editing font, so glyph references outside the current text subset still resolve correctly without bypassing feature parsing. | Full compile/render path                                                                                                                          |
| `text-input-full-compile`               | Deferred correctness pass after typing settles                   | `null`                                | Yes                                                                                  | N/A, this is the debounce target                                                                          | `full`            | None                                                                     | Reuses cached font data when possible; full compile wake-up through dirty flag                                                                                                                                                                                                                                                                                                                                                | Full compile/render path                                                                                                                          |
| Debounced post-interaction full compile | `FontManager.scheduleFullCompileDebounce()`                      | Reset to `null` before compile        | Yes, when debounce fires                                                             | N/A, this is the debounce target                                                                          | `full`            | None                                                                     | Uses latest synchronized babelfont JSON after pending sync is flushed                                                                                                                                                                                                                                                                                                                                                         | Full compile/render path                                                                                                                          |
| `remote-anchor`                         | Shared committed-change funnel from a main-window anchor edit    | `anchor`                              | Yes, via committed Yjs packet after receiver cache refresh                           | No (trailing full compile handled by main window)                                                         | `anchor-only`     | `produce_varc_table: false`                                              | Incremental layer updates via `workerReplayTargets` from change log entries; no full JSON resync to worker                                                                                                                                                                                                                                                                                                                    | Linked window editing font updated; canvas refreshed                                                                                              |
| `remote-outline`                        | Shared committed-change funnel from a main-window outline edit   | `outline`                             | Yes, via committed Yjs packet after receiver cache refresh                           | No (trailing full compile handled by main window)                                                         | `outline-only`    | `skip_features: true`, `skip_kerning: true`, `produce_varc_table: false` | Incremental layer updates via `workerReplayTargets` from change log entries; no full JSON resync to worker                                                                                                                                                                                                                                                                                                                    | Linked window editing font updated; canvas refreshed                                                                                              |
| `remote-change`                         | Shared committed-change funnel (unknown remote edit type)        | `null`                                | Yes, via committed Yjs packet after receiver cache refresh                           | No (trailing full compile handled by main window)                                                         | `full`            | None                                                                     | `syncRustCacheAndRefreshCanvas` with available replay targets only; missing replay metadata or worker-sync rejection is a bug and must not trigger a full-state resend                                                                                                                                                                                                                                                        | Full compile/render path in linked window                                                                                                         |

## Scheduling Details

### Undo/redo

Undo/redo must request an editing-font compile immediately so the auto-compile
loop wakes up, and must request it again after `syncRustCacheAndRefreshCanvas()`
completes. The second request is required because undo/redo first patches the
model/Yjs state and only then refreshes the Rust worker cache. Without the
post-refresh request, the first compile can run against stale worker cache data
and leave the editing font one undo step behind.

Undo/redo must rely on the already-forwarded incremental Yjs worker update. If
the recorded history entries also carry explicit layer replay targets, they may
be used only as narrow metadata to avoid unnecessary work around the already-
authoritative Yjs update. Missing replay targets or worker-sync timing issues
must be fixed inside the incremental path; they must not trigger any full-state
repair resend.

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
is required so undo stays on the incremental path. Any code that would otherwise
have forced a full-document Rust resync is a regression and must be removed.

### Interactive layer saves

`FontManager.saveLayerData()` still prepares the local model state for keyboard saves and drag-finalization saves, but committed post-commit reactions now belong to the authoritative Yjs packet rather than the save helper itself. The required responsibilities are:

1. It marks the font dirty immediately.
2. It records the local change metadata (`lastChangeSource` / `lastEditType`) and, for `outline` and `anchor` edits, arms `scheduleFullCompileDebounce()` so the editor returns to a full compile after the interaction.
3. It MUST NOT dispatch the committed overview refresh or wake the committed editing compile directly. Those now run only after `PatchSyncEngine` emits the authoritative committed Yjs packet and the shared committed-change funnel consumes it.

#### Synchronous local commit sequence

For interactive outline, anchor, and sidebearing saves, the local sender must
finish one synchronous commit phase before any async propagation, worker-cache
refresh, or compile wakeup begins.

The required sequence is:

1. Serialize the edited layer payload into canonical storage form.
2. Commit that serialized layer into `currentFont.babelfontData` in place,
   without replacing the stored glyph or layer objects.
3. Sync the object-model layer from that same serialized stored layer and
   invalidate any layer-local caches.
4. Mark only the serialized-string cache (`babelfontJson`) as stale when the
   edit path is allowed to defer string regeneration. The authoritative JS font
   object (`babelfontData`) must already be current at this point.
5. Emit the authoritative committed Yjs packet from that already-committed
   local state.
6. Let the shared committed-change funnel own the authoritative async
   post-commit reactions: compile wakeup, linked-window propagation, cloud
   propagation, and overview invalidation. Sender-local save helpers may still
   perform narrow worker-cache priming needed for the local interactive path,
   but that work must happen strictly after steps 1-5 and must not replace or
   race the authoritative Yjs-driven post-commit reactions.

This ordering is mandatory because tests and post-commit consumers may inspect
`currentFont.babelfontData` immediately after `saveLayerData()` returns. A
state where the editor layer and Yjs delta are current but `babelfontData`
still contains the pre-edit layer is a bug.

While the pointer is still down for a mouse drag, the live editing compile path must remain active. What must stay suppressed is only the full-compile side: full compile execution itself and the JSON/model sync required to feed that full compile. Mid-drag pauses may continue to produce editing compiles, but must not flush `pendingBabelfontJsonSyncAfterDrag` or run full-font compilation until the drag ends.

Outline point/component drags now mirror the anchor-drag pattern during the active drag: they keep the model current, batch-refresh the edited layer plus visible metrics-key dependents into the worker with `refreshGlyphsAfterModelBatch()`, and request recompilation without routing every drag tick through `saveLayerData()`. The final `saveLayerData('mouse-drag-outline')` still fires on mouseup for Yjs/collaboration sync, undo history, and the trailing full compile baseline.

Anchor drags skip `saveLayerData()` entirely during the drag. Instead, the recomposition loop (`queueLiveVisibleAnchorDependentRefresh`) keeps the model in sync via `syncFromEditorLayerData` + `rebuildAutomaticCompositesForGlyphs`, and sends all affected layers (source + downstream) to the worker in a single `refreshGlyphsAfterModelBatch` call. That same live path must route sender overview invalidation through the shared glyph-overview refresh helper used by the bridge funnel, preserving the immediate-refresh hint while deduplicating glyph-name expansion and dependent-composite handling with the receiver path. The final `saveLayerData('mouse-drag-anchor')` fires on mouseup for the Yjs/collaboration sync and undo history, and the resulting committed Yjs packet then drives the same centralized post-commit compile/overview path as every receiver window.

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

OpenType feature source edits in the font-info Features editor are font-wide source changes, so they must stay on the full compile path rather than any outline or text-input fast path. They must still enter the shared patch/Yjs funnel before recompilation so Rust receives the same authoritative Yjs update as every other edit.

The editor commits and recompiles feature code in three cases:

1. Immediately on `Cmd+Enter` / `Ctrl+Enter`.
2. Immediately when the Ace editor loses focus.
3. Automatically after 5 seconds with no further typing.

All three triggers must use the same commit path: write the current Ace buffer through the patch bridge, mark the font dirty, wait for the corresponding Yjs worker update to land, and call `recompileEditingFont()`. That recompilation must validate feature-code edits against the full validated babelfont JSON rather than the subset-retained editing font, so glyph references outside the current text subset still resolve correctly. Blur and explicit commit must cancel any pending idle timer so one edit burst produces at most one automatic compile.

The cached worker path must validate raw feature source before applying the editing filter pipeline. Filters such as glyph retention may normalize or discard feature statements, so feature-code commits first compile the full cached Rust font for validation, then continue with the filtered editing-font compile only if that raw validation succeeds. This validation still reads the Rust-side Yjs/CANONICAL_JSON cache; it must not send a full babelfont JSON string from JavaScript.

## Worker Cache Policy

### Rust Worker Cache Authority

The Rust worker cache chain has one authoritative direction during steady-state
editing:

```text
Y.Doc -> CANONICAL_JSON_CACHE -> FONT_CACHE -> subset/filter/layout/compile caches
```

`CANONICAL_JSON_CACHE` is the Rust worker's materialized JSON view of the
authoritative Yjs document. `FONT_CACHE` is only the typed `babelfont::Font`
derived from that JSON for operations that need the Rust object model. After any
edit-time Yjs update changes canonical JSON, `FONT_CACHE` and all feature,
subset, filtered-font, layout-closure, and outline caches derived from it must be
invalidated or rebuilt from `CANONICAL_JSON_CACHE`. Editing code must not patch
`FONT_CACHE` as a competing source of truth for font-wide data. Feature-code
validation must read the latest Yjs-derived canonical state before the subset
editing compile runs.

The fast path depends on these rules staying true:

1. Drag and keyboard layer edits use the incremental sentinel JSON path in `font-compilation.ts` rather than sending the full babelfont JSON to the worker.
2. `applyYjsUpdate` is the authoritative edit-time worker update channel for both local and remote changes.
3. `applyJsonPatches` is not part of the edit-time worker path. Interactive cache updates must reach Rust through the already-issued Yjs worker sync rather than a parallel JSON-patch channel.
4. When the bridge already holds the authoritative binary Yjs delta plus layer replay metadata, the worker path must forward that original delta directly. It may derive local fingerprint bookkeeping from the object model, but it must not rebuild a second Yjs update for the same edit.
5. The editing subset key is reused when unchanged so subset font caches stay hot. Layout closure uses a separate feature-sensitive closure key and must not include visual font-cache epochs for ordinary outline, anchor, sidebearing, component, guide, or layer-visual edits.
6. Full `store_font()`, `storeFontJson`, `seedYdoc`, or `initYdoc` are reserved for font open or external reload, not for interactive editing, undo, redo, Python execution, feature-code commits, or linked-window edit replay.
7. Dormant compatibility branches that resend a full document during normal editing must be deleted rather than retained as safety valves. If the incremental pipeline is insufficient, fix the pipeline.

### Layout Closure Cache

The layout closure cache represents the closed glyph set needed for the current editing text and active OpenType feature selection. It is not a cache of glyph outlines. Visual edits update the glyph data inside the existing closed set and therefore must not clear or re-prime the closure.

The worker may re-prime layout closure only when one of these inputs changes:

- The editing text/subset changes, producing a different subset glyph key.
- The selected OpenType feature set changes, producing a different layout-closure key.
- Feature source data or glyphset-level structure changes in a committed Yjs packet.

Layer-scoped visual updates forwarded through `applyYjsUpdate` must pass `invalidateLayoutClosure: false`. This applies equally to local commits, linked-window replay, undo/redo replay, and Python edits that only touch visual layer data.

If `compile_cached_font_from_last_layout_closure()` reports that no layout closure is primed while the JS worker sentinel believed the closure was reusable, the worker must treat that as stale closure metadata and re-prime from the current Yjs-backed `subsetGlyphs`/layout-closure key before retrying the cached compile. This is not a full-document fallback and must not rebuild state from JSON; it only restores the Rust closure cache for the already-authoritative worker Y.Doc.

Any change that introduces or increases any full-document transfer during normal editing is a regression unless explicitly documented and approved for bootstrap-only behavior.

## Collaboration Metadata Policy

There are two distinct mutation formats in the system, and they serve different boundaries:

1. Rust worker boundary during editing: incremental Yjs updates against the worker Y.Doc only. Full `storeFontJson`, `seedYdoc`, or `initYdoc` are reserved for bootstrap and external reload, not for normal editing recovery.
2. Collaboration/history metadata boundary: semantic change descriptors whose paths use stable glyph names and layer ids where human-readable or history-facing paths are needed.

The collaboration/history metadata format exists because history display, undo labels, replay-target hints, and cloud-side audit trails need stable semantic identity even when raw numeric array indices would be unstable. It accompanies the authoritative Yjs update; it is not the document-state transport between JS peers.

Required properties of every collaboration metadata entry:

- It describes the affected path or target using stable glyph names and layer ids whenever glyph or layer identity is involved.
- It may attach `workerReplayTargets`, edit-source metadata, and human-readable summaries.
- It may be derived from JSON Patch or named forward/inverse patch pairs when a producer, such as Python snapshot diffing, needs that conversion internally.
- It must not be used to replay, rebuild, or repair font data during ordinary linked-window or cloud convergence. The Yjs update alone defines document state.

Only binary Yjs updates are supported for collaboration, linked-window sync, cloud convergence, and steady-state worker convergence. Metadata is permitted only as a companion record.

### Required edit funnel

All persisted font-data edits must flow through the patch system so change-log history, linked windows, cloud durability, undo/redo, and replay all see the same canonical mutation stream.

For all non-exception persisted edits, the bridge finalizes transactions in this order:

1. Apply the direct edit to the in-memory JSON/model.
2. Derive the direct mutation operations that describe that user edit.
3. Before the transaction is committed, inspect those direct operations for cascade triggers.
4. If the direct operations touched layer width or anchors, rebuild downstream automatic composites and metrics-key dependents inside the same open transaction.
5. Derive a second operation set for the cascade-only layer changes.
6. Commit one combined operation list, emit one authoritative Yjs update, and attach the corresponding semantic change metadata to that same committed packet.

Node-only outline edits must not trigger downstream recomposition by themselves. Downstream recomposition is keyed to anchor changes and width-affecting edits.

There are only two approved exceptions:

1. Live dragging may update the worker cache and trigger instant editing recompilation before the final patch-funnel commit lands. The drag interaction must still commit through the patch system when the gesture is finalized.
2. Debounced feature-code editor recompilation may still auto-run after idle, but the commit itself must first enter the shared patch/Yjs funnel. Automatic recompilation is not an exception to the authoritative Yjs transport rule.

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

**Committed-change funnel:** Committed local packets and committed remote packets both enter the same serialized post-commit funnel. Local packets enter it immediately after the authoritative Yjs update is emitted. Remote packets enter it immediately after the update is applied. The shared funnel owns compile wake-up and overview invalidation for both origins so sender and receiver windows react to the same committed metadata instead of maintaining parallel reaction code.

**Editing compile efficiency:** When the committed-change funnel handles a remote packet, it extracts edit-type metadata and `workerReplayTargets` from the change log entries and uses them to:

1. Pass `workerReplayTargets` to `syncRustCacheAndRefreshCanvas` for incremental layer updates to the WASM worker cache (instead of a full JSON resync).
2. Infer the original edit type (`anchor` / `outline`) so the linked window's editing compile uses the matching fast-path compilation mode (`anchor-only` / `outline-only`) instead of always falling back to the slowest `full` mode.

Linked-window/cloud replay must rebuild change-log entries from the named forward/inverse patch pairs, not from any worker-local cache transport. The worker Yjs update is a receiver-local cache refresh detail; it is not the cross-window source of truth.

For local commits, the same funnel must wait for the already-forwarded worker Yjs update to land and for any chained local replay-target cache batch to settle before requesting the editing compile or invalidating overview tiles. That preserves the sender's fast path while keeping the compile trigger and committed overview refresh tied to the authoritative committed packet rather than to `saveLayerData()`.

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
