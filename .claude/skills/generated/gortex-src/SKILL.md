---
name: gortex-src
description: "Work in the src area — 35 symbols across 4 files (88% cohesion)"
---

# src

35 symbols | 4 files | 88% cohesion

## When to Use

Use this skill when working on files in:
- `babelfont-fontc-build/src/glyph_outlines.rs`
- `babelfont-fontc-build/src/lib.rs`
- `webapp/js/glyph-canvas/outline-editor.ts`
- `webapp/js/pyodide-official-console.ts`

## Key Files

| File | Symbols |
|------|---------|
| `babelfont-fontc-build/src/glyph_outlines.rs` | clear_outline_cache, clear_outline_cache_for_glyph, get_glyphs_outlines |
| `babelfont-fontc-build/src/lib.rs` | compile_cached_font_from_last_layout_closure, canonical_subset_key_from_sorted_unique, start, drop, PerfSpan, ... |
| `webapp/js/glyph-canvas/outline-editor.ts` | get |
| `webapp/js/pyodide-official-console.ts` | lock |

## Entry Points

- `babelfont-fontc-build/src/lib.rs::compile_cached_font_from_last_layout_closure`
- `babelfont-fontc-build/src/lib.rs::update_cached_layer`
- `babelfont-fontc-build/src/glyph_outlines.rs::get_glyphs_outlines`
- `babelfont-fontc-build/src/lib.rs::open_font_file`
- `babelfont-fontc-build/src/lib.rs::compile_cached_font`

## Connected Communities

- **get** (17 cross-edges)
- **src** (11 cross-edges)
- **js** (9 cross-edges)
- **js** (6 cross-edges)
- **js** (2 cross-edges)
- **get** (2 cross-edges)
- **src** (2 cross-edges)
- **src** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **js** (1 cross-edges)
- **src** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-170"
smart_context with task: "understand src", format: "gcx"
find_usages with id: "babelfont-fontc-build/src/lib.rs::compile_cached_font_from_last_layout_closure", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
