# Writing General Python Scripts

Use a general Python script for a reusable font operation that you run yourself
from the Script Editor. Save it in `Counterpunch/Scripts` when you want to keep
it for later. It is different from a Glyph Overview filter: a general script
may inspect or modify the active font, while a filter only describes glyphs for
Overview to show.

## Start With the Active Font

Counterpunch already provides the font API in the scripting environment. Start
with `Font()` and do not import `fonteditor` or `context`:

```python
# Report glyph and master counts
# Keywords: glyphs, masters

font = Font()
print(f'Glyphs: {len(font.glyphs)}')
print(f'Masters: {len(font.masters)}')
```

`Font()` returns the current open font and raises an error when no font is
open. Use the Python API reference when you need an exact property or method.

## Write Reusable Scripts

Keep a script self-contained and focused on one operation. Start with a small,
read-only report when you are exploring data. Before a script changes font data,
save the font and make the intended change clear in its header and comments.

Use `print()` for results, counts, skipped items, and next steps. This makes a
script useful when you return to it later and makes errors easier to diagnose.

```python
# List glyphs without Unicode values
# Keywords: glyphs, unicode

font = Font()
missing_unicode = [glyph.name for glyph in font.glyphs if not glyph.codepoints]

print(f'{len(missing_unicode)} glyphs have no Unicode value:')
for glyph_name in missing_unicode:
    print(glyph_name)
```

## Handle Errors Deliberately

When an operation can fail for an expected reason, report that reason rather
than silently continuing. Do not catch broad errors just to hide a traceback:
the Script Editor traceback is useful while developing a script.

```python
# Report a required glyph width
# Keywords: glyphs, metrics

font = Font()
glyph_name = 'A'
glyph = font.glyphs.get(glyph_name)

if glyph is None:
    print(f'Glyph not found: {glyph_name}')
else:
    print(f'{glyph_name} width: {glyph.width}')
```

## Suggested File Header

Use a short command-style summary, a focused keyword line, and a few comments
that explain the operation. This makes a saved script easy to scan in the
Scripts folder.

```python
# Add 10 units to selected glyph widths
# Keywords: metrics
#
# This script updates the selected glyphs and prints a summary.
```

## Agent Boundary

The Agent can read and edit the unsaved Script Editor buffer when Agent editing
is enabled. It never runs the script or saves it. Review the buffer, then use
the Script Editor's own Save and Run controls when you decide to persist or run
the operation.

## Related Pages

- [Python in Counterpunch](01-python-in-counterpunch.md)
- [Script Editor Workflow](02-script-editor-workflow.md)
- [Python API Reference](../../API.md)