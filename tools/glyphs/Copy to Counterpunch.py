# MenuTitle: Copy to Counterpunch
# -*- coding: utf-8 -*-
"""
Copy the current Glyphs selection to the system clipboard as Counterpunch JSON.

- Edit view (Glyphs.font.currentTab): copy selected objects from
  Glyphs.font.selectedLayers[0]
- Font view: copy each glyph in Glyphs.font.selection as a complete glyph
  (master defaults, layer copies, braces, and feature-variation families,
  with masterIndex association for Counterpunch paste)
"""

from __future__ import division, print_function, unicode_literals

import json

from AppKit import NSPasteboard, NSPasteboardTypeString
from GlyphsApp import (
    CURVE,
    LINE,
    OFFCURVE,
    QCURVE,
    GSAnchor,
    GSComponent,
    GSGuide,
    GSNode,
    GSPath,
    Glyphs,
    Message,
)

CLIPBOARD_FORMAT = "counterpunch-clipboard"
CLIPBOARD_VERSION = 2

NODE_TYPE_MAP = {
    LINE: "Line",
    CURVE: "Curve",
    OFFCURVE: "OffCurve",
    QCURVE: "QCurve",
}


def main():
    font = Glyphs.font
    if font is None:
        Message("No font open.", title="Counterpunch Copy")
        return

    if font.currentTab:
        payload = build_selection_payload(font)
    else:
        payload = build_glyphs_payload(font)

    if payload is None:
        return

    text = json.dumps(payload, indent=4, ensure_ascii=False)
    pasteboard = NSPasteboard.generalPasteboard()
    pasteboard.clearContents()
    pasteboard.setString_forType_(text, NSPasteboardTypeString)
    Glyphs.showNotification(
        "Counterpunch Copy",
        summarize_payload(payload),
    )


def build_selection_payload(font):
    selected_layers = font.selectedLayers
    if not selected_layers:
        Message("No layer selected.", title="Counterpunch Copy")
        return None

    layer = selected_layers[0]
    paths, components, anchors, guides = collect_selected_layer_objects(layer)
    if not (paths or components or anchors or guides):
        Message(
            "Nothing selected on the active layer.",
            title="Counterpunch Copy",
        )
        return None

    return {
        "format": CLIPBOARD_FORMAT,
        "version": CLIPBOARD_VERSION,
        "kind": "selection",
        # Glyphs closed paths store the start node last; leave that order here
        # and let Counterpunch rotate to start-first on paste.
        "nodeOrder": "glyphs",
        "keepAbsoluteCoords": True,
        "glyph": layer.parent.name if layer.parent else None,
        "layerId": layer.layerId,
        "paths": paths,
        "components": components,
        "anchors": anchors,
        "guides": guides,
    }


def build_glyphs_payload(font):
    glyphs = list(font.selection)
    if not glyphs:
        Message("No glyphs selected.", title="Counterpunch Copy")
        return None

    return {
        "format": CLIPBOARD_FORMAT,
        "version": CLIPBOARD_VERSION,
        "kind": "glyphs",
        "nodeOrder": "glyphs",
        "masters": serialize_masters(font),
        "glyphs": [serialize_glyph(glyph, font) for glyph in glyphs],
    }


def serialize_masters(font):
    masters = []
    for master in font.masters:
        entry = {
            "id": master.id,
            "name": master_display_name(master),
        }
        location = master_location(master, font)
        if location:
            entry["location"] = location
        masters.append(entry)
    return masters


def master_display_name(master):
    name = getattr(master, "name", None)
    if name is None:
        return master.id
    try:
        return str(name)
    except Exception:
        return master.id


