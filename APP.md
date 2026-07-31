# Preambel

This is a human-written document. Agents may alter it on request, but it must undergo human review.

# Alpha Stage

This project is in **Alpha stage**. There is no backward compatibility. Old code, old APIs, and old parameters are removed aggressively. If a function signature, parameter, or behavior is no longer needed, it is deleted entirely — not deprecated, not kept for compatibility. Always prefer clean deletion over maintaining dead paths.

# Purpose

`APP.md` is the principal authority document over how the app functions, described in human language, and translated into code and tests by agents.

# Notes

Known-good interactive glyph editor woth functional commits: 0509b80

# Counterpunch Font Editor Software Architecture

## Keeping tests up-to-sate

All rules in this document must be backed up by unit tests in either jest or playwright under `/webapp/tests/canonical/` and the unit tests must be kept up-to-date and mustn’t fail.

The tests are locking down the described functionality. They are written first and functionality implemented backwards from there, if possible. In any case, the tests control the code and carry the autority over the correct execution of the document.

The agent may use the Chrome DevTools MCP server to inspect the live app during development, but tighter and more realistic tests are preferrable.

The test files must be named (and renamed) according to their topic and tests regrouped as it makes sense.

## Further Rules

Every function must be accompanied by a human-readable description, which must also be kept up-to-date.

Wherever the `cmd` key is mentioned, on Windows and Linux the `ctrl` key is to be used instead.

## Document Collaboration

Yjs is the single source of truth for all edits. Reliable document convergence is the primary design goal.

The Patch Engine must treat Yjs diffs as authoritative for normal edits, undo, and redo. Replay targets are allowed only as narrow metadata for efficient cache refresh and compilation. A short human-readable edit summary must also be attached, along with edit-source metadata such as mouse, keyboard, or Python, for display in the history view.

Undo and redo may append coarse control rows to the change log so the history UI can rotate items between active and undone stacks, but those control rows are history-only metadata. Every post-commit consumer must still process clones of the original forward semantic entries from the same authoritative Yjs delta. There must not be a second undo-specific or redo-specific local emission path beside the normal committed Yjs update flow.

Committed post-commit reactions must also be driven from that same authoritative Yjs packet. After `PatchSyncEngine` emits or applies a committed Yjs update, both the local sender and every remote receiver must enter the same serialized committed-change funnel for edit-type inference, editing-compile wakeup, and glyph-overview invalidation. After each processed edit, any transient compile or edit-source state must be cleaned up again so one edit cannot poison the next one. Sender-local save helpers may prepare model state or arm trailing debounces, but they must not run a separate committed reaction path in parallel.

Forward patches are generated only on the receiving side, on the fly, from the incoming binary Yjs diff for human introspection. They are shown in the history item's info popup, but they must never be used to replay, rebuild, or update font data. Yjs alone defines document state.

Binary Yjs updates (not RFC 6902 forward patches) are the authoritative transmission format for keeping the Rust WASM compilation worker's cache current during normal editing. The worker maintains its own `yrs::Doc` (a Rust port of the Yjs CRDT), and the JavaScript `PatchSyncEngine` forwards every local and remote edit-time Yjs binary update directly to it via `applyYjsUpdate`. This eliminates the need to transmit the full babelfont JSON string on every edit. The main font cache (`CANONICAL_JSON_CACHE`) is rebuilt from the Rust Y.Doc on each update. The subset compilation cache is kept up-to-date using the list of changed glyph/layer identifiers returned by `apply_yjs_update`.

The editing layout-closure cache represents the closed glyph set for the current text buffer and selected OpenType feature set. Visual edits to outlines, anchors, sidebearings, components, guides, or visual layer data must update glyph data inside that existing closed set without invalidating or re-priming layout closure. Layout closure may be invalidated only when the editing text/subset changes, the selected OpenType feature set changes, feature source data changes, or glyphset-level structure changes.

For normal editing there are no escape hatches: no full babelfont JSON resend, no full Yjs-state resend, no `storeFontJson`, no `initYdoc`, and no other full-document repair transport may be used to make Rust catch up. If an edit, undo, redo, Python edit, feature-code commit, or linked-window edit cannot keep Rust correct through incremental Yjs updates alone, that is a bug in the editing pipeline and must be fixed there rather than papered over with any full-state fallback.

Full-document transport is reserved for bootstrap from external sources only, such as opening or importing a font into a fresh Rust worker state. Once a document is open and editing has begun, steady-state document convergence must remain incremental-only.

