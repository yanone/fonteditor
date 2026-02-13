# Open, Save, and File Formats

A stable file workflow is the backbone of trustworthy type design work. Counterpunch supports multiple source formats and keeps a live edit-to-preview cycle, but the practical question for users is always the same: what did I open, where am I saving, and what state is my current source in. This page clarifies those fundamentals in operational terms.

## Summary

This page explains which source files you can open, what saving means in Counterpunch’s editing model, and how the compile-preview loop supports iterative design. It is intended to reduce uncertainty when switching between quick experiments and production-safe file handling.

## Common Source Formats

Counterpunch can open several established source formats, including `.babelfont`, `.glyphs`, and `.vfj`. Some formats may be converted internally to facilitate editing, though this happens transparently.

## Recommended Save Workflow

A reliable save workflow helps maintain project integrity. After opening a source file in the Files view and making edits in the Editor view, save your work after completing meaningful changes. For added safety, consider maintaining versioned snapshots within your project folder.

## Preview/Compile Mental Model

As you work, your edits are continuously transformed into a live preview font that powers the shaping and rendering you see within the application. If the preview doesn't match your expectations, verify your recent edits first, then consider whether any scripting or filter actions might be affecting the output.

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
