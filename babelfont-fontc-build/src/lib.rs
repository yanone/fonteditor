use babelfont::{
    convertors::fontir::{BabelfontIrSource, CompilationOptions},
    filters::{
        DropIncompatiblePaths, FontFilter as _, GlyphsBracketLayers, GlyphsData,
        GlyphsStylisticSetLabel, RetainGlyphs, RewriteSmartAxes,
    },
};
use fea_rs_ast::FeatureFile;
use smol_str::SmolStr;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
static FONT_CACHE: Mutex<Option<babelfont::Font>> = Mutex::new(None);
/// B2: Pre-parsed FeatureFile AST, populated once in store_font() and reused
/// for every close_layout() call.  The visitor only reads the AST, never
/// modifies it, so the same instance is safe to reuse across keystrokes.
/// WASM is single-threaded so no concurrent access can occur.
static FEATURE_FILE_CACHE: Mutex<Option<FeatureFile>> = Mutex::new(None);
/// C1: Serialized FEA string + full glyph name list stored alongside the parsed
/// FeatureFile.  Cloning a String is cheap; used by subset_font_using_cached_fea
/// to re-parse a fresh FeatureFile for the SubsetLayout visitor (which mutates
/// the AST, so we can't reuse the B2 cached FeatureFile directly).
static FEATURE_FEA_STRING_CACHE: Mutex<Option<(String, Vec<String>)>> = Mutex::new(None);
static LAYOUT_CLOSURE_CACHE: LazyLock<Mutex<HashMap<String, Vec<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static LAST_LAYOUT_CLOSURE_CACHE_KEY: Mutex<Option<String>> = Mutex::new(None);
static PREPARED_SUBSET_FONT_CACHE: Mutex<Option<(String, u64, babelfont::Font)>> = Mutex::new(None);
static FONT_CACHE_EPOCH: AtomicU64 = AtomicU64::new(0);
/// Filtered font cache: stores the result of apply_filters() keyed by
/// (subset_key, filter_epoch, options_fingerprint).
/// The filter_epoch tracks structural changes (font load, non-outline edits).
/// Outline/anchor edits bump FONT_CACHE_EPOCH but NOT the filter epoch,
/// so the cached filtered font can be reused with surgical glyph patching.
static FILTERED_FONT_CACHE: Mutex<Option<FilteredFontCacheEntry>> = Mutex::new(None);
/// Epoch counter for structural (non-outline) changes that require re-filtering.
/// Incremented by store_font() and clear_font_cache(), but NOT by update_cached_layer().
static FILTER_EPOCH: AtomicU64 = AtomicU64::new(0);
/// Set to true by update_cached_layer when it patches the prepared subset in-place.
/// Consumed (reset to false) by compile_cached_font_from_last_layout_closure to
/// skip the redundant patch_subset_glyphs_from_cached_font call + clone-back.
static PREPARED_SUBSET_PATCHED_IN_PLACE: AtomicBool = AtomicBool::new(false);
/// Set to true by update_cached_layer when it patches FILTERED_FONT_CACHE in-place.
/// Consumed by the filter-cache section of compile_cached_font_from_last_layout_closure
/// so it can skip the dirty-glyph patching loop (the cache is already current).
static FILTERED_FONT_PATCHED_IN_PLACE: AtomicBool = AtomicBool::new(false);
static PERF_SPAN_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Cache entry for a pre-filtered font ready for compilation.
struct FilteredFontCacheEntry {
    /// The subset key that was used to create this font
    subset_key: String,
    /// The filter epoch when filters were applied
    filter_epoch: u64,
    /// Fingerprint of compilation options that affect filtering
    options_fingerprint: u64,
    /// The filtered font (filters applied, ready for compile_filtered).
    /// Stored in an Arc so callers can clone the handle in O(1) rather than
    /// doing a full data copy.  Mutations via update_cached_layer() use
    /// Arc::make_mut(), which is O(1) when the Arc is the sole owner (always
    /// the case in WASM's single-threaded execution model).
    font: Arc<babelfont::Font>,
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

fn get_string_array_option(options: &JsValue, key: &str) -> Vec<String> {
    if options.is_undefined() || options.is_null() {
        return Vec::new();
    }

    let value = match js_sys::Reflect::get(options, &JsValue::from_str(key)) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };

    if value.is_undefined() || value.is_null() {
        return Vec::new();
    }

    let array = match value.dyn_into::<js_sys::Array>() {
        Ok(array) => array,
        Err(_) => return Vec::new(),
    };

    array
        .iter()
        .filter_map(|entry| entry.as_string())
        .filter(|entry| !entry.is_empty())
        .collect()
}

