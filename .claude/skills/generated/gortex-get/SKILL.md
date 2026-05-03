---
name: gortex-get
description: "Work in the get area — 37 symbols across 12 files (27% cohesion)"
---

# get

37 symbols | 12 files | 27% cohesion

## When to Use

Use this skill when working on files in:
- `babelfont-fontc-build/src/lib.rs`
- `webapp/js/babelfont-model.ts`
- `webapp/js/change-bridge.ts`
- `webapp/js/font-info.ts`
- `webapp/js/font-manager.ts`
- `webapp/js/glyph-canvas/outline-editor.ts`
- `webapp/js/glyph-overview-filters.ts`
- `webapp/scripts/generate-css-tokens.js`
- `webapp/scripts/tutorial/record-outline-tutorial.mjs`
- `webapp/tests/canonical/sidebearing-keys.test.js`
- `webapp/tests/change-bridge-cross-window.spec.ts`
- `webapp/tests/path-context-menu-fuzz.spec.ts`

## Key Files

| File | Symbols |
|------|---------|
| `babelfont-fontc-build/src/lib.rs` | apply_filter_pipeline |
| `webapp/js/babelfont-model.ts` | map, getPathSegmentDescriptors, processPathSegments, fingerprint, normalizeSignatureNodeType, ... |
| `webapp/js/change-bridge.ts` | getLayerFingerprintFromJson, getPathLikeShape, getComponentReferenceFromShape, normalizeLayerSignatureNodeType |
| `webapp/js/font-info.ts` | parseClassGlyphMembers |
| `webapp/js/font-manager.ts` | normalizeLayerForRust, serializeLayerForStorage, submitLayerUpdatesToWorkerCache, refreshWorkerCacheForReplayTargets, extractComponentShape, ... |
| `webapp/js/glyph-canvas/outline-editor.ts` | buildStrokeAwareSelectionGeometry, smoothOpenPolyline, splitPreviewSegment, mapRasterPointToGlyphSpace, sampleDescriptorPoints, ... |
| `webapp/js/glyph-overview-filters.ts` | normalizeAutoUpdateEvents |
| `webapp/scripts/generate-css-tokens.js` | formatVars |
| `webapp/scripts/tutorial/record-outline-tutorial.mjs` | readDuplicateOffcurvePairs |
| `webapp/tests/canonical/sidebearing-keys.test.js` | getSnapCandidateXs |
| `webapp/tests/change-bridge-cross-window.spec.ts` | installJsonCanonicalizer, extractGlyphLayerData, serializeNodeForTest |
| `webapp/tests/path-context-menu-fuzz.spec.ts` | captureOutlineFingerprint, toPathFingerprint, toGeometrySignature |

## Entry Points

- `webapp/tests/change-bridge-cross-window.spec.ts::installJsonCanonicalizer`

## Connected Communities

- **src** (4 cross-edges)
- **get** (4 cross-edges)
- **glyph-canvas** (4 cross-edges)
- **js** (3 cross-edges)
- **glyph-canvas** (3 cross-edges)
- **glyph-canvas** (3 cross-edges)
- **tests** (3 cross-edges)
- **js** (2 cross-edges)
- **js** (2 cross-edges)
- **js** (2 cross-edges)
- **js** (2 cross-edges)
- **js** (2 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **js** (1 cross-edges)
- **js** (1 cross-edges)
- **js** (1 cross-edges)
- **js** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **js** (1 cross-edges)
- **js** (1 cross-edges)
- **resolve** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-186"
smart_context with task: "understand get", format: "gcx"
find_usages with id: "webapp/tests/change-bridge-cross-window.spec.ts::installJsonCanonicalizer", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
