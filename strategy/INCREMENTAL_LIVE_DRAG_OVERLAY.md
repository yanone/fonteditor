# Incremental Live-Drag Overlay Strategy

## Problem

Live dragging, committed keyboard edits, and undo/redo must stay responsive and
functionally correct without using full-document repair paths. Previous fixes
restored one behavior by sending a full babelfont JSON document, then restored it
again by cloning/transmitting full Yjs state into a preview document. Both paths
violate the steady-state editing policy.

## Non-Negotiable Rule

After font bootstrap, no edit-time path may transmit or reconstruct worker state
from a full document. This includes full babelfont JSON, full Yjs state, and a
separate live-drag preview Y.Doc cloned from authoritative state.

If live drag, keyboard edits, undo, redo, Python edits, or linked-window replay
cannot keep Rust correct through bounded edit packets, the bug belongs to the
incremental pipeline.

## Architecture

### Authoritative Commit Lane

Committed edits use the existing incremental Yjs stream:

```text
GUI/model mutation
-> PatchSyncEngine committed Yjs delta
-> applyYjsUpdate in the compilation worker
-> Rust applies the delta to its authoritative Y.Doc
-> Rust patches canonical/subset/font caches from changed glyph/layer metadata
-> committed compile runs from authoritative worker state
```

Mouseup, keyboard edits, undo, redo, Python edits, and linked-window replay all
belong to this lane. They must not have a fallback that sends a full font or a
full Yjs state.

### Live Preview Lane

Live drag is not document synchronization. It sends a transient preview overlay:

```text
drag movement
-> JS recomputes active/dependent visible layers
-> worker receives only changed { glyphName, layerId, layerData } records
-> Rust stores those layer records in a preview overlay map
-> preview compile reads authoritative cached subset plus overlay replacements
-> mouseup sends the real authoritative Yjs commit and clears the overlay
```

The preview overlay is a small map of changed layer records. It is not a Y.Doc,
not a full font, and not an alternate authoritative state.

### Compile State Provenance

Compile requests must state which lane they use:

- authoritative committed compiles use `authoritative-worker-yjs`
- live-drag compiles use `live-drag-worker-preview`

The preview lane may reuse the normal layout-closure cache, because visual layer
drags update glyph data inside the existing closed glyph set. The overlay is
applied only when constructing the transient subset font for that preview
compile. Authoritative caches stay untouched until mouseup commits the real Yjs
delta.

## Tripwires

Tests for this flow must fail if an edit-time path calls any of these as a
repair mechanism:

- `currentFont.fontModel.toJSONString()` for live drag or committed editing
- `storeFontJson` after bootstrap
- `seedYdoc` / `initYdoc` after bootstrap
- full-state `Y.encodeStateAsUpdate(...)` for live drag
- preview Y.Doc creation or replacement
- Rust authoritative Y.Doc cloning for preview

The accepted proof is the full workflow, not isolated unit success:

```text
open font
-> drag source glyph and update visible dependent glyphs live
-> mouseup commit
-> keyboard edit from the post-drag state
-> undo
-> redo
```

That workflow must pass while the forbidden full-document mechanisms are rigged
to fail.

## Implementation Checklist

1. Remove the JS `workerPreviewYDoc` mirror and all live-drag full-state
   bootstrap code.
2. Replace `applyPreviewYjsUpdate` with a sparse preview-layer overlay message.
3. Replace Rust `PreviewState` with a preview overlay map keyed by
   `(glyphName, layerId)`.
4. Compile preview fonts from authoritative cached subsets plus overlay layer
   replacements.
5. Clear the overlay on mouseup, authoritative Yjs commits, font open, and cache
   clears.
6. Keep committed edits on the existing incremental Yjs lane.
7. Add tests that assert live drag sends overlay packets only and does not create
   or mutate a preview Y.Doc.
8. Rebuild WASM and the webapp, then run the focused drag/keyboard/undo
   regressions.