fn patch_subset_glyphs_from_cached_font(
    subset_font: &mut babelfont::Font,
    dirty_glyph_names: &[String],
) -> Result<usize, JsValue> {
    if dirty_glyph_names.is_empty() {
        return Ok(0);
    }

    let dirty_set: HashSet<&str> = dirty_glyph_names.iter().map(String::as_str).collect();
    let cache = FONT_CACHE.lock().unwrap();
    let base_font = cache
        .as_ref()
        .ok_or_else(|| JsValue::from_str("No font cached. Call store_font() first."))?;

    let mut base_glyph_by_name: HashMap<String, babelfont::Glyph> = base_font
        .glyphs
        .iter()
        .filter_map(|glyph| {
            let glyph_name = glyph.name.as_str();
            if dirty_set.contains(glyph_name) {
                Some((glyph_name.to_string(), glyph.clone()))
            } else {
                None
            }
        })
        .collect();

    let mut patched_count = 0;
    for subset_glyph in subset_font.glyphs.iter_mut() {
        let subset_glyph_name = subset_glyph.name.as_str();
        if !dirty_set.contains(subset_glyph_name) {
            continue;
        }

        if let Some(latest_glyph) = base_glyph_by_name.remove(subset_glyph_name) {
            *subset_glyph = latest_glyph;
            patched_count += 1;
        }
    }

    Ok(patched_count)
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
    let cache = FONT_CACHE.lock().unwrap();
    let font = cache
        .as_ref()
        .ok_or_else(|| JsValue::from_str("No font cached. Call store_font() first."))?;
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
    let closure_set = babelfont::close_layout(font, glyph_set)
        .map_err(|e| JsValue::from_str(&format!("Layout closure computation failed: {:?}", e)))?;
    drop(_close_layout_span);
    drop(_compute_span);

    let _normalize_span = PerfSpan::start("layout_closure_cached.normalize");
    let mut result: Vec<String> = closure_set.into_iter().map(|s| s.to_string()).collect();

    // Phase A5 benchmark point: index-based glyph lookup for component dependencies.
    let _component_deps_span = PerfSpan::start("layout_closure_cached.normalize.component_deps");
    // Expand closure to include transitively referenced component glyphs
    // so that RetainGlyphs does not decompose them out of the subset.
    expand_closure_with_component_deps(font, &mut result);
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

/// Store a font in memory from babelfont JSON
///
/// This caches the deserialized font for fast access by interpolation
/// and other operations without re-parsing JSON every time.
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
    let font: babelfont::Font = serde_json::from_str(babelfont_json)
        .map_err(|e| JsValue::from_str(&format!("JSON parse error: {}", e)))?;
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
    // C1: Also cache the raw FEA string + glyph list so subset_font_using_cached_fea
    // can re-parse a fresh FeatureFile without the expensive to_fea() round-trip.
    *FEATURE_FEA_STRING_CACHE.lock().unwrap() = Some((fea, font_glyphs));

    FONT_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed);
    FILTER_EPOCH.fetch_add(1, Ordering::Relaxed);

    // Keep layout-closure cache across store_font to avoid recomputing closure
    // for outline-only edits. The cache key should be provided by caller.

    // Clear the outline cache since font changed
    let _outline_clear_span = PerfSpan::start("store_font.clear_outline_cache");
    glyph_outlines::clear_outline_cache();
    drop(_outline_clear_span);

    Ok(())
}

