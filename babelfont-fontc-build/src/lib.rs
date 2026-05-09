use babelfont::{
    convertors::fontir::{BabelfontIrSource, CompilationOptions},
    filters::{
        DropIncompatiblePaths, FontFilter as _, GlyphsBracketLayers, GlyphsData,
        GlyphsStylisticSetLabel, RetainGlyphs, RewriteSmartAxes,
    },
};
use fea_rs_ast::FeatureFile;
use json_patch::Patch;
use smol_str::SmolStr;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

// Font reading module (using read-fonts/skrifa)
mod font_reader;
pub use font_reader::{
    get_font_axes, get_font_features, get_font_features_with_tables, get_glyph_name,
    get_glyph_order, get_stylistic_set_names,
};

// Interpolation module
mod interpolation;

// Glyph outlines module
mod glyph_outlines;

// Fontspector QC module
mod fontspector;
pub use fontspector::run_fontspector;

// Global storage for cached fonts
// Use a Mutex to allow safe mutable access from multiple calls

/// Canonical babelfont JSON as serde_json::Value — THE authoritative state.
/// All patches are applied here first, and babelfont::Font is rebuilt
/// lazily from this cache when needed for compilation or interpolation.
static CANONICAL_JSON_CACHE: Mutex<Option<serde_json::Value>> = Mutex::new(None);

/// Subset babelfont JSON — mirrors the full CANONICAL_JSON_CACHE but
/// retains only the glyphs needed for the current editing subset.
/// Patches are applied to both caches; paths that don't exist in the
/// subset are silently ignored.
static SUBSET_JSON_CACHE: Mutex<Option<(String, u64, serde_json::Value)>> = Mutex::new(None);

/// Full babelfont::Font derived from CANONICAL_JSON_CACHE.
/// Rebuilt lazily when the epoch changes (FONT_CACHE_EPOCH > FONT_CACHE_BUILT_AT_EPOCH).
static FONT_CACHE: Mutex<Option<babelfont::Font>> = Mutex::new(None);
static FONT_CACHE_BUILT_AT_EPOCH: AtomicU64 = AtomicU64::new(0);

/// Subset babelfont::Font derived from SUBSET_JSON_CACHE.
/// Rebuilt lazily — keyed by (subset_key, epoch).
static SUBSET_FONT_CACHE: Mutex<Option<(String, u64, babelfont::Font)>> = Mutex::new(None);
static SUBSET_FONT_CACHE_BUILT_AT_EPOCH: AtomicU64 = AtomicU64::new(0);

/// B2: Pre-parsed FeatureFile AST, populated once in store_font_internal() and reused
/// for every close_layout() call.
static FEATURE_FILE_CACHE: Mutex<Option<FeatureFile>> = Mutex::new(None);
/// C1: Serialized FEA string + full glyph name list stored alongside the parsed
/// FeatureFile.
static FEATURE_FEA_STRING_CACHE: Mutex<Option<(String, Vec<String>)>> = Mutex::new(None);
static LAYOUT_CLOSURE_CACHE: LazyLock<Mutex<HashMap<String, Vec<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static LAST_LAYOUT_CLOSURE_CACHE_KEY: Mutex<Option<String>> = Mutex::new(None);
static FONT_CACHE_EPOCH: AtomicU64 = AtomicU64::new(0);
/// Filtered font cache: stores the result of apply_filters() keyed by
/// (subset_key, filter_epoch, options_fingerprint).
static FILTERED_FONT_CACHE: Mutex<Option<FilteredFontCacheEntry>> = Mutex::new(None);
/// Epoch counter for structural (non-outline) changes that require re-filtering.
/// Incremented by store_font_internal() and clear_font_cache().
static FILTER_EPOCH: AtomicU64 = AtomicU64::new(0);
static PERF_SPAN_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Cache entry for a pre-filtered font ready for compilation.
struct FilteredFontCacheEntry {
    /// The subset key that was used to create this font
    subset_key: String,
    /// The filter epoch when filters were applied
    filter_epoch: u64,
    /// The font cache epoch when this entry was built.
    /// When FONT_CACHE_EPOCH advances (outline edits, patches), the filter cache
    /// must be invalidated because the source font data has changed.
    cache_epoch: u64,
    /// Fingerprint of compilation options that affect filtering
    options_fingerprint: u64,
    /// The filtered font (filters applied, ready for compile_filtered).
    /// Stored in an Arc so callers can clone the handle in O(1).
    font: Arc<babelfont::Font>,
}

/// Rebuild babelfont::Font from CANONICAL_JSON_CACHE if the epoch has advanced
/// since the last build. Returns a clone of the cached font.
fn get_or_rebuild_font_cache() -> Result<babelfont::Font, JsValue> {
    let current_epoch = FONT_CACHE_EPOCH.load(Ordering::Relaxed);
    let built_epoch = FONT_CACHE_BUILT_AT_EPOCH.load(Ordering::Relaxed);

    if current_epoch == built_epoch {
        let cache = FONT_CACHE.lock().unwrap();
        return cache
            .as_ref()
            .cloned()
            .ok_or_else(|| JsValue::from_str("No font loaded. Open a font first."));
    }

    let _rebuild_span = PerfSpan::start("rebuild_font_cache");
    let canonical = CANONICAL_JSON_CACHE.lock().unwrap();
    let json_value = canonical
        .as_ref()
        .ok_or_else(|| JsValue::from_str("No font loaded. Open a font first."))?;

    let font: babelfont::Font = serde_json::from_value(json_value.clone())
        .map_err(|e| JsValue::from_str(&format!("Font deserialization error: {}", e)))?;

    let mut cache = FONT_CACHE.lock().unwrap();
    *cache = Some(font.clone());
    FONT_CACHE_BUILT_AT_EPOCH.store(current_epoch, Ordering::Relaxed);

    Ok(font)
}

