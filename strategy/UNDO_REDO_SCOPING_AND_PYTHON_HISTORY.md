# Undo/Redo Scoping and Python History Strategy

## Goals

- Keep undo/redo behavior predictable from the editor scope the user is in.
- Keep history visibility precise without overloading undo scope for display decisions.
- Represent Python script execution as one logical history item with accurate touched scopes.
- Preserve Yjs undo-manager correctness across main and linked windows.

## Core Model

There are two separate concepts:

1. Undo scope
   Determines which undo manager owns the operation and therefore what Undo or Redo targets.
   Supported scopes are `font`, `glyph`, and `layer`.

2. Touched scope metadata
   Determines where a history item is shown.
   This is derived from the actual changed paths.
   Canonically, history items aggregate `touchedPaths`, and glyph or layer
   visibility is derived from those paths rather than stored as duplicated
   `touchedGlyphNames` or `touchedLayerKeys` fields.

This separation is important because one logical edit can be glyph-scoped for undo purposes while still needing to appear in multiple layer histories.

## Undo Scope Rules

- Font scope is used for edits outside glyphs or edits spanning multiple glyphs.
- Layer scope is used for edits confined to one glyph layer.
- Glyph scope is used for edits confined to one glyph but spanning more than one layer or including glyph-level data outside a single layer.

History items derive their undo scope from the aggregate entry set, not from display filtering.

## History Visibility Rules

- Font history shows all items.
- Glyph history shows items whose derived touched glyph set contains the active glyph.
- Layer history shows items whose derived touched layer set contains the active `glyph@@layer` key.

This replaces the earlier approach where layer history inferred visibility from promoted glyph scope. The earlier model was too approximate because it showed glyph-scoped items in every layer history for that glyph, even if the layer was untouched.

## Yjs Ownership

Undo behavior is implemented with separate undo managers:

- Font undo manager for top-level font data.
- Glyph undo managers keyed by glyph name.
- Layer undo managers keyed by `glyph@@layer`.

The transaction origin determines which undo manager captures a change set. Display metadata does not affect this.

One implementation detail is now intentionally asymmetric:

- Layer- and glyph-scoped undo/redo still use their Yjs undo managers directly.
- Font-scoped undo/redo resolves the target history item from the change log and replays exactly that item, instead of trusting the root Yjs undo-manager capture state.

This avoids a failure mode where one font-level undo could otherwise collapse unrelated edits that happened to share root-manager capture history.

## Python Execution Strategy

Python scripts are special because the object model may emit many low-level setter mutations while the user expects one logical history item.

The execution flow is:

1. Before execution
    - Capture a normalized snapshot of `babelfontData`.
    - Begin a bridge transaction labeled `Python script`.
    - Suppress ordinary live bridge recording so setter noise does not enter history.

2. After execution
    - Sync `babelfontJson` from the mutated model.
    - Diff the normalized before snapshot against the normalized after snapshot.
    - Convert the diff into synthetic operations with babelfont-aware paths.
    - Apply those synthetic operations to Yjs in one bridge transaction with one origin.
    - Let the bridge derive the correct undo scope from the full touched set.

3. Visibility
    - Each synthetic entry carries a canonical changed path.
    - History items aggregate touched paths, and glyph/layer visibility is derived from those paths, so the Python action appears only in the relevant glyph and layer histories.

## Diff Semantics

The Python diff logic is semantic rather than CRDT-level:

- `glyphs` collections are keyed by glyph name.
- `layers` collections are keyed by layer id.
- Other arrays remain index-based.
- Primitive changes become `set` operations.
- Missing-to-present becomes `add`.
- Present-to-missing becomes `remove`.

This keeps history aligned with babelfont semantics instead of raw Yjs delta shapes.

## Linked Window Behavior

Remote windows receive the same change-log entries with touched metadata intact. Remote origin selection still depends on undo scope and touched span:

- one layer touched in one glyph: layer origin
- multiple layers in one glyph: glyph origin
- multiple glyphs or font-level changes: font origin

That preserves correct undo ownership across windows while keeping layer history filtering accurate.

The History panel can also change the effective undo context explicitly:

- when the panel is zoomed to `layer`, undo targets that layer history
- when zoomed to `glyph`, undo targets that glyph history
- when zoomed to `font`, undo targets font history even if the outline editor still has a layer selected

Toolbar and keyboard undo/redo should therefore follow the visible history-panel scope, not just the active outline-editor scope.

## Known Constraints

- Synchronous `runPython` cannot await async post-execution work; it can only trigger it.
- Snapshot normalization must mirror serialization enough to avoid false positives, especially for path node arrays.
- Full-font Python changes can legitimately surface as font-scoped history items.

## Result

The intended user-visible behavior is:

- Undo and Redo still target the correct logical scope.
- Layer history shows only edits that actually touched that layer.
- Multi-layer Python edits remain one logical undo step.
- Font-level undo reverts exactly one targeted font-scope history item, even in mixed histories that also contain layer or glyph edits.
- Linked windows stay in sync without losing undo ownership.
