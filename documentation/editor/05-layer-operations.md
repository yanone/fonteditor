# Layer operations

The layer list in the Editor is the stored design states of the current glyph. Use it to select stored layers, insert intermediate layers at in-between axis locations, delete non-master layers, and regenerate stored geometry when a layer should follow interpolation again.

## Vocabulary

- A **master layer** is stored at a master location.
- An **intermediate layer** is stored at a non-master location, between or beyond masters.
- An **interpolated view** is temporary generated geometry when the axis position does not match a stored layer.
- **Reinterpolate** replaces a stored layer with a fresh interpolation at the same location.

Exact stored layers and interpolated previews are not the same thing. Click a stored layer to edit stored geometry. The outline colors, selection, and add-layer button update immediately.

## Create, delete, and reinterpolate

Move the axis sliders off every stored location. The add-layer button is enabled only at in-between positions. Click it to store the current interpolation as an **Intermediate Layer**. It then appears in the list and can be selected like any other stored layer.

Delete a non-master layer from its context menu when you no longer want that exception. After delete, if the location is still in-between, the editor returns to interpolated preview. Master-bound layers are not offered delete.

**Reinterpolate** rebuilds a stored layer from the current interpolation at the same layer id and location. Use it after source masters have changed and an intermediate should follow them again. If that layer was selected, you stay on the recreated layer.

Watch for: add-layer disabled at exact stored locations; reinterpolate rewriting stored data rather than only previewing; delete removing the exception, not the source masters.

A practical sequence on a variable glyph: move to an in-between, inspect, create an intermediate, switch away and back, reinterpolate after changing a source, then delete to return that location to pure interpolation.

Axes themselves are in [Axes and masters](03-axes-masters.md). Outline editing is in [Outline drawing](02-outline-drawing.md).