/// Rebuild the subset babelfont::Font from SUBSET_JSON_CACHE when stale.
fn get_or_rebuild_subset_font_cache(
    expected_subset_key: &str,
) -> Result<Option<babelfont::Font>, JsValue> {
    let current_epoch = FONT_CACHE_EPOCH.load(Ordering::Relaxed);
    let built_epoch = SUBSET_FONT_CACHE_BUILT_AT_EPOCH.load(Ordering::Relaxed);

    let subset_cache = SUBSET_JSON_CACHE.lock().unwrap();
    let Some((subset_key, subset_epoch, subset_json)) = subset_cache.as_ref() else {
        return Ok(None);
    };
    if subset_key != expected_subset_key {
        return Ok(None);
    }

    if current_epoch == built_epoch && *subset_epoch <= built_epoch {
        let font_cache = SUBSET_FONT_CACHE.lock().unwrap();
        if let Some((key, _, font)) = font_cache.as_ref() {
            if key == expected_subset_key {
                return Ok(Some(font.clone()));
            }
        }
    }

    let font: babelfont::Font = serde_json::from_value(subset_json.clone())
        .map_err(|e| JsValue::from_str(&format!("Subset font deserialization error: {}", e)))?;

    let mut font_cache = SUBSET_FONT_CACHE.lock().unwrap();
    *font_cache = Some((expected_subset_key.to_string(), current_epoch, font.clone()));
    SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(current_epoch, Ordering::Relaxed);

    Ok(Some(font))
}

/// Compute a fingerprint for compilation options that affect filtering.
/// If any of these change, the filtered cache must be invalidated.
/// Note: `produce_varc_table` is intentionally excluded — a font filtered
/// WITH RewriteSmartAxes applied can be compiled without VARC table
/// generation, so outline-only mode (produce_varc_table=false) reuses the
/// same cached filtered font as full mode (produce_varc_table=true).
fn options_filter_fingerprint(options: &CompilationOptions) -> u64 {
    let mut h: u64 = 0;
    if options.drop_incompatible_paths { h |= 1; }
    if options.dont_use_production_names { h |= 4; }
    h
}

/// C1: Apply RetainGlyphs to `font` using the cached FEA string to re-parse a
/// fresh FeatureFile for the SubsetLayout visitor.  Re-parsing from the cached
/// string avoids the expensive `font.features.to_fea()` round-trip (~100ms).
/// Falls back to the cold `RetainGlyphs::new()` path when the cache is empty.
fn subset_font_using_cached_fea(
    font: &mut babelfont::Font,
    closure_subset: &[String],
) -> Result<(), JsValue> {
    // Current babelfont API performs SubsetLayout internally in RetainGlyphs.
    // Keep the existing function boundary for minimal call-site changes.
    RetainGlyphs::new(closure_subset.to_vec())
        .apply(font)
        .map_err(|e| JsValue::from_str(&format!("Subsetting failed: {:?}", e)))?;
    Ok(())
}

fn apply_filter_pipeline(
    font: &babelfont::Font,
    options: &CompilationOptions,
) -> Result<babelfont::Font, JsValue> {
    let mut filtered = font.clone();

    if options.drop_incompatible_paths {
        DropIncompatiblePaths
            .apply(&mut filtered)
            .map_err(|e| JsValue::from_str(&format!("DropIncompatiblePaths failed: {:?}", e)))?;
    }

    if options.produce_varc_table {
        RewriteSmartAxes
            .apply(&mut filtered)
            .map_err(|e| JsValue::from_str(&format!("RewriteSmartAxes failed: {:?}", e)))?;
    }

    let exported_names: Vec<String> = filtered
        .glyphs
        .iter()
        .filter(|g| g.exported)
        .map(|g| g.name.to_string())
        .collect();
    RetainGlyphs::new(exported_names)
        .apply(&mut filtered)
        .map_err(|e| JsValue::from_str(&format!("RetainGlyphs failed: {:?}", e)))?;

    GlyphsData
        .apply(&mut filtered)
        .map_err(|e| JsValue::from_str(&format!("GlyphsData failed: {:?}", e)))?;
    GlyphsStylisticSetLabel
        .apply(&mut filtered)
        .map_err(|e| JsValue::from_str(&format!("GlyphsStylisticSetLabel failed: {:?}", e)))?;
    GlyphsBracketLayers
        .apply(&mut filtered)
        .map_err(|e| JsValue::from_str(&format!("GlyphsBracketLayers failed: {:?}", e)))?;

    Ok(filtered)
}

fn parse_usize_prefix(text: &str) -> Option<(usize, usize)> {
    let mut end = 0usize;
    for ch in text.chars() {
        if ch.is_ascii_digit() {
            end += ch.len_utf8();
        } else {
            break;
        }
    }
    if end == 0 {
        return None;
    }
    let value = text[..end].parse::<usize>().ok()?;
    Some((value, end))
}

fn extract_span_from_feature_error_entry(entry: &str) -> Option<(usize, usize)> {
    let marker = "span: ";
    let start_idx = entry.find(marker)? + marker.len();
    let rest = &entry[start_idx..];
    let (start, consumed_start) = parse_usize_prefix(rest)?;
    let rest = &rest[consumed_start..];
    if !rest.starts_with("..") {
        return None;
    }
    let rest = &rest[2..];
    let (end, _consumed_end) = parse_usize_prefix(rest)?;
    Some((start, end))
}

fn extract_feature_error_span(error_text: &str) -> Option<(usize, usize)> {
    let mut first_with_span: Option<(usize, usize)> = None;
    let mut search_from = 0usize;

    while let Some(rel_idx) = error_text[search_from..].find("FeatureError {") {
        let entry_start = search_from + rel_idx;
        let entry_end = error_text[entry_start..]
            .find('}')
            .map(|idx| entry_start + idx + 1)
            .unwrap_or(error_text.len());
        let entry = &error_text[entry_start..entry_end];

        if let Some(span) = extract_span_from_feature_error_entry(entry) {
            if first_with_span.is_none() {
                first_with_span = Some(span);
            }
            if entry.contains("is_error: true") {
                return Some(span);
            }
        }

        if entry_end >= error_text.len() {
            break;
        }
        search_from = entry_end;
    }

    first_with_span
}

fn feature_span_debug_context(fea: &str, start: usize, end: usize) -> String {
    let bytes = fea.as_bytes();
    let len = bytes.len();
    if len == 0 {
        return "empty feature code".to_string();
    }

    let clamped_start = start.min(len);
    let clamped_end = end.max(clamped_start).min(len);

    let line_number = bytes[..clamped_start]
        .iter()
        .filter(|b| **b == b'\n')
        .count()
        + 1;
    let line_start = bytes[..clamped_start]
        .iter()
        .rposition(|b| *b == b'\n')
        .map(|idx| idx + 1)
        .unwrap_or(0);
    let line_end = bytes[clamped_start..]
        .iter()
        .position(|b| *b == b'\n')
        .map(|idx| clamped_start + idx)
        .unwrap_or(len);

    let window_start = clamped_start.saturating_sub(80);
    let window_end = (clamped_end + 160).min(len);

    let line_text = String::from_utf8_lossy(&bytes[line_start..line_end])
        .replace('\n', "\\n")
        .replace('\r', "\\r");
    let window_text = String::from_utf8_lossy(&bytes[window_start..window_end])
        .replace('\n', "\\n")
        .replace('\r', "\\r");

    format!(
        "span={}..{} line={} line_text=\"{}\" window=\"{}\"",
        clamped_start, clamped_end, line_number, line_text, window_text
    )
}

