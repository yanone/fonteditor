# Glyph Filter Events

## Purpose

Glyph filters refresh from one committed semantic change batch, not from raw
Yjs packets or broad browser events. The Yjs update remains an internal
transport; the host derives a stable, read-only filter-facing summary.

## Event Contract

Supported event types live in `webapp/js/glyph-filter-events.ts`. They use
dotted names such as `glyph.unicode.changed`; browser `CustomEvent` names
remain internal and are not a plugin API.

Path-to-event derivation lives in
`webapp/js/glyph-filter-change-derivation.ts`. Compatibility is special:
`glyph.compatibility.changed` fires only when `Glyph.isCompatible` toggles,
not on every layer edit.

Full rebuilds are **not** events. On font open, filter activate, and filter
file reload, the host calls `filter_glyphs(font)` directly with an empty
change batch and skips `apply_changes`. `EVENT_TYPES` / `event_types` cover
incremental edits only.

The registry contains these events currently:

```text
glyph.created
glyph.deleted
glyph.renamed
glyph.unicode.changed
glyph.category.changed
glyph.export.changed
glyph.production-name.changed
glyph.paths.changed
glyph.components.changed
glyph.component.reference.changed
glyph.component.transform.changed
glyph.anchors.changed
glyph.guides.changed
glyph.layers.changed
glyph.layer.location.changed
glyph.metrics.changed
glyph.metrics-key.changed
glyph.compatibility.changed
font.masters.changed
```

## Useful Future Event Names

```text
font.glyph-order.changed
font.axes.changed
font.instances.changed
font.kerning.changed
font.features.changed
font.classes.changed
font.prefixes.changed
font.compile.completed
font.compile.failed
font.shaping-data.changed
language-packs.changed
glyph-data.provider.changed
glyph-filter.settings.changed
glyph-filter.source.changed
glyph-filter.enabled.changed
```

After the host's full `filter_glyphs` rebuild, the host intersects each
filter's declared event types with a committed change batch and runs only
matching filters (preferring `apply_changes` when present).

## Wheel Filters

Wheel filters must expose:

```python
event_types = {"glyph.unicode.changed"}

def filter_glyphs(self, font):
    return []

def apply_changes(self, change_batch, current_results, font_view):
    return None
```

The host calls optional `apply_changes` first for incremental batches only.
It returns `None` to request `filter_glyphs(font)`, or an idempotent delta.
`remove` is a list of glyph names. `add` accepts either bare glyph names or
ordinary filter-result records, including `group` or `groups`; removals apply
before additions so one glyph can be intentionally replaced with new group
membership.

## Single-File User Filters

User files under `Counterpunch/Filters` are not class plugins. They require a
stripped module-level contract:

```python
EVENT_TYPES = {"glyph.unicode.changed", "glyph.created"}

GROUPS = {}

def filter_glyphs(font):
    return []

def apply_changes(change_batch, current_results, font):
    return {
        "remove": ["adieresis"],
        "add": [
            {"glyph_name": "adieresis", "groups": ["latin_ext_a"]}
        ]
    }
```

`EVENT_TYPES` and `filter_glyphs(font)` are mandatory. Optional
`apply_changes(change_batch, current_results, font)` is parsed with `ast`
without executing the file. A matched incremental batch executes the file in
the isolated filter worker, calls `apply_changes` when present, and only
calls `filter_glyphs` when it returns `None`. Full rebuilds never call
`apply_changes`.

There is no compatibility path for old filters without these declarations.

## Change Batch

The host passes JSON-like immutable data:

```text
changes[]
  type
  metadata
```

An empty `changes` list means a host-driven full rebuild. It never exposes
Yjs bytes, Yjs structures, raw JSON pointers, undo internals, or worker
transport metadata.

## Documentation

`npm run generate-glyph-filter-event-docs` writes
`developer-docs/GLYPH_FILTER_EVENTS.md` from the central registry. Run it with
the normal generated documentation commands after changing the registry.
