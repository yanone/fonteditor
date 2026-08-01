# Undo and History Scopes

Undo in Counterpunch follows the **focused editing surface**, not merely “whatever glyph name appears in a history item.” History shows the collaboration log; rows that the current ⌘Z stack cannot reach are hidden by default (or faded when revealed).

## Surfaces

| Surface | Focused view | ⌘Z undoes |
|---|---|---|
| **Canvas** | Glyph editor with a layer selected | Edits whose **originating layer** is the current glyph/layer (including cascades that started there) |
| **Overview** | Glyph overview | Glyph-structural edits (paste, duplicate, delete, reorder, codepoints, rename, …) |
| **Font Info** | Font Info (non-Features) | Pure font-wide edits (masters, names, UPM, master guides, …) |
| **Features** | Font Info Features with an item selected | That feature / class / prefix only |

Surfaces do not share one interleaved stack: a later font edit does not block undoing an earlier layer edit on the canvas.

## Originating layer

Canvas undo keys off where the forward edit **started**, not every layer touched afterward.

- Edit layer A → cascade updates dependents → undoable on **A**, not on a dependent layer.
- Paste a glyph in the overview → open it on the canvas → creation stays **overview-only** (not canvas-undoable), even though the history item names that glyph.

## History visibility

- **Bright / listed (default):** items on the current surface’s undo **and** redo stack (including undone edits and their undo/redo rows).
- **Hidden by default:** everything else, replaced by compact markers such as `3 hidden · other context`.
- **Title-bar toggle** (visibility icon): show unreachable rows faded. Clicking a hidden-run marker turns the toggle on.
- Fade means “outside this undo/redo context”; ⌘Z undoes the newest active bright item, and ⌘⇧Z can redo undone bright items.
- Opening **History** (or other auxiliary panels) does **not** change the undo surface — filtering stays on the last focused main view (Editor, Overview, or Font Info).

## Reading a history row

- **Title** — transaction summary
- **Action chip** — `edit` (grayscale), `undo` / `redo` (colored)
- **Origin** — `Layer · {glyph} / {master}` (layer id resolved to Master name) / `Overview` / `Font` / `Feature · …` (where to switch to undo a faded row)
- **`account_tree`** — transaction recomposed dependent layers
- Time / duration / size — development builds only

## Practical checks

1. Confirm which view is focused (canvas, overview, Font Info, Features).
2. If an edit is missing, enable “show outside context” or switch to the origin surface on the row.
3. For cascades, return to the layer you edited.

## Related Pages

- [Glyph Editor Basics](../editor/01-glyph-editor-basics.md)
- [Feature Code Editor](../features/01-feature-code-editor.md)
- [Common Problems and Recovery](../troubleshooting/common-problems.md)
