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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use yrs::updates::decoder::Decode;
use yrs::{Array as _, GetString, Map as _, ReadTxn, Transact};

// Font reading module (using read-fonts/skrifa)
mod font_reader;
pub use font_reader::{
    get_font_axes, get_font_features, get_font_features_with_tables, get_glyph_name,
    get_glyph_order, get_stylistic_set_names,
};

// Interpolation module
mod interpolation;

// Rust-authored Yjs batch operations for master add / reinterpolation
mod batch_yjs_ops;

pub use batch_yjs_ops::{
    add_master_with_interpolated_layers_yjs, reinterpolate_master_layers_yjs,
};

// Glyph outlines module
mod glyph_outlines;

// Fontspector QC module
mod fontspector;
pub use fontspector::run_fontspector;

// Global storage for cached fonts
// Use a Mutex to allow safe mutable access from multiple calls

/// Canonical babelfont JSON as serde_json::Value — THE authoritative state.
/// It is refreshed from bootstrap/reload full-font loads or the Rust Y.Doc,
/// and babelfont::Font is rebuilt lazily from this cache when needed for
/// compilation or interpolation.
static CANONICAL_JSON_CACHE: Mutex<Option<serde_json::Value>> = Mutex::new(None);
static CANONICAL_GLYPH_INDEX_CACHE: Mutex<Option<HashMap<String, usize>>> = Mutex::new(None);

/// Subset babelfont JSON — mirrors the full CANONICAL_JSON_CACHE but
/// retains only the glyphs needed for the current editing subset.
/// Yjs-driven glyph refreshes update this cache opportunistically when the
/// affected glyphs are part of the active subset.
static SUBSET_JSON_CACHE: Mutex<Option<(String, u64, serde_json::Value)>> = Mutex::new(None);
static SUBSET_GLYPH_INDEX_CACHE: Mutex<Option<(String, HashMap<String, usize>)>> = Mutex::new(None);

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

/// Yjs CRDT document maintained in Rust — receives binary Yjs updates directly
/// from the JavaScript PatchSyncEngine, eliminating full-JSON round-trips for
/// incremental cache maintenance.
static Y_DOC: Mutex<Option<yrs::Doc>> = Mutex::new(None);

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

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
struct LayerTarget {
    glyph_name: String,
    layer_id: String,
}