### Cloud sync vs. local window sync

Only a font’s main window syncs with the DO room in the cloud. Local linked windows only talk to the main window which relays messages back and forth between the cloud and the local linked windows.

## The Editing Pipeline

### Central cascading recomposition engine

Live drags and committed edits share one cascade mutator:
`computeLayerRecompositionClosure` in `webapp/js/recomposition-closure.ts`.

- **Live tick** runs `scope: 'visible'` once (mutate model + advances for
  `source ∪ recomposeTargets` only). The live funnel is **stage-only**: it
  previews the cached `{glyphName, layerId}` targets via
  `stageLiveDragPreviewFromModel` (`toCompileJSON`) and must not re-run the
  closure. After a successful nonempty stage it wakes a live compile; funnel
  queue coalescing owns "latest". A completed preview may apply while a newer
  stage is queued; it is rejected only when older than an already-applied
  preview, so continuous pointer motion cannot starve visible recompilation.
  No Yjs during drag.
- **Commit** (drag-end, keyboard, property panel) runs **one** `scope: 'all'`
  closure, stashes sync targets, then serialize-only syncs
  `source ∪ recomposeTargets`. `_syncCurrentGlyphToYDoc` must not rebuild
  autos again. Sidebearing mouseup reuses the refreshFinal stash — no second
  full closure.

**Mutation vs persistence** (do not conflate “no-op”):

- Mutation gate: rebuild/metrics change stored values only when they differ
  (APP.md sidebearing “don’t propagate no-ops”).
- Persistence gate: after live drag, automatic/metrics dependents still enter
  `changedLayerTargets` even when mutation is a no-op, so Yjs matches the
  already-correct model.

**Layer identity:** layer IDs are unique per glyph. Every cascade consumer
(preview, Yjs snapshots, `workerReplayTargets`, advance refresh) must use
matched per-glyph layer ids via `resolveDependentLayerTarget` / designspace
matching — never reuse the source layer UUID as a dependent id.

**Automatic `=+/-=` bake boundary:** resting model, JS worker mirror, and
Rust Y.Doc always store logical composition (`Layer.toJSON`). They must never
receive a second baked Yjs update. Live preview stages `Layer.toCompileJSON`
into the worker-only overlay (already physical). At compile-read, Rust merges
any overlay layers, then bakes remaining logical automatic `=+/-=` layers into
a local font clone only — never into `Y_DOC` / canonical / subset caches.
`apply_yjs_update` clears the overlay (correct CRDT hygiene); post-commit
compiles stay physically correct via the bake, not via overlay retention.
Each overlay stage replaces the prior physical overlay atomically, preventing
drag-one component snapshots from surviving into drag two.
Sidebearing mouseup must keep `isDraggingSidebearing` true through
drain → final refresh → Yjs, then explicitly `clearLiveDragPreview()` so
in-flight live funnel stages still compile under the sidebearing
no-reshape contract and drag-2 cannot inherit an orphaned physical overlay.
If a sidebearing/anchor funnel stage completes after the session dies, the
funnel must clear that orphaned overlay rather than leave it for the next drag.
Live preview staging must never write compile-facing (`toCompileJSON`) layers
into resting model/storage — that poisons logical component translates and
double-bakes `=+/-=` on the next drag. Preview collectors build overlay
payloads only; resting writeback stays logical (`toJSON`).
Automatic layers are mutated only by `rebuildAutomaticComposition`, never by
metrics translate/bake.

That closure returns two dependent sets that must stay distinct:

