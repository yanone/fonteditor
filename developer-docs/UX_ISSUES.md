# UX Issues

## Canvas Undo Is Intentionally Layer-Scoped

Canvas undo and redo resolve history from the active glyph/layer selection. An
edit on one layer followed by selecting another layer or entering a component
can therefore make Cmd/Ctrl+Z operate on that new scope or have no applicable
history item. This is intentional: a canvas history action must not mutate a
different layer from the one the user is currently editing.

The current behavior is easy to mistake for a stale undo because the visible
canvas remains active throughout the interaction.

Future UX change: keep the layer-scoped implementation, but expose the active
undo scope in the canvas history controls and show a short status message when
the current layer has no undoable change. The history view should also make the
layer or nested component scope of each item immediately visible. Do not change
the command to select the last canvas edit globally; that would make undo mutate
an off-screen layer and conflict with the active editing context.