# MenuTitle: Paste from Counterpunch
# -*- coding: utf-8 -*-
"""
Paste Counterpunch JSON from the system clipboard into Glyphs.

Accepts plain Counterpunch JSON, or SVG on the pasteboard with JSON embedded
in <metadata id="counterpunch-clipboard"> (Counterpunch Cmd+C format).

- Edit view (Glyphs.font.currentTab): clear selection, append objects onto
  Glyphs.font.selectedLayers[0], then select the pasted objects
- Font view: always create new glyphs (Glyphs-style unique names: keep the
  name if free, else .001 / .002 / …). Layer content is remapped onto this
  font's masters; then select the pasted glyphs
"""

from __future__ import division, print_function, unicode_literals

import json
import re

from AppKit import NSPasteboard, NSPasteboardTypeString, NSPoint
from GlyphsApp import (
    CURVE,
    LINE,
    OFFCURVE,
    QCURVE,
    GSAnchor,
    GSComponent,
    GSGlyph,
    GSGuide,
    GSNode,
    GSPath,
    Glyphs,
    Message,
)

CLIPBOARD_FORMAT = "counterpunch-clipboard"

NODE_TYPE_MAP = {
    "Line": LINE,
    "Curve": CURVE,
    "OffCurve": OFFCURVE,
    "QCurve": QCURVE,
    "Move": LINE,
}


def main():
    font = Glyphs.font
    if font is None:
        Message("No font open.", title="Counterpunch Paste")
        return

    payload = read_clipboard_payload()
    if payload is None:
        return

    kind = payload.get("kind")
    node_order = payload.get("nodeOrder") or "glyphs"

    if font.currentTab:
        if kind == "glyphs":
            Message(
                "Clipboard has whole glyphs. Switch to Font view to paste them.",
                title="Counterpunch Paste",
            )
            return
        pasted = paste_selection(font, payload, node_order)
    else:
        if kind != "glyphs":
            Message(
                "Clipboard has a selection fragment. Open a glyph edit tab to paste it.",
                title="Counterpunch Paste",
            )
            return
        pasted = paste_glyphs(font, payload, node_order)

    if pasted:
        Glyphs.showNotification("Counterpunch Paste", pasted)


COUNTERPUNCH_SVG_METADATA_RE = re.compile(
    r'<metadata\b[^>]*\bid=["\']counterpunch-clipboard["\'][^>]*>\s*'
    r'<!\[CDATA\[(.*?)\]\]>\s*</metadata>',
    re.DOTALL | re.IGNORECASE,
)


def read_clipboard_payload():
    pasteboard = NSPasteboard.generalPasteboard()
    text = pasteboard.stringForType_(NSPasteboardTypeString)
    if not text:
        Message("Clipboard has no text.", title="Counterpunch Paste")
        return None

    json_text = extract_counterpunch_json_text(text)
    if json_text is None:
        Message(
            "Clipboard has no Counterpunch JSON "
            "(plain JSON or SVG with counterpunch-clipboard metadata).",
            title="Counterpunch Paste",
        )
        return None

    try:
        payload = json.loads(json_text)
    except Exception:
        Message(
            "Clipboard text is not valid JSON.",
            title="Counterpunch Paste",
        )
        return None

    if not isinstance(payload, dict):
        Message("Clipboard JSON is not an object.", title="Counterpunch Paste")
        return None
    if payload.get("format") != CLIPBOARD_FORMAT:
        Message(
            'Clipboard is not Counterpunch JSON (missing format "counterpunch-clipboard").',
            title="Counterpunch Paste",
        )
        return None
    return payload


def extract_counterpunch_json_text(text):
    stripped = (text or "").strip()
    if stripped.startswith("{"):
        return stripped
    match = COUNTERPUNCH_SVG_METADATA_RE.search(stripped)
    if match:
        return match.group(1).strip()
    return None


def allocate_unique_glyph_name(font, base_name):
    """Glyphs-style unique name: free name as-is, else .001, .002, …"""
    name = (base_name or "").strip()
    if not name:
        raise ValueError("Glyph name must be non-empty")
    if font.glyphs[name] is None:
        return name
    index = 1
    while index < 10000:
        candidate = "%s.%03d" % (name, index)
        if font.glyphs[candidate] is None:
            return candidate
        index += 1
    raise ValueError('Could not allocate a unique name for "%s"' % name)


def paste_selection(font, payload, node_order):
    selected_layers = font.selectedLayers
    if not selected_layers:
        Message("No layer selected.", title="Counterpunch Paste")
        return None

    layer = selected_layers[0]
    font.disableUpdateInterface()
    try:
        layer.clearSelection()
        pasted_objects = append_fragment_to_layer(layer, payload, node_order)
        select_objects(layer, pasted_objects)
    finally:
        font.enableUpdateInterface()

    counts = {
        "paths": len(pasted_objects.get("paths") or []),
        "components": len(pasted_objects.get("components") or []),
        "anchors": len(pasted_objects.get("anchors") or []),
        "guides": len(pasted_objects.get("guides") or []),
    }
    if not any(counts.values()):
        Message("Nothing to paste.", title="Counterpunch Paste")
        return None

    return "Pasted %s into /%s" % (
        summarize_counts(counts),
        layer.parent.name if layer.parent else "?",
    )


