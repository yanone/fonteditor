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
   This is derived from the actual changed paths and stored as:
    - `touchedPaths`
    - `touchedGlyphNames`
    - `touchedLayerKeys`

This separation is important because one logical edit can be glyph-scoped for undo purposes while still needing to appear in multiple layer histories.

## Undo Scope Rules

- Font scope is used for edits outside glyphs or edits spanning multiple glyphs.
- Layer scope is used for edits confined to one glyph layer.
- Glyph scope is used for edits confined to one glyph but spanning more than one layer or including glyph-level data outside a single layer.

History items derive their undo scope from the aggregate entry set, not from display filtering.

## History Visibility Rules

- Font history shows all items.
- Glyph history shows items whose `touchedGlyphNames` contain the active glyph.
- Layer history shows items whose `touchedLayerKeys` contain the active `glyph@@layer` key.

This replaces the earlier approach where layer history inferred visibility from promoted glyph scope. The earlier model was too approximate because it showed glyph-scoped items in every layer history for that glyph, even if the layer was untouched.

## Yjs Ownership

Undo behavior is implemented with separate undo managers:

- Font undo manager for top-level font data.
- Glyph undo managers keyed by glyph name.
- Layer undo managers keyed by `glyph@@layer`.

The transaction origin determines which undo manager captures a change set. Display metadata does not affect this.

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
    - Each synthetic entry carries touched metadata derived from its changed path.
    - History items aggregate those touched scopes, so the Python action appears only in the relevant glyph and layer histories.

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

## Known Constraints

- Synchronous `runPython` cannot await async post-execution work; it can only trigger it.
- Snapshot normalization must mirror serialization enough to avoid false positives, especially for path node arrays.
- Full-font Python changes can legitimately surface as font-scoped history items.

## Result

The intended user-visible behavior is:

- Undo and Redo still target the correct logical scope.
- Layer history shows only edits that actually touched that layer.
- Multi-layer Python edits remain one logical undo step.
- Linked windows stay in sync without losing undo ownership.
