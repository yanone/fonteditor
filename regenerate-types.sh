#!/bin/bash
# Regenerate babelfont.d.ts from babelfont-rs
#
# This script extracts TypeScript type definitions from the official babelfont-ts
# package maintained within the babelfont-rs repository.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBAPP_DIR="$SCRIPT_DIR/webapp"
OUTPUT_FILE="$WEBAPP_DIR/js/babelfont.d.ts"

echo "🔄 Regenerating TypeScript definitions from babelfont-ts"
echo "========================================================="
echo ""

echo "📋 Step 1/3: Resolving local babelfont-rs clone..."
BABELFONT_RS_DIR="${BABELFONT_RS_DIR:-$SCRIPT_DIR/../babelfont-rs}"

if [ ! -d "$BABELFONT_RS_DIR/.git" ]; then
    echo "❌ Local babelfont-rs clone not found at $BABELFONT_RS_DIR"
    echo "   Clone it next to this repo:"
    echo "   git clone https://github.com/simoncozens/babelfont-rs.git \"$SCRIPT_DIR/../babelfont-rs\""
    exit 1
fi

if ! git -C "$BABELFONT_RS_DIR" pull --ff-only --quiet; then
    echo "❌ Failed to fast-forward local babelfont-rs clone at $BABELFONT_RS_DIR"
    echo "   Ensure the clone has a clean branch that tracks origin (e.g. main)."
    exit 1
fi

COMMIT=$(git -C "$BABELFONT_RS_DIR" rev-parse --short HEAD)
echo "✅ Using local babelfont-rs at $BABELFONT_RS_DIR@$COMMIT"
echo ""

# Extract types from babelfont-ts/src/underlying.ts
echo "⚙️  Step 2/3: Extracting TypeScript definitions from babelfont-ts..."
UNDERLYING_FILE="$BABELFONT_RS_DIR/babelfont-ts/src/underlying.ts"

if [ ! -f "$UNDERLYING_FILE" ]; then
    echo "❌ underlying.ts not found at $UNDERLYING_FILE"
    cd "$SCRIPT_DIR"
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
} > "$OUTPUT_FILE"

echo "✅ Generated TypeScript definitions"
echo ""

echo "📝 Step 3/3: Installing new type definitions..."

# Add custom properties used in this codebase
echo "🔧 Adding custom properties..."
# Make DecomposedAffine fields optional (babelfont-rs outputs them with defaults)
perl -i -pe '
    $in_decomposed = 1 if /^    export type DecomposedAffine = \{/;
    if ($in_decomposed) {
        s/translation: \[number, number\];/translation?: [number, number];/;
        s/scale: \[number, number\];/scale?: [number, number];/;
        s/rotation: number;/rotation?: number;/;
        s/skew: \[number, number\];/skew?: [number, number];/;
    }
    $in_decomposed = 0 if $in_decomposed && /^    \}/;
' "$OUTPUT_FILE"
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

# Format with prettier
echo "🎨 Formatting with prettier..."
cd "$WEBAPP_DIR"
npx prettier --write "js/babelfont.d.ts"

cd "$SCRIPT_DIR"

echo "✅ Type definitions regenerated successfully!"
echo ""
echo "File: $OUTPUT_FILE"
echo "From: local babelfont-rs clone at $BABELFONT_RS_DIR@$COMMIT (babelfont-ts/src/underlying.ts)"
echo ""
echo "Next steps:"
echo "  1. Review changes: git diff webapp/js/babelfont.d.ts"
echo "  2. Update babelfont-model.ts to match new types if needed"
echo "  3. Run TypeScript check: cd webapp && npx tsc --noEmit"
echo ""