- `recomposeTargets` — layers whose stored model must change (automatic composition rebuild and/or metrics-key inheritance, including outline edits that move a keyed glyph's visual edge). Only these, plus the directly edited source layers, may be written into the authoritative Yjs packet as layer snapshots.
- `invalidateTargets` — layers that only need worker/canvas/overview refresh because they draw an edited source (including manual composites). Manual composites keep their stored transforms and width; live base geometry may shift inside them. These targets must be stamped as `workerReplayTargets` metadata on the Yjs packet and must not be cascade-written as model snapshots.
- `allTargets` — source ∪ recompose ∪ invalidate. Stamp this as `workerReplayTargets` so local and remote peers refresh the same compile/cache closure. Replay targets remain part of the Yjs packet metadata; they are not re-derived on receive.

After a live drag has already applied derived automatic-composite / metrics-key state, commit must still include those dependents in `changedLayerTargets` even when a final rebuild/metrics pass is a no-op. Post-commit model refresh may only reload layers that the packet actually wrote into Yjs; reloading wider invalidate-only replay targets from stale Yjs state must not clobber the live-updated object model.

Bridge finalizer fallback must infer edit kinds from the buffered operations (width → sidebearing, anchors → anchor, etc.) and must never expand cascade writes with a universal outline+anchor+sidebearing+component hammer. Multi-target `workerReplayTargets` without any layer-snapshot write are incomplete and must not bypass the finalizer.

Structural edits (connect, split, open, close path) go to `syncStructuralGlyphChangeTransaction()` and Yjs bridge directly. Skip both closure and `_syncCurrentGlyphToYDoc`.
TODO: Structural edits should ideally go through `_syncCurrentGlyphToYDoc` like all other edits to stamp them with replay targets, but for now it seems okay since it doesn't actually cause any harm if they don't have replayTargets.

All committed interactive edits enter the pipeline in `_syncCurrentGlyphToYDoc()`, which sends results to the Yjs bridge. Exceptions are undo, redo, and remote edits, as these are already finalzed Yjs packets.

`_syncCurrentGlyphToYDoc()` forwards to the Yjs bridge, which applies the operation to its Y.Doc, from which the binary Yjs diffs are created.
TODO: This operation needs scrutiny to see if the Y.Doc sync is good.

Here, undo, redo, and remote Yjs packets converge with forward GUI edits to be processed at `_emitLocalUpdate`.

TODO: Continue with the Yjs packet handling, namely the compilation pipeline in Rust.

TODO: Undo doesn't work

## Glyphs

### Glyph Stack Labels

`glyphStack` serializes the current component-editing path as `rootGlyphName@rootLayerId>componentIndex:componentGlyphName@componentLayerId>...`. The root segment has no component-index prefix; every nested segment's zero-based `componentIndex` identifies the component in the preceding segment's layer. A foreground selection always uses that foreground layer's persisted ID.

When the root edits a feature variation, its root glyph name is the synthetic editor notation `baseGlyphName.feaVar.N`, where `N` is the zero-based index in the source glyph's `featureVariations` list. For example, `dollar.feaVar.0@layer-id` denotes the first feature-variation family of source glyph `dollar`. The notation is editor-only stack state: it must never be persisted as a glyph name, layer value, or Yjs font field.

An unmaterialized background selection is virtual and must use `glyphName@background-<foregroundLayerId>` in its active stack segment. This synthetic token identifies the foreground owner; it is not a raw layer ID and must never be serialized to the font or Yjs as a layer root. When the first background path materializes the sibling, the active segment must be rewritten to `glyphName@<persistedBackgroundLayerId>`, where that ID is the newly created background layer's normal persisted ID (typically a UUID), not a `background-`-prefixed value. The materialized layer carries `is_background: true` and `background_layer_id: <foregroundLayerId>`; rebuilding the stack must preserve every unaffected component segment.

### Feature Variations

Feature-variation families are source glyph views over conditional raw layers. Their order is the order of `Glyph.featureVariations`; the `.feaVar.N` stack suffix selects exactly that family. A root without the suffix selects the base glyph.

In editing mode, only an explicit user action in the feature-variation dropdown or layer list may add, replace, or remove `.feaVar.N`. Moving an axis slider, reshaping text, automatic layer matching, interpolation, rendering, or receiving model updates must never switch the root between base and feature-variation families.

All root rendering, exact-layer fetches, and direct interpolation first resolve `baseGlyphName.feaVar.N` to source glyph `baseGlyphName`. When the suffix is present, they use only the raw layer IDs in `baseGlyphName.featureVariations[N]`; without it they use only the base glyph layers. Compiled `*.VAR.*` names are binary output identities only. They may recover the source base glyph during edit entry, but must never select a feature-variation family or be stored in `glyphStack`.

### Layers

#### Background Layers

Every foreground layer has a paired background layer stored as a sibling raw layer. `Glyph.layers` remains foreground-only; `Layer.backgroundLayer` resolves the pair and returns an empty transient background until it receives its first path. That first path materializes the sibling and reciprocal layer IDs through the normal incremental Yjs edit path.

Background layers contain paths only: they have no components, anchors, guides, metrics, compatibility, or interpolation behavior of their own. Their foreground layer supplies the displayed guides and width. Editing a background must remain a normal outline edit; neighbouring glyphs continue to use their normal interpolation.

`cmd`+`shift`+`b` switches between paired foreground and background editing while retaining independent selections. Active background editing is visibly tinted faint yellow. `cmd`+`alt`+`b` toggles a faint, non-interactive rendering of the paired layer; only while visible do its on-curve nodes become snap candidates. This command is also available in the Editing View's View menu.

`cmd`+`b` copies selected objects to the paired layer. Paths copy directly; copying foreground components to a background decomposes them to paths. Anchors and guides never copy into a background.

#### Drawing New Outlines

Pressing the `cmd` key and hovering the mouse over clear glyph space (not over existing outlines) will draw new paths point by point. Once a new path drawing is in progress (hovering line visible from last selected node to mouse pointer with `cmd` key pressed), prioritize extending the new path over adding nodes to existing paths when hovering over existing paths segments (but not open end points, see below). While `cmd` is pressed for drawing, prioritize drawing new points over hitting neighbouring glyphs as well, so drawing may continue outside the active glyph’s width. In that state, neighbouring glyphs must not be treated as hovered visually either. When closing a newly drawn path on its first point, preserve every explicitly drawn corner; only merge the endpoints into one node when the open path's start and end already sit on the same coordinates.

Selecting either end point of an open path while pressing the `cmd` key will continue the drawing from the selected point. When a line is drawn from a selected node onto an open path’s end node, the path will be closed (if it's the same path) or connected (if it's a different open path).

#### Editing Existing Outlines

A point triplet is defined as a middle on-curve point with off-curve points on both sides. All three nodes are enforced to be aligned if the on-curve point is set to smooth, otherwise the off-curve points of the triplet may be moved freely.

Holding the shift key before or after selecting and moving an off-curve point of a smooth point triplet will restrict the triplet's direction to horizontal/vertical direction, rotated around the on-curve point.

Holding the `alt` key before or after selecting and moving a smooth on-curve point will keep its two off-curve points fixed in place and restrict the on-curve point to sliding on the straight line between those two off-curve points. Lifting the `alt` key while still dragging returns to free movement and lets the off-curve points follow again. Pressing the `alt` key again while still dragging freezes the off-curve points at their current positions and again restricts the on-curve point to the line between them.

Holding the `alt` key before or after selecting and moving an off-curve point that’s not connected to a smooth point will keep the movement restricted to its original direction from the on-curve point. Lifting the `alt` key while still dragging allows free movement, but pressing the `alt` key again while still dragging return to the original direction, not the direction at the moment of re-pressing the `alt` key.

Double clicking an on-curve point of a triplet will toggle the smoothness state. Turning a non-smooth on-curve point of a triplet to smooth will align both off-curve points in a straight line around the on-curve point, with their direction being the average of the previous off-curve points’ directions. Turning a non-smooth on-curve point of a triplet when one of the two lines is in perfect horizontal or vertical direction will also align the other off-curve point’s direction to horizontal or vertical. If the two off-curve directions previously differed by more than 10 degrees but, after that smooth-toggle alignment, the aligned triplet lies within 10 degrees of horizontal or vertical, snap it fully to that axis.

A node can be smooth with a curve segment only on one of its sides. In that case, the direction (angle) of the off-curve point is bound by the direction of the straight line segment on the other side of the smooth on-curve point, and the off-curve point's direction must be adjusted when either point of the straight line segment moves.
If a smooth triplet loses a curve on one side by off-curve point deletion, the on-curve point must be kept smooth if the remaining on-curve point's direction matches the straight line segment's direction on the other side of the off-curve point (with a small angle error margin), otherwise be set to not smooth.
Similar to editing a smooth on-curve point of a triplet, holding the `alt` key before or after selecting and moving a smooth on-curve point with a curve only one one one side will keep the off-curve point in place and move the smooth on-curve point on the fixed axis between the off-curve point and the line segment's opposite point.
Open path end points can never be smooth.

Clicking on an on-curve point with `cmd` key pressed will cut the path open at that point by duplicating the point in the same location and making it the path’s new start and end point. In case that point was a smooth on-curve point, both new points must be set to not smooth. While the `cmd` key is pressed and such a node is hovered, the mouse pointer must become a crosshair. Cutting the same path open again in another point will separate the path into two separate paths. Immediately after such a cut, do not show the path-drawing preview line yet; only show it after the user has released and pressed the `cmd` key again while the selected on-curve point is still selected. Once that path-drawing preview line is shown, hide it again while the user hovers a different non-endpoint node with the `cmd` key still pressed. If the hovered node is an open-path end node, keep the line visible and prioritize closing or connecting the path.

Dragging an open path’s end node onto another end node of an open path (regardless of path direction and whether or not it’s the same path or a different open path) will connect or close the path and combine the two nodes into one. This must work during any point dragging, even while dragging several selected nodes at once or during one and the same dragging process after an end point got lifted from the other end point's position and returned to it, which signals intent to close the contour. If it so happens that after connecting or closing a path this way two other end nodes also sit on top of each other, connect those as well, and save all path changes in the same history transaction.

If the new combined node is a triplet with two off-curve points and the two off-curve points and the on-curve point are in a straight line (with a small error margin), or the end points sits in a straight line between a straight line segment and an off-curve point on the other side (with a small error margin), set the on-curve point to smooth after connecting it.

Two nodes with identical positions must be underlined with a red circle as notification, regardless of whether they belong to the same path or separate paths.

All operations must wrap around the start/end point of a closed path as if the point was nothing special at all.

#### Node Snapping

Both for dragging existing points as well as drawing new points (not for inserting new nodes into existing segments), points will snap horizontally and/or vertically to on-curve points of the active glyph, on-curve points of both neighbouring glyphs, as well as an extra phantom point on the dragged point’s original position, as well as to vertical metrics lines end the glyph edge. The snap distance is configurable in `settings.ts`.

#### Sidebearing Keys

Layer sidebearings can be linked to other glyphs’ sidebearings by curated keys such as `=n`or arithmetics like `=a+10` or fixed values `=50` etc.

In detail:

- `=n` inherits that sidebearing glyph-wide from the same-side sidebearing of glyph `n`
- `=n+10` or `=n*1.5*` does the same, but adds arithmetics
- `=50` sets sidebearings glyph-wide to an exact value of `50`
- exceptions can be made that are local to just one layer of a glyph when the key starts with another `=`, so `==n`, `==n+10`, or `==50` etc, while the other layers of the same glyph may have a glyph-wide key or no key at all.

Since sidebearings are not supposed to change when a user edits anything on a layer with inherited linked sidebearings, the sidebearings will be kept up-to-date if the glyph's left-most or right-most nodes or component bounding boxes are responsible for left or right side layer bounding box changes. This applies equally to path node drags, component drags, and mixed layers containing both paths and components.

During edits from mouse-dragging, the width of the active glyph in the harfbuzz buffer must be updated live and without any lag by adjusting all occurrences of its advance width in the harfbuzz buffer and immediately redrawing, while scheduling repeated editing font compilations as during outline edits so that the GPOS table can update.

Simultaneously, once a glyph’s sidebearing changes, all downstream glyphs who inherit the active glyph’s sidebearings must be updated as well. This includes both glyphs that inherit sidebearings explicitly through sidebearing keys and glyphs whose metrics depend implicitly on the glyph through automatic alignment of component-only composite layers. Only update if the value actually changed in the end. Don’t propagate no-ops.

Group any sidebearing changes of sidebearing inheritance in one history transaction and Yjs message. When a structural path operation triggers keyed realignment, keep the path operation itself and all resulting width changes of the active glyph and downstream dependent glyphs in that same single history transaction and Yjs message.

Update canvas panning: When sidebearings of the active glyph change via explicit sidebearing edits, such as the dedicated sidebearing handles on canvas, the property panel text fields, or undo of those edits, preserve the active glyph layer's visual bounding-box center on screen during the repaint. Width adjustments, downstream metrics-key propagation, live advance refreshes, and this canvas anchoring must happen during one single animation frame so that no jiggle is visible on screen. Mouse sidebearing drag coalesces pointer samples into that one frame (mutate → pointer rebase → paint). Live preview compiles during an interactive sidebearing session may swap outline font bytes but must not reshape the text run or issue an independent compile repaint; the interaction frame owns paint. The sidebearing session flag stays active through mouseup drain, final refresh, and Yjs commit, and mouseup then clears the worker preview overlay before the next drag. Keyboard sidebearing nudges use the same one-frame contract, and any mid-burst preview blob swap must re-apply live advances and the stashed bbox-center anchor before paint.

When sidebearing changes are caused by keyed realignment during outline or component dragging, anchor the opposite edge of the active glyph layer on screen: If the RSB changes, anchor the canvas to the left edge of the glyph. If the LSB changes, anchor the canvas to the right edge of the glyph. Reserve bbox-center anchoring for explicit sidebearing edits and for structural outline operations whose keyed realignment is applied only after the structure change is complete, such as inserting or deleting points, deleting whole paths, converting a straight segment to a curve, and opening or closing paths.

When a sidebearing changes, update the sidebearings of all inheriting downstream glyphs both in the object model as well as their advance widths in the harfbuzz buffer before repainting the canvas. This downstream propagation must include both explicit metrics-key inheritance and implicit automatic-alignment dependencies. When downstream glyphs that appear **before** the active glyph in the harfbuzz buffer also change width, the viewport anchoring must account for those preceding-advance shifts as part of the same repaint so the active glyph remains visually stationary at its intended anchor point.

##### Tests

**Test 1: Unkeyed Sidebearing Edits**

For glyphs with no sidebearing keys, test that sidebearing edits via the handle by mouse, via the handle by keyboard, and via the property panel text fields keep the active glyph layer's visual bounding-box center anchored on screen. Test a matrix of all edit input types and both sides.

**Test 2: Keyed Sidebearing Edits**

For glyphs with any of the defined sidebearing keys, test that sidebearing handle edits keep the active glyph layer's visual bounding-box center anchored on screen while cascading metrics-key recompositions refresh dependent metrics and advances.
For outline or component drags, test that keyed realignment anchors the opposite glyph edge visually on the canvas. LSB changes anchor the right layer edge visually on screen, and RSB changes anchor the left layer edge visually on screen.
Test structural outline operations that trigger keyed realignment after the structure edit separately, and ensure those preserve the active glyph layer's visual bounding-box center on screen.

**Test 3: Selected Glyph Anchoring**

When a live advance refresh changes one or more glyphs before the active glyph in the text run, test that the appropriate active glyph anchor remains screen-stationary through the matching `panX` compensation. When no changed glyph precedes the active glyph, test that no preceding-advance compensation is applied.

**Instructions for all sidebearing tests**

Ensure that undo operations of the same edits result in the same visual anchoring as during edits, by storing in the history item which side got edited and using that for undo-time visual anchoring.
Ensure that ongoing mouse drags that take a break are not committing data to the history items such that an undo restores an already altered state. Undos must restore each state cleanly.

#### Anchors

Pasting anchors that already exist in the layer will update the anchor position for the active layer.

#### Clipboard Paste

The editor pastes outline clipboard data in this order of preference:

1. **Counterpunch JSON** — from `application/x-counterpunch-clipboard`, plain JSON on `text/plain`, or JSON embedded in SVG `<metadata id="counterpunch-clipboard">`. The wire shape is a `font-editor-clipboard` envelope (`clipboardSchema` / `clipboardSchemaVersion` / `clipboardItems`); Counterpunch’s document lives under `clipboardItems.counterpunch` (`version: 1`, `kind: "selection" | "glyphs"`). Produced by Counterpunch copy and by the Glyphs script `tools/glyphs/Copy to Counterpunch.py`. Coordinates are kept absolute. Closed paths from Glyphs use Glyphs’ node order (start node last); paste rotates them so the start node is at index 0. Component pastes preserve the full Glyphs affine transform (`GSComponent.transform`).
2. **SVG** — from Illustrator, Glyphs’ SVG fallback, and other apps. Path pastes are centered horizontally in the layer width and vertically between the visible descender and highest vertical metric. After centering, horizontal guide origins are placed on the left glyph edge `(0, y)` and vertical guide origins on the highest metrics line `(x, highestMetric)`.

Paste always appends selection / SVG content. Selection / SVG pastes fan out to all linked layers when the active layer is linked, and affect only the active layer when it is unlinked. Before pasting, the current selection is cleared; afterwards the pasted objects on the active layer are selected.

**View gating:** copy and paste route by which view has the `.focused` class — not by whether a glyph edit tab is open. Whole-glyph JSON (`kind: "glyphs"`) copies/pastes only when `#view-overview` is focused; selection / SVG layer data pastes only when `#view-editor` is focused and glyph editing mode is active; normal text pastes only in editor text mode. Otherwise the editor shows an alert and does not paste. The Glyphs paste script uses the same rule (Font view vs Edit tab).

**Whole-glyph paste:** always creates new glyphs. If the clipboard name is free it is used as-is; if it already exists, Counterpunch allocates `name.001`, `name.002`, … (same scheme as Glyphs). New glyphs are inserted immediately after the last existing namesake / `name.NNN` sibling (same placement as Duplicate), then selected. The overview syncs that change incrementally (reuses existing tiles/outlines; only paints new glyphs) and only scrolls when needed: no scroll if already fully visible, minimal scroll if clipped, center if fully off-screen. The overview’s blue “editing” highlight still tracks the glyph stack; optionally scrolling the overview to that glyph is off by default and toggled from Editing View → View → Scroll Overview to Active Glyph. Clipboard documents include the source font’s masters list and each layer’s `masterIndex` association. Paste matches layers to target masters **by master index only** (master counts must match). Layer copies (`AssociatedWithMaster` without location) are pasted and remain hidden in the UI, as with `.glyphs` import. Brace/intermediate layers paste only when every location axis key exists in the target font (axis id or tag); otherwise they are skipped and an alert is shown. Feature-variation layer families are pasted onto the new glyph as associated layers with the same master matching. Clipboards without this metadata are refused.

**Duplicate Glyph(s):** overview context menu, ⌘D, and Font → Duplicate Glyph(s) clone selected glyphs directly in the model (not via the clipboard), using the same `.001` naming scheme. Each clone is inserted immediately after its source, drops Unicode codepoints, regenerates layer IDs, and keeps master references.

**Overview type-to-select:** with the glyph overview focused, a single printable key selects the first visible glyph that encodes that Unicode character. Keys typed within 1 second append to a buffer and select by glyph-name prefix instead (case-insensitive). Escape / arrow keys / Backspace clear the buffer.

**View keyboard activation:** focusing a view via its shortcut (or click) must move real DOM focus into that view and blur the previous view’s controls (glyph canvas, Ace, terminal, assistant prompt). Otherwise keystrokes can still reach the previously focused control while the new view also handles them. Glyph overview tile clicks, double-clicks, drag-select, and context menus apply immediately even when the overview was not previously the focused view (the click still focuses the view as usual).

SVG subpaths closed with `Z` / `z` become closed Contours; the start point is not duplicated at the end. Background layers accept paths only.

#### Clipboard Copy

Copy writes a `font-editor-clipboard` envelope (Counterpunch document under `clipboardItems.counterpunch`, `version: 1`, `nodeOrder: "start-first"`) to `text/plain`, and publishes SVG via the Async Clipboard API as `image/svg+xml` (macOS: `public.svg-image`) so Glyphs/Illustrator Cmd+V can paste paths. Nested contours are emitted as one compound SVG path (Illustrator hole); non-nested shapes stay separate. Sync `clipboardData.setData('image/svg+xml')` alone is not enough — Chrome keeps that type in private web clipboard data that native apps cannot see.

SVG is a lossy interchange path: browsers cannot publish Illustrator AICB/PDF (the formats Glyphs uses for 1:1 unit paste from Illustrator). Glyphs may rescale SVG paste. For correct size and full fidelity into Glyphs, use `tools/glyphs/Paste from Counterpunch.py` (reads the JSON on `text/plain`).

- **Glyph edit view:** copies the current selection (paths, components, anchors, selected guide). SVG includes selected paths only.
- **Glyph overview:** copies each selected glyph as a whole-glyph payload (all foreground layers, width, metrics keys). SVG includes paths from each glyph’s first foreground layer.

The Glyphs paste script clears the current selection and selects the pasted objects.

#### Editing Components

Components, like paths, must be of identical structure across the layers of a glyph to be compatible. Their decomposed transformations can be edited via the property panel of the editor view. Translation is locked only while the entire layer is automatically composed. In other words: if any component in a component-only layer is not automatic and the layer therefore falls out of automatic composition, all components in that layer, including components still marked automatic, must remain movable by the user. While a layer is fully automatic, component translation is derived from automatic composition and therefore not directly editable, while rotation, scale, and skew remain editable. All transformation edits stay local to a layer, even if the edited layer is linked with other layers, while changing the automatic alignment status of a component is updated across all linked layers.

When an automatically aligned component has more than one eligible target anchor in the current composition, the property panel must offer an anchor override control backed by `Component.anchor`. Leaving that control unset keeps the component on the default automatic target selection for its anchor family.

#### Automatic Glyph Composition

Layers that contain only components and no paths are automatically composed by the editor only when every component explicitly stores `alignment = 1`.

Anchors serve both OpenType GPOS attachment features and automatic component arrangement in the editor at design-time. A base component may expose anchors such as `top` or `bottom`, and a mark component may expose matching attachment anchors such as `_top` or `_bottom`. During automatic composition, a mark component must snap to the matching base anchor in the same way mark-to-base positioning would attach the mark glyph.

If a glyph layer contains multiple anchors of the same family, alternative anchors are distinguished by a freely chosen suffix after an underscore, such as `top_alt` or `top_viet`. A component may explicitly choose one of these alternative target anchors via the `Component.anchor` attribute. The editor must treat the unsuffixed anchor and all suffixed variants as one anchor family for attachment purposes, while preserving the exact chosen target name on the component.

Automatic composition is intended for three common cases: a single base component, a base component followed by one or more mark components, or multiple base components. In base-plus-mark compositions, the base component must come first and combining mark components after it. When multiple marks are present, they stack in shape order. For stacking to work, a mark glyph must usually contain both its attachment anchor such as `_top` and its own outgoing anchor such as `top`, so later marks can attach to it in turn.

When an automatically aligned component does not attach to an anchor, automatic composition must preserve that component's stored vertical offset instead of resetting it to the origin. This applies to unattached automatic mark components as well as unattached automatic base components. Only the stored horizontal offset is limited to the leading unattached component, because that component establishes the running base advance for the composition. This is required for authored automatic composites whose single component is intentionally raised or shifted, such as suffixed mark variants built from one mark component.

Automatic alignment keeps composite metrics derived from their base components. Changing the metrics of a base glyph must therefore update compatible automatically composed glyphs that reference it. Mark components attached through anchors must not expand the automatically derived sidebearings. If extra spacing is needed beyond the automatic metrics, that spacing must be expressed as an explicit adjustment on the composite rather than by letting attached marks redefine the sidebearings.

Automatic composition also depends on anchor positions. Moving an anchor on a glyph must therefore rebuild any compatible automatically composed downstream glyphs that attach to that anchor family, update the editing font from that rebuilt data, and do so both for direct edits and for undo or redo of those edits.

Glyphs components preserve their stored placement unless they explicitly store `alignment = 1`. Omitted alignment metadata and all other alignment values take a component-only layer out of automatic composition, allowing manual placement of all of its components. Enabling automatic alignment writes `alignment = 1` on every component in the layer; only then does the layer return to automatic composition. Changing automatic alignment state or a component's explicit target-anchor override must rebuild the automatic composition immediately.

Sidebearings of automatically composed layers cannot be edited directly because they are derived from the base glyph. The property panel must therefore present those fields as automatic unless the user has supplied an explicit automatic-offset override. Imported non-operator metrics keys that merely restate the implicit automatic derivation, such as direct references to the first or last chained base glyph, must not appear as explicit keys on an automatic layer and must not replace the implicit automatic sidebearings. However, the automatic sidebearings may be adjusted using `=+` and `=-` glyph-wide operators, or `==+` and `==-` layer-local overrides.

Automatically aligned components must be visually distinguished from manually positioned components in the editor so their derived placement is apparent at a glance. Both kinds of components must draw their explicit path outlines with a 2 px stroke. Automatically aligned components use a gray stroke darker than their fill, while manually positioned components use a blue stroke darker than their fill.

#### Chained Base Components

Automatic composition must also support left-to-right chains of multiple base components connected by `#exit` and `#entry` anchors. A preceding base component may expose `#exit`, and the following base component may expose `#entry`. The composer must align those two anchors exactly. More than two base components may be chained in shape order; any middle base component must therefore expose both `#entry` and `#exit`, while the first chained base needs `#exit` and the last chained base needs `#entry`.

This chained-base behavior only participates in automatic composition when those base components are automatic too. If any base component in the chain is not automatically aligned, the layer is no longer an automatically composed layer and the chained-base placement rule does not apply.

For chained base components, derived metrics must come from the base chain itself rather than from summing standalone advances blindly. The automatically composed glyph must use the LSB of the first base glyph in the chain and the RSB of the last base glyph in the chain, with interior overlaps or joins determined by the aligned `#exit`/`#entry` anchors.

Changes to chained-base source glyphs, including metrics changes and edits to `#entry` or `#exit` anchor positions, must rebuild inheriting automatic composites immediately and in the same transaction path as the existing automatic glyph composer.
