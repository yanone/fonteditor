---
name: gortex-glyph-canvas
description: "Work in the glyph-canvas area — 41 symbols across 1 files (48% cohesion)"
---

# glyph-canvas

41 symbols | 1 files | 48% cohesion

## When to Use

Use this skill when working on files in:
- `webapp/js/glyph-canvas/textrun.ts`

## Key Files

| File | Symbols |
|------|---------|
| `webapp/js/glyph-canvas/textrun.ts` | TextRunEditor, findExplicitGlyphTokenStartingAt, bidiRuns, constructor, displayTextBuffer, ... |

## How to Explore

```
get_communities with id: "community-42"
smart_context with task: "understand glyph-canvas", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
