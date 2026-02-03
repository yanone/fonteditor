#!/bin/bash
# Generate babelfont.d.ts to stdout (for type drift detection)
#
# This runs regenerate-types.sh and outputs the result to stdout

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMP_FILE=$(mktemp)
trap "rm -f $TEMP_FILE" EXIT

# Save current babelfont.d.ts location
ORIGINAL_FILE="$SCRIPT_DIR/webapp/js/babelfont.d.ts"

# Run regenerate-types.sh (it writes to webapp/js/babelfont.d.ts)
# but first backup the original
if [ -f "$ORIGINAL_FILE" ]; then
    cp "$ORIGINAL_FILE" "$TEMP_FILE"
fi

# Run regenerate-types.sh (all output to stderr)
"$SCRIPT_DIR/regenerate-types.sh" >&2

# Output the newly generated file to stdout
cat "$ORIGINAL_FILE"

# Restore original
if [ -f "$TEMP_FILE" ]; then
    mv "$TEMP_FILE" "$ORIGINAL_FILE"
fi
