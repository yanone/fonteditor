# Glossary

Type design mixes geometric, typographic, and technical terms. These are the meanings used in Counterpunch’s interface and handbook.

- **Glyph** — a stored character shape: a letter, number, or symbol.
- **Contour** — a connected outline path that is part of a glyph.
- **Node / point** — an editable location on a contour.
- **Layer** — a stored design state of a glyph, often a master in a variable font.
- **Axis** — a variable dimension such as weight or width.
- **Master** — a key design at a location in that space.
- **Instance** — a named style at chosen axis values.
- **Interpolation** — generated shapes between masters.
- **Assistant editing** — the pen toggle in the Assistant title bar. Off: inspect only. On: the assistant may mutate the font and edit an unsaved Script Editor buffer.
- **Metrics key** — a sidebearing formula such as `=n+10` or `==|H`.
- **Undo surface** — the focused `Cmd/Ctrl+Z` stack (Canvas, Overview, Font Info, Features, or Automation). History lists edits; it does not change which surface undo uses.
- **Filter script** — Python in `Counterpunch/Filters` that decides which glyphs Overview shows.

Axes are covered in [Axes and masters](../editor/03-axes-masters.md). Scripting starts in [Python in Counterpunch](../python/01-python-in-counterpunch.md).