#[wasm_bindgen]
pub fn update_cached_layer(
    glyph_name: &str,
    layer_id: &str,
    layer_json: &str,
) -> Result<(), JsValue> {
    let _update_span = PerfSpan::start("update_cached_layer.total");

    let _parse_span = PerfSpan::start("update_cached_layer.parse_layer_json");
    let parsed_layer: babelfont::Layer = serde_json::from_str(layer_json)
        .map_err(|e| JsValue::from_str(&format!("Layer JSON parse error: {}", e)))?;
    drop(_parse_span);

    let _cache_span = PerfSpan::start("update_cached_layer.cache_write");
    let mut cache = FONT_CACHE.lock().unwrap();
    let font = cache
        .as_mut()
        .ok_or_else(|| JsValue::from_str("No font cached. Call store_font() first."))?;

    let target_glyph = font
        .glyphs
        .iter_mut()
        .find(|glyph| glyph.name.as_str() == glyph_name)
        .ok_or_else(|| JsValue::from_str("Glyph not found in cached font."))?;

    if let Some(existing_layer) = target_glyph
        .layers
        .iter_mut()
        .find(|layer| layer.id.as_deref() == Some(layer_id))
    {
        *existing_layer = parsed_layer.clone();
    } else {
        target_glyph.layers.push(parsed_layer.clone());
    }
    drop(_cache_span);

    let next_epoch = FONT_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed) + 1;

    // Keep a copy of parsed_layer for patching the filtered font cache below.
    let parsed_layer_for_filter = parsed_layer.clone();

    let _prepared_span = PerfSpan::start("update_cached_layer.patch_prepared_subset");
    let mut prepared_cache = PREPARED_SUBSET_FONT_CACHE.lock().unwrap();
    if let Some((_subset_key, prepared_epoch, prepared_font)) = prepared_cache.as_mut() {
        if let Some(prepared_glyph) = prepared_font
            .glyphs
            .iter_mut()
            .find(|glyph| glyph.name.as_str() == glyph_name)
        {
            if let Some(prepared_layer) = prepared_glyph
                .layers
                .iter_mut()
                .find(|layer| layer.id.as_deref() == Some(layer_id))
            {
                *prepared_layer = parsed_layer;
            } else {
                prepared_glyph.layers.push(parsed_layer);
            }
            *prepared_epoch = next_epoch;
            PREPARED_SUBSET_PATCHED_IN_PLACE.store(true, Ordering::Release);
            perf_mark(&format!(
                "{}:update_cached_layer.patch_prepared_subset.applied{}",
                PERF_PREFIX,
                current_perf_trace_suffix()
            ));
        }
    }
    drop(_prepared_span);

    // D2: Also patch FILTERED_FONT_CACHE in-place so compile_cached_font_from_last_layout_closure
    // can skip the dirty-glyph patching loop entirely (avoiding both the find + layers clone).
    // Arc::make_mut() is O(1) here because WASM is single-threaded: the compile that previously
    // consumed an Arc::clone() has already returned before the next update_cached_layer() call.
    let _filtered_span = PerfSpan::start("update_cached_layer.patch_filtered_font");
    let mut filtered_cache = FILTERED_FONT_CACHE.lock().unwrap();
    if let Some(entry) = filtered_cache.as_mut() {
        if let Some(filtered_glyph) = Arc::make_mut(&mut entry.font)
            .glyphs
            .iter_mut()
            .find(|glyph| glyph.name.as_str() == glyph_name)
        {
            if let Some(filtered_layer) = filtered_glyph
                .layers
                .iter_mut()
                .find(|layer| layer.id.as_deref() == Some(layer_id))
            {
                *filtered_layer = parsed_layer_for_filter;
            } else {
                filtered_glyph.layers.push(parsed_layer_for_filter);
            }
            FILTERED_FONT_PATCHED_IN_PLACE.store(true, Ordering::Release);
            perf_mark(&format!(
                "{}:update_cached_layer.patch_filtered_font.applied{}",
                PERF_PREFIX,
                current_perf_trace_suffix()
            ));
        }
    }
    drop(_filtered_span);

    let _outline_clear_span = PerfSpan::start("update_cached_layer.clear_outline_cache");
    glyph_outlines::clear_outline_cache_for_glyph(glyph_name);
    drop(_outline_clear_span);

    Ok(())
}

