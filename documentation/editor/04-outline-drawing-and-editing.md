# Outline Drawing and Editing

Counterpunch's outline tools are designed around direct manipulation. You work on the canvas itself, building contours point by point, then refining structure, curve tension, and joins without switching into a separate modal workflow.

## Summary

Use the Editor view to draw new contours, continue open paths, reshape existing points, and repair structure directly on the canvas. The most important gestures are `Cmd/Ctrl` for path creation and structural edits, `Shift` for directional constraints, and `Alt/Option` for curve-specific handle behavior.

## Draw a New Contour

To start a new outline, hold `Cmd/Ctrl` and move the pointer into empty glyph space, away from existing outlines. Counterpunch enters point-by-point drawing mode and shows a preview line from the last placed point to the pointer.

Each new click adds another point to the contour. While this drawing preview is active, Counterpunch prioritizes extending the current path over inserting points into nearby segments, so you can keep drawing cleanly even when you pass near other outlines.

You can also continue an open contour instead of starting from scratch. Select an open end point, then hold `Cmd/Ctrl` to resume drawing from that end.

To finish the contour:

- click the first point to close the path
- click another open end point to connect two open contours
- stop with an open end if you want to keep the contour open for now

While drawing with `Cmd/Ctrl` held, Counterpunch can continue beyond the active glyph width if necessary. Nearby glyphs are ignored during that gesture so they do not interfere with contour construction.

## Select and Move Existing Points

Click a point to select it, then drag it to reshape the outline. Bézier handles appear when the point participates in a curve, making it easier to read the local structure before you move anything.

For early practice, use a simple glyph and make very small moves first. That helps you see whether a change affected only one local segment or the overall rhythm of the glyph.

If you want to inspect distances while editing, hold `Tab` in outline mode to bring up the measurement tool and drag out a temporary measurement line.

## Shape Curves and Smooth Points

Counterpunch distinguishes between corner behavior and smooth behavior at on-curve points.

- Double-click an on-curve point in a curve setup to toggle between smooth and non-smooth
- Hold `Shift` while dragging an off-curve handle of a smooth point to constrain the handle direction to horizontal or vertical
- Hold `Alt/Option` while dragging a smooth on-curve point to slide that point along the line defined by its handles while keeping the handles fixed in place
- Hold `Alt/Option` while dragging an off-curve point that is not part of a smooth connection to keep that handle moving on its original direction from the on-curve point

Open contour end points are always corners. They do not remain smooth at the ends of an open path.

## Add, Convert, Open, and Close Structure

Several editing gestures change contour structure rather than just moving existing geometry.

- `Cmd/Ctrl + Click` on a segment inserts a point on that segment
- `Alt/Option + Click` on a straight segment converts that segment into a curve
- `Cmd/Ctrl + Click` on an on-curve point cuts the contour open at that point
- Drag one open end point onto another open end point to connect two contours or close one contour

Cutting a closed contour open creates a new start and end at the clicked location. If you cut an already open contour again at a different point, Counterpunch separates it into two open contours.

When you drag an open end point directly onto another open end point, Counterpunch treats that as intentional closure or connection and merges the structure accordingly.

## Snapping and Visual Warnings

When drawing new points or dragging existing ones, Counterpunch snaps against useful editing targets such as:

- on-curve points in the active glyph
- on-curve points in neighboring glyphs
- the dragged point's original position
- glyph edges and vertical metric lines

This helps maintain alignment without forcing you into a separate alignment tool.

If two nodes end up at exactly the same position, Counterpunch marks that spot with a red circle. Treat that as a warning to inspect whether the overlap is intentional or whether a contour connection needs cleanup.

## A Practical Practice Routine

Try this sequence when learning the outline tools:

1. Open a simple glyph such as `O`, `H`, or `n`.
2. Draw one short open contour with `Cmd/Ctrl`.
3. Continue it from one end point and close it back onto its first point.
4. Insert one extra point on a segment, then move it slightly.
5. Convert one straight segment into a curve and compare the result.
6. Double-click one on-curve point to switch between corner and smooth behavior.

This sequence touches the main structural operations without requiring a complex glyph.

## Suggested Screenshots

### Screenshot 1 — Drawing a new contour

- Filename: `editor-04-01-drawing-new-contour.png`
- Capture: an in-progress new contour with the preview line visible from the last point to the pointer.
- Suggested annotations:
    1. Last placed point
    2. Preview line
    3. Next target position
- Alt text: Glyph editor showing a new contour being drawn point by point.

### Screenshot 2 — Smooth point editing

- Filename: `editor-04-02-smooth-point-editing.png`
- Capture: a selected smooth point with both handles visible while one handle is being constrained.
- Suggested annotations:
    1. Smooth on-curve point
    2. Bézier handles
    3. Constrained direction
- Alt text: Glyph editor showing a smooth curve point and its handles during editing.

### Screenshot 3 — Opening and reconnecting a contour

- Filename: `editor-04-03-open-and-reconnect-contour.png`
- Capture: side-by-side state showing a contour cut open and then reconnected by dragging one end point onto another.
- Suggested annotations:
    1. Open end point
    2. Reconnection target
    3. Final closed contour
- Alt text: Comparison of a contour after being opened and then closed again.

## Related Pages

- [Glyph Editor Basics](01-glyph-editor-basics.md)
- [Sidebearing Arithmetics](03-sidebearing-arithmetics.md)
- [Keyboard Shortcuts](../reference/keyboard-shortcuts.md)
- [Glossary](../reference/glossary.md)
