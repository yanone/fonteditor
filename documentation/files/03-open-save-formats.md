# Open, Save, and File Formats

A stable file workflow is the backbone of trustworthy type design work. Counterpunch supports multiple source formats and keeps a live edit-to-preview cycle, but the practical question for users is always the same: what did I open, where am I saving, and what state is my current source in. This page clarifies those fundamentals in operational terms.

## Summary

This page explains which source files you can open, what saving means in Counterpunch’s editing model, and how the compile-preview loop supports iterative design. It is intended to reduce uncertainty when switching between quick experiments and production-safe file handling.

## Common Source Formats

- `.babelfont`
- `.glyphs`
- `.vfj`

Some formats may be converted internally for editing.

## Recommended Save Workflow

1. Open source file in Files view.
2. Edit in Editor view.
3. Save after meaningful steps.
4. Keep versioned snapshots in your project folder.

## Preview/Compile Mental Model

Your edits are transformed into a live preview font for shaping and rendering inside the app. If preview looks wrong, verify recent edits first, then inspect scripting/filter actions.

## Suggested Screenshots

### Screenshot 1 — File open dialog with supported formats

- Filename: `files-03-01-supported-formats.png`
- Capture: open flow with examples of source files.
- Suggested annotations:
    1. Source file types
    2. Selected file
    3. Open confirmation
- Alt text: Opening a font source file with supported format examples.

### Screenshot 2 — Save workflow in toolbar/files

- Filename: `files-03-02-save-workflow.png`
- Capture: save action and resulting state in Files panel.
- Suggested annotations:
    1. Save control
    2. Current file name/path
    3. Updated state indicator
- Alt text: Save action and file location feedback in Counterpunch.

## Related Pages

- [Glyph Editor Basics](../editor/01-glyph-editor-basics.md)
- [Local Disk Access](02-local-disk-access.md)