def master_location(master, font):
    # Prefer explicit axis values when present; otherwise omit.
    location = {}
    axes = list(font.axes) if font.axes else []
    values = getattr(master, "axesValues", None) or getattr(master, "weightValue", None)
    if axes and isinstance(values, (list, tuple)) and len(values) == len(axes):
        for axis, value in zip(axes, values):
            axis_id = getattr(axis, "axisId", None) or getattr(axis, "tag", None)
            if not axis_id:
                continue
            try:
                location[str(axis_id)] = float(value)
            except Exception:
                pass
    return location or None


def collect_selected_layer_objects(layer):
    selected_paths = set()
    components = []
    anchors = []
    guides = []

    for item in layer.selection:
        if isinstance(item, GSPath):
            selected_paths.add(item)
        elif isinstance(item, GSNode):
            path = item.parent
            if isinstance(path, GSPath):
                selected_paths.add(path)
        elif isinstance(item, GSComponent):
            components.append(serialize_component(item))
        elif isinstance(item, GSAnchor):
            anchors.append(serialize_anchor(item))
        elif isinstance(item, GSGuide):
            guides.append(serialize_guide(item, global_guide=False))

    # Keep layer shape order for selected paths.
    paths = []
    if hasattr(layer, "shapes"):
        for shape in layer.shapes:
            if isinstance(shape, GSPath) and shape in selected_paths:
                paths.append(serialize_path(shape))
                selected_paths.discard(shape)
    for path in layer.paths:
        if path in selected_paths:
            paths.append(serialize_path(path))

    return paths, components, anchors, guides


def serialize_glyph(glyph, font):
    masters = list(font.masters)
    base_layers = []
    feature_variations = {}

    for layer in glyph.layers:
        if getattr(layer, "isBackground", False):
            continue
        if getattr(layer, "layerId", None) == "background":
            continue

        serialized = serialize_layer(layer, font, masters)
        if serialized is None:
            continue

        axis_rules = feature_variation_axis_rules(layer)
        if axis_rules is not None:
            family_key = json.dumps(axis_rules, sort_keys=True)
            family = feature_variations.get(family_key)
            if family is None:
                family = {"axisRules": axis_rules, "layers": []}
                feature_variations[family_key] = family
            family["layers"].append(serialized)
            continue

        base_layers.append(serialized)

    payload = {
        "name": glyph.name,
        "leftMetricsKey": nullable_string(getattr(glyph, "leftMetricsKey", None)),
        "rightMetricsKey": nullable_string(
            getattr(glyph, "rightMetricsKey", None)
        ),
        "layers": base_layers,
    }
    if feature_variations:
        payload["featureVariations"] = list(feature_variations.values())
    return payload


def serialize_layer(layer, font, masters):
    master = classify_layer_master(layer, masters)
    if master is None:
        return None

    paths = [serialize_path(path) for path in layer.paths]
    components = [serialize_component(component) for component in layer.components]
    anchors = [serialize_anchor(anchor) for anchor in layer.anchors]
    guides = [
        serialize_guide(guide, global_guide=False) for guide in layer.guides
    ]

    payload = {
        "layerId": layer.layerId,
        "name": layer.name,
        "master": master,
        "width": float(layer.width),
        "leftMetricsKey": nullable_string(
            getattr(layer, "leftMetricsKey", None)
            or getattr(layer, "metricLeft", None)
        ),
        "rightMetricsKey": nullable_string(
            getattr(layer, "rightMetricsKey", None)
            or getattr(layer, "metricRight", None)
        ),
        "paths": paths,
        "components": components,
        "anchors": anchors,
        "guides": guides,
    }
    location = layer_brace_location(layer, font)
    if location:
        payload["location"] = location
    return payload


def classify_layer_master(layer, masters):
    master_ids = [master.id for master in masters]
    layer_id = getattr(layer, "layerId", None)
    if layer_id in master_ids:
        return {
            "type": "DefaultForMaster",
            "masterIndex": master_ids.index(layer_id),
        }
    associated = getattr(layer, "associatedMasterId", None)
    if associated in master_ids:
        return {
            "type": "AssociatedWithMaster",
            "masterIndex": master_ids.index(associated),
        }
    return {"type": "FreeFloating"}


