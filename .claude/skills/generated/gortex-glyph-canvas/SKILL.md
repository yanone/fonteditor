---
name: gortex-glyph-canvas
description: "Work in the glyph-canvas area — 41 symbols across 4 files (51% cohesion)"
---

# glyph-canvas

41 symbols | 4 files | 51% cohesion

## When to Use

Use this skill when working on files in:
- `webapp/js/glyph-canvas.ts`
- `webapp/js/glyph-canvas/measurement-tool.ts`
- `webapp/js/glyph-canvas/outline-editor.ts`
- `webapp/js/glyph-canvas/stack-preview-animator.ts`

## Key Files

| File | Symbols |
|------|---------|
| `webapp/js/glyph-canvas.ts` | setupEventListeners, onResize, focusCanvasForMeasurementTab, shouldBlockTextEditingDuringLoopAnimation, onBlur, ... |
| `webapp/js/glyph-canvas/measurement-tool.ts` | handleMeasurementKeyRelease, handleMouseUp, shouldBlockHitDetection, shouldShowCrosshair, handleMeasurementKeyPress, ... |
| `webapp/js/glyph-canvas/outline-editor.ts` | setCommandKeyPressed, onBlur, setAltKeyPressed, performHitDetection, updateHoveredResizeHandle, ... |
| `webapp/js/glyph-canvas/stack-preview-animator.ts` | shouldRenderStackPreview |

## Connected Communities

- **js** (30 cross-edges)
- **tests** (9 cross-edges)
- **js** (8 cross-edges)
- **glyph-canvas** (6 cross-edges)
- **glyph-canvas** (3 cross-edges)
- **get** (3 cross-edges)
- **js** (3 cross-edges)
- **get** (3 cross-edges)
- **js** (2 cross-edges)
- **glyph-canvas** (2 cross-edges)
- **js** (2 cross-edges)
- **js** (2 cross-edges)
- **glyph-canvas** (2 cross-edges)
- **js** (2 cross-edges)
- **glyph-canvas** (2 cross-edges)
- **glyph-canvas** (2 cross-edges)
- **js** (1 cross-edges)
- **canonical** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **js** (1 cross-edges)
- **tests** (1 cross-edges)
- **js** (1 cross-edges)
- **js** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **js** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **js** (1 cross-edges)
- **js** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **js** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-204"
smart_context with task: "understand glyph-canvas", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
