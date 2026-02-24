# Incremental Font Compilation — Optimization Strategy

_February 2026_

## Current State

Counterpunch compiles fonts in the browser using a WASM-compiled pipeline:

```
JS edit → layer data → WASM (Rust) patch → fontc IR compile → TTF binary → HarfBuzz shaping → render
```

After Phase 1 optimizations (incremental layer patching, eliminating redundant JSON transfer, double-patch elimination, per-glyph cache invalidation), the breakdown for a typical editing compile is:

| Stage                                           | Time       |
| ----------------------------------------------- | ---------- |
| JS → WASM layer patch + subset preparation      | ~5 ms      |
| `BabelfontIrSource::compile()` (fontc pipeline) | ~50 ms     |
| **Total**                                       | **~55 ms** |

The 50 ms `ir_compile` is now the bottleneck. This document analyzes where that time is spent and proposes a phased optimization strategy.

---

## What Happens Inside the 50 ms

`BabelfontIrSource::compile(font, options)` in babelfont-rs does the following every invocation:

### 1. Pre-processing (~minor)

```
font.clone()                          // full deep clone of the subset Font
DropIncompatiblePaths.apply(&mut font) // remove incompatible paths across masters
RewriteSmartAxes.apply(&mut font)     // rewrite smart component axes (if VARC enabled)
RetainGlyphs.apply(&mut font)         // re-subset to exported glyphs (redundant — already subset)
GlyphsNumberValue.apply(&mut font)    // Glyphs.app compatibility filters
GlyphsData.apply(&mut font)
GlyphsStylisticSetLabel.apply(&mut font)
GlyphsBracketLayers.apply(&mut font)
```

### 2. fontc::generate_font() (~bulk of cost)

Creates fresh FE + BE contexts and a full `Workload` with **30+ job types** organized in a dependency graph:

**Frontend (IR generation)**:

- `StaticMetadata` — axes, glyph order, names, instances
- `GlobalMetrics` — cap height, x-height, ascender, descender per master
- `GlyphIrWork` × N — per-glyph: iterate layers, convert paths to BezPath, build ir::Glyph
- `Features` — parse FEA source
- `KerningGroups` + `KernInstances` — kern groups + per-master kerning values
- `GlyphOrder` — final glyph ordering

**Backend (binary table generation)**:

- `GlyfFragment` × N — per-glyph binary glyf data
- `GvarFragment` × N — per-glyph variation deltas
- `MarkWork` — mark/mkmk/cursive attachment from anchors (feeds into GPOS)
- `FeatureFirstPassWork` — FEA AST parsing
- `FeatureCompilationWork` — fea-rs compilation → produces **GSUB + GPOS + GDEF**
- `KernFragments` → `GatherBeKerning` — kern pair segments
- Table assembly: glyf+loca, gvar, avar, cmap, fvar, head, hhea/hmtx, hvar, name, os/2, post, STAT, maxp, etc.
- `FontWork` — final binary assembly merging all tables

### Critical path

```
StaticMetadata ──→ GlyphOrder ──→ GlyfFragments (×N) ──→ Glyf/Loca assembly ──→ Font assembly
                        ↗
   GlyphIR (×N, parallel) ──→ GvarFragments (×N) ──→ Gvar assembly ──↗
                                                                       ↗
KerningGroups → KernInstances → GatherIrKerning → KernFragments ──→ Features (fea-rs) ──↗
                                                                       ↗
                                              MarkWork (anchors → GPOS lookups) ──↗
```

### Key constraint

**fontc has zero incremental compilation support.** Every `generate_font()` call creates fresh contexts and runs the entire pipeline from scratch. There is no concept of "this glyph didn't change, skip it."

---

## Optimization Opportunities

### A. Skip kerning + features during drag — Quick Win

**Impact**: ~30–50% of compile time  
**Effort**: JS-side option change only  
**Risk**: Low

During mouse-drag and keyboard editing, kerning data and FEA features never change. The feature pipeline (FEA parsing + fea-rs compilation of GSUB/GPOS/GDEF) and kerning pipeline (kern groups → per-master instances → segments) are the most expensive non-glyph work.

**Implementation**: Pass `skip_kerning: true` and `skip_features: true` in the `compileEditingCached` options when `compileSource` is `mouse-drag` or `keyboard`. Restore full compilation when drag ends.

#### Important: `skip_features` skips GPOS entirely

Research into fontc's workload reveals that `skip_features` is **all-or-nothing**. It skips:

| Work Item                           | What it does                                                    |
| ----------------------------------- | --------------------------------------------------------------- |
| `FeatureFirstPassWork`              | FEA AST parsing                                                 |
| `FeatureCompilationWork`            | Compiles **GSUB + GPOS + GDEF** via fea-rs                      |
| `MarkWork`                          | Mark-to-base, mark-to-mark, cursive attachment (GPOS types 3-6) |
| `GatherIrKerning` + `KernFragments` | Kern pair compilation                                           |

