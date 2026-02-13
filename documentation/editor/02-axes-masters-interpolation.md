# Axes, Masters, and Interpolation

Variable font work can look abstract at first, but it becomes manageable when treated as a set of explicit design locations connected by interpolation. Counterpunch exposes these relationships directly in the editor so you can move between masters and intermediate states while observing shape continuity. This page introduces the conceptual model in plain language, then translates it into a practical workflow.

## Summary

Counterpunch supports variable-font workflows by letting you edit masters at defined axis locations and preview interpolated results between them. The goal is to help you build shapes that remain coherent across the full design space, not only at master extremes.

## Quick Vocabulary

- **Axis**: a design dimension, like weight or width.
- **Master**: a key design source at a specific axis location.
- **Interpolation**: generated shapes between masters.

## Beginner Workflow

1. Set up or inspect axes.
2. Edit a glyph in one master.
3. Move to another master and edit intentionally.
4. Preview in-between results to check consistency.

## What to Watch For

- Compatible point structure across masters.
- Smooth transitions at intermediate positions.
- No sudden shape kinks when moving sliders.

## Suggested Screenshots

### Screenshot 1 — Axis controls with current location

- Filename: `editor-02-01-axis-controls.png`
- Capture: editor sidebar with axis sliders or location controls.
- Suggested annotations:
    1. Axis name
    2. Current value
    3. Master markers (if visible)
- Alt text: Variable axis controls showing current interpolation location.

### Screenshot 2 — Same glyph at two master locations

- Filename: `editor-02-02-master-comparison.png`
- Capture: side-by-side or toggled views of the same glyph across masters.
- Suggested annotations:
    1. Master A location
    2. Master B location
    3. Key shape differences
- Alt text: Glyph comparison across two masters in variable design space.

### Screenshot 3 — Interpolated mid-location preview

- Filename: `editor-02-03-interpolated-preview.png`
- Capture: glyph at intermediate axis value.
- Suggested annotations:
    1. Midpoint axis value
    2. Interpolated contour region
- Alt text: Interpolated glyph preview at a non-master axis location.

## Related Pages

- [Glyph Editor Basics](01-glyph-editor-basics.md)
- [Glossary](../reference/glossary.md)
