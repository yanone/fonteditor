---
name: gortex-tests
description: "Work in the tests area — 51 symbols across 3 files (50% cohesion)"
---

# tests

51 symbols | 3 files | 50% cohesion

## When to Use

Use this skill when working on files in:

- `webapp/js/glyph-canvas/outline-editor.ts`
- `webapp/tests/change-bridge-cross-window.spec.ts`
- `webapp/tests/open-close-path.spec.ts`

## Key Files

| File                                              | Symbols                                                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `webapp/js/glyph-canvas/outline-editor.ts`        | \_handleDrag, usesSharedSnapDrag, \_getPrimaryDragNodePos, \_updateDraggedAnchors, getCurrentLayerDataFromStack, ... |
| `webapp/tests/change-bridge-cross-window.spec.ts` | extractActiveInterpolatedRenderState                                                                                 |
| `webapp/tests/open-close-path.spec.ts`            | waitForOutlineState, getActiveLayerOutlineState                                                                      |

## Connected Communities

- **js** (10 cross-edges)
- **get** (7 cross-edges)
- **glyph-canvas** (7 cross-edges)
- **get** (5 cross-edges)
- **glyph-canvas** (5 cross-edges)
- **js** (5 cross-edges)
- **glyph-canvas** (4 cross-edges)
- **js** (3 cross-edges)
- **glyph-canvas** (3 cross-edges)
- **js** (3 cross-edges)
- **glyph-canvas** (2 cross-edges)
- **glyph-canvas** (2 cross-edges)
- **glyph-canvas** (2 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **canonical** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **js** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **js** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-320"
smart_context with task: "understand tests", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