def layer_brace_location(layer, font):
    attributes = getattr(layer, "attributes", None)
    if not attributes:
        return None
    coords = None
    try:
        coords = attributes.get("coordinates")
    except Exception:
        coords = attributes["coordinates"] if "coordinates" in attributes else None
    if not coords:
        return None
    axes = list(font.axes) if font.axes else []
    location = {}
    if isinstance(coords, dict):
        for key, value in coords.items():
            try:
                location[str(key)] = float(value)
            except Exception:
                pass
        return location or None
    if isinstance(coords, (list, tuple)) and axes and len(coords) == len(axes):
        for axis, value in zip(axes, coords):
            axis_id = getattr(axis, "axisId", None) or getattr(axis, "tag", None)
            if not axis_id:
                continue
            try:
                location[str(axis_id)] = float(value)
            except Exception:
                pass
        return location or None
    return None


def feature_variation_axis_rules(layer):
    attributes = getattr(layer, "attributes", None)
    if not attributes:
        return None
    try:
        axis_rules = attributes.get("axisRules")
    except Exception:
        axis_rules = attributes["axisRules"] if "axisRules" in attributes else None
    if isinstance(axis_rules, (list, tuple)):
        return list(axis_rules)
    return None


def serialize_path(path):
    return {
        "closed": bool(path.closed),
        "nodes": [serialize_node(node) for node in path.nodes],
    }


def serialize_node(node):
    node_type = NODE_TYPE_MAP.get(node.type, "Line")
    payload = {
        "x": float(node.position.x),
        "y": float(node.position.y),
        "nodetype": node_type,
    }
    if getattr(node, "smooth", False) and node_type in ("Curve", "QCurve", "Line"):
        payload["smooth"] = True
    return payload


def serialize_component(component):
    # Glyphs GSComponent.transform is NSAffineTransformStruct
    # (m11, m12, m21, m22, tX, tY) — see docu.glyphsapp.com GSComponent.
    transform = list(component.transform)
    payload = {
        "reference": component.name,
        "x": float(transform[4]) if len(transform) >= 6 else float(component.position.x),
        "y": float(transform[5]) if len(transform) >= 6 else float(component.position.y),
        "transform": [float(value) for value in transform],
    }
    alignment = getattr(component, "alignment", None)
    if alignment is not None:
        try:
            payload["alignment"] = int(alignment)
        except Exception:
            pass
    anchor = getattr(component, "anchor", None)
    if anchor:
        payload["anchor"] = str(anchor)
    return payload


def serialize_anchor(anchor):
    return {
        "name": anchor.name,
        "x": float(anchor.position.x),
        "y": float(anchor.position.y),
    }


def serialize_guide(guide, global_guide=False):
    position = guide.position
    payload = {
        "x": float(position.x),
        "y": float(position.y),
        "angle": float(getattr(guide, "angle", 0) or 0),
        "global": bool(global_guide),
    }
    name = getattr(guide, "name", None)
    if name:
        payload["name"] = name
    return payload


def nullable_string(value):
    if value is None:
        return None
    text = str(value).strip()
    return text if text else None


def summarize_payload(payload):
    kind = payload.get("kind")
    if kind == "selection":
        counts = []
        for key, label in (
            ("paths", "path"),
            ("components", "component"),
            ("anchors", "anchor"),
            ("guides", "guide"),
        ):
            count = len(payload.get(key) or [])
            if count:
                counts.append("%d %s%s" % (count, label, "" if count == 1 else "s"))
        detail = ", ".join(counts) if counts else "nothing"
        glyph = payload.get("glyph") or "?"
        return "Copied %s from /%s" % (detail, glyph)

    glyphs = payload.get("glyphs") or []
    count = len(glyphs)
    return "Copied %d glyph%s" % (count, "" if count == 1 else "s")


main()
