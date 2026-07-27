# Writing Glyph Overview Filters

Use a Glyph Overview filter to select and optionally categorize glyphs in the
Overview. Save the file in `Counterpunch/Filters`. A filter is not a reusable
font-editing script: Glyph Overview calls it to decide which glyphs to display.

## Required Contract

Every filter must define `EVENT_TYPES` and `filter_glyphs(font)`. `EVENT_TYPES`
contains only incremental event types from the central registry. The host always
runs `filter_glyphs(font)` on font open, filter activate, and filter file reload
— those are not events. An optional
`apply_changes(change_batch, current_results, font)` may maintain the cached
result incrementally; it returns `None` to request complete reconciliation.
The filter function receives the current font directly; do not call `Font()`
or import the font API. Yield or return
dictionaries containing a `glyph_name` key for each glyph to include.

```python
EVENT_TYPES = {'glyph.unicode.changed'}

def filter_glyphs(font):
    return []
```

When authoring a filter with Assistant, it must call
`glyph_filter_event_types` first. That tool returns the current registry event
list and a complete compact example. Do not invent event types.

```python
# Show glyphs without Unicode values
# Keywords: glyphs, unicode

EVENT_TYPES = {'glyph.unicode.changed'}

def filter_glyphs(font):
    for glyph in font.glyphs:
        if not glyph.codepoints:
            yield {'glyph_name': glyph.name}
```

Use `yield` for large fonts so the filter does not need to build a full list in
memory. Returning a list of the same dictionaries also works.

Put optional `apply_changes` after `filter_glyphs`. Its `add` entries use the
same result dictionaries, so an incremental update can replace group
membership:

```python
def apply_changes(change_batch, current_results, font):
    return {
        'remove': ['adieresis'],
        'add': [
            {'glyph_name': 'adieresis', 'groups': ['latin_ext_a']}
        ]
    }
```

`add` also accepts bare glyph names when no group metadata is needed:

```python
{'add': ['adieresis'], 'remove': ['aacute']}
```

Removals happen before additions. Removing an absent glyph or adding a glyph
already present in the cached result is a no-op.

### Complete `apply_changes` Example

The following example is adapted from the built-in All Glyphs filter. It
handles every event type that the filter subscribes to, with annotated lines
showing where filter-specific membership logic would go:

```python
EVENT_TYPES = {'glyph.created', 'glyph.deleted', 'glyph.renamed'}

def filter_glyphs(font):
    """Return every glyph in the font."""
    for glyph in font.glyphs:
        yield {'glyph_name': glyph.name}

def apply_changes(change_batch, current_results, font):
    add = []
    remove = []

    for change in change_batch['changes']:
        metadata = change['metadata']
        glyph_name = metadata.get('glyphName')

        if change['type'] == 'glyph.deleted':
            # A glyph was removed from the font.
            remove.append(glyph_name)
            continue

        if change['type'] == 'glyph.renamed':
            # The old name leaves the result set.
            remove.append(metadata['previousGlyphName'])
            # The new name enters the result set.
            add.append(glyph_name)
            # ── Additional filter logic ──────────────────────────
            # If groups depend on the glyph name, recalculate them
            # here and use a result-record instead of a bare name.
            # add.append({'glyph_name': glyph_name, 'groups': [...]})
            # ────────────────────────────────────────────────────
            continue

        if change['type'] == 'glyph.created':
            # A new glyph was added to the font.
            add.append(glyph_name)
            # ── Additional filter logic ──────────────────────────
            # Check glyph properties, category, codepoints, etc.
            # to decide whether to skip this addition.
            # ────────────────────────────────────────────────────
            continue

    return {'add': add, 'remove': remove}
```

The same pattern applies to any filter. The annotation lines mark where
filter-specific conditions belong: for example, an encoded-glyph filter
adds a glyph only when it has codepoints, and an incompatible-outlines
filter adds a glyph only when its compatibility check fails.

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

EVENT_TYPES = set()

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

EVENT_TYPES = {
    'glyph.created',
    'glyph.deleted',
    'glyph.renamed',
    'glyph.anchors.changed',
    'glyph.components.changed',
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
