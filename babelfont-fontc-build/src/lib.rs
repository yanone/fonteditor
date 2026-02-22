use babelfont::{
    convertors::fontir::{BabelfontIrSource, CompilationOptions},
    filters::FontFilter as _,
};
use smol_str::SmolStr;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
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
static PERF_SPAN_COUNTER: AtomicU64 = AtomicU64::new(0);

const PERF_PREFIX: &str = "cp:wasm";

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
    stage: String,
    start_mark: String,
    end_mark: String,
}

impl PerfSpan {
    fn start(stage: &str) -> Self {
        let span_id = PERF_SPAN_COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
        let start_mark = format!("{}:{}#{}:start", PERF_PREFIX, stage, span_id);
        let end_mark = format!("{}:{}#{}:end", PERF_PREFIX, stage, span_id);
        perf_mark(&start_mark);

        Self {
            stage: stage.to_string(),
            start_mark,
            end_mark,
        }
    }
}

impl Drop for PerfSpan {
    fn drop(&mut self) {
        perf_mark(&self.end_mark);
        perf_measure(
            &format!("{}:{}", PERF_PREFIX, self.stage),
            &self.start_mark,
            &self.end_mark,
        );
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
    let compiled_font = BabelfontIrSource::compile(font, options)
        .map_err(|e| JsValue::from_str(&format!("Compilation failed: {:?}", e)))?;
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

    let _cache_span = PerfSpan::start("store_font.cache_write");
    let mut cache = FONT_CACHE.lock().unwrap();
    *cache = Some(font);
    drop(_cache_span);

    // Clear the outline cache since font changed
    let _outline_clear_span = PerfSpan::start("store_font.clear_outline_cache");
    glyph_outlines::clear_outline_cache();
    drop(_outline_clear_span);

    Ok(())
}

/// Clear the cached font from memory
#[wasm_bindgen]
pub fn clear_font_cache() {
    let mut cache = FONT_CACHE.lock().unwrap();
    *cache = None;

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
pub fn interpolate_glyph(glyph_name: &str, location_json: &str) -> Result<String, JsValue> {
    let cache = FONT_CACHE.lock().unwrap();
    let font = cache
        .as_ref()
        .ok_or_else(|| JsValue::from_str("No font cached. Call store_font() first."))?;

    // Call the interpolation module function
    interpolation::interpolate_glyph(font, glyph_name, location_json)
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
    result.sort();

    // Serialize to JSON array
    let output = serde_json::to_string(&result)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize closure result: {}", e)))
        ?;
    drop(_result_span);

    Ok(output)
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
    let compiled_font = BabelfontIrSource::compile(font_clone, compilation_options)
        .map_err(|e| JsValue::from_str(&format!("Compilation failed: {:?}", e)))?;
    drop(_ir_compile_span);

    Ok(compiled_font)
}
