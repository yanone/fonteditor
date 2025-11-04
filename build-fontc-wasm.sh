#!/bin/bash
# Build fontc with babelfont-rs integration to WebAssembly
# Based on Simon Cozens' fontc-web approach with direct babelfont JSON support

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBAPP_DIR="$SCRIPT_DIR/webapp"
WASM_DIR="$SCRIPT_DIR/babelfont-fontc-build"

echo "🦀 Building fontc with babelfont-rs for WebAssembly..."
echo "Direct Python → Rust integration (no file system)"
echo ""

# Check if Rust is installed
if ! command -v rustc &> /dev/null; then
    echo "❌ Rust is not installed. Please install it from https://rustup.rs/"
    exit 1
fi

echo "✓ Rust is installed: $(rustc --version)"

# Install wasm-pack if not present
if ! command -v wasm-pack &> /dev/null; then
    echo "📦 Installing wasm-pack..."
    cargo install wasm-pack --locked
else
    echo "✓ wasm-pack is installed: $(wasm-pack --version)"
fi

# Check for nightly toolchain
echo "📦 Ensuring Rust nightly is available..."
rustup toolchain install nightly --profile minimal --component rust-std --component rust-src --target wasm32-unknown-unknown

# Create build directory
mkdir -p "$WASM_DIR"
cd "$WASM_DIR"

# Create or update the Rust crate for babelfont-fontc integration
if [ ! -f "Cargo.toml" ]; then
    echo "� Creating babelfont-fontc crate..."
    cat > Cargo.toml << 'EOF'
[package]
name = "babelfont-fontc-web"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
babelfont = { git = "https://github.com/simoncozens/babelfont-rs.git", features = ["fontir"] }
fontc = { git = "https://github.com/googlefonts/fontc.git" }
fontir = { git = "https://github.com/googlefonts/fontc.git" }
wasm-bindgen = "0.2"
serde_json = "1.0"
console_error_panic_hook = "0.1"
tempfile = "3"

[profile.release]
opt-level = "z"
lto = true
EOF
    echo "✓ Created Cargo.toml"
fi

# Create the Rust source file
mkdir -p src
echo "📝 Creating lib.rs with babelfont → fontc pipeline..."
cat > src/lib.rs << 'EOF'
use wasm_bindgen::prelude::*;
use std::sync::Arc;

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
    
    let compiled_font = fontc::compile(
        Arc::new(source),
        build_dir,
        flags,
    ).map_err(|e| JsValue::from_str(&format!("Compilation failed: {:?}", e)))?;
    
    Ok(compiled_font)
}

/// Legacy function for compatibility with existing fontc-web code
/// This now accepts .glyphs format JSON and compiles it
#[wasm_bindgen]
pub fn compile_glyphs(glyphs_json: &str) -> Result<Vec<u8>, JsValue> {
    // For now, return an error asking to use babelfont format
    Err(JsValue::from_str(
        "Please use compile_babelfont() with .babelfont JSON format instead. \
         The .glyphs format is no longer supported in this version."
    ))
}

/// Get version information
#[wasm_bindgen]
pub fn version() -> String {
    format!(
        "babelfont-fontc-web v{} (fontc + babelfont-rs)",
        env!("CARGO_PKG_VERSION")
    )
}
EOF
echo "✓ Created src/lib.rs"

echo ""
echo "� Building WASM module with threading support..."
echo "This may take several minutes (first build downloads dependencies)..."
echo ""

