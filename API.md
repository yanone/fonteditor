# Font Object Model API Documentation

*Auto-generated from JavaScript object model introspection*


## Table of Contents


- [Overview](#overview)
- [Class Reference](#class-reference)
  - [Font](#font) - The main font class representing a complete font
  - [Glyph](#glyph) - Glyph in the font
  - [Layer](#layer) - Layer in a glyph representing a master or intermediate design
  - [Shape](#shape) - Shape wrapper that can contain either a Component or a Path
  - [Path](#path) - Path (contour) in a layer
  - [Node](#node) - Point in a path
  - [Component](#component) - Component reference to another glyph
  - [Anchor](#anchor) - Anchor point in a layer
  - [Guide](#guide) - Guideline in a layer or master
  - [Axis](#axis) - Variation axis in a variable font
  - [Master](#master) - Master/source in a design space
  - [Instance](#instance) - Named instance in a variable font
- [Complete Examples](#complete-examples)
- [Tips and Best Practices](#tips-and-best-practices)

---

## Overview

The Font Object Model provides an object-oriented interface for manipulating font data.
All objects are lightweight facades over the underlying JSON data - changes are immediately
reflected in the font structure.

### Accessing the Font Model

```python
# Get the current font (fonteditor module is pre-loaded)
font = Font()
```

### Dictionary Access (Python wrappers)

Dictionary-like object model fields are wrapped as live Python mappings.
Use normal Python dictionary access for both reading and writing.

```python
font = Font()
master = font.masters[0]

# Nested kerning dictionary (live two-way view)
master.kerning["A"]["V"] = -80

# Internationalized naming dictionaries
font.names.familyName["dflt"] = "My Family"
font.names.familyName["de"] = "Meine Familie"
font.names.familyName["fr"] = "Ma Famille"
font.names.familyName["ar"] = "عائلتي"
master.name["dflt"] = "Standard"
master.name["de"] = "Standard"
master.name["fr"] = "Standard"
master.name["ar"] = "قياسي"

# Optional snapshot copy when needed
kerning_snapshot = master.kerning.as_dict()
```

### Shared Plugin Context

```python
ctx = Context()
ctx.runCount = getattr(ctx, "runCount", 0) + 1
SetContextPatch({"lastRun": {"count": ctx.runCount}})
```

### Parent Navigation

All objects in the hierarchy have a `parent()` method that returns their parent object,
allowing navigation up the object tree to the root Font object.

**Example:**
```python
# Navigate from node up to font
node = font.glyphs[0].layers[0].paths[0].nodes[0]
path = node.parent()      # Path object
shape = path.parent()     # Shape object
layer = shape.parent()    # Layer object
glyph = layer.parent()    # Glyph object
font = glyph.parent()     # Font object
```

---


## Class Reference


## Font

The main font class representing a complete font

**Access:**
```python
# fonteditor module is pre-loaded
font = Font()
```

### Properties

#### Read/Write Properties

- **`upm`** (float | int)
- **`version`** ([number, number])
- **`note`** (str | None)
- **`date`** (str)
- **`names`** (dict[str, dict[str, str] | None])
- **`custom_ot_values`** (list[Unsafe] | None)
- **`variation_sequences`** ( | dict | None)
- **`features`** (dict[str, Any])
- **`first_kern_groups`** (dict | None)
- **`second_kern_groups`** (dict | None)
- **`format_specific`** (dict | None)
- **`source`** (str | None)

#### Read-Only Properties

- **`axes`** (list[[Axis](#axis)] | None)
- **`instances`** (list[[Instance](#instance)] | None)
- **`masters`** (list[[Master](#master)] | None)
- **`glyphs`** (list[[Glyph](#glyph)])

### Methods

#### `recomputeMetricsKeys(changedGlyphNames: Set<string> | None = None) -> Set<string>`
#### `findGlyph(name: str) -> [Glyph](#glyph) | None`
Find a glyph by name

**Example:**
```python
glyph = font.findGlyph("A")
if glyph:
    print(glyph.name)
```

#### `findGlyphByCodepoint(codepoint: float | int) -> [Glyph](#glyph) | None`
Find a glyph by codepoint

**Example:**
```python
glyph = font.findGlyphByCodepoint(0x0041)  # Find 'A'
```

#### `findGlyphsUsingComponent(componentGlyphName: str) -> list[str]`
Find all glyphs that reference a given glyph as a component
This recursively finds glyphs at each nesting level

**Example:**
```python
glyphs = font.findGlyphsUsingComponent("o")
# Returns ["ö", "õ", "ø", ...] if they use "o" as a component
```

#### `duplicateGlyph(glyph: [Glyph](#glyph), newName: str) -> [Glyph](#glyph)`
Duplicate a glyph with a new name

**Example:**
```python
new_glyph = font.duplicateGlyph(glyph, "A.alt")
```

#### `findAxis(id: str) -> [Axis](#axis) | None`
Find an axis by ID

#### `findAxisByTag(tag: str) -> [Axis](#axis) | None`
Find an axis by tag

**Example:**
```python
weight_axis = font.findAxisByTag("wght")
```

#### `findMaster(id: str) -> [Master](#master) | None`
Find a master by ID

#### `addGlyph(name: str, category: Babelfont.GlyphCategory | str) -> [Glyph](#glyph)`
Add a new glyph to the font

**Example:**
```python
glyph = font.addGlyph("myGlyph", "Base")
```

#### `removeGlyph(name: str) -> bool`
Remove a glyph by name

**Example:**
```python
font.removeGlyph("oldGlyph")
```

#### `toJSONString() -> str`
Serialize the font back to JSON string

#### `fromJSONString(json: str) -> [Font](#font)`
Create a Font instance from JSON string

#### `fromData(data: Babelfont.Font) -> [Font](#font)`
Create a Font instance from parsed JSON data

#### `toString() -> str`
#### `analyzeFeatureTables(featureTag: str) -> { hasGSUB: boolean; hasGPOS: boolean; }`
Analyze a feature's code to determine if it contains GSUB and/or GPOS rules

**Example:**
```python
const analysis = font.analyzeFeatureTables("liga")
if (analysis.hasGSUB) console.log("Feature has substitution rules")
```

#### `analyzeOpenTypeCode(code: str) -> { hasGSUB: boolean; hasGPOS: boolean; }`
Analyze OpenType feature code to determine if it contains GSUB and/or GPOS rules
This is a general-purpose method that can analyze code from features, prefixes, or other sources

**Example:**
```python
const analysis = font.analyzeOpenTypeCode("substitute a by b;")
if (analysis.hasGSUB) console.log("Code contains substitution rules")
```

#### `analyzePrefix(prefixName: str) -> { hasGSUB: boolean; hasGPOS: boolean; }`
Analyze a prefix's code to determine if it contains GSUB and/or GPOS rules

**Example:**
```python
const analysis = font.analyzePrefix("myLookup")
if (analysis.hasGSUB) console.log("Prefix contains substitution rules")
```

---


## Glyph

Glyph in the font

**Access:**
```python
glyph = font.glyphs[0]
# or
glyph = font.findGlyph("A")
```

### Properties

#### Read/Write Properties

- **`leftMetricsKey`** (str | None)
- **`rightMetricsKey`** (str | None)
- **`name`** (str)
- **`production_name`** (str | None)
- **`category`** (Babelfont.GlyphCategory)
- **`codepoints`** (list[float | int] | None)
- **`exported`** (bool | None)
- **`direction`** (Babelfont.Direction | None)
- **`format_specific`** (dict | None)

#### Read-Only Properties

- **`BUILTIN_CATEGORIES`** (Any)
- **`layers`** (list[[Layer](#layer)] | None)

### Methods

#### `getPathSegment() -> list[(string | number)]`
#### `normalizeCategory(value: Babelfont.GlyphCategory | str | None) -> Babelfont.GlyphCategory`
#### `addLayer(width: float | int, master: Babelfont.LayerType | None = None) -> [Layer](#layer)`
Add a new layer to the glyph

**Example:**
```python
layer = glyph.addLayer(500)  # 500 units wide
```

#### `removeLayer(index: float | int) -> None`
Remove a layer at the specified index

#### `findLayerById(id: str) -> [Layer](#layer) | None`
Find a layer by ID

#### `findLayerByMasterId(masterId: str) -> [Layer](#layer) | None`
Find a layer by master ID

#### `calculateOutlineCompatibility() -> { compatible: boolean; layerCount: number; referenceLayerId?: string; incompatibleLayerIds: string[]; }`
Compare outline structure across main layers (the same list shown in the UI).

For compatibility checks, mixed shape sequences are normalized by moving
components before paths while preserving their relative order inside each type.

#### `toString() -> str`
---


## Layer

Layer in a glyph representing a master or intermediate design

**Access:**
```python
layer = glyph.layers[0]
```

### Properties

#### Read/Write Properties

- **`leftMetricsKey`** (str | None)
- **`rightMetricsKey`** (str | None)
- **`width`** (float | int)
- **`lsb`** (float | int): Get the left sidebearing (LSB) - the distance from x=0 to the left edge of the bounding box
- **`rsb`** (float | int): Get the right sidebearing (RSB) - the distance from the right edge of the bounding box to the advance width
- **`name`** (str | None)
- **`id`** (str | None)
- **`master`** (Babelfont.LayerType | None)
- **`smart_component_location`** (UserspaceLocation | None)
- **`color`** (Babelfont.Color | None)
- **`layer_index`** (float | int | None)
- **`is_background`** (bool | None)
- **`background_layer_id`** (str | None)
- **`location`** (DesignspaceLocation | None)
- **`format_specific`** (dict | None)

#### Read-Only Properties

- **`guides`** (list[[Guide](#guide)] | None)
- **`paths`** (list[[Path](#path)]): Direct path objects in this layer, ready to use without Shape.asPath()
- **`components`** (list[[Component](#component)]): Direct component objects in this layer, ready to use without Shape.asComponent()
- **`anchors`** (list[[Anchor](#anchor)] | None)

### Methods

#### `setDirectSidebearing(side: SidebearingSide, value: float | int) -> None`
#### `isAutomaticAlignedLayer() -> bool`
#### `resolveMetricsKey(side: SidebearingSide, stack: Set<string>) -> MetricsKeyResolution`
#### `applySidebearingInput(side: SidebearingSide, rawValue: str) -> MetricsKeyResolution`
#### `getPathSegment() -> list[(string | number)]`
#### `getMaster() -> [Master](#master) | None`
Get the resolved master object for this layer.
Returns a Master only when this layer is a DefaultForMaster layer.

#### `getComputedName() -> str`
#### `addShape(shape: Babelfont.Shape) -> [Shape](#shape)`
Add a new shape to the layer

#### `addPath(closed: bool | dict, Unsafe>) -> [Path](#path)`
Add a new path to the layer

**Example:**
```python
path = layer.addPath(closed=True)
```

#### `addComponent(reference: str, transform: list[float | int] | Babelfont.DecomposedAffine | None = None) -> [Component](#component)`
Add a new component to the layer

**Example:**
```python
component = layer.addComponent("A")
# With transformation matrix (legacy 6-element format converted to DecomposedAffine)
component = layer.addComponent("acutecomb", [1, 0, 0, 1, 250, 500])
```

#### `removeShape(index: float | int) -> None`
Remove a shape at the specified index

#### `addAnchor(x: float | int, y: float | int, name: str | None = None) -> [Anchor](#anchor)`
Add a new anchor to the layer

**Example:**
```python
anchor = layer.addAnchor(250, 700, "top")
```

#### `addGuide(pos: Babelfont.Position, name: str | None = None, color: Babelfont.Color | None = None) -> [Guide](#guide)`
#### `removeAnchor(index: float | int) -> None`
Remove an anchor at the specified index

#### `removeGuide(index: float | int) -> None`
#### `processPathSegments(pathData: { nodes: Unsafe[]; closed?: boolean; }) -> Array<{ points: Array<{ x: number; y: number }>; type: 'line' | 'quadratic' | 'cubic'; }>`
Process a path into Bezier curve segments
Handles the babelfont node format where:
- Nodes can have 'type' (lowercase: o, c, l, q, etc.) or 'nodetype' (capitalized: OffCurve, Curve, Line, etc.)
- Segments are sequences: [oncurve] [offcurve*] [oncurve]
- For closed paths, the path can start with offcurve nodes

#### `calculatePathBounds(pathData: list[{ nodes?: Unsafe] | string; closed?: boolean; }) -> { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number; } | None`
#### `calculateShapeBounds(shapes: list[Unsafe] | None, parentTransform: list[float | int]) -> { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number; } | None`
#### `calculateSvgPathBounds(pathData: str) -> { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number; } | None`
#### `getAllPaths() -> list[Babelfont.Path]`
Get all paths in this layer including transformed paths from components (recursively flattened)

#### `calculateBoundingBox(layerData: Unsafe, includeAnchors: bool, font: [Font](#font) | None = None, masterId: str | None = None) -> { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number; } | None`
Calculate bounding box for layer data

#### `getBoundingBox(includeAnchors: bool) -> { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number; } | None`
Calculate bounding box for this layer

#### `getIntersectionsOnLine(p1: { x: number; y: number }, p2: { x: number; y: number }, includeComponents: bool) -> Array<{ x: number; y: number; t: number }>`
Calculate intersections between a line segment and all paths in this layer

#### `getSidebearingsAtHeight(y: float | int) -> { left: number; right: number; } | None`
Calculate sidebearings at a given Y height by measuring distance from glyph edges to first/last outline intersections

#### `getMatchingLayerOnGlyph(glyphName: str) -> [Layer](#layer) | None`
Find the exact matching stored layer on another glyph for this layer's
effective designspace location.

#### `toString() -> str`
---


## Shape

Shape wrapper that can contain either a Component or a Path

**Access:**
```python
path = layer.paths[0]
shape = path.parent()
```

### Methods

#### `getPathSegment() -> list[(string | number)]`
#### `isComponent() -> bool`
Check if this shape is a component

#### `isPath() -> bool`
Check if this shape is a path

#### `asComponent() -> [Component](#component)`
Get as Component (throws if not a component)

#### `asPath() -> [Path](#path)`
Get as Path (throws if not a path)

#### `toString() -> str`
---


## Path

Path (contour) in a layer

**Access:**
```python
path = layer.paths[0]
```

### Properties

All properties are read/write:

- **`nodes`** (list[[Node](#node)])
- **`closed`** (bool)
- **`format_specific`** (dict | None)

### Methods

#### `getPathSegment() -> list[(string | number)]`
#### `parseNodesString(nodesStr: str) -> list[Babelfont.Node]`
Parse nodes from babelfont-rs string format
Format: "x1 y1 type x2 y2 type ..."
Types: m, l, o, c, q (with optional 's' suffix for smooth)

#### `mapNodeType(shortType: str) -> Babelfont.NodeType`
Map short node type to Babelfont.NodeType

#### `nodesToString(nodes: list[Babelfont.Node]) -> str`
Convert nodes array back to compact string format for serialization

#### `insertNode(index: float | int, x: float | int, y: float | int, nodetype: Babelfont.NodeType, smooth: bool | None = None) -> [Node](#node)`
Insert a node at the specified index

**Example:**
```python
path.insertNode(1, 150, 250, "Line")  # Insert at index 1
```

#### `removeNode(index: float | int) -> None`
Remove a node at the specified index

**Example:**
```python
path.removeNode(0)  # Remove first node
```

#### `appendNode(x: float | int, y: float | int, nodetype: Babelfont.NodeType, smooth: bool | None = None) -> [Node](#node)`
Append a node to the end of the path

**Example:**
```python
path.appendNode(100, 200, "Line")
path.appendNode(300, 400, "Curve", smooth=True)
```

#### `toString() -> str`
---


## Node

Point in a path

**Access:**
```python
node = path.nodes[0]
```

### Properties

All properties are read/write:

- **`x`** (float | int)
- **`y`** (float | int)
- **`nodetype`** (Babelfont.NodeType)
- **`smooth`** (bool | None)

### Methods

#### `getPathSegment() -> list[(string | number)]`
#### `toString() -> str`
---


## Component

Component reference to another glyph

**Access:**
```python
component = layer.components[0]
```

### Properties

All properties are read/write:

- **`reference`** (str)
- **`transform`** (Babelfont.DecomposedAffine)
- **`location`** (DesignspaceLocation | None)
- **`format_specific`** (dict | None)

### Methods

#### `getPathSegment() -> list[(string | number)]`
#### `toAffineArray() -> list[float | int]`
Convert transform to affine matrix array [a, b, c, d, e, f]
Uses the proper DecomposedAffineTransform utility

#### `toString() -> str`
#### `getTransformedPaths() -> list[Babelfont.Path]`
Get all paths from this component with transforms applied recursively
Automatically determines the correct master by walking up the parent chain

---


## Anchor

Anchor point in a layer

**Access:**
```python
anchor = layer.anchors[0]
```

### Properties

All properties are read/write:

- **`x`** (float | int)
- **`y`** (float | int)
- **`name`** (str | None)
- **`format_specific`** (dict | None)

### Methods

#### `getPathSegment() -> list[(string | number)]`
#### `toString() -> str`
---


## Guide

Guideline in a layer or master

**Access:**
```python
guide = layer.guides[0]
# or
guide = master.guides[0]
```

### Properties

All properties are read/write:

- **`pos`** (Babelfont.Position)
- **`name`** (str | None)
- **`color`** (Babelfont.Color | None)
- **`format_specific`** (dict | None)

### Methods

#### `getPathSegment() -> list[(string | number)]`
#### `toString() -> str`
---


## Axis

Variation axis in a variable font

**Access:**
```python
axis = font.axes[0]
# or
axis = font.findAxisByTag("wght")
```

### Properties

All properties are read/write:

- **`name`** (dict[str, str])
- **`tag`** (str)
- **`id`** (str)
- **`min`** (float | int | None)
- **`max`** (float | int | None)
- **`default`** (float | int | None)
- **`map`** (list[[number, number]] | None)
- **`hidden`** (bool | None)
- **`values`** (list[float | int] | None)
- **`format_specific`** (dict | None)

### Methods

#### `getPathSegment() -> list[(string | number)]`
#### `toString() -> str`
---


## Master

Master/source in a design space

**Access:**
```python
master = font.masters[0]
# or
master = font.findMaster("master-id")
```

### Properties

#### Read/Write Properties

- **`name`** (dict[str, str])
- **`id`** (str)
- **`location`** (DesignspaceLocation | None)
- **`metrics`** (dict)
- **`kerning`** (dict)
- **`custom_ot_values`** (list[Unsafe] | None)
- **`format_specific`** (dict | None)

#### Read-Only Properties

- **`guides`** (list[[Guide](#guide)] | None)

### Methods

#### `getPathSegment() -> list[(string | number)]`
#### `addGuide(pos: Babelfont.Position, name: str | None = None, color: Babelfont.Color | None = None) -> [Guide](#guide)`
#### `removeGuide(index: float | int) -> None`
#### `toString() -> str`
---


## Instance

Named instance in a variable font

**Access:**
```python
instance = font.instances[0]
```

### Properties

All properties are read/write:

- **`id`** (str)
- **`name`** (dict[str, str])
- **`location`** (DesignspaceLocation | None)
- **`custom_names`** (dict[str, dict[str, str] | None])
- **`variable`** (bool | None)
- **`linked_style`** (str | None)
- **`format_specific`** (dict | None)

### Methods

#### `getPathSegment() -> list[(string | number)]`
#### `toString() -> str`
---


## Complete Examples

### Example 1: Creating a Simple Glyph

```python
# Get the font
font = Font()

# Create a new glyph
glyph = font.addGlyph("myGlyph", "Base")

# Add a layer
layer = glyph.addLayer(500)  # 500 units wide

# Create a rectangle path
path = layer.addPath(closed=True)
path.appendNode(100, 0, "Line")
path.appendNode(400, 0, "Line")
path.appendNode(400, 700, "Line")
path.appendNode(100, 700, "Line")

print(f"Created glyph: {glyph.name}")
```

### Example 2: Modifying Existing Glyphs

```python
font = Font()

# Find glyph A
glyph_a = font.findGlyph("A")
if glyph_a:
    layer = glyph_a.layers[0]
    
    # Modify all nodes
    for path in layer.paths:
        for node in path.nodes:
            node.x += 10  # Shift 10 units right
            node.y += 5   # Shift 5 units up
    
    # Add an anchor
    layer.addAnchor(250, 700, "top")
    
    print(f"Modified {glyph_a.name}")
```

### Example 3: Working with Components

```python
font = Font()

# Create a glyph with a component
glyph = font.addGlyph("Aacute", "Base")
layer = glyph.addLayer(600)

# Add base letter component
base = layer.addComponent("A")

# Add accent component with transformation
# Transform: [scaleX, skewX, skewY, scaleY, translateX, translateY]
accent = layer.addComponent("acutecomb", [1, 0, 0, 1, 250, 500])

print(f"Created {glyph.name} with components")
```

### Example 4: Iterating Through Font

```python
font = Font()

# Count nodes across all glyphs
total_nodes = 0
for glyph in font.glyphs:
    if glyph.layers:
        for layer in glyph.layers:
            for path in layer.paths:
                total_nodes += len(path.nodes)

print(f"Total nodes in font: {total_nodes}")
```

### Example 5: Working with Variable Fonts

```python
font = Font()

# Check if font has axes
if font.axes:
    print("Variable font axes:")
    for axis in font.axes:
        print(f"  {axis.tag}: {axis.min} - {axis.max} (default: {axis.default})")
    
    # Check masters
    if font.masters:
        print(f"\nFont has {len(font.masters)} masters:")
        for master in font.masters:
            location_str = ", ".join(f"{k}={v}" for k, v in (master.location or {}).items())
            print(f"  Master: {location_str}")
```

### Example 6: Batch Processing Glyphs

```python
font = Font()

# Scale all glyphs by 1.5x
scale_factor = 1.5

for glyph in font.glyphs:
    if glyph.layers:
        for layer in glyph.layers:
            # Scale width
            layer.width *= scale_factor
            
            # Scale all outline paths
            for path in layer.paths:
                for node in path.nodes:
                    node.x *= scale_factor
                    node.y *= scale_factor
            
            # Scale anchors
            if layer.anchors:
                for anchor in layer.anchors:
                    anchor.x *= scale_factor
                    anchor.y *= scale_factor

print(f"Scaled {len(font.glyphs)} glyphs by {scale_factor}x")
```

### Example 7: Kerning and i18n Dictionaries

```python
font = Font()
master = font.masters[0]

# Ensure nested kerning bucket exists
if "A" not in master.kerning:
    master.kerning["A"] = {}

master.kerning["A"]["V"] = -90
master.kerning["A"]["W"] = -70

# Read values with standard dict APIs
av_value = master.kerning["A"].get("V")
print(f"A/V kerning: {av_value}")

# Update localized names
font.names.familyName["dflt"] = "Counterpunch Sans"
font.names.familyName["de"] = "Counterpunch Sans DE"
font.names.familyName["fr"] = "Counterpunch Sans FR"
font.names.familyName["ar"] = "كاونتربنش سانس"
```

### Example 8: Editing OpenType Features List

```python
font = Font()

# features is a live list-like wrapper
feature_items = font.features.features

# Append a new feature tuple: [tag, code-record]
feature_items.append(["liga", {"code": "sub f i by fi;"}])

# Insert at the top
feature_items.insert(0, ["kern", {"code": "pos A V -80;"}])

# Remove entries with normal list operations
if len(feature_items) > 5:
    feature_items.pop()

del feature_items[0]
```

---

## Tips and Best Practices

### Performance

- Changes to properties are immediately reflected in the underlying JSON data
- No need to "save" or "commit" changes - they are live
- Dictionary-like fields are live Python mappings (no routine `.to_py()` needed)
- Array fields (for example `font.features.features`) are live list-like wrappers
- For batch operations, group changes together to minimize redraws

### Type Checking

```python
# Use the filtered convenience collections when you know what you want
for path in layer.paths:
    # Work with path

for component in layer.components:
    # Work with component
```

### Safe Property Access

```python
# Check for optional properties
if glyph.layers:
    for layer in glyph.layers:
        for path in layer.paths:
            for node in path.nodes:
                print(f"Node at ({node.x}, {node.y})")
```

### Guardrails for Dictionary Fields

Dictionary-like fields reject scalar overwrite assignments to prevent broken model state.

```python
# ❌ Avoid replacing a language dictionary with a string
# font.names.familyName = "My Font"

# ✅ Set a language value inside the dictionary
font.names.familyName["dflt"] = "My Font"

# ✅ Or replace with a full mapping
font.names.familyName = {
    "dflt": "My Font",
    "de": "Meine Schrift"
}
```

### Accessing Nodes Example

```python
# Direct access (may fail if properties are None)
# glyph.layers[0].paths[0].nodes  # DON'T DO THIS

# Safe access with checks:
layer = glyph.layers[0] if glyph.layers else None
if layer and layer.paths:
    path = layer.paths[0]
    nodes = path.nodes
    print(f"Path has {len(nodes)} nodes")
```

### Coordinate System

- Origin (0, 0) is at the baseline on the left
- Y-axis points upward
- All coordinates are in font units (1/upm of the em square)

### Common Issues

**Q: Why does `glyph.layers[0].paths[0].nodes` fail?**

A: Optional properties may be `None`. Use safe access:
```python
# Check each step
if glyph.layers and len(glyph.layers) > 0:
    layer = glyph.layers[0]
    if layer.paths and len(layer.paths) > 0:
        path = layer.paths[0]
        nodes = path.nodes  # Now safe to access
```

**Q: How do I access only paths or only components in a layer?**

A: Use `layer.paths` and `layer.components` directly:
```python
for path in layer.paths:
    print(len(path.nodes))

for component in layer.components:
    print(component.reference)
```

---

*Generated by `generate-api-docs.mjs`*