fn build_glyph_index(font_json: &serde_json::Value) -> HashMap<String, usize> {
    font_json
        .get("glyphs")
        .and_then(|value| value.as_array())
        .map(|glyphs| {
            glyphs
                .iter()
                .enumerate()
                .filter_map(|(index, glyph)| {
                    glyph
                        .get("name")
                        .and_then(|value| value.as_str())
                        .map(|name| (name.to_string(), index))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn set_canonical_json_cache(json_value: serde_json::Value) {
    *CANONICAL_JSON_CACHE.lock().unwrap() = Some(json_value.clone());
    *CANONICAL_GLYPH_INDEX_CACHE.lock().unwrap() = Some(build_glyph_index(&json_value));
}

fn store_subset_cache_json(subset_key: &str, subset_json: serde_json::Value) -> u64 {
    let next_epoch = {
        let mut subset_cache = SUBSET_JSON_CACHE.lock().unwrap();
        let next_epoch = subset_cache
            .as_ref()
            .map_or(1, |(_, epoch, _)| epoch.saturating_add(1));
        *subset_cache = Some((subset_key.to_string(), next_epoch, subset_json.clone()));
        next_epoch
    };

    *SUBSET_GLYPH_INDEX_CACHE.lock().unwrap() =
        Some((subset_key.to_string(), build_glyph_index(&subset_json)));

    next_epoch
}

fn store_subset_font_cache(
    subset_key: &str,
    subset_font: &babelfont::Font,
) -> Result<u64, JsValue> {
    let subset_json = serde_json::to_value(subset_font)
        .map_err(|e| JsValue::from_str(&format!("Subset font serialization error: {}", e)))?;
    let subset_epoch = store_subset_cache_json(subset_key, subset_json);

    let mut subset_font_cache = SUBSET_FONT_CACHE.lock().unwrap();
    *subset_font_cache = Some((subset_key.to_string(), subset_epoch, subset_font.clone()));
    SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(subset_epoch, Ordering::Relaxed);

    Ok(subset_epoch)
}

fn replace_glyph_json_entry(
    font_json: &mut serde_json::Value,
    glyph_index: &mut HashMap<String, usize>,
    glyph_name: &str,
    new_glyph_json: Option<serde_json::Value>,
) -> bool {
    let Some(glyphs) = font_json
        .get_mut("glyphs")
        .and_then(|value| value.as_array_mut())
    else {
        return false;
    };

    match new_glyph_json {
        Some(glyph_json) => {
            if let Some(&index) = glyph_index.get(glyph_name) {
                if index < glyphs.len() {
                    glyphs[index] = glyph_json;
                    return true;
                }
            }

            glyph_index.insert(glyph_name.to_string(), glyphs.len());
            glyphs.push(glyph_json);
            true
        }
        None => {
            let Some(index) = glyph_index.remove(glyph_name) else {
                return false;
            };
            if index >= glyphs.len() {
                return false;
            }

            glyphs.remove(index);
            for cached_index in glyph_index.values_mut() {
                if *cached_index > index {
                    *cached_index -= 1;
                }
            }
            true
        }
    }
}

fn replace_layer_json_entry(
    font_json: &mut serde_json::Value,
    glyph_index: &HashMap<String, usize>,
    glyph_name: &str,
    layer_id: &str,
    new_layer_json: Option<serde_json::Value>,
) -> bool {
    let Some(glyphs) = font_json
        .get_mut("glyphs")
        .and_then(|value| value.as_array_mut())
    else {
        return false;
    };
    let Some(&glyph_position) = glyph_index.get(glyph_name) else {
        return false;
    };
    let Some(glyph_json) = glyphs.get_mut(glyph_position) else {
        return false;
    };
    replace_layer_in_glyph_json(glyph_json, layer_id, new_layer_json)
}

fn replace_layer_in_glyph_json(
    glyph_json: &mut serde_json::Value,
    layer_id: &str,
    new_layer_json: Option<serde_json::Value>,
) -> bool {
    let Some(layers) = glyph_json
        .get_mut("layers")
        .and_then(|value| value.as_array_mut())
    else {
        return false;
    };

    let layer_position = layers.iter().position(|layer| {
        layer
            .get("id")
            .and_then(|value| value.as_str())
            .is_some_and(|id| id == layer_id)
    });

    match new_layer_json {
        Some(layer_json) => {
            if let Some(index) = layer_position {
                layers[index] = layer_json;
            } else {
                layers.push(layer_json);
            }
            true
        }
        None => {
            if let Some(index) = layer_position {
                layers.remove(index);
                return true;
            }
            false
        }
    }
}

fn replace_glyph_in_font_cache(
    font: &mut babelfont::Font,
    glyph_name: &str,
    new_glyph_json: Option<&serde_json::Value>,
) -> Result<bool, JsValue> {
    let glyph_index = font
        .glyphs
        .iter()
        .position(|glyph| glyph.name.as_str() == glyph_name);

    match new_glyph_json {
        Some(glyph_json) => {
            let glyph: babelfont::Glyph =
                serde_json::from_value(glyph_json.clone()).map_err(|e| {
                    JsValue::from_str(&format!(
                        "Glyph deserialization error for {}: {}",
                        glyph_name, e
                    ))
                })?;

            if let Some(index) = glyph_index {
                font.glyphs[index] = glyph;
            } else {
                font.glyphs.push(glyph);
            }
            Ok(true)
        }
        None => {
            if let Some(index) = glyph_index {
                font.glyphs.remove(index);
                return Ok(true);
            }
            Ok(false)
        }
    }
}

fn replace_layer_in_font_cache(
    font: &mut babelfont::Font,
    glyph_name: &str,
    layer_id: &str,
    new_layer_json: Option<&serde_json::Value>,
) -> Result<bool, JsValue> {
    let Some(glyph_index) = font
        .glyphs
        .iter()
        .position(|glyph| glyph.name.as_str() == glyph_name)
    else {
        return Ok(false);
    };

    let glyph = &mut font.glyphs[glyph_index];
    let layer_index = glyph
        .layers
        .iter()
        .position(|layer| layer.id.as_deref() == Some(layer_id));

    match new_layer_json {
        Some(layer_json) => {
            let layer: babelfont::Layer =
                serde_json::from_value(layer_json.clone()).map_err(|e| {
                    JsValue::from_str(&format!(
                        "Layer deserialization error for {}::{}: {}",
                        glyph_name, layer_id, e
                    ))
                })?;
            if let Some(index) = layer_index {
                glyph.layers[index] = layer;
            } else {
                glyph.layers.push(layer);
            }
            Ok(true)
        }
        None => {
            if let Some(index) = layer_index {
                glyph.layers.remove(index);
                return Ok(true);
            }
            Ok(false)
        }
    }
}

fn layout_closure_cache_key(font_revision: &str, subset_key: &str) -> String {
    format!("{}::{}", font_revision, subset_key)
}

fn prune_layout_closure_cache_for_subset(
    cache: &mut HashMap<String, Vec<String>>,
    subset_key: &str,
) {
    let suffix = format!("::{}", subset_key);
    cache.retain(|cache_key, _| !cache_key.ends_with(&suffix));
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
    let built_epoch = SUBSET_FONT_CACHE_BUILT_AT_EPOCH.load(Ordering::Relaxed);

    let subset_cache = SUBSET_JSON_CACHE.lock().unwrap();
    let Some((subset_key, subset_epoch, subset_json)) = subset_cache.as_ref() else {
        return Ok(None);
    };
    if subset_key != expected_subset_key {
        return Ok(None);
    }

    if *subset_epoch == built_epoch {
        let font_cache = SUBSET_FONT_CACHE.lock().unwrap();
        if let Some((key, cache_epoch, font)) = font_cache.as_ref() {
            if key == expected_subset_key && *cache_epoch == *subset_epoch {
                return Ok(Some(font.clone()));
            }
        }
    }

    let font: babelfont::Font = serde_json::from_value(subset_json.clone())
        .map_err(|e| JsValue::from_str(&format!("Subset font deserialization error: {}", e)))?;

    let mut font_cache = SUBSET_FONT_CACHE.lock().unwrap();
    *font_cache = Some((expected_subset_key.to_string(), *subset_epoch, font.clone()));
    SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(*subset_epoch, Ordering::Relaxed);

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
    if options.drop_incompatible_paths {
        h |= 1;
    }
    if options.dont_use_production_names {
        h |= 4;
    }
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
    let context =
        match js_sys::Reflect::get(&global, &JsValue::from_str(PERF_TRACE_CONTEXT_GLOBAL_KEY)) {
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
        let start_mark = format!(
            "{}:{}#{}:start{}",
            PERF_PREFIX, stage, span_id, trace_suffix
        );
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
    font_revision: &str,
    glyph_names_json: &str,
) -> Result<(String, Vec<String>), JsValue> {
    let _parse_span = PerfSpan::start("layout_closure_cached.parse_input");
    let glyph_names: Vec<String> = serde_json::from_str(glyph_names_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse glyph names JSON: {}", e)))?;
    drop(_parse_span);

    let _key_span = PerfSpan::start("layout_closure_cached.compute_key");
    let subset_key = canonical_subset_key(glyph_names.clone());
    let cache_key = layout_closure_cache_key(font_revision, &subset_key);
    drop(_key_span);

    let _lookup_span = PerfSpan::start("layout_closure_cached.lookup");
    if let Some(cached) = LAYOUT_CLOSURE_CACHE.lock().unwrap().get(&cache_key) {
        let output = cached.clone();
        drop(_lookup_span);
        return Ok((cache_key, output));
    }
    drop(_lookup_span);

    let _cache_read_span = PerfSpan::start("layout_closure_cached.cache_read_font");
    let font = get_or_rebuild_font_cache()?;
    drop(_cache_read_span);

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
    let mut closure_cache = LAYOUT_CLOSURE_CACHE.lock().unwrap();
    prune_layout_closure_cache_for_subset(&mut closure_cache, &subset_key);
    closure_cache.insert(cache_key.clone(), result.clone());
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
    let compiled_font = compile_with_feature_debug_context(&font, &options, "compile_babelfont")?;
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

// ── Yjs / yrs helpers ────────────────────────────────────────────────────────

/// Convert a yrs `Any` primitive to a `serde_json::Value`.
fn yrs_any_to_json(any: &yrs::Any) -> serde_json::Value {
    match any {
        yrs::Any::Null | yrs::Any::Undefined => serde_json::Value::Null,
        yrs::Any::Bool(b) => serde_json::Value::Bool(*b),
        yrs::Any::Number(n) => {
            let n = *n;
            if n.fract() == 0.0 && n >= i64::MIN as f64 && n <= i64::MAX as f64 {
                serde_json::Value::Number(serde_json::Number::from(n as i64))
            } else {
                serde_json::Number::from_f64(n)
                    .map(serde_json::Value::Number)
                    .unwrap_or(serde_json::Value::Null)
            }
        }
        yrs::Any::BigInt(n) => serde_json::Value::Number(serde_json::Number::from(*n)),
        yrs::Any::String(s) => serde_json::Value::String(s.to_string()),
        yrs::Any::Buffer(_) => serde_json::Value::Null, // not used in babelfont
        yrs::Any::Array(arr) => serde_json::Value::Array(arr.iter().map(yrs_any_to_json).collect()),
        yrs::Any::Map(map) => {
            let obj: serde_json::Map<String, serde_json::Value> = map
                .iter()
                .map(|(k, v)| (k.to_string(), yrs_any_to_json(v)))
                .collect();
            serde_json::Value::Object(obj)
        }
    }
}

/// Recursively convert a yrs `Value` (which may be a Y.Map / Y.Array / Y.Text /
/// primitive) to a `serde_json::Value`.
fn yrs_value_to_json<T: ReadTxn>(value: yrs::types::Value, txn: &T) -> serde_json::Value {
    match value {
        yrs::types::Value::Any(any) => yrs_any_to_json(&any),
        yrs::types::Value::YMap(map_ref) => yrs_map_to_json(&map_ref, txn),
        yrs::types::Value::YArray(arr_ref) => yrs_array_to_json(&arr_ref, txn),
        yrs::types::Value::YText(text_ref) => serde_json::Value::String(text_ref.get_string(txn)),
        _ => serde_json::Value::Null,
    }
}

fn yrs_map_to_json<T: ReadTxn>(map_ref: &yrs::MapRef, txn: &T) -> serde_json::Value {
    let entries: Vec<(String, serde_json::Value)> = map_ref
        .iter(txn)
        .map(|(k, v)| (k.to_string(), yrs_value_to_json(v, txn)))
        .collect();

    let numeric_indices: Option<Vec<usize>> = if !entries.is_empty()
        && entries.iter().all(|(key, _)| {
            !key.is_empty()
                && key.chars().all(|ch| ch.is_ascii_digit())
                && key
                    .parse::<usize>()
                    .map(|idx| idx.to_string() == *key)
                    .unwrap_or(false)
        }) {
        Some(
            entries
                .iter()
                .map(|(key, _)| key.parse::<usize>().unwrap())
                .collect(),
        )
    } else {
        None
    };

    if let Some(indices) = numeric_indices {
        let max_idx = indices.iter().copied().max().unwrap_or(0);
        let mut arr = vec![serde_json::Value::Null; max_idx + 1];
        for ((_, value), idx) in entries.into_iter().zip(indices.into_iter()) {
            arr[idx] = value;
        }
        return serde_json::Value::Array(arr);
    }

    let obj: serde_json::Map<String, serde_json::Value> = entries.into_iter().collect();
    serde_json::Value::Object(obj)
}

fn yrs_array_to_json<T: ReadTxn>(arr_ref: &yrs::ArrayRef, txn: &T) -> serde_json::Value {
    let arr: Vec<serde_json::Value> = arr_ref
        .iter(txn)
        .map(|v| yrs_value_to_json(v, txn))
        .collect();
    serde_json::Value::Array(arr)
}

fn ydoc_layer_to_json<T: ReadTxn>(
    layer_id: &str,
    layer_val: yrs::types::Value,
    txn: &T,
) -> serde_json::Value {
    let layer_json = yrs_value_to_json(layer_val, txn);
    let mut layer_obj = match layer_json {
        serde_json::Value::Object(o) => o,
        _ => serde_json::Map::new(),
    };
    if !layer_obj.contains_key("id") {
        layer_obj.insert(
            "id".to_string(),
            serde_json::Value::String(layer_id.to_string()),
        );
    }
    if let Some(serde_json::Value::Array(shapes)) = layer_obj.get_mut("shapes") {
        for shape in shapes.iter_mut() {
            let serde_json::Value::Object(ref mut obj) = shape else {
                continue;
            };
            if obj.contains_key("nodes") && !obj.contains_key("closed") {
                obj.insert("closed".to_string(), serde_json::Value::Bool(false));
            }
        }
    }
    serde_json::Value::Object(layer_obj)
}

/// Convert a single glyph Y.Map to a babelfont glyph JSON object.
/// Handles the special `layers` sub-map (Y.Map<layer_id, Y.Map>) → array.
fn ydoc_glyph_to_json<T: ReadTxn>(
    glyph_name: &str,
    glyph_map: &yrs::MapRef,
    txn: &T,
) -> serde_json::Value {
    let mut glyph_obj = serde_json::Map::new();
    for (gk, gv) in glyph_map.iter(txn) {
        if gk == "layers" {
            if let yrs::types::Value::YMap(layers_map) = gv {
                let mut layers_array: Vec<serde_json::Value> = Vec::new();
                for (layer_id, layer_val) in layers_map.iter(txn) {
                    layers_array.push(ydoc_layer_to_json(&layer_id, layer_val, txn));
                }
                glyph_obj.insert("layers".to_string(), serde_json::Value::Array(layers_array));
            } else {
                glyph_obj.insert(gk.to_string(), yrs_value_to_json(gv, txn));
            }
        } else {
            glyph_obj.insert(gk.to_string(), yrs_value_to_json(gv, txn));
        }
    }
    // Ensure glyph has its name field
    if !glyph_obj.contains_key("name") {
        glyph_obj.insert(
            "name".to_string(),
            serde_json::Value::String(glyph_name.to_string()),
        );
    }
    serde_json::Value::Object(glyph_obj)
}

/// Convert the full Y.Doc (keyed by root map "font") to a babelfont JSON Value.
///
/// Mirrors `yDocToJson` from `change-bridge-ydoc.ts`:
/// - `glyphs` Y.Map<glyph_name, Y.Map> → JSON array of glyph objects
/// - Each glyph's `layers` Y.Map<layer_id, Y.Map> → JSON array of layer objects
/// - Everything else follows the standard Y.type → JSON mapping
fn ydoc_to_babelfont_json_with_txn<T: ReadTxn>(txn: &T) -> serde_json::Value {
    let Some(font_map) = txn.get_map("font") else {
        return serde_json::Value::Object(serde_json::Map::new());
    };
    let mut result = serde_json::Map::new();

    for (key, value) in font_map.iter(txn) {
        if key == "glyphs" {
            if let yrs::types::Value::YMap(glyphs_map) = value {
                let mut glyphs_array: Vec<serde_json::Value> = Vec::new();
                for (glyph_name, glyph_val) in glyphs_map.iter(txn) {
                    if let yrs::types::Value::YMap(glyph_map) = glyph_val {
                        glyphs_array.push(ydoc_glyph_to_json(glyph_name, &glyph_map, txn));
                    }
                }
                result.insert("glyphs".to_string(), serde_json::Value::Array(glyphs_array));
            } else {
                result.insert(key.to_string(), yrs_value_to_json(value, txn));
            }
        } else {
            result.insert(key.to_string(), yrs_value_to_json(value, txn));
        }
    }

    serde_json::Value::Object(result)
}

/// Extract and return the JSON for a single named glyph from the Rust Y.Doc.
/// Returns None if the glyph is not found or Y_DOC is not initialized.
fn ydoc_get_glyph_json_with_txn<T: ReadTxn>(
    glyph_name: &str,
    txn: &T,
) -> Option<serde_json::Value> {
    let font_map = txn.get_map("font")?;
    let glyphs_val = font_map.get(txn, "glyphs")?;
    if let yrs::types::Value::YMap(glyphs_map) = glyphs_val {
        let glyph_val = glyphs_map.get(txn, glyph_name)?;
        if let yrs::types::Value::YMap(glyph_map) = glyph_val {
            return Some(ydoc_glyph_to_json(glyph_name, &glyph_map, txn));
        }
    }
    None
}

fn ydoc_get_layer_json_with_txn<T: ReadTxn>(
    glyph_name: &str,
    layer_id: &str,
    txn: &T,
) -> Option<serde_json::Value> {
    let font_map = txn.get_map("font")?;
    let glyphs_val = font_map.get(txn, "glyphs")?;
    let yrs::types::Value::YMap(glyphs_map) = glyphs_val else {
        return None;
    };
    let glyph_val = glyphs_map.get(txn, glyph_name)?;
    let yrs::types::Value::YMap(glyph_map) = glyph_val else {
        return None;
    };
    let layers_val = glyph_map.get(txn, "layers")?;
    let yrs::types::Value::YMap(layers_map) = layers_val else {
        return None;
    };
    let layer_val = layers_map.get(txn, layer_id)?;
    Some(ydoc_layer_to_json(layer_id, layer_val, txn))
}

fn ydoc_get_top_level_json_with_txn<T: ReadTxn>(key: &str, txn: &T) -> Option<serde_json::Value> {
    let font_map = txn.get_map("font")?;
    let value = font_map.get(txn, key)?;
    Some(yrs_value_to_json(value, txn))
}

fn extract_string_array(value: &serde_json::Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(|text| text.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn parse_apply_yjs_update_metadata(
    update_metadata_json: &str,
) -> (Vec<String>, Vec<String>, Vec<LayerTarget>) {
    if update_metadata_json.is_empty() || update_metadata_json == "[]" {
        return (Vec::new(), Vec::new(), Vec::new());
    }

    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(update_metadata_json) else {
        return (Vec::new(), Vec::new(), Vec::new());
    };

    if parsed.is_array() {
        return (extract_string_array(&parsed), Vec::new(), Vec::new());
    }

    let Some(object) = parsed.as_object() else {
        return (Vec::new(), Vec::new(), Vec::new());
    };

    let changed_glyphs = object
        .get("changedGlyphs")
        .map(extract_string_array)
        .unwrap_or_default();
    let non_glyph_change_hints = object
        .get("nonGlyphChangeHints")
        .map(extract_string_array)
        .unwrap_or_default();
    let mut seen_layer_targets = HashSet::new();
    let layer_targets = object
        .get("layerTargets")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let object = item.as_object()?;
                    let glyph_name = object.get("glyphName")?.as_str()?;
                    let layer_id = object.get("layerId")?.as_str()?;
                    if glyph_name.is_empty() || layer_id.is_empty() {
                        return None;
                    }
                    let key = format!("{}@@{}", glyph_name, layer_id);
                    if !seen_layer_targets.insert(key) {
                        return None;
                    }
                    Some(LayerTarget {
                        glyph_name: glyph_name.to_string(),
                        layer_id: layer_id.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    (changed_glyphs, non_glyph_change_hints, layer_targets)
}

fn replace_top_level_json_entry(
    font_json: &mut serde_json::Value,
    key: &str,
    new_value: Option<serde_json::Value>,
) -> bool {
    let Some(font_object) = font_json.as_object_mut() else {
        return false;
    };

    match new_value {
        Some(value) => {
            if font_object.get(key) == Some(&value) {
                return false;
            }
            font_object.insert(key.to_string(), value);
            true
        }
        None => font_object.remove(key).is_some(),
    }
}

fn replace_masters_kerning_in_json(
    font_json: &mut serde_json::Value,
    masters_json: Option<&serde_json::Value>,
) -> bool {
    let Some(font_object) = font_json.as_object_mut() else {
        return false;
    };
    let Some(existing_masters) = font_object
        .get_mut("masters")
        .and_then(|value| value.as_array_mut())
    else {
        return false;
    };
    let Some(incoming_masters) = masters_json.and_then(|value| value.as_array()) else {
        return false;
    };

    let mut changed = false;
    for (existing_master, incoming_master) in
        existing_masters.iter_mut().zip(incoming_masters.iter())
    {
        let Some(existing_object) = existing_master.as_object_mut() else {
            continue;
        };

        match incoming_master.get("kerning").cloned() {
            Some(kerning_value) => {
                if existing_object.get("kerning") != Some(&kerning_value) {
                    existing_object.insert("kerning".to_string(), kerning_value);
                    changed = true;
                }
            }
            None => {
                if existing_object.remove("kerning").is_some() {
                    changed = true;
                }
            }
        }
    }

    changed
}

fn replace_masters_in_font_cache(
    font: &mut babelfont::Font,
    masters_json: Option<&serde_json::Value>,
) -> Result<(), JsValue> {
    let Some(masters_json) = masters_json else {
        return Ok(());
    };

    font.masters = serde_json::from_value(masters_json.clone()).map_err(|error| {
        JsValue::from_str(&format!(
            "apply_yjs_update: failed to deserialize masters cache update: {}",
            error
        ))
    })?;

    Ok(())
}

fn refresh_masters_related_caches_from_ydoc<T: ReadTxn>(txn: &T) -> Result<(), JsValue> {
    let masters_json = ydoc_get_top_level_json_with_txn("masters", txn);

    let mut canonical_missing = false;
    {
        let mut canonical_lock = CANONICAL_JSON_CACHE.lock().unwrap();
        if let Some(ref mut canonical) = *canonical_lock {
            replace_top_level_json_entry(canonical, "masters", masters_json.clone());
        } else {
            canonical_missing = true;
        }
    }

    if canonical_missing {
        let rebuilt = ydoc_to_babelfont_json_with_txn(txn);
        set_canonical_json_cache(rebuilt);

        *FONT_CACHE.lock().unwrap() = None;
        *SUBSET_JSON_CACHE.lock().unwrap() = None;
        *SUBSET_GLYPH_INDEX_CACHE.lock().unwrap() = None;
        *SUBSET_FONT_CACHE.lock().unwrap() = None;
        *FILTERED_FONT_CACHE.lock().unwrap() = None;

        FONT_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed);
        FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
        SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
        FILTER_EPOCH.fetch_add(1, Ordering::Relaxed);
        glyph_outlines::clear_outline_cache();
        return Ok(());
    }

    let mut subset_cache_refresh: Option<(String, u64)> = None;
    {
        let mut subset_lock = SUBSET_JSON_CACHE.lock().unwrap();
        if let Some((ref subset_key, ref mut subset_epoch, ref mut subset_json)) = *subset_lock {
            if replace_top_level_json_entry(subset_json, "masters", masters_json.clone()) {
                *subset_epoch = subset_epoch.saturating_add(1);
                subset_cache_refresh = Some((subset_key.clone(), *subset_epoch));
            }
        }
    }

    if let Some(ref mut font_cache) = *FONT_CACHE.lock().unwrap() {
        replace_masters_in_font_cache(font_cache, masters_json.as_ref())?;
    }

    if let Some((subset_key, subset_epoch)) = subset_cache_refresh {
        if let Some((ref cached_key, ref mut cached_epoch, ref mut subset_font)) =
            *SUBSET_FONT_CACHE.lock().unwrap()
        {
            if *cached_key == subset_key {
                replace_masters_in_font_cache(subset_font, masters_json.as_ref())?;
                *cached_epoch = subset_epoch;
                SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(subset_epoch, Ordering::Relaxed);
            }
        }
    }

    *FILTERED_FONT_CACHE.lock().unwrap() = None;
    FILTER_EPOCH.fetch_add(1, Ordering::Relaxed);
    glyph_outlines::clear_outline_cache();

    Ok(())
}

fn refresh_kerning_related_caches_from_ydoc<T: ReadTxn>(
    txn: &T,
    refresh_master_kerning: bool,
    refresh_kern_groups: bool,
) -> Result<(), JsValue> {
    if !refresh_master_kerning && !refresh_kern_groups {
        return Ok(());
    }

    let masters_json = if refresh_master_kerning {
        ydoc_get_top_level_json_with_txn("masters", txn)
    } else {
        None
    };
    let first_kern_groups_json = if refresh_kern_groups {
        ydoc_get_top_level_json_with_txn("first_kern_groups", txn)
    } else {
        None
    };
    let second_kern_groups_json = if refresh_kern_groups {
        ydoc_get_top_level_json_with_txn("second_kern_groups", txn)
    } else {
        None
    };

    let mut canonical_missing = false;
    {
        let mut canonical_lock = CANONICAL_JSON_CACHE.lock().unwrap();
        if let Some(ref mut canonical) = *canonical_lock {
            if refresh_master_kerning {
                replace_masters_kerning_in_json(canonical, masters_json.as_ref());
            }
            if refresh_kern_groups {
                replace_top_level_json_entry(
                    canonical,
                    "first_kern_groups",
                    first_kern_groups_json.clone(),
                );
                replace_top_level_json_entry(
                    canonical,
                    "second_kern_groups",
                    second_kern_groups_json.clone(),
                );
            }
        } else {
            canonical_missing = true;
        }
    }

    if canonical_missing {
        set_canonical_json_cache(ydoc_to_babelfont_json_with_txn(txn));
        *FONT_CACHE.lock().unwrap() = None;
        *SUBSET_JSON_CACHE.lock().unwrap() = None;
        *SUBSET_GLYPH_INDEX_CACHE.lock().unwrap() = None;
        *SUBSET_FONT_CACHE.lock().unwrap() = None;
        *FILTERED_FONT_CACHE.lock().unwrap() = None;
        FONT_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed);
        FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
        SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
        FILTER_EPOCH.fetch_add(1, Ordering::Relaxed);
        return Ok(());
    }

    {
        let mut subset_lock = SUBSET_JSON_CACHE.lock().unwrap();
        if let Some((_, subset_epoch, subset_json)) = subset_lock.as_mut() {
            let mut subset_changed = false;
            if refresh_master_kerning {
                subset_changed |=
                    replace_masters_kerning_in_json(subset_json, masters_json.as_ref());
            }
            if refresh_kern_groups {
                subset_changed |= replace_top_level_json_entry(
                    subset_json,
                    "first_kern_groups",
                    first_kern_groups_json.clone(),
                );
                subset_changed |= replace_top_level_json_entry(
                    subset_json,
                    "second_kern_groups",
                    second_kern_groups_json.clone(),
                );
            }

            if subset_changed {
                *subset_epoch = subset_epoch.saturating_add(1);
            }
        }
    }

    *FONT_CACHE.lock().unwrap() = None;
    *SUBSET_FONT_CACHE.lock().unwrap() = None;
    *FILTERED_FONT_CACHE.lock().unwrap() = None;

    FONT_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed);
    FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
    SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
    FILTER_EPOCH.fetch_add(1, Ordering::Relaxed);

    Ok(())
}

fn refresh_non_glyph_feature_caches_from_ydoc<T: ReadTxn>(txn: &T) -> Result<(), JsValue> {
    let rebuilt = ydoc_to_babelfont_json_with_txn(txn);
    set_canonical_json_cache(rebuilt);

    *FONT_CACHE.lock().unwrap() = None;
    *SUBSET_JSON_CACHE.lock().unwrap() = None;
    *SUBSET_GLYPH_INDEX_CACHE.lock().unwrap() = None;
    *SUBSET_FONT_CACHE.lock().unwrap() = None;
    *FILTERED_FONT_CACHE.lock().unwrap() = None;
    *FEATURE_FILE_CACHE.lock().unwrap() = None;
    *FEATURE_FEA_STRING_CACHE.lock().unwrap() = None;
    LAYOUT_CLOSURE_CACHE.lock().unwrap().clear();
    *LAST_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = None;

    FONT_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed);
    FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
    SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
    FILTER_EPOCH.fetch_add(1, Ordering::Relaxed);

    Ok(())
}

// ── store_font internal helpers ──────────────────────────────────────────────

/// Internal: store a babelfont `serde_json::Value` in all Rust caches.
/// Equivalent to `store_font()` but accepts a pre-parsed JSON value.
fn store_font_from_value(json_value: serde_json::Value) -> Result<(), JsValue> {
    // Store in canonical JSON cache
    set_canonical_json_cache(json_value.clone());

    // Deserialize into babelfont::Font
    let font: babelfont::Font = serde_json::from_value(json_value)
        .map_err(|e| JsValue::from_str(&format!("Font deserialization error: {}", e)))?;

    // Build FeatureFile before acquiring FONT_CACHE lock to avoid re-entrant lock
    let fea = font.features.to_fea();
    let font_glyphs: Vec<String> = font.glyphs.iter().map(|g| g.name.to_string()).collect();
    let font_glyphs_ref: Vec<&str> = font_glyphs.iter().map(|s| s.as_str()).collect();
    let new_feature_file =
        FeatureFile::new_from_fea(&fea, Some(&font_glyphs_ref), font.source.clone()).ok();

    *FONT_CACHE.lock().unwrap() = Some(font);
    *FEATURE_FILE_CACHE.lock().unwrap() = new_feature_file;
    *FEATURE_FEA_STRING_CACHE.lock().unwrap() = Some((fea, font_glyphs));

    // Clear subset caches — they need rebuilding with the new font
    *SUBSET_JSON_CACHE.lock().unwrap() = None;
    *SUBSET_GLYPH_INDEX_CACHE.lock().unwrap() = None;
    *SUBSET_FONT_CACHE.lock().unwrap() = None;
    *FILTERED_FONT_CACHE.lock().unwrap() = None;

    let next_epoch = FONT_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed) + 1;
    FONT_CACHE_BUILT_AT_EPOCH.store(next_epoch, Ordering::Relaxed);
    SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
    FILTER_EPOCH.fetch_add(1, Ordering::Relaxed);

    glyph_outlines::clear_outline_cache();
    Ok(())
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
    // FULLJSON_UNNECESSARY (U1/A2): Receives full JSON string, parses it,
    // and populates all caches. Should be replaced by forwarding the Yjs
    // binary update to apply_yjs_update then calling the internal rebuild.
    let _store_span = PerfSpan::start("store_font.total");
    let _parse_span = PerfSpan::start("store_font.parse_json");
    let json_value: serde_json::Value = serde_json::from_str(babelfont_json)
        .map_err(|e| JsValue::from_str(&format!("JSON parse error: {}", e)))?;
    drop(_parse_span);

    store_font_from_value(json_value)
}

/// Seed the Rust Y.Doc from a full Yjs binary state (v1 encoding) without
/// rebuilding all caches. Called immediately after `openFont` so that
/// subsequent `apply_yjs_update` calls have a baseline Y.Doc, while the
/// heavy `store_font` cache population (FeatureFile, FONT_CACHE, …) already
/// happened in the `openFont` worker handler.
#[wasm_bindgen]
pub fn seed_ydoc(state_update: &[u8]) -> Result<(), JsValue> {
    let _span = PerfSpan::start("seed_ydoc.total");
    let doc = yrs::Doc::new();
    {
        let update = yrs::Update::decode_v1(state_update)
            .map_err(|e| JsValue::from_str(&format!("seed_ydoc: decode failed: {:?}", e)))?;
        let mut txn = doc.transact_mut();
        txn.apply_update(update);
    }
    *Y_DOC.lock().unwrap() = Some(doc);
    Ok(())
}

/// Initialize (or re-initialize) the Rust Y.Doc from a full Yjs binary state
/// and rebuild all font caches from the resulting JSON.
///
/// Use this:
/// - After undo/redo (instead of the expensive `store_font` full-JSON path)
/// - After receiving a remote full-state sync from another window
///
/// The Yjs binary state is typically 20-40 % smaller than the equivalent
/// babelfont JSON string, so data transfer from the JS thread to the WASM
/// worker is significantly cheaper.
#[wasm_bindgen]
pub fn init_ydoc_from_state(state_update: &[u8]) -> Result<(), JsValue> {
    // FULLJSON_INTERNAL_RUST: Receives binary Yjs state (not JSON), applies it to
    // a fresh Y.Doc, then rebuilds all Caches from a full Y.Doc→JSON walk.
    // Could be made incremental with targeted top-level key patching — lower
    // priority since no boundary crossing.
    let _span = PerfSpan::start("init_ydoc_from_state.total");

    let doc = yrs::Doc::new();
    let json_value = {
        let _decode_span = PerfSpan::start("init_ydoc_from_state.decode_apply");
        let update = yrs::Update::decode_v1(state_update).map_err(|e| {
            JsValue::from_str(&format!("init_ydoc_from_state: decode failed: {:?}", e))
        })?;
        let mut txn = doc.transact_mut();
        txn.apply_update(update);
        let _serialize_span = PerfSpan::start("init_ydoc_from_state.serialize_json");
        ydoc_to_babelfont_json_with_txn(&txn)
    };

    *Y_DOC.lock().unwrap() = Some(doc);

    store_font_from_value(json_value)
}

/// Apply an incremental Yjs binary update (v1 encoding) to the Rust Y.Doc and
/// update the CANONICAL_JSON_CACHE.
///
/// `update_metadata_json` is a JSON payload produced by the JS side that can
/// contain `changedGlyphs` plus `nonGlyphChangeHints` for top-level edits.
/// When non-empty the function performs a targeted update — only those glyphs
/// are re-serialised from the Y.Doc and replaced in CANONICAL_JSON_CACHE,
/// making drag-step updates cheap even for large fonts.
/// When empty or "[]" the function falls back to a full JSON rebuild from the
/// Y.Doc.
///
/// Returns a JSON string `{ "changedGlyphs": ["a", …], "changedLayerIds": [] }`
/// that the JS side can use to drive subset-cache replay.
#[wasm_bindgen]
pub fn apply_yjs_update(update: &[u8], update_metadata_json: &str) -> Result<String, JsValue> {
    // YJS_ONLY when changedGlyphs is populated: targeted per-glyph
    // patching of CANONICAL_JSON_CACHE — no full rebuild.
    // FULLJSON_INTERNAL_RUST (C1b/U5) when changedGlyphs is empty: falls to
    // refresh_non_glyph_feature_caches_from_ydoc which does a full Y.Doc→JSON
    // walk. Could target-patch only changed top-level keys (features, axes).
    let _span = PerfSpan::start("apply_yjs_update.total");

    // -- 1. Apply binary update to Y_DOC ----------------------------------
    let yrs_update = yrs::Update::decode_v1(update)
        .map_err(|e| JsValue::from_str(&format!("apply_yjs_update: decode failed: {:?}", e)))?;

    // Move the worker doc out of the global slot while mutating and reading it.
    // Keeping the Y_DOC mutex-held handle borrowed across transact_mut()/transact()
    // can trip yrs' internal transaction guard during live incremental updates.
    let doc = match Y_DOC.lock().unwrap().take() {
        Some(doc) => doc,
        None => {
            // Y.Doc not yet seeded — this happens when apply_yjs_update arrives
            // before seed_ydoc has been called (e.g. very early edits during font
            // open). Return a no-op result so the caller can wait for bootstrap or
            // recovery to seed the worker document.
            let result = serde_json::json!({
                "changedGlyphs": [],
                "changedLayerIds": [],
                "skipped": "ydoc_not_initialized"
            });
            return serde_json::to_string(&result).map_err(|e| {
                JsValue::from_str(&format!("apply_yjs_update: result serialize: {}", e))
            });
        }
    };

    let result = (|| -> Result<String, JsValue> {
        let _apply_span = PerfSpan::start("apply_yjs_update.decode_apply");
        let mut txn = doc.transact_mut();
        txn.apply_update(yrs_update);

        // -- 2. Parse JS-supplied update metadata -----------------------------
        let (changed_glyphs, non_glyph_change_hints, layer_targets) =
            parse_apply_yjs_update_metadata(update_metadata_json);
        let layer_target_glyphs: HashSet<String> = layer_targets
            .iter()
            .map(|target| target.glyph_name.clone())
            .collect();
        let refresh_masters = non_glyph_change_hints
            .iter()
            .any(|hint| hint == "masters");
        let masters_json = if refresh_masters {
            ydoc_get_top_level_json_with_txn("masters", &txn)
        } else {
            None
        };
        let changed_layer_snapshots: Vec<(LayerTarget, Option<serde_json::Value>)> = layer_targets
            .iter()
            .map(|target| {
                (
                    target.clone(),
                    ydoc_get_layer_json_with_txn(&target.glyph_name, &target.layer_id, &txn),
                )
            })
            .collect();
        let changed_glyph_snapshots: Vec<(String, Option<serde_json::Value>)> = changed_glyphs
            .iter()
            .filter(|glyph_name| !layer_target_glyphs.contains(*glyph_name))
            .map(|glyph_name| {
                (
                    glyph_name.clone(),
                    ydoc_get_glyph_json_with_txn(glyph_name, &txn),
                )
            })
            .collect();

        // -- 3. Update CANONICAL_JSON_CACHE -----------------------------------
        if changed_glyphs.is_empty() && changed_layer_snapshots.is_empty() {
            let refresh_feature_caches = non_glyph_change_hints
                .iter()
                .any(|hint| hint == "feature-code");
            let refresh_master_kerning = non_glyph_change_hints
                .iter()
                .any(|hint| hint == "kerning-value");
            let refresh_kern_groups = non_glyph_change_hints
                .iter()
                .any(|hint| hint == "kerning-groups");

            if refresh_feature_caches {
                // Font-level edits such as feature-code commits do not identify
                // changed glyphs, but they still need the worker caches to stay
                // in sync. Refresh the top-level features data directly from the
                // Y.Doc and invalidate derived caches without forcing a full font
                // JSON rebuild for every feature edit.
                let _rebuild_span = PerfSpan::start("apply_yjs_update.feature_refresh");
                refresh_non_glyph_feature_caches_from_ydoc(&txn)?;
            } else if refresh_masters || refresh_master_kerning || refresh_kern_groups {
                if refresh_masters {
                    let _rebuild_span = PerfSpan::start("apply_yjs_update.masters_refresh");
                    refresh_masters_related_caches_from_ydoc(&txn)?;
                }
                if refresh_master_kerning || refresh_kern_groups {
                    let _rebuild_span = PerfSpan::start("apply_yjs_update.kerning_refresh");
                    refresh_kerning_related_caches_from_ydoc(
                        &txn,
                        refresh_master_kerning,
                        refresh_kern_groups,
                    )?;
                }
            } else {
                let _rebuild_span = PerfSpan::start("apply_yjs_update.non_glyph_refresh");
                refresh_non_glyph_feature_caches_from_ydoc(&txn)?;
            }
        } else {
            // Partial update. Prefer sparse layer patches when JS supplied
            // layerTargets; fall back to whole-glyph snapshots only for changed
            // glyphs that are not represented by a layer target.
            let _partial_span = PerfSpan::start("apply_yjs_update.partial_update");
            let mut canonical_lock = CANONICAL_JSON_CACHE.lock().unwrap();
            if let Some(ref mut canonical) = *canonical_lock {
                {
                    let mut canonical_index_lock = CANONICAL_GLYPH_INDEX_CACHE.lock().unwrap();
                    let glyph_index =
                        canonical_index_lock.get_or_insert_with(|| build_glyph_index(canonical));

                    if refresh_masters {
                        replace_top_level_json_entry(canonical, "masters", masters_json.clone());
                    }

                    for (target, layer_json) in &changed_layer_snapshots {
                        replace_layer_json_entry(
                            canonical,
                            glyph_index,
                            &target.glyph_name,
                            &target.layer_id,
                            layer_json.clone(),
                        );
                    }

                    for (glyph_name, glyph_json) in &changed_glyph_snapshots {
                        replace_glyph_json_entry(
                            canonical,
                            glyph_index,
                            glyph_name,
                            glyph_json.clone(),
                        );
                    }
                }

                let mut subset_cache_refresh: Option<(String, u64, Vec<String>)> = None;
                {
                    let mut subset_lock = SUBSET_JSON_CACHE.lock().unwrap();
                    if let Some((ref subset_key, ref mut subset_epoch, ref mut subset_json)) =
                        *subset_lock
                    {
                        let mut subset_changed = false;
                        let mut subset_index_lock = SUBSET_GLYPH_INDEX_CACHE.lock().unwrap();
                        let subset_index = match subset_index_lock.as_mut() {
                            Some((cached_key, index)) if *cached_key == *subset_key => index,
                            _ => {
                                *subset_index_lock =
                                    Some((subset_key.clone(), build_glyph_index(subset_json)));
                                match subset_index_lock.as_mut() {
                                    Some((_, index)) => index,
                                    None => unreachable!(),
                                }
                            }
                        };

                        if refresh_masters {
                            subset_changed |= replace_top_level_json_entry(
                                subset_json,
                                "masters",
                                masters_json.clone(),
                            );
                        }

                        let mut touched_subset_glyphs: Vec<String> = Vec::new();
                        for (target, layer_json) in &changed_layer_snapshots {
                            let touches_subset = subset_index.contains_key(&target.glyph_name)
                                || layer_json.is_none();
                            if !touches_subset {
                                continue;
                            }

                            if replace_layer_json_entry(
                                subset_json,
                                subset_index,
                                &target.glyph_name,
                                &target.layer_id,
                                layer_json.clone(),
                            ) {
                                touched_subset_glyphs.push(target.glyph_name.clone());
                            }
                        }

                        for (glyph_name, glyph_json) in &changed_glyph_snapshots {
                            let touches_subset =
                                subset_index.contains_key(glyph_name) || glyph_json.is_none();
                            if !touches_subset {
                                continue;
                            }

                            if replace_glyph_json_entry(
                                subset_json,
                                subset_index,
                                glyph_name,
                                glyph_json.clone(),
                            ) {
                                touched_subset_glyphs.push(glyph_name.clone());
                            }
                        }

                        if subset_changed || !touched_subset_glyphs.is_empty() {
                            *subset_epoch = subset_epoch.saturating_add(1);
                            subset_cache_refresh =
                                Some((subset_key.clone(), *subset_epoch, touched_subset_glyphs));
                        }
                    }
                }

                if let Some(ref mut font_cache) = *FONT_CACHE.lock().unwrap() {
                    if refresh_masters {
                        replace_masters_in_font_cache(font_cache, masters_json.as_ref())?;
                    }
                    for (glyph_name, glyph_json) in &changed_glyph_snapshots {
                        replace_glyph_in_font_cache(font_cache, glyph_name, glyph_json.as_ref())?;
                    }
                    for (target, layer_json) in &changed_layer_snapshots {
                        replace_layer_in_font_cache(
                            font_cache,
                            &target.glyph_name,
                            &target.layer_id,
                            layer_json.as_ref(),
                        )?;
                    }
                }

                if let Some((subset_key, subset_epoch, subset_glyphs)) = subset_cache_refresh {
                    if let Some((ref cached_key, ref mut cached_epoch, ref mut subset_font)) =
                        *SUBSET_FONT_CACHE.lock().unwrap()
                    {
                        if *cached_key == subset_key {
                            if refresh_masters {
                                replace_masters_in_font_cache(subset_font, masters_json.as_ref())?;
                            }
                            for (target, layer_json) in &changed_layer_snapshots {
                                replace_layer_in_font_cache(
                                    subset_font,
                                    &target.glyph_name,
                                    &target.layer_id,
                                    layer_json.as_ref(),
                                )?;
                            }
                            for glyph_name in &subset_glyphs {
                                let Some((_, glyph_json)) = changed_glyph_snapshots
                                    .iter()
                                    .find(|(name, _)| name == glyph_name)
                                else {
                                    continue;
                                };
                                replace_glyph_in_font_cache(
                                    subset_font,
                                    glyph_name,
                                    glyph_json.as_ref(),
                                )?;
                            }
                            *cached_epoch = subset_epoch;
                            SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(subset_epoch, Ordering::Relaxed);
                        }
                    }

                    *FILTERED_FONT_CACHE.lock().unwrap() = None;
                }

                // Also clear outline cache for affected glyphs.
                for glyph_name in changed_glyphs.iter().chain(layer_target_glyphs.iter()) {
                    glyph_outlines::clear_outline_cache_for_glyph(glyph_name);
                }
            } else {
                // No canonical cache yet — fall back to full rebuild
                let json_value = ydoc_to_babelfont_json_with_txn(&txn);
                *canonical_lock = Some(json_value.clone());
                *CANONICAL_GLYPH_INDEX_CACHE.lock().unwrap() = Some(build_glyph_index(&json_value));
                *FONT_CACHE.lock().unwrap() = None;
                *SUBSET_JSON_CACHE.lock().unwrap() = None;
                *SUBSET_GLYPH_INDEX_CACHE.lock().unwrap() = None;
                *SUBSET_FONT_CACHE.lock().unwrap() = None;
                *FILTERED_FONT_CACHE.lock().unwrap() = None;
                FONT_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed);
                SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
            }
        }

        drop(txn);

        // -- 5. Return changed-glyph list for JS subset-cache replay ------------
        let result = serde_json::json!({
            "changedGlyphs": changed_glyphs,
            "changedLayerIds": layer_targets
                .iter()
                .map(|target| target.layer_id.clone())
                .collect::<Vec<String>>()
        });
        serde_json::to_string(&result).map_err(|e| {
            JsValue::from_str(&format!(
                "apply_yjs_update: result serialisation failed: {}",
                e
            ))
        })
    })();

    *Y_DOC.lock().unwrap() = Some(doc);

    result
}

/// Clear the cached font from memory
#[wasm_bindgen]
pub fn clear_font_cache() {
    let mut cache = FONT_CACHE.lock().unwrap();
    *cache = None;

    *CANONICAL_JSON_CACHE.lock().unwrap() = None;
    *CANONICAL_GLYPH_INDEX_CACHE.lock().unwrap() = None;
    *SUBSET_JSON_CACHE.lock().unwrap() = None;
    *SUBSET_GLYPH_INDEX_CACHE.lock().unwrap() = None;
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
    // FULLJSON_NECESSARY (A1/N1): Parses .glyphs/.ufo/etc. to babelfont::Font,
    // then serializes to JSON string for JS — the one unavoidable full JSON crossing.
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

            babelfont::convertors::glyphs3::load_package_entries(path.clone(), &entries).map_err(
                |e| JsValue::from_str(&format!("Failed to load .glyphspackage: {:?}", e)),
            )?
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
            babelfont::convertors::designspace::load_entries(path.clone(), &entries)
                .map_err(|e| JsValue::from_str(&format!("Failed to load .designspace: {:?}", e)))?
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
    glyph_outlines::interpolate_glyph_json_cached(&font, glyph_name, location_json, extrapolate)
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
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize closure result: {}", e)))?;
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

    let (_cache_key, result) =
        compute_layout_closure_cached_internal(font_revision, glyph_names_json)?;

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
pub fn compile_cached_font_from_last_layout_closure(options: &JsValue) -> Result<Vec<u8>, JsValue> {
    let _compile_span = PerfSpan::start("compile_cached_font_from_last_layout_closure.total");

    let _closure_fetch_span =
        PerfSpan::start("compile_cached_font_from_last_layout_closure.fetch_last_closure");
    let cache_key = LAST_LAYOUT_CLOSURE_CACHE_KEY
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| {
            JsValue::from_str("No primed layout closure. Call prime_layout_closure_cache() first.")
        })?;
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
    let _prepared_span =
        PerfSpan::start("compile_cached_font_from_last_layout_closure.get_or_build_subset");
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
            store_subset_font_cache(&prepared_subset_key, &subset_font)?;
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

    let _filter_cache_span =
        PerfSpan::start("compile_cached_font_from_last_layout_closure.filter_cache");
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
            let _apply_span = PerfSpan::start(
                "compile_cached_font_from_last_layout_closure.filter_cache.apply_filters",
            );
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

    let _ir_compile_span =
        PerfSpan::start("compile_cached_font_from_last_layout_closure.ir_compile");
    let compiled_font = compile_with_feature_debug_context(
        filtered_font.as_ref(),
        &compilation_options,
        "compile_cached_font_from_last_layout_closure",
    )?;
    drop(_ir_compile_span);

    Ok(compiled_font)
}

/// Compile the full cached font after running the standard filter pipeline.
/// This preserves feature parsing/validation without constraining the compile
/// to the current text subset.
#[wasm_bindgen]
pub fn compile_cached_full_font_with_filter_pipeline(
    options: &JsValue,
) -> Result<Vec<u8>, JsValue> {
    let _compile_span = PerfSpan::start("compile_cached_full_font_with_filter_pipeline.total");

    let _cache_read_span =
        PerfSpan::start("compile_cached_full_font_with_filter_pipeline.cache_read");
    let full_font = get_or_rebuild_font_cache()?;
    drop(_cache_read_span);

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

    let _filter_span =
        PerfSpan::start("compile_cached_full_font_with_filter_pipeline.apply_filters");
    let filtered_font = apply_filter_pipeline(&full_font, &compilation_options)?;
    drop(_filter_span);

    let _ir_compile_span =
        PerfSpan::start("compile_cached_full_font_with_filter_pipeline.ir_compile");
    let compiled_font = compile_with_feature_debug_context(
        &filtered_font,
        &compilation_options,
        "compile_cached_full_font_with_filter_pipeline",
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use yrs::{Any, ArrayPrelim, Doc, Map, MapPrelim, Transact};

    const TEST_FONT_JSON: &str = r#"{
        "upm": 1000,
        "version": [1, 0],
        "note": "",
        "date": "2026-01-01T00:00:00.000Z",
        "names": { "family_name": { "dflt": "TestFont" } },
        "features": {
            "classes": {},
            "prefixes": {},
            "features": []
        },
        "first_kern_groups": {},
        "second_kern_groups": {},
        "format_specific": {},
        "axes": [
            {
                "name": { "dflt": "Weight" },
                "tag": "wght",
                "min": 100,
                "max": 900,
                "default": 400
            }
        ],
        "instances": [],
        "masters": [
            {
                "name": { "dflt": "Regular" },
                "id": "master-regular",
                "location": { "wght": 400 },
                "guides": [],
                "metrics": {},
                "kerning": {},
                "custom_ot_values": {},
                "format_specific": {}
            }
        ],
        "glyphs": [
            {
                "name": "A",
                "codepoints": [65],
                "category": "Base",
                "exported": true,
                "layers": [
                    {
                        "id": "layer-1",
                        "master": {
                            "type": "DefaultForMaster",
                            "master": "master-regular"
                        },
                        "width": 600,
                        "shapes": [],
                        "anchors": [],
                        "guides": [],
                        "format_specific": {}
                    }
                ],
                "format_specific": {}
            }
        ]
    }"#;

    #[test]
    fn layout_closure_cache_key_includes_font_revision() {
        assert_eq!(
            layout_closure_cache_key("17", "alef\u{1f}beh"),
            "17::alef\u{1f}beh"
        );
    }

    #[test]
    fn replace_glyph_json_entry_updates_shifted_indices_after_removal() {
        let mut font_json = json!({
            "glyphs": [
                { "name": "alef", "layers": [] },
                { "name": "beh", "layers": [] },
                { "name": "teh", "layers": [] }
            ]
        });
        let mut glyph_index = build_glyph_index(&font_json);

        assert!(replace_glyph_json_entry(
            &mut font_json,
            &mut glyph_index,
            "beh",
            None,
        ));

        assert_eq!(glyph_index.get("alef"), Some(&0));
        assert_eq!(glyph_index.get("teh"), Some(&1));
        assert!(glyph_index.get("beh").is_none());
        assert_eq!(
            font_json
                .get("glyphs")
                .and_then(|value| value.as_array())
                .map(|glyphs| glyphs.len()),
            Some(2)
        );
    }

    #[test]
    fn replace_layer_json_entry_updates_one_layer_without_replacing_glyph() {
        let mut font_json = json!({
            "glyphs": [
                {
                    "name": "alef",
                    "category": "Letter",
                    "layers": [
                        { "id": "regular", "width": 400, "anchors": [] },
                        { "id": "bold", "width": 500, "anchors": [] }
                    ]
                }
            ]
        });
        let glyph_index = build_glyph_index(&font_json);

        assert!(replace_layer_json_entry(
            &mut font_json,
            &glyph_index,
            "alef",
            "regular",
            Some(json!({ "id": "regular", "width": 410, "anchors": [] })),
        ));

        let layers = font_json["glyphs"][0]["layers"].as_array().unwrap();
        assert_eq!(layers.len(), 2);
        assert_eq!(layers[0]["width"], json!(410));
        assert_eq!(layers[1]["width"], json!(500));
    }

    #[test]
    fn parse_apply_yjs_update_metadata_extracts_layer_targets() {
        let (changed_glyphs, hints, layer_targets) = parse_apply_yjs_update_metadata(
            r#"{
                "changedGlyphs": ["alef"],
                "nonGlyphChangeHints": [],
                "layerTargets": [
                    { "glyphName": "alef", "layerId": "regular" },
                    { "glyphName": "alef", "layerId": "regular" },
                    { "glyphName": "beh", "layerId": "regular" }
                ]
            }"#,
        );

        assert_eq!(changed_glyphs, vec!["alef".to_string()]);
        assert!(hints.is_empty());
        assert_eq!(
            layer_targets,
            vec![
                LayerTarget {
                    glyph_name: "alef".to_string(),
                    layer_id: "regular".to_string(),
                },
                LayerTarget {
                    glyph_name: "beh".to_string(),
                    layer_id: "regular".to_string(),
                },
            ]
        );
    }

    #[test]
    fn prune_layout_closure_cache_for_subset_discards_stale_revisions() {
        let mut cache = HashMap::from([
            (
                layout_closure_cache_key("1", "alef\u{1f}beh"),
                vec!["alef".to_string()],
            ),
            (
                layout_closure_cache_key("2", "alef\u{1f}beh"),
                vec!["beh".to_string()],
            ),
            (
                layout_closure_cache_key("1", "teh"),
                vec!["teh".to_string()],
            ),
        ]);

        prune_layout_closure_cache_for_subset(&mut cache, "alef\u{1f}beh");

        assert_eq!(cache.len(), 1);
        assert!(cache.contains_key(&layout_closure_cache_key("1", "teh")));
    }

    #[test]
    fn yrs_map_to_json_converts_numeric_key_maps_to_arrays() {
        let doc = Doc::new();
        let root = doc.get_or_insert_map("root");
        let mut txn = doc.transact_mut();
        let numeric_map = root.insert(&mut txn, "numeric", yrs::MapPrelim::<&str>::new());
        numeric_map.insert(&mut txn, "0", "zero");
        numeric_map.insert(&mut txn, "2", "two");

        let value = yrs_map_to_json(&numeric_map, &txn);

        assert_eq!(value, json!(["zero", null, "two"]));
    }

    #[test]
    fn refresh_masters_related_caches_updates_all_cached_views() {
        clear_font_cache();

        let canonical_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let font_cache: babelfont::Font = serde_json::from_value(canonical_json.clone()).unwrap();
        set_canonical_json_cache(canonical_json.clone());
        *FONT_CACHE.lock().unwrap() = Some(font_cache);

        let subset_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let subset_font: babelfont::Font = serde_json::from_value(subset_json.clone()).unwrap();
        *SUBSET_JSON_CACHE.lock().unwrap() = Some((
            "A".to_string(),
            1,
            subset_json.clone(),
        ));
        *SUBSET_GLYPH_INDEX_CACHE.lock().unwrap() = Some((
            "A".to_string(),
            build_glyph_index(&subset_json),
        ));
        *SUBSET_FONT_CACHE.lock().unwrap() = Some(("A".to_string(), 1, subset_font));
        SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(1, Ordering::Relaxed);

        let doc = Doc::new();
        let font_map = doc.get_or_insert_map("font");
        {
            let mut txn = doc.transact_mut();
            let masters: yrs::ArrayRef =
                font_map.insert(&mut txn, "masters", ArrayPrelim::from(Vec::<Any>::new()));
            let renamed_master: yrs::MapRef = masters.push_back(&mut txn, MapPrelim::<Any>::new());
            renamed_master.insert(&mut txn, "id", "master-regular");
            let name: yrs::MapRef =
                renamed_master.insert(&mut txn, "name", MapPrelim::<Any>::new());
            name.insert(&mut txn, "dflt", "Renamed Regular");
            let location: yrs::MapRef =
                renamed_master.insert(&mut txn, "location", MapPrelim::<Any>::new());
            location.insert(&mut txn, "wght", Any::Number(400.0));
            renamed_master.insert(&mut txn, "guides", ArrayPrelim::from(Vec::<Any>::new()));
            renamed_master.insert(&mut txn, "metrics", MapPrelim::<Any>::new());
            renamed_master.insert(&mut txn, "kerning", MapPrelim::<Any>::new());
            renamed_master.insert(&mut txn, "custom_ot_values", MapPrelim::<Any>::new());
            renamed_master.insert(&mut txn, "format_specific", MapPrelim::<Any>::new());
        }

        let txn = doc.transact();
        refresh_masters_related_caches_from_ydoc(&txn).unwrap();

        assert_eq!(
            FONT_CACHE.lock().unwrap().as_ref().unwrap().masters[0]
                .name
                .get_default()
                .map(|value| value.as_str()),
            Some("Renamed Regular")
        );
        assert_eq!(
            CANONICAL_JSON_CACHE.lock().unwrap().as_ref().unwrap()["masters"][0]["name"]["dflt"],
            json!("Renamed Regular")
        );
        assert_eq!(
            SUBSET_JSON_CACHE.lock().unwrap().as_ref().unwrap().2["masters"][0]["name"]["dflt"],
            json!("Renamed Regular")
        );
        assert_eq!(
            SUBSET_FONT_CACHE.lock().unwrap().as_ref().unwrap().2.masters[0]
                .name
                .get_default()
                .map(|value| value.as_str()),
            Some("Renamed Regular")
        );
    }
}
