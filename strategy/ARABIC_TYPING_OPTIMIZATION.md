# Fast Arabic Typing — Layout Closure & Compilation Optimization Strategy

_February 2026_

## Problem

Typing in the editor triggers layout closure → glyphset → font compilation via WASM. For Arabic fonts with contextual alternates, features and kerning **must** stay enabled during typing — otherwise letters visually disconnect, producing a broken editing experience. Currently `skip_features=true` and `skip_kerning=true` for text-input mode, which must change.

With features on, the pipeline is slow and grows super-linearly with input length:

1. `close_layout()` re-parses FEA + runs multi-round closure — **slow**
2. `expand_closure_with_component_deps()` — minor
3. `RetainGlyphs` → `SubsetLayout` re-parses FEA — **moderate**
4. `apply_filters()` → `RetainGlyphs` again + `GlyphsNumberValue` parses FEA again — **moderate**
5. `fontc::generate_font()` re-parses FEA again, compiles GSUB/GPOS/GDEF, all glyph IR — **~50ms**

Features are parsed **5 times** on a cold cache. fontc has zero incremental compilation support.

---

## Constraints

- **Features and kerning must stay ON** during typing (Arabic connected script)
- **Fonts can have up to 80 masters** — compiling the full font is not viable (gvar table compilation is the reason we subset in the first place)
- **GSUB/GPOS/GDEF tables change with each subset** — they are pruned by `SubsetLayout` to only reference retained glyphs, and GIDs shift when glyph order changes. Cached compiled tables from subset A are invalid for subset B.
- **fontc has zero incremental compilation** — every `generate_font()` call creates fresh contexts and runs the entire pipeline from scratch
- **fea_rs_ast is external** (v0.1.2) — can cache its output but cannot modify its internals
- **fontc is external** (v0.6.0 from git) — no incremental API

---

## What's Invariant During Typing

During typing, **only the glyph subset changes**. These do not change:

| Invariant                      | Implication                         |
| ------------------------------ | ----------------------------------- |
| Feature FEA source code        | Parsed AST can be cached and reused |
| Kerning groups and values      | Kerning IR can be cached            |
| Glyph outlines/anchors/metrics | Glyph IR can be cached per glyph    |
| Axes, names, metadata          | Static metadata IR is stable        |

**What DOES change per keystroke (when a new unique glyph appears):**

| Changes             | Implication                                               |
| ------------------- | --------------------------------------------------------- |
| Glyph subset        | Layout closure must (re-)run                              |
| Glyph order / GIDs  | GSUB/GPOS/GDEF reference GIDs — tables must be recompiled |
| Pruned feature code | `SubsetLayout` removes rules for absent glyphs            |
| Subset font struct  | `RetainGlyphs` produces a different `Font`                |

**Key insight:** The parsed FEA AST doesn't change, but the _subset-filtered_ version of it does change with each new subset. However, the parse-from-string step (which is expensive) can be done once, and only the visitor/pruning pass needs to re-run per subset.

---

## Current Pipeline Architecture

```
User types → onTextChange() [glyph-canvas.ts]
  ↓ (150ms debounce)
  deriveSubsetGlyphsFromText() [font-manager.ts:1334]
  ↓
  compileEditingFont() [font-manager.ts:1037]
    sets compilationMode = 'text-input'
    currently: skip_features=true, skip_kerning=true  ← must change for Arabic
    ↓
    Web Worker [fontc-worker.ts]
      prime_layout_closure_cache()   — if subset key changed
      compile_cached_font_from_last_layout_closure()
      ↓ returns compiled TTF bytes
  ↓
  scheduleTextInputFullCompile()     — 500ms deferred full compile
```

### Existing Caches (WASM layer)

| Cache                        | Key                                    | Purpose                                                     |
| ---------------------------- | -------------------------------------- | ----------------------------------------------------------- |
| `FONT_CACHE`                 | —                                      | Full deserialized Font; patched via `update_cached_layer()` |
| `LAYOUT_CLOSURE_CACHE`       | exact glyph set string                 | Glyph subset → closed layout set                            |
| `PREPARED_SUBSET_FONT_CACHE` | (subset_key, epoch)                    | Pre-subset font after RetainGlyphs                          |
| `FILTERED_FONT_CACHE`        | (subset_key, filter_epoch, options_fp) | Font after full filter pipeline                             |
| `FONT_CACHE_EPOCH`           | atomic counter                         | Bumped by store_font() AND update_cached_layer()            |
| `FILTER_EPOCH`               | atomic counter                         | Bumped by store_font() only, NOT outline edits              |

