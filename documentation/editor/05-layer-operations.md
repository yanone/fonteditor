# Layer operations

The layer list holds the current glyph’s stored designs: select a layer, add an intermediate at an in-between location, delete a non-master exception, or reinterpolate stored geometry. **Variations** sit with that list as alternate layer families that replace the **base glyph** inside an axis range.

## Vocabulary

- A **master layer** is stored at a master location.
- An **intermediate layer** is stored at a non-master location.
- An **interpolated view** is temporary geometry when the axis position matches no stored layer.
- **Reinterpolate** replaces a stored layer with a fresh interpolation at the same location.
- A **variation** is a feature-variation: parallel layers active only inside a certain axis range.
- The **base glyph** is the default glyph, used when no variation is selected.

Stored layers and interpolated previews are different. Click a stored layer to edit its geometry. Outline colors, selection, and the add-layer button update immediately.

## Create, delete, and reinterpolate

Move the sliders off every stored location. Add-layer is enabled only in-between; it stores the current interpolation as an **Intermediate Layer**, then selectable like any other stored layer.

Delete a non-master layer from its context menu. If the location is still in-between, the editor returns to interpolated preview. Master-bound layers cannot be deleted.

**Reinterpolate** rebuilds a stored layer at the same location after source masters change. If that layer was selected, you stay on it.

## Variations

A variation compiles as a Glyphs Feature Variation. Selecting it switches the Layers list to that family’s masters and intermediates; it does not merge into the base glyph.

Add opens **Add Feature Variation**: optional **Min** / **Max** per axis, in designspace coordinates; empty means unbounded. **Add** copies one associated layer per base master (and a materialized background if present). The glyph needs a master layer. Duplicate axis rules are rejected.

Once any exist, the list shows **Base glyph** plus each family, labeled by conditions (`400 < wght < 700`, or `Feature variation 1` if every bound is empty). Click a row to edit that family. Only this list switches families in edit mode—not sliders, interpolation, or text reshaping.

Right-click for **Edit** (same axis-range dialog) and **Remove**. Remove deletes every layer in the family, including backgrounds, and returns to the base if that variation was selected.

Add, delete, and reinterpolate apply to the selected family. An intermediate created there belongs to that variation, not the base.

Watch for: empty min/max = unbounded, not unused; designspace values, not slider userspace; Remove deletes the family, not one master.

Sequence: add a weight-range variation → select it → edit its masters → add an intermediate if needed → compare against Base glyph.

Axes: [Axes and masters](03-axes-masters.md). Outlines: [Outline drawing](02-outline-drawing.md). Scripting: [Glyph](../python/06-python-api.md#glyph) (`featureVariations`, `addFeatureVariation`, `removeFeatureVariation`).
