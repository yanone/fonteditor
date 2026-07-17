# Writing Glyph Overview Filters

Use a Glyph Overview filter to select and optionally categorize glyphs in the
Overview. Save the file in `Counterpunch/Filters`. A filter is not a reusable
font-editing script: Glyph Overview calls it to decide which glyphs to display.

## Required Function

Every filter must define `filter_glyphs(font)`. The function receives the
current font directly; do not call `Font()` or import the font API. Yield or
return dictionaries containing a `glyph_name` key for each glyph to include.

```python
# Show glyphs without Unicode values
# Keywords: glyphs, unicode

def filter_glyphs(font):
    for glyph in font.glyphs:
        if not glyph.codepoints:
            yield {'glyph_name': glyph.name}
```

Use `yield` for large fonts so the filter does not need to build a full list in
memory. Returning a list of the same dictionaries also works.

## Optional Groups

Define `GROUPS` when the filter needs a legend or colors. Group names should be
short and readable. Each group declares a legend description and a CSS color.

```python
GROUPS = {
    'uppercase': {
        'description': 'Uppercase letters',
        'color': '#4CAF50'
    },
    'lowercase': {
        'description': 'Lowercase letters',
        'color': '#2196F3'
    }
}


def filter_glyphs(font):
    for glyph in font.glyphs:
        if len(glyph.name) == 1 and glyph.name.isupper():
            yield {'glyph_name': glyph.name, 'group': 'uppercase'}
        elif len(glyph.name) == 1 and glyph.name.islower():
            yield {'glyph_name': glyph.name, 'group': 'lowercase'}
```

Use `group` for one category or `groups` for several categories:

```python
yield {
    'glyph_name': glyph.name,
    'groups': ['has_anchors', 'has_components']
}
```

A group may name a `GROUPS` entry or use a raw CSS color such as `'#ff5500'`,
`'coral'`, or `'rgb(255, 100, 50)'`. Raw colors receive generated legend
entries. Only add groups when the filter genuinely needs categorization.

## Complete Multi-Group Example

```python
# Review glyph construction
# Keywords: glyphs, anchors, components

GROUPS = {
    'has_anchors': {'description': 'Has anchors', 'color': 'green'},
    'has_components': {'description': 'Has components', 'color': 'blue'},
    'empty': {'description': 'Empty glyph', 'color': 'red'}
}


def filter_glyphs(font):
    for glyph in font.glyphs:
        groups = set()
        for layer in glyph.layers:
            if layer.anchors:
                groups.add('has_anchors')
            if layer.components:
                groups.add('has_components')
            if not layer.paths and not layer.components:
                groups.add('empty')

        if groups:
            yield {'glyph_name': glyph.name, 'groups': sorted(groups)}
```

## Practical Advice

- Change one condition at a time and inspect the resulting Overview.
- Cache expensive setup outside the glyph loop.
- Prefer early skips and generators over deeply nested loops.
- Use `print()` sparingly for development diagnostics; Glyph Overview displays
  errors when a filter cannot run.

## Agent Boundary

The Agent can read and edit the unsaved Script Editor buffer when Agent editing
is enabled. It never runs the filter, saves it, or selects it in Glyph Overview.
Review the buffer, save it yourself, then select the filter from Glyph Overview.

## Related Pages

- [Code-Driven Glyph Filters](../overview/02-code-driven-filters.md)
- [Python API Reference](../../API.md)
