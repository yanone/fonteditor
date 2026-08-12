# Undo and History Scopes

Undo in Counterpunch follows the **focused editing surface**, not merely “whatever glyph name appears in a history item.” History shows the collaboration log; rows that the current ⌘Z stack cannot reach are hidden by default (or faded when revealed).

## Surfaces

| Surface | Focused view | ⌘Z undoes |
|---|---|---|
| **Canvas** | Glyph editor with a layer selected | Edits whose **originating layer** is the current glyph/layer (including cascades that started there) |
| **Overview** | Glyph overview | Glyph-structural edits (paste, duplicate, delete, reorder, codepoints, rename, …) |
| **Font Info** | Font Info (non-Features) | Pure font-wide edits (masters, names, UPM, master guides, …) |
| **Features** | Font Info Features with an item selected | That feature / class / prefix only |
| **Automation** | Scripts, Konsole, or Assistant | Font mutations produced by Python or the Assistant (any derived font/glyph/layer scope) |

Surfaces do not share one interleaved stack: a later font edit does not block undoing an earlier layer edit on the canvas. Automation is the exception for scripted work: while Scripts, Konsole, or Assistant is focused, ⌘Z walks Python- and Assistant-sourced history items only (not ordinary GUI edits from other surfaces).

## Originating layer

Canvas undo keys off where the forward edit **started**, not every layer touched afterward.

- Edit layer A → cascade updates dependents → undoable on **A**, not on a dependent layer.
- Paste a glyph in the overview → open it on the canvas → creation stays **overview-only** (not canvas-undoable), even though the history item names that glyph.

## History visibility

- **Bright / listed (default):** items on the current surface’s undo **and** redo stack (including undone edits and their undo/redo rows).
- **Hidden by default:** everything else, replaced by compact markers such as `3 hidden · other context`.
- **Title-bar toggle** (visibility icon): show unreachable rows faded. Clicking a hidden-run marker turns the toggle on.
- Fade means “outside this undo/redo context”; ⌘Z undoes the newest active bright item, and ⌘⇧Z can redo undone bright items.
- Opening **History** does **not** change the undo surface — filtering stays on the last focused main view (Editor, Overview, or Font Info). Scripts / Konsole / Assistant switch to the automation surface while they are focused.

## Ace editors and ⌘Z

In the Script Editor and Features Ace editors:

- `Cmd/Ctrl + Z` / `Cmd/Ctrl + Shift + Z` undo and redo **font history** for the current surface
- `Cmd/Ctrl + Alt + Z` / `Cmd/Ctrl + Alt + Shift + Z` undo and redo **text** inside the Ace buffer

While Scripts, Konsole, or Assistant is focused, the same font-history shortcuts apply even when the caret is in the prompt or terminal.

## Reading a history row

- **Title** — transaction summary
- **Action chip** — `edit` (grayscale), `undo` / `redo` (colored)
- **Origin** — follows the item’s **undo scope**, not the first layer path in the packet: `Layer · {glyph} / {master}` (layer-scoped), `Overview` (glyph-scoped), `Font` (font-scoped, including add/remove master even when many layer paths are present), `Feature · …` (feature target). This is where to switch to undo a faded row when you are not on the automation surface.
- **`account_tree`** — transaction recomposed dependent layers
- Time / duration / size — development builds only

## Practical checks

1. Confirm which view is focused (canvas, overview, Font Info, Features, Scripts, Konsole, or Assistant).
2. If a scripted edit is missing, focus Scripts / Konsole / Assistant, or enable “show outside context” / switch to the origin surface on the row.
3. For cascades from manual canvas edits, return to the layer you edited.

## Related Pages

- [Glyph Editor Basics](../editor/01-glyph-editor-basics.md)
- [Feature Code Editor](../features/01-feature-code-editor.md)
- [Keyboard Shortcuts](keyboard-shortcuts.md)
- [Common Problems and Recovery](../troubleshooting/common-problems.md)
