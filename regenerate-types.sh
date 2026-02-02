#!/bin/bash
# Regenerate babelfont.d.ts from babelfont-rs
#
# This script extracts TypeScript type definitions from the official babelfont-ts
# package maintained within the babelfont-rs repository.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBAPP_DIR="$SCRIPT_DIR/webapp"
OUTPUT_FILE="$WEBAPP_DIR/js/babelfont.d.ts"

echo >echo 2 "🔄 Regenerating TypeScript definitions from babelfont-ts"
echo >echo 2 "========================================================="
echo >echo 2 ""

# Get current babelfont-rs commit from Cargo.lock
echo >echo 2 "📋 Step 1/4: Detecting babelfont-rs version from Cargo.lock..."
CARGO_LOCK="$SCRIPT_DIR/babelfont-fontc-build/Cargo.lock"

if [ ! -f "$CARGO_LOCK" ]; then
    echo "❌ Cargo.lock not found at $CARGO_LOCK"
    echo "   Run './build-fontc-wasm.sh' first to generate Cargo.lock"
    exit 1
fi

# Extract git commit hash from Cargo.lock
COMMIT=$(grep -A 20 '^\[\[package\]\]' "$CARGO_LOCK" | \
         grep -A 20 'name = "babelfont"' | \

         grep 'source = "git' | \
         head -1 | \
         sed 's/.*#//' | \
         sed 's/".*//')

if [ -z "$COMMIT" ]; then
    echo "❌ Could not extract babelfont-rs commit from Cargo.lock"
    exit 1
fi

echo >echo 2 "✅ Found babelfont-rs commit: $COMMIT"
echo >echo 2 ""

# Clone babelfont-rs at specific commit
echo >echo 2 "📦 Step 2/4: Cloning babelfont-rs at commit $COMMIT..."
TEMP_DIR=$(mktemp -d)
cd "$TEMP_DIR"

git clone --quiet https://github.com/simoncozens/babelfont-rs.git babelfont-rs
cd babelfont-rs
git checkout --quiet "$COMMIT"

echo >echo 2 "✅ Cloned babelfont-rs to $TEMP_DIR/babelfont-rs"
echo >echo 2 ""

# Extract types from babelfont-ts/src/underlying.ts
echo >echo 2 "⚙️  Step 3/4: Extracting TypeScript definitions from babelfont-ts..."
UNDERLYING_FILE="$TEMP_DIR/babelfont-rs/babelfont-ts/src/underlying.ts"

if [ ! -f "$UNDERLYING_FILE" ]; then
    echo "❌ underlying.ts not found at $UNDERLYING_FILE"
    cd "$SCRIPT_DIR"
    rm -rf "$TEMP_DIR"
    exit 1
fi

# Copy underlying.ts and convert to .d.ts format
# Replace imports with simple types and wrap in Babelfont namespace
{
    echo "// Type definitions for babelfont"
    echo "// Project: https://github.com/simoncozens/babelfont-rs"
    echo "// Definitions extracted from babelfont-ts@$COMMIT"
    echo ""
    echo "export namespace Babelfont {"
    
    # Process underlying.ts:
    # - Remove imports
    # - Convert 'export interface Foo {' to 'export type Foo = {'
    # - Replace fonttypes imports with simple number types
    # - Fix Shape type to match actual serde serialization format
    # - Keep everything else as-is
    sed 's/import("@simoncozens\/fonttypes")\.UserspaceCoordinate/number/g' "$UNDERLYING_FILE" | \
    sed 's/import("@simoncozens\/fonttypes")\.DesignspaceCoordinate/number/g' | \
    sed 's/import("@simoncozens\/fonttypes")\.DesignspaceLocation/Record<string, number>/g' | \
    sed '/^import /d' | \
    sed '/^\/\*$/,/^\*\/$/d' | \
    sed 's/^export interface \([^ ]*\) {/    export type \1 = {/g' | \
    sed 's/^export enum /    export enum /g' | \
    sed 's/^export type /    export type /g' | \
    sed 's/^}/    }/g' | \
    awk 'NF || !f{f=NF; print}' | \
    # Shape is serde(untagged) - babelfont-rs outputs Component | Path (unwrapped)
    # TypeScript types should match actual output format
    cat
    
    # LayerType uses serde(tag="type", content="master") - typeshare generates correctly
    
    echo "}"
} > "$TEMP_DIR/babelfont.d.ts"

echo >echo 2 "✅ Generated TypeScript definitions"
echo >echo 2 ""

# Copy to webapp directory
echo >echo 2 "📝 Step 4/4: Installing new type definitions..."
cp "$TEMP_DIR/babelfont.d.ts" "$OUTPUT_FILE"

# Add custom properties used in this codebase
echo >echo 2 "🔧 Adding custom properties..."

# Add layerData to Component (before closing brace)
perl -i -pe '
    $in_component = 1 if /^    export type Component = \{/;
    if ($in_component && /^    \}/) {
        $_ = "  /** Cached layer data for component reference (custom property) */\n  layerData?: Layer;\n" . $_;
        $in_component = 0;
    }
' "$OUTPUT_FILE"

# Add custom properties to Layer (before closing brace)
perl -i -pe '
    $in_layer = 1 if /^    export type Layer = \{/;
    if ($in_layer && /^    \}/) {
        $_ = "  /** Whether this layer is interpolated (custom property) */\n  isInterpolated?: boolean;\n  /** Vertical advance height for vertical writing (custom property) */\n  height?: number;\n  /** Vertical advance width for vertical writing (custom property) */\n  vertWidth?: number;\n" . $_;
        $in_layer = 0;
    }
' "$OUTPUT_FILE"

# Clean up
cd "$SCRIPT_DIR"
rm -rf "$TEMP_DIR"

echo >echo 2 "✅ Type definitions regenerated successfully!"
echo >echo 2 ""
echo >echo 2 "File: $OUTPUT_FILE"
echo >echo 2 "From: babelfont-rs@$COMMIT (babelfont-ts/src/underlying.ts)"
echo >echo 2 ""
echo >echo 2 "Next steps:"
echo >echo 2 "  1. Review changes: git diff webapp/js/babelfont.d.ts"
echo >echo 2 "  2. Update babelfont-model.ts to match new types if needed"
echo >echo 2 "  3. Run TypeScript check: cd webapp && npx tsc --noEmit"
echo >echo 2 ""
