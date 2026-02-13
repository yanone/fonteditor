#!/bin/bash
set -e

echo "🔍 Checking for type drift from babelfont-rs..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BABELFONT_RS_DIR="${BABELFONT_RS_DIR:-$SCRIPT_DIR/../babelfont-rs}"

if [ ! -d "$BABELFONT_RS_DIR/.git" ]; then
    echo -e "${RED}❌ Error: Local babelfont-rs clone not found at $BABELFONT_RS_DIR${NC}"
    echo "   Clone it next to this repo:"
    echo "   git clone https://github.com/simoncozens/babelfont-rs.git \"$SCRIPT_DIR/../babelfont-rs\""
    exit 1
fi

BABELFONT_RS_COMMIT=$(git -C "$BABELFONT_RS_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")
echo "📦 Using local babelfont-rs clone: $BABELFONT_RS_DIR@$BABELFONT_RS_COMMIT"

# Generate types to temporary file
TEMP_TYPES=$(mktemp)
echo "🔨 Generating types from local babelfont-rs clone..."

# Run generate-types-stdout.sh (stderr goes to console, stdout to temp file)
if ! ./generate-types-stdout.sh > "$TEMP_TYPES"; then
    echo -e "${RED}❌ Error: Failed to generate types${NC}"
    rm -f "$TEMP_TYPES"
    exit 1
fi

# Compare with committed types
COMMITTED_TYPES="webapp/js/babelfont.d.ts"
if [ ! -f "$COMMITTED_TYPES" ]; then
    echo -e "${RED}❌ Error: $COMMITTED_TYPES not found${NC}"
    rm -f "$TEMP_TYPES"
    exit 1
fi

# Format both files with prettier for consistent comparison
echo "🎨 Formatting files with prettier..."
TEMP_FORMATTED=$(mktemp)
TEMP_COMMITTED_FORMATTED=$(mktemp)
if command -v npx &> /dev/null && [ -f "webapp/node_modules/.bin/prettier" ]; then
    # Run prettier from webapp directory to pick up .prettierrc
    (cd webapp && npx prettier --stdin-filepath js/babelfont.d.ts) < "$TEMP_TYPES" > "$TEMP_FORMATTED"
    (cd webapp && npx prettier --stdin-filepath js/babelfont.d.ts) < "$COMMITTED_TYPES" > "$TEMP_COMMITTED_FORMATTED"
    mv "$TEMP_FORMATTED" "$TEMP_TYPES"
    mv "$TEMP_COMMITTED_FORMATTED" "$COMMITTED_TYPES"
else
    echo "⚠️  Prettier not found, comparing raw files"
    rm -f "$TEMP_FORMATTED"
    rm -f "$TEMP_COMMITTED_FORMATTED"
fi

# Check if there are differences
if diff -q "$TEMP_TYPES" "$COMMITTED_TYPES" > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Type definitions are in sync with local babelfont-rs@$BABELFONT_RS_COMMIT${NC}"
    rm -f "$TEMP_TYPES"
    exit 0
else
    echo -e "${RED}❌ Type drift detected!${NC}"
    echo ""
    echo -e "${YELLOW}The committed type definitions (webapp/js/babelfont.d.ts) are out of sync${NC}"
    echo -e "${YELLOW}with the types from local babelfont-rs@$BABELFONT_RS_COMMIT${NC}"
    echo ""
    echo "To see the differences:"
    echo "  diff webapp/js/babelfont.d.ts <(./regenerate-types.sh)"
    echo ""
    echo "To fix this, run:"
    echo "  ./regenerate-types.sh > webapp/js/babelfont.d.ts"
    echo "  git add webapp/js/babelfont.d.ts"
    echo "  git commit -m 'Update type definitions from local babelfont-rs@$BABELFONT_RS_COMMIT'"
    echo ""
    
    # Show a preview of differences (first 20 lines)
    echo "Preview of differences:"
    diff -u "$COMMITTED_TYPES" "$TEMP_TYPES" | head -20
    echo "..."
    
    rm -f "$TEMP_TYPES"
    exit 1
fi
