# Editing in Multiple Windows

Counterpunch can open the same font in more than one browser window at the same time. This is useful when you want one window focused on drawing, another on feature code, and another on overview or inspection. The important detail is that these windows are not independent copies of the font: they participate in one shared editing session.

## Summary

Use multiple windows when you want parallel views on the same font. The original window is the **Main** window, and additional windows opened from it become **linked windows** that stay synchronized with the same live edit history.

## Main Window vs Linked Windows

When you first open a font, that editor is the **Main** window.

If you use **Open in New Window**, Counterpunch opens the same font in another browser window and marks it as a **linked window**. The interface labels these windows as:

- **Main**
- **Linked 1**
- **Linked 2**
- and so on

You may see these labels in the window title area and in history items.

## What Is Shared

Main and linked windows share the same live editing session for that font.

In practical terms:

- edits made in one window appear in the others,
- history items are synchronized across the session,
- undo and redo operate on the shared change history,
- the History panel shows which window produced each change.

This makes multi-window work useful for side-by-side tasks such as comparing glyphs, keeping the feature editor open in one window, or watching the overview while editing in another.

## What Is Different

The windows are synchronized, but they do not have identical UI roles.

- The **Main** window is the original editor session.
- **Linked windows** join that session and receive the current full state and history from the Main window.
- History items record the source window label, so you can see whether an action came from Main or a linked window.

This means a change made in a linked window is still a real shared edit. It is not a preview-only branch or a temporary sandbox.

## A Good Mental Model

Think of linked windows as multiple control surfaces for one document, not as separate files.

That mental model explains several behaviors that might otherwise seem surprising:

- making a change in one window updates the others,
- undo in one window can affect work that was entered in another,
- history badges may show different source windows inside one continuous timeline.

## Recommended Uses

Multi-window editing is most helpful when each window has a distinct job:

1. Keep one window on glyph drawing.
2. Keep another on the feature editor.
3. Use another for overview, proofing, or navigation.

This reduces view-switching while still keeping all work inside one synchronized session.

## Things To Be Careful About

Because the session is shared, undo requires a little discipline.

- Check the History panel before undoing if several windows are active.
- Watch the **window badge** on history items to see where a change came from.
- Remember that undo follows the current history scope, not just the currently visible window.

If you are collaborating with yourself across several windows, it helps to treat History as the source of truth for what will be undone next.

## Closing Behavior

Linked windows depend on the Main window’s session. In normal use, think of the Main window as the anchor for the multi-window setup.

If you intend to keep working in several windows, keep the Main window open.

## Suggested Screenshots

### Screenshot 1 — Main window opening a linked window

- Filename: `files-04-01-open-linked-window.png`
- Capture: toolbar or control used to open a new linked window.
- Suggested annotations:
    1. Open in New Window control
    2. Current Main window label
- Alt text: Main Counterpunch window showing the control used to open a linked window.

### Screenshot 2 — Two synchronized windows

- Filename: `files-04-02-main-and-linked.png`
- Capture: Main and Linked 1 windows open side by side.
- Suggested annotations:
    1. Main label
    2. Linked label
    3. Same font open in both windows
- Alt text: Main and linked Counterpunch windows editing the same font in one shared session.

### Screenshot 3 — History items with window badges

- Filename: `files-04-03-window-history-badges.png`
- Capture: History panel showing items from Main and Linked 1.
- Suggested annotations:
    1. Window badge on history item
    2. Shared timeline
- Alt text: Shared history list with window badges indicating which editor window made each change.

## Related Pages

- [Files View Basics](01-files-view-basics.md)
- [Open, Save, and File Formats](03-open-save-formats.md)
- [Undo and History Scopes](../reference/undo-and-history-scopes.md)