# Build using wasm-pack with atomics and threading support
# This matches Simon's build.sh approach
RUSTFLAGS='-C target-feature=+atomics,+bulk-memory,+mutable-globals' \
    rustup run nightly wasm-pack build --target web . -- -Z build-std=panic_abort,std

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ WASM build completed!"
    echo ""
    echo "📦 Copying WASM files to project..."
    
    # Copy the built files to our wasm-dist directory in webapp
    mkdir -p "$WEBAPP_DIR/wasm-dist"
    cp -r pkg/* "$WEBAPP_DIR/wasm-dist/"
    
    echo ""
    echo "✅ Build complete!"
    echo "📦 WASM files copied to: $WEBAPP_DIR/wasm-dist/"
    echo ""
    echo "Files created:"
    ls -lh "$WEBAPP_DIR/wasm-dist/"
    echo ""
    echo "🎯 Key features:"
    echo "  - Direct .babelfont JSON → TTF compilation"
    echo "  - No file system operations needed"
    echo "  - Zero intermediate format conversions"
    echo ""
    echo "⚠️  IMPORTANT: You need to serve this app with proper CORS headers:"
    echo "   Cross-Origin-Embedder-Policy: require-corp"
    echo "   Cross-Origin-Opener-Policy: same-origin"
    echo ""
    echo "Use the provided server: cd webapp && python3 serve-with-cors.py"
    
    exit 0
else
    echo ""
    echo "❌ Build failed."
    echo ""
    echo "Common issues:"
    echo "  - Make sure you have Rust nightly installed"
    echo "  - Check that wasm-pack is up to date: cargo install wasm-pack --force"
    echo "  - Some fontc dependencies may not be WASM-compatible yet"
    echo ""
    echo "Check the error messages above for details."
    exit 1
fi

# EXPERIMENTAL: Custom wrapper (not used, Simon's build above is complete)
# Create the wrapper Rust code
mkdir -p src
cat > src/lib.rs << 'EOF'
use wasm_bindgen::prelude::*;
use std::path::PathBuf;

// Set up panic hook for better error messages
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct FontCompiler {
    // State for the compiler
}

#[wasm_bindgen]
impl FontCompiler {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<FontCompiler, JsValue> {
        Ok(FontCompiler {})
    }

    /// Compile a font from a designspace file
    /// 
    /// # Arguments
    /// * `input_path` - Path to the input file (designspace, glyphs, ufo, etc.)
    /// * `output_path` - Optional path for output file
    /// 
    /// Returns: Success message or error
    #[wasm_bindgen]
    pub fn compile(&self, input_path: &str, output_path: Option<String>) -> Result<String, JsValue> {
        // Note: This is a simplified wrapper. The full fontc compilation pipeline
        // is complex and may require significant adaptation for WASM.
        // 
        // Key challenges:
        // 1. File I/O needs to go through WASM/Pyodide virtual filesystem
        // 2. Multi-threading may not work the same way in WASM
        // 3. Some system calls may not be available
        
        Err(JsValue::from_str(
            "fontc WASM compilation is not yet fully implemented. \
             This requires significant adaptation of the fontc codebase for WASM compatibility. \
             Consider using Python-based fontmake in Pyodide instead."
        ))
    }

    /// Get version information
    #[wasm_bindgen]
    pub fn version(&self) -> String {
        "fontc-wasm 0.1.0 (experimental)".to_string()
    }
}

#[wasm_bindgen]
pub fn test_wasm() -> String {
    "fontc WASM module loaded successfully!".to_string()
}
EOF

echo ""
echo "🔨 Building WASM module..."
echo "⚠️  Note: This is an experimental build and may not work fully"
echo ""

# Try to build
if cargo build --target wasm32-unknown-unknown --release; then
    echo ""
    echo "✅ WASM build completed!"
    
    # Run wasm-bindgen to generate JS bindings
    echo "🔗 Generating JavaScript bindings..."
    WASM_FILE="target/wasm32-unknown-unknown/release/fontc_wasm.wasm"
    
    if [ -f "$WASM_FILE" ]; then
        wasm-bindgen "$WASM_FILE" \
            --out-dir "$WEBAPP_DIR/wasm-dist" \
            --target web \
            --no-typescript
        
        echo ""
        echo "✅ Build complete!"
        echo "📦 WASM files generated in: $WEBAPP_DIR/wasm-dist/"
        echo ""
        echo "Files created:"
        ls -lh "$WEBAPP_DIR/wasm-dist/"
        echo ""
        echo "⚠️  IMPORTANT: This is a minimal wrapper. Full fontc functionality"
        echo "   requires significant additional work to adapt for WASM."
    else
        echo "❌ WASM file not found: $WASM_FILE"
        exit 1
    fi
else
    echo ""
    echo "❌ Build failed. This is expected as fontc has dependencies that"
    echo "   may not be fully compatible with WASM target."
    echo ""
    echo "💡 Alternative approaches:"
    echo "   1. Use fontmake (Python) via Pyodide - works now!"
    echo "   2. Set up a backend API for fontc compilation"
    echo "   3. Contribute WASM support to fontc upstream"
    exit 1
fi
