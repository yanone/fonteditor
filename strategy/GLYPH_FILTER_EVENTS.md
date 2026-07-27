# Glyph Filter Events

## Purpose

Glyph filters refresh from one committed semantic change batch, not from raw
Yjs packets or broad browser events. The Yjs update remains an internal
transport; the host derives a stable, read-only filter-facing summary.

## Event Contract

Supported event types live in `webapp/js/glyph-filter-events.ts`. They use
dotted names such as `glyph.unicode.changed`; browser `CustomEvent` names
remain internal and are not a plugin API.

The initial registry contains only events needed by shipped filters:

```text
font.opened
font.replaced
glyph.created
glyph.deleted
glyph.renamed
glyph.unicode.changed
glyph.compatibility.changed
font.masters.changed
```

Every filter runs once on `font.opened` and `font.replaced`. Afterward, the
host intersects each filter's declared event types with a committed change
batch and runs only matching filters that request a rebuild.

## Wheel Filters

Wheel filters must expose:

```python
event_types = {"glyph.unicode.changed"}

def needs_rebuild(self, change_batch, font_view):
    return {"action": "refresh"}
```

The host calls `filter_glyphs(font)` only after `needs_rebuild` returns
`{"action": "refresh"}`. `{"action": "skip"}` prevents execution.

## Single-File User Filters

User files under `Counterpunch/Filters` are not class plugins. They require a
stripped module-level contract:

```python
EVENT_TYPES = {"glyph.unicode.changed", "glyph.created"}

def needs_rebuild(change_batch):
    return "glyph.unicode.changed" in change_batch["event_types"]

GROUPS = {}

def filter_glyphs(font):
    return []
```

`EVENT_TYPES`, `needs_rebuild(change_batch)`, and `filter_glyphs(font)` are
mandatory. Discovery parses these declarations with `ast` without executing
the file. A matched batch executes the file in the isolated filter worker,
calls `needs_rebuild`, and only then calls `filter_glyphs`.

There is no compatibility path for old filters without these declarations.

## Change Batch

The host passes JSON-like immutable data:

```text
revision
source
event_types
glyphs[glyph name].changed_fields
glyphs[glyph name].layer_ids
```

It never exposes Yjs bytes, Yjs structures, raw JSON pointers, undo internals,
or worker transport metadata.

## Documentation

`npm run generate-glyph-filter-event-docs` writes
`developer-docs/GLYPH_FILTER_EVENTS.md` from the central registry. Run it with
the normal generated documentation commands after changing the registry.
