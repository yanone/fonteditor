---
name: gortex-src
description: "Work in the src area — 31 symbols across 3 files (87% cohesion)"
---

# src

31 symbols | 3 files | 87% cohesion

## When to Use

Use this skill when working on files in:
- `babelfont-fontc-build/src/glyph_outlines.rs`
- `babelfont-fontc-build/src/lib.rs`
- `webapp/js/pyodide-official-console.ts`

## Key Files

| File | Symbols |
|------|---------|
| `babelfont-fontc-build/src/glyph_outlines.rs` | get_glyphs_outlines, clear_outline_cache_for_glyph, clear_outline_cache |
| `babelfont-fontc-build/src/lib.rs` | compile_cached_font_from_last_layout_closure, perf_mark, start, canonical_subset_key_from_sorted_unique, drop, ... |
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
- **src** (7 cross-edges)
- **js** (6 cross-edges)
- **get** (2 cross-edges)
- **src** (2 cross-edges)
- **js** (2 cross-edges)
- **src** (1 cross-edges)
- **glyph-canvas** (1 cross-edges)
- **js** (1 cross-edges)
- **src** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-66"
smart_context with task: "understand src", format: "gcx"
find_usages with id: "babelfont-fontc-build/src/lib.rs::compile_cached_font_from_last_layout_closure", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