/// Apply a batch of layer updates in a single WASM call.
///
/// The input is a JSON array of `{ glyphName, layerId, layerData }` entries,
/// where `layerData` is the parsed layer object (NOT a string).  Compared
/// to invoking `update_cached_layer` once per layer, this:
///   * crosses the JS↔WASM boundary once instead of N times,
///   * acquires each cache lock (`FONT_CACHE`, `PREPARED_SUBSET_FONT_CACHE`,
///     `FILTERED_FONT_CACHE`) exactly once for the whole batch,
///   * lets the caller skip a separate `JSON.stringify` per layer in the
///     worker, since the entire batch is one JSON string.
///
/// Behaviour for each individual entry matches `update_cached_layer`:
/// the parsed layer replaces an existing matching layer or is appended
/// to the glyph's layer list, and downstream caches are patched in place
/// when present.  All affected glyphs have their outline caches cleared.
#[wasm_bindgen]
pub fn update_cached_layers_batch(updates_json: &str) -> Result<(), JsValue> {
    let _batch_span = PerfSpan::start("update_cached_layers_batch.total");

    let _parse_span = PerfSpan::start("update_cached_layers_batch.parse_json");
    let raw_entries: serde_json::Value = serde_json::from_str(updates_json)
        .map_err(|e| JsValue::from_str(&format!("Layer batch JSON parse error: {}", e)))?;
    let raw_array = match raw_entries {
        serde_json::Value::Array(arr) => arr,
        _ => {
            return Err(JsValue::from_str(
                "update_cached_layers_batch expects a JSON array",
            ));
        }
    };
    drop(_parse_span);

    if raw_array.is_empty() {
        return Ok(());
    }

    // Pre-parse each layer once so we don't pay the deserialize cost twice
    // when patching the prepared subset and filtered font caches.
    let _convert_span = PerfSpan::start("update_cached_layers_batch.convert_layers");
    let mut parsed: Vec<(String, String, babelfont::Layer)> =
        Vec::with_capacity(raw_array.len());
    for raw in raw_array {
        let mut obj = match raw {
            serde_json::Value::Object(map) => map,
            _ => {
                return Err(JsValue::from_str(
                    "update_cached_layers_batch entry must be an object",
                ));
            }
        };

        let glyph_name = match obj.remove("glyphName") {
            Some(serde_json::Value::String(s)) if !s.is_empty() => s,
            _ => {
                return Err(JsValue::from_str(
                    "Missing or invalid glyphName in batch entry",
                ));
            }
        };
        let layer_id = match obj.remove("layerId") {
            Some(serde_json::Value::String(s)) if !s.is_empty() => s,
            _ => {
                return Err(JsValue::from_str(
                    "Missing or invalid layerId in batch entry",
                ));
            }
        };
        let layer_data = obj
            .remove("layerData")
            .ok_or_else(|| JsValue::from_str("Missing layerData in batch entry"))?;

        let layer: babelfont::Layer = serde_json::from_value(layer_data)
            .map_err(|e| JsValue::from_str(&format!("Layer JSON parse error: {}", e)))?;
        parsed.push((glyph_name, layer_id, layer));
    }
    drop(_convert_span);

    // ── Patch the primary FONT_CACHE under a single lock. ────────
    {
        let _cache_span = PerfSpan::start("update_cached_layers_batch.cache_write");
        let mut cache = FONT_CACHE.lock().unwrap();
        let font = cache
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No font cached. Call store_font() first."))?;

        // Pre-validate every glyph exists before mutating anything so the
        // batch is atomic by construction. Without this, a missing glyph
        // partway through would leave FONT_CACHE partially mutated while
        // FONT_CACHE_EPOCH stays unbumped — the next compile would silently
        // reuse the stale prepared subset.
        {
            let known: std::collections::HashSet<&str> =
                font.glyphs.iter().map(|g| g.name.as_str()).collect();
            for (glyph_name, _, _) in &parsed {
                if !known.contains(glyph_name.as_str()) {
                    return Err(JsValue::from_str(&format!(
                        "Glyph '{}' not found in cached font.",
                        glyph_name
                    )));
                }
            }
        }

        for (glyph_name, layer_id, layer) in &parsed {
            let target_glyph = font
                .glyphs
                .iter_mut()
                .find(|glyph| glyph.name.as_str() == glyph_name.as_str())
                .expect("glyph existence pre-validated above");

            if let Some(existing_layer) = target_glyph
                .layers
                .iter_mut()
                .find(|l| l.id.as_deref() == Some(layer_id.as_str()))
            {
                *existing_layer = layer.clone();
            } else {
                target_glyph.layers.push(layer.clone());
            }
        }
    }

    let next_epoch = FONT_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed) + 1;

    // ── Patch the PREPARED_SUBSET_FONT_CACHE in place. ───────────
    {
        let _prepared_span =
            PerfSpan::start("update_cached_layers_batch.patch_prepared_subset");
        let mut prepared_cache = PREPARED_SUBSET_FONT_CACHE.lock().unwrap();
        if let Some((_subset_key, prepared_epoch, prepared_font)) = prepared_cache.as_mut() {
            let mut any_applied = false;
            for (glyph_name, layer_id, layer) in &parsed {
                if let Some(prepared_glyph) = prepared_font
                    .glyphs
                    .iter_mut()
                    .find(|glyph| glyph.name.as_str() == glyph_name.as_str())
                {
                    if let Some(prepared_layer) = prepared_glyph
                        .layers
                        .iter_mut()
                        .find(|l| l.id.as_deref() == Some(layer_id.as_str()))
                    {
                        *prepared_layer = layer.clone();
                    } else {
                        prepared_glyph.layers.push(layer.clone());
                    }
                    any_applied = true;
                }
            }
            if any_applied {
                *prepared_epoch = next_epoch;
                PREPARED_SUBSET_PATCHED_IN_PLACE.store(true, Ordering::Release);
                perf_mark(&format!(
                    "{}:update_cached_layers_batch.patch_prepared_subset.applied{}",
                    PERF_PREFIX,
                    current_perf_trace_suffix()
                ));
            }
        }
    }

    // ── Patch the FILTERED_FONT_CACHE in place. ──────────────────
    {
        let _filtered_span =
            PerfSpan::start("update_cached_layers_batch.patch_filtered_font");
        let mut filtered_cache = FILTERED_FONT_CACHE.lock().unwrap();
        if let Some(entry) = filtered_cache.as_mut() {
            let mut any_applied = false;
            // Arc::make_mut is O(1) here because WASM is single-threaded.
            let filtered_font = Arc::make_mut(&mut entry.font);
            for (glyph_name, layer_id, layer) in &parsed {
                if let Some(filtered_glyph) = filtered_font
                    .glyphs
                    .iter_mut()
                    .find(|glyph| glyph.name.as_str() == glyph_name.as_str())
                {
                    if let Some(filtered_layer) = filtered_glyph
                        .layers
                        .iter_mut()
                        .find(|l| l.id.as_deref() == Some(layer_id.as_str()))
                    {
                        *filtered_layer = layer.clone();
                    } else {
                        filtered_glyph.layers.push(layer.clone());
                    }
                    any_applied = true;
                }
            }
            if any_applied {
                FILTERED_FONT_PATCHED_IN_PLACE.store(true, Ordering::Release);
                perf_mark(&format!(
                    "{}:update_cached_layers_batch.patch_filtered_font.applied{}",
                    PERF_PREFIX,
                    current_perf_trace_suffix()
                ));
            }
        }
    }

    // ── Clear the outline cache for every affected glyph. ────────
    {
        let _outline_clear_span =
            PerfSpan::start("update_cached_layers_batch.clear_outline_cache");
        // Glyph names may repeat across the batch; collect distinct names.
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for (glyph_name, _, _) in &parsed {
            if seen.insert(glyph_name.as_str()) {
                glyph_outlines::clear_outline_cache_for_glyph(glyph_name);
            }
        }
    }

    Ok(())
}

