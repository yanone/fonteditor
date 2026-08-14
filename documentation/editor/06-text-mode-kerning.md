# Text-mode kerning

Counterpunch edits kerning in text mode, with the caret between two glyphs, so pair work stays next to the shaped text. Group membership is visible, and you can switch between glyph-level and group-level kerning. Edits apply to the currently selected exact master.

## Where to edit

Switch the Editor to text mode and put the caret between two glyphs. The property panel shows:

- **First** for the glyph before the caret
- **Second** for the glyph after the caret
- an inline kerning value in the center
- chips for the base glyph and any kerning group on each side

Without an exact master the operands still show, but kerning is read-only until you choose a real master.

**Font → Kerning Editor…** opens a table of all defined pairs (LTR or RTL) with values per master. Opening it from text mode selects the active First/Second chips from the panel and scrolls that row into view. Select a row to delete it from every master, or edit individual cells. Undo restores previous values and the table UI state.

## Pair choice and groups

Counterpunch prefers an existing glyph-to-glyph or glyph-to-group pair when one is defined, otherwise a group pair. Click a different chip to override. The active pair is the selected chips plus the inline preview.

A glyph may belong to one kerning group per side. `+` adds the current glyph to a group on that side; `x` removes it. The add button disables once that side already has a group.

## Values and shortcuts

Type a number in the inline field. Negative values tighten, positive values open, an empty field clears the pair. The overlay updates from the active pair.

For LTR, the caret stays at the between-glyph edge: left of the overlay when the value is negative, right when positive. The canvas stays anchored on the glyph left of the pair. RTL is the mirror: the canvas stays anchored on the glyph right of the caret.

Arrow nudges and field arrows update the active pair immediately, then commit after a short idle (same delay as keyboard outline edits). Other matching pairs in the proof string refresh after compile.

- `Alt/Option+Left` / `Alt/Option+Right` change the value by 1
- add Shift for 10
- add `Cmd/Ctrl` with Shift for 100

A practical loop: type a short proof, put the caret in the pair, check whether it is a glyph or group pair, switch chips if needed, nudge with Alt/Option+Arrow, and add a group only when that side has none yet.

Related: [Glyph editor](01-glyph-editor.md), [Sidebearing arithmetics](04-sidebearing-arithmetics.md), [Keyboard shortcuts](../reference/keyboard-shortcuts.md).
