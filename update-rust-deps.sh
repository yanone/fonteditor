#!/bin/bash
# Update all Rust components to their latest versions
# This script updates Rust toolchains, wasm-pack, and Cargo dependencies

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WASM_DIR="$SCRIPT_DIR/babelfont-fontc-build"

echo "🔄 Updating all Rust components to latest versions"
echo "=================================================="
echo ""

# Step 0: Fetch latest babelfont-rs commit and update Cargo.toml
LATEST_COMMIT=""
if [ -d "$WASM_DIR" ]; then
    echo "📦 Step 0/5: Fetching latest babelfont-rs commit and updating Cargo.toml..."
    echo ""
    
    # Fetch latest commit
    LATEST_COMMIT=$(curl -s https://api.github.com/repos/simoncozens/babelfont-rs/commits/main | grep -o '"sha": "[^"]*"' | head -1 | cut -d'"' -f4)

    if [ -z "$LATEST_COMMIT" ]; then
        echo "❌ Failed to fetch latest commit from GitHub API"
        exit 1
    fi

    echo "Latest babelfont-rs commit: $LATEST_COMMIT"
    echo ""
    
    # Update Cargo.toml with the new commit hash
    cd "$WASM_DIR"
    
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        sed -i '' "s/rev = \"[^\"]*\"/rev = \"$LATEST_COMMIT\"/g" Cargo.toml
    else
        # Linux
        sed -i "s/rev = \"[^\"]*\"/rev = \"$LATEST_COMMIT\"/g" Cargo.toml
    fi
    
    echo "✅ Updated Cargo.toml with commit: $LATEST_COMMIT"
    echo ""
fi

# Step 1: Update Rust toolchains
echo "📦 Step 1/5: Updating Rust toolchains..."
echo ""
rustup update

if [ $? -ne 0 ]; then
    echo "❌ Failed to update Rust toolchains"
    exit 1
fi

echo ""
echo "✅ Rust toolchains updated to: $(rustc --version)"
echo ""

# Step 2: Ensure nightly toolchain with WASM target
echo "📦 Step 2/5: Ensuring Rust nightly with WASM support..."
echo ""
rustup toolchain install nightly --profile minimal --component rust-std --component rust-src --target wasm32-unknown-unknown

if [ $? -ne 0 ]; then
    echo "❌ Failed to install/update nightly toolchain"
    exit 1
fi

echo ""
echo "✅ Nightly toolchain ready: $(rustup run nightly rustc --version)"
echo ""

# Step 3: Update wasm-pack
echo "📦 Step 3/5: Updating wasm-pack to latest version..."
echo ""
cargo install wasm-pack --force

if [ $? -ne 0 ]; then
    echo "❌ Failed to update wasm-pack"
    exit 1
fi

echo ""
echo "✅ wasm-pack updated to: $(wasm-pack --version)"
echo ""

# Step 4: Update cargo dependencies
echo "📦 Step 4/5: Updating cargo dependencies..."
echo ""

if [ ! -d "$WASM_DIR" ]; then
    echo "⚠️  Warning: Directory not found: $WASM_DIR"
    echo "   Run ./build-fontc-wasm.sh to create the project first"
    echo ""
    echo "Skipping cargo update..."
else
    cd "$WASM_DIR"
    
    cargo update --aggressive

    if [ $? -ne 0 ]; then
        echo "❌ Failed to update Cargo dependencies"
        exit 1
    fi

    echo ""
    echo "✅ Cargo dependencies updated to latest versions"

    # Show the updated dependency tree (brief)
    echo ""
    echo "📋 Updated dependency versions:"
    cargo tree --depth 1 | grep -E "(babelfont|fontc|fontir)" || true
fi

echo ""
echo "=================================================="
echo "✅ All Rust components updated successfully!"
echo ""
echo "Summary:"
echo "  - Rust stable: $(rustc --version)"
echo "  - Rust nightly: $(rustup run nightly rustc --version)"
echo "  - wasm-pack: $(wasm-pack --version)"
if [ -d "$WASM_DIR" ]; then
    echo "  - Cargo dependencies: updated in $WASM_DIR"
fi
echo ""
echo "Next steps:"
echo "  1. Run: ./build-fontc-wasm.sh"
echo "  2. Test: cd webapp/compilation-test && node compile-test.mjs"
echo ""
