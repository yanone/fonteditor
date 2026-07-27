# Writing General Python Scripts

Use a general-purpose Python script for a reusable font operation that you run yourself
from the Script Editor. Save it in `Counterpunch/Scripts` when you want to keep
it for later. It is different from a Glyph Overview filter: a general-purpose script
may inspect or modify the active font, while a filter only describes glyphs for
Overview to show.

## Start With the Active Font

Counterpunch already provides the font API in the scripting environment. Start
with `Font()` which does not need to be imported:

```python
# Report glyph and master counts
# Keywords: glyphs, masters

font = Font()
print(f'Glyphs: {len(font.glyphs)}')
print(f'Masters: {len(font.masters)}')
```

`Font()` returns the current open font and raises an error when no font is
open. Use the Python API reference (tool python_api_docs) when you need an exact property or method.

## Write Reusable Scripts

Keep a script self-contained and focused on one operation. Start with a small,
read-only report when you are exploring data. Before a script changes font data,
save the font and make the intended change clear in its header and comments.
Font manipulation by a Python script can be undone with the undo command.

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

## File Header

At the top of a file you include information that is displayed to the user in the Run Python Script dialog. The file name used as the script title, and the file header includes auxiliary information such as a description and keywords.

The description consists of several optional comment lines, followed by an optional commented keywords line that starts with `Keywords:` and contains a comma-delimited list of keywords that will be displayed to the user in a keyword cloud in the Run Python Script dialog.

Update the description and the keywords if the script purpose changes significantly from the stated description.

The keywords are primarily chosen from the below list, and only if they pertain to the actual target functionality of the script. If for example glyphs and layers are merely used for filtering in a for loop, omit glyphs and layers from the keywords list.

The following keywords are permitted, and may be extended manually by the user:
glyphs, layers, paths, nodes, anchors, components, metrics, names, masters, unicode, kerning, groups, features, guidelines

Don't remove keywords that a user has put in that list.

Example:
```python
# This script updates the selected glyphs
# and prints a summary.
#
# Keywords: metrics
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
