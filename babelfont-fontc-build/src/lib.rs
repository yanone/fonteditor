use babelfont::{
    convertors::fontir::{BabelfontIrSource, CompilationOptions},
    filters::{
        DropIncompatiblePaths, FontFilter as _, GlyphsBracketLayers, GlyphsData,
        GlyphsStylisticSetLabel, RetainGlyphs, RewriteSmartAxes,
    },
    BabelfontError,
};
use fea_rs::{
    compile::NopVariationInfo,
    parse::{parse_root, SourceLoadError, SourceResolver},
    Diagnostic, GlyphMap,
};
use fea_rs_ast::FeatureFile;
use smol_str::SmolStr;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt::Write as _;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
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

mod font_introspection;
pub use font_introspection::{
    inspect_font_bytes, parse_path, FontPath, InspectionError, InspectionResult,
    MAX_LIST_SIZE, MAX_OUTPUT_BYTES, MAX_QUERY_COUNT, MAX_REQUEST_BYTES,
};

// Interpolation module
mod interpolation;

// Rust-authored Yjs batch operations for master add / reinterpolation
mod batch_yjs_ops;

pub use batch_yjs_ops::{add_master_with_interpolated_layers_yjs, reinterpolate_master_layers_yjs};

// Glyph outlines module
mod glyph_outlines;

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
static COMMITTED_FONT_FINGERPRINT: Mutex<Option<String>> = Mutex::new(None);
static LAYOUT_CLOSURE_CACHE: LazyLock<Mutex<HashMap<String, Vec<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static LAST_LAYOUT_CLOSURE_CACHE_KEY: Mutex<Option<String>> = Mutex::new(None);
static LAST_DEBUG_LAYOUT_CLOSURE_CACHE_KEY: Mutex<Option<String>> = Mutex::new(None);
static FONT_CACHE_EPOCH: AtomicU64 = AtomicU64::new(0);
/// Filtered font cache: stores the result of apply_filters() keyed by
/// (subset_key, filter_epoch, options_fingerprint).
static FILTERED_FONT_CACHE: Mutex<Option<FilteredFontCacheEntry>> = Mutex::new(None);
static DEBUG_SETTINGS_TO_FONT_HASH_CACHE: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static DEBUG_FONT_BYTES_CACHE: LazyLock<Mutex<DebugFontBytesCache>> =
    LazyLock::new(|| Mutex::new(DebugFontBytesCache::default()));
/// Epoch counter for source-data changes that require re-filtering without
/// necessarily invalidating the editing layout-closure cache.
/// Incremented by store_font_internal(), clear_font_cache(), and committed
/// Yjs source updates.
static FILTER_EPOCH: AtomicU64 = AtomicU64::new(0);
static PERF_SPAN_COUNTER: AtomicU64 = AtomicU64::new(0);
static Y_DOC_EPOCH: AtomicU64 = AtomicU64::new(0);

/// Yjs CRDT document maintained in Rust — receives binary Yjs updates directly
/// from the JavaScript PatchSyncEngine, eliminating full-JSON round-trips for
/// incremental cache maintenance.
static Y_DOC: Mutex<Option<yrs::Doc>> = Mutex::new(None);

static PREVIEW_OVERLAY: Mutex<Option<PreviewOverlay>> = Mutex::new(None);
static LAST_PREVIEW_LAYOUT_CLOSURE_CACHE_KEY: Mutex<Option<String>> = Mutex::new(None);

struct PreviewOverlay {
    base_font_cache_epoch: u64,
    generation: u64,
    layer_overrides: HashMap<LayerTarget, serde_json::Value>,
    subset_font_cache: Option<PreviewSubsetFontCacheEntry>,
    filtered_font_cache: Option<PreviewFilteredFontCacheEntry>,
}

struct PreviewSubsetFontCacheEntry {
    subset_key: String,
    base_font_cache_epoch: u64,
    overlay_generation: u64,
    font: babelfont::Font,
}

struct PreviewFilteredFontCacheEntry {
    subset_key: String,
    filter_epoch: u64,
    base_font_cache_epoch: u64,
    overlay_generation: u64,
    options_fingerprint: u64,
    font: Arc<babelfont::Font>,
}

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

#[derive(Default)]
struct DebugFontBytesCache {
    max_bytes: usize,
    total_bytes: usize,
    entries: HashMap<String, Arc<Vec<u8>>>,
    lru: VecDeque<String>,
}

impl DebugFontBytesCache {
    fn set_max_bytes(&mut self, max_bytes: usize) {
        self.max_bytes = max_bytes;
        self.evict_if_needed();
    }

    fn get(&mut self, font_hash: &str) -> Option<Vec<u8>> {
        let bytes = self.entries.get(font_hash).cloned()?;
        self.touch(font_hash);
        Some((*bytes).clone())
    }

    fn insert(&mut self, font_hash: String, bytes: Vec<u8>) {
        if let Some(previous) = self.entries.remove(&font_hash) {
            self.total_bytes = self.total_bytes.saturating_sub(previous.len());
            self.remove_from_lru(&font_hash);
        }

        let bytes_len = bytes.len();
        self.entries.insert(font_hash.clone(), Arc::new(bytes));
        self.total_bytes = self.total_bytes.saturating_add(bytes_len);
        self.touch(&font_hash);
        self.evict_if_needed();
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.lru.clear();
        self.total_bytes = 0;
    }

    fn touch(&mut self, font_hash: &str) {
        self.remove_from_lru(font_hash);
        self.lru.push_back(font_hash.to_string());
    }

    fn remove_from_lru(&mut self, font_hash: &str) {
        if let Some(index) = self.lru.iter().position(|entry| entry == font_hash) {
            self.lru.remove(index);
        }
    }