fn compile_with_feature_debug_context(
    font: &babelfont::Font,
    options: &CompilationOptions,
    context: &str,
) -> Result<Vec<u8>, JsValue> {
    match BabelfontIrSource::compile(font.clone(), options.clone()) {
        Ok(compiled) => Ok(compiled),
        Err(err) => {
            let error_text = format!("{:?}", err);
            if error_text.contains("FeatureParsing(") {
                let fea = font.features.to_fea();
                let debug_context = extract_feature_error_span(&error_text)
                    .map(|(start, end)| feature_span_debug_context(&fea, start, end))
                    .unwrap_or_else(|| "span not found in FeatureParsing payload".to_string());
                return Err(JsValue::from_str(&format!(
                    "Compilation failed: {:?}\n[FeatureDebug:{}] {}",
                    err, context, debug_context
                )));
            }

            Err(JsValue::from_str(&format!("Compilation failed: {:?}", err)))
        }
    }
}

const PERF_PREFIX: &str = "cp:wasm";
const PERF_TRACE_CONTEXT_GLOBAL_KEY: &str = "__cpPerfTraceContext";

fn sanitize_trace_part(value: &str) -> String {
    value
        .trim()
        .chars()
        .map(|ch| match ch {
            '|' | '=' | ':' | '#' | ' ' | '\t' | '\n' | '\r' => '_',
            _ => ch,
        })
        .collect()
}

fn get_trace_context_value(context: &JsValue, key: &str) -> Option<String> {
    let value = js_sys::Reflect::get(context, &JsValue::from_str(key)).ok()?;
    let value = value.as_string()?;
    let sanitized = sanitize_trace_part(&value);
    if sanitized.is_empty() {
        None
    } else {
        Some(sanitized)
    }
}

fn current_perf_trace_suffix() -> String {
    let global = js_sys::global();
    let context = match js_sys::Reflect::get(&global, &JsValue::from_str(PERF_TRACE_CONTEXT_GLOBAL_KEY)) {
        Ok(value) if !value.is_null() && !value.is_undefined() => value,
        _ => return String::new(),
    };

    let mut parts: Vec<String> = Vec::new();
    if let Some(process) = get_trace_context_value(&context, "process") {
        parts.push(format!("proc={}", process));
    }
    if let Some(trace_id) = get_trace_context_value(&context, "traceId") {
        parts.push(format!("trace={}", trace_id));
    }
    if let Some(parent) = get_trace_context_value(&context, "parentSpanId") {
        parts.push(format!("parent={}", parent));
    }
    if let Some(request_id) = get_trace_context_value(&context, "requestId") {
        parts.push(format!("req={}", request_id));
    }
    if let Some(revision) = get_trace_context_value(&context, "fontRevisionKey") {
        parts.push(format!("rev={}", revision));
    }

    if parts.is_empty() {
        String::new()
    } else {
        format!("|{}", parts.join("|"))
    }
}

fn perf_mark(label: &str) {
    let global = js_sys::global();
    let performance = match js_sys::Reflect::get(&global, &JsValue::from_str("performance")) {
        Ok(value) if !value.is_null() && !value.is_undefined() => value,
        _ => return,
    };

    let mark_fn = match js_sys::Reflect::get(&performance, &JsValue::from_str("mark")) {
        Ok(value) => value,
        Err(_) => return,
    };

    let Some(mark_fn) = mark_fn.dyn_ref::<js_sys::Function>() else {
        return;
    };

    let _ = mark_fn.call1(&performance, &JsValue::from_str(label));
}

fn perf_measure(name: &str, start: &str, end: &str) {
    let global = js_sys::global();
    let performance = match js_sys::Reflect::get(&global, &JsValue::from_str("performance")) {
        Ok(value) if !value.is_null() && !value.is_undefined() => value,
        _ => return,
    };

    let measure_fn = match js_sys::Reflect::get(&performance, &JsValue::from_str("measure")) {
        Ok(value) => value,
        Err(_) => return,
    };

    let Some(measure_fn) = measure_fn.dyn_ref::<js_sys::Function>() else {
        return;
    };

    let _ = measure_fn.call3(
        &performance,
        &JsValue::from_str(name),
        &JsValue::from_str(start),
        &JsValue::from_str(end),
    );
}

struct PerfSpan {
    measure_name: String,
    start_mark: String,
    end_mark: String,
}

impl PerfSpan {
    fn start(stage: &str) -> Self {
        let span_id = PERF_SPAN_COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
        let trace_suffix = current_perf_trace_suffix();
        let start_mark = format!("{}:{}#{}:start{}", PERF_PREFIX, stage, span_id, trace_suffix);
        let end_mark = format!("{}:{}#{}:end{}", PERF_PREFIX, stage, span_id, trace_suffix);
        let measure_name = format!("{}:{}{}", PERF_PREFIX, stage, trace_suffix);
        perf_mark(&start_mark);

        Self {
            measure_name,
            start_mark,
            end_mark,
        }
    }
}

impl Drop for PerfSpan {
    fn drop(&mut self) {
        perf_mark(&self.end_mark);
        perf_measure(&self.measure_name, &self.start_mark, &self.end_mark);
    }
}

// Set up panic hook for better error messages
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

fn get_option(options: &JsValue, key: &str, default: bool) -> bool {
    if options.is_undefined() || options.is_null() {
        return default;
    }
    js_sys::Reflect::get(options, &JsValue::from_str(key))
        .unwrap_or(JsValue::from_bool(default))
        .as_bool()
        .unwrap_or(default)
}

fn canonical_subset_key(mut glyph_names: Vec<String>) -> String {
    glyph_names.sort();
    glyph_names.dedup();
    glyph_names.join("\u{1F}")
}

fn canonical_subset_key_from_sorted_unique(glyph_names: &[String]) -> String {
    glyph_names.join("\u{1F}")
}

