# Writing Glyph Overview Filters

Save Glyph Overview filters as Python files in `Counterpunch/Filters`. A
filter only reads one glyph at a time and decides whether it belongs in the
Overview result.

## Small Contract

Every filter needs literal `EVENT_TYPES` and `classify_glyph(glyph)`:

```python
EVENT_TYPES = ["glyph.unicode.changed"]

def classify_glyph(glyph):
    return not glyph.codepoints
```

Return `False` to hide a glyph and `True` to show it without groups. Return a
mapping with a non-empty `groups` list only when the filter needs categories.

Each group always includes both fields:

```python
{"name": "Readable group name", "color": "CSS color"}
```

The group name is its visible label and identity. The app combines equal names
across glyphs. If matching groups use different colors, the most recently
classified glyph supplies the displayed color.

## Optional Fast Gate

Use `is_candidate(glyph)` only for a cheap early rejection. The app calls it
before `classify_glyph(glyph)`.

```python
EVENT_TYPES = ["glyph.anchors.changed"]

def is_candidate(glyph):
    return glyph.name.endswith(".sc")

def classify_glyph(glyph):
    if glyph.anchors:
        return False
    return {
        "groups": [
            {"name": "Unanchored small caps", "color": "orange"}
        ]
    }
```

`is_candidate()` does not need to predict the final answer. It only decides
whether `classify_glyph()` is worth calling. A candidate may still return
`None`.

For a filter that finds glyphs without anchors, do not use a gate: both
anchor-bearing and anchorless glyphs must be classified.

## Events

`EVENT_TYPES` lists only glyph-content changes that can change this filter's
answer. The app reclassifies the affected glyph after a matching committed
edit.

Do not subscribe to these events:

```text
glyph.created
glyph.deleted
glyph.renamed
font.masters.changed
```

The app always manages creation, deletion, and renaming. It also emits
`glyph.compatibility.changed` only when a glyph's compatibility actually
changes, so compatibility filters should subscribe to that targeted event.

Do not use `filter_glyphs`, `apply_changes`, `GROUPS`, `glyph_name`, or cache
management. The app owns complete scans, incremental updates, group cleanup,
and result cache keys.

## Running

The app scans all glyphs when a filter first loads, reloads, or is explicitly
refreshed. After that, it updates only changed glyphs. Filters run read-only;
they must not edit the font.

Keep both functions small. A filter runs as part of normal update handling,
so expensive whole-font searches, I/O, and asynchronous work do not belong in
this filter type.

## Assistant Workflow

When creating or editing a filter with Assistant, first call
`glyph_filter_event_types`, then create the smallest possible filter. After
every edit, call `validate_python_document`. The Assistant does not run or
save the filter.

## Related Pages

- [Code-Driven Glyph Filters](../overview/02-code-driven-filters.md)
- [Python API Reference](../../API.md)