def paste_glyphs(font, payload, node_order):
    glyphs = payload.get("glyphs") or []
    if not glyphs:
        Message("Clipboard has no glyphs.", title="Counterpunch Paste")
        return None

    master_count = len(font.masters) if font.masters else 0
    if master_count < 1:
        Message("Font has no masters.", title="Counterpunch Paste")
        return None

    for glyph_data in glyphs:
        source_layers = glyph_data.get("layers") or []
        if len(source_layers) != master_count:
            Message(
                "Glyph /%s: clipboard has %d layers, font has %d masters."
                % (
                    glyph_data.get("name") or "?",
                    len(source_layers),
                    master_count,
                ),
                title="Counterpunch Paste",
            )
            return None

    font.disableUpdateInterface()
    created_names = []
    pasted_glyphs = []
    try:
        # Clear Font View selection, then select pasted glyphs.
        try:
            font.selection = []
        except Exception:
            for glyph in font.glyphs:
                glyph.selected = False

        for glyph_data in glyphs:
            base_name = glyph_data.get("name")
            if not base_name:
                continue
            new_name = allocate_unique_glyph_name(font, base_name)
            glyph = GSGlyph(new_name)
            font.glyphs.append(glyph)

            if glyph_data.get("leftMetricsKey") is not None:
                glyph.leftMetricsKey = glyph_data.get("leftMetricsKey") or None
            if glyph_data.get("rightMetricsKey") is not None:
                glyph.rightMetricsKey = glyph_data.get("rightMetricsKey") or None

            source_layers = glyph_data.get("layers") or []
            target_layers = [
                layer
                for layer in glyph.layers
                if not getattr(layer, "isBackground", False)
                and getattr(layer, "layerId", None) != "background"
            ]
            if len(target_layers) != len(source_layers):
                Message(
                    "Glyph /%s: created %d layers, clipboard has %d."
                    % (new_name, len(target_layers), len(source_layers)),
                    title="Counterpunch Paste",
                )
                continue

            for index, source_layer in enumerate(source_layers):
                # New glyph layers are empty; masters already wired by Glyphs.
                replace_layer_contents(
                    target_layers[index], source_layer, node_order
                )
            created_names.append(new_name)
            pasted_glyphs.append(glyph)

        if pasted_glyphs:
            try:
                font.selection = pasted_glyphs
            except Exception:
                for glyph in pasted_glyphs:
                    glyph.selected = True
    finally:
        font.enableUpdateInterface()

    if not created_names:
        return "Pasted glyphs (nothing)"
    return "Created %d glyph%s: %s" % (
        len(created_names),
        "" if len(created_names) == 1 else "s",
        ", ".join("/%s" % name for name in created_names),
    )


def append_fragment_to_layer(layer, fragment, node_order):
    pasted = {
        "paths": [],
        "components": [],
        "anchors": [],
        "guides": [],
    }

    for path_data in fragment.get("paths") or []:
        path = build_path(path_data, node_order)
        if path is None:
            continue
        append_shape(layer, path)
        pasted["paths"].append(path)

    for component_data in fragment.get("components") or []:
        component = build_component(component_data)
        if component is None:
            continue
        append_shape(layer, component)
        pasted["components"].append(component)

    for anchor_data in fragment.get("anchors") or []:
        anchor = apply_anchor(layer, anchor_data)
        if anchor is not None:
            pasted["anchors"].append(anchor)

    for guide_data in fragment.get("guides") or []:
        guide = apply_guide(layer, guide_data)
        if guide is not None:
            pasted["guides"].append(guide)

    return pasted


def select_objects(layer, pasted_objects):
    layer.clearSelection()
    for path in pasted_objects.get("paths") or []:
        path.selected = True
    for component in pasted_objects.get("components") or []:
        component.selected = True
    for anchor in pasted_objects.get("anchors") or []:
        anchor.selected = True
    for guide in pasted_objects.get("guides") or []:
        # Master guides may not live on this layer; still try.
        try:
            guide.selected = True
        except Exception:
            pass