/// Expand a glyph closure to include all transitively referenced component glyphs.
///
/// `close_layout()` only computes the GSUB feature closure (substitution targets).
/// Glyphs that are only used as *components* inside composite glyphs (e.g.
/// `behDotless-ar` referenced by `nun-ar.medi` and `ba-ar.medi`) are not
/// discovered by GSUB closure alone.  If such component glyphs are missing
/// from the subset, `RetainGlyphs` decomposes the component references into
/// inline outlines.  After decomposition, incremental `update_cached_layer`
/// patches to the component glyph no longer propagate to the composites
/// because the component reference no longer exists in the subset font.
///
/// This function walks every glyph in the closure, collects `Shape::Component`
/// references, and transitively adds them — guaranteeing that component glyphs
/// stay in the subset and their references remain live for incremental patching.
fn expand_closure_with_component_deps(font: &babelfont::Font, result: &mut Vec<String>) {
    // A5: Build O(1) name → glyph index up-front so the inner loop does a
    // HashMap lookup instead of an O(total_glyphs) iter().find() per glyph.
    let glyph_index: HashMap<&str, &babelfont::Glyph> =
        font.glyphs.iter().map(|g| (g.name.as_str(), g)).collect();

    let mut closure_set: HashSet<String> = result.iter().cloned().collect();
    let mut queue: Vec<String> = result.clone();

    while let Some(glyph_name) = queue.pop() {
        let Some(glyph) = glyph_index.get(glyph_name.as_str()) else {
            continue;
        };
        for layer in &glyph.layers {
            if layer.is_background {
                continue;
            }
            for shape in &layer.shapes {
                if let babelfont::Shape::Component(component) = shape {
                    let ref_name = component.reference.to_string();
                    if closure_set.insert(ref_name.clone()) {
                        queue.push(ref_name);
                    }
                }
            }
        }
    }

    // Add any newly discovered glyphs to the result
    if closure_set.len() > result.len() {
        let original: HashSet<String> = result.iter().cloned().collect();
        for name in closure_set {
            if !original.contains(&name) {
                result.push(name);
            }
        }
    }
}

fn compute_layout_closure_cached_internal(
    _font_revision: &str,
    glyph_names_json: &str,
) -> Result<(String, Vec<String>), JsValue> {
    let _cache_read_span = PerfSpan::start("layout_closure_cached.cache_read_font");
    let font = get_or_rebuild_font_cache()?;
    drop(_cache_read_span);

    let _parse_span = PerfSpan::start("layout_closure_cached.parse_input");
    let glyph_names: Vec<String> = serde_json::from_str(glyph_names_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse glyph names JSON: {}", e)))?;
    drop(_parse_span);

    let _key_span = PerfSpan::start("layout_closure_cached.compute_key");
    let subset_key = canonical_subset_key(glyph_names.clone());
    let cache_key = subset_key;
    drop(_key_span);

    let _lookup_span = PerfSpan::start("layout_closure_cached.lookup");
    if let Some(cached) = LAYOUT_CLOSURE_CACHE.lock().unwrap().get(&cache_key) {
        let output = cached.clone();
        drop(_lookup_span);
        return Ok((cache_key, output));
    }
    drop(_lookup_span);

    let _to_set_span = PerfSpan::start("layout_closure_cached.to_set");
    let glyph_set: HashSet<SmolStr> = glyph_names.into_iter().map(SmolStr::from).collect();
    drop(_to_set_span);

    let _compute_span = PerfSpan::start("layout_closure_cached.compute");
    // Phase A1+A2+A3 benchmark point: FEA parse, glyph-class expansion, multi-round loop.
    let _close_layout_span = PerfSpan::start("layout_closure_cached.compute.close_layout");
    // B2: Use the pre-parsed FeatureFile from the cache if available (populated
    // by store_font). The visitor only reads the AST so we can safely return it
    // to the cache after the call.
    let closure_set = babelfont::close_layout(&font, glyph_set)
        .map_err(|e| JsValue::from_str(&format!("Layout closure computation failed: {:?}", e)))?;
    drop(_close_layout_span);
    drop(_compute_span);

    let _normalize_span = PerfSpan::start("layout_closure_cached.normalize");
    let mut result: Vec<String> = closure_set.into_iter().map(|s| s.to_string()).collect();

    // Phase A5 benchmark point: index-based glyph lookup for component dependencies.
    let _component_deps_span = PerfSpan::start("layout_closure_cached.normalize.component_deps");
    // Expand closure to include transitively referenced component glyphs
    // so that RetainGlyphs does not decompose them out of the subset.
    expand_closure_with_component_deps(&font, &mut result);
    drop(_component_deps_span);

    result.sort();
    result.dedup();
    drop(_normalize_span);

    let _store_span = PerfSpan::start("layout_closure_cached.store");
    LAYOUT_CLOSURE_CACHE
        .lock()
        .unwrap()
        .insert(cache_key.clone(), result.clone());
    drop(_store_span);

    Ok((cache_key, result))
}

/// Compile a font from babelfont JSON directly to TTF
///
/// This is the main entry point that takes a .babelfont JSON string
/// and produces compiled TTF bytes.
///
/// # Arguments
/// * `babelfont_json` - JSON string in .babelfont format
/// * `options` - Compilation options:
///  - `skip_kerning`: bool - Skip creation of kern tables
///  - `skip_features`: bool - Skip OpenType feature compilation
///  - `skip_metrics`: bool - Skip metrics compilation
///  - `skip_outlines`: bool - Skip `glyf`/`gvar` table creation
///  - `dont_use_production_names`: bool - Don't use production names for glyphs
///  - `subset_glyphs`: String[] - List of glyph names to include
///  - `drop_incompatible_paths`: bool - Drop incompatible paths during compilation
///  - `produce_varc_table`: bool - Produce VARC table (variable fonts)
///
/// # Returns
/// * `Vec<u8>` - Compiled TTF font bytes
#[wasm_bindgen]
pub fn compile_babelfont(babelfont_json: &str, options: &JsValue) -> Result<Vec<u8>, JsValue> {
    let _compile_span = PerfSpan::start("compile_babelfont.total");
    let _parse_span = PerfSpan::start("compile_babelfont.parse_json");
    let mut font: babelfont::Font = serde_json::from_str(babelfont_json)
        .map_err(|e| JsValue::from_str(&format!("JSON parse error: {}", e)))?;
    drop(_parse_span);

    // Handle subset_glyphs option if present
    let _subset_span = PerfSpan::start("compile_babelfont.extract_subset_options");
    if !options.is_undefined() && !options.is_null() {
        if let Ok(subset_val) = js_sys::Reflect::get(options, &JsValue::from_str("subset_glyphs")) {
            if !subset_val.is_undefined() && !subset_val.is_null() {
                if let Ok(array) = subset_val.dyn_into::<js_sys::Array>() {
                    let subset_glyphs: Vec<String> =
                        array.iter().filter_map(|v| v.as_string()).collect();

                    if !subset_glyphs.is_empty() {
                        let _retain_span = PerfSpan::start("compile_babelfont.retain_glyphs");
                        let subsetter = babelfont::filters::RetainGlyphs::new(subset_glyphs);
                        subsetter.apply(&mut font).map_err(|e| {
                            JsValue::from_str(&format!("Subsetting failed: {:?}", e))
                        })?;
                        drop(_retain_span);
                    }
                }
            }
        }
    }
    drop(_subset_span);

    let options = CompilationOptions {
        skip_kerning: get_option(options, "skip_kerning", false),
        skip_features: get_option(options, "skip_features", false),
        skip_metrics: get_option(options, "skip_metrics", false),
        skip_outlines: get_option(options, "skip_outlines", false),
        dont_use_production_names: get_option(options, "dont_use_production_names", false),
        drop_incompatible_paths: get_option(options, "drop_incompatible_paths", false),
        produce_varc_table: get_option(options, "produce_varc_table", false),
        debug_feature_file: None,
    };

    let _ir_compile_span = PerfSpan::start("compile_babelfont.ir_compile");
    let compiled_font = compile_with_feature_debug_context(
        &font,
        &options,
        "compile_babelfont",
    )?;
    drop(_ir_compile_span);

    Ok(compiled_font)
}

/// Legacy function for compatibility
#[wasm_bindgen]
pub fn compile_glyphs(_glyphs_json: &str) -> Result<Vec<u8>, JsValue> {
    Err(JsValue::from_str("Please use compile_babelfont() instead."))
}

/// Get version information
#[wasm_bindgen]
pub fn version() -> String {
    format!("babelfont-fontc-web v{}", env!("CARGO_PKG_VERSION"))
}

/// Store a font in memory from babelfont JSON.
///
/// Populates both the canonical serde_json::Value cache and the
/// babelfont::Font cache. Called during font open/bootstrap.
///
/// # Arguments
/// * `babelfont_json` - JSON string in .babelfont format
///
/// # Returns
/// * `Result<(), JsValue>` - Success or error
#[wasm_bindgen]
pub fn store_font(babelfont_json: &str) -> Result<(), JsValue> {
    let _store_span = PerfSpan::start("store_font.total");
    let _parse_span = PerfSpan::start("store_font.parse_json");

    // Parse into canonical JSON cache first
    let json_value: serde_json::Value = serde_json::from_str(babelfont_json)
        .map_err(|e| JsValue::from_str(&format!("JSON parse error: {}", e)))?;
    *CANONICAL_JSON_CACHE.lock().unwrap() = Some(json_value.clone());

    // Also deserialize into babelfont::Font for immediate use
    let font: babelfont::Font = serde_json::from_value(json_value)
        .map_err(|e| JsValue::from_str(&format!("Font deserialization error: {}", e)))?;
    drop(_parse_span);

    // B2: Build FeatureFile from the local `font` BEFORE acquiring FONT_CACHE,
    // so we never attempt a recursive lock (WASM mutex panics on re-entrancy).
    let _fea_span = PerfSpan::start("store_font.parse_feature_file");
    let fea = font.features.to_fea();
    let font_glyphs: Vec<String> = font.glyphs.iter().map(|g| g.name.to_string()).collect();
    let font_glyphs_ref: Vec<&str> = font_glyphs.iter().map(|s| s.as_str()).collect();
    let new_feature_file = FeatureFile::new_from_fea(&fea, Some(&font_glyphs_ref), font.source.clone()).ok();
    drop(_fea_span);

    let _cache_span = PerfSpan::start("store_font.cache_write");
    let mut cache = FONT_CACHE.lock().unwrap();
    *cache = Some(font);
    drop(_cache_span);

    *FEATURE_FILE_CACHE.lock().unwrap() = new_feature_file;
    *FEATURE_FEA_STRING_CACHE.lock().unwrap() = Some((fea, font_glyphs));

    // Clear subset caches — they need rebuilding with new closure
    *SUBSET_JSON_CACHE.lock().unwrap() = None;
    *SUBSET_FONT_CACHE.lock().unwrap() = None;

    let next_epoch = FONT_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed) + 1;
    FONT_CACHE_BUILT_AT_EPOCH.store(next_epoch, Ordering::Relaxed);
    SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
    FILTER_EPOCH.fetch_add(1, Ordering::Relaxed);

    // Clear the outline cache since font changed
    let _outline_clear_span = PerfSpan::start("store_font.clear_outline_cache");
    glyph_outlines::clear_outline_cache();
    drop(_outline_clear_span);

    Ok(())
}

