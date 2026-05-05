# Keyboard Shortcuts

Keyboard shortcuts are one of the fastest ways to reduce friction in repeated type design tasks. Even learning a small core set makes navigation and execution more fluid, especially when alternating between editing, overview inspection, scripting, and assistant workflows. This page groups shortcuts by intent so users can adopt them progressively.

## Summary

Use shortcuts to move faster between views and trigger common actions with less context switching. The list prioritizes practical, high-frequency commands that matter in everyday sessions.

## Global View Navigation

These shortcuts allow you to move quickly between different areas of Counterpunch:

- `Cmd/Ctrl + Shift + E` navigates to the Editor
- `Cmd/Ctrl + Shift + O` opens the Overview
- `Cmd/Ctrl + Shift + A` displays the Assistant
- `Cmd/Ctrl + Shift + Y` opens Scripts
- `Cmd/Ctrl + Shift + K` shows the Konsole
- `Cmd/Ctrl + Shift + I` reveals Font Info

## File Actions

- `Cmd/Ctrl + O` opens the font file dialog
- `Cmd/Ctrl + S` saves the current font
- `Cmd/Ctrl + Shift + S` opens the font Save As dialog

## Script and Konsole Actions

When working with Python, these shortcuts streamline common operations:

- `Cmd/Ctrl + Alt + R` runs the current script or executes the primary action in the active context
- `Cmd/Ctrl + K` clears the Konsole output for a fresh start

## Editor Measurement

- Hold `Tab` to show the measurement overlay immediately in Editor text mode
- Hold `Tab` to show the measurement tool immediately in outline editing mode, then click and drag to define a custom measurement line

## Editor Outline Actions

- Hold `Cmd/Ctrl` in empty glyph space to start drawing a new contour point by point
- Hold `Cmd/Ctrl` on a selected open end point to continue an open contour from that end
- `Cmd/Ctrl + Click` on a segment adds a point to that segment
- `Cmd/Ctrl + Click` on an on-curve point cuts the contour open at that point
- Drag one open end point onto another open end point to connect or close a contour
- `Alt/Option + Click` on a straight segment converts it into a curve
- Double-click an on-curve point toggles smooth and corner behavior
- Hold `Shift` while dragging an off-curve handle of a smooth point to constrain it horizontally or vertically
- Hold `Alt/Option` while dragging a smooth on-curve point to slide it along its existing handle axis

## Notes for Beginners

Keep in mind that some shortcuts may only be available when certain views are active or have focus. Additionally, keyboard conventions differ between platforms: macOS uses `Cmd` while Windows and Linux use `Ctrl`. The measurement overlay uses the dedicated `Tab` key rather than `Cmd/Ctrl`.

## Suggested Screenshots

### Screenshot 1 — Keyboard shortcut hints in UI

- Filename: `reference-shortcuts-01-ui-hints.png`
- Capture: view buttons showing shortcut hints.
- Suggested annotations:
    1. Visible shortcut labels
    2. Active view marker
- Alt text: View controls with keyboard shortcut hints displayed.

### Screenshot 2 — Shortcut help modal (if enabled)

- Filename: `reference-shortcuts-02-help-modal.png`
- Capture: keyboard shortcut cheat sheet panel/modal.
- Suggested annotations:
    1. Grouped shortcut categories
    2. Close/help action
- Alt text: Keyboard shortcut help panel grouped by feature area.

## Related Pages

- [Workspace Tour](../getting-started/03-workspace-tour.md)
- [Outline Drawing and Editing](../editor/04-outline-drawing-and-editing.md)
- [Script Editor Workflow](../python/02-script-editor-workflow.md)
