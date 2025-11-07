use wasm_bindgen::prelude::*;

// Set up panic hook for better error messages
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

/// Compile a font from babelfont JSON directly to TTF
/// 
/// This is the main entry point that takes a .babelfont JSON string
/// and produces compiled TTF bytes.
/// 
/// # Arguments
/// * `babelfont_json` - JSON string in .babelfont format
/// 
/// # Returns
/// * `Vec<u8>` - Compiled TTF font bytes
#[wasm_bindgen]
pub fn compile_babelfont(babelfont_json: &str) -> Result<Vec<u8>, JsValue> {
    // Step 1: Deserialize JSON → babelfont::Font
    let font: babelfont::Font = serde_json::from_str(babelfont_json)
        .map_err(|e| JsValue::from_str(&format!("JSON parse error: {}", e)))?;
    
    // Step 2: Create BabelfontIrSource from the Font
    let source = babelfont::convertors::fontir::BabelfontIrSource::new_from_memory(font)
        .map_err(|e| JsValue::from_str(&format!("Failed to create IR source: {}", e)))?;
    
    // Step 3: Use fontc to compile
    // Create a temporary directory for fontc's intermediate files
    // Note: In WASM, this doesn't actually write to disk
    let build_dir = std::path::Path::new("/tmp/fontc_build");
    let flags = fontir::orchestration::Flags::default();
    
    let compiled_font = fontc::generate_font(
        Box::new(source),
        build_dir,
        None,
        flags,
        false,
    ).map_err(|e| JsValue::from_str(&format!("Compilation failed: {:?}", e)))?;
    
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