/// Apply RFC 6902 JSON Patch batch to the canonical font JSON cache.
///
/// This is the exclusive mutation path for the Rust cache after bootstrap.
/// The same patches are also applied to the subset JSON cache (best-effort;
/// missing paths in the subset are silently ignored).
///
/// # Arguments
/// * `patches_json` - JSON string containing an array of RFC 6902 patch operations
///
/// # Returns
/// * `Result<(), JsValue>` - Success or error
#[wasm_bindgen]
pub fn apply_patch_batch(patches_json: &str) -> Result<(), JsValue> {
    let _span = PerfSpan::start("apply_patch_batch.total");

    let _parse_span = PerfSpan::start("apply_patch_batch.parse");
    let patch: Patch = serde_json::from_str(patches_json)
        .map_err(|e| JsValue::from_str(&format!("Patch batch parse error: {}", e)))?;
    drop(_parse_span);

    if patch.0.is_empty() {
        return Ok(());
    }

    // Apply patches to canonical JSON cache
    let _apply_span = PerfSpan::start("apply_patch_batch.apply_canonical");
    {
        let mut canonical = CANONICAL_JSON_CACHE.lock().unwrap();
        let json_value = canonical
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No font loaded. Open a font first."))?;
        json_patch::patch(json_value, &patch)
            .map_err(|e| JsValue::from_str(&format!("Patch application error: {}", e)))?;
    }
    drop(_apply_span);

    // Apply same patches to subset JSON cache (best-effort)
    let _subset_span = PerfSpan::start("apply_patch_batch.apply_subset");
    {
        let mut subset_cache = SUBSET_JSON_CACHE.lock().unwrap();
        if let Some((subset_key, _subset_epoch, subset_json)) = subset_cache.as_mut() {
            let subset_key = subset_key.clone();
            if json_patch::patch(subset_json, &patch).is_ok() {
                let current_epoch = FONT_CACHE_EPOCH.load(Ordering::Relaxed);
                *subset_cache = Some((subset_key, current_epoch, subset_json.clone()));
                perf_mark(&format!(
                    "{}:apply_patch_batch.subset_patched{}",
                    PERF_PREFIX,
                    current_perf_trace_suffix()
                ));
            }
        }
    }
    drop(_subset_span);

    // Bump the cache epoch so downstream consumers (font cache, subset cache,
    // filter cache) detect that data has changed.
    FONT_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed);

    // Collect affected glyph names from patch paths for outline cache clearing
    let _clear_outline_span = PerfSpan::start("apply_patch_batch.clear_outline");
    let mut affected_glyphs: HashSet<String> = HashSet::new();
    for op in &patch.0 {
        let path = op.path().to_string();
        let segments: Vec<&str> = path.split('/').skip(1).collect();
        if segments.len() >= 2 && segments[0] == "glyphs" && !segments[1].is_empty() {
            let glyph_name = segments[1];
            // Convert JSON pointer escaping back (~1 → /, ~0 → ~)
            let glyph_name = glyph_name.replace("~1", "/").replace("~0", "~");
            // Filter out numeric indices (array positions that need resolution)
            if !glyph_name.chars().all(|c| c.is_ascii_digit()) {
                affected_glyphs.insert(glyph_name);
            }
        }
    }
    for glyph_name in &affected_glyphs {
        glyph_outlines::clear_outline_cache_for_glyph(glyph_name);
    }
    drop(_clear_outline_span);

    Ok(())
}