/// Clear the cached font from memory
#[wasm_bindgen]
pub fn clear_font_cache() {
    let mut cache = FONT_CACHE.lock().unwrap();
    *cache = None;

    LAYOUT_CLOSURE_CACHE.lock().unwrap().clear();
    *LAST_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = None;
    *PREPARED_SUBSET_FONT_CACHE.lock().unwrap() = None;
    *FILTERED_FONT_CACHE.lock().unwrap() = None;
    *FEATURE_FILE_CACHE.lock().unwrap() = None;
    *FEATURE_FEA_STRING_CACHE.lock().unwrap() = None;
    FONT_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed);
    FILTER_EPOCH.fetch_add(1, Ordering::Relaxed);
    FILTERED_FONT_PATCHED_IN_PLACE.store(false, Ordering::Relaxed);

    // Also clear the outline cache
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
    let cache = FONT_CACHE.lock().unwrap();
    let font = cache
        .as_ref()
        .ok_or_else(|| JsValue::from_str("No font cached. Call store_font() first."))?;

    // Call the interpolation module function
    interpolation::interpolate_glyph(font, glyph_name, location_json, extrapolate)
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
    let cache = FONT_CACHE.lock().unwrap();
    let font = cache
        .as_ref()
        .ok_or_else(|| JsValue::from_str("No font cached. Call store_font() first."))?;

    // Parse glyph names array
    let glyph_names: Vec<String> = serde_json::from_str(glyph_names_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse glyph names: {}", e)))?;

    // Call the glyph outlines module function
    glyph_outlines::get_glyphs_outlines(font, &glyph_names, location_json, flatten_components)
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
    let cache = FONT_CACHE.lock().unwrap();
    let font = cache
        .as_ref()
        .ok_or_else(|| JsValue::from_str("No font cached. Call store_font() first."))?;
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
    let closure_set = babelfont::close_layout(font, glyph_set)
        .map_err(|e| JsValue::from_str(&format!("Layout closure computation failed: {:?}", e)))?;
    drop(_compute_span);

    // Convert HashSet<SmolStr> back to sorted Vec<String> for consistent output
    let _result_span = PerfSpan::start("get_layout_closure.result_serialize");
    let mut result: Vec<String> = closure_set.into_iter().map(|s| s.to_string()).collect();

    // Expand closure to include transitively referenced component glyphs
    expand_closure_with_component_deps(font, &mut result);

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

    let font_cache_epoch = FONT_CACHE_EPOCH.load(Ordering::Relaxed);

    let dirty_glyph_names = get_string_array_option(options, "dirty_glyphs");

    let _prepared_lookup_span =
        PerfSpan::start("compile_cached_font_from_last_layout_closure.prepared_subset_lookup");
    let prepared_hit = {
        let prepared_cache = PREPARED_SUBSET_FONT_CACHE.lock().unwrap();
        if let Some((prepared_key, prepared_epoch, prepared_font)) = prepared_cache.as_ref() {
            if prepared_key == &prepared_subset_key {
                Some((*prepared_epoch, prepared_font.clone()))
            } else {
                None
            }
        } else {
            None
        }
    };

    // Check if update_cached_layer already patched the prepared subset in-place.
    // If so, we can skip both patch_subset_glyphs_from_cached_font AND the
    // clone-back into the cache — the cached copy is already up-to-date.
    let already_patched = PREPARED_SUBSET_PATCHED_IN_PLACE.swap(false, Ordering::Acquire);

    let font_clone = if let Some((prepared_epoch, mut prepared_font)) = prepared_hit {
        if prepared_epoch != font_cache_epoch && dirty_glyph_names.is_empty() && !already_patched {
            let _cache_read_span = PerfSpan::start(
                "compile_cached_font_from_last_layout_closure.cache_read",
            );
            let base_font = {
                let cache = FONT_CACHE.lock().unwrap();
                cache
                    .as_ref()
                    .cloned()
                    .ok_or_else(|| JsValue::from_str("No font cached. Call store_font() first."))?
            };
            drop(_cache_read_span);

            let _clone_span =
                PerfSpan::start("compile_cached_font_from_last_layout_closure.clone_cached_font");
            let mut subset_font = base_font;
            drop(_clone_span);

            let _retain_span =
                PerfSpan::start("compile_cached_font_from_last_layout_closure.retain_glyphs");
            if !closure_subset.is_empty() {
                subset_font_using_cached_fea(&mut subset_font, &closure_subset)?;
            }
            drop(_retain_span);

            let mut prepared_cache = PREPARED_SUBSET_FONT_CACHE.lock().unwrap();
            prepared_cache.replace((
                prepared_subset_key.clone(),
                font_cache_epoch,
                subset_font.clone(),
            ));

            subset_font
        } else if already_patched {
            // update_cached_layer already patched the prepared subset in-place.
            // The cached copy is up-to-date — just use prepared_font directly.
            perf_mark(&format!(
                "{}:compile_cached_font_from_last_layout_closure.skip_patch_already_applied{}",
                PERF_PREFIX,
                current_perf_trace_suffix()
            ));

            prepared_font
        } else {
            let _patch_span = PerfSpan::start(
                "compile_cached_font_from_last_layout_closure.patch_dirty_glyphs",
            );
            let patched_count = patch_subset_glyphs_from_cached_font(
                &mut prepared_font,
                &dirty_glyph_names,
            )?;

            if patched_count > 0 || prepared_epoch != font_cache_epoch {
                perf_mark(&format!(
                    "{}:compile_cached_font_from_last_layout_closure.patch_dirty_glyphs.applied{}",
                    PERF_PREFIX,
                    current_perf_trace_suffix()
                ));
                let mut prepared_cache = PREPARED_SUBSET_FONT_CACHE.lock().unwrap();
                prepared_cache.replace((
                    prepared_subset_key.clone(),
                    font_cache_epoch,
                    prepared_font.clone(),
                ));
            } else {
                perf_mark(&format!(
                    "{}:compile_cached_font_from_last_layout_closure.patch_dirty_glyphs.noop{}",
                    PERF_PREFIX,
                    current_perf_trace_suffix()
                ));
            }
            drop(_patch_span);

            prepared_font
        }
    } else {
        // Key mismatch — C3: three tiered strategy to avoid expensive full rebuilds:
        //
        //  1. New subset ⊆ old prepared subset (deletion / selection-shrink):
        //     Reuse the existing prepared font unchanged. The font has a few extra
        //     glyphs compared to the new closure, which is harmless for a preview
        //     compile. No rebuild at all.
        //
        //  2. New subset ⊃ old prepared subset (typing, pure expansion):
        //     Clone the existing prepared font (~20 glyphs) and add only the
        //     new glyphs, rather than cloning the entire 500-glyph font.
        //
        //  3. Otherwise (cold start or no previous prepared cache):
        //     Full rebuild via FONT_CACHE clone + RetainGlyphs.
        let new_glyph_set: HashSet<&str> = closure_subset.iter().map(|s| s.as_str()).collect();

        enum IncrementalOp {
            /// New subset ⊆ old — reuse old prepared font unchanged.
            Subset(babelfont::Font),
            /// New subset ⊃ old — expand old prepared font with added glyphs.
            Superset { font: babelfont::Font, added: Vec<String> },
        }

        let incremental_op = {
            let prepared_cache = PREPARED_SUBSET_FONT_CACHE.lock().unwrap();
            prepared_cache.as_ref().and_then(|(old_key, _old_epoch, old_font)| {
                if old_key.is_empty() {
                    return None;
                }
                let old_set: HashSet<&str> = old_key.split('\u{1F}').collect();
                let added: Vec<String> = new_glyph_set
                    .iter()
                    .filter(|g| !old_set.contains(**g))
                    .map(|s| s.to_string())
                    .collect();
                if added.is_empty() {
                    // New set has no glyphs not in old set → it's ⊆ old.
                    // Reuse old prepared font as-is.
                    Some(IncrementalOp::Subset(old_font.clone()))
                } else {
                    // New set has additions. Only do incremental expand (not full
                    // rebuild) — any removed glyphs just stay in the prepared font
                    // as harmless extras.
                    Some(IncrementalOp::Superset { font: old_font.clone(), added })
                }
            })
        };

        match incremental_op {
            Some(IncrementalOp::Subset(existing_font)) => {
                // C3a: subset (deletion/shrink) — reuse existing prepared font unchanged.
                // Update the key so future incremental ops use the smaller set as the base.
                perf_mark(&format!(
                    "{}:compile_cached_font_from_last_layout_closure.incremental_reuse{}",
                    PERF_PREFIX,
                    current_perf_trace_suffix()
                ));
                {
                    let mut prepared_cache = PREPARED_SUBSET_FONT_CACHE.lock().unwrap();
                    // Keep the font object but update the key to the new (smaller) subset
                    // so the next keystroke's incremental-expand starts from the right baseline.
                    if let Some(entry) = prepared_cache.as_mut() {
                        entry.0 = prepared_subset_key.clone();
                        entry.1 = font_cache_epoch;
                    }
                }
                existing_font
            }
            Some(IncrementalOp::Superset { mut font, added: added_glyphs }) => {
                // C3b: superset (typing) — expand existing prepared font with added glyphs.
                let _expand_span = PerfSpan::start(
                    "compile_cached_font_from_last_layout_closure.incremental_expand",
                );
                perf_mark(&format!(
                    "{}:compile_cached_font_from_last_layout_closure.incremental_expand.added_count={}{}",
                    PERF_PREFIX,
                    added_glyphs.len(),
                    current_perf_trace_suffix()
                ));

                // SubsetLayout (inside subset_font_using_cached_fea) calls
                // FeatureFile::new_from_fea(&fea, Some(&old_glyphs), ...) which validates
                // every glyph name referenced in the FEA against old_glyphs.  The full
                // features reference ~1000 glyphs, but font.glyphs only holds the old
                // ~30-glyph subset — causing "not a known glyph" errors for every name
                // in the FEA not in that small list.
                //
                // Solution: add lightweight stub Glyphs (name only, no layer data) for
                // every full-font glyph not already in font.glyphs before subsetting.
                // SubsetLayout sees the full glyph universe → validation passes → correctly
                // prunes GSUB/GPOS rules to the new closure.
                // RetainGlyphs (called inside subset_font_using_cached_fea) then drops all
                // stubs because they are not in closure_subset.
                //
                // This is far cheaper than full_font.clone() (which copies all path data
                // for 1000+ glyphs); stubs carry only a SmolStr name.
                {
                    let cache = FONT_CACHE.lock().unwrap();
                    let full_font = cache.as_ref().ok_or_else(|| {
                        JsValue::from_str("No font cached. Call store_font() first.")
                    })?;

                    // Add truly new glyphs with full layer/path data.
                    for name in &added_glyphs {
                        if let Some(glyph) =
                            full_font.glyphs.iter().find(|g| g.name.as_str() == name.as_str())
                        {
                            font.glyphs.push(glyph.clone());
                        }
                    }

                    // Restore full features — the cached prepared font has already-pruned
                    // features that are missing GSUB rules for the newly added glyphs.
                    font.features = full_font.features.clone();

                    // Restore kern groups and masters.
                    font.first_kern_groups = full_font.first_kern_groups.clone();
                    font.second_kern_groups = full_font.second_kern_groups.clone();
                    font.masters = full_font.masters.clone();

                    // Add stub glyphs for every full-font glyph name not already present.
                    // Stubs carry only the name (no layers/paths) and exported=false so
                    // they are excluded from the filter pipeline's exported-names set.
                    // Collect stub names first (releasing the borrow on font.glyphs)
                    // before pushing, to satisfy the borrow checker.
                    let existing: std::collections::HashSet<smol_str::SmolStr> =
                        font.glyphs.iter().map(|g| g.name.clone()).collect();
                    let stub_names: Vec<smol_str::SmolStr> = full_font
                        .glyphs
                        .iter()
                        .filter(|g| !existing.contains(&g.name))
                        .map(|g| g.name.clone())
                        .collect();
                    for name in stub_names {
                        font.glyphs.push(babelfont::Glyph {
                            name,
                            exported: false,
                            ..babelfont::Glyph::default()
                        });
                    }
                }

                if !closure_subset.is_empty() {
                    subset_font_using_cached_fea(&mut font, &closure_subset)?
                }
                drop(_expand_span);

                {
                    let mut prepared_cache = PREPARED_SUBSET_FONT_CACHE.lock().unwrap();
                    prepared_cache.replace((
                        prepared_subset_key.clone(),
                        font_cache_epoch,
                        font.clone(),
                    ));
                }
                font
            }
            None => {
                // C3c: cold start — full rebuild
        let _cache_read_span = PerfSpan::start(
            "compile_cached_font_from_last_layout_closure.cache_read",
        );
        let base_font = {
            let cache = FONT_CACHE.lock().unwrap();
            cache
                .as_ref()
                .cloned()
                .ok_or_else(|| JsValue::from_str("No font cached. Call store_font() first."))?
        };
        drop(_cache_read_span);

        let _clone_span =
            PerfSpan::start("compile_cached_font_from_last_layout_closure.clone_cached_font");
        let mut subset_font = base_font;
        drop(_clone_span);

        let _retain_span =
            PerfSpan::start("compile_cached_font_from_last_layout_closure.retain_glyphs");
        if !closure_subset.is_empty() {
            subset_font_using_cached_fea(&mut subset_font, &closure_subset)?;
        }
        drop(_retain_span);

        {
            let mut prepared_cache = PREPARED_SUBSET_FONT_CACHE.lock().unwrap();
            prepared_cache.replace((
                prepared_subset_key.clone(),
                font_cache_epoch,
                subset_font.clone(),
            ));
        }
        subset_font
            } // end None arm (full rebuild)
        } // end match incremental_op
    };
    drop(_prepared_lookup_span);

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

    // Use filtered font cache: apply_filters() once, then reuse with surgical glyph patching.
    let current_filter_epoch = FILTER_EPOCH.load(Ordering::Relaxed);
    let current_options_fp = options_filter_fingerprint(&compilation_options);

    let _filter_cache_span = PerfSpan::start("compile_cached_font_from_last_layout_closure.filter_cache");
    let filtered_font = {
        let mut filter_cache = FILTERED_FONT_CACHE.lock().unwrap();
        let cache_hit = filter_cache.as_ref().map_or(false, |entry| {
            entry.subset_key == prepared_subset_key
                && entry.filter_epoch == current_filter_epoch
                && entry.options_fingerprint == current_options_fp
        });

        // D2: consume the flag set by update_cached_layer() so we know whether
        // the cached filtered font is already up-to-date for the dirty glyph.
        let filter_already_patched = FILTERED_FONT_PATCHED_IN_PLACE.swap(false, Ordering::Acquire);

        if cache_hit {
            // Cache hit: clone the Arc handle (O(1)) and patch dirty glyphs if needed.
            let _clone_span = PerfSpan::start("compile_cached_font_from_last_layout_closure.filter_cache.clone");
            let filtered_arc = if filter_already_patched || dirty_glyph_names.is_empty() {
                // Fast path: update_cached_layer already patched the filtered font
                // in-place, or no dirty glyphs at all — just clone the Arc (O(1)).
                perf_mark(&format!(
                    "{}:compile_cached_font_from_last_layout_closure.filter_cache.hit.no_patch{}",
                    PERF_PREFIX,
                    current_perf_trace_suffix()
                ));
                Arc::clone(&filter_cache.as_ref().unwrap().font)
            } else {
                // Slow path: need to incorporate dirty glyphs not yet in the cached filtered font.
                let mut filtered: babelfont::Font = (*filter_cache.as_ref().unwrap().font).clone();
                drop(_clone_span);

                let _patch_span = PerfSpan::start("compile_cached_font_from_last_layout_closure.filter_cache.patch_dirty");
                for dirty_name in &dirty_glyph_names {
                    if let Some(source_glyph) = font_clone.glyphs.iter().find(|g| g.name.as_str() == dirty_name.as_str()) {
                        if let Some(target_glyph) = filtered.glyphs.iter_mut().find(|g| g.name.as_str() == dirty_name.as_str()) {
                            target_glyph.layers = source_glyph.layers.clone();
                        }
                    }
                }
                drop(_patch_span);

                Arc::new(filtered)
            };

            perf_mark(&format!(
                "{}:compile_cached_font_from_last_layout_closure.filter_cache.hit{}",
                PERF_PREFIX,
                current_perf_trace_suffix()
            ));
            filtered_arc
        } else {
            // Cache miss: run full filter pipeline and cache result
            let _apply_span = PerfSpan::start("compile_cached_font_from_last_layout_closure.filter_cache.apply_filters");
            // Phase A4 benchmark point: FEA parses inside the subset/filter pipeline.
            let _fea_parse_pipeline_span = PerfSpan::start("compile_cached_font_from_last_layout_closure.filter_cache.apply_filters.fea_parse_pipeline");
            let filtered = apply_filter_pipeline(&font_clone, &compilation_options)?;
            drop(_fea_parse_pipeline_span);
            drop(_apply_span);

            // Store as Arc so future cache hits can clone the handle in O(1).
            let filtered_arc = Arc::new(filtered);
            *filter_cache = Some(FilteredFontCacheEntry {
                subset_key: prepared_subset_key.clone(),
                filter_epoch: current_filter_epoch,
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

    let _post_ir_compile_span =
        PerfSpan::start("compile_cached_font_from_last_layout_closure.post_ir_compile");

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
    let cache = FONT_CACHE.lock().unwrap();
    let font = cache
        .as_ref()
        .ok_or_else(|| JsValue::from_str("No font cached. Call store_font() first."))?;
    drop(_cache_read_span);

    // Clone the font for compilation (in case we need to apply filters)
    let _clone_span = PerfSpan::start("compile_cached_font.clone_cached_font");
    let mut font_clone = font.clone();
    drop(_clone_span);

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
