# MenuTitle: Paste from Counterpunch
# -*- coding: utf-8 -*-
"""
Paste Counterpunch JSON from the system clipboard into Glyphs.

Accepts a font-editor-clipboard JSON envelope on the pasteboard (with a
"counterpunch" item), or SVG with that JSON embedded in
<metadata id="counterpunch-clipboard"> (Counterpunch Cmd+C format).

- Edit view (Glyphs.font.currentTab): clear selection, append objects onto
  Glyphs.font.selectedLayers[0], then select the pasted objects
- Font view: always create new glyphs (Glyphs-style unique names: keep the
  name if free, else .001 / .002 / …). Layers are matched to masters by
  masterIndex; layer copies and braces/feature variations are included
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
    GSLayer,
    GSNode,
    GSPath,
    Glyphs,
    Message,
)

CLIPBOARD_SCHEMA = "font-editor-clipboard"
CLIPBOARD_SCHEMA_VERSION = 1
COUNTERPUNCH_VENDOR = "counterpunch"

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
            "(font-editor-clipboard envelope or SVG with counterpunch-clipboard metadata).",
            title="Counterpunch Paste",
        )
        return None

    try:
        envelope = json.loads(json_text)
    except Exception:
        Message(
            "Clipboard text is not valid JSON.",
            title="Counterpunch Paste",
        )
        return None

    payload = unwrap_counterpunch_item(envelope)
    if payload is None:
        Message(
            "Clipboard JSON is not a font-editor-clipboard envelope "
            'with a "counterpunch" item.',
            title="Counterpunch Paste",
        )
        return None
    return payload


def unwrap_counterpunch_item(envelope):
    if not isinstance(envelope, dict):
        return None
    if envelope.get("clipboardSchema") != CLIPBOARD_SCHEMA:
        return None
    schema_version = envelope.get("clipboardSchemaVersion")
    if not isinstance(schema_version, int) or schema_version < CLIPBOARD_SCHEMA_VERSION:
        return None
    items = envelope.get("clipboardItems")
    if not isinstance(items, dict):
        return None
    payload = items.get(COUNTERPUNCH_VENDOR)
    if not isinstance(payload, dict):
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


def find_insert_index_after_name(font, base_name):
    """Index after the last family sibling; else append.

    Strips trailing .NNN so clipboard names like a.001 still land with a.
    """
    import re

    name = (base_name or "").strip()
    if not name:
        return len(font.glyphs)
    while re.search(r"\.\d{3,}$", name):
        name = re.sub(r"\.\d{3,}$", "", name)
    if not name:
        return len(font.glyphs)
    pattern = re.compile(r"^%s\.\d{3,}$" % re.escape(name))
    last_index = -1
    for index, glyph in enumerate(font.glyphs):
        glyph_name = glyph.name
        if glyph_name == name or pattern.match(glyph_name):
            last_index = index
    return last_index + 1 if last_index >= 0 else len(font.glyphs)


def insert_glyph_after_namesake(font, glyph, base_name):
    """Insert glyph after the namesake family; fall back to append."""
    insert_index = find_insert_index_after_name(font, base_name)
    try:
        font.glyphs.insert(insert_index, glyph)
        return
    except Exception:
        pass
    font.glyphs.append(glyph)
    try:
        from_index = len(font.glyphs) - 1
        if insert_index < from_index and hasattr(font, "moveGlyphToIndex_fromIndex_"):
            font.moveGlyphToIndex_fromIndex_(insert_index, from_index)
    except Exception:
        pass


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

    version = payload.get("version") or 0
    try:
        version = int(version)
    except Exception:
        version = 0
    if version < 2:
        Message(
            "Clipboard uses an old Counterpunch whole-glyph format. "
            "Re-copy with the current Copy to Counterpunch script.",
            title="Counterpunch Paste",
        )
        return None

    source_masters = payload.get("masters") or []
    master_count = len(font.masters) if font.masters else 0
    if master_count < 1:
        Message("Font has no masters.", title="Counterpunch Paste")
        return None
    if len(source_masters) != master_count:
        Message(
            "Clipboard has %d masters, font has %d. Master counts must match."
            % (len(source_masters), master_count),
            title="Counterpunch Paste",
        )
        return None

    target_axis_keys = collect_target_axis_keys(font)
    skipped_braces = 0

    font.disableUpdateInterface()
    created_names = []
    pasted_glyphs = []
    try:
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
            insert_glyph_after_namesake(font, glyph, base_name)

            if glyph_data.get("leftMetricsKey") is not None:
                glyph.leftMetricsKey = glyph_data.get("leftMetricsKey") or None
            if glyph_data.get("rightMetricsKey") is not None:
                glyph.rightMetricsKey = glyph_data.get("rightMetricsKey") or None

            skipped_braces += paste_layers_onto_glyph(
                font,
                glyph,
                glyph_data.get("layers") or [],
                node_order,
                target_axis_keys,
            )
            for feature_variation in glyph_data.get("featureVariations") or []:
                skipped_braces += paste_feature_variation_onto_glyph(
                    font,
                    glyph,
                    feature_variation,
                    node_order,
                    target_axis_keys,
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

    if skipped_braces:
        Message(
            "Skipped %d intermediate/brace layer%s because one or more axis "
            "ids are missing in this font."
            % (skipped_braces, "" if skipped_braces == 1 else "s"),
            title="Counterpunch Paste",
        )

    if not created_names:
        return "Pasted glyphs (nothing)"
    return "Created %d glyph%s: %s" % (
        len(created_names),
        "" if len(created_names) == 1 else "s",
        ", ".join("/%s" % name for name in created_names),
    )


def collect_target_axis_keys(font):
    keys = set()
    for axis in font.axes or []:
        axis_id = getattr(axis, "axisId", None)
        tag = getattr(axis, "tag", None) or getattr(axis, "axisTag", None)
        if axis_id:
            keys.add(str(axis_id))
        if tag:
            keys.add(str(tag))
    return keys


def paste_layers_onto_glyph(font, glyph, source_layers, node_order, target_axis_keys):
    skipped_braces = 0
    masters = list(font.masters)
    default_layers = default_layers_by_master_index(glyph, masters)

    for source_layer in source_layers:
        master = source_layer.get("master") or {}
        master_type = master.get("type")
        if master_type == "FreeFloating":
            continue
        master_index = master.get("masterIndex")
        if not isinstance(master_index, int) or master_index < 0 or master_index >= len(masters):
            continue
        target_master = masters[master_index]
        location = source_layer.get("location") or None
        has_brace = isinstance(location, dict) and len(location) > 0

        if master_type == "DefaultForMaster":
            target_layer = default_layers[master_index]
            if target_layer is None:
                continue
            replace_layer_contents(target_layer, source_layer, node_order)
            continue

        if has_brace and not location_axes_exist(location, target_axis_keys):
            skipped_braces += 1
            continue

        target_layer = create_associated_layer(
            glyph, target_master, location if has_brace else None
        )
        if target_layer is None:
            continue
        replace_layer_contents(target_layer, source_layer, node_order)
    return skipped_braces


def paste_feature_variation_onto_glyph(
    font, glyph, feature_variation, node_order, target_axis_keys
):
    skipped_braces = 0
    masters = list(font.masters)
    axis_rules = feature_variation.get("axisRules")
    if not isinstance(axis_rules, list):
        return 0

    for source_layer in feature_variation.get("layers") or []:
        master = source_layer.get("master") or {}
        master_type = master.get("type")
        if master_type == "FreeFloating":
            continue
        master_index = master.get("masterIndex")
        if not isinstance(master_index, int) or master_index < 0 or master_index >= len(masters):
            continue
        target_master = masters[master_index]
        location = source_layer.get("location") or None
        has_brace = isinstance(location, dict) and len(location) > 0
        if has_brace and not location_axes_exist(location, target_axis_keys):
            skipped_braces += 1
            continue
        target_layer = create_associated_layer(
            glyph, target_master, location if has_brace else None
        )
        if target_layer is None:
            continue
        try:
            if target_layer.attributes is None:
                target_layer.attributes = {}
            target_layer.attributes["axisRules"] = axis_rules
        except Exception:
            pass
        replace_layer_contents(target_layer, source_layer, node_order)
    return skipped_braces


def default_layers_by_master_index(glyph, masters):
    result = []
    for master in masters:
        layer = None
        try:
            layer = glyph.layers[master.id]
        except Exception:
            layer = None
        result.append(layer)
    return result


def create_associated_layer(glyph, master, location):
    try:
        layer = GSLayer()
    except Exception:
        return None
    try:
        import uuid

        layer.associatedMasterId = master.id
        layer.layerId = str(uuid.uuid4()).upper()
        if location:
            if layer.attributes is None:
                layer.attributes = {}
            layer.attributes["coordinates"] = location
        glyph.layers.append(layer)
        return layer
    except Exception:
        return None


def location_axes_exist(location, target_axis_keys):
    if not isinstance(location, dict) or not location:
        return False
    for key in location.keys():
        if str(key) not in target_axis_keys:
            return False
    return True


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