### Where Time Is Spent (per compile, with features on, cold cache)

| Stage                                      | Time           | Notes                                  |
| ------------------------------------------ | -------------- | -------------------------------------- |
| Layout closure (`close_layout()`)          | ~5-30ms        | Grows super-linearly with Arabic input |
| FEA parse #1 (inside closure)              | included above | `to_fea()` + `new_from_fea()`          |
| Component deps expansion                   | ~1ms           | Linear search per glyph                |
| RetainGlyphs + SubsetLayout (FEA parse #2) | ~5-10ms        | Full re-parse + visitor                |
| apply_filters (FEA parse #3, #4)           | ~5-10ms        | RetainGlyphs again + GlyphsNumberValue |
| fontc::generate_font() (FEA parse #5)      | ~30-50ms       | Full pipeline: IR + binary tables      |
| **Total**                                  | **~50-100ms+** | Grows with input length                |

---

## PHASE A — Upstream Improvements (babelfont-rs)

General-purpose algorithmic improvements that benefit all babelfont-rs consumers. Suitable for upstreaming as PRs.

### A1. Cache Parsed FeatureFile AST

**Impact: High | Risk: Low**

**Problem:** `close_layout()`, `SubsetLayout::apply()`, `GlyphsNumberValue::apply()`, and `RenameGlyphs::apply()` all call `font.features.to_fea()` (serialize to string) then `FeatureFile::new_from_fea()` (parse back to AST). This round-trips string formatting + parsing even though the feature source code hasn't changed.

```
to_fea()          — serialize Features struct → FEA string       (allocates string)
new_from_fea()    — parse FEA string → FeatureFile AST           (expensive parse)
```

This happens 4-5 times per compile pipeline. The FEA source doesn't change between calls.

**Change:**

- Add a lazy-cached `FeatureFile` on the `Features` struct (or parallel cache)
- Invalidate when `features.classes`, `features.prefixes`, or `features.features` are mutated
- All consumers clone the cached AST instead of re-parsing from string
- Cloning the AST is substantially cheaper than string formatting + full parsing

**Files:**

- `babelfont/src/features.rs` — add cache field + invalidation
- `babelfont/src/layout/closure.rs` — use cached AST (lines 13-17)
- `babelfont/src/filters/subsetlayout.rs` — use cached AST (line 37)
- `babelfont/src/filters/glyphsnumbervalue.rs` — use cached AST (line 32)

**Why upstream:** Every babelfont-rs consumer benefits from not re-parsing features repeatedly.

### A2. Pre-expand Glyph Classes as HashSets in Layout Closure

**Impact: High | Risk: Low | Parallel with A1**

**Problem:** `expand_glyph_container()` allocates a new `Vec<SmolStr>` per `contains()` call, then linear-scans the result. For Arabic glyph classes with 100+ members, across hundreds of rules, across up to 10 rounds = millions of allocations + scans.

```rust
// Current: O(class_size) allocation + linear scan per call
fn contains(&self, gc: &GlyphContainer) -> bool {
    self.expand_glyph_container(gc)        // allocates Vec<SmolStr> every time
        .iter()
        .any(|g| self.glyphs.contains(g))  // linear scan
}

fn is_excluded_by_context(&self, prefix: &[GlyphContainer], suffix: &[GlyphContainer]) -> bool {
    prefix.iter().any(|gc| !self.contains(gc))  // expands + scans per prefix element
    || suffix.iter().any(|gc| !self.contains(gc))  // same for suffix
}
```

For a contextual rule with 2 prefix classes of 100 members each: 200 Vec allocations + 200 linear scans, **per rule, per round**.

**Change:**

- Change `original_class_definitions` from `HashMap<SmolStr, Vec<SmolStr>>` to `HashMap<SmolStr, HashSet<SmolStr>>`
- Pre-expand all class definitions during the initial `close_glyph_class_definition()` pass
- Replace `contains()` with a set intersection: iterate the smaller of (class set, glyph set) and check membership in the other — O(min(|class|, |glyphs|)) with no allocation
- Replace `is_excluded_by_context()` similarly

**Files:**

- `babelfont/src/layout/closure.rs` — `LayoutClosureVisitor` struct (line 43), `expand_glyph_container()` (line 55), `contains()` (line 98), `is_excluded_by_context()` (line 104), `close_glyph_class_definition()` (line 203)

**Why upstream:** Algorithmic improvement that helps any font with glyph classes, not just Arabic.

### A3. Resolve Contextual Lookup References In-Pass

**Impact: Medium | Risk: High (complexity) | Depends on: A1, A2**

**Problem:** The multi-round fixed-point loop in `close_layout()` runs up to 10 iterations, each re-traversing the **entire** AST. It exists because contextual substitution rules (`sub a' lookup X`) reference named lookups that may not have been visited yet in the current pass.

```rust
// Current: multi-round loop
let mut rounds = 0;
loop {
    visitor.visit(&mut feature_file)?;  // full AST traversal
    rounds += 1;
    if visitor.glyphs.len() == count { break; }  // fixed point?
    if rounds > 10 { return Err(LayoutClosureError); }
    count = visitor.glyphs.len();
}
```

**Change:**

- During AST traversal, when encountering a contextual rule referencing `lookup X`, eagerly look up the named lookup block in the FeatureFile and process its substitutions immediately
- This collapses the loop from up to 10 iterations to 1-2 passes
- Requires that fea_rs_ast exposes lookup blocks by name (to investigate)

**Files:**

- `babelfont/src/layout/closure.rs` — multi-round loop (lines 26-39), comment explaining the issue (lines 19-23)

**Why upstream:** Reduces closure from O(rounds × statements) to O(statements). Benefits any font with complex contextual substitutions.

### A4. Eliminate Redundant Feature Parsing Across Filters

**Impact: Medium | Risk: Medium | Depends on: A1**

**Problem:** `apply_filters()` runs `RetainGlyphs` → `SubsetLayout` (parse → visit → serialize) → then `GlyphsNumberValue` (parse → visit → serialize). Each independently does a full parse + serialize round-trip on the same feature code.

**Change:**

- Thread a shared `FeatureFile` through the filter pipeline
- Run `SubsetVisitor` and `GlyphsNumberValueVisitor` sequentially on the same AST
- Serialize back to `Features::from_fea()` only once at the end

**Files:**

- `babelfont/src/convertors/fontir/mod.rs` — `apply_filters()` (line 153)
- `babelfont/src/filters/subsetlayout.rs` — accept `&mut FeatureFile` parameter
- `babelfont/src/filters/glyphsnumbervalue.rs` — accept `&mut FeatureFile` parameter

**Why upstream:** Eliminates redundant work in the standard compilation pipeline.

### A5. Index-Based Glyph Lookup in Component Dependencies

**Impact: Low | Risk: Low | Parallel with all**

**Problem:** `expand_closure_with_component_deps()` uses `font.glyphs.iter().find(|g| g.name == ...)` for each glyph in the closure queue — O(total_glyphs) per lookup.

**Change:** Build `HashMap<&str, usize>` index at function entry, use O(1) lookups.

**Files:**

- `editor/babelfont-fontc-build/src/lib.rs` — `expand_closure_with_component_deps()` (line 310)

---

## PHASE B — In-House Editor Optimizations (Counterpunch-specific)

Editor-specific caching and architectural changes that don't need upstreaming.

### B1. Turn Features and Kerning On for Text-Input Mode

**Impact: Required | Risk: Low (JS-only)**

Remove `skip_features: true` and `skip_kerning: true` overrides for `compilationMode === 'text-input'`. Without this, Arabic letters disconnect when typing.

**Files:**

- `editor/webapp/js/font-manager.ts` — lines ~1229-1243, text-input `optionOverrides`

### B2. Cache Parsed FeatureFile AST at WASM Layer

**Impact: High | Risk: Low**

Distinct from A1 (which caches on the `Features` struct inside babelfont-rs). This is a WASM-layer cache since during typing, even when the closure subset changes and `RetainGlyphs` is re-applied, the _input_ FEA source hasn't changed — only the subset-pruned version changes.

**Approach:**

- Store a `FEATURE_FILE_CACHE: Mutex<Option<FeatureFile>>` alongside `FONT_CACHE`
- Populate when `store_font()` is called (parse once)
- Invalidate on `store_font()` (font reload) or feature-code edit
- Pass the cached AST (cloned) to `close_layout()`, `SubsetLayout`, etc. instead of letting each function re-parse from scratch

This ensures the expensive parse happens **once** per font load, not per keystroke.

**Files:**

- `editor/babelfont-fontc-build/src/lib.rs` — new static cache, modified `store_font()`, pass cached AST into babelfont functions

**Why in-house:** The WASM-layer static cache management is editor-specific. The underlying A1 change to babelfont-rs makes the functions _accept_ a pre-parsed AST; B2 is the caching wrapper.

### B3. Incremental Layout Closure

**Impact: High | Risk: Medium**

**Problem:** `LAYOUT_CLOSURE_CACHE` is keyed by exact glyph set. Each new character typed may add a new unique glyph → cache miss → full closure recomputation from scratch. The closure computation itself gets slower as the input set grows (more rules fire, more rounds needed).

**Approach:**

- Store both input glyph set and closure result in each cache entry
- When a new glyph set arrives that is a **superset** of a previous input set:
    - Start with the previous closure result as the seed
    - Only process rules that could be triggered by the NEW glyphs (the delta)
    - The closure is monotonic — adding glyphs can only grow the set, never shrink it
- When a glyph is **removed** (backspace): fall back to full recomputation, or check if any cached entry's input is still a subset of the new input

**Implementation:**

- Modify `close_layout()` to accept optional `seed_closure: Option<HashSet<SmolStr>>` — this part is upstreamable
- The incremental cache management logic stays in-house
- Keep the most recent `(input_set, closure_set)` entry as the primary cache

**Files:**

- `babelfont/src/layout/closure.rs` — `close_layout()` signature (add seed parameter)
- `editor/babelfont-fontc-build/src/lib.rs` — `compute_layout_closure_cached_internal()`, cache structure

### B4. Pre-Warm Closure Cache on Font Load

**Impact: Low | Risk: Low**

Pre-compute layout closure for common Arabic Unicode ranges (U+0600–U+06FF, Arabic Supplement, Arabic Extended) when a font is first loaded. The first keystroke gets a warm cache.

**Files:**

- `editor/webapp/js/fontc-worker.ts` or `font-manager.ts` — trigger on font load

### B5. Cache fontc IR Work Results (Future)

**Impact: Medium-High | Risk: High (complexity)**

`fontc::generate_font()` regenerates IR for ALL glyphs on every compile — per-glyph path conversion, static metadata, features IR, kerning groups. During typing, none of the per-glyph data changes; only which glyphs are included changes.

**Approach (future):** Fork fontc or contribute incremental API:

- Cache `ir::Glyph` results across compiles; return `CachedGlyphIrWork` for unchanged glyphs
- Pre-populate `FeContext` with cached StaticMetadata, Features, KerningGroups
- Only regenerate IR for glyphs newly added to the subset

This is architecturally complex and requires fontc upstream changes. Defer until A1-A4 + B1-B3 are implemented and measured.

---

## Why We Cannot Cache Compiled GSUB/GPOS/GDEF Tables

An earlier version of this plan proposed caching compiled layout tables and splicing them into featureless compiles. This is **not viable** because:

1. **GSUB/GPOS/GDEF change with each subset.** `SubsetLayout` prunes feature rules to only reference retained glyphs. Different subset → different rules → different tables.
2. **GIDs shift.** GSUB/GPOS reference glyphs by numeric Glyph ID (index in glyph order). When the subset changes, glyph order changes, so cached tables reference wrong GIDs.
3. **Full-font compilation is not viable.** With up to 80 masters, the gvar table compilation is prohibitively expensive — subsetting exists specifically to avoid this cost.

The tables _are_ independent in the binary format (separate entries in the table directory, can be individually read/written via `FontRef`/`FontBuilder`), but their _content_ depends on the subset, so caching provides no typing-speedup benefit.

---

## Implementation Order

```
                    ┌─── A1 (cache parsed AST)
                    │
    babelfont-rs ───┤─── A2 (HashSet glyph classes)    ← parallel, immediate PRs
                    │
                    ├─── A4 (shared AST across filters)
                    └─── A3 (lookup resolution)        ← deferred, complex

                    ┌─── B1 (turn features on)         ← required, JS-only
                    │
    editor ─────────┤─── B2 (WASM AST cache)           ← biggest caching win
                    │
                    ├─── B3 (incremental closure)
                    ├─── A5 (glyph index lookup)
                    └─── B4 (pre-warm closure)

    future ─────────── B5 (fontc IR caching)
```

**Recommended execution order:**

| Step | Item    | Type                     | Depends On |
| ---- | ------- | ------------------------ | ---------- |
| 1    | A1 + A2 | babelfont-rs PR          | —          |
| 2    | B1      | JS change                | —          |
| 3    | B2      | Editor Rust              | A1         |
| 4    | B3      | Both                     | A1         |
| 5    | A4 + A5 | babelfont-rs PR + Editor | A1         |
| 6    | A3      | babelfont-rs PR          | A1, A2     |
| 7    | B5      | fontc fork               | All above  |

---

## Expected Impact

The optimizations target two bottlenecks: **layout closure** (grows super-linearly) and **redundant FEA parsing** (5× per compile).

| Optimization             | What It Eliminates                                        | Expected Savings                                      |
| ------------------------ | --------------------------------------------------------- | ----------------------------------------------------- |
| A1 (cache AST)           | 4 of 5 FEA parses from string                             | ~5-10ms per parse avoided                             |
| A2 (HashSet classes)     | Millions of Vec allocations + linear scans in closure     | ~5-20ms (proportional to Arabic class sizes)          |
| B2 (WASM AST cache)      | The 1 remaining parse (populate cache once per font load) | ~5-10ms                                               |
| B3 (incremental closure) | Full re-traversal of AST on superset input                | Variable — makes closure ~constant time as text grows |
| A4 (shared AST)          | 2 redundant parse+serialize round-trips in filters        | ~3-5ms                                                |
| A3 (lookup resolution)   | Multi-round AST re-traversal (up to 10×)                  | ~5-15ms on complex Arabic features                    |

**Cumulative estimate:** From ~50-100ms+ (growing super-linearly) down to ~25-40ms (roughly constant). The fontc `generate_font()` call itself (~30ms+ with features on) remains a hard floor until B5 (fontc incremental IR) is implemented.

The most impactful combination for the "exponentially slower" typing symptom is **A2 + B3**: HashSet class lookups eliminate the per-rule per-round cost, and incremental closure eliminates the per-keystroke full recompute. Together they make the closure step roughly constant-time regardless of input length.

---

## Verification Plan

1. **Unit tests:** Run existing `closure.rs` tests after A1, A2, A3 — they cover single subst, contextual subst, class expansion, multi-round convergence
2. **Benchmark:** Add Criterion benchmark using `Fustat.glyphs` (already in `babelfont/resources/`): time `close_layout()` with Arabic glyph sets of 5, 10, 20, 50 input glyphs before and after A1+A2
3. **Incremental closure correctness (B3):** Diff sorted closure results between incremental (seeded) and from-scratch computation for identical inputs — must be byte-identical
4. **End-to-end profiling:** Measure `cp:wasm:layout_closure_cached.compute` and `cp:wasm:compile_cached_font_from_last_layout_closure.total` perf traces while typing Arabic text in Fustat, before and after optimizations
5. **Regression check:** Compile the same font with and without optimizations, compare HarfBuzz shaping output for Arabic text strings — must produce identical glyph positioning

---

## Scope Boundaries

**Included:**

- Layout closure performance in `babelfont/src/layout/closure.rs`
- Feature parsing elimination across filter pipeline
- WASM-layer AST and closure caching
- Text-input compilation options in JS

**Excluded:**

- Full-font compilation (not viable with 80 masters)
- Compiled binary table caching (tables change with subset)
- Changes to debounce timing or two-phase compile architecture
- fontc upstream modifications (deferred to B5/future)
- Non-typing editing modes (drag, keyboard outline editing — separately optimized)
- HarfBuzz shaping performance (downstream of compilation)