    fn evict_if_needed(&mut self) {
        if self.max_bytes == 0 {
            return;
        }

        while self.total_bytes > self.max_bytes {
            let Some(oldest_key) = self.lru.pop_front() else {
                break;
            };

            if let Some(removed) = self.entries.remove(&oldest_key) {
                self.total_bytes = self.total_bytes.saturating_sub(removed.len());
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
struct LayerTarget {
    glyph_name: String,
    layer_id: String,
}

fn clear_preview_overlay_internal() {
    *PREVIEW_OVERLAY.lock().unwrap() = None;
    *LAST_PREVIEW_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = None;
}

fn reset_debug_font_caches_with_fingerprint(committed_font_fingerprint: Option<String>) {
    *COMMITTED_FONT_FINGERPRINT.lock().unwrap() = committed_font_fingerprint;
    *LAST_DEBUG_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = None;
    DEBUG_SETTINGS_TO_FONT_HASH_CACHE.lock().unwrap().clear();
    DEBUG_FONT_BYTES_CACHE.lock().unwrap().clear();
}

fn refresh_debug_font_caches_from_canonical_cache() -> Result<(), JsValue> {
    let canonical_json = CANONICAL_JSON_CACHE.lock().unwrap().clone();
    match canonical_json {
        Some(value) => {
            let fingerprint = stable_hash_json_value(&value)?;
            reset_debug_font_caches_with_fingerprint(Some(fingerprint));
        }
        None => reset_debug_font_caches_with_fingerprint(None),
    }

    Ok(())
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
    let fingerprint = stable_hash_json_value(&json_value)
        .expect("canonical JSON cache fingerprinting must not fail");
    reset_debug_font_caches_with_fingerprint(Some(fingerprint));
}

fn stable_hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn stable_hash_json_value(value: &serde_json::Value) -> Result<String, JsValue> {
    let serialized = serde_json::to_vec(value)
        .map_err(|e| JsValue::from_str(&format!("JSON serialization error: {}", e)))?;
    Ok(stable_hash_bytes(&serialized))
}

fn get_committed_font_fingerprint() -> Result<String, JsValue> {
    COMMITTED_FONT_FINGERPRINT
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| JsValue::from_str("No committed font fingerprint available."))
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
            let next_layer_json = if let Some(index) = layer_position {
                merge_sparse_layer_json(&layers[index], layer_json)
            } else {
                layer_json
            };
            if let Some(index) = layer_position {
                layers[index] = next_layer_json;
            } else {
                layers.push(next_layer_json);
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

fn merge_sparse_layer_json(
    existing_layer_json: &serde_json::Value,
    incoming_layer_json: serde_json::Value,
) -> serde_json::Value {
    match (existing_layer_json, incoming_layer_json) {
        (serde_json::Value::Object(existing), serde_json::Value::Object(mut incoming)) => {
            for (key, value) in existing {
                if !incoming.contains_key(key) {
                    incoming.insert(key.clone(), value.clone());
                }
            }
            serde_json::Value::Object(incoming)
        }
        (_, incoming) => incoming,
    }
}

fn layer_field_from_json<T>(
    glyph_name: &str,
    layer_id: &str,
    field_name: &str,
    value: &serde_json::Value,
) -> Result<T, JsValue>
where
    T: serde::de::DeserializeOwned,
{
    let normalized_value = match field_name {
        "location" | "smart_component_location" => {
            if let Some(object) = value.as_object() {
                serde_json::Value::Array(
                    object
                        .iter()
                        .map(|(key, nested_value)| {
                            serde_json::Value::Array(vec![
                                serde_json::Value::String(key.clone()),
                                nested_value.clone(),
                            ])
                        })
                        .collect(),
                )
            } else {
                value.clone()
            }
        }
        _ => value.clone(),
    };

    serde_json::from_value(normalized_value).map_err(|e| {
        JsValue::from_str(&format!(
            "Layer field deserialization error for {}::{} {}: {}",
            glyph_name, layer_id, field_name, e
        ))
    })
}

fn apply_sparse_layer_json_to_cached_layer(
    layer: &mut babelfont::Layer,
    glyph_name: &str,
    layer_id: &str,
    layer_json: &serde_json::Value,
) -> Result<(), JsValue> {
    let Some(fields) = layer_json.as_object() else {
        *layer = serde_json::from_value(layer_json.clone()).map_err(|e| {
            JsValue::from_str(&format!(
                "Layer deserialization error for {}::{}: {}",
                glyph_name, layer_id, e
            ))
        })?;
        return Ok(());
    };

    if let Some(value) = fields.get("width") {
        layer.width = layer_field_from_json(glyph_name, layer_id, "width", value)?;
    }
    if let Some(value) = fields.get("name") {
        layer.name = layer_field_from_json(glyph_name, layer_id, "name", value)?;
    }
    if let Some(value) = fields.get("id") {
        layer.id = layer_field_from_json(glyph_name, layer_id, "id", value)?;
    }
    if let Some(value) = fields.get("master") {
        layer.master = layer_field_from_json(glyph_name, layer_id, "master", value)?;
    }
    if let Some(value) = fields.get("guides") {
        layer.guides = layer_field_from_json(glyph_name, layer_id, "guides", value)?;
    }
    if let Some(value) = fields.get("shapes") {
        layer.shapes = layer_field_from_json(glyph_name, layer_id, "shapes", value)?;
    }
    if let Some(value) = fields.get("anchors") {
        layer.anchors = layer_field_from_json(glyph_name, layer_id, "anchors", value)?;
    }
    if let Some(value) = fields.get("color") {
        layer.color = layer_field_from_json(glyph_name, layer_id, "color", value)?;
    }
    if let Some(value) = fields.get("layer_index") {
        layer.layer_index = layer_field_from_json(glyph_name, layer_id, "layer_index", value)?;
    }
    if let Some(value) = fields.get("is_background") {
        layer.is_background = layer_field_from_json(glyph_name, layer_id, "is_background", value)?;
    }
    if let Some(value) = fields.get("background_layer_id") {
        layer.background_layer_id =
            layer_field_from_json(glyph_name, layer_id, "background_layer_id", value)?;
    }
    if let Some(value) = fields.get("location") {
        layer.location = layer_field_from_json(glyph_name, layer_id, "location", value)?;
    }
    if let Some(value) = fields.get("smart_component_location") {
        layer.smart_component_location =
            layer_field_from_json(glyph_name, layer_id, "smart_component_location", value)?;
    }
    if let Some(value) = fields.get("format_specific") {
        layer.format_specific =
            layer_field_from_json(glyph_name, layer_id, "format_specific", value)?;
    }

    Ok(())
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
            if let Some(index) = layer_index {
                apply_sparse_layer_json_to_cached_layer(
                    &mut glyph.layers[index],
                    glyph_name,
                    layer_id,
                    layer_json,
                )?;
            } else {
                let layer: babelfont::Layer =
                    serde_json::from_value(layer_json.clone()).map_err(|e| {
                        JsValue::from_str(&format!(
                            "Layer deserialization error for {}::{}: {}",
                            glyph_name, layer_id, e
                        ))
                    })?;
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

fn build_subset_font_from_closure_subset(
    closure_subset: &[String],
) -> Result<babelfont::Font, JsValue> {
    let full_font = get_or_rebuild_font_cache()?;
    let mut subset_font = full_font;
    if !closure_subset.is_empty() {
        subset_font_using_cached_fea(&mut subset_font, closure_subset)?;
    }
    Ok(subset_font)
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

fn options_compile_fingerprint(options: &CompilationOptions) -> u64 {
    let mut h: u64 = 0;
    if options.skip_kerning {
        h |= 1;
    }
    if options.skip_features {
        h |= 1 << 1;
    }
    if options.skip_metrics {
        h |= 1 << 2;
    }
    if options.skip_outlines {
        h |= 1 << 3;
    }
    if options.dont_use_production_names {
        h |= 1 << 4;
    }
    if options.drop_incompatible_paths {
        h |= 1 << 5;
    }
    if options.produce_varc_table {
        h |= 1 << 6;
    }
    h
}

fn make_debug_compile_settings_key(
    committed_font_fingerprint: &str,
    subset_key: &str,
    options: &CompilationOptions,
) -> String {
    format!(
        "{}::{}::{:016x}",
        committed_font_fingerprint,
        subset_key,
        options_compile_fingerprint(options)
    )
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

fn render_feature_parsing_error_entries(diagnostics: &[Diagnostic]) -> String {
    let mut rendered = String::new();

    for (index, diagnostic) in diagnostics.iter().enumerate() {
        if index > 0 {
            rendered.push_str(", ");
        }
        let span = diagnostic.span();
        let _ = write!(
            rendered,
            "FeatureError {{ message: {:?}, span: {}..{}, is_error: {} }}",
            diagnostic.message.text,
            span.start,
            span.end,
            diagnostic.is_error()
        );
    }

    rendered
}

fn feature_diagnostics_to_error_string(
    prefix: &str,
    diagnostics: &[fea_rs::Diagnostic],
    fea: &str,
    context: &str,
) -> String {
    let rendered = format!(
        "FeatureParsing([{}])",
        render_feature_parsing_error_entries(diagnostics)
    );
    let debug_context = diagnostics
        .iter()
        .find(|diagnostic| diagnostic.is_error())
        .or_else(|| diagnostics.first())
        .map(|diagnostic| {
            let span = diagnostic.span();
            feature_span_debug_context(fea, span.start, span.end)
        })
        .unwrap_or_else(|| "span not found in FeatureParsing payload".to_string());

    format!(
        "{}: {}\n[FeatureDebug:{}] {}",
        prefix, rendered, context, debug_context
    )
}

fn feature_debug_error_from_babelfont_error(
    prefix: &str,
    err: &BabelfontError,
    fea: &str,
    context: &str,
) -> JsValue {
    let error_text = format!("{:?}", err);
    if error_text.contains("FeatureParsing(") {
        let debug_context = extract_feature_error_span(&error_text)
            .map(|(start, end)| feature_span_debug_context(fea, start, end))
            .unwrap_or_else(|| "span not found in FeatureParsing payload".to_string());
        return JsValue::from_str(&format!(
            "{}: {:?}\n[FeatureDebug:{}] {}",
            prefix, err, context, debug_context
        ));
    }

    JsValue::from_str(&format!("{}: {:?}", prefix, err))
}

struct InMemoryFeatureValidationResolver {
    content_path: PathBuf,
    content: Arc<str>,
    include_dir: Option<PathBuf>,
}

impl InMemoryFeatureValidationResolver {}

impl SourceResolver for InMemoryFeatureValidationResolver {
    fn get_contents(&self, rel_path: &Path) -> Result<Arc<str>, SourceLoadError> {
        if rel_path == &*self.content_path {
            return Ok(self.content.clone());
        }
        let Some(include_dir) = &self.include_dir else {
            return Err(SourceLoadError::new(
                rel_path.to_path_buf(),
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "No include path configured for feature validation",
                ),
            ));
        };
        let path = include_dir
            .join(rel_path)
            .canonicalize()
            .map_err(|error| SourceLoadError::new(rel_path.to_path_buf(), error))?;
        if !path.is_file() {
            return Err(SourceLoadError::new(
                rel_path.to_path_buf(),
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("Feature include file not found: {}", path.display()),
                ),
            ));
        }
        let contents = fs::read_to_string(path)
            .map_err(|error| SourceLoadError::new(rel_path.to_path_buf(), error))?;
        Ok(Arc::from(contents.as_str()))
    }
}

fn feature_validation_resolver(
    fea: &str,
    include_dir: Option<PathBuf>,
) -> (Box<dyn SourceResolver>, PathBuf) {
    (
        Box::new(InMemoryFeatureValidationResolver {
            content_path: PathBuf::new(),
            content: Arc::from(fea),
            include_dir,
        }),
        PathBuf::new(),
    )
}

fn validate_feature_source_with_full_filter_pipeline_internal(
    options: &CompilationOptions,
) -> Result<(), String> {
    let full_font = get_or_rebuild_font_cache()
        .map_err(|error| error.as_string().unwrap_or_else(|| format!("{:?}", error)))?;
    let filtered_font = apply_filter_pipeline(&full_font, options)
        .map_err(|error| error.as_string().unwrap_or_else(|| format!("{:?}", error)))?;
    let fea = filtered_font.features.to_fea();
    let glyph_map: GlyphMap = filtered_font
        .glyphs
        .iter()
        .map(|glyph| glyph.name.as_str())
        .collect();
    let include_dir = filtered_font
        .source
        .as_ref()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()));
    let (resolver, root_path) = feature_validation_resolver(&fea, include_dir);

    let (ast, parse_diagnostics) = parse_root(root_path, Some(&glyph_map), resolver)
        .map_err(|error| format!("Feature validation failed: {:?}", error))?;
    if parse_diagnostics.has_errors() {
        return Err(feature_diagnostics_to_error_string(
            "Feature validation failed",
            parse_diagnostics.diagnostics(),
            &fea,
            "validate_feature_source_with_full_filter_pipeline",
        ));
    }

    let validation_diagnostics =
        fea_rs::compile::validate(&ast, &glyph_map, Some(&NopVariationInfo));
    if validation_diagnostics.has_errors() {
        return Err(feature_diagnostics_to_error_string(
            "Feature validation failed",
            validation_diagnostics.diagnostics(),
            &fea,
            "validate_feature_source_with_full_filter_pipeline",
        ));
    }

    Ok(())
}

#[wasm_bindgen]
pub fn validate_feature_source_with_full_filter_pipeline(options: &JsValue) -> Result<(), JsValue> {
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

    validate_feature_source_with_full_filter_pipeline_internal(&compilation_options)
        .map_err(|error| JsValue::from_str(&error))
}

fn compile_with_feature_debug_context(
    font: &babelfont::Font,
    options: &CompilationOptions,
    context: &str,
) -> Result<Vec<u8>, JsValue> {
    match BabelfontIrSource::compile(font.clone(), options.clone()) {
        Ok(compiled) => Ok(zero_head_timestamps(&compiled)),
        Err(err) => Err(feature_debug_error_from_babelfont_error(
            "Compilation failed",
            &err,
            &font.features.to_fea(),
            context,
        )),
    }
}

/// Zero out the `head` table `created` and `modified` timestamps so that
/// compiling the same input produces byte-identical output.  Without this,
/// fontc embeds fresh timestamps on every compile, making pixel-level
/// canvas snapshot comparison across compiles impossible.
fn zero_head_timestamps(font_data: &[u8]) -> Vec<u8> {
    if font_data.len() < 12 {
        return font_data.to_vec();
    }
    // Parse sfVersion + numTables (2) + searchRange (2) + entrySelector (2) + rangeShift (2) = 12
    let num_tables = u16::from_be_bytes([font_data[4], font_data[5]]) as usize;
    let dir_start = 12;
    let dir_end = dir_start + num_tables * 16;

    if font_data.len() < dir_end {
        return font_data.to_vec();
    }

    // "head" table tag as big-endian u32
    let head_tag: u32 = u32::from_be_bytes([b'h', b'e', b'a', b'd']);
    let head_tag_bytes = head_tag.to_be_bytes();

    for i in 0..num_tables {
        let entry_offset = dir_start + i * 16;
        if entry_offset + 16 > font_data.len() {
            break;
        }
        let tag = &font_data[entry_offset..entry_offset + 4];
        if tag == head_tag_bytes {
            let offset = u32::from_be_bytes([
                font_data[entry_offset + 8],
                font_data[entry_offset + 9],
                font_data[entry_offset + 10],
                font_data[entry_offset + 11],
            ]) as usize;
            let length = u32::from_be_bytes([
                font_data[entry_offset + 12],
                font_data[entry_offset + 13],
                font_data[entry_offset + 14],
                font_data[entry_offset + 15],
            ]) as usize;

            if offset + 32 > font_data.len() || length < 32 {
                break;
            }

            // head table layout (after the first 12 bytes of table header):
            // Offset 0:  version       (4 bytes, Fixed 16.16)
            // Offset 4:  fontRevision  (4 bytes, Fixed 16.16)
            // Offset 8:  checkSumAdjustment (4 bytes, uint32)
            // Offset 12: magicNumber   (4 bytes, uint32 = 0x5F0F3CF5)
            // Offset 16: flags         (2 bytes, uint16)
            // Offset 18: unitsPerEm    (2 bytes, uint16)
            // Offset 20: created       (8 bytes, LONGDATETIME)
            // Offset 28: modified      (8 bytes, LONGDATETIME)
            let mut result = font_data.to_vec();
            let created_offset = offset + 20;
            let modified_offset = offset + 28;

            if created_offset + 8 <= result.len() {
                result[created_offset..created_offset + 8].fill(0);
            }
            if modified_offset + 8 <= result.len() {
                result[modified_offset..modified_offset + 8].fill(0);
            }
            return result;
        }
    }

    font_data.to_vec()
}

const PERF_PREFIX: &str = "cp:wasm";
#[cfg(target_arch = "wasm32")]
const PERF_TRACE_CONTEXT_GLOBAL_KEY: &str = "__cpPerfTraceContext";

#[cfg(target_arch = "wasm32")]
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

#[cfg(target_arch = "wasm32")]
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

#[cfg(target_arch = "wasm32")]
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

#[cfg(not(target_arch = "wasm32"))]
fn current_perf_trace_suffix() -> String {
    String::new()
}

#[cfg(target_arch = "wasm32")]
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

#[cfg(not(target_arch = "wasm32"))]
fn perf_mark(_label: &str) {}

#[cfg(target_arch = "wasm32")]
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

#[cfg(not(target_arch = "wasm32"))]
fn perf_measure(_name: &str, _start: &str, _end: &str) {}

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

/// Convert a Y.Map to a JSON value.
///
/// With the indexed-map schema, nodes/shapes/anchors/guides are stored
/// as `*ById` (Y.Map keyed by stable id) + `*Order` (Y.Array of ids).
/// The old numeric-key heuristic that converted numeric-keyed Y.Maps to
/// JSON arrays is no longer needed and has been removed.
fn yrs_map_to_json<T: ReadTxn>(map_ref: &yrs::MapRef, txn: &T) -> serde_json::Value {
    let entries: Vec<(String, serde_json::Value)> = map_ref
        .iter(txn)
        .map(|(k, v)| (k.to_string(), yrs_value_to_json(v, txn)))
        .collect();

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

    // Reconstruct indexed-map structures back to flat arrays
    // (shapesById+shapeOrder → shapes, etc.)
    reconstruct_indexed_map_array(&mut layer_obj, "shapes", "shapesById", "shapeOrder");
    reconstruct_indexed_map_array(&mut layer_obj, "anchors", "anchorsById", "anchorOrder");
    reconstruct_indexed_map_array(&mut layer_obj, "guides", "guidesById", "guideOrder");

    // For each shape, reconstruct nodes from nodesById+nodeOrder
    if let Some(serde_json::Value::Array(shapes)) = layer_obj.get_mut("shapes") {
        for shape in shapes.iter_mut() {
            let serde_json::Value::Object(ref mut obj) = shape else {
                continue;
            };
            // Reconstruct nodes from indexed-map
            reconstruct_indexed_map_array(obj, "nodes", "nodesById", "nodeOrder");
            if obj.contains_key("nodes") && !obj.contains_key("closed") {
                obj.insert("closed".to_string(), serde_json::Value::Bool(false));
            }
        }
    }
    serde_json::Value::Object(layer_obj)
}

/// Reconstruct a flat JSON array from an indexed-map structure
/// (*ById + *Order → array). Removes the *ById and *Order keys.
fn reconstruct_indexed_map_array(
    obj: &mut serde_json::Map<String, serde_json::Value>,
    array_key: &str,
    by_id_key: &str,
    order_key: &str,
) {
    let by_id = obj.get(by_id_key).cloned();
    let order = obj.get(order_key).cloned();
    if let (Some(serde_json::Value::Object(by_id_map)), Some(serde_json::Value::Array(order_arr))) =
        (by_id, order)
    {
        let mut arr = Vec::with_capacity(order_arr.len());
        for id_val in &order_arr {
            let Some(id) = id_val.as_str() else {
                continue;
            };
            let Some(item) = by_id_map.get(id) else {
                continue;
            };
            arr.push(item.clone());
        }
        obj.insert(array_key.to_string(), serde_json::Value::Array(arr));
    }
    // Clean up indexed-map keys regardless
    obj.remove(by_id_key);
    obj.remove(order_key);
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

fn cached_layer_json_from_font_json(
    font_json: &serde_json::Value,
    glyph_name: &str,
    layer_id: &str,
    glyph_index: Option<&HashMap<String, usize>>,
) -> Option<serde_json::Value> {
    let glyphs = font_json.get("glyphs")?.as_array()?;
    let glyph_position = glyph_index
        .and_then(|index| index.get(glyph_name).copied())
        .or_else(|| {
            glyphs.iter().position(|glyph| {
                glyph
                    .get("name")
                    .and_then(|value| value.as_str())
                    .is_some_and(|name| name == glyph_name)
            })
        })?;
    let glyph_json = glyphs.get(glyph_position)?;
    let layers = glyph_json.get("layers")?.as_array()?;
    layers
        .iter()
        .find(|layer| {
            layer
                .get("id")
                .and_then(|value| value.as_str())
                .is_some_and(|id| id == layer_id)
        })
        .cloned()
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

        for field_name in ["kerning", "kerning_rtl"] {
            match incoming_master.get(field_name).cloned() {
                Some(kerning_value) => {
                    if existing_object.get(field_name) != Some(&kerning_value) {
                        existing_object.insert(field_name.to_string(), kerning_value);
                        changed = true;
                    }
                }
                None => {
                    if existing_object.remove(field_name).is_some() {
                        changed = true;
                    }
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
    let format_specific_json = if refresh_master_kerning {
        ydoc_get_top_level_json_with_txn("format_specific", txn)
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
                replace_top_level_json_entry(
                    canonical,
                    "format_specific",
                    format_specific_json.clone(),
                );
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
                subset_changed |= replace_top_level_json_entry(
                    subset_json,
                    "format_specific",
                    format_specific_json.clone(),
                );
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
    clear_preview_overlay_internal();
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
    clear_preview_overlay_internal();
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

#[derive(serde::Deserialize)]
struct PreviewLayerOverlayUpdate {
    #[serde(rename = "glyphName")]
    glyph_name: String,
    #[serde(rename = "layerId")]
    layer_id: String,
    #[serde(rename = "layerData")]
    layer_data: serde_json::Value,
}

fn apply_preview_layer_overlay_internal(
    layer_updates_json: &str,
    update_metadata_json: &str,
) -> Result<String, JsValue> {
    let layer_updates: Vec<PreviewLayerOverlayUpdate> = serde_json::from_str(layer_updates_json)
        .map_err(|e| {
            JsValue::from_str(&format!(
                "apply_preview_layer_overlay: layer update parse failed: {}",
                e
            ))
        })?;
    let (metadata_changed_glyphs, _non_glyph_change_hints, metadata_layer_targets) =
        parse_apply_yjs_update_metadata(update_metadata_json);

    let current_epoch = FONT_CACHE_EPOCH.load(Ordering::Relaxed);
    let mut preview_lock = PREVIEW_OVERLAY.lock().unwrap();
    let needs_reset = preview_lock.as_ref().map_or(true, |overlay| {
        overlay.base_font_cache_epoch != current_epoch
    });
    if needs_reset {
        *preview_lock = Some(PreviewOverlay {
            base_font_cache_epoch: current_epoch,
            generation: 0,
            layer_overrides: HashMap::new(),
            subset_font_cache: None,
            filtered_font_cache: None,
        });
    }

    let overlay = preview_lock
        .as_mut()
        .ok_or_else(|| JsValue::from_str("Preview overlay not initialized"))?;
    let mut changed_glyphs: HashSet<String> = metadata_changed_glyphs.into_iter().collect();
    let mut changed_layer_ids: Vec<String> = Vec::new();

    for update in layer_updates {
        if update.glyph_name.is_empty() || update.layer_id.is_empty() {
            return Err(JsValue::from_str(
                "apply_preview_layer_overlay: glyphName and layerId are required",
            ));
        }

        changed_glyphs.insert(update.glyph_name.clone());
        changed_layer_ids.push(update.layer_id.clone());
        overlay.layer_overrides.insert(
            LayerTarget {
                glyph_name: update.glyph_name,
                layer_id: update.layer_id,
            },
            update.layer_data,
        );
    }

    for target in metadata_layer_targets {
        changed_glyphs.insert(target.glyph_name);
        changed_layer_ids.push(target.layer_id);
    }

    overlay.generation = overlay.generation.saturating_add(1);
    overlay.subset_font_cache = None;
    overlay.filtered_font_cache = None;

    changed_layer_ids.sort();
    changed_layer_ids.dedup();
    let mut changed_glyphs: Vec<String> = changed_glyphs.into_iter().collect();
    changed_glyphs.sort();

    let result = serde_json::json!({
        "changedGlyphs": changed_glyphs,
        "changedLayerIds": changed_layer_ids
    });
    serde_json::to_string(&result).map_err(|e| {
        JsValue::from_str(&format!(
            "apply_preview_layer_overlay: result serialisation failed: {}",
            e
        ))
    })
}

/// Apply live-drag layer replacements to a transient preview overlay. This
/// keeps the authoritative Rust Y.Doc and committed caches untouched until
/// mouseup sends the real bridge packet through `apply_yjs_update`.
#[wasm_bindgen]
pub fn apply_preview_layer_overlay(
    layer_updates_json: &str,
    update_metadata_json: &str,
) -> Result<String, JsValue> {
    let _span = PerfSpan::start("apply_preview_layer_overlay.total");
    apply_preview_layer_overlay_internal(layer_updates_json, update_metadata_json)
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
    clear_preview_overlay_internal();

    // -- 1. Apply binary update to Y_DOC ----------------------------------
    let yrs_update = yrs::Update::decode_v1(update)
        .map_err(|e| JsValue::from_str(&format!("apply_yjs_update: decode failed: {:?}", e)))?;

    // Keep the worker doc installed in Y_DOC while mutating it. In wasm, a trap
    // inside apply_update can bypass our normal Result flow; if the doc has been
    // taken out of the global slot, the worker is stranded in
    // ydoc_not_initialized afterward.
    let ydoc_lock = Y_DOC.lock().unwrap();
    let doc = match ydoc_lock.as_ref() {
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
        let document_epoch = Y_DOC_EPOCH.fetch_add(1, Ordering::Relaxed) + 1;

        // -- 2. Parse JS-supplied update metadata -----------------------------
        let (changed_glyphs, non_glyph_change_hints, layer_targets) =
            parse_apply_yjs_update_metadata(update_metadata_json);
        let layer_target_glyphs: HashSet<String> = layer_targets
            .iter()
            .map(|target| target.glyph_name.clone())
            .collect();
        let refresh_masters = non_glyph_change_hints.iter().any(|hint| hint == "masters");
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
                        let needs_subset_index_rebuild = !matches!(
                            subset_index_lock.as_ref(),
                            Some((cached_key, _)) if *cached_key == *subset_key
                        );
                        if needs_subset_index_rebuild {
                            *subset_index_lock =
                                Some((subset_key.clone(), build_glyph_index(subset_json)));
                        }
                        let subset_index = subset_index_lock
                            .as_mut()
                            .map(|(_, index)| index)
                            .ok_or_else(|| {
                                JsValue::from_str(
                                    "apply_yjs_update: subset glyph index missing after rebuild",
                                )
                            })?;

                        if refresh_masters {
                            subset_changed |= replace_top_level_json_entry(
                                subset_json,
                                "masters",
                                masters_json.clone(),
                            );
                        }

                        let mut touched_subset_glyphs: Vec<String> = Vec::new();
                        for (target, layer_json) in &changed_layer_snapshots {
                            let touches_subset = subset_index.contains_key(&target.glyph_name);
                            if !touches_subset {
                                continue;
                            }

                            let changed = replace_layer_json_entry(
                                subset_json,
                                subset_index,
                                &target.glyph_name,
                                &target.layer_id,
                                layer_json.clone(),
                            );
                            // Always mark touched-subset layers for cache refresh,
                            // even when the layer JSON is byte-equal.  Composite-
                            // dependent glyphs (adieresis referencing a) are included
                            // as layer targets via JS recomposition-closure logic,
                            // but their own layer data may not have changed — the
                            // subset font cache must still be refreshed so fontc
                            // recompiles them from current data.
                            if changed || touches_subset {
                                touched_subset_glyphs.push(target.glyph_name.clone());
                            }
                        }

                        for (glyph_name, glyph_json) in &changed_glyph_snapshots {
                            let touches_subset = subset_index.contains_key(glyph_name);
                            if !touches_subset {
                                continue;
                            }

                            let changed = replace_glyph_json_entry(
                                subset_json,
                                subset_index,
                                glyph_name,
                                glyph_json.clone(),
                            );
                            if changed || touches_subset {
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

                let filtered_cache_source_changed =
                    refresh_masters || subset_cache_refresh.is_some();

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
                }

                if filtered_cache_source_changed {
                    *FILTERED_FONT_CACHE.lock().unwrap() = None;
                    FILTER_EPOCH.fetch_add(1, Ordering::Relaxed);
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
        refresh_debug_font_caches_from_canonical_cache()?;

        // -- 5. Return changed-glyph list for JS subset-cache replay ------------
        let result = serde_json::json!({
            "changedGlyphs": changed_glyphs,
            "changedLayerIds": layer_targets
                .iter()
                .map(|target| target.layer_id.clone())
                .collect::<Vec<String>>(),
            "workerCacheStatus": {
                "coherent": true,
                "documentEpoch": document_epoch,
                "fontCacheEpoch": FONT_CACHE_EPOCH.load(Ordering::Relaxed),
                "filterEpoch": FILTER_EPOCH.load(Ordering::Relaxed),
                "subsetCacheEpoch": SUBSET_JSON_CACHE
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|(_, epoch, _)| *epoch)
            }
        });
        serde_json::to_string(&result).map_err(|e| {
            JsValue::from_str(&format!(
                "apply_yjs_update: result serialisation failed: {}",
                e
            ))
        })
    })();

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
    *LAST_DEBUG_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = None;
    *FILTERED_FONT_CACHE.lock().unwrap() = None;
    *FEATURE_FILE_CACHE.lock().unwrap() = None;
    *FEATURE_FEA_STRING_CACHE.lock().unwrap() = None;
    reset_debug_font_caches_with_fingerprint(None);
    FONT_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed);
    FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
    SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
    FILTER_EPOCH.fetch_add(1, Ordering::Relaxed);
    clear_preview_overlay_internal();

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
            // Load UFO from a JSON-encoded in-memory file tree.
            // Expected format: { "relative/path": "file contents", ... }
            let entries: HashMap<String, String> = serde_json::from_str(contents).map_err(|e| {
                JsValue::from_str(&format!(
                    "Failed to parse .ufo entries JSON: {}",
                    e
                ))
            })?;

            babelfont::convertors::ufo::load_entries(path.clone(), &entries).map_err(
                |e| JsValue::from_str(&format!("Failed to load .ufo: {:?}", e)),
            )?
        }

        "designspace" => {
            // Load DesignSpace from a JSON-encoded in-memory file tree.
            // Expected format: { "relative/path": "file contents", ... }
            let entries: HashMap<String, String> = serde_json::from_str(contents).map_err(|e| {
                JsValue::from_str(&format!(
                    "Failed to parse .designspace entries JSON: {}",
                    e
                ))
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

#[derive(serde::Deserialize)]
struct LayerDumpRequest {
    #[serde(rename = "glyphName")]
    glyph_name: String,
    #[serde(rename = "layerId")]
    layer_id: String,
}

const MAX_LAYER_DUMP_TARGETS: usize = 256;

fn dump_lock_error(cache_name: &str) -> JsValue {
    JsValue::from_str(&format!("Layer dump lock poisoned: {}", cache_name))
}

/// Dump Rust-side layer state for one or more glyph/layer targets.
///
/// This is a debug/introspection facility for comparing the Rust caches against
/// the JavaScript state during live editing. For each requested target it
/// returns:
/// - `canonicalLayer`: the layer JSON currently stored in CANONICAL_JSON_CACHE
/// - `subsetLayer`: the layer JSON currently stored in SUBSET_JSON_CACHE, if any
/// - `ydocLayer`: the layer JSON currently readable from the Rust Y.Doc, if any
///
/// The payload also includes the current `fontCacheEpoch` and subset metadata.
#[wasm_bindgen]
pub fn dump_layer_state_json(layer_targets_json: &str) -> Result<String, JsValue> {
    let targets: Vec<LayerDumpRequest> = serde_json::from_str(layer_targets_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse layer targets: {}", e)))?;

    if targets.len() > MAX_LAYER_DUMP_TARGETS {
        return Err(JsValue::from_str(&format!(
            "Too many layer targets requested: {} (max {})",
            targets.len(),
            MAX_LAYER_DUMP_TARGETS
        )));
    }

    for target in &targets {
        if target.glyph_name.trim().is_empty() {
            return Err(JsValue::from_str(
                "Layer dump target glyphName must be non-empty",
            ));
        }
        if target.layer_id.trim().is_empty() {
            return Err(JsValue::from_str(
                "Layer dump target layerId must be non-empty",
            ));
        }
    }

    let response = {
        let ydoc_lock = Y_DOC.lock().map_err(|_| dump_lock_error("Y_DOC"))?;
        let canonical_lock = CANONICAL_JSON_CACHE
            .lock()
            .map_err(|_| dump_lock_error("CANONICAL_JSON_CACHE"))?;
        let canonical_index_lock = CANONICAL_GLYPH_INDEX_CACHE
            .lock()
            .map_err(|_| dump_lock_error("CANONICAL_GLYPH_INDEX_CACHE"))?;
        let subset_lock = SUBSET_JSON_CACHE
            .lock()
            .map_err(|_| dump_lock_error("SUBSET_JSON_CACHE"))?;
        let subset_index_lock = SUBSET_GLYPH_INDEX_CACHE
            .lock()
            .map_err(|_| dump_lock_error("SUBSET_GLYPH_INDEX_CACHE"))?;

        let has_ydoc = ydoc_lock.is_some();
        let has_canonical_cache = canonical_lock.is_some();
        let has_subset_cache = subset_lock.is_some();

        let subset_metadata = subset_lock.as_ref().map(|(subset_key, subset_epoch, _)| {
            serde_json::json!({
                "subsetKey": subset_key,
                "subsetEpoch": subset_epoch,
            })
        });

        let ydoc_txn = ydoc_lock.as_ref().map(|doc| doc.transact());
        let canonical_json = canonical_lock.as_ref();
        let canonical_index = canonical_index_lock.as_ref();
        let subset_json = subset_lock.as_ref().map(|(_, _, subset_json)| subset_json);
        let subset_index = subset_index_lock.as_ref().map(|(_, index)| index);

        let dumps: Vec<serde_json::Value> = targets
            .iter()
            .map(|target| {
                let canonical_layer = canonical_json.and_then(|json| {
                    cached_layer_json_from_font_json(
                        json,
                        &target.glyph_name,
                        &target.layer_id,
                        canonical_index,
                    )
                });
                let subset_layer = subset_json.and_then(|json| {
                    cached_layer_json_from_font_json(
                        json,
                        &target.glyph_name,
                        &target.layer_id,
                        subset_index,
                    )
                });
                let ydoc_layer = ydoc_txn.as_ref().and_then(|txn| {
                    ydoc_get_layer_json_with_txn(&target.glyph_name, &target.layer_id, txn)
                });

                serde_json::json!({
                    "glyphName": target.glyph_name,
                    "layerId": target.layer_id,
                    "canonicalPresent": canonical_layer.is_some(),
                    "subsetPresent": subset_layer.is_some(),
                    "ydocPresent": ydoc_layer.is_some(),
                    "canonicalLayer": canonical_layer,
                    "subsetLayer": subset_layer,
                    "ydocLayer": ydoc_layer,
                })
            })
            .collect();

        serde_json::json!({
        "targets": dumps,
        "fontCacheEpoch": FONT_CACHE_EPOCH.load(Ordering::Relaxed),
        "subset": subset_metadata,
        "hasYDoc": has_ydoc,
        "hasCanonicalCache": has_canonical_cache,
        "hasSubsetCache": has_subset_cache,
        })
    };

    serde_json::to_string(&response)
        .map_err(|e| JsValue::from_str(&format!("Layer dump serialization failed: {}", e)))
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

/// Prime the transient live-drag preview layout-closure cache.
#[wasm_bindgen]
pub fn prime_preview_layout_closure_cache(
    font_revision: &str,
    glyph_names_json: &str,
) -> Result<u32, JsValue> {
    let _prime_span = PerfSpan::start("prime_preview_layout_closure_cache.total");
    let (cache_key, result) =
        compute_layout_closure_cached_internal(font_revision, glyph_names_json)?;
    *LAST_PREVIEW_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = Some(cache_key);

    Ok(result.len() as u32)
}

/// Prime the committed-state debug layout-closure cache on a lane isolated
/// from the normal editing compile's last-closure pointer.
#[wasm_bindgen]
pub fn prime_debug_layout_closure_cache(glyph_names_json: &str) -> Result<u32, JsValue> {
    let _prime_span = PerfSpan::start("prime_debug_layout_closure_cache.total");
    let committed_font_fingerprint = get_committed_font_fingerprint()?;
    let (cache_key, result) =
        compute_layout_closure_cached_internal(&committed_font_fingerprint, glyph_names_json)?;
    *LAST_DEBUG_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = Some(cache_key);

    Ok(result.len() as u32)
}

/// Compile the transient live-drag preview cached font using the last primed
/// preview layout closure subset.
#[wasm_bindgen]
pub fn compile_preview_cached_font_from_last_layout_closure(
    options: &JsValue,
) -> Result<Vec<u8>, JsValue> {
    let _compile_span =
        PerfSpan::start("compile_preview_cached_font_from_last_layout_closure.total");

    let cache_key = LAST_PREVIEW_LAYOUT_CLOSURE_CACHE_KEY
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| {
            JsValue::from_str(
            "No primed preview layout closure. Call prime_preview_layout_closure_cache() first.",
        )
        })?;
    let closure_subset = LAYOUT_CLOSURE_CACHE
        .lock()
        .unwrap()
        .get(&cache_key)
        .cloned()
        .ok_or_else(|| {
            JsValue::from_str("Primed preview layout closure key not found in cache.")
        })?;
    let prepared_subset_key = canonical_subset_key_from_sorted_unique(&closure_subset);

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

    let current_base_epoch = FONT_CACHE_EPOCH.load(Ordering::Relaxed);
    let current_filter_epoch = FILTER_EPOCH.load(Ordering::Relaxed);
    let current_options_fp = options_filter_fingerprint(&compilation_options);

    let filtered_font = {
        let mut preview_lock = PREVIEW_OVERLAY.lock().unwrap();
        if preview_lock
            .as_ref()
            .is_some_and(|overlay| overlay.base_font_cache_epoch != current_base_epoch)
        {
            *preview_lock = None;
        }

        if let Some(overlay) = preview_lock.as_mut() {
            let subset_font = match overlay.subset_font_cache.as_ref() {
                Some(entry)
                    if entry.subset_key == prepared_subset_key
                        && entry.base_font_cache_epoch == current_base_epoch
                        && entry.overlay_generation == overlay.generation =>
                {
                    perf_mark(&format!(
                        "{}:compile_preview_cached_font_from_last_layout_closure.subset_cache_hit{}",
                        PERF_PREFIX,
                        current_perf_trace_suffix()
                    ));
                    entry.font.clone()
                }
                _ => {
                    perf_mark(&format!(
                        "{}:compile_preview_cached_font_from_last_layout_closure.subset_cache_miss{}",
                        PERF_PREFIX,
                        current_perf_trace_suffix()
                    ));
                    let mut subset_font =
                        match get_or_rebuild_subset_font_cache(&prepared_subset_key)? {
                            Some(cached) => cached,
                            None => build_subset_font_from_closure_subset(&closure_subset)?,
                        };
                    for (target, layer_json) in &overlay.layer_overrides {
                        replace_layer_in_font_cache(
                            &mut subset_font,
                            &target.glyph_name,
                            &target.layer_id,
                            Some(layer_json),
                        )?;
                    }
                    overlay.subset_font_cache = Some(PreviewSubsetFontCacheEntry {
                        subset_key: prepared_subset_key.clone(),
                        base_font_cache_epoch: current_base_epoch,
                        overlay_generation: overlay.generation,
                        font: subset_font.clone(),
                    });
                    subset_font
                }
            };

            let cache_hit = overlay.filtered_font_cache.as_ref().map_or(false, |entry| {
                entry.subset_key == prepared_subset_key
                    && entry.filter_epoch == current_filter_epoch
                    && entry.base_font_cache_epoch == current_base_epoch
                    && entry.overlay_generation == overlay.generation
                    && entry.options_fingerprint == current_options_fp
            });

            if cache_hit {
                perf_mark(&format!(
                    "{}:compile_preview_cached_font_from_last_layout_closure.filter_cache.hit{}",
                    PERF_PREFIX,
                    current_perf_trace_suffix()
                ));
                Arc::clone(&overlay.filtered_font_cache.as_ref().unwrap().font)
            } else {
                let filtered = apply_filter_pipeline(&subset_font, &compilation_options)?;
                let filtered_arc = Arc::new(filtered);
                overlay.filtered_font_cache = Some(PreviewFilteredFontCacheEntry {
                    subset_key: prepared_subset_key.clone(),
                    filter_epoch: current_filter_epoch,
                    base_font_cache_epoch: current_base_epoch,
                    overlay_generation: overlay.generation,
                    options_fingerprint: current_options_fp,
                    font: Arc::clone(&filtered_arc),
                });
                perf_mark(&format!(
                    "{}:compile_preview_cached_font_from_last_layout_closure.filter_cache.miss{}",
                    PERF_PREFIX,
                    current_perf_trace_suffix()
                ));
                filtered_arc
            }
        } else {
            let subset_font = match get_or_rebuild_subset_font_cache(&prepared_subset_key)? {
                Some(cached) => cached,
                None => build_subset_font_from_closure_subset(&closure_subset)?,
            };
            Arc::new(apply_filter_pipeline(&subset_font, &compilation_options)?)
        }
    };

    compile_with_feature_debug_context(
        filtered_font.as_ref(),
        &compilation_options,
        "compile_preview_cached_font_from_last_layout_closure",
    )
}

/// Drop all transient live-drag preview overlay state.
#[wasm_bindgen]
pub fn clear_preview_layer_overlay() {
    clear_preview_overlay_internal();
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

/// Configure the maximum total size of the dedicated debug compiled-font bytes
/// cache. The caller should pass one eighth of the app memory budget.
#[wasm_bindgen]
pub fn set_debug_font_cache_max_bytes(max_bytes: u32) {
    DEBUG_FONT_BYTES_CACHE
        .lock()
        .unwrap()
        .set_max_bytes(max_bytes as usize);
}

/// Compile the committed-state debug cached font using the last primed debug
/// layout closure subset. Returns a stable hash key for retrieving the cached
/// font bytes via get_debug_cached_font_bytes().
#[wasm_bindgen]
pub fn compile_debug_cached_font_from_last_layout_closure(
    options: &JsValue,
) -> Result<String, JsValue> {
    let _compile_span = PerfSpan::start("compile_debug_cached_font_from_last_layout_closure.total");

    let cache_key = LAST_DEBUG_LAYOUT_CLOSURE_CACHE_KEY
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| {
            JsValue::from_str(
                "No primed debug layout closure. Call prime_debug_layout_closure_cache() first.",
            )
        })?;

    let closure_subset = LAYOUT_CLOSURE_CACHE
        .lock()
        .unwrap()
        .get(&cache_key)
        .cloned()
        .ok_or_else(|| JsValue::from_str("Primed debug layout closure key not found in cache."))?;

    let prepared_subset_key = canonical_subset_key_from_sorted_unique(&closure_subset);
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

    let committed_font_fingerprint = get_committed_font_fingerprint()?;
    let settings_key = make_debug_compile_settings_key(
        &committed_font_fingerprint,
        &prepared_subset_key,
        &compilation_options,
    );

    if let Some(font_hash) = DEBUG_SETTINGS_TO_FONT_HASH_CACHE
        .lock()
        .unwrap()
        .get(&settings_key)
        .cloned()
    {
        if DEBUG_FONT_BYTES_CACHE
            .lock()
            .unwrap()
            .get(&font_hash)
            .is_some()
        {
            return Ok(font_hash);
        }
    }

    let subset_font = match get_or_rebuild_subset_font_cache(&prepared_subset_key)? {
        Some(cached) => cached,
        None => build_subset_font_from_closure_subset(&closure_subset)?,
    };

    let filtered_font = apply_filter_pipeline(&subset_font, &compilation_options)?;
    let compiled_font = compile_with_feature_debug_context(
        &filtered_font,
        &compilation_options,
        "compile_debug_cached_font_from_last_layout_closure",
    )?;
    let font_hash = stable_hash_bytes(&compiled_font);

    DEBUG_FONT_BYTES_CACHE
        .lock()
        .unwrap()
        .insert(font_hash.clone(), compiled_font);
    DEBUG_SETTINGS_TO_FONT_HASH_CACHE
        .lock()
        .unwrap()
        .insert(settings_key, font_hash.clone());

    Ok(font_hash)
}

/// Retrieve compiled font bytes from the dedicated debug bytes cache.
#[wasm_bindgen]
pub fn get_debug_cached_font_bytes(font_hash: &str) -> Result<Vec<u8>, JsValue> {
    DEBUG_FONT_BYTES_CACHE
        .lock()
        .unwrap()
        .get(font_hash)
        .ok_or_else(|| {
            JsValue::from_str(&format!(
                "Debug cached font bytes not found for hash {}",
                font_hash
            ))
        })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BinaryFontInspectionRequest {
    #[serde(default)]
    font_index: u32,
    paths: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BinaryFontChildrenRequest {
    #[serde(default)]
    font_index: u32,
    path: String,
    #[serde(default)]
    limit: usize,
}

/// Inspect a previously compiled debug font by stable hash and return compact
/// deterministic JSON values in the same order as the requested paths.
#[wasm_bindgen]
pub fn inspect_debug_cached_font(
    font_hash: &str,
    request_json: &str,
) -> Result<String, JsValue> {
    if request_json.len() > MAX_REQUEST_BYTES {
        return Err(JsValue::from_str("binary font inspection request is too large"));
    }

    let request: BinaryFontInspectionRequest = serde_json::from_str(request_json)
        .map_err(|error| JsValue::from_str(&format!("invalid binary font inspection request: {error}")))?;
    if request.paths.len() > MAX_QUERY_COUNT {
        return Err(JsValue::from_str("inspection query limit exceeded"));
    }

    let paths = request
        .paths
        .iter()
        .map(|path| font_introspection::parse_path(path))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let bytes = get_debug_cached_font_bytes(font_hash)?;
    let result = font_introspection::inspect_font_bytes(&bytes, request.font_index, &paths)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    serde_json::to_string(&result)
        .map_err(|error| JsValue::from_str(&format!("failed to encode inspection result: {error}")))
}

/// List the immediate children beneath a supported binary-font collection path.
#[wasm_bindgen]
pub fn list_debug_cached_font_children(
    font_hash: &str,
    request_json: &str,
) -> Result<String, JsValue> {
    if request_json.len() > MAX_REQUEST_BYTES {
        return Err(JsValue::from_str("binary font child-list request is too large"));
    }

    let request: BinaryFontChildrenRequest = serde_json::from_str(request_json)
        .map_err(|error| JsValue::from_str(&format!("invalid binary font child-list request: {error}")))?;
    let limit = if request.limit == 0 {
        MAX_LIST_SIZE
    } else {
        request.limit.min(MAX_LIST_SIZE)
    };

    let bytes = get_debug_cached_font_bytes(font_hash)?;
    let result = font_introspection::list_font_children(
        &bytes,
        request.font_index,
        &request.path,
        limit,
    )
    .map_err(|error| JsValue::from_str(&error.to_string()))?;

    serde_json::to_string(&result)
        .map_err(|error| JsValue::from_str(&format!("failed to encode child-list result: {error}")))
}

/// Compile the current cached font, store its bytes in the debug cache, and
/// return only the stable hash used to retrieve those bytes later.
#[wasm_bindgen]
pub fn compile_cached_font_to_debug_hash(options: &JsValue) -> Result<String, JsValue> {
    let compiled_font = compile_cached_font(options)?;
    let font_hash = stable_hash_bytes(&compiled_font);
    DEBUG_FONT_BYTES_CACHE
        .lock()
        .unwrap()
        .insert(font_hash.clone(), compiled_font);
    Ok(font_hash)
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

/// Serialize a babelfont JSON string to a UFO file-tree as JSON.
///
/// Input: a babelfont JSON string (as produced by `open_font_file`).
/// Output: a JSON object `{ "relative/path": "file contents", ... }`
/// representing the UFO directory structure.
///
/// Only single-master fonts are supported (norad/UFO limitation).
#[wasm_bindgen]
pub fn save_font_as_ufo_entries(babelfont_json: &str) -> Result<String, JsValue> {
    let font: babelfont::Font = serde_json::from_str(babelfont_json).map_err(|e| {
        JsValue::from_str(&format!("Failed to parse babelfont JSON: {}", e))
    })?;

    let entries = babelfont::convertors::ufo::save_entries(&font)
        .map_err(|e| JsValue::from_str(&format!("Failed to save UFO: {:?}", e)))?;

    serde_json::to_string(&entries)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize UFO entries: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use yrs::{Any, ArrayPrelim, Doc, Map, MapPrelim, StateVector, Transact};

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
    fn preview_layer_overlay_does_not_mutate_authoritative_json_cache() {
        let previous_canonical = CANONICAL_JSON_CACHE.lock().unwrap().clone();
        let previous_index = CANONICAL_GLYPH_INDEX_CACHE.lock().unwrap().clone();
        let previous_overlay = PREVIEW_OVERLAY.lock().unwrap().take();
        let previous_preview_closure_key =
            LAST_PREVIEW_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap().take();

        let font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        set_canonical_json_cache(font_json.clone());

        let result = apply_preview_layer_overlay_internal(
            r#"[
                {
                    "glyphName": "A",
                    "layerId": "layer-1",
                    "layerData": { "id": "layer-1", "width": 650 }
                }
            ]"#,
            r#"{
                "changedGlyphs": ["A"],
                "layerTargets": [{ "glyphName": "A", "layerId": "layer-1" }]
            }"#,
        );

        assert!(result.is_ok());
        assert_eq!(
            CANONICAL_JSON_CACHE.lock().unwrap().as_ref(),
            Some(&font_json)
        );

        let overlay_lock = PREVIEW_OVERLAY.lock().unwrap();
        let overlay = overlay_lock.as_ref().unwrap();
        assert_eq!(overlay.layer_overrides.len(), 1);
        assert_eq!(
            overlay.layer_overrides[&LayerTarget {
                glyph_name: "A".to_string(),
                layer_id: "layer-1".to_string(),
            }]["width"],
            json!(650)
        );
        drop(overlay_lock);

        *CANONICAL_JSON_CACHE.lock().unwrap() = previous_canonical;
        *CANONICAL_GLYPH_INDEX_CACHE.lock().unwrap() = previous_index;
        *PREVIEW_OVERLAY.lock().unwrap() = previous_overlay;
        *LAST_PREVIEW_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = previous_preview_closure_key;
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

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn validate_feature_source_with_full_filter_pipeline_reports_feature_spans_without_compiling() {
        let previous_canonical = CANONICAL_JSON_CACHE.lock().unwrap().clone();
        let previous_index = CANONICAL_GLYPH_INDEX_CACHE.lock().unwrap().clone();
        let previous_font_cache = FONT_CACHE.lock().unwrap().clone();
        let previous_font_epoch = FONT_CACHE_EPOCH.load(Ordering::Relaxed);
        let previous_font_cache_epoch = FONT_CACHE_BUILT_AT_EPOCH.load(Ordering::Relaxed);

        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        font_json["features"] = json!({
            "classes": {},
            "prefixes": {},
            "features": [["liga", { "code": "sub A by ;" }]]
        });

        store_font_from_value(font_json).unwrap();

        let options = CompilationOptions {
            skip_kerning: false,
            skip_features: false,
            skip_metrics: false,
            skip_outlines: false,
            dont_use_production_names: true,
            drop_incompatible_paths: true,
            produce_varc_table: false,
            debug_feature_file: None,
        };
        let error = validate_feature_source_with_full_filter_pipeline_internal(&options)
            .expect_err("invalid feature code should fail validation");
        let message = error;

        assert!(message.contains("FeatureParsing([FeatureError"));
        assert!(
            message.contains("[FeatureDebug:validate_feature_source_with_full_filter_pipeline]")
        );

        *CANONICAL_JSON_CACHE.lock().unwrap() = previous_canonical;
        *CANONICAL_GLYPH_INDEX_CACHE.lock().unwrap() = previous_index;
        *FONT_CACHE.lock().unwrap() = previous_font_cache;
        FONT_CACHE_EPOCH.store(previous_font_epoch, Ordering::Relaxed);
        FONT_CACHE_BUILT_AT_EPOCH.store(previous_font_cache_epoch, Ordering::Relaxed);
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
    fn replace_layer_json_entry_preserves_missing_fields_for_sparse_layer_patch() {
        let mut font_json = json!({
            "glyphs": [
                {
                    "name": "alef",
                    "layers": [
                        {
                            "id": "regular",
                            "width": 400,
                            "anchors": [
                                { "name": "bottom", "x": 200, "y": 0 }
                            ],
                            "shapes": [
                                { "nodes": [], "closed": false }
                            ]
                        }
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
            Some(json!({
                "id": "regular",
                "width": 410,
                "shapes": []
            })),
        ));

        let layer = &font_json["glyphs"][0]["layers"][0];
        assert_eq!(layer["width"], json!(410));
        assert_eq!(layer["shapes"], json!([]));
        assert_eq!(layer["anchors"][0]["name"], json!("bottom"));
    }

    #[test]
    fn replace_layer_json_entry_allows_explicit_empty_anchor_array() {
        let mut font_json = json!({
            "glyphs": [
                {
                    "name": "alef",
                    "layers": [
                        {
                            "id": "regular",
                            "width": 400,
                            "anchors": [
                                { "name": "bottom", "x": 200, "y": 0 }
                            ]
                        }
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
            Some(json!({ "id": "regular", "anchors": [] })),
        ));

        assert_eq!(font_json["glyphs"][0]["layers"][0]["anchors"], json!([]));
    }

    #[test]
    fn replace_layer_in_font_cache_preserves_missing_anchors_for_sparse_layer_patch() {
        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        font_json["glyphs"][0]["layers"][0]["anchors"] = json!([
            { "name": "bottom", "x": 200, "y": 0 }
        ]);
        let mut font: babelfont::Font = serde_json::from_value(font_json).unwrap();

        replace_layer_in_font_cache(
            &mut font,
            "A",
            "layer-1",
            Some(&json!({
                "id": "layer-1",
                "master": {
                    "type": "DefaultForMaster",
                    "master": "master-regular"
                },
                "width": 410,
                "shapes": []
            })),
        )
        .unwrap();

        let layer = &font.glyphs[0].layers[0];
        assert_eq!(layer.width, 410.0);
        assert_eq!(layer.anchors.len(), 1);
        assert_eq!(layer.anchors[0].name, "bottom");
    }

    #[test]
    fn replace_layer_in_font_cache_allows_explicit_empty_anchor_array() {
        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        font_json["glyphs"][0]["layers"][0]["anchors"] = json!([
            { "name": "bottom", "x": 200, "y": 0 }
        ]);
        let mut font: babelfont::Font = serde_json::from_value(font_json).unwrap();

        replace_layer_in_font_cache(
            &mut font,
            "A",
            "layer-1",
            Some(&json!({ "id": "layer-1", "anchors": [] })),
        )
        .unwrap();

        assert!(font.glyphs[0].layers[0].anchors.is_empty());
    }

    #[test]
    fn replace_layer_in_font_cache_accepts_object_location_for_sparse_layer_patch() {
        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        font_json["glyphs"][0]["layers"][0]["location"] = json!({ "wght": 400.0 });
        let mut font: babelfont::Font = serde_json::from_value(font_json).unwrap();

        replace_layer_in_font_cache(
            &mut font,
            "A",
            "layer-1",
            Some(&json!({
                "id": "layer-1",
                "location": { "wght": 650.0 }
            })),
        )
        .unwrap();

        let layer = &font.glyphs[0].layers[0];
        let serialized_location = serde_json::to_value(&layer.location).unwrap();
        assert_eq!(serialized_location, json!([["wght", 650.0]]));
    }

    #[test]
    fn reconstruct_indexed_map_array_skips_stale_order_entries() {
        let mut layer = serde_json::Map::new();
        layer.insert(
            "shapesById".to_string(),
            json!({
                "shape-a": { "id": "shape-a" }
            }),
        );
        layer.insert(
            "shapeOrder".to_string(),
            json!(["shape-a", "missing-shape", 42]),
        );

        reconstruct_indexed_map_array(&mut layer, "shapes", "shapesById", "shapeOrder");

        assert_eq!(
            layer.get("shapes"),
            Some(&json!([{ "id": "shape-a" }]))
        );
        assert!(!layer.contains_key("shapesById"));
        assert!(!layer.contains_key("shapeOrder"));
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
    fn apply_yjs_update_visual_layer_patch_advances_filter_epoch() {
        clear_font_cache();

        let font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        store_font_from_value(font_json.clone()).unwrap();

        let subset_font: babelfont::Font = serde_json::from_value(font_json.clone()).unwrap();
        store_subset_font_cache("A", &subset_font).unwrap();
        *FILTERED_FONT_CACHE.lock().unwrap() = Some(FilteredFontCacheEntry {
            subset_key: "A".to_string(),
            filter_epoch: FILTER_EPOCH.load(Ordering::Relaxed),
            cache_epoch: FONT_CACHE_EPOCH.load(Ordering::Relaxed),
            options_fingerprint: 0,
            font: Arc::new(subset_font.clone()),
        });
        let closure_key = layout_closure_cache_key("unchanged-source", "A");
        LAYOUT_CLOSURE_CACHE
            .lock()
            .unwrap()
            .insert(closure_key.clone(), vec!["A".to_string()]);
        *LAST_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = Some(closure_key.clone());

        let author_doc = Doc::new();
        let font_map = author_doc.get_or_insert_map("font");
        let layer_map: yrs::MapRef;
        {
            let mut txn = author_doc.transact_mut();
            let glyphs_map: yrs::MapRef =
                font_map.insert(&mut txn, "glyphs", MapPrelim::<Any>::new());
            let glyph_map: yrs::MapRef = glyphs_map.insert(&mut txn, "A", MapPrelim::<Any>::new());
            let layers_map: yrs::MapRef =
                glyph_map.insert(&mut txn, "layers", MapPrelim::<Any>::new());
            layer_map = layers_map.insert(&mut txn, "layer-1", MapPrelim::<Any>::new());
            layer_map.insert(&mut txn, "id", "layer-1");
            layer_map.insert(&mut txn, "width", Any::Number(600.0));
            layer_map.insert(&mut txn, "shapes", ArrayPrelim::from(Vec::<Any>::new()));
            layer_map.insert(&mut txn, "anchors", ArrayPrelim::from(Vec::<Any>::new()));
        }

        let initial_update = author_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let base_state_vector = author_doc.transact().state_vector();
        {
            let mut txn = author_doc.transact_mut();
            layer_map.insert(&mut txn, "width", Any::Number(610.0));
        }
        let incremental_update = author_doc.transact().encode_diff_v1(&base_state_vector);

        let worker_doc = Doc::new();
        {
            let update = yrs::Update::decode_v1(initial_update.as_slice()).unwrap();
            let mut txn = worker_doc.transact_mut();
            txn.apply_update(update);
        }
        *Y_DOC.lock().unwrap() = Some(worker_doc);

        let filter_epoch_before = FILTER_EPOCH.load(Ordering::Relaxed);
        let font_epoch_before = FONT_CACHE_EPOCH.load(Ordering::Relaxed);

        apply_yjs_update(
            incremental_update.as_slice(),
            r#"{
                "changedGlyphs": ["A"],
                "layerTargets": [{ "glyphName": "A", "layerId": "layer-1" }]
            }"#,
        )
        .unwrap();

        assert_eq!(FONT_CACHE_EPOCH.load(Ordering::Relaxed), font_epoch_before);
        assert!(FILTER_EPOCH.load(Ordering::Relaxed) > filter_epoch_before);
        assert!(FILTERED_FONT_CACHE.lock().unwrap().is_none());
        assert_eq!(
            LAST_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap().as_ref(),
            Some(&closure_key)
        );
        assert!(LAYOUT_CLOSURE_CACHE
            .lock()
            .unwrap()
            .contains_key(&closure_key));
        assert_eq!(
            CANONICAL_JSON_CACHE.lock().unwrap().as_ref().unwrap()["glyphs"][0]["layers"][0]
                ["width"],
            json!(610)
        );
        assert_eq!(
            SUBSET_JSON_CACHE.lock().unwrap().as_ref().unwrap().2["glyphs"][0]["layers"][0]
                ["width"],
            json!(610)
        );

        clear_font_cache();
    }

    #[test]
    fn apply_yjs_update_indexed_node_patch_refreshes_active_subset_caches() {
        clear_font_cache();

        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        font_json["glyphs"][0]["layers"][0]["shapes"] = json!([
            {
                "nodes": [
                    { "x": 10, "y": 20, "nodetype": "Line" },
                    { "x": 30, "y": 20, "nodetype": "Line" }
                ],
                "closed": false
            }
        ]);
        store_font_from_value(font_json.clone()).unwrap();

        let subset_font: babelfont::Font = serde_json::from_value(font_json.clone()).unwrap();
        store_subset_font_cache("A", &subset_font).unwrap();
        *FILTERED_FONT_CACHE.lock().unwrap() = Some(FilteredFontCacheEntry {
            subset_key: "A".to_string(),
            filter_epoch: FILTER_EPOCH.load(Ordering::Relaxed),
            cache_epoch: FONT_CACHE_EPOCH.load(Ordering::Relaxed),
            options_fingerprint: 0,
            font: Arc::new(subset_font.clone()),
        });

        let author_doc = Doc::new();
        let font_map = author_doc.get_or_insert_map("font");
        let node_map: yrs::MapRef;
        {
            let mut txn = author_doc.transact_mut();
            let glyphs_map: yrs::MapRef =
                font_map.insert(&mut txn, "glyphs", MapPrelim::<Any>::new());
            let glyph_map: yrs::MapRef = glyphs_map.insert(&mut txn, "A", MapPrelim::<Any>::new());
            let layers_map: yrs::MapRef =
                glyph_map.insert(&mut txn, "layers", MapPrelim::<Any>::new());
            let layer_map: yrs::MapRef = layers_map.insert(&mut txn, "layer-1", MapPrelim::<Any>::new());
            layer_map.insert(&mut txn, "id", "layer-1");
            layer_map.insert(&mut txn, "width", Any::Number(600.0));
            layer_map.insert(&mut txn, "shapeOrder", ArrayPrelim::from(vec![Any::String("shape-1".into())]));
            let shapes_by_id: yrs::MapRef =
                layer_map.insert(&mut txn, "shapesById", MapPrelim::<Any>::new());
            let shape_map: yrs::MapRef =
                shapes_by_id.insert(&mut txn, "shape-1", MapPrelim::<Any>::new());
            shape_map.insert(&mut txn, "closed", Any::Bool(false));
            shape_map.insert(
                &mut txn,
                "nodeOrder",
                ArrayPrelim::from(vec![Any::String("node-1".into()), Any::String("node-2".into())]),
            );
            let nodes_by_id: yrs::MapRef =
                shape_map.insert(&mut txn, "nodesById", MapPrelim::<Any>::new());
            node_map = nodes_by_id.insert(&mut txn, "node-1", MapPrelim::<Any>::new());
            node_map.insert(&mut txn, "x", Any::Number(10.0));
            node_map.insert(&mut txn, "y", Any::Number(20.0));
            node_map.insert(&mut txn, "nodetype", "Line");
            let second_node_map: yrs::MapRef =
                nodes_by_id.insert(&mut txn, "node-2", MapPrelim::<Any>::new());
            second_node_map.insert(&mut txn, "x", Any::Number(30.0));
            second_node_map.insert(&mut txn, "y", Any::Number(20.0));
            second_node_map.insert(&mut txn, "nodetype", "Line");
            layer_map.insert(&mut txn, "anchors", ArrayPrelim::from(Vec::<Any>::new()));
        }

        let initial_update = author_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let base_state_vector = author_doc.transact().state_vector();
        {
            let mut txn = author_doc.transact_mut();
            node_map.insert(&mut txn, "x", Any::Number(25.0));
        }
        let incremental_update = author_doc.transact().encode_diff_v1(&base_state_vector);

        let worker_doc = Doc::new();
        {
            let update = yrs::Update::decode_v1(initial_update.as_slice()).unwrap();
            let mut txn = worker_doc.transact_mut();
            txn.apply_update(update);
        }
        *Y_DOC.lock().unwrap() = Some(worker_doc);

        let filter_epoch_before = FILTER_EPOCH.load(Ordering::Relaxed);

        apply_yjs_update(
            incremental_update.as_slice(),
            r#"{
                "changedGlyphs": ["A"],
                "layerTargets": [{ "glyphName": "A", "layerId": "layer-1" }]
            }"#,
        )
        .unwrap();

        assert!(FILTER_EPOCH.load(Ordering::Relaxed) > filter_epoch_before);
        assert!(FILTERED_FONT_CACHE.lock().unwrap().is_none());
        assert_eq!(
            CANONICAL_JSON_CACHE.lock().unwrap().as_ref().unwrap()["glyphs"][0]["layers"][0]
                ["shapes"][0]["nodes"][0]["x"],
            json!(25)
        );
        assert_eq!(
            SUBSET_JSON_CACHE.lock().unwrap().as_ref().unwrap().2["glyphs"][0]["layers"][0]
                ["shapes"][0]["nodes"][0]["x"],
            json!(25)
        );
        let subset_cache_json = serde_json::to_value(
            &SUBSET_FONT_CACHE.lock().unwrap().as_ref().unwrap().2,
        )
        .unwrap();
        assert_eq!(
            subset_cache_json["glyphs"][0]["layers"][0]["shapes"][0]["nodes"][0]["x"],
            json!(25.0)
        );

        clear_font_cache();
    }

    #[test]
    fn apply_yjs_update_unrelated_layer_patch_preserves_filter_epoch() {
        clear_font_cache();

        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let mut glyph_b = font_json["glyphs"][0].clone();
        glyph_b["name"] = json!("B");
        glyph_b["codepoints"] = json!([66]);
        glyph_b["layers"][0]["width"] = json!(620);
        font_json["glyphs"].as_array_mut().unwrap().push(glyph_b);
        store_font_from_value(font_json).unwrap();

        let subset_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let subset_font: babelfont::Font = serde_json::from_value(subset_json).unwrap();
        store_subset_font_cache("A", &subset_font).unwrap();
        *FILTERED_FONT_CACHE.lock().unwrap() = Some(FilteredFontCacheEntry {
            subset_key: "A".to_string(),
            filter_epoch: FILTER_EPOCH.load(Ordering::Relaxed),
            cache_epoch: FONT_CACHE_EPOCH.load(Ordering::Relaxed),
            options_fingerprint: 0,
            font: Arc::new(subset_font.clone()),
        });

        let author_doc = Doc::new();
        let font_map = author_doc.get_or_insert_map("font");
        let layer_map: yrs::MapRef;
        {
            let mut txn = author_doc.transact_mut();
            let glyphs_map: yrs::MapRef =
                font_map.insert(&mut txn, "glyphs", MapPrelim::<Any>::new());
            let glyph_map: yrs::MapRef = glyphs_map.insert(&mut txn, "B", MapPrelim::<Any>::new());
            let layers_map: yrs::MapRef =
                glyph_map.insert(&mut txn, "layers", MapPrelim::<Any>::new());
            layer_map = layers_map.insert(&mut txn, "layer-1", MapPrelim::<Any>::new());
            layer_map.insert(&mut txn, "id", "layer-1");
            layer_map.insert(&mut txn, "width", Any::Number(620.0));
            layer_map.insert(&mut txn, "shapes", ArrayPrelim::from(Vec::<Any>::new()));
            layer_map.insert(&mut txn, "anchors", ArrayPrelim::from(Vec::<Any>::new()));
        }

        let initial_update = author_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let base_state_vector = author_doc.transact().state_vector();
        {
            let mut txn = author_doc.transact_mut();
            layer_map.insert(&mut txn, "width", Any::Number(630.0));
        }
        let incremental_update = author_doc.transact().encode_diff_v1(&base_state_vector);

        let worker_doc = Doc::new();
        {
            let update = yrs::Update::decode_v1(initial_update.as_slice()).unwrap();
            let mut txn = worker_doc.transact_mut();
            txn.apply_update(update);
        }
        *Y_DOC.lock().unwrap() = Some(worker_doc);

        let filter_epoch_before = FILTER_EPOCH.load(Ordering::Relaxed);

        apply_yjs_update(
            incremental_update.as_slice(),
            r#"{
                "changedGlyphs": ["B"],
                "layerTargets": [{ "glyphName": "B", "layerId": "layer-1" }]
            }"#,
        )
        .unwrap();

        assert_eq!(FILTER_EPOCH.load(Ordering::Relaxed), filter_epoch_before);
        assert!(FILTERED_FONT_CACHE.lock().unwrap().is_some());
        assert_eq!(
            CANONICAL_JSON_CACHE.lock().unwrap().as_ref().unwrap()["glyphs"][1]["layers"][0]
                ["width"],
            json!(630)
        );
        assert_eq!(
            SUBSET_JSON_CACHE.lock().unwrap().as_ref().unwrap().2["glyphs"][0]["layers"][0]
                ["width"],
            json!(600.0)
        );

        clear_font_cache();
    }

    #[test]
    fn apply_yjs_update_unrelated_deletions_preserve_filter_epoch() {
        clear_font_cache();

        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let mut glyph_b = font_json["glyphs"][0].clone();
        glyph_b["name"] = json!("B");
        glyph_b["codepoints"] = json!([66]);
        glyph_b["layers"][0]["width"] = json!(620);
        font_json["glyphs"].as_array_mut().unwrap().push(glyph_b);
        store_font_from_value(font_json).unwrap();

        let subset_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let subset_font: babelfont::Font = serde_json::from_value(subset_json).unwrap();
        store_subset_font_cache("A", &subset_font).unwrap();
        *FILTERED_FONT_CACHE.lock().unwrap() = Some(FilteredFontCacheEntry {
            subset_key: "A".to_string(),
            filter_epoch: FILTER_EPOCH.load(Ordering::Relaxed),
            cache_epoch: FONT_CACHE_EPOCH.load(Ordering::Relaxed),
            options_fingerprint: 0,
            font: Arc::new(subset_font.clone()),
        });

        let author_doc = Doc::new();
        let font_map = author_doc.get_or_insert_map("font");
        let glyphs_map: yrs::MapRef;
        let layers_map: yrs::MapRef;
        {
            let mut txn = author_doc.transact_mut();
            glyphs_map = font_map.insert(&mut txn, "glyphs", MapPrelim::<Any>::new());
            let glyph_map: yrs::MapRef = glyphs_map.insert(&mut txn, "B", MapPrelim::<Any>::new());
            layers_map = glyph_map.insert(&mut txn, "layers", MapPrelim::<Any>::new());
            let layer_map: yrs::MapRef =
                layers_map.insert(&mut txn, "layer-1", MapPrelim::<Any>::new());
            layer_map.insert(&mut txn, "id", "layer-1");
            layer_map.insert(&mut txn, "width", Any::Number(620.0));
            layer_map.insert(&mut txn, "shapes", ArrayPrelim::from(Vec::<Any>::new()));
            layer_map.insert(&mut txn, "anchors", ArrayPrelim::from(Vec::<Any>::new()));
        }

        let initial_update = author_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let base_state_vector = author_doc.transact().state_vector();
        {
            let mut txn = author_doc.transact_mut();
            layers_map.remove(&mut txn, "layer-1");
        }
        let layer_delete_update = author_doc.transact().encode_diff_v1(&base_state_vector);

        let worker_doc = Doc::new();
        {
            let update = yrs::Update::decode_v1(initial_update.as_slice()).unwrap();
            let mut txn = worker_doc.transact_mut();
            txn.apply_update(update);
        }
        *Y_DOC.lock().unwrap() = Some(worker_doc);

        let filter_epoch_before = FILTER_EPOCH.load(Ordering::Relaxed);

        apply_yjs_update(
            layer_delete_update.as_slice(),
            r#"{
                "changedGlyphs": ["B"],
                "layerTargets": [{ "glyphName": "B", "layerId": "layer-1" }]
            }"#,
        )
        .unwrap();

        assert_eq!(FILTER_EPOCH.load(Ordering::Relaxed), filter_epoch_before);
        assert!(FILTERED_FONT_CACHE.lock().unwrap().is_some());
        assert!(
            CANONICAL_JSON_CACHE.lock().unwrap().as_ref().unwrap()["glyphs"][1]["layers"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            SUBSET_JSON_CACHE.lock().unwrap().as_ref().unwrap().2["glyphs"][0]["layers"][0]
                ["width"],
            json!(600.0)
        );

        let base_state_vector = author_doc.transact().state_vector();
        {
            let mut txn = author_doc.transact_mut();
            glyphs_map.remove(&mut txn, "B");
        }
        let glyph_delete_update = author_doc.transact().encode_diff_v1(&base_state_vector);

        apply_yjs_update(
            glyph_delete_update.as_slice(),
            r#"{
                "changedGlyphs": ["B"],
                "layerTargets": []
            }"#,
        )
        .unwrap();

        assert_eq!(FILTER_EPOCH.load(Ordering::Relaxed), filter_epoch_before);
        assert!(FILTERED_FONT_CACHE.lock().unwrap().is_some());
        assert_eq!(
            CANONICAL_JSON_CACHE.lock().unwrap().as_ref().unwrap()["glyphs"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            SUBSET_JSON_CACHE.lock().unwrap().as_ref().unwrap().2["glyphs"][0]["name"],
            json!("A")
        );

        clear_font_cache();
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
    fn refresh_masters_related_caches_updates_all_cached_views() {
        clear_font_cache();

        let canonical_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let font_cache: babelfont::Font = serde_json::from_value(canonical_json.clone()).unwrap();
        set_canonical_json_cache(canonical_json.clone());
        *FONT_CACHE.lock().unwrap() = Some(font_cache);

        let subset_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let subset_font: babelfont::Font = serde_json::from_value(subset_json.clone()).unwrap();
        *SUBSET_JSON_CACHE.lock().unwrap() = Some(("A".to_string(), 1, subset_json.clone()));
        *SUBSET_GLYPH_INDEX_CACHE.lock().unwrap() =
            Some(("A".to_string(), build_glyph_index(&subset_json)));
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
            SUBSET_FONT_CACHE
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .2
                .masters[0]
                .name
                .get_default()
                .map(|value| value.as_str()),
            Some("Renamed Regular")
        );
    }

    #[test]
    fn refresh_kerning_related_caches_updates_canonical_rtl_kerning() {
        clear_font_cache();

        let old_rtl_kerning = json!({
            "master-regular": {
                "@MMK_R_A": { "@MMK_L_V": -10 }
            }
        });
        let mut canonical_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        canonical_json["format_specific"]["com.schriftgestalt.Glyphs.kerningRTL"] =
            old_rtl_kerning.clone();
        set_canonical_json_cache(canonical_json.clone());

        let subset_json = canonical_json.clone();
        *SUBSET_JSON_CACHE.lock().unwrap() = Some(("A".to_string(), 1, subset_json.clone()));

        let doc = Doc::new();
        let font_map = doc.get_or_insert_map("font");
        {
            let mut txn = doc.transact_mut();
            let masters: yrs::ArrayRef =
                font_map.insert(&mut txn, "masters", ArrayPrelim::from(Vec::<Any>::new()));
            let master: yrs::MapRef = masters.push_back(&mut txn, MapPrelim::<Any>::new());
            master.insert(&mut txn, "kerning", MapPrelim::<Any>::new());

            let format_specific: yrs::MapRef =
                font_map.insert(&mut txn, "format_specific", MapPrelim::<Any>::new());
            let rtl_kerning: yrs::MapRef = format_specific.insert(
                &mut txn,
                "com.schriftgestalt.Glyphs.kerningRTL",
                MapPrelim::<Any>::new(),
            );
            let master_rtl: yrs::MapRef =
                rtl_kerning.insert(&mut txn, "master-regular", MapPrelim::<Any>::new());
            let first: yrs::MapRef =
                master_rtl.insert(&mut txn, "@MMK_R_A", MapPrelim::<Any>::new());
            first.insert(&mut txn, "@MMK_L_V", Any::Number(-80.0));
        }

        let txn = doc.transact();
        refresh_kerning_related_caches_from_ydoc(&txn, true, false).unwrap();

        let expected_rtl_kerning = json!({
            "master-regular": {
                "@MMK_R_A": { "@MMK_L_V": -80 }
            }
        });
        assert_eq!(
            CANONICAL_JSON_CACHE.lock().unwrap().as_ref().unwrap()["format_specific"]
                ["com.schriftgestalt.Glyphs.kerningRTL"],
            expected_rtl_kerning
        );
        assert_eq!(
            SUBSET_JSON_CACHE.lock().unwrap().as_ref().unwrap().2["format_specific"]
                ["com.schriftgestalt.Glyphs.kerningRTL"],
            expected_rtl_kerning
        );

        clear_font_cache();
    }

    #[test]
    fn refresh_debug_font_caches_from_canonical_cache_rotates_fingerprint_and_clears_debug_state() {
        clear_font_cache();

        let canonical_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        set_canonical_json_cache(canonical_json);

        let original_fingerprint = COMMITTED_FONT_FINGERPRINT.lock().unwrap().clone().unwrap();
        *LAST_DEBUG_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = Some("debug-key".to_string());
        DEBUG_SETTINGS_TO_FONT_HASH_CACHE
            .lock()
            .unwrap()
            .insert("settings".to_string(), "hash".to_string());
        DEBUG_FONT_BYTES_CACHE
            .lock()
            .unwrap()
            .insert("hash".to_string(), vec![1, 2, 3]);

        let mut mutated_json = CANONICAL_JSON_CACHE.lock().unwrap().clone().unwrap();
        mutated_json["glyphs"][0]["name"] = json!("A.alt");
        *CANONICAL_JSON_CACHE.lock().unwrap() = Some(mutated_json);

        refresh_debug_font_caches_from_canonical_cache().unwrap();

        let refreshed_fingerprint = COMMITTED_FONT_FINGERPRINT.lock().unwrap().clone().unwrap();
        assert_ne!(refreshed_fingerprint, original_fingerprint);
        assert!(LAST_DEBUG_LAYOUT_CLOSURE_CACHE_KEY
            .lock()
            .unwrap()
            .is_none());
        assert!(DEBUG_SETTINGS_TO_FONT_HASH_CACHE.lock().unwrap().is_empty());
        assert!(DEBUG_FONT_BYTES_CACHE.lock().unwrap().entries.is_empty());
    }

    #[test]
    fn dump_layer_state_json_reports_canonical_subset_and_ydoc_layers() {
        clear_font_cache();

        let canonical_json = json!({
            "glyphs": [
                {
                    "name": "alef",
                    "layers": [
                        {
                            "id": "regular",
                            "width": 400,
                            "shapes": [],
                            "anchors": []
                        }
                    ]
                }
            ]
        });
        set_canonical_json_cache(canonical_json);

        let subset_json = json!({
            "glyphs": [
                {
                    "name": "alef",
                    "layers": [
                        {
                            "id": "regular",
                            "width": 405,
                            "shapes": [],
                            "anchors": []
                        }
                    ]
                }
            ]
        });
        *SUBSET_JSON_CACHE.lock().unwrap() = Some(("alef".to_string(), 7, subset_json.clone()));
        *SUBSET_GLYPH_INDEX_CACHE.lock().unwrap() =
            Some(("alef".to_string(), build_glyph_index(&subset_json)));

        let doc = Doc::new();
        let font_map = doc.get_or_insert_map("font");
        {
            let mut txn = doc.transact_mut();
            let glyphs_map: yrs::MapRef =
                font_map.insert(&mut txn, "glyphs", MapPrelim::<Any>::new());
            let glyph_map: yrs::MapRef =
                glyphs_map.insert(&mut txn, "alef", MapPrelim::<Any>::new());
            let layers_map: yrs::MapRef =
                glyph_map.insert(&mut txn, "layers", MapPrelim::<Any>::new());
            let layer_map: yrs::MapRef =
                layers_map.insert(&mut txn, "regular", MapPrelim::<Any>::new());
            layer_map.insert(&mut txn, "width", Any::Number(410.0));
            layer_map.insert(&mut txn, "id", "regular");
            layer_map.insert(&mut txn, "anchors", ArrayPrelim::from(Vec::<Any>::new()));
            layer_map.insert(&mut txn, "shapes", ArrayPrelim::from(Vec::<Any>::new()));
        }
        *Y_DOC.lock().unwrap() = Some(doc);

        let dump_json =
            dump_layer_state_json(r#"[{"glyphName":"alef","layerId":"regular"}]"#).unwrap();
        let dump_value: serde_json::Value = serde_json::from_str(&dump_json).unwrap();

        assert!(dump_value["fontCacheEpoch"].as_u64().unwrap_or_default() >= 1);
        assert_eq!(dump_value["hasCanonicalCache"], json!(true));
        assert_eq!(dump_value["hasSubsetCache"], json!(true));
        assert_eq!(dump_value["hasYDoc"], json!(true));
        assert_eq!(dump_value["subset"]["subsetKey"], json!("alef"));
        assert_eq!(dump_value["subset"]["subsetEpoch"], json!(7));
        assert_eq!(dump_value["targets"][0]["canonicalPresent"], json!(true));
        assert_eq!(dump_value["targets"][0]["subsetPresent"], json!(true));
        assert_eq!(dump_value["targets"][0]["ydocPresent"], json!(true));
        assert_eq!(
            dump_value["targets"][0]["canonicalLayer"]["width"],
            json!(400)
        );
        assert_eq!(dump_value["targets"][0]["subsetLayer"]["width"], json!(405));
        assert_eq!(dump_value["targets"][0]["ydocLayer"]["width"], json!(410));

        clear_font_cache();
    }
}
