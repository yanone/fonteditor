---
name: gortex-get
description: "Work in the get area — 59 symbols across 20 files (56% cohesion)"
---

# get

59 symbols | 20 files | 56% cohesion

## When to Use

Use this skill when working on files in:
- `babelfont-fontc-build/src/glyph_outlines.rs`
- `babelfont-fontc-build/src/lib.rs`
- `plugins/canvas/curvature/curvature_comb_plugin/plugin.py`
- `plugins/canvas/example/example_canvas_plugin/plugin.py`
- `shrink-trace-to-timings.mjs`
- `webapp/js/babelfont-model.ts`
- `webapp/js/design.ts`
- `webapp/js/font-info.ts`
- `webapp/js/fontc-worker.ts`
- `webapp/js/glyph-canvas.ts`
- `webapp/js/glyph-canvas/outline-editor.ts`
- `webapp/js/glyph-canvas/renderer.ts`
- `webapp/js/glyph-canvas/stack-preview-animator.ts`
- `webapp/js/glyph-canvas/textrun.ts`
- `webapp/js/glyph-canvas/viewport.ts`
- `webapp/js/glyph-overview.ts`
- `webapp/js/loading-cursor.ts`
- `webapp/scripts/tutorial/record-outline-tutorial.mjs`
- `webapp/tests/glyphcanvas.test.js`
- `webapp/tests/open-close-path.spec.ts`

## Key Files

| File | Symbols |
|------|---------|
| `babelfont-fontc-build/src/glyph_outlines.rs` | calculate_bounds |
| `babelfont-fontc-build/src/lib.rs` | feature_span_debug_context |
| `plugins/canvas/curvature/curvature_comb_plugin/plugin.py` | _cubic_bezier_point, _draw_curve_data, _remap_tooth_length_curvature, _get_curvature_color, draw_below |
| `plugins/canvas/example/example_canvas_plugin/plugin.py` | _calculate_bbox |
| `shrink-trace-to-timings.mjs` | percentile |
| `webapp/js/babelfont-model.ts` | min, max, calculateBoundingBox, insertShapeAt |
| `webapp/js/design.ts` | adjustColorHueAndLightness, hue2rgb |
| `webapp/js/font-info.ts` | renderFeatureErrorInEditor, utf8ByteOffsetToCodeUnitIndex, openFeatureCompilationError, resolveFeatureSpanTarget, findFeatureItemFromGlobalSpan |
| `webapp/js/fontc-worker.ts` | getJsonSnippetAtLineColumn |
| `webapp/js/glyph-canvas.ts` | frameCurrentGlyph, restoreActivePropertyInput, getCmdZeroViewportTarget |
| `webapp/js/glyph-canvas/outline-editor.ts` | getAngleBetweenVectors, rasterizeContourMask, getSidebearingHandleRadiusScreen, evaluateOpenPolylineAt, getMarqueeSelectionBox |
| `webapp/js/glyph-canvas/renderer.ts` | getTextRunHorizontalExtents |
| `webapp/js/glyph-canvas/stack-preview-animator.ts` | calculateTargetViewport, addShapeBounds, transformPoint, calculateStackBounds, startAnimation, ... |
| `webapp/js/glyph-canvas/textrun.ts` | _getGlyphPosition |
| `webapp/js/glyph-canvas/viewport.ts` | frameGlyph, zoomToFitText, animateZoomAndPan, handleWheel, pan, ... |
| `webapp/js/glyph-overview.ts` | renderVirtualizedLinesWindow, onContainerScroll, setCenteredScrollTop, scrollToGlyphId, centerGlyphIdsInView, ... |
| `webapp/js/loading-cursor.ts` | getSpinnerPosition |
| `webapp/scripts/tutorial/record-outline-tutorial.mjs` | getTutorialGeometry, frameGlyphBounds |
| `webapp/tests/glyphcanvas.test.js` | getLayerBoundingBoxCenterScreen |
| `webapp/tests/open-close-path.spec.ts` | hasRenderedTextGlyphAtIndex |

## Entry Points

- `webapp/js/glyph-canvas/viewport.ts::ViewportManager.handleWheel`

## Connected Communities

- **js** (13 cross-edges)
- **get** (11 cross-edges)
- **js** (6 cross-edges)
- **js** (5 cross-edges)
- **tests** (3 cross-edges)
- **curvature_comb_plugin** (3 cross-edges)
- **js** (3 cross-edges)
- **js** (3 cross-edges)
- **glyph-canvas** (3 cross-edges)
- **glyph-canvas** (2 cross-edges)
- **glyph-canvas** (2 cross-edges)
- **tests** (2 cross-edges)
- **js** (2 cross-edges)
- **base_canvas_plugin** (2 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **js** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **js** (1 cross-edges)
- **curvature_comb_plugin** (1 cross-edges)
- **js** (1 cross-edges)
- **js** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **js** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **js** (1 cross-edges)
- **js** (1 cross-edges)
- **js** (1 cross-edges)
- **js** (1 cross-edges)
- **js** (1 cross-edges)
- **js** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **js** (1 cross-edges)
- **js** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-495"
smart_context with task: "understand get", format: "gcx"
find_usages with id: "webapp/js/glyph-canvas/viewport.ts::ViewportManager.handleWheel", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