/// Clear the cached font from memory
#[wasm_bindgen]
pub fn clear_font_cache() {
    let mut cache = FONT_CACHE.lock().unwrap();
    *cache = None;

    *CANONICAL_JSON_CACHE.lock().unwrap() = None;
    *SUBSET_JSON_CACHE.lock().unwrap() = None;
    *SUBSET_FONT_CACHE.lock().unwrap() = None;
    LAYOUT_CLOSURE_CACHE.lock().unwrap().clear();
    *LAST_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = None;
    *FILTERED_FONT_CACHE.lock().unwrap() = None;
    *FEATURE_FILE_CACHE.lock().unwrap() = None;
    *FEATURE_FEA_STRING_CACHE.lock().unwrap() = None;
    FONT_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed);
    FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
    SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
    FILTER_EPOCH.fetch_add(1, Ordering::Relaxed);

    glyph_outlines::clear_outline_cache();
}
/// Open a font file from various formats
///
/// Supports .glyphs, .glyphspackage, .ufo, .designspace, .vfj, and .babelfont formats.
/// Loads the font, stores it in cache, and returns the babelfont JSON representation.
///
/// # Arguments
/// * `filename` - The name of the font file (used to determine format)
/// * `contents` - The file contents as a string (for text formats) or JSON (for .babelfont)
///
/// # Returns
/// * `String` - Babelfont JSON representation
#[wasm_bindgen]
pub fn open_font_file(filename: &str, contents: &str) -> Result<String, JsValue> {
    web_sys::console::log_1(&format!("[Rust] Opening font file: {}", filename).into());

    let path = std::path::PathBuf::from(filename);
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    // Parse the font based on file extension
    let font: babelfont::Font = match extension.as_str() {
        "babelfont" => {
            // For .babelfont, just parse the JSON directly
            serde_json::from_str(contents).map_err(|e| {
                JsValue::from_str(&format!("Failed to parse .babelfont JSON: {}", e))
            })?
        }

        "glyphs" => {
            // Load Glyphs 2/3 format
            babelfont::convertors::glyphs3::load_str(contents, path.clone())
                .map_err(|e| JsValue::from_str(&format!("Failed to load .glyphs file: {:?}", e)))?
        }

        "glyphspackage" => {
            // Load Glyphs package from a JSON-encoded in-memory file tree.
            // Expected format: { "relative/path": "file contents", ... }
            let entries: HashMap<String, String> = serde_json::from_str(contents).map_err(|e| {
                JsValue::from_str(&format!(
                    "Failed to parse .glyphspackage entries JSON: {}",
                    e
                ))
            })?;

            babelfont::convertors::glyphs3::load_package_entries(path.clone(), &entries)
                .map_err(|e| {
                    JsValue::from_str(&format!("Failed to load .glyphspackage: {:?}", e))
                })?
        }

        "vfj" => {
            // Load FontLab VFJ format
            babelfont::convertors::fontlab::load_str(contents)
                .map_err(|e| JsValue::from_str(&format!("Failed to load .vfj file: {:?}", e)))?
        }

        "sfd" => {
            // Load FontForge SFD format from string content
            babelfont::convertors::fontforge::load_str(contents)
                .map_err(|e| JsValue::from_str(&format!("Failed to load .sfd file: {:?}", e)))?
        }

        "ufo" => {
            let entries: HashMap<String, String> = serde_json::from_str(contents).map_err(|e| {
                JsValue::from_str(&format!("Failed to parse .ufo entries JSON: {}", e))
            })?;
            babelfont::convertors::ufo::load_entries(path.clone(), &entries)
                .map_err(|e| JsValue::from_str(&format!("Failed to load .ufo: {:?}", e)))?
        }

        "designspace" => {
            let entries: HashMap<String, String> = serde_json::from_str(contents).map_err(|e| {
                JsValue::from_str(&format!("Failed to parse .designspace entries JSON: {}", e))
            })?;
            babelfont::convertors::designspace::load_entries(path.clone(), &entries).map_err(
                |e| JsValue::from_str(&format!("Failed to load .designspace: {:?}", e)),
            )?
        }

        _ => {
            return Err(JsValue::from_str(&format!(
                "Unsupported file format: .{}. Supported formats: .babelfont, .glyphs, .glyphspackage, .vfj, .sfd, .ufo, .designspace",
                extension
            )));
        }
    };

    web_sys::console::log_1(
        &format!(
            "[Rust] Successfully loaded font with {} glyphs",
            font.glyphs.len()
        )
        .into(),
    );

    // Store in cache
    let mut cache = FONT_CACHE.lock().unwrap();
    *cache = Some(font.clone());
    drop(cache);

    // Serialize to JSON for JavaScript
    let json = serde_json::to_string(&font)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize font to JSON: {}", e)))?;

    web_sys::console::log_1(&format!("[Rust] Serialized to JSON ({} bytes)", json.len()).into());

    Ok(json)
}