def replace_layer_contents(layer, source_layer, node_order):
    clear_layer_drawable_content(layer)

    if source_layer.get("width") is not None:
        try:
            layer.width = float(source_layer.get("width"))
        except Exception:
            pass

    if "leftMetricsKey" in source_layer:
        value = source_layer.get("leftMetricsKey")
        if hasattr(layer, "leftMetricsKey"):
            layer.leftMetricsKey = value or None
        elif hasattr(layer, "metricLeft"):
            layer.metricLeft = value or None
    if "rightMetricsKey" in source_layer:
        value = source_layer.get("rightMetricsKey")
        if hasattr(layer, "rightMetricsKey"):
            layer.rightMetricsKey = value or None
        elif hasattr(layer, "metricRight"):
            layer.metricRight = value or None

    append_fragment_to_layer(layer, source_layer, node_order)


def clear_layer_drawable_content(layer):
    if hasattr(layer, "shapes"):
        for shape in list(layer.shapes):
            if isinstance(shape, (GSPath, GSComponent)):
                layer.shapes.remove(shape)
    else:
        for path in list(layer.paths):
            layer.paths.remove(path)
        for component in list(layer.components):
            layer.components.remove(component)

    for anchor in list(layer.anchors):
        del layer.anchors[anchor.name]
    for guide in list(layer.guides):
        layer.guides.remove(guide)


def append_shape(layer, shape):
    if hasattr(layer, "shapes"):
        layer.shapes.append(shape)
    elif isinstance(shape, GSPath):
        layer.paths.append(shape)
    elif isinstance(shape, GSComponent):
        layer.components.append(shape)


def build_path(path_data, node_order):
    nodes_data = path_data.get("nodes") or []
    if not nodes_data:
        return None

    closed = bool(path_data.get("closed"))
    ordered = list(nodes_data)
    if closed and node_order == "start-first" and len(ordered) > 1:
        # Counterpunch stores start at index 0; Glyphs stores start last.
        ordered = ordered[1:] + [ordered[0]]

    path = GSPath()
    path.closed = closed
    for node_data in ordered:
        node = build_node(node_data)
        if node is not None:
            path.nodes.append(node)
    if len(path.nodes) == 0:
        return None
    return path


def build_node(node_data):
    if not isinstance(node_data, dict):
        return None
    try:
        x = float(node_data.get("x"))
        y = float(node_data.get("y"))
    except Exception:
        return None
    node_type = NODE_TYPE_MAP.get(node_data.get("nodetype"), LINE)
    node = GSNode(NSPoint(x, y), node_type)
    if node_data.get("smooth") and node_type in (CURVE, QCURVE, LINE):
        node.smooth = True
    return node


def build_component(component_data):
    if not isinstance(component_data, dict):
        return None
    reference = component_data.get("reference")
    if not reference:
        return None

    component = GSComponent(reference)
    transform = component_data.get("transform")
    if isinstance(transform, (list, tuple)) and len(transform) >= 6:
        component.transform = tuple(float(value) for value in transform[:6])
    else:
        x = float(component_data.get("x") or 0)
        y = float(component_data.get("y") or 0)
        component.transform = (1.0, 0.0, 0.0, 1.0, x, y)

    alignment = component_data.get("alignment")
    if alignment is not None:
        try:
            component.alignment = int(alignment)
        except Exception:
            pass

    anchor = component_data.get("anchor")
    if anchor:
        component.anchor = str(anchor)

    return component


def apply_anchor(layer, anchor_data):
    if not isinstance(anchor_data, dict):
        return None
    name = anchor_data.get("name")
    if not name:
        return None
    try:
        x = float(anchor_data.get("x"))
        y = float(anchor_data.get("y"))
    except Exception:
        return None

    existing = layer.anchors[name]
    if existing is not None:
        existing.position = NSPoint(x, y)
        return existing

    anchor = GSAnchor(name, NSPoint(x, y))
    layer.anchors.append(anchor)
    return anchor


def apply_guide(layer, guide_data):
    if not isinstance(guide_data, dict):
        return None
    try:
        x = float(guide_data.get("x"))
        y = float(guide_data.get("y"))
    except Exception:
        return None

    if guide_data.get("global"):
        master = layer.associatedFontMaster() if hasattr(layer, "associatedFontMaster") else None
        if master is None:
            master = Glyphs.font.selectedFontMaster
        if master is None:
            return None
        guide = GSGuide()
        guide.position = NSPoint(x, y)
        guide.angle = float(guide_data.get("angle") or 0)
        if guide_data.get("name"):
            guide.name = guide_data.get("name")
        master.guides.append(guide)
        return guide

    guide = GSGuide()
    guide.position = NSPoint(x, y)
    guide.angle = float(guide_data.get("angle") or 0)
    if guide_data.get("name"):
        guide.name = guide_data.get("name")
    layer.guides.append(guide)
    return guide


def summarize_counts(counts):
    parts = []
    for key, label in (
        ("paths", "path"),
        ("components", "component"),
        ("anchors", "anchor"),
        ("guides", "guide"),
    ):
        count = counts.get(key) or 0
        if count:
            parts.append("%d %s%s" % (count, label, "" if count == 1 else "s"))
    return ", ".join(parts) if parts else "nothing"


main()
