#!/usr/bin/env python3
"""
Test font compilation offline using the Context library

Usage:
    python test-compile-python.py input.glyphs [output.ttf]
    python test-compile-python.py input.ufo [output.ttf]
    python test-compile-python.py input.designspace [output.ttf]
    python test-compile-python.py input.babelfont [output.ttf]

This script:
1. Loads a font using the Context library
2. Exports it to .babelfont JSON
3. Saves the JSON (for inspection/debugging)
4. Shows what the browser would send to the WASM module
"""

import sys
import time
import orjson
from pathlib import Path


def test_export(input_file, output_json=None):
    """Test exporting a font to .babelfont JSON"""

    print("🔧 Testing font export to .babelfont JSON")
    print(f"📖 Input:  {input_file}")
    print()

    # Import the context library
    try:
        import context
    except ImportError:
        print("❌ Context library not found!")
        print("   Install it with: pip install -e context-py/")
        sys.exit(1)

    # Load the font
    print("📖 Loading font...")
    start_time = time.time()

    try:
        font = context.load(input_file)
        load_time = time.time() - start_time
        print(f"✅ Font loaded in {load_time:.2f}s")
    except Exception as e:
        print(f"❌ Failed to load font: {e}")
        sys.exit(1)

    # Get font info
    font_name = "Untitled"
    if hasattr(font, "names") and hasattr(font.names, "familyName"):
        if isinstance(font.names.familyName, dict) and "dflt" in font.names.familyName:
            font_name = font.names.familyName["dflt"]

    print(f"📝 Font name: {font_name}")
    print()

    # Export to .babelfont JSON
    print("🔄 Exporting to .babelfont JSON...")
    export_start = time.time()

    try:
        font_dict = font.to_dict()
        babelfont_json = orjson.dumps(font_dict)
        export_time = time.time() - export_start

        json_size_kb = len(babelfont_json) / 1024
        print(f"✅ Exported in {export_time:.3f}s")
        print(f"📊 JSON size: {json_size_kb:.2f} KB")

    except Exception as e:
        print(f"❌ Export failed: {e}")
        import traceback

        traceback.print_exc()
        sys.exit(1)

    # Optionally save the JSON
    if output_json:
        print()
        print(f"💾 Saving JSON to {output_json}...")
        Path(output_json).write_bytes(babelfont_json)
        print("✅ JSON saved")

    print()
    print("=" * 60)
    print("✅ Export successful!")
    print()
    print("This JSON would be sent to the WASM module in the browser.")
    print(f"Size: {json_size_kb:.2f} KB")
    print()
    print("To compile with WASM, you would:")
    print("  1. Load this JSON in the browser")
    print("  2. Call: fontCompilation.compileFromJson(json, 'font.ttf')")
    print("  3. Get back compiled TTF bytes")
    print()
    print("Or use the Node.js test script:")
    print(
        f"  node test-compile.js {output_json or input_file.replace('.glyphs', '.babelfont')}"
    )
    print("=" * 60)

    return babelfont_json


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python test-compile-python.py input.font [output.babelfont]")
        sys.exit(1)

    input_file = sys.argv[1]
    output_json = (
        sys.argv[2]
        if len(sys.argv) > 2
        else input_file.replace(".glyphs", ".babelfont")
        .replace(".ufo", ".babelfont")
        .replace(".designspace", ".babelfont")
    )

    if not output_json.endswith(".babelfont"):
        output_json += ".babelfont"

    test_export(input_file, output_json)