There is **no built-in way to skip GSUB but keep GPOS**. The mark attachment pipeline (`MarkWork`) is explicitly included in the skippable set, and its output (`FeaRsMarks`) feeds into `FeatureCompilationWork` which produces the unified GPOS table.

**Consequence for anchor editing**: If a user edits anchors (mark positions), skipping features means the compiled font will have **no GPOS table** — marks won't attach. This is acceptable during **outline dragging** (anchor positions don't change), but not during anchor editing.

**Recommendation**: Skip features only for `mouse-drag` and `keyboard` edits to path outlines. When the editing operation involves anchors, keep features enabled. The `compileSource` or `lastChangeSource` in the JS pipeline can distinguish these cases.

#### Future: selective GSUB-only skip

This would require changes to fontc itself — adding a `skip_gsub_only` option that:

- Still runs `MarkWork` (anchor → GPOS lookups)
- Still runs `FeatureCompilationWork` but only for GPOS
- Skips `FeatureFirstPassWork` (which is GSUB-focused)

This is architecturally non-trivial because fea-rs compiles GSUB and GPOS together in a single pass.

### B. Skip VARC during drag — Quick Win

**Impact**: Saves RewriteSmartAxes filter + insert_varc_table() post-processing  
**Effort**: JS-side option change  
**Risk**: None for fonts without smart components; acceptable for fonts with them during drag

Currently `produce_varc_table: true` in the editing target. Smart component structure doesn't change during outline editing. Set to `false` during drag.

### C. Cache the pre-processed font — Medium

**Impact**: Eliminates font.clone() + 5 filter passes per compile  
**Effort**: Rust changes in babelfont-rs  
**Risk**: Low

The clone + filter pipeline in `compile()` produces identical results when only a glyph outline changes. Cache the filtered font in a `static`, keyed by an epoch counter. Only re-run filters when non-outline data changes (new glyph added, features changed, etc.).

**Implementation sketch** (in babelfont-rs):

```rust
static FILTERED_FONT_CACHE: Mutex<Option<(u64, Arc<Font>)>> = Mutex::new(None);

pub fn compile_incremental(
    font: Font,
    options: CompilationOptions,
    cache_epoch: u64,
) -> Result<Vec<u8>, BabelfontError> {
    let filtered = {
        let cache = FILTERED_FONT_CACHE.lock().unwrap();
        if let Some((epoch, cached)) = cache.as_ref() {
            if *epoch == cache_epoch {
                Some(cached.clone())
            } else { None }
        } else { None }
    };

    let font = if let Some(cached) = filtered {
        // Patch only the dirty glyph into the cached filtered font
        (*cached).clone()  // or surgical patch
    } else {
        // Full filter pipeline, then cache
        let mut font = font.clone();
        apply_all_filters(&mut font, &options)?;
        let arc = Arc::new(font.clone());
        *FILTERED_FONT_CACHE.lock().unwrap() = Some((cache_epoch, arc));
        font
    };

    // Compile...
}
```

### D. Incremental IR Source — Medium-Hard

**Impact**: Skip per-glyph IR generation for unchanged glyphs  
**Effort**: Significant babelfont-rs changes  
**Risk**: Medium (correctness of cache invalidation)

The `Source` trait's `create_glyph_ir_work()` returns one work item per glyph. Each runs `GlyphIrWork::exec()` which reads all layers, converts paths to BezPath, and builds `ir::Glyph`. For unchanged glyphs, this is pure waste.

**Approach**: Create an `IncrementalBabelfontIrSource` that:

- Caches `ir::Glyph` results from previous compiles
- Returns `CachedGlyphIrWork` for unchanged glyphs (just calls `context.glyphs.set(cached)`)
- Returns real `GlyphIrWork` only for the dirty glyph(s)

The challenge is that `ir::Glyph` may not implement `Clone` easily, and the `FeContext` expects specific access patterns. The `ContextMap::set()` method does short-circuit if the value hasn't changed, but the work item still runs.

### E. Cache FE/BE contexts across compiles — Hard

**Impact**: Highest potential (skip almost everything for single-glyph edits)  
**Effort**: Requires fontc fork/modification  
**Risk**: High (complex interaction with dependency graph, ACL system)

Pre-populate `FeContext` with cached StaticMetadata, GlobalMetrics, Features, KerningGroups, and all unchanged glyph IR. Modify `Workload::new()` to skip creating jobs for pre-populated data.

This requires:

1. Forking `fontc::generate_font()` to accept pre-populated contexts
2. Modifying `Workload` to recognize pre-existing work results
3. Handling the `AccessControlList` which blocks writes after root context creation
4. Properly managing the dependency counter system

### F. Binary table patching — Hardest

**Impact**: Skip fontc entirely for single-glyph outline edits  
**Effort**: Major new subsystem  
**Risk**: High (correctness, edge cases in binary format)

For single-glyph edits, patch the existing compiled TTF binary directly:

- Replace the dirty glyph's glyf table entry
- Recompute loca offsets
- Patch gvar deltas for the dirty glyph
- Recalculate head checksum

This bypasses fontc entirely but reimplements parts of fontbe's binary generation. Libraries like `write-fonts` (already a dependency) could help, but the variable font delta patching is complex.

---

## Implementation Roadmap

| Phase      | Optimization                         | Expected Gain          | Effort               |
| ---------- | ------------------------------------ | ---------------------- | -------------------- |
| **Now**    | A: Skip kerning/features during drag | ~15–25 ms              | JS-only              |
| **Now**    | B: Skip VARC during drag             | ~2–5 ms                | JS-only              |
| **Soon**   | C: Cache filtered font               | ~3–8 ms                | Rust (babelfont-rs)  |
| **Later**  | D: Incremental IR source             | ~10–20 ms              | Rust (babelfont-rs)  |
| **Future** | E: Context caching                   | ~30–40 ms              | Rust (fontc fork)    |
| **Future** | F: Binary patching                   | ~45–50 ms (skip fontc) | Rust (new subsystem) |

Phases A+B alone could bring the 50 ms down to ~25–30 ms with minimal risk. Combined with Phase 1 optimizations (5 ms WASM overhead), total compile time during drag would be ~30–35 ms (~30 fps).

---

## Architecture Reference

### Caches in WASM (lib.rs)

| Cache                              | Purpose                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| `FONT_CACHE`                       | Full deserialized babelfont::Font — patched incrementally via `update_cached_layer()` |
| `PREPARED_SUBSET_FONT_CACHE`       | Pre-subset font ready for compilation — patched in-place during drag                  |
| `LAYOUT_CLOSURE_CACHE`             | Glyph subset → closed layout set (GSUB closure)                                       |
| `FONT_CACHE_EPOCH`                 | Freshness counter for cache invalidation                                              |
| `PREPARED_SUBSET_PATCHED_IN_PLACE` | Flag to skip redundant patching in compile step                                       |

### Data flow during incremental editing compile

```
1. JS: outline-editor mutates layer data in memory
2. JS: fontManager.saveLayerData() updates babelfontData, marks dirty, skips full JSON sync
3. JS: autoCompileManager triggers compileEditingFont()
4. JS: extracts dirty glyph/layer, normalizes for Rust
5. JS→Worker: postMessage with sentinel (no full JSON), dirty layer data, options
6. Worker→WASM: update_cached_layer(glyph, layer, json) — patches FONT_CACHE + PREPARED_SUBSET in-place
7. WASM: compile_cached_font_from_last_layout_closure() — uses patched subset, skips double-patch
8. WASM: BabelfontIrSource::compile(subset_font, options) — the 50ms target
9. Worker→JS: compiled TTF bytes (transferred, zero-copy)
10. JS: setFont() + shapeText() + render()
```

### fontc Source trait (babelfont-rs implements this)

```
create_static_metadata_work()     → 1 job: axes, glyph order, names
create_global_metric_work()       → 1 job: metrics per master
create_glyph_ir_work()            → N jobs: per-glyph path conversion
create_feature_ir_work()          → 1 job: FEA source text
create_kerning_group_ir_work()    → 1 job: kern groups
create_kerning_instance_ir_work() → 1 per master location
create_color_palette_work()       → 1 job: CPAL
create_color_glyphs_work()        → 1 job: COLR
```

### fontc compilation flags

| babelfont Option     | fontc Effect                                                  |
| -------------------- | ------------------------------------------------------------- |
| `skip_kerning`       | Source returns DummyWork for kerning (empty groups/instances) |
| `skip_features`      | Source returns DummyWork for features (empty FEA)             |
| `skip_metrics`       | Source returns DummyWork for metrics (defaults)               |
| `skip_outlines`      | Source skips outline generation                               |
| `produce_varc_table` | Enables RewriteSmartAxes + VARC post-processing               |

Note: The babelfont-level `skip_features` only empties the FEA content. To actually skip the feature _compilation work_ (GSUB+GPOS+GDEF+kerns+marks), fontc's `Options.skip_features` must also be true. Currently the WASM build always passes `Options::default()` to fontc (which has `skip_features: false`), so the fea-rs compiler still runs even with empty FEA — it just produces empty tables. **Passing fontc-level `skip_features` would eliminate the fea-rs work entirely.**
