# Text-Mode Kerning

Counterpunch edits kerning directly in text mode, where you can place the text cursor between two glyphs and work on the active pair in context. The goal is practical: keep pair editing close to the shaped text, make group membership visible, and let you switch quickly between glyph-level and group-level kerning.

## Summary

When the text cursor sits between two adjacent glyphs, the property panel shows the current kerning pair. Counterpunch lets you:

- inspect which glyph-level and group-level operands are available on each side
- switch the active pair by clicking the chips
- edit the kerning value directly in the inline field
- add or remove one kerning group per glyph per side

Kerning edits happen on the currently selected exact master.

## Where To Edit

Open the Editor in text mode and place the cursor between two glyphs. The property panel at the bottom switches to a kerning panel.

The panel shows:

- a `First` side for the glyph before the cursor
- a `Second` side for the glyph after the cursor
- an inline kerning value field in the center
- pills for the base glyph and any kerning group on each side

If no exact master is selected, the panel still shows the operands, but kerning stays read-only until you choose a real master.

## How Pair Selection Works

Counterpunch tries to pick the most useful pair automatically.

- If a defined glyph-to-glyph or glyph-to-group pair exists, it prefers that.
- If no explicit value exists, it can fall back to a group pair.
- You can override the automatic choice by clicking a different chip.

The active pair is shown both by the selected chips and by the inline code preview in the center of the panel.

## Kerning Groups

Kerning groups are edited from the same panel.

- Click `+` on either side to add the current glyph to a group on that side.
- Click the `x` on a group chip to remove the current glyph from that group.
- A glyph may currently belong to only one kerning group per side.

That means:

- if a glyph already has a first-side group, the first-side add button is disabled
- if a glyph already has a second-side group, the second-side add button is disabled

This keeps group membership simple while the broader kerning strategy is being revised.

## Editing Values

Type a number into the inline field to set the active kerning pair.

- negative values tighten spacing
- positive values open spacing
- an empty field clears the active pair

The kerning overlay in text mode updates from the active pair so you can see the adjustment in place.

## Keyboard Shortcuts

These shortcuts are the main ones for text-mode kerning:

- `Alt/Option + Left Arrow` decreases the active kerning value by `1`
- `Alt/Option + Right Arrow` increases the active kerning value by `1`
- add `Shift` to change by `10`
- add `Cmd/Ctrl` together with `Shift` to change by `100`
- `Enter` commits the value currently typed in the kerning field
- `Escape` cancels the current draft value in the kerning field

## A Practical Workflow

1. Type a short proof string and place the cursor between the pair you want to inspect.
2. Check whether the active pair is a glyph pair or a group pair.
3. If needed, switch operands by clicking the chips.
4. Adjust the value with `Alt/Option + Arrow` for quick tuning.
5. Add a group only when the glyph has no group yet on that side.

## Related Pages

- [Glyph Editor Basics](01-glyph-editor-basics.md)
- [Sidebearing Arithmetics](03-sidebearing-arithmetics.md)
- [Keyboard Shortcuts](../reference/keyboard-shortcuts.md)
