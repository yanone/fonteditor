---
name: gortex-build
description: "Work in the build area — 66 symbols across 11 files (57% cohesion)"
---

# build

66 symbols | 11 files | 57% cohesion

## When to Use

Use this skill when working on files in:
- `generate-js-event-docs.mjs`
- `shrink-trace-to-timings.mjs`
- `webapp/js/babelfont-model.ts`
- `webapp/js/change-bridge.ts`
- `webapp/js/font-manager.ts`
- `webapp/js/glyph-canvas/outline-editor.ts`
- `webapp/scripts/generate-css-tokens.js`
- `webapp/scripts/tutorial/record-outline-tutorial.mjs`
- `webapp/tests/canonical/sidebearing-keys.test.js`
- `webapp/tests/change-bridge-cross-window.spec.ts`
- `webapp/tests/path-context-menu-fuzz.spec.ts`

## Key Files

| File | Symbols |
|------|---------|
| `generate-js-event-docs.mjs` | renderMarkdown, toEventAnchor, formatRelativePath, main, generateFallbackDescription, ... |
| `shrink-trace-to-timings.mjs` | buildCompileRenderHandoff, parseMarkerNameContext, collectNamedEvents, advanceCursor, extractLeft, ... |
| `webapp/js/babelfont-model.ts` | map, processPathSegments, getPathSegmentDescriptors, fingerprint, normalizeSignatureNodeType |
| `webapp/js/change-bridge.ts` | getLayerFingerprintFromJson, normalizeLayerSignatureNodeType, getPathLikeShape, getComponentReferenceFromShape |
| `webapp/js/font-manager.ts` | submitLayerUpdatesToWorkerCache, serializeLayerForStorage, extractPathShape, refreshWorkerCacheForReplayTargets, submitLayerToWorkerCache, ... |
| `webapp/js/glyph-canvas/outline-editor.ts` | splitPreviewSegment, buildStrokeAwareSelectionGeometry, mapRasterPointToGlyphSpace, thinMaskToSkeleton, sampleDescriptorPoints, ... |
| `webapp/scripts/generate-css-tokens.js` | formatVars |
| `webapp/scripts/tutorial/record-outline-tutorial.mjs` | readDuplicateOffcurvePairs, getTutorialGeometry |
| `webapp/tests/canonical/sidebearing-keys.test.js` | getSnapCandidateXs |
| `webapp/tests/change-bridge-cross-window.spec.ts` | installJsonCanonicalizer, serializeNodeForTest |
| `webapp/tests/path-context-menu-fuzz.spec.ts` | toGeometrySignature, captureOutlineFingerprint, toPathFingerprint |

## Entry Points

- `shrink-trace-to-timings.mjs::buildCompileRenderHandoff`
- `generate-js-event-docs.mjs::main`
- `webapp/tests/change-bridge-cross-window.spec.ts::installJsonCanonicalizer`

## Connected Communities

- **js** (22 cross-edges)
- **js** (16 cross-edges)
- **babelfont-fontc-build/src** (11 cross-edges)
- **js** (6 cross-edges)
- **glyph-canvas** (3 cross-edges)
- **glyph-canvas** (3 cross-edges)
- **tests** (3 cross-edges)
- **js** (3 cross-edges)
- **get** (2 cross-edges)
- **js** (2 cross-edges)
- **js** (2 cross-edges)
- **js** (2 cross-edges)
- **js** (2 cross-edges)
- **js** (2 cross-edges)
- **js** (2 cross-edges)
- **src** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **.** (1 cross-edges)
- **js** (1 cross-edges)
- **js** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **js** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **tests** (1 cross-edges)
- **js** (1 cross-edges)
- **tests** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-190"
smart_context with task: "understand build", format: "gcx"
find_usages with id: "shrink-trace-to-timings.mjs::buildCompileRenderHandoff", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
