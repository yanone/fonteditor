# Layer Operations

Counterpunch lets you move between stored layers, create new intermediate layers from interpolated positions, delete non-master layers, and regenerate stored layer geometry when you want a layer to follow the current interpolation again. This page explains those operations as an editing workflow rather than as internal implementation details.

## Summary

Use the layer list in the Editor view to manage design states for the current glyph. Exact stored layers can be selected directly, intermediate layers can be inserted at in-between axis locations, non-master layers can be deleted again, and any stored layer can be reinterpolated from the current source structure.

## Quick Vocabulary

- A **master layer** is a stored layer tied to a master location.
- An **intermediate layer** is a stored layer at a non-master location between or beyond masters.
- An **interpolated view** is the temporary shape you see when the current axis position does not match a stored layer exactly.
- **Reinterpolate** means replacing a stored layer with a fresh layer generated from the current interpolation setup.

## Select an Existing Layer

When the current axis location matches a stored layer, that layer behaves as an exact editable source. Clicking a layer in the layer list switches the editor to that stored layer and restores exact-layer editing state immediately.

This matters because exact layers and interpolated previews are not the same thing. In an interpolated preview, you are looking at generated geometry between sources. In an exact layer, you are editing stored geometry that belongs to the glyph.

If you click a stored layer after deleting another intermediate layer, Counterpunch now restores that exact layer on the first click. The outline colors, selection state, and add-layer button all update immediately.

## Create an Intermediate Layer

To insert a new intermediate layer:

1. Move the axis sliders to a position that does not already match a stored layer.
2. Look at the layer panel. The add-layer button becomes available only at in-between positions.
3. Click the add-layer button to store the current interpolated location as a new layer.

Counterpunch uses the current glyph, the current design location, and the active master linkage to create that stored layer. Once created, it appears in the layer list and can be selected like any other stored layer.

Intermediate layers are shown with the label **Intermediate Layer** in the list so they are visually distinct from master-bound layers.

## Delete an Intermediate Layer

Intermediate layers and other non-master stored layers can be deleted from the layer context menu.

Use this when a temporary correction layer is no longer needed, or when you want to return that position to pure interpolation instead of maintaining a stored exception.

After deleting a selected intermediate layer, Counterpunch falls back cleanly:

- if the current location is still a valid in-between position, the editor returns to interpolated preview there
- if you then click another stored layer, that exact layer becomes active immediately

Master-bound layers are not offered a delete action.

## Reinterpolate a Stored Layer

The layer context menu also offers **Reinterpolate**.

Use this when a stored layer should be rebuilt from the current interpolation instead of keeping its previous stored outline data. A common case is after source layers have changed and you want an intermediate layer to be regenerated from the updated structure.

Reinterpolation removes the stored layer and recreates it at the same layer ID and design location using fresh interpolated geometry. If that layer was currently selected, Counterpunch refreshes the selection so you stay on the recreated layer instead of being left in an outdated preview.

## What to Watch For

- The add-layer button is disabled at exact stored-layer locations because there is nothing new to insert there.
- The add-layer button becomes enabled only between exact locations, where a new intermediate layer can actually be stored.
- Reinterpolate is different from ordinary preview interpolation. Preview interpolation is temporary; reinterpolation rewrites the stored layer.
- Deleting a non-master layer does not delete its source masters. It only removes that stored exception layer.

## A Practical Workflow

Try this sequence on a variable glyph:

1. Open a glyph with at least two master locations.
2. Move to an in-between position and inspect the interpolated result.
3. Create an intermediate layer there.
4. Switch away and back to confirm it behaves as a stored exact layer.
5. Use the layer menu to reinterpolate it after changing a source layer.
6. Delete it again to return that location to pure interpolation.

This is a good way to understand the difference between temporary interpolation and stored layer data.

## Suggested Screenshots

### Screenshot 1 — Add intermediate layer at an in-between location

- Filename: `editor-05-01-add-intermediate-layer.png`
- Capture: layer list with sliders at a non-exact location and the add-layer button enabled.
- Suggested annotations:
    1. Current in-between axis location
    2. Add-layer button
    3. Existing stored layers
- Alt text: Layer panel showing an in-between location where a new intermediate layer can be created.

### Screenshot 2 — Intermediate layer in the list

- Filename: `editor-05-02-intermediate-layer-row.png`
- Capture: layer list after insertion, with the new row visible.
- Suggested annotations:
    1. Intermediate Layer label
    2. Selected exact layer row
    3. Context menu trigger
- Alt text: Layer list showing a newly created intermediate layer.

### Screenshot 3 — Reinterpolate and delete actions

- Filename: `editor-05-03-layer-context-actions.png`
- Capture: open layer context menu for a non-master layer.
- Suggested annotations:
    1. Delete layer action
    2. Reinterpolate action
    3. Target layer row
- Alt text: Layer context menu with delete and reinterpolate actions for a stored layer.

## Related Pages

- [Glyph Editor Basics](01-glyph-editor-basics.md)
- [Axes, Masters, and Interpolation](02-axes-masters-interpolation.md)
- [Outline Drawing and Editing](04-outline-drawing-and-editing.md)
- [Undo and History Scopes](../reference/undo-and-history-scopes.md)
