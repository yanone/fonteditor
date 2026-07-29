#!/usr/bin/env python3
"""Build the editor's static Glyph Data search index from context-glyphdata.

Requires the sibling ``context-glyphdata`` package (or an installed
``counterpunch_glyph_data`` / ``context_glyphdata`` import). Emits a gzipped
JSON array of named Unicode records with generated glyph names — the same
payload the Add Glyphs dialog and ``Glyph.glyphData`` previously obtained via
Pyodide ``search_records()``.
"""

from __future__ import annotations

import gzip
import json
import sys
import time
from pathlib import Path

WEBAPP_ROOT = Path(__file__).resolve().parents[1]
OUTPUT = WEBAPP_ROOT / "data" / "glyph-data.json.gz"
SIBLING_SRC = WEBAPP_ROOT.parents[1] / "context-glyphdata" / "src"


def _ensure_import() -> None:
    if str(SIBLING_SRC) not in sys.path and SIBLING_SRC.is_dir():
        sys.path.insert(0, str(SIBLING_SRC))
    try:
        import context_glyphdata  # noqa: F401
    except ImportError as error:
        raise SystemExit(
            "Unable to import context_glyphdata. Install counterpunch_glyph_data "
            f"or keep the sibling checkout at {SIBLING_SRC}."
        ) from error


def build_records() -> list[dict]:
    from context_glyphdata.plugin import search_records

    records = []
    for record in search_records():
        item = dict(record)
        item["general_category"] = (
            item.get("category") or item.get("general_category") or ""
        )
        records.append(item)
    return records


def main() -> None:
    _ensure_import()
    started = time.perf_counter()
    records = build_records()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(records, separators=(",", ":"), ensure_ascii=False)
    compressed = gzip.compress(payload.encode("utf-8"), compresslevel=9)
    OUTPUT.write_bytes(compressed)
    elapsed = time.perf_counter() - started
    print(
        f"Wrote {OUTPUT.relative_to(WEBAPP_ROOT)} "
        f"({len(records)} records, {len(compressed)} gzip bytes) in {elapsed:.1f}s"
    )


if __name__ == "__main__":
    main()
