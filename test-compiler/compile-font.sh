#!/bin/bash
# Combined font compilation test script
# 
# Usage:
#   ./compile-font.sh input.glyphs [output.ttf]
#   ./compile-font.sh input.ufo [output.ttf]
#   ./compile-font.sh input.designspace [output.ttf]

set -e  # Exit on error

# Check arguments
if [ $# -lt 1 ]; then
    echo "Usage: ./compile-font.sh input.font [output.ttf]"
    echo ""
    echo "Supported input formats:"
    echo "  - .glyphs"
    echo "  - .ufo"
    echo "  - .designspace"
    echo "  - .babelfont"
    echo "  - .context"
    exit 1
fi

INPUT_FILE="$1"
OUTPUT_TTF="${2:-${INPUT_FILE%.*}.ttf}"

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Create temp file for intermediate JSON (placed inside test-compiler/)
# Use a consistent filename so it gets overwritten on each run (not deleted)
INPUT_BASENAME=$(basename "${INPUT_FILE%.*}")
TEMP_JSON="${SCRIPT_DIR}/${INPUT_BASENAME}.babelfont.json"

echo "🔧 Font Compilation Test"
echo "📖 Input:  $INPUT_FILE"
echo "📝 Output: $OUTPUT_TTF"
echo ""

# Step 1: Export to .babelfont JSON
echo "========================================="
echo "Step 1: Export to .babelfont JSON"
echo "========================================="
python3 "$SCRIPT_DIR/1-export-to-json.py" "$INPUT_FILE" "$TEMP_JSON"

echo ""
echo "========================================="
echo "Step 2: Compile to TTF using WASM"
echo "========================================="
node "$SCRIPT_DIR/2-compile-to-ttf.js" "$TEMP_JSON" "$OUTPUT_TTF"

echo ""
echo "========================================="
echo "🎉 Success!"
echo "========================================="
echo "Compiled font saved to: $OUTPUT_TTF"

# Show file info
if command -v otfinfo &> /dev/null; then
    echo ""
    echo "Font info:"
    otfinfo -i "$OUTPUT_TTF" 2>/dev/null || true
fi