/// Interpolate a glyph at a specific location in design space
///
/// Requires that a font has been stored via store_font() first.
///
/// # Arguments
/// * `glyph_name` - Name of the glyph to interpolate
/// * `location_json` - JSON object with axis tags and values in USER SPACE, e.g., '{"wght": 550.0, "wdth": 100.0}'
///
/// # Returns
/// * `String` - JSON representation of the interpolated Layer
#[wasm_bindgen]
pub fn interpolate_glyph(
    glyph_name: &str,
    location_json: &str,
    extrapolate: bool,
) -> Result<String, JsValue> {
    let font = get_or_rebuild_font_cache()?;
    interpolation::interpolate_glyph(&font, glyph_name, location_json, extrapolate)
}

/// Get outlines for multiple glyphs with optional component flattening
///
/// Requires that a font has been stored via store_font() first.
///
/// # Arguments
/// * `glyph_names_json` - JSON array of glyph names, e.g., '["A", "B", "C"]'
/// * `location_json` - JSON object with axis tags and values in USER SPACE, e.g., '{"wght": 400.0}'. Empty object '{}' uses default location.
/// * `flatten_components` - If true, resolves and flattens all components into paths
///
/// # Returns
/// * `String` - JSON array of glyph outline data: '[{"name": "A", "width": 600, "shapes": [...], "bounds": {...}}, ...]'
#[wasm_bindgen]
pub fn get_glyphs_outlines(
    glyph_names_json: &str,
    location_json: &str,
    flatten_components: bool,
) -> Result<String, JsValue> {
    let font = get_or_rebuild_font_cache()?;
    let glyph_names: Vec<String> = serde_json::from_str(glyph_names_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse glyph names: {}", e)))?;
    glyph_outlines::get_glyphs_outlines(&font, &glyph_names, location_json, flatten_components)
}

/// Compute layout closure for a set of glyphs
///
/// Given a set of glyph names, returns all glyphs that are referenced
/// in OpenType layout features (GSUB substitutions only). This includes
/// substitution targets, ligature components, and alternate forms.
///
/// Requires that a font has been stored via store_font() first.
///
/// # Arguments
/// * `glyph_names_json` - JSON array of glyph names, e.g., '["A", "B", "C"]'
///
/// # Returns
/// * `String` - JSON array of all glyphs in the closure set (sorted)
///
/// # Example
/// ```javascript
/// // JavaScript usage:
/// const initialGlyphs = ["a", "b"];
/// const closure = JSON.parse(wasmModule.get_layout_closure(JSON.stringify(initialGlyphs)));
/// // closure might be: ["a", "b", "a.sc", "b.sc", "a.alt", ...]
/// ```
#[wasm_bindgen]
pub fn get_layout_closure(glyph_names_json: &str) -> Result<String, JsValue> {
    let _closure_total_span = PerfSpan::start("get_layout_closure.total");

    let _cache_read_span = PerfSpan::start("get_layout_closure.cache_read");
    let font = get_or_rebuild_font_cache()?;
    drop(_cache_read_span);

    // Parse input glyph names from JSON array
    let _parse_span = PerfSpan::start("get_layout_closure.parse_input");
    let glyph_names: Vec<String> = serde_json::from_str(glyph_names_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse glyph names JSON: {}", e)))?;
    drop(_parse_span);

    // Convert Vec<String> to HashSet<SmolStr> for close_layout
    let _to_set_span = PerfSpan::start("get_layout_closure.to_set");
    let glyph_set: HashSet<SmolStr> = glyph_names.into_iter().map(SmolStr::from).collect();
    drop(_to_set_span);

    // Compute the layout closure
    let _compute_span = PerfSpan::start("get_layout_closure.compute");
    let closure_set = babelfont::close_layout(&font, glyph_set)
        .map_err(|e| JsValue::from_str(&format!("Layout closure computation failed: {:?}", e)))?;
    drop(_compute_span);

    // Convert HashSet<SmolStr> back to sorted Vec<String> for consistent output
    let _result_span = PerfSpan::start("get_layout_closure.result_serialize");
    let mut result: Vec<String> = closure_set.into_iter().map(|s| s.to_string()).collect();

    // Expand closure to include transitively referenced component glyphs
    expand_closure_with_component_deps(&font, &mut result);

    result.sort();

    // Serialize to JSON array
    let output = serde_json::to_string(&result)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize closure result: {}", e)))
        ?;
    drop(_result_span);

    Ok(output)
}

/// Compute layout closure with Rust-side caching keyed by font revision + subset key.
///
/// Cache key format: `<font_revision>::<canonical_subset_key>`
/// where canonical subset key is sorted+deduplicated input glyph names.
#[wasm_bindgen]
pub fn get_layout_closure_cached(
    font_revision: &str,
    glyph_names_json: &str,
) -> Result<String, JsValue> {
    let _closure_total_span = PerfSpan::start("get_layout_closure_cached.total");

    let (_cache_key, result) = compute_layout_closure_cached_internal(font_revision, glyph_names_json)?;

    let _serialize_span = PerfSpan::start("get_layout_closure_cached.serialize");
    let output = serde_json::to_string(&result)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize closure result: {}", e)))?;
    drop(_serialize_span);

    Ok(output)
}

/// Prime Rust layout-closure cache and mark it as the current closure subset.
/// Returns number of glyphs in the resolved closure subset.
#[wasm_bindgen]
pub fn prime_layout_closure_cache(
    font_revision: &str,
    glyph_names_json: &str,
) -> Result<u32, JsValue> {
    let _prime_span = PerfSpan::start("prime_layout_closure_cache.total");
    let (cache_key, result) =
        compute_layout_closure_cached_internal(font_revision, glyph_names_json)?;
    *LAST_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = Some(cache_key.clone());

    Ok(result.len() as u32)
}

/// Compile cached font using the last primed layout closure subset.
#[wasm_bindgen]
pub fn compile_cached_font_from_last_layout_closure(
    options: &JsValue,
) -> Result<Vec<u8>, JsValue> {
    let _compile_span = PerfSpan::start("compile_cached_font_from_last_layout_closure.total");

    let _closure_fetch_span = PerfSpan::start("compile_cached_font_from_last_layout_closure.fetch_last_closure");
    let cache_key = LAST_LAYOUT_CLOSURE_CACHE_KEY
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| JsValue::from_str("No primed layout closure. Call prime_layout_closure_cache() first."))?;
    drop(_closure_fetch_span);

    let _subset_fetch_span =
        PerfSpan::start("compile_cached_font_from_last_layout_closure.fetch_closure_subset");
    let closure_subset = LAYOUT_CLOSURE_CACHE
        .lock()
        .unwrap()
        .get(&cache_key)
        .cloned()
        .ok_or_else(|| JsValue::from_str("Primed layout closure key not found in cache."))?;
    drop(_subset_fetch_span);

    let prepared_subset_key = canonical_subset_key_from_sorted_unique(&closure_subset);

    // Try lazy subset font cache first. Falls back to building subset from
    // the full canonical JSON + RetainGlyphs on cache miss.
    let _prepared_span = PerfSpan::start("compile_cached_font_from_last_layout_closure.get_or_build_subset");
    let subset_font = match get_or_rebuild_subset_font_cache(&prepared_subset_key)? {
        Some(cached) => {
            perf_mark(&format!(
                "{}:compile_cached_font_from_last_layout_closure.subset_cache_hit{}",
                PERF_PREFIX,
                current_perf_trace_suffix()
            ));
            cached
        }
        None => {
            perf_mark(&format!(
                "{}:compile_cached_font_from_last_layout_closure.subset_cache_miss{}",
                PERF_PREFIX,
                current_perf_trace_suffix()
            ));
            let full_font = get_or_rebuild_font_cache()?;
            let mut subset_font = full_font;
            if !closure_subset.is_empty() {
                subset_font_using_cached_fea(&mut subset_font, &closure_subset)?;
            }
            subset_font
        }
    };
    drop(_prepared_span);

    let compilation_options = CompilationOptions {
        skip_kerning: get_option(options, "skip_kerning", false),
        skip_features: get_option(options, "skip_features", false),
        skip_metrics: get_option(options, "skip_metrics", false),
        skip_outlines: get_option(options, "skip_outlines", false),
        dont_use_production_names: get_option(options, "dont_use_production_names", false),
        drop_incompatible_paths: get_option(options, "drop_incompatible_paths", false),
        produce_varc_table: get_option(options, "produce_varc_table", false),
        debug_feature_file: None,
    };

    // Use filtered font cache: apply_filters() once, then reuse.
    let current_filter_epoch = FILTER_EPOCH.load(Ordering::Relaxed);
    let current_cache_epoch = FONT_CACHE_EPOCH.load(Ordering::Relaxed);
    let current_options_fp = options_filter_fingerprint(&compilation_options);

    let _filter_cache_span = PerfSpan::start("compile_cached_font_from_last_layout_closure.filter_cache");
    let filtered_font = {
        let mut filter_cache = FILTERED_FONT_CACHE.lock().unwrap();
        let cache_hit = filter_cache.as_ref().map_or(false, |entry| {
            entry.subset_key == prepared_subset_key
                && entry.filter_epoch == current_filter_epoch
                && entry.cache_epoch == current_cache_epoch
                && entry.options_fingerprint == current_options_fp
        });

        if cache_hit {
            perf_mark(&format!(
                "{}:compile_cached_font_from_last_layout_closure.filter_cache.hit{}",
                PERF_PREFIX,
                current_perf_trace_suffix()
            ));
            Arc::clone(&filter_cache.as_ref().unwrap().font)
        } else {
            let _apply_span = PerfSpan::start("compile_cached_font_from_last_layout_closure.filter_cache.apply_filters");
            let filtered = apply_filter_pipeline(&subset_font, &compilation_options)?;
            drop(_apply_span);

            let filtered_arc = Arc::new(filtered);
            *filter_cache = Some(FilteredFontCacheEntry {
                subset_key: prepared_subset_key.clone(),
                filter_epoch: current_filter_epoch,
                cache_epoch: current_cache_epoch,
                options_fingerprint: current_options_fp,
                font: Arc::clone(&filtered_arc),
            });

            perf_mark(&format!(
                "{}:compile_cached_font_from_last_layout_closure.filter_cache.miss{}",
                PERF_PREFIX,
                current_perf_trace_suffix()
            ));
            filtered_arc
        }
    };
    drop(_filter_cache_span);

    let _ir_compile_span = PerfSpan::start("compile_cached_font_from_last_layout_closure.ir_compile");
    let compiled_font = compile_with_feature_debug_context(
        filtered_font.as_ref(),
        &compilation_options,
        "compile_cached_font_from_last_layout_closure",
    )?;
    drop(_ir_compile_span);

    Ok(compiled_font)
}

/// Compile the cached font to TTF
///
/// This is a convenience function that compiles the currently cached font
/// without needing to pass the JSON again.
///
/// # Arguments
/// * `options` - Compilation options (same as compile_babelfont)
///
/// # Returns
/// * `Vec<u8>` - Compiled TTF font bytes
#[wasm_bindgen]
pub fn compile_cached_font(options: &JsValue) -> Result<Vec<u8>, JsValue> {
    let _compile_span = PerfSpan::start("compile_cached_font.total");

    let _cache_read_span = PerfSpan::start("compile_cached_font.cache_read");
    let mut font_clone = get_or_rebuild_font_cache()?;
    drop(_cache_read_span);

    // Handle subset_glyphs option if present
    let _subset_span = PerfSpan::start("compile_cached_font.extract_subset_options");
    if !options.is_undefined() && !options.is_null() {
        if let Ok(subset_val) = js_sys::Reflect::get(options, &JsValue::from_str("subset_glyphs")) {
            if !subset_val.is_undefined() && !subset_val.is_null() {
                if let Ok(array) = subset_val.dyn_into::<js_sys::Array>() {
                    let subset_glyphs: Vec<String> =
                        array.iter().filter_map(|v| v.as_string()).collect();

                    if !subset_glyphs.is_empty() {
                        let _retain_span = PerfSpan::start("compile_cached_font.retain_glyphs");
                        let subsetter = babelfont::filters::RetainGlyphs::new(subset_glyphs);
                        subsetter.apply(&mut font_clone).map_err(|e| {
                            JsValue::from_str(&format!("Subsetting failed: {:?}", e))
                        })?;
                        drop(_retain_span);
                    }
                }
            }
        }
    }
    drop(_subset_span);

    let compilation_options = CompilationOptions {
        skip_kerning: get_option(options, "skip_kerning", false),
        skip_features: get_option(options, "skip_features", false),
        skip_metrics: get_option(options, "skip_metrics", false),
        skip_outlines: get_option(options, "skip_outlines", false),
        dont_use_production_names: get_option(options, "dont_use_production_names", false),
        drop_incompatible_paths: get_option(options, "drop_incompatible_paths", false),
        produce_varc_table: get_option(options, "produce_varc_table", false),
        debug_feature_file: None,
    };

    let _ir_compile_span = PerfSpan::start("compile_cached_font.ir_compile");
    let compiled_font = compile_with_feature_debug_context(
        &font_clone,
        &compilation_options,
        "compile_cached_font",
    )?;
    drop(_ir_compile_span);

    Ok(compiled_font)
}
